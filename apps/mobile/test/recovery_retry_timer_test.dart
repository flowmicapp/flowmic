// 🔴 CARD RC-O — AN AUTOMATIC RETRY HAPPENS WHEN ITS BACKOFF RUNS OUT, WITH THE
// LINK UP AND NOTHING ELSE HAPPENING.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §3.1 / §8 RC-O
//   apps/mobile/lib/src/session/recovery_retry_timer.dart
//
// MEASURED (S6): after a failed attempt wrote `nextEligibleAtMs`, the link
// stayed up and nobody recorded anything for 7.5 minutes — and nothing asked
// again, because a sweep only ran on the link coming up, a recording ending,
// or an owed tail's ticket.
//
// Through the real `BackfillRunner` → `RecoveryJournalLeg` path and a relay
// that never answers: the first automatic attempt fails and backs off 60 s;
// the runner arms ONE timer for exactly then; firing it into an idle session
// on a live link starts the second attempt, and firing it while a press holds
// the session does not (the recording's own end sweeps).
//
// Time is virtual for the leg (its clock and sleeps are injected, as in
// recovery_leg_pacing_test.dart) and the timer is captured rather than slept.
//
// Reverse control: the `_armRetry` call removed from `BackfillRunner._run` ⇒
// no timer, no second attempt (red) — log in the card report.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/recovery_backoff.dart' show RecoveryQueueState;
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_journal_leg.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

class _Starts extends FakeSocketTransport {
  int recoveryStarts = 0;
  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart &&
        payload is Map<String, Object?> &&
        payload['attempt_kind'] == 'auto_retry') {
      recoveryStarts += 1;
    }
  }
}

/// Codex rc3 ⑦ — the real disk, with a hook on each directory listing (one per
/// journal scan), so a test can move the clock between the pass's candidate
/// check (scan 1) and its closing tally (scan 2).
class _ScanHookFs implements JournalFileSystem {
  _ScanHookFs(this.onList);
  final void Function(int n) onList;
  final JournalFileSystem _io = const IoJournalFileSystem();
  int _lists = 0;
  @override
  Future<List<String>> listNames(String d) {
    onList(++_lists);
    return _io.listNames(d);
  }

  @override
  Future<void> ensureDirectory(String p) => _io.ensureDirectory(p);
  @override
  Future<bool> exists(String p) => _io.exists(p);
  @override
  Future<int> lengthOf(String p) => _io.lengthOf(p);
  @override
  Future<Uint8List> readBytes(String p) => _io.readBytes(p);
  @override
  Future<Uint8List> readRange(String p, int s, int e) => _io.readRange(p, s, e);
  @override
  Future<void> writeBytes(String p, Uint8List b, {bool flush = true}) =>
      _io.writeBytes(p, b, flush: flush);
  @override
  Future<JournalFileHandle> openAppend(String p) => _io.openAppend(p);
  @override
  Future<void> rename(String f, String t) => _io.rename(f, t);
  @override
  Future<void> deleteFile(String p) => _io.deleteFile(p);
}

void main() {
  testWidgets(
      '🔴 Codex rc3 ⑦: the backoff runs out while the pass is scanning ⇒ the '
      'recording was skipped as not yet due, and a retry is still scheduled',
      (WidgetTester tester) async {
    await tester.runAsync(() async {
      final Directory tmp = await Directory.systemTemp.createTemp('flowmic-rco7-');
      final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
      await store.open();
      const int due = 5000000;
      int now = due - 1;
      final RetainedAudioSpill spill = RetainedAudioSpill(
        store: store,
        retainFromFirstFrame: true,
        // Scan 2 is the pass's closing tally: by then the deadline has passed.
        journalFs: _ScanHookFs((int n) {
          if (n == 2) now = due + 1;
        }),
      );
      final _Starts transport = _Starts();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
        stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
      );
      giveSessionAPairedIdentity(session);
      session.reconnect.noteServerCapabilities(<String, Object?>{
        'capabilities': <String>[
          kCapabilityCoverageReceipt,
          kCapabilityDeliveryNoneSafe,
          kCapabilityIdempotentOperation,
        ],
      });
      final TimelineStore timeline = newTestStore();
      final List<Duration> armed = <Duration>[];
      final BackfillRunner runner = BackfillRunner(
        session: session,
        store: timeline,
        clock: () => now,
        retryTimer: (Duration d, void Function() cb) {
          armed.add(d);
          return Timer(const Duration(days: 1), () {});
        },
      );
      addTearDown(() async {
        runner.dispose();
        timeline.dispose();
        await session.dispose();
        await spill.dispose();
        await store.dispose();
        await removeTempDir(tmp);
      });
      transport.pushStatus(SocketStatus.connected);
      // One automatic failure behind it, due again at [due].
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: tmp.path,
        recordingId: 'rec-due',
        configSnapshot: const <String, Object?>{
          kConfigSnapshotMode: 'realtime',
          kConfigSnapshotSourceLang: 'zh',
          kConfigSnapshotPrefsDigest: '',
        },
        commitInterval: const Duration(days: 1),
      );
      await j.appendPcm(Uint8List(kRecoveryReadBlockBytes));
      j.addAttempt(const JournalAttempt(
          attemptId: 'a-1', startedAtMs: due - 60000, kind: 'auto_retry'));
      j.closeAttempt('a-1', outcome: JournalAttempt.outcomeFailed);
      j.setRecoveryState(RecoveryQueueState.pending, nextEligibleAtMs: due);
      await j.close();

      await runner.sweep(sourceLang: 'zh');

      expect(transport.recoveryStarts, 0,
          reason: 'positive control: the pass saw it as not yet due');
      expect(armed, isNotEmpty,
          reason: 'nothing else would ever ask again on an idle live link');
      expect(armed.last.inMilliseconds, lessThanOrEqualTo(0),
          reason: 'it is due now');
    });
  });

  testWidgets(
      '🔴 RC-O: a failed automatic attempt backs off 60 s; a timer armed for '
      'then starts the second attempt with the link up and no new recording',
      (WidgetTester tester) async {
    await tester.runAsync(() async {
      final Directory tmp = await Directory.systemTemp.createTemp('flowmic-rco-');
      final RetainedAudioStore store = RetainedAudioStore(dir: tmp, clock: () => 0);
      await store.open();
      final RetainedAudioSpill spill =
          RetainedAudioSpill(store: store, retainFromFirstFrame: true);
      final _Starts transport = _Starts();
      final PttSession session = newTestSession(
        transport: transport,
        audio: AudioCapture(recorder: FakeAudioRecorder(), spill: spill),
        stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
      );
      giveSessionAPairedIdentity(session);
      session.reconnect.noteServerCapabilities(<String, Object?>{
        'capabilities': <String>[
          kCapabilityCoverageReceipt,
          kCapabilityDeliveryNoneSafe,
          kCapabilityIdempotentOperation,
        ],
      });
      final TimelineStore timeline = newTestStore();
      int skew = 0;
      int now() => DateTime.now().millisecondsSinceEpoch + skew;
      final List<(Duration, void Function())> armed = <(Duration, void Function())>[];
      final BackfillRunner runner = BackfillRunner(
        session: session,
        store: timeline,
        recoveryTimeouts: const RecoveryTimeouts(
          uploadProgress: Duration(seconds: 2),
          engineProgress: Duration(milliseconds: 300),
          noProgress: Duration(milliseconds: 400),
          totalBudgetBase: Duration(seconds: 5),
          totalBudgetPerAudioMinute: Duration.zero,
        ),
        clock: now,
        sleep: (Duration d) async {
          skew += d.inMilliseconds;
          await Future<void>.delayed(const Duration(milliseconds: 1));
        },
        // Captured, not slept: the test fires it after moving the clock.
        retryTimer: (Duration d, void Function() cb) {
          armed.add((d, cb));
          return Timer(const Duration(days: 1), () {});
        },
      );
      addTearDown(() async {
        while (runner.isBusy) {
          await Future<void>.delayed(const Duration(milliseconds: 5));
        }
        runner.dispose();
        timeline.dispose();
        await session.dispose();
        await spill.dispose();
        await store.dispose();
        await removeTempDir(tmp);
      });
      transport.pushStatus(SocketStatus.connected);
      final RetainedAudioJournal j = await RetainedAudioJournal.open(
        dirPath: tmp.path,
        recordingId: 'rec-retry',
        configSnapshot: const <String, Object?>{
          kConfigSnapshotMode: 'realtime',
          kConfigSnapshotSourceLang: 'zh',
          kConfigSnapshotPrefsDigest: '',
        },
        commitInterval: const Duration(days: 1),
      );
      await j.appendPcm(Uint8List(2 * kRecoveryReadBlockBytes));
      await j.close();

      await runner.sweep(sourceLang: 'zh');
      while (runner.isBusy) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(transport.recoveryStarts, 1, reason: 'positive control: one attempt');
      final RecordingManifest m = RecordingManifest.decode(
          await File('${tmp.path}${Platform.pathSeparator}rec-retry'
                  '${RetainedAudioJournal.manifestSuffix}')
              .readAsString());
      expect(m.nextEligibleAtMs, isNotNull, reason: 'it failed and backed off');
      expect(armed, isNotEmpty,
          reason: 'S6: nothing was scheduled for the moment the backoff ran out');
      final (Duration wait, void Function() fire) = armed.last;
      expect(wait.inMilliseconds, inInclusiveRange(59000, 60000),
          reason: 'armed for the first backoff step, 1 minute');

      // A press holds the session when it fires: not ours to interrupt.
      session.fsm.onPttDown();
      skew += wait.inMilliseconds;
      fire();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(transport.recoveryStarts, 1, reason: 'no attempt into a live press');
      session.fsm.onPttCancel();

      // Idle, link up: the retry runs.
      armed.clear();
      fire();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      while (runner.isBusy) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
      expect(transport.recoveryStarts, 2,
          reason: 'the second automatic attempt, with nobody touching anything');
      expect(armed, isNotEmpty, reason: 'and it failed again, so the next is armed');
      expect(armed.last.$1.inMilliseconds, inInclusiveRange(119000, 120000),
          reason: 'the second backoff step, 2 minutes');
    });
  });
}
