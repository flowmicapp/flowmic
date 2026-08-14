// Card F10 — owner-scoped keyset pagination for the narrowed (per-instance) view.
//
// 🔴 THE DEFECT THIS EXISTS TO KILL. The chat page used to render
// `TimelineStore.entriesForInstance(iid)`, which is an IN-MEMORY FILTER over
// whatever page the store happens to hold. What the store holds is
// `loadPage(limit: 60)` with NO owner predicate — the globally newest 60 rows.
// So the per-instance screen showed 「whichever of the newest 60 rows happen to
// belong to this instance」: connect to a PC you last used yesterday, and the
// screen is EMPTY although every row is sitting in the table. The store's own
// `loadMore()` did not help either — its only caller in the whole app is
// `history_page.dart`, so the chat list never paginated at all.
//
// The fix is to ASK STORAGE the narrowed question instead of filtering an
// answer to a different one. The index for that question has existed, unused,
// since V2-06a-1: `idx_timeline_owner (spoken_to_instance_id, created_at DESC)`.
//
// 🔴 F2 CONTRACT (docs/strategy/2026-08-04-f2-machine-merge-design.md §5 Stage 3):
// 「分页谓词从「单 owner」推广为「owner ∈ 集合」（索引不变）」("the paging predicate
// generalizes from 'single owner' to 'owner ∈ set' (the index stays
// unchanged)"). F2 will widen the
// owner of a chat view from ONE pairing instance id to the SET of instance ids
// belonging to the same physical machine. This pager therefore takes a SET from
// day one — today the caller passes a singleton — so that F2 is a change of
// ARGUMENT, not a rewrite of the paging path. Nothing here implements the merge
// itself: building the set is F2's job (`session/machine_key.dart`).

import 'package:flutter/foundation.dart';

import 'timeline_entry.dart';
import 'timeline_persistence.dart';

/// Storage that can answer 「the newest rows spoken to ANY of these owners,
/// older than this cursor」 as a QUERY.
///
/// Deliberately a SEPARATE, narrow interface rather than a new method on
/// [TimelinePersistence]: the capability is genuinely optional. Production can
/// come up on the capped SharedPrefs blob when the SQLite open fails
/// (`main.dart` — 「whatever openTimelinePersistence actually managed to open」),
/// and that store has no index to scope with. Widening the base interface would
/// have forced a fake implementation onto every implementer — including the
/// test doubles other cards own — and a fake owner-scoped query is exactly the
/// in-memory filter this card is deleting.
abstract class OwnerScopedTimelineSource {
  /// Newest-first rows whose birth-time owner is in [ownerIds], strictly older
  /// than [before] (null ⇒ start from the newest), at most [limit] of them.
  ///
  /// Soft-deleted rows are NOT filtered here — the caller decides, exactly as
  /// with [TimelinePersistence.loadPage], because a page made entirely of
  /// deleted rows still means 「there is more above」.
  Future<List<TimelineEntry>> loadOwnerPage({
    required Set<String> ownerIds,
    DateTime? before,
    required int limit,
  });
}

/// Card F10 — what a narrowed chat list actually renders: [live] (the store's
/// view of this owner's rows) unioned with [paged] (the pager's owner-scoped
/// pages), newest-first, de-duplicated on id.
///
/// 🔴 Why a union and not just the pager. The store is authoritative for rows
/// that exist RIGHT NOW: a just-spoken utterance is inserted into its list
/// before — and independently of — the `upsert` reaching SQLite, and edits and
/// status write-backs flow through it. The pager is authoritative for DEPTH: it
/// is the only side that has actually asked storage the narrowed question.
/// Either one alone regresses the other half — pager-only would make a fresh
/// utterance appear only after a reload; store-only IS the defect this card
/// exists to kill.
///
/// The union can only ADD rows that already passed the same owner predicate, so
/// it cannot widen the view past Requirement ④. [live] wins on an id collision because
/// it carries this session's later write-backs.
///
/// Pure on purpose: it is the one piece of F10 with a branch worth reading, and
/// a pure function can be measured without pumping a widget.
List<TimelineEntry> mergeNarrowedRows(
  List<TimelineEntry> live,
  List<TimelineEntry> paged,
) {
  if (paged.isEmpty) return live;
  final Set<String> seen = live.map((TimelineEntry e) => e.id).toSet();
  return <TimelineEntry>[
    ...live,
    ...paged.where((TimelineEntry e) => !seen.contains(e.id)),
  ]..sort((TimelineEntry a, TimelineEntry b) =>
      b.createdAt.compareTo(a.createdAt));
}

/// One chat view's window onto the table: the rows spoken to [owners],
/// newest-first, extended upward one page at a time.
///
/// Lives next to the widget that scrolls it rather than inside [TimelineStore]:
/// the store is the app-wide, cross-instance list (the full-history page
/// paginates it, edits and
/// deletions flow through it), while this is a per-screen cursor that is thrown
/// away when the screen is. Two cursors over one list in one object is how the
/// 「chat page silently reused the history page's page」 confusion started.
class OwnerTimelinePager extends ChangeNotifier {
  OwnerTimelinePager({
    required TimelinePersistence? persistence,
    this.pageSize = 60,
  }) : _persistence = persistence;

  /// Null ⇒ this pager has no storage to ask and stays permanently empty.
  ///
  /// 🔴 Not a friendly default: [ChatFlowPage] treats a null source as 「the
  /// composition root did not wire storage」 and keeps rendering the store's own
  /// rows, so the page degrades to the PRE-F10 behaviour rather than to a blank
  /// screen. `chat_history_source_wiring_test.dart` pins the production wiring
  /// so that degradation cannot become the shipped path by omission.
  final TimelinePersistence? _persistence;

  /// Rows per page. Matches [TimelineStore.pageSize] so a first screen costs the
  /// same one query it did before this card.
  final int pageSize;

  Set<String> _owners = const <String>{};
  final List<TimelineEntry> _rows = <TimelineEntry>[];
  bool _loading = false;
  bool _firstLoadComplete = false;
  bool _hasMore = true;

  /// Bumped whenever the window is reset. A query that comes back under an old
  /// generation must not touch ANY state — not the rows (another instance's
  /// history on this screen), and not [_loading]/[_firstLoadComplete] either,
  /// which would clear the spinner and flash the empty state over a load that
  /// is still running.
  int _generation = 0;

  /// The owner set this window is scoped to. Empty ⇒ no connected instance.
  Set<String> get owners => _owners;

  /// Loaded rows, newest-first, soft-deleted rows already dropped.
  List<TimelineEntry> get rows => List<TimelineEntry>.unmodifiable(_rows);

  /// A query is in flight (first page or older page alike).
  bool get loading => _loading;

  /// 🔴 The bit that keeps 「还没有历史」("there is no history yet") apart from
  /// 「历史还没加载完」("history hasn't finished loading"). Until the
  /// first page has come back, an empty [rows] means NOTHING — rendering the
  /// empty state on it would tell a returning user their history is gone.
  bool get firstLoadComplete => _firstLoadComplete;

  /// False once a page comes back short: the oldest owned row is loaded and
  /// there is nothing further up. Distinct from 「还没试过」("haven't tried yet").
  bool get hasMore => _hasMore;

  /// Point this window at a new owner set. No-op when the set is unchanged, so
  /// it is safe to call from `build`/`didUpdateWidget`.
  ///
  /// A CHANGED set (including 「connected → disconnected」) resets the window:
  /// the previous instance's rows must not linger under a new header for even
  /// one frame.
  Future<void> setOwners(Set<String> owners) async {
    if (setEquals(_owners, owners)) return;
    _owners = Set<String>.unmodifiable(owners);
    _generation += 1;
    _rows.clear();
    _hasMore = true;
    _firstLoadComplete = false;
    _loading = false;
    if (_owners.isEmpty) {
      // Nothing to ask. Complete rather than hang: 「no instance」 is its own
      // rendered face and must not sit behind a spinner forever.
      _firstLoadComplete = true;
      notifyListeners();
      return;
    }
    notifyListeners();
    await _load(before: null, limit: pageSize, replace: true);
  }

  /// One page older than the oldest row held.
  ///
  /// Idempotent while in flight — the scroll listener fires on every pixel near
  /// the edge and must not stack queries.
  Future<void> loadMore() async {
    if (_loading || !_hasMore || !_firstLoadComplete || _owners.isEmpty) return;
    if (_rows.isEmpty) return;
    await _load(before: _rows.last.createdAt, limit: pageSize, replace: false);
  }

  /// Drop a row this window is holding, without a round trip.
  ///
  /// Called when the chat page itself deletes a row: the store removes it from
  /// ITS list and notifies, but a copy cached here would repaint the row the
  /// user just watched disappear.
  void forget(String id) {
    final int before = _rows.length;
    _rows.removeWhere((TimelineEntry e) => e.id == id);
    if (_rows.length != before) notifyListeners();
  }

  /// Re-ask storage for exactly the depth already on screen.
  ///
  /// For deletions this window cannot see (the full-history page, a scoped
  /// clear). Re-querying
  /// the same depth rather than resetting to page 1 keeps a user who scrolled
  /// up five pages where they were.
  Future<void> resync() async {
    if (_owners.isEmpty || _rows.isEmpty) return;
    await _load(before: null, limit: _rows.length, replace: true);
  }

  Future<void> _load({
    required DateTime? before,
    required int limit,
    required bool replace,
  }) async {
    final TimelinePersistence? p = _persistence;
    if (p == null) {
      _firstLoadComplete = true;
      notifyListeners();
      return;
    }
    final Set<String> asked = _owners;
    final int gen = _generation;
    _loading = true;
    notifyListeners();
    try {
      final List<TimelineEntry> page = await _queryOwnerPage(
        p,
        ownerIds: asked,
        before: before,
        limit: limit,
      );
      // The owner set can change while a query is in flight (disconnect, or an
      // F2 machine-set rebuild). Landing a stale answer would put another
      // instance's rows on this screen — the exact confusion Requirement ④ forbids.
      if (gen != _generation) return;
      // Judged on the RAW page length, before the soft-deleted rows are
      // dropped: a page made entirely of deleted rows still means there is
      // more above it.
      _hasMore = page.length >= limit;
      if (replace) _rows.clear();
      final Set<String> known = _rows.map((TimelineEntry e) => e.id).toSet();
      _rows.addAll(
        page.where((TimelineEntry e) => !e.deleted && !known.contains(e.id)),
      );
      _rows.sort((TimelineEntry a, TimelineEntry b) =>
          b.createdAt.compareTo(a.createdAt));
    } finally {
      if (gen == _generation) {
        _loading = false;
        _firstLoadComplete = true;
      }
      notifyListeners();
    }
  }

  /// The indexed query when storage can answer it; an honest scan when it
  /// cannot.
  Future<List<TimelineEntry>> _queryOwnerPage(
    TimelinePersistence p, {
    required Set<String> ownerIds,
    required DateTime? before,
    required int limit,
  }) async {
    if (p is OwnerScopedTimelineSource) {
      final OwnerScopedTimelineSource scoped = p as OwnerScopedTimelineSource;
      return scoped.loadOwnerPage(
        ownerIds: ownerIds,
        before: before,
        limit: limit,
      );
    }
    // Degraded path — SharedPrefs fallback storage only.
    //
    // Walks the unscoped keyset pages and keeps the owned rows until it has a
    // full page or the table runs out. This is SLOW but it is the same ANSWER,
    // which is the whole point: the pre-F10 code took one unscoped page and
    // called it the answer. The scan is bounded in practice because the only
    // production storage without an owner index is the 100-row capped blob
    // (`historyFallbackNote`), and it terminates in every case because each
    // step strictly lowers the cursor.
    final List<TimelineEntry> collected = <TimelineEntry>[];
    DateTime? cursor = before;
    while (collected.length < limit) {
      final List<TimelineEntry> raw =
          await p.loadPage(before: cursor, limit: limit);
      if (raw.isEmpty) break;
      for (final TimelineEntry e in raw) {
        final String? owner = e.spokenToInstanceId;
        if (owner != null && ownerIds.contains(owner)) collected.add(e);
        if (collected.length >= limit) break;
      }
      final DateTime next = raw.last.createdAt;
      if (cursor != null && !next.isBefore(cursor)) break; // no progress
      cursor = next;
      if (raw.length < limit) break; // that was the last page
    }
    return collected;
  }
}
