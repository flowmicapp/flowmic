// Card NR-3 (owner ruling 2026-08-27 item 8,
// `docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md`; design in §3 of
// `docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md`)
// —— **the delete family**: every trigger that makes a row, and everything that
// row owns, go away.
//
// ── WHY THIS IS THE RIGHT CUT ─────────────────────────────────────────────
// `timeline_reaper.dart`'s header already states the shape verbatim: 「There
// can be many triggers, but there is only ONE deleter.」 Until this card there
// were two triggers (a single row / a range clear) and they sat 30 lines apart
// in timeline_store.dart with the whole build/find/edit family between them.
// This card adds a third, and three triggers of one mechanism belong beside
// each other — a reader asking 「how many ways can a row leave, and do they all
// pay the same price」 now reads one file instead of grepping.
//
// ── THE MECHANICS OF THE SPLIT (this repo's usual rule) ───────────────────
// `timeline_store.dart` stood at 829/800 (pinned in
// `verify/lint/file-size.mjs`'s translation-bloat baseline), so this move is
// also debt repayment, in exactly the shape that lint asks for: a coherent
// family moved out VERBATIM, never reasoning deleted to save lines. Same
// library, so `store._entries` / `store._persistence` / `store._reaper` are
// still in scope; `delete` / `clear` stay on the class as one-line delegates
// ⇒ **no caller and no test double had to be edited** (the precedent and its
// wording are `timeline_store_control_rows.dart`'s header).
//
// 🔴 `notifyListeners` is `@protected` and a `part`'s top-level function is not
// an instance of the class, so the three bodies here CANNOT call it directly.
// They go through `TimelineStore._dropRows`, a private instance helper that
// exists for the same reason `_insertNew` exists for the control-row split.

part of 'timeline_store.dart';

/// Trigger ① —— the user deletes a row on the timeline.
///
/// 🔴 G-21: this used to be `_entries.removeAt` + `_persistence.delete`, i.e.
/// it dropped the ROW and left the row's picture file (and its carried fields)
/// behind forever. It goes through the one deleter now, so 「这一行的字节没了吗」
/// ("are this row's bytes gone")
/// has one answer whichever way the row leaves.
///
/// `advance` is null on purpose: 「我删了这一条」("I deleted this one") says
/// nothing about everything
/// older than it, and moving the cutoff here would claim it did.
void _deleteOne(TimelineStore store, String id) {
  final int i = store._entries.indexWhere((TimelineEntry e) => e.id == id);
  if (i < 0) return;
  final TimelineEntry gone = store._entries.removeAt(i);
  // Fire-and-forget like every other persist on this class — order is held by
  // the single-writer invariant (every mutation goes through this class, on
  // one isolate) plus sqflite's own serialised write chain.
  //
  // D9: fire-and-forget, NOT fail-silent. A reap that throws means the row
  // (or its bytes) is still on disk while the screen shows it gone — the
  // mirror image of the persist_failed case below, and it gets the same loud
  // trail instead of vanishing into an unawaited future.
  _healArticles(store, <TimelineEntry>[gone]);
  unawaited(
    store._reaper.reap(<TimelineEntry>[gone]).then<void>(
      (_) {},
      onError: (Object e) => diag('timeline.reap_failed', <String, Object?>{
        'entry_id': gone.id,
        'is_image': gone.isImage,
        'error': e,
      }),
    ),
  );
  store._notify();
}

/// Trigger ①b —— card NR-3: the multi-select toolbar's batch delete.
///
/// Returns what it ACTUALLY did, so the toast can report a measured number
/// rather than 「how many were ticked」 (doc 16 §6.2-5).
///
/// ── 🔴 WHY IT TAKES ROWS AND NOT IDS ──────────────────────────────────────
/// The obvious signature is `deleteMany(Iterable<String> ids)`, resolving each
/// id against [_entries] the way [_deleteOne] does. **That would silently skip
/// rows**, and skip exactly the ones a user is most likely to have ticked:
///   · the all-history page's SEARCH results come straight from storage
///     (`TimelineStore.search`), so a hit the user never scrolled to is not in
///     `_entries` at all;
///   · the chat page's list is a union of the store's view and
///     `OwnerTimelinePager.rows` (`mergeNarrowedRows`), and a pager row from a
///     page the store never loaded is likewise absent.
/// `_deleteOne`'s `if (i < 0) return;` is correct for ONE row the caller took
/// off the visible list; as a batch rule it is the G-21 shape restored — the
/// screen says the rows are gone and their bytes are still on disk. So the
/// caller hands over the rows it is actually looking at, and every one of them
/// reaches the deleter.
///
/// ⚠️ De-duplicated by id first. A duplicate would be reaped twice and counted
/// twice, and the count is what the user is told — an over-claim, which is the
/// half of 「no silent failure」 that is easiest to ship by accident.
///
/// `advance` is null for the same reason as [_deleteOne]: 「I deleted these
/// forty」 says nothing about everything older than them.
///
/// 🔴 The rows leave [_entries] **AFTER** the reap returns, never before —
/// [_clear]'s D7 discipline, and for the same reason: if the batch dies
/// half-way the honest direction is to under-claim the deletion (a row still
/// listed whose bytes may already be gone; the next [load] reconciles it)
/// rather than to over-claim it (rows wiped off the screen while they are
/// still on disk). The throw is re-raised so the caller can SAY so —
/// `AppStrings.selectionDeleteFailed` is that sentence.
/// 🔴 CR-10 — KEEP EVERY TOUCHED ARTICLE HONEST AFTER A DELETE.
///
/// A head is derived from its members, so deleting members without
/// recomputing it leaves a cover claiming a length and a part count that no
/// longer exist — 「18 parts, 12:04」 over four sentences. That is not a
/// cosmetic drift: those two numbers are the only thing the list shows about
/// a recording, and a clear-by-date is exactly the operation that removes
/// SOME of an article rather than all of it.
///
/// 🔴 AND AN ARTICLE WITH NO MEMBERS LEFT LOSES ITS HEAD. A cover over
/// nothing is a row the user cannot open, cannot delete by its own name (its
/// members are already gone) and cannot explain. It is minted lazily on the
/// first thing said, and it goes the same way when the last thing said is
/// removed — the two halves of one rule.
///
/// ⚠️ It does NOT delete an article when its HEAD is deleted. That direction
/// is the user's call, not this function's, and cascading it would turn
/// 「remove this cover」 into 「remove the meeting」 with no confirmation that
/// said so. The members survive as ordinary light records, which is what
/// they were before articles existed.
void _healArticles(TimelineStore store, List<TimelineEntry> removed) {
  final Set<String> touched = <String>{
    for (final TimelineEntry e in removed)
      if (e.articleId != null && !e.isArticle) e.articleId!,
  };
  for (final String id in touched) {
    final TimelineEntry? head = store.findByClientId(id);
    if (head == null || !head.isArticle) continue;
    if (articleMembersOf(store, id).isEmpty) {
      store.delete(head.id);
      continue;
    }
    refreshArticleHeadOf(store, id);
  }
}

Future<ReapResult> _deleteMany(
  TimelineStore store,
  List<TimelineEntry> doomed,
) async {
  final Map<String, TimelineEntry> unique = <String, TimelineEntry>{};
  for (final TimelineEntry e in doomed) {
    unique.putIfAbsent(e.id, () => e);
  }
  if (unique.isEmpty) {
    return ReapResult(
      rows: 0,
      pictures: 0,
      bytesFreed: 0,
      cutoffs: store._reaper.cutoffs,
    );
  }
  final List<TimelineEntry> rows = unique.values.toList(growable: false);
  final ReapResult out;
  try {
    out = await store._reaper.reap(rows);
  } catch (e) {
    diag('timeline.reap_failed', <String, Object?>{
      'batch': rows.length,
      'images': rows.where((TimelineEntry r) => r.isImage).length,
      'error': e,
    });
    rethrow;
  }
  store._dropRows(unique.keys.toSet());
  _healArticles(store, rows);
  return out;
}

/// Trigger ② —— owner's RV-96 clear (pick one of two types + a time bracket).
///
/// Returns what it ACTUALLY did.
///
/// 🔴 D7 — THE DOOMED SET COMES FROM STORAGE, NOT FROM [_entries]. The
/// confirmation dialog's 「将删除 N 条」("N entries will be deleted") is
/// counted by the inventory layer over
/// the WHOLE table (`AssetInventory.walk` → [readAllRowsForInventory] →
/// `TimelinePersistence.loadAll`), while [_entries] holds only the pages the
/// user has scrolled to ([pageSize] = 60). Selecting the doomed rows from
/// [_entries] deleted at most one page's worth, then advanced the cutoff over
/// the whole promised range — an irreversible delete that reported more than
/// it did, with the survivors' image files still on disk. Selecting from the
/// same full-table source with the same [planClear] predicate is what makes
/// 「将删除 N 条」("N entries will be deleted") and 「已删除 N 条」("N entries
/// have been deleted") agree for real (Book 16 §6.2-5).
///
/// The cutoff advance stays inside [TimelineReaper.reap], AFTER every row (and
/// its bytes) in the batch is gone — a throw mid-batch aborts before the
/// cutoff is written, so the marks never claim a range the delete did not
/// finish covering.
///
/// Pinned by timeline_clear_boundary_test.dart (>60 rows across the pagination
/// boundary; the old in-memory selection goes red there).
Future<ReapResult> _clear(
  TimelineStore store,
  ClearKind kind,
  ClearWindow window, {
  DateTime? now,
}) async {
  final DateTime? horizon = horizonOf(window, now ?? DateTime.now().toUtc());
  final List<TimelineEntry> doomed = planClear(
    await store._persistence.loadAll(),
    kind,
    horizon,
  );
  if (doomed.isEmpty) {
    return ReapResult(
      rows: 0,
      pictures: 0,
      bytesFreed: 0,
      cutoffs: store._reaper.cutoffs,
    );
  }
  final Set<String> ids = doomed.map((TimelineEntry e) => e.id).toSet();
  final ReapResult out;
  try {
    out = await store._reaper.reap(doomed, advance: kind);
  } catch (e) {
    // 🔴 D7, partial-failure form — a delete that did not finish must not
    // leave the SCREEN claiming it did, for the same reason the cutoff is
    // only written after the last row. The rows therefore leave [_entries]
    // AFTER the reap returns, never before: if the batch dies halfway the
    // honest direction is to under-claim the deletion (a row still listed
    // whose bytes may already be gone — the next [load] reconciles it)
    // rather than over-claim it (rows wiped off the screen while they are
    // still on disk), which is the very shape this card removed.
    // No silent failure either: the trail names the batch that did not
    // complete. A user-visible 「清空没做完」("the clear didn't finish") sentence would need new copy —
    // reported as a follow-up need, not smuggled in.
    diag('timeline.clear_failed', <String, Object?>{
      'kind': kind.name,
      'window': window.name,
      'planned_rows': doomed.length,
      'error': e,
    });
    rethrow;
  }
  store._dropRows(ids);
  return out;
}
