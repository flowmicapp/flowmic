// NR-115 N4: acceptance-5's claim-ahead probe, without wall-clock races.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/memory_journal_fs.dart';
import 'support/rc3_rig.dart' show Rc3Relay;

// Only the unused legacy-file source is empty. Journals use the real journal
// writer/scanner through MemoryJournalFs, and the real runner owns the latch.
class _JournalOnlyStore extends RetainedAudioStore {
  _JournalOnlyStore() : super(dir: Directory('memory-revalidation'));
  @override
  Future<List<String>> pendingSessions() async => [];
}

class _Fs extends MemoryJournalFs {
  bool paced = false;
  bool churn = false;
  int changed = 0;
  int writes = 0;
  int now = 100000;
  final deadline = Completer<void>();
  final release = Completer<void>();

  @override
  Future<Uint8List> readBytes(String path) async {
    // Each read advances the injected logical clock by 1ms. No wall-clock
    // race: an encode comparison always sees different observation stamps.
    // Park at 2s so removing the restart bound fails without hanging the test.
    if (paced) {
      now += 1;
      if (now >= 102000 && !release.isCompleted) {
        if (!deadline.isCompleted) deadline.complete();
        await release.future;
      }
    }
    return super.readBytes(path);
  }

  @override
  Future<JournalFileHandle> openAppend(String path) async {
    final handle = await super.openAppend(path);
    if (churn && path.endsWith('a-changing.pcm')) {
      // A real competing writer changes a relevant fact while open yields.
      final mp = path.replaceFirst('.pcm', '.manifest.json');
      final old = RecordingManifest.decode(
        utf8.decode(await super.readBytes(mp)),
      );
      changed += 1;
      final updated = old.copyWith(
        owedRanges: [OwedRange(start: changed.isOdd ? 3200 : 0)],
      );
      await super.writeBytes(
        mp,
        Uint8List.fromList(utf8.encode(updated.encode())),
      );
    }
    return handle;
  }

  @override
  Future<void> writeBytes(String path, Uint8List bytes, {bool flush = true}) {
    if (path.endsWith('.manifest.json.tmp')) writes += 1;
    return super.writeBytes(path, bytes, flush: flush);
  }
}

void main() {
  for (final changing in [false, true]) {
    test(
      changing
          ? 'N4: three restarts defer changing debt and recover next candidate'
          : 'N4: claim-ahead observation proceeds once and releases runner',
      () async {
        final fs = _Fs();
        final store = _JournalOnlyStore();
        final spill = RetainedAudioSpill(
          store: store,
          retainFromFirstFrame: true,
          journalFs: fs,
        );
        final relay = Rc3Relay();
        final PttSession session = newTestSession(
          transport: relay,
          audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
          stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
        );
        giveSessionAPairedIdentity(session);
        session.reconnect.noteServerCapabilities({
          'capabilities': [
            kCapabilityCoverageReceipt,
            kCapabilityDeliveryNoneSafe,
            kCapabilityIdempotentOperation,
          ],
        });
        relay.pushStatus(SocketStatus.connected);
        final timeline = newTestStore();
        final runner = BackfillRunner(
          session: session,
          store: timeline,
          clock: () => fs.now,
          sleep: (_) async {},
        );
        // The retained zero PCM is silence; a real terminal receipt ends
        // the wire attempt without fabricating rows or a fake leg outcome.
        relay.onStop = (stop) => scheduleMicrotask(() {
          relay.pushIncoming(FlowMicEvents.sttFinal, {
            ...relay.terminal(
              stop,
              text: '',
              durationMs: stop.toMs - stop.fromMs,
            ),
            'empty_reason': 'heard_no_words',
          });
        });
        Future<void> seed(String id) async {
          final j = await RetainedAudioJournal.open(
            dirPath: store.dirPath,
            recordingId: id,
            fs: fs,
            configSnapshot: {
              kConfigSnapshotMode: 'realtime',
              kConfigSnapshotSourceLang: 'zh',
              kConfigSnapshotPrefsDigest: '',
            },
            commitInterval: const Duration(days: 1),
          );
          await j.appendPcm(Uint8List(64000));
          await j.close();
        }

        bool finished = false;
        bool secondFinished = false;
        Future<void> scenario() async {
          if (changing) {
            await seed('a-changing');
            await seed('b-stable');
            fs.churn = true;
          } else {
            await seed('claim-ahead');
            // The same crash shape as Opus's probe: 2s claim, 1s file.
            await fs.writeBytes(
              '${store.dirPath}/claim-ahead.pcm',
              Uint8List(32000),
            );
          }
          fs.writes = 0;
          fs.paced = true;
          DiagLog.instance.clear();
          await runner.sweep(sourceLang: 'zh');
          finished = true;
        }

        final sweep = scenario();
        await Future.any([sweep, fs.deadline.future]);
        // Snapshot before cleanup makes removal of the bound fail promptly,
        // rather than hanging the test process waiting on the broken sender.
        final doneAtDeadline = finished;
        final elapsedAtDeadline = fs.now - 100000;
        final busyAtDeadline = runner.isBusy;
        final writesAtDeadline = fs.writes;
        final changesAtDeadline = fs.changed;
        final startsAtDeadline = relay.recoveryStarts.toList();
        final diagAtDeadline = DiagLog.instance.snapshot();
        // ignore: avoid_print
        print(
          'N4 changing=$changing done=$finished busy=${runner.isBusy} '
          'elapsedMs=$elapsedAtDeadline writes=$writesAtDeadline '
          'revalidations=$changesAtDeadline starts=${startsAtDeadline.length}',
        );
        fs.churn = false;
        fs.release.complete();
        await sweep;
        if (changing && doneAtDeadline) {
          await runner.sweep(sourceLang: 'zh');
          secondFinished = true;
        }
        runner.dispose();
        timeline.dispose();
        await session.dispose();
        await spill.dispose();
        await store.dispose();

        expect(
          doneAtDeadline,
          isTrue,
          reason:
              'sweep must finish within 2s fake time; events=${relay.events} emitted=${relay.emittedNames} fsm=${session.fsm.session} starts=$startsAtDeadline writes=$writesAtDeadline changes=$changesAtDeadline\n${diagAtDeadline.join("\n")}',
        );
        expect(
          busyAtDeadline,
          isFalse,
          reason: 'runner latch must be released',
        );
        expect(
          writesAtDeadline,
          lessThanOrEqualTo(12),
          reason: 'no manifest write loop',
        );
        expect(elapsedAtDeadline, lessThan(2000));
        expect(startsAtDeadline, hasLength(1));
        expect(
          diagAtDeadline.where((s) => s.contains('audio.recovery.settle ')),
          hasLength(1),
        );
        expect(
          diagAtDeadline.where((s) => s.contains('audio.recovery.timeout ')),
          isEmpty,
        );
        expect(
          startsAtDeadline.single['recording_id'],
          changing ? 'b-stable' : 'claim-ahead',
        );
        if (changing) {
          expect(
            changesAtDeadline,
            4,
            reason: 'initial try plus exactly three restarts',
          );
          expect(
            diagAtDeadline.where(
              (s) => s.contains('audio.recovery.revalidation_deferred'),
            ),
            hasLength(1),
          );
          expect(
            diagAtDeadline.any(
              (s) => s.contains(
                'reason=recovery_projection_keeps_changing restarts=3',
              ),
            ),
            isTrue,
          );
          expect(secondFinished, isTrue);
          expect(
            relay.recoveryStarts.map((s) => s['recording_id']),
            ['b-stable', 'a-changing'],
            reason:
                'deferred candidate retries next sweep; settled candidate does not',
          );
        } else {
          expect(startsAtDeadline.single['range_end_sample'], 16000);
          expect(
            relay.chunks,
            5,
            reason: 'only the one second observed on disk',
          );
        }
      },
    );
  }
}
