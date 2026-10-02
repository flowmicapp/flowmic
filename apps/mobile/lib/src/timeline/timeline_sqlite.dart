// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §7 (local timeline table + loc_ idempotency
//     key lineage, F-2367)
//   docs/archive/strategy/R7-V2-TASK-CARDS.md V2-06a-2 (incremental persistence + SQLite)
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
import 'timeline_fallback_receipts_schema.dart';
import '../mcp/mcp_schema.dart';
import '../mcp/mcp_store.dart';
import '../session/instance_machine_map.dart';
import '../session/outbox_store.dart';
import 'cloud/blind_store_cloud_state.dart';
import 'owner_timeline_pager.dart';
import 'local_record_persistence.dart';
import 'timeline_entry.dart';
import 'timeline_persistence.dart';
import 'timeline_corrupt_archive.dart';
import 'timeline_row_stores.dart';
import 'timeline_unresolved_rows.dart';
import 'timeline_verified_reads.dart';
import 'timeline_write_gate.dart';

export 'timeline_row_stores.dart' show kTimelineMigratedKey;

// card F2 — the frozen per-version migration steps + their test hooks, moved out
// VERBATIM when v5 pushed this file over the 800-line src cap. A `part`, not an
// import, so `_upgradeVn` stays private to this library and every call site in
// `onUpgrade` above is untouched. See that file's header for the diff rule.
part 'timeline_sqlite_migrations.dart';
part 'timeline_fallback_import.dart';
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
const int kTimelineDbVersion = 8;

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

  /// The shared_preferences blob; NR-146 removed its lossy disk cap. Reached ONLY
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
    this.corruptionCounts = const {},
    this.corruptionRowIds = const {},
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

  /// Non-null on a storage-open or fallback-import/cleanup failure. Carries the
  /// reason so the UI can state it. NOT swallowed, NOT rethrown: rethrowing
  /// here would turn a storage-upgrade problem into an app that will not start,
  /// which is a worse outcome for the user and is not 「loud」("响亮") in any useful
  /// sense — a crash is not a message.
  final String? failure;

  /// Rows newly carried over from fallback storage during this open.
  final int importedRows;
  final Map<String, int> corruptionCounts;
  final Map<String, Set<String>> corruptionRowIds;
}

/// Opens SQLite and imports any fallback rows from earlier failed sessions.
/// Each imported payload has a receipt in the same transaction as its row.
/// Clear fallback rows only after commit and receipt read-back. If cleanup
/// fails, SQLite remains available and leftover copies are diagnostic only.
/// A transaction failure keeps fallback data and surfaces the fallback notice.
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
              case 7:
                await _upgradeV7AddTimelineArticleId(d);
              case 8:
                await installMcpSchemaV8(d);
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
        // Auxiliary receipts do not alter any table the previous v8 build reads.
        // Install on every open without stamping a downgrade-incompatible v9.
        // NR-137 round 8: the unresolved-row ledger is the same kind of table.
        onOpen: (Database d) async {
          await installTimelineFallbackReceiptsSchema(d);
          await installTimelineUnresolvedSchema(d);
        },
      ),
    );
    final SqfliteTimelinePersistence store =
        SqfliteTimelinePersistence(db, prefs: prefs);
    final imported = await _importOnce(db: db, prefs: prefs, legacy: legacy);
    // A failed optional migration retries without dropping primary history to
    // shared preferences. Its own diagnostic and settings state name failure.
    await installMcpSchemaV8(db);
    await store.mcp.initialize();
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
      importedRows: imported.rows,
      corruptionRowIds: {
        if (legacy.unreadableRows > 0) 'fallback_unreadable_rows': legacy.unreadableRowIds,
        if (imported.unreadablePrimary > 0) 'fallback_unreadable_primary_rows': imported.unreadablePrimaryIds,
      },
      corruptionCounts: {
        if (legacy.unreadableRows > 0) 'fallback_unreadable_rows': legacy.unreadableRows,
        if (imported.unreadablePrimary > 0) 'fallback_unreadable_primary_rows': imported.unreadablePrimary,
      },
      failure: imported.failure,
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
      'history_cap': null,
      'outbox_persistent': false,
    });
    return TimelineStorageOpen(
      persistence: legacy..sqliteFile = await _sqliteFileEvidence(factory, path),
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
      'history_cap': null,
      'outbox_persistent': false,
      'error': e.runtimeType,
    });
    return TimelineStorageOpen(
      persistence: legacy..sqliteFile = await _sqliteFileEvidence(factory, path),
      kind: TimelineStorageKind.sharedPrefsFallback,
      failure: 'timeline_storage:${e.runtimeType}',
    );
  }
}

/// NR-137 round 8/9 — what this session knows about the database it could not
/// open: absent only when the check succeeded and found no file.
/// (Compatibility marker `kTimelineMigratedKey` lives in timeline_row_stores.dart.)
Future<SqliteFileEvidence> _sqliteFileEvidence(
    DatabaseFactory factory, String path) async {
  try {
    return await factory.databaseExists(path)
        ? SqliteFileEvidence.unknown
        : SqliteFileEvidence.absent;
  } on Object {
    return SqliteFileEvidence.unknown;
  }
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
  // CR-7 — the projected half of the article grouping. The other half rides
  // inside `payload` (TimelineEntry.toJson), because that is the copy the blind
  // store carries; both are written from this one value, here, at once.
  'article_id': e.articleId,
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

class SqfliteTimelinePersistence with TimelineReadIssues
    implements TimelinePersistence, OwnerScopedTimelineSource, LocalRecordPersistence,
        TimelineKeyedPersistence, TimelineBatchPersistence, TimelineVerifiedReads {
  SqfliteTimelinePersistence(this._db, {SharedPreferences? prefs})
      : _prefs = prefs,
        mcp = McpStore(_db);

  final Database _db;

  /// NR-137 round 9 — the SharedPreferences stores its census reads live.
  /// Null (a test building the store by hand): those stores are UNREAD.
  final SharedPreferences? _prefs;
  final McpStore mcp;
  Future<void> _mcpWrites = Future<void>.value();

  @override
  Future<void> saveLocalRecord(TimelineEntry entry, {required LocalRecordSource source}) async {
    final Map<String, int> targets = mcp.armedTargets;
    final Future<void> localWrite = upsert(entry);
    // Separate chains: optional bookkeeping never holds the next local write.
    // Birth and content-ready bookkeeping still preserve their invocation order.
    final Future<void> registration = _mcpWrites.then((_) async {
      await localWrite;
      try {
        await mcp.recordLocal(entry, source: source, targets: targets);
      } on Object {
        await mcp.markUnavailable('register_local');
      }
    });
    _mcpWrites = registration.catchError((Object _) {});
    await localWrite;
    await registration;
  }

  @override
  Future<void> forgetSubmissionRecords(Iterable<String> entryIds) async {
    await _mcpWrites;
    try { await mcp.forget(entryIds); }
    on Object { await mcp.markUnavailable('reap'); }
  }

  /// Serialises writes. The store issues `upsert`/`delete` fire-and-forget in
  /// mutation order; without this, two writes to the SAME id could interleave
  /// and the loser would be whichever finished last rather than whichever the
  /// user did last. Cheap, and it makes 「order is truth」("顺序即真相") a property instead of a hope.
  Future<void> _writes = Future<void>.value();

  Future<void> _serialize(Future<void> Function() op) {
    // NR-137 round 10b: and the process's timeline write gate.
    final Future<void> next =
        _writes.then((_) => TimelineWriteGate.timeline.run(op));
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
  Future<TimelineEntry?> readRecord(String id) async {
    final rows = await _decode(_db.query(kTimelineTable, columns: _payloadOnly,
      where: 'id = ?', whereArgs: [id]));
    return rows.isEmpty ? null : rows.single;
  }

  /// NR-137 round 6 — the whole table, with every row whose payload will not
  /// decode named by its id and its projected `article_id` column.
  ///
  /// ⚠️ NR-137 round 8/9 (reviews r7/r8): was the table alone. Now every
  /// registered store, in one exhaustive switch: the table, the archive (read,
  /// never a row), and the SharedPreferences stores read live
  /// (`sqliteResidueHoles`), or UNREAD when this store has no preferences. A
  /// table row is attributed only by what agrees: its id column and the
  /// payload's id, its `article_id` column and the payload's (round 9, B1/B3);
  /// a payload that decodes to another id is a conflict, not a row. The
  /// unreadable-rows report stays the table's undecodable rows, as before.
  @override
  Future<TimelineInventory> loadInventory() async {
    final List<TimelineEntry> out = <TimelineEntry>[];
    final List<UnreadableRow> holes = <UnreadableRow>[];
    final Set<String> undecodable = <String>{};
    final Set<TimelineRowStore> unread = <TimelineRowStore>{};
    for (final TimelineRowStore store in TimelineRowStore.values) {
      switch (store) {
        case TimelineRowStore.sqliteRows:
          for (final Map<String, Object?> r in await _db.query(kTimelineTable,
              columns: const <String>['id', 'article_id', 'payload'],
              orderBy: _newestFirst)) {
            final TimelineEntry? entry = decodeTimelineRow(r['payload']);
            if (entry != null && entry.id == r['id']) {
              out.add(entry);
            } else if (entry != null) {
              holes.add(const UnreadableRow()); // filed under another id
            } else {
              undecodable.add(r['id']! as String);
              holes.add(unreadableRowOf(r['payload'],
                  id: r['id']! as String, articles: <Object?>[r['article_id']]));
            }
          }
        case TimelineRowStore.sqliteCorruptArchive:
          // Read like every store; its rows are recovery copies, never rows.
          if (await hasTimelineCorruptArchive(_db)) {
            await _db.rawQuery('SELECT COUNT(*) FROM $kTimelineCorruptArchiveTable');
          }
        case TimelineRowStore.prefsLegacyArray:
        case TimelineRowStore.prefsV2Rows:
        case TimelineRowStore.prefsV3Rows:
        case TimelineRowStore.prefsCorruptArchive:
        case TimelineRowStore.prefsCloudRetries:
          if (_prefs == null) unread.add(store);
      }
    }
    final SharedPreferences? prefs = _prefs;
    if (prefs != null) holes.addAll(await sqliteResidueHoles(_db, prefs));
    reportUnreadableRows(undecodable);
    return TimelineInventory(out, holes, unread: unread);
  }

  /// NR-137 round 6/9 — may a row keyed [id] be physically there, in any
  /// store? From the census, so it can never disagree with it.
  @override
  Future<bool> mayHoldRow(String id) async {
    final TimelineInventory inv = await loadInventory();
    return inv.unread.isNotEmpty ||
        inv.rows.any((TimelineEntry e) => e.id == id) ||
        inv.unreadable.any((UnreadableRow u) => u.mayBe(id));
  }

  @override
  Future<void> writeRecordBatch(TimelineBatchAction action) => _serialize(() async {
    final replaced = <String>[];
    final superseded = <String>[];
    await _db.transaction((txn) async {
      final raw = await txn.query(kTimelineTable, columns: _payloadOnly);
      final originals = {for (final row in raw) row['id'] as String: row};
      final rows = await _decode(Future.value(raw));
      await action({for (final row in rows) row.id: row}, (entry) async {
        final original = originals[entry.id];
        if (original != null && unreadableTimelineValue(original['payload'], entry)) {
          // Only a corrupt replacement needs the complete recovery projection.
          final full = await txn.query(kTimelineTable,
            where: 'id = ?', whereArgs: [entry.id]);
          if (await archiveCorruptTimelineRow(txn, full.firstOrNull,
              table: kTimelineTable)) {
            replaced.add(entry.id);
          }
        }
        await txn.insert(kTimelineTable, _row(entry), conflictAlgorithm: ConflictAlgorithm.replace);
        if (await supersedeUnresolvedTimelineRows(txn, entry.id) > 0) superseded.add(entry.id);
        originals[entry.id] = {'id': entry.id, 'payload': jsonEncode(entry.toJson())};
      });
    });
    for (final id in replaced) { reportCorruptTimelineReplacement(id); }
    reportUnresolvedTimelineRowsSuperseded(superseded);
  });

  @override
  Future<List<TimelineEntry>> loadPage({
    DateTime? before,
    required int limit,
  }) => _readLimited(
    (count) => _db.query(
      kTimelineTable,
      columns: _payloadOnly,
      // Keyset, not OFFSET — see [TimelinePersistence.loadPage]. Strict `<` so
      // the boundary row is not handed out twice.
      where: before == null ? null : 'created_at < ?',
      whereArgs: before == null
          ? null
          : <Object?>[before.toUtc().millisecondsSinceEpoch],
      orderBy: _newestFirst,
      limit: count,
    ),
    limit,
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
    return _readLimited(
      (count) => _db.query(
        kTimelineTable,
        columns: _payloadOnly,
        where: where,
        whereArgs: args,
        orderBy: _newestFirst,
        limit: count,
      ),
      limit,
    );
  }

  /// [limit] counts ROWS, and one recording can own dozens of matching rows,
  /// so it sits well above the 200 RESULTS a screen shows after grouping
  /// (`kSearchResultLimit`, search_hits.dart).
  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 1000}) {
    if (query.trim().isEmpty) return Future<List<TimelineEntry>>.value(<TimelineEntry>[]);
    return _readLimited(
      (count) => _db.query(
        kTimelineTable,
        columns: _payloadOnly,
        where: _kSearchWhere,
        whereArgs: <Object?>[_likeArg(query.trim()), r'\'],
        orderBy: _newestFirst,
        limit: count,
      ),
      limit,
    );
  }

  static const List<String> _payloadOnly = <String>['id', 'payload'];
  static const String _newestFirst = 'created_at DESC';

  /// Fill the requested page with readable rows. A corrupt row must not make
  /// the UI infer the end of history while older healthy rows remain on disk.
  Future<List<TimelineEntry>> _readLimited(
    Future<List<Map<String, Object?>>> Function(int count) query, int limit,
  ) async {
    if (limit <= 0) return <TimelineEntry>[];
    int count = limit;
    while (true) {
      final rows = await query(count);
      final List<TimelineEntry> out = [];
      final Set<String> unreadable = {};
      for (final row in rows) {
        final entry = decodeTimelineRow(row['payload']);
        if (entry == null) { unreadable.add(row['id']! as String); } else { out.add(entry); }
        if (out.length == limit) break;
      }
      if (out.length >= limit || rows.length < count) {
        reportUnreadableRows(unreadable);
        return out;
      }
      count *= 2;
    }
  }

  /// Rows in → entries out. A row whose payload will not parse is SKIPPED, not
  /// substituted: half an entry rendered as if it were whole is worse than a
  /// gap, and there is nothing truthful to put in its place.
  Future<List<TimelineEntry>> _decode(
    Future<List<Map<String, Object?>>> rows,
  ) async {
    final List<TimelineEntry> out = <TimelineEntry>[];
    final Set<String> unreadable = {};
    for (final Map<String, Object?> r in await rows) {
      final TimelineEntry? entry = decodeTimelineRow(r['payload']);
      if (entry == null) { unreadable.add(r['id']! as String); } else { out.add(entry); }
    }
    reportUnreadableRows(unreadable);
    return out;
  }

  @override
  Future<void> upsert(TimelineEntry entry) => _serialize(() async {
    bool replaced = false;
    int superseded = 0;
    await _db.transaction((txn) async {
      final rows = await txn.query(kTimelineTable, where: 'id = ?', whereArgs: [entry.id]);
      replaced = await archiveCorruptTimelineRow(txn, rows.firstOrNull, table: kTimelineTable);
      await txn.insert(kTimelineTable, _row(entry), conflictAlgorithm: ConflictAlgorithm.replace);
      // NR-137 round 8: a valid record for this id, written by the active store.
      superseded = await supersedeUnresolvedTimelineRows(txn, entry.id);
    });
    if (replaced) reportCorruptTimelineReplacement(entry.id);
    if (superseded > 0) reportUnresolvedTimelineRowsSuperseded(<String>[entry.id]);
  });

  @override
  Future<void> delete(String id) => _serialize(() => _db.transaction((txn) async {
    if (await hasTimelineCorruptArchive(txn)) {
      await txn.delete(kTimelineCorruptArchiveTable,
        where: 'row_id = ?', whereArgs: [id]);
    }
    await txn.delete(kTimelineTable, where: 'id = ?', whereArgs: [id]);
  }));

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
        await supersedeUnresolvedTimelineRows(txn, e.id);
      }
    });
  });

  Future<void> close() => _db.close();
}
