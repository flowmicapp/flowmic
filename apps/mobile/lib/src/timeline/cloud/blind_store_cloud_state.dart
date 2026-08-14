// E-CL — this phone's belief about what is in its account's blind store.
//
// SPEC-REF: docs/strategy/2026-08-08-design-e-blindstore-client.md §3.1
//   (push is idempotent by id+ciphertext ⇒ the client may re-push safely), §4
//   / §4.1 (per-entry deletion + a pending-delete set: 「written in the same
//   transaction that deletes the local row」, drained on the next
//   authenticated cloud connection, idempotent, bounded, 「must not say it
//   was deleted from the cloud before the server's ack arrives」).
//
// ── WHY A TABLE AND NOT A FLAG ON THE ROW ───────────────────────────────────
// Two of the three states this answers are about rows that NO LONGER EXIST
// locally: a pending delete outlives its timeline row by definition (that is the
// whole point — the row is gone here and still up there). A column on
// `timeline_entries` cannot hold it.
//
// ── WHAT ONE ROW MEANS ──────────────────────────────────────────────────────
//   state='pushed'         — the cloud holds this entry, and the copy up there
//                            matches `payload_hash`. Written only on an ACK.
//   state='pending_delete' — the local row is gone and the cloud copy is not,
//                            yet. Cleared only on a tombstone ACK.
//   NO ROW                 — nothing of this entry is in the cloud and nothing
//                            is owed. An entry that was never pushed and then
//                            deleted leaves no row, so it costs no tombstone.
//
// 🔴 This is ONE question with a state machine, not two questions sharing a
// table: 「what state is this entry in, in the cloud」. The distinction matters because this repo's
// headline bug is a value answering two questions — so it is worth saying which
// one this is, and that `payload_hash` is meaningless (and NULL) once the state
// is pending_delete, because there is no content left to fingerprint.

import 'package:meta/meta.dart';
import 'package:sqflite/sqflite.dart';

/// The table. Declared here, next to everything that understands it, and
/// imported by timeline_sqlite.dart — the same one-directional arrangement
/// `kOutboxTable` / `kInstanceMachineMapTable` already use.
const String kBlindStoreCloudStateTable = 'timeline_cloud_state';

/// Column values. One spelling, shared by the store below and by the
/// transactional deleter in timeline_sqlite.dart, so the two cannot drift.
const String kBlindStoreStatePushed = 'pushed';
const String kBlindStoreStatePendingDelete = 'pending_delete';

/// Build a row for [kBlindStoreCloudStateTable]. The single writer of this
/// shape, for the same reason `_row` is the single writer of a timeline row.
Map<String, Object?> blindStoreCloudStateRow({
  required String entryId,
  required String state,
  required String? payloadHash,
  required int nowMs,
}) => <String, Object?>{
  'entry_id': entryId,
  'state': state,
  'payload_hash': payloadHash,
  'updated_at': nowMs,
};

/// The local ledger of cloud state.
abstract interface class BlindStoreCloudStateStore {
  /// entry id → the payload hash the cloud acknowledged. Entries absent from
  /// this map have never been pushed (or have been tombstoned).
  Future<Map<String, String>> pushedHashes();

  /// Ids whose cloud copy is owed a tombstone. Oldest first, so a bounded drain
  /// makes progress on the oldest debt instead of starving it.
  Future<List<String>> pendingDeletes();

  /// Record an ACKED push. 🔴 Callers must only call this after the server
  /// answered — recording an intent would make [pushedHashes] a list of things
  /// we MEANT to upload, and the next launch would skip them forever.
  Future<void> markPushed({required String entryId, required String payloadHash});

  /// Forget these ids entirely — the tombstone was ACKED, or a remote tombstone
  /// was applied locally, so nothing is owed in either direction.
  Future<void> forget(Iterable<String> entryIds);
}

/// The atomic half of a local delete.
///
/// 🔴 Implemented by `SqfliteTimelinePersistence` (which owns the timeline
/// table) rather than by the store above, so the two writes land in ONE sqflite
/// transaction. Design §4.1: 「删本地行的同一个事务里写入（不许"先删后记"，中间崩了
/// 就永久漏删）」("written in the same transaction that deletes the local
/// row — never 'delete then record'; a crash in between causes a permanent,
/// missed deletion").
///
/// The failure this prevents is not theoretical and both orderings are bad:
///   · delete the row first, crash → the cloud copy is orphaned FOREVER, with
///     nothing on the device that remembers it exists. Silent, permanent, and
///     it violates the ruling that a delete frees the space up there.
///   · write the marker first, crash → the cloud copy is tombstoned while the
///     local row is still on screen; the uploader would then re-push it and
///     resurrect what the user deleted.
/// One transaction has neither state.
abstract interface class BlindStoreRowDeleter {
  /// Delete the timeline row AND, iff the cloud is known to hold a copy, leave
  /// a pending tombstone — atomically. Returns true iff a tombstone was queued.
  ///
  /// An entry with no `pushed` row queues nothing: there is nothing up there to
  /// delete, and a tombstone for an id the server never had would be a wire
  /// round-trip that can only answer 「0 rows affected」.
  Future<bool> deleteRowAndQueueTombstone(String entryId, {required int nowMs});
}

/// Production store — the same database the timeline and the outbox live in.
///
/// Serves BOTH roles above: it is the ledger, and it is the atomic deleter. They
/// are one object because [BlindStoreRowDeleter] has to write this file's table
/// and the timeline's table inside ONE `db.transaction`, and only something
/// holding this [Database] can do that.
///
/// ⚠️ [timelineTable] is INJECTED rather than imported, and that is structural,
/// not stylistic: `timeline_sqlite.dart` (which owns that table) imports THIS
/// file for the schema and the constants above, so importing it back would be a
/// cycle — and `verify/lint/circular.mjs` rejects those. Passing the name keeps
/// the arrow pointing one way. The composition point passes `kTimelineTable`
/// verbatim, so there is exactly one spelling in the tree.
class SqfliteBlindStoreCloudStateStore
    implements BlindStoreCloudStateStore, BlindStoreRowDeleter {
  SqfliteBlindStoreCloudStateStore(this._db, {required this.timelineTable});

  final Database _db;

  /// The timeline table's name — see the class doc for why it arrives this way.
  final String timelineTable;

  /// The shared connection, for the ONE test that has to prove atomicity.
  ///
  /// A transaction can only be shown to roll back by making it fail half way,
  /// and that needs a second store over the SAME database pointed at a table
  /// that does not exist. There is no way to observe that from outside the
  /// class, so the seam is named and marked rather than left to a test reaching
  /// through a private field.
  @visibleForTesting
  Database get rawDatabaseForTest => _db;

  @override
  Future<bool> deleteRowAndQueueTombstone(
    String entryId, {
    required int nowMs,
  }) async {
    bool queued = false;
    await _db.transaction((Transaction txn) async {
      // Is there anything up there to delete? Only a `pushed` row proves the
      // cloud holds a copy. Without this check every local delete would queue a
      // tombstone, including for entries that never left the device — a round
      // trip whose only possible answer is 「0 rows affected」.
      final List<Map<String, Object?>> existing = await txn.query(
        kBlindStoreCloudStateTable,
        columns: <String>['state'],
        where: 'entry_id = ? AND state = ?',
        whereArgs: <Object?>[entryId, kBlindStoreStatePushed],
        limit: 1,
      );
      if (existing.isNotEmpty) {
        await txn.insert(
          kBlindStoreCloudStateTable,
          blindStoreCloudStateRow(
            entryId: entryId,
            state: kBlindStoreStatePendingDelete,
            // No content is left to fingerprint — see the header.
            payloadHash: null,
            nowMs: nowMs,
          ),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
        queued = true;
      } else {
        // Nothing owed either way: drop any stale ledger row with the timeline
        // row, so the table cannot grow entries for rows that no longer exist.
        await txn.delete(
          kBlindStoreCloudStateTable,
          where: 'entry_id = ?',
          whereArgs: <Object?>[entryId],
        );
      }
      await txn.delete(
        timelineTable,
        where: 'id = ?',
        whereArgs: <Object?>[entryId],
      );
    });
    return queued;
  }

  @override
  Future<Map<String, String>> pushedHashes() async {
    final List<Map<String, Object?>> rows = await _db.query(
      kBlindStoreCloudStateTable,
      columns: <String>['entry_id', 'payload_hash'],
      where: 'state = ?',
      whereArgs: <Object?>[kBlindStoreStatePushed],
    );
    final Map<String, String> out = <String, String>{};
    for (final Map<String, Object?> r in rows) {
      final Object? id = r['entry_id'];
      final Object? hash = r['payload_hash'];
      // A `pushed` row with no hash cannot answer 「是不是当前内容」("whether
      // this is the current content"), so it is
      // skipped and the entry re-pushes. Wasteful, never wrong — and the server
      // is idempotent about it.
      if (id is String && hash is String && hash.isNotEmpty) out[id] = hash;
    }
    return out;
  }

  @override
  Future<List<String>> pendingDeletes() async {
    final List<Map<String, Object?>> rows = await _db.query(
      kBlindStoreCloudStateTable,
      columns: <String>['entry_id'],
      where: 'state = ?',
      whereArgs: <Object?>[kBlindStoreStatePendingDelete],
      orderBy: 'updated_at ASC',
    );
    return <String>[
      for (final Map<String, Object?> r in rows)
        if (r['entry_id'] is String) r['entry_id']! as String,
    ];
  }

  @override
  Future<void> markPushed({
    required String entryId,
    required String payloadHash,
  }) async {
    await _db.insert(
      kBlindStoreCloudStateTable,
      blindStoreCloudStateRow(
        entryId: entryId,
        state: kBlindStoreStatePushed,
        payloadHash: payloadHash,
        nowMs: DateTime.now().toUtc().millisecondsSinceEpoch,
      ),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  @override
  Future<void> forget(Iterable<String> entryIds) async {
    final List<String> ids = entryIds.toList(growable: false);
    if (ids.isEmpty) return;
    final String slots = List<String>.filled(ids.length, '?').join(', ');
    await _db.delete(
      kBlindStoreCloudStateTable,
      where: 'entry_id IN ($slots)',
      whereArgs: <Object?>[...ids],
    );
  }
}

/// In-memory store — tests only. Records honestly; substitutes nothing.
class InMemoryBlindStoreCloudStateStore implements BlindStoreCloudStateStore {
  final Map<String, String> _pushed = <String, String>{};
  final List<String> _pending = <String>[];

  /// Seed a pending tombstone the way a local delete would have.
  void seedPendingDelete(String entryId) {
    _pushed.remove(entryId);
    if (!_pending.contains(entryId)) _pending.add(entryId);
  }

  @override
  Future<Map<String, String>> pushedHashes() async =>
      Map<String, String>.from(_pushed);

  @override
  Future<List<String>> pendingDeletes() async =>
      List<String>.from(_pending);

  @override
  Future<void> markPushed({
    required String entryId,
    required String payloadHash,
  }) async {
    _pushed[entryId] = payloadHash;
  }

  @override
  Future<void> forget(Iterable<String> entryIds) async {
    for (final String id in entryIds) {
      _pushed.remove(id);
      _pending.remove(id);
    }
  }
}
