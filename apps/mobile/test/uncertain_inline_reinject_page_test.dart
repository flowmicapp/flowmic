// L7: the row write-back for an uncertain submission is synchronous, while
// outbox settlement is intentionally unawaited. This mounts the real chat page
// in that exact interleaving and proves the user's explicit press becomes a new
// delivery instead of replaying the old uncertainty tombstone.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/outbox_item.dart';
import 'package:flowmic/src/session/outbox_store.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';

class _SessionOwner implements InstanceOwnerProbe {
  const _SessionOwner(this.session);

  final PttSession session;

  @override
  String? get instanceId => session.connectedInstanceId;

  @override
  String? get instanceName => session.pcDisplayName;
}

class _Rig {
  _Rig() {
    transport = FakeSocketTransport();
    session = newTestSession(
      transport: transport,
      audio: AudioCapture(recorder: FakeAudioRecorder()),
    );
    giveSessionAPairedIdentity(session);
    store = newTestStore(owner: _SessionOwner(session));
    outboxStore = newTestOutboxStore();
    destination = DestinationController();
    controller = ChatController(
      outboxStore: outboxStore,
      outboxBlobs: newTestOutboxBlobs(),
      session: session,
      store: store,
      destination: destination,
      syncGate: TimelineSyncGate(transport: transport),
      localPrefs: InMemoryLocalPrefs(sendPolicy: SendPolicy.manual),
    );
    transport.pushStatus(SocketStatus.connected);
  }

  late final FakeSocketTransport transport;
  late final PttSession session;
  late final TimelineStore store;
  late final OutboxStore outboxStore;
  late final DestinationController destination;
  late final ChatController controller;

  Future<TimelineEntry> seedUnsettledUncertainty() async {
    final TimelineEntry row = store.buildFromUtterance(
      clientId: 'u-uncertain-old',
      mode: FlowMode.realtime,
      delivery: Delivery.inject,
      text: '可能已经输入',
    );
    final OutboxItem? item = await controller.outbox.enqueueText(
      requestId: 'u-uncertain-old',
      entryId: row.id,
      wireEntryId: row.id,
      source: 'manual',
      text: row.displayText,
      mode: row.mode.name,
      createdAt: row.createdAt,
    );
    expect(item, isNotNull);
    expect(
      store.applyInjectResult(
        correlationId: row.id,
        ok: false,
        pcName: 'Test PC',
        failureReason: 'INJECT_SUBMISSION_UNCERTAIN',
        wireMode: 'clipboard',
      ),
      isTrue,
    );
    expect(controller.outbox.owedEntryIds, contains(row.id));
    return row;
  }

  Future<void> dispose() async {
    await controller.dispose();
    destination.dispose();
    store.dispose();
    await session.dispose();
    await transport.close();
  }
}

void main() {
  testWidgets(
    'real ChatFlowPage uncertain resend mints a new id before outbox settlement',
    (WidgetTester tester) async {
      final _Rig rig = _Rig();
      final TimelineEntry row = (await tester.runAsync(
        rig.seedUnsettledUncertainty,
      ))!;
      await tester.pump();

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: rig.controller)),
      );
      await tester.pump();
      await tester.pump();

      final Finder resend = find.byKey(
        ValueKey<String>('entry.resend.${row.id}'),
      );
      expect(resend, findsOneWidget);
      await tester.tap(resend);
      await tester.pump();
      await tester.pump();

      final List<EventEnvelope> frames = rig.transport.emittedWhere(
        FlowMicEvents.injectRequest,
      );
      expect(frames, hasLength(1));
      final Map<dynamic, dynamic> frame = frames.single.data as Map;
      final String freshRequestId = frame['request_id'] as String;
      expect(freshRequestId, isNot('u-uncertain-old'));
      expect(frame['entry_id'], row.id);
      expect(rig.store.findById(row.id)!.status, EntryStatus.cached);

      rig.transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': true,
        'mode': 'sendinput',
        'request_id': freshRequestId,
        'entry_id': row.id,
      });
      await tester.pump();
      await tester.pump();
      expect(rig.store.findById(row.id)!.status, EntryStatus.injected);

      rig.session.debugStopIdlePresencePoll();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(rig.dispose);
    },
  );
}
