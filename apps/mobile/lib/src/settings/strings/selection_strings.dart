// AppStrings copy catalogue shard: record multi-select / batch copy / hand
// off to AI organize (FB-7).
//
// SPEC-REF:
//   docs/decisions/2026-08-06-owner-feedback-batch-fb1-12.md FB-7
//
// The sole external entry point is still ../app_strings.dart. Since 0.2.67 the
// copy leaves `_lf…` are implemented by generated classes under l10n/.
//
// 🔴 Why this is not placed in compose_strings.dart — that would be the most
// natural home for 「hand off to AI organize」,
// but it **is occupied by the parallel window W4S** (registering two new
// error codes this round). This is not a design judgement, it is a
// scheduling constraint, written here so the next person does not mistake it
// for a domain-split ruling. Can be merged once both windows are wrapped up.
//
// ⚠️ The 「hand off to AI organize」 action itself must go through the
//    **controlled pipeline of organize mode**
//    (`ChatController.startAiCompose`), bound by the same precision-control
//    constraint as FB-5;
//    never open a second, unvalidated path for batch. This shard is only
//    responsible for its **words**, not its **path**.
//
// 🔴 **This shard deliberately takes NO enum parameter at all**, the opposite
// of the `imageCopyResult(ImageCopyOutcome)` precedent, for a reason that is
// mechanical and checkable: a `part` file **cannot have its own import**,
// and taking an enum would mean adding an import line to the top of
// `app_strings.dart` — and **this window has that file frozen**
// (four parallel lanes share it as the single aggregation point, see that
// file's W5a scaffold section).
// ⇒ The enum → sentence mapping lives in `ui/selection/batch_actions.dart`
// (which can import), where the `switch` is equally **exhaustive** — missing
// a branch still fails to compile — so the same guarantee is preserved, just
// moved one layer over. Can be moved back once both windows are wrapped up.
part of '../app_strings.dart';

mixin SelectionStrings on AppStringsLeaves {

  /// Exit multi-select mode.
  String get selectionCancel =>
      _lfSelectionCancel;

  // ── Enter multi-select (the item in the long-press menu) ──────────────────
  /// 🔴 The entry point is deliberately hung off **the EXISTING long-press
  /// menu**, rather than inventing a new gesture: long-press on this list is
  /// already claimed by the context menu (`chat_message_tile` →
  /// `showEntryContextMenu`),
  /// while a single tap **is free** and `chat_message_tile.dart` says right
  /// there「a single tap must
  /// stay free for the row itself」— so 「enter mode via the menu, tap to
  /// select once in the mode」
  /// needs no new gesture invented at all. The reasoning and its source are
  /// in `ui/selection/entry_selection.dart`.
  String get selectionEnter =>
      _lfSelectionEnter;

  /// The subtitle: spells out what you can do once inside, otherwise 「multi-
  /// select」 is a word nobody knows why they'd tap.
  String get selectionEnterSub => _lfSelectionEnterSub;

  // ── The multi-select toolbar ────────────────────────────────────────────
  /// The selected-count. ⚠️ This number **only counts rows that genuinely
  /// still exist in the current list** (see
  /// `EntrySelection`'s docs): after a row is deleted elsewhere it must
  /// immediately drop by one,
  /// otherwise 「3 selected」 would be speaking for a record that no longer
  /// exists.
  String selectionCount(int n) => _lfSelectionCount(n);

  String get selectionSelectAll =>
      _lfSelectionSelectAll;

  String get selectionCopy =>
      _lfSelectionCopy;

  /// 🔴 The button pins the scope down up front: a picture row has no text
  /// body, so batch copy **only carries text away**.
  /// Saying it before the press beats explaining it after — this is the same
  /// sentence as `image_clipboard.dart`'s file-header rule
  /// 「never swallow, never overclaim」, on the batch face.
  String get selectionCopySub =>
      _lfSelectionCopySub;

  String get selectionOrganize =>
      _lfSelectionOrganize;

  /// 🔴 A standing subtitle, copying `ai_action_row.dart`'s existing
  /// argument 「acts on the buffer · does not inject」: 「the AI sent it out」
  /// must never be a reasonable reading of this button. It matters even more
  /// here than there
  /// — the records the user selects have **already been delivered**, so it
  /// is even easier to misread as 「send it again」.
  String get selectionOrganizeSub => _lfSelectionOrganizeSub;

  // ── The four outcomes of batch copy (`batchCopyResultText` is the only caller) ──────────
  String selectionCopiedRecords(int n) => _lfSelectionCopiedRecords(n);

  /// If pictures were not carried along, that must be said in the same
  /// sentence. 「5 records copied」 while two of them are pictures
  /// ⇒ the user pastes and gets only three, which is the overclaiming half
  /// of misreporting.
  String selectionCopiedRecordsSkippedImages(int n, int images) => _lfSelectionCopiedRecordsSkippedImages(n, images);

  /// 🔴 「Clipboard unchanged」 is not filler: this path **deliberately does
  /// not write an empty string to the clipboard** — that would silently wipe
  /// out whatever the user last copied, a loss this button has no business
  /// causing.
  String get selectionCopiedNothing => _lfSelectionCopiedNothing;

  // ── Hand off to AI organize: the six refusal reasons (`batchOrganizeRefusalText` is the only caller) ──
  String get selectionOrganizeNoSelection => _lfSelectionOrganizeNoSelection;

  String get selectionOrganizeNoText => _lfSelectionOrganizeNoText;

  String get selectionOrganizeOffline => _lfSelectionOrganizeOffline;

  String get selectionOrganizeAiBusy => _lfSelectionOrganizeAiBusy;

  /// 🔴 Blocked during speaking/transcription, and not out of fastidiousness:
  /// under the manual send policy the next final result **folds into the
  /// same buffer** (`chat_utterance.dart`'s `_foldIntoBuffer`), and the
  /// instant organize finishes running,
  /// `AiComposeController` does `aiBuffer = outputText` as a **wholesale
  /// replacement** ⇒ the sentence just spoken
  /// gets wiped out. That is content loss, not a formatting problem.
  String get selectionOrganizeRecording => _lfSelectionOrganizeRecording;

  /// 🔴 The single most important sentence on this card. Organize can only
  /// act on **the text currently in the input box** (the pipeline only knows
  /// `aiBuffer`), so handing the selected records in necessarily means
  /// writing that box; if the box still holds words the user has not sent,
  /// writing into it means overwriting them ⇒ **refuse rather than
  /// overwrite**, and say 「this will overwrite it」 up front.
  String get selectionOrganizeBufferBusy => _lfSelectionOrganizeBufferBusy;

  // ── Hand off to AI organize: started / did not start ───────────────────
  String selectionOrganizeStarted(int n) => _lfSelectionOrganizeStarted(n);

  String selectionOrganizeStartedSkippedImages(int n, int images) => _lfSelectionOrganizeStartedSkippedImages(n, images);

  /// Failed to start. **Why** is said by the existing AI-failure banner
  /// (`aiComposeError`; the wiring site can be grepped as
  /// `aiFailure:` in `ui/chat_banner_sources.dart`), this only answers
  /// 「where did those words go」 —
  /// one fact, one outlet, not said twice in two places.
  String get selectionOrganizeNotStarted => _lfSelectionOrganizeNotStarted;
}
