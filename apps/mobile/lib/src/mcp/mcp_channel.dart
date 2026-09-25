// Device-local MCP configuration. Credentials and complete endpoints never
// belong in this model: persistence and portable backup serialize it verbatim.
import 'dart:convert';

enum McpChannelState {
  saved('saved'), enabled('enabled'), paused('paused'),
  reauthorizationRequired('reauthorization_required'), toolMissing('tool_missing'),
  schemaUnsupported('schema_unsupported'), storageUnavailable('storage_unavailable');
  const McpChannelState(this.wire);
  final String wire;
}

class McpChannel {
  const McpChannel({required this.id, required this.name, required this.hostHint,
    required this.tool, required this.inputSchema, required this.mapping,
    required this.generation, required this.authorized, required this.paused,
    required this.state, this.testedGeneration, this.expiredCount = 0,
    this.lastSuccessAt, this.lastTestAt,
  });
  final String id;
  final String name;
  final String hostHint;
  final String tool;
  final Map<String, Object?> inputSchema;
  final Map<String, Object?> mapping;
  final int generation;
  final int? testedGeneration;
  final bool authorized;
  final bool paused;
  final McpChannelState state;
  final int expiredCount;
  final int? lastSuccessAt;
  final int? lastTestAt;
  bool get canSend => authorized && !paused && state == McpChannelState.enabled && testedGeneration == generation;

  factory McpChannel.fromRow(Map<String, Object?> row) => McpChannel(
    id: row['id']! as String, name: row['name']! as String,
    hostHint: row['host_hint']! as String, tool: row['tool']! as String,
    inputSchema: (jsonDecode(row['input_schema']! as String) as Map).cast<String, Object?>(),
    mapping: (jsonDecode(row['mapping']! as String) as Map).cast<String, Object?>(),
    generation: row['generation']! as int,
    testedGeneration: row['tested_generation'] as int?,
    authorized: row['authorized'] == 1, paused: row['paused'] == 1,
    state: McpChannelState.values.firstWhere((McpChannelState s) => s.wire == row['state']),
    expiredCount: row['expired_count']! as int,
    lastSuccessAt: row['last_success_at'] as int?, lastTestAt: row['last_test_at'] as int?,
  );

  Map<String, Object?> toRow() => <String, Object?>{
    'id': id, 'name': name, 'host_hint': hostHint, 'tool': tool,
    'input_schema': jsonEncode(inputSchema), 'mapping': jsonEncode(mapping),
    'generation': generation, 'tested_generation': testedGeneration,
    'authorized': authorized ? 1 : 0, 'paused': paused ? 1 : 0, 'state': state.wire,
    'expired_count': expiredCount, 'last_success_at': lastSuccessAt, 'last_test_at': lastTestAt,
  };
}
