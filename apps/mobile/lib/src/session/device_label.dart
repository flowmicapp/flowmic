// SPEC-REF:
//   packages/protocol/src/protocol-schemas-auth.ts (MobilePairSchema.mobile_name
//     — additive, optional, ≤48)
//   apps/server-core/src/room/registry.ts (a caller-supplied name wins over the
//     `Phone-<4>` fallback)
//
// owner 2026-07-27: 「手机端是否能够获取手机型号再结合唯一码来作为名称，这样从名称
// 就可以区分手机是哪一台」 ("can the phone side get the phone model and combine it
// with a unique code to use as the name, so that the name alone can tell you
// which phone this is").
//
// Every phone used to pair as `Phone-<4-digit pairing code>`, where the 4 hex came from the
// PAIRING uuid — so the same physical phone got a DIFFERENT name every time it
// re-paired (which is every APK reinstall, since that wipes the stored token).
// The one thing the name had to do — tell you which handset this is — was the
// one thing it could not do.
//
// The label is 「型号-<4 位设备指纹>」 ("model-<4-digit device fingerprint>"), e.g. `Pixel 8-3f2a`, `TB335ZC-91c4`.
//
// THE SUFFIX IS A HASH, DELIBERATELY. The seed is ANDROID_ID, which is a real
// device identifier: stable across reinstalls (that is the point) but also
// exactly the sort of value that should not travel. Only 16 bits of a hash of it
// leave the phone, which is plenty to tell two handsets apart in a list of two
// and useless as an identifier anywhere else.
//
// Pure and platform-free so the naming rules are unit-tested without a device;
// platform_device_info.dart is the only file that touches the channel.

/// Hard cap, mirroring MobilePairSchema's `.max(48)`. The model half is trimmed
/// rather than the suffix — the suffix is what makes the name unique.
const int kDeviceLabelMax = 48;

/// Length of the fingerprint suffix, in hex characters.
const int kDeviceFingerprintLen = 4;

/// What the platform can tell us about this handset. Any field may be missing —
/// an OEM that reports nothing must still produce a usable name.
class DeviceIdentity {
  const DeviceIdentity({this.manufacturer, this.model, this.seed});

  final String? manufacturer;
  final String? model;

  /// Stable per-device value (Android: Settings.Secure.ANDROID_ID). NEVER sent
  /// anywhere — only [deviceFingerprint] of it is.
  final String? seed;
}

/// FNV-1a (32-bit), truncated to [kDeviceFingerprintLen] hex chars.
///
/// A non-cryptographic hash is the right tool: this is a display discriminator,
/// not a security boundary, and the property that matters is that it is stable
/// and cheap. It is one-way enough that the ANDROID_ID does not travel, which is
/// the only privacy claim made for it.
String deviceFingerprint(String? seed) {
  final String s = (seed ?? '').trim();
  if (s.isEmpty) return '';
  return _fnv1a32Hex(s).substring(0, kDeviceFingerprintLen);
}

/// FNV-1a (32-bit) of [s] as 8 lowercase hex characters.
int _fnv1a32(String s) {
  int hash = 0x811c9dc5;
  for (final int c in s.codeUnits) {
    hash ^= c;
    // 32-bit FNV prime multiply, masked back to 32 bits each step so Dart's
    // 64-bit ints cannot drift from the canonical result.
    hash = (hash * 0x01000193) & 0xFFFFFFFF;
  }
  return hash;
}

String _fnv1a32Hex(String s) => _fnv1a32(s).toRadixString(16).padLeft(8, '0');

// ── v0.2.4: 「是不是同一台手机」 ("is this the same phone") ─────────────────
//
// owner 2026-07-29: 「手机在外部网络是通过云端中继来访问，如外出办公，在内网环境使
// 用本地局域网环境，但应能明确知道是否都是同一台手机和同一台 PC」 ("when the phone
// is on an external network it connects through the cloud relay — e.g. working
// away from the office — and on an internal network it uses the local LAN; either
// way it should be possible to clearly know whether this is the same phone and
// the same PC").
//
// The 4-hex suffix above is a DISPLAY discriminator — 16 bits is plenty to tell
// two phones apart in a list of two, and far too few to key a database lookup
// on. v0.2.3 nonetheless had to reuse the whole NAME as the server's
// 「这台手机回来了」 ("this phone is back") key, because it was the only stable thing a phone sent.
// That works, but it welds two jobs together: a name is for people to read and
// may legitimately change, while a match key must not.
//
// [deviceUid] is the key, and only the key. Same seed (ANDROID_ID), same rule —
// the raw value never leaves the phone — at 64 bits instead of 16.
//
// Built from TWO domain-separated FNV-1a 32s rather than one 64-bit hash: Dart's
// int is 64-bit two's complement, so a genuine FNV-1a-64 would go negative and
// `toRadixString(16)` would emit a minus sign. Two masked 32-bit halves have no
// such edge, and they reuse the routine the 4-hex suffix has been using since
// 0.1.10.
const int kDeviceUidPrefix = 3; // 'mb-'

/// This handset's cross-channel identity, or `null` when the platform gave us
/// no device id to derive it from.
///
/// `null` is deliberate and is NOT downgraded to a placeholder: this value
/// decides whether the server treats two pairings as one phone, and a constant
/// fallback would be identical on every phone that also reported nothing —
/// merging strangers into one row. With null the server simply falls back to
/// matching on the name, which is exactly the 0.2.3 behaviour.
String? deviceUid(String? seed) {
  final String s = (seed ?? '').trim();
  if (s.isEmpty) return null;
  // `mb-` mirrors the desktop's `pc-` (pc_name.rs) and satisfies the protocol's
  // DeviceUid shape /^[a-z]{2}-[0-9a-f]{16,48}$/. The two prefixes mean a phone
  // uid and a PC uid can never be confused, even by accident in a log grep.
  return 'mb-${_fnv1a32Hex('flowmic-uid-a|$s')}${_fnv1a32Hex('flowmic-uid-b|$s')}';
}

/// Collapse an OEM model string into something safe to show and store.
///
/// Real `Build.MODEL` values include spaces, plus signs and the odd control
/// character; some OEMs repeat the brand ("Xiaomi Xiaomi 13"). Empty after
/// cleaning ⇒ null, and the caller falls back to 「Phone」.
String? cleanModel(String? manufacturer, String? model) {
  String m = (model ?? '').replaceAll(RegExp(r'[\x00-\x1F\x7F]'), ' ').trim();
  m = m.replaceAll(RegExp(r'\s+'), ' ');
  final String brand = (manufacturer ?? '').trim();
  // Prepend the brand when the model does not already carry it: a bare
  // 「SM-S911B」 or 「TB335ZC」 identifies nothing to a human, and the brand is the
  // half people actually recognise. Skipped when the model already includes it,
  // because 「Xiaomi Xiaomi 13」 is just wrong.
  if (brand.isNotEmpty && m.isNotEmpty && !m.toLowerCase().contains(brand.toLowerCase())) {
    m = '$brand $m';
  }
  if (m.isEmpty) m = brand;
  return m.isEmpty ? null : m;
}

/// Build the wire name. Never returns empty: with nothing at all to work from
/// this yields 「Phone」 and the SERVER then appends its own `-<4>` fallback, so
/// the pre-0.1.10 behaviour is exactly what an unknown device still gets.
String buildDeviceLabel(DeviceIdentity id) {
  final String? model = cleanModel(id.manufacturer, id.model);
  final String fp = deviceFingerprint(id.seed);
  if (model == null && fp.isEmpty) return 'Phone';
  if (fp.isEmpty) return _cap(model!, kDeviceLabelMax);
  final String base = model ?? 'Phone';
  // Trim the MODEL, never the fingerprint: a truncated suffix stops being
  // unique, which is the whole reason the suffix exists.
  final int room = kDeviceLabelMax - fp.length - 1;
  return '${_cap(base, room)}-$fp';
}

String _cap(String s, int max) => s.length <= max ? s : s.substring(0, max).trimRight();
