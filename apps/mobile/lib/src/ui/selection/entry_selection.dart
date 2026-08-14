// SPEC-REF:
//   docs/decisions/2026-08-06-owner-feedback-batch-fb1-12.md FB-7
//   owner, verbatim: "the current recording needs to extend further: on the
//   phone you should be able to multi-select, and after multi-selecting you
//   should be able to batch-copy, or hand the selection to AI to organize
//   into something new" (「现在的记录要延伸：手机上可多选，多选之后可批量复制，
//   也可以多选之后统一交给 AI 整理成新的东西」)
//
// The multi-select state itself: enter/exit, tick/untick, select-all. One
// ChangeNotifier that knows none of TimelineEntry's fields, only ids — so it
// can be unit-tested independently of any page.
//
// ── HOW THE INTERACTION SHAPE WAS DECIDED (not a preference — counted) ──────
// This repo had **no prior multi-select precedent** before this (a full grep
// of `apps/mobile/lib`: no `Checkbox`, no selection mode, no
// `Set<String> _selected`), so the gesture had to be freshly chosen, and it
// needs a justification:
//   ① **Long-press is already taken**: `chat_message_tile.dart`'s
//      `onLongPress` → `chat_flow_page`'s `_onLongPress` →
//      `showEntryContextMenu` (deferred-delivery / re-run / edit / copy /
//      favorite / delete). Hanging another long-press semantic there would
//      either compete with it or need duration-based disambiguation — both
//      are overloading a gesture that already has an owner.
//   ② **A single tap is empty, and deliberately left that way**:
//      `chat_message_tile.dart` has the sentence "a single tap must stay
//      free for the row itself" written right next to the picture
//      double-tap preview (`onDoubleTap`).
// ⇒ **Add a "multi-select" item to the existing long-press menu to enter the
//   mode, then a single tap toggles selection once inside it**. Not one new
//   gesture was invented; the entry point is somewhere the user already
//   knows to look for behavior; and `EntryAction` is a **closed enum**, so
//   failing to handle one branch is a compile error, not a silent dead item.
//
// ⚠️ The two candidates that were rejected, written down so the next person
// doesn't retread them:
//   (a) **A standing "multi-select" button on the toolbar** — the top bar
//       already had its budget counted once in 0.2.51: at 360dp, a single
//       row cannot fit a fourth thing (that card split the top bar into two
//       rows). Adding another standing control would be a third instance of
//       the same budget problem.
//   (b) **Swipe-left to reveal a selection box** — `R-UX-09` explicitly
//       states swipe actions are parked as optional, and this page's
//       `ListView` is already `reverse: true`, so swipe semantics have
//       already been inverted once.

import 'package:flutter/foundation.dart';

/// "Which rows are ticked".
///
/// 🔴 **It only stores ids, never rows**, deliberately: rows get deleted
/// elsewhere (all-history, range clear), and also get swapped for new
/// objects by pagination. Storing rows would mean holding onto a copy that
/// might no longer exist, and "3 selected" speaking on behalf of a record
/// that no longer exists is exactly the opposite of this repo's R11 rule
/// that "a status word must be able to answer 'says who'".
///
/// ⇒ The real "how many are actually selected" is computed on the spot by
///   [visibleSelected] intersecting with the **current list**; this class
///   does no reconciliation of its own: mutating state inside `build` is a
///   `markNeedsBuild` during
///   build, whereas taking an intersection is a pure function with zero side effects.
class EntrySelection extends ChangeNotifier {
  bool _active = false;
  final Set<String> _ids = <String>{};

  /// Whether multi-select mode is active. false ⇒ the toolbar doesn't paint,
  /// and a single tap goes back to "does nothing".
  bool get active => _active;

  /// The set of ticked ids (read-only view). ⚠️ It **may contain ids no
  /// longer in the list** — see the class doc; for "how many are actually
  /// selected", use [visibleSelected].
  Set<String> get ids => Set<String>.unmodifiable(_ids);

  bool contains(String id) => _ids.contains(id);

  /// Enter multi-select mode. [seed] is the row that triggered it — the user
  /// long-pressed a row and picked "multi-select", and that row **obviously
  /// ought to be selected**; without seeding it, the mode would open empty
  /// and the user would have to tap, a second time, the very row they just
  /// long-pressed.
  void enter({String? seed}) {
    if (_active && (seed == null || _ids.contains(seed))) return;
    _active = true;
    if (seed != null) _ids.add(seed);
    notifyListeners();
  }

  void toggle(String id) {
    if (!_ids.remove(id)) _ids.add(id);
    notifyListeners();
  }

  /// Select all. Passed **the current list's** ids, not "all of history" —
  /// what the toolbar's label answers is "select everything I can currently
  /// see", and this page is a paginated window to begin with.
  void selectAll(Iterable<String> visibleIds) {
    final int before = _ids.length;
    _ids.addAll(visibleIds);
    if (_ids.length == before) return;
    notifyListeners();
  }

  /// Exit multi-select mode and clear it. **Clearing is mandatory**: leaving
  /// the last session's ticks in place would mean the next entry carries a
  /// selection the user never made, and the toolbar would report its count
  /// as if nothing were wrong.
  void exit() {
    if (!_active && _ids.isEmpty) return;
    _active = false;
    _ids.clear();
    notifyListeners();
  }
}

/// The rows in the current list that are **actually selected**, in the
/// list's original order.
///
/// A pure function with no side effects, so calling it inside `build` is
/// safe (see [EntrySelection]'s class doc for why it does no reconciliation).
/// The generic only requires that an id can be extracted, so tests can feed
/// it plain string pairs.
List<T> visibleSelected<T>(
  Iterable<T> entries,
  EntrySelection selection,
  String Function(T entry) idOf,
) => <T>[
  for (final T e in entries)
    if (selection.contains(idOf(e))) e,
];
