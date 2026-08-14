// 🔴 T-7 (0.2.63, owner addendum #6 「even after it's sent out, it must still
// be linked to the very first transcribed original」) — the ONE
// answer to 「which passage is this frame's original text」, as a pure
// function so it can be tested without a session, a socket or a queue.
//
// Contract = docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md (this
//   card makes zero changes to it)
//   + Book 05: `source_text` is IMMUTABLE — written once, at the moment a row
//     or a frame is built, never edited afterwards. This function only
//     decides 「what to write」; it never changes an existing row.
// Ruling = docs/decisions/2026-08-13-owner-0263-design-rulings.md §3 line 6
//   (「the path already exists … whether the original really lands in this
//   field when sending AI-edited text was unproven」 — proven this round,
//   see below).
//
// ── 🔴 THE STATE MEASURED THIS ROUND (the measurement script has been
// deleted; the conclusion landed in manual_delivery_source_text_test) ──
// Manual delivery (➤) across six combinations, the `source_text` on the frame:
//   realtime  / not through AI  → null      (the row's own face IS the
//                                            original; there is no second
//                                            passage to point to)
//   realtime  / through AI      → **null**  ✗ the original is nowhere
//                                            readable on the PC — this is
//                                            the missing half
//   translate / not through AI  → original ✓
//   translate / through AI      → original ✓ (the row's own `source_text`
//                                            already IS the transcribed
//                                            original)
//   organize  / not through AI  → original ✓
//   organize  / through AI      → original ✓
//   hand-typed D10 / through AI → **null**  ✗ the hand-typed text is left
//                                            nowhere at all
//
// ⇒ What's missing is exactly the two cells where 「the row itself can't
// answer」, not all six. So this is a **fallback**, not an **override**:
//
// 🔴 Why the order cannot be reversed (this is the easiest place on this
// card to get wrong, confirmed by measurement). Under translate / organize,
// the card's AI transform's 「pre-transform buffer」 is **the previous LLM
// output** (`utterance-transformed`), not what the user said — because the
// utterance-level organize/translate already ran before it was folded into
// the buffer. Using it to **override** the row's `source_text` would swap
// the real transcribed original for an intermediate product, which is worse
// than leaving it blank. The row's own copy is immutable, comes from the
// microphone, and always takes priority.
//
// ⚠️ Relationship with `TimelineEntry.showsSourceLine`: the first branch IS
// it. There is no second criterion here — this only asks one more question,
// when it answers null, of 「does this delivery itself know the original」.

import '../timeline/timeline_entry.dart';

/// What a manual delivery should stamp on its frame as `source_text`.
///
/// [representative] is the row this delivery settles onto (or the D10 row it
/// just built); [deliveredText] is what is actually going on the wire;
/// [aiOriginal] is the buffer as it stood before the FIRST card-level AI
/// transform (T-6's `AiComposeController.restorableOriginal`), or null when no
/// transform happened.
///
/// Returns null for 「this row has no source text」 — which is a real answer, not a gap: the
/// desktop's `Stated` reader distinguishes an explicit null from an absent key
/// (row_transit.rs, RV-75), and a realtime row whose words ARE the output
/// genuinely has no second text to show.
String? originalForDelivery({
  required TimelineEntry? representative,
  required String deliveredText,
  required String? aiOriginal,
}) {
  // ① The row's own immutable original, exactly as before this card. Unchanged
  //    for every delivery that never touched the AI pills.
  if (representative?.showsSourceLine ?? false) return representative!.sourceText;
  // ② The delivery's own knowledge. Only reached when the row could not answer.
  final String? original = aiOriginal;
  if (original == null || original.trim().isEmpty) return null;
  // An 「original」 identical to what is being delivered is not an original; it
  // is the same sentence twice, and the PC's original-text panel would offer
  // to expand a row into itself. Same test `showsSourceLine` applies on the
  // row side.
  if (original == deliveredText) return null;
  return original;
}
