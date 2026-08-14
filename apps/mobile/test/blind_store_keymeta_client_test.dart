// SALT-2 — HttpBlindStoreKeymetaClient against a REAL loopback HttpServer.
//
// Why not a fake HttpClient: the RV-97 lesson — when a bug lives in the layer
// a test double replaces, it is invisible to the whole suite, and the layer
// being delivered here IS the HTTP mechanics (does the Authorization header go
// out, what does a 404 read as, does a dead port become a verdict). Same
// harness shape as pc_presence_probe_test.dart.
//
// ⚠️ Bare `test`, no pumpWidget: TestWidgetsFlutterBinding installs
// HttpOverrides and the dial would fall back onto the double this file exists
// to avoid.

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flowmic/src/timeline/cloud/blind_store_cloud_client.dart'
    show BlindStoreCloudRefusal, BlindStoreCloudUnreachable;
import 'package:flowmic/src/timeline/cloud/blind_store_keymeta_client.dart';
import 'package:flutter_test/flutter_test.dart';

final Uint8List kSalt =
    Uint8List.fromList(List<int>.generate(16, (int i) => (i * 7 + 3) & 0xff));

/// Opaque on this side of the wire — never parsed, never built (see the
/// client's file header). Any string proves pass-through.
const String kSentinel = 'opaque-sentinel-carried-verbatim';

Future<({HttpBlindStoreKeymetaClient client, List<
    ({String method, String path, String? auth, String body})> seen,
    HttpServer server})> _serve(
  void Function(HttpRequest req) reply, {
  String? jwt = 'jwt-abc',
}) async {
  final HttpServer server =
      await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final List<({String method, String path, String? auth, String body})> seen =
      <({String method, String path, String? auth, String body})>[];
  server.listen((HttpRequest req) async {
    final String body = await utf8.decoder.bind(req).join();
    seen.add((
      method: req.method,
      path: req.uri.path,
      auth: req.headers.value('authorization'),
      body: body,
    ));
    reply(req);
  });
  final HttpBlindStoreKeymetaClient client = HttpBlindStoreKeymetaClient(
    endpoint: 'http://127.0.0.1:${server.port}',
    bearer: () => jwt,
    timeout: const Duration(seconds: 3),
  );
  return (client: client, seen: seen, server: server);
}

void _json(HttpRequest req, int status, Object? body) {
  req.response
    ..statusCode = status
    ..write(jsonEncode(body));
  req.response.close();
}

void main() {
  group('GET', () {
    test('🔴 200: the row comes back — salt decoded, sentinel VERBATIM, and '
        'the account Bearer really went out', () async {
      final s = await _serve((HttpRequest req) {
        _json(req, 200, <String, Object?>{
          'salt_b64': base64.encode(kSalt),
          'sentinel': kSentinel,
          'schema_ver': 1,
        });
      });
      addTearDown(() => s.server.close(force: true));

      final BlindStoreKeymetaRow? row = await s.client.get();

      expect(row, isNotNull);
      expect(row!.salt, kSalt);
      expect(row.sentinel, kSentinel);
      expect(row.schemaVer, 1);
      expect(s.seen.single.method, 'GET');
      expect(s.seen.single.path, '/api/timeline/keymeta');
      // The credential half — without this the authenticated surface is a
      // client-side claim.
      expect(s.seen.single.auth, 'Bearer jwt-abc');
    });

    test('🔴 404 maps to 「no row」 — a value, never an error', () async {
      final s = await _serve((HttpRequest req) {
        _json(req, 404, <String, Object?>{'ok': false, 'error': 'KEYMETA_NOT_FOUND'});
      });
      addTearDown(() => s.server.close(force: true));

      expect(await s.client.get(), isNull);
    });

    test('401 is a REFUSAL carrying the server own code', () async {
      final s = await _serve((HttpRequest req) {
        _json(req, 401, <String, Object?>{'error': 'AUTH_TOKEN_INVALID'});
      });
      addTearDown(() => s.server.close(force: true));

      await expectLater(
        s.client.get(),
        throwsA(
          isA<BlindStoreCloudRefusal>().having(
            (BlindStoreCloudRefusal e) => e.code,
            'code',
            'AUTH_TOKEN_INVALID',
          ),
        ),
      );
    });

    test('🔴 nobody listening ⇒ UNREACHABLE, never a refusal — an unanswered '
        'request is not a server verdict', () async {
      final HttpServer tmp =
          await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final int deadPort = tmp.port;
      await tmp.close(force: true);
      final HttpBlindStoreKeymetaClient client = HttpBlindStoreKeymetaClient(
        endpoint: 'http://127.0.0.1:$deadPort',
        bearer: () => 'jwt',
        timeout: const Duration(milliseconds: 800),
      );

      await expectLater(
        client.get(),
        throwsA(isA<BlindStoreCloudUnreachable>()),
      );
    });

    test('200 with an unreadable body is UNREACHABLE, not a row and not a '
        'verdict', () async {
      for (final Object? body in <Object?>[
        'not json at all',
        <String, Object?>{'sentinel': kSentinel}, // no salt
        <String, Object?>{'salt_b64': 'not-base64!!', 'sentinel': kSentinel},
        <String, Object?>{
          // wrong length — a truncated salt would derive a key that opens
          // nothing while looking enrolled
          'salt_b64': base64.encode(kSalt.sublist(0, 8)),
          'sentinel': kSentinel,
        },
        <String, Object?>{'salt_b64': base64.encode(kSalt), 'sentinel': ''},
      ]) {
        final s = await _serve((HttpRequest req) {
          req.response
            ..statusCode = 200
            ..write(body is String ? body : jsonEncode(body));
          req.response.close();
        });
        await expectLater(
          s.client.get(),
          throwsA(isA<BlindStoreCloudUnreachable>()),
          reason: '$body',
        );
        await s.server.close(force: true);
      }
    });
  });

  group('PUT', () {
    test('201 → created, and the wire carried salt_b64 + sentinel verbatim', () async {
      final s = await _serve((HttpRequest req) {
        _json(req, 201, <String, Object?>{'ok': true, 'outcome': 'created'});
      });
      addTearDown(() => s.server.close(force: true));

      final BlindStoreKeymetaPutOutcome r =
          await s.client.put(salt: kSalt, sentinel: kSentinel);

      expect(r, BlindStoreKeymetaPutOutcome.created);
      expect(s.seen.single.method, 'PUT');
      expect(s.seen.single.auth, 'Bearer jwt-abc');
      final Map<String, Object?> sent =
          (jsonDecode(s.seen.single.body) as Map).cast<String, Object?>();
      expect(sent['salt_b64'], base64.encode(kSalt));
      expect(sent['sentinel'], kSentinel);
    });

    test('200 → identical (the idempotent replay both confirm on)', () async {
      final s = await _serve((HttpRequest req) {
        _json(req, 200, <String, Object?>{'ok': true, 'outcome': 'identical'});
      });
      addTearDown(() => s.server.close(force: true));

      expect(
        await s.client.put(salt: kSalt, sentinel: kSentinel),
        BlindStoreKeymetaPutOutcome.identical,
      );
    });

    test('🔴 409 → conflict as a VALUE — the race is a flow step, not an '
        'exception', () async {
      final s = await _serve((HttpRequest req) {
        _json(req, 409, <String, Object?>{'ok': false, 'error': 'KEYMETA_CONFLICT'});
      });
      addTearDown(() => s.server.close(force: true));

      expect(
        await s.client.put(salt: kSalt, sentinel: kSentinel),
        BlindStoreKeymetaPutOutcome.conflict,
      );
    });

    test('400 → refusal with the server code (KEYMETA_INVALID)', () async {
      final s = await _serve((HttpRequest req) {
        _json(req, 400, <String, Object?>{'ok': false, 'error': 'KEYMETA_INVALID'});
      });
      addTearDown(() => s.server.close(force: true));

      await expectLater(
        s.client.put(salt: kSalt, sentinel: kSentinel),
        throwsA(
          isA<BlindStoreCloudRefusal>().having(
            (BlindStoreCloudRefusal e) => e.code,
            'code',
            'KEYMETA_INVALID',
          ),
        ),
      );
    });

    test('a status with no readable body still refuses by bare status — '
        'never softened, never invented', () async {
      final s = await _serve((HttpRequest req) {
        req.response.statusCode = 503;
        req.response.close();
      });
      addTearDown(() => s.server.close(force: true));

      await expectLater(
        s.client.put(salt: kSalt, sentinel: kSentinel),
        throwsA(
          isA<BlindStoreCloudRefusal>().having(
            (BlindStoreCloudRefusal e) => e.code,
            'code',
            'HTTP_503',
          ),
        ),
      );
    });
  });

  test('🔴 logged out (null bearer): the request goes out WITHOUT an '
      'Authorization header and the 401 that returns is the SERVER verdict', () async {
    final s = await _serve(
      (HttpRequest req) {
        _json(req, 401, <String, Object?>{'error': 'AUTH_TOKEN_REQUIRED'});
      },
      jwt: null,
    );
    addTearDown(() => s.server.close(force: true));

    await expectLater(
      s.client.get(),
      throwsA(
        isA<BlindStoreCloudRefusal>().having(
          (BlindStoreCloudRefusal e) => e.code,
          'code',
          'AUTH_TOKEN_REQUIRED',
        ),
      ),
    );
    // No blank `Bearer ` went out — 「no token」 must not read as 「empty token」.
    expect(s.seen.single.auth, isNull);
  });
}
