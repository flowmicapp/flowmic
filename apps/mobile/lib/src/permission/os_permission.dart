// The OS-permission VOCABULARY, shared by every permission this app asks for.
//
// SPEC-REF:
//   card U2 (microphone) — ptt/mic_permission.dart holds the whole argument for
//     the explain-then-request-then-settings shape this vocabulary serves.
//   card CAM-1 (camera, 2026-08-25) — the reason this file exists.
//
// ── WHY THIS IS EXTRACTED RATHER THAN COPIED ────────────────────────────────
//
// The camera needed exactly what U2 built for the microphone: a closed
// four-state reading of the OS, a port so decisions are testable without a
// device, and a device-local 「已经问过一次了吗」("have we asked once already")
// flag. Copying that vocabulary would have produced a second enum answering the
// same question — 「操作系统怎么说」("what does the OS say") — which is this
// repo's headline bug shape, and the two copies would drift the first time one
// of them learned a new state.
//
// So the VOCABULARY moved here and `MicPermissionProbe` / `MicPermissionPort` /
// `MicAskedStore` became type aliases onto it. That is deliberate: the mic
// flow, its faces and all of its tests keep compiling untouched, and there is
// still exactly one enum in the codebase that answers this question.
//
// 🔴 WHAT DID **NOT** MOVE, AND WHY. The FACES stay per-surface
// (`MicFlowFace`, `ScanPermissionFace`). What a talk bar must render and what a
// scanner pane must render are different questions with different answers — the
// scanner has a manual-entry fallback and the talk bar has a capture-start
// failure, and neither belongs in the other. One vocabulary, several faces.

import 'package:shared_preferences/shared_preferences.dart';

/// What the OS says about ONE permission right now. A closed vocabulary rather
/// than the plugin's `PermissionStatus`, so no decision layer can grow a
/// dependency on plugin enum details (and a fake port cannot half-agree).
enum OsPermissionProbe {
  granted,

  /// Refused, but the OS would still show a dialog if asked again.
  denied,

  /// The OS will never show the dialog again (Android "don't ask again" /
  /// second refusal, iOS Settings toggle off, iOS `restricted`). The ONLY way
  /// out is the system settings screen — which is why this value exists as its
  /// own word: it changes what the action button must do.
  permanentlyDenied,

  /// The platform could not be asked at all (a host whose plugin registry has
  /// no permission_handler). NOT a friendly default: each caller decides what
  /// its own surface does with 「问不出来」("could not be asked"), and none of
  /// them may render it as a refusal — that would be a status word whose
  /// evidence does not support it.
  ///
  /// ⚠️ This is NOT how the Dart test VM arrives: with no binding the platform
  /// call throws before any channel work and is deliberately not caught (see
  /// platform_permission.dart). Fixtures inject a fake port.
  unavailable,
}

/// The seam to the OS permission machinery. Production:
/// `PlatformOsPermission` (platform_permission.dart). Tests: a fake.
///
/// 🔴 The default a composition root gets is the REAL thing, never a friendly
/// no-op (13 册 §7 F1 ②): a permission port that always answers `granted`
/// turns every refusal into a silent success.
abstract class OsPermissionPort {
  /// Read-only probe — MUST NOT show any OS UI.
  ///
  /// This is what makes 「先解释、后请求」("explain first, request second")
  /// structural rather than a habit: a surface can find out where it stands
  /// without the OS dialog appearing under the user's thumb.
  Future<OsPermissionProbe> status();

  /// May show the OS permission dialog. When already permanently denied the OS
  /// shows nothing and this resolves immediately — flows rely on that to flip
  /// to the permanently-denied face with its settings action.
  Future<OsPermissionProbe> request();

  /// Open the app's page in system settings — the 「去设置开启」("go to Settings
  /// to enable it") way out, and the only way out of permanently-denied.
  Future<void> openSettings();
}

/// Device-local 「已经问过一次了吗」("have we already asked once"). Decides
/// rationale-vs-denied wording only — it is NOT a permission cache (the OS
/// stays the single source of truth for granted/denied). Deliberately OUTSIDE
/// the settings-sync store, same ruling and same mechanism as local_prefs.dart:
/// phone-local, never synced, no server-side reader.
abstract class AskedOnceStore {
  Future<bool> askedBefore();
  Future<void> markAsked();
}

/// The persisted flag, one key per permission.
///
/// 「asked」 is stamped BEFORE the OS dialog resolves, so a dialog killed by the
/// OS mid-flight still counts as asked — the user saw it, and re-explaining
/// would be the second explain that U2 forbids.
class SharedPrefsAskedOnceStore implements AskedOnceStore {
  const SharedPrefsAskedOnceStore(this.key);

  /// 🔴 One key per permission, passed in rather than derived from a name.
  /// A shared key would make granting the microphone silence the camera's
  /// rationale — two facts collapsed onto one bit.
  final String key;

  @override
  Future<bool> askedBefore() async =>
      (await SharedPreferences.getInstance()).getBool(key) ?? false;

  @override
  Future<void> markAsked() async {
    await (await SharedPreferences.getInstance()).setBool(key, true);
  }
}

class InMemoryAskedOnceStore implements AskedOnceStore {
  InMemoryAskedOnceStore({bool asked = false}) : _asked = asked;
  bool _asked;

  @override
  Future<bool> askedBefore() async => _asked;

  @override
  Future<void> markAsked() async => _asked = true;
}
