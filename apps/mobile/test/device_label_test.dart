// owner 2026-07-27:「获取手机型号再结合唯一码来作为名称，这样从名称就可以区分手机
// 是哪一台」.
//
// The old name was `Phone-<4-digit pairing code>`, and the 4 hex came from the PAIRING uuid —
// so the same handset got a different name every time it re-paired, which is
// every APK reinstall. The one job the name had, it could not do.
//
// What is asserted here is the two properties that make the new name useful,
// plus the one that keeps it safe:
//   ① STABLE for one device across re-pairs (same seed → same suffix);
//   ② DIFFERENT for two devices (different seed → different suffix);
//   ③ the raw ANDROID_ID never appears in the label — only a hash of it.
//
// SPEC-REF: apps/mobile/lib/src/session/device_label.dart;
//   packages/protocol/src/protocol-schemas-auth.ts (mobile_name ≤48, optional).

import 'package:flowmic/src/session/device_label.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('the label tells two handsets apart', () {
    test('brand+model+fingerprint, e.g. Google Pixel 8-xxxx', () {
      final String label = buildDeviceLabel(const DeviceIdentity(
        manufacturer: 'Google', model: 'Pixel 8', seed: 'a1b2c3d4e5f60718',
      ));
      expect(label, startsWith('Google Pixel 8-'));
      expect(label.split('-').last, hasLength(kDeviceFingerprintLen));
    });

    test('① the SAME device is named the same across re-pairs', () {
      const DeviceIdentity id = DeviceIdentity(
        manufacturer: 'Lenovo', model: 'TB335ZC', seed: 'stable-android-id',
      );
      expect(buildDeviceLabel(id), buildDeviceLabel(id));
      // …which is the fix: the old suffix came from the pairing uuid and so
      // changed on every re-pair.
    });

    test('② two devices of the SAME model still differ', () {
      final String a = buildDeviceLabel(const DeviceIdentity(model: 'Pixel 8', seed: 'phone-a'));
      final String b = buildDeviceLabel(const DeviceIdentity(model: 'Pixel 8', seed: 'phone-b'));
      expect(a, isNot(b));
      expect(a, startsWith('Pixel 8-'));
      expect(b, startsWith('Pixel 8-'));
    });

    test('③ the ANDROID_ID itself never reaches the label', () {
      const String secret = '9f8e7d6c5b4a3210';
      final String label = buildDeviceLabel(const DeviceIdentity(model: 'X', seed: secret));
      expect(label.contains(secret), isFalse);
      // Not even a prefix of it — the suffix is a hash, not a truncation.
      expect(label.contains(secret.substring(0, 4)), isFalse);
    });
  });

  group('the brand is not repeated, and junk is cleaned', () {
    test('brand is prepended only when the model lacks it', () {
      expect(cleanModel('Google', 'Pixel 8'), 'Google Pixel 8');
      expect(cleanModel('Xiaomi', 'Xiaomi 13'), 'Xiaomi 13');
      expect(cleanModel('samsung', 'SAMSUNG SM-S911B'), 'SAMSUNG SM-S911B');
    });

    test('control characters and runs of whitespace collapse', () {
      expect(cleanModel(null, 'SM-S911B   Ultra'), 'SM- S911B Ultra');
      expect(cleanModel('', '   '), isNull);
      expect(cleanModel(null, null), isNull);
    });
  });

  group('it degrades instead of failing', () {
    test('no model, no seed → 「Phone」 (the server then adds its own suffix)', () {
      expect(buildDeviceLabel(const DeviceIdentity()), 'Phone');
    });

    test('a model with no seed keeps the model', () {
      expect(buildDeviceLabel(const DeviceIdentity(model: 'Pixel 8')), 'Pixel 8');
    });

    test('a seed with no model still discriminates', () {
      final String label = buildDeviceLabel(const DeviceIdentity(seed: 'only-a-seed'));
      expect(label, startsWith('Phone-'));
    });
  });

  test('never exceeds the protocol cap, and trims the MODEL not the suffix', () {
    final String label = buildDeviceLabel(DeviceIdentity(
      manufacturer: 'OEM', model: 'M' * 200, seed: 'seed',
    ));
    expect(label.length, lessThanOrEqualTo(kDeviceLabelMax));
    // The fingerprint survives intact — truncating it would destroy the very
    // uniqueness the suffix exists to provide.
    expect(label.split('-').last, hasLength(kDeviceFingerprintLen));
    expect(label.split('-').last, deviceFingerprint('seed'));
  });

  test('the fingerprint is 4 lowercase hex, deterministic', () {
    final String fp = deviceFingerprint('abc');
    expect(fp, matches(RegExp(r'^[0-9a-f]{4}$')));
    expect(fp, deviceFingerprint('abc'));
    expect(deviceFingerprint(''), '');
    expect(deviceFingerprint(null), '');
  });
}
