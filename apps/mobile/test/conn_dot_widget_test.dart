// T-5b-mobile widget layer — sync FSM drives only; no real PttSession await.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart' hide ConnectionState;
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

/// The 8×8 connection dot inside the tappable header control.
Container? _connDotContainer(WidgetTester tester) {
  final Finder ink = find.byKey(const ValueKey<String>('chat.connDot'));
  expect(ink, findsOneWidget);
  return tester
      .widgetList<Container>(find.descendant(of: ink, matching: find.byType(Container)))
      .cast<Container?>()
      .firstWhere(
        (Container? c) => c?.constraints?.maxWidth == 8,
        orElse: () => null,
      );
}

void main() {
  testWidgets('idle disconnected paints slate, not red', (WidgetTester tester) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
    final Container? dot = _connDotContainer(tester);
    expect(dot, isNotNull);
    final BoxDecoration? deco = dot!.decoration as BoxDecoration?;
    expect(deco?.color, FlowMicColors.slate);
  });

  testWidgets('connected paints green; tap opens diagnostics with state', (
    WidgetTester tester,
  ) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    transport.pushStatus(SocketStatus.connected);
    controller.session.reconnect.configure(url: 'ws://192.0.2.5:41879');
    controller.session.connectedDeviceName.value = 'DESKTOP-A';
    // v0.2.1: the channel label comes from the SERVER's own /api/health.mode,
    // not from the destination kind. Set it the way a real connection would.
    controller.session.serverChannel.value = ServerChannel.lan;

    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
    final Container? dot = _connDotContainer(tester);
    expect((dot!.decoration as BoxDecoration?)?.color, FlowMicColors.green);

    await tester.tap(find.byKey(const ValueKey<String>('chat.connDot')));
    await tester.pumpAndSettle();
    expect(find.text('连接诊断'), findsOneWidget);
    expect(find.text('已连接'), findsWidgets);
    expect(find.text('ws://192.0.2.5:41879'), findsOneWidget);
    // Header title + diagnostics device row both show the paired name.
    expect(find.text('DESKTOP-A'), findsNWidgets(2));
    expect(find.text('本地局域网'), findsWidgets);
  });

  testWidgets('v0.2.1: an UNKNOWN channel shows no chip and no diagnostics row '
      'rather than guessing one', (WidgetTester tester) async {
    // owner 2026-07-28: a PC reached through the relay was labelled 本地局域网,
    // because the chip read `destination.isFixed` — "is the peer a virtual cloud instance",
    // which a real PC answers `false` to on EITHER transport. The replacement
    // asks the server (`/api/health.mode`), and when it has not answered yet the
    // honest output is nothing at all. A default would just be the old bug with
    // a new source.
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    transport.pushStatus(SocketStatus.connected);
    controller.session.reconnect.configure(url: 'ws://192.0.2.5:41879');
    controller.session.connectedDeviceName.value = 'DESKTOP-A';
    // serverChannel deliberately left null.

    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
    expect(find.text('本地局域网'), findsNothing);
    expect(find.text('云端中继'), findsNothing);

    await tester.tap(find.byKey(const ValueKey<String>('chat.connDot')));
    await tester.pumpAndSettle();
    expect(find.text('连接诊断'), findsOneWidget, reason: 'the sheet still opens');
    expect(find.text('本地局域网'), findsNothing);
    expect(find.text('云端中继'), findsNothing);
  });

  testWidgets('v0.2.1: a cloud-relay connection says 云端中继 on BOTH the chip '
      'and the diagnostics sheet', (WidgetTester tester) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    transport.pushStatus(SocketStatus.connected);
    controller.session.reconnect.configure(url: 'ws://192.0.2.5:41879');
    controller.session.connectedDeviceName.value = 'DESKTOP-A';
    controller.session.serverChannel.value = ServerChannel.cloudRelay;

    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
    // The destination is NOT fixed here — a real PC reached through the relay —
    // which is exactly the case the old code got wrong.
    expect(controller.destination.isFixed, isFalse);
    expect(find.text('云端中继'), findsWidgets);
    expect(find.text('本地局域网'), findsNothing);
  });

  testWidgets('error paints red; lastConnectError row appears when present', (
    WidgetTester tester,
  ) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    transport.pushStatus(SocketStatus.error);
    transport.setLastConnectError('AUTH_TOKEN_INVALID');

    await tester.pumpWidget(MaterialApp(home: ChatFlowPage(controller: controller)));
    final Container? dot = _connDotContainer(tester);
    expect((dot!.decoration as BoxDecoration?)?.color, FlowMicColors.red);

    await tester.tap(find.byKey(const ValueKey<String>('chat.connDot')));
    await tester.pumpAndSettle();
    expect(find.text('连接异常'), findsWidgets);

    expect(find.text('AUTH_TOKEN_INVALID'), findsOneWidget);

    // owner ②: the sustained-disconnect watch armed on the error status above.
    // Let it complete inside the FakeAsync zone (it fires, the page schedules
    // its exit) so no pending timer leaks past the test body. Placed AFTER the
    // sheet assertions — firing the exit first would tear down what they read.
    await tester.pump(const Duration(seconds: 11));
    await tester.pumpAndSettle();
  });

  testWidgets('unsent buffer → back confirms; cancel keeps the page', (
    WidgetTester tester,
  ) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    transport.pushStatus(SocketStatus.connected);
    controller.setBuffer('还没发出去');

    int backs = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (BuildContext ctx) => TextButton(
            onPressed: () {
              Navigator.of(ctx).push<void>(
                MaterialPageRoute<void>(
                  builder: (_) => ChatFlowPage(
                    controller: controller,
                    onBack: () => backs++,
                  ),
                ),
              );
            },
            child: const Text('go'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.arrow_back_ios_new));
    await tester.pumpAndSettle();
    expect(find.text('放弃未发送的内容？'), findsOneWidget);

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(backs, 0);
    expect(find.byType(ChatFlowPage), findsOneWidget);
    expect(controller.buffer, '还没发出去');
  });
}
