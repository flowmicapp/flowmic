import 'package:flowmic/src/auth/browser_login.dart';
import 'package:flowmic/src/auth/browser_login_controller.dart';
import 'package:flowmic/src/auth/deep_link_source.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/login_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/browser_login_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';

void main() {
  for (final String outcome in ['expired']) {
    testWidgets('closed panel callback uses current app language', (tester) async {
      AppStrings s = const AppStringsZh();
      final transport = FakeSocketTransport()..connectSucceeds = true;
      final login = newTestLogin(transport: transport);
      final links = FakeBrowserLoginLinks();
      final opener = FakeBrowserOpener();
      int now = 1800000000000;
      final browser = BrowserLoginController(
        login: login, links: links, store: InMemoryBrowserLoginStateStore(),
        opener: opener.call, endpoint: 'https://flowmic.app',
        waitTimeout: const Duration(seconds: 1),
        now: () => DateTime.fromMillisecondsSinceEpoch(now),
      );
      addTearDown(() async { login.dispose(); await links.close(); });
      transport.ackQueue.add(<String, Object?>{
        'ok': true, 'token': 'eyJh.eyJz.sig',
        'user': <String, Object?>{'id': 'u1', 'email': 'a@b.co', 'plan': 'free'},
      });
      late BuildContext home;
      await tester.pumpWidget(MaterialApp(home: Builder(builder: (context) {
        home = context;
        return const Scaffold(body: Text('home'));
      })));
      final panel = showLoginSheet(home, controller: login, strings: s, browserLogin: browser, currentStrings: () => s);
      await tester.pumpAndSettle();
      await tester.tap(find.text(s.browserLoginTitle));
      await tester.pump();
      expect(opener.opened, hasLength(1));
      Navigator.of(home).pop();
      await tester.pumpAndSettle();
      await panel;
      expect(find.text(s.browserLoginTitle), findsNothing);
      await tester.pump(const Duration(milliseconds: 10));
      expect(find.byType(SnackBar), findsNothing,
          reason: 'closing the panel makes the wait timeout silent');
      if (outcome == 'silent') {
        now += kBrowserLoginStateTtl.inMilliseconds + 1;
        await tester.pump(kBrowserLoginStateTtl + const Duration(seconds: 1));
        expect(find.byType(SnackBar), findsNothing);
        expect(login.isLoggedIn, isFalse);
        return;
      }
      s = const AppStringsEn();
      now += outcome == 'expired' ? kBrowserLoginStateTtl.inMilliseconds + 1
          : const Duration(minutes: 5).inMilliseconds;
      links.push(Uri.parse('flowmic://login').replace(queryParameters: {
        'state': outcome == 'invalid' ? 'forged' : opener.opened.single.queryParameters['state']!,
        't': 'nonce', 'endpoint': 'https://flowmic.app',
      }));
      await tester.pumpAndSettle();
      if (outcome == 'success') {
        expect(login.isLoggedIn, isTrue);
        expect(transport.emitted, hasLength(1));
      } else {
        final code = outcome == 'expired' ? BrowserLoginCodes.expired : BrowserLoginCodes.stateMismatch;
        expect(login.isLoggedIn, isFalse);
        expect(transport.emitted, isEmpty);
        expect(find.text(s.browserLoginError(code)), findsOneWidget);
      }
    });
  }
}
