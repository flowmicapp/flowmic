import 'dart:io';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flowmic/src/diag/diag_log.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flowmic/src/timeline/timeline_recovery_failures.dart';
import 'support/di.dart';
import 'support/temp_teardown.dart';

class _RefusesClear extends InMemorySharedPreferencesStore {
  _RefusesClear() : super.empty();
  bool refuse = false;
  @override
  Future<bool> remove(String key) async => refuse ? false : super.remove(key);
}

void main() {
  test('cleanup exclusion still reports unreadable row ids and actual open failures', () {
    final failures = TimelineRecoveryFailures();
    addTearDown(failures.dispose);
    failures.reportStorageOpen('fallback_import_cleanup:StateError',
      {'fallback_unreadable_primary_rows': {'broken-row'}});
    expect(failures.noticeTicket, isNotNull);
    expect(failures.entryIds, hasLength(1));
    expect(failures.entryIds, isNot(contains('storage-open')));
    final openFailure = TimelineRecoveryFailures();
    addTearDown(openFailure.dispose);
    openFailure.reportStorageOpen('open_failed:StateError', {});
    expect(openFailure.entryIds, contains('storage-open'));
    expect(openFailure.noticeTicket, isNotNull);
  });

  test('equal timestamps keep SQLite content instead of overwriting it from fallback', () async {
    SharedPreferences.setMockInitialValues({kTimelineMigratedKey: true});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('nr142-equal-'); addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    final first = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    final store = newTestStore(persistence: first.persistence); addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'equal', mode: FlowMode.realtime,
      delivery: Delivery.none, text: 'SQLite content');
    await store.awaitPersisted(row.id);
    final fallbackRow = TimelineEntry.fromJson({...row.toJson(), 'output_text': 'fallback content'})!;
    await SharedPrefsTimelinePersistence(prefs).upsert(fallbackRow);
    await (first.persistence as SqfliteTimelinePersistence).close();
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    addTearDown(() => (opened.persistence as SqfliteTimelinePersistence).close());
    expect((await opened.persistence.loadById(row.id))!.outputText, 'SQLite content');
    expect(opened.importedRows, 0);
  });

  setUpAll(sqfliteFfiInit);
  test('an import transaction refusal preserves every fallback row and is visible', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('nr142-import-refused-');
    addTearDown(() => removeTempDir(tmp));
    final path = '${tmp.path}/timeline.db';
    final initial = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    await (initial.persistence as SqfliteTimelinePersistence).close();
    final raw = await databaseFactoryFfi.openDatabase(path);
    await raw.execute("CREATE TRIGGER refuse_import BEFORE INSERT ON $kTimelineTable "
      "BEGIN SELECT RAISE(ABORT, 'forced import refusal'); END");
    await raw.close();
    final store = newTestStore(persistence: SharedPrefsTimelinePersistence(prefs));
    addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'import-refused',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'PRIVATE_TRANSACTION_SENTINEL');
    await store.awaitPersisted(row.id);
    final refused = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(refused.kind, TimelineStorageKind.sharedPrefsFallback);
    expect(refused.failure, isNotNull);
    expect(await refused.persistence.loadById(row.id), isNotNull);
    final check = await databaseFactoryFfi.openDatabase(path);
    expect(await check.query(kTimelineTable), isEmpty);
    await check.execute('DROP TRIGGER refuse_import'); await check.close();
    final recovered = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    addTearDown(() => (recovered.persistence as SqfliteTimelinePersistence).close());
    expect(recovered.kind, TimelineStorageKind.sqlite);
    expect(await recovered.persistence.loadById(row.id), isNotNull);
  });

  test('failed fallback cleanup is diagnostic only and an import retry cannot resurrect a deletion', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final platform = _RefusesClear(); SharedPreferencesStorePlatform.instance = platform;
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('nr142-cleanup-');
    addTearDown(() => removeTempDir(tmp));
    final fallback = SharedPrefsTimelinePersistence(prefs);
    final store = newTestStore(persistence: fallback); addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'clear-refused',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'PRIVATE_CLEANUP_SENTINEL');
    await store.awaitPersisted(row.id);
    platform.refuse = true;
    DiagLog.instance.clear();
    final path = '${tmp.path}/timeline.db';
    final first = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(first.kind, TimelineStorageKind.sqlite);
    addTearDown(() => (first.persistence as SqfliteTimelinePersistence).close());
    expect(first.failure, startsWith('fallback_import_cleanup:'), reason: 'cleanup refusal remains diagnosable');
    expect((await first.persistence.loadById(row.id))!.sourceText, row.sourceText);
    final primaryStore = newTestStore(persistence: first.persistence);
    addTearDown(primaryStore.dispose);
    primaryStore.recoveryFailures.reportStorageOpen(first.failure, first.corruptionRowIds);
    expect(primaryStore.recoveryFailures.noticeTicket, isNull,
      reason: 'all notes are saved and readable; leftover copies are harmless');
    expect(primaryStore.recoveryFailures.entryIds, isEmpty);
    final cleanup = DiagLog.instance.snapshot().singleWhere((line) => line.contains('timeline.fallback_import_cleanup_failed'));
    expect(cleanup, contains('row_id_count=1'));
    expect(cleanup, contains('confirmed_row_id_count=1'));
    expect(cleanup, contains('unreadable_primary_row_id_count=0'));
    expect(cleanup, isNot(contains('PRIVATE_CLEANUP_SENTINEL')));
    expect(await fallback.loadById(row.id), isNotNull);
    await first.persistence.delete(row.id);
    await (first.persistence as SqfliteTimelinePersistence).close();
    platform.refuse = false;
    final second = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(second.kind, TimelineStorageKind.sqlite);
    addTearDown(() => (second.persistence as SqfliteTimelinePersistence).close());
    expect(await second.persistence.loadById(row.id), isNull);
    expect(second.importedRows, 0);
    expect(await fallback.loadAll(), isEmpty);
    await (second.persistence as SqfliteTimelinePersistence).close();
  });
  test('DB fails, fallback note is imported after next successful open exactly once', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{kTimelineMigratedKey: true});
    final prefs = await SharedPreferences.getInstance();
    final tmp = await Directory.systemTemp.createTemp('nr142-recovery-');
    addTearDown(() => removeTempDir(tmp));
    final failed = await openTimelinePersistence(prefs: prefs,
      factory: databaseFactoryFfi, path: tmp.path);
    expect(failed.kind, TimelineStorageKind.sharedPrefsFallback);
    final store = newTestStore(persistence: failed.persistence); addTearDown(store.dispose);
    final row = store.buildFromUtterance(clientId: 'fallback-note',
      mode: FlowMode.realtime, delivery: Delivery.none, text: 'PRIVATE_IMPORT_SENTINEL');
    await store.awaitPersisted(row.id);
    expect(await failed.persistence.loadById(row.id), isNotNull);
    DiagLog.instance.clear();
    final path = '${tmp.path}/timeline.db';
    final opened = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(opened.kind, TimelineStorageKind.sqlite);
    addTearDown(() => (opened.persistence as SqfliteTimelinePersistence).close());
    expect((await opened.persistence.loadById(row.id))?.sourceText, row.sourceText);
    expect(opened.importedRows, 1);
    expect(await SharedPrefsTimelinePersistence(prefs).loadAll(), isEmpty);
    final trail = DiagLog.instance.snapshot().join('\n');
    expect(trail, contains('timeline.fallback_import'));
    expect(trail, contains('rows=1'));
    expect(trail, isNot(contains('PRIVATE_IMPORT_SENTINEL')));
    await (opened.persistence as SqfliteTimelinePersistence).close();
    final again = await openTimelinePersistence(prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(again.importedRows, 0);
    expect(await again.persistence.loadAll(), hasLength(1));
    await (again.persistence as SqfliteTimelinePersistence).close();
  });
}
