// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §7 (local timeline is the first landing
//     point; loc_ idempotency-key lineage, F-2367)
//   WP-R3-2 item 5 ("local entry persistence: entries table + loc_ idempotency
//     key lineage"; shared_prefs / drift follow the old-line local-storage mechanism)
//
// The device-local timeline persistence CONTRACT, plus two implementations that
// are no longer the production one.
//
// V2-06a-2 moved the real store to SQLite (timeline_sqlite.dart). What is left
// here:
//   * [TimelinePersistence] — the interface every implementation answers to;
//   * [InMemoryTimelinePersistence] — tests and a null-object default;
//   * [SharedPrefsTimelinePersistence] — the OLD store. It is still built and
//     still correct, for exactly two reasons: it is the source the one-time
//     import reads from, and it is the fallback the app runs on when SQLite
//     cannot be opened. NR-146 removes its lossy disk cap;
//     timeline_persistence_test.dart pins complete fallback history.
//
// The loc_ id lineage and the "local first landing point" mechanic are unchanged
// by any of this: an entry is written the instant an utterance closes,
// independent of any room-sync decision.

import 'dart:convert';
import 'package:crypto/crypto.dart';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:shared_preferences_platform_interface/types.dart';

import 'timeline_entry.dart';
import 'timeline_row_stores.dart';
import 'timeline_verified_reads.dart';
import 'timeline_write_failures.dart';
import 'timeline_write_gate.dart';
import '../diag/diag_log.dart';
import 'timeline_corrupt_archive.dart';

/// Identifies a failed storage operation, separate from a rejected row mutation.
class TimelineLocalStorageError extends StateError {
  TimelineLocalStorageError(this.cause) : super('timeline storage operation failed');
  final Object cause;
}

class TimelineRecordRejected extends StateError {
  TimelineRecordRejected() : super('timeline source_text is immutable');
}

/// Optional read health shared by disk stores. Corrupt bytes are never removed.
mixin TimelineReadIssues {
  final TimelineWriteFailures readFailures = TimelineWriteFailures();
  Set<String> unreadableRowIds = {};
  int get unreadableRows => unreadableRowIds.length;
  void reportUnreadableRows(Iterable<String> ids) {
    unreadableRowIds = ids.toSet();
    if (unreadableRowIds.isEmpty) return;
    diag('timeline.unreadable_rows', <String, Object?>{'rows': unreadableRows});
    final digest = sha256.convert(utf8.encode(jsonEncode(unreadableRowIds.toList()..sort())));
    readFailures.recordOnce('unreadable-storage:$digest');
  }
}

/// Decode exactly one row so type errors and JSON failures cannot abort a scan.
TimelineEntry? decodeTimelineRow(Object? value) {
  try {
    final Object? decoded = value is String ? jsonDecode(value) : value;
    return decoded is Map ? TimelineEntry.fromJson(decoded.cast<String, Object?>()) : null;
  } on Object {
    return null;
  }
}

abstract class TimelinePersistence {
  Future<List<TimelineEntry>> loadAll();

  /// V2-06a-2 step 1 — the INCREMENTAL seam.
  ///
  /// This interface used to be `loadAll` + `saveAll(the whole table)`, and `TimelineStore`
  /// called `saveAll` on every single mutation. That is the write amplification
  /// the SQLite migration exists to remove: at ten thousand rows, every
  /// utterance rewrote megabytes.
  ///
  /// The interface is widened FIRST and deliberately. Swapping the storage
  /// engine underneath `saveAll(the whole table)` would have produced a version that runs
  /// SQLite and is exactly as slow — the one outcome that looks like success
  /// and isn't, and that nobody downstream could diagnose.
  ///
  /// Both disk implementations write individual rows. The fallback converts
  /// the old JSON array before its first mutation, without trimming history.
  Future<void> upsert(TimelineEntry entry);

  /// Remove one row by id. A missing id is not an error (idempotent delete).
  Future<void> delete(String id);

  /// V2-06b scroll-up pagination — the [limit] newest rows strictly OLDER than [before]
  /// (null ⇒ the newest page). Newest-first, same as [loadAll].
  ///
  /// Keyset, not OFFSET, and the difference matters here: rows are written
  /// while the user scrolls, and an OFFSET page would silently skip or repeat
  /// entries every time one lands. A timeline that quietly drops a row while
  /// you scroll past it is the same failure as never persisting it.
  Future<List<TimelineEntry>> loadPage({DateTime? before, required int limit});

  /// V2-06b full-text search — rows whose text contains [query], newest-first.
  ///
  /// Substring, case-insensitive, over the words the user can actually see
  /// (source / output / processed). Empty or blank [query] returns nothing
  /// rather than everything: 「searching with nothing dumps out everything」reads as a broken filter.
  Future<List<TimelineEntry>> search(String query, {int limit});

  /// Whole-list write. Kept for MIGRATION and tests only — not a mutation path.
  Future<void> saveAll(List<TimelineEntry> entries);
}

/// Card RC-1a - READ ONE ROW BACK OUT OF PERSISTENT STORAGE.
///
/// The third condition of the 2026-09-06 cleanup threshold is 「the result row's
/// persisted commit has been awaited AND the row was read back」: awaiting the
/// write proves the future completed, and only a read proves something is
/// there to find after a kill. `TimelineStore.awaitPersisted` is the first
/// half; this is the second.
///
/// AN EXTENSION, NOT AN INTERFACE MEMBER, and the reason is blunt: this
/// interface has three implementations in `lib/` and several more in tests, and
/// widening it for one caller would edit every one of them for no behaviour.
///
/// NR-146: SQLite supplies a keyed read; legacy/test implementations retain
/// the whole-table fallback. External batches use a single snapshot instead.
abstract interface class TimelineKeyedPersistence {
  Future<TimelineEntry?> readRecord(String id);
}

typedef TimelineBatchAction = Future<void> Function(
  Map<String, TimelineEntry> existing,
  Future<void> Function(TimelineEntry) write,
);

/// A snapshot and writes in the same transaction domain, owned by the writer.
abstract interface class TimelineBatchPersistence {
  Future<void> writeRecordBatch(TimelineBatchAction action);
}

extension TimelinePersistenceReadBack on TimelinePersistence {
  Future<TimelineEntry?> loadById(String id) async {
    final persistence = this;
    if (persistence is TimelineKeyedPersistence) return (persistence as TimelineKeyedPersistence).readRecord(id);
    for (final TimelineEntry e in await loadAll()) {
      if (e.id == id) return e;
    }
    return null;
  }

  Future<void> withRecordBatch(TimelineBatchAction action) async {
    final persistence = this;
    if (persistence is TimelineBatchPersistence) {
      await (persistence as TimelineBatchPersistence).writeRecordBatch(action);
    } else {
      await action({for (final row in await loadAll()) row.id: row}, upsert);
    }
  }
}

/// Tests + a null-object default (no persistence, in-process only).
class InMemoryTimelinePersistence with TimelineReadIssues
    implements TimelinePersistence, TimelineVerifiedReads {
  List<Map<String, Object?>> _rows = <Map<String, Object?>>[];

  @override
  Future<void> upsert(TimelineEntry entry) =>
      TimelineWriteGate.timeline.run(() async => _upsertRow(entry));

  void _upsertRow(TimelineEntry entry) {
    final Map<String, Object?> row = entry.toJson();
    final int i = _rows.indexWhere((Map<String, Object?> r) => r['id'] == entry.id);
    if (i >= 0) {
      _rows[i] = row;
    } else {
      _rows.insert(0, row);
    }
  }

  @override
  Future<void> delete(String id) => TimelineWriteGate.timeline.run(() async {
        _rows.removeWhere((Map<String, Object?> r) => r['id'] == id);
      });

  @override
  Future<List<TimelineEntry>> loadAll() async {
    final List<TimelineEntry> out = <TimelineEntry>[];
    final Set<String> unreadable = {};
    for (final Map<String, Object?> r in _rows) {
      final TimelineEntry? e = decodeTimelineRow(r);
      if (e != null) { out.add(e); } else { unreadable.add(r['id'] as String? ?? jsonEncode(r)); }
    }
    reportUnreadableRows(unreadable);
    return out;
  }

  /// NR-137 round 6 — through [loadAll] (subclasses hook it), then the
  /// rows that did not decode, read from the same list.
  @override
  Future<TimelineInventory> loadInventory() async {
    final List<TimelineEntry> rows = await loadAll();
    return TimelineInventory(rows, <UnreadableRow>[
      for (final Map<String, Object?> r in _rows)
        if (decodeTimelineRow(r) == null) unreadableRowOf(r),
    ]);
  }

  @override
  Future<bool> mayHoldRow(String id) async =>
      _rows.any((Map<String, Object?> r) => r['id'] == id || r['id'] is! String);

  @override
  Future<void> saveAll(List<TimelineEntry> entries) =>
      TimelineWriteGate.timeline.run(() async {
        // Round-trip through JSON so the in-memory store exercises the exact
        // serialization the production path uses.
        _rows = entries.map((TimelineEntry e) => e.toJson()).toList();
      });

  @override
  Future<List<TimelineEntry>> loadPage({
    DateTime? before,
    required int limit,
  }) async {
    final List<TimelineEntry> all = await loadAll();
    all.sort((TimelineEntry a, TimelineEntry b) => b.createdAt.compareTo(a.createdAt));
    return all
        .where((TimelineEntry e) => before == null || e.createdAt.isBefore(before))
        .take(limit)
        .toList(growable: false);
  }

  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 1000}) async {
    final String q = query.trim().toLowerCase();
    if (q.isEmpty) return <TimelineEntry>[];
    final List<TimelineEntry> all = await loadAll();
    all.sort((TimelineEntry a, TimelineEntry b) => b.createdAt.compareTo(a.createdAt));
    return all
        .where((TimelineEntry e) => timelineSearchText(e).contains(q))
        .take(limit)
        .toList(growable: false);
  }
}

/// The haystack a search runs against: everything the user can SEE on the row,
/// lowercased. Kept as one shared function so the SQLite column and the
/// in-memory implementation cannot disagree about what「a match」means.
///
/// Deliberately excludes ids, window titles and PC names. A search over
/// 「meeting」 (会议)
/// should return the sentences about the meeting, not every row that happened
/// to land in a window whose title contained it.
String timelineSearchText(TimelineEntry e) => <String?>[
  e.sourceText,
  e.outputText,
  e.processedText,
].whereType<String>().join('\n').toLowerCase();

/// The fallback stores each row under its own key and reads the previous
/// production JSON array for migration. Superseded by SqfliteTimelinePersistence (V2-06a-2) and kept for
/// the two roles named in the file header — migration source, and the fallback
/// the app runs on when SQLite will not open.
///
/// NR-146: no disk trim. The old cap only bounded JSON growth
/// (`timeline_sqlite.dart` header); it was not a correctness constraint.
/// Regression: timeline_persistence_test.dart persists all 120 rows.
/// What a session on the fallback knows about the SQLite database file.
enum SqliteFileEvidence {
  /// Checked: there is no file, so no SQLite row exists.
  absent,

  /// The file exists, or nobody checked: any row may be in it.
  unknown,
}

class SharedPrefsTimelinePersistence with TimelineReadIssues
    implements TimelinePersistence, TimelineVerifiedReads {
  SharedPrefsTimelinePersistence(this._prefs,
      {this.sqliteFile = SqliteFileEvidence.unknown});

  final SharedPreferences _prefs;

  /// NR-137 round 8/9 — this session cannot see the SQLite file's rows
  /// (`TimelineRowStore.sqliteRows`, role `unreachable`). Unless the file was
  /// checked and is not there, both SQLite stores are UNREAD and nothing is
  /// proven. ⚠️ Round 9: the default is unknown (was "no file"); the app sets
  /// it in `openTimelinePersistence`, on the instance it returns. Display is
  /// unaffected.
  SqliteFileEvidence sqliteFile;
  bool _cacheNeedsReload = false;
  static const String _kKey = kTimelineLegacyArrayKey;
  static const String _legacyRowPrefix = kTimelineV2RowPrefix;
  static const String _rowPrefix = kTimelineV3RowPrefix;
  static const String _migratedKey = kTimelineMigratedKey;
  static const String _convertedKey = kTimelineLegacyConvertedKey;

  String _key(String id) => '$_rowPrefix${Uri.encodeComponent(id)}';


  @override
  Future<List<TimelineEntry>> loadAll() async => (await loadInventory()).rows;

  /// NR-137 round 6 — the scan [loadAll] always was, with its holes kept: a
  /// row key whose value will not decode, or a legacy array entry (or the
  /// whole array) that will not. The display list is unchanged.
  ///
  /// ⚠️ 更正（NR-137 round 7, review D2）: 原为 「the legacy array is read only
  /// until it is converted」. Conversion ([_convertLegacy]) copies the READABLE
  /// entries to row keys and sets the marker, and leaves the array untouched —
  /// so an entry it could not decode still exists ONLY in that array, and
  /// dropping the array from the scan after the marker turned that row into
  /// 「absent」 (measured: a legacy member proven gone, press `done`, audio
  /// released). Once converted (or migrated to SQLite) the array's readable
  /// entries are a rollback copy and are not rows; its undecodable entries
  /// (or the whole array, if it does not parse) stay HOLES for as long as the
  /// array exists. The same for a legacy v2 row key after migration. Those
  /// holes are inventory-only: [reportUnreadableRows] — the notice the user
  /// sees — reports exactly what it reported before.
  ///
  /// ⚠️ NR-137 round 8: the items come from the one enumeration of these
  /// stores the SQLite import uses too (`timeline_row_stores.dart`); two scans
  /// would be two answers. A value filed under another id's key is a hole of
  /// unknown id (it may be either row), frozen or not.
  ///
  /// ⚠️ NR-137 round 9 (review r8): every registered store is answered for,
  /// in one exhaustive switch — the SQLite stores as unread unless the file is
  /// known to be absent, the cloud retry records as residue, the archive as
  /// recovery copies — and every unclaimed `flowmic.timeline.` key is an item
  /// that may be any row. Two readable copies of one id that differ are a
  /// conflict, not a row (the list still shows the later one, as before).
  @override
  Future<TimelineInventory> loadInventory() async {
    await _recoverCache();
    final Map<String, TimelineEntry> rows = <String, TimelineEntry>{};
    final Set<String> unreadable = {};
    final List<UnreadableRow> holes = <UnreadableRow>[];
    final Set<TimelineRowStore> unread = <TimelineRowStore>{};
    final bool migrated = _prefs.getBool(_migratedKey) == true;
    final bool live = !migrated && _prefs.getBool(_convertedKey) != true;
    final TimelinePrefsScan scan = scanTimelinePrefs(_prefs);
    void addRow(TimelineEntry row) {
      final TimelineEntry? earlier = rows[row.id];
      if (earlier != null &&
          jsonEncode(earlier.toJson()) != jsonEncode(row.toJson())) {
        final ({bool known, String? articleId}) a =
            agreedArticle(<Object?>[earlier.articleId, row.articleId]);
        holes.add(UnreadableRow(
            id: row.id, articleKnown: a.known, articleId: a.articleId));
      }
      rows[row.id] = row;
    }
    for (final TimelineRowStore store in TimelineRowStore.values) {
      switch (store) {
        case TimelineRowStore.sqliteRows:
        case TimelineRowStore.sqliteCorruptArchive:
          if (sqliteFile != SqliteFileEvidence.absent) unread.add(store);
        case TimelineRowStore.prefsLegacyArray:
        case TimelineRowStore.prefsV2Rows:
        case TimelineRowStore.prefsV3Rows:
        case TimelineRowStore.prefsCorruptArchive:
        case TimelineRowStore.prefsCloudRetries:
          break; // read from the scan, below, in the platform's key order
      }
    }
    for (final TimelineResidueItem item in scan.items) {
      final TimelineEntry? row = item.row;
      switch (item.store) {
        case TimelineRowStore.prefsLegacyArray:
          if (row == null) {
            if (live) unreadable.add(item.reportId);
            holes.add(item.hole);
          } else if (live) {
            addRow(row);
          }
        case TimelineRowStore.prefsV2Rows when migrated:
          // Imported into SQLite when readable; an undecodable one never was.
          if (row == null) holes.add(item.hole);
        case TimelineRowStore.prefsV2Rows:
        case TimelineRowStore.prefsV3Rows:
          if (row == null) {
            unreadable.add(item.reportId);
            holes.add(item.hole);
          } else {
            addRow(row);
          }
        case TimelineRowStore.prefsCloudRetries:
          if (!item.cloudDeleteRetry) holes.add(item.hole);
        case TimelineRowStore.prefsCorruptArchive:
          break; // a recovery copy of a replaced row: never a row
        case TimelineRowStore.sqliteRows:
        case TimelineRowStore.sqliteCorruptArchive:
          break; // never yielded by the SharedPreferences scan
      }
    }
    for (final String _ in scan.unclaimed) {
      holes.add(const UnreadableRow());
    }
    reportUnreadableRows(unreadable);
    return TimelineInventory(rows.values.toList(), holes, unread: unread);
  }

  @override
  Future<bool> mayHoldRow(String id) async {
    final TimelineInventory inv = await loadInventory();
    return inv.unread.isNotEmpty ||
        inv.rows.any((TimelineEntry e) => e.id == id) ||
        inv.unreadable.any((UnreadableRow u) => u.mayBe(id));
  }

  // A normal mutation encodes only its row. No history cap or whole-list
  // rewrite. Legacy conversion is retryable and removes its blob only after
  // every row has been read back from the platform.
  Future<void> _recoverCache() async {
    if (!_cacheNeedsReload) return;
    await _prefs.reload();
    _cacheNeedsReload = false;
  }

  Future<void> _verifyOperation(Future<void> Function() action) async {
    await _recoverCache();
    try {
      await action();
    } on Object {
      // Legacy SharedPreferences changes its cache before the platform answers,
      // including when the platform throws. An uncertain cache cannot confirm
      // an audio cleanup or let a delete retry silently skip the disk row.
      _cacheNeedsReload = true;
      await _recoverCache();
      rethrow;
    }
  }

  Future<void> _writeVerified(String key, String value) => _verifyOperation(() async {
    final bool saved = await _prefs.setString(key, value);
    final Object? actual = await _readPlatformKey(key);
    // Foundation's UserDefaults.set returns void; read the platform value.
    if (!saved || actual != value) throw StateError('timeline shared preferences write refused');
  });

  Future<Object?> _readPlatformKey(String key) async {
    // This app uses SharedPreferences' default prefix (no setPrefix callers).
    // Restrict platform output to one row: reload/getAll would marshal history
    // back to the UI isolate on every successful save.
    final String platformKey = 'flutter.$key';
    final Map<String, Object> actual = await SharedPreferencesStorePlatform.instance.getAllWithParameters(
      GetAllParameters(filter: PreferencesFilter(prefix: 'flutter.', allowList: <String>{platformKey})),
    );
    return actual[platformKey];
  }

  Future<void> _removeVerified(String key) => _verifyOperation(() async {
    final bool removed = await _prefs.remove(key);
    final Object? actual = await _readPlatformKey(key);
    if (!removed || actual != null) throw StateError('timeline shared preferences delete refused');
  });

  Future<void> _convertLegacy() async {
    await _recoverCache();
    if (_prefs.getBool(_migratedKey) == true ||
        _prefs.getBool(_convertedKey) == true || _prefs.get(_kKey) == null) {
      return;
    }
    final List<TimelineEntry> rows = await loadAll();
    for (final TimelineEntry row in rows) {
      await _writeRowPreserving(row);
    }
    final bool saved = await _prefs.setBool(_convertedKey, true);
    await _prefs.reload();
    if (!saved || _prefs.getBool(_convertedKey) != true) {
      throw StateError('legacy conversion marker refused');
    }
  }

  /// NR-137 round 10b: the public writes hold the timeline write gate; the
  /// private ones they share (and [clearImported], run inside the import's
  /// hold) do not, because the gate is not re-entrant.
  @override
  Future<void> upsert(TimelineEntry entry) =>
      TimelineWriteGate.timeline.run(() => _upsert(entry));

  Future<void> _upsert(TimelineEntry entry) async {
    await _convertLegacy();
    await _writeRowPreserving(entry);
  }

  Future<void> _writeRowPreserving(TimelineEntry entry) async {
    final key = _key(entry.id);
    final previous = _prefs.get(key);
    final replaced = previous != null && unreadableTimelineValue(previous, entry);
    if (replaced) {
      final encoded = jsonEncode(previous);
      final digest = sha256.convert(utf8.encode(encoded));
      await _writeVerified('$kTimelineCorruptPrefsPrefix${Uri.encodeComponent(entry.id)}.$digest', encoded);
    }
    await _writeVerified(key, jsonEncode(entry.toJson()));
    if (replaced) reportCorruptTimelineReplacement(entry.id);
  }

  List<String> _corruptKeys(String id) {
    final owner = '$kTimelineCorruptPrefsPrefix${Uri.encodeComponent(id)}';
    return _prefs.getKeys().where((key) =>
      key.startsWith('$owner.') && key.substring(0, key.lastIndexOf('.')) == owner,
    ).toList();
  }

  @override
  Future<void> delete(String id) =>
      TimelineWriteGate.timeline.run(() => _delete(id));

  Future<void> _delete(String id) async {
    await _convertLegacy();
    // Preferences has no transactions. Remove side copies first: if any
    // removal fails, keep the visible row so the single deleter can retry.
    for (final key in _corruptKeys(id)) {
      await _removeVerified(key);
    }
    final String key = _key(id);
    if (_prefs.containsKey(key)) await _removeVerified(key);
  }

  @override
  Future<void> saveAll(List<TimelineEntry> entries) =>
      TimelineWriteGate.timeline.run(() => _saveAll(entries));

  Future<void> _saveAll(List<TimelineEntry> entries) async {
    await _convertLegacy();
    final Set<String> wanted = entries.map((e) => _key(e.id)).toSet();
    for (final TimelineEntry entry in entries) { await _upsert(entry); }
    for (final String key in _prefs.getKeys().where((k) => k.startsWith(_rowPrefix)).toList()) {
      if (!wanted.contains(key) && decodeTimelineRow(_prefs.get(key)) != null) {
        await _removeVerified(key);
      }
    }
  }

  /// Clear only the exact readable rows confirmed by the import. Concurrent
  /// changes and unreadable keys remain untouched; the v1 rollback copy stays.
  Future<void> clearImported(List<TimelineEntry> rows) async {
    await _recoverCache();
    for (final TimelineEntry row in rows) {
      for (final String prefix in [_rowPrefix, _legacyRowPrefix]) {
        final String key = '$prefix${Uri.encodeComponent(row.id)}';
        if (_prefs.get(key) == jsonEncode(row.toJson())) {
          await _removeVerified(key);
        }
      }
    }
  }

  // Paging/search scan fallback rows; normal mutations encode one row.

  @override
  Future<List<TimelineEntry>> loadPage({
    DateTime? before,
    required int limit,
  }) async {
    final List<TimelineEntry> all = await loadAll();
    all.sort((TimelineEntry a, TimelineEntry b) => b.createdAt.compareTo(a.createdAt));
    return all
        .where((TimelineEntry e) => before == null || e.createdAt.isBefore(before))
        .take(limit)
        .toList(growable: false);
  }

  @override
  Future<List<TimelineEntry>> search(String query, {int limit = 1000}) async {
    final String q = query.trim().toLowerCase();
    if (q.isEmpty) return <TimelineEntry>[];
    final List<TimelineEntry> all = await loadAll();
    all.sort((TimelineEntry a, TimelineEntry b) => b.createdAt.compareTo(a.createdAt));
    return all
        .where((TimelineEntry e) => timelineSearchText(e).contains(q))
        .take(limit)
        .toList(growable: false);
  }
}
