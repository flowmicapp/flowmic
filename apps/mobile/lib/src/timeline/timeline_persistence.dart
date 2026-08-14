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
//     cannot be opened. Its 100-row cap is therefore still live on that path,
//     which is why the 「entire history」footnote is conditional rather than a constant.
//
// The loc_ id lineage and the "local first landing point" mechanic are unchanged
// by any of this: an entry is written the instant an utterance closes,
// independent of any room-sync decision.

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'timeline_entry.dart';

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
  /// `shared_prefs` still rewrites its blob inside `upsert` (a JSON array has no
  /// other option). That is honest and stated: the interface no longer FORCES
  /// the rewrite, so the SQLite implementation can do the right thing.
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

/// Tests + a null-object default (no persistence, in-process only).
class InMemoryTimelinePersistence implements TimelinePersistence {
  List<Map<String, Object?>> _rows = <Map<String, Object?>>[];

  @override
  Future<void> upsert(TimelineEntry entry) async {
    final Map<String, Object?> row = entry.toJson();
    final int i = _rows.indexWhere((Map<String, Object?> r) => r['id'] == entry.id);
    if (i >= 0) {
      _rows[i] = row;
    } else {
      _rows.insert(0, row);
    }
  }

  @override
  Future<void> delete(String id) async {
    _rows.removeWhere((Map<String, Object?> r) => r['id'] == id);
  }

  @override
  Future<List<TimelineEntry>> loadAll() async {
    final List<TimelineEntry> out = <TimelineEntry>[];
    for (final Map<String, Object?> r in _rows) {
      final TimelineEntry? e = TimelineEntry.fromJson(r);
      if (e != null) out.add(e);
    }
    return out;
  }

  @override
  Future<void> saveAll(List<TimelineEntry> entries) async {
    // Round-trip through JSON so the in-memory store exercises the exact
    // serialization the production path uses.
    _rows = entries.map((TimelineEntry e) => e.toJson()).toList(growable: false);
  }

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
  Future<List<TimelineEntry>> search(String query, {int limit = 200}) async {
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

/// The PREVIOUS production store: the whole table as one JSON array under a
/// single key. Superseded by SqfliteTimelinePersistence (V2-06a-2) and kept for
/// the two roles named in the file header — migration source, and the fallback
/// the app runs on when SQLite will not open.
///
/// Disk trim (not memory trim): [saveAll] persists at most
/// [maxPersistedEntries] newest rows. The caller's in-memory list is left
/// untouched on purpose — a live session must not suddenly lose scrollable
/// history mid-use; the cap only bounds shared_prefs growth across cold
/// starts (reload reads back the trimmed set).
class SharedPrefsTimelinePersistence implements TimelinePersistence {
  SharedPrefsTimelinePersistence(this._prefs);

  final SharedPreferences _prefs;
  static const String _kKey = 'flowmic.timeline.entries.v1';

  /// Hard cap on rows written to shared_prefs. Memory / TimelineStore is unbounded.
  static const int maxPersistedEntries = 100;

  @override
  Future<List<TimelineEntry>> loadAll() async {
    final String? raw = _prefs.getString(_kKey);
    if (raw == null || raw.isEmpty) return <TimelineEntry>[];
    final Object? decoded = jsonDecode(raw);
    if (decoded is! List) return <TimelineEntry>[];
    final List<TimelineEntry> out = <TimelineEntry>[];
    for (final Object? e in decoded) {
      if (e is Map) {
        final TimelineEntry? parsed =
            TimelineEntry.fromJson(e.cast<String, Object?>());
        if (parsed != null) out.add(parsed);
      }
    }
    return out;
  }

  /// shared_prefs holds ONE json array, so a single-row change still rewrites
  /// the blob. Stated plainly rather than hidden behind the incremental name:
  /// this implementation cannot do better, and that is precisely why the SQLite
  /// one is coming. Correctness is unaffected — only cost.
  @override
  Future<void> upsert(TimelineEntry entry) async {
    final List<TimelineEntry> rows = await loadAll();
    final int i = rows.indexWhere((TimelineEntry e) => e.id == entry.id);
    if (i >= 0) {
      rows[i] = entry;
    } else {
      rows.insert(0, entry);
    }
    await saveAll(rows);
  }

  @override
  Future<void> delete(String id) async {
    final List<TimelineEntry> rows = await loadAll();
    final int before = rows.length;
    rows.removeWhere((TimelineEntry e) => e.id == id);
    // A missing id is not an error — delete is idempotent by contract.
    if (rows.length != before) await saveAll(rows);
  }

  @override
  Future<void> saveAll(List<TimelineEntry> entries) async {
    // Trim disk only — never mutate [entries] (caller's live list).
    final List<TimelineEntry> toWrite = _capNewest(entries, maxPersistedEntries);
    await _prefs.setString(
      _kKey,
      jsonEncode(toWrite.map((TimelineEntry e) => e.toJson()).toList()),
    );
  }

  // Paging and search over ≤100 rows held in one JSON blob: there is nothing to
  // optimise, so both just filter the decoded list. Real on this path, not
  // stubs — the fallback store has to work, not merely compile.

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
  Future<List<TimelineEntry>> search(String query, {int limit = 200}) async {
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

/// Keep the [limit] newest by [TimelineEntry.createdAt] (desc). Does not
/// mutate [entries]. When length ≤ limit, returns a shallow copy as-is.
List<TimelineEntry> _capNewest(List<TimelineEntry> entries, int limit) {
  if (entries.length <= limit) {
    return List<TimelineEntry>.from(entries);
  }
  final List<TimelineEntry> sorted = List<TimelineEntry>.from(entries)
    ..sort(
      (TimelineEntry a, TimelineEntry b) =>
          b.createdAt.compareTo(a.createdAt),
    );
  return sorted.take(limit).toList(growable: false);
}
