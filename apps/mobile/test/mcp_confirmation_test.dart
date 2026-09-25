// Durable manual-confirmation facts: readiness, generation and observed result
// must still hold at the transaction that enqueues. No widget timing shortcut.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/mcp/mcp_channel.dart';
import 'package:flowmic/src/mcp/mcp_secrets.dart';
import 'package:flowmic/src/mcp/mcp_service.dart';
import 'package:flowmic/src/mcp/mcp_submission_store.dart';
import 'package:flowmic/src/mcp/mcp_settings_backup.dart';
import 'package:flowmic/src/mcp/mcp_transport.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'mcp_client_test.dart' show ReplayTransport;
import 'support/di.dart';

void main() {
  sqfliteFfiInit();
  late Directory folder;
  late SqfliteTimelinePersistence persistence;
  late TimelineStore timeline;
  late McpService service;
  late ReplayTransport transport;
  late McpChannel channel;
  setUp(() async {
    folder = await Directory.systemTemp.createTemp('mcp-confirmation-');
    SharedPreferences.setMockInitialValues(<String, Object>{});
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    persistence = (await openTimelinePersistence(prefs: await SharedPreferences.getInstance(),
      factory: databaseFactoryFfi, path: '${folder.path}/timeline.db')).persistence as SqfliteTimelinePersistence;
    timeline = newTestStore(persistence: persistence);
    transport = ReplayTransport(<String>['modern-discover', 'modern-tools', 'modern-tools', 'modern-success']);
    service = McpService(store: persistence.mcp, transport: transport);
    final Map result = (jsonDecode(transport.fixtures['modern-tools']!['body']! as String) as Map)['result'] as Map;
    channel = await service.configure(name: 'fixture', tool: 'submit',
      schema: (((result['tools'] as List).first as Map)['inputSchema'] as Map).cast<String, Object?>(),
      mapping: <String, Object?>{'/payload/text': <String, Object?>{'source': 'outputText'}, '/kind': <String, Object?>{'source': 'fixed', 'value': 'record'}},
      credential: McpSecrets(endpoint: Uri.parse('https://fixture.invalid/secret'), token: null, fixed: <String, Object?>{}));
    expect((await service.testChannel(channel.id)).succeeded, true);
    await service.enable(channel.id); channel = service.channels.single;
  });
  tearDown(() async { service.dispose(); timeline.dispose(); await persistence.close(); await folder.delete(recursive: true); });
  Future<TimelineEntry> birth(bool ready) async {
    final TimelineEntry row = timeline.buildFromUtterance(clientId: 'confirmation', mode: FlowMode.realtime,
      delivery: Delivery.none, text: 'synthetic', origin: 'cloud', mcpContentReady: ready);
    await timeline.awaitPersisted(row.id); return row;
  }

  test('manual does not manufacture readiness', () async {
    final TimelineEntry row = await birth(false);
    final Map<String, Object?> job = (await persistence.mcp.submissions(channel.id)).single;
    await expectLater(service.manual(row.id, channel.id, generation: channel.generation, expectedRevision: mcpJobRevision(job)),
      throwsA(isA<StateError>().having((StateError e) => e.message, 'reason', 'content_not_ready')));
    await service.drain();
    expect(transport.methods, isNot(contains('tools/call')));
    expect((await persistence.mcp.submissions(channel.id)).single['ready'], 0);
  });

  test('a completed automatic call invalidates the old manual confirmation', () async {
    final TimelineEntry row = await birth(true);
    final String? revision = mcpJobRevision((await persistence.mcp.submissions(channel.id)).single);
    await service.drain();
    expect((await persistence.mcp.submissions(channel.id)).single['state'], 'sent');
    await expectLater(service.manual(row.id, channel.id, generation: channel.generation, expectedRevision: revision),
      throwsA(isA<StateError>().having((StateError e) => e.message, 'reason', 'confirmation_changed')));
    expect((await persistence.mcp.submissions(channel.id)).single['state'], 'sent');
    expect(transport.methods.where((String m) => m == 'tools/call'), hasLength(1));
    final McpChannel changed = await service.configure(id: channel.id, name: channel.name, tool: channel.tool,
      schema: channel.inputSchema, mapping: channel.mapping,
      credential: McpSecrets(endpoint: Uri.parse('https://other.invalid/new-secret'), token: null, fixed: <String, Object?>{}));
    expect(changed.lastSuccessAt, isNull);
    await expectLater(service.manual(row.id, channel.id, generation: channel.generation, expectedRevision: revision), throwsStateError);
  });

  test('editor discovery shares the generation 401 stop latch', () async {
    transport.names.clear(); transport.names.add('auth-required');
    // The captured HTTP challenge is also valid for a later tools/list after
    // the cached discovery epoch; only this request-method expectation varies.
    transport.fixtures['auth-required'] = <String, Object?>{...transport.fixtures['auth-required']!,
      'request': <String, Object?>{'method': 'tools/list', 'params': <String, Object?>{}},
    };
    expect((await service.discover(channel.id)).status, 401);
    expect(service.channels.single.state, McpChannelState.reauthorizationRequired);
    final int count = transport.methods.length;
    expect((await service.discover(channel.id)).status, 401);
    expect(transport.methods.length, count);
  });

  test('deleting then restoring the same id cannot adopt a late old success', () async {
    final TimelineEntry row = await birth(true);
    final Map<String, Object?> old = (await persistence.mcp.submissions(channel.id)).single;
    expect(await persistence.mcp.claim(old, '{}', 'old-hash'), true);
    final McpSettingsBackup backup = McpSettingsBackup(store: service.store, secrets: service.secrets);
    final List<Map<String, Object?>> portable = await backup.exportChannels();
    await service.remove(channel.id);
    await backup.importChannels(portable);
    final McpChannel restored = service.channels.single;
    expect(restored.id, channel.id);
    expect(restored.generation, greaterThan(channel.generation));
    await persistence.mcp.tested(restored.id, restored.generation);
    await service.enable(restored.id);
    await service.manual(row.id, restored.id, generation: restored.generation, expectedRevision: null);
    final Map<String, Object?> current = (await persistence.mcp.submissions(restored.id)).single;
    expect(await persistence.mcp.claim(current, '{}', 'new-hash'), true);
    await persistence.mcp.conclude(old, const McpReply(McpEvidence.result, 'tool_result'));
    final Map<String, Object?> stillCurrent = (await persistence.mcp.submissions(restored.id)).single;
    expect(stillCurrent['state'], 'sending');
    expect(stillCurrent['remote_ack'], isNull);
    expect(stillCurrent['payload_hash'], 'new-hash');
    expect(await persistence.mcp.db.query('mcp_configuration_epochs'), isEmpty);
    expect(await persistence.mcp.db.rawQuery("SELECT * FROM sqlite_sequence WHERE name = 'mcp_configuration_epochs'"), hasLength(1));
  });
}
