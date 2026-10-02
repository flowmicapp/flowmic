// NR-137 round 8 (review r7, BLOCKING D2) — THE ROWS SQLITE CANNOT READ
// BECAUSE THEY ARE NOT IN SQLITE.
//
// The one-time import reads the fallback through its lenient reader, so a row
// that will not decode never reaches it; the device was then marked migrated,
// and SQLite's inventory scanned only its own table. Measured by the review on
// `13025e9d`: four places such a row can sit (the legacy array, a v2 key, a v3
// key, a v3 key written by a degraded session AFTER migration), and in all four
// the hole went 1 → 0, absence was proven, the press said done and the PCM went
// while the bytes were still in SharedPreferences.
//
// ⚠️ NR-137 round 9 (review r8): was "SQLite's inventory reads a ledger that
// every open reconciles; while SQLite is active nothing writes those keys".
// The second half was false: the cloud sync writes its retry records
// (`TimelineRowStore.prefsCloudRetries`) while SQLite is the active store. Now
// SQLite's census reads every SharedPreferences store LIVE, through the same
// scan the fallback uses ([sqliteResidueHoles]), and the ledger only records
// which items existed when SQLite opened, so that a later write can supersede
// exactly those.
//
// RESOLUTION, positively and only:
//   · imported — a receipt for exactly that row (or the migration/conversion
//     record that already made the fallback treat it as a copy);
//   · gone — the bytes are no longer at that locator: the scan does not find
//     them, and the next reconcile drops the ledger row;
//   · superseded — the active store WROTE a valid record for the item's id
//     after the item was recorded ([supersedeUnresolvedTimelineRows], same
//     transaction as that write). The bytes stay where they are; an item whose
//     id is unknown can never be superseded, only gone. A cloud retry record
//     is never superseded: it can still land.
// The bytes themselves are never touched. This is auxiliary schema: additive,
// `IF NOT EXISTS`, invisible to an older v8 reader.

import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';

import '../diag/diag_log.dart';
import 'timeline_entry.dart';
import 'timeline_fallback_receipts_schema.dart';
import 'timeline_row_stores.dart';
import 'timeline_verified_reads.dart';

const String kTimelineUnresolvedTable = 'timeline_unresolved_rows';

/// Additive and replayable; installed on every open.
Future<void> installTimelineUnresolvedSchema(DatabaseExecutor db) => db.execute(
    'CREATE TABLE IF NOT EXISTS $kTimelineUnresolvedTable ('
    'store TEXT NOT NULL, locator TEXT NOT NULL, fingerprint TEXT NOT NULL, '
    'row_id TEXT, article_known INTEGER NOT NULL CHECK (article_known IN (0, 1)), '
    'article_id TEXT, recorded_at INTEGER NOT NULL, superseded_at INTEGER, '
    'PRIMARY KEY (store, locator, fingerprint))');

/// The fingerprint an import receipt carries for [row].
String timelineImportFingerprint(TimelineEntry row) =>
    sha256.convert(utf8.encode(jsonEncode(row.toJson()))).toString();

Future<bool> _hasLedger(DatabaseExecutor db) async => (await db.rawQuery(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        <Object?>[kTimelineUnresolvedTable]))
    .isNotEmpty;

String _keyOf(Object? store, Object? locator, Object? fp) =>
    jsonEncode(<Object?>[store, locator, fp]);

/// The stores whose items a later write may supersede.
bool _supersedable(TimelineRowStore s) => switch (s) {
      TimelineRowStore.prefsLegacyArray ||
      TimelineRowStore.prefsV2Rows ||
      TimelineRowStore.prefsV3Rows =>
        true,
      TimelineRowStore.prefsCloudRetries ||
      TimelineRowStore.prefsCorruptArchive ||
      TimelineRowStore.sqliteRows ||
      TimelineRowStore.sqliteCorruptArchive =>
        false,
    };

/// The active store wrote a valid record for [id]: its recorded residue is
/// superseded. Call inside the transaction of that write. Returns how many.
Future<int> supersedeUnresolvedTimelineRows(DatabaseExecutor db, String id) async {
  if (!await _hasLedger(db)) return 0;
  return db.update(kTimelineUnresolvedTable,
      <String, Object?>{'superseded_at': DateTime.now().toUtc().millisecondsSinceEpoch},
      where: 'row_id = ? AND superseded_at IS NULL', whereArgs: <Object?>[id]);
}

void reportUnresolvedTimelineRowsSuperseded(Iterable<String> ids) {
  if (ids.isEmpty) return;
  diag('timeline.unresolved_row_superseded',
      <String, Object?>{'row_id': boundedDiagnosticIds(ids)});
}

/// Is [item] resolved by a record of the event that copied it into SQLite?
/// Only a readable row can be.
Future<bool> _imported(DatabaseExecutor db, TimelineResidueItem item,
    {required bool migrated, required bool converted}) async {
  final TimelineEntry? row = item.row;
  if (row == null) return false;
  switch (item.store) {
    case TimelineRowStore.prefsLegacyArray:
      // Read as the store until conversion or migration copied it; the
      // fallback has treated its readable entries as a copy since (round 7).
      if (converted || migrated) return true;
    case TimelineRowStore.prefsV2Rows:
      // Frozen at migration, which imported every readable key.
      if (migrated) return true;
    case TimelineRowStore.prefsV3Rows:
      break;
    case TimelineRowStore.prefsCloudRetries:
    case TimelineRowStore.prefsCorruptArchive:
    case TimelineRowStore.sqliteRows:
    case TimelineRowStore.sqliteCorruptArchive:
      return false; // never imported
  }
  return (await db.query(kTimelineFallbackReceiptsTable,
          columns: const <String>['id'],
          where: 'id = ? AND fingerprint = ?',
          whereArgs: <Object?>[row.id, timelineImportFingerprint(row)],
          limit: 1))
      .isNotEmpty;
}

/// 🔴 NR-137 round 9 — the SharedPreferences stores, read NOW, as SQLite's
/// census sees them: every item not positively resolved is a hole, attributed
/// only by what it states (`TimelineResidueItem.hole`); every unclaimed key
/// under `flowmic.timeline.` may be any row.
Future<List<UnreadableRow>> sqliteResidueHoles(
    DatabaseExecutor db, SharedPreferences prefs) async {
  final TimelinePrefsScan scan = scanTimelinePrefs(prefs);
  final bool migrated = prefs.getBool(kTimelineMigratedKey) == true;
  final bool converted = prefs.getBool(kTimelineLegacyConvertedKey) == true;
  final Set<String> superseded = <String>{
    if (await _hasLedger(db))
      for (final Map<String, Object?> r in await db.query(kTimelineUnresolvedTable,
          columns: const <String>['store', 'locator', 'fingerprint'],
          where: 'superseded_at IS NOT NULL'))
        _keyOf(r['store'], r['locator'], r['fingerprint']),
  };
  final List<UnreadableRow> holes = <UnreadableRow>[];
  for (final TimelineResidueItem item in scan.items) {
    switch (item.store) {
      case TimelineRowStore.prefsLegacyArray:
      case TimelineRowStore.prefsV2Rows:
      case TimelineRowStore.prefsV3Rows:
        if (await _imported(db, item, migrated: migrated, converted: converted) ||
            superseded.contains(
                _keyOf(item.store.name, item.locator, item.fingerprint))) {
          continue;
        }
        holes.add(item.hole);
      case TimelineRowStore.prefsCloudRetries:
        if (!item.cloudDeleteRetry) holes.add(item.hole);
      case TimelineRowStore.prefsCorruptArchive:
        break; // a recovery copy of a replaced row: never a row
      case TimelineRowStore.sqliteRows:
      case TimelineRowStore.sqliteCorruptArchive:
        break; // never a SharedPreferences item
    }
  }
  for (final String _ in scan.unclaimed) {
    holes.add(const UnreadableRow());
  }
  return holes;
}

/// Record which residue items exist as SQLite opens, so a later write can
/// supersede exactly those; drop the rows of items that are gone or now
/// imported. Run after the import's receipts are written, in the same
/// transaction. [migrated] is the marker as this open found it.
Future<void> reconcileUnresolvedTimelineRows(
  DatabaseExecutor db,
  List<TimelineResidueItem> residue, {
  required bool migrated,
  required bool converted,
}) async {
  await installTimelineUnresolvedSchema(db);
  final Map<String, Map<String, Object?>> ledger = <String, Map<String, Object?>>{
    for (final Map<String, Object?> r in await db.query(kTimelineUnresolvedTable))
      _keyOf(r['store'], r['locator'], r['fingerprint']): r,
  };
  final Set<String> present = <String>{};
  int recorded = 0;
  final int now = DateTime.now().toUtc().millisecondsSinceEpoch;
  for (final TimelineResidueItem item in residue) {
    if (!_supersedable(item.store) ||
        await _imported(db, item, migrated: migrated, converted: converted)) {
      continue;
    }
    final String k = _keyOf(item.store.name, item.locator, item.fingerprint);
    if (!present.add(k) || ledger.containsKey(k)) continue;
    final UnreadableRow hole = item.hole;
    await db.insert(kTimelineUnresolvedTable, <String, Object?>{
      'store': item.store.name,
      'locator': item.locator,
      'fingerprint': item.fingerprint,
      'row_id': hole.id,
      'article_known': hole.articleKnown ? 1 : 0,
      'article_id': hole.articleId,
      'recorded_at': now,
    }, conflictAlgorithm: ConflictAlgorithm.ignore);
    recorded++;
  }
  int resolved = 0;
  for (final MapEntry<String, Map<String, Object?>> e in ledger.entries) {
    if (present.contains(e.key)) continue;
    await db.delete(kTimelineUnresolvedTable,
        where: 'store = ? AND locator = ? AND fingerprint = ?',
        whereArgs: <Object?>[
          e.value['store'], e.value['locator'], e.value['fingerprint'],
        ]);
    resolved++;
  }
  final int open = present.where((String k) =>
      ledger[k] == null || ledger[k]!['superseded_at'] == null).length;
  if (recorded > 0 || resolved > 0 || open > 0) {
    diag('timeline.unresolved_rows', <String, Object?>{
      'recorded': recorded,
      'resolved': resolved,
      'unresolved': open,
    });
  }
}
