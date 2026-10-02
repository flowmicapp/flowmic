import 'package:flowmic/src/auth/browser_login_controller.dart';
import 'package:flowmic/src/auth/deep_link_source.dart';
import 'package:flowmic/src/permission/camera_permission.dart';
import 'package:flowmic/src/permission/os_permission.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/login_sheet.dart';
import 'package:flowmic/src/ui/scan_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/browser_login_fakes.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';
import 'support/inset_geometry.dart';

void main() {
  const AppStrings s = AppStringsZh();
  for (final InsetCase c in insetCases) {
    testWidgets('login final action inside safe area ${c.name}', (
      WidgetTester tester,
    ) async {
      final login = newTestLogin(transport: FakeSocketTransport());
      final FakeBrowserLoginLinks links = FakeBrowserLoginLinks();
      final BrowserLoginController browser = BrowserLoginController(
        login: login,
        links: links,
        store: InMemoryBrowserLoginStateStore(),
        opener: FakeBrowserOpener().call,
      );
      addTearDown(() async {
        browser.dispose();
        login.dispose();
        await links.close();
      });
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (MethodCall call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await openSheet(tester, c, (BuildContext context) {
        showLoginSheet(
          context,
          controller: login,
          strings: s,
          browserLogin: browser,
        );
      });
      final Finder copy = find.byKey(
        const ValueKey<String>('login.register.copyUrl'),
      );
      await reveal(tester, copy);
      expectInside(tester, copy, c);
      await tester.tap(copy);
      await tester.pumpAndSettle();
      expect(copied, isNotEmpty);
      final Finder close = find.byKey(const ValueKey<String>('login.close'));
      await reveal(tester, close);
      expectInside(tester, close, c);
      expect(tester.takeException(), isNull);
    });
    testWidgets('scanner hint and close inside safe area ${c.name}', (
      WidgetTester tester,
    ) async {
      final CameraPermissionFlow camera = CameraPermissionFlow(
        port: FakeMicPermissionPort(OsPermissionProbe.denied),
        asked: InMemoryAskedOnceStore(),
      );
      addTearDown(camera.dispose);
      await openSheet(tester, c, (BuildContext context) {
        showScanSheet(
          context,
          strings: s,
          title: s.loginScanTitle,
          hint: s.loginScanHint,
          onScan: (_) async => false,
          cameraPermission: camera,
        );
      });
      final Finder action = find.byKey(
        const ValueKey<String>('scan.perm.action'),
      );
      await reveal(tester, action);
      expectInside(tester, action, c);
      await reveal(tester, find.text(s.loginScanHint));
      expectInside(tester, find.text(s.loginScanHint), c);
      final Finder close = find.ancestor(
        of: find.byIcon(Icons.close),
        matching: find.byType(InkWell),
      );
      await reveal(tester, close);
      expectInside(tester, close, c);
      await tester.tap(close);
      await tester.pumpAndSettle();
      expect(find.text(s.loginScanHint), findsNothing);
      expect(tester.takeException(), isNull);
    });
  }
}
