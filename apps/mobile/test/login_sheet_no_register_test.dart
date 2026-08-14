// SPEC-REF:
//   docs/decisions/2026-08-11-owner-mobile-register-removed-guide-to-website.md
//     (owner ruling: NO in-app registration; guide users to the official
//     website; keep sign-in, forgot-password and QR login)
//   docs/strategy/2026-08-11-dev-handoff-after-b6.md §2 (implementation card:
//     the URL is /signin — registration is an IN-PAGE tab there, /register
//     does not exist and no ?mode=create query is parsed today)
//
// Pins the removed register surface CLOSED and the replacement guidance OPEN:
//  1. absence — the sheet renders no register tab, no nickname/confirm-password
//     inputs, and exactly the two sign-in fields (positive controls prove the
//     probe sees the sheet at all);
//  2. guidance — the official-website sentence and the literal URL are visible;
//  3. copy — tapping the copy affordance puts exactly that URL on the system
//     clipboard (asserted on the platform channel, not on our own state).

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/login_sheet.dart';

import 'support/di.dart';
import 'support/fakes.dart';

Future<void> _pumpSheet(WidgetTester tester, {AppLocale locale = AppLocale.zh}) async {
  final LoginController controller = newTestLogin(transport: FakeSocketTransport());
  final AppStrings strings = AppStrings.of(locale);
  await tester.pumpWidget(
    MaterialApp(
      home: Builder(
        builder: (BuildContext context) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () =>
                  showLoginSheet(context, controller: controller, strings: strings),
              child: const Text('open-sheet'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open-sheet'));
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('login sheet has NO register tab and NO register inputs', (
    WidgetTester tester,
  ) async {
    await _pumpSheet(tester);
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    // Positive controls FIRST — prove the probe is looking at a live sheet
    // (a zero on a blind probe would otherwise pass the absence checks).
    expect(find.text(zh.loginTitle), findsOneWidget);
    expect(find.text(zh.forgotPassword), findsOneWidget);
    expect(find.text(zh.loginScanTitle), findsOneWidget);

    // Absence: the register tab and its whole form branch are gone. The old
    // strings were deleted with their producer, so the probes are literals
    // (the exact copy the removed tab used to render).
    expect(find.text('注册'), findsNothing, reason: 'register tab label');
    expect(find.text('注册账号'), findsNothing, reason: 'register title');
    expect(find.text('创建账号并登录'), findsNothing, reason: 'register button');
    expect(find.text('注册尚未开放（私域版）'), findsNothing,
        reason: 'expired-truth inert note');
    expect(find.widgetWithText(TextField, '昵称'), findsNothing,
        reason: 'nickname input');
    expect(find.widgetWithText(TextField, '确认密码'), findsNothing,
        reason: 'confirm-password input');
    // Exactly the sign-in pair — email + password, nothing else.
    expect(find.byType(TextField), findsNWidgets(2));
  });

  testWidgets('guidance to the official website is visible, URL included', (
    WidgetTester tester,
  ) async {
    await _pumpSheet(tester);
    final AppStrings zh = AppStrings.of(AppLocale.zh);

    expect(find.text(zh.registerOnWebsite), findsOneWidget);
    // The literal address the user is told to visit. SelectableText renders
    // through EditableText, which find.text matches.
    expect(find.text('https://flowmic.app/signin'), findsOneWidget);
    expect(find.text(zh.registerCopyLink), findsOneWidget);
  });

  test('the pinned URL is /signin — no invented /register path, no deep link', () {
    // Registration on the web is an in-page tab of /signin. A /register path
    // does not exist, and nothing on the web parses ?mode=create today —
    // pointing at either would be a link to nowhere.
    expect(kRegisterWebsiteUrl, 'https://flowmic.app/signin');
    expect(kRegisterWebsiteUrl.contains('/register'), isFalse);
    expect(kRegisterWebsiteUrl.contains('mode='), isFalse);
  });

  test('guidance copy exists in all four app languages, each distinct', () {
    final Set<String> seen = <String>{};
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      expect(s.registerOnWebsite.trim(), isNotEmpty, reason: '$locale guidance');
      expect(s.registerCopyLink.trim(), isNotEmpty, reason: '$locale copy label');
      expect(s.registerLinkCopied.trim(), isNotEmpty, reason: '$locale copied toast');
      expect(seen.add(s.registerOnWebsite), isTrue,
          reason: '$locale reuses the previous language\'s guidance sentence');
    }
  });

  testWidgets('copy affordance puts the URL on the system clipboard', (
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
    await tester.tap(find.byKey(const ValueKey<String>('login.register.copyUrl')));
    await tester.pump();

    final Iterable<MethodCall> setData =
        platformCalls.where((MethodCall c) => c.method == 'Clipboard.setData');
    expect(setData, hasLength(1), reason: 'exactly one clipboard write');
    final Map<Object?, Object?> args =
        setData.single.arguments as Map<Object?, Object?>;
    expect(args['text'], 'https://flowmic.app/signin');

    // The toast confirms in the user's language.
    await tester.pump();
    expect(find.text(AppStrings.of(AppLocale.zh).registerLinkCopied), findsOneWidget);
  });
}
