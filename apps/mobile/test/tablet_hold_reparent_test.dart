// WP8 acceptance P0 — a hold STARTED on the tablet dock must survive the
// arrangement switch that the hold itself triggers.
//
// ── THE DEFECT (device-measured, TB335ZC, 2026-08-14) ────────────────────────
// VF-8's tablet branch is idle-only (`twoColumn = idleRows && width>=560`), so
// the moment an accepted press flips the FSM to RECORDING the dock rebuilds
// from the two-column arrangement into the phone arrangement — and the PttBar
// moves BETWEEN PARENTS (speak column → dock column). A ValueKey cannot carry
// an element across a reparent, so the element that owned the in-flight
// gesture (its `_active`, its recognizers, its pointer route) was disposed
// mid-hold: release and swipe-cancel never reached the controller and the
// recording ran until force-stop, minting a 30s record-only row per N-1 rolling
// segment (device evidence: scratch/wp8-r2-mid-hold.png — 3:40 · seg 8).
// The code comment beside the old ValueKey argued 「the tablet branch is
// idle-only, so no arrangement flip can happen mid-recording」 — the premise
// refutes itself: idle-only is exactly why the flip happens AT THE START of
// every recording. (anti-façade ④: a comment asserting behavior elsewhere.)
//
// ── THE FIX THIS TEST PINS ──────────────────────────────────────────────────
// The PttBar's element identity is held by a page-lifetime GlobalKey
// (`_ChatFlowPageState._pttBarKey`), which Flutter honors ACROSS reparents in
// the same frame — the element, its state and its live gesture survive the
// arrangement switch in both directions.
//
// ── P3 (0.3.1) UPDATE: the on-press flip this file documented IS GONE ───────
// The column count is (width × mode) now (`_dockTwoColumnRouted`), so an
// accepted press at tablet width no longer flips the arrangement at all — the
// two-column skeleton holds, the key column stays on screen dimmed and inert
// (asserted below), and the rect stability that buys is pinned by
// tablet_dock_layout_test.dart's press case. The GlobalKey STAYS regardless,
// because a reparent is still reachable MID-HOLD through the one input the
// press does not control: the dock's own width. A split-screen drag, a
// foldable posture change or a rotation resizes the dock under a live
// gesture, the arrangement flips with it, and the element must carry the
// hold across that reparent — so this test now drives exactly that: press on
// the two-column dock, RESIZE to phone width mid-hold (the reparent), then
// end the hold and require the controller heard it.
//
// The ending is a SWIPE-UP CANCEL, not a release: `PttSession.pttUp` awaits
// the audio detach and deadlocks inside FakeAsync (measured account in
// mic_permission_denial_widget_test.dart's `_swipeUpCancel` doc — same
// harness, same reason). The cancel path is synchronous and proves the same
// fact: pointer events after the flip still reach the surviving element.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

final Finder _group = find.byKey(const ValueKey<String>('compose.keys.group'));
final Finder _bar = find.byKey(const ValueKey<String>('ptt.bar'));

Future<ChatController> _pumpPage(
  WidgetTester tester, {
  required double width,
  required double height,
}) async {
  tester.view.physicalSize = Size(width * 3, height * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  giveSessionAPairedIdentity(session);
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
    // 🔴 NO `await controller.session.dispose()` here — unlike
    // tablet_dock_layout_test (which never starts a recording), this test
    // runs a real accepted hold, and session.dispose() then awaits the audio
    // detach chain that NEVER completes inside FakeAsync (the exact measured
    // deadlock mic_permission_denial_widget_test documents; its harness omits
    // the await for the same reason). The cancelled recording leaves no live
    // ticker, so nothing leaks.
  });
  await controller.loadSendPolicy();
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return controller;
}

void main() {
  testWidgets(
    '🔴 WP8-P0 (P3-updated): a hold that a mid-hold RESIZE reparents to the '
    'phone dock still ends when the pointer lifts',
    (WidgetTester tester) async {
      final ChatController controller =
          await _pumpPage(tester, width: 800, height: 900);

      // Preflight: this IS the two-column dock.
      expect(_group, findsOneWidget,
          reason: 'harness: expected the tablet arrangement at 800dp');

      // Accepted press — same drive as U2's helper: past the long-press
      // timeout, then let the acceptance settle.
      final TestGesture g =
          await tester.startGesture(tester.getCenter(find.byType(PttBar)));
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
      await tester.pump();

      // P3 (0.3.1): the press itself no longer flips the arrangement — the
      // key column HOLDS (dim + inert skeleton), it does not leave the tree.
      // The pre-P3 assertion here (`_group findsNothing` — 「the flip
      // happened」) is retired WITH the flip.
      expect(controller.isRecording, isTrue,
          reason: 'harness: the press was not accepted — nothing to prove');
      expect(_group, findsOneWidget,
          reason: 'P3: recording must keep the key column skeleton at tablet '
              'width — if it left the tree, the on-press flip is back');

      // 🔴 THE REPARENT, by the one input a press does not control: the
      // dock's own width. Shrinking the window under a live hold (split
      // screen, foldable, rotation) flips tablet→phone, and the PttBar moves
      // BETWEEN PARENTS (speak column → dock column). On a ValueKey build
      // these pointer events would now go to a disposed element and the FSM
      // would stay RECORDING forever (the original device evidence: 3:40
      // across 8 rolling segments before force-stop).
      tester.view.physicalSize = const Size(400 * 3, 900 * 3);
      await tester.pump();
      await tester.pump();
      expect(_group, findsNothing,
          reason: 'harness: the phone dock hides the key group while '
              'recording — if it is still here, the resize never reparented '
              'and this test proved nothing');
      expect(controller.isRecording, isTrue,
          reason: '🔴 the resize itself killed the hold — the reparent '
              'orphaned the gesture (WP8-P0)');

      // Now the other half of the gesture, delivered AFTER the reparent.
      await g.moveBy(const Offset(0, -120));
      await tester.pump();
      await tester.pump();
      await g.up();
      await tester.pump();
      await tester.pump();

      expect(controller.isRecording, isFalse,
          reason: '🔴 the lift never reached the controller — the mid-hold '
              'reparent orphaned the in-flight hold (WP8-P0)');

      // And the dock is whole again: idle phone dock, bar back to idle face.
      expect(_group, findsOneWidget,
          reason: 'idle again ⇒ the key group is back');
      expect(_bar, findsOneWidget);
    },
  );
}
