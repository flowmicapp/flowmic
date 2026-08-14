// SPEC-REF:
//   apps/mobile/android/app/src/main/kotlin/app/flowmic/android/UpdateInstaller.kt
//     (the other half. Method names, parameter names, and result strings on
//     both sides must match verbatim)
//   apps/mobile/lib/src/session/image_clipboard.dart (this file copies its
//     seam: `ImageClipboardPort` + `MethodChannelImageClipboard`)
//   apps/mobile/lib/src/update/update_download.dart (where the file it hands
//     off for install comes from —
//     🔴 it can ONLY come from `UpdateDownloadResult.file`, and that field
//     is non-null only when verified)
//   CLAUDE.md red line: no silent failure
//
// ── THE ONE QUESTION THIS LAYER ANSWERS ─────────────────────────────────
//
// 「**has the already-verified install package been handed off to the
// system installer; if it wasn't handed off, where did it get stuck**」.
//
// 🔴 **It does not install anything itself.** There is no 「silent install」
// path on Android (that would need a system signature or device-owner
// status); all it can do is hand a `content://` URI to the system's package
// installer via `ACTION_VIEW`, and then the **user** confirms it in a system
// dialog. So this module's best possible outcome is called
// [UpdateInstallOutcome.handedToInstaller] — 「handed off to it」, **NOT
// 「installed」**. Calling it 「installed」 would be claiming something got
// done when it didn't (the red line's second direction).
//
// ── WHY 「PERMISSION NOT GRANTED」 MUST BE ITS OWN CELL ────────────────────
//
// API 26+'s `REQUEST_INSTALL_PACKAGES` is a **user-toggled** runtime grant
// (`canRequestPackageInstalls()`). It is the **ONE failure on this whole
// path the user can fix themselves** — folding it into a generic 「install
// failed」 sentence would turn a solvable problem into an unsolvable one.
// ⇒ It gets its own cell, its own sentence, and the Kotlin side
// **incidentally takes the user straight to that settings page**.

import 'package:flutter/services.dart';

/// One conclusion of 「handed off to the system installer」. **A closed
/// set** — the UI must give each entry its own four-language copy.
enum UpdateInstallOutcome {
  /// The system's package installer has accepted this URI; next the user
  /// taps 「Install」 in the system dialog.
  /// 🔴 **It does NOT mean 「installed」** — the copy must never say that.
  handedToInstaller,

  /// 「Allow installing apps from unknown sources」 has not been granted
  /// yet. **The user has already been taken to that settings page** —
  /// after granting it, coming back and pressing again is all it takes.
  /// This is the ONE failure the user can fix themselves.
  permissionRequired,

  /// The system refused this request (FileProvider misconfigured / no
  /// component can handle this intent / the file vanished before it could be
  /// handed off). The path left to the user is to manually install from the
  /// download URL shown in the UI.
  refused,

  /// This platform has no such channel wired at all (`MissingPluginException`).
  /// **Kept separate from [refused]**: one is 「the system said no」, the
  /// other is 「this build of ours has no such path」.
  unsupportedPlatform,
}

class UpdateInstallResult {
  const UpdateInstallResult(this.outcome, {this.detail});
  final UpdateInstallOutcome outcome;

  /// The platform's own words. **Never shown on screen by itself**, only as
  /// diagnostic supplement.
  final String? detail;
}

/// The platform seam. Production is [MethodChannelUpdateInstaller]; tests
/// pass a fake.
abstract class UpdateInstallerPort {
  /// Hand [apkPath] to the system's package installer.
  ///
  /// Returns the Kotlin side's result string (see [kInstallHandedOff] /
  /// [kInstallPermissionRequired]); throws `PlatformException` on refusal.
  ///
  /// ⚠️ **Must not swallow a refusal into a successful null** — a channel
  /// that did nothing and a successful hand-off would look identical on
  /// screen, and that is exactly the failure this whole feature exists to
  /// eliminate.
  Future<String?> installApk(String apkPath);
}

/// The two strings the Kotlin side's `result.success(...)` can return.
/// **Both sides must match verbatim**.
const String kInstallHandedOff = 'handed_off';
const String kInstallPermissionRequired = 'permission_required';

class MethodChannelUpdateInstaller implements UpdateInstallerPort {
  const MethodChannelUpdateInstaller();

  /// Must spell identically to `UpdateInstaller.CHANNEL` (Kotlin side).
  static const MethodChannel channel = MethodChannel(
    'app.flowmic/update_installer',
  );

  @override
  Future<String?> installApk(String apkPath) =>
      channel.invokeMethod<String>('installApk', <String, Object?>{
        'path': apkPath,
      });
}

/// Hands [apkPath] off, and states clearly what happened.
///
/// 🔴 This function **never throws**. Every path lands on some cell of
/// [UpdateInstallOutcome].
///
/// ⚠️ The caller's obligation (the one thing the type system cannot enforce
/// for it): [apkPath] can **ONLY** come from an `UpdateDownloadResult.file`
/// whose `outcome == verified`. Unverified bytes must never reach this
/// point.
Future<UpdateInstallResult> handOffToInstaller(
  String apkPath, {
  UpdateInstallerPort port = const MethodChannelUpdateInstaller(),
}) async {
  try {
    final String? answer = await port.installApk(apkPath);
    switch (answer) {
      case kInstallHandedOff:
        return const UpdateInstallResult(UpdateInstallOutcome.handedToInstaller);
      case kInstallPermissionRequired:
        return const UpdateInstallResult(UpdateInstallOutcome.permissionRequired);
      default:
        // An answer we don't recognise. **Must not be treated as success**
        // — that is exactly 「an unknown value posing as an affirmative
        // answer」.
        return UpdateInstallResult(
          UpdateInstallOutcome.refused,
          detail: 'unknown_answer:$answer',
        );
    }
  } on MissingPluginException catch (e) {
    return UpdateInstallResult(
      UpdateInstallOutcome.unsupportedPlatform,
      detail: e.message,
    );
  } on PlatformException catch (e) {
    return UpdateInstallResult(
      UpdateInstallOutcome.refused,
      detail: '${e.code}:${e.message}',
    );
  } on Object catch (e) {
    return UpdateInstallResult(UpdateInstallOutcome.refused, detail: '$e');
  }
}
