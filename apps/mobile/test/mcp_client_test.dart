// Actual official SDK captures are the protocol ruler. Fault mutations below
// test classification only; they are deliberately not interoperability evidence.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:flowmic/src/mcp/mcp_client.dart';
import 'package:flowmic/src/mcp/mcp_transport.dart';

Map<String, Map<String, Object?>> captures() {
  final Map<String, Object?> doc = (jsonDecode(File('test/fixtures/mcp_sdk_responses.json').readAsStringSync()) as Map).cast<String, Object?>();
  return <String, Map<String, Object?>>{
    for (final Object? raw in doc['exchanges']! as List)
      (raw! as Map)['name'] as String: (raw as Map).cast<String, Object?>(),
  };
}

class ReplayTransport implements McpTransport {
  ReplayTransport(this.names);
  final List<String> names;
  final Map<String, Map<String, Object?>> fixtures = captures();
  final List<String> methods = <String>[];
  final List<String?> sessions = <String?>[];
  @override
  Future<McpReply> request({required Uri endpoint, required Map<String, Object?> message,
    required String version, required String? token, required String? session}) async {
    methods.add(message['method']! as String);
    sessions.add(session);
    final Map<String, Object?> row = fixtures[names.removeAt(0)]!;
    final Map<String, Object?> expected = (row['request']! as Map).cast<String, Object?>();
    expect(message['method'], expected['method']);
    final Map<String, String> headers = (row['headers']! as Map).cast<String, String>();
    String body = row['body']! as String;
    // Only correlation ids vary between sessions; leave SDK result bytes intact.
    body = body.replaceAll('"id":${expected['id']}', '"id":${jsonEncode(message['id'])}');
    if (message['method'] == 'tools/list') {
      expect((message['params']! as Map)['cursor'], (expected['params']! as Map)['cursor']);
    }
    return decodeMcpReply(status: row['status']! as int, headers: headers,
      body: body, id: message['id'], toolCall: message['method'] == 'tools/call');
  }
}

McpClient client(ReplayTransport transport, {Future<void> Function()? unauthorized}) => McpClient(
  endpoint: Uri.parse('https://fixture.invalid/path-secret'), token: null,
  transport: transport, onUnauthorized: unauthorized ?? () async {},
);

void main() {
  test('malformed or duplicate tool names cannot reach a selection control', () async {
    for (final Object? invalid in <Object?>[null, <String, Object?>{'name': 4}, <String, Object?>{'name': 'submit', 'inputSchema': <String, Object?>{}}]) {
      final ReplayTransport transport = ReplayTransport(<String>['modern-discover', 'modern-tools']);
      final Map<String, Object?> fixture = transport.fixtures['modern-tools']!;
      final Map<dynamic, dynamic> body = jsonDecode(fixture['body']! as String) as Map;
      ((body['result'] as Map)['tools'] as List).add(invalid);
      fixture['body'] = jsonEncode(body);
      expect((await client(transport).listTools()).reason, 'schema_unsupported');
    }
  });
  test('read-only connection test uses discovery and listing, never tools/call', () async {
    final ReplayTransport transport = ReplayTransport(<String>['modern-discover', 'modern-tools', 'modern-tools']);
    final McpClient connection = client(transport);
    final McpReply reply = await connection.listTools();
    expect(reply.succeeded, true);
    expect((reply.result!['tools']! as List).length, 2);
    await connection.listTools();
    expect(transport.methods, <String>['server/discover', 'tools/list', 'tools/list']);
    expect(transport.methods, isNot(contains('tools/call')));
  });

  test('legacy SDK handshake carries session and follows nextCursor', () async {
    final ReplayTransport transport = ReplayTransport(<String>[
      'legacy-discover-probe', 'legacy-initialize', 'legacy-initialized',
      'legacy-tools-page-one', 'legacy-tools-page-two',
    ]);
    final McpReply reply = await client(transport).listTools();
    expect(reply.succeeded, true);
    expect((reply.result!['tools']! as List).length, 2);
    expect(transport.sessions.skip(2), everyElement('fixture-session'));
    expect(transport.methods, isNot(contains('tools/call')));
  });

  test('unsupported revision retries supported version once, not indefinitely', () async {
    final ReplayTransport transport = ReplayTransport(<String>[
      'unsupported-version', 'unsupported-version',
    ]);
    final McpReply reply = await client(transport).discover();
    expect(reply.code, -32022);
    expect(transport.methods.length, 2);
  });

  test('401 stops all later requests on this configuration generation', () async {
    int unauthorized = 0;
    final ReplayTransport transport = ReplayTransport(<String>['auth-required']);
    final McpClient connection = client(transport, unauthorized: () async { unauthorized++; });
    expect((await connection.listTools()).status, 401);
    expect((await connection.listTools()).status, 401);
    expect(transport.methods.length, 1);
    expect(unauthorized, 1);
  });

  test('official success, isError and SSE results have distinct evidence', () async {
    final ReplayTransport transport = ReplayTransport(<String>[
      'modern-discover', 'modern-success', 'modern-refusal', 'modern-sse',
    ]);
    final McpClient connection = client(transport);
    expect((await connection.discover()).succeeded, true);
    expect((await connection.invoke('submit', <String, Object?>{})).reason, 'tool_result');
    expect((await connection.invoke('refuse', <String, Object?>{})).evidence, McpEvidence.rejected);
    expect((await connection.invoke('submit', <String, Object?>{})).reason, 'tool_result');
  });

  test('HTTP status and malformed responses pin the unexecuted evidence table', () {
    for (final int status in <int>[401, 403, 404, 405, 415, 429]) {
      final McpReply reply = decodeMcpReply(status: status, headers: <String, String>{'retry-after': '120'},
        body: '', id: 1, toolCall: true);
      expect(reply.evidence, McpEvidence.notExecuted, reason: 'HTTP $status');
      expect(reply.retryAfter, const Duration(seconds: 120));
    }
    for (final int status in <int>[500, 502, 503, 599]) {
      expect(decodeMcpReply(status: status, headers: <String, String>{}, body: '', id: 1, toolCall: true).evidence,
        McpEvidence.unknown, reason: 'HTTP $status');
    }
    for (final String body in <String>[
      'not-json', '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":1,"result":{"content":[],"isError":"false"}}',
    ]) {
      expect(decodeMcpReply(status: 200, headers: <String, String>{}, body: body, id: 1, toolCall: true).evidence,
        McpEvidence.unknown, reason: body);
    }
    for (final int code in <int>[-32601, -32602, -32022]) {
      expect(decodeMcpReply(status: 400, headers: <String, String>{},
        body: jsonEncode(<String, Object?>{'jsonrpc': '2.0', 'id': 1, 'error': <String, Object?>{'code': code}}),
        id: 1, toolCall: true).evidence, McpEvidence.notExecuted);
    }
  });
}
