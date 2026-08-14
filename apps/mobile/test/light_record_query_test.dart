// REQ-12-09 09-A — `LightRecordQuery`, the 「search ∩ light record」 read.
//
// SPEC-REF: docs/strategy/2026-08-12-req1209-plus-panel-design.md §5-3, §9 (09-A).
//
// These run against a REAL database (sqflite_common_ffi on the host VM), and
// that is load-bearing rather than thorough: the defect this card exists to
// prevent lives in `SqfliteTimelinePersistence.search`'s `limit`, so a fake
// persistence would agree with whatever the query did and prove nothing. Same
// argument timeline_sqlite_test.dart's header makes.
//
// 🔴 THE ONE THAT MATTERS is 「201 paired hits + one older cloud hit」. Its
// reverse control is the natural implementation — `persistence.search(q)` then
// filter origin in Dart — and it was OBSERVED RED before this file was left
// green; the failure text is quoted in the card's report.

import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/cloud/light_record_query.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

TimelineEntry _entry(
  String id, {
  required String origin,
  required String text,
  required DateTime at,
  bool deleted = false,
}) => TimelineEntry(
  id: id,
  clientId: id,
  mode: FlowMode.realtime,
  delivery: Delivery.none,
  sourceText: text,
  outputText: text,
  status: EntryStatus.noted,
  createdAt: at,
  updatedAt: at,
  origin: origin,
  deleted: deleted,
);

Future<TimelinePersistence> _open() async {
  SharedPreferences.setMockInitialValues(<String, Object>{});
  final SharedPreferences prefs = await SharedPreferences.getInstance();
  final TimelineStorageOpen open = await openTimelinePersistence(
    prefs: prefs,
    factory: databaseFactoryFfi,
    path: inMemoryDatabasePath,
  );
  // A fallback here would silently test the 100-row shared_preferences store
  // instead of the production one — the limit under test lives in the SQLite
  // implementation, so the test must assert it got that one.
  expect(open.kind, TimelineStorageKind.sqlite);
  return open.persistence;
}

List<String> _ids(List<TimelineEntry> rows) =>
    rows.map((TimelineEntry e) => e.id).toList(growable: false);

void main() {
  setUpAll(sqfliteFfiInit);

  setUp(() async {
    // sqflite_common_ffi keys in-memory databases BY PATH, so every open of
    // ':memory:' in this process hands back the SAME database. Without this the
    // tests leak rows into each other (timeline_sqlite_test.dart found this the
    // hard way).
    await databaseFactoryFfi.deleteDatabase(inMemoryDatabasePath);
  });

  test('all() is the cloud slice only, newest first, without deleted rows',
      () async {
    final TimelinePersistence p = await _open();
    await p.upsert(_entry('paired-1',
        origin: 'paired', text: '开会记录', at: DateTime.utc(2026, 8, 1)));
    await p.upsert(_entry('cloud-old',
        origin: 'cloud', text: '买牛奶', at: DateTime.utc(2026, 8, 2)));
    await p.upsert(_entry('cloud-new',
        origin: 'cloud', text: '还书', at: DateTime.utc(2026, 8, 5)));
    await p.upsert(_entry('cloud-gone',
        origin: 'cloud',
        text: '删掉的',
        at: DateTime.utc(2026, 8, 6),
        deleted: true));

    final LightRecordQuery q = LightRecordQuery(persistence: p);
    expect(_ids(await q.all()), <String>['cloud-new', 'cloud-old']);
  });

  test('search() returns light-record hits only — a paired row containing the '
      'same word is not one', () async {
    final TimelinePersistence p = await _open();
    await p.upsert(_entry('paired-hit',
        origin: 'paired', text: '今天的会议记录', at: DateTime.utc(2026, 8, 1)));
    await p.upsert(_entry('cloud-hit',
        origin: 'cloud', text: '会议之后要买牛奶', at: DateTime.utc(2026, 8, 2)));
    await p.upsert(_entry('cloud-miss',
        origin: 'cloud', text: '完全无关', at: DateTime.utc(2026, 8, 3)));
    await p.upsert(_entry('cloud-deleted-hit',
        origin: 'cloud',
        text: '会议纪要',
        at: DateTime.utc(2026, 8, 4),
        deleted: true));

    final LightRecordQuery q = LightRecordQuery(persistence: p);
    expect(_ids(await q.search('会议')), <String>['cloud-hit']);
  });

  test('a blank query answers with nothing, not with everything', () async {
    final TimelinePersistence p = await _open();
    await p.upsert(_entry('cloud-1',
        origin: 'cloud', text: '随手记', at: DateTime.utc(2026, 8, 1)));

    final LightRecordQuery q = LightRecordQuery(persistence: p);
    expect(await q.search(''), isEmpty);
    expect(await q.search('   '), isEmpty);
    // …and the tab's non-searching face is still populated, so "empty in, empty out" is a
    // statement about the METHOD and never about what the user sees.
    expect(await q.all(), hasLength(1));
  });

  test('🔴 201 paired hits + one older cloud hit — the light note is still '
      'found (the origin narrowing runs BEFORE any truncation)', () async {
    final TimelinePersistence p = await _open();
    // The light note is the OLDEST row on purpose: `search` is newest-first and
    // truncates at 200, so an implementation that searches everything first and
    // filters origin afterwards drops precisely this row. The user's situation
    // is the ordinary one — plenty of dictation to a PC, a handful of notes.
    await p.upsert(_entry('cloud-buried',
        origin: 'cloud', text: '密码提示在抽屉里', at: DateTime.utc(2026, 1, 1)));
    for (int i = 0; i < 201; i++) {
      await p.upsert(_entry('paired-$i',
          origin: 'paired',
          text: '这条也提到了密码',
          at: DateTime.utc(2026, 8, 1).add(Duration(minutes: i))));
    }

    final LightRecordQuery q = LightRecordQuery(persistence: p);
    expect(
      _ids(await q.search('密码')),
      <String>['cloud-buried'],
      reason: 'the paired rows are not light records, and the light record is '
          'below the 200-row search limit — narrowing first is what finds it',
    );
  });

  test('a light record deep in history is reachable without paging to it',
      () async {
    final TimelinePersistence p = await _open();
    await p.upsert(_entry('cloud-ancient',
        origin: 'cloud', text: '很久以前的那件事', at: DateTime.utc(2025, 3, 3)));
    for (int i = 0; i < 300; i++) {
      await p.upsert(_entry('cloud-$i',
          origin: 'cloud',
          text: '日常一条 $i',
          at: DateTime.utc(2026, 8, 1).add(Duration(minutes: i))));
    }

    final LightRecordQuery q = LightRecordQuery(persistence: p);
    expect(_ids(await q.search('很久以前')), <String>['cloud-ancient']);
  });

  test('the match is case-insensitive and treats % and _ as literals, exactly '
      'as the storage layer does', () async {
    final TimelinePersistence p = await _open();
    await p.upsert(_entry('cloud-en',
        origin: 'cloud', text: 'Deploy the SERVER', at: DateTime.utc(2026, 8, 1)));
    await p.upsert(_entry('cloud-pct',
        origin: 'cloud', text: 'battery at 90% now', at: DateTime.utc(2026, 8, 2)));

    final LightRecordQuery q = LightRecordQuery(persistence: p);
    expect(_ids(await q.search('server')), <String>['cloud-en']);
    expect(_ids(await q.search('SERVER')), <String>['cloud-en']);
    expect(_ids(await q.search('90%')), <String>['cloud-pct']);
    // A bare '%' is a literal, never match-all.
    expect(_ids(await q.search('%')), <String>['cloud-pct']);
  });
}
