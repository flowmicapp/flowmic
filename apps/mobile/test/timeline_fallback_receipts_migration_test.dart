import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_fallback_receipts_schema.dart';
import 'support/temp_teardown.dart';

void main() {
  setUpAll(sqfliteFfiInit);
  test('receipt schema can be applied twice without rewriting existing data', () async {
    final db = await databaseFactoryFfi.openDatabase(inMemoryDatabasePath);
    addTearDown(db.close);
    await installTimelineFallbackReceiptsSchema(db);
    await db.insert(kTimelineFallbackReceiptsTable, {'id': 'deleted-row', 'fingerprint': 'receipt'});
    await installTimelineFallbackReceiptsSchema(db);
    expect(await db.query(kTimelineFallbackReceiptsTable), [{'id': 'deleted-row', 'fingerprint': 'receipt'}]);
  });
  for (final bool existingReceipts in [false, true]) {
    test('upgrade from v8 preserves history and existing receipts ($existingReceipts)', () async {
      SharedPreferences.setMockInitialValues({kTimelineMigratedKey: true});
      final prefs = await SharedPreferences.getInstance();
      final tmp = await Directory.systemTemp.createTemp('receipt-upgrade-'); addTearDown(() => removeTempDir(tmp));
      final path = '${tmp.path}/timeline.db';
      final initial = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
      await (initial.persistence as SqfliteTimelinePersistence).close();
      final old = await databaseFactoryFfi.openDatabase(path);
      addTearDown(old.close);
      // v8 has the same primary schema; the mixed importer may or may not have
      // created its receipt table. Exercise both real deployed shapes.
      await old.execute('CREATE TABLE upgrade_sentinel (id TEXT PRIMARY KEY, payload TEXT)');
      await old.insert('upgrade_sentinel', {'id': 'keep', 'payload': 'untouched'});
      if (existingReceipts) {
        await old.insert(kTimelineFallbackReceiptsTable, {'id': 'gone', 'fingerprint': 'kept'});
      } else {
        await old.execute('DROP TABLE $kTimelineFallbackReceiptsTable');
      }
      await old.setVersion(8); await old.close();
      final upgraded = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
      expect(upgraded.kind, TimelineStorageKind.sqlite);
      addTearDown(() => (upgraded.persistence as SqfliteTimelinePersistence).close());
      final raw = await databaseFactoryFfi.openDatabase(path);
      expect(await raw.getVersion(), 8);
      expect(await raw.query('upgrade_sentinel'), [{'id': 'keep', 'payload': 'untouched'}]);
      expect(await raw.query(kTimelineFallbackReceiptsTable), existingReceipts ? [{'id': 'gone', 'fingerprint': 'kept'}] : isEmpty);
      await installTimelineFallbackReceiptsSchema(raw);
      expect(await raw.query(kTimelineFallbackReceiptsTable), existingReceipts ? [{'id': 'gone', 'fingerprint': 'kept'}] : isEmpty);
    });
  }
  test('this build leaves receipts and history readable by the previous v8 open path', () async {
    SharedPreferences.setMockInitialValues({kTimelineMigratedKey: true});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('receipt-previous-');
    addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(opened.kind, TimelineStorageKind.sqlite);
    final db = await databaseFactoryFfi.openDatabase(path);
    await db.insert(kTimelineFallbackReceiptsTable, {'id': 'gone', 'fingerprint': 'kept'});
    await (opened.persistence as SqfliteTimelinePersistence).close();
    // The previous code supports v8 and refuses any downgrade in this callback.
    final previous = await databaseFactoryFfi.openDatabase(path, options: OpenDatabaseOptions(
      version: 8,
      onDowngrade: (d, from, to) => throw TimelineDbDowngradeRefused(dbVersion: from, appVersion: to),
    ));
    addTearDown(previous.close);
    expect(await previous.getVersion(), 8);
    expect(await previous.query(kTimelineTable), isEmpty);
    expect(await previous.query(kTimelineFallbackReceiptsTable), [{'id': 'gone', 'fingerprint': 'kept'}]);
  });
}
