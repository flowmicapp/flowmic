// ST-2 (2026-08-19) — the way to the account page, from inside the app.
//
// Both stores expect an account-deletion path a user can find without leaving
// the app to look for it, and this app deliberately has no sign-up of its own
// (registration is on the website, owner 2026-08-11). So the honest shape is a
// link, and the two things worth pinning are the two ways a link lies:
//   · it opens nothing and says nothing (the dead-button façade), and
//   · it appears when there is no account to manage.
//
// SPEC-REF:
//   apps/mobile/lib/src/ui/cloud_signout_row.dart
//   apps/mobile/lib/src/support/legal_urls.dart (kAccountPageUrl)
//   docs/strategy/2026-08-19-store-review-approval-playbook.md ST-2

import 'package:flowmic/src/auth/account_store.dart';
import 'package:flowmic/src/auth/login_controller.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/support/legal_urls.dart';
import 'package:flowmic/src/ui/cloud_signout_row.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:url_launcher/url_launcher.dart';

import 'support/di.dart';
import 'support/fakes.dart';

const String _kSaas = 'https://saas.test:443';

Future<void> _pump(
  WidgetTester tester, {
  required LoginController login,
  required ConnectionsController connections,
  required AccountUrlLauncher launcher,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: CloudSignOutRow(
          login: login,
          connections: connections,
          strings: AppStrings.of(AppLocale.en),
          urlLauncher: launcher,
        ),
      ),
    ),
  );
  await tester.pump();
}

/// The same shape cloud_signout_confirm_gate_test.dart uses: a real login
/// through the fake transport, so 「signed in」 is the controller's own answer
/// rather than a flag a test set on it.
Future<void> _signIn(FakeSocketTransport t, LoginController login) async {
  t.ackQueue.add(<String, Object?>{
    'ok': true,
    'token': 'jwt-st2',
    'user': <String, Object?>{'email': 'st2@flowmic.test', 'id': 'u-st2'},
    'mode': 'saas',
  });
  await login.login(email: 'st2@flowmic.test', password: 'secret12ab');
  if (!login.isLoggedIn) {
    throw StateError('harness precondition failed: the fake login did not take');
  }
}

void main() {
  late FakeSocketTransport transport;
  late LoginController login;
  late ConnectionsController connections;

  setUp(() {
    // connectSucceeds: the login flow dials before it emits, so a transport
    // that refuses to connect makes the fake ack unreachable — the same setup
    // the sibling sign-out test uses.
    transport = FakeSocketTransport()..connectSucceeds = true;
    login = LoginController(
      transport: transport,
      accountStore: InMemoryAccountStore(),
      saasEndpoint: _kSaas,
    );
    connections = ConnectionsController(
      session: newTestSession(transport: transport),
      login: login,
      saasEndpoint: _kSaas,
    );
  });

  tearDown(() {
    connections.dispose();
    login.dispose();
  });

  testWidgets('signed out ⇒ no link at all — there is no account to manage',
      (WidgetTester tester) async {
    await _pump(
      tester,
      login: login,
      connections: connections,
      launcher: (Uri url, {required LaunchMode mode}) async => true,
    );
    expect(find.byKey(const ValueKey<String>('cloud.account.manage')), findsNothing);
  });

  testWidgets('signed in ⇒ the tap really opens the account page',
      (WidgetTester tester) async {
    await _signIn(transport, login);
    final List<Uri> opened = <Uri>[];
    await _pump(
      tester,
      login: login,
      connections: connections,
      launcher: (Uri url, {required LaunchMode mode}) async {
        opened.add(url);
        return true;
      },
    );

    await tester.tap(find.byKey(const ValueKey<String>('cloud.account.manage')));
    // Two pumps, and the second one is not ceremony: the tap handler awaits the
    // launcher and then the clipboard write before it can raise the snackbar,
    // so a single frame lands BEFORE the sentence exists.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(opened.single.toString(), kAccountPageUrl,
        reason: 'the address comes from the one place that owns it');
    expect(kAccountPageUrl, contains('/console/account'));
  });

  testWidgets('🔴 a launcher that refuses is said out loud, not swallowed',
      (WidgetTester tester) async {
    // The failure this pins is the one that matters on THIS row: a user looking
    // for how to delete their account taps, nothing happens, and they conclude
    // there is no way. The address is copied and the sentence names the problem.
    await _signIn(transport, login);
    await _pump(
      tester,
      login: login,
      connections: connections,
      launcher: (Uri url, {required LaunchMode mode}) async => false,
    );

    await tester.tap(find.byKey(const ValueKey<String>('cloud.account.manage')));
    // Two pumps, and the second one is not ceremony: the tap handler awaits the
    // launcher and then the clipboard write before it can raise the snackbar,
    // so a single frame lands BEFORE the sentence exists.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // 🔴 This case is the one that FOUND the defect: with the clipboard write
    // ahead of the message, the snackbar never appeared here at all (0 found),
    // and on a real phone that would have been a tap that did nothing to a user
    // looking for how to delete their account. Assert the SnackBar itself, not
    // only its text — the shape is what the fix restored.
    expect(find.byType(SnackBar), findsOneWidget);
    expect(find.textContaining(kAccountPageUrl), findsOneWidget);
  });

  testWidgets('a launcher that THROWS is the same answer, not a crash',
      (WidgetTester tester) async {
    await _signIn(transport, login);
    await _pump(
      tester,
      login: login,
      connections: connections,
      launcher: (Uri url, {required LaunchMode mode}) async =>
          throw StateError('no handler'),
    );

    await tester.tap(find.byKey(const ValueKey<String>('cloud.account.manage')));
    // Two pumps, and the second one is not ceremony: the tap handler awaits the
    // launcher and then the clipboard write before it can raise the snackbar,
    // so a single frame lands BEFORE the sentence exists.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.textContaining(kAccountPageUrl), findsOneWidget);
  });

  test('every locale says BOTH things: what it does, and where it happens', () {
    for (final AppLocale locale in AppLocale.values) {
      final AppStrings s = AppStrings.of(locale);
      expect(s.accountManageLink.trim(), isNotEmpty, reason: locale.name);
      expect(s.accountManageNote.trim(), isNotEmpty, reason: locale.name);
      expect(s.accountManageNote, isNot(s.accountManageLink), reason: locale.name);
    }
  });
}
