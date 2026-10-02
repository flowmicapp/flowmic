import 'dart:io';
import 'package:flowmic/src/timeline/timeline_corrupt_archive.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_purge.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'nr152_corrupt_replacement_test.dart' show incoming, corrupt;
import 'support/di.dart';
import 'support/temp_teardown.dart';

void main() {
  setUpAll(sqfliteFfiInit);
  test('fallback deletion keeps a different row whose id shares a dotted prefix', () async {
    SharedPreferences.setMockInitialValues({
      'flowmic.timeline.pending.v3.x': corrupt,
      'flowmic.timeline.pending.v3.x.y': corrupt,
    });
    final prefs = await SharedPreferences.getInstance();
    final persistence = SharedPrefsTimelinePersistence(prefs);
    await persistence.upsert(incoming('x'));
    await persistence.upsert(incoming('x.y'));
    await persistence.delete('x');
    final keys = prefs.getKeys().where((key) =>
      key.startsWith('flowmic.timeline.corrupt.v1.')).toList();
    expect(keys, hasLength(1));
    expect(keys.single, startsWith('flowmic.timeline.corrupt.v1.x.y.'));
  });
  for (final sqlite in [true, false]) {
    for (final clear in [true, false]) {
      test('NR-152 ${sqlite ? "SQLite" : "fallback"} ${clear ? "clear history" : "delete row"} removes preserved bytes', () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final tmp = await Directory.systemTemp.createTemp('nr152-delete-');
        addTearDown(() => removeTempDir(tmp));
        final path = '${tmp.path}/timeline.db';
        final TimelinePersistence persistence;
        Database? raw;
        if (sqlite) {
          persistence = (await openTimelinePersistence(prefs: prefs,
            factory: databaseFactoryFfi, path: path)).persistence;
          addTearDown((persistence as SqfliteTimelinePersistence).close);
          raw = await databaseFactoryFfi.openDatabase(path);
          await persistence.upsert(incoming('x'));
          await raw.update(kTimelineTable, {'payload': corrupt}, where: 'id = ?', whereArgs: ['x']);
        } else {
          persistence = SharedPrefsTimelinePersistence(prefs);
          await prefs.setString('flowmic.timeline.pending.v3.x', corrupt);
        }
        await persistence.upsert(incoming('x'));
        if (sqlite) {
          expect(await raw!.query(kTimelineCorruptArchiveTable), hasLength(1));
        } else {
          expect(prefs.getKeys().where((k) => k.startsWith('flowmic.timeline.corrupt.v1.x.')), hasLength(1));
        }
        if (sqlite && !clear) {
          await raw!.execute("CREATE TRIGGER refuse_delete BEFORE DELETE ON $kTimelineTable "
            "BEGIN SELECT RAISE(ABORT, 'test delete refusal'); END");
          await expectLater(persistence.delete('x'), throwsA(isA<DatabaseException>()));
          expect(await raw.query(kTimelineCorruptArchiveTable), hasLength(1),
            reason: 'a refused primary delete must roll back the archive delete');
          expect(await persistence.loadById('x'), isNotNull);
          await raw.execute('DROP TRIGGER refuse_delete');
        }
        final store = newTestStore(persistence: persistence);
        addTearDown(store.dispose);
        await store.load();
        if (clear) {
          await store.clear(ClearKind.both, ClearWindow.all);
        } else {
          await store.deleteMany([incoming('x')]);
        }
        expect(await persistence.loadAll(), isEmpty);
        if (sqlite) {
          expect(await raw!.query(kTimelineCorruptArchiveTable), isEmpty);
        } else {
          await prefs.reload();
          expect(prefs.getKeys().where((k) => k.startsWith('flowmic.timeline.corrupt.v1.x.')), isEmpty);
        }
      });
    }
  }
}
