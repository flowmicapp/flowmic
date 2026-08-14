// Owner report (device, 2026-08-14, auto-deliver mode): 「当我按下说话按钮，
// 按钮会向下移动，但我按的位置还是在此前的位置 … 原本按钮下有一行文字，应该是
// 按下后这行文字隐藏掉的原因。按下时需要保持界面的稳定。」
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// The dock is a bottom-anchored column and the PA-2 caption is the last child
// under the PTT bar. `pttCaption` returns '' on the recording face (A3 — the
// strip owns that moment), and `_dockCaptionRouted` used to return null for
// '' so both arrangements dropped the row from the tree. Removing a row BELOW
// a bottom-anchored bar moves the bar DOWN by that row's height — at the exact
// moment the finger lands on it. The finger has not moved; the button has.
//
// ── THE FIX THIS TEST PINS ──────────────────────────────────────────────────
// The captionless faces render an invisible ghost of the pre-press caption
// (same string, byte-identical style via `_captionText`, `Visibility` with
// maintainSize) so the slot's GEOMETRY never changes across the press edge.
// The assertion is on the bar's on-screen rect — the thing under the finger —
// not on any implementation detail of the slot.
//
// The hold ends with the swipe-up cancel, not a release: `PttSession.pttUp`
// awaits the audio detach chain that never completes inside FakeAsync (the
// measured deadlock mic_permission_denial_widget_test.dart documents; same
// harness shape as tablet_hold_reparent_test.dart, same reason).

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

final Finder _bar = find.byKey(const ValueKey<String>('ptt.bar'));
final Finder _caption = find.byKey(const ValueKey<String>('ptt.caption'));
final Finder _ghost = find.byKey(const ValueKey<String>('ptt.caption.ghost'));

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
    // No `await session.dispose()`: this test runs a real accepted hold, and
    // dispose then awaits the audio detach that never completes in FakeAsync
    // (tablet_hold_reparent_test.dart documents the same omission).
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
    '🔴 the PTT bar does not move under the finger when a hold is accepted '
    '(auto-deliver; the caption slot keeps its geometry)',
    (WidgetTester tester) async {
      final ChatController controller =
          await _pumpPage(tester, width: 400, height: 800);

      // Preflight: idle face, visible caption, no ghost.
      expect(_bar, findsOneWidget);
      expect(_caption, findsOneWidget,
          reason: 'harness: idle in auto-deliver mode must carry a caption — '
              'without one there is nothing whose disappearance could move '
              'the bar, and this test would prove nothing');
      expect(_ghost, findsNothing);
      final Rect idleRect = tester.getRect(_bar);

      // Accepted press (past the long-press timeout), FSM → recording.
      final TestGesture g =
          await tester.startGesture(tester.getCenter(find.byType(PttBar)));
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
      await tester.pump();
      expect(controller.isRecording, isTrue,
          reason: 'harness: the press was not accepted — nothing to prove');

      // 🔴 THE assertion: the rect under the finger is the rect that was
      // under the finger. Whole-rect equality — top AND height — so neither
      // a slide nor a resize can pass.
      final Rect recordingRect = tester.getRect(_bar);
      expect(recordingRect, idleRect,
          reason: '🔴 the bar moved when the hold was accepted — the dock '
              'below it changed height under the finger (owner 2026-08-14: '
              '按下时需要保持界面的稳定)');

      // The mechanism, named: the visible caption is gone (A3 shows none),
      // and the ghost holds its geometry.
      expect(_caption, findsNothing,
          reason: 'A3 carries no visible caption — the mock still holds');
      expect(_ghost, findsOneWidget,
          reason: 'the empty slot must still be laid out, or the bar above '
              'it slides down');

      // End the hold (swipe-up cancel — see header for why not a release).
      await g.moveBy(const Offset(0, -120));
      await tester.pump();
      await tester.pump();
      await g.up();
      await tester.pump();
      await tester.pump();
      expect(controller.isRecording, isFalse);

      // Idle again: the bar is back where it started, caption visible.
      expect(tester.getRect(_bar), idleRect,
          reason: 'the round trip must land the bar exactly where it began');
      expect(_caption, findsOneWidget);
      expect(_ghost, findsNothing);
    },
  );

  testWidgets(
    'record-only (轻记录): the same stability holds with the noted caption',
    (WidgetTester tester) async {
      final ChatController controller =
          await _pumpPage(tester, width: 400, height: 800);
      controller.destination.setRecordOnly();
      await tester.pump();

      expect(_caption, findsOneWidget,
          reason: 'harness: noted face carries the 「只保存在手机」 caption');
      final Rect idleRect = tester.getRect(_bar);

      final TestGesture g =
          await tester.startGesture(tester.getCenter(find.byType(PttBar)));
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
      await tester.pump();
      expect(controller.isRecording, isTrue);

      expect(tester.getRect(_bar), idleRect,
          reason: '🔴 record-only press moved the bar — the noted-face ghost '
              'is not holding the slot');

      await g.moveBy(const Offset(0, -120));
      await tester.pump();
      await tester.pump();
      await g.up();
      await tester.pump();
      await tester.pump();
      expect(controller.isRecording, isFalse);
    },
  );
}
