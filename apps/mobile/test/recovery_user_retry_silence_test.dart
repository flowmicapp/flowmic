// 🔴 0.3.122 DEVICE CHECK (2026-11-11) — A PRESS OF 「TRY AGAIN NOW」 THAT COMES
// BACK AS SILENCE KEEPS THE RECORDING AND SAYS SO. MOUNTED ON THE SCREEN THE
// PRESS IS MADE ON, OVER THE REAL CHAIN.
//
// SPEC-REF:
//   docs/rebuild/15-TRANSCRIPTION-FINALS.md, the RC6 F3 correction of 2026-11-11
//   lib/src/session/recovery_leg_settle.dart `_finishVerdict` (`resultIsSilence`)
//   lib/src/ui/pending_recovery_page.dart `_noticeFor`
//   test/support/rc3_rig.dart (the rig: the real chain, a scripted relay)
//
// THE SHAPE, MEASURED on TB335ZC over the cloud relay, three times: a kept
// recording (the 「recorded over a different connection」 card and the
// 「speech recognition wasn't set up」 card) is pressed; the relay's gate
// accepts none of the audio and stamps the empty terminal final
// `empty_reason: 'no_voice'`; RC6 F3 settled that as silence and released the
// PCM; the page read 「the card is gone」 as its own answer and said nothing.
// The card was gone 2.5 s later and 13 hours later; no row, nothing on the
// computer. The same silence over LAN kept its card (A5-4).
//
// THE CASES:
//   ① the route-held card, pressed, silence back ⇒ the PCM stays, the card
//     stays as `emptyConfirmed`, the page says 「Tried again. This recording
//     still has no words in it.」 — the LAN outcome, word for word;
//   ② the engine-setup card, the same;
//   ③ CONTROL: the automatic route over the same silence still settles and
//     releases the audio (RC6 F3 ② is kept for `auto_retry`), so ①/② are not
//     green because silence stopped being read at all.
//
// MEASURED (reverse control, 2026-11-11): with `resultIsSilence` in
// `_finishVerdict` put back to `r.resultEmptyReason == kEmptyReasonNoVoice`
// (no attempt-kind arm), ① and ② fail on
//   Expected: true  Actual: <false>
//   the user pressed retry, not delete: the audio stays (O-5)
// and ③ stays green; restored, all three pass.

import 'dart:typed_data';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/pending_recovery.dart';
import 'package:flowmic/src/session/recording_route.dart';
import 'package:flowmic/src/session/recovery_backoff.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/pending_recovery_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

/// A recording id in the production shape (`run-<µs>-r<ms>`).
const String _id = 'run-1762800000000000-r1762800000000';

/// Two seconds of 16 kHz mono PCM16 — the length of the device recordings.
const int _bytes = 2 * 32000;

enum _Held { route, engineSetup, none }

/// A kept recording as an earlier session left it on disk.
Future<void> _seed(Rc3Rig r, _Held held) async {
  final RetainedAudioJournal j = await RetainedAudioJournal.open(
    dirPath: r.store.dirPath,
    recordingId: _id,
    fs: r.fs,
    configSnapshot: <String, Object?>{
      kConfigSnapshotMode: 'realtime',
      kConfigSnapshotSourceLang: 'zh',
      kConfigSnapshotPrefsDigest: '',
      // Recorded over LAN; the rig is on the relay now (device card one).
      if (held == _Held.route) kConfigSnapshotRouteChannel: 'lan',
    },
    commitInterval: const Duration(days: 1),
  );
  await j.appendPcm(Uint8List(_bytes));
  if (held == _Held.engineSetup) {
    // Device card two: the engine refused to open for want of a setup.
    j.addAttempt(JournalAttempt(
      attemptId: 'a0',
      startedAtMs: 0,
      kind: RecoveryAttemptKind.autoRetry.wire,
    ));
    j.closeAttempt('a0',
        outcome: JournalAttempt.outcomeFailed,
        failureCode: kSttConfigMissingCode);
  }
  await j.close();
}

/// The relay's gate accepted none of the audio: an empty terminal final,
/// stamped `no_voice`, with a complete receipt.
void _silenceRelay(Rc3Rig r) {
  r.relay.onStop = (Rc3Stop stop) {
    Future<void>.delayed(const Duration(milliseconds: 20), () {
      r.relay.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
        ...r.relay.terminal(stop, text: '', durationMs: stop.toMs - stop.fromMs),
        'empty_reason': 'no_voice',
      });
    });
  };
}

Future<void> _settle(WidgetTester tester, Rc3Rig r) async {
  for (int i = 0; i < 40; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
  }
  await tester.runAsync(() => r.until(() => !r.controller.backfill.isBusy));
  await tester.pump();
}

Future<void> _pressAndRead(WidgetTester tester, _Held held) async {
  final AppStrings en = AppStrings(AppLocale.en);
  late final Rc3Rig r;
  await tester.runAsync(() async {
    r = await Rc3Rig.open();
    r.session.serverChannel.value = ServerChannel.cloudRelay;
    _silenceRelay(r);
    await _seed(r, held);
    // The automatic route must leave a held recording alone (positive control
    // for the press being what feeds it).
    await r.controller.backfill.sweep(sourceLang: 'zh');
  });
  addTearDown(() => tester.runAsync(r.dispose));
  expect(r.relay.recoveryStarts, isEmpty,
      reason: 'setup: the card is held, nothing fed it automatically');

  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    home: PendingRecoveryPage(source: pendingRecoveryOf(r.controller), strings: en),
  ));
  await _settle(tester, r);
  expect(find.text(en.pendingRecoveryRetryNow), findsOneWidget,
      reason: 'setup: the held card offers the press');

  // Tapped inside `runAsync` so the press's chain (socket, journal, the
  // relay's reply timer) runs on the real clock, as it does on a phone; tapped
  // in the fake zone, every timer it arms waits for a `pump` that never comes.
  await tester.runAsync(() async => tester.tap(find.text(en.pendingRecoveryRetryNow)));
  await _settle(tester, r);

  expect(r.relay.recoveryStarts, hasLength(1),
      reason: 'positive control: the press reached the relay');
  expect(r.relay.recoveryStarts.single['attempt_kind'], 'user_retranscribe');
  expect(r.pcmOf(_id), isTrue,
      reason: 'the user pressed retry, not delete: the audio stays (O-5)');
  final PendingRecoveryItem item =
      (await tester.runAsync(() => pendingRecoveryOf(r.controller).list()))!.single;
  expect(item.state, PendingRecoveryState.emptyConfirmed,
      reason: 'the same card the LAN path leaves for the same silence');
  expect(find.textContaining(en.pendingRecoveryStateEmptyConfirmed), findsOneWidget,
      reason: 'the card is still on the screen the press was made on');
  expect(find.text(en.pendingRecoveryRetryStillEmpty), findsOneWidget,
      reason: 'the press is answered; a vanished card is not an answer');
}

void main() {
  testWidgets(
      '🔴 ① route-held card, 「Try again now」 over the relay, silence back ⇒ '
      'the recording stays and the page says it still has no words',
      (WidgetTester tester) => _pressAndRead(tester, _Held.route));

  testWidgets(
      '🔴 ② engine-setup card, 「Try again now」 over the relay, silence back ⇒ '
      'the same',
      (WidgetTester tester) => _pressAndRead(tester, _Held.engineSetup));

  testWidgets(
      'control ③: the AUTOMATIC route over the same silence still settles and '
      'releases the audio (RC6 F3 ② unchanged for auto_retry)',
      (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async {
      r = await Rc3Rig.open();
      r.session.serverChannel.value = ServerChannel.cloudRelay;
      _silenceRelay(r);
      await _seed(r, _Held.none);
      await r.controller.backfill.sweep(sourceLang: 'zh');
      await r.recoveries(1, max: const Duration(seconds: 10));
      await r.untilAsync(() async => !r.pcmOf(_id), max: const Duration(seconds: 10));
    });
    addTearDown(() => tester.runAsync(r.dispose));

    expect(r.relay.recoveryStarts, hasLength(1),
        reason: 'positive control: the automatic route fed it');
    expect(r.relay.recoveryStarts.single['attempt_kind'], 'auto_retry');
    final RecordingManifest m = (await tester.runAsync<RecordingManifest?>(r.manifest))!;
    expect(m.settled, isTrue);
    expect(m.attempts.last.outcome, RecoveryQueueState.settled);
    expect(r.pcmOf(_id), isFalse, reason: 'RC6 F3 ②: certified silence releases on the automatic route');
  });
}
