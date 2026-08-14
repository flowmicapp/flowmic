// V2-04 acceptance (widget layer) —
//   ① haptics: PTT down / send / cancel + the inject:result receipt, with
//     success and failure carrying DIFFERENT patterns (the user watches the PC
//     screen; feel is the only channel that reaches them);
//   ② the header tap targets (back / connection dot / settings / destination
//     badge) are ≥40dp while the icons keep their exact visual sizes.
//
// Haptics are observed through a mock on SystemChannels.platform — no plugin,
// no device. The ChatFlowPage half rides the same FakeSocketTransport harness
// as conn_dot_widget_test.

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/ui/destination_badge.dart';
import 'package:flowmic/src/ui/ptt_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

// ── haptic observation ────────────────────────────────────────────────────

List<MethodCall> _mockHaptics(WidgetTester tester) {
  final List<MethodCall> calls = <MethodCall>[];
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    SystemChannels.platform,
    (MethodCall call) async {
      if (call.method == 'HapticFeedback.vibrate') calls.add(call);
      return null;
    },
  );
  addTearDown(
    () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      null,
    ),
  );
  return calls;
}

List<Object?> _patterns(List<MethodCall> calls) =>
    calls.map((MethodCall c) => c.arguments).toList();

// ── PTT bar host ──────────────────────────────────────────────────────────

Widget _pttHost({
  Future<bool> Function()? onDown,
  Future<void> Function()? onUp,
  Future<void> Function()? onCancel,
}) => MaterialApp(
  home: Scaffold(
    body: Center(
      child: SizedBox(
        width: 300,
        child: PttBar(
          visual: PttVisual.idle,
          onDown: onDown ?? () async => true,
          onUp: onUp ?? () async {},
          onCancel: onCancel ?? () async {},
        ),
      ),
    ),
  ),
);

/// Holds the bar past the long-press timeout and lets `_handleDown` settle.
Future<TestGesture> _pressAndHold(WidgetTester tester) async {
  final TestGesture g = await tester.startGesture(
    tester.getCenter(find.byType(PttBar)),
  );
  await tester.pump(const Duration(milliseconds: 600));
  await tester.pump();
  return g;
}

// ── ChatFlowPage harness (same shape as conn_dot_widget_test) ─────────────

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

void _disposeController(ChatController controller) {
  addTearDown(() async {
    await controller.dispose();
    controller.destination.dispose();
    controller.store.dispose();
  });
}

void main() {
  group('① PTT haptics (observation points, FSM untouched)', () {
    testWidgets('an ACCEPTED press buzzes once (medium); a refused press '
        'buzzes nothing', (WidgetTester tester) async {
      final List<MethodCall> calls = _mockHaptics(tester);

      await tester.pumpWidget(_pttHost());
      final TestGesture g = await _pressAndHold(tester);
      expect(_patterns(calls), <String>['HapticFeedbackType.mediumImpact']);
      await g.up();
      await tester.pump();
      await tester.pump();

      calls.clear();
      await tester.pumpWidget(_pttHost(onDown: () async => false));
      final TestGesture g2 = await _pressAndHold(tester);
      expect(
        calls,
        isEmpty,
        reason: 'a refused press is a non-event — buzzing would claim a '
            'recording that does not exist',
      );
      await g2.up();
      await tester.pump();
    });

    testWidgets('release-to-send buzzes light AFTER the down buzz', (
      WidgetTester tester,
    ) async {
      final List<MethodCall> calls = _mockHaptics(tester);
      bool sent = false;
      await tester.pumpWidget(_pttHost(onUp: () async => sent = true));
      final TestGesture g = await _pressAndHold(tester);
      await g.up();
      await tester.pump();
      await tester.pump();
      expect(sent, isTrue);
      expect(_patterns(calls), <String>[
        'HapticFeedbackType.mediumImpact',
        'HapticFeedbackType.lightImpact',
      ]);
    });

    testWidgets('swipe-up cancel buzzes HEAVY, and the later release does NOT '
        'add a send buzz', (WidgetTester tester) async {
      final List<MethodCall> calls = _mockHaptics(tester);
      bool sent = false;
      bool cancelled = false;
      await tester.pumpWidget(
        _pttHost(
          onUp: () async => sent = true,
          onCancel: () async => cancelled = true,
        ),
      );
      final TestGesture g = await _pressAndHold(tester);
      await g.moveBy(const Offset(0, -100));
      await tester.pump();
      expect(cancelled, isFalse, reason: 'zone-enter arms, it does not discard');
      await g.up();
      await tester.pump();
      await tester.pump();
      expect(cancelled, isTrue);
      expect(sent, isFalse, reason: 'a cancelled press never sends');
      expect(_patterns(calls), <String>[
        'HapticFeedbackType.mediumImpact',
        'HapticFeedbackType.heavyImpact',
      ]);
    });
  });

  group('① inject:result receipt haptics (ChatFlowPage observer)', () {
    testWidgets('ok → ONE light pulse; failure → TWO; cached → silent', (
      WidgetTester tester,
    ) async {
      final List<MethodCall> calls = _mockHaptics(tester);
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController controller = _controller(transport);
      _disposeController(controller);

      await tester.pumpWidget(
        MaterialApp(home: ChatFlowPage(controller: controller)),
      );

      // Success — the PC really landed the text.
      transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': true,
        'mode': 'sendinput',
      });
      await tester.pump();
      expect(_patterns(calls), <String>['HapticFeedbackType.lightImpact']);

      // Failure — two pulses, separated: the second lands after the 140 ms gap.
      calls.clear();
      transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': false,
        'mode': 'sendinput',
        'error': 'INJECT_FOCUS_LOST',
      });
      await tester.pump();
      expect(_patterns(calls), <String>['HapticFeedbackType.lightImpact']);
      await tester.pump(const Duration(milliseconds: 200));
      expect(_patterns(calls), <String>[
        'HapticFeedbackType.lightImpact',
        'HapticFeedbackType.lightImpact',
      ]);

      // Cached — the PC queued the text for later: neither landed nor lost,
      // so NO receipt pulse (success would lie, failure would lie).
      calls.clear();
      transport.pushIncoming(FlowMicEvents.injectResult, <String, Object?>{
        'ok': false,
        'mode': 'cached',
        'error': 'INJECT_NO_TEXT_TARGET',
      });
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(calls, isEmpty);
    });
  });

  group('② header tap targets ≥40dp, icons unchanged', () {
    testWidgets('back / connection dot / settings are 40×40; the tappable '
        'destination badge is at least 40×40', (WidgetTester tester) async {
      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController controller = _controller(transport);
      _disposeController(controller);
      transport.pushStatus(SocketStatus.connected);
      controller.session.connectedDeviceName.value = 'DESKTOP-A';

      await tester.pumpWidget(
        MaterialApp(
          home: ChatFlowPage(controller: controller, onBack: () {}),
        ),
      );

      for (final String key in <String>[
        'chat.back',
        'chat.connDot',
        'chat.settings',
      ]) {
        final Size size = tester.getSize(find.byKey(ValueKey<String>(key)));
        expect(size.width, greaterThanOrEqualTo(40), reason: '$key too narrow');
        expect(size.height, greaterThanOrEqualTo(40), reason: '$key too short');
      }

      // The visuals did NOT grow: the dot is still 8px, the icons still 16/18.
      final Finder dotInk = find.byKey(const ValueKey<String>('chat.connDot'));
      final Container dot = tester.widget<Container>(
        find.descendant(of: dotInk, matching: find.byType(Container)),
      );
      expect(dot.constraints?.maxWidth, 8);
      expect(
        tester.widget<Icon>(find.byIcon(Icons.arrow_back_ios_new)).size,
        16,
      );
      expect(
        tester.widget<Icon>(find.byIcon(Icons.settings_outlined)).size,
        18,
      );

      // Connected + togglable ⇒ the badge is the ONLY destination switch.
      final Size badge = tester.getSize(find.byType(DestinationHeaderBadge));
      expect(badge.width, greaterThanOrEqualTo(40));
      expect(badge.height, greaterThanOrEqualTo(40));
    });

    testWidgets('a long PC name ELLIPSES instead of overflowing the header', (
      WidgetTester tester,
    ) async {
      // Widening three tap targets to 40dp spent ~56px of a row that already
      // held a bare, unshrinkable Text plus the cloud/LAN chip. On a narrow
      // phone with a long machine name that is not a cosmetic squeeze —
      // Flutter paints the yellow/black overflow stripes across the header.
      // This case is the reason the name is wrapped in Flexible + ellipsis.
      tester.view.physicalSize = const Size(320 * 3, 640 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final FakeSocketTransport transport = FakeSocketTransport();
      final ChatController controller = _controller(transport);
      _disposeController(controller);
      transport.pushStatus(SocketStatus.connected);
      controller.session.connectedDeviceName.value =
          'DESKTOP-VERY-LONG-WORKSTATION-NAME-THAT-NOBODY-WOULD-SHORTEN';

      await tester.pumpWidget(
        MaterialApp(
          home: ChatFlowPage(controller: controller, onBack: () {}),
        ),
      );

      // A RenderFlex overflow surfaces as an exception, so a clean pump IS the
      // assertion. Checked explicitly so a future refactor cannot quietly
      // reintroduce it.
      expect(tester.takeException(), isNull);
      final Text name = tester.widget<Text>(
        find.byKey(const ValueKey<String>('chat.deviceName')),
      );
      expect(name.overflow, TextOverflow.ellipsis);
      expect(name.maxLines, 1);
    });
  });
}
