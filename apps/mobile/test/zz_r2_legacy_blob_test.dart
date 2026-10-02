import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'support/temp_teardown.dart';

TimelineEntry _row(String id) => TimelineEntry.fromJson(<String, Object?>{
  'id': id, 'client_id': id, 'mode': 'realtime', 'delivery': 'none',
  'source_text': 'deleted long ago', 'output_text': 'deleted long ago', 'status': 'noted',
  'created_at': '2026-07-01T00:00:00Z', 'updated_at': '2026-07-01T00:00:00Z'})!;

void main() {
  setUpAll(sqfliteFfiInit);
  test('upgrade: a pre-migration v1 blob row the user deleted in SQLite stays deleted', () async {
    final x = _row('loc_mobile_old');
    SharedPreferences.setMockInitialValues(<String, Object>{
      'flowmic.timeline.entries.v1': jsonEncode(<Object?>[x.toJson()]),
      kTimelineMigratedKey: true});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('r2-legacy-'); addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    await (await databaseFactoryFfi.openDatabase(path)).close();
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    addTearDown(() => (opened.persistence as SqfliteTimelinePersistence).close());
    expect(opened.kind, TimelineStorageKind.sqlite);
    expect((await opened.persistence.loadAll()).where((e) => e.id == x.id), isEmpty);
    expect(prefs.getString('flowmic.timeline.entries.v1'), isNotNull);
  });
  test('one unreadable legacy row never makes SQLite history unavailable', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      'flowmic.timeline.entries.v1': jsonEncode(<Object?>[_row('old').toJson(), {'mode': 'realtime'}]),
      kTimelineMigratedKey: true});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('r2-corrupt-'); addTearDown(() => removeTempDir(tmp));
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: '${tmp.path}/timeline.db');
    expect(opened.kind, TimelineStorageKind.sqlite, reason: 'failure=${opened.failure}');
    addTearDown(() => (opened.persistence as SqfliteTimelinePersistence).close());
    expect(prefs.getString('flowmic.timeline.entries.v1'), isNotNull);
  });
  test('fallback mutation after migration cannot convert or import the backup', () async {
    final backup = jsonEncode([_row('deleted').toJson()]);
    SharedPreferences.setMockInitialValues({'flowmic.timeline.entries.v1': backup, kTimelineMigratedKey: true});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('r2-fallback-'); addTearDown(() => removeTempDir(tmp));
    final failed = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: tmp.path);
    await failed.persistence.upsert(_row('new'));
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: '${tmp.path}/timeline.db');
    addTearDown(() => (opened.persistence as SqfliteTimelinePersistence).close());
    expect((await opened.persistence.loadAll()).map((e) => e.id), ['new']);
    expect(prefs.getString('flowmic.timeline.entries.v1'), backup);
  });
}
