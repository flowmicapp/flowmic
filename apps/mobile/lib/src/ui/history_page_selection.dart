// Card NR-3 — the all-history page's multi-select toolbar, batch copy / delete
// and long-press menu, MOVED VERBATIM out of history_page.dart (card CR-12-G,
// 2026-09-23) because that file was at 753 lines and CR-12-G has to add the
// grouped search results to it. A `part` so the private state it reads
// (`_selection`, `_forgetDeleted`, `_toast`) stays private; no line below was
// edited, and every call site still reaches these by the same names.

part of 'history_page.dart';

extension _HistoryPageSelection on _HistoryPageState {
  // ── Card NR-3: multi-select + the long-press menu ──────────────────────────

  /// The multi-select toolbar. Same widget, same three actions as the chat
  /// page's — this page just supplies its own `selected` list and its own
  /// delete.
  ///
  /// ⚠️ 「Select all」 is passed the CURRENT list, which on this page is either
  /// the loaded pages or the search hits. That is the same promise the chat
  /// page's toolbar makes (「select everything I can currently see」) and it is
  /// the honest one here too: this page is paginated, so 「all of history」 is
  /// not something a toolbar button can deliver.
  Widget _selectionBar(
    BuildContext context,
    AppStrings s,
    List<TimelineEntry> entries,
  ) {
    final List<TimelineEntry> selected = visibleSelected<TimelineEntry>(
      entries,
      _selection,
      (TimelineEntry e) => e.id,
    );
    return SelectionBar(
      strings: s,
      selectedCount: selected.length,
      onCancel: _selection.exit,
      onSelectAll: () =>
          _selection.selectAll(entries.map((TimelineEntry e) => e.id)),
      onCopy: () => unawaited(_onBatchCopy(context, s, selected)),
      // 🔴 NO 「organize with AI」 BUTTON HERE AT ALL (owner 2026-08-30).
      //
      // What stood here passed a callback whose only effect was a toast saying
      // it could not be done, and argued that keeping the button was the
      // honest choice because 「withholding it would mean a toolbar whose shape
      // changes between two screens showing the same rows」.
      //
      // That is R8 with the sign flipped: a control that cannot change
      // anything is worse than no control, and this repo has paid for that
      // three times. The differing shape is not the cost — it is the signal,
      // and it is true: this page has no controller, so it cannot organize.
      // Copy and delete both work here, and both stay.
      onDelete: () => unawaited(_onBatchDelete(context, s, selected)),
    );
  }

  /// Batch copy — the SAME two pure functions the chat page dispatches to, so
  /// 「what N records amount to」 has one author on both screens.
  Future<void> _onBatchCopy(
    BuildContext context,
    AppStrings s,
    List<TimelineEntry> selected,
  ) async {
    // 🔴 REVERSED, because THIS page lists newest-first and only this page
    // knows that. `selectedRecords` sorts by `createdAt` and that is the rule;
    // what it cannot recover is a TIE — two rows minted in the same
    // millisecond have no time difference to sort on, so they keep the order
    // they arrived in, and arriving in screen order means arriving backwards
    // here. Handing them over chronologically is a fact about this list, not a
    // second copy of the ordering rule.
    // owner 2026-08-30: a recording in the batch copies its whole piece. The
    // members are read from STORAGE before composing (this page's loaded
    // window need not contain them — a search hit is one row), and handed to
    // the one composer as a lookup so it stays the sync function it is.
    final Map<String, List<TimelineEntry>> members =
        <String, List<TimelineEntry>>{};
    for (final TimelineEntry e in selected) {
      final String? id = e.isArticle ? e.articleId : null;
      if (id == null || members.containsKey(id)) continue;
      members[id] = await articleMembersOnDisk(widget.store, id);
    }
    final SelectedRecords records = selectedRecords(
      selected.reversed.toList(),
      membersOf: (String id) => members[id] ?? const <TimelineEntry>[],
    );
    final BatchCopyOutcome outcome = await runBatchCopy(records);
    if (!context.mounted) return;
    _toast(context, batchCopyResultText(outcome, records, s));
    if (outcome != BatchCopyOutcome.nothingToCopy) _selection.exit();
  }

  /// Batch delete — through [TimelineStore.deleteMany], i.e. the one deleter.
  /// The chat page's `_onBatchDeleteRouted` is the same sequence against the
  /// same store; the difference is only what each page has to refresh
  /// afterwards (`_pager.forget` there, [_forgetDeleted] here).
  Future<void> _onBatchDelete(
    BuildContext context,
    AppStrings s,
    List<TimelineEntry> selected,
  ) async {
    if (selected.isEmpty) {
      _toast(context, s.selectionDeleteNoSelection);
      return;
    }
    final bool sure = await confirmDestructive(
      context,
      title: s.selectionDeleteConfirmTitle(selected.length),
      message: batchDeleteConfirmBody(
        selected.length,
        imageRowsIn(selected),
        s,
      ),
      confirmLabel: s.confirmDelete,
      cancelLabel: s.cancel,
    );
    if (!sure || !context.mounted) return;
    final List<String> ids = selected
        .map((TimelineEntry e) => e.id)
        .toList(growable: false);
    final String note;
    try {
      note = batchDeleteResultText(await widget.store.deleteMany(selected), s);
    } catch (_) {
      if (context.mounted) _toast(context, s.selectionDeleteFailed);
      return;
    }
    _forgetDeleted(ids);
    _selection.exit();
    if (context.mounted) _toast(context, note);
  }

  /// The long-press menu. **The same sheet the chat page opens** — the ruling
  /// says not to fork a second menu, so this passes `sessionActions: false`
  /// and the four controller-bound rows simply do not render.
  Future<void> _onLongPress(
    BuildContext context,
    TimelineEntry entry,
    AppStrings s,
  ) async {
    final EntryAction? action = await showEntryContextMenu(
      context,
      entry,
      strings: s,
      sessionActions: false,
    );
    if (action == null || !context.mounted) return;
    switch (action) {
      case EntryAction.copy:
        // owner 2026-08-30: a recording's row copies its whole piece, each
        // segment with its range, from storage (see `_onBatchCopy`).
        final ImageCopyOutcome copied = await copyRowToClipboard(
          entry,
          membersOf: (String id) => articleMembersOnDisk(widget.store, id),
        );
        final String? note = s.imageCopyResult(copied);
        if (note == null || !context.mounted) return;
        _toast(context, note);
      case EntryAction.copyOriginal:
        // Copies the immutable `source_text`; silent on success, the same
        // posture as a plain text copy — identical to the chat page's arm.
        await copyEntrySourceText(entry);
      case EntryAction.select:
        _selection.enter(seed: entry.id);
      case EntryAction.delete:
        final bool sure = await confirmDestructive(
          context,
          title: s.deleteEntryConfirmTitle,
          message: s.deleteEntryConfirmBody,
          confirmLabel: s.confirmDelete,
          cancelLabel: s.cancel,
        );
        if (!sure) return;
        // 🔴 `deleteMany` with ONE row, deliberately, and NOT
        // `TimelineStore.delete`. That method resolves the id against the
        // store's loaded pages and returns silently when it is not there —
        // correct for the chat page, wrong here: a SEARCH hit comes straight
        // from storage and need never have been loaded, so the row the user
        // just long-pressed can be absent from `_entries`. It would have
        // vanished from the list and kept its bytes on disk, which is G-21
        // restored.
        try {
          await widget.store.deleteMany(<TimelineEntry>[entry]);
        } catch (_) {
          if (context.mounted) _toast(context, s.selectionDeleteFailed);
          return;
        }
        _forgetDeleted(<String>[entry.id]);
      case EntryAction.reInject:
      case EntryAction.retranslate:
      case EntryAction.reorganize:
      case EntryAction.edit:
      case EntryAction.favorite:
        // Structurally unreachable: `sessionActions: false` means the sheet
        // never renders these rows (four before NR-89 split re-run into
        // re-translate and re-organize), so it cannot return them. An assert
        // rather than a silent `break` — if someone re-enables a row here
        // without wiring it, this fails loudly in debug instead of becoming a
        // menu item that does nothing.
        assert(
          false,
          'the all-history page has no ChatController: $action was rendered '
          'without a receiver',
        );
    }
  }
}
