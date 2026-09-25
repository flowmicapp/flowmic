// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (HANGUP-1 seam bullet, RC-5a block)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §3.1 (the lost 「是」), §5 RC-5a
//
// card RC-5a — WHERE A ROW CUT PUTS ITS REPLAY BOUNDARY when the chunk it was
// decided on is one the VAD gate withheld.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// A pause cut is decided ON a withheld chunk (the gate has been closed for
// `MIN_PAUSE_MS`). Every withheld chunk advanced the replay mark as it passed
// (RT-2: silence is never replayed), so the boundary sat ABOVE the whole closed
// run and the new leg was replayed only what came after it. The next syllable's
// onset lives at the END of that run: a chunk whose last 50–150 ms hold the
// onset reads as silence to an energy gate. MEASURED (CR-12-E A2, relay + WAV):
// 「是」 starts at 53.85 s, the leg started after it, and Soniox — probed with the
// same audio started 50 ms late — deletes the whole syllable rather than
// mis-hearing it.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// The boundary goes below the TAIL of the closed run, so the new leg is handed
// that tail first. Only the tail, capped at {@link PAUSE_CUT_REPLAY_MAX_MS}: the
// onset can only be at the run's end, and a run that began long before the
// cadence deadline would otherwise replay seconds of silence into a metered
// vendor. The mark itself is not moved — only the boundary the cut takes — so
// the chunks stay 「already accounted for」 to the pause arithmetic
// (`segment-pause.ts`: they are filed as withheld runs of the closing segment and
// subtracted from the new leg's head as replay overlap, never counted twice).
//
// ⚠️ Replaying withheld chunks makes a leg's byte count non-zero without any
// voice in it. The hang-up and release empty-leg rule reads VOICE for that
// reason (`leg-facts.ts` `voicedBytes`, book 15 §2.0-d RC-5a correction).

/** card RC-5a — the most withheld audio a row cut replays into the next leg.
 *  1 s = the card's own bound (「多喂 ≤1 s 静音」): five of today's 200 ms chunks,
 *  more than the 600 ms + 300 ms hangover a pause cut normally stands on. */
export const PAUSE_CUT_REPLAY_MAX_MS = 1_000;

/** The trailing ≤{@link PAUSE_CUT_REPLAY_MAX_MS} of the current gate-closed run. */
export class ClosedRunTail {
  private run: { seq: number; ms: number }[] = [];
  private runMs = 0;

  /** A fresh recording. */
  reset(): void { this.run = []; this.runMs = 0; }

  /** Every chunk the chunk path classifies, with the SAME `feed` reading it uses
   *  for everything else (one gate read per chunk). A fed chunk ends the run. */
  note(fed: boolean, seq: number, ms: number): void {
    if (fed) { this.reset(); return; }
    this.run.push({ seq, ms });
    this.runMs += ms;
    while (this.run.length > 1 && this.runMs > PAUSE_CUT_REPLAY_MAX_MS) this.runMs -= this.run.shift()!.ms;
  }

  /** The replay boundary a cut decided now should take instead of [mark]: just
   *  below the run's kept tail, or [mark] itself when the gate is open (the cut
   *  chunk was fed — nothing is withheld to hand over). Never above [mark]. */
  boundaryBelow(mark: number): number {
    const first = this.run[0];
    return first === undefined ? mark : Math.min(mark, first.seq - 1);
  }

  /** card RC-T — the seqs of the run's last chunks that fit in [maxMs] (at least none, oldest first):
   *  what the gate-open pre-roll hands the leg. Empty while the gate is open. */
  lastSeqs(maxMs: number): number[] {
    const out: number[] = [];
    let ms = 0;
    for (let i = this.run.length - 1; i >= 0; i--) {
      const c = this.run[i]!;
      if (ms + c.ms > maxMs) break;
      ms += c.ms; out.unshift(c.seq);
    }
    return out;
  }
}
