// The CAMERA permission decision layer — card SCAN-PERM (2026-08-25).
//
// SPEC-REF:
//   docs/strategy/2026-08-25-owner-four-issues-analysis.md §1 (the defect)
//   docs/strategy/2026-08-25-owner-rulings-and-execution-plan.md §2-①
//   ptt/mic_permission.dart — card U2, the shape this file reuses
//   permission/os_permission.dart — the ONE vocabulary both flows speak
//   CLAUDE.md red line: no silent failure (没有静默失败)
//
// ── THE DEFECT, MEASURED (owner, real device, 2026-08-25) ─────────────────
//
// With the camera permission not yet granted, the user granted it and the
// scanner still did not work; only backing out to the instance list and
// re-entering brought the camera up. Root cause (measured, not re-derived):
// both scan sheets built their `MobileScannerController` exactly once — the
// pairing sheet in `initState`, the login sheet as a FIELD INITIALISER — and
// asking the OS for the permission was a SIDE EFFECT of building it. Nothing
// re-armed the controller afterwards: switching tabs reused the dead one, and
// neither sheet had a `WidgetsBindingObserver`, so coming back from system
// settings changed nothing on screen.
//
// ── THE SHAPE, AND WHY IT IS THE MICROPHONE'S ───────────────────────────────
//
// Card U2 already built the correct flow for the microphone: PROBE the OS
// without showing UI, EXPLAIN before the first request, fire the real request
// from the rendered surface's own button, offer `openAppSettings()` when the
// OS will never ask again, and RE-PROBE when the app comes back to the
// foreground. This file is that decision layer for the camera. It reuses the
// VOCABULARY (`OsPermissionProbe` / `OsPermissionPort` / `AskedOnceStore`)
// and NOT the microphone's faces: what a scanner pane must render (a camera
// box, or a reason plus a way back) is a different question from what a talk
// bar must render, and `MicFlowFace.captureStartFailed` has no camera
// counterpart — the scanner's own `errorBuilder` is that seam.
//
// 🔴 The consequence for the sheets: the scanner controller is built ONLY when
// this flow says [ScanPermissionFace.ready], and it is built AGAIN every time
// the face returns to ready (after a grant, after a resume). Asking for the
// permission is therefore never a side effect of building anything.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

import '../diag/diag_log.dart';
import 'os_permission.dart';
import 'platform_permission.dart';

/// The one persisted key for the CAMERA — never the microphone's
/// (`kMicPermissionAskedKey`). One key per permission: a shared bit would let
/// granting the microphone silence the camera's rationale.
const String kCameraPermissionAskedKey = 'flowmic.camera.permission_asked';

/// What a scan pane must render right now. Written ONLY by
/// [CameraPermissionFlow]; the sheets read it and never guess.
enum ScanPermissionFace {
  /// The first probe has not answered yet. The sheet shows an empty box of the
  /// scanner's height — NOT a camera and NOT a refusal, because neither has
  /// been established.
  probing,

  /// The OS says granted (or could not be asked — see [CameraPermissionFlow.probe]).
  /// The sheet builds the scanner controller on this face and on no other.
  ready,

  /// Never asked, and the OS would show the dialog: explain WHY the camera is
  /// needed; the action button fires the real OS request.
  rationale,

  /// Refused, but askable again — the refusal by name + the same request action.
  denied,

  /// The OS will never show the dialog again. The ONLY way out is the system
  /// settings screen, so the action is `openAppSettings()` — and the way back
  /// IN is [CameraPermissionFlow.onResumed], which is the reported defect.
  permanentlyDenied,
}

class CameraPermissionFlow {
  CameraPermissionFlow({required OsPermissionPort port, required AskedOnceStore asked})
    : _port = port,
      _asked = asked;

  /// The production composition: the real `permission_handler` port for the
  /// camera and the camera's own asked-once key. NOT a friendly default that
  /// always answers granted (13 册 §7 F1 ②) — the real thing, so a refusal on
  /// a device is a refusal here too.
  factory CameraPermissionFlow.production() => CameraPermissionFlow(
    port: const PlatformOsPermission(ph.Permission.camera),
    asked: const SharedPrefsAskedOnceStore(kCameraPermissionAskedKey),
  );

  final OsPermissionPort _port;
  final AskedOnceStore _asked;

  /// The rendered truth. A ValueNotifier for the same reason
  /// `MicPermissionFlow.face` is one: the sheet listens and re-reads the value
  /// on every build.
  final ValueNotifier<ScanPermissionFace> face =
      ValueNotifier<ScanPermissionFace>(ScanPermissionFace.probing);

  /// Read the OS (no UI) and write the face. Called before the scanner is
  /// built, and again on every foreground resume.
  ///
  /// `unavailable` (the platform could not be asked at all) maps to READY on
  /// purpose: 「问不出来」("could not be asked") is not a refusal, and the
  /// scanner's own `errorBuilder` is the seam that names a camera failure by
  /// itself. Rendering a permission face for a host that has no permission
  /// plugin would be a status word with no evidence behind it.
  Future<void> probe() async {
    final OsPermissionProbe probe = await _port.status();
    final ScanPermissionFace next = switch (probe) {
      OsPermissionProbe.granted || OsPermissionProbe.unavailable => ScanPermissionFace.ready,
      OsPermissionProbe.permanentlyDenied => ScanPermissionFace.permanentlyDenied,
      OsPermissionProbe.denied =>
        (await _asked.askedBefore()) ? ScanPermissionFace.denied : ScanPermissionFace.rationale,
    };
    if (next != ScanPermissionFace.ready) {
      diag('camera.permission.blocked', <String, Object?>{'probe': probe.name, 'face': next.name});
    }
    if (face.value != next) face.value = next;
  }

  /// 🔴 THE REPORTED DEFECT'S FIX. The sheet's `WidgetsBindingObserver` calls
  /// this on `AppLifecycleState.resumed`: the user may have just granted the
  /// permission in system settings, and the only way to learn that is to ask
  /// the OS again. A flow that skipped this re-probe would leave a user who
  /// granted the permission looking at the 「去设置开启」 face until they
  /// unmounted the sheet — exactly what the owner reported.
  Future<void> onResumed() => probe();

  /// The rationale/denied face's action: run the REAL OS request, after the
  /// explanation was on screen (the surface's button is what called us).
  Future<void> requestFromSurface() async {
    await _asked.markAsked(); // before the dialog: a killed dialog still counts
    final OsPermissionProbe probe = await _port.request();
    diag('camera.permission.requested', <String, Object?>{'result': probe.name});
    face.value = switch (probe) {
      OsPermissionProbe.granted || OsPermissionProbe.unavailable => ScanPermissionFace.ready,
      OsPermissionProbe.denied => ScanPermissionFace.denied,
      // Android answers this WITHOUT a dialog after 「don't ask again」 — the
      // transition that swaps the button from 「允许」 to 「去设置开启」.
      OsPermissionProbe.permanentlyDenied => ScanPermissionFace.permanentlyDenied,
    };
  }

  /// The permanently-denied face's action — the `openAppSettings` way out. The
  /// face deliberately stays up: whether the user granted anything over there
  /// is unknowable from here, and [onResumed] is what finds out.
  Future<void> openSystemSettings() async {
    diag('camera.permission.open_settings', const <String, Object?>{});
    await _port.openSettings();
  }

  void dispose() => face.dispose();
}
