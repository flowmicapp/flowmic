// A complete MCP endpoint may itself be a credential. It lives beside the
// Bearer and secret fixed values in platform secure storage, never in SQLite,
// diagnostics, portable settings, or a collapsed channel summary.
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class McpSecrets {
  const McpSecrets({required this.endpoint, required this.token, required this.fixed});
  final Uri endpoint;
  final String? token;
  final Map<String, Object?> fixed;

  Map<String, Object?> toSecureJson() => <String, Object?>{
    'endpoint': endpoint.toString(), 'token': token, 'fixed': fixed,
  };
}

abstract interface class McpSecretStore {
  Future<McpSecrets?> read(String id, int generation);
  Future<void> write(String id, int generation, McpSecrets secrets);
  Future<void> remove(String id, int generation);
  Future<void> prune(String id, {int? keepGeneration});
}

class SecureMcpSecretStore implements McpSecretStore {
  const SecureMcpSecretStore([this.storage = const FlutterSecureStorage()]);
  final FlutterSecureStorage storage;
  String _key(String id, int generation) => 'flowmic.mcp.secrets.v1.$id.$generation';

  @override
  Future<McpSecrets?> read(String id, int generation) async {
    final String? value = await storage.read(key: _key(id, generation));
    if (value == null) return null;
    // Corruption is a named failure, not an invented unauthenticated endpoint.
    try {
      final Map<dynamic, dynamic> raw = jsonDecode(value) as Map;
      final Uri endpoint = Uri.parse(raw['endpoint'] as String);
      validateMcpEndpoint(endpoint);
      return McpSecrets(endpoint: endpoint, token: raw['token'] as String?,
        fixed: (raw['fixed'] as Map).cast<String, Object?>());
    } on Object { throw StateError('credential_unavailable'); }
  }

  @override
  Future<void> write(String id, int generation, McpSecrets secrets) async {
    validateMcpEndpoint(secrets.endpoint);
    final String value = jsonEncode(secrets.toSecureJson());
    if (utf8.encode(value).length > 256 * 1024) throw StateError('credential_limit');
    await storage.write(key: _key(id, generation), value: value);
    if (await storage.read(key: _key(id, generation)) != value) {
      throw StateError('credential_unavailable');
    }
  }

  @override
  Future<void> remove(String id, int generation) => storage.delete(key: _key(id, generation));

  @override
  Future<void> prune(String id, {int? keepGeneration}) async {
    final String prefix = 'flowmic.mcp.secrets.v1.$id.';
    final String? keep = keepGeneration == null ? null : _key(id, keepGeneration);
    for (final String key in (await storage.readAll()).keys.toList()) {
      if (key.startsWith(prefix) && key != keep) await storage.delete(key: key);
    }
  }
}

void validateMcpEndpoint(Uri endpoint) {
  if (endpoint.scheme != 'https' || endpoint.host.isEmpty ||
      endpoint.userInfo.isNotEmpty || endpoint.hasFragment || endpoint.toString().length > 8192) {
    throw StateError('https_required');
  }
}

/// Called before persistence. Even a caller that has put a value beside a
/// secret marker cannot accidentally serialize that value into a backup.
Map<String, Object?> publicMcpMapping(Map<String, Object?> mapping) => <String, Object?>{
  for (final MapEntry<String, Object?> entry in mapping.entries)
    entry.key: entry.value is Map && (entry.value! as Map)['secret'] == true
      ? <String, Object?>{'source': 'fixed', 'secret': true}
      : entry.value,
};
