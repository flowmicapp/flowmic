import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'support/di.dart';
import 'support/temp_teardown.dart';

TimelineEntry _row(String id) => TimelineEntry.fromJson({'id': id, 'client_id': id,
  'mode': 'realtime', 'delivery': 'none', 'output_text': 'history', 'status': 'noted',
  'created_at': '2026-07-01T00:00:00Z', 'updated_at': '2026-07-01T00:00:00Z'})!;
void main() {
  test('corrupt primary rows preserve pending recovery copies and do not abort open', () async {
    SharedPreferences.setMockInitialValues({kTimelineMigratedKey: true});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('n2-primary-import-'); addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    final initial = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    await initial.persistence.upsert(_row('bad-payload'));
    await initial.persistence.upsert(_row('bad-projection'));
    await (initial.persistence as SqfliteTimelinePersistence).close();
    final raw = await databaseFactoryFfi.openDatabase(path);
    await raw.update(kTimelineTable, {'payload': '{broken'}, where: 'id = ?', whereArgs: ['bad-payload']);
    await raw.update(kTimelineTable, {'updated_at': 'unreadable'}, where: 'id = ?', whereArgs: ['bad-projection']);
    await raw.close();
    final fallback = SharedPrefsTimelinePersistence(prefs);
    await fallback.upsert(_row('bad-payload'));
    await fallback.upsert(_row('bad-projection'));
    await fallback.upsert(_row('healthy'));
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(opened.kind, TimelineStorageKind.sqlite);
    addTearDown(() => (opened.persistence as SqfliteTimelinePersistence).close());
    expect(await opened.persistence.loadById('healthy'), isNotNull);
    expect(opened.failure, isNotNull);
    expect((await fallback.loadAll()).map((e) => e.id).toSet(), {'bad-payload', 'bad-projection'});
    final check = await databaseFactoryFfi.openDatabase(path);
    expect((await check.query(kTimelineTable, where: 'id = ?', whereArgs: ['bad-payload'])).single['payload'], '{broken');
    expect((await check.query(kTimelineTable, where: 'id = ?', whereArgs: ['bad-projection'])).single['updated_at'], 'unreadable');
  });
  test('one corrupt row does not end history, owner or search pagination early', () async {
    SharedPreferences.setMockInitialValues({kTimelineMigratedKey: true});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('n2-paging-'); addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    final p = opened.persistence as SqfliteTimelinePersistence; addTearDown(p.close);
    for (int i = 0; i < 71; i++) {
      final stamp = DateTime.utc(2026, 7, 1).add(Duration(seconds: i)).toIso8601String();
      await p.upsert(TimelineEntry.fromJson({..._row('row-$i').toJson(),
        'created_at': stamp, 'updated_at': stamp, 'spoken_to_instance_id': 'owner'})!);
    }
    final raw = await databaseFactoryFfi.openDatabase(path);
    await raw.update(kTimelineTable, {'payload': '{broken'}, where: 'id = ?', whereArgs: ['row-70']);
    final store = newTestStore(persistence: p); addTearDown(store.dispose);
    await store.load();
    expect(store.entries, hasLength(60));
    expect(store.hasMore, isTrue);
    await store.loadMore();
    expect(store.entries, hasLength(70));
    expect(await p.loadOwnerPage(ownerIds: {'owner'}, limit: 60), hasLength(60));
    expect(await p.search('history', limit: 60), hasLength(60));
  });

  setUpAll(sqfliteFfiInit);
  test('unreadable pending rows stay on disk while valid fallback rows import', () async {
    const brokenKey = 'flowmic.timeline.pending.v3.broken';
    SharedPreferences.setMockInitialValues({kTimelineMigratedKey: true, brokenKey: '{broken'});
    final prefs = await SharedPreferences.getInstance();
    final fallback = SharedPrefsTimelinePersistence(prefs);
    await fallback.upsert(_row('good'));
    final tmp = await Directory.systemTemp.createTemp('n2-pending-'); addTearDown(() => removeTempDir(tmp));
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: '${tmp.path}/timeline.db');
    expect(opened.kind, TimelineStorageKind.sqlite);
    addTearDown(() => (opened.persistence as SqfliteTimelinePersistence).close());
    expect((await opened.persistence.loadAll()).single.id, 'good');
    expect(opened.failure, isNotNull);
    expect(prefs.getString(brokenKey), '{broken');
    expect(await fallback.loadAll(), isEmpty);
  });
  test('unreadable legacy row is skipped without changing the rollback blob', () async {
    final blob = jsonEncode([_row('good').toJson(), {'mode': 'realtime'}, {'id': 'bad', 'client_id': 42}]);
    SharedPreferences.setMockInitialValues({'flowmic.timeline.entries.v1': blob});
    final prefs = await SharedPreferences.getInstance();
    final p = SharedPrefsTimelinePersistence(prefs);
    final store = newTestStore(persistence: p); addTearDown(store.dispose);
    await store.load();
    expect(store.entries.single.id, 'good');
    expect(store.recoveryFailures.noticeTicket, isNotNull);
    expect(prefs.getString('flowmic.timeline.entries.v1'), blob);
  });
  test('corrupt SQLite payload never hides healthy history or rewrites the row', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('n2-sqlite-'); addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    final p = opened.persistence as SqfliteTimelinePersistence; addTearDown(p.close);
    await p.upsert(_row('bad')); await p.upsert(_row('good'));
    final raw = await databaseFactoryFfi.openDatabase(path);
    await raw.update(kTimelineTable, {'payload': '{broken'}, where: 'id = ?', whereArgs: ['bad']);
    final store = newTestStore(persistence: p); addTearDown(store.dispose);
    await store.load();
    expect(store.entries.single.id, 'good');
    expect(store.recoveryFailures.noticeTicket, isNotNull);
    expect((await raw.query(kTimelineTable, where: 'id = ?', whereArgs: ['bad'])).single['payload'], '{broken');
    store.recoveryFailures.dismissNotice();
    await store.load();
    expect(store.recoveryFailures.noticeTicket, isNull, reason: 'same skipped row does not repeatedly raise notice');
  });
}
