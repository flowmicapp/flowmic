// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (soft segmentation: the boundary is
//     where a row ends; this file only REPORTS the silence at one, it never
//     moves one), docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (d)
//     (`stt:final.pause_before_ms`, additive optional)
//   Design: docs/strategy/2026-09-22-cr12-continuous-recording-live-article-view-design.md §2.4 / §2.4.1
//
// ── WHAT THIS FILE ANSWERS ──────────────────────────────────────────────────
// 「这一段开始前静了多久」 — the silence between the last word of the previous
// segment and the first word of this one, so the phone can put a paragraph
// break where the speaker actually stopped instead of where a stopwatch did.
//
// ── 🔴 TWO SIGNALS, ADDED — AND WHY ADDING THEM IS NOT 「两个传感器投票」 ──────
// (Primary-owner ruling 2026-09-23, replacing the first cut of this file, which
// reported the ENGINE's clock and called the shortfall an open account. Keep the
// reasoning below intact: it is the only justification this arithmetic has.)
//
// The engine's word timestamps (`start_ms` / `end_ms`; today ONLY Soniox sends
// them) are positions in THE AUDIO THAT LEG WAS HANDED — `engineFedBytes / 32`.
// Under a VAD gate (`shouldFeedEngine`; production managed streaming, see
// `engine-factory.ts` `gated`) that is NOT all the audio the phone sent us.
//
//   • GATE CANNOT CLOSE (a room with any noise floor): every chunk is handed
//     over, so the word gap already contains the whole silence and the gate has
//     withheld nothing. MEASURED (design册 §2.4, real `stt-rt-v5`): with −40 dBFS
//     noise over a 4 s gap the gate never closed (open 100 %) and the token clock
//     reported 4,320 ms.
//   • GATE CLOSES (a quiet room): the withheld chunks never reached the engine,
//     so the word gap is SHORT by exactly that much — and the gate is the one
//     thing that knows how much. MEASURED: against digital silence it withheld
//     ~70 % of the same gap.
//
// 🔴 THE TWO FAILURE CASES ARE COMPLEMENTARY, AND THE TWO QUANTITIES ARE
// DISJOINT BY CONSTRUCTION. Every chunk is classified ONCE, by one read of one
// predicate ({@link SegmentPauseAccount.noteChunk}'s `fed`, which IS the `feed`
// the orchestrator's chunk path already computed): either it went to an engine —
// and then it exists ONLY in the engine's word clock — or it did not, and then it
// exists ONLY as a withheld run here. There is no third bucket and no chunk in
// both, so
//
//     wall-clock pause = (silence inside the audio the engine heard)
//                      + (audio the gate withheld in the same interval)
//
// is a SUM OVER A PARTITION, not two opinions about one number. That single
// classification is also why the gate's 300 ms HANGOVER cannot be counted twice:
// during the hangover `feed` is still true (`vad-gate.ts` `step()` keeps `_open`
// until `silenceRunMs >= hangoverMs`), so that audio is handed to the engine and
// sits inside the word gap; it is never offered to the withheld side at all.
//
// ⚠️ WHAT THIS STILL DOES NOT MEASURE. A stretch the gate ACCEPTED but the
// engine produced no word for (a cough, a door) is counted as silence by both
// halves — the pause then reads LONGER than the speaker's real pause. That
// limitation predates this ruling: it is inherent in taking 「最后一个词」 from the
// recogniser, and it is unchanged, not introduced here.
//
// ── THE ARITHMETIC ──────────────────────────────────────────────────────────
// Every number below is carried in the SEGMENT's audio clock, whose zero is the
// segment boundary. A leg reports positions in ITS OWN clock, whose zero is the
// first byte that leg was handed; a leg that opens on a rollover is first handed
// the REPLAY (audio the previous leg already had, re-offered for context), so
//
//     segmentClock = legClock − legReplayMs + (audio earlier legs of this
//                                              segment contributed)
//
// and then
//
//     pause_before(N+1) = (fedEnd(N) − lastWord(N))              // heard, tail of N
//                       + Σ withheld runs of N   at ≥ lastWord(N)
//                       + firstWord(N+1)                          // heard, head of N+1
//                       + Σ withheld runs of N+1 at ≤ firstWord(N+1)
//
// with every term in its own segment's clock, so the replay two legs share is
// counted once at the end of N and subtracted once at the head of N+1. Clamped at
// 0 (the head term goes negative when the next segment's first word sits inside
// the replayed tail — i.e. the speaker never stopped) and rounded to the vendor's
// own 60 ms frame quantisation, because reporting 4,321 ms would claim a
// precision the source does not have.
//
// 🔴 WHY A WITHHELD RUN CARRIES A POSITION, AND WHY THAT POSITION IS IN THE WORD
// CLOCK. A withheld run is filed at the point of the SEGMENT's word clock where it
// happened: `base + legFedMs` while a leg is open (the bytes that leg had been
// handed when the gate refused the chunk), or the segment's `fedEnd` while no leg
// is (hung up, closing, dialling). Words and runs then pass through the SAME
// leg-to-segment mapping, so "is this run between the two words" is a comparison
// in one clock and cannot drift. The first version of this file skipped the
// position and sampled a monotonic withheld total at the first FED chunk after
// the boundary, on the belief that a fed chunk means speech. It does not: the gate
// is an energy threshold, and room noise above −45 dBFS is fed. MEASURED in the
// mixed room of `stt-segment-pause-rooms.test.ts` (2.5 s of −40 dBFS noise, then
// 2.5 s of silence): that version reported 2,580 ms for a 5,000 ms pause — the
// sample landed on the first noise chunk and the silence behind it fell outside.
//
// ⚠️ WHAT THE POSITIONING CANNOT ORDER. While no leg is open, an ACCEPTED chunk
// waits for the next leg's replay; a withheld chunk that follows it inside that
// window (a flicker during a redial) is filed at `fedEnd`, i.e. BEFORE the waiting
// chunk. If the waiting chunk was the first word, that flicker is counted into the
// pause — an over-report bounded by one dial round trip. Rare, small, and named.
//
// ── 🔴 ABSENCE IS A THIRD ANSWER, NEVER 0 ───────────────────────────────────
// `pauseBeforeMs` returns null — and the wire field is then ABSENT — whenever
// the number would be a guess: the first segment of a recording (nothing came
// before it), an engine that sends no word timestamps, a flush that returned no
// engine final, or a segment that crossed a LADDER RECONNECT. That last one is
// the subtle one: a reconnect re-feeds up to 5 s of already-heard audio into a
// leg whose byte counter was never reset, so the mapping above is unknowable —
// `noteLegReplay(null)` says so instead of producing a number that looks fine.

/** One engine leg's report, taken at the flush that closed it. */
export interface LegWordSpan {
  /** Total ms of audio THIS leg was handed (`engineFedBytes / 32`). */
  readonly legFedMs: number;
  /** Start of the first CONTENT word, in this leg's clock, or null. */
  readonly firstWordMs: number | null;
  /** End of the last CONTENT word, in this leg's clock, or null. */
  readonly lastWordEndMs: number | null;
}

/** card RC-4 — the live leg's word facts, all in THAT leg's fed-audio clock
 *  (the Soniox interim fields `hypothesis_last_word_ms` / `audio_proc_ms`). */
export interface LiveLegWords {
  /** `engineFedBytes / 32` right now — what this leg has been handed. */
  readonly legFedMs: number;
  /** End of the last content word of the vendor's current hypothesis. */
  readonly lastWordEndMs: number;
  /** How much of this leg's audio the vendor says it has processed. */
  readonly vendorProcMs: number;
}

/** card RC-4 — silence since the last word, two ways. `ms` counts every byte this
 *  leg was handed after the word plus what the gate withheld; `certainMs` counts
 *  only what the VENDOR has already processed after the word plus what the gate
 *  withheld. The difference is audio the vendor has not answered for yet — it may
 *  hold the next word. The policy that reads both is `segmentCutDecision`. */
export interface WordGap {
  readonly ms: number;
  readonly certainMs: number;
}

/** The vendor quantises to 60 ms frames (design册 §2.4, real frames: every token
 *  spans exactly 60 ms). Report on that grid rather than pretending to ms. */
export const PAUSE_QUANTUM_MS = 60;

export class SegmentPauseAccount {
  /** Trailing silence of the segment that just closed, in ms. `null` = there is
   *  no previous segment, or its trailing silence is not knowable. */
  private trailingMs: number | null = null;
  /** ── current segment, all in the SEGMENT clock ── */
  private firstWordMs: number | null = null;
  private lastWordEndMs: number | null = null;
  private fedEndMs = 0;
  private poisoned = false;
  /** ── current leg ── */
  private legReplayMs = 0;
  private priorLegsMs = 0;
  /** What the leg that just closed contributed to this segment, held until the
   *  next leg opens: only then do we know whether it belongs to the same
   *  segment (leg rotation, silence redial) or to a new one. */
  private carryMs = 0;
  /** ── the withheld half, positioned in the segment clock ── */
  /** Withheld runs of the CURRENT segment: `at` is the segment-clock position the
   *  gate refused them at, `ms` how much. Consecutive refusals at one position
   *  merge, so the list grows by gate CLOSURES, not by chunks. */
  private runs: { at: number; ms: number }[] = [];
  /** Whether a leg's clock is live for positioning: true between a leg's replay
   *  (its zero is known) and its final (its bytes are banked into `fedEndMs`). The
   *  cold-open leg is live from `reset()` — it is dialled with no replay. */
  private legOpen = true;

  /** A fresh recording: no previous segment, so no pause can be claimed. */
  reset(): void {
    this.beginSegment();
    this.trailingMs = null;
    this.legOpen = true;
  }

  /**
   * 🔴 EVERY chunk the orchestrator's chunk path classifies, with the SAME
   * `feed` boolean it uses for everything else — read once, per chunk, at one
   * site. That single classification is the proof that the two halves of the
   * sum are disjoint (header), so this must never be re-derived from the gate,
   * from `voiceBytesCaptured`, or from anything else that could disagree.
   *
   * A FED chunk records nothing here: it will be in some leg's word clock (live
   * now, or replayed into the next leg if none is open), and that clock is the
   * other half of the sum. `legFedMs` is how many bytes the CURRENT leg had been
   * handed when this chunk arrived — the position a refused chunk is filed at.
   *
   * ⚠️ Called for chunks the gate refuses even when NO engine is attached. That
   * is the case this ruling exists for: `idleHangupMs` (3 s, same wiring as the
   * gate) hangs the leg up partway through a quiet-room pause, and a counter
   * that stopped there would go blind on the pauses longer than three seconds in
   * a quiet room — precisely the pauses a paragraph break is for.
   */
  noteChunk(fed: boolean, ms: number, legFedMs: number): void {
    if (fed) return;
    const at = this.legOpen ? this.priorLegsMs - this.legReplayMs + legFedMs : this.fedEndMs;
    const last = this.runs[this.runs.length - 1];
    if (last !== undefined && last.at === at) last.ms += ms;
    else this.runs.push({ at, ms });
  }

  /**
   * card RC-T — the last [ms] of the withheld run just filed were handed to the live leg after all (the
   * gate-open pre-roll, `gate-preroll.ts`), so they are in its word clock now and leave the withheld half:
   * the two halves stay disjoint, as the header requires. Taken off the newest run, which is the one
   * those chunks were filed into; never below zero.
   */
  notePreroll(ms: number): void {
    const last = this.runs[this.runs.length - 1];
    if (last !== undefined) last.ms = Math.max(0, last.ms - ms);
  }

  /**
   * A leg opened and has just been re-fed its replay tail. `replayMs` is how
   * much audio it was handed before any live chunk; `null` means THE MAPPING IS
   * UNKNOWN (a ladder reconnect) and poisons this segment's number.
   */
  noteLegReplay(replayMs: number | null): void {
    this.priorLegsMs += this.carryMs;
    this.carryMs = 0;
    this.legOpen = true;
    if (replayMs === null) { this.poisoned = true; this.legReplayMs = 0; return; }
    this.legReplayMs = replayMs;
  }

  /** A leg closed; fold its report into the segment clock. */
  noteLegFinal(span: LegWordSpan): void {
    this.legOpen = false;
    const base = this.priorLegsMs - this.legReplayMs;
    this.fedEndMs = Math.max(this.fedEndMs, base + span.legFedMs);
    this.carryMs = span.legFedMs - this.legReplayMs;
    // FIRST word of the SEGMENT, so only the first leg that has one may write it.
    if (span.firstWordMs !== null && this.firstWordMs === null) {
      this.firstWordMs = base + span.firstWordMs;
    }
    // LAST word of the segment, so every leg that has one overwrites it.
    if (span.lastWordEndMs !== null) {
      this.lastWordEndMs = base + span.lastWordEndMs;
    }
  }

  /**
   * The value for the final being minted for the CURRENT segment, or null when
   * it would be a guess (see the header). Read BEFORE {@link beginSegment}.
   */
  pauseBeforeMs(): number | null {
    if (this.poisoned || this.trailingMs === null || this.firstWordMs === null) return null;
    const first = this.firstWordMs;
    const lead = this.runs.reduce((sum, r) => (r.at <= first ? sum + r.ms : sum), 0);
    const raw = Math.max(0, this.trailingMs + first + lead);
    return Math.round(raw / PAUSE_QUANTUM_MS) * PAUSE_QUANTUM_MS;
  }

  /**
   * card RC-4 — the silence since the live leg's last word, as a {@link WordGap},
   * or null when it would be a guess. The same partition the header argues for
   * `pause_before_ms`: audio handed to the engine after the word (its own clock)
   * plus runs the gate withheld at or after the word (filed here by
   * {@link noteChunk}), and nothing counted twice.
   *
   * Null — the arm stays silent, it never answers 0 — when:
   *  · the segment crossed a LADDER RECONNECT (poisoned): that leg's byte counter
   *    was never reset, so its clock and the vendor's disagree;
   *  · no leg is open for positioning (closing, hung up, dialling);
   *  · the caller has no live word (engine sends no timestamps, or this leg has
   *    not produced a content word yet — a pause straddling a leg seam is not
   *    measured here; the gate's own arm still is).
   */
  liveWordGap(live: LiveLegWords | null): WordGap | null {
    if (live === null || this.poisoned || !this.legOpen) return null;
    const base = this.priorLegsMs - this.legReplayMs;
    const word = base + live.lastWordEndMs;
    const withheld = this.runs.reduce((sum, r) => (r.at >= word ? sum + r.ms : sum), 0);
    return {
      ms: Math.max(0, live.legFedMs - live.lastWordEndMs) + withheld,
      certainMs: Math.max(0, Math.min(live.vendorProcMs, live.legFedMs) - live.lastWordEndMs) + withheld,
    };
  }

  /** The index was spent: bank this segment's trailing silence and start over. */
  beginSegment(): void {
    if (this.poisoned || this.lastWordEndMs === null) {
      this.trailingMs = null;
    } else {
      const last = this.lastWordEndMs;
      const heard = Math.max(0, this.fedEndMs - last);
      const withheld = this.runs.reduce((sum, r) => (r.at >= last ? sum + r.ms : sum), 0);
      this.trailingMs = heard + withheld;
    }
    this.firstWordMs = null;
    this.lastWordEndMs = null;
    this.fedEndMs = 0;
    this.poisoned = false;
    this.legReplayMs = 0;
    this.priorLegsMs = 0;
    this.carryMs = 0;
    this.runs = [];
  }
}
