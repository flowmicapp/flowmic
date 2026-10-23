// FM-003 — the add-device / sign-in / scan sheets' error strip must be
// readable in BOTH themes.
//
// The three strips painted their icon and sentence in a fixed dark-theme
// red-300 over `FlowMicColors.redSoft`; on the light sheet that measured 1.49:1
// — under every WCAG bar. They now share `SheetErrorBanner`.
//
// The screen is the deliverable, so this mounts the REAL add-device sheet (the
// path pair_expired_code_render_test.dart already drives: Manual tab, a code,
// Connect, a refused ack) and measures the RENDERED sentence's colour against
// the strip's fill composited over the sheet surface it sits on.
//
// Reverse control (FM-003): put the old ink back in sheet_error_banner.dart
// (the Text colour → Color(0xFFFCA5A5)) and the light case goes red at 1.49:1.

import 'dart:async';
import 'dart:math' as math;

import 'package:flowmic/src/session/connections_controller.dart';
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/ui/add_pairing_sheet.dart';
import 'package:flowmic/src/ui/sheet_error_banner.dart';
import 'package:flowmic/src/ui/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'support/di.dart';
import 'support/fakes.dart';
import 'support/mic_permission_fakes.dart';

/// Copied in shape from pair_expired_code_render_test.dart (its header traces
/// why exactly these six members are the whole camera path).
class _FakeMobileScannerPlatform extends MobileScannerPlatform {
  final StreamController<BarcodeCapture> _barcodes =
      StreamController<BarcodeCapture>.broadcast();

  @override
  Stream<BarcodeCapture?> get barcodesStream => _barcodes.stream;

  @override
  Stream<TorchState> get torchStateStream =>
      Stream<TorchState>.value(TorchState.unavailable);

  @override
  Stream<double> get zoomScaleStateStream => Stream<double>.value(1);

  @override
  Future<MobileScannerViewAttributes> start(StartOptions startOptions) {
    return Future<MobileScannerViewAttributes>.value(
      const MobileScannerViewAttributes(
        cameraDirection: CameraFacing.back,
        currentTorchMode: TorchState.unavailable,
        size: Size(200, 200),
        numberOfCameras: 1,
      ),
    );
  }

  @override
  Widget buildCameraView() => const SizedBox.square(dimension: 100);

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}

double _linear(double c) =>
    c <= 0.03928 ? c / 12.92 : math.pow((c + 0.055) / 1.055, 2.4).toDouble();
double _luminance(Color c) =>
    0.2126 * _linear(c.r) + 0.7152 * _linear(c.g) + 0.0722 * _linear(c.b);
double _contrast(Color a, Color b) {
  final double hi = math.max(_luminance(a), _luminance(b));
  final double lo = math.min(_luminance(a), _luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  setUp(() {
    MobileScannerPlatform.instance = _FakeMobileScannerPlatform();
    FlowMicTheme.brightness.value = Brightness.dark;
    addTearDown(() => FlowMicTheme.brightness.value = Brightness.dark);
  });

  for (final Brightness theme in <Brightness>[Brightness.light, Brightness.dark]) {
    testWidgets('${theme.name}: the add-device error sentence clears 4.5:1 on its strip',
        (WidgetTester tester) async {
      FlowMicTheme.brightness.value = theme;
      final FakeSocketTransport transport = FakeSocketTransport()..connectSucceeds = true;
      final ConnectionsController controller = ConnectionsController(
        session: newTestSession(transport: transport),
        login: newTestLogin(transport: transport),
      );
      transport.ackQueue.add(<String, Object?>{'error': 'PAIR_EXPIRED_CODE'});
      const AppStrings s = AppStringsEn();

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => ElevatedButton(
              onPressed: () => unawaited(showAddPairingSheet(
                context,
                cameraPermission: newTestCameraPermission(),
                controller: controller,
                strings: s,
              )),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(s.pairTabManual));
      await tester.pumpAndSettle();
      final Finder fields = find.byType(TextField);
      await tester.enterText(fields.at(0), '192.168.1.50:41999');
      await tester.enterText(fields.at(1), '1234');
      await tester.pump();
      await tester.tap(find.text(s.pairConnect));
      await tester.pumpAndSettle();

      final String sentence = s.pairError('PAIR_EXPIRED_CODE');
      final Finder strip = find.byKey(kSheetErrorBannerKey);
      expect(strip, findsOneWidget, reason: 'positive control: the refusal reached the strip');
      expect(find.descendant(of: strip, matching: find.text(sentence)), findsOneWidget);

      // The colour the sentence is actually painted in (the render object's
      // span, not the widget's argument).
      final RenderParagraph para = tester.renderObject<RenderParagraph>(
        find.descendant(of: strip, matching: find.text(sentence)),
      );
      final Color ink = para.text.style!.color!;
      final Icon icon = tester.widget<Icon>(
        find.descendant(of: strip, matching: find.byIcon(Icons.error_outline)),
      );
      // The strip's fill composited over the sheet surface it sits on
      // (add_pairing_sheet.dart paints the sheet body `FlowMicColors.surface`).
      final BoxDecoration deco =
          tester.widget<Container>(strip).decoration! as BoxDecoration;
      final Color fill = Color.alphaBlend(deco.color!, FlowMicColors.surface);

      final double textRatio = _contrast(ink, fill);
      final double iconRatio = _contrast(icon.color!, fill);
      // ignore: avoid_print
      print('FM-003 ${theme.name}: text ${textRatio.toStringAsFixed(2)}:1, '
          'icon ${iconRatio.toStringAsFixed(2)}:1');
      expect(textRatio, greaterThanOrEqualTo(4.5),
          reason: '${theme.name} sentence ${textRatio.toStringAsFixed(2)}:1 is under AA');
      expect(iconRatio, greaterThanOrEqualTo(4.5),
          reason: '${theme.name} icon ${iconRatio.toStringAsFixed(2)}:1');
    });
  }
}
