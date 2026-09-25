// 🔴 CARD RC4 — A RECOVERY PASS IS NOT A PRESS. MOUNTED ON THE LIST SCREEN
// THE PHANTOM WAS SEEN ON.
//
// SPEC-REF:
//   `_dispatch/2026-09-24-cr12e-rerun4.report.md`, "Speaking while a recovery
//     runs" (evidence `r4-YL-list-during-attempt1.png`): while a background
//     recovery attempt ran, the light-record list drew a live 「转录中」
//     bubble carrying the engine's STT_NETWORK_DROP sentence (「…请再说一遍」)
//     and the button read 「松开 结束」 over the swipe-up strip, with nobody
//     holding anything.
//   apps/mobile/lib/src/ptt/ptt_backfill.dart `openSessionIsRecovery` /
//     `recoveryOwnsSession` (whose session it is, next to what the FSM says)
//   apps/mobile/lib/src/session/chat_ptt_lifecycle.dart `pressSessionState`,
//     `hasLiveDraft`, `isRecording`, `recoveryRefusesPress`
//   apps/mobile/lib/src/session/chat_notices.dart `onSttStalledRouted`
//   apps/mobile/lib/src/session/chat_asr_health_wire.dart
//
// (A) A journal recovery attempt holds the wire in RECORDING, an interim and a
//     terminal STT_NETWORK_DROP arrive for it. The list shows no draft row, no
//     press face, no recording strip, no stall sentence. A live press then
//     yields the attempt and gets the normal press UI; the attempt's latched
//     error, consumed by the yield, raises no banner. Positive controls: the
//     same finders DO find the live draft, the press face, the strip, and —
//     once the live press itself hits the same engine error — the sentence.
// (B) The attempt waits in PROCESSING and then stalls: no busy face, no
//     banner, while the stall still reaches the stream the recovery leg reads.
//     A legacy segment pass (no identity, cannot yield) shows the busy face,
//     never the recording one.
//
// Reverse controls (logs in the RC4 report): the recovery flag never written
// in `beginBackfill` ⇒ (A) and (B) red; the stall gate removed ⇒ (B) red on
// the banner; the health gate removed ⇒ (A) red on the tracker.
//
// Assertions use getters and widget types, never literal copy.

import 'dart:async';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/retained_audio_journal.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/recovery_identity.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show FlowMode;
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/chat_message_tile.dart' show LiveDraftTile;
import 'package:flowmic/src/ui/recording_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/rc3_rig.dart';

final AppStrings _zh = AppStrings.of(AppLocale.zh);

/// The sentence the device showed, through the selector that paints it.
final String _dropSentence = _zh.sttStallBannerMessage(
    const SttStall(SttStallReason.engineError, code: 'STT_NETWORK_DROP'));

const String _recoveryWords = 'RECOVERY-INTERIM-WORDS';
const String _liveWords = 'LIVE-INTERIM-WORDS';

RecoveryIdentity _identity(String attemptId) => RecoveryIdentity(
      recordingId: 'rec-rc4',
      jobId: 'job-rc4',
      attemptId: attemptId,
      operationId: 'op-rc4',
      attemptKind: RecoveryAttemptKind.autoRetry,
      range: const RecoverySampleRange(0, 160000),
      audioFormatVersion: RecordingManifest.currentFormatVersion,
    );

/// Open a journal recovery attempt on the wire exactly as
/// `recovery_leg_wire.dart` `_runOnWire` does: `beginBackfill` with an
/// identity, then the ledger registration.
void _openJournalAttempt(Rc3Rig r, String attemptId) {
  expect(
    r.session.beginBackfill(
      mode: FlowMode.realtime,
      sourceLang: 'zh',
      identity: _identity(attemptId),
    ),
    BackfillStart.started,
  );
  r.session.articles.attempts.openedRecovery(
    attemptId: attemptId,
    recordingId: 'rec-rc4',
    rangeStartSample: 0,
    rangeEndSample: 160000,
    rangeMs: 10000,
  );
}

Future<void> _interim(Rc3Rig r, String text) => r.push(
    FlowMicEvents.sttInterim,
    <String, Object?>{'text': text, 'segment_idx': 0});

Future<void> _networkDrop(Rc3Rig r) =>
    r.push(FlowMicEvents.sttError, <String, Object?>{
      'code': 'STT_NETWORK_DROP',
      'message': 'engine link dropped',
      'retryable': false,
    });

Future<void> _mount(WidgetTester tester, Rc3Rig r) async {
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: r.controller)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

/// Nothing on the list may speak for a press while a recovery runs.
void _expectNoPhantomPress({required String because}) {
  expect(find.byType(LiveDraftTile), findsNothing, reason: '$because: draft row');
  expect(find.textContaining(_zh.pttRecording), findsNothing,
      reason: '$because: 「release to end」 face');
  expect(find.byType(RecordingPanel), findsNothing, reason: '$because: recording strip');
  expect(find.textContaining(_zh.recSwipeCancel), findsNothing,
      reason: '$because: swipe-up hint');
  expect(find.textContaining(_dropSentence), findsNothing,
      reason: '$because: 「say it again」 for words nobody said');
  expect(find.textContaining(_recoveryWords), findsNothing,
      reason: '$because: the recovery interim as a live draft');
}

void main() {
  testWidgets(
      '🔴 (A) a recovery attempt in RECORDING with an interim and a terminal '
      'engine error draws no press; a live press then yields it and gets the '
      'normal press UI', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async => r = await Rc3Rig.open());
    addTearDown(() => tester.runAsync(r.dispose));
    await _mount(tester, r);

    await tester.runAsync(() async {
      _openJournalAttempt(r, 'att-a');
      await _interim(r, _recoveryWords);
      await _networkDrop(r);
    });
    await _settle(tester);

    // Positive controls: the wire really is in a recovery's RECORDING, and the
    // interim really reached the session (the probe is not blind).
    expect(r.session.fsm.session, SessionState.recording);
    expect(r.session.recoveryHoldsWire, isTrue);
    expect(r.session.segments.unsettledJoined, contains(_recoveryWords));
    _expectNoPhantomPress(because: 'recovery in RECORDING');
    expect(find.textContaining(_zh.pttHoldNoted), findsOneWidget,
        reason: 'the button shows its resting (record-only) face');
    expect(r.controller.isRecording, isFalse, reason: 'Back must not stop it');
    expect(r.controller.asrHealth.value.terminalError, isNull,
        reason: 'the tracker behind the draft note and the warning buzz');
    expect(r.controller.canPtt, isTrue, reason: 'a journal attempt yields to a press');

    // The live press: the attempt yields (its latched error is consumed by the
    // yield and must not surface), the press is the user's.
    late final bool pressed;
    await tester.runAsync(() async {
      pressed = await r.controller.pttDown();
      await r.feedMs(1000);
      await _interim(r, _liveWords);
    });
    await _settle(tester);

    expect(pressed, isTrue);
    expect(
      r.relay.emittedWhere(FlowMicEvents.audioStop).where((e) =>
          e.data is Map<String, Object?> &&
          (e.data! as Map<String, Object?>)['discard'] == true),
      hasLength(1),
      reason: 'the recovery was thrown away on the relay (the yield path)',
    );
    expect(r.controller.sttStalled, isNull,
        reason: 'the yielded attempt\'s latched error is not the press\'s');
    expect(find.textContaining(_dropSentence), findsNothing);
    expect(find.textContaining(_zh.pttRecording), findsOneWidget,
        reason: 'positive control: the live press face');
    expect(find.byType(RecordingPanel), findsOneWidget,
        reason: 'positive control: the live recording strip');
    expect(find.byType(LiveDraftTile), findsOneWidget,
        reason: 'positive control: the live draft row');
    expect(find.textContaining(_liveWords), findsOneWidget);
    expect(find.textContaining(_recoveryWords), findsNothing);

    // Positive control for the sentence finder: the SAME engine error on the
    // user's own press is shown, at once, in the draft row.
    await tester.runAsync(() => _networkDrop(r));
    await _settle(tester);
    expect(find.textContaining(_dropSentence), findsWidgets,
        reason: 'positive control: the live press\'s own engine error');

    await tester.runAsync(() async {
      await r.controller.pttUp();
      await pumpEventQueue();
    });
    await _settle(tester);
    expect(r.controller.sttStalled, isNotNull,
        reason: 'positive control: the live stall reaches the banner source');
  });

  testWidgets(
      '🔴 (B) a recovery attempt waiting in PROCESSING, then stalling, draws no '
      'busy face and no banner; a legacy pass that cannot yield shows the busy '
      'face, never the recording one', (WidgetTester tester) async {
    late final Rc3Rig r;
    await tester.runAsync(() async => r = await Rc3Rig.open());
    addTearDown(() => tester.runAsync(r.dispose));
    await _mount(tester, r);

    final List<SttStall> stalls = <SttStall>[];
    final StreamSubscription<SttStall> sub = r.session.sttStalled.listen(stalls.add);
    addTearDown(sub.cancel);

    await tester.runAsync(() async {
      _openJournalAttempt(r, 'att-b');
      await _interim(r, _recoveryWords);
      r.session.endBackfill();
      await pumpEventQueue();
    });
    await _settle(tester);

    expect(r.session.fsm.session, SessionState.processing,
        reason: 'positive control: the attempt waits on the relay');
    _expectNoPhantomPress(because: 'recovery in PROCESSING');
    expect(find.textContaining(_zh.pttProcessing), findsNothing,
        reason: 'a pass that yields keeps the resting face');
    expect(find.textContaining(_zh.pttHoldNoted), findsOneWidget);

    await tester.runAsync(() => _networkDrop(r));
    await _settle(tester);

    expect(stalls, hasLength(1),
        reason: 'positive control: the stall happened, on the stream the '
            'recovery leg reads for its own verdict');
    expect(r.session.fsm.session, SessionState.idle);
    expect(r.controller.sttStalled, isNull, reason: 'no banner source');
    expect(find.textContaining(_dropSentence), findsNothing, reason: 'no banner');

    // The legacy segment leg: no identity, cannot yield, refuses a press.
    await tester.runAsync(() async {
      expect(
        r.session.beginBackfill(mode: FlowMode.realtime, sourceLang: 'zh'),
        BackfillStart.started,
      );
      await _interim(r, _recoveryWords);
    });
    await _settle(tester);
    expect(r.session.fsm.session, SessionState.recording);
    expect(r.controller.canPtt, isFalse);
    expect(find.textContaining(_zh.pttProcessing), findsOneWidget,
        reason: 'a pass that cannot yield shows the busy face');
    _expectNoPhantomPress(because: 'legacy recovery in RECORDING');

    await tester.runAsync(() async {
      r.session.abortBackfill();
      await pumpEventQueue();
    });
  });
}
