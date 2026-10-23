// Card E-M / P-1 (docs/rebuild/18 §2.6) against a REAL saas server-core.
//
// D-23: a defect that lives in the layer a test double replaces is invisible
// to the suite. The rule under test — 「only a 401 whose body is
// AUTH_TOKEN_EXPIRED / AUTH_TOKEN_INVALID means 『sign in again』」 — is a rule
// about the response BODY, so here the body comes from the product: the real
// `GET /api/cloud/summary` route, read by the production `HttpClient` path
// (`httpCloudSummaryFetch`). The loopback-server cases in
// cloud_summary_client_test.dart pin the client's reading of each body; this
// file pins that the server really sends those bodies.
//
// Needs node AND a built server-core (`apps/server-core/dist/index.js` + its
// node_modules) — the verify lanes have both. Where they are absent (the
// flutter-only CI job installs no pnpm workspace) the group is SKIPPED with
// that reason printed, never silently passed.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/auth/cloud_summary.dart';
import 'package:flutter_test/flutter_test.dart';

const String _serverDist = '../server-core/dist/index.js';
const String _serverDeps = '../server-core/node_modules';

String? _skipReason() {
  if (!File(_serverDist).existsSync() || !Directory(_serverDeps).existsSync()) {
    return 'needs a built server-core ($_serverDist + node_modules); run '
        '`pnpm install` and `pnpm --filter @flowmic/server-core build`';
  }
  return null;
}

void main() {
  late Process server;
  late Map<String, Object?> fx;

  Uri summaryUri() => Uri.parse('${fx['base']}/api/cloud/summary');

  Future<CloudSummaryRead> read(String bearer) => httpCloudSummaryFetch(
    summaryUri(),
    bearer,
    const Duration(seconds: 10),
  );

  /// What the server itself put in the body, read raw — so each client-side
  /// assertion below is paired with the server-side fact it depends on.
  Future<(int, Object?)> raw(String authorization) async {
    final HttpClient c = HttpClient();
    try {
      final HttpClientRequest req = await c.getUrl(summaryUri());
      req.headers.set(HttpHeaders.authorizationHeader, authorization);
      final HttpClientResponse res = await req.close();
      final String body = await res.transform(utf8.decoder).join();
      Object? error;
      try {
        final Object? j = jsonDecode(body);
        error = j is Map ? j['error'] : null;
      } on FormatException {
        error = null;
      }
      return (res.statusCode, error);
    } finally {
      c.close(force: true);
    }
  }

  group('cloud summary against a real server-core', () {
    setUpAll(() async {
      server = await Process.start('node', <String>[
        'test/support/expired_jwt_saas_server.mjs',
      ], runInShell: false);
      unawaited(server.stderr.drain<void>());
      final String line = await server.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .first
          .timeout(const Duration(seconds: 60));
      fx = jsonDecode(line) as Map<String, Object?>;
    });
    tearDownAll(() async {
      // Only the process this file started, by its own handle.
      await server.stdin.close();
      server.kill();
    });

    test('controls: the real token and a re-signed live token both get PAST '
        'authentication', () async {
      // Not 「both read a summary」: a fresh account may be answered 403
      // EMAIL_NOT_VERIFIED (measured on this fixture), which is a verdict ABOUT
      // an authenticated account. What the control must prove is only that the
      // bearer authenticated — so the expired case below fails on `exp` alone.
      for (final String k in <String>['valid', 'resigned']) {
        final String jwt = fx[k]! as String;
        final (int status, Object? _) = await raw('Bearer $jwt');
        expect(status, isNot(401), reason: '$k must authenticate');
        expect((await read(jwt)).refusal, isNot(CloudSummaryRefusal.authExpired),
            reason: k);
      }
    });

    test('an expired credential: server says 401 AUTH_TOKEN_EXPIRED, the '
        'phone names it authExpired', () async {
      final String expired = fx['expired']! as String;
      expect(await raw('Bearer $expired'), (401, 'AUTH_TOKEN_EXPIRED'));
      final CloudSummaryRead got = await read(expired);
      expect(got.summary, isNull);
      expect(got.refusal, CloudSummaryRefusal.authExpired);
    });

    test('🔴 no credential presented: server says 401 AUTH_ACCOUNT_REQUIRED, '
        'the phone does NOT say 「sign in again」', () async {
      expect(await raw('Bearer '), (401, 'AUTH_ACCOUNT_REQUIRED'));
      final CloudSummaryRead got = await read('');
      expect(got.summary, isNull);
      expect(got.refusal, isNull);
    });
  }, skip: _skipReason());
}
