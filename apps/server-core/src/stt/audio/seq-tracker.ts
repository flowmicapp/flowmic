// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.1 (every chunk carries a seq/ts), §2.3
//     (reconnect replay dedupe)
//   Ported from legacy audio/seq-tracker.ts (mechanism unchanged from the legacy line).
//
// Tracks the contiguous-received sequence number per audio session.
//
// The LOAD-BEARING half is hasObserved(): it is what keeps a reconnect's
// full-ring replay from re-feeding already-transcribed audio into the live
// engine, and it is exercised on every blip.
//
// The gap half is NOT wired to anything. This class still COMPUTES a GapRange
// (and AudioSession re-emits it as an internal 'gap'), but the wire verb it was
// written for — `audio:resend-request` — was deleted from the protocol on
// 2026-07-31 precisely because the server never emitted it while the mobile sat
// there handling it. Do not read the GapRange return as evidence that anything
// asks for a resend; nothing does. Lost chunks come back via the mobile's
// full 30 s ring replay on reconnect, deduped by hasObserved() above.
//
// SEG-1 correction (design §2-R5, docs/strategy/2026-08-11-unified-
// transcription-session-design.md): the paragraph above stays true for the
// GapRange half — still computed, still consumed by nothing, still no resend
// verb. But it no longer covers this class as a whole: the `lastContiguousSeq`
// GETTER below, which had no reader at all from the 2026-07-31 deletion until
// this card (~two weeks on the tree with hasObserved() as the only live half),
// now HAS a consumer — the mobile:reconnect ack carries it as
// `audio_last_contiguous_seq` (read via
// AudioSessionRegistry.peekLastContiguousSeq → SttSessionBridge.lastContiguousSeq
// → socket/handlers/mobile.handler.ts; wire contract:
// @flowmic/protocol MobileReconnectAckAudioFieldsSchema) so the phone can trim
// its ring replay to seqs above the watermark (card SEG-2) instead of always
// re-sending all 30 s. hasObserved() keeps deduping whatever still arrives —
// the trim saves bandwidth and duplicate text, the dedupe stays the belt.

export interface GapRange {
  from_seq: number;
  to_seq: number;
}

export class SeqTracker {
  private last_contiguous = -1;
  private out_of_order = new Set<number>();

  /** Returns the last contiguous seq received, or -1 if none yet. */
  get lastContiguousSeq(): number {
    return this.last_contiguous;
  }

  /** F-2149: true iff `seq` has ALREADY been observed — either within the
   *  contiguous run (≤ lastContiguousSeq) or recorded out-of-order ahead of a
   *  gap. The orchestrator uses this to feed each seq to the live engine at most
   *  once: a reconnect replays already-delivered seqs (→ true, skip the
   *  re-transcription) while a genuine gap-fill resend of a never-seen seq below
   *  the high-water mark is NOT observed yet (→ false, still fed) so lossless
   *  recovery is preserved (06 §2.1). */
  hasObserved(seq: number): boolean {
    return seq <= this.last_contiguous || this.out_of_order.has(seq);
  }

  /**
   * Record a chunk arrival.
   * @returns A gap range to request replay for, or null if no gap.
   */
  observe(seq: number): GapRange | null {
    if (seq < 0) return null;
    if (seq <= this.last_contiguous) return null; // duplicate / late
    if (seq === this.last_contiguous + 1) {
      this.last_contiguous = seq;
      this.advanceContiguous();
      return null;
    }
    // Gap
    this.out_of_order.add(seq);
    return { from_seq: this.last_contiguous + 1, to_seq: seq - 1 };
  }

  /** Advance last_contiguous as far as out-of-order set allows. */
  private advanceContiguous(): void {
    while (this.out_of_order.has(this.last_contiguous + 1)) {
      this.last_contiguous += 1;
      this.out_of_order.delete(this.last_contiguous);
    }
  }

  /** Reset to fresh state (e.g. on new session). */
  reset(): void {
    this.last_contiguous = -1;
    this.out_of_order.clear();
  }
}
