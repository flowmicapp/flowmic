// Card C4 — 「为什么那一问没得到答案」 ("why that question went unanswered"), made
// attributable AFTER THE FACT from the phone's own diagnostic upload, over real
// sockets.
//
// SPEC-REF:
//   apps/mobile/lib/src/session/pc_presence_probe.dart
//     ([PcPresenceFault], `httpPcPresenceRead`, `readPcPresenceRetrying`)
//   apps/mobile/lib/src/diag/diag_log.dart — `DiagLog.snapshot()` IS the upload
//     payload (diag_upload.dart reads exactly that), so every line asserted here
//     is a line that leaves the phone
//   apps/server-core/src/http/presence-routes.ts (`PRESENCE_AUTH_REQUIRED`)
//
// 🔴 THE DEFECT. The owner's instance list read 「中继可达 · 电脑是否在线未知」
// ("relay reachable · PC status unknown") from an external network. The server
// did not answer `false` — the phone never got an answer at all. `miss` already
// separated a timeout from a 401 from a 404, but THREE genuinely different
// faults still shared one word:
//   · a name that never resolved,
//   · a connection that was refused,
//   · a TLS handshake that failed,
// all landed as `miss=network`. Their fixes are three different things (the
// relay's DNS, the relay being down, a certificate or a pin), so a report of
// 「it says unknown」 still could not be acted on. And every non-200 that was
// neither 401 nor 404 arrived as the single word `serverError`, with the status
// — the one fact that separates an old relay from a middlebox in front of a
// current one — thrown away.
//
// 🔴 WHY IT IS MEASURED HERE AND NOT WITH AN INJECTED READER. The classification
// lives in `httpPcPresenceRead`'s catch arms, which an injected reader replaces
// wholesale. A unit test with a fake would be asserting that our own fixture
// carries the class we put in it. So: real `HttpServer`s, one real refused port,
// one real TLS-on-a-plain-listener, and the production probe.
//
// ⚠️ Bare `test` only, never `testWidgets`: `TestWidgetsFlutterBinding` installs
// HttpOverrides suite-wide and every `HttpClient` below would quietly become a
// double. This repo has paid for that twice (pc_signed_out_wire_test.dart §head).
//
// ── REVERSE CONTROL (executed 2026-08-17, observed — not reasoned) ──────────
// See the individual cases; each break and what it produced is recorded at the
// group it belongs to.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/session/instance_probe.dart';
import 'package:flowmic/src/session/pc_presence.dart';
import 'package:flowmic/src/session/pc_presence_probe.dart';
import 'package:flutter_test/flutter_test.dart';

/// One attempt, no retry — every case here is deterministic, and a second
/// attempt would only double the wall clock.
const PcPresenceRetryBudget _once = PcPresenceRetryBudget(
  attempts: 1,
  perAttemptTimeout: Duration(seconds: 3),
  backoff: <Duration>[],
);

/// Serve one canned response and hand back its origin.
Future<({String url, HttpServer server})> _serve(
  int status,
  String body, {
  ContentType? type,
}) async {
  final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((HttpRequest req) {
    req.response
      ..statusCode = status
      ..headers.contentType = type ?? ContentType.json
      ..write(body);
    req.response.close();
  });
  return (url: 'http://127.0.0.1:${server.port}', server: server);
}

/// The trail line this cycle left behind — the same string
/// `POST /api/diag/mobile` would carry.
Future<String> _trailFor(Uri url, {PcPresenceRetryBudget budget = _once}) async {
  DiagLog.instance.clear();
  await readPcPresenceRetrying(url, 'fm_token_super_secret_value', budget: budget);
  final List<String> lines = DiagLog.instance
      .snapshot()
      .where((String l) => l.contains('presence.unknown'))
      .toList();
  expect(lines, hasLength(1));
  return lines.single;
}

/// A port nothing is listening on. Bound and immediately released, so the number
/// is real and free rather than a guess that might collide with a live service.
Future<int> _deadPort() async {
  final ServerSocket s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final int port = s.port;
  await s.close();
  return port;
}

void main() {
  setUp(DiagLog.instance.clear);

  // ── the refusal that is not a miss ────────────────────────────────────────
  //
  // REVERSE CONTROL (executed 2026-08-17, observed — not reasoned): in
  // `httpPcPresenceRead`, drop the `_saysPresenceAuthRequired` branch so a 401
  // drains and falls through to `PcPresenceMiss.unauthorized`, exactly as it did
  // before this card. Observed — 8 pass / 3 FAIL:
  //   '🔴 a 401 carrying PRESENCE_AUTH_REQUIRED is a REFUSAL, not a non-answer'
  //     Expected: true   Actual: <false>
  //   '🔴 wire to face: a revoked pairing stops reading as "PC status unknown"'
  //     Expected: <InstanceLivenessFace.pairingRevoked>
  //       Actual: <InstanceLivenessFace.relayOnlyPcUnknown>
  //     — which is verbatim the screen the owner reported.
  //   'the trail says a refusal happened, so a field report can be checked'
  //     Expected: contains 'pairing_rejected=true'
  //       Actual: '…presence.unknown miss=unauthorized fault=status
  //                fault_code=401 attempts=1 elapsed_ms=2 endpoint_h=…'
  // ⚠️ Three, where the note written here first predicted two. Recorded as
  // observed. Note also what SURVIVED: `fault=status fault_code=401` is still in
  // the trail under the break — so the forensic half of this card and the
  // product half really are independent, which is the property that lets them be
  // two commits.
  // 🔴 The two negative controls (a bare 401, and a 403) stayed green: the
  // narrowing is doing the work, not the status code.
  // Restored, re-run: 11/11 green.
  group('a 401 from a revoked pairing', () {
    test('🔴 a 401 carrying PRESENCE_AUTH_REQUIRED is a REFUSAL, not a non-answer', () async {
      final s = await _serve(401, jsonEncode(<String, Object?>{
        'ok': false,
        'error': 'PRESENCE_AUTH_REQUIRED',
      }));
      addTearDown(() => s.server.close(force: true));
      final PcPresenceReading r = await httpPcPresenceRead(
        Uri.parse('${s.url}/api/pc/presence'),
        'tok',
        const Duration(seconds: 3),
      );
      expect(r.pairingRejected, isTrue);
      // 🔴 The presence itself is STILL unknown. A refusal about the pairing is
      // not a measurement of the computer, and this line is what stops the new
      // face from becoming a second way of saying 「offline」.
      expect(r.presence, PcPresence.unknown);
      // The retry layer's answer is unchanged: the server answered, so asking
      // again is an authentication hammer, not a recovery.
      expect(r.miss, PcPresenceMiss.unauthorized);
      expect(r.miss!.retryable, isFalse);
    });

    test('🔴 wire to face: a revoked pairing stops reading as "PC status unknown"', () async {
      final s = await _serve(401, jsonEncode(<String, Object?>{
        'ok': false,
        'error': 'PRESENCE_AUTH_REQUIRED',
      }));
      addTearDown(() => s.server.close(force: true));
      final PcPresenceReading r = await httpPcPresenceRead(
        Uri.parse('${s.url}/api/pc/presence'),
        'tok',
        const Duration(seconds: 3),
      );
      expect(
        instanceLivenessFaceOf(
          reach: InstanceReach.online,
          answeringChannel: ServerChannel.cloudRelay,
          target: InstanceTarget.pc,
          pcPresence: r.presence,
          pairingRejected: r.pairingRejected,
        ),
        InstanceLivenessFace.pairingRevoked,
      );
    });

    test('🔴 THE DISTINCTION: a bare 401 from a middlebox stays "unknown"', () async {
      // The negative control, and the reason the body is checked at all. A
      // corporate proxy, a captive portal or an nginx basic-auth in front of the
      // relay all answer 401 with an opinion about NOTHING. Telling that user
      // their pairing was revoked would send them to redo a pairing that is
      // perfectly fine — the same class of error as the fabricated
      // `AUTH_TOKEN_INVALID` that L-② cost this repo.
      for (final String body in <String>[
        '<html><body>401 Authorization Required</body></html>',
        jsonEncode(<String, Object?>{'ok': false, 'error': 'UNAUTHORIZED'}),
        '',
      ]) {
        final s = await _serve(401, body, type: ContentType.html);
        final PcPresenceReading r = await httpPcPresenceRead(
          Uri.parse('${s.url}/api/pc/presence'),
          'tok',
          const Duration(seconds: 3),
        );
        await s.server.close(force: true);
        expect(r.pairingRejected, isFalse, reason: body);
        expect(
          instanceLivenessFaceOf(
            reach: InstanceReach.online,
            answeringChannel: ServerChannel.cloudRelay,
            target: InstanceTarget.pc,
            pcPresence: r.presence,
            pairingRejected: r.pairingRejected,
          ),
          InstanceLivenessFace.relayOnlyPcUnknown,
          reason: body,
        );
      }
    });

    test('a 403 is never read as a revoked pairing', () async {
      // Only the route's own 401 says 「I do not know this pairing」. A 403 is
      // somebody else's opinion about the request, whatever body it carries.
      final s = await _serve(403, jsonEncode(<String, Object?>{
        'ok': false,
        'error': 'PRESENCE_AUTH_REQUIRED',
      }));
      addTearDown(() => s.server.close(force: true));
      final PcPresenceReading r = await httpPcPresenceRead(
        Uri.parse('${s.url}/api/pc/presence'),
        'tok',
        const Duration(seconds: 3),
      );
      expect(r.pairingRejected, isFalse);
      expect(r.miss, PcPresenceMiss.unauthorized);
    });

    test('the trail says a refusal happened, so a field report can be checked', () async {
      final s = await _serve(401, jsonEncode(<String, Object?>{
        'ok': false,
        'error': 'PRESENCE_AUTH_REQUIRED',
      }));
      addTearDown(() => s.server.close(force: true));
      final String line = await _trailFor(Uri.parse('${s.url}/api/pc/presence'));
      expect(line, contains('pairing_rejected=true'));
      expect(line, contains('fault=status'));
      expect(line, contains('fault_code=401'));
    });
  });

  // ── the three faults that used to share one word ──────────────────────────
  //
  // REVERSE CONTROL (executed 2026-08-17, observed — not reasoned): remove
  // `fault:`/`faultCode:` from the `SocketException` and `TlsException` arms —
  // both still return `miss=network`, the line is still emitted, and it still
  // looks like a tended diagnostic. Observed — 10 pass / 1 FAIL:
  //   '🔴 a refused connection and a failed handshake are two different lines'
  //     Expected: contains 'fault=socket'
  //       Actual: '2026-08-17T04:01:43Z presence.unknown miss=network
  //                attempts=1 elapsed_ms=2029 endpoint_h=fc7435b55334'
  //       Which: does not contain 'fault=socket'
  // 🔴 That failure IS the card in one line: the trail is PRESENT and cannot
  // answer the question it exists for. Note which case did NOT fail — the 404
  // vs 502 one, because the status arm was left intact. Two independent fields,
  // two independent failures; a single test asserting 「the line is richer」
  // would have hidden that.
  // Restored, re-run: 11/11 green.
  group('what kind of failure it was', () {
    test('🔴 a refused connection and a failed handshake are two different lines', () async {
      final int dead = await _deadPort();
      final String refused = await _trailFor(Uri.parse('http://127.0.0.1:$dead/api/pc/presence'));
      expect(refused, contains('miss=network'));
      expect(refused, contains('fault=socket'));
      // The OS's own code rides along, because 「the name never resolved」 and
      // 「the connection was refused」 are both `socket` and only this number
      // tells them apart. Measured 2026-08-17 on Windows/dart 3.11.5: a refused
      // connection reports 1225. The assertion is deliberately 「there is a
      // number」 rather than 「the number is 1225」 — an errno is the platform's
      // to choose, and pinning this machine's value would make the test a claim
      // about Windows instead of about the trail.
      expect(RegExp(r'fault_code=\d+').hasMatch(refused), isTrue, reason: refused);

      // A plain listener spoken to over TLS: the handshake cannot complete.
      final ServerSocket plain = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      plain.listen((Socket sock) {
        sock.add(<int>[72, 84, 84, 80]); // "HTTP" — not a TLS record
        sock.close();
      });
      addTearDown(() => plain.close());
      final String tls = await _trailFor(
        Uri.parse('https://127.0.0.1:${plain.port}/api/pc/presence'),
      );
      expect(tls, contains('miss=network'));
      expect(tls, contains('fault=tls'));

      // 🔴 The whole point: before this card these two lines were byte-identical
      // apart from the elapsed time, and they call for completely different
      // fixes (「the relay is down」 vs 「a certificate or a pin is wrong」).
      expect(
        refused.replaceAll(RegExp(r'elapsed_ms=\d+'), ''),
        isNot(tls.replaceAll(RegExp(r'elapsed_ms=\d+'), '')),
      );
    });

    test('🔴 an old relay (404) and a middlebox (502) are two different lines', () async {
      final s404 = await _serve(404, 'not found', type: ContentType.text);
      final String old = await _trailFor(Uri.parse('${s404.url}/api/pc/presence'));
      await s404.server.close(force: true);

      final s502 = await _serve(502, 'bad gateway', type: ContentType.text);
      final String gateway = await _trailFor(Uri.parse('${s502.url}/api/pc/presence'));
      await s502.server.close(force: true);

      expect(old, contains('miss=notFound'));
      expect(old, contains('fault_code=404'));
      // 🔴 This is the one the class alone could never carry: EVERY non-200 that
      // is not 401/404 was the single word `serverError`. Measured on this
      // machine 2026-08-17 while writing this card: a nonexistent hostname did
      // not raise a SocketException at all — a middlebox answered 502. Without
      // the status in the trail, that incident is indistinguishable from a relay
      // returning 500 under load.
      expect(gateway, contains('miss=serverError'));
      expect(gateway, contains('fault_code=502'));
    });

    test('🔴 the fault fields never carry an address, a token or a message', () async {
      final int dead = await _deadPort();
      final String line = await _trailFor(Uri.parse('http://127.0.0.1:$dead/api/pc/presence'));
      // Addresses are user content in this repo (`verify/lint/no-lan-ip.mjs`)
      // and the trail is uploaded to the PC on request, so everything written
      // here leaves the phone. The exception's `message` is the tempting field
      // and the forbidden one: on a host-lookup failure it spells the host.
      expect(line, isNot(contains('127.0.0.1')));
      expect(line, isNot(contains('$dead')));
      expect(line, isNot(contains('fm_token')));
      expect(line, isNot(contains('SocketException')));
      expect(line, isNot(contains('errno')));
      expect(line, contains('endpoint_h='));
    });

    test('a class that already tells the whole story carries no fault at all', () async {
      // `malformed` needs no second field: a 200 whose body we could not believe
      // has exactly one shape. An empty `fault` is 「nothing to add」, not
      // 「nobody classified this」.
      final s = await _serve(200, 'this is not json', type: ContentType.text);
      addTearDown(() => s.server.close(force: true));
      final PcPresenceReading r = await httpPcPresenceRead(
        Uri.parse('${s.url}/api/pc/presence'),
        'tok',
        const Duration(seconds: 3),
      );
      expect(r.miss, PcPresenceMiss.malformed);
      expect(r.fault, isNull);
      expect(r.faultCode, isNull);
    });
  });

  // ── the per-attempt budget bounds an ATTEMPT ──────────────────────────────
  group('the per-attempt budget', () {
    test('🔴 bounds the whole attempt, not each stage of it separately', () async {
      // 🔴 THE DEFECT THIS PINS. `perAttemptTimeout` used to be applied
      // independently to connect, to send-and-await-headers, and to reading the
      // body — so a 3-second budget bounded an attempt at NINE seconds, and
      // every figure written about this path was arithmetic over a number that
      // did not bound what it named: `worstCase`, the instance list's 「≈10.2
      // s」, and the in-session poll's 「6.5 s, 35 % headroom inside a 10 s
      // tick」. That last one is load-bearing — it is the stated reason the
      // session budget has two attempts and not three.
      //
      // The server below is slow in TWO stages and comfortably inside the budget
      // in each: 400 ms to the headers, 400 ms more to the rest of the body,
      // against a 600 ms budget. Under the old per-stage code this SUCCEEDED
      // (400 < 600 twice); under one deadline it is a timeout — which is the
      // honest answer, because the caller asked to wait 600 ms and 800 ms
      // elapsed.
      final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((HttpRequest req) async {
        await Future<void>.delayed(const Duration(milliseconds: 400));
        req.response.headers.contentType = ContentType.json;
        // Flush the headers — the client's 「await the response」 stage ends
        // here, and its 「read the body」 stage begins.
        req.response.write('{"ok":true,"pc_id":"pc-1",');
        await req.response.flush();
        await Future<void>.delayed(const Duration(milliseconds: 400));
        req.response.write('"pc_online":true}');
        await req.response.close();
      });

      final Stopwatch sw = Stopwatch()..start();
      final PcPresenceReading r = await httpPcPresenceRead(
        Uri.parse('http://127.0.0.1:${server.port}/api/pc/presence'),
        'tok',
        const Duration(milliseconds: 600),
      );
      sw.stop();
      expect(r.miss, PcPresenceMiss.timeout);
      // …and it gave up at the budget rather than at some multiple of it. The
      // ceiling is generous (the point is the ORDER of magnitude, not a
      // stopwatch on a loaded CI box) but it is far below the 800 ms the old
      // shape would have spent, let alone the 1800 ms three stages permit.
      expect(sw.elapsedMilliseconds, lessThan(780), reason: '${sw.elapsedMilliseconds}ms');
    });

    test('a fast answer is untouched by the deadline', () async {
      // The negative control for the case above: the deadline must bound a slow
      // exchange without cutting a normal one, or the 「fix」 would be a new
      // failure mode wearing the same name.
      final s = await _serve(200, jsonEncode(<String, Object?>{
        'ok': true,
        'pc_id': 'pc-1',
        'pc_online': true,
      }));
      addTearDown(() => s.server.close(force: true));
      final PcPresenceReading r = await httpPcPresenceRead(
        Uri.parse('${s.url}/api/pc/presence'),
        'tok',
        const Duration(milliseconds: 600),
      );
      expect(r.presence, PcPresence.online);
      expect(r.pcId, 'pc-1');
    });
  });
}
