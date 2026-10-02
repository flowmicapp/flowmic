import 'package:flowmic/src/permission/camera_permission.dart';
import 'package:flowmic/src/permission/os_permission.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/add_pairing_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/di.dart';
import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';
import 'support/inset_geometry.dart';

void main() {
  const AppStrings s = AppStringsZh();
  for (final InsetCase c in insetCases) {
    testWidgets('pairing actions inside safe area ${c.name}', (
      WidgetTester tester,
    ) async {
      final FakeSocketTransport socket = FakeSocketTransport();
      final session = newTestSession(transport: socket);
      final login = newTestLogin(transport: socket);
      final ConnectionsController controller = ConnectionsController(
        session: session,
        login: login,
        saasEndpoint: 'https://relay.test',
      );
      final CameraPermissionFlow camera = CameraPermissionFlow(
        port: FakeMicPermissionPort(OsPermissionProbe.denied),
        asked: InMemoryAskedOnceStore(),
      );
      addTearDown(() async {
        controller.dispose();
        login.dispose();
        camera.dispose();
        await session.dispose();
      });
      await openSheet(tester, c, (BuildContext context) {
        showAddPairingSheet(
          context,
          controller: controller,
          strings: s,
          initialEndpoint: 'https://relay.test',
          cameraPermission: camera,
        );
      });
      await reveal(tester, find.text(s.pairTabManual));
      await tester.tap(find.text(s.pairTabManual));
      await tester.pumpAndSettle();
      final Finder connect = find
          .ancestor(
            of: find.text(s.pairConnect),
            matching: find.byType(GestureDetector),
          )
          .first;
      await reveal(tester, connect);
      expectInside(tester, connect, c);
      await tester.tap(connect);
      await tester.pumpAndSettle();
      expect(controller.busy, isFalse);
      expect(tester.takeException(), isNull);
      if (c.ime > 0) {
        tester.view.viewInsets = FakeViewPadding.zero;
        tester.view.padding = FakeViewPadding(
          top: c.top,
          left: c.left,
          right: c.right,
          bottom: c.bottom,
        );
        await tester.pumpAndSettle();
        await reveal(tester, connect);
        expectInside(tester, connect, InsetCase('dismissed', bottom: c.bottom));
      }
    });
  }
}
