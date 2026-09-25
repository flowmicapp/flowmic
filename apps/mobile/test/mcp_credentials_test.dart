// Platform secure-storage adapter + actual settings export bytes. Plugin
// storage is mocked here; device Keystore/Keychain requires the device drill.
import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/mcp/mcp_channel.dart';
import 'package:flowmic/src/mcp/mcp_secrets.dart';
import 'package:flowmic/src/mcp/mcp_service.dart';
import 'package:flowmic/src/mcp/mcp_settings_backup.dart';
import 'package:flowmic/src/portable/settings_backup.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/portable_fakes.dart';

void main() {
  sqfliteFfiInit();
  test('URL path and marked fixed credentials never enter SQLite, diagnostics, or export bytes', () async {
    final Directory folder = await Directory.systemTemp.createTemp('mcp-credentials-');
    SharedPreferences.setMockInitialValues(<String, Object>{});
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final SharedPreferences prefs = await SharedPreferences.getInstance();
    final TimelineStorageOpen storage = await openTimelinePersistence(prefs: prefs,
      factory: databaseFactoryFfi, path: '${folder.path}/timeline.db');
    final SqfliteTimelinePersistence persistence = storage.persistence as SqfliteTimelinePersistence;
    final McpService service = McpService(store: persistence.mcp);
    addTearDown(() async { service.dispose(); await persistence.close(); await folder.delete(recursive: true); });
    DiagLog.instance.clear();
    final McpSecrets credential = McpSecrets(endpoint: Uri.parse('https://fixture.invalid/path-is-the-secret'),
      token: 'bearer-is-the-secret', fixed: <String, Object?>{'/api_key': 'fixed-is-the-secret'});
    final McpChannel channel = await service.configure(name: 'fixture', tool: 'submit',
      schema: <String, Object?>{'type': 'object', 'properties': <String, Object?>{'api_key': <String, Object?>{'type': 'string'}}},
      mapping: <String, Object?>{'/api_key': <String, Object?>{'source': 'fixed', 'secret': true, 'value': 'fixed-is-the-secret'}},
      credential: credential);
    await const FlutterSecureStorage().write(key: 'unrelated-service-token', value: 'untouched');
    final McpSecrets? read = await const SecureMcpSecretStore().read(channel.id, channel.generation);
    expect(read!.endpoint, credential.endpoint);
    expect(read.token, credential.token);
    expect(read.fixed, credential.fixed);
    final String sqlite = jsonEncode(await persistence.mcp.db.query('mcp_channels'));
    final RecordingExportDestination destination = RecordingExportDestination('${folder.path}/export');
    final SettingsBackup backup = SettingsBackup(prefs: prefs, destination: destination,
      mcp: McpSettingsBackup(store: service.store, secrets: service.secrets),
      source: FixedImportSource(null), version: const FixedAppVersion('test'), workDir: folder.path,
      deviceName: null, onImported: () async {});
    expect((await backup.export()).ok, true);
    final String exported = await File(destination.savedPath!).readAsString();
    final Map document = jsonDecode(exported) as Map;
    final List configs = (document['local'] as Map)['mcp_channels'] as List;
    expect(configs, hasLength(1));
    expect((configs.single as Map).keys.toSet(),
      <String>{'id', 'name', 'host_hint', 'tool', 'input_schema', 'mapping'});
    for (final String value in <String>['path-is-the-secret', 'bearer-is-the-secret', 'fixed-is-the-secret']) {
      expect(sqlite, isNot(contains(value)));
      expect(jsonEncode(DiagLog.instance.snapshot()), isNot(contains(value)));
      expect(exported, isNot(contains(value)));
    }
    expect(sqlite, contains('fixture.invalid'));
    await persistence.mcp.tested(channel.id, channel.generation);
    await service.enable(channel.id);
    // Reusing an existing id cannot reuse consent, tests or secure slots.
    await service.secrets.write(channel.id, channel.generation + 1, credential);
    await service.secrets.write(channel.id, channel.generation + 100, credential);
    final SettingsRestoreOutcome restored = await backup.restoreFrom(exported);
    expect(restored.ok, true);
    final McpChannel imported = service.channels.single;
    expect(imported.authorized, false);
    expect(imported.testedGeneration, isNull);
    expect(imported.state, McpChannelState.saved);
    expect(imported.lastSuccessAt, isNull);
    expect(persistence.mcp.armedTargets, isEmpty);
    expect(await service.secrets.read(channel.id, channel.generation), isNull);
    expect(await service.secrets.read(channel.id, imported.generation), isNull);
    expect(await service.secrets.read(channel.id, channel.generation + 100), isNull);
    expect(await const FlutterSecureStorage().read(key: 'unrelated-service-token'), 'untouched');
    expect((await service.testChannel(channel.id)).reason, 'credential_unavailable');
    // Old versions may have retained this as unknown. Never re-export that raw
    // value after the key becomes known, even when no channels remain.
    await prefs.setString(SettingsBackup.unknownKeysKey, jsonEncode(<String, Object?>{
      'local': <String, Object?>{'mcp_channels': <Object?>[<String, Object?>{'endpoint': credential.endpoint.toString()}]},
    }));
    await service.remove(channel.id);
    expect(await const SecureMcpSecretStore().read(channel.id, channel.generation), isNull);
    expect(jsonEncode(await backup.snapshot()), isNot(contains('path-is-the-secret')));
    // Validate the complete input before mutating even its first valid channel.
    final McpSettingsBackup port = McpSettingsBackup(store: service.store, secrets: service.secrets);
    await expectLater(port.importChannels(<Object?>[configs.single, <String, Object?>{'id': 'bad'}]), throwsStateError);
    expect(service.channels, isEmpty);
    // Bookkeeping failure must not prevent reading public configuration for an
    // otherwise ordinary settings backup.
    await port.importChannels(configs);
    await persistence.mcp.markUnavailable('test');
    expect((await backup.export()).ok, true);
  });
}
