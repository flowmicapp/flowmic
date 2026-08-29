// T-6b — pure back-policy tests. Widget layer must not await PttSession here.
//
// 🔴 0.3.43 Q6 ADDENDUM (2026-08-28): the second group below is about the iOS
// EDGE-SWIPE BACK, which this file suddenly owns. Enabling the Cupertino page
// transition app-wide gives every pushed route a back gesture, and
// `_CupertinoBackGestureDetector` decides whether to arm by asking the route's
// `popDisposition` — i.e. by asking `PopScope.canPop`. So the chat page's
// `canPop` is no longer only 「what the system back button does」; it is now also
// 「whether a left-edge drag can leave this page」.
//
// 🔴 AND THAT IS WHY IT HAD TO BECOME DYNAMIC. The first version of this group
// asserted canPop was false in every state and labelled the clean case a GAP:
// `interceptBack` opened with `onBack != null`, true for the whole life of the
// pushed page, so the gesture the ruling asked for could never fire. The
// predicate now consults `chatBackKind`, so the ruling's two halves are two
// different answers — 「录音中滑动不退出、有草稿先确认」 blocks, clean leaves —
// and the group asserts BOTH. A file that only ever asserted 「false」 would have
// stayed green through the entire defect, which is what it did.
//
// ── REVERSE CONTROL (it really went red) ─────────────────────────────────────
// Hardcoding the disposition back to a constant in chat_flow_page.dart's build
// (`final bool backLeaves = false;`) and re-running THIS file, on dev-pc-a:
//
//   00:04 +5 -1: … 🔴 canPop is TRUE when clean — the gesture the ruling asked
//                for [E]
//     Expected: true
//       Actual: <false>
//   00:05 +5 -2: … 🔴 the disposition is FRESH — a recording that ended re-opens
//                the gesture without waiting for an unrelated rebuild [E]
//     Expected: true
//       Actual: <false>
//   00:05 +5 -3: … a pop in the clean state runs the leave cleanup once [E]
//     Expected: true
//       Actual: <false>
//   00:05 +5 -3: Some tests failed.
//
// ⚠️ THE TWO BLOCKING CASES STAYED GREEN (the `+5`), and that is the point of
// keeping all five: a constant `false` satisfies every negative assertion in
// this group. Only the three positive ones can tell a working predicate from a
// padlock — which is precisely the confusion the first version of this file
// shipped with. Restored from a byte copy; `REVERSE-CONTROL` grep = 0.
//
// Ruling: docs/decisions/2026-08-28-owner-settings-catalogue-shortpress-ios-swipe-rulings.md Q6
// Predicate + leave cleanup: lib/src/ui/chat_flow_back_disposition.dart.
// Mechanism + production wiring: ios_edge_swipe_back_test.dart.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_back_policy.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

Future<ChatController> _controller(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-back-0000000000000000000000000',
    'pc_name': 'Widget PC',
    'pc_instance_id': 'inst-back',
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
  return ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
}

/// The chat page as PRODUCTION pushes it: a route, with an `onBack` (main.dart
/// hands it `_session.transport.disconnect`).
///
/// ⚠️ `onBack` NO LONGER DECIDES `canPop` — it used to be the first term of
/// `interceptBack`, which is exactly the defect this group now pins. It is still
/// passed here because it is what production passes and because it is the
/// cleanup a successful pop must run; `ios_edge_swipe_back_test.dart` pins that
/// main.dart still hands it over.
Widget _pushedChat(ChatController c) => MaterialApp(
  home: ChatFlowPage(controller: c, onBack: () {}),
);

/// ⚠️ A PREDICATE, not `find.byType(PopScope)`. `PopScope` is generic and
/// `byType` matches the RUNTIME type exactly, so the type argument Dart infers
/// for the page's `onPopInvokedWithResult` closure would have to be guessed
/// right — and a wrong guess reads as 「no PopScope in the tree」, i.e. a finder
/// that quietly measures nothing. `is PopScope` accepts every instantiation.
bool _canPop(WidgetTester tester) {
  final Finder f = find.descendant(
    of: find.byType(ChatFlowPage),
    matching: find.byWidgetPredicate((Widget w) => w is PopScope),
  );
  expect(f, findsWidgets, reason: 'the page must own a PopScope at all');
  return (tester.widgetList(f).first as PopScope).canPop;
}

void main() {
  test('recording wins over an unsent buffer', () {
    expect(
      chatBackKind(isRecording: true, hasUnsentBuffer: true),
      ChatBackKind.stopRecording,
    );
  });

  test('unsent buffer alone → confirm discard', () {
    expect(
      chatBackKind(isRecording: false, hasUnsentBuffer: true),
      ChatBackKind.confirmDiscard,
    );
  });

  test('idle empty buffer → leave', () {
    expect(
      chatBackKind(isRecording: false, hasUnsentBuffer: false),
      ChatBackKind.leave,
    );
  });

  group('0.3.43 Q6 — what a back gesture may and may not do on the chat page', () {
    testWidgets('canPop is false while recording, so the swipe never arms', (
      WidgetTester tester,
    ) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController c = await _controller(transport);
      addTearDown(() async {
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
        await c.session.dispose();
      });
      await tester.pumpWidget(_pushedChat(c));
      await tester.pump();

      // Drive the FSM edge directly: the real `pttDown` chain deadlocks inside
      // testWidgets' FakeAsync zone (the documented reason every widget-layer
      // back test in this repo stays pure). This is the same state the async
      // chain lands in.
      c.session.fsm.onPttDown();
      await tester.pump();
      expect(c.isRecording, isTrue, reason: 'harness failed to enter RECORDING');

      expect(_canPop(tester), isFalse);
      // G-15①: the harness runs a real pair(), which arms the idle presence-poll
      // Timer. The binding checks for pending timers the instant the tree is torn
      // down — BEFORE addTearDown runs — so the session has to be quieted here.
      c.session.debugStopIdlePresencePoll();
      c.session.fsm.onPttCancel();
      await tester.pump();
    });

    testWidgets('canPop is false with an unsent buffer', (
      WidgetTester tester,
    ) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController c = await _controller(transport);
      addTearDown(() async {
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
        await c.session.dispose();
      });
      await tester.pumpWidget(_pushedChat(c));
      c.setBuffer('一句还没发出去的草稿');
      await tester.pump();
      expect(c.buffer, isNotEmpty, reason: 'harness failed to seed the buffer');

      expect(_canPop(tester), isFalse);
      // G-15①: the harness runs a real pair(), which arms the idle presence-poll
      // Timer. The binding checks for pending timers the instant the tree is torn
      // down — BEFORE addTearDown runs — so the session has to be quieted here.
      c.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 canPop is TRUE when clean — the gesture the ruling asked for',
        (WidgetTester tester) async {
      // 🔴 THIS ASSERTION WAS THE INVERSE ONE DAY AGO, and the flip is the whole
      // card. `interceptBack` used to open with `onBack != null`, a term that is
      // true for the entire life of the pushed page — so the swipe was refused in
      // EVERY state, including the clean one it was asked for. The predicate now
      // consults `chatBackKind`, so 「录音中滑动不退出、有草稿先确认」 keeps its two
      // blockers and everything else means what it says: leave.
      //
      // Asserted on `canPop` rather than on a drag because that is the value the
      // gesture reads: `_CupertinoBackGestureDetector` refuses to ARM on a route
      // whose pop disposition is `doNotPop`. The drag itself is exercised against
      // a synthetic route in ios_edge_swipe_back_test.dart, with a positive
      // control — the two files together say 「the mechanism works」 and 「this
      // page opts into it」, which is a different claim from either alone.
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController c = await _controller(transport);
      addTearDown(() async {
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
        await c.session.dispose();
      });
      await tester.pumpWidget(_pushedChat(c));
      await tester.pump();
      expect(c.isRecording, isFalse);
      expect(c.buffer, isEmpty);

      expect(_canPop(tester), isTrue);
      // G-15①: the harness runs a real pair(), which arms the idle presence-poll
      // Timer. The binding checks for pending timers the instant the tree is torn
      // down — BEFORE addTearDown runs — so the session has to be quieted here.
      c.session.debugStopIdlePresencePoll();
    });

    testWidgets('🔴 the disposition is FRESH — a recording that ended re-opens '
        'the gesture without waiting for an unrelated rebuild',
        (WidgetTester tester) async {
      // Card FB-7's law, which this change put back in play: canPop is read
      // OUTSIDE `build`'s `Listenable.merge`, and `isRecording` arrives through
      // that merge as a repaint-only update. Without the state-level listener,
      // the first back gesture after a recording ended would still be judged
      // against the previous answer — the classic 「one press too early」.
      //
      // The transition is what is measured, not the two ends: both ends are
      // already covered above, and only the transition can catch a stale read.
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController c = await _controller(transport);
      addTearDown(() async {
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
        await c.session.dispose();
      });
      await tester.pumpWidget(_pushedChat(c));
      await tester.pump();

      c.session.fsm.onPttDown();
      await tester.pump();
      expect(_canPop(tester), isFalse, reason: 'recording must block the swipe');

      c.session.fsm.onPttCancel();
      await tester.pump();
      expect(_canPop(tester), isTrue);
      c.session.debugStopIdlePresencePoll();
    });

    testWidgets('a pop in the clean state runs the leave cleanup once', (
      WidgetTester tester,
    ) async {
      // 🔴 THE OTHER HALF OF THE CARD, and the half a canPop assertion cannot
      // see. Letting the route go is only correct if the departure still does
      // what the header ← did — production's `onBack` is the transport
      // disconnect, so a swipe that popped without it would leave the page while
      // still holding the connection.
      //
      // ONCE, not twice: `onBack` used to run inside `_attemptBack` BEFORE its
      // own `Navigator.pop()`, and that pop fires this same `didPop == true`
      // callback. Had the call been added here without being removed there, the
      // header ← would have disconnected twice.
      int leaves = 0;
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController c = await _controller(transport);
      addTearDown(() async {
        await c.dispose();
        c.destination.dispose();
        c.store.dispose();
        await c.session.dispose();
      });

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (BuildContext context) => TextButton(
                onPressed: () => Navigator.of(context).push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        ChatFlowPage(controller: c, onBack: () => leaves++),
                  ),
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.byType(ChatFlowPage), findsOneWidget);
      expect(_canPop(tester), isTrue);

      // maybePop, not pop: it consults the pop disposition, which is exactly
      // what the system back and the edge-swipe do.
      final NavigatorState nav = tester.state(find.byType(Navigator).last);
      await nav.maybePop();
      await tester.pumpAndSettle();

      expect(find.byType(ChatFlowPage), findsNothing);
      expect(leaves, 1);
      c.session.debugStopIdlePresencePoll();
    });
  });
}
