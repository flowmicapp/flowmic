// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §7 (local timeline table + loc_ idempotency
//     key lineage, F-2367)
//   docs/strategy/R7-V2-TASK-CARDS.md V2-06a-2 (incremental persistence + SQLite)
//
// The timeline's real store.
//
// WHY THIS EXISTS (the argument, so nobody re-litigates it from the speed side):
// shared_preferences held the WHOLE table as one JSON array under one key, so
// every mutation rewrote every row. The 100-row disk cap existed only to bound
// that cost — and it capped the USER'S HISTORY as a side effect, on a page
// called 「全部历史」("all history").
//
// The deciding argument was NOT search speed. At a private-domain scale a
// linear scan over a few thousand rows is fine. It was that EDIT and DELETE on
// a blob/append-only file force a hand-rolled compaction plus crash safety,
// and that is exactly where data-loss bugs live. sqflite has both already.
//
// SHAPE: one JSON `payload` column is the single source of truth for a row's
// content; the other columns are PROJECTIONS written from that payload in one
// place ([_row]). Nothing else writes them, so a column drifting out of step
// with the payload is not a bug that has to be caught — it is unreachable.
// This also means an additive field on TimelineEntry needs no schema change,
// which matters in a repo whose protocol discipline is additive-field-first.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';

import '../diag/diag_log.dart';
import '../session/instance_machine_map.dart';
import '../session/outbox_store.dart';
import 'cloud/blind_store_cloud_state.dart';
import 'owner_timeline_pager.dart';
import 'timeline_entry.dart';
import 'timeline_persistence.dart';

// card F2 — the frozen per-version migration steps + their test hooks, moved out
// VERBATIM when v5 pushed this file over the 800-line src cap. A `part`, not an
// import, so `_upgradeVn` stays private to this library and every call site in
// `onUpgrade` above is untouched. See that file's header for the diff rule.
part 'timeline_sqlite_migrations.dart';
// card E-CL pre-split — the FINAL `onCreate` schema (`_createSchema` + the four
// `_create*Schema` DDL functions), moved out VERBATIM when this file reached
// 788/800 and the next edit would have crossed the cap. A `part`, same as the
// migrations above, so `_createSchema` stays private and its call sites
// (`onCreate`, the migrations part's `createTimelineSchemaV1ForTest`) are
// untouched. See that file's header for the diff rule.
part 'timeline_sqlite_schema.dart';

const String kTimelineTable = 'timeline_entries';
const String kTimelineDbFile = 'flowmic_timeline.db';

/// Bumped only for a real schema change. `onCreate` builds the FINAL shape;
/// `onUpgrade` walks explicit per-version steps.
///
/// 🔴 D13 — THE TWO RULES THIS FILE NOW ENFORCES BY STRUCTURE:
///   1. **A version step, once shipped, is frozen.** Each `_upgradeVn` below is
///      the DDL as that version shipped it, never edited afterwards. Editing a
///      shipped step is a silent no-op for every install already past it — the
///      exact trap v4 exists to heal (see below).
///   2. **The create path and the upgrade path must converge**, and that is a
///      TESTED property, not a convention: timeline_migration_test.dart compares
///      `PRAGMA table_info` of a fresh create against a v1→latest stepwise
///      upgrade, both tables. Adding a column to [_createOutboxSchema] without a
///      matching new version step goes red there.
///
/// v2 (Window B3-2a): adds [kOutboxTable] — purely additive, one new table, no
/// existing row read, rewritten or dropped. [_upgradeV2CreateOutboxAsShipped]
/// is that table AS v2 SHIPPED IT.
///
/// v3 (0.2.43, owner 「语音时长要找回来」"the spoken duration needs to be
/// recovered"): adds ONE nullable column,
/// `duration_ms`, to [kOutboxTable]. Old rows read NULL — the honest value
/// (absence, never 0 — Book 16 §6.1). PRAGMA-guarded so it is idempotent.
///
/// v4 (0.3.0 D13): heals the in-place-edit trap. `covered_entry_ids` and
/// `wire_entry_id` (Window B3-2b) were added by EDITING the v2 CREATE TABLE in
/// place while the create doubled as the v1→v2 step — a no-op for any install
/// whose table already existed, leaving it two columns short forever. On such
/// an install every enqueue INSERT names an unknown column and the queue dies
/// wholesale. v4 adds both columns, PRAGMA-guarded per column so installs whose
/// table came from the edited create (columns already present) no-op cleanly.
///
/// v5 (0.3.0 card F2 / ruling ④): adds [kInstanceMachineMapTable] — a NEW table, no
/// existing row read, rewritten or dropped. It remembers which machine an
/// instance id belonged to, so 「同一台电脑的历史」("history for the same
/// computer") survives the user deleting one
/// of that computer's two pairings. 🔴 The timeline rows themselves are NOT
/// touched and carry no machine column: merging is applied at READ time
/// (session/machine_key.dart), because back-filling a machine onto every row is
/// the one migration class that can lose history, and it would freeze
/// 「migration day couldn't ask」 into a permanent answer.
///
/// ⚠️ v5 is the FIRST version bump since D13 shipped `onDowngrade`, i.e. the
/// first file this repo has ever produced that an older APK can be asked to
/// open. That is not a coincidence — D13 was the gate this card waited on
/// (design §3.3), and the seam is pinned by timeline_migration_test.dart
/// 「card F2 §3.3 — downgrade」.
///
/// v6 (0.3.0 card E-CL): adds [kBlindStoreCloudStateTable] — a NEW table, no
/// existing row read, rewritten or dropped. It holds this device's belief about
/// what its account's blind store contains, including the pending-tombstone set
/// that design §4.1 requires to outlive the rows it is about.
const int kTimelineDbVersion = 6;

/// D13 ① — 「装了更老的 APK」("an older APK got installed") has an explicit answer instead of an accident.
///
/// Thrown by `onDowngrade` when the db file's schema version is NEWER than this
/// build supports. The policy is REFUSE: the file is left exactly as it was —
/// throwing out of the callback aborts the open transaction BEFORE sqflite's
/// `setVersion`, which is the write that matters (with no callback at all it
/// silently stamps the file down to this build's version; see the measurement
/// at `onDowngrade` in [openTimelinePersistence]). So re-installing the newer
/// APK finds everything intact, stamp included.
///
/// What this build then runs on is the legacy fallback —
/// [openTimelinePersistence] catches THIS type by name and reports the state
/// loudly (diag `timeline.db_downgrade_refused`), rather than letting the broad
/// catch dress a downgrade up as 「disk trouble」.
class TimelineDbDowngradeRefused implements Exception {
  const TimelineDbDowngradeRefused({
    required this.dbVersion,
    required this.appVersion,
  });

  /// The version stamped in the db file (written by a newer APK).
  final int dbVersion;

  /// The newest version THIS build understands ([kTimelineDbVersion]).
  final int appVersion;

  @override
  String toString() =>
      'TIMELINE_DB_DOWNGRADE_REFUSED: db file is schema v$dbVersion, this build '
      'supports v$appVersion — refusing to open it (install the newer APK to '
      'read this data; nothing was modified or deleted)';
}

/// Which store the app is ACTUALLY running on. Surfaced, not internal: the
/// 「全部历史」("all history") page renders a different footnote for each,
/// because 「你的历史都在本机」("all your history is on this device") and
/// 「仍然只保留最近 100 条」("only the most recent 100 are still kept") are
/// different promises and the user is
/// entitled to know which one is true right now.
enum TimelineStorageKind {
  /// SQLite. Every row is kept; there is no cap.
  sqlite,

  /// The old shared_preferences blob, still capped at 100 rows. Reached ONLY
  /// when SQLite could not be opened or the one-time import failed — never as
  /// a routine choice.
  sharedPrefsFallback,
}

/// What [openTimelinePersistence] actually managed to do.
class TimelineStorageOpen {
  const TimelineStorageOpen({
    required this.persistence,
    required this.kind,
    this.outbox,
    this.machineMap,
    this.cloudState,
    this.failure,
    this.importedRows = 0,
  });

  final TimelinePersistence persistence;
  final TimelineStorageKind kind;

  /// Window B3-2a — the delivery queue's store, backed by the SAME database.
  ///
  /// Non-null exactly when [kind] is [TimelineStorageKind.sqlite]. **Null on the
  /// shared_preferences fallback**, and deliberately not substituted here: this
  /// function's job is to report what it managed to open, and quietly handing
  /// back an in-memory queue would be a store that loses every undelivered
  /// message on the next launch while looking healthy. The composition root
  /// decides what to do about that, in the open, next to [failure].
  final OutboxStore? outbox;

  /// card F2 phase 2 — the learned `instance_id → machine_uid` table, same database.
  ///
  /// Non-null exactly when [kind] is [TimelineStorageKind.sqlite], and
  /// **deliberately null on the fallback rather than substituted with an
  /// in-memory one**: a map that forgets on every launch would answer 「which
  /// machine」 with silence while looking healthy. Null makes the reader fall
  /// back to the pairing list, which is the phase-1 behaviour and is complete
  /// for every pairing the user still has.
  final InstanceMachineMap? machineMap;

  /// card E-CL — the blind store's local ledger AND its atomic row deleter (one
  /// object serving both interfaces; see the class doc there). Same database.
  ///
  /// **Null on the shared_preferences fallback, and NOT substituted** — the same
  /// rule as [outbox] and [machineMap], with a sharper consequence: an in-memory
  /// stand-in would forget the pending-tombstone set on every launch, so a cloud
  /// record the user deleted would stay in the cloud forever while the phone
  /// showed it as gone. The composition root leaves the cloud leg switched off
  /// in that state rather than running it against a store that cannot remember.
  final SqfliteBlindStoreCloudStateStore? cloudState;

  /// Non-null ⇔ [kind] is [TimelineStorageKind.sharedPrefsFallback]. Carries the
  /// reason so the UI can state it. NOT swallowed, NOT rethrown: rethrowing
  /// here would turn a storage-upgrade problem into an app that will not start,
  /// which is a worse outcome for the user and is not 「loud」("响亮") in any useful
  /// sense — a crash is not a message.
  final String? failure;

  /// Rows carried over from shared_preferences by the one-time import.
  final int importedRows;
}

/// Opens the timeline store, importing the shared_preferences table once.
///
/// FAILURE CONTRACT — the part worth reading:
///   * The import runs in ONE transaction. It lands whole or not at all; there
///     is no half-migrated state to reason about.
///   * The shared_preferences blob is NEVER deleted, not even after a clean
///     import. It is a ≤100-row remnant and it is the rollback net. Deleting it
///     to be tidy would trade the only copy of the user's history for nothing.
///   * The「migrated」flag is set ONLY after the transaction commits. A failure
///     therefore retries on the next launch by construction.
///   * A failure falls back to the shared_preferences implementation for this
///     session and REPORTS the reason. It does not return an empty SQLite
///     store: an empty 「全部历史」("all history") page is the loudest possible lie about data
///     the user still has.
Future<TimelineStorageOpen> openTimelinePersistence({
  required SharedPreferences prefs,
  required DatabaseFactory factory,
  required String path,
}) async {
  final SharedPrefsTimelinePersistence legacy =
      SharedPrefsTimelinePersistence(prefs);
  Database? db;
  try {
    db = await factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: kTimelineDbVersion,
        onCreate: (Database d, int _) => _createSchema(d),
        // Explicit per-version steps, walked as a range loop rather than an
        // `if (old == 1)` so upgrading from two versions back cannot silently
        // skip a step. Each case is FROZEN as-shipped DDL (D13 rule 1); a new
        // schema change is a NEW case plus a [kTimelineDbVersion] bump, never
        // an edit to an existing one.
        onUpgrade: (Database d, int from, int to) async {
          for (int v = from + 1; v <= to; v++) {
            switch (v) {
              case 2:
                await _upgradeV2CreateOutboxAsShipped(d);
              case 3:
                await _upgradeV3AddOutboxDuration(d);
              case 4:
                await _upgradeV4AddOutboxWireEntryColumns(d);
              case 5:
                await _upgradeV5CreateInstanceMachineMapAsShipped(d);
              case 6:
                await _upgradeV6CreateBlindStoreCloudStateAsShipped(d);
            }
          }
        },
        // 🔴 D13 ① — 「older APK opens a newer db」 had no story at all, and the
        // real default is WORSE than 「a generic error」. MEASURED against
        // sqflite_common 2.5.8 (database_mixin.dart:1152-1167) and reproduced
        // on a real file: with `onDowngrade` null, sqflite runs NO callback,
        // does not throw, does not delete — and then falls through to
        // `if (oldVersion != options.version) setVersion(options.version!)`,
        // i.e. it STAMPS THE FILE BACK DOWN to this build's version. The old
        // APK opens the newer schema happily (`kind == sqlite`,
        // `failure == null`); the newer columns are still there, now wearing a
        // lower version number. The damage lands LATER, on the next install of
        // the newer APK: it reads the lowered stamp and re-runs a step whose
        // columns already exist — an unguarded `ADD COLUMN` fails there, so THAT
        // build drops to the 100-row store on every launch, permanently, with
        // nothing naming the cause. Refusing the open leaves the stamp intact,
        // which is what makes reinstalling the newer APK a full recovery.
        // Pinned by timeline_migration_test.dart 「the downgrade is REFUSED,
        // reported by name, and destroys nothing」 — its version-stamp assertion
        // is the one that goes red the moment this callback is removed.
        onDowngrade: (Database d, int from, int to) =>
            throw TimelineDbDowngradeRefused(dbVersion: from, appVersion: to),
        onConfigure: (Database d) => d.execute('PRAGMA foreign_keys = ON'),
      ),
    );
    final SqfliteTimelinePersistence store = SqfliteTimelinePersistence(db);
    final int imported = await _importOnce(db: db, prefs: prefs, legacy: legacy);
    return TimelineStorageOpen(
      persistence: store,
      kind: TimelineStorageKind.sqlite,
      // Same Database handle as the timeline — one transaction domain, so an
      // enqueue and the row it settles onto cannot half-land.
      outbox: SqfliteOutboxStore(db),
      // card F2 phase 2 — the table is CREATED here (schema is this file's job) but
      // deliberately NOT seeded here: seeding reads the pairing list, and a
      // failure inside this try would drop the user's whole history to the
      // 100-row store. The seed runs after this function returns — see
      // [seedInstanceMachineMap] and main.dart.
      machineMap: SqfliteInstanceMachineMap(db),
      // card E-CL — same Database handle again, and here it is load-bearing rather
      // than merely tidy: a local delete must remove the timeline row and record
      // the cloud tombstone in ONE transaction (design §4.1), which is only
      // possible while both tables share a connection.
      cloudState: SqfliteBlindStoreCloudStateStore(
        db,
        timelineTable: kTimelineTable,
      ),
      importedRows: imported,
    );
  } on TimelineDbDowngradeRefused catch (e) {
    // D13 ① — the downgrade refusal, BY NAME. Same session-level disposition as
    // the broad catch (the app must still run, on the legacy store), but the
    // state is diagnosable instead of dressed up as disk trouble: the failure
    // string names the versions, and the diag trail states the one consequence
    // the fallback footnote cannot — the delivery queue is NOT persistent in
    // this state (the composition root substitutes an in-memory queue when
    // [TimelineStorageOpen.outbox] is null). A user-visible sentence for the
    // queue half needs new copy — reported as a follow-up need, not smuggled in.
    diag('timeline.db_downgrade_refused', <String, Object?>{
      'db_version': e.dbVersion,
      'app_version': e.appVersion,
    });
    diag('timeline.storage_fallback', <String, Object?>{
      'reason': 'downgrade_refused',
      'history_cap': SharedPrefsTimelinePersistence.maxPersistedEntries,
      'outbox_persistent': false,
    });
    return TimelineStorageOpen(
      persistence: legacy,
      kind: TimelineStorageKind.sharedPrefsFallback,
      failure: e.toString(),
    );
  } catch (e) {
    // Deliberately broad: every failure mode here (locked file, read-only
    // storage, corrupt db, malformed legacy blob) has the SAME correct
    // response — keep the user's history readable, say what happened, retry
    // next launch. Narrowing this would only add ways to crash instead.
    await db?.close().catchError((Object _) {});
    // D13 ① — the degraded mode is LOUD wherever it is entered from: same
    // truth-telling line as the downgrade branch, different reason.
    diag('timeline.storage_fallback', <String, Object?>{
      'reason': 'open_failed',
      'history_cap': SharedPrefsTimelinePersistence.maxPersistedEntries,
      'outbox_persistent': false,
      'error': e,
    });
    return TimelineStorageOpen(
      persistence: legacy,
      kind: TimelineStorageKind.sharedPrefsFallback,
      failure: e.toString(),
    );
  }
}

/// SharedPreferences key marking the one-time import done. Its ABSENCE is what
/// makes a failed import retry, so it is written last and only on success.
const String kTimelineMigratedKey = 'flowmic.timeline.migrated.sqlite.v1';

Future<int> _importOnce({
  required Database db,
  required SharedPreferences prefs,
  required SharedPrefsTimelinePersistence legacy,
}) async {
  if (prefs.getBool(kTimelineMigratedKey) == true) return 0;

  final List<TimelineEntry> old = await legacy.loadAll();
  if (old.isNotEmpty) {
    await db.transaction((Transaction txn) async {
      for (final TimelineEntry e in old) {
        // INSERT OR REPLACE on the PRIMARY KEY: re-running the import can only
        // rewrite a row with itself. Idempotent by construction rather than by
        // a guard someone has to remember.
        //
        // NOTE what is NOT here: no field is invented. A pre-V2-06a-1 row has
        // no `spoken_to_instance_id` and keeps none — adopting it into
        // 「whoever is connected right now」would make history lie, the same red
        // line requirement ③ drew when it refused to back-fill `now` onto old pairings.
        // The import is a MOVE, not an enrichment.
        await txn.insert(
          kTimelineTable,
          _row(e),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
    });
  }
  // Only now — a throw above leaves the flag unset and the blob intact.
  await prefs.setBool(kTimelineMigratedKey, true);
  return old.length;
}

/// The single writer of the projected columns. See the file header.
Map<String, Object?> _row(TimelineEntry e) => <String, Object?>{
  'id': e.id,
  'created_at': e.createdAt.toUtc().millisecondsSinceEpoch,
  'updated_at': e.updatedAt.toUtc().millisecondsSinceEpoch,
  'client_id': e.clientId,
  'mode': e.mode.name,
  'status': e.status.wire,
  'entry_type': e.entryType,
  'spoken_to_instance_id': e.spokenToInstanceId,
  'deleted': e.deleted ? 1 : 0,
  'search_text': timelineSearchText(e),
  'payload': jsonEncode(e.toJson()),
};

/// V2-06b full-text search — WHY THIS IS `LIKE` AND NOT FTS5.
///
/// FTS5 is the obvious answer and it is the wrong one here, for a reason worth
/// writing down before someone 「upgrades」("升级") it:
///
///   * **Tokenisation.** FTS5's default `unicode61` tokeniser splits on
///     non-alphanumerics. CJK characters are alphanumeric to it, so a Chinese
///     sentence with no spaces becomes ONE token. Searching 「会议」("meeting")
///     would not
///     match 「今天的会议记录」("today's meeting notes"). On a Chinese-primary product that is not a
///     degraded index — it is a search box that finds nothing while looking
///     like it works.
///   * **Availability.** sqflite on Android uses the SYSTEM SQLite. Whether it
///     was compiled with FTS5 (and with the `trigram` tokeniser that would fix
///     the above, 3.34+) varies by device. A feature that works on my phone and
///     silently returns nothing on someone else's is worse than no feature.
///   * **Scale.** This is a private-domain history. A substring scan over a few
///     thousand rows is milliseconds, and it is EXACTLY the semantics a user
///     expects when searching their own transcripts: type a fragment, find the
///     rows containing it.
///
/// So: a lowercased `search_text` projection plus `LIKE '%q%'`. Stated plainly
/// — there is no index on it and none would help a leading-wildcard LIKE. If
/// this ever gets slow the fix is a real tokeniser (jieba-style segmentation
/// feeding an FTS table), not a hopeful index.
const String _kSearchWhere = 'search_text LIKE ? ESCAPE ?';

/// `%`, `_` and the escape char are literals when a user types them.
String _likeArg(String query) {
  final String esc = query
      .toLowerCase()
      .replaceAll('\\', '\\\\')
      .replaceAll('%', '\\%')
      .replaceAll('_', '\\_');
  return '%$esc%';
}

class SqfliteTimelinePersistence
    implements TimelinePersistence, OwnerScopedTimelineSource {
  SqfliteTimelinePersistence(this._db);

  final Database _db;

  /// Serialises writes. The store issues `upsert`/`delete` fire-and-forget in
  /// mutation order; without this, two writes to the SAME id could interleave
  /// and the loser would be whichever finished last rather than whichever the
  /// user did last. Cheap, and it makes 「order is truth」("顺序即真相") a property instead of a hope.
  Future<void> _writes = Future<void>.value();

  Future<void> _serialize(Future<void> Function() op) {
    final Future<void> next = _writes.then((_) => op());
    // Keep the chain alive after a failure — one failed write must not wedge
    // every later write behind a rejected future.
    _writes = next.catchError((Object _) {});
    return next;
  }

  @override
  Future<List<TimelineEntry>> loadAll() => _decode(
    _db.query(kTimelineTable, columns: _payloadOnly, orderBy: _newestFirst),
  );

  @override
  Future<List<TimelineEntry>> loadPage({
    DateTime? before,
    required int limit,
  }) => _decode(
    _db.query(
      kTimelineTable,
      columns: _payloadOnly,
      // Keyset, not OFFSET — see [TimelinePersistence.loadPage]. Strict `<` so
      // the boundary row is not handed out twice.
      where: before == null ? null : 'created_at < ?',
      whereArgs: before == null
          ? null
          : <Object?>[before.toUtc().millisecondsSinceEpoch],
      orderBy: _newestFirst,
      limit: limit,
    ),
  );

  /// card F10 — the narrowed view's page, asked as a QUERY.
  ///
  /// 🔴 This is the method whose absence was the bug. `loadPage` above filters
  /// on `created_at` ONLY, so the per-instance chat screen was showing 「the
  /// rows of this instance that happen to be among the globally newest 60」 —
  /// empty for any PC you did not speak to most recently, with every row still
  /// in the table. The index this needs has existed and gone unused since
  /// V2-06a-1: `idx_timeline_owner (spoken_to_instance_id, created_at DESC)`.
  ///
  /// 🔴 `IN (…)`, never `=`, per the F2 contract (§5 phase 3: 「the pagination
  /// predicate generalizes from 'single owner' to 'owner ∈ a set' (the index
  /// unchanged)」). A single-element set is the same query
  /// with one placeholder, so F2's machine merge widens the ARGUMENT and leaves
  /// this SQL alone. The index still serves it: SQLite runs one indexed range
  /// per value of the IN list.
  ///
  /// Rows with a NULL owner (everything written before V2-06a-1) are excluded
  /// by `IN` and that is the intent — a legacy row belongs to NO instance, and
  /// letting it fall into whichever instance is open would be a silent claim
  /// about where it was spoken. They stay visible in 「all history」("全部历史") as 「unknown instance」("未知实例").
  @override
  Future<List<TimelineEntry>> loadOwnerPage({
    required Set<String> ownerIds,
    DateTime? before,
    required int limit,
  }) {
    // An empty set is not 「every owner」. Answering it with an unscoped page is
    // precisely the defect this method replaces, so it answers with nothing.
    if (ownerIds.isEmpty) {
      return Future<List<TimelineEntry>>.value(const <TimelineEntry>[]);
    }
    final List<String> ids = ownerIds.toList(growable: false);
    final String slots = List<String>.filled(ids.length, '?').join(', ');
    final List<Object?> args = <Object?>[...ids];
    // Keyset, not OFFSET — same reason as [loadPage]. Strict `<` so the
    // boundary row is not handed out twice.
    String where = 'spoken_to_instance_id IN ($slots)';
    if (before != null) {
      where = '$where AND created_at < ?';
      args.add(before.toUtc().millisecondsSinceEpoch);
    }
    return _decode(
      _db.query(
        kTimelineTable,
        columns: _payloadOnly,
        where: where,
        whereArgs: args,
        orderBy: _newestFirst,
        limit: limit,
      ),
    );
  }

  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 200}) {
    if (query.trim().isEmpty) return Future<List<TimelineEntry>>.value(<TimelineEntry>[]);
    return _decode(
      _db.query(
        kTimelineTable,
        columns: _payloadOnly,
        where: _kSearchWhere,
        whereArgs: <Object?>[_likeArg(query.trim()), r'\'],
        orderBy: _newestFirst,
        limit: limit,
      ),
    );
  }

  static const List<String> _payloadOnly = <String>['payload'];
  static const String _newestFirst = 'created_at DESC';

  /// Rows in → entries out. A row whose payload will not parse is SKIPPED, not
  /// substituted: half an entry rendered as if it were whole is worse than a
  /// gap, and there is nothing truthful to put in its place.
  Future<List<TimelineEntry>> _decode(
    Future<List<Map<String, Object?>>> rows,
  ) async {
    final List<TimelineEntry> out = <TimelineEntry>[];
    for (final Map<String, Object?> r in await rows) {
      final Object? raw = r['payload'];
      if (raw is! String) continue;
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map) continue;
      final TimelineEntry? e =
          TimelineEntry.fromJson(decoded.cast<String, Object?>());
      if (e != null) out.add(e);
    }
    return out;
  }

  @override
  Future<void> upsert(TimelineEntry entry) => _serialize(
    () => _db.insert(
      kTimelineTable,
      _row(entry),
      conflictAlgorithm: ConflictAlgorithm.replace,
    ),
  );

  @override
  Future<void> delete(String id) => _serialize(
    () => _db.delete(kTimelineTable, where: 'id = ?', whereArgs: <Object?>[id]),
  );

  /// Whole-list write — MIGRATION and tests only, never a mutation path (see
  /// [TimelinePersistence.saveAll]). One transaction so a caller that does use
  /// it cannot leave the table half-written.
  @override
  Future<void> saveAll(List<TimelineEntry> entries) => _serialize(() async {
    await _db.transaction((Transaction txn) async {
      await txn.delete(kTimelineTable);
      for (final TimelineEntry e in entries) {
        await txn.insert(
          kTimelineTable,
          _row(e),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
    });
  });

  Future<void> close() => _db.close();
}
