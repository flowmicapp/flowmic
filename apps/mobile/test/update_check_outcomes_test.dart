// UP-2 —— row-by-row acceptance of design §3 "failure-direction table".
//
// 🔴 Every row of that table is a **must-do behaviour**, not decoration.
// This file is one test per row.
//
// Governing principle (§3 heading): **every failure degrades to "the user
// keeps using the version in their hand"**, and **no failure is allowed to
// say "already up to date"**.
//
// ⚠️ Assertions pin contract literals (`/api/updates/latest`, `android`,
// `apk`), and do not cite the constants of the file under test: a
// self-referential assertion moves with anyone who changes that constant,
// the test stays green, and on-the-wire behaviour has already changed —
// that kind of assertion is not a gate.

import 'package:flowmic/src/update/update_check.dart';
import 'package:flutter_test/flutter_test.dart';

import 'update_manifest_test.dart' show kGoodSha, manifestJson;

/// A fake fetcher that records what it was asked.
class _Fetcher {
  _Fetcher(this.status, this.body);
  _Fetcher.throwing(this.error) : status = 0, body = '';

  int status;
  String body;
  Object? error;
  Uri? askedFor;

  Future<({int status, String body})> call(Uri url) async {
    askedFor = url;
    final Object? e = error;
    if (e != null) throw e;
    return (status: status, body: body);
  }
}

Future<UpdateCheckResult> _check(
  _Fetcher f, {
  String? mine = '0.2.59',
  String endpoint = 'https://flowmic.app',
}) => checkForUpdate(
  currentVersion: mine,
  endpoint: endpoint,
  fetcher: f.call,
  now: () => DateTime.utc(2026, 8, 8, 9, 12),
);

void main() {
  group('the endpoint and the request itself', () {
    test('🔴 asks /api/updates/latest — same characters as the server UPDATE_MANIFEST_PATH', () async {
      final _Fetcher f = _Fetcher(200, manifestJson(androidVersion: '0.2.59'));
      await _check(f);
      // Pin the literal: this is a **cross-repo contract**; either side
      // moving must go red.
      expect(f.askedFor.toString(), 'https://flowmic.app/api/updates/latest');
    });

    test('🔴 the default asks the **official site**, not the current relay address', () async {
      // "which server am I connected to" and "which version is the latest
      // FlowMic" are two questions.
      // A private-domain build will point the relay at an intranet machine
      // with --dart-define=FLOWMIC_SAAS_ENDPOINT; that **must not** casually
      // take the update check with it (design §1.1: both clients always ask
      // the official site).
      // Pin the literal: this default is a design ruling, not an
      // implementation detail.
      expect(resolveUpdateEndpoint(), 'https://flowmic.app');
      // ⚠️ **This case cannot save itself; say clearly what it cannot
      // prove**: without a dart-define, `resolveSaasEndpoint()` and
      // `resolveUpdateEndpoint()` return the same string ⇒ someone changing
      // the implementation back to the former **stays green here**. Really
      // telling the two apart needs a define at build time, and
      // `flutter test` can only carry one set of defines, so it cannot be
      // pinned into a standing test.
      // ⇒ the fork is recorded here as a one-shot measurement
      // 【measured 2026-08-08, dev-pc-a】:
      //   `flutter test --dart-define=FLOWMIC_SAAS_ENDPOINT=http://100.64.7.99:41879`
      //   ⇒ `SAAS=http://100.64.7.99:41879  UPDATE=https://flowmic.app`
      // Before the fix both would have been that intranet machine. **This
      // is the entire evidence of that fork.**
    });

    test('🔴 the update endpoint has its own define — changing the relay must not casually change the update source', () async {
      // Two questions, two keys. Pin the literal: it appears in the
      // release command.
      expect(kUpdateEndpointDefineKey, 'FLOWMIC_UPDATE_ENDPOINT');
      expect(kUpdateManifestPath, '/api/updates/latest');
    });

    test('🔴 a ws:// endpoint is funnelled to http:// — rather than throwing ArgumentError', () async {
      // `HttpClient.getUrl` throws an **Error not an Exception** for ws;
      // `on Exception` cannot catch it. This fork has already cost this
      // repo three silent-failure bills (http_endpoint.dart file header).
      final _Fetcher f = _Fetcher(200, manifestJson(androidVersion: '0.2.59'));
      await _check(f, endpoint: 'ws://192.168.1.5:41879');
      expect(f.askedFor.toString(), 'http://192.168.1.5:41879/api/updates/latest');
    });
  });

  group('§3 table —— one test per row', () {
    test('row 7: manifest version ≤ this device ⇒ already up to date, and carries "when it was compared"', () async {
      final _Fetcher f = _Fetcher(200, manifestJson(androidVersion: '0.2.59'));
      final UpdateCheckResult r = await _check(f);
      expect(r.outcome, UpdateCheckOutcome.upToDate);
      expect(r.latestVersion, '0.2.59');
      // 🔴 Credential: without it, "already up to date" has no basis
      // (end of §5.0).
      expect(r.comparedAt, isNotNull);
      expect(r.didCompare, isTrue);
    });

    test('a lower manifest version is also "already up to date" — there is never a downgrade path', () async {
      final _Fetcher f = _Fetcher(200, manifestJson(androidVersion: '0.1.0'));
      expect((await _check(f)).outcome, UpdateCheckOutcome.upToDate);
    });

    test('a newer version ⇒ carries version, download URL, release notes, and refreshes the credential', () async {
      final _Fetcher f = _Fetcher(200, manifestJson(androidVersion: '9.9.9'));
      final UpdateCheckResult r = await _check(f);
      expect(r.outcome, UpdateCheckOutcome.updateAvailable);
      expect(r.latestVersion, '9.9.9');
      expect(r.installable, isNotNull);
      expect(r.installable!.kind, 'apk');
      expect(r.downloadUrl, contains('FlowMic-9.9.9-release.apk'));
      expect(r.notesUrl, isNotNull);
      expect(r.comparedAt, isNotNull);
    });

    test('row 2: endpoint 404 ⇒ "this deployment has no update manifest", **not** "already up to date"', () async {
      final _Fetcher f = _Fetcher(404, 'Not Found');
      final UpdateCheckResult r = await _check(f);
      expect(r.outcome, UpdateCheckOutcome.noManifestHere);
      // 🔴 A failed check must not refresh "last successful check" —
      // otherwise that row degrades from a credential into decoration.
      expect(r.comparedAt, isNull);
      expect(r.didCompare, isFalse);
    });

    test('row 3 first half: 503 ⇒ "temporarily unavailable", **a different sentence** from 404', () async {
      final _Fetcher f = _Fetcher(503, '{"error":"UPDATE_MANIFEST_UNAVAILABLE"}');
      final UpdateCheckResult r = await _check(f);
      expect(r.outcome, UpdateCheckOutcome.unavailable);
      expect(r.outcome, isNot(UpdateCheckOutcome.noManifestHere));
      expect(r.comparedAt, isNull);
    });

    test('row 3 second half: cannot connect / DNS failure ⇒ "unreachable", separate from 503', () async {
      final _Fetcher f = _Fetcher.throwing(const _NetDown());
      final UpdateCheckResult r = await _check(f);
      expect(r.outcome, UpdateCheckOutcome.unreachable);
      expect(r.outcome, isNot(UpdateCheckOutcome.unavailable));
      expect(r.comparedAt, isNull);
    });

    test('🔴 an Error thrown by the fetcher (not an Exception) must also be caught', () async {
      // `on Exception` cannot catch Error — this is exactly the RV-97
      // family's shape.
      final _Fetcher f = _Fetcher.throwing(ArgumentError('Unsupported scheme'));
      expect((await _check(f)).outcome, UpdateCheckOutcome.unreachable);
    });

    test('200 but a whole page of HTML ⇒ malformed, never "we looked it up"', () async {
      final _Fetcher f = _Fetcher(200, '<!doctype html><html>…</html>');
      final UpdateCheckResult r = await _check(f);
      expect(r.outcome, UpdateCheckOutcome.malformed);
      expect(r.comparedAt, isNull);
    });

    test('row 4 first half: the manifest has no android entry ⇒ "update information is incomplete"', () async {
      const String onlyWindows = '''
{"manifest_version":1,"generated_at":"x","platforms":{
  "windows-x64":{"version":"9.9.9","notes_url":null,"artifacts":[
    {"kind":"msi","locale":"zh-CN","filename":"a.msi","url":"http://x/a.msi",
     "sha256":"$kGoodSha","size":1}]}}}''';
      final UpdateCheckResult r = await _check(_Fetcher(200, onlyWindows));
      expect(r.outcome, UpdateCheckOutcome.incompleteInfo);
      expect(r.comparedAt, isNull);
    });

    test('🔴 row 4 second half: version is newer but the artifact sha256 is illegal ⇒ do not download, named "information incomplete"', () async {
      // This is the first gate of the hash check on the **client**: a
      // package we cannot verify, we do not even download.
      final _Fetcher f = _Fetcher(
        200,
        manifestJson(
          androidVersion: '9.9.9',
          artifacts: '''{ "kind": "apk", "locale": null, "filename": "a.apk",
              "url": "http://x/a.apk", "sha256": "", "size": 1 }''',
        ),
      );
      final UpdateCheckResult r = await _check(f);
      expect(r.outcome, UpdateCheckOutcome.incompleteInfo);
      expect(r.downloadUrl, isNull, reason: 'give no download URL — we do not intend to let anyone install a package we cannot verify');
      expect(r.detail, contains('dropped=1'));
    });

    test('🔴 this device\'s version cannot be read ⇒ ownVersionUnknown, **never** "already up to date"', () async {
      // The §3 table has no such row; this round added it: a build that
      // can never read its own version number, if it fell into upToDate,
      // would **forever display "already up to date"**.
      for (final String? mine in <String?>[null, '', '不是版本号', '0.2']) {
        final _Fetcher f = _Fetcher(200, manifestJson(androidVersion: '9.9.9'));
        final UpdateCheckResult r = await _check(f, mine: mine);
        expect(r.outcome, UpdateCheckOutcome.ownVersionUnknown, reason: '「$mine」');
        expect(r.comparedAt, isNull);
        // Did not even send the request — nothing comparable, no need to ask.
        expect(f.askedFor, isNull);
      }
    });
  });

  group('🔴 kind is an open set —— lead ruling 1, and already an on-the-wire fact', () {
    test('only portable-zip ⇒ still "a newer version" + a real URL, not an error, not up to date', () async {
      // scripts lane today's measurement, secondhand: `portable-zip` is
      // already in the generator (commit 1791ab0).
      // A closed set in this position produced a P0 in 0.2.48, and was
      // replicated a second time the same month.
      final _Fetcher f = _Fetcher(
        200,
        manifestJson(
          androidVersion: '9.9.9',
          artifacts: '''{ "kind": "portable-zip", "locale": null,
              "filename": "p.zip", "url": "http://x/p.zip",
              "sha256": "$kGoodSha", "size": 9 }''',
        ),
      );
      final UpdateCheckResult r = await _check(f);
      expect(r.outcome, UpdateCheckOutcome.updateAvailable);
      expect(r.installable, isNull, reason: 'we will not install a zip');
      expect(r.downloadUrl, 'http://x/p.zip', reason: 'still have to give a path that works');
      expect(r.latestVersion, '9.9.9');
    });

    test('a mix of recognised and unrecognised kinds ⇒ pick the apk one', () async {
      final _Fetcher f = _Fetcher(
        200,
        manifestJson(
          androidVersion: '9.9.9',
          artifacts: '''
            { "kind": "dmg", "locale": null, "filename": "a.dmg",
              "url": "http://x/a.dmg", "sha256": "$kGoodSha", "size": 9 },
            { "kind": "apk", "locale": null, "filename": "a.apk",
              "url": "http://x/a.apk", "sha256": "$kGoodSha", "size": 9 }''',
        ),
      );
      final UpdateCheckResult r = await _check(f);
      expect(r.installable!.kind, 'apk');
      expect(r.downloadUrl, 'http://x/a.apk');
    });
  });

  group('🔴 unknown ≠ up to date —— exhaustive assertion', () {
    test('except upToDate, no cell can produce the credential "we compared versions"', () async {
      // This is the shape of this card's red line at the **type level**:
      // `comparedAt` is the only basis for "already up to date", and only
      // the two cells that actually compared a version are entitled to it.
      final List<UpdateCheckResult> failures = <UpdateCheckResult>[
        await _check(_Fetcher(404, '')),
        await _check(_Fetcher(503, '')),
        await _check(_Fetcher(500, '')),
        await _check(_Fetcher(200, 'not json')),
        await _check(_Fetcher.throwing(const _NetDown())),
        await _check(_Fetcher(200, manifestJson()), mine: null),
        await _check(_Fetcher(200, '{"manifest_version":1,"generated_at":"x",'
            '"platforms":{"windows-x64":{"version":"9.9.9","notes_url":null,'
            '"artifacts":[{"kind":"msi","locale":null,"filename":"a.msi",'
            '"url":"http://x/a.msi","sha256":"$kGoodSha","size":1}]}}}')),
      ];
      for (final UpdateCheckResult r in failures) {
        expect(
          r.outcome,
          isNot(UpdateCheckOutcome.upToDate),
          reason: '${r.outcome} was treated as "already up to date"',
        );
        expect(
          r.didCompare,
          isFalse,
          reason: '${r.outcome} must not refresh "last successful check" — it compared nothing',
        );
      }
    });
  });
}

class _NetDown implements Exception {
  const _NetDown();
}
