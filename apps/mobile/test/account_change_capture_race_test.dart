// Codex review of round 3 (2026-09-24), items 2 and 3 — two holes in the RC-S
// account binding, both in the moment an account changes while audio is being
// captured.
//
// ITEM 2 — the account digest was sampled INSIDE the queued journal creation
// (`RetainedAudioSpill.beginRecording` → `_enqueueJournal`), after capture had
// already started. A sign-out landing while that queue was busy stamped the
// recording with whoever (or nobody) was signed in when the disk got round to
// it, and an empty stamp reads as 「unknown」, i.e. recoverable under anyone.
//
// ITEM 3 — `ChatController.stopRecordingForAccountChange` asked only
// `isRecording` (FSM `recording`). A continuous recording that has outlived
// its link keeps capturing with the FSM `disconnected`, so sign-out left the
// microphone running.
//
// DRIVEN THROUGH PRODUCTION: the real spill over a real temp directory (item
// 2, `support/live_settle_rig.dart`, whose journal filesystem can hold the
// product's renames), and the real LoginController + ChatController +
// PttSession with the continuous link-loss path (item 3). Fakes: the socket and
// the recorder.
//
// REVERSE CONTROLS (both seen red while writing this file, logs in the report):
//   · item 2 — stamp inside the queued closure again ⇒ the first case fails on
//     the digest (the stamp is the signed-out '' instead of h's);
//   · item 3 — ask only `isRecording` again ⇒ the second case fails on
//     `capture.currentState` (still recording after sign-out).

import 'dart:async';
import 'dart:io';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/audio/recording_account.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/audio/retained_audio_spill.dart';
import 'package:flowmic/src/audio/retained_audio_store.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/live_settle_rig.dart';
import 'support/temp_teardown.dart';

const CloudAccount _h = CloudAccount(jwt: 'jwt-h', email: 'h@example.com');

void main() {
  test(
      '🔴 item 2: a sign-out while the journal queue is busy does not change '
      'whose recording it is — the stamp is taken when recording starts',
      () async {
    final Rig r = await Rig.open();
    addTearDown(r.dispose);
    final LoginController login = LoginController(
      transport: r.transport,
      accountStore: InMemoryAccountStore(_h),
      saasEndpoint: 'https://example.invalid',
    );
    addTearDown(login.dispose);
    await login.hydrate();
    r.spill.recordingAccount.bind(() => login.email);

    // A first recording, open on disk.
    await r.spill.beginRecording();
    r.spill.appendCaptured(makePcm(frameBytes));
    await r.spill.journalFlush();

    // The disk stalls: the product's manifest publish (a rename) cannot land,
    // so closing the first recording holds the journal queue.
    final Completer<void> disk = Completer<void>();
    unawaited(r.journalFs.guard<void>(() => disk.future));
    final Future<void> ended = r.spill.endRecording();
    // The next recording starts while the queue is still busy — capture does
    // not wait for the journal (`beginRecording` mints the id synchronously).
    final Future<void> begun = r.spill.beginRecording();
    final String second = r.spill.liveAttempt!.recordingId;

    // …and the account goes away before the disk comes back.
    await login.logout();
    expect(login.email, isNull);

    disk.complete();
    await ended;
    await begun;
    r.spill.appendCaptured(makePcm(frameBytes));
    await r.spill.journalFlush();

    final RecordingManifest m = (await r.manifestOf(second))!;
    expect(m.configSnapshot[kConfigSnapshotAccount],
        accountDigest(_h.email),
        reason: 'the recording started under h; a stamp taken later names '
            'whoever is signed in then (here: nobody ⇒ 「unknown」, '
            'recoverable under any account)');
  });

  group('item 3: sign-out stops an offline continuous recording', () {
    late Directory tmp;
    late RetainedAudioStore store;
    late RetainedAudioSpill spill;
    late FakeSocketTransport transport;
    late FakeAudioRecorder recorder;
    late AudioCapture capture;
    late PttSession session;
    late ChatController controller;
    late LoginController login;

    setUp(() async {
      tmp = await Directory.systemTemp.createTemp('flowmic-rc3b-');
      store = RetainedAudioStore(dir: tmp, clock: () => 0);
      await store.open();
      spill = RetainedAudioSpill(store: store);
      transport = FakeSocketTransport();
      recorder = FakeAudioRecorder();
      capture = AudioCapture(recorder: recorder, spill: spill);
      session = newTestSession(
        transport: transport,
        audio: capture,
        stateMachine: FlowmicStateMachine(
            sessionDropGrace: const Duration(milliseconds: 80)),
        heartbeatInterval: const Duration(milliseconds: 40),
      );
      giveSessionAPairedIdentity(session);
      controller = ChatController(
        outboxStore: newTestOutboxStore(),
        outboxBlobs: newTestOutboxBlobs(),
        session: session,
        store: newTestStore(),
        destination: DestinationController(fixedRecordOnly: true),
        syncGate: TimelineSyncGate(transport: transport),
        localPrefs: InMemoryLocalPrefs(),
      );
      controller.backfill.dispose();
      login = LoginController(
        transport: transport,
        accountStore: InMemoryAccountStore(_h),
        saasEndpoint: 'https://example.invalid',
        // The closure main.dart passes.
        onBeforeAccountChange: () => controller.stopRecordingForAccountChange(),
      );
      await login.hydrate();
      transport.pushStatus(SocketStatus.connected);
    });

    tearDown(() async {
      login.dispose();
      await controller.dispose();
      await session.dispose();
      await spill.dispose();
      await store.dispose();
      await removeTempDir(tmp);
    });

    test(
        '🔴 the link dies past the grace, the continuous recording keeps the '
        'microphone, the user signs out ⇒ capture and the continuous session '
        'stop through the offline stop', () async {
      session.continuous.begin();
      expect(await session.pttDown(), isTrue);
      recorder.feed(makePcm(frameBytes));
      await Future<void>.delayed(Duration.zero);

      transport.pushStatus(SocketStatus.disconnected);
      await Future<void>.delayed(const Duration(milliseconds: 250));
      // POSITIVE CONTROL: the state under test — FSM no longer `recording`,
      // microphone still open.
      expect(controller.isRecording, isFalse);
      expect(session.continuousCapturingOffline, isTrue);
      expect(capture.currentState, RecorderState.recording);

      await login.logout();
      await Future<void>.delayed(Duration.zero);

      expect(capture.currentState, RecorderState.stopped,
          reason: 'the microphone must not outlive the account');
      expect(session.continuous.isActive, isFalse);
      expect(session.continuousCapturingOffline, isFalse);
    });
  });
}
