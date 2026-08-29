// Part of chat_flow_page.dart — the edit sheet's CONTROLLER-NOTIFICATION
// family: everything the sheet adopts from outside itself, at the moment the
// ChatController says something moved.
//
// ── WHY THIS SPLIT, AND WHAT IT IS NOT ───────────────────────────────────────
// chat_flow_edit_sheet.dart sat at EXACTLY 800 against `verify/lint/
// file-size.mjs`'s SRC_MAX = 800, and card NR-4-P1 (c) had to grow one of the
// functions below. The repo's own rule for that situation is a structural
// split — 「move a coherent family out VERBATIM, never delete reasoning to save
// lines」 (file-size.mjs's baseline note) — so this is one whole family, not a
// line-count shave.
//
// 🔴 THE FAMILY: three top-level `…Routed` functions, all three registered on
// the SAME `ChatController` listener, all three answering 「the world outside
// this sheet changed; what does the sheet do about it」:
//   · [_syncComposeTextRouted]      — adopt an external buffer move into the field
//   · [_syncSheetOnControllerRouted] — SUP-5 open/close triggers
//   · [_syncSheetAiAppliedRouted]   — the applied-✓ mark that must survive collapse
// Nothing else in chat_flow_edit_sheet.dart runs at notification time, and
// nothing here runs at build time. That is the seam.
//
// 🔴 NOTHING MOVED HERE CHANGED BEHAVIOUR IN THE MOVE. The bodies and their
// comments are the ones that stood in chat_flow_edit_sheet.dart, character for
// character, with exactly ONE intended edit on top — the NR-4-P1 (c) caret
// guard inside [_syncComposeTextRouted], which is marked as such in place.
// **Any diff beyond that one is a bug.**

part of 'chat_flow_page.dart';

/// Adopt an EXTERNAL buffer move into the page-owned edit controller — at
/// CONTROLLER-NOTIFICATION time (an event handler), never during build: the
/// sheet's field listens to this controller, and a write mid-build is a
/// markNeedsBuild-during-build crash on an element the writer is no ancestor
/// of (measured — the first cut of ruling #4 took 16 tests down that way).
/// When the user is typing, ChatController echoes the same string straight
/// back, so the comparison keeps the caret still.
///
/// 🔴 NR-4-P1 (c) — 「keeps the caret still」 was only ever true for the ECHO.
/// Every OTHER writer — a new utterance folding in, an AI result landing,
/// 「restore original」 — rebuilt the value with `TextSelection.collapsed(
/// offset: buffer.length)`, which yanks the caret to the end of the box **while
/// the user is mid-edit**. Measured shape (NR-4 ledger §4 row c): fix a typo in
/// the middle of a manual draft, keep talking, and the next fold teleports the
/// caret past the word being corrected — the next keystroke lands in the wrong
/// place, and nothing on screen says why.
///
/// THE FORK, AND WHY IT IS THE ONLY HONEST ONE:
///   · **append-only extension** (the new text STARTS WITH what the field
///     already holds) ⇒ every existing offset still points at the same
///     character, so the user's selection is still MEANINGFUL and is kept
///     byte-for-byte. This is exactly the fold's shape: `_foldIntoBuffer`
///     always appends (chat_utterance.dart — NR-4-P1 (h) fixed the comment
///     that claimed otherwise), so the common case is the preserved one.
///   · **wholesale replacement** (an AI result, 「restore original」) ⇒ offset
///     `k` in the old string has NO successor in the new one. There is no
///     stable anchor to preserve, so this keeps the old behaviour and collapses
///     to the end. Pretending to preserve a caret across a rewrite would be a
///     position invented by us and presented as the user's.
///
/// GATED ON FOCUS, deliberately. With no focus there is no caret to protect and
/// no edit to interrupt; the end-of-text collapse is the right resting place
/// for the next tap, and D4's 「a sheet that opens by itself must not raise the
/// keyboard」 means the auto-open path lands here every time. So the guard costs
/// nothing on the path that does not need it.
void _syncComposeTextRouted(_ChatFlowPageState s) {
  final String buffer = s.controller.buffer;
  final TextEditingValue current = s._composeText.value;
  if (current.text == buffer) return;
  if (s._composeFocus.hasFocus &&
      current.text.isNotEmpty &&
      buffer.startsWith(current.text)) {
    final TextSelection selection = current.selection;
    // Range guard. `current.text` is a PREFIX of `buffer`, so a valid
    // selection into the old string is arithmetically still in range of the
    // new one — this cannot fire today, and it is here anyway because the
    // premise it rests on is the `startsWith` above, i.e. a fact about
    // ANOTHER expression. A selection that is invalid (`-1` offsets, the
    // fresh-controller default) or that some future writer put out of range
    // falls back to the same end-of-text collapse the replacement arm uses,
    // rather than into a Flutter range assertion.
    final bool anchored =
        selection.isValid &&
        selection.start >= 0 &&
        selection.end <= buffer.length;
    if (anchored) {
      s._composeText.value = TextEditingValue(
        text: buffer,
        selection: selection,
        // The IME's in-progress composition belonged to the OLD string. It is
        // dropped rather than carried: a composing range is the keyboard's
        // claim about text it is still authoring, and re-asserting it over a
        // string the keyboard has not seen is how a half-typed CJK syllable
        // gets duplicated.
        composing: TextRange.empty,
      );
      return;
    }
  }
  s._composeText.value = TextEditingValue(
    text: buffer,
    selection: TextSelection.collapsed(offset: buffer.length),
  );
}

/// SUP-5 open/close triggers that arrive as controller notifications:
/// (a) manual voice finalize ⇒ auto-open, no focus (D4);
/// mode switch ⇒ close (the red line already cleared the buffer; a sheet
/// left open over a foreign mode would be editing nothing).
void _syncSheetOnControllerRouted(_ChatFlowPageState s) {
  final String buffer = s.controller.buffer;
  final FlowMode mode = s.controller.mode;
  final bool modeChanged = s._lastModeSeen != null && mode != s._lastModeSeen;
  // 「是不是有一句话正在进行中」 — ONE author, both consumers below. SEG-2 needed
  // the predicate PA-5 already spelled out inline; two copies become two answers.
  final bool utteranceInFlight =
      s.controller.sessionState == SessionState.recording ||
      s.controller.sessionState == SessionState.processing;
  // PA-5: the append face ends when the utterance does — the fold (release)
  // or the discard (swipe-up cancel) has settled once the FSM is out of
  // recording/processing. A LISTENER edge, not a callback from the gesture:
  // the finalize arrives async and the button's up-handler cannot know when.
  if (s._sheetAppending && !utteranceInFlight) s._setSheetAppending(false);
  // 🔴 SEG-2 (owner, 2026-08-15) — 「说话的按钮也没了」. Trigger (a) says 「manual
  // voice FINALIZE ⇒ auto-open」 and never asked whether the finger is still
  // DOWN — correct while a manual utterance grew the buffer once, at release;
  // wrong once the server began settling SOFT SEGMENTS, which fold in MID-HOLD,
  // sliding the sheet over the dock (it COVERS the PTT bar by design). ⇒ anti-
  // façade ④. Account + reverse controls: edit_sheet_not_during_hold_test.dart.
  if (s._sheetOpen && modeChanged) {
    _collapseSheetRouted(s);
    s._sheetSrcVoice = false;
  } else if (!s._sheetOpen &&
      !utteranceInFlight &&
      s.controller.sendPolicy == SendPolicy.manual &&
      buffer.trim().isNotEmpty &&
      buffer != s._lastBufferSeen) {
    // Trigger (a). 🔴 NO focus request anywhere on this path — D4: a surface
    // that appears by itself must not raise the keyboard; only the explicit
    // preview tap focuses.
    s._sheetSrcVoice = true;
    s._setSheetOpen(true);
  }
  // 🔴 SEG-2 — the watermark advances only once the change has been JUDGED.
  // Unconditional (as it was) makes the guard above a WORSE bug: the mid-hold
  // fold records as "seen", so at settle the sheet never opens at all — the
  // manual flow's whole point, deleted, with every "no sheet during a hold"
  // test still green. Freezing it is what makes this a DEFERRAL, not a drop.
  if (!utteranceInFlight) s._lastBufferSeen = buffer;
  s._lastModeSeen = mode;
  _syncSheetAiAppliedRouted(s);
}

/// The applied-✓ mark used to live on `_SheetAiRowState`. Collapsing the
/// sheet unmounted that State, so reopening showed plain pills over a draft
/// that was still an AI product. The restore strip survived (controller-
/// derived); the ✓ did not. The listener is the SAME controller listener
/// the sheet already uses, so the mark survives collapse.
void _syncSheetAiAppliedRouted(_ChatFlowPageState s) {
  final ChatController c = s.controller;
  final ComposeTask? running = c.aiTask;
  if (running != null) {
    s._sheetAiPending = running;
    if (s._sheetApplied != null) s._sheetApplied = null;
    return;
  }
  final ComposeTask? finished = s._sheetAiPending;
  if (finished != null) {
    s._sheetAiPending = null;
    if (c.aiFailure == null) {
      s._sheetApplied = finished;
      s._sheetAppliedText = c.buffer;
      return;
    }
  }
  if (s._sheetApplied != null &&
      (c.buffer != s._sheetAppliedText || c.restorableOriginal == null)) {
    s._sheetApplied = null;
  }
}
