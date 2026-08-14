// SPEC-REF:
//   docs/decisions/2026-08-06-owner-feedback-batch-fb1-12.md FB-7
//   CLAUDE.md red line: no silent failure (both directions: neither swallow it, nor misreport it)
//
// Two actions after multi-select: **batch copy** and **hand off to AI organize**.
//
// The two share one derivation ([selectedRecords]), and that is deliberate:
// they must give the SAME answer to 「what text do the selected records
// actually equal」 — computing it separately in two places is exactly the
// entry point for this repo's #1 bug shape.
//
// ── why picture rows are excluded ──────────────────────────────────────────
// A picture row has no body text: `entry.displayText` is a **descriptor**
// (「🖼 PNG · 214 KB」). Copying it out as a record would have the user paste a
// sentence ABOUT a picture, not the picture, and not a record —
// `image_clipboard.dart`'s file header states this verbatim: 「copying a 256
// px preview while saying picture copied would have the user paste a blurry
// square…the misreporting half of the fail-loud red line」. The batch surface
// pushes it to the extreme: **exclude it, and count how many were excluded
// in the very same sentence**.
//
// ⚠️ This card does **NOT** do 「batch-copy pictures」. The system clipboard
// only ever holds one picture at a time (Android ClipData's multi-item
// support is read by only the first item on the vast majority of
// receivers), so 「batch-copy 5 pictures」 does not mechanically hold up —
// this is a gap, written down here plainly, not quietly skipped.

import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import '../../session/image_clipboard.dart' show TextCopy;
import '../../settings/app_strings.dart';
import '../../timeline/timeline_entry.dart';

/// The text the selected records fold down into, and how that folding happened.
class SelectedRecords {
  const SelectedRecords({
    required this.text,
    required this.textRows,
    required this.imageRows,
  });

  /// The text that will actually be handed off (copied to the clipboard / sent into the AI organize buffer).
  final String text;

  /// How many records [text] contains.
  final int textRows;

  /// The count of picture rows excluded for having no body text. **Must be reported**, see file header.
  final int imageRows;

  bool get hasText => textRows > 0;
}

/// Selected records → one block of text. List order IS output order (the page
/// renders newest-first, so what gets handed off is the same order the
/// user read it in on screen).
///
/// The separator is a single newline: one record per line. The organize
/// pipeline gets 「a number of sentences」, not one long run glued together
/// by spaces — the latter would make the LLM unable to tell where one ends.
SelectedRecords selectedRecords(Iterable<TimelineEntry> selected) {
  final List<String> lines = <String>[];
  int images = 0;
  for (final TimelineEntry e in selected) {
    if (e.isImage) {
      images++;
      continue;
    }
    final String t = e.displayText.trim();
    if (t.isEmpty) continue; // an empty line neither counts as one nor pretends to be one
    lines.add(t);
  }
  return SelectedRecords(
    text: lines.join('\n'),
    textRows: lines.length,
    imageRows: images,
  );
}

// ── batch copy ──────────────────────────────────────────────────────────────

/// What actually landed on the clipboard. There is no single 「success」 value
/// covering three different things — the same design law as
/// [ImageCopyOutcome].
enum BatchCopyOutcome {
  /// Everything selected was a text record, and all of it is on the clipboard.
  copied,

  /// Text is on the clipboard, picture rows were excluded — the count is told by [SelectedRecords.imageRows].
  copiedSkippedImages,

  /// Not a single character (everything selected was a picture). 🔴 **The clipboard was deliberately never touched**, see [runBatchCopy].
  nothingToCopy,
}

/// The same one line of code as the private default implementation in
/// `image_clipboard.dart`. Deliberately rewritten rather than
/// making that one public: that file is not this card's territory, and
/// duplicating one line of `Clipboard.setData` is far cheaper than
/// editing a seam someone else is using just to save one line. The type
/// [TextCopy] still reuses theirs, so the test doubles on both paths are the
/// same kind of thing.
Future<void> _systemTextCopy(String text) =>
    Clipboard.setData(ClipboardData(text: text));

/// Put [records]' text on the clipboard.
///
/// 🔴 **Does nothing when there is no text**, rather than writing an empty
/// string: writing an empty string would quietly wipe out whatever the user
/// last copied — a loss caused BY this button that this button never
/// promised. The corresponding copy's sentence
/// 「clipboard unchanged」 is not filler, it is this branch's
/// **user-readable evidence**.
Future<BatchCopyOutcome> runBatchCopy(
  SelectedRecords records, {
  TextCopy? text,
}) async {
  if (!records.hasText) return BatchCopyOutcome.nothingToCopy;
  await (text ?? _systemTextCopy)(records.text);
  return records.imageRows > 0
      ? BatchCopyOutcome.copiedSkippedImages
      : BatchCopyOutcome.copied;
}

/// Outcome → that sentence. **Exhaustive switch**: adding one more outcome
/// down the road will fail to compile here.
///
/// 🔴 It lives here rather than in `selection_strings.dart`, for a mechanical
/// reason: a `part` file cannot have
/// its own imports, and accepting the enum as a parameter would need adding
/// an import line to the top of `app_strings.dart`, which is frozen for
/// this window. The guarantee is unchanged (missing a branch still fails to
/// compile), just moved one layer over. See that shard's own file header.
String batchCopyResultText(
  BatchCopyOutcome outcome,
  SelectedRecords records,
  AppStrings strings,
) => switch (outcome) {
  BatchCopyOutcome.copied => strings.selectionCopiedRecords(records.textRows),
  BatchCopyOutcome.copiedSkippedImages =>
    strings.selectionCopiedRecordsSkippedImages(
      records.textRows,
      records.imageRows,
    ),
  BatchCopyOutcome.nothingToCopy => strings.selectionCopiedNothing,
};

// ── hand off to AI organize ────────────────────────────────────────────────

/// Why this run is not allowed this time.
///
/// 🔴 **This is NOT a list of 「disabled states」, it is six reasons that must
/// be spoken out loud.** This repo's established precedent is
/// 「a control that changes nothing is worse than no control at all」
/// (0.2.27): the button stays pressable as always, and pressing it
/// gets one of the sentences here, never a silent nothing-happened.
enum BatchOrganizeRefusal {
  /// Not a single item is ticked.
  noSelection,

  /// Everything ticked is a picture — no text to organize.
  noText,

  /// The link is down. Organize is one `compose:start` round trip, and it
  /// cannot go out while disconnected.
  offline,

  /// The previous AI run is still going. `AiComposeController` only allows
  /// one at a time
  /// (`ai_compose_controller.dart` `if (isRunning) return null`).
  aiBusy,

  /// Currently speaking / transcribing. See the paragraph in
  /// [checkBatchOrganize] for why this is a content-safety issue.
  speechInFlight,

  /// 🔴 The input box still has text the user hasn't sent. See [checkBatchOrganize].
  bufferBusy,
}

/// Whether this hand-off to AI organize can run; null = yes it can.
///
/// ── 🔴 Why [bufferBusy] has to exist ────────────────────────────────────
/// Organize can **only act on the input box's own buffer**: the controlled
/// pipeline is
/// `ChatController.startAiCompose` → `AiComposeController.start`, and what it
/// reads is
/// `_host.aiBuffer`, which is `ChatController._buffer` — the SAME buffer the
/// user is currently typing into,
/// and the one a spoken final under the manual send policy accumulates into
/// (`chat_controller.dart`'s
/// `aiBuffer` getter/setter reads/writes `_buffer` directly).
/// ⇒ Handing the selected records in **necessarily means writing that box**.
/// If the box still has unsent text, writing into it means overwriting it,
/// and that is content loss. **Better to refuse than to overwrite.**
///
/// ⚠️ Deliberately **does NOT** do 「pop a dialog asking whether to
/// overwrite」: the shape of this repo's W2.5-E P0 was exactly a second
/// surface reading this shared buffer mid-compose; a confirmation dialog
/// merely pushes the responsibility onto the user, it does not change the
/// fact that 「one action would eat another action's input」. The user
/// already has two zero-cost ways out
/// (send it, or clear it), and the refusal sentence names both of them.
///
/// ── 🔴 Why [speechInFlight] has to exist ─────────────────────────────────
/// Under the manual send policy, a final transcript **appends** into the
/// same buffer via `_foldIntoBuffer`
/// (`chat_utterance.dart`); and the instant organize finishes running,
/// `AiComposeController` executes
/// `_host.aiBuffer = outputText` — a **whole-buffer replacement**. If the two
/// collide, the sentence just spoken
/// gets overwritten by the result, and no layer anywhere reports an error.
/// This entry blocks exactly that window.
///
/// ── ⚠️ Why the criterion is not `ChatController.canAiCompose` ──────────────────────
/// That getter is `aiCompose.canStart`, and the last clause of `canStart` is
/// **`_host.aiBuffer.trim().isNotEmpty`** — it requires the buffer to be
/// **non-empty**, which is exactly the opposite of what this function
/// requires it to be (empty). Using it as a precondition would make this
/// button refuse forever.
/// ⇒ The half of the pipeline that must be read is
/// `ChatController.canCompose` (＝`aiCanStart`),
///   which is what the [canCompose] parameter is. **This sentence can be
///   falsified by grep**, it is not a reminder.
///
/// Order IS priority: first answer 「is what you selected okay」 (the action
/// the user just took), then answer 「is the current state okay」 (something
/// they did not do). When both are hit at once, the former is said first.
BatchOrganizeRefusal? checkBatchOrganize({
  required SelectedRecords records,
  required int selectedCount,
  required bool canCompose,
  required bool isAiComposing,
  required bool speechInFlight,
  required String buffer,
}) {
  if (selectedCount == 0) return BatchOrganizeRefusal.noSelection;
  if (!records.hasText) return BatchOrganizeRefusal.noText;
  if (!canCompose) return BatchOrganizeRefusal.offline;
  if (isAiComposing) return BatchOrganizeRefusal.aiBusy;
  if (speechInFlight) return BatchOrganizeRefusal.speechInFlight;
  if (buffer.trim().isNotEmpty) return BatchOrganizeRefusal.bufferBusy;
  return null;
}

/// Refusal reason → that sentence. **Exhaustive switch**, same reasoning as [batchCopyResultText].
String batchOrganizeRefusalText(
  BatchOrganizeRefusal refusal,
  AppStrings strings,
) => switch (refusal) {
  BatchOrganizeRefusal.noSelection => strings.selectionOrganizeNoSelection,
  BatchOrganizeRefusal.noText => strings.selectionOrganizeNoText,
  BatchOrganizeRefusal.offline => strings.selectionOrganizeOffline,
  BatchOrganizeRefusal.aiBusy => strings.selectionOrganizeAiBusy,
  BatchOrganizeRefusal.speechInFlight => strings.selectionOrganizeRecording,
  BatchOrganizeRefusal.bufferBusy => strings.selectionOrganizeBufferBusy,
};

/// The sentence once it starts running — 「what I put where」. When pictures
/// are excluded, the count appears in the very same sentence.
String batchOrganizeStartedText(SelectedRecords records, AppStrings strings) =>
    records.imageRows > 0
    ? strings.selectionOrganizeStartedSkippedImages(
        records.textRows,
        records.imageRows,
      )
    : strings.selectionOrganizeStarted(records.textRows);
