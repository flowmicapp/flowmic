// owner 2026-08-27 UAT ①, measured on a Lenovo tablet: signing in through the
// device's DEFAULT browser (its stock browser) is refused by Google —「this
// browser is not secure」— while Chrome on the same tablet completes the flow.
// Owner's ask: say so on the phone's sign-in sheet. A NOTE ONLY; do not try to
// open Chrome for the user.
//
// 🔴 WHY THIS IS THE ONLY POSSIBLE FIX, AND WHY THAT SHAPES THE TEST.
// The refusal happens on a page in another process. Nothing reaches this app:
// no callback, no code, no error — the same silence a user who closed the tab
// produces, which lands on BROWSER_LOGIN_TIMED_OUT. So there is no state to
// render it from and no code to name it by (inventing one would state a cause
// we do not know, the 0.2.53 rule). What is left is to say it BEFORE it
// happens, which means the only thing worth asserting is that the sentence is
// on screen, readable, in every language, whenever the browser entry is.
//
// ⚠️ WHAT THIS FILE CANNOT PROVE, stated rather than implied: that the sentence
// is TRUE of any particular browser. That fact came from a real tablet, is
// recorded in the owner's report, and no headless test can re-derive it.
//
// ⚠️ AHEM RULER — flutter_test paints every glyph as a full-em square, so
// 「not clipped here」⇒「not clipped on a real phone」and NOT the converse.
// See test/support/legibility.dart.
//
// ── REVERSE CONTROL, run on this machine (dev-pc-a), then restored ──
// Deleted the note's `Text` from `login_sheet.dart`'s `_browserGuidance` and
// re-ran. Twelve of the thirteen cases went red; the first three, verbatim:
//
//   00:00 +0 -1: the note is on the sheet, in the explainer that carries the
//                address [E]
//   00:00 +0 -2: 🔴 it is still there on the timed-out face — the one this
//                refusal lands on [E]
//   00:00 +0 -3: it is there when no browser opened at all, beside that
//                refusal [E]
//     Expected: exactly one matching candidate
//       Actual: _KeyWidgetFinder:<Found 0 widgets with key
//               [<'login.browser.refusedNote'>]: []>
//      Which: means none were found but one was expected
//
// ⚠️ The thirteenth (「a real translation in every language」) stayed GREEN, and
// that is worth writing down rather than tidying away: it reads the catalogue,
// not the screen. A sentence can exist in nine languages and be painted in
// none — which is precisely why the twelve above land on the render.
//
// Restored; file re-green 13/13.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/login_sheet.dart (_browserGuidance)
//   apps/mobile/lib/src/settings/strings/cloud_strings.dart
//     (browserLoginBrowserRefused — why it is a note and not a code)

import 'package:flowmic/src/auth/browser_login.dart' show BrowserLoginCodes;
import 'package:flowmic/src/auth/browser_login_controller.dart';
import 'package:flowmic/src/auth/deep_link_source.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/login_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/browser_login_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart' show ahemWidthBudget, expectLegible;

const String kEndpoint = 'https://flowmic.app';

final Finder kNote =
    find.byKey(const ValueKey<String>('login.browser.refusedNote'));

class _Sheet {
  _Sheet(this.opener, this.browser, this.login);
  final FakeBrowserOpener opener;
  final BrowserLoginController browser;
  final LoginController login;
}

/// The real sheet, at a real phone width for the language on screen.
///
/// The width matters here and is not decoration: this note is body copy that
/// WRAPS, so the only way it can become unreadable is by being laid out in a
/// box it does not fit — which is a thing a 800dp default viewport can never
/// show.
Future<_Sheet> _pumpSheet(
  WidgetTester tester, {
  required AppLocale locale,
  bool openerSucceeds = true,
}) async {
  final double px = ahemWidthBudget(locale);
  tester.view.physicalSize = Size(px, 1400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final FakeSocketTransport transport = FakeSocketTransport()
    ..connectSucceeds = true;
  final LoginController controller = newTestLogin(transport: transport);
  addTearDown(controller.dispose);
  final FakeBrowserOpener opener = FakeBrowserOpener(succeeds: openerSucceeds);
  final BrowserLoginController browser = BrowserLoginController(
    login: controller,
    links: FakeBrowserLoginLinks(),
    store: InMemoryBrowserLoginStateStore(),
    opener: opener.call,
    endpoint: kEndpoint,
    // Short, but not so short that pumpAndSettle's 100ms steps can trip it: a
    // wait that ended because the HARNESS moved the clock proves nothing.
    waitTimeout: const Duration(seconds: 5),
  );
  addTearDown(browser.dispose);

  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => showLoginSheet(
                context,
                controller: controller,
                strings: AppStrings.of(locale),
                browserLogin: browser,
              ),
              child: const Text('open-sheet'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open-sheet'));
  await tester.pumpAndSettle();
  return _Sheet(opener, browser, controller);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the note is on the sheet, in the explainer that carries the address',
      (WidgetTester tester) async {
    await _pumpSheet(tester, locale: AppLocale.zh);
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    expect(kNote, findsOneWidget);
    expect(find.text(zh.browserLoginBrowserRefused), findsOneWidget);
    expectLegible(tester, kNote, reason: 'zh browser-refusal note');

    // 🔴 IT SITS WITH THE ADDRESS IT TALKS ABOUT. The action the sentence asks
    // for is「open THAT address somewhere else」; parked anywhere else it would
    // name a thing the user then has to go and find. Asserted as geometry —
    // below the explainer's first sentence, above the address — because「it is
    // in the widget tree」would be true of a note at the very bottom too.
    final double hintY = tester.getBottomLeft(find.text(zh.browserLoginHint)).dy;
    final double noteY = tester.getTopLeft(kNote).dy;
    final double addrY = tester.getTopLeft(find.text('$kEndpoint/signin')).dy;
    expect(noteY, greaterThanOrEqualTo(hintY - 0.5));
    expect(addrY, greaterThan(noteY));
  });

  testWidgets('🔴 it is still there on the timed-out face — the one this refusal lands on',
      (WidgetTester tester) async {
    // A refused browser produces NO callback, so from in here it is
    // indistinguishable from a closed tab: both end at BROWSER_LOGIN_TIMED_OUT.
    // That makes this face the one a user who just hit Google's refusal is
    // actually looking at, and the note has to survive to it.
    final _Sheet sheet = await _pumpSheet(tester, locale: AppLocale.en);
    final AppStrings en = AppStrings.of(AppLocale.en);

    await tester.tap(find.byKey(const ValueKey<String>('login.browser.start')));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();

    expect(sheet.browser.phase, BrowserLoginPhase.failed, reason: 'harness precondition');
    expect(find.text(en.browserLoginError(BrowserLoginCodes.timedOut)), findsOneWidget);

    // 🔴 ONCE, not twice. The note lives in the explainer that is always on
    // this sheet, so it is already on screen at this moment; printing it again
    // under the banner would put one sentence in two places and make the second
    // look like a different answer.
    expect(kNote, findsOneWidget);
    expect(find.text(en.browserLoginBrowserRefused), findsOneWidget);
    expectLegible(tester, kNote, reason: 'en note on the timed-out face');
  });

  testWidgets('it is there when no browser opened at all, beside that refusal',
      (WidgetTester tester) async {
    await _pumpSheet(tester, locale: AppLocale.en, openerSucceeds: false);
    final AppStrings en = AppStrings.of(AppLocale.en);

    await tester.tap(find.byKey(const ValueKey<String>('login.browser.start')));
    await tester.pumpAndSettle();

    // Positive control: this really is the open-failed face, not just any sheet.
    expect(find.text(en.browserLoginError(BrowserLoginCodes.openFailed)),
        findsOneWidget);
    expect(kNote, findsOneWidget);
  });

  // One case PER LANGUAGE rather than one case with a loop inside it: a loop
  // reports the first language that breaks and hides the rest, and its failure
  // message has to carry the locale by hand. Nine named cases say which.
  for (final AppLocale locale in AppLocale.values) {
    testWidgets('${locale.name}: the note is painted and not clipped at 360dp',
        (WidgetTester tester) async {
      await _pumpSheet(tester, locale: locale);
      expect(kNote, findsOneWidget);
      // Positive control for the legibility reading below: a box of zero size
      // passes 「not clipped」 for free.
      final Size box = tester.getSize(kNote);
      expect(box.width, greaterThan(0));
      expect(box.height, greaterThan(0));
      expectLegible(tester, kNote, reason: locale.name);
      expect(tester.takeException(), isNull, reason: '${locale.name} overflowed');
    });
  }

  test('the sentence is a real translation in every language, not a copy', () {
    final Set<String> seen = <String>{};
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      expect(s.browserLoginBrowserRefused.trim(), isNotEmpty, reason: locale.name);
      expect(seen.add(s.browserLoginBrowserRefused), isTrue,
          reason: '${locale.name} reuses another language\'s sentence');
      // 🔴 It must name a way out, and the way out is a browser the user can
      // pick. 「Chrome」 is deliberately NOT translated in any language — it is
      // a product name, and a user hunting for it in a launcher will see it
      // spelled exactly this way.
      expect(s.browserLoginBrowserRefused, contains('Chrome'), reason: locale.name);
      expect(s.browserLoginBrowserRefused, contains('Google'), reason: locale.name);
      // ...and it must not become a second copy of the explainer above it.
      expect(s.browserLoginBrowserRefused, isNot(s.browserLoginHint),
          reason: locale.name);
    }
  });
}
