// Card CR-7 — the article grouping key's schema step (v6 → v7).
//
// The fresh-vs-stepwise parity property is already pinned by
// timeline_migration_test.dart and is NOT repeated here. What this file adds is
// the three things parity cannot see:
//   ① a real v6 database, with real rows, arrives at v7 with every row intact
//      and every one of them saying `article_id IS NULL`;
//   ② the step survives being walked twice (D13 ① — an older APK stamps a file
//      back down, a newer one raises it again);
//   ③ nothing is back-filled. A legacy row belongs to no recording, and the
//      only alternatives are to invent one or to leave it null.
//
// 🔴 ③ IS THE ONE WITH A COST IF IT IS EVER 「IMPROVED」. Adopting old rows into
// the nearest article by time would look tidy and would be a fabricated claim
// about which meeting somebody's sentence came from — the same lie V2-06a-1
// refused when it would not invent an owner for a legacy row.

import 'dart:convert';
import 'dart:io';

import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

late Directory _tmp;
int _seq = 0;
String _freshPath() => '${_tmp.path}/db_${_seq++}.db';

/// A v6 database: v1 timeline + every step up to 6, built through the app's own
/// frozen steps rather than by hand — a hand-written 「v6」 would be this test's
/// opinion of v6, not the shape that shipped.
Future<String> _v6WithRows(List<String> ids) async {
  final String path = _freshPath();
  final Database db = await databaseFactoryFfi.openDatabase(
    path,
    options: OpenDatabaseOptions(
      version: 6,
      onCreate: (Database d, int _) async {
        await createTimelineSchemaV1ForTest(d);
        await createOutboxSchemaV2ForTest(d);
      },
      onUpgrade: (Database d, int from, int to) async {},
    ),
  );
  final int t = DateTime.utc(2026, 8, 4, 10).millisecondsSinceEpoch;
  for (final String id in ids) {
    // Written with v1's columns, because that is what a v6 install had. Using
    // today's projection here would make the fixture unable to represent an old
    // file at all — see _insertLegacyRow in timeline_migration_test.dart.
    await db.rawInsert(
      'INSERT INTO timeline_entries '
      '(id, created_at, updated_at, client_id, mode, status, entry_type, '
      ' spoken_to_instance_id, deleted, search_text, payload) '
      'VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)',
      <Object?>[
        id, t, t, id, 'realtime', 'noted', 'transcript', 'said $id',
        jsonEncode(
          TimelineEntry(
            id: id,
            clientId: id,
            mode: FlowMode.realtime,
            delivery: Delivery.none,
            sourceText: 'said $id',
            outputText: 'said $id',
            status: EntryStatus.noted,
            createdAt: DateTime.utc(2026, 8, 4, 10),
            updatedAt: DateTime.utc(2026, 8, 4, 10),
          ).toJson(),
        ),
      ],
    );
  }
  await db.close();
  return path;
}

Future<List<String>> _columns(Database d, String table) async {
  final List<Map<String, Object?>> rows =
      await d.rawQuery('PRAGMA table_info($table)');
  return <String>[for (final Map<String, Object?> r in rows) r['name']! as String];
}

void main() {
  setUpAll(() async {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
    _tmp = await Directory.systemTemp.createTemp('flowmic_article_v7_');
  });
  tearDownAll(() async {
    try {
      if (await _tmp.exists()) await _tmp.delete(recursive: true);
    } on FileSystemException {
      // Windows holds a just-closed db file for a moment; the same tolerance
      // timeline_migration_test.dart already records. A leftover temp dir is
      // not worth failing a migration assertion over.
    }
  });
  setUp(() => SharedPreferences.setMockInitialValues(<String, Object>{}));

  test('a real v6 database reaches v7 with its rows intact and unclaimed', () async {
    final String path = await _v6WithRows(<String>['loc_a', 'loc_b']);

    // Positive control: the column really is absent beforehand. Without this the
    // assertions below could pass on a file that was never v6 at all.
    final Database before = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(readOnly: true, singleInstance: false),
    );
    expect(await _columns(before, 'timeline_entries'), isNot(contains('article_id')));
    await before.close();

    final TimelineStorageOpen out = await openTimelinePersistence(
      prefs: await SharedPreferences.getInstance(),
      factory: databaseFactoryFfi,
      path: path,
    );
    expect(out.kind, TimelineStorageKind.sqlite,
        reason: 'a failed upgrade drops the user to the 100-row store');

    final List<TimelineEntry> rows = await out.persistence.loadAll();
    expect(rows.map((TimelineEntry e) => e.id).toSet(), <String>{'loc_a', 'loc_b'});
    // 🔴 The whole of ③: every legacy row belongs to no recording, and says so.
    expect(rows.every((TimelineEntry e) => e.articleId == null), isTrue);
    expect(rows.every((TimelineEntry e) => e.isInArticle), isFalse);
  });

  test('the step is idempotent — column AND index survive a second walk', () async {
    final String path = await _v6WithRows(<String>['loc_a']);
    final SharedPreferences prefs = await SharedPreferences.getInstance();

    final TimelineStorageOpen first = await openTimelinePersistence(
        prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(first.kind, TimelineStorageKind.sqlite);
    await (first.persistence as SqfliteTimelinePersistence).close();

    // Stamp the file back DOWN, exactly as D13 ① records an older APK doing,
    // then raise it again. This is the path an unguarded ALTER dies on — and it
    // does not die politely: that install drops to the fallback store on every
    // launch, permanently, with nothing naming the cause.
    final Database stamped = await databaseFactoryFfi.openDatabase(
      path, options: OpenDatabaseOptions(singleInstance: false));
    await stamped.setVersion(6);
    await stamped.close();

    final TimelineStorageOpen second = await openTimelinePersistence(
        prefs: prefs, factory: databaseFactoryFfi, path: path);
    expect(second.kind, TimelineStorageKind.sqlite,
        reason: 'the second walk of the v7 step must be a no-op, not a failure');
    expect((await second.persistence.loadAll()).single.id, 'loc_a');
  });

  test('the article index exists and is the one an article needs', () async {
    final String path = await _v6WithRows(<String>['loc_a']);
    final TimelineStorageOpen out = await openTimelinePersistence(
        prefs: await SharedPreferences.getInstance(),
        factory: databaseFactoryFfi, path: path);
    expect(out.kind, TimelineStorageKind.sqlite);
    await (out.persistence as SqfliteTimelinePersistence).close();

    final Database d = await databaseFactoryFfi.openDatabase(
      path, options: OpenDatabaseOptions(readOnly: true, singleInstance: false));
    final List<Map<String, Object?>> idx = await d.rawQuery(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND name=?",
      <Object?>['idx_timeline_article'],
    );
    expect(idx, hasLength(1), reason: 'the step must create the index, not only the column');
    // 🔴 ASC, not DESC, and the direction is the point: an article is read in the
    // order it was spoken. The two neighbouring indexes are DESC because they
    // serve a feed; copying that here would make every article read backwards.
    expect((idx.single['sql']! as String).toUpperCase(), contains('CREATED_AT ASC'));
    await d.close();
  });
}
