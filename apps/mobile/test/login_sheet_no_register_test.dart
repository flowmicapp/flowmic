// SPEC-REF:
//   docs/decisions/2026-08-27-owner-no-password-login-on-clients.md (owner
//     ruling, card NR-2b: NO username/password login on either client. The
//     phone keeps exactly two entries — sign in with the browser, scan the QR.)
//   docs/decisions/2026-08-11-owner-mobile-register-removed-guide-to-website.md
//     (the earlier half: no in-app registration)
//
// Pins the sign-in sheet's SHAPE: what must be there, and — the load-bearing
// half — what must never come back.
//
// 🔴 WHY THE ABSENCE ASSERTIONS ARE THE POINT. A password field is not removed
// by deleting a widget; it is removed by nothing putting one back. This card
// deleted two TextFields, a submit and a dead 「忘记密码」 line, and the cheapest
// way for any of them to return is a well-meant 「let people type an email if
// they prefer」. `findsNothing` on TextField is the sentence that says no.
//
// ⚠️ Every absence check is preceded by POSITIVE CONTROLS, for the reason this
// file has carried since the register tab went: a probe looking at a blank
// screen passes every `findsNothing` in the world.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flowmic/src/auth/browser_login_controller.dart';
import 'package:flowmic/src/auth/deep_link_source.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/login_sheet.dart';

import 'support/browser_login_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';

const String kEndpoint = 'https://flowmic.app';

/// What a pumped sheet hands back so a test can drive and then quiesce it.
class _Sheet {
  _Sheet(this.opener, this.browser, this.links, this.login, this.transport);
  final FakeBrowserOpener opener;
  final BrowserLoginController browser;
  final FakeBrowserLoginLinks links;
  final LoginController login;
  final FakeSocketTransport transport;
}

/// Builds the sheet with a browser controller whose three platform seams are
/// fakes. Production builds the real one inside the sheet; a widget test must
/// hand one in, because the real one would reach for app_links on construction.
Future<_Sheet> _pumpSheet(
  WidgetTester tester, {
  AppLocale locale = AppLocale.zh,
  bool openerSucceeds = true,
  Duration waitTimeout = const Duration(seconds: 5),
}) async {
  final FakeSocketTransport transport = FakeSocketTransport()..connectSucceeds = true;
  final LoginController controller = newTestLogin(transport: transport);
  final FakeBrowserOpener opener = FakeBrowserOpener(succeeds: openerSucceeds);
  final FakeBrowserLoginLinks links = FakeBrowserLoginLinks();
  final BrowserLoginController browser = BrowserLoginController(
    login: controller,
    links: links,
    store: InMemoryBrowserLoginStateStore(),
    opener: opener.call,
    endpoint: kEndpoint,
    // Short on purpose: a widget test may not leave a timer pending, and the
    // production three minutes would be three minutes of pending fake time.
    // Still long enough that `pumpAndSettle` (which advances 100 ms per pump)
    // cannot trip it by accident — a wait that ended because the HARNESS moved
    // the clock would prove nothing about the product.
    waitTimeout: waitTimeout,
  );
  addTearDown(browser.dispose);
  final AppStrings strings = AppStrings.of(locale);
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => showLoginSheet(
                context,
                controller: controller,
                strings: strings,
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
  return _Sheet(opener, browser, links, controller, transport);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the sheet offers exactly two entries: browser and QR', (
    WidgetTester tester,
  ) async {
    await _pumpSheet(tester);
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    expect(find.text(zh.loginTitle), findsOneWidget);
    expect(find.text(zh.browserLoginTitle), findsOneWidget);
    expect(find.text(zh.loginScanTitle), findsOneWidget);
    // Both are reachable controls, not decoration.
    expect(find.byKey(const ValueKey<String>('login.browser.start')), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('login.scan.start')), findsOneWidget);
  });

  testWidgets('NO password field, NO email field, NO submit, NO dead recovery line', (
    WidgetTester tester,
  ) async {
    await _pumpSheet(tester);
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    // Positive controls FIRST — prove the probe is looking at a live sheet.
    expect(find.text(zh.loginTitle), findsOneWidget);
    expect(find.text(zh.browserLoginTitle), findsOneWidget);

    // 🔴 The absence this card exists for. Not "no field with THIS hint" —
    // no text input of any kind, so a re-added field cannot slip past by
    // wearing a different placeholder.
    expect(find.byType(TextField), findsNothing, reason: 'credential inputs');
    expect(find.byType(EditableText).evaluate().where((Element e) {
      final EditableText t = e.widget as EditableText;
      return !t.readOnly; // SelectableText renders a read-only EditableText
    }), isEmpty, reason: 'any editable text at all');

    // The dead 「忘记密码」 line (login_sheet.dart:220-226 before this card):
    // static text, no handler, no flow behind it. Probed as a literal because
    // the string left with it.
    expect(find.text('忘记密码？'), findsNothing, reason: 'dead forgot-password text');
    expect(find.text('Forgot password?'), findsNothing);
    // The register tab removed in 0.2.6x stays removed.
    expect(find.text('注册'), findsNothing, reason: 'register tab label');
    expect(find.text('创建账号并登录'), findsNothing, reason: 'register button');
  });

  testWidgets('tapping the browser entry hands the OS a /signin?flow=mobile URL', (
    WidgetTester tester,
  ) async {
    final _Sheet sheet = await _pumpSheet(tester);
    await tester.tap(find.byKey(const ValueKey<String>('login.browser.start')));
    await tester.pumpAndSettle();

    expect(sheet.opener.opened, hasLength(1));
    final Uri url = sheet.opener.opened.single;
    expect(url.origin, kEndpoint);
    expect(url.path, '/signin');
    expect(url.queryParameters['flow'], 'mobile');
    // The binding value is minted per attempt and must actually be on the wire —
    // without it the console has nothing to echo and every callback would be
    // refused as unsolicited.
    expect(url.queryParameters['state'], isNotNull);
    expect(url.queryParameters['state']!.length, 32);

    // While the browser has it, the sheet must SAY so and must offer a way
    // out — the OS never tells this app that the user closed the tab.
    expect(find.text(AppStrings.of(AppLocale.zh).browserLoginWaiting), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('login.browser.cancel')));
    await tester.pumpAndSettle();
    expect(sheet.browser.phase, BrowserLoginPhase.idle);
    expect(find.text(AppStrings.of(AppLocale.zh).browserLoginTitle), findsOneWidget);
  });

  testWidgets('🔴 a callback that arrives while the user is away signs in AND closes the sheet', (
    WidgetTester tester,
  ) async {
    final _Sheet sheet = await _pumpSheet(tester);
    // The relay's success shape for a redeemed nonce (frozen wire, 04 §3.1).
    sheet.transport.ackQueue.add(<String, Object?>{
      'ok': true,
      'token': 'eyJh.eyJz.sig',
      'user': <String, Object?>{'id': 'u1', 'email': 'a@b.co', 'plan': 'free'},
    });
    await tester.tap(find.byKey(const ValueKey<String>('login.browser.start')));
    await tester.pumpAndSettle();
    final String state = sheet.opener.opened.single.queryParameters['state']!;

    // The whole point of this flow: the sign-in finishes in ANOTHER APP. The
    // user's last interaction with this sheet was the tap that opened the
    // browser, so nothing here can be waiting on a second one.
    sheet.links.push(
      Uri.parse('flowmic://login').replace(
        queryParameters: <String, String>{
          't': 'nonce-abc',
          'state': state,
          'endpoint': kEndpoint,
        },
      ),
    );
    await tester.pumpAndSettle();
    expect(sheet.login.isLoggedIn, isTrue);

    // 🔴 …and it dismisses itself after the success tick. Leaving it open would
    // make the last step of a working flow「now close this yourself」, on a
    // screen the user did not choose to come back to.
    await tester.pump(const Duration(milliseconds: 800));
    await tester.pumpAndSettle();
    expect(find.text(AppStrings.of(AppLocale.zh).browserLoginTitle), findsNothing);
    expect(find.text('open-sheet'), findsOneWidget, reason: 'back on the page beneath');
  });

  testWidgets('🔴 TIMEOUT RECOVERY: the wait ends by itself and the sheet offers a retry', (
    WidgetTester tester,
  ) async {
    final _Sheet sheet = await _pumpSheet(
      tester,
      waitTimeout: const Duration(seconds: 5),
    );
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    await tester.tap(find.byKey(const ValueKey<String>('login.browser.start')));
    await tester.pumpAndSettle();
    expect(find.text(zh.browserLoginWaiting), findsOneWidget);

    // Let the deadline pass with no callback — a user who cancelled in the
    // browser, or an OS that never routed the URL back. Both look like this.
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();

    expect(sheet.browser.phase, BrowserLoginPhase.failed);
    expect(find.text(zh.browserLoginWaiting), findsNothing, reason: 'no eternal spinner');
    expect(find.text(zh.browserLoginError('BROWSER_LOGIN_TIMED_OUT')), findsOneWidget);
    expect(find.text(zh.browserLoginRetry), findsOneWidget);

    // ...and the retry really re-opens the browser.
    await tester.tap(find.byKey(const ValueKey<String>('login.browser.start')));
    await tester.pumpAndSettle();
    expect(sheet.opener.opened, hasLength(2));
    await sheet.browser.cancel();
    await tester.pumpAndSettle();
  });

  testWidgets('an OS that opens nothing says so by name, and the QR entry stays', (
    WidgetTester tester,
  ) async {
    await _pumpSheet(tester, openerSucceeds: false);
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    await tester.tap(find.byKey(const ValueKey<String>('login.browser.start')));
    await tester.pumpAndSettle();

    expect(find.text(zh.browserLoginError('BROWSER_LOGIN_OPEN_FAILED')), findsOneWidget);
    // 🔴 The route that is left when no browser can be opened: the address is
    // on screen and copyable. A failure that removed it would be a dead end.
    expect(find.text('$kEndpoint/signin'), findsOneWidget);
    expect(find.byKey(const ValueKey<String>('login.scan.start')), findsOneWidget);
    // ...and the primary button invites a retry rather than repeating its label.
    expect(find.text(zh.browserLoginRetry), findsOneWidget);
  });

  testWidgets('the guidance sentence carries the address, and copies it', (
    WidgetTester tester,
  ) async {
    final List<MethodCall> platformCalls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (MethodCall call) async {
        platformCalls.add(call);
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );

    await _pumpSheet(tester);
    final AppStrings zh = AppStrings.of(AppLocale.zh);
    expect(find.text(zh.browserLoginHint), findsOneWidget);
    expect(find.text('$kEndpoint/signin'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey<String>('login.register.copyUrl')));
    await tester.pump();

    final Iterable<MethodCall> setData =
        platformCalls.where((MethodCall c) => c.method == 'Clipboard.setData');
    expect(setData, hasLength(1), reason: 'exactly one clipboard write');
    final Map<Object?, Object?> args =
        setData.single.arguments as Map<Object?, Object?>;
    // 🔴 The PLAIN page address — never the one carrying `state`. A binding
    // pasted onto another device is a binding that device cannot satisfy, and
    // the refusal would look like the user's mistake.
    expect(args['text'], '$kEndpoint/signin');
    expect((args['text']! as String).contains('state='), isFalse);

    await tester.pump();
    expect(find.text(zh.registerLinkCopied), findsOneWidget);
  });

  test('the browser-login copy exists in all nine languages, each distinct', () {
    final Set<String> titles = <String>{};
    final Set<String> hints = <String>{};
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      expect(s.browserLoginTitle.trim(), isNotEmpty, reason: '$locale title');
      expect(s.browserLoginHint.trim(), isNotEmpty, reason: '$locale hint');
      expect(s.browserLoginWaiting.trim(), isNotEmpty, reason: '$locale waiting');
      expect(s.browserLoginRetry.trim(), isNotEmpty, reason: '$locale retry');
      expect(s.browserLoginCancel.trim(), isNotEmpty, reason: '$locale cancel');
      expect(titles.add(s.browserLoginTitle), isTrue,
          reason: '$locale reuses another language\'s button label');
      expect(hints.add(s.browserLoginHint), isTrue,
          reason: '$locale reuses another language\'s explainer');
    }
  });
}
