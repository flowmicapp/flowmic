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
