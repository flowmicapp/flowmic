// SPEC-REF:
//   apps/mobile/lib/src/timeline/timeline_sqlite.dart (kOutboxTable schema,
//     v1→v2 additive migration)
//   docs/strategy/2026-07-31-mobile-outbox-design-draft.md §3.1 (persist to disk before sending)
//
// The outbox's disk. Deliberately thin: it stores and returns [OutboxItem]s and
// makes no decisions about them — every rule about WHEN an item may move lives
// in DeliveryOutbox, so there is one place to read the queue's behaviour rather
// than two halves that have to be mentally joined.
//
// WHY A SEAM AT ALL. The same reason TimelinePersistence has one: the queue's
// contract has to be provable without a device. `SqfliteOutboxStore` runs the
// REAL SQL on the host VM under sqflite_common_ffi, so the schema and the
// statements are exercised rather than agreed with by a stub (doc 13 §7 F1 ③).

import 'package:sqflite/sqflite.dart';

import 'outbox_item.dart';

/// 窗口B3-2a — the persistent delivery outbox table (this project's FIRST
/// store-and-forward queue).
///
/// It lives in the SAME database file as the timeline deliberately: an enqueue
/// is 「persisted to disk before sending」 and the row it settles onto is
/// written in the same breath,
/// so one database means one transaction domain and no window in which a
/// delivery exists without its row (or the reverse).
///
/// DECLARED HERE, not next to the DDL in timeline_sqlite.dart, purely to keep
/// the import graph one-directional: timeline_sqlite (which owns the schema
/// version and the migration) imports this file; this file imports nothing of
/// it. The alternative was a legal-but-pointless library cycle.
const String kOutboxTable = 'outbox_items';

abstract class OutboxStore {
  /// Write [item], replacing any row with the same `request_id`.
  ///
  /// Awaited by every caller: 「persist to disk before sending」 is only true
  /// if the write has
  /// actually happened before the emit, so this must never be fire-and-forget
  /// the way the timeline's own `_persistOne` can afford to be.
  Future<void> upsert(OutboxItem item);

  /// Every item that still owes a delivery (queued + inflight), OLDEST FIRST.
  ///
  /// Order is part of the contract, not an implementation detail: owner ruled
  /// 「try to sync over everything that hasn't been synced yet」 and a queue
  /// that drains newest-first would
  /// deliver a conversation backwards.
  Future<List<OutboxItem>> loadPending();

  /// Everything, newest-enqueued first. Diagnostics + the terminal-state reader.
  Future<List<OutboxItem>> loadAll();

  // ⚠️ `countPending()` LIVED HERE AND WAS DELETED IN 窗口B3-2b, deliberately.
  // Its doc said 「B3-2b's 「N items still not delivered」 reads this」 — and
  // when that card
  // came to build the surface, it needed the ROWS anyway (which ones are still
  // `queued`, which still hold picture bytes), so `DeliveryOutbox._refreshDerived`
  // takes one `loadPending()` and counts its length. That left this method with
  // ZERO production callers and two test assertions, i.e. the exact façade the
  // note under this class warns about, in the class that warns about it.
  //
  // Nothing is lost: it shared `_pendingWhere` with [loadPending], so the tests
  // that asserted it assert the same predicate through `loadPending().length`.

  Future<OutboxItem?> findByRequestId(String requestId);
}

// ⚠️ THERE IS DELIBERATELY NO `delete`. Every settled item — delivered, refused,
// or dropped by the overflow trim — is KEPT with its terminal state, because a
// row that is gone cannot answer 「what actually happened to it」 and 「it got
// cleared」 must never
// degrade into 「there was never anything there」 across a restart. A delete
// method with no
// production caller would also be exactly the façade this repo keeps paying for
// (anti-façade: grep the caller, or the capability does not exist).

class SqfliteOutboxStore implements OutboxStore {
  SqfliteOutboxStore(this._db);

  final Database _db;

  /// Serialises writes, same argument as SqfliteTimelinePersistence: the queue
  /// issues writes in mutation order, and without this the loser of two writes
  /// to one id would be whichever finished last rather than whichever happened
  /// last.
  Future<void> _writes = Future<void>.value();

  Future<T> _serialize<T>(Future<T> Function() op) {
    final Future<T> next = _writes.then((_) => op());
    _writes = next.then((_) {}).catchError((Object _) {});
    return next;
  }

  static const String _pendingWhere = 'delivery_state IN (?, ?)';
  static List<Object?> get _pendingArgs => <Object?>[
    OutboxDeliveryState.queued.name,
    OutboxDeliveryState.inflight.name,
  ];

  @override
  Future<void> upsert(OutboxItem item) => _serialize(
    () => _db.insert(
      kOutboxTable,
      item.toJson(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    ),
  );

  @override
  Future<List<OutboxItem>> loadPending() => _decode(
    _db.query(
      kOutboxTable,
      where: _pendingWhere,
      whereArgs: _pendingArgs,
      orderBy: 'enqueued_at ASC',
    ),
  );

  @override
  Future<List<OutboxItem>> loadAll() =>
      _decode(_db.query(kOutboxTable, orderBy: 'enqueued_at DESC'));

  @override
  Future<OutboxItem?> findByRequestId(String requestId) async {
    final List<OutboxItem> hit = await _decode(
      _db.query(
        kOutboxTable,
        where: 'request_id = ?',
        whereArgs: <Object?>[requestId],
        limit: 1,
      ),
    );
    return hit.isEmpty ? null : hit.first;
  }

  /// A row that will not parse is SKIPPED, never substituted — same rule the
  /// timeline decoder states: half an item is worse than a gap.
  Future<List<OutboxItem>> _decode(
    Future<List<Map<String, Object?>>> rows,
  ) async {
    final List<OutboxItem> out = <OutboxItem>[];
    for (final Map<String, Object?> r in await rows) {
      final OutboxItem? item = OutboxItem.fromJson(r);
      if (item != null) out.add(item);
    }
    return out;
  }
}

/// A legitimate test double (the ban in doc 13 §7 F1 ② is on production-path
/// DEFAULTS, not on doubles). Never constructed by production code —
/// `DeliveryOutbox` takes its store as a required parameter for exactly that
/// reason.
class InMemoryOutboxStore implements OutboxStore {
  final Map<String, OutboxItem> _items = <String, OutboxItem>{};

  @override
  Future<void> upsert(OutboxItem item) async {
    _items[item.requestId] = item;
  }

  @override
  Future<List<OutboxItem>> loadPending() async {
    final List<OutboxItem> pending =
        _items.values.where((OutboxItem i) => i.isPending).toList()
          ..sort((OutboxItem a, OutboxItem b) =>
              a.enqueuedAt.compareTo(b.enqueuedAt));
    return pending;
  }

  @override
  Future<List<OutboxItem>> loadAll() async {
    final List<OutboxItem> all = _items.values.toList()
      ..sort((OutboxItem a, OutboxItem b) =>
          b.enqueuedAt.compareTo(a.enqueuedAt));
    return all;
  }

  @override
  Future<OutboxItem?> findByRequestId(String requestId) async =>
      _items[requestId];
}
