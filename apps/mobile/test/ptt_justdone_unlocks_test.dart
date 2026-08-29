// NR-4-P1 (a) acceptance — the JUST_DONE window stops blocking a new hold.
//
// SPEC-REF: docs/strategy/2026-08-27-next-release-feature-and-optimization-
//   ledger.md §4 row a + §4 分期方案 P1 ① (「解锁 a——justDone 只是视觉面，不再
//   占互斥」); docs/rebuild/08-MOBILE-SPEC.md §2 (the PTT FSM).
//
// THE MEASURED DEFECT: after every utterance the user was locked out for the
// whole final-wait PLUS the 1500 ms green ✓ face. Four independent layers each
// spelled `== SessionState.idle`: the bar's `_enabled`, `ChatController.canPtt`,
// `PttSession.pttDown` and `FlowmicStateMachine.onPttDown`. This file drives
// all four, because unlocking three of them and leaving the fourth shut is a
// PTT bar that lights up and then refuses.
//
// ── REVERSE CONTROLS (each ACTUALLY run on 2026-08-27, then reverted; the
//    residual-string grep came back 0 and the file re-greened at 10/10) ───────
// ① `sessionAcceptsPttDown` narrowed back to `s == SessionState.idle`
//    (i.e. re-adding justDone to the blocked set at the ONE author):
//      → 6 red / 4 green. Named:
//      「the FSM accepts a fresh hold from the JUST_DONE window」
//        Expected: SessionState:<recording>  Actual: SessionState:<justDone>
//      「canPtt is true during JUST_DONE …」   Expected: true  Actual: <false>
//      「the data layer accepts a hold …」     Expected: true  Actual: <false>
//      「two sentences back to back …」        Expected: <2>   Actual: <1>
//      (plus the enum table and the timer case.) The three `the bar` cases
//      stayed GREEN — which is exactly why the widget gate is asserted
//      separately: the state layer cannot see it and it cannot see the state
//      layer.
// ② `PttBar._enabled` given `widget.visual != PttVisual.justDone` back:
//      → 2 red / 8 green. 「the BAR accepts a press on the done face」
//        Expected: <1>  Actual: <0>   (onDown never fired)
//      …and ONLY those two, the mirror image of ①.
// ③ The `_justDoneTimer?.cancel()` in `onPttDown` deleted:
//      「leaving JUST_DONE by this edge leaves NO timer behind」
//        Expected: <0>  Actual: <1>   (one armed Timer left inside RECORDING)
//    🔴 THIS ONE CAME BACK GREEN THE FIRST TIME, and the case was rewritten
//    because of it — see the long note on that case. The original assertion
//    (「the session is still RECORDING 4 s later」) could not fail, because
//    `_onJustDoneTimerFired` re-checks `_sess`. A reverse control that stays
//    green is not a nuisance, it is the finding: it says the sentence in the
//    test header was false. The assertion that DOES distinguish the two
//    implementations is the pending-timer count, and that is what the case
//    asserts now.

import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// Walk a fresh FSM to the JUST_DONE face the way the wire does.
FlowmicStateMachine _atJustDone() {
  final FlowmicStateMachine fsm = FlowmicStateMachine();
  fsm.onSocketStatus(SocketStatus.connected);
  fsm.onPttDown();
  fsm.onPttUp();
  fsm.onSttFinal();
  expect(fsm.session, SessionState.justDone, reason: 'harness precondition');
  return fsm;
}

class _Harness {
  _Harness() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    controller = ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: newTestStore(),
      destination: DestinationController(),
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final ChatController controller;

  /// One complete utterance, ending ON the JUST_DONE face — the 1500 ms window
  /// is left ARMED on purpose, because that window is what this card is about.
  Future<void> speakLeavingJustDone(String text) async {
    await controller.pttDown();
    await controller.pttUp();
    transport.pushIncoming(FlowMicEvents.sttFinal, <String, Object?>{
      'text': text,
      'confidence': 0.95,
      'language': 'zh',
      'segment_idx': 0,
      'is_segment': false,
      'duration_ms': 1200,
    });
    await pumpEventQueue();
    expect(
      controller.sessionState,
      SessionState.justDone,
      reason: 'harness precondition',
    );
  }

  Future<void> dispose() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  group('the ONE author', () {
    test('sessionAcceptsPttDown admits idle and justDone, and NOTHING else', () {
      // A whole-enum table rather than two spot checks: the failure this
      // guards against is a fifth state quietly joining the set, and a test
      // that only names the two it likes cannot see that.
      expect(
        <SessionState, bool>{
          for (final SessionState s in SessionState.values)
            s: sessionAcceptsPttDown(s),
        },
        <SessionState, bool>{
          SessionState.disconnected: false,
          SessionState.idle: true,
          SessionState.recording: false,
          SessionState.processing: false,
          SessionState.justDone: true,
        },
      );
    });
  });

  group('the FSM', () {
    test('accepts a fresh hold from the JUST_DONE window', () {
      final FlowmicStateMachine fsm = _atJustDone();
      final List<IllegalTransition> refused = <IllegalTransition>[];
      final List<FlowmicStateSnapshot> emitted = <FlowmicStateSnapshot>[];
      fsm.illegalTransitions.listen(refused.add);
      fsm.changes.listen(emitted.add);

      fsm.onPttDown();

      expect(fsm.session, SessionState.recording);
      expect(refused, isEmpty, reason: 'the press was refused, not accepted');
      expect(
        emitted.length,
        1,
        reason: '🔴 more than one transition for one press — a leftover '
            'JUST_DONE edge fired alongside the accepted one',
      );
      fsm.dispose();
    });

    test('leaving JUST_DONE by this edge leaves NO timer behind', () {
      // 🔴 WRITTEN THE OTHER WAY ROUND FIRST, AND THAT VERSION WAS A
      // TAUTOLOGY. The first cut asserted 「the session is still RECORDING
      // 4 s later」 with the story 「an orphaned timer would write IDLE over a
      // live recording」. Reverse control ③ (delete the `_justDoneTimer
      // ?.cancel()` in `onPttDown`) came back GREEN: `_onJustDoneTimerFired`
      // guards on `if (_sess == justDone)`, so the orphan really is inert and
      // the story was false. Kept as the outcome assertion below — it is worth
      // pinning — but it is NOT what the cancel buys, and a case that cannot
      // report the absence of the thing it is named after is the shape this
      // repo calls 「a reverse control aimed the wrong way」 (0.2.52).
      //
      // What the cancel actually buys is the PENDING TIMER: one real armed
      // Timer per press, holding a closure over this FSM, surviving into an
      // unrelated state. `fakeAsync` can see exactly that, and it is the only
      // assertion here that distinguishes the two implementations.
      fakeAsync((FakeAsync async) {
        final FlowmicStateMachine fsm = _atJustDone();
        expect(
          async.nonPeriodicTimerCount,
          1,
          reason: 'harness precondition: the 1500 ms window is armed',
        );
        // 1499 ms in — one millisecond short of firing on its own.
        async.elapse(const Duration(milliseconds: 1499));

        fsm.onPttDown();

        expect(fsm.session, SessionState.recording);
        expect(
          async.nonPeriodicTimerCount,
          0,
          reason: '🔴 the JUST_DONE window is still armed inside a RECORDING '
              'session. It is inert TODAY only because _onJustDoneTimerFired '
              'happens to re-check `_sess`; the state that reaches that guard '
              'is one where a timer for a finished utterance is still counting '
              'down over a live one.',
        );
        // The outcome, pinned separately: well past both the original deadline
        // and a whole second window.
        async.elapse(const Duration(seconds: 4));
        expect(fsm.session, SessionState.recording);
        fsm.dispose();
        async.flushTimers();
      });
    });

    test('🔴 THE BOUNDARY: PROCESSING is still refused, and says why', () {
      final FlowmicStateMachine fsm = FlowmicStateMachine();
      fsm.onSocketStatus(SocketStatus.connected);
      fsm.onPttDown();
      fsm.onPttUp();
      expect(fsm.session, SessionState.processing);
      final List<IllegalTransition> refused = <IllegalTransition>[];
      fsm.illegalTransitions.listen(refused.add);

      fsm.onPttDown();

      expect(
        fsm.session,
        SessionState.processing,
        reason: '🔴 PROCESSING was opened — two utterances in flight, which is '
            'the coexistence 08 §2 forbids. This card deliberately did NOT '
            'unlock it (see sessionAcceptsPttDown).',
      );
      expect(refused.single.trigger, 'pttDown');
      expect(refused.single.reason, contains('idle|justDone'));
      fsm.dispose();
    });
  });

  group('the two gates above the FSM', () {
    test('canPtt is true during JUST_DONE and false during PROCESSING',
        () async {
      final _Harness h = _Harness();
      await h.speakLeavingJustDone('第一句');
      expect(
        h.controller.canPtt,
        isTrue,
        reason: '🔴 the UI mirror still locks the done face ⇒ the bar is grey '
            'for 1500 ms after every sentence (ledger §4 row a)',
      );

      // Same harness, one utterance later, stopped at PROCESSING.
      await h.controller.pttDown();
      await h.controller.pttUp();
      expect(h.controller.sessionState, SessionState.processing);
      expect(
        h.controller.canPtt,
        isFalse,
        reason: 'the boundary this card keeps: PROCESSING stays shut',
      );
      await h.dispose();
    });

    test('the data layer accepts a hold from JUST_DONE and really starts one',
        () async {
      final _Harness h = _Harness();
      await h.speakLeavingJustDone('第一句');
      final int startsBefore =
          h.transport.emittedWhere(FlowMicEvents.audioStart).length;

      final bool ok = await h.controller.pttDown();

      expect(ok, isTrue);
      expect(h.controller.sessionState, SessionState.recording);
      // 🔴 The claim is 「a new utterance began」, not 「a bool came back true」:
      // the proof is the frame on the wire, because that is what the server
      // and the engine actually see.
      expect(
        h.transport.emittedWhere(FlowMicEvents.audioStart).length,
        startsBefore + 1,
        reason: '🔴 the gate opened but no audio:start left the phone — the '
            'hold was accepted by the UI and dropped by the data layer',
      );
      await h.dispose();
    });

    test('two sentences back to back need NO justDone release in between',
        () async {
      // The regression this card is FOR, stated as the user states it. Note
      // what this replaces: the pre-existing harness in chat_controller_test
      // .dart has to call `session.fsm.onJustDoneTimeout()` inside `speak()`
      // 「so the NEXT pttDown really succeeds」 — a test helper carrying a
      // workaround for the product defect. That workaround stays where it is
      // (it is still legal), but nothing here uses it.
      final _Harness h = _Harness();
      await h.speakLeavingJustDone('第一句');
      await h.speakLeavingJustDone('第二句');
      expect(
        h.transport.emittedWhere(FlowMicEvents.audioStart).length,
        2,
        reason: '🔴 the second sentence never started — the 1500 ms face ate it',
      );
      await h.dispose();
    });
  });

  group('the bar', () {
    /// A press-and-hold on the bar, released. Returns how many times the bar
    /// asked the layer below to start an utterance.
    Future<int> holdOn(WidgetTester tester, PttVisual visual) async {
      int downs = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: PttBar(
                visual: visual,
                strings: AppStrings.of(AppLocale.zh),
                onDown: () async {
                  downs++;
                  return true;
                },
                onUp: () async {},
                onCancel: () async {},
              ),
            ),
          ),
        ),
      );
      final TestGesture g = await tester.startGesture(
        tester.getCenter(find.byKey(const ValueKey<String>('ptt.bar'))),
      );
      // Past the 300 ms accept edge, then release.
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
      await g.up();
      await tester.pumpAndSettle();
      return downs;
    }

    testWidgets('the BAR accepts a press on the done face', (
      WidgetTester tester,
    ) async {
      expect(
        await holdOn(tester, PttVisual.justDone),
        1,
        reason: '🔴 the bar itself is still disabled on justDone — the three '
            'gates below it can be as open as they like and the finger never '
            'reaches them',
      );
    });

    testWidgets('the BAR still refuses processing and disabled', (
      WidgetTester tester,
    ) async {
      expect(await holdOn(tester, PttVisual.processing), 0);
      expect(await holdOn(tester, PttVisual.disabled), 0);
    });

    testWidgets(
        'a press on the done face RETIRES it — no ✓ and no green over '
        '「正在启动麦克风」', (WidgetTester tester) async {
      final AppStrings s = AppStrings.of(AppLocale.zh);
      // onDown never completes ⇒ the widget is parked in the `_starting`
      // window, which is exactly the frame under test (the real one lasts as
      // long as the permission gate + the native recorder open).
      final Completer<bool> held = Completer<bool>();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Center(
              child: PttBar(
                visual: PttVisual.justDone,
                strings: s,
                onDown: () => held.future,
                onUp: () async {},
                onCancel: () async {},
              ),
            ),
          ),
        ),
      );
      final TestGesture g = await tester.startGesture(
        tester.getCenter(find.byKey(const ValueKey<String>('ptt.bar'))),
      );
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();

      expect(
        find.text(s.pttStartingMic),
        findsOneWidget,
        reason: 'harness precondition: the bar is in the `_starting` window',
      );
      expect(
        find.byIcon(Icons.check),
        findsNothing,
        reason: '🔴 a ✓ beside 「正在启动麦克风」 — the face says the previous '
            'sentence is finished while the label says a new one is starting',
      );
      final Container box = tester.widget<Container>(
        find.byKey(const ValueKey<String>('ptt.bar')),
      );
      final Color fill = (box.decoration! as BoxDecoration).color!;
      expect(
        fill,
        isNot(FlowMicDockColors.doneFlash),
        reason: '🔴 the green DONE flash is still painted under a label that '
            'says a new utterance is starting (R11: a status word nothing '
            'behind it supports)',
      );

      held.complete(true);
      await g.up();
      await tester.pumpAndSettle();
    });
  });
}
