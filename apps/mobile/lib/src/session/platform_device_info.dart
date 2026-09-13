// The ONLY file that talks to the device-info channel. Everything else uses
// [DeviceIdentity] / [buildDeviceLabel] from device_label.dart, which is what
// keeps the naming rules testable without a handset.
//
// owner 2026-07-27, phone naming. A platform that answers nothing is not a failure:
// the label falls back to 「Phone」 and the SERVER appends its own `-<4>`, i.e.
// exactly the pre-0.1.10 behaviour. Naming is cosmetic — it must never be able
// to block a pairing.

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../portable/platform_portable.dart';
import '../portable/portable_ports.dart';

import 'device_label.dart';

/// The platform seam; tests pass a fake.
typedef DeviceIdentityReader = Future<DeviceIdentity> Function();

class MethodChannelDeviceInfo {
  const MethodChannelDeviceInfo();

  /// Must match `DeviceInfo.CHANNEL` on the Kotlin side.
  ///
  /// 🔴 P0-PKG: namespace owned by `scripts/package-ids.mjs`
  /// (`METHOD_CHANNEL_NAMESPACE`). Dart cannot import an .mjs, so two machines
  /// hold this mirror: `verify/lint/package-id-family.mjs` compares both
  /// language sides, and `test/method_channel_namespace_mirror_test.dart` reads
  /// the SSOT file as text from `flutter test`.
  static const MethodChannel channel = MethodChannel('app.flowmic/device_info');

  Future<DeviceIdentity> read() async {
    try {
      final Map<Object?, Object?>? m =
          await channel.invokeMapMethod<Object?, Object?>('identity');
      if (m == null) return const DeviceIdentity();
      return DeviceIdentity(
        manufacturer: m['manufacturer'] as String?,
        model: m['model'] as String?,
        seed: m['seed'] as String?,
      );
    } on Object catch (e) {
      // Missing channel (a platform we have not wired), or an OEM that threw.
      //
      // ⚠️ 0.3.28 — "a platform we have not wired" was, until this round, **the
      // normal case on iOS**: there was no Swift handler, so every iPhone took
      // this branch at app start and paired as a nameless `Phone`. The
      // degradation was right; what was missing was the thing to degrade FROM
      // (`ios/Runner/DeviceInfo.swift`, and its entry in project.pbxproj —
      // both pinned by `verify/lint/package-id-family.mjs`).
      // 🔴 That is worth leaving written down: this catch was doing its job
      // perfectly and the feature was absent, so nothing anywhere went red. A
      // correct fallback is not evidence that the thing it falls back from
      // exists.
      debugPrint('[flowmic.device] identity unavailable: $e');
      return const DeviceIdentity();
    }
  }
}

/// Resolved once per process — the model and the device id cannot change while
/// the app is running.
String? _cached;

/// v0.2.4 — the machine-level uid, resolved from the SAME read as the label so
/// the two can never disagree about which handset this is.
String? _cachedUid;

/// The name this phone pairs under. Never throws, never empty.
///
/// Call this to WARM the cache (app start). The pairing path deliberately does
/// not await it — see [cachedDeviceLabel].
Future<String> deviceLabel({DeviceIdentityReader? reader}) async {
  final String? hit = _cached;
  if (hit != null) return hit;
  final DeviceIdentity id =
      await (reader ?? const MethodChannelDeviceInfo().read)();
  // ONE read fills BOTH caches. Two reads could in principle disagree (an OEM
  // that answers the second call differently), and 「the name says one handset,
  // the uid says another」 is the one inconsistency this pair must not have.
  _cachedUid = deviceUid(id.seed);
  return _cached = buildDeviceLabel(id);
}

/// The resolved [deviceUid], or null when it has not been read yet OR the
/// platform had no device id. The pairing path uses this synchronously for the
/// same reason as [cachedDeviceLabel] — identity is not worth inserting a
/// platform round-trip into pairing, and a null simply omits the field.
String? cachedDeviceUid() => _cachedUid;

/// The resolved label, or null when it has not been read yet.
///
/// The pairing path uses THIS, synchronously, on purpose: naming is cosmetic and
/// must never insert a platform round-trip — or a new async ordering — into
/// pairing. A null simply omits `mobile_name` and the server mints its own
/// `Phone-<4>`, which is exactly the pre-0.1.10 behaviour.
String? cachedDeviceLabel() => _cached;

/// Test seam — no production caller (the cache is process-lifetime by design).
@visibleForTesting
void resetDeviceLabelCache() {
  _cached = null;
  _cachedUid = null;
}

// ── card S2-01 · WHAT THIS END IS, beside what the handset is ───────────
//
// FLOWMIC-WEB is a third end — a browser page that pairs over the very same
// `mobile:pair` — and until this card nothing on the wire could tell it apart
// from this app. `client: 'app'` is this build stating what it is; the relay's
// default for an absent field is the same value, so an older phone and this one
// are indistinguishable in effect, which is what makes the field safe to add.
//
// It lives in THIS file rather than one of its own because it is the same shape
// as everything above: a platform-read fact about this end, warmed once at boot,
// read SYNCHRONOUSLY at pairing so no round-trip lands in front of the user's
// pairing tap. Two modules with one discipline drift apart; one does not.
//
// 🔴 THE VERSION IS DIAGNOSTIC AND NOTHING MAY BRANCH ON IT. It is a claim the
// client makes about itself, so a decision taken on it is a decision taken on
// text the client chose. It exists so a support conversation can start from a
// fact instead of a question.

/// The `client` value this build sends. A constant, not a setting: a phone that
/// could describe itself as something else would be describing a build it is not.
const String kClientKind = 'app';

/// Resolved once per process — the version cannot change while the app runs.
String? _cachedVersion;

/// Warm the cache (app start), exactly as [deviceLabel] does for the name.
///
/// Awaited at boot for the same reason that one is: the pairing path reads it
/// SYNCHRONOUSLY, because a diagnostic string must never insert a platform
/// round-trip — or a new async ordering — in front of the user's pairing tap.
/// A null simply omits the field, which is byte-for-byte what a pre-S2-01 build
/// sends.
Future<String?> warmClientVersion({AppVersionPort? port}) async {
  final String? hit = _cachedVersion;
  if (hit != null) return hit;
  final String? v = await (port ?? const PackageAppVersion()).appVersion();
  final String trimmed = (v ?? '').trim();
  return _cachedVersion = trimmed.isEmpty ? null : trimmed;
}

/// The resolved version, or null when it has not been read yet or the platform
/// could not answer. Never an empty string and never a placeholder: 「we do not
/// know which version this is」 and 「this is version ''」 are different facts, and
/// only the first one is true here.
String? cachedClientVersion() => _cachedVersion;

/// Test seam — no production caller (the cache is process-lifetime by design).
@visibleForTesting
void resetClientVersionCache() {
  _cachedVersion = null;
}
