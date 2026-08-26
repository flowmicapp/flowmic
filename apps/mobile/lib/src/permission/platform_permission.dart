// The production [OsPermissionPort]: `permission_handler`, for ANY permission.
//
// SPEC-REF:
//   card U2 — ptt/mic_permission.dart holds the argument this adapter serves.
//   card CAM-1 (2026-08-25) — the camera reuses this rather than repeating the
//     status mapping below.
//
// `permission_handler` (pubspec pins ^11.3.1; lockfile resolves 11.4.0) was
// ALREADY the app's permission dependency, and its top-level
// `openAppSettings()` is the 「去设置开启」("go to Settings and turn it on")
// call the repo never made — so neither U2 nor CAM-1 adds a dependency.
//
// 🔴 THE MAPPING IS POLICY, AND IT LIVES IN EXACTLY ONE PLACE. `_map` decides
// that `restricted` reads as permanently-denied and that partial grants read as
// granted. Those are judgements, not mechanics, and a second copy of them for
// the camera would be a second answer to 「操作系统这个状态算什么」("what does
// this OS state count as") — free to drift the day one copy learns something.

import 'package:flutter/services.dart' show MissingPluginException;
import 'package:permission_handler/permission_handler.dart' as ph;

import 'os_permission.dart';

class PlatformOsPermission implements OsPermissionPort {
  const PlatformOsPermission(this.permission);

  /// Which OS permission this port speaks for. Passed in rather than baked in,
  /// so the decision layers stay identical across permissions and only the
  /// FACES differ.
  final ph.Permission permission;

  @override
  Future<OsPermissionProbe> status() async {
    try {
      return _map(await permission.status);
    } on MissingPluginException {
      // A host whose plugin registry has no permission_handler. Deliberately
      // ONLY this exception: a PlatformException from a real device is a real
      // fault and must propagate loudly, not be reclassified as 「无法询问」
      // ("cannot be asked").
      //
      // ⚠️ MEASURED 2026-08-04, so nobody re-derives it from the enum's doc:
      // this catch does NOT cover the Dart test VM. A plain `test()` has no
      // `TestWidgetsFlutterBinding`, so the failure happens BEFORE any channel
      // call — `ServicesBinding.instance` throws 「Binding has not yet been
      // initialized」, which is not a MissingPluginException and is not caught
      // here on purpose (a binding that does not exist is not a permission
      // answer). Test fixtures inject fakes instead.
      return OsPermissionProbe.unavailable;
    }
  }

  @override
  Future<OsPermissionProbe> request() async {
    try {
      return _map(await permission.request());
    } on MissingPluginException {
      return OsPermissionProbe.unavailable;
    }
  }

  @override
  Future<void> openSettings() async {
    // permission_handler's top-level openAppSettings() — Android: the app's
    // details page (where the per-permission toggles live); iOS: the app's
    // Settings pane.
    await ph.openAppSettings();
  }

  static OsPermissionProbe _map(ph.PermissionStatus s) {
    // `limited` / `provisional` are photo/notification concepts that cannot
    // apply to the microphone or the camera, but the enum carries them for
    // every permission — and both mean 「拿到了一部分权限」("some access was
    // granted"), so folding them into granted is the truthful side.
    if (s.isGranted || s.isLimited || s.isProvisional) {
      return OsPermissionProbe.granted;
    }
    // iOS `restricted` (MDM / parental controls): the OS dialog will never be
    // shown, exactly like permanently-denied — and the settings screen is the
    // only place anything can change. Mapping it to `denied` instead would
    // re-fire a request that structurally cannot succeed.
    if (s.isPermanentlyDenied || s.isRestricted) {
      return OsPermissionProbe.permanentlyDenied;
    }
    return OsPermissionProbe.denied;
  }
}
