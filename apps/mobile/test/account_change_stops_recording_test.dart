// Card RC-S follow-up (MAIN, 2026-09-24) — signing out (or switching account)
// while a recording is running ends that recording through the user's own stop
// path BEFORE the account changes, and it settles under the account it was
// made under.
//
// WHY: before this, `LoginController.logout` / `handleAuthExpired` cleared the
// account and detached the blind store, and nothing touched the microphone. A
// recording in progress (a continuous one keeps running while the user is in
// settings) went on streaming after the account was gone, and a reconnect after
// the next sign-in could replay its ring into the next account's session.
//
// DRIVEN THROUGH PRODUCTION: the real `LoginController`, the real
// `ChatController` / `PttSession` / spill over a real temp directory
// (`support/live_settle_rig.dart`), wired with the same closure main.dart uses
// (the last case pins that main.dart does). Fakes: the socket and the recorder.
//
// REVERSE CONTROL (seen red while writing this file): delete the
// `_beforeAccountChange()` call from `LoginController.logout` ⇒ the first case
// fails on `recordingWhenCleared, isFalse` (the recorder was still running when
// the account was cleared).

import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/recording_account.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/live_settle_rig.dart';

void main() {
  test(
      '🔴 sign-out while recording: the recording is stopped (audio:stop sent, '
      'FSM out of RECORDING) before the account is cleared, nothing is '
      'streamed after, and it settles under the original account', () async {
    final Rig r = await Rig.open();
    addTearDown(r.dispose);
    final LoginController login = LoginController(
      transport: r.transport,
      accountStore: InMemoryAccountStore(
          const CloudAccount(jwt: 'jwt-h', email: 'h@example.com')),
      saasEndpoint: 'https://example.invalid',
      // The closure main.dart passes.
      onBeforeAccountChange: () => r.controller.stopRecordingForAccountChange(),
    );
    addTearDown(login.dispose);
    await login.hydrate();
    expect(login.email, 'h@example.com');
    r.spill.recordingAccount.bind(() => login.email);
    // The terminal final comes back only when the test says so: the cloud-relay
    // ordering, where it lands after the sign-out has finished.
    r.transport.holdTerminalFinal = true;

    await r.session.pttDown();
    final String id = r.spill.liveAttempt!.recordingId;
    for (int i = 0; i < 3; i++) {
      r.recorder.feed(makePcm(frameBytes));
      await r.pump();
    }
    expect(r.controller.isRecording, isTrue,
        reason: 'positive control: a recording is really running');

    List<String> names() =>
        r.transport.emitted.map((e) => e.name).toList();
    bool? recordingWhenCleared;
    bool? stopSentWhenCleared;
    login.addListener(() {
      if (login.email == null && recordingWhenCleared == null) {
        recordingWhenCleared = r.controller.isRecording;
        stopSentWhenCleared = names().contains(FlowMicEvents.audioStop);
      }
    });

    await login.logout();
    await r.pump(8);

    expect(recordingWhenCleared, isFalse,
        reason: 'the recording must be over before the account is cleared');
    expect(stopSentWhenCleared, isTrue,
        reason: 'audio:stop left on the original account\'s session');
    final List<String> sent = names();
    final int stopAt = sent.indexOf(FlowMicEvents.audioStop);
    expect(stopAt, lessThan(sent.indexOf(FlowMicEvents.mobileLogout)));
    expect(
        sent.skip(stopAt + 1).where((String n) =>
            n == FlowMicEvents.audioChunk || n == FlowMicEvents.audioStart),
        isEmpty,
        reason: 'no audio after the stop — nothing for another account to get');

    // The terminal final arrives on the same socket; the recording settles as
    // an ordinary release, stamped with h.
    r.transport.releaseTerminalFinal();
    await r.awaitSettleOf(id);
    final RecordingManifest m = (await r.manifestOf(id))!;
    expect(m.configSnapshot[kConfigSnapshotAccount],
        accountDigest('h@example.com'));
    expect(
        m.attempts
            .where((JournalAttempt a) => a.kind == 'live')
            .single
            .outcome,
        isNotNull,
        reason: 'settled, not abandoned');
    expect(r.controller.isRecording, isFalse);
  });

  test('signing out with no recording running touches nothing', () async {
    final Rig r = await Rig.open();
    addTearDown(r.dispose);
    final LoginController login = LoginController(
      transport: r.transport,
      accountStore: InMemoryAccountStore(
          const CloudAccount(jwt: 'jwt-h', email: 'h@example.com')),
      saasEndpoint: 'https://example.invalid',
      onBeforeAccountChange: () => r.controller.stopRecordingForAccountChange(),
    );
    addTearDown(login.dispose);
    await login.hydrate();
    await login.logout();
    expect(r.transport.emitted.map((e) => e.name),
        isNot(contains(FlowMicEvents.audioStop)));
  });

  test('🔴 production wires the hook (main.dart)', () {
    final String main = File('lib/main.dart').readAsStringSync();
    expect(
        main,
        contains('onBeforeAccountChange: () => '
            '_controller.stopRecordingForAccountChange()'));
  });
}
