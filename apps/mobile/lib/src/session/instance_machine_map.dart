// SPEC-REF:
//   docs/strategy/2026-08-04-f2-machine-merge-design.md §3.2 (phase-2 on-disk
//     mapping table)
//   apps/mobile/lib/src/timeline/timeline_sqlite.dart (v5 DDL + version step)
//   apps/mobile/lib/src/session/machine_key.dart (the only reader)
//
// card F2 phase 2 — 「WHICH MACHINE DID THIS INSTANCE BELONG TO」, on disk.
//
// ── WHY THIS TABLE EXISTS AT ALL ─────────────────────────────────────────────
//
// Phase 1 answers that question from `TokenStorage.readPairings()`, which is
// correct and needs no migration — but it is only true while the pairing is
// still remembered. The day the user deletes one of the two pairings to one
// computer, every row born on it leaves the merged view (it stays in 「the
// full history」, so nothing is lost — but 「history for the same computer」
// silently gets shorter). This table
// is the remembering half: an instance id, once seen on a machine, keeps naming
// that machine after the pairing is gone.
//
// ── 🔴 IT IS DERIVED DATA, AND THAT DECIDES ITS FAILURE BEHAVIOUR ─────────────
//
// Every row here can be rebuilt from the pairing list and from any future ack.
// So the correct response to a write failure is 「don't merge this time, say so,
// try again next launch」 — never a rollback, never a wipe, and above all never
// a fallback that costs the user something REAL. See [seedInstanceMachineMap]:
// it runs AFTER `openTimelinePersistence` has returned, in its own try, for
// exactly that reason (design §3.2: a seed inside that function's broad catch
// would demote the whole history store to the 100-row shared_preferences
// fallback — 「downgrading the user's history for the sake of merging」, an
// order of magnitude worse than not merging).
//
// ── 🔴 IT IS NOT AN ADDRESS ──────────────────────────────────────────────────
//
// CLAUDE.md: never cross-wire ids. This maps an instance to a MACHINE for display and
// history only. It holds no `pc_id` and no endpoint, and like `machine_key.dart`
// it deliberately does not import `outbox_destination.dart` / `outbox_item.dart`
// — a delivery address is minted by `resolveOutboxTarget` from the live
// connection, and nothing in this file can be substituted for it.

import 'package:sqflite/sqflite.dart';

import '../auth/token_storage.dart';
import '../diag/diag_log.dart';

/// v5 (card F2). Declared here rather than next to the DDL for the same reason
/// [kOutboxTable] is: timeline_sqlite.dart imports this file, never the reverse.
const String kInstanceMachineMapTable = 'instance_machine_map';

/// Who wrote a row — forensics only, never a rule.
const String kMachineMapSourceSeed = 'seed';
const String kMachineMapSourceAck = 'ack';

/// The learned `instance_id → machine_uid` mapping.
abstract class InstanceMachineMap {
  /// Every remembered mapping. Read whole: it is one small row per pairing the
  /// phone has ever connected to, and the reader ([SessionScope]) needs the
  /// inverse (「who else is on this machine」), which no index would serve better.
  Future<Map<String, String>> readAll();

  /// Remember that [instanceId] lives on [machineUid], replacing any earlier
  /// answer for that instance.
  Future<void> put({
    required String instanceId,
    required String machineUid,
    required String source,
  });
}

class SqfliteInstanceMachineMap implements InstanceMachineMap {
  SqfliteInstanceMachineMap(this._db);

  final Database _db;

  @override
  Future<Map<String, String>> readAll() async {
    final List<Map<String, Object?>> rows = await _db.query(
      kInstanceMachineMapTable,
      columns: <String>['instance_id', 'machine_uid'],
    );
    return <String, String>{
      for (final Map<String, Object?> r in rows)
        (r['instance_id'] as String? ?? ''): (r['machine_uid'] as String? ?? ''),
    }..removeWhere((String k, String v) => k.isEmpty || v.isEmpty);
  }

  @override
  Future<void> put({
    required String instanceId,
    required String machineUid,
    required String source,
  }) async {
    // 🔴 Design §3.2: one instance id carrying two machine uids is normally
    // unreachable (the id is minted per pairing by the server that owns the
    // machine). If it happens anyway, last-write-wins AND says so — the newest
    // ack is the machine's newest self-report, and a silent overwrite would
    // erase the only evidence that the assumption broke.
    final List<Map<String, Object?>> was = await _db.query(
      kInstanceMachineMapTable,
      columns: <String>['machine_uid'],
      where: 'instance_id = ?',
      whereArgs: <Object?>[instanceId],
      limit: 1,
    );
    final String? previous = was.isEmpty
        ? null
        : was.single['machine_uid'] as String?;
    if (previous != null && previous != machineUid) {
      diag('machine_map.uid_changed', <String, Object?>{
        'instance_id': instanceId,
        'was': previous,
        'now': machineUid,
        'source': source,
      });
    }
    await _db.insert(kInstanceMachineMapTable, <String, Object?>{
      'instance_id': instanceId,
      'machine_uid': machineUid,
      'learned_at': DateTime.now().millisecondsSinceEpoch,
      'source': source,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }
}

/// For tests and for the shared_preferences fallback session, where there is no
/// database to write to.
///
/// 🔴 CORRECTION (IT-06 / anti-façade ④, 2026-08-05) — the sentence above is
/// kept as the expired claim. Grep of `InMemoryInstanceMachineMap` across
/// `apps/mobile` finds only: this class definition, and two constructions in
/// `apps/mobile/test/f2_machine_merge_test.dart` (test-only). There is NO
/// production call site that installs this class for the shared_preferences
/// fallback session. What production actually does on that path is install
/// `null` via `installInstanceMachineMap(storage.machineMap)` in
/// `apps/mobile/lib/main.dart` (where `machineMap` is null on the fallback —
/// see the comment at that call site). The reader that then answers 「which
/// machine」 is `SessionScope` in `apps/mobile/lib/src/session/machine_key.dart`
/// (`installedInstanceMachineMap`), which falls through to the pairing list
/// when the map is null. So: this class is a TEST double. The fallback does
/// not use it; claiming it does named a consumer grep cannot find.
///
/// ⚠️ Deliberately NOT installed as a substitute in production when SQLite is
/// unavailable (Book 13 §7 F1 ②「a DI default must not be a friendly empty
/// implementation」): a map that forgets
/// on every launch would answer 「which machine」 with silence and look healthy.
/// The fallback session installs NOTHING, so the reader falls back to the
/// pairing list — the phase-1 behaviour, which is honest and complete for every
/// pairing the user still has.
class InMemoryInstanceMachineMap implements InstanceMachineMap {
  final Map<String, String> _rows = <String, String>{};

  @override
  Future<Map<String, String>> readAll() async =>
      Map<String, String>.unmodifiable(_rows);

  @override
  Future<void> put({
    required String instanceId,
    required String machineUid,
    required String source,
  }) async {
    _rows[instanceId] = machineUid;
  }
}

InstanceMachineMap? _installed;

/// The map the read surfaces use, or null when this session has none.
///
/// A process-wide install (the same shape as `installUsageCounters` in
/// main.dart) because the reader is [SessionScope], which is constructed inside
/// `PttSession` before the database is open and must not grow a constructor
/// argument threaded through five owners for one optional lookup.
InstanceMachineMap? get installedInstanceMachineMap => _installed;

void installInstanceMachineMap(InstanceMachineMap? map) {
  _installed = map;
}

/// 🔴 The FIRST of the two writers (design §3.2). MUST be called AFTER
/// `openTimelinePersistence` has returned successfully, in its own try — see
/// this file's header for what happens if it is folded into that function.
///
/// Returns how many mappings were written; 0 on any failure, which is a
/// non-event: the pairing list still answers the same question this launch, and
/// the next launch tries again (nothing records that the seed succeeded, so it
/// is retried by construction — the same discipline as the timeline import's
/// 「flag written last」).
///
/// `INSERT OR REPLACE` per row ⇒ re-running it only overwrites each row with
/// itself. Idempotence here is a requirement, not an observation: this runs on
/// EVERY launch.
Future<int> seedInstanceMachineMap({
  required InstanceMachineMap? map,
  required TokenStorage storage,
}) async {
  if (map == null) return 0;
  try {
    final List<MobileSession> pairings = await storage.readPairings();
    int written = 0;
    for (final MobileSession p in pairings) {
      final String uid = (p.pcMachineUid ?? '').trim();
      // The virtual cloud instance is a virtual PC row, not a machine (machine_group.dart rule
      // ②). Excluded at the WRITE too, not only at the read: a saas row in this
      // table is a category error waiting for a second reader to trust it.
      if (uid.isEmpty || p.channel == 'saas') continue;
      final String identity;
      try {
        identity = p.connectionIdentity;
      } on StateError {
        continue;
      }
      await map.put(
        instanceId: identity,
        machineUid: uid,
        source: kMachineMapSourceSeed,
      );
      written++;
    }
    diag('machine_map.seeded', <String, Object?>{'rows': written});
    return written;
  } catch (e) {
    // 「don't merge this time + say so + try again next launch」. Never
    // rethrown: this runs after the store is already open and serving
    // history, and there is nothing here worth taking that down for.
    diag('machine_map.seed_failed', <String, Object?>{'error': '$e'});
    return 0;
  }
}
