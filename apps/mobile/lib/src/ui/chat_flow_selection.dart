// Card FB-7 — the selection-mode half that lives on this page: the toolbar +
// the dispatch for the two batch actions.
//
// owner, verbatim: 「现在的记录要延伸：手机上可多选，多选之后可批量复制，也可以
// 多选之后统一交给 AI 整理成新的东西 —— 这个蛮重要。」 ("the recording feature
// needs to be extended: the phone should support multi-select, after which you
// can batch-copy, and you can also hand a multi-selection off together to the
// AI to organize into something new — this is fairly important.")
//
// None of the judgment lives here: WHAT is ticked lives in
// `selection/entry_selection.dart`; what text a batch amounts to, and which
// action is not allowed to run, lives in `selection/batch_actions.dart` (pure
// functions, unit-testable outside the page). This file's only job is to wire
// them up to the real controller and the real toast.
//
// ── 🔴 The single most dangerous thing riding on this card ──────────────────
// 「Hand it to the AI to organize」 must go through the **controlled
// pipeline** (`ChatController.startAiCompose` → `AiComposeController.start` →
// `ComposeGate.emitAiCompose`) — never a second, unvalidated path invented
// for batch. And that pipeline **accepts exactly one input**: `aiBuffer`,
// i.e. `ChatController._buffer` — the **very same** buffer the user is typing
// into, and the one the manual-policy voice finals are accumulating into. ⇒
// handing batch content in necessarily means writing that box. The six gates
// that run before that write all live in `checkBatchOrganize`, whose
// documentation spells out exactly why each one is there (especially the two
// content-safety ones, `bufferBusy` and `speechInFlight`).
//
// ⚠️ What this card does **NOT** do: auto-deliver the organized result, write
// it back onto the timeline, or turn it into a "note". The result lands in
// the input box and the user decides whether to send it — the same contract
// as `ai_action_row.dart`'s standing sentence 「作用于缓冲 · 不注入」 ("acts on
// the buffer · does not inject"); this card has not touched a single word of
// it.
//
// ── 🔴 Reassigning three gestures under selection mode (the argument lives
//    here; the page keeps only one pointer to it) ────────────────────────────
// `chat_flow_page.dart`'s `itemBuilder` decides all three parameters —
// `onSelectToggle` / `onLongPress` / `onZoom` — **in one place**, gated on
// `_selection.active` a single time, rather than as three independently
// written conditions — three conditions would give three different answers
// to 「what mode is this right now」, which is exactly this repo's #1 bug
// shape. The reasoning for each of the three:
//   ① **single tap → toggle-select**: `chat_message_tile.dart` writes, right
//      next to the picture double-tap preview, 「a single tap must stay free
//      for the row itself」. It has always been empty; selection mode is a
//      mode the user **explicitly enters**, and it is given back on exit, so
//      that promise is not broken.
//   ② **long-press → null**: long-press is already the entry point for the
//      context menu. Leave it wired, and the user trying to tick a row
//      instead pops up a menu; and that menu's deferred-delivery/delete
//      actions **act on one row**, which contradicts the mode they are
//      currently standing in.
//   ③ **double-tap-to-zoom → null**: a full-screen jump would interrupt
//      selecting; more concretely, it would eat the second tap of 「quickly
//      tap twice to tick then untick」.
// ⚠️ `ChatMessageTile` itself does **NOT enforce** that these three agree
//    (one tile cannot govern its host's argument table, and pretending it
//    can would be a comment asserting another place's behavior = anti-façade
//    ④). Enforced by a test instead: `selection_wire_test.dart` asserts the
//    production page really does hand over two nulls in selection mode.

part of 'chat_flow_page.dart';

/// The rows in this list that are **actually still here**, AND ticked.
///
/// Computed as an intersection on the spot every time, never cached: once a
/// row is deleted elsewhere (full history / range clear), the count must drop
/// by one IMMEDIATELY, otherwise 「已选 3 条」 ("3 selected") would be
/// speaking for a record that no longer exists (R11: a status word must be
/// able to answer 「凭什么这么说」 — "what grounds do you have for saying
/// that").
List<TimelineEntry> _visibleSelectedRouted(
  _ChatFlowPageState s,
  List<TimelineEntry> entries,
) => visibleSelected<TimelineEntry>(
  entries,
  s._selection,
  (TimelineEntry e) => e.id,
);

Widget _selectionBarRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
  List<TimelineEntry> entries,
) {
  final List<TimelineEntry> selected = _visibleSelectedRouted(s, entries);
  return SelectionBar(
    strings: strings,
    selectedCount: selected.length,
    onCancel: s._selection.exit,
    // 「Select all」 = everything this list currently has. It does NOT reach
    // into earlier pages: the word on the toolbar answers 「select everything
    // I can currently see」, and this page is a paginated window to begin
    // with.
    onSelectAll: () => s._selection.selectAll(
      entries.map((TimelineEntry e) => e.id),
    ),
    onCopy: () => unawaited(_onBatchCopyRouted(s, context, strings, selected)),
    onOrganize: () => _onBatchOrganizeRouted(s, context, strings, selected),
  );
}

/// Batch copy.
///
/// 🔴 The result sentence and what actually lands on the clipboard are **two
/// halves of the SAME computation** (`runBatchCopy` and `batchCopyResultText`
/// share the same [SelectedRecords]), so the N in 「已复制 N 条」 ("N copied")
/// can never disagree with the count actually on the clipboard — that is
/// exactly the shape of `image_clipboard.dart`'s file-header rule 「never
/// swallow, never overclaim」, applied to the batch surface.
Future<void> _onBatchCopyRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
  List<TimelineEntry> selected,
) async {
  final SelectedRecords records = selectedRecords(selected);
  final BatchCopyOutcome outcome = await runBatchCopy(records);
  if (!context.mounted) return;
  s._toast(context, batchCopyResultText(outcome, records, strings));
  // Not a single character got copied ⇒ stay in selection mode, the user can
  // just adjust the selection; only a real copy exits it.
  if (outcome != BatchCopyOutcome.nothingToCopy) s._selection.exit();
}

/// Hand off to the AI to organize.
///
/// 🔴 **NOT A SINGLE `await` is permitted between [checkBatchOrganize]'s
/// return and `startAiCompose`.** This is not a style choice:
/// `AiComposeController.start` returns **null** while `isRunning` (＝
/// "success"), and it is only safe because the caller has already checked
/// `isRunning` first. Inserting an await in between opens a window for
/// another compose run to start, and we would then **overwrite ITS buffer**
/// and read a null back as though 「it started running」. This function is
/// therefore synchronous (`_onBatchCopyRouted` is async; this one
/// deliberately is not).
void _onBatchOrganizeRouted(
  _ChatFlowPageState s,
  BuildContext context,
  AppStrings strings,
  List<TimelineEntry> selected,
) {
  final SelectedRecords records = selectedRecords(selected);
  final BatchOrganizeRefusal? refusal = checkBatchOrganize(
    records: records,
    selectedCount: selected.length,
    // ⚠️ `canCompose`, **NOT** `canAiCompose`: the latter requires the buffer
    // to be non-empty, which is exactly the thing THIS site requires it to
    // be — empty ⇒ using it as the precondition would make this button
    // refuse forever. The full reasoning lives in `checkBatchOrganize`'s doc
    // comment and is grep-falsifiable.
    canCompose: s.controller.canCompose,
    isAiComposing: s.controller.isAiComposing,
    // Speaking / transcribing both count as 「in flight」: under the manual
    // policy a final gets folded into this same buffer, and the moment
    // organize finishes it does a wholesale replace ⇒ the sentence just
    // finished speaking would get wiped out.
    speechInFlight:
        s.controller.isRecording ||
        s.controller.sessionState == SessionState.processing,
    buffer: s.controller.buffer,
  );
  if (refusal != null) {
    // 🔴 A refusal must always be spoken out loud, never a silent nothing-
    // happened (the 0.2.27 precedent: 「一个改变不了任何东西的控件比没有控件
    // 更坏」 — "a control that changes nothing is worse than no control at
    // all"). Stays in selection mode: once the user fixes the condition,
    // pressing again in place just works; exiting would throw away the batch
    // they just ticked.
    s._toast(context, batchOrganizeRefusalText(refusal, strings));
    return;
  }
  // Cleared the gate ⇒ the buffer is empty right now (`bufferBusy` is
  // exactly that check), so this write cannot overwrite anything.
  s.controller.setBuffer(records.text);
  final AiComposeFailure? failed = s.controller.startAiCompose(
    ComposeTask.organize,
  );
  // Whether it started running or not, the text is already in the input box
  // ⇒ exit selection mode so the user can see it.
  s._selection.exit();
  if (failed != null) {
    // **WHY** it failed is already spoken by the existing AI-failure banner
    // (`chat_banner_sources.dart`'s `aiFailure:` line → `AppStrings
    // .aiComposeError`). This one only answers 「where did those words go」
    // — one fact, one exit, not said twice in two places.
    // ⚠️ Deliberately does **NOT** roll back the text just written in: it is
    // not garbage, it is the batch of records the user selected — rolling it
    // back would be deleting something on the user's behalf that they never
    // asked to have deleted.
    s._toast(context, strings.selectionOrganizeNotStarted);
    return;
  }
  s._toast(context, batchOrganizeStartedText(records, strings));
}
