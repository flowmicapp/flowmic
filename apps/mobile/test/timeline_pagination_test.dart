// V2-06b — TimelineStore paging and search.
//
// The failure this guards is specific and quiet: with the 100-row cap gone, a
// store that still calls loadAll() works perfectly in every test and blocks the
// first frame on a year of history in someone's hand. And a search that filters
// `entries` instead of asking storage finds LESS THE LESS YOU HAVE SCROLLED —
// which reads as「this one was never recorded」, not as a bug in the search box.

import 'support/di.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

TimelineEntry _row(int i, {String text = 'row'}) {
  final DateTime t = DateTime.utc(2026, 1, 1).add(Duration(minutes: i));
  return TimelineEntry(
    id: 'e$i',
    clientId: 'e$i',
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    sourceText: '$text-$i',
    outputText: '$text-$i',
    status: EntryStatus.noted,
    createdAt: t,
    updatedAt: t,
  );
}

/// Counts how storage is actually asked for rows.
///
/// COMPOSITION, not `extends`. A subclass spy also counts the implementation's
/// internal self-calls — InMemoryTimelinePersistence.loadPage happens to filter
/// loadAll(), so an inherited counter reports「store called loadAll」when the
/// store did no such thing. That measures the fake's internals instead of the
/// store's behaviour, and the SQLite implementation (which queries directly)
/// would not have shown it at all.
class _CountingPersistence implements TimelinePersistence {
  final InMemoryTimelinePersistence _inner = InMemoryTimelinePersistence();
  int loadAllCalls = 0;
  int loadPageCalls = 0;
  int searchCalls = 0;

  @override
  Future<List<TimelineEntry>> loadAll() {
    loadAllCalls += 1;
    return _inner.loadAll();
  }

  @override
  Future<List<TimelineEntry>> loadPage({DateTime? before, required int limit}) {
    loadPageCalls += 1;
    return _inner.loadPage(before: before, limit: limit);
  }

  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 200}) {
    searchCalls += 1;
    return _inner.search(query, limit: limit);
  }

  @override
  Future<void> upsert(TimelineEntry entry) => _inner.upsert(entry);
  @override
  Future<void> delete(String id) => _inner.delete(id);
  @override
  Future<void> saveAll(List<TimelineEntry> entries) => _inner.saveAll(entries);
}

Future<_CountingPersistence> _seeded(int n, {String text = 'row'}) async {
  final _CountingPersistence p = _CountingPersistence();
  for (int i = 0; i < n; i++) {
    await p.upsert(_row(i, text: text));
  }
  p.loadAllCalls = 0; // seeding noise
  return p;
}

void main() {
  test('load() takes ONE page, not the whole table', () async {
    final _CountingPersistence p = await _seeded(TimelineStore.pageSize * 3);
    final TimelineStore store = TimelineStore(persistence: p, reaper: newTestReaper(persistence: p));
    addTearDown(store.dispose);

    await store.load();

    expect(store.entries, hasLength(TimelineStore.pageSize));
    expect(store.hasMore, isTrue);
    expect(
      p.loadAllCalls,
      0,
      reason: 'loadAll on an uncapped table is the whole problem this card fixes',
    );
  });

  test('loadMore() walks upward one page at a time and then stops', () async {
    final _CountingPersistence p = await _seeded(TimelineStore.pageSize * 2 + 5);
    final TimelineStore store = TimelineStore(persistence: p, reaper: newTestReaper(persistence: p));
    addTearDown(store.dispose);

    await store.load();
    await store.loadMore();
    expect(store.entries, hasLength(TimelineStore.pageSize * 2));
    expect(store.hasMore, isTrue);

    await store.loadMore();
    expect(store.entries, hasLength(TimelineStore.pageSize * 2 + 5));
    expect(
      store.hasMore,
      isFalse,
      reason: 'a short page means the top was reached — the UI needs to know',
    );

    // …and asking again once exhausted costs nothing.
    final int before = p.loadPageCalls;
    await store.loadMore();
    expect(p.loadPageCalls, before);
  });

  test('overlapping loadMore() calls do not stack — the scroll listener fires '
      'repeatedly near the top', () async {
    final _CountingPersistence p = await _seeded(TimelineStore.pageSize * 3);
    final TimelineStore store = TimelineStore(persistence: p, reaper: newTestReaper(persistence: p));
    addTearDown(store.dispose);

    await store.load();
    final int after1 = p.loadPageCalls;

    // Three near-simultaneous triggers, as a scroll listener produces.
    await Future.wait(<Future<void>>[
      store.loadMore(),
      store.loadMore(),
      store.loadMore(),
    ]);

    expect(
      p.loadPageCalls - after1,
      1,
      reason: 'three triggers, one page — otherwise rows arrive three times',
    );
    expect(store.entries, hasLength(TimelineStore.pageSize * 2));
  });

  test('no duplicate ids survive a page boundary', () async {
    final _CountingPersistence p = await _seeded(TimelineStore.pageSize * 2);
    final TimelineStore store = TimelineStore(persistence: p, reaper: newTestReaper(persistence: p));
    addTearDown(store.dispose);

    await store.load();
    await store.loadMore();

    final Set<String> ids = store.entries.map((TimelineEntry e) => e.id).toSet();
    expect(
      ids,
      hasLength(store.entries.length),
      reason: 'a duplicated row is a Flutter key collision, not a cosmetic issue',
    );
  });

  test('SEARCH ASKS STORAGE, NOT THE LOADED LIST — it finds rows the user has '
      'never scrolled to', () async {
    // The assertion that matters. The needle is the OLDEST row, so it is far
    // above the first page: a search implemented as `entries.where(...)` returns
    // nothing here and looks exactly like「that one was never recorded」.
    final _CountingPersistence p = _CountingPersistence();
    await p.upsert(_row(0, text: '很久以前说的那句关键词'));
    for (int i = 1; i < TimelineStore.pageSize * 3; i++) {
      await p.upsert(_row(i));
    }
    final TimelineStore store = TimelineStore(persistence: p, reaper: newTestReaper(persistence: p));
    addTearDown(store.dispose);

    await store.load();
    expect(
      store.entries.any((TimelineEntry e) => e.id == 'e0'),
      isFalse,
      reason: 'precondition: the needle is not in the loaded page',
    );

    final List<TimelineEntry> hits = await store.search('关键词');
    expect(hits, hasLength(1));
    expect(hits.single.id, 'e0');
    expect(p.searchCalls, 1);
  });

  test('search skips soft-deleted rows', () async {
    final _CountingPersistence p = _CountingPersistence();
    await p.upsert(_row(1, text: '找得到'));
    final TimelineEntry gone = _row(2, text: '找得到').copyWith(deleted: true);
    await p.upsert(gone);

    final TimelineStore store = TimelineStore(persistence: p, reaper: newTestReaper(persistence: p));
    addTearDown(store.dispose);
    await store.load();

    expect((await store.search('找得到')).map((TimelineEntry e) => e.id), <String>['e1']);
  });
}
