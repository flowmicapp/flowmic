// A platform double for any test that pumps the REAL add-pairing sheet.
//
// `_AddPairingSheet.initState` unconditionally builds a MobileScannerController
// and starts it (autoStart defaults true), so pumping the real sheet with no
// platform double throws MissingPluginException. This is the pattern from the
// package's own suite (mobile_scanner-7.4.0/test/mobile_scanner_widget/
// detect_barcode_test.dart): swap `MobileScannerPlatform.instance` for a plain
// Dart Fake overriding only what the exercised path calls. Every method NOT
// overridden throws UnimplementedError by construction, so nothing silently
// routes through the real MethodChannel.
//
// Traced call path: `_initializeController` → `controller.attach()` (no
// platform call) → `controller.start()` → `_setupListeners()` (the three stream
// getters) → platform `start()` → the preview widget calls `buildCameraView()`.
// Switching away from the scan tab disposes the `MobileScanner` widget →
// `controller.stop()` → platform `stop()`; ending the sheet disposes the
// controller → platform `dispose()`. Six methods, zero channels.
//
// ⚠️ `pair_expired_code_render_test.dart` carries the original private copy of
// this fake and is deliberately left untouched (it belongs to another card).
// This file exists so the 0.2.66 PCID tests do not add a THIRD copy.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class FakeMobileScannerPlatform extends MobileScannerPlatform {
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
