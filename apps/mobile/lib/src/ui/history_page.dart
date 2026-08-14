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

import 'dart:async' show unawaited;

import 'package:flutter/material.dart';

import '../settings/app_settings.dart';
import '../settings/app_strings.dart';
import '../timeline/timeline_entry.dart';
import '../timeline/timeline_sqlite.dart' show TimelineStorageKind;
import '../timeline/timeline_store.dart';
import 'chat_message_tile.dart';
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
    super.dispose();
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
          listenable: Listenable.merge(
            <Listenable>[widget.store, ?widget.appSettings],
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
          onTap: () => Navigator.of(context).pop(),
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
