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
void setModeRouted(ChatController c, FlowMode next) {
  if (c._sess == SessionState.recording) return;
  if (c._mode == next) return;
  c._mode = next;
  c._clearBuffer();
  c.notifyUi();
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
