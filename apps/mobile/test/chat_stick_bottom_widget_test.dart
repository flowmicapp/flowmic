// T-6b-2 — reversed chat list stick-to-bottom + back-to-bottom affordance.
// Widget layer only: FSM driven synchronously; no real PttSession await chain.

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
import 'package:flowmic/src/ui/chat_message_tile.dart';
import 'package:flutter/material.dart' hide ConnectionState;
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// V2-06b: the chat page now narrows to the CONNECTED instance's rows, so this
/// harness pairs for real (fake ack) and stamps seeded rows through the same
/// session-reading probe production uses (main.dart _SessionInstanceOwner).
/// Rows born under `_NoOwner` would prove nothing here — the narrowed view
/// correctly hides them (13 册 §7 F1: wire the real owner or test nothing).
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
    'token': 'tok-stick-000000000000000000000000',
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

void _seedEntries(TimelineStore store, int count) {
  for (int i = 0; i < count; i++) {
    store.buildFromUtterance(
      clientId: 'seed-$i',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: '历史消息 #$i — ${'字' * 24}',
    );
  }
}

void main() {
  testWidgets(
    'T-6b-2: reverse list paints live draft at the visual bottom',
    (WidgetTester tester) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController controller = await _controller(transport);
      final TimelineStore store = controller.store;
      addTearDown(() async {
        await controller.dispose();
        controller.destination.dispose();
        store.dispose();
        await controller.session.dispose();
      });

      _seedEntries(store, 3);
      transport.pushStatus(SocketStatus.connected);

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );

      final ListView list = tester.widget<ListView>(
        find.byKey(const ValueKey<String>('chat.timeline')),
      );
      expect(list.reverse, isTrue);

      // Sync FSM → RECORDING so hasLiveDraft is true (no real audio await).
      controller.session.fsm.onPttDown();
      await tester.pump();

      expect(find.byType(LiveDraftTile), findsOneWidget);
      expect(find.byType(ChatMessageTile), findsWidgets);

      final double liveBottom = tester.getBottomLeft(find.byType(LiveDraftTile)).dy;
      final double newestCommittedBottom =
          tester.getBottomLeft(find.byType(ChatMessageTile).first).dy;
      // Live draft sits lower on screen than committed rows (chat bottom).
      expect(liveBottom, greaterThan(newestCommittedBottom));
      // G-15①: `_controller()` runs a real `pair()`, which arms the idle
      // presence-poll Timer (ptt_presence_poll.dart) — `addTearDown` above
      // disposes the session too late (AutomatedTestWidgetsFlutterBinding
      // checks for pending timers the instant the tree is torn down, before
      // teardown callbacks run). Same escape hatch send_retry_banner_test.dart
      // uses.
      controller.session.debugStopIdlePresencePoll();
    },
  );

  testWidgets(
    'T-6b-2: scroll past threshold shows back-to-bottom; tap returns offset 0',
    (WidgetTester tester) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController controller = await _controller(transport);
      final TimelineStore store = controller.store;
      addTearDown(() async {
        await controller.dispose();
        controller.destination.dispose();
        store.dispose();
        await controller.session.dispose();
      });

      _seedEntries(store, 30);
      transport.pushStatus(SocketStatus.connected);

      await tester.binding.setSurfaceSize(const Size(390, 720));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );
      await tester.pump();

      final Finder backBtn = find.byKey(const ValueKey<String>('chat.backToBottom'));
      expect(backBtn, findsNothing);

      final ScrollableState scrollable = tester.state<ScrollableState>(
        find.descendant(
          of: find.byKey(const ValueKey<String>('chat.timeline')),
          matching: find.byType(Scrollable),
        ),
      );
      expect(scrollable.position.pixels, 0);

      // Threshold on the page is 240 logical px.
      scrollable.position.jumpTo(300);
      await tester.pump();
      expect(backBtn, findsOneWidget);

      await tester.tap(backBtn);
      await tester.pumpAndSettle();
      expect(scrollable.position.pixels, 0);
      expect(backBtn, findsNothing);
      controller.session.debugStopIdlePresencePoll(); // G-15①, see note above
    },
  );
}
