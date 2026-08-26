// Card SCAN-PERM (2026-08-25) — the camera-permission FACES on both scanner
// sheets, asserted on the RENDERED result, plus the reported defect end to end:
// 「granted it in Settings, came back, the scanner works」.
//
// SPEC-REF:
//   lib/src/permission/camera_permission.dart (decision layer)
//   lib/src/ui/scanner_camera_lifecycle.dart (the shared lifecycle both sheets use)
//   lib/src/ui/scan_permission_pane.dart (face → pane)
//
// Every sentence assertion below reads the laid-out RenderParagraph
// (`expectLegible`), never `Text.data` — 0.2.53's rule: a sentence that exists
// in the catalogue and reaches the screen clipped passes every string-table
// assertion while the user reads three letters.
//
// 🔴 REVERSE CONTROL (mandatory, recorded in the commit message): with the
// resume re-probe deleted from `ScannerCameraLifecycle.didChangeAppLifecycleState`,
// the two 「granted in Settings, came back」 cases below go red on
//   Expected: exactly one matching candidate
//   Actual: _TypeWidgetFinder:<Found 0 widgets with type "MobileScanner": []>
// — i.e. the sheet keeps showing the refusal face after the grant, which is the
// owner's report verbatim.

import 'dart:async';

import 'package:flowmic/src/permission/camera_permission.dart';
import 'package:flowmic/src/permission/os_permission.dart';
import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/add_pairing_sheet.dart';
import 'package:flowmic/src/ui/scan_sheet.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/legibility.dart' show ahemWidthFor, expectLegible;
import 'support/mic_permission_fakes.dart';
import 'support/mobile_scanner_fake.dart';

const String kRelay = 'https://relay.test';
const double kPhoneDp = 411;

final Finder _action = find.byKey(const ValueKey<String>('scan.perm.action'));

CameraPermissionFlow _flow(FakeMicPermissionPort port, {bool asked = false}) =>
    CameraPermissionFlow(port: port, asked: InMemoryAskedOnceStore(asked: asked));

void _phoneView(WidgetTester tester, {AppLocale locale = AppLocale.zh}) {
  tester.view.physicalSize = Size(ahemWidthFor(kPhoneDp, locale) * 3, 890 * 3);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

void main() {
  late FakeSocketTransport transport;
  late ConnectionsController controller;

  setUp(() {
    MobileScannerPlatform.instance = FakeMobileScannerPlatform();
    transport = FakeSocketTransport()..connectSucceeds = true;
    controller = ConnectionsController(
      session: newTestSession(transport: transport),
      login: newTestLogin(transport: transport),
      saasEndpoint: kRelay,
    );
  });

  /// The REAL add-pairing sheet, opened the only way a user reaches it, with a
  /// scripted camera flow. Scan is the default tab (GA-30).
  Future<void> openPairingSheet(
    WidgetTester tester,
    CameraPermissionFlow flow, {
    AppStrings strings = const AppStringsZh(),
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => ElevatedButton(
              onPressed: () {
                unawaited(
                  showAddPairingSheet(
                    context,
                    controller: controller,
                    strings: strings,
                    initialEndpoint: kRelay,
                    cameraPermission: flow,
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  /// The REAL login scan sheet (GA-31), same seam.
  Future<void> openLoginScanSheet(WidgetTester tester, CameraPermissionFlow flow) async {
    const AppStrings s = AppStringsZh();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => ElevatedButton(
              onPressed: () {
                unawaited(
                  showScanSheet(
                    context,
                    strings: s,
                    title: s.loginScanTitle,
                    hint: s.loginScanHint,
                    onScan: (_) async => true,
                    cameraPermission: flow,
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  group('faces on the pairing sheet (rendered result)', () {
    testWidgets('positive control: a granted device shows the camera, no pane', (WidgetTester tester) async {
      _phoneView(tester);
      final CameraPermissionFlow flow = _flow(FakeMicPermissionPort(OsPermissionProbe.granted));
      addTearDown(flow.dispose);
      await openPairingSheet(tester, flow);
      expect(find.byType(MobileScanner), findsOneWidget);
      expect(_action, findsNothing);
    });

    testWidgets('never asked + denied ⇒ RATIONALE: the reason is legible, the scanner is '
        'NOT built, and the button fires the real request', (WidgetTester tester) async {
      _phoneView(tester);
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.denied)
        ..requestAnswer = OsPermissionProbe.granted;
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await openPairingSheet(tester, flow);

      const AppStrings s = AppStringsZh();
      expect(find.byType(MobileScanner), findsNothing,
          reason: 'asking for the permission must not be a side effect of building the scanner');
      expectLegible(tester, find.text(s.cameraRationale));
      expect(find.text(s.cameraAllowAction), findsOneWidget);
      expect(port.requestCalls, 0, reason: 'nothing requested before the user taps');

      await tester.tap(_action);
      await tester.pumpAndSettle();
      expect(port.requestCalls, 1);
      expect(find.byType(MobileScanner), findsOneWidget, reason: 'granted ⇒ the scanner is built');
      expect(_action, findsNothing);
    });

    testWidgets('asked before + denied ⇒ DENIED (not a second explain)', (WidgetTester tester) async {
      _phoneView(tester);
      final CameraPermissionFlow flow = _flow(FakeMicPermissionPort(OsPermissionProbe.denied), asked: true);
      addTearDown(flow.dispose);
      await openPairingSheet(tester, flow);
      const AppStrings s = AppStringsZh();
      expectLegible(tester, find.text(s.cameraDenied));
      expect(find.text(s.cameraRationale), findsNothing);
    });

    testWidgets('permanently denied ⇒ its OWN face whose button opens system settings', (WidgetTester tester) async {
      _phoneView(tester);
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.permanentlyDenied);
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await openPairingSheet(tester, flow);
      const AppStrings s = AppStringsZh();
      expectLegible(tester, find.text(s.cameraPermanentlyDenied));
      expect(find.text(s.cameraOpenSettingsAction), findsOneWidget);
      await tester.tap(_action);
      await tester.pumpAndSettle();
      expect(port.openSettingsCalls, 1);
      expect(port.requestCalls, 0, reason: 'the OS would show nothing — the settings screen is the only way');
      // The manual-entry fallback stays one tap away, with its reason unchanged.
      expect(find.text(s.pairTabManual), findsOneWidget);
    });

    testWidgets('every locale renders its own legible sentence for each face', (WidgetTester tester) async {
      for (final AppLocale locale in AppLocale.values) {
        final AppStrings s = AppStrings.of(locale);
        for (final (OsPermissionProbe probe, String Function(AppStrings) sentence) in <(OsPermissionProbe, String Function(AppStrings))>[
          (OsPermissionProbe.denied, (AppStrings s) => s.cameraRationale),
          (OsPermissionProbe.permanentlyDenied, (AppStrings s) => s.cameraPermanentlyDenied),
        ]) {
          _phoneView(tester, locale: locale);
          final CameraPermissionFlow flow = _flow(FakeMicPermissionPort(probe));
          await openPairingSheet(tester, flow, strings: s);
          expectLegible(tester, find.text(sentence(s)), reason: '$locale / ${probe.name}');
          await tester.pumpWidget(const SizedBox.shrink());
          flow.dispose();
        }
      }
    });
  });

  group('🔴 the reported defect — granted in Settings, came back', () {
    testWidgets('pairing sheet: refusal face → resume with the OS now saying granted ⇒ '
        'the scanner is built, with NO tab switch and NO remount', (WidgetTester tester) async {
      _phoneView(tester);
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.permanentlyDenied);
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await openPairingSheet(tester, flow);
      expect(find.byType(MobileScanner), findsNothing, reason: 'positive control: the refusal face is up');

      // The user flips the camera toggle in system settings and comes back.
      port.current = OsPermissionProbe.granted;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();

      expect(find.byType(MobileScanner), findsOneWidget);
      expect(_action, findsNothing);
      expect(port.requestCalls, 0, reason: 'a resume is a re-READ, never a request');
    });

    testWidgets('login sheet: the same shape (it used to have no way back at all)', (WidgetTester tester) async {
      _phoneView(tester);
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.permanentlyDenied);
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await openLoginScanSheet(tester, flow);
      const AppStrings s = AppStringsZh();
      expectLegible(tester, find.text(s.cameraPermanentlyDenied));
      expect(find.byType(MobileScanner), findsNothing);

      port.current = OsPermissionProbe.granted;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.byType(MobileScanner), findsOneWidget);
    });

    testWidgets('a resume that changes nothing keeps the face (no flicker, no request)', (WidgetTester tester) async {
      _phoneView(tester);
      final FakeMicPermissionPort port = FakeMicPermissionPort(OsPermissionProbe.permanentlyDenied);
      final CameraPermissionFlow flow = _flow(port);
      addTearDown(flow.dispose);
      await openPairingSheet(tester, flow);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(find.byType(MobileScanner), findsNothing);
      expect(find.text(const AppStringsZh().cameraPermanentlyDenied), findsOneWidget);
      expect(port.requestCalls, 0);
    });
  });
}
