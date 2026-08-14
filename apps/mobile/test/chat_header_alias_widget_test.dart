// T-6d — chat header prefers the local display alias override; without an
// alias/override it falls back to the session ack device name. Sync widget
// layer only (no real async inside testWidgets).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

ChatController _controller(FakeSocketTransport transport) {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  final TimelineStore store = newTestStore();
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

String _headerName(WidgetTester tester) {
  final Text text = tester.widget<Text>(
    find.byKey(const ValueKey<String>('chat.deviceName')),
  );
  return text.data!;
}

void main() {
  testWidgets('header shows the local alias when deviceNameOverride is set', (
    WidgetTester tester,
  ) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    // Ack truth stays the protocol name — override must win without mutating it.
    controller.session.connectedDeviceName.value = 'Studio PC';

    await tester.pumpWidget(
      MaterialApp(
        home: ChatFlowPage(
          controller: controller,
          deviceNameOverride: '办公桌',
        ),
      ),
    );

    expect(_headerName(tester), '办公桌');
    expect(controller.session.connectedDeviceName.value, 'Studio PC');
  });

  testWidgets('header falls back to connectedDeviceName when override is null', (
    WidgetTester tester,
  ) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    controller.session.connectedDeviceName.value = 'Studio PC';

    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller)),
    );

    expect(_headerName(tester), 'Studio PC');
  });
}
