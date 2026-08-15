// card SEG-2 (owner, 2026-08-15) — 「然后这个说话的按钮也没了」.
//
// Owner, dictating a long sentence under MANUAL send policy: partway through,
// 「它马上切换到了那个中间反冲的带编辑的界面，然后这个说话的按钮也没了。但是我手
// 不松的还是可以继续录的。但是松掉了之后它就没了。」
//
// Mechanism. The sheet's auto-open trigger (chat_flow_edit_sheet.dart,
// `_syncSheetOnControllerRouted`) is documented as 「manual voice FINALIZE ⇒
// auto-open」 and its condition asks only 「is the policy manual, is the buffer
// non-empty, did it change」. Nothing in it asks whether the user is still
// holding the button. That was correct while a manual utterance grew the buffer
// exactly once — at release. It stopped being correct when the server started
// settling SOFT SEGMENTS: a long dictation folds text into the buffer every
// segment, i.e. MID-HOLD. And by design the sheet COVERS the PTT bar
// (edit_sheet_test.dart pins that: 「the speak key exits while editing」), so the
// surface the release belonged to left the screen with the finger still down.
//
// ⇒ anti-façade ④: the comment named the intent ("finalize"), the code encoded a
// proxy for it ("the buffer grew"), and a change elsewhere made the proxy stop
// meaning the intent.
//
// ── Reverse control (2026-08-15, dev-pc-a — run, observed, reverted) ──
// ① Drop `!utteranceInFlight` from the trigger ⇒ 「+1 -2」. Case ① fails on
//    「Expected: no matching candidates / Actual: Found 1 widget with key
//    'compose.card'」 — the reported defect, reproduced — and case ② falls with
//    it, because with the guard gone its mid-hold step opens the sheet early
//    and there is nothing left to defer.
// ② Keep the guard but let `_lastBufferSeen` advance unconditionally (i.e. make
//    the suppression a DROP instead of a DEFERRAL) ⇒ 「+2 -1」, case ② alone:
//    「Expected: exactly one matching candidate / Actual: Found 0 widgets」.
//    That second control is the one worth having: without it the "fix" would
//    silently delete the manual flow's whole point while case ① stayed green.

import 'dart:async';

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/signaling/state_machine.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

final Finder _sheet = find.byKey(const ValueKey<String>('compose.card'));

Future<ChatController> _pumpPage(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360 * 3, 780 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport();
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
    stateMachine: FlowmicStateMachine(justDoneDuration: Duration.zero),
  );
  giveSessionAPairedIdentity(session);
  final ChatController controller = ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
  );
  // Synchronous teardown: a live capture makes the dispose awaits
  // unresolvable (same caveat as edit_sheet_append_test.dart's header).
  addTearDown(() {
    unawaited(controller.dispose());
    controller.destination.dispose();
    controller.store.dispose();
  });
  await controller.loadSendPolicy();
  transport.pushStatus(SocketStatus.connected);
  await tester.pumpWidget(
    MaterialApp(home: ChatFlowPage(controller: controller)),
  );
  await tester.pump();
  return controller;
}

/// The production accepted-edge of the dock's speak key, driven directly —
/// same technique as edit_sheet_append_test.dart's `_pressAppend`, and for the
/// same reason: the 300 ms accept timer plus the capture chain deadlocks
/// FakeAsync if driven as a real gesture.
Future<void> _holdSpeakKey(WidgetTester tester) async {
  final PttBar bar = tester.widget<PttBar>(find.byType(PttBar));
  unawaited(bar.onDown!());
  await tester.pump();
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('🔴 SEG-2 ①: a segment folding into the buffer MID-HOLD does not '
      'take the speak key away', (WidgetTester tester) async {
    final ChatController c = await _pumpPage(tester);
    expect(_sheet, findsNothing);

    await _holdSpeakKey(tester);
    expect(
      c.isRecording,
      isTrue,
      reason: 'positive control: the rest of this case means nothing if the FSM never started',
    );
    final Rect pttWhileHolding = tester.getRect(find.byType(PttBar));

    // What the server's soft segmentation does at second ~30 of a long
    // dictation: a settled segment folds into the manual buffer. The finger is
    // still down.
    c.setBuffer('第一段已经落进缓冲，而我还在说');
    await tester.pump();

    expect(
      _sheet,
      findsNothing,
      reason: '🔴 the edit sheet opened mid-hold — it COVERS the PTT bar, so the '
          'button the user is holding left the screen (owner: 说话的按钮也没了)',
    );
    expect(
      tester.getRect(find.byType(PttBar)),
      pttWhileHolding,
      reason: 'and the key did not move under the finger either',
    );

    await c.pttCancel();
  });

  testWidgets('🔴 SEG-2 ②: the open is DEFERRED, not dropped — it arrives when '
      'the hold ends', (WidgetTester tester) async {
    final ChatController c = await _pumpPage(tester);

    await _holdSpeakKey(tester);
    c.setBuffer('第一段已经落进缓冲，而我还在说');
    await tester.pump();
    expect(_sheet, findsNothing);

    // The finger lifts. (Cancel rather than release: it returns the FSM to a
    // resting state without needing a terminal stt:final on the wire, and the
    // buffer is not the utterance — discarding the RECORDING does not discard
    // text that already settled into the draft.)
    await c.pttCancel();
    await tester.pump();
    await tester.pump();

    expect(
      _sheet,
      findsOneWidget,
      reason: '🔴 the suppression became a DROP: the manual draft never got its '
          'edit surface at all, which is worse than the defect being fixed',
    );
  });

  testWidgets('SEG-2 ③: with no hold in flight the trigger is untouched',
      (WidgetTester tester) async {
    // The unchanged path, asserted so the guard cannot be widened into
    // "never auto-open" by a later edit and still look correct.
    final ChatController c = await _pumpPage(tester);
    expect(_sheet, findsNothing);
    c.setBuffer('直接落进缓冲的一句话');
    await tester.pump();
    expect(_sheet, findsOneWidget);
  });
}
