// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §8 (first-PTT microphone permission, F-2063)
//   card U2 — see mic_permission.dart for the whole argument.
//
// The production [MicPermissionPort]: `permission_handler` (pubspec pins
// ^11.3.1; lockfile resolves 11.4.0). That package was ALREADY the app's
// permission dependency (audio_capture.dart's legacy in-capture request rides
// it), and its top-level `openAppSettings()` is the 「去设置开启」 ("go to
// Settings and turn it on") call the repo
// never made — so U2 adds NO new dependency.
//
// Every DECISION lives in mic_permission.dart against the closed
// [MicPermissionProbe] vocabulary; this adapter only translates. The one
// translation that is policy rather than mechanics is documented on `_map`.

import 'package:flutter/services.dart' show MissingPluginException;
import 'package:permission_handler/permission_handler.dart' as ph;

import 'mic_permission.dart';

class PlatformMicPermission implements MicPermissionPort {
  const PlatformMicPermission();

  @override
  Future<MicPermissionProbe> status() async {
    try {
      return _map(await ph.Permission.microphone.status);
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
      // answer). Test fixtures inject `newTestMicPermission()` instead; see
      // test/support/mic_permission_fakes.dart.
      return MicPermissionProbe.unavailable;
    }
  }

  @override
  Future<MicPermissionProbe> request() async {
    try {
      return _map(await ph.Permission.microphone.request());
    } on MissingPluginException {
      return MicPermissionProbe.unavailable;
    }
  }

  @override
  Future<void> openSettings() async {
    // permission_handler's top-level openAppSettings() — Android: the app's
    // details page (where the mic toggle lives); iOS: the app's Settings pane.
    await ph.openAppSettings();
  }

  static MicPermissionProbe _map(ph.PermissionStatus s) {
    // `limited` / `provisional` are photo/notification concepts that cannot
    // apply to the microphone, but the enum carries them — and both mean 「some
    // access was granted」, so folding them into granted is the truthful side.
    if (s.isGranted || s.isLimited || s.isProvisional) {
      return MicPermissionProbe.granted;
    }
    // iOS `restricted` (MDM / parental controls): the OS dialog will never be
    // shown, exactly like permanently-denied — and the settings screen is the
    // only place anything can change. Mapping it to `denied` instead would
    // re-fire a request that structurally cannot succeed.
    if (s.isPermanentlyDenied || s.isRestricted) {
      return MicPermissionProbe.permanentlyDenied;
    }
    return MicPermissionProbe.denied;
  }
}
