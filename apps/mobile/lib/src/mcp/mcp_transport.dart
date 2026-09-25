// SPEC-REF: Task C implementation plan §9.5. No exception text, endpoint path,
// body, or credentials escape this boundary. HTTP success is not tool success.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

enum McpEvidence { result, notExecuted, unknown, rejected }

class McpReply {
  const McpReply(this.evidence, this.reason, {
    this.result, this.status, this.code, this.supported = const <String>[],
    this.retryAfter, this.session, this.oauthChallenge = false, this.field,
  });
  final McpEvidence evidence;
  final String reason;
  final Map<String, Object?>? result;
  final int? status;
  final int? code;
  final List<String> supported;
  final Duration? retryAfter;
  final String? session;
  final bool oauthChallenge;
  // Local mapping diagnostic only, never a remote argument or credential value.
  final String? field;
  bool get succeeded => evidence == McpEvidence.result;
}

abstract interface class McpTransport {
  Future<McpReply> request({
    required Uri endpoint,
    required Map<String, Object?> message,
    required String version,
    required String? token,
    required String? session,
  });
}

/// One request owns one client so timeout/cancellation closes every stream.
/// Test clients may trust their private CA; production always uses OS trust.
class HttpMcpTransport implements McpTransport {
  HttpMcpTransport({HttpClient Function()? clientFactory,
    this.deadline = const Duration(seconds: 25),
  }) : _clientFactory = clientFactory ?? HttpClient.new;
  final HttpClient Function() _clientFactory;
  final Duration deadline;
  static const int maxResponseBytes = 2 * 1024 * 1024;

  @override
  Future<McpReply> request({required Uri endpoint,
    required Map<String, Object?> message, required String version,
    required String? token, required String? session,
  }) async {
    if (endpoint.scheme != 'https' || endpoint.host.isEmpty ||
        endpoint.userInfo.isNotEmpty || endpoint.hasFragment) {
      return const McpReply(McpEvidence.notExecuted, 'https_required');
    }
    final HttpClient client = _clientFactory();
    bool bodyStarted = false;
    final Timer timer = Timer(deadline, () => client.close(force: true));
    try {
      // Failure before postUrl resolves means DNS/connect/TLS did not finish.
      final HttpClientRequest request = await client.postUrl(endpoint).timeout(deadline);
      request.followRedirects = false;
      request.headers.contentType = ContentType.json;
      request.headers.set('Accept', 'application/json, text/event-stream');
      request.headers.set('MCP-Protocol-Version', version);
      request.headers.set('Mcp-Method', message['method']!);
      final Object? params = message['params'];
      if (params is Map && params['name'] is String) {
        final String name = params['name'] as String;
        // Modern MCP requires the name header; encode non-ASCII sentinel names.
        request.headers.set('Mcp-Name', RegExp(r'^[\x21-\x7e]+$').hasMatch(name) &&
          !name.startsWith('=?base64?') ? name : '=?base64?${base64Encode(utf8.encode(name))}?=');
      }
      if (token != null && token.isNotEmpty) request.headers.set('Authorization', 'Bearer $token');
      if (session != null) request.headers.set('Mcp-Session-Id', session);
      final List<int> bytes = utf8.encode(jsonEncode(message));
      request.contentLength = bytes.length;
      bodyStarted = true;
      request.add(bytes);
      final HttpClientResponse response = await request.close();
      final Map<String, String> headers = <String, String>{};
      response.headers.forEach((String key, List<String> values) => headers[key.toLowerCase()] = values.join(', '));
      // Status evidence is sufficient even if a rejection body never finishes.
      final McpReply? statusReply = classifyMcpStatus(response.statusCode, headers);
      if (statusReply != null) return statusReply;
      final List<int> body = <int>[];
      await for (final List<int> chunk in response) {
        if (body.length + chunk.length > maxResponseBytes) {
          return const McpReply(McpEvidence.unknown, 'response_limit');
        }
        body.addAll(chunk);
        // A complete SSE result is authoritative without waiting for EOF.
        if ((headers['content-type'] ?? '').startsWith('text/event-stream')) {
          final String text = utf8.decode(body, allowMalformed: true);
          final McpReply? reply = _sseReply(text, message['id'], headers,
            toolCall: message['method'] == 'tools/call');
          if (reply != null) return reply;
        }
      }
      return decodeMcpReply(status: response.statusCode, headers: headers,
        body: utf8.decode(body), id: message['id'], toolCall: message['method'] == 'tools/call');
    } on Object {
      // Never expose error.toString(): HttpClient errors can contain the URI.
      return McpReply(bodyStarted ? McpEvidence.unknown : McpEvidence.notExecuted,
        bodyStarted ? 'response_unknown' : 'transport_before_send');
    } finally {
      timer.cancel(); client.close(force: true);
    }
  }
}

McpReply? classifyMcpStatus(int status, Map<String, String> headers) {
  if (<int>{401, 403, 404, 405, 415, 429}.contains(status)) {
    return McpReply(McpEvidence.notExecuted, 'remote_http', status: status,
      retryAfter: parseMcpRetryAfter(headers['retry-after']),
      oauthChallenge: (headers['www-authenticate'] ?? '').contains('resource_metadata'));
  }
  if (status >= 500 || (status >= 300 && status < 400)) {
    return McpReply(McpEvidence.unknown, 'response_unknown', status: status);
  }
  return null;
}

Duration? parseMcpRetryAfter(String? value) {
  if (value == null) return null;
  final int? seconds = int.tryParse(value);
  if (seconds != null) return Duration(seconds: seconds < 0 ? 0 : seconds);
  try {
    final Duration wait = HttpDate.parse(value).difference(DateTime.now().toUtc());
    return wait.isNegative ? Duration.zero : wait;
  } on Object { return null; }
}

McpReply decodeMcpReply({required int status, required Map<String, String> headers,
  required String body, required Object? id, required bool toolCall,
}) {
  final McpReply? statusReply = classifyMcpStatus(status, headers);
  if (statusReply != null) return statusReply;
  if (id == null && status == 202) return const McpReply(McpEvidence.result, 'notification_accepted');
  if ((headers['content-type'] ?? '').startsWith('text/event-stream')) {
    return _sseReply(body, id, headers, toolCall: toolCall) ??
      const McpReply(McpEvidence.unknown, 'response_unknown');
  }
  try {
    return _rpcReply(jsonDecode(body), id, headers, toolCall: toolCall, status: status);
  } on Object { return const McpReply(McpEvidence.unknown, 'response_unknown'); }
}

McpReply? _sseReply(String text, Object? id, Map<String, String> headers, {bool toolCall = true}) {
  final List<String> events = text.replaceAll('\r\n', '\n').split('\n\n');
  // The trailing event is incomplete until its terminating empty line arrives.
  for (final String event in events.take(events.length - 1)) {
    final String data = event.split('\n').where((String line) => line.startsWith('data:'))
      .map((String line) => line.substring(5).replaceFirst(RegExp(r'^ '), '')).join('\n');
    if (data.isEmpty) continue;
    try {
      final Object? value = jsonDecode(data);
      if (value is Map && value['method'] is String && !value.containsKey('id')) continue;
      return _rpcReply(value, id, headers, toolCall: toolCall, status: 200);
    } on Object { return const McpReply(McpEvidence.unknown, 'response_unknown'); }
  }
  return null;
}

McpReply _rpcReply(Object? value, Object? id, Map<String, String> headers,
  {required bool toolCall, required int status}) {
  // Official legacy SDK rejects pre-initialize discovery with id:null/-32000.
  // This hint permits a read-only legacy handshake, never a write retry/success.
  if (!toolCall && status == 400 && value is Map && value['id'] == null &&
      value['jsonrpc'] == '2.0' && value['error'] is Map &&
      (value['error'] as Map)['code'] == -32000) {
    return const McpReply(McpEvidence.unknown, 'legacy_discovery_hint', code: -32000);
  }
  if (value is! Map || value['jsonrpc'] != '2.0' || id == null || value['id'] != id ||
      value.containsKey('result') == value.containsKey('error')) {
    return const McpReply(McpEvidence.unknown, 'response_unknown');
  }
  final Object? error = value['error'];
  if (error is Map) {
    final Object? code = error['code'];
    final Object? data = error['data'];
    final Object? supported = data is Map ? data['supported'] : null;
    return McpReply(<int>{-32601, -32602, -32022}.contains(code) ?
      McpEvidence.notExecuted : McpEvidence.unknown, 'remote_protocol',
      status: status, code: code is int ? code : null,
      supported: supported is List ? supported.whereType<String>().toList() : const <String>[]);
  }
  final Object? raw = value['result'];
  if (raw is! Map || status < 200 || status >= 300) {
    return const McpReply(McpEvidence.unknown, 'response_unknown');
  }
  final Map<String, Object?> result = raw.cast<String, Object?>();
  if (toolCall) {
    if (result['isError'] != null && result['isError'] is! bool) {
      return const McpReply(McpEvidence.unknown, 'response_unknown');
    }
    if (result['isError'] == true) return const McpReply(McpEvidence.rejected, 'remote_tool');
    if (result['content'] is! List || (result['resultType'] != null && result['resultType'] != 'complete')) {
      return const McpReply(McpEvidence.unknown, 'response_unknown');
    }
  }
  return McpReply(McpEvidence.result, toolCall ? 'tool_result' : 'read_result',
    result: result, session: headers['mcp-session-id']);
}
