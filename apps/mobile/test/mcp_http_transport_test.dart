// Real dart:io HTTPS calls; SDK response bytes are replayed by a TLS listener.
// Faults injected here test the evidence boundary, not official interoperability.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../lib/src/mcp/mcp_client.dart';
import '../lib/src/mcp/mcp_transport.dart';
import 'mcp_client_test.dart' show captures;

void main() {
  late String cert;
  late SecurityContext serverContext;
  setUpAll(() async {
    final ProcessResult result = await Process.run('node', <String>[
      '--experimental-strip-types', 'test/support/mint_lan_tls_identity.mjs',
    ], runInShell: true);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    final Map<String, Object?> identity = (jsonDecode(result.stdout as String) as Map).cast<String, Object?>();
    cert = identity['certPem']! as String;
    serverContext = SecurityContext()
      ..useCertificateChainBytes(utf8.encode(cert))
      ..usePrivateKeyBytes(utf8.encode(identity['keyPem']! as String));
  });

  HttpMcpTransport transport({Duration deadline = const Duration(seconds: 3)}) => HttpMcpTransport(
    deadline: deadline,
    clientFactory: () => HttpClient()..badCertificateCallback =
      (X509Certificate certificate, String host, int port) => certificate.pem == cert,
  );

  Future<HttpServer> serve(Future<void> Function(HttpRequest) action) async {
    final HttpServer server = await HttpServer.bindSecure(InternetAddress.loopbackIPv4, 0, serverContext);
    server.listen((HttpRequest request) { unawaited(action(request)); }, onError: (Object _) {});
    addTearDown(() => server.close(force: true));
    return server;
  }

  Future<McpReply> call(HttpMcpTransport wire, Uri endpoint) => wire.request(
    endpoint: endpoint, message: <String, Object?>{'jsonrpc': '2.0', 'id': 7,
      'method': 'tools/call', 'params': <String, Object?>{'name': 'submit', 'arguments': <String, Object?>{}}},
    version: McpClient.modernVersion, token: null, session: null,
  );

  test('production HTTPS client replays real SDK discovery, tool and SSE results', () async {
    final Map<String, Map<String, Object?>> fixtures = captures();
    final List<String> names = <String>['modern-discover', 'modern-tools', 'modern-sse'];
    final List<String> methods = <String>[];
    final HttpServer server = await serve((HttpRequest request) async {
      final Map<String, Object?> body = (jsonDecode(await utf8.decoder.bind(request).join()) as Map).cast<String, Object?>();
      methods.add(body['method']! as String);
      expect(request.headers.value('Mcp-Method'), body['method']);
      expect(request.headers.value('MCP-Protocol-Version'), McpClient.modernVersion);
      if (body['method'] == 'tools/call') expect(request.headers.value('Mcp-Name'), 'submit');
      final Map<String, Object?> row = fixtures[names.removeAt(0)]!;
      final Map<String, Object?> recorded = (row['request']! as Map).cast<String, Object?>();
      final Map<String, String> headers = (row['headers']! as Map).cast<String, String>();
      request.response.headers.set('content-type', headers['content-type']!);
      final String response = (row['body']! as String).replaceAll('"id":${recorded['id']}', '"id":${body['id']}');
      // Small chunks exercise incremental SSE framing through the real stack.
      for (final int byte in utf8.encode(response)) { request.response.add(<int>[byte]); }
      await request.response.close();
    });
    final McpClient connection = McpClient(endpoint: Uri.parse('https://127.0.0.1:${server.port}/secret-path'),
      token: null, onUnauthorized: () async {}, transport: transport());
    expect((await connection.listTools()).succeeded, true);
    expect(methods, <String>['server/discover', 'tools/list']);
    expect((await connection.invoke('submit', <String, Object?>{})).reason, 'tool_result');
  });

  test('post-body timeout is unknown, never retryable or sent', () async {
    final Completer<void> received = Completer<void>();
    final HttpServer server = await serve((HttpRequest request) async {
      await request.drain<void>(); received.complete();
      // Deliberately keep the response open until client deadline closes it.
    });
    final McpReply reply = await call(transport(deadline: const Duration(milliseconds: 300)),
      Uri.parse('https://127.0.0.1:${server.port}/secret'));
    expect(received.isCompleted, true);
    expect(reply.evidence, McpEvidence.unknown);
  });

  test('post-body disconnect and incomplete SSE result are unknown', () async {
    final HttpServer server = await serve((HttpRequest request) async {
      await request.drain<void>();
      request.response.headers.set('Content-Type', 'text/event-stream');
      request.response.write('data: {"jsonrpc":"2.0","id":7,"result":');
      await request.response.close();
    });
    expect((await call(transport(), Uri.parse('https://127.0.0.1:${server.port}/'))).evidence, McpEvidence.unknown);
  });

  test('TLS trust refusal precedes any request body', () async {
    int requests = 0;
    final HttpServer server = await serve((HttpRequest request) async { requests++; await request.response.close(); });
    final McpReply reply = await call(HttpMcpTransport(), Uri.parse('https://127.0.0.1:${server.port}/'));
    expect(reply.evidence, McpEvidence.notExecuted);
    expect(reply.reason, 'transport_before_send');
    expect(requests, 0);
  });

  test('DNS failure precedes body transmission', () async {
    final McpReply reply = await call(transport(), Uri.parse('https://flowmic-fixture.invalid/'));
    expect(reply.evidence, McpEvidence.notExecuted);
  });

  test('connection failure precedes body transmission', () async {
    final ServerSocket reservation = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final int port = reservation.port;
    await reservation.close();
    final McpReply reply = await call(transport(), Uri.parse('https://127.0.0.1:$port/'));
    expect(reply.evidence, McpEvidence.notExecuted);
  });

  test('non-HTTPS is refused before creating an HTTP client', () async {
    final HttpMcpTransport wire = HttpMcpTransport(clientFactory: () => throw StateError('must not construct'));
    expect((await call(wire, Uri.parse('http://fixture.invalid/'))).reason, 'https_required');
  });
}
