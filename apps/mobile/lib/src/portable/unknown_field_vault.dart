// SPEC-REF:
//   docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §2-6 (missing fields must
//     be forward-compatible), §5.4 (unknown fields preserved verbatim — import
//     → export, that field is still there unchanged), §9 (its test row)
//
// Where a FUTURE version's fields wait.
//
// ── WHY THIS IS NOT A COLUMN ON THE ROW ─────────────────────────────────────
//
// The obvious home for 「这一行还带着几个我看不懂的键」("this row is still
// carrying a few keys I don't understand") is TimelineEntry itself — it
// already round-trips through one JSON `payload` column, so an extra map
// would need no migration. It is deliberately NOT there, for one reason:
// `timeline_entry.dart` is the phone's persistence surface, and adding a
// field to it is a change to what a ROW IS. Export is a pure read; it may not
// widen the row model to serve itself. (Window C's boundary: 「不许给行加字段
// ——那是落盘面，是另一件事」 "no adding fields to the row — that is the
// persistence surface, a different matter".)
//
// So the unrecognised fields live BESIDE the timeline, keyed by row id, in the
// same device-local prefs the app already uses for phone-only state.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
// It is NOT a second copy of the timeline and must never grow into one. It holds
// ONLY keys this build could not place, and it is written only by an import.
// On an install that never imports a future-version file it stays empty
// forever — grep [UnknownFieldVault] : the only writer is `portable_import.dart`
// and the only reader is `portable_export.dart`.

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'fpr_mobile.dart';

/// The seam. A named interface rather than a raw `SharedPreferences` so the
/// import/export tests do not need a plugin.
abstract interface class UnknownFieldVault {
  /// Everything carried, keyed by row id. Read WHOLE rather than per row: the
  /// exporter would otherwise decode the same blob once per row (O(n²) on a
  /// 2000-row export), and Book 16 §8 asks that export not be the slow thing.
  Future<Map<String, FprCarriedFields>> readAll();

  /// Merge [fields] in — one write for a whole import batch.
  ///
  /// An entry whose value [FprCarriedFields.isEmpty] is REMOVED rather than
  /// stored: a vault full of empty records would grow on every re-import for no
  /// benefit.
  Future<void> merge(Map<String, FprCarriedFields> fields);

  /// 🔴 Window C2 — drop the entries for rows that no longer exist.
  ///
  /// The card that built this vault booked the debt in writing (Book 16
  /// §9b-4): 「行被删掉时 vault 条目会留下来——正是 G-17『存储单调增长』的同族
  /// 形状」("when a row gets deleted, its vault entry stays behind — exactly
  /// the same family of shape as G-17's 'storage grows monotonically'"), with
  /// C2 named as the payer. This is the payment. It is called by the ONE DELETER
  /// (timeline_reaper.dart) and nowhere else, so a row's carried fields cannot
  /// outlive the row on one deletion path and die with it on another — which is
  /// exactly the shape of G-21.
  Future<void> forget(Iterable<String> rowIds);
}

class SharedPrefsUnknownFieldVault implements UnknownFieldVault {
  SharedPrefsUnknownFieldVault(this._prefs);

  final SharedPreferences _prefs;

  /// Device-local, never synced, never on the wire — same family as
  /// `flowmic.timeline.entries.v1`.
  static const String kKey = 'flowmic.portable.carried_fields.v1';

  Map<String, Object?> _all() {
    final String? raw = _prefs.getString(kKey);
    if (raw == null || raw.isEmpty) return <String, Object?>{};
    try {
      final Object? decoded = jsonDecode(raw);
      return decoded is Map
          ? decoded.cast<String, Object?>()
          : <String, Object?>{};
    } on FormatException {
      // A corrupt blob loses the carried fields, not the user's rows. Cleared
      // rather than propagated: the alternative is an import that fails forever
      // because of a key nobody can read.
      return <String, Object?>{};
    }
  }

  @override
  Future<Map<String, FprCarriedFields>> readAll() async {
    final Map<String, FprCarriedFields> out = <String, FprCarriedFields>{};
    for (final MapEntry<String, Object?> e in _all().entries) {
      out[e.key] = FprCarriedFields.fromJson(e.value);
    }
    return out;
  }

  @override
  Future<void> merge(Map<String, FprCarriedFields> fields) async {
    if (fields.isEmpty) return;
    final Map<String, Object?> all = _all();
    for (final MapEntry<String, FprCarriedFields> e in fields.entries) {
      if (e.value.isEmpty) {
        all.remove(e.key);
      } else {
        all[e.key] = e.value.toJson();
      }
    }
    await _prefs.setString(kKey, jsonEncode(all));
  }

  @override
  Future<void> forget(Iterable<String> rowIds) async {
    final Map<String, Object?> all = _all();
    bool touched = false;
    for (final String id in rowIds) {
      if (all.remove(id) != null) touched = true;
    }
    // A write only when something really went: rewriting an unchanged blob on
    // every delete would put the vault's whole content back on disk for rows
    // that never had carried fields — which is most of them.
    if (touched) await _prefs.setString(kKey, jsonEncode(all));
  }
}

/// Tests and any composition that has no prefs. A legitimate double: it stores
/// what it is given and answers truthfully — it does not fake success for an
/// operation it skipped.
class InMemoryUnknownFieldVault implements UnknownFieldVault {
  final Map<String, FprCarriedFields> entries = <String, FprCarriedFields>{};

  @override
  Future<Map<String, FprCarriedFields>> readAll() async =>
      Map<String, FprCarriedFields>.from(entries);

  @override
  Future<void> merge(Map<String, FprCarriedFields> fields) async {
    for (final MapEntry<String, FprCarriedFields> e in fields.entries) {
      if (e.value.isEmpty) {
        entries.remove(e.key);
      } else {
        entries[e.key] = e.value;
      }
    }
  }

  @override
  Future<void> forget(Iterable<String> rowIds) async {
    for (final String id in rowIds) {
      entries.remove(id);
    }
  }
}
