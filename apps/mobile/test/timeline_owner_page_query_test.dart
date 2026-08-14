// Card F10 — the owner-scoped page, against a REAL database.
//
// The defect this file guards is not「the SQL is wrong」but「there is no SQL」:
// the per-instance chat screen used to render an in-memory filter over
// `loadPage(limit: 60)`, a query with NO owner predicate. Connect to a PC you
// last spoke to yesterday and the screen was empty while every row sat in the
// table.
//
// Runs on sqflite_common_ffi rather than a fake persistence on purpose: a fake
// agrees with whatever SQL I wrote, including SQL that does not compile, and
// the whole point of this card is that the query is real (13 册 §7 F1 ③).

import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/owner_timeline_pager.dart';
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

TimelineEntry _entry(String id, {required DateTime at, String? owner}) =>
    TimelineEntry(
      id: id,
      clientId: id,
      mode: FlowMode.realtime,
      delivery: Delivery.none,
      sourceText: id,
      outputText: id,
      status: EntryStatus.noted,
      createdAt: at,
      updatedAt: at,
      spokenToInstanceId: owner,
      spokenToInstanceName: owner == null ? null : 'name-of-$owner',
    );

List<String> _ids(List<TimelineEntry> rows) =>
    rows.map((TimelineEntry e) => e.id).toList(growable: false);

void main() {
  setUpAll(sqfliteFfiInit);

  late TimelinePersistence persistence;

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    // sqflite_common_ffi keys in-memory databases BY PATH — without the delete
    // every test in this process shares one table.
    await databaseFactoryFfi.deleteDatabase(inMemoryDatabasePath);
    final TimelineStorageOpen open = await openTimelinePersistence(
      prefs: await SharedPreferences.getInstance(),
      factory: databaseFactoryFfi,
      path: inMemoryDatabasePath,
    );
    expect(open.kind, TimelineStorageKind.sqlite,
        reason: 'this file is about the SQL; a fallback store proves nothing');
    persistence = open.persistence;
  });

  test('the SQLite store can answer the narrowed question at all', () {
    // The capability is discovered by TYPE, so if this ever stops holding the
    // pager silently drops to its scan path and the query goes untested.
    expect(persistence, isA<OwnerScopedTimelineSource>());
  });

  test(
    'F10: owner rows OLDER than the globally newest page are still returned',
    () async {
      final DateTime base = DateTime.utc(2026, 8, 1);
      // The shape of the bug: 80 rows for a PC used today, 5 rows for the PC we
      // are opening, all of them older. The unscoped newest page (60) contains
      // NONE of the five.
      for (int i = 0; i < 5; i++) {
        await persistence.upsert(
          _entry('mine-$i', at: base.add(Duration(minutes: i)), owner: 'pc-A'),
        );
      }
      for (int i = 0; i < 80; i++) {
        await persistence.upsert(
          _entry('other-$i',
              at: base.add(Duration(days: 1, minutes: i)), owner: 'pc-B'),
        );
      }

      // 【unit-test】the unscoped page is the defect, verbatim.
      final List<TimelineEntry> unscoped = await persistence.loadPage(limit: 60);
      expect(
        unscoped.where((TimelineEntry e) => e.spokenToInstanceId == 'pc-A'),
        isEmpty,
        reason: 'baseline: this is exactly what the chat page used to filter',
      );

      final List<TimelineEntry> scoped =
          await (persistence as OwnerScopedTimelineSource).loadOwnerPage(
        ownerIds: <String>{'pc-A'},
        limit: 60,
      );
      expect(_ids(scoped),
          <String>['mine-4', 'mine-3', 'mine-2', 'mine-1', 'mine-0']);
    },
  );

  test('F2 contract: the predicate is owner ∈ SET, not owner ==', () async {
    // F2 (docs/strategy/2026-08-04-f2-machine-merge-design.md §5 phase 3) widens the
    // owner of a chat view to every pairing id of the same physical machine.
    // This asserts the widening is an ARGUMENT change, available today.
    final DateTime base = DateTime.utc(2026, 8, 1);
    await persistence.upsert(_entry('a', at: base, owner: 'lan-1'));
    await persistence.upsert(
      _entry('b', at: base.add(const Duration(minutes: 1)), owner: 'relay-1'),
    );
    await persistence.upsert(
      _entry('c', at: base.add(const Duration(minutes: 2)), owner: 'elsewhere'),
    );

    final List<TimelineEntry> merged =
        await (persistence as OwnerScopedTimelineSource).loadOwnerPage(
      ownerIds: <String>{'lan-1', 'relay-1'},
      limit: 60,
    );
    // Newest-first across the union, and the third machine stays out.
    expect(_ids(merged), <String>['b', 'a']);
  });

  test('keyset paging walks upward and stops', () async {
    final DateTime base = DateTime.utc(2026, 8, 1);
    for (int i = 0; i < 5; i++) {
      await persistence.upsert(
        _entry('r-$i', at: base.add(Duration(minutes: i)), owner: 'pc-A'),
      );
    }
    final OwnerScopedTimelineSource src =
        persistence as OwnerScopedTimelineSource;

    final List<TimelineEntry> page1 =
        await src.loadOwnerPage(ownerIds: <String>{'pc-A'}, limit: 2);
    expect(_ids(page1), <String>['r-4', 'r-3']);

    final List<TimelineEntry> page2 = await src.loadOwnerPage(
      ownerIds: <String>{'pc-A'},
      before: page1.last.createdAt,
      limit: 2,
    );
    // Strict `<`: the boundary row is not handed out twice.
    expect(_ids(page2), <String>['r-2', 'r-1']);

    final List<TimelineEntry> page3 = await src.loadOwnerPage(
      ownerIds: <String>{'pc-A'},
      before: page2.last.createdAt,
      limit: 2,
    );
    expect(_ids(page3), <String>['r-0']);
  });

  test('an EMPTY owner set means nothing, never everything', () async {
    // 🔴 The one way this API could recreate the bug it fixes: answering
    // 「no owner」with an unscoped page. Requirement ④ says a view with no identity shows
    // none of anyone's history.
    await persistence.upsert(
      _entry('x', at: DateTime.utc(2026, 8, 1), owner: 'pc-A'),
    );
    final List<TimelineEntry> rows =
        await (persistence as OwnerScopedTimelineSource).loadOwnerPage(
      ownerIds: const <String>{},
      limit: 60,
    );
    expect(rows, isEmpty);
  });

  test('legacy rows with no owner never fall into an instance', () async {
    final DateTime base = DateTime.utc(2026, 8, 1);
    await persistence.upsert(_entry('legacy', at: base));
    await persistence.upsert(
      _entry('owned', at: base.add(const Duration(minutes: 1)), owner: 'pc-A'),
    );
    final List<TimelineEntry> rows =
        await (persistence as OwnerScopedTimelineSource).loadOwnerPage(
      ownerIds: <String>{'pc-A'},
      limit: 60,
    );
    expect(_ids(rows), <String>['owned']);
  });
}
