// Cell E-1/E-2 — the light-record screen's article half: which rows it shows
// once finished recordings are collapsed, and what opening one does.
//
// A `part` of chat_flow_page.dart for the reason every other part beside it
// gives: that file is at the 800-line src cap (verify/lint/file-size.mjs) and
// this is a coherent piece that does not belong to any of its neighbours. The
// name it is reached by is unchanged, so no call site moved.

part of 'chat_flow_page.dart';

extension _ChatFlowArticleRouting on _ChatFlowPageState {
  /// Card F10 — the rows this screen shows. See [mergeNarrowedRows] for why it is
  /// a union of the store's live view and the pager's pages rather than either
  /// one alone.
  ///
  /// Card F2: both halves are scoped by [OwnerTimelinePager.owners], the machine's
  /// owner set. Reading the set off the pager rather than recomputing it is what
  /// keeps the two halves from ever answering different questions — the pager IS
  /// the cache of 「this screen asked storage for THESE owners」, and a store view
  /// built from a different set would union rows the pages can never reach.
  ///
  /// 🔴 CR-8 / cell E-1 — and THEN the articles are collapsed, here, on the one
  /// list this screen has. This is the line 0.3.47 was missing; the LIVE
  /// recording passes through uncollapsed (cell C-1). Full account, including
  /// why every acceptance test was green through it: article_view.dart.
  List<TimelineEntry> _narrowedEntries(String? iid) => iid == null
      ? const <TimelineEntry>[]
      : collapseArticles(
          mergeNarrowedRows(
            controller.store.entriesForOwners(_pager.owners),
            _pager.rows,
          ),
          liveArticleId: controller.session.recordingArticleId,
        );
  /// Open one recording (cell E-2).
  ///
  /// Members are read from the STORE by id rather than carried on the card,
  /// so what opens is what exists at the moment of the tap — a backfilled
  /// segment that landed while the list sat on screen is in the piece, and a
  /// snapshot taken when the card was built would have silently omitted it.
  void _openArticleRouted(TimelineEntry head, AppStrings strings) {
    final String? id = head.articleId;
    if (id == null) return;
    Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => ArticlePage(
          head: head,
          rows: articleMembersOf(controller.store, id),
          strings: strings,
          pendingBackfillMs: controller.backfill.progress.value.pendingMs,
        ),
      ),
    );
  }
}
