// 🔴 owner 2026-08-03 real-device —— 「顶部的 PC 实例名称是看不清楚的，这会带来我不清楚
// 当前在跟哪台 PC 发消息，会需要退出，才能了解」。
//
// **This is the second time at the same place.** The first was v0.2.1 (owner
// 2026-07-28: 「只显示了前3个字母」), and the culprit then was `Spacer` splitting
// leftover width evenly with the name; the fix was to lift the name to `flex: 6`.
// This time the culprit changed: the **destination badge** (`→ {PC focus window}`)
// previously **did not participate in flex**, so it took its full intrinsic width
// first and the name only got what was left. And when the process name is empty
// its content falls back to the **window title** (`FocusState.appLabel`), which
// can be a whole sentence ⇒ the name is squeezed to a few letters.
//
// 🔴 The shape both times is the same, worth a separate note: **identity is
// crowded out by a transient value**.
// "Which computer I am talking to" barely changes in a session; "which window
// is in front over there" changes every few seconds — and the layout gave
// absolute priority to the latter. **Law: when a row holds both identity and a
// transient value, the compressible one must be the transient**; relying on
// "anyway titles are usually short" bets correctness on whatever window is open
// on the other side.
//
// ⚠️ The positive control is in the same test: while asserting the name is not
// truncated, also assert **the badge WAS truncated**. Without the latter, "the
// name was not truncated" may only mean that long title never applied pressure
// — then this test is blind to regressions (15 / CLAUDE.md: a negative
// assertion must carry its own positive control).

import 'package:flowmic/src/audio/audio_capture.dart';
import 'package:flowmic/src/destination/destination_controller.dart';
import 'package:flowmic/src/ptt/ptt_session.dart';
import 'package:flowmic/src/session/chat_controller.dart';
import 'package:flowmic/src/session/instance_probe.dart' show ServerChannel;
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/settings/local_prefs.dart';
import 'package:flowmic/src/signaling/socket_core.dart' show SocketStatus;
import 'package:flowmic/src/timeline/timeline_sync.dart';
import 'package:flowmic/src/ui/chat_flow_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';
import 'support/di.dart';

/// One of owner's machine names, used verbatim — "a name of about the same
/// length" does not prove this one fits.
const String _pcName = 'dev-pc-a';

/// The real shape of a PC focus-window title: the screenshot line was this long
/// (`M3窗口主控启动与关键任务…` + filename + project name + app name).
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

/// How wide this text is when **unconstrained**. Compare with the painted box
/// and you know whether it was ellipsized — harder than "eyeball a screenshot",
/// and more stable than asserting a pixel constant (it tracks if the font size
/// changes).
double _intrinsicWidth(Text t) {
  final TextPainter p = TextPainter(
    text: TextSpan(text: t.data, style: t.style),
    textDirection: TextDirection.ltr,
    maxLines: 1,
  )..layout();
  return p.width;
}

void main() {
  testWidgets('a long focus-window title must not crowd out "which computer I am talking to"', (WidgetTester tester) async {
    // Phone width, not tablet: this defect only holds on a narrow screen;
    // measuring at the default 800x600 is the same as not measuring.
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
    // The badge only paints a real label when **connected** (disconnected is
    // the neutral `→ —`, too short to apply pressure).
    transport.pushStatus(SocketStatus.connected);
    controller.destination.onFocusApp(_longFocus);

    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller)),
    );
    await tester.pump();

    // ① Overflow stripes themselves are one manifestation of the defect
    // (written in the comments of the v0.2.1 incident).
    expect(tester.takeException(), isNull, reason: 'the top bar overflowed');

    final Finder nameFinder = find.byKey(const ValueKey<String>('chat.deviceName'));
    final Text nameText = tester.widget<Text>(nameFinder);
    expect(nameText.data, _pcName);

    final double namePainted = tester.getSize(nameFinder).width;
    final double nameNeeds = _intrinsicWidth(nameText);

    // ② Positive control: the badge **must** be the one that was compressed.
    // If it was not compressed, this title never applied pressure ⇒ the
    // "name is intact" assertion below is an idle spin, zero proof against
    // regression.
    final Finder badgeFinder = find.textContaining(_longFocus.substring(0, 12));
    final double badgePainted = tester.getSize(badgeFinder).width;
    final double badgeNeeds = _intrinsicWidth(tester.widget<Text>(badgeFinder));
    expect(
      badgePainted,
      lessThan(badgeNeeds - 1),
      reason: 'the badge was not compressed ⇒ this title applied no pressure, this test is blind',
    );

    // ③ The actual question: not one character of the name may be ellipsized.
    expect(
      namePainted,
      greaterThanOrEqualTo(nameNeeds - 0.5),
      reason: '"$_pcName" was squeezed to ${namePainted.toStringAsFixed(1)}px'
          ' (full needs ${nameNeeds.toStringAsFixed(1)}px) — owner has to leave again to see which machine',
    );
  });

  testWidgets('on the narrowest screen + every production condition, the longer machine name still fits', (WidgetTester tester) async {
    // 360dp is a common Android minimum width; the 411dp above is the generous
    // case. **At the same time** put on everything production occupies that the
    // case above did not: the back key, the channel chip, the longer machine
    // name. Miss any one of them and "it fits" only holds in a world more
    // generous than reality.
    tester.view.physicalSize = const Size(360 * 3, 780 * 3);
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
    controller.session.serverChannel.value = ServerChannel.lan; // channel chip appears
    transport.pushStatus(SocketStatus.connected);
    controller.destination.onFocusApp(_longFocus);

    await tester.pumpWidget(
      MaterialApp(
        home: ChatFlowPage(controller: controller, onBack: () {}), // back key appears
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'the top bar overflowed at 360dp');

    // Positive control: these things are really there, otherwise this case
    // measures a emptier top bar.
    expect(find.byKey(const ValueKey<String>('chat.back')), findsOneWidget);
    expect(find.text(AppStrings(AppLocale.zh).localLan), findsOneWidget);

    final Finder nameFinder = find.byKey(const ValueKey<String>('chat.deviceName'));
    final Text nameText = tester.widget<Text>(nameFinder);
    expect(
      tester.getSize(nameFinder).width,
      greaterThanOrEqualTo(_intrinsicWidth(nameText) - 0.5),
      reason: '"$_pcName" was truncated at 360dp',
    );
  });

  testWidgets('when it does not fit it still must not be eaten by someone else: the name must get the leftover width of the whole row', (WidgetTester tester) async {
    // 🔴 **This case measures the boundary of the promise, not "every name
    // fits"** — that promise we cannot give: at 360dp, two 40dp tap targets +
    // gaps leave only 250px, and a 19-character machine name needs 256px.
    // What we can promise is **nobody else comes to split**: the name gets all
    // of row 1 except the tap targets; whether that is enough is a matter of
    // character count and screen width, no longer of which window is open on
    // the other side. When the ellipsis is still there, the full answer is
    // covered by "tap the name".
    //
    // Why this case is separate: if we only assert "dev-pc-a fits", someone
    // can move row-2 things back onto row 1 and as long as 202.5px remain the
    // test stays green — and that is exactly the shape of this defect.
    tester.view.physicalSize = const Size(360 * 3, 780 * 3);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    controller.session.connectedDeviceName.value = 'dev-pc-a-minipc';
    controller.session.serverChannel.value = ServerChannel.lan;
    transport.pushStatus(SocketStatus.connected);
    controller.destination.onFocusApp(_longFocus);

    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller, onBack: () {})),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);

    // On row 1, besides the name, only two 40dp tap targets (← and the
    // connection dot) and the 2px gap between them are allowed.
    const double kTapTargets = 40 + 40 + 2;
    final double rowWidth = tester.getSize(find.byKey(const ValueKey<String>('chat.back'))).width +
        tester.getSize(find.byKey(const ValueKey<String>('chat.deviceNameTap'))).width +
        tester.getSize(find.byKey(const ValueKey<String>('chat.connDot'))).width +
        2;
    final double nameCell =
        tester.getSize(find.byKey(const ValueKey<String>('chat.deviceNameTap'))).width;
    expect(
      nameCell,
      closeTo(rowWidth - kTapTargets, 0.5),
      reason: 'a third competitor appeared on row 1 — the name is about to be squeezed again',
    );
  });

  testWidgets('the name is tappable: when the ellipsis is still there, the full answer must also be one tap away', (WidgetTester tester) async {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ChatController controller = _controller(transport);
    addTearDown(() async {
      await controller.dispose();
      controller.destination.dispose();
      controller.store.dispose();
    });

    controller.session.connectedDeviceName.value = _pcName;
    await tester.pumpWidget(
      MaterialApp(home: ChatFlowPage(controller: controller)),
    );

    // A 50px row may forever fail to fit some longer machine name, so "it
    // fits" is not the only way out: tapping the name = tapping the connection
    // dot, opens the same diagnostics sheet (the full device name is there).
    // Owner's previous move was "leave to the instance list and look again",
    // and that is what this surface owed him.
    await tester.tap(find.byKey(const ValueKey<String>('chat.deviceNameTap')));
    await tester.pumpAndSettle();
    expect(find.text(_pcName), findsWidgets, reason: 'the diagnostics sheet did not give the full machine name');
  });
}
