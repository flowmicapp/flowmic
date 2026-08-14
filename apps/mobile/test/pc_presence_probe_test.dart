// RV-98 (card B4-14) — `httpPcPresenceRead` against a REAL `HttpServer`.
//
// owner 2026-08-01：「实际上 PC 是在线的，这样显示不对，**要能正确显示 PC 端是否在线**」。
//
// 🔴 Why this file does not use a fake `HttpClient`. RV-97's lesson is one this
// window just paid for:
// **when a bug lives in the layer the test double replaces, it is invisible to
// the entire test suite** —
// `flutter_test` swaps every HTTP call for a fake, and the broken thing was
// exactly the replaced `getUrl` (`ws://` throws
// `ArgumentError`, an **Error not an Exception**). So this file starts a real
// loopback `HttpServer` and lets a **real `HttpClient` make a real request**:
// whether the Authorization header actually went on the wire, and what 404/401
// actually read as, can only be asked this way.
//
// ⚠️ `TestWidgetsFlutterBinding` installs HttpOverrides, so this file uses bare
// `test` and does not `pumpWidget` anything — otherwise the dial would fall
// back onto the double layer again.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flutter_test/flutter_test.dart';

/// Starts a server that only says one thing; returns its base url and the
/// requests it saw.
Future<({String url, List<HttpRequest> seen, HttpServer server})> _serve(
  void Function(HttpRequest req) reply,
) async {
  final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  final List<HttpRequest> seen = <HttpRequest>[];
  server.listen((HttpRequest req) {
    seen.add(req);
    reply(req);
  });
  return (url: 'http://127.0.0.1:${server.port}', seen: seen, server: server);
}

void main() {
  const Duration t = Duration(seconds: 3);

  test('pcPresenceUri uses the repo-wide single normalisation (a QR that stored ws:// can still be asked)', () {
    expect(
      pcPresenceUri('ws://192.168.1.5:41879').toString(),
      'http://192.168.1.5:41879/api/pc/presence',
    );
    expect(
      pcPresenceUri('https://flowmic.app').toString(),
      'https://flowmic.app/api/pc/presence',
    );
    // Any path/query hanging on the endpoint is dropped: /api/pc/presence is an
    // absolute route on the server root.
    expect(
      pcPresenceUri('http://h:1/socket.io/?EIO=4').toString(),
      'http://h:1/api/pc/presence',
    );
  });

  test('🔴 real HttpClient, real request: sends Bearer, and reads pc_online as online', () async {
    final s = await _serve((HttpRequest req) {
      req.response
        ..statusCode = 200
        ..write(jsonEncode(<String, Object?>{
          'ok': true,
          'pc_id': 'pc-1',
          'pc_online': true,
        }));
      req.response.close();
    });
    addTearDown(() => s.server.close(force: true));

    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('${s.url}/api/pc/presence'),
      'fm_token_abc',
      t,
    );
    expect(r.presence, PcPresence.online);
    expect(r.pcId, 'pc-1');
    // 🔴 The credential really went on the wire — without this line, 「an
    // authenticated surface」 is an empty claim on the client half.
    expect(s.seen.single.headers.value('authorization'), 'Bearer fm_token_abc');
    expect(s.seen.single.uri.path, '/api/pc/presence');
    expect(s.seen.single.method, 'GET');
  });

  test('pc_online:false reads as offline', () async {
    final s = await _serve((HttpRequest req) {
      req.response
        ..statusCode = 200
        ..write(jsonEncode(<String, Object?>{'ok': true, 'pc_id': 'pc-1', 'pc_online': false}));
      req.response.close();
    });
    addTearDown(() => s.server.close(force: true));
    final PcPresenceReading r =
        await httpPcPresenceRead(Uri.parse('${s.url}/api/pc/presence'), 'tok', t);
    expect(r.presence, PcPresence.offline);
  });

  test('🔴 old server 404 / credential rejected 401 ⇒ unknown, never 「offline」', () async {
    for (final int code in <int>[404, 401, 500]) {
      final s = await _serve((HttpRequest req) {
        req.response.statusCode = code;
        req.response.close();
      });
      final PcPresenceReading r =
          await httpPcPresenceRead(Uri.parse('${s.url}/api/pc/presence'), 'tok', t);
      expect(r.presence, PcPresence.unknown, reason: 'HTTP $code');
      await s.server.close(force: true);
    }
  });

  test('🔴 200 but the field is not a bool ⇒ unknown (a missing field is never back-filled into a plausible value)', () async {
    for (final Object? body in <Object?>[
      <String, Object?>{'ok': true, 'pc_id': 'pc-1'}, // no pc_online
      <String, Object?>{'ok': true, 'pc_online': 'true'}, // a string is not a bool
      <String, Object?>{'ok': false, 'pc_online': true}, // claims not ok
      'not json at all',
    ]) {
      final s = await _serve((HttpRequest req) {
        req.response
          ..statusCode = 200
          ..write(body is String ? body : jsonEncode(body));
        req.response.close();
      });
      final PcPresenceReading r =
          await httpPcPresenceRead(Uri.parse('${s.url}/api/pc/presence'), 'tok', t);
      expect(r.presence, PcPresence.unknown, reason: '$body');
      await s.server.close(force: true);
    }
  });

  test('🔴 RV-89\'s shape: handing ws:// straight to read throws Error, and can only land as 「unknown」', () async {
    // The production path always goes through [pcPresenceUri], so this URI never
    // arrives here; it is pinned because RV-89/RV-97 were both 「a path that
    // skipped normalisation」, and `on Exception` cannot catch an Error.
    final PcPresenceReading r =
        await httpPcPresenceRead(Uri.parse('ws://127.0.0.1:1/api/pc/presence'), 'tok', t);
    expect(r.presence, PcPresence.unknown);
  });

  test('unreachable (nobody on the port) ⇒ unknown', () async {
    final HttpServer tmp = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final int deadPort = tmp.port;
    await tmp.close(force: true); // nobody is listening on the port now
    final PcPresenceReading r = await httpPcPresenceRead(
      Uri.parse('http://127.0.0.1:$deadPort/api/pc/presence'),
      'tok',
      const Duration(milliseconds: 800),
    );
    expect(r.presence, PcPresence.unknown);
  });
}
