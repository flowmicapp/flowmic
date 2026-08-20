// UP-2 —— manifest parse and version compare (pure logic, no network).
//
// This file pins three things, each corresponding to a red line in the design:
//   ① **the envelope rules match the server's item-by-item** (`validateUpdateManifest`
//      in `update-routes.ts`);
//   ② 🔴 **hash gate**: an artifact whose sha256 is the wrong shape **must not be
//      served as a downloadable item**;
//   ③ 🔴 **`kind` is an open set**: an unrecognized type **must not** kill the
//      whole manifest or the whole path.
//
// ⚠️ **Assertions land on literals, not on the file-under-test's own constants.**
// An `expect(artifact.kind, kUpdateInstallableKind)` is **self-referential**: whoever
// changes that constant to `'exe'` moves both sides, the test stays green, and
// production behavior has already changed.
// Criterion: **an assertion must be expensive enough that breaking it costs
// something**, otherwise it is not a gate.
// So the values below are hardcoded `'apk'` / `'android'` / `'/api/updates/latest'`
// — these are **contract values**.

import 'package:flowmic/src/update/update_manifest.dart';
import 'package:flutter_test/flutter_test.dart';

/// 64-bit lowercase hex — the only legal sha256 shape.
const String kGoodSha = 'abc1230000000000000000000000000000000000000000000000000000000def';

String manifestJson({
  String androidVersion = '9.9.9',
  String artifacts = '''
      { "kind": "apk", "locale": null, "filename": "FlowMic-9.9.9-release.apk",
        "url": "http://100.64.7.68/dl/flowmic/release/FlowMic-9.9.9-release.apk",
        "sha256": "$kGoodSha", "size": 45678901 }''',
  String notesUrl = '"http://100.64.7.68/dl/flowmic/release/NOTES.md"',
  /// Extra top-level JSON, e.g. `, "store_platforms": {…}` — the additive
  /// block the iOS notify-only channel rides on.
  String trailer = '',
}) => '''
{
  "manifest_version": 1,
  "generated_at": "2026-08-08T12:00:00.000Z",
  "platforms": {
    "android": {
      "version": "$androidVersion",
      "notes_url": $notesUrl,
      "artifacts": [$artifacts]
    }
  }$trailer
}''';

/// A ready-made `store_platforms` trailer for [manifestJson].
String storeTrailer({
  String iosVersion = '9.9.9',
  String notesUrl = '"https://github.com/flowmicapp/flowmic/releases/tag/v9.9.9"',
  String storeUrl = '"https://testflight.apple.com/join/example"',
}) => ''',
  "store_platforms": {
    "ios": { "version": "$iosVersion", "notes_url": $notesUrl, "store_url": $storeUrl }
  }''';

void main() {
  group('① envelope rules — the same set as the server\'s validateUpdateManifest', () {
    test('a well-formed manifest parses', () {
      final ManifestParse p = parseUpdateManifest(manifestJson());
      expect(p, isA<ManifestParsed>());
      final UpdateManifest m = (p as ManifestParsed).manifest;
      // Platform key hardcoded as 'android' — it is a contract value (the payload
      // example in design §1.2), not an implementation detail this file may
      // casually change.
      expect(m.platforms.containsKey('android'), isTrue);
      expect(m.platforms['android']!.version, '9.9.9');
      expect(m.platforms['android']!.artifacts, hasLength(1));
      expect(m.platforms['android']!.artifacts.single.kind, 'apk');
    });

    test('🔴 200 that answers with a whole HTML page ⇒ named reject, never "we found it"', () {
      // This is not an edge case: production nginx `try_files $uri $uri/ /index.html`
      // answers a missing path with 200 + a whole HTML page (design §1.4). Same
      // shape as a captive portal.
      final ManifestParse p = parseUpdateManifest(
        '<!doctype html><html><head><title>FlowMic</title></head></html>',
      );
      expect(p, isA<ManifestRejected>());
      expect((p as ManifestRejected).reason, 'unparsable_json');
    });

    test('empty platforms ⇒ reject (it would be read as "no platform has an update", and that is not something we know)', () {
      final ManifestParse p = parseUpdateManifest(
        '{"manifest_version":1,"generated_at":"x","platforms":{}}',
      );
      expect((p as ManifestRejected).reason, 'empty_platforms');
    });

    test('manifest_version is not 1 ⇒ reject, do not guess', () {
      final ManifestParse p = parseUpdateManifest(
        '{"manifest_version":2,"generated_at":"x","platforms":{"android":{}}}',
      );
      expect((p as ManifestRejected).reason, 'unsupported_manifest_version');
    });

    test('version is not three numeric segments ⇒ reject the whole thing (the same ruler as the server\'s VERSION_RE)', () {
      for (final String bad in <String>['9.9', 'v9.9.9', '9.9.9-rc1', '']) {
        final ManifestParse p = parseUpdateManifest(manifestJson(androidVersion: bad));
        expect(p, isA<ManifestRejected>(), reason: '"$bad" must not be treated as a version number');
      }
    });

    test('notes_url is not http(s) ⇒ reject (file: would point the client at a local file)', () {
      final ManifestParse p = parseUpdateManifest(
        manifestJson(notesUrl: '"file:///etc/passwd"'),
      );
      expect((p as ManifestRejected).reason, startsWith('bad_notes_url'));
    });
  });

  group('② 🔴 hash gate — an artifact that cannot be verified must not be served', () {
    // Every one of these must be **dropped**, not "still downloadable with a
    // suspicious sha256". This is the first half of design §2.2 gate ③: before
    // the client recomputes the hash itself, it must first refuse entries that
    // **cannot be computed at all**.
    final Map<String, String> badShas = <String, String>{
      'empty string': '""',
      'truncated': '"abc123"',
      'uppercase': '"${kGoodSha.toUpperCase()}"',
      'leading space': '" $kGoodSha"',
      'not a string': '12345',
      'missing': null.toString(),
    };
    for (final MapEntry<String, String> e in badShas.entries) {
      test('sha256 ${e.key} ⇒ this artifact is dropped, the platform becomes "no usable artifact"', () {
        final String art = e.key == 'missing'
            ? '''{ "kind": "apk", "locale": null, "filename": "a.apk",
                   "url": "http://x/a.apk", "size": 1 }'''
            : '''{ "kind": "apk", "locale": null, "filename": "a.apk",
                   "url": "http://x/a.apk", "sha256": ${e.value}, "size": 1 }''';
        final ManifestParse p = parseUpdateManifest(manifestJson(artifacts: art));
        final UpdatePlatform entry =
            (p as ManifestParsed).manifest.platforms['android']!;
        expect(entry.artifacts, isEmpty, reason: '${e.key} sha256 got through the gate');
        expect(entry.droppedArtifacts, 1);
      });
    }

    test('url is not http(s) ⇒ dropped the same way', () {
      final ManifestParse p = parseUpdateManifest(
        manifestJson(
          artifacts: '''{ "kind": "apk", "locale": null, "filename": "a.apk",
              "url": "file:///tmp/a.apk", "sha256": "$kGoodSha", "size": 1 }''',
        ),
      );
      expect((p as ManifestParsed).manifest.platforms['android']!.artifacts, isEmpty);
    });

    test('filename contains a path separator / .. ⇒ dropped (must not tell the client to write outside the directory)', () {
      // ⚠️ A backslash in JSON must be written `\\`, otherwise `\a` is an illegal
      // escape and the whole manifest dies in jsonDecode — that would measure
      // "is the JSON legal" rather than "does the validator drop it".
      // (The first version was written that way and went red on itself: check
      // your ruler first.)
      for (final String bad in <String>['../a.apk', 'sub/a.apk', r'sub\\a.apk']) {
        final ManifestParse p = parseUpdateManifest(
          manifestJson(
            artifacts: '''{ "kind": "apk", "locale": null, "filename": "$bad",
                "url": "http://x/a.apk", "sha256": "$kGoodSha", "size": 1 }''',
          ),
        );
        expect(
          (p as ManifestParsed).manifest.platforms['android']!.artifacts,
          isEmpty,
          reason: '"$bad" must not be treated as a filename that can land on disk',
        );
      }
    });

    test('🔴 a plaintext http url is **legal** — the download center IS HTTP, and that is why the hash exists', () {
      final ManifestParse p = parseUpdateManifest(manifestJson());
      final UpdateArtifact a =
          (p as ManifestParsed).manifest.platforms['android']!.artifacts.single;
      expect(a.url, startsWith('http://'));
    });
  });

  group('③ 🔴 kind is an open set — an unrecognized type must not kill the whole path', () {
    test('unheard-of kinds like portable-zip / dmg still parse', () {
      // This is not a hypothesis: `portable-zip` is already in the generator
      // (scripts lane measured, secondhand), and a closed set in this position
      // produced a P0 in 0.2.48 (the phone forever said 「待投递」 and never
      // converged).
      final ManifestParse p = parseUpdateManifest(
        manifestJson(
          artifacts: '''{ "kind": "portable-zip", "locale": null,
              "filename": "FlowMic-portable.zip", "url": "http://x/p.zip",
              "sha256": "$kGoodSha", "size": 99 }''',
        ),
      );
      final UpdatePlatform entry =
          (p as ManifestParsed).manifest.platforms['android']!;
      expect(entry.artifacts, hasLength(1));
      expect(entry.artifacts.single.kind, 'portable-zip');
      expect(entry.droppedArtifacts, 0, reason: 'unrecognized ≠ illegal');
    });
  });

  group('④ version compare (design §1.3)', () {
    test('strictly greater counts as new; equal and smaller do not', () {
      expect(compareVersions('0.2.60', '0.2.59'), 1);
      expect(compareVersions('0.2.59', '0.2.59'), 0);
      expect(compareVersions('0.2.58', '0.2.59'), -1);
      expect(compareVersions('0.3.0', '0.2.99'), 1);
      expect(compareVersions('1.0.0', '0.99.99'), 1);
    });

    test('compare each segment as a **number**, not as a string', () {
      // A string compare would say '0.2.9' > '0.2.10', the classic bug of this
      // kind of implementation.
      expect(compareVersions('0.2.10', '0.2.9'), 1);
    });

    test('🔴 unparsable ⇒ null, **must not collapse into "not a new version"**', () {
      // "we do not know whether it is newer" and "it is not newer" produce
      // opposite UI on this chain.
      for (final String bad in <String>['', '9.9', 'v1.2.3', '1.2.3-rc1', 'x.y.z']) {
        expect(compareVersions(bad, '0.2.59'), isNull, reason: '"$bad"');
        expect(compareVersions('0.2.59', bad), isNull, reason: '"$bad"');
      }
      expect(parseVersion('1.2.3'), <int>[1, 2, 3]);
      expect(parseVersion('1.2.3-rc1'), isNull);
    });
  });

  group('⑤ store_platforms — the additive block for store-delivered platforms (iOS)', () {
    test('a valid ios entry parses, and the android half is untouched by its presence', () {
      final ManifestParse p = parseUpdateManifest(manifestJson(trailer: storeTrailer()));
      expect(p, isA<ManifestParsed>());
      final UpdateManifest m = (p as ManifestParsed).manifest;
      final UpdateStorePlatform ios = m.storePlatforms['ios']!;
      expect(ios.version, '9.9.9');
      expect(ios.storeUrl, 'https://testflight.apple.com/join/example');
      // Additive safety, asserted where it matters: the android entry a
      // fielded phone reads is exactly what it was without the block.
      expect(m.platforms['android']!.artifacts, hasLength(1));
    });

    test('a manifest WITHOUT the block parses with an empty map — absent and empty are one fact', () {
      final ManifestParse p = parseUpdateManifest(manifestJson());
      expect((p as ManifestParsed).manifest.storePlatforms, isEmpty);
    });

    test('🔴 a mangled store version rejects the WHOLE manifest — never compare against garbage', () {
      final ManifestParse p = parseUpdateManifest(
        manifestJson(trailer: storeTrailer(iosVersion: 'v9.9.9')),
      );
      expect(p, isA<ManifestRejected>());
      expect((p as ManifestRejected).reason, 'bad_store_version:ios');
    });

    test('store_url takes http(s) only — itms-services: dies at the boundary', () {
      final ManifestParse p = parseUpdateManifest(
        manifestJson(trailer: storeTrailer(storeUrl: '"itms-services://?action=x"')),
      );
      expect(p, isA<ManifestRejected>());
      expect((p as ManifestRejected).reason, 'bad_store_url:ios');
    });

    test('store_url may be null — the news is real before the link is minted', () {
      final ManifestParse p = parseUpdateManifest(
        manifestJson(trailer: storeTrailer(storeUrl: 'null')),
      );
      expect(p, isA<ManifestParsed>());
      expect((p as ManifestParsed).manifest.storePlatforms['ios']!.storeUrl, isNull);
    });
  });
}
