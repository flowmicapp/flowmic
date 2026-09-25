// Real SQLite files pin v8 replay, migration parity, and optional failure isolation.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../lib/src/diag/diag_log.dart';
import '../lib/src/mcp/mcp_schema.dart';
import '../lib/src/signaling/wire_payloads.dart';
import '../lib/src/timeline/timeline_entry.dart';
import '../lib/src/timeline/timeline_sqlite.dart';

void main() {
  sqfliteFfiInit();
  late Directory folder;
  late SharedPreferences prefs;
  setUp(() async {
    folder = await Directory.systemTemp.createTemp('flowmic-mcp-schema-');
    SharedPreferences.setMockInitialValues(<String, Object>{});
    prefs = await SharedPreferences.getInstance();
    DiagLog.instance.clear();
  });
  tearDown(() async { await folder.delete(recursive: true); });

  Future<TimelineStorageOpen> open(String name) => openTimelinePersistence(
    prefs: prefs, factory: databaseFactoryFfi, path: '${folder.path}/$name.db');

  test('fresh and historical upgrade converge; replay preserves local content', () async {
    final Database historical = await databaseFactoryFfi.openDatabase('${folder.path}/old.db',
      options: OpenDatabaseOptions(version: 1, onCreate: (Database db, int _) => createTimelineSchemaV1ForTest(db)));
    await historical.close();
    final TimelineStorageOpen upgraded = await open('old');
    final TimelineStorageOpen fresh = await open('new');
    expect(upgraded.kind, TimelineStorageKind.sqlite);
    expect(fresh.kind, TimelineStorageKind.sqlite);
    final DateTime time = DateTime.utc(2026, 9, 22);
    await upgraded.persistence.upsert(TimelineEntry(id: 'preserved', clientId: 'preserved',
      mode: FlowMode.realtime, delivery: Delivery.none, sourceText: 'local-only',
      outputText: 'local-only', status: EntryStatus.noted, createdAt: time, updatedAt: time));
    await (upgraded.persistence as SqfliteTimelinePersistence).close();
    await (fresh.persistence as SqfliteTimelinePersistence).close();
    final Database old = await databaseFactoryFfi.openDatabase('${folder.path}/old.db');
    final Database newest = await databaseFactoryFfi.openDatabase('${folder.path}/new.db');
    addTearDown(old.close); addTearDown(newest.close);
    for (final String table in <String>['mcp_channels', 'mcp_local_records', 'mcp_submissions', 'mcp_evictions', 'mcp_maintenance', 'mcp_configuration_epochs']) {
      expect(await old.rawQuery('PRAGMA table_info($table)'), await newest.rawQuery('PRAGMA table_info($table)'));
      expect(await old.query(table), isEmpty, reason: 'zero configuration creates zero content rows');
    }
    await createMcpSchemaV8(old);
    await createMcpSchemaV8(old);
    expect((await old.query('timeline_entries')).single['id'], 'preserved');
    expect(await old.getVersion(), kTimelineDbVersion);
  });

  test('acknowledgement level is separate; terminal snapshots cannot survive', () async {
    final Database db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    addTearDown(db.close);
    await createMcpSchemaV8(db);
    await db.insert('mcp_local_records', <String, Object?>{'entry_id': 'e', 'registered_at': 1, 'ready': 1});
    await db.insert('mcp_channels', <String, Object?>{'id': 'c', 'name': 'fixture', 'host_hint': 'fixture.invalid',
      'tool': 'submit', 'input_schema': '{}', 'mapping': '{}'});
    final Map<String, Object?> row = <String, Object?>{'entry_id': 'e', 'channel_id': 'c', 'generation': 1,
      'state': 'sent', 'created_at': 1, 'updated_at': 1};
    await expectLater(db.insert('mcp_submissions', row), throwsA(isA<DatabaseException>()));
    for (final String ack in <String>['tool_result', 'accepted', 'completed']) {
      await db.insert('mcp_submissions', <String, Object?>{...row, 'remote_ack': ack});
      await db.delete('mcp_submissions');
    }
    await expectLater(db.insert('mcp_submissions', <String, Object?>{...row, 'remote_ack': 'tool_result', 'snapshot': 'body'}),
      throwsA(isA<DatabaseException>()));
    await expectLater(db.insert('mcp_submissions', <String, Object?>{...row, 'remote_ack': 'synced'}),
      throwsA(isA<DatabaseException>()));
  });

  test('broken optional table does not demote or erase the primary SQLite timeline', () async {
    final TimelineStorageOpen initial = await open('broken');
    await (initial.persistence as SqfliteTimelinePersistence).close();
    final Database corrupt = await databaseFactoryFfi.openDatabase('${folder.path}/broken.db');
    await corrupt.execute('DROP TABLE mcp_submissions');
    await corrupt.execute('CREATE TABLE mcp_submissions (unrelated TEXT)');
    await corrupt.close();
    final TimelineStorageOpen reopened = await open('broken');
    expect(reopened.kind, TimelineStorageKind.sqlite);
    addTearDown((reopened.persistence as SqfliteTimelinePersistence).close);
    expect(DiagLog.instance.snapshot().join('\n'), contains('mcp.storage_unavailable'));
    final DateTime now = DateTime.now().toUtc();
    await reopened.persistence.upsert(TimelineEntry(id: 'still-local', clientId: 'still-local',
      mode: FlowMode.realtime, delivery: Delivery.none, sourceText: 'saved', outputText: 'saved',
      status: EntryStatus.noted, createdAt: now, updatedAt: now));
    expect((await reopened.persistence.loadAll()).single.outputText, 'saved');
  });
}
