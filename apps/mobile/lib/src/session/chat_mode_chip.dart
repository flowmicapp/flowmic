// Part of chat_controller.dart — the mode chip's three writers.
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// This section has **nothing to do with** RV-92. It was moved out for exactly
// one reason: chat_controller.dart was already sitting at the 800-line source
// file cap, RV-92 needed to add a few lines each to the constructor and to one
// routing method, and the lead card called out the one wrong way to do that:
// 「不许为了压行数去删注释——要减的是**内容不该在这里**，不是内容太长」("comments
// must not be deleted just to shrink the line count — what needs cutting is
// **content that does not belong here**, not content that is too long"). So
// what moved is one whole, self-contained section, with not a word of its
// comments changed.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every function body is the exact same one
// that was in chat_controller.dart, with only two mechanical changes, listed
// here so that claim can be checked:
//   (1) the receiver made explicit ([c]) — the convention chat_utterance.dart /
//       chat_notices.dart already established;
//   (2) `notifyListeners` changed to `c.notifyUi()`, because `notifyListeners`
//       is `@protected` and a top-level function is not an instance member
//       (this is what makes it pass analyze).
// **Any diff beyond those two is a bug.**
//
// The class keeps same-named methods that forward to these, so every call site
// (the mode chip widget / chat_ui / mode_switch_confirm_widget_test) does not
// have to change a single character.

part of 'chat_controller.dart';

/// Switch mode. 08 §2: IGNORED while recording; otherwise switches AND clears
/// the buffer + STT segment cache (the "clear the buffer" red line — a stale
/// partial must not bleed across modes).
///
/// 🔴 NR-4-P1 (f): a non-empty draft is FOLDED INTO THE TIMELINE as a
/// record-only row FIRST — see [foldDraftToNotedOnModeSwitch]. The red line
/// above is untouched (the box still comes out empty and no partial bleeds
/// across modes); what changes is that the words are no longer thrown away on
/// the way out.
void setModeRouted(ChatController c, FlowMode next) {
  if (c._sess == SessionState.recording) return;
  if (c._mode == next) return;
  // BEFORE `_mode = next`, deliberately: the row belongs to the mode the words
  // were composed under. Minting it after the assignment would file a
  // realtime draft under 「organize」 and there would be nothing on screen or in
  // the store to contradict it.
  foldDraftToNotedOnModeSwitch(c);
  c._mode = next;
  c._clearBuffer();
  c.notifyUi();
}

/// 🔴 NR-4-P1 (f) — 「switching modes must not silently discard what is in the
/// box」 (NR-4 ledger §4 row f: 「有真实丢稿路径」, a real draft-loss path).
///
/// ── WHAT WAS ACTUALLY LOST, AND WHAT WAS NOT ────────────────────────────────
/// [discardBufferedRowsRouted] already settles every row that FED the buffer at
/// 📥 noted, and `ComposeModeSwitchHint`'s own doc leans on that to say 「this
/// box will be cleared」 rather than 「what you said is gone」. That is true —
/// for spoken text that was never edited. It is FALSE for the two things this
/// closes, because neither has a row behind it:
///   · text the user TYPED (`_bufferedEntryIds` is empty — nothing settles,
///     nothing is kept, the words simply cease to exist);
///   · a draft the user EDITED, or an AI translate/organize product — the rows
///     keep the ORIGINAL wording, so the version the user was about to send is
///     the version that disappears.
/// The confirm dialog that used to stand in front of this was cancelled by D1
/// (2026-08-06) and the replacement was a hint strip, i.e. a sentence — a
/// sentence stops nothing. This is the mechanism the sentence was standing in
/// for.
///
/// ── WHY A ROW AND NOT A DIALOG ──────────────────────────────────────────────
/// D1's ruling (a direct pick needs no confirmation) is not reopened here: the
/// user's tap still does what it looks like, in one step, with no interruption.
/// The words survive because 記錄是本體 — the record IS the substrate — which is
/// the same answer `discardBufferedRowsRouted` already gives for spoken rows.
/// An inline confirm was the stated fallback ONLY if a noted row were
/// structurally impossible from here; it is not (see below).
///
/// REUSED MACHINERY, NOT A SECOND WRITE PATH: identical to
/// `commitNotedLocal` (manual_delivery_noted.dart) and to a record-only spoken
/// utterance (`_settleSpan`) — `TimelineStore.buildFromUtterance` with
/// `Delivery.none` ⇒ `EntryStatus.noted`, and the same `origin` fork
/// (`destination.isFixed ? 'cloud' : 'paired'`) both of those stamp.
///
/// ── THE DE-DUPLICATION RULE, AND WHY IT IS A COMPARISON AND NOT A FLAG ──────
/// In the ordinary spoken-manual case the buffer is EXACTLY the covered rows'
/// text joined the way `_foldIntoBuffer` joins it (a single space, always
/// appended — NR-4-P1 (h)). Minting a row there would put the same sentence on
/// the timeline twice, one line above itself. So the fold runs only when the
/// buffer says something those rows do not. A boolean 「was this edited」 flag
/// would be a second author of that fact and would have to be maintained by
/// every writer of `_buffer` (typing, the AI row, restore-original, the fold);
/// the comparison asks the rows themselves and cannot go stale.
///
/// ⚠️ SCOPE, STATED: this runs on the MODE SWITCH only. The ✕ / 「discard」
/// button also reaches `_clearBuffer`, and it is deliberately left alone — that
/// button is labelled, deliberate destruction, and quietly keeping a copy of
/// what someone explicitly threw away is its own red line.
void foldDraftToNotedOnModeSwitch(ChatController c) {
  final String draft = c._buffer.trim();
  if (draft.isEmpty) return;
  if (draft == _coveredRowsText(c)) return;
  // 's' for switch — a prefix of its own, so `deliver.noted_local` (typed
  // commit) and this one stay tellable apart in a forensic trace.
  final String clientId = c.delivery.mintRequestId('s');
  c.store.buildFromUtterance(
    clientId: clientId,
    mode: c._mode,
    delivery: Delivery.none,
    text: draft,
    origin: c.destination.isFixed ? 'cloud' : 'paired',
  );
  diag('compose.mode_switch_folded_noted', <String, Object?>{
    'client_id': clientId,
    'text_chars': draft.length,
    'covered_rows': c._bufferedEntryIds.length,
  });
}

/// What the rows about to settle at 📥 noted already say, assembled by
/// `_foldIntoBuffer`'s own rule so the two strings are comparable at all.
/// A missing row contributes nothing rather than an empty span: it would make
/// the join differ from the buffer for a reason that has nothing to do with
/// the user, and the safe direction of that disagreement is 「mint the row」.
String _coveredRowsText(ChatController c) {
  final List<String> parts = <String>[];
  for (final String id in c._bufferedEntryIds) {
    final TimelineEntry? entry = c.store.findById(id);
    if (entry != null) parts.add(entry.outputText);
  }
  return parts.join(' ').trim();
}

// `cycleModeRouted` stood here. DELETED with `ChatController.cycleMode` in
// FB-3 Plan A (owner D1, 2026-08-06): the three modes are a one-tap segmented
// control now (`ModeSegmentedControl`), and 「到第三个模式要点两次」("reaching
// the third mode took two taps") was pain point 2. The permanent left-to-right
// order it encoded did not vanish — it lives at `kModeOrder` in
// ui/mode_chip.dart, where the segments read it.

/// The composer is now an editable TextField — this is its write path.
void setBufferRouted(ChatController c, String text) {
  if (c._buffer == text) return;
  c._buffer = text;
  // 🔴 T-6 — 「恢复原文」("restore the original text") dies with the draft, not
  // with an edit.
  //
  // Editing an AI result is precisely what the affordance is for, so an
  // ordinary keystroke must NOT retire it. EMPTYING the box is a different
  // act: `composeEditHold` goes false, the card unmounts, and whatever the
  // user types next is a NEW draft — offering it 「回到原文」 would hand back a
  // sentence belonging to something they already threw away.
  if (text.isEmpty) c.aiCompose.forgetRestorable();
  c.notifyUi();
}
