// The timeline scroll — the one thing this screen is for.
//
// ── WHY THIS SPLIT ───────────────────────────────────────────────────────
// Same reason and same shape as chat_flow_exits.dart / chat_flow_composer.dart
// / chat_flow_entry_actions.dart / chat_flow_selection.dart /
// chat_flow_pager_sync.dart: `chat_flow_page.dart` stood at 796/800 against
// `verify/lint/file-size.mjs` SRC_MAX, and the repo's standing move at that cap
// is a STRUCTURAL SPLIT, never deleting the evidence in the comments (CLAUDE.md,
// 0.2.52: 「按仓里成例做结构拆分而不是删证据」("split structurally per the repo's
// precedent rather than deleting evidence")).
//
// 🔴 DIFF DISCIPLINE: the body below is the previous `_scroll` moved VERBATIM —
// not one comment reflowed, not one identifier renamed, and **not even a `s.`
// prefix**. Unlike the five part files listed above it is NOT a
// `_xxxRouted(_ChatFlowPageState s)` top-level: it is still an instance member,
// reached through a private extension on the state (the shape
// compose_buffer_row.dart uses on `_ComposeBandState`, and ptt_wire_keepalive
// .dart on `PttSession`). That buys the one property the Routed shape cannot:
// the moved text is byte-for-byte identical, so the diff has nothing in it to
// audit, and `build()`'s `_scroll(context, strings, iid, entries)` needed no
// delegator. **Any difference at all in the diff is a bug.**
//
// ⚠️ WHAT DELIBERATELY DID NOT COME WITH IT. `_onScrollOffset` stays on the
// state and is NOT an extension member, because it is torn off twice — once
// into `addListener` in `initState`, once into `removeListener` in `dispose`.
// Instance-method tear-offs of the same receiver are canonicalised and compare
// equal; EXTENSION-method tear-offs are not, so moving it here would hand
// `removeListener` a closure that never matches the one that was added, and the
// listener would outlive the page. `_scrollToBottom` and `_maybeLoadOlder` stay
// for the milder version of the same rule — they are the state's own members and
// the body below simply calls them, which a `part` may do.

part of 'chat_flow_page.dart';

extension _ChatFlowScroll on _ChatFlowPageState {
  // ── scroll ─────────────────────────────────────────────────────────────
  // TimelineStore stays newest-first (insert(0) + createdAt desc). reverse:true
  // paints index 0 at the visual BOTTOM — live draft + newest commits sit there,
  // offset==0 is stick-to-bottom for free (no animateTo on insert). 「回到底部」
  // ("back to bottom")
  // is animateTo(0) only when the user has scrolled away.
  //
  // V2-06b (Requirement ④): ONE instance's view, narrowed on the BIRTH-time owner
  // (spokenToInstanceId) — never pcName, which would drop noted/failed rows
  // (see the field's doc in timeline_entry.dart). Null identity ⇒ none of
  // anyone's history; legacy rows live only on the full-history page.
  //
  // Card FB-7: [iid] and [entries] are now computed by the CALLER (`build`) and
  // handed in, because the selection bar needs the same list. Nothing about the
  // derivation changed — the three lines that stood here moved up verbatim; see
  // the comment at the hoist for why one derivation and not two.
  Widget _scroll(
    BuildContext context,
    AppStrings strings,
    String? iid,
    List<TimelineEntry> entries,
  ) {
    final bool live = controller.hasLiveDraft;
    final int liveCount = live ? 1 : 0;
    final Set<String> skippedIds = controller.polishSkippedEntryIds;
    return Stack(
      children: <Widget>[
        if (iid == null)
          chatNoInstanceFace(strings)
        // 🔴 Card U4 — 「还没加载完」("hasn't finished loading") is NOT 「还没有
        // 历史」("there's no history yet"), and neither is either of
        // them 「没连着实例」("not connected to an instance"). Three states,
        // three faces; see
        // `chat_timeline_faces.dart` for why they must stay apart.
        else if (entries.isEmpty && !live && !_pager.firstLoadComplete)
          chatHistoryLoadingFace(strings)
        else if (entries.isEmpty && !live)
          chatHistoryEmptyFace(strings)
        else
          ListView.separated(
            key: const ValueKey<String>('chat.timeline'),
            controller: _scrollCtl,
            reverse: true,
            // Padding flipped with reverse so edge insets stay visual top/bottom.
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
            itemCount: entries.length + liveCount,
            separatorBuilder: (BuildContext context, int index) =>
                const SizedBox(height: 10),
            itemBuilder: (BuildContext context, int i) {
              if (live && i == 0) {
                return LiveDraftTile(
                  text: controller.liveText,
                  mode: controller.mode,
                  strings: strings,
                  // §4b-8 duration half — the SAME real elapsed-since-audio:start
                  // clock RecordingPanel renders above (`_recordingPanel`),
                  // read off the controller's public getter only (see
                  // LiveDraftTile's own doc for why it stays truthful through
                  // `processing`, not just `recording`).
                  elapsed: controller.recordingElapsed,
                );
              }
              final TimelineEntry entry = entries[i - liveCount];
              return ChatMessageTile(
                entry: entry,
                strings: strings,
                // window B3-2b: 「这一行的投递还躺在队列里、一个字节都没上过路吗」
                // ("is this row's delivery still sitting in the queue, not a
                // single byte having gone out").
                // Read off the queue, never inferred from the row — the row
                // genuinely cannot tell 「在等 PC 回话」("waiting for the PC to
                // answer") from 「还没发出去」("hasn't been sent out yet"), which
                // is why it used to say delivering for both.
                queued: controller.queuedEntryIds.contains(entry.id),
                // 🔴 owner two-segment model / R8: the picture's resend affordance exists
                // IFF its compressed copy is still on disk. Same read, one
                // source — the queue is the only thing that knows.
                canResendImage:
                    controller.resendableImageEntryIds.contains(entry.id),
                polishSkippedLabel: skippedIds.contains(entry.id)
                    ? strings.polishSkipped
                    : null,
                // F-5 exact match — the same text the panel would send.
                isFavorite: controller.favorites.contains(entry.displayText),
                // 🔴 Card FB-7 — under multi-select mode, three gestures are
                // decided **in one place** here (single-tap takes over,
                // long-press and double-tap hand back null). Each of the
                // three's reasoning and 「why not three independent
                // conditions」 are in chat_flow_selection.dart's file header.
                selected: _selection.contains(entry.id),
                onSelectToggle: _selection.active
                    ? () => _selection.toggle(entry.id)
                    : null,
                onLongPress: _selection.active
                    ? null
                    : (TimelineEntry e) => _onLongPress(context, e, strings),
                // M2: the un-landed row's inline resend. window B3-2b routes it
                // through `resendEntry`, which dispatches on the row's KIND: a
                // text row gets `reInject` (a NEW delivery — new request_id, new
                // PC row, RV-72), a picture gets `resendImage` (the SAME queued
                // delivery, tried now). Merging them would either type a
                // picture's descriptor into the document or paste the picture
                // twice. The tile still gates WHEN the affordance shows.
                onRetry: controller.resendEntry,
                // owner 2026-07-27 double-tap full-screen preview + RV-93 two sizes: the row's 256 px
                // thumbnail paints instantly, and the DELIVERED picture replaces
                // it when the disk read returns. The future is started here, in
                // the tap handler, so exactly one read happens per opening —
                // starting it in the viewer's `build` would restart it on every
                // rebuild (and flicker between the two sizes).
                // Card FB-7: null in selection mode — see the block above.
                onZoom: _selection.active
                    ? null
                    : (TimelineEntry e, Uint8List thumb) =>
                    Navigator.of(context).push(
                      ImagePreviewPage.route(
                        png: thumb,
                        caption: e.displayText,
                        closeHint: strings.imageZoomClose,
                        previewOnlyNote: strings.imagePreviewNote,
                        full: rowImageBytes(controller.rowImages, e),
                      ),
                    ),
              );
            },
          ),
        if (_showBackToBottom)
          Positioned(
            right: 12,
            bottom: 12,
            child: Tooltip(
              message: strings.backToBottom,
              child: Material(
                color: FlowMicColors.surface2,
                elevation: 2,
                shape: CircleBorder(
                  side: BorderSide(color: FlowMicColors.line),
                ),
                child: InkWell(
                  key: const ValueKey<String>('chat.backToBottom'),
                  customBorder: const CircleBorder(),
                  onTap: _scrollToBottom,
                  child: Padding(
                    padding: const EdgeInsets.all(10),
                    child: Icon(
                      Icons.keyboard_arrow_down,
                      size: 22,
                      color: FlowMicColors.t1,
                      semanticLabel: strings.backToBottom,
                    ),
                  ),
                ),
              ),
            ),
          ),
        // PA-4: the floating edit card and the expanded compose face that
        // used to close this Stack are GONE — the ONE edit surface is the
        // page-level sheet (chat_flow_edit_sheet.dart), mounted in `build`'s
        // outer Stack so it can cover the dock and PTT bar too (§4 A6).
      ],
    );
  }
}
