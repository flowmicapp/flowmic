// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (the overdue arm, RC-4 follow-up block)
//   docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md §3
//     (`kParagraphHardMaxMs` 90 s — the cap this arm makes reachable)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §2 / §5 RC-4
//
// card RC-4 follow-up — THE OVERDUE ARM: a row that has been open 90 s ends at the
// next PROVEN gap between words, and at 120 s at the next PROVEN word end. Never
// inside a word.
//
// ── WHY THE CUT IS IN THE PAST ──────────────────────────────────────────────
// Every other arm cuts at the live edge (the chunk being pushed), which is sound
// only when the live edge is known to be silent. For a 600 ms gap it cannot be:
// MEASURED (2026-09-24, `stt-rt-v5`, book 06 §2 RC-4 block) the vendor reports a
// word 460–540 ms after it has processed its end, up to 1,320 ms, so 「processed −
// last word end ≥ 400 ms」 (the word-gap arm's certainty rule scaled to 600) holds in
// the middle of almost every sentence. What IS proven is a gap BOTH of whose sides
// the vendor has FINALISED: its whole length is processed audio, so its certain part
// is 100 % (the live arm asks for 2/3), and a final token never moves. Finals trail
// the audio by 4–5 s, so the cut point X lies behind the live edge: the old leg's
// final is limited to tokens that started before X (`SttEngine.limitFinalTo`) and
// the next leg is replayed from the chunk containing X.
//
// ⚠️ The chunk containing X may start up to one chunk before X. For a gap cut that
// is silence (X is the middle of ≥ 600 ms, chunks are 200 ms). For the 120 s
// word-end cut it can be the tail of the word just ended; that tail has no onset,
// and Soniox deletes an onset-less syllable rather than mis-hearing it (root-cause
// §3.1, measured) — the same fact RC-5a stands on, pointed the other way.

import type { LegFacts } from './leg-facts';

/** The row age from which the arm looks for a gap: the design's 90 s paragraph cap
 *  (`kParagraphHardMaxMs`), measured on the clock `duration_ms` reports. */
export const OVERDUE_ROW_MS = 90_000;
/** Past this row age a proven word end is enough (MAIN, 2026-09-24). */
export const OVERDUE_FORCE_MS = 120_000;
/** The gap the first phase waits for: the same 600 ms `MIN_PAUSE_MS` calls a pause. */
export const OVERDUE_GAP_MIN_MS = 600;
/**
 * How long the ring may hold this leg's audio while the arm is armed. The cut point
 * trails the live edge by a finalisation lag (4.1–5.3 s measured) plus the flush
 * round trip, which already crosses the 5 s replay window; the arm is armed for at
 * most 30 s (90 → 120 s) and a leg spans at most `cadence + grace` (45 s). 60 s
 * covers both; the ring then holds ≤ 65 s ≈ 2 MB of PCM for one long row.
 */
export const OVERDUE_HOLD_GRACE_MS = 60_000;

/**
 * card RC-J (MAIN 2026-09-24, the first of the two fixes offered) — how far from the
 * current leg's start (its clock's 0) the cut point X must be, and the other half of the
 * rule: both words either side of X must be this leg's OWN audio, i.e. start at or after
 * `LegFacts.seam` (the head of the leg that re-hears audio the leg before it was handed).
 * The 120 s word-end fallback keeps both conditions.
 *
 * WHY: on the device both overdue cuts landed less than 1 s into a leg that had just been
 * born, and both sides of each seam were damaged (rerun §7 RC-J: 「非常壮观。｜同行的朋友」 →
 * 「非常长壮观｜中心的朋友」). A second cut that close to a leg seam leaves the one or two words
 * between the two seams with no context on either side. The rig reproduced the placement,
 * before this rule (`stt.cut` x_leg_ms / leg_seam_ms, test/stt-overdue-cut.test.ts): X at
 * 750–3050 ms into the new leg, under 2 s in 11 of 20 sweep points. 2 s is MAIN's number.
 */
export const OVERDUE_SEAM_CLEARANCE_MS = 2_000;
// ⚠️ 更正（RC-J2，2026-09-24）：the first sentence above said 「how far from the current leg's start (its clock's
// 0)」, and `decide` compared X itself with the clearance. It now measures from the SEAM (`LegFacts.seam`, the end of
// the head the leg re-hears): X − seam. On a healthy leg the head is ~0.4 s and the two readings agree; on a leg born
// into a backlog the head is the old leg's whole flush (18.6 s on the device), so an X 1.2 s past the seam read as
// 19.8 s 「from the leg start」 and passed — the seam repeated a word (「而不是一｜是一个」, rerun-3 root cause §5.1-2).

/** Where the row is cut: a position in the CURRENT leg's fed-audio clock, and the
 *  replay boundary seq that hands the next leg the chunk containing it. */
export interface OverdueCandidate {
  readonly kind: 'gap' | 'word_end';
  readonly legMs: number;
  readonly boundarySeq: number;
  /** card RC-J — where the words either side of X start (leg clock); right is null for a word-end cut. */
  readonly leftWordStartMs: number;
  readonly rightWordStartMs: number | null;
}

export class OverdueCut {
  private segmentIdx = -1;
  /** The leg position at which the row turned 90 s — gaps before it do not count. */
  private armLegMs: number | null = null;
  private armedLeg: object | null = null;
  /** card RC-J — how many of the armed leg's final words the last {@link decide} had in front of it.
   *  A gap is discovered only when its RIGHT word turns final, so every gap not yet judged starts at
   *  or after the end of word `scanned - 1`; {@link holdSeq} pins the ring there. */
  private scanned = 0;

  /**
   * Called once per chunk with the row's age and the leg's own facts. Returns the
   * proven cut point, or null. [legId] is the engine object of the open leg: the
   * facts are reset at every leg birth, so only the identity says 「same leg」.
   */
  decide(i: { segmentIdx: number; rowAgeMs: number; legFedMs: number; facts: LegFacts; legId: object }): OverdueCandidate | null {
    if (i.segmentIdx !== this.segmentIdx) { this.segmentIdx = i.segmentIdx; this.armLegMs = null; this.armedLeg = null; this.scanned = 0; }
    if (i.rowAgeMs < OVERDUE_ROW_MS) return null;
    // Armed now, or in an earlier leg of this row (then all of this leg is after the 90 s point).
    if (this.armedLeg !== i.legId) { this.armLegMs = this.armLegMs === null ? i.legFedMs : 0; this.armedLeg = i.legId; this.scanned = 0; }
    const from = this.armLegMs!;
    const words = i.facts.finalWords;
    this.scanned = words.length; // card RC-J — every gap among these is judged below
    const seam = i.facts.seam; // card RC-J
    for (let k = 0; k + 1 < words.length; k++) {
      const a = words[k]!; const b = words[k + 1]!;
      if (a.end_ms < from || b.start_ms - a.end_ms < OVERDUE_GAP_MIN_MS) continue;
      const x = (a.end_ms + b.start_ms) / 2;
      if (a.start_ms < seam || b.start_ms < seam || x - seam < OVERDUE_SEAM_CLEARANCE_MS) continue; // card RC-J; RC-J2: from the seam
      return this.at('gap', x, i.facts, a.start_ms, b.start_ms);
    }
    const last = words[words.length - 1];
    if (i.rowAgeMs >= OVERDUE_FORCE_MS && last !== undefined && last.end_ms >= from
      && last.start_ms >= seam && last.end_ms - seam >= OVERDUE_SEAM_CLEARANCE_MS) return this.at('word_end', last.end_ms, i.facts, last.start_ms, null); // card RC-J; RC-J2
    return null;
  }

  /**
   * While armed: the replay boundary of the EARLIEST point the arm could still cut
   * at — the end of the last final word it knows (any later gap or word end lies at
   * or after it), or the 90 s point. The orchestrator pins the ring there so the
   * replay the cut needs is still in it. null when not armed for this leg.
   *
   * ⚠️ 更正（RC-J，2026-09-24）：「the end of the last final word it knows」 was one gap too
   * late. The pin is set on the chunk path BEFORE `decide` runs on that chunk, and the
   * words that turned final in between (on the previous chunk's push) can close a gap
   * that starts at the end of the word BEFORE them. Finals trail the audio by 4–5 s, so
   * that gap's chunks sit right at the edge of the 5 s window, and pinning at the new
   * last word let the ring prune the chunk holding X just before the cut chose it (the
   * next leg then started 200–400 ms after X; `stt.replay_short` read `needed 502 /
   * oldest 504` on test/stt-overdue-cut.test.ts). The earliest undecided gap starts at
   * the end of the last word the previous `decide` had already seen ({@link scanned}).
   */
  holdSeq(facts: LegFacts, legId: object): number | null {
    if (this.armLegMs === null || this.armedLeg !== legId) return null;
    const words = facts.finalWords;
    const judged = words[Math.min(this.scanned, words.length) - 1];
    const earliest = Math.max(this.armLegMs, judged === undefined ? 0 : judged.end_ms);
    return facts.replayBoundaryFor(earliest);
  }

  private at(kind: OverdueCandidate['kind'], legMs: number, facts: LegFacts, leftWordStartMs: number, rightWordStartMs: number | null): OverdueCandidate | null {
    const boundarySeq = facts.replayBoundaryFor(legMs);
    return boundarySeq === null ? null : { kind, legMs, boundarySeq, leftWordStartMs, rightWordStartMs };
  }
}
