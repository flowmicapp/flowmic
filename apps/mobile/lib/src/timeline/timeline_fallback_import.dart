// NR-142: fallback recovery with transactional receipts and per-row isolation.
//
// ⚠️ NR-137 round 8 (review r7 D2): was only the readable rows. `old` is the
// fallback's LENIENT read, so a row that will not decode never reached this
// loop, and the device was marked migrated with those bytes still in
// SharedPreferences — after which SQLite's inventory could not see them.
// Every open now also reconciles the unresolved-row ledger against everything
// the fallback stores hold (`timeline_unresolved_rows.dart`), after this
// open's receipts are written and in the same transaction. The marker and the
// notice are unchanged.
// ⚠️ NR-137 round 9: was "the ledger is what carries the uncertainty". SQLite's
// census now reads those stores live (`sqliteResidueHoles`); the ledger only
// records which items existed at this open, so a later write can supersede
// exactly those.
part of 'timeline_sqlite.dart';

// NR-137 round 10b: the whole import holds the timeline write gate — it writes
// the database directly and clears fallback keys (`clearImported`, which is
// therefore not gated itself).
Future<({int rows, String? failure, int unreadablePrimary, Set<String> unreadablePrimaryIds})> _importOnce({
  required Database db,
  required SharedPreferences prefs,
  required SharedPrefsTimelinePersistence legacy,
}) =>
    TimelineWriteGate.timeline.run(() => _importOnceGated(db: db, prefs: prefs, legacy: legacy));

Future<({int rows, String? failure, int unreadablePrimary, Set<String> unreadablePrimaryIds})> _importOnceGated({
  required Database db,
  required SharedPreferences prefs,
  required SharedPrefsTimelinePersistence legacy,
}) async {
  final List<TimelineEntry> old = await legacy.loadAll();
  final List<TimelineResidueItem> residue = scanTimelinePrefsResidue(prefs);
  final bool migrated = prefs.getBool(kTimelineMigratedKey) == true;
  final bool converted = prefs.getBool(kTimelineLegacyConvertedKey) == true;
  Future<void> reconcile(DatabaseExecutor e) => reconcileUnresolvedTimelineRows(
      e, residue, migrated: migrated, converted: converted);
  if (old.isEmpty) {
    await db.transaction(reconcile);
    return (rows: 0, unreadablePrimary: 0, unreadablePrimaryIds: <String>{}, failure: legacy.unreadableRows > 0 ? 'fallback_unreadable_rows' : null);
  }
  // Receipts outlive deletion; the schema is installed idempotently on open.
  const String receipts = kTimelineFallbackReceiptsTable;
  const String Function(TimelineEntry) fingerprint = timelineImportFingerprint;
  final List<TimelineEntry> confirmedRows = [];
  final Set<String> importedIds = {};
  final Set<String> unreadablePrimaryIds = {};
  await db.transaction((Transaction txn) async {
    for (final TimelineEntry row in old) {
      final confirmed = await txn.query(receipts,
        where: 'id = ? AND fingerprint = ?', whereArgs: [row.id, fingerprint(row)]);
      final current = await txn.query(kTimelineTable,
        columns: ['updated_at', 'payload'], where: 'id = ?', whereArgs: [row.id]);
      if (current.isNotEmpty && (current.single['updated_at'] is! int ||
          decodeTimelineRow(current.single['payload']) == null)) {
        // Preserve both the corrupt primary bytes and the readable pending copy.
        // Neither a receipt nor a destructive cleanup is appropriate here.
        unreadablePrimaryIds.add(row.id);
        continue;
      }
      if (confirmed.isEmpty) {
        if (current.isEmpty || (current.single['updated_at']! as int) < row.updatedAt.toUtc().millisecondsSinceEpoch) {
          await txn.insert(kTimelineTable, _row(row), conflictAlgorithm: ConflictAlgorithm.replace);
          importedIds.add(row.id);
        }
        await txn.insert(receipts, {'id': row.id, 'fingerprint': fingerprint(row)});
      }
      confirmedRows.add(row);
    }
    await reconcile(txn);
  });
  // Read the committed receipt AND each newly imported payload before cleanup.
  final List<TimelineEntry> clearedRows = [];
  for (final row in confirmedRows) {
    final receipt = await db.query(receipts, where: 'id = ? AND fingerprint = ?',
      whereArgs: [row.id, fingerprint(row)]);
    if (receipt.length != 1) throw StateError('fallback import not confirmed');
    if (importedIds.contains(row.id)) {
      final stored = await db.query(kTimelineTable, columns: ['payload'], where: 'id = ?', whereArgs: [row.id]);
      if (stored.length != 1 || stored.single['payload'] != jsonEncode(row.toJson())) {
        unreadablePrimaryIds.add(row.id);
        continue;
      }
    }
    clearedRows.add(row);
  }
  diag('timeline.fallback_import', <String, Object?>{
    'rows': old.length, 'imported_rows': importedIds.length,
    'skipped_rows': old.length - importedIds.length, 'unreadable_primary_rows': unreadablePrimaryIds.length,
  });
  try {
    if (unreadablePrimaryIds.isEmpty) {
      final bool marked = await prefs.setBool(kTimelineMigratedKey, true);
      await prefs.reload();
      if (!marked || prefs.getBool(kTimelineMigratedKey) != true) {
        throw StateError('fallback import marker refused');
      }
    }
    await legacy.clearImported(clearedRows);
    return (rows: importedIds.length, unreadablePrimary: unreadablePrimaryIds.length, unreadablePrimaryIds: unreadablePrimaryIds, failure: unreadablePrimaryIds.isNotEmpty
        ? 'fallback_unreadable_primary_rows'
        : legacy.unreadableRows > 0 ? 'fallback_unreadable_rows' : null);
  } on Object catch (e) {
    diag('timeline.fallback_import_cleanup_failed', <String, Object?>{
      'rows': old.length,
      'row_id_count': old.map((row) => row.id).toSet().length,
      'confirmed_row_id_count': clearedRows.map((row) => row.id).toSet().length,
      'unreadable_primary_row_id_count': unreadablePrimaryIds.length,
    });
    return (rows: importedIds.length, unreadablePrimary: unreadablePrimaryIds.length, unreadablePrimaryIds: unreadablePrimaryIds, failure: 'fallback_import_cleanup:${e.runtimeType}');
  }
}
