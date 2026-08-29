// SPEC-REF:
//   docs/decisions/2026-07-27-owner-0.2.0-request-batch.md requirement ④
//     ("all history" + instance attribution; V2-06b UI surface)
//   docs/rebuild/13-LESSONS-LEARNED.md §7 F2 (reporting something unfinished
//     as finished is forbidden — a page called "all history" that says not a
//     word about a 100-row on-disk cap is exactly that kind of lie)
//
// The "all history" page — every committed row on this phone across ALL
// instances (every paired PC + the cloud instance), newest first. Reached
// from the history icon on the connections page (left of the ⚙).
//
// The four hard requirements (requirement ④'s real check):
//   ① The attribution chip is a FIRST-CLASS citizen on every row — rendered as
//     the row's top line by ChatMessageTile.instanceChip, never inside a
//     detail view. With instances interleaved, an unlabelled row is unreadable.
//   ② A cloud row is labelled "cloud instance · record only"
//     (云端实例 · 仅记录) (AppStrings.cloudInstanceRow).
//     Speaking to a cloud instance has no inject target by construction, so
//     the row must SAY that — never left blank (reads as lost data), never
//     lent a PC name (a lie about where it went).
//   ③ A legacy row (spokenToInstanceId == null) is labelled "unknown instance"
//     (未知实例). It is
//     NEVER adopted into "whoever is connected right now" — that would make
//     history lie, the same red line requirement ③ drew for back-filling `now`.
//   ④ What this page ACTUALLY holds is stated in a pinned footnote.
//     It used to read "only the most recent 100 are kept" (仅保留最近 100 条),
//     which was true while the store was one
//     capped shared_preferences blob. V2-06a-2 moved the table to SQLite and
//     dropped the cap, so that sentence became an outdated lie and changed in
//     the same commit — and it is now CONDITIONAL: the footnote reports which
//     store is live, because a failed upgrade falls back to the capped blob and
//     saying "all history is on this device" (全部历史都在本机) then would be
//     the same red line, restored.
//
// The "injected window" provenance stays exactly as ChatMessageTile already
// renders it: pcName/injectTarget exist only on a row that truly landed, so
// noted and failed rows show no "→ window" leg. Empty is empty — nothing is
// back-filled to look respectable.

// ── Card NR-3 (owner ruling 2026-08-27 item 8) ──────────────────────────────
// This page was READ-ONLY: it handed ChatMessageTile no callbacks at all, so a
// long press did nothing and there was no way to remove a row from the one
// screen that shows every row. owner's ruling wires the chat page's existing
// interactions in here — the SAME long-press menu, the SAME EntrySelection, the
// SAME SelectionBar. Explicitly not a second menu and not a second delete path.
//
// 🔴 WHAT THIS PAGE HAS THAT THE CHAT PAGE DOES NOT, and why it changes two
// things:
//   ① It holds a [TimelineStore] and nothing else — no ChatController, no
//      session, no favourites. Four of the menu's eight actions therefore
//      cannot run here and are withheld by `sessionActions: false`
//      (entry_context_menu.dart argues that at the flag).
//   ② Its list is `_hits ?? store.entries`, and `_hits` is a SNAPSHOT taken
//      from storage by [TimelineStore.search]. The store's notification
//      refreshes `store.entries`; it cannot refresh a local snapshot ⇒ a
//      deleted row would keep rendering in a search result. [_forgetDeleted]
//      is the fix, and it is why every delete on this page routes through one
//      place.

import 'dart:async' show unawaited;
import 'dart:typed_data' show Uint8List;

import 'package:flutter/material.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_sqlite.dart' show TimelineStorageKind;
import '../timeline/timeline_store.dart';
import '../session/image_clipboard.dart'
    show ImageCopyOutcome, copyEntrySourceText, copyEntryToClipboard;
import 'chat_flow_toast.dart' show showChatToast;
import 'chat_message_tile.dart';
import 'confirm_dialog.dart';
import 'entry_context_menu.dart';
import 'image_preview_page.dart';
import 'selection/batch_actions.dart';
import 'selection/entry_selection.dart';
import 'selection/selection_bar.dart';
import 'tokens.dart';

class HistoryPage extends StatefulWidget {
  const HistoryPage({
    super.key,
    required this.store,
    required this.storageKind,
    this.appSettings,
  });

  final TimelineStore store;

  /// V2-06a-2 hard requirement ④: which store is LIVE. Required, not defaulted
  /// — a default of `sqlite` would render "all history is stored on this
  /// device" (全部历史都保存在本机) on a phone that had fallen
  /// back to the capped blob, which is exactly the lie the footnote exists to
  /// prevent.
  final TimelineStorageKind storageKind;

  /// Explicit locale source (same pattern as ChatFlowPage; null falls back to
  /// zh). Never the OS locale (CLAUDE.md red line).
  final AppSettingsController? appSettings;

  @override
  State<HistoryPage> createState() => _HistoryPageState();
}

class _HistoryPageState extends State<HistoryPage> {
  final TextEditingController _query = TextEditingController();
  final ScrollController _scroll = ScrollController();

  /// Non-null ⇔ a search is showing. Distinct from "the result is empty":
  /// null means the page is the ordinary timeline, `[]` means the user
  /// searched and there was genuinely nothing — two different sentences on screen.
  List<TimelineEntry>? _hits;

  /// Card NR-3 — the SAME multi-select state object the chat page uses, not a
  /// second one modelled on it. It stores ids only; see its class doc.
  final EntrySelection _selection = EntrySelection();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    _query.dispose();
    _selection.dispose();
    super.dispose();
  }

  void _toast(BuildContext context, String message) =>
      showChatToast(context, message);

  /// 🔴 The one place a delete's effect reaches this page's own list.
  ///
  /// The store notifies and `store.entries` is refreshed for free. `_hits` is
  /// not: it is a snapshot [TimelineStore.search] took from storage, and
  /// nothing will ever update it. Skip this and a deleted row keeps rendering
  /// inside a search result — a ghost row, i.e. the screen saying a record
  /// exists that does not.
  void _forgetDeleted(Iterable<String> ids) {
    final List<TimelineEntry>? hits = _hits;
    if (hits == null) return;
    final Set<String> gone = ids.toSet();
    setState(() {
      _hits = hits
          .where((TimelineEntry e) => !gone.contains(e.id))
          .toList(growable: false);
    });
  }

  /// Rows are newest-first top-to-bottom, so OLDER is downward: the trigger is
  /// approaching the bottom. (The chat page's list is reversed, and there the
  /// same "towards older" direction is upward — same intent, opposite edge.)
  void _onScroll() {
    if (_hits != null) return; // a search result set is not paged
    if (!_scroll.hasClients) return;
    final double remaining =
        _scroll.position.maxScrollExtent - _scroll.position.pixels;
    // One screen of slack so the next page is already there when the user
    // arrives, rather than a visible stall at the boundary.
    if (remaining < 600) unawaited(widget.store.loadMore());
  }

  Future<void> _runSearch(String raw) async {
    final String q = raw.trim();
    if (q.isEmpty) {
      setState(() => _hits = null);
      return;
    }
    // Straight to storage — see TimelineStore.search. Filtering the loaded
    // page would find less the less the user has scrolled.
    final List<TimelineEntry> found = await widget.store.search(q);
    if (!mounted) return;
    setState(() => _hits = found);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: FlowMicColors.canvas,
      body: SafeArea(
        child: ListenableBuilder(
          // Card NR-3 adds `_selection`: entering/leaving the mode and every
          // tick has to repaint this page, and merging it here is the same
          // wiring the chat page uses rather than a `setState` sprinkled
          // through the handlers.
          listenable: Listenable.merge(
            <Listenable>[widget.store, ?widget.appSettings, _selection],
          ),
          builder: (BuildContext context, _) {
            final AppStrings s = AppStrings.of(
              widget.appSettings?.locale ?? AppLocale.zh,
            );
            // The ordinary view is the loaded PAGES of the whole table,
            // newest-first — all PC instances + cloud + ownerless legacy rows,
            // which is what "all history" means. A search replaces the list with
            // hits from storage, so it can reach rows never scrolled to.
            final List<TimelineEntry> entries = _hits ?? widget.store.entries;
            final bool searching = _hits != null;
            return Column(
              children: <Widget>[
                _header(context, s),
                // Card NR-3 — directly under the header, exactly where the chat
                // page docks it, and present only in the mode.
                if (_selection.active) _selectionBar(context, s, entries),
                _searchField(s),
                Expanded(
                  child: entries.isEmpty
                      ? Center(
                          child: Text(
                            // "no matches found" and "no history" are different
                            // facts. Showing the second for the first reads as
                            // "the records are gone".
                            searching ? s.historySearchNoHit : s.historyEmpty,
                            style: TextStyle(
                              color: FlowMicColors.t3,
                              fontSize: 12.5,
                            ),
                          ),
                        )
                      : ListView.separated(
                          key: const ValueKey<String>('history.timeline'),
                          controller: _scroll,
                          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
                          // +1 for the tail row (loading / end-of-list), except
                          // while searching — a result set has no more pages.
                          itemCount: entries.length + (searching ? 0 : 1),
                          separatorBuilder: (BuildContext context, int index) =>
                              const SizedBox(height: 10),
                          itemBuilder: (BuildContext context, int i) {
                            if (i >= entries.length) return _tail(s);
                            final TimelineEntry entry = entries[i];
                            return ChatMessageTile(
                              entry: entry,
                              strings: s,
                              instanceChip: _attributionChip(s, entry),
                              // ⚠️ Window B3-2b — BOTH FALSE, AND ONE OF THEM IS A
                              // KNOWN GAP RATHER THAN A FACT.
                              //
                              // `canResendImage: false` costs nothing and is
                              // exact: this page passes no `onRetry`, so no
                              // resend affordance can render on any row here.
                              //
                              // `queued: false` is the gap. This page shows
                              // EVERY instance's rows and holds only a
                              // TimelineStore — it has no DeliveryOutbox, and
                              // rows belonging to another pairing have no queue
                              // item on this device at all. So a row whose
                              // delivery really is still queued reads "delivering"
                              // (投递中) here while the chat page reads "queued" (排队中).
                              //
                              // Said out loud rather than papered over: this is
                              // the pre-0.2.33 behaviour, not a regression, and
                              // it is logged as a gap (docs/rebuild/15 §6).
                              // Closing it means threading the queue into this
                              // page, which is a different card.
                              queued: false,
                              canResendImage: false,
                              // 🔴 Card NR-3 — the three gestures, decided in
                              // ONE place gated on `_selection.active` a single
                              // time. The whole argument for each of the three
                              // (single tap toggles / long-press and zoom go
                              // null in the mode) is in
                              // `chat_flow_selection.dart`'s file header; this
                              // page follows it verbatim rather than restating
                              // it, because a second copy of that reasoning is
                              // a second place for it to drift.
                              // 🔴 Card NR-3 — the three gestures, decided in
                              // ONE place gated on `_selection.active` a single
                              // time. The whole argument for each of the three
                              // (single tap toggles / long-press and zoom go
                              // null in the mode) is in
                              // `chat_flow_selection.dart`'s file header; this
                              // page follows it verbatim rather than restating
                              // it, because a second copy of that reasoning is
                              // a second place for it to drift.
                              selected: _selection.contains(entry.id),
                              onSelectToggle: _selection.active
                                  ? () => _selection.toggle(entry.id)
                                  : null,
                              onLongPress: _selection.active
                                  ? null
                                  : (TimelineEntry e) => unawaited(
                                      _onLongPress(context, e, s),
                                    ),
                              onZoom: _selection.active
                                  ? null
                                  : (TimelineEntry e, Uint8List thumb) =>
                                        Navigator.of(context).push(
                                          ImagePreviewPage.route(
                                            png: thumb,
                                            caption: e.displayText,
                                            closeHint: s.imageZoomClose,
                                            previewOnlyNote: s.imagePreviewNote,
                                            // 🔴 No `full:`, and that is a fact
                                            // rather than an omission. The
                                            // delivered bytes live in
                                            // `ChatController.rowImages`, which
                                            // this page does not have. Null is
                                            // the documented 「this host offers
                                            // no big picture」 value and it is
                                            // what makes `previewOnlyNote`
                                            // render — so the preview SAYS it
                                            // is a 256 px preview instead of
                                            // passing itself off as the
                                            // original.
                                          ),
                                        ),
                            );
                          },
                        ),
                ),
                _capFootnote(s),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _searchField(AppStrings s) => Padding(
    padding: const EdgeInsets.fromLTRB(14, 10, 14, 0),
    child: Row(
      children: <Widget>[
        Expanded(
          child: SizedBox(
            height: 38,
            child: TextField(
              key: const ValueKey<String>('history.search'),
              controller: _query,
              onChanged: _runSearch,
              style: TextStyle(color: FlowMicColors.t1, fontSize: 13),
              decoration: InputDecoration(
                isDense: true,
                hintText: s.historySearchHint,
                hintStyle: TextStyle(color: FlowMicColors.t3, fontSize: 13),
                prefixIcon: Icon(
                  Icons.search,
                  size: 16,
                  color: FlowMicColors.t3,
                ),
                filled: true,
                fillColor: FlowMicColors.surface,
                contentPadding: const EdgeInsets.symmetric(vertical: 8),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(color: FlowMicColors.line),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(color: FlowMicColors.line),
                ),
              ),
            ),
          ),
        ),
        if (_hits != null) ...<Widget>[
          const SizedBox(width: 8),
          // The count is the whole table's truth, not "the number of hits
          // among what's already loaded".
          Text(
            s.historySearchHits(_hits!.length),
            style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5),
          ),
          InkWell(
            key: const ValueKey<String>('history.search.clear'),
            onTap: () {
              _query.clear();
              setState(() => _hits = null);
            },
            borderRadius: BorderRadius.circular(10),
            child: SizedBox(
              width: 40,
              height: 40,
              child: Center(
                child: Icon(
                  Icons.close,
                  size: 16,
                  color: FlowMicColors.t2,
                  semanticLabel: s.historySearchClear,
                ),
              ),
            ),
          ),
        ],
      ],
    ),
  );

  /// The row after the last entry. It SAYS which of the two states it is in —
  /// "still fetching" (还在取) and "nothing older" (没有更早的了) look identical
  /// as blank space, and a user reads
  /// the second as the first and waits forever.
  Widget _tail(AppStrings s) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 14),
    child: Center(
      child: Text(
        widget.store.loadingMore
            ? s.historyLoadingMore
            : widget.store.hasMore
            ? ''
            : s.historyReachedEnd,
        style: TextStyle(color: FlowMicColors.t3, fontSize: 11.5),
      ),
    ),
  );

  Widget _header(BuildContext context, AppStrings s) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 14),
    height: 50,
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: FlowMicColors.line)),
    ),
    child: Row(
      children: <Widget>[
        InkWell(
          key: const ValueKey<String>('history.back'),
          // Card NR-3: in multi-select the back affordance leaves the MODE,
          // not the page — the chat page's `_attemptBack` does the same, and
          // for the same reason: a user who ticked twenty rows and wanted out
          // of the mode should not lose the page as well.
          // ⚠️ The system back gesture is deliberately NOT intercepted here.
          // It pops the page, and the selection dies with it — no state
          // survives to be wrong about. Claiming otherwise would need a
          // PopScope this card has no evidence anyone wants.
          onTap: () => _selection.active
              ? _selection.exit()
              : Navigator.of(context).pop(),
          borderRadius: BorderRadius.circular(10),
          // ≥40dp tap target, icon stays 16 (V2-04 contract).
          child: SizedBox(
            width: 40,
            height: 40,
            child: Center(
              child: Icon(
                Icons.arrow_back_ios_new,
                size: 16,
                color: FlowMicColors.t2,
              ),
            ),
          ),
        ),
        const SizedBox(width: 2),
        Text(
          s.historyTitle,
          style: TextStyle(
            color: FlowMicColors.t1,
            fontSize: 16,
            fontWeight: FontWeight.w700,
          ),
        ),
      ],
    ),
  );

  /// Hard requirement ④ — pinned so it is visible even at the full 100 rows (a
  /// footnote
  /// that only appears after scrolling to the oldest row would be the quiet
  /// kind of disclosure). Small type, always there.
  Widget _capFootnote(AppStrings s) => Container(
    width: double.infinity,
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
    decoration: BoxDecoration(
      color: FlowMicColors.surface,
      border: Border(top: BorderSide(color: FlowMicColors.line)),
    ),
    child: Text(
      // Reports the store that is ACTUALLY live — see the class doc on
      // [storageKind]. There is no third branch and no default.
      switch (widget.storageKind) {
        TimelineStorageKind.sqlite => s.historyAllPersisted,
        TimelineStorageKind.sharedPrefsFallback => s.historyFallbackNote,
      },
      textAlign: TextAlign.center,
      style: TextStyle(
        // The fallback line is a fault report, not a caption — it gets the
        // amber the rest of the app uses for "something didn't get done" (有事没做成).
        color: widget.storageKind == TimelineStorageKind.sharedPrefsFallback
            ? FlowMicColors.amber
            : FlowMicColors.t3,
        fontSize: 11,
      ),
    ),
  );

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
      // 🔴 No 「organize with AI」 receiver on this page, and the button is
      // still there. The refusal is the truth: organize runs through
      // `ChatController.startAiCompose`, and this page has no controller — so
      // it answers with the same 「not connected」 sentence the chat page uses
      // when the link is down, rather than a dead cell that swallows the tap
      // (0.2.27). Withholding the button instead would mean a toolbar whose
      // shape changes between two screens showing the same rows.
      onOrganize: () => _toast(context, s.selectionOrganizeOffline),
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
    final SelectedRecords records = selectedRecords(selected);
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
        final ImageCopyOutcome copied = await copyEntryToClipboard(entry);
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
      case EntryAction.reprocess:
      case EntryAction.edit:
      case EntryAction.favorite:
        // Structurally unreachable: `sessionActions: false` means the sheet
        // never renders these four rows, so it cannot return them. An assert
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

  /// The row's attribution chip (hard requirements ①②③). Precedence is deliberate:
  /// `origin == 'cloud'` is answered FIRST because a pre-V2-06a cloud row can
  /// ALSO have a null owner — and "cloud instance · record only"
  /// (云端实例 · 仅记录) is still the truth about
  /// it, while "unknown instance" (未知实例) would suggest a pairing we simply
  /// failed to record.
  Widget _attributionChip(AppStrings s, TimelineEntry entry) {
    if (entry.origin == 'cloud') {
      return _chip(
        Icons.cloud_outlined,
        s.cloudInstanceRow,
        FlowMicColors.brand,
        FlowMicColors.brandSoft,
      );
    }
    final String? ownerId = entry.spokenToInstanceId;
    if (ownerId == null) {
      // Legacy row: nobody knows which instance heard this, and the chip says
      // so. It must NOT be attributed to the currently-connected instance.
      return _chip(
        Icons.help_outline,
        s.unknownInstance,
        FlowMicColors.t3,
        FlowMicColors.surface2,
      );
    }
    // The name snapshot taken at birth (rename-proof, swipe-away-proof). A row
    // CAN carry an owner id with no name (a resumed pairing whose pc_name has
    // not arrived yet); the id itself is an opaque token-bearing string that
    // must never hit the screen, so the honest user-facing answer is the same
    // "unknown instance" (未知实例) — we cannot name who this was said to.
    final String? name = entry.spokenToInstanceName;
    return _chip(
      Icons.computer,
      (name != null && name.isNotEmpty) ? name : s.unknownInstance,
      FlowMicColors.teal,
      FlowMicColors.tealSoft,
    );
  }

  Widget _chip(IconData icon, String label, Color fg, Color bg) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      color: bg,
      borderRadius: BorderRadius.circular(99),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: 11, color: fg),
        const SizedBox(width: 4),
        // A long PC name ellipsizes INSIDE the chip; the chip itself never
        // pushes the row wider than the card.
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: fg,
              fontSize: 10,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}
