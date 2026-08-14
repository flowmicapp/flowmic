// P0-PKG (2026-08-12) — **cross-language mirror guard** for the MethodChannel
// namespace: the three channel names Dart opens must be the three names
// `scripts/package-ids.mjs` declares, character for character.
//
// 🔴 WHY A MACHINE HAS TO HOLD THIS. A MethodChannel name is a string agreed on
// by two languages that cannot see each other. Dart cannot import an .mjs and
// Kotlin cannot either, so "both ends read the same list" is a wish until something checks
// it. And the failure it prevents is not a degraded feature: a name that matches
// on only one side means the platform handler is never registered for the name
// Dart calls, `invokeMethod` raises MissingPluginException, and on
// `device_info` that happens while the app is starting. The unit suite cannot
// see it — every test here replaces the channel with a fake, which is precisely
// the layer the bug lives in (CLAUDE.md, 0.2.35: 「当一个 bug 活在测试替身替掉的
// 那一层里，它对整个测试套件不可见」).
//
// ⚠️ WHAT THIS FILE CANNOT SEE, stated rather than implied: it reads the DART
// side only. The Kotlin side is compared against the same SSOT by
// `verify/lint/package-id-family.mjs`, which reads all three literals out of
// `DeviceInfo.kt` / `ImageClipboard.kt` / `UpdateInstaller.kt`. Two halves, two
// mechanisms — do not widen this header into a claim that this test proves the
// channel is wired end to end. Only a cold start on a real handset proves that.
//
// The technique is not new here: `restriction_reason_copy_mirror_test.dart`
// reads a `.ts` the same way and says why.
//
// SPEC-REF:
//   scripts/package-ids.mjs (the single source)
//   docs/strategy/2026-08-12-p0-app-flowmic-package-id-migration.md §6.2

import 'dart:io';

import 'package:flowmic/src/session/image_clipboard.dart';
import 'package:flowmic/src/session/platform_device_info.dart';
import 'package:flowmic/src/update/update_installer.dart';
import 'package:flutter_test/flutter_test.dart';

/// `flutter test` runs with this package's root as its working directory.
final File _ssot = File('../../scripts/package-ids.mjs');

/// `  deviceInfo: \`app.flowmic/device_info\`,` — the entries of
/// `METHOD_CHANNELS`, whose values are template literals built from the
/// namespace constant. Matching the assembled literal would be matching our own
/// assumption, so the key and the interpolation are read separately below.
final RegExp _channelEntry =
    RegExp(r'^  (\w+): `\$\{METHOD_CHANNEL_NAMESPACE\}/(\w+)`,$', multiLine: true);

final RegExp _namespace =
    RegExp(r"^export const METHOD_CHANNEL_NAMESPACE = '([^']+)';$", multiLine: true);

String _ssotText() {
  // A guard that passes when it cannot find its source is not a guard.
  expect(
    _ssot.existsSync(),
    isTrue,
    reason: 'package-id SSOT not found at ${_ssot.path} '
        '(working directory should be apps/mobile)',
  );
  return _ssot.readAsStringSync();
}

void main() {
  group('MethodChannel namespace mirrors scripts/package-ids.mjs', () {
    test('the parser is not blind (positive control)', () {
      // 🔴 THIS RUNS FIRST ON PURPOSE. Every assertion below reads a value out
      // of the SSOT and compares it to Dart. A regex that matched nothing would
      // make them compare null to null, or skip entirely — green, and blind.
      final String src = _ssotText();
      expect(
        _namespace.firstMatch(src),
        isNotNull,
        reason: 'could not find METHOD_CHANNEL_NAMESPACE in the SSOT — the '
            'parser drifted from the file it reads, which is not the same as '
            'the file being correct',
      );
      expect(
        _channelEntry.allMatches(src).map((RegExpMatch m) => m.group(1)).toSet(),
        <String>{'deviceInfo', 'imageClipboard', 'updateInstaller'},
        reason: 'the SSOT must declare exactly these three channels; a new one '
            'that nothing here knows about is the drift this file exists for',
      );
    });

    test('every Dart channel name is the SSOT namespace + the SSOT suffix', () {
      final String src = _ssotText();
      final String ns = _namespace.firstMatch(src)!.group(1)!;
      final Map<String, String> suffixes = <String, String>{
        for (final RegExpMatch m in _channelEntry.allMatches(src))
          m.group(1)!: m.group(2)!,
      };

      final Map<String, String> dart = <String, String>{
        'deviceInfo': MethodChannelDeviceInfo.channel.name,
        'imageClipboard': MethodChannelImageClipboard.channel.name,
        'updateInstaller': MethodChannelUpdateInstaller.channel.name,
      };

      for (final MapEntry<String, String> e in dart.entries) {
        expect(
          e.value,
          '$ns/${suffixes[e.key]}',
          reason: 'Dart opens ${e.value} for ${e.key}, but the SSOT says '
              '$ns/${suffixes[e.key]}. Kotlin follows the SSOT, so this side '
              'would call a name nothing answers to.',
        );
      }
    });

    test('no Dart channel still carries the retired namespace', () {
      // Named separately from the equality above because it answers a different
      // question: the equality could be satisfied by a future edit that changed
      // BOTH the SSOT and Dart back to the old family. This one says the old
      // family is retired, full stop — the anti-snap-back half of P0-PKG.
      final String legacy =
          RegExp(r"^export const LEGACY_METHOD_CHANNEL_NAMESPACE = '([^']+)';$",
                  multiLine: true)
              .firstMatch(_ssotText())!
              .group(1)!;
      for (final String name in <String>[
        MethodChannelDeviceInfo.channel.name,
        MethodChannelImageClipboard.channel.name,
        MethodChannelUpdateInstaller.channel.name,
      ]) {
        expect(
          name.startsWith('$legacy/'),
          isFalse,
          reason: '$name still uses the retired $legacy namespace',
        );
      }
    });
  });
}
