// SPEC-REF: Task C plan §9.5. One instance belongs to one channel/config generation.
// Discovery never calls a tool. Only the explicit invoke method can write remotely.
import 'mcp_transport.dart';

class McpClient {
  McpClient({required this.endpoint, required this.token, required this.onUnauthorized,
    McpTransport? transport,
  }) : _transport = transport ?? HttpMcpTransport();
  final Uri endpoint;
  final String? token;
  final Future<void> Function() onUnauthorized;
  final McpTransport _transport;
  String? _version;
  String? _session;
  bool _unauthorized = false;
  int _nextId = 0;
  static const String modernVersion = '2026-07-28';
  static const String legacyVersion = '2025-11-25';

  Future<McpReply> _send(String method, Map<String, Object?> params,
    {required String version, bool notification = false}) async {
    if (_unauthorized) return const McpReply(McpEvidence.notExecuted, 'reauthorization_required', status: 401);
    final McpReply reply = await _transport.request(endpoint: endpoint, token: token,
      session: _session, version: version, message: <String, Object?>{
        'jsonrpc': '2.0', if (!notification) 'id': ++_nextId, 'method': method,
        'params': <String, Object?>{...params, if (version == modernVersion) '_meta': <String, Object?>{
          'io.modelcontextprotocol/protocolVersion': version,
          'io.modelcontextprotocol/clientInfo': <String, Object?>{'name': 'FlowMic', 'version': '1'},
          'io.modelcontextprotocol/clientCapabilities': <String, Object?>{},
        }},
      });
    if (reply.status == 401) {
      _unauthorized = true;
      await onUnauthorized();
    }
    return reply;
  }

  Future<McpReply> discover() async {
    if (_version != null) return const McpReply(McpEvidence.result, 'cached_epoch');
    McpReply reply = await _send('server/discover', <String, Object?>{}, version: modernVersion);
    if (reply.code == -32022 && reply.supported.contains(modernVersion)) {
      // Retry exactly once with a version the peer explicitly advertised.
      reply = await _send('server/discover', <String, Object?>{}, version: modernVersion);
    }
    if (reply.succeeded) {
      final Object? versions = reply.result?['supportedVersions'];
      if (versions is! List || !versions.contains(modernVersion)) {
        return const McpReply(McpEvidence.notExecuted, 'protocol_unsupported');
      }
      _version = modernVersion;
      return reply;
    }
    final bool legacy = reply.code == -32601 || reply.code == -32000 ||
      <int>{404, 405}.contains(reply.status) ||
      (reply.code == -32022 && reply.supported.contains(legacyVersion));
    if (!legacy) return reply;
    reply = await _send('initialize', <String, Object?>{
      'protocolVersion': legacyVersion, 'capabilities': <String, Object?>{},
      'clientInfo': <String, Object?>{'name': 'FlowMic', 'version': '1'},
    }, version: legacyVersion);
    if (!reply.succeeded) return reply;
    if (reply.result?['protocolVersion'] != legacyVersion) {
      return const McpReply(McpEvidence.notExecuted, 'protocol_unsupported');
    }
    _session = reply.session;
    reply = await _send('notifications/initialized', <String, Object?>{}, version: legacyVersion, notification: true);
    if (reply.succeeded) _version = legacyVersion;
    return reply;
  }

  Future<McpReply> listTools() async {
    final McpReply discovery = await discover();
    if (!discovery.succeeded) return discovery;
    final List<Object?> tools = <Object?>[];
    final Set<String> names = <String>{};
    final Set<String> cursors = <String>{};
    String? cursor;
    for (int page = 0; page < 32; page++) {
      final McpReply reply = await _send('tools/list', <String, Object?>{
        'cursor': ?cursor,
      }, version: _version!);
      if (!reply.succeeded) {
        if (reply.status == 404 || reply.code == -32022) invalidate();
        return reply;
      }
      final Object? rows = reply.result?['tools'];
      if (rows is! List || tools.length + rows.length > 512) {
        return const McpReply(McpEvidence.notExecuted, 'schema_unsupported');
      }
      for (final Object? tool in rows) {
        if (tool is! Map || tool['name'] is! String || (tool['name'] as String).isEmpty ||
            (tool['name'] as String).length > 1024 || tool['inputSchema'] is! Map || !names.add(tool['name'] as String)) {
          return const McpReply(McpEvidence.notExecuted, 'schema_unsupported');
        }
        tools.add(tool);
      }
      final Object? next = reply.result?['nextCursor'];
      if (next == null) return McpReply(McpEvidence.result, 'tools_listed', result: <String, Object?>{'tools': tools});
      if (next is! String || next.isEmpty || !cursors.add(next)) break;
      cursor = next;
    }
    return const McpReply(McpEvidence.notExecuted, 'pagination_limit');
  }

  Future<McpReply> invoke(String name, Map<String, Object?> arguments) async {
    // Worker lists/validates first. Do not hide a discovery failure as a write attempt.
    if (_version == null) return const McpReply(McpEvidence.notExecuted, 'discovery_required');
    final McpReply reply = await _send('tools/call', <String, Object?>{
      'name': name, 'arguments': arguments,
    }, version: _version!);
    if (reply.code == -32022 || reply.status == 404) invalidate();
    return reply;
  }

  void invalidate() { _version = null; _session = null; }
}
