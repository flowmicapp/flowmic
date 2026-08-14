// The phone's diagnostic trail and its upload (owner 2026-07-29:「手机拿日志
// 不方便」).
//
// Two things are pinned, and they are the two that decide whether the feature is
// worth having:
//   1. the trail is BOUNDED and ordered, and a line never carries a newline that
//      would break the one-event-per-line contract the PC log relies on;
//   2. every upload outcome is DISTINGUISHABLE — an upload that quietly did
//      nothing would make the log un-trustable, which is worse than no feature.
//
// Plus the anti-façade check this repo demands of any new capability: the
// production emit path really writes into the trail (compose_gate), so the trail
// is not an empty box with a nice API.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/generated/flowmic_events.g.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/diag/diag_upload.dart';
import 'package:flowmic/src/session/compose_gate.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fakes.dart';

void main() {
  setUp(() {
    DiagLog.instance.clear();
    DiagLog.instance.clock = () => DateTime.utc(2026, 7, 29, 13);
  });

  test('the trail is bounded, ordered, and one event per line', () {
    for (int i = 0; i < kDiagCapacity + 25; i++) {
      diag('probe.tick', <String, Object?>{'i': i});
    }
    final List<String> lines = DiagLog.instance.snapshot();
    expect(lines, hasLength(kDiagCapacity), reason: 'bounded');
    expect(lines.first, contains('i=25'), reason: 'oldest dropped first');
    expect(lines.last, contains('i=${kDiagCapacity + 24}'));
    expect(lines.every((String l) => !l.contains('\n')), isTrue);
  });

  test('a field containing a newline cannot break the line format', () {
    diag('emit.inject', <String, Object?>{'detail': 'line1\nline2'});
    expect(DiagLog.instance.snapshot().single, contains(r'detail=line1\nline2'));
    expect(DiagLog.instance.snapshot().single.contains('\n'), isFalse);
  });

  test('the PRODUCTION emit path writes into the trail (no façade)', () {
    final FakeSocketTransport transport = FakeSocketTransport();
    final ComposeGate gate = ComposeGate(transport: transport);
    final bool ok = gate.emitInject(
      const InjectRequestPayload(
        text: '',
        source: InjectSource.image,
        injectOrigin: InjectOrigin.live,
        requestId: 'i7-42',
        entryId: 'loc_x_i7-42',
        imageB64: 'QUJDRA==',
        imageMime: 'image/png',
      ),
    );
    expect(ok, isTrue);
    expect(transport.emittedNames, contains(FlowMicEvents.injectRequest));
    final String line = DiagLog.instance.snapshot().single;
    expect(line, contains('emit.inject'));
    expect(line, contains('request_id=i7-42'));
    expect(line, contains('image_b64_chars=8'));
    expect(line, contains('handed_to_socket=true'));
    // The picture's BYTES never enter the trail — only their size.
    expect(line.contains('QUJDRA=='), isFalse);
  });

  test('a refused emit is recorded as handed_to_socket=false', () {
    final FakeSocketTransport transport = FakeSocketTransport()..failEmits = true;
    final ComposeGate gate = ComposeGate(transport: transport);
    expect(
      gate.emitInject(
        const InjectRequestPayload(
          text: 'hi',
          source: InjectSource.manual,
          injectOrigin: InjectOrigin.live,
          requestId: 'm1-1',
        ),
      ),
      isFalse,
    );
    expect(DiagLog.instance.snapshot().single, contains('handed_to_socket=false'));
  });

  group('upload', () {
    test('delivered reports the line count it actually sent', () async {
      diag('a');
      diag('b');
      late String sentBody;
      String? seenToken;
      final DiagUploadResult r = await uploadDiagnostics(
        endpoint: 'http://192.168.1.5:41879',
        deviceLabel: 'Phone-1234',
        token: 'pair-tok-aaaaaaaaaaaaaaaaaaaaaaaa',
        poster: (Uri url, String body, String? token) async {
          expect(url.toString(), 'http://192.168.1.5:41879/api/diag/mobile');
          sentBody = body;
          seenToken = token;
          return (status: 200, body: '{"ok":true,"lines":2,"authenticated":true}');
        },
      );
      expect(r.outcome, DiagUploadOutcome.delivered);
      expect(r.lines, 2);
      expect(sentBody, contains('Phone-1234'));
      expect(seenToken, 'pair-tok-aaaaaaaaaaaaaaaaaaaaaaaa');
    });

    test('null/blank token is passed through — upload still goes (unverified)', () async {
      // Red line: no token must NOT suppress the upload. The PC marks the block
      // `[phone-unverified]`; refusing here would hide the half we need most.
      diag('a');
      for (final String? tok in <String?>[null, '', '   ']) {
        String? seen;
        final DiagUploadResult r = await uploadDiagnostics(
          endpoint: 'http://192.168.1.5:41879',
          deviceLabel: 'p',
          token: tok,
          poster: (Uri url, String body, String? token) async {
            seen = token;
            return (status: 200, body: '{"ok":true,"authenticated":false}');
          },
        );
        expect(r.outcome, DiagUploadOutcome.delivered, reason: 'token=$tok');
        expect(seen, tok);
      }
    });

    test('production _post sets Bearer only for a non-empty token; server body '
        'carries authenticated', () async {
      // Real HTTP round-trip (local listener), not a fake poster — proves the
      // dart:io path emits Authorization the way diag-routes.ts expects.
      HttpServer? server;
      String? authHeader;
      String? responseBody;
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() async {
        await server?.close(force: true);
      });
      server.listen((HttpRequest req) async {
        authHeader = req.headers.value(HttpHeaders.authorizationHeader);
        // Mirror the server's 200 shape (diag-routes.ts) so the delivery can
        // cite a real `authenticated` field off the wire.
        responseBody = jsonEncode(<String, Object?>{
          'ok': true,
          'lines': 1,
          'authenticated': authHeader != null && authHeader!.startsWith('Bearer '),
        });
        req.response
          ..statusCode = 200
          ..headers.contentType = ContentType.json
          ..write(responseBody);
        await req.response.close();
      });

      diag('wire');
      final String base = 'http://127.0.0.1:${server.port}';
      final DiagUploadResult withTok = await uploadDiagnostics(
        endpoint: base,
        deviceLabel: 'Phone',
        token: 'pair-tok-bbbbbbbbbbbbbbbbbbbbbbbb',
      );
      expect(withTok.outcome, DiagUploadOutcome.delivered);
      expect(authHeader, 'Bearer pair-tok-bbbbbbbbbbbbbbbbbbbbbbbb');
      expect(responseBody, contains('"authenticated":true'));

      authHeader = 'SENTINEL';
      DiagLog.instance.clear();
      diag('wire2');
      final DiagUploadResult noTok = await uploadDiagnostics(
        endpoint: base,
        deviceLabel: 'Phone',
        token: null,
      );
      expect(noTok.outcome, DiagUploadOutcome.delivered);
      expect(authHeader, isNull, reason: 'blank/missing must omit the header');
      expect(responseBody, contains('"authenticated":false'));
    });

    test('every failure mode is its own outcome, never a generic failure', () async {
      diag('a');
      Future<DiagUploadResult> upload(int status, {String? endpoint = 'http://pc:41879'}) =>
          uploadDiagnostics(
            endpoint: endpoint,
            deviceLabel: 'p',
            token: null,
            poster: (Uri url, String body, String? token) async =>
                (status: status, body: '{"error":"x"}'),
          );
      expect((await upload(503)).outcome, DiagUploadOutcome.noSink);
      expect((await upload(413)).outcome, DiagUploadOutcome.refused);
      expect((await upload(200, endpoint: '')).outcome, DiagUploadOutcome.noEndpoint);

      final DiagUploadResult dead = await uploadDiagnostics(
        endpoint: 'http://pc:41879',
        deviceLabel: 'p',
        token: null,
        poster: (Uri url, String body, String? token) async =>
            throw const SocketExceptionStub(),
      );
      expect(dead.outcome, DiagUploadOutcome.unreachable);
      expect(dead.detail, isNotNull, reason: 'the raw reason rides along');

      DiagLog.instance.clear();
      final DiagUploadResult empty = await uploadDiagnostics(
        endpoint: 'http://pc:41879',
        deviceLabel: 'p',
        token: null,
        poster: (Uri url, String body, String? token) async =>
            (status: 200, body: '{}'),
      );
      expect(empty.outcome, DiagUploadOutcome.empty);
    });
  });
}

class SocketExceptionStub implements Exception {
  const SocketExceptionStub();
  @override
  String toString() => 'connection refused';
}
