// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (soft_segment_ms — the server-side
//     segmentation cadence)
//   CLAUDE.md red line: no silent truncation
//
// card SEG-1 (2026-08-15) — WHERE a long recording is allowed to be cut.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
// `soft_segment_ms` was a bare 30 s stopwatch: at the tick the orchestrator
// flushed the engine, closed it, opened a new one, and the row ended wherever
// the clock happened to land. owner, 2026-08-15, from one 102-second dictation
// (relay: `audio intake {"audioMs":102400,"voicedMs":102280}`), which came out as
// four rows of 173 / 172 / 163 / 62 characters:
//
//   row 2 ends 「…所以呢，本质上安倍。」   row 3 starts 「经济学是通过出卖金融主权…」
//
// 「安倍经济学」 (Abenomics) was cut in half. Both halves then decode without the
// other's context, so the join also drops or garbles a word or two — which is
// what the owner reported as 「中间会丢失几个字」. The clock knew when 30 s had
// passed and NOTHING knew whether a sentence was in flight.
//
// ── WHY NOT "JUST USE THE VAD" ──────────────────────────────────────────────
// 🔴 Because it would not have fired on that recording. The billing VAD gate is
// an absolute-energy gate (-45 dBFS, `vad-gate.ts`) and the measurement above is
// its own counter-example: 102,280 ms voiced out of 102,400 ms — **120 ms of
// silence in 102 seconds**. In a room with any background level the gate simply
// never closes, so a pause-only rule degrades to the ceiling and changes nothing
// for exactly the recording that motivated the card. It is kept as ONE of the
// two signals because when it does fire it is unambiguous, never as the only one.
//
// The second signal is the engine's own punctuation: a terminator at the end of
// the CONFIRMED text means the vendor has committed a sentence. That is a
// semantic boundary rather than an energy one, and it is the signal that fires
// on continuous speech.
//
// ⚠️ CONFIRMED text only — never the draft. A draft's trailing 「。」 can be
// revised away by the next token, and cutting on it would put the boundary
// inside a sentence the engine had not finished deciding.
//
// ⚠️ The ceiling is not optional. Two of the three inputs can stay false
// forever (a speaker who never pauses and an engine configured without
// punctuation), and a segment that never closes is a row that grows without
// bound — the failure this whole cadence exists to prevent.

/** Sentence-final punctuation, as produced by the STT engines' own punctuation
 *  models across the product's spoken languages.
 *
 *  ⚠️ The ASCII period is deliberately ABSENT. English STT emits it mid-sentence
 *  inside abbreviations and numbers ("U.S.", "3.5"), so accepting it would move
 *  the cut INTO a sentence — the very defect being fixed — while the ideographic
 *  「。」 has no such second job. English recordings therefore lean on the VAD
 *  signal and the ceiling, which is the honest trade and not an oversight: a
 *  boundary rule is only worth having where it is right, and half a rule that
 *  fires in the wrong place is worse than none (this repo has paid for that
 *  twice — 0.2.53, ENG-4). */
const SENTENCE_TERMINATORS = '。！？…‼⁇⁈⁉！？!?';

/** True when [confirmed] ends on a sentence the engine has already committed.
 *  Trailing whitespace is ignored (engines pad); an empty string is never a
 *  boundary — "nothing has been said yet" is not "a sentence just ended". */
export function endsAtSentenceBoundary(confirmed: string): boolean {
  const t = confirmed.trimEnd();
  if (t.length === 0) return false;
  return SENTENCE_TERMINATORS.includes(t[t.length - 1]!);
}

/** The three inputs a cut decision is allowed to read, and nothing else. */
export interface SegmentCutInput {
  /** Has the `soft_segment_ms` cadence deadline already passed? Before it, the
   *  answer is always 'wait' — a pause at second 3 must not mint a 3-second row. */
  due: boolean;
  /** Has the grace ceiling past the deadline expired? Forces the cut. */
  ceilingReached: boolean;
  /** The engine's CONFIRMED text for the segment now open (never the draft). */
  confirmed: string;
  /** Is the VAD gate currently OPEN (i.e. we are inside speech)? A closed gate
   *  means the hangover has elapsed with no voiced frame — a real pause. */
  gateOpen: boolean;
}

/**
 * 'cut' ⇒ roll the segment over now; 'wait' ⇒ keep recording into this segment.
 *
 * The order below IS the policy and reads top-down: nothing before the deadline,
 * everything at the ceiling, and in between the two boundaries we trust.
 */
export function segmentCutVerdict(input: SegmentCutInput): 'cut' | 'wait' {
  if (!input.due) return 'wait';
  if (input.ceilingReached) return 'cut';
  if (!input.gateOpen) return 'cut';
  return endsAtSentenceBoundary(input.confirmed) ? 'cut' : 'wait';
}

/** What {@link SoftSegmentCadence} needs from the orchestrator, and nothing
 *  else. Same composition shape as `EngineIdleHangup` and
 *  `EngineSessionReconnectLadder`: the helper owns the countdown and its own
 *  state, the orchestrator owns the engine field and the accumulators. */
export interface SoftSegmentCadenceHooks {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** RT-2: a boundary is a FLUSH, so it needs a leg. With none attached phase 1
   *  RE-ARMS rather than raising `due` — returning instead would kill soft
   *  segmentation for the rest of the session with nothing saying it stopped. */
  hasEngine(): boolean;
  /** terminated || terminalizing — this recording is wrapping up, no segment work. */
  isFinished(): boolean;
  /** Phase 2: the grace expired, cut regardless of what the speech is doing. */
  cutNow(): void;
}

/**
 * card SEG-1 — the cadence, as its own object.
 *
 * TWO PHASES ON ONE TIMER. Phase 1 fires at `cadenceMs` and does NOT cut: it
 * raises {@link due} and re-arms itself for `graceMs`. The cut in between is
 * decided per audio chunk by {@link segmentCutVerdict} above — at a pause, or at
 * a sentence the engine has confirmed. Phase 2 is that grace expiring, and it
 * cuts unconditionally.
 *
 * ⚠️ Worst case a row is `cadenceMs + graceMs` long instead of exactly
 * `cadenceMs`. That is the price, it is bounded, and it buys the thing rows are
 * for: one row is one stretch of speech, not one stretch of clock.
 */
export class SoftSegmentCadence {
  private timer: unknown = null;
  private _due = false;

  constructor(
    private readonly cadenceMs: number,
    private readonly graceMs: number,
    private readonly hooks: SoftSegmentCadenceHooks,
  ) {}

  /** Has the cadence deadline passed, i.e. is this segment looking for
   *  somewhere decent to end? */
  get due(): boolean { return this._due; }

  arm(delayMs: number = this.cadenceMs): void {
    this.clear();
    this.timer = this.hooks.setTimeout(() => {
      if (!this.hooks.hasEngine()) { if (!this.hooks.isFinished()) this.arm(); return; }
      if (!this._due) { // phase 1 — the deadline, deliberately NOT a cut
        this._due = true;
        this.arm(this.graceMs);
        return;
      }
      this.hooks.cutNow(); // phase 2 — the ceiling
    }, delayMs);
  }

  clear(): void {
    if (this.timer !== null) { this.hooks.clearTimeout(this.timer); this.timer = null; }
  }

  /** The boundary HAPPENED. Called from the orchestrator's `beginNextSegment`
   *  alongside the index and the clock anchor, so the three facts that together
   *  mean "a new segment is open" cannot drift apart (that drift WAS N1-B1). */
  reset(): void { this._due = false; }
}
