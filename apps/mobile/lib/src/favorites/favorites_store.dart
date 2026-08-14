// SPEC-REF:
//   docs/ui-design/REDESIGN-PLAN.md §2 F-5 (Frequently Used / Favorites: local, ≤50 rows,
//     「oldest gets trimmed」;
//     save the current buffer / turn a history row into a favourite / tap to
//     send; show ⭐ on an exact match against history),
//     §6.1 (the 「+」 panel → the Favorites list), §6.4 (F-5's ≤50 and the
//     term cap of 100 are two separate limits)
//   docs/strategy/R6-BACKLOG-AND-PLAN.md wave 2 T-3 ③
//
// The Favorites phrase book. Pure local state + a LocalPrefs round-trip; it
// never touches the wire, the timeline, or settings sync — a favourite is a
// shortcut for composing text, not a record of anything that happened.
//
// Ordering IS recency: index 0 is the newest. That makes 「oldest gets trimmed」
// a tail cut
// and 「exact match against history」 a plain membership test, with no extra
// timestamp field to
// keep honest.

import 'package:flutter/foundation.dart';

import '../settings/local_prefs.dart';

/// F-5 cap. Deliberately NOT the 100 of SCENARIO_MAX_TERMS (D6) — REDESIGN §6.4
/// states outright that these are two different limits, so they do not share a
/// constant.
const int kFavoritesMax = 50;

/// Why an add did not produce a new row. Returned rather than thrown so the UI
/// can say which one happened (a silent no-op on 「save the current buffer」
/// would look broken).
enum FavoriteAddOutcome {
  /// Stored as a new newest-first row.
  added,

  /// The exact text was already saved; it moved back to the top instead of
  /// creating a duplicate.
  refreshed,

  /// Blank / whitespace-only — nothing to save.
  empty,
}

class FavoritesStore extends ChangeNotifier {
  FavoritesStore({required LocalPrefs prefs}) : _prefs = prefs;

  final LocalPrefs _prefs;

  List<String> _items = <String>[];

  /// Newest-first. Unmodifiable so the only mutation path is this class.
  List<String> get items => List<String>.unmodifiable(_items);

  int get length => _items.length;
  bool get isEmpty => _items.isEmpty;

  /// F-5 「show ⭐ on an exact match against history」 — EXACT match, no trimming or normalisation of
  /// the candidate. A history row whose text merely resembles a favourite is
  /// not a favourite, and pretending otherwise would put a ⭐ on a row the user
  /// never saved.
  bool contains(String text) => _items.contains(text);

  /// Hydrate from device-local storage. Never throws — an unreadable pref
  /// leaves an empty list rather than blocking the input area.
  Future<void> load() async {
    final List<String> stored = await _prefs.favorites();
    _items = _normalize(stored);
    notifyListeners();
  }

  /// Save [text] (current buffer, or a history row turned into a favourite).
  /// Trimmed once on
  /// the way in so the stored phrase is what a later exact match will compare
  /// against.
  ///
  /// Re-adding an existing phrase REFRESHES its recency instead of stacking a
  /// duplicate: the list is a phrase book, and two identical rows would be two
  /// buttons that do the same thing.
  Future<FavoriteAddOutcome> add(String text) async {
    final String value = text.trim();
    if (value.isEmpty) return FavoriteAddOutcome.empty;
    final bool existed = _items.contains(value);
    final List<String> next = <String>[
      value,
      for (final String f in _items)
        if (f != value) f,
    ];
    await _commit(next);
    return existed ? FavoriteAddOutcome.refreshed : FavoriteAddOutcome.added;
  }

  /// Remove one phrase. No-op (and no write) when it is not there.
  Future<bool> remove(String text) async {
    if (!_items.contains(text)) return false;
    await _commit(<String>[
      for (final String f in _items)
        if (f != text) f,
    ]);
    return true;
  }

  Future<void> _commit(List<String> next) async {
    // 「oldest gets trimmed」: the list is newest-first, so overflow is dropped off the TAIL.
    // sublist is exclusive-end, so this keeps exactly kFavoritesMax rows.
    _items = next.length > kFavoritesMax
        ? next.sublist(0, kFavoritesMax)
        : next;
    notifyListeners();
    await _prefs.setFavorites(_items);
  }

  /// Defensive read of whatever was on disk: drop blanks, collapse duplicates
  /// (keeping the first/newest occurrence) and enforce the cap. A pref file
  /// written by an older build must not be able to seed a list this class's own
  /// invariants forbid.
  static List<String> _normalize(List<String> raw) {
    final List<String> out = <String>[];
    for (final String item in raw) {
      final String value = item.trim();
      if (value.isEmpty || out.contains(value)) continue;
      out.add(value);
      if (out.length == kFavoritesMax) break;
    }
    return out;
  }
}
