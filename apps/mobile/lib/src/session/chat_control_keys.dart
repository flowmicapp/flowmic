// Part of chat_controller.dart — the control:key half.
//
// SPEC-REF:
//   docs/rebuild/08-MOBILE-SPEC.md §5 + its 2026-08-13 correction block
//     (QuickActions act on the PC; 🔴 they NEVER touch this phone's draft —
//     「clear 同时清本地缓冲」("clear also clears the local buffer") was struck by
//     owner supplement #3)
//   docs/ui-design/2026-08-13-compose-band-redesign.md §4 (the full contract for
//     that decoupling, incl. why 「丢弃 ≠ 清屏」("discard ≠ clear screen") gets
//     cleaner rather than weaker)
//   packages/protocol/src/protocol-schemas-inject.ts (the control:key whitelist,
//     widened in v0.2.1 with the punct* family — sender-less since T-1)
//
// Split out for the 800-line cap, as a `part` in the same shape chat_utterance
// already uses: TOP-LEVEL functions taking the controller, so they can reach its
// private state without an extension (an extension cannot call the protected
// `notifyListeners`, and routing around that would mean weakening the class's
// own encapsulation to satisfy a line count).

part of 'chat_controller.dart';

/// One of the four QuickAction keys (⏎ ⌫ ↶ ✕). They act on the PC's FOCUSED
/// window — this is not local editing.
///
/// 🔴 **NO LOCAL SIDE EFFECT ON THE USER'S DRAFT** (owner 2026-08-13 supplement
/// #3:「在没点发送转录内容的按钮前，点控制键按钮也是独立投递，不会并入当前的未发送
/// 转录消息中」("before you press the send button on the transcribed content,
/// pressing a control-key button is also an independent delivery — it does not
/// get merged into the currently un-sent transcribed message")). This doc used
/// to declare TWO of them, and BOTH are gone in the same round:
///   · `clear` used to wipe the local buffer and settle the rows it covered at
///     📥 noted (08 §5). Struck: ✕ means 「clear the box on my COMPUTER」, and the
///     draft being reviewed on the phone is precisely what it must not destroy
///     on the way past.
///   · a punctuation key used to append its mark to this phone's copy of the
///     sentence. Struck together with the punctuation group itself (owner Q2㋐),
///     which was its only trigger.
///
/// ⚠️ Deleting the `clear` branch removed a real defect rather than moving it:
/// that branch blanked `_buffer` WITHOUT aborting a running AI compose, while
/// the genuine local discard (`clearBufferRouted`) aborts it precisely so that
/// 「一个稍后到达的 compose:done」("a compose:done that arrives later") cannot
/// resurrect text the user just cleared.
/// Pressing ✕ mid-run therefore used to leave an empty buffer with a live run
/// still aimed at it.
///
/// 🔴 No entry point for discarding a draft was lost: the floating card's
/// [丢弃]("Discard")/[✕] call `ChatController.discardBuffer`, and a mode switch
/// still clears the buffer (08 §2 red line). What changed is that 「丢弃」
/// ("discard") and 「清屏」("clear screen") stopped half-overlapping — two
/// controls with alike names and opposite consequences is a debt this repo
/// already carries once.
///
/// Returns BOTH facts, because they are genuinely different and conflating them
/// is a bug waiting to happen: `sent` is whether the frame reached the wire (the
/// caller's return value), `changed` is whether any local state moved (whether to
/// notify listeners). All four are `sent: true, changed: <minted a row>` now —
/// reporting 「nothing local moved」 as a failure would make every successful
/// press look like a refusal.
({bool sent, bool changed}) runControlKey(ChatController c, ControlKeyKind kind) {
  if (!c.delivery.sendControlKey(kind)) {
    return (sent: false, changed: false);
  }
  return (sent: true, changed: _mintControlRow(c, kind));
}

/// 🔴 REQ-12-13 (owner P0 2026-08-12) — 「按了哪一个键」("which key was pressed")
/// leaves a row on this phone's history. Contract: docs/rebuild/15 §2.0-e.
///
/// **AFTER the send, never before**, and that ordering is the row's entire meaning:
/// the row says 「帧离开了本机」("the frame left this device") and nothing more, so
/// it may only exist once that is true. A press that did not leave (no link,
/// `emit` threw) has already raised the compose banner inside `sendControlKey` —
/// no silent failures is answered there — and mints nothing, because a receipt
/// for a non-event is the other direction of the same red line.
///
/// 🔴 CHORD KEYS ONLY, and the predicate is 「it has no glyph」.
///
/// ⚠️ T-1 changed this guard's REASON without changing the guard. It used to
/// read 「the six `punct_*` kinds are a different act — they EDIT the newest
/// existing row, so a row of their own would double-count one press」. That
/// editing act no longer exists, and no surface in the app can send a `punct_*`
/// kind any more. The guard stays because the kinds are still on the wire
/// whitelist (deleting an event is an owner gate) and because
/// `docs/rebuild/15 §2.0-e` scopes this row to the four chords in so many words
/// — a kind with a glyph is not one of them.
bool _mintControlRow(ChatController c, ControlKeyKind kind) {
  if (controlKeyGlyph(kind) != null) return false;
  c.store.buildControlRow(
    // Same mint as every other correlation id on this end (`mintRequestId`), with
    // its own prefix so a keypress row can never collide with a delivery's. It
    // correlates NOTHING across the wire — there is no receipt to match — it is
    // only this row's local identity, which `buildControlRow` needs to stay
    // idempotent against a double tap.
    clientId: c.delivery.mintRequestId('k'),
    kind: controlKeyWireName(kind),
  );
  return true;
}

// T-1 (0.2.63): `_appendPunctuation` — which applied a punctuation key's mark to
// the newest row of this phone's timeline (v0.2.1 owner ruling
// 「送 PC，手机端的最后一条转录历史也要补上」("send to PC — the phone side's last
// transcript history entry also needs to be filled in")) — is DELETED, along with
// the pure decision it delegated to (`punctuation_append.dart`). Its only trigger
// was the punctuation group, which owner 2026-08-13 Q2㋐ removed; keeping a
// judgement function with no caller is exactly the dead content R8 bans.
//
// ⚠️ It did NOT go because it was wrong. Read `git log` for it before writing
// anything like it again: it owed its final shape to two real defects (card F2 —
// 「the newest row」 must be read from the MACHINE's owner set, not one instance,
// or a channel switch lands the mark on the wrong row; REQ-12-13 — the row-kind
// test must be written POSITIVELY on `kTranscript`, or the next entry type
// silently starts collecting full stops).
