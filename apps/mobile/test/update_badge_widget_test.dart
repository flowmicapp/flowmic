// UP-2 —— the badge on the top-bar gear (design §5.1「提醒面」: does not pop
// in the face, does not steal focus).
//
// This test has to pin three things:
//   ① it appears when there is a new version, and when there is not it is
//      **not on the tree** (not 「transparently sitting there」);
//   ② 🔴 it occupies **not a single pixel**. The top bar's first-row width
//      has already been counted to the boundary, and 「stuff one more thing
//      into this row」 is the shape that has bitten this top bar **three
//      times** (the CLAUDE.md 0.2.51
//      line: the first two fixes both reallocated width inside the same row,
//      so the third time it came back).
//      ⇒ the criterion must be **the difference between two measurements**,
//      not a sentence that says 「it used a Stack so it is fine」.
//   ③ a single true source: it follows `UpdateController.hasUpdate`, and
//      does not judge a second time on the badge side.
//
// ⚠️ This walks the **production path** (ChatFlowPage → ChatHeader), not a
// ChatHeader constructed directly: how hard a measurement is depends on
// whether the mechanism that produced it is the path the product actually
// walks.

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flowmic/src/update/update_check.dart';
import 'package:flowmic/src/update/update_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/update_fakes.dart';

const ValueKey<String> _dot = ValueKey<String>('chat.settings.updateDot');
const String _pcName = 'dev-pc-a';
const String _longFocus =
    'M3窗口主控启动与关键任务收口 - CLAUDE.md - flowmic-app - Cursor';

ChatController _controller(FakeSocketTransport transport) {
  final PttSession session = newTestSession(
    transport: transport,
    audio: AudioCapture(recorder: FakeAudioRecorder()),
  );
  return ChatController(
    outboxStore: newTestOutboxStore(),
    outboxBlobs: newTestOutboxBlobs(),
    session: session,
    store: newTestStore(),
    destination: DestinationController(),
    syncGate: TimelineSyncGate(transport: transport),
    localPrefs: InMemoryLocalPrefs(),
  );
}

void main() {
  /// Paints the top bar once; returns the laid-out width of the machine-name cell.
  Future<double> pumpHeader(WidgetTester tester, {required bool hasUpdate}) async {
    // Phone width, not the default 800x600: this width defect only holds on a narrow screen.
    tester.view.physicalSize = const Size(411 * 3, 890 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    controller.session.connectedDeviceName.value = _pcName;
    // Positive control: the badge only paints a real label when **connected**, and only then is the first row actually under pressure.
    transport.pushStatus(SocketStatus.connected);
    controller.destination.onFocusApp(_longFocus);

    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller, hasUpdate: hasUpdate)),
    );
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'the top bar overflowed');
    return tester.getSize(find.byKey(const ValueKey<String>('chat.deviceName'))).width;
  }

  testWidgets('① a new version ⇒ the dot appears on the gear', (WidgetTester tester) async {
    await pumpHeader(tester, hasUpdate: true);
    expect(find.byKey(_dot), findsOneWidget);
  });

  testWidgets('① reverse control: no new version ⇒ it is not on the tree at all', (WidgetTester tester) async {
    await pumpHeader(tester, hasUpdate: false);
    expect(find.byKey(_dot), findsNothing);
  });

  testWidgets('🔴 ② measurement: the badge occupies not a single pixel —— the machine-name width is identical with or without it', (
    WidgetTester tester,
  ) async {
    final double without = await pumpHeader(tester, hasUpdate: false);
    final double with_ = await pumpHeader(tester, hasUpdate: true);
    expect(without, greaterThan(0), reason: 'gauge self-check: the name must actually have been painted');
    expect(
      with_,
      without,
      reason: 'the badge ate the machine-name width —— that is exactly the shape this top bar has fallen into three times',
    );
  });

  testWidgets('🔴 ③ a single true source: controller.hasUpdate decides, not 「we already checked」', (
    WidgetTester tester,
  ) async {
    // If someone later judges a second time on the badge side (e.g.
    // `result != null`), this case goes red on the spot:
    // an 「unreachable」 is also a non-null result, but it is never 「there is a
    // new version」.
    final UpdateController c = newTestUpdateController(
      checker: (({required String? currentVersion}) async =>
          const UpdateCheckResult(UpdateCheckOutcome.unreachable)),
    );
    addTearDown(c.dispose);
    await c.load();
    await c.checkNow();
    expect(c.result, isNotNull, reason: 'a check really did run once');
    expect(c.hasUpdate, isFalse, reason: '「already checked」 is not 「there is a new version」');

    await pumpHeader(tester, hasUpdate: c.hasUpdate);
    expect(find.byKey(_dot), findsNothing);
  });
}
