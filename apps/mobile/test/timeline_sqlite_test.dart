// V2-06a-2 step 2 — the SQLite store and the one-time shared_preferences import.
//
// These run against a REAL database (sqflite_common_ffi on the host VM), not a
// hand-written fake. A fake would agree with whatever SQL I wrote, including
// invalid SQL, and 13 册 §7 F1 ③ is explicit that a green unit test over a stub
// proves nothing about the thing it stands in for.
//
// The assertions are organised around the ways this change could quietly go
// wrong rather than around its API surface:
//   * the migration silently inventing a value for a field legacy rows lack;
//   * the migration running twice and duplicating the table;
//   * a failure leaving the user staring at an empty 全部历史 page;
//   * the cap being "removed" while something downstream still trims;
//   * the shared_preferences blob being deleted to be tidy.

import 'package:flowmic/src/settings/app_settings.dart' show AppLocale;
import 'package:flowmic/src/settings/app_strings.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_sqlite.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

TimelineEntry _entry(
  String id, {
  DateTime? at,
  String? owner,
  String text = 'hello',
  String entryType = TimelineEntry.kTranscript,
  EntryStatus status = EntryStatus.noted,
}) {
  final DateTime t = at ?? DateTime.utc(2026, 7, 28, 12);
  return TimelineEntry(
    id: id,
    clientId: id,
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    sourceText: text,
    outputText: text,
    status: status,
    createdAt: t,
    updatedAt: t,
    spokenToInstanceId: owner,
    spokenToInstanceName: owner == null ? null : 'name-of-$owner',
    entryType: entryType,
  );
}

/// A factory whose openDatabase always fails — the only honest way to exercise
/// the fallback branch.
class _BrokenFactory implements DatabaseFactory {
  @override
  Future<Database> openDatabase(String path, {OpenDatabaseOptions? options}) =>
      Future<Database>.error(StateError('disk is on fire'));

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<TimelineStorageOpen> _open(SharedPreferences prefs) =>
    openTimelinePersistence(
      prefs: prefs,
      factory: databaseFactoryFfi,
      path: inMemoryDatabasePath,
    );

void main() {
  setUpAll(sqfliteFfiInit);

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    // sqflite_common_ffi keys in-memory databases BY PATH, so every
    // openDatabase(':memory:') in this process hands back the SAME database.
    // Without this the tests leak rows into each other and the failures read
    // like production bugs. (Found the hard way — the 500-row test came back
    // with 512.)
    await databaseFactoryFfi.deleteDatabase(inMemoryDatabasePath);
  });

  group('the store itself', () {
    late TimelineStorageOpen open;

    setUp(() async {
      open = await _open(await SharedPreferences.getInstance());
      expect(open.kind, TimelineStorageKind.sqlite);
    });

    test('a row round-trips through real SQL with every field intact', () async {
      final TimelineEntry e = _entry('a', owner: 'inst-1', text: '你好世界');
      await open.persistence.upsert(e);

      final List<TimelineEntry> back = await open.persistence.loadAll();
      expect(back, hasLength(1));
      expect(back.first.id, 'a');
      expect(back.first.outputText, '你好世界');
      expect(back.first.spokenToInstanceId, 'inst-1');
      expect(back.first.spokenToInstanceName, 'name-of-inst-1');
      expect(back.first.createdAt, e.createdAt);
    });

    test('upsert on the same id REPLACES — the loc_ key is the identity', () async {
      await open.persistence.upsert(_entry('a', text: 'first'));
      await open.persistence.upsert(_entry('a', text: 'second'));

      final List<TimelineEntry> back = await open.persistence.loadAll();
      expect(back, hasLength(1), reason: 'two rows means the primary key is not doing its job');
      expect(back.first.outputText, 'second');
    });

    test('loadAll is newest-first', () async {
      await open.persistence.upsert(_entry('old', at: DateTime.utc(2026, 1, 1)));
      await open.persistence.upsert(_entry('new', at: DateTime.utc(2026, 7, 1)));
      await open.persistence.upsert(_entry('mid', at: DateTime.utc(2026, 4, 1)));

      final List<TimelineEntry> back = await open.persistence.loadAll();
      expect(back.map((TimelineEntry e) => e.id), <String>['new', 'mid', 'old']);
    });

    test('delete removes the row, and deleting a missing id is not an error', () async {
      await open.persistence.upsert(_entry('a'));
      await open.persistence.delete('a');
      expect(await open.persistence.loadAll(), isEmpty);

      // Idempotent by contract — the store fires deletes without awaiting them,
      // so a repeat must not become an exception nobody is there to catch.
      await open.persistence.delete('a');
      await open.persistence.delete('never-existed');
    });

    test('THE POINT OF THE CARD: no 100-row cap — 500 rows go in and 500 come '
        'back', () async {
      // The old store trimmed to maxPersistedEntries on every write, so a
      // 「全部历史」page silently forgot everything past 100. If anything
      // downstream still trims, this is where it shows.
      for (int i = 0; i < 500; i++) {
        await open.persistence.upsert(
          _entry('e$i', at: DateTime.utc(2026, 1, 1).add(Duration(minutes: i))),
        );
      }
      final List<TimelineEntry> back = await open.persistence.loadAll();
      expect(back, hasLength(500));
      expect(back.first.id, 'e499', reason: 'newest first');
    });
  });

  group('V2-06b upward-scroll pagination (keyset, not OFFSET)', () {
    late TimelinePersistence p;

    setUp(() async {
      p = (await _open(await SharedPreferences.getInstance())).persistence;
      // 10 rows, one per hour, oldest first.
      for (int i = 0; i < 10; i++) {
        await p.upsert(
          _entry('e$i', at: DateTime.utc(2026, 7, 28, i)),
        );
      }
    });

    test('the first page is the newest N', () async {
      final List<TimelineEntry> page = await p.loadPage(limit: 3);
      expect(page.map((TimelineEntry e) => e.id), <String>['e9', 'e8', 'e7']);
    });

    test('the next page continues from the last row, no gap and no repeat', () async {
      final List<TimelineEntry> first = await p.loadPage(limit: 3);
      final List<TimelineEntry> second =
          await p.loadPage(before: first.last.createdAt, limit: 3);
      expect(second.map((TimelineEntry e) => e.id), <String>['e6', 'e5', 'e4']);
      // Strict `<` — the boundary row must not come back a second time.
      expect(second.map((TimelineEntry e) => e.id), isNot(contains('e7')));
    });

    test('A ROW ARRIVING MID-SCROLL DOES NOT SHIFT THE PAGES', () async {
      // The reason this is keyset and not OFFSET. With OFFSET, a row landing
      // between two page fetches pushes everything down by one and the user
      // silently never sees the row that got pushed past the boundary — a
      // timeline that drops entries while you scroll past them.
      final List<TimelineEntry> first = await p.loadPage(limit: 3);
      await p.upsert(_entry('brand-new', at: DateTime.utc(2026, 7, 28, 23)));

      final List<TimelineEntry> second =
          await p.loadPage(before: first.last.createdAt, limit: 3);
      expect(
        second.map((TimelineEntry e) => e.id),
        <String>['e6', 'e5', 'e4'],
        reason: 'the new row is newer than the cursor — it cannot affect this page',
      );
    });

    test('the last page is short and the one after it is empty', () async {
      final List<TimelineEntry> page = await p.loadPage(
        before: DateTime.utc(2026, 7, 28, 2),
        limit: 5,
      );
      expect(page.map((TimelineEntry e) => e.id), <String>['e1', 'e0']);
      expect(
        await p.loadPage(before: page.last.createdAt, limit: 5),
        isEmpty,
      );
    });
  });

  group('V2-06b search', () {
    late TimelinePersistence p;

    setUp(() async {
      p = (await _open(await SharedPreferences.getInstance())).persistence;
    });

    test('CHINESE SUBSTRINGS MATCH — the case FTS5 would silently miss', () async {
      // FTS5's unicode61 tokeniser makes a space-free Chinese sentence ONE
      // token, so 「会议」 would not match 「今天的会议记录整理好了」. This assertion
      // is the reason the store uses LIKE. If anyone「upgrades」to FTS5, it dies
      // here rather than in a user's hands.
      await p.upsert(_entry('a', text: '今天的会议记录整理好了'));
      await p.upsert(_entry('b', text: '晚上去吃火锅'));

      final List<TimelineEntry> hits = await p.search('会议');
      expect(hits.map((TimelineEntry e) => e.id), <String>['a']);
    });

    test('is case-insensitive for latin text', () async {
      await p.upsert(_entry('a', text: 'Deploy the Server tonight'));
      expect((await p.search('SERVER')).single.id, 'a');
      expect((await p.search('server')).single.id, 'a');
    });

    test('a blank query returns NOTHING, not everything', () async {
      await p.upsert(_entry('a'));
      await p.upsert(_entry('b'));
      expect(await p.search(''), isEmpty);
      expect(await p.search('   '), isEmpty);
    });

    test('% and _ typed by the user are literals, not wildcards', () async {
      // Without escaping, searching 「%」 matches every row and the box looks
      // broken in the most confusing possible way.
      await p.upsert(_entry('pct', text: 'CPU 占用 90% 了'));
      await p.upsert(_entry('plain', text: '一切正常'));

      final List<TimelineEntry> hits = await p.search('90%');
      expect(hits.map((TimelineEntry e) => e.id), <String>['pct']);
      expect(await p.search('%'), hasLength(1), reason: 'literal %, not match-all');
    });

    test('searches the processed face too, and results are newest-first', () async {
      await p.upsert(_entry('old', at: DateTime.utc(2026, 1, 1), text: '关键词'));
      await p.upsert(_entry('new', at: DateTime.utc(2026, 7, 1), text: '关键词'));
      expect(
        (await p.search('关键词')).map((TimelineEntry e) => e.id),
        <String>['new', 'old'],
      );
    });

    test('does NOT match on window titles or PC names', () async {
      // A search for 「会议」 should find the sentences about the meeting, not
      // every row that happened to land in a window whose title said so.
      final TimelineEntry e = TimelineEntry(
        id: 'w',
        clientId: 'w',
        mode: FlowMode.realtime,
        delivery: Delivery.inject,
        sourceText: '完全无关的一句话',
        outputText: '完全无关的一句话',
        status: EntryStatus.injected,
        createdAt: DateTime.utc(2026, 7, 28),
        updatedAt: DateTime.utc(2026, 7, 28),
        pcName: '会议室电脑',
        injectTarget: const InjectTarget(
          windowTitle: '会议纪要.docx',
          processName: 'WINWORD.EXE',
          injectedAt: '',
        ),
      );
      await p.upsert(e);
      expect(await p.search('会议'), isEmpty);
    });
  });

  group('the one-time import from shared_preferences', () {
    /// Seeds the legacy blob the way the old store wrote it.
    Future<SharedPreferences> seedLegacy(List<TimelineEntry> rows) async {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      await SharedPrefsTimelinePersistence(prefs).saveAll(rows);
      return prefs;
    }

    test('carries the old rows over and marks itself done', () async {
      final SharedPreferences prefs = await seedLegacy(<TimelineEntry>[
        _entry('a', owner: 'inst-1'),
        _entry('b', at: DateTime.utc(2026, 7, 27)),
      ]);

      final TimelineStorageOpen open = await _open(prefs);
      expect(open.kind, TimelineStorageKind.sqlite);
      expect(open.importedRows, 2);
      expect(open.failure, isNull);

      final List<TimelineEntry> back = await open.persistence.loadAll();
      expect(back.map((TimelineEntry e) => e.id).toSet(), <String>{'a', 'b'});
      expect(prefs.getBool(kTimelineMigratedKey), isTrue);
    });

    test('DOES NOT INVENT the owner a legacy row never had', () async {
      // The migration is a MOVE, not an enrichment. Adopting an ownerless row
      // into 「whoever is connected right now」 would make history lie — the same
      // red line 需求③ drew against back-filling `now` onto old pairings.
      final SharedPreferences prefs = await seedLegacy(<TimelineEntry>[
        _entry('legacy'), // no owner, as every pre-V2-06a-1 row has none
      ]);

      final TimelineStorageOpen open = await _open(prefs);
      final TimelineEntry row = (await open.persistence.loadAll()).single;
      expect(row.spokenToInstanceId, isNull);
      expect(row.spokenToInstanceName, isNull);
    });

    test('is idempotent — a second open imports nothing and duplicates nothing',
        () async {
      final SharedPreferences prefs = await seedLegacy(<TimelineEntry>[
        _entry('a'),
        _entry('b'),
      ]);

      // Both opens hit the SAME in-memory database (ffi keys them by path), so
      // this is the real question: does opening twice double the table?
      final TimelineStorageOpen first = await _open(prefs);
      expect(first.importedRows, 2);

      final TimelineStorageOpen second = await _open(prefs);
      expect(second.importedRows, 0, reason: 'the flag should short-circuit it');
      expect(await second.persistence.loadAll(), hasLength(2));

      // …and belt-and-braces: even with the flag forced off, re-running the
      // import over a populated table collapses on the primary key rather than
      // doubling. Idempotency must not rest on the flag alone — a flag can be
      // lost (app data cleared, prefs migration), a PRIMARY KEY cannot.
      await prefs.remove(kTimelineMigratedKey);
      final TimelineStorageOpen third = await _open(prefs);
      expect(third.importedRows, 2, reason: 'it ran again, as intended');
      expect(
        await third.persistence.loadAll(),
        hasLength(2),
        reason: 'ran twice, still two rows — INSERT OR REPLACE did its job',
      );
    });

    test('NEVER deletes the legacy blob — it is the rollback net', () async {
      final SharedPreferences prefs = await seedLegacy(<TimelineEntry>[_entry('a')]);
      await _open(prefs);

      // Read it back through the legacy reader: the ≤100-row remnant stays.
      final List<TimelineEntry> stillThere =
          await SharedPrefsTimelinePersistence(prefs).loadAll();
      expect(stillThere, hasLength(1));
    });
  });

  group('when it fails', () {
    test('falls back to the OLD store with the history intact, and says why',
        () async {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      await SharedPrefsTimelinePersistence(prefs).saveAll(<TimelineEntry>[
        _entry('a', text: '用户真实存在的一条'),
      ]);

      final TimelineStorageOpen open = await openTimelinePersistence(
        prefs: prefs,
        factory: _BrokenFactory(),
        path: 'irrelevant',
      );

      expect(open.kind, TimelineStorageKind.sharedPrefsFallback);
      expect(open.failure, isNotNull);
      expect(open.failure, contains('disk is on fire'),
          reason: 'the reason must survive to the UI, not be flattened to a bool');

      // The whole point: the user still sees their history. An empty SQLite
      // store here would be the loudest possible lie about data they still have.
      final List<TimelineEntry> back = await open.persistence.loadAll();
      expect(back, hasLength(1));
      expect(back.first.outputText, '用户真实存在的一条');
    });

    test('leaves the migrated flag UNSET so the next launch retries', () async {
      final SharedPreferences prefs = await SharedPreferences.getInstance();
      await openTimelinePersistence(
        prefs: prefs,
        factory: _BrokenFactory(),
        path: 'irrelevant',
      );
      expect(prefs.getBool(kTimelineMigratedKey), isNot(isTrue));
    });

    test('the fallback footnote copy exists in both languages and does not '
        'promise the full history', () async {
      // Pairs with history_page_widget_test ④b: that one proves the page picks
      // the right sentence, this one proves the sentence itself is honest.
      for (final AppLocale l in AppLocale.values) {
        final AppStrings s = AppStrings.of(l);
        expect(s.historyFallbackNote.trim(), isNotEmpty);
        expect(s.historyFallbackNote, contains('100'));
        expect(s.historyFallbackNote, isNot(equals(s.historyAllPersisted)));
      }
    });
  });
}
