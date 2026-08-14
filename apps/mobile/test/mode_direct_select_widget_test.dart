// FB-3 option A acceptance — the mode row is **direct select**, not a cycle
// and no longer asks a question (owner 2026-08-06 ruling D1). Widget layer
// only: the FSM is driven synchronously; no real PttSession await chain.
//
// 🔴 This file was previously named mode_switch_confirm_widget_test.dart and
// verified M4's 「输入框里有未发送内容，切换模式会将其清空」 confirm dialog.
// D1 cancelled that dialog (three-way direct select needs no confirm), so of
// those three cases:
//   · 「dialog asks / cancel keeps / confirm clears」 — retired; the replacement
//     criterion is in compose_three_row_layout_test.dart's 「one tap lands it…
//     no confirm dialog」 (asserts: one tap reaches the mode + no dialog +
//     the buffer is still cleared), plus that file's 「the substitute is the
//     pre-emptive hint strip」 (asserts didExceedMaxLines);
//   · 「empty-buffer one-tap switch」 — kept below, semantics changed from
//     cycle to direct;
//   · 「a tap while recording is a no-op」 — **kept verbatim**; it is
//     unrelated to this round's change, and it guards a red line that still
//     holds (08 §2: setMode bails immediately while recording).
// Renamed rather than keeping the old name: a filename that says it tests a
// confirm dialog, when the confirm dialog no longer exists, is exactly this
// repo's most expensive kind of 「expired truth」.
//
// Harness shape mirrors chat_stick_bottom_widget_test.dart (fake socket, real
// pair ack, session-owned instance rows).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this._session);
  final PttSession _session;
  @override
  String? get instanceId => _session.connectedInstanceId;
  @override
  String? get instanceName => _session.pcDisplayName;
}

Future<ChatController> _controller(FakeSocketTransport transport) async {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  transport.connectSucceeds = true;
  transport.ackQueue.add(<String, Object?>{
    'token': 'tok-modec-00000000000000000000000',
    'pc_name': 'Widget PC',
    'pc_instance_id': 'inst-widget',
  });
  final PairResult pair = await session.pair(
    PairEntry.parse('1234'),
    endpoint: 'ws://192.0.2.5:41879',
  );
  expect(pair.ok, isTrue, reason: 'harness pair failed: ${pair.error}');
  final TimelineStore store = newTestStore(owner: _SessionOwner(session));
  final DestinationController destination = DestinationController();
  final InMemoryLocalPrefs prefs = InMemoryLocalPrefs();
  return ChatController(
      outboxStore: newTestOutboxStore(),
      outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: store,
    destination: destination,
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: prefs,
  );
}

void main() {
  final Finder segRealtime =
      find.byKey(const ValueKey<String>('compose.mode.realtime'));
  final Finder segTranslate =
      find.byKey(const ValueKey<String>('compose.mode.translate'));
  final Finder deadDialogBody =
      find.text('输入框里有未发送内容，切换模式会将其清空');

  Future<ChatController> pumpPage(WidgetTester tester) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = await _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
      await controller.session.dispose();
    });
    transport.pushStatus(SocketStatus.connected);
    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
    await tester.pump();
    return controller;
  }

  testWidgets('D1: tapping ② Translate on an empty buffer = one tap lands it, no confirm dialog', (
    WidgetTester tester,
  ) async {
    final ChatController controller = await pumpPage(tester);
    expect(controller.mode, FlowMode.realtime);
    await tester.tap(segTranslate);
    await tester.pumpAndSettle();
    expect(deadDialogBody, findsNothing);
    expect(controller.mode, FlowMode.translate);
    // G-15①: `_controller()` runs a real `pair()`, which arms the idle
    // presence-poll Timer (ptt_presence_poll.dart) — `addTearDown` above
    // disposes the session too late (AutomatedTestWidgetsFlutterBinding checks
    // for pending timers the instant the tree is torn down, before teardown
    // callbacks run). Same escape hatch send_retry_banner_test.dart uses.
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('tapping the already-selected segment is a no-op (it is not a switch, and it does not clear the buffer)', (
    WidgetTester tester,
  ) async {
    // 🔴 A new possibility under direct select: the user taps the mode they
    // are already in. That action did not exist in the cycle-switch era
    // (every tap changed the mode). It must never clear the buffer — that
    // would be a silent destruction of 「tapped something that looks like it
    // does nothing, and the thing is gone」.
    final ChatController controller = await pumpPage(tester);
    controller.setBuffer('还没发出去的话');
    await tester.pump();
    await tester.tap(segRealtime);
    await tester.pumpAndSettle();
    expect(controller.mode, FlowMode.realtime);
    expect(controller.buffer, '还没发出去的话');
    controller.session.debugStopIdlePresencePoll();
  });

  testWidgets('while recording the mode segments are **not in the tree** (SUP-4\'s structural no-op), and setMode '
      'is still ignored by the FSM (08 §2)', (WidgetTester tester) async {
    // 🔴 PA-1 (Plan A′ SUP-4) CHANGED THIS CASE'S MECHANISM, deliberately: the
    // idle rows — mode segments included — leave the tree while recording
    // (「one primary action at a time」), so 「a mis-tap of a segment while
    // recording」 is now IMPOSSIBLE rather than ignored. The tap-based half
    // becomes an absence assertion; the 08 §2 guarantee itself (a
    // mid-recording switch moves nothing) is still real and still pinned, at
    // the layer that still has an entry point: setMode.
    final ChatController controller = await pumpPage(tester);
    controller.setBuffer('录音中误点的内容');
    controller.session.fsm.onPttDown();
    await tester.pump();
    expect(controller.isRecording, isTrue);

    expect(
      segTranslate,
      findsNothing,
      reason: '🔴 mode segments still present while recording ⇒ SUP-4\'s 「the dock is only speaking」 is broken',
    );
    expect(segRealtime, findsNothing);

    // The FSM half: even a programmatic switch is ignored mid-recording.
    controller.setMode(FlowMode.translate);
    await tester.pump();
    await tester.pump();
    expect(deadDialogBody, findsNothing);
    expect(controller.mode, FlowMode.realtime);
    expect(controller.buffer, '录音中误点的内容');
    controller.session.debugStopIdlePresencePoll();
  });
}
