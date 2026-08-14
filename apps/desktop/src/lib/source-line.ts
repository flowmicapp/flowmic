// 🔴 T-7 (0.2.63, owner addendum #6「发出去后也要关联的有最开始转录的原文」("even after it's sent, it should still be linked to the originally transcribed original text")) —
// 「这一行有没有原文可看」("whether this row has an original worth viewing"), in ONE place.
//
// ── WHY IT MOVED HERE, AND WHY THE TEST CHANGED ──────────────────────────────
// Two copies existed and they said the same thing in two files:
// `TimelinePage.vue:canExpandSource` and `CapsuleApp.vue:canShowSource` (the
// latter's own comment read 「Same gate as the timeline's canExpandSource」 — a
// greppable claim about another file's behaviour, i.e. exactly the shape 反
// façade ④ is about: it stays written while the other file moves).
//
// Both asked `mode === 'translate' || mode === 'organize'`, and until this card
// that was RIGHT — the only producer of a `source_text` was an utterance-level
// transform, which only those two modes run. T-7 added a second producer: a
// manual send whose buffer went through the card's AI pills carries the
// pre-transform text on the frame no matter which mode the row was spoken in
// (apps/mobile/lib/src/session/delivery_source_text.dart). A realtime row can
// now legitimately have an original, and under the old gate the PC would have
// received it, stored it, and never offered it — the field arriving and the
// field being readable are two different things.
//
// ⇒ the row now answers the question with what it HAS rather than with a proxy
// for what produced it: an original exists, and it is not the same words as the
// face. The mode test is not merely loosened — it is REPLACED by the fact it
// was standing in for.
//
// ⚠️ This is DISPLAY ONLY. `source_text` is write-once immutable (rebuild vol. 05) and
// nothing here writes anything; the desktop keeps recording the wire's three
// states (absent / null / text) exactly as `Stated` does in row_transit.rs.

/** The two shapes this predicate has to serve — the timeline row and the
 *  capsule's projection of it. Kept structural rather than importing both
 *  types: the question is about two strings, and naming them here is what lets
 *  ONE function answer for both surfaces. */
export interface SourceLineFace {
  /** The immutable original, when the sender declared one. */
  source: string | null | undefined;
  /** The row's display face — what was actually delivered. */
  face: string | null | undefined;
}

/** True when this row has an original worth offering behind 「原文」("original text"). */
export function hasSourceLine(f: SourceLineFace): boolean {
  const source = f.source;
  if (typeof source !== 'string' || source.length === 0) return false;
  // 🔴 An 「original」 identical to the face is not an original: expanding it
  // would show the same sentence twice under a label promising something else.
  // The old mode gate hid this case by accident (realtime rows never carried a
  // source_text at all); now it has to be said out loud. The MOBILE side draws
  // the same line — `TimelineEntry.showsSourceLine` ends with
  // `sourceText != displayText` — so the two timelines agree about which rows
  // have a second text, which is the whole point of 「两端一个答案」("one answer on both ends").
  return source !== (f.face ?? '');
}
