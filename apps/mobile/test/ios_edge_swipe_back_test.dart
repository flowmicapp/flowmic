// 0.3.43 Q6 — THE STANDARD iOS EDGE-SWIPE BACK, APP-WIDE, WITH THE CHAT PAGE
// KEEPING ITS EXISTING GUARD.
//
// Ruling:
//   docs/decisions/2026-08-28-owner-settings-catalogue-shortpress-ios-swipe-rulings.md Q6
//   「全 App 启用 iOS 标准边缘左滑返回（Cupertino 过渡；防误操作复用转录页现有返回
//    策略：录音中滑动不退出、有草稿先确认；iOS 真机验证走 TestFlight）」
//
// ── WHAT WAS MEASURED FIRST, BECAUSE IT CHANGES WHAT THE FIX IS ──────────────
// On the SDK this repo builds with (framework 3.41.8, read from
// `bin/cache/flutter.version.json` on dev-pc-a — the SDK FOLDER on that
// machine is named 3.29 and is stale), `PageTransitionsTheme._defaultBuilders`
// ALREADY maps `TargetPlatform.iOS` to `CupertinoPageTransitionsBuilder`. The
// gesture was therefore already on by default, and main.dart's block does not
// switch it on — it PINS it, so the ruling survives a change to Flutter's
// defaults. Saying otherwise would be a fix taking credit for a default.
//
// The same measurement is why Android is restated in that map rather than left
// out: a `builders` map REPLACES the defaults wholesale and Android's
// miss-fallback is `ZoomPageTransitionsBuilder`, so an iOS-only map would have
// silently demoted the platform this product actually ships on today off
// `PredictiveBackPageTransitionsBuilder`.
//
// 🔴 真机未证 (NOT VERIFIED ON A DEVICE). Everything below is headless: the
// builder wiring, the pop disposition, and whether a left-edge drag pops. How
// the drag FEELS on an iPhone needs a TestFlight round.

import 'dart:io' show File;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// A route whose body opts out of popping, the way the chat page's PopScope
/// does while it owns its own exit.
Widget _pushHost({required bool canPop}) => MaterialApp(
  theme: ThemeData(
    platform: TargetPlatform.iOS,
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: <TargetPlatform, PageTransitionsBuilder>{
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
      },
    ),
  ),
  home: Builder(
    builder: (BuildContext context) => Scaffold(
      body: Center(
        child: TextButton(
          onPressed: () => Navigator.of(context).push<void>(
            MaterialPageRoute<void>(
              builder: (_) => PopScope(
                canPop: canPop,
                child: const Scaffold(body: Center(child: Text('second'))),
              ),
            ),
          ),
          child: const Text('go'),
        ),
      ),
    ),
  ),
);

Future<void> _pushSecond(WidgetTester tester) async {
  await tester.tap(find.text('go'));
  await tester.pumpAndSettle();
  expect(find.text('second'), findsOneWidget);
}

/// Drag from the left edge across the screen and let it settle — the standard
/// iOS back gesture.
Future<void> _edgeSwipe(WidgetTester tester) async {
  final TestGesture g = await tester.startGesture(const Offset(2, 300));
  await g.moveBy(const Offset(400, 0), timeStamp: const Duration(milliseconds: 100));
  await tester.pump();
  await g.up();
  await tester.pumpAndSettle();
}

void main() {
  group('the mechanism', () {
    testWidgets('under the Cupertino transition a left-edge drag pops the route',
        (WidgetTester tester) async {
      // 🔴 THE POSITIVE CONTROL, and it has to come first: without it, the
      // refusal case below could be green because the gesture never worked in
      // this harness at all — 「blocked」 and 「never armed」 look identical from
      // the outside, and that is exactly the shape CLAUDE.md's negative-assertion
      // rule was written for.
      await tester.pumpWidget(_pushHost(canPop: true));
      await _pushSecond(tester);
      await _edgeSwipe(tester);
      expect(find.text('second'), findsNothing);
    });

    testWidgets('a PopScope that refuses to pop refuses the gesture too', (
      WidgetTester tester,
    ) async {
      // This is the whole 防误操作 half of the ruling. `_CupertinoBackGestureDetector`
      // will not even ARM on a route whose `popDisposition` is `doNotPop`, so
      // the swipe is not intercepted-then-undone — it never starts.
      await tester.pumpWidget(_pushHost(canPop: false));
      await _pushSecond(tester);
      await _edgeSwipe(tester);
      expect(find.text('second'), findsOneWidget);
    });
  });

  group('the production wiring', () {
    // A SOURCE assertion, and the reason is stated so nobody upgrades it into a
    // widget test by mistake: the theme lives inside `_AppRootState.build`,
    // which cannot be pumped without the whole DI composition root (transport,
    // session, stores, lifecycle). The behaviour it produces is already pinned
    // by the two cases above; what is left to pin is that the app declares it.
    // Same shape and same justification as `chat_history_source_wiring_test.dart`.
    final String main = File('lib/main.dart').readAsStringSync();

    test('iOS is pinned to the Cupertino page transition', () {
      expect(
        main.contains('TargetPlatform.iOS: CupertinoPageTransitionsBuilder()'),
        isTrue,
      );
    });

    test('🔴 and Android is restated, so the map cannot demote it', () {
      // The trap this catches: a `builders` map REPLACES `_defaultBuilders`.
      // Declaring iOS alone would drop Android to the Zoom fallback and quietly
      // remove the predictive-back animation on the shipping platform — a
      // regression with no error, no warning and no other test that sees it.
      expect(
        main.contains(
          'TargetPlatform.android: PredictiveBackPageTransitionsBuilder()',
        ),
        isTrue,
      );
    });

    test('the chat page is pushed WITH an onBack, which is what arms its guard',
        () {
      // The chat page's `interceptBack` is `onBack != null || _selection.active
      // || _sheetOpen`, so `canPop` is false — and the gesture therefore
      // refused — precisely because production hands it an `onBack`. Without
      // this pin, dropping that argument somewhere in main.dart would silently
      // hand the chat page a live back-swipe.
      final int chat = main.indexOf('ChatFlowPage(');
      expect(chat, isNot(-1));
      final int end = main.indexOf('Widget build(BuildContext context)', chat);
      expect(
        main.substring(chat, end == -1 ? main.length : end).contains('onBack:'),
        isTrue,
      );
    });
  });
}
