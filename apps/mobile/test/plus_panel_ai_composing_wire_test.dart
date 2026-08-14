// W2.5-E WIRE TEST — the 「+」 panel's "save current buffer" really does receive the AI-running state on the live path.
//
// ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
// plus_panel_widget_test.dart drives `PlusPanel(aiComposing: true)` directly.
// That proves the WIDGET honours the criterion and proves nothing about whether
// production ever passes it a true. Delete the one line that does —
// `aiComposing: s.controller.isAiComposing` in chat_flow_composer.dart
// `_openPlusPanelRouted` — and every assertion over there stays green while the
// hole is fully reopened: the parameter defaults to `false`.
//
// This is the exact shape 0.2.51 recorded for `PcBusyTracker` (「只测 tracker 的
// 话，把 `recheck:` 删掉，四条全还是绿的」). So: real ChatController, real
// ChatFlowPage, real `startAiCompose`, real bottom sheet, tapped through the
// real 「+」 button.
//
// ── WHAT IS DELIBERATELY NOT ASSERTED HERE ───────────────────────────────────
// 🔴 That a favourite, once saved, is delivered WITHOUT compose validation is
// correct by design and is NOT a hole: a favourite is a phrase the user wrote,
// not model output. `ManualDelivery.deliverText` therefore carries no compose
// term and must not grow one. The bug was only ever that partial model output
// could BECOME a favourite. Nothing below touches the send path.
//
// Harness shape mirrors mode_switch_confirm_widget_test.dart (fake socket, real
// pair ack, session-owned instance rows); the compose plumbing mirrors
// ai_compose_test.dart's `_Harness`.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/app_strings.dart';
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

const AppStrings _zh = AppStringsZh();

const ValueKey<String> _plus = ValueKey<String>('compose.plus');
const ValueKey<String> _save = ValueKey<String>('plus.fav.save');
const ValueKey<String> _blocked = ValueKey<String>('plus.fav.save.blocked');

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
    'token': 'tok-w25e-000000000000000000000000',
    'pc_name': 'Widget PC',
    'pc_instance_id': 'inst-widget',
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
    store: newTestStore(owner: _SessionOwner(session)),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
}

void main() {
  late FakeSocketTransport transport;

  Future<ChatController> pumpPage(WidgetTester tester) async {
    transport = FakeSocketTransport();
    final ChatController controller = await _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
      await controller.session.dispose();
    });
    transport.pushStatus(SocketStatus.connected);
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller)),
    );
    await tester.pump();
    // G-15①: `_controller()` runs a real `pair()`, which arms the idle
    // presence-poll Timer (ptt_presence_poll.dart) — `addTearDown` above
    // disposes the session too late (AutomatedTestWidgetsFlutterBinding checks
    // for pending timers the instant the tree is torn down, before teardown
    // callbacks run). Same escape hatch mode_switch_confirm_widget_test.dart
    // and send_retry_banner_test.dart use.
    controller.session.debugStopIdlePresencePoll();
    return controller;
  }

  /// Open the 「+」 sheet.
  ///
  /// 🔴 NEVER `pumpAndSettle()` here. While a compose run is live the AI action row
  /// spins a real `CircularProgressIndicator` (`ai_action_row.dart`), so the
  /// tree never settles: `pumpAndSettle` then elapses fake time until the 45 s
  /// `AiComposeController.kWatchdog` fires and ABORTS the very run this test is
  /// about — the test would be measuring the watchdog, not the panel. Same trap
  /// plus_panel_widget_test.dart already records for the image tile.
  Future<void> openSheet(WidgetTester tester) async {
    await tester.tap(find.byKey(_plus));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// The request_id of the live run, read off the wire exactly as the server
  /// would echo it — a hand-made id would be dropped by `AiComposeController`.
  String liveRequestId() {
    final Map<String, Object?> start = Map<String, Object?>.from(
      transport.emittedWhere(FlowMicEvents.composeStart).last.data!
          as Map<Object?, Object?>,
    );
    return start['request_id']! as String;
  }

  testWidgets('W2.5-E wire: save-current-buffer is withheld mid-compose because the panel '
      'is handed ChatController.isAiComposing — the same term ➤ reads',
      (WidgetTester tester) async {
    final ChatController c = await pumpPage(tester);
    c.setBuffer('用户自己说的那句话');
    await tester.pump();

    // Start a REAL run through the controller, then stream a partial delta into
    // the buffer the way the server does. After this the buffer holds model
    // output that no guard has looked at.
    expect(c.startAiCompose(ComposeTask.organize), isNull,
        reason: 'harness could not start a compose run');
    await tester.pump();
    transport.pushIncoming(FlowMicEvents.composeChunk, <String, Object?>{
      'delta': '模型才写了一半的',
      'request_id': liveRequestId(),
    });
    await tester.pump();
    expect(c.isAiComposing, isTrue);
    expect(c.buffer, '模型才写了一半的',
        reason: 'the partial IS in the buffer — that is what makes this a hole');

    await openSheet(tester);

    await tester.tap(find.byKey(_save));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(c.favorites.isEmpty, isTrue,
        reason: 'a half-streamed compose result must not become a permanent '
            'favourite — once stored, sendFavorite → deliverText never '
            're-checks it');
    expect(find.byKey(_blocked), findsOneWidget,
        reason: 'withholding silently is the other half of the same bug');
    expect(find.text(_zh.favoritesSaveBlockedAiComposing), findsOneWidget);

    // End the run so the 45 s watchdog timer does not outlive the test
    // (`AiComposeController._end` cancels it).
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': '模型写完的整句',
      'request_id': liveRequestId(),
    });
    await tester.pump();
    expect(c.isAiComposing, isFalse, reason: 'watchdog must not be left armed');
  });

  testWidgets('W2.5-E wire positive control: the SAME panel saves normally once the run '
      'has finished — the wire carries the live value, not a constant',
      (WidgetTester tester) async {
    final ChatController c = await pumpPage(tester);
    c.setBuffer('用户自己说的那句话');
    await tester.pump();
    expect(c.startAiCompose(ComposeTask.organize), isNull);
    await tester.pump();
    transport.pushIncoming(FlowMicEvents.composeDone, <String, Object?>{
      'output_text': '模型写完的整句',
      'request_id': liveRequestId(),
    });
    await tester.pump();
    expect(c.isAiComposing, isFalse);

    await openSheet(tester);
    expect(find.byKey(_blocked), findsNothing);

    await tester.tap(find.byKey(_save));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(c.favorites.items, <String>['模型写完的整句'],
        reason: 'a COMPLETED run went through the output guard; blocking here '
            'would be the false-rejection that gets a criterion loosened away');
  });
}
