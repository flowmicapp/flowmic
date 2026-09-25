// Device-local settings backup only. Endpoint paths, credentials, session ids,
// consent and delivery history are never portable configuration.
import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import 'mcp_channel.dart';
import 'mcp_mapping.dart';
import 'mcp_secrets.dart';
import 'mcp_store.dart';

abstract interface class McpSettingsPort {
  Future<List<Map<String, Object?>>> exportChannels();
  Future<void> importChannels(Object? value);
}

class McpSettingsBackup implements McpSettingsPort {
  const McpSettingsBackup({required this.store, required this.secrets});
  final McpStore? store;
  final McpSecretStore secrets;

  @override
  Future<List<Map<String, Object?>>> exportChannels() async {
    if (store == null) return <Map<String, Object?>>[];
    // A ledger write failure stops submissions, not a read of portable public
    // configuration. A failed read still fails export honestly.
    final List<McpChannel> channels = (await store!.db.query('mcp_channels')).map(McpChannel.fromRow).toList();
    return <Map<String, Object?>>[
      for (final McpChannel c in channels) <String, Object?>{
        'id': c.id, 'name': c.name, 'host_hint': c.hostHint, 'tool': c.tool,
        'input_schema': c.inputSchema, 'mapping': publicMcpMapping(c.mapping),
      },
    ];
  }

  @override
  Future<void> importChannels(Object? value) async {
    if (store == null || !store!.available) throw StateError('storage_unavailable');
    if (value is! List || value.length > 3 || utf8.encode(jsonEncode(value)).length > 2 * 1024 * 1024) {
      throw StateError('mcp_configuration_invalid');
    }
    final List<McpChannel> incoming = <McpChannel>[];
    final Set<String> ids = <String>{};
    for (final Object? raw in value) {
      if (raw is! Map || raw['id'] is! String || !RegExp(r'^[a-f0-9]{32}$').hasMatch(raw['id'] as String) ||
          !ids.add(raw['id'] as String) || raw['name'] is! String || raw['host_hint'] is! String ||
          raw['tool'] is! String || raw['input_schema'] is! Map || raw['mapping'] is! Map) {
        throw StateError('mcp_configuration_invalid');
      }
      final String host = raw['host_hint'] as String;
      final Uri? parsed = Uri.tryParse('https://${host.contains(':') && !host.startsWith('[') ? '[$host]' : host}');
      if (host.isEmpty || host.length > 253 || parsed == null || parsed.host != host || parsed.hasPort || parsed.hasQuery || parsed.hasFragment ||
          parsed.userInfo.isNotEmpty || parsed.path.isNotEmpty || (raw['name'] as String).length > 128 ||
          (raw['tool'] as String).length > 1024) {
        throw StateError('mcp_configuration_invalid');
      }
      final Map<String, Object?> schema = (raw['input_schema'] as Map).cast<String, Object?>();
      final Map<String, Object?> mapping = publicMcpMapping((raw['mapping'] as Map).cast<String, Object?>());
      McpMapping(schema, mapping, requireComplete: false);
      incoming.add(McpChannel(id: raw['id'] as String, name: raw['name'] as String,
        hostHint: host, tool: raw['tool'] as String, inputSchema: schema, mapping: mapping,
        generation: 1, authorized: false, paused: false, state: McpChannelState.saved));
    }
    // Validate every channel before writing any; preserve channels not named in
    // the file, refuse a union above three instead of silently deleting one.
    await store!.db.transaction((Transaction txn) async {
      final List<Map<String, Object?>> old = await txn.query('mcp_channels');
      if (<String>{...old.map((Map<String, Object?> r) => r['id']! as String), ...ids}.length > 3) {
        throw StateError('mcp_configuration_invalid');
      }
      for (final McpChannel channel in incoming) {
        final List<Map<String, Object?>> previous = old.where((Map<String, Object?> r) => r['id'] == channel.id).toList();
        final int generation = await reserveMcpGeneration(txn);
        final Map<String, Object?> row = <String, Object?>{...channel.toRow(), 'generation': generation};
        if (previous.isEmpty) {
          await txn.insert('mcp_channels', row);
        } else {
          await txn.update('mcp_channels', row, where: 'id = ?', whereArgs: <Object?>[channel.id]);
          await txn.update('mcp_submissions', <String, Object?>{
            'state': 'rejected', 'snapshot': null, 'last_error': 'local_mapping', 'updated_at': store!.nowMs,
          }, where: "channel_id = ? AND state IN ('pending','retrying')", whereArgs: <Object?>[channel.id]);
        }
        // A stale secure slot from a previously removed/imported configuration
        // must not be inherited just because a portable id was reused.
      }
    });
    await store!.refresh();
    try {
      for (final String id in ids) { await secrets.prune(id); }
    } on Object {
      await store!.markUnavailable('restore_credential_cleanup');
      throw StateError('storage_unavailable');
    }
  }
}
