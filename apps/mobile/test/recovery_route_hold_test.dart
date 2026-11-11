// D-MKT-22 — a kept recording is fed back automatically only along the route it
// was recorded on, and not after its engine refused for want of a setup.
//
// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.7, the D-MKT-22
//     addition
//   apps/mobile/lib/src/session/recording_route.dart (the one reader)
//
// MEASURED BEFORE THE CARD (V-LAN-speech-path.md §7 ①): a recording that failed
// on the computer's built-in engine replayed by itself after the computer was
// switched to a cloud engine; its audio went there with nobody pressing anything.
//
// DRIVEN THROUGH PRODUCTION: the stamp is written by a real `pttDown` over the
// production spill; the sweep is the production `BackfillRunner` over a real temp
// directory, and the screen case mounts the real pending-recovery page. The only
// fakes are the socket and the microphone.
//
// REVERSE CONTROLS (2026-11-10, this file only, each seen red, restored, rerun
// green):
//   · `RecoveryJournalLeg._heldForRoute` returning false ⇒ the relay case and
//     the other-computer case fail on 「Expected: empty」 (an `audio:start` went
//     out), the engine-setup case on 「has length of <2>」;
//   · `ptt_edges.dart` stamping `channel: null, pcMachineUid: null` ⇒ the press
//     case fails on 「Expected: 'lan' Actual: <null>」.

import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/backfill_runner.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/session/pending_recovery_store.dart';
import 'package:flowmic/src/session/recording_route.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/recovery_leg_policy.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/server_capabilities.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/temp_teardown.dart';

const int kBytesPerSecond = 32000;
const String kPc = 'machine-test-0001'; // giveSessionAPairedIdentity's default

const List<String> kTierA = <String>[
  kCapabilityCoverageReceipt,
  kCapabilityDeliveryNoneSafe,
  kCapabilityIdempotentOperation,
];

Map<String, Object?> _snapshot({String? channel, String? pc}) => <String, Object?>{
      kConfigSnapshotMode: 'realtime',
      kConfigSnapshotSourceLang: 'zh',
      kConfigSnapshotPrefsDigest: '',
      kConfigSnapshotRouteChannel: ?channel,
      kConfigSnapshotRoutePc: ?pc,
    };

void main() {
  group('D-MKT-22 — the automatic route keeps to the recorded route', () {
    test('🔴 the press stamps the channel and the computer into the manifest',
        () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      rig.session.serverChannel.value = ServerChannel.lan;
      expect(await rig.session.pttDown(), isTrue);
      rig.recorder.feed(makePcm(kChunkBytes));
      await pumpEventQueue();
      final String id = rig.spill.currentRecordingId!;
      final Future<RecorderState> stopped = rig.session.audio.state
          .firstWhere((RecorderState s) => s == RecorderState.stopped);
      rig.transport.pushStatus(SocketStatus.disconnected);
      await stopped.timeout(const Duration(seconds: 3));
      // The manifest is published by the stop path's tail write; reading it
      // earlier opens a second handle on a journal still being closed.
      expect(await rig.session.audio.tailRetentionConfirmed, isTrue);
      await pumpEventQueue();
      final RecordingManifest m = await rig.readManifest(id);
      expect(m.configSnapshot[kConfigSnapshotRouteChannel], 'lan');
      expect(m.configSnapshot[kConfigSnapshotRoutePc], kPc);
    });

    test(
        '🔴 recorded over the LAN, now on the relay ⇒ no audio:start, nothing '
        'spent; back on the LAN ⇒ it runs', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(
          id: 'rec-lan', snapshot: _snapshot(channel: 'lan', pc: kPc));

      rig.session.serverChannel.value = ServerChannel.cloudRelay;
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, isEmpty,
          reason: 'LAN audio must not go to the cloud service by itself');
      final RecordingManifest m1 = await rig.readManifest('rec-lan');
      expect(m1.attempts, isEmpty);
      expect(m1.nextEligibleAtMs, isNull);
      expect(RecoveryQueueState.normalise(m1.recoveryState),
          RecoveryQueueState.pending);
      final RecoveryLegOutcome tally =
          await rig.runner.journalLeg!.run(fallbackSourceLang: 'zh');
      expect(tally.pendingBytes, kBytesPerSecond,
          reason: 'a held recording is still a debt on every tally');
      expect(rig.transport.starts, isEmpty);

      // Channel not known now: fail closed.
      rig.session.serverChannel.value = null;
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, isEmpty);

      // POSITIVE CONTROL: same recording, same rig, the recorded route.
      rig.session.serverChannel.value = ServerChannel.lan;
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(1));
      expect(rig.transport.starts.single['recording_id'], 'rec-lan');
    });

    test('recorded to another computer ⇒ held', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(
          id: 'rec-pc', snapshot: _snapshot(channel: 'lan', pc: 'machine-b'));
      rig.session.serverChannel.value = ServerChannel.lan;
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, isEmpty);
    });

    test('an old manifest (no route recorded) runs as before', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      await rig.writeJournal(id: 'rec-old', snapshot: _snapshot());
      rig.session.serverChannel.value = ServerChannel.cloudRelay;
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(1));
    });

    test(
        '🔴 an attempt refused with STT_CONFIG_MISSING ⇒ no further automatic '
        'attempt; a user press still runs', () async {
      final _Rig rig = await _Rig.open();
      addTearDown(rig.dispose);
      rig.transport.refuseWith = kSttConfigMissingCode;
      await rig.writeJournal(
          id: 'rec-cfg', snapshot: _snapshot(channel: 'lan', pc: kPc));
      rig.session.serverChannel.value = ServerChannel.lan;

      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(1),
          reason: 'premise: the first attempt went out on the recorded route');
      final RecordingManifest m1 = await rig.readManifest('rec-cfg');
      expect(m1.attempts.single.failureCode, kSttConfigMissingCode);

      // The computer's setup is fixed (maybe to a cloud engine): nothing goes
      // out by itself, however eligible the backoff says it is.
      rig.transport.refuseWith = null;
      await rig.releaseBackoff('rec-cfg');
      await rig.runner.sweep(sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(1),
          reason: 'no automatic attempt after an engine-setup refusal');

      // The user's press is consent to the route that is up now.
      await rig.runner.retranscribe(recordingId: 'rec-cfg', sourceLang: 'zh');
      expect(rig.transport.starts, hasLength(2));
      expect(rig.transport.starts[1]['attempt_kind'],
          RecoveryAttemptKind.userRetranscribe.wire);
    });

    // Anti-façade ⑥: the deliverable is what the pending-recovery SCREEN says.
    testWidgets(
        '🔴 the pending-recovery page says why, keeps Try again now, and drops the '
        'waiting sentence', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final AppStrings en = AppStrings(AppLocale.en);
      late _Rig rig;
      await tester.runAsync(() async {
        rig = await _Rig.open();
        await rig.writeJournal(
            id: 'rec-a', snapshot: _snapshot(channel: 'lan', pc: kPc));
      });

      Future<void> mount() async {
        await tester.runAsync(() async {
          await tester.pumpWidget(MaterialApp(
            home: PendingRecoveryPage(
              key: UniqueKey(),
              source: PendingRecoveryStore(
                  runner: rig.runner, sourceLang: () => 'zh'),
              strings: en,
            ),
          ));
          await Future<void>.delayed(const Duration(milliseconds: 300));
        });
        await tester.pump();
      }

      String sentence() => tester
          .widget<Text>(find.byKey(
              const ValueKey<String>('pendingRecovery.sentence.rec-a')))
          .data!;
      final Finder retry =
          find.byKey(const ValueKey<String>('pendingRecovery.retry.rec-a'));
      final Finder delete =
          find.byKey(const ValueKey<String>('pendingRecovery.delete.rec-a'));

      rig.session.serverChannel.value = ServerChannel.cloudRelay;
      await mount();
      expect(delete, findsOneWidget, reason: 'positive control: the card is on screen');
      expect(sentence(), en.pendingRecoveryRouteChanged);
      expect(retry, findsOneWidget, reason: 'a press is consent to the current route');

      // On the recorded route: the ordinary waiting sentence returns.
      rig.session.serverChannel.value = ServerChannel.lan;
      await mount();
      expect(sentence(), en.pendingRecoveryStateWaiting);

      // An engine-setup refusal on record: its own sentence, button kept.
      await tester.runAsync(() => rig.addRefusedAttempt('rec-a', kSttConfigMissingCode));
      await mount();
      expect(sentence(), en.pendingRecoveryEngineSetup);
      expect(retry, findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(rig.dispose);
    });
  });
}

/// Records every `audio:start`; when [refuseWith] is set, answers the
/// attempt's `audio:stop` with that terminal `stt:error`, the way the server
/// refuses an engine that cannot open (server-core `STT_CONFIG_MISSING`).
class _Transport extends FakeSocketTransport {
  final List<Map<String, Object?>> starts = <Map<String, Object?>>[];
  String? refuseWith;

  @override
  void emit(String event, Object? payload) {
    super.emit(event, payload);
    if (event == FlowMicEvents.audioStart && payload is Map<String, Object?>) {
      starts.add(payload);
    }
    final String? code = refuseWith;
    if (code != null && event == FlowMicEvents.audioStop) {
      pushIncoming(FlowMicEvents.sttError, <String, Object?>{
        'code': code,
        'message': 'no engine could be opened',
        'retryable': false,
      });
    }
  }
}

class _Rig {
  _Rig._(this.tmp, this.store, this.spill);

  static Future<_Rig> open() async {
    final Directory tmp =
        await Directory.systemTemp.createTemp('flowmic-dmkt22-');
    final RetainedAudioStore store =
        RetainedAudioStore(dir: tmp, clock: () => 0);
    await store.open();
    final _Rig r = _Rig._(
      tmp,
      store,
      RetainedAudioSpill(store: store, retainFromFirstFrame: true),
    );
    r._build();
    while (r.runner.isBusy) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    return r;
  }

  final Directory tmp;
  final RetainedAudioStore store;
  final RetainedAudioSpill spill;
  final FakeAudioRecorder recorder = FakeAudioRecorder();

  late final _Transport transport;
  late final PttSession session;
  late final TimelineStore timeline;
  late final BackfillRunner runner;

  void _build() {
    transport = _Transport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: recorder, spill: spill),
      stateMachine: FlowmicStateMachine(
        justDoneDuration: Duration.zero,
        // The press case stops on a link loss; the default grace would race
        // its three-second wait.
        sessionDropGrace: const Duration(milliseconds: 10),
      ),
    );
    giveSessionAPairedIdentity(session);
    session.reconnect
        .noteServerCapabilities(<String, Object?>{'capabilities': kTierA});
    timeline = newTestStore();
    runner = BackfillRunner(
      session: session,
      store: timeline,
      sleep: (Duration _) async {},
      recoveryTimeouts: const RecoveryTimeouts(
        uploadProgress: Duration(milliseconds: 200),
        engineProgress: Duration(milliseconds: 200),
        noProgress: Duration(milliseconds: 200),
        totalBudgetBase: Duration(milliseconds: 400),
        totalBudgetPerAudioMinute: Duration.zero,
      ),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  Future<void> writeJournal(
      {required String id, required Map<String, Object?> snapshot}) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      configSnapshot: snapshot,
      commitInterval: const Duration(days: 1),
    );
    await j.appendPcm(Uint8List(kBytesPerSecond));
    await j.close(interruptReason: JournalInterrupt.linkLoss);
  }

  Future<RecordingManifest> readManifest(String id) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      commitInterval: const Duration(days: 1),
    );
    final RecordingManifest m = j.manifest;
    await j.close();
    return m;
  }

  /// A finished automatic attempt the server refused with [code].
  Future<void> addRefusedAttempt(String id, String code) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      commitInterval: const Duration(days: 1),
    );
    j.addAttempt(JournalAttempt(
        attemptId: 'att-1',
        startedAtMs: 1,
        kind: RecoveryAttemptKind.autoRetry.wire));
    j.closeAttempt('att-1',
        outcome: JournalAttempt.outcomeFailed, failureCode: code);
    await j.commit();
    await j.close();
  }

  Future<void> releaseBackoff(String id) async {
    final RetainedAudioJournal j = await RetainedAudioJournal.open(
      dirPath: tmp.path,
      recordingId: id,
      commitInterval: const Duration(days: 1),
    );
    j.setRecoveryState(RecoveryQueueState.pending, clearNextEligibleAt: true);
    await j.commit();
    await j.close();
  }

  Future<void> dispose() async {
    final DateTime deadline = DateTime.now().add(const Duration(seconds: 10));
    while (runner.isBusy && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
    runner.dispose();
    timeline.dispose();
    await session.dispose();
    await spill.dispose();
    await store.dispose();
    await removeTempDir(tmp);
  }
}
