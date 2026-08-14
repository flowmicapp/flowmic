// V2-06a-2 step 1 — every mutation must name the ROW it changed.
//
// This exists because the change it guards is invisible to every other test:
// swapping `saveAll(whole table)` for `upsert(one row)` altered no behaviour,
// no output and no assertion — all 529 tests stayed green through it. A cost
// property nobody asserts is a cost property anyone can quietly undo, and the
// undo would look like a cleanup.
//
// It is also the reason the interface was widened BEFORE the storage engine was
// swapped: SQLite underneath `saveAll(whole table)` would run SQLite and be
// exactly as slow — success-shaped, and undiagnosable from the outside.

import 'support/di.dart';
import 'package:flowmic/src/signaling/wire_payloads.dart' show Delivery, FlowMode;
import 'package:flowmic/src/timeline/timeline_entry.dart';
import 'package:flowmic/src/timeline/timeline_persistence.dart';
import 'package:flowmic/src/timeline/timeline_store.dart';
import 'package:flutter_test/flutter_test.dart';

/// Counts which persistence calls a mutation actually makes.
class _CountingPersistence implements TimelinePersistence {
  final InMemoryTimelinePersistence _inner = InMemoryTimelinePersistence();
  int saveAllCalls = 0;
  final List<String> upserted = <String>[];
  final List<String> deleted = <String>[];

  @override
  Future<List<TimelineEntry>> loadAll() => _inner.loadAll();

  @override
  Future<void> upsert(TimelineEntry entry) {
    upserted.add(entry.id);
    return _inner.upsert(entry);
  }

  @override
  Future<void> delete(String id) {
    deleted.add(id);
    return _inner.delete(id);
  }

  @override
  Future<void> saveAll(List<TimelineEntry> entries) {
    saveAllCalls += 1;
    return _inner.saveAll(entries);
  }

  // V2-06b read paths — delegated, not stubbed. This fake counts WRITES; a
  // hand-written empty read here would quietly break any future test that
  // seeded through it.
  @override
  Future<List<TimelineEntry>> loadPage({DateTime? before, required int limit}) =>
      _inner.loadPage(before: before, limit: limit);

  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 200}) =>
      _inner.search(query, limit: limit);
}

void main() {
  late _CountingPersistence p;
  late TimelineStore store;

  setUp(() {
    p = _CountingPersistence();
    store = TimelineStore(persistence: p,reaper: newTestReaper(persistence: p), deviceId: 'phone');
  });

  TimelineEntry add(String clientId) => store.buildFromUtterance(
    clientId: clientId,
    mode: FlowMode.realtime,
    delivery: Delivery.none,
    text: clientId,
  );

  test('creating a row upserts ONLY that row — never the whole table', () async {
    add('u1');
    add('u2');
    await Future<void>.delayed(Duration.zero); // let the fire-and-forget land

    expect(p.upserted, hasLength(2));
    expect(
      p.saveAllCalls,
      0,
      reason: 'saveAll is for migration and tests — a mutation path must not use it',
    );
  });

  test('a write-back upserts the ONE changed row', () async {
    add('u1');
    add('u2');
    p.upserted.clear();

    store.applyInjectResult(correlationId: 'u1', ok: true, pcName: 'PC-A');
    await Future<void>.delayed(Duration.zero);

    expect(p.upserted, hasLength(1), reason: 'one row changed, one row written');
    expect(p.saveAllCalls, 0);
  });

  test('delete names the id and does not rewrite the table', () async {
    final TimelineEntry e = add('u1');
    add('u2');
    p.upserted.clear();

    store.delete(e.id);
    await Future<void>.delayed(Duration.zero);

    expect(p.deleted, <String>[e.id]);
    expect(p.saveAllCalls, 0);
  });

  test('the cost stays flat as the table grows — 1 write per mutation, always', () async {
    // The actual property under guard. With `saveAll(whole table)` the work per
    // mutation grew with the table; here the 50th row costs the same as the 1st.
    for (int i = 0; i < 50; i++) {
      add('u$i');
    }
    await Future<void>.delayed(Duration.zero);

    expect(p.upserted, hasLength(50));
    expect(p.saveAllCalls, 0);
  });
}
