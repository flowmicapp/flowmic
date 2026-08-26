// SPEC-REF:
//   permission/camera_permission.dart — card SCAN-PERM (2026-08-25); the whole
//     argument (and the measured defect) lives there.
//   ui/add_pairing_sheet.dart + ui/scan_sheet.dart — the two callers.
//
// ONE scanner lifecycle, two sheets. Both sheets used to own a
// `MobileScannerController` built exactly once — one in `initState`, one as a
// field initialiser — and asking the OS for the camera was a side effect of
// building it. This mixin is the replacement for both, extracted rather than
// duplicated so the login sheet cannot drift back to the old shape the day the
// pairing sheet learns something new (and because add_pairing_sheet.dart sits
// at the 800-line cap).
//
// The contract, in order:
//   · [attachCamera] PROBES the OS (no UI) and listens to the face;
//   · the scanner controller is built ONLY when the face is READY, and it is
//     built AGAIN on every transition back to ready (a grant, a resume) —
//     re-entrant by construction, never a reused dead controller;
//   · `didChangeAppLifecycleState(resumed)` re-probes — 🔴 this is the fix for
//     the reported defect (granted in Settings, came back, nothing changed);
//   · [detachCamera] tears everything down, and disposes the flow only when
//     this mixin created it (a test-injected flow belongs to the test).
//
// The mixin requires `WidgetsBindingObserver` to be mixed in BEFORE it (the
// `on` clause), so the resume hook here is the one the binding actually calls.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../permission/camera_permission.dart';

mixin ScannerCameraLifecycle<T extends StatefulWidget>
    on State<T>, WidgetsBindingObserver {
  /// The camera decision layer. Set by [attachCamera]; reading it earlier is a
  /// caller bug (a sheet must attach in `initState`).
  late final CameraPermissionFlow camera;
  bool _ownsCamera = false;

  /// The live scanner controller, or null on every non-ready face.
  MobileScannerController? scanner;

  /// Wire the flow, the observer and the first probe. [injected] is the test
  /// seam; null (production) builds `CameraPermissionFlow.production()` — the
  /// REAL port, never a granted-by-default double (13 册 §7 F1 ②).
  void attachCamera({CameraPermissionFlow? injected}) {
    camera = injected ?? CameraPermissionFlow.production();
    _ownsCamera = injected == null;
    WidgetsBinding.instance.addObserver(this);
    camera.face.addListener(_onCameraFaceChanged);
    unawaited(camera.probe());
  }

  void detachCamera() {
    WidgetsBinding.instance.removeObserver(this);
    camera.face.removeListener(_onCameraFaceChanged);
    stopScanner();
    if (_ownsCamera) camera.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 🔴 THE REPORTED DEFECT'S FIX — see camera_permission.dart `onResumed`.
    // Without this line a user who grants the permission in system settings
    // comes back to the same refusal face until the sheet is unmounted.
    if (state == AppLifecycleState.resumed) unawaited(camera.onResumed());
  }

  /// READY ⇒ (re)build the scanner; any other face ⇒ tear it down so the
  /// permission pane can take the slot. Every transition INTO ready gets a
  /// fresh controller — the old one may have died on a refusal.
  void _onCameraFaceChanged() {
    if (!mounted) return;
    if (camera.face.value == ScanPermissionFace.ready) {
      startScanner();
    } else {
      stopScanner();
    }
    // ignore: invalid_use_of_protected_member — the mixin IS part of the State
    setState(() {});
  }

  /// Re-entrant: disposes any previous controller first. Constructing the
  /// controller is what opens the camera; a refusal that still reaches
  /// MobileScanner surfaces through the sheet's own `errorBuilder`.
  void startScanner() {
    stopScanner();
    scanner = MobileScannerController(
      detectionSpeed: DetectionSpeed.noDuplicates,
      formats: const <BarcodeFormat>[BarcodeFormat.qrCode],
    );
  }

  void stopScanner() {
    final MobileScannerController? old = scanner;
    scanner = null;
    if (old != null) unawaited(old.dispose());
  }
}
