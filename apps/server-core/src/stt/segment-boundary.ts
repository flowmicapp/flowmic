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

/**
 * card SEG-3 (2026-08-15) — WHY a span of audio was closed, kept because the
 * text has to be repaired differently for each. See {@link seamText}.
 *
 * card SEG-4 (same day, owner: 「从处理逻辑上彻底优化，不要打补丁」) renamed the
 * third member: 'ceiling' became **'leg'**, because the thing the timer closes
 * is no longer a segment. A segment — the user-visible row — now ends ONLY at
 * 'sentence' or 'pause' (or at the terminal stop, which never comes through
 * here). What the clock bounds is the ENGINE LEG, an engineering constraint the
 * user never sees: its flush text is seam-repaired and banked, and the same row
 * keeps growing across the new leg.
 */
export type SegmentCutReason = 'sentence' | 'pause' | 'leg';

/**
 * card SEG-3 — how long the VAD gate must have been CONTINUOUSLY closed before
 * a silence counts as a boundary.
 *
 * 🔴 SEG-1 accepted a bare `!gateOpen`, and owner's 2026-08-15 recording is the
 * counter-example: 「…看看要怎么样实现」 / 「这个方案，…」 is ONE clause, and the
 * only thing between its halves is the breath before 「这个」. Mandarin runs at
 * roughly 4–6 syllables/s with sub-300 ms inter-phrase breaths, so an instant
 * gate reading answers 「is there sound RIGHT NOW」 — not 「did the speaker stop」.
 * 600 ms is longer than a breath and shorter than a thought; it is the first
 * measured number here, so it is a named constant to be re-measured, not tuned
 * in place.
 */
export const MIN_PAUSE_MS = 600;

/** The three inputs a DELIVERY decision is allowed to read, and nothing else.
 *  card SEG-4 removed `ceilingReached`: no timer can deliver a row any more —
 *  the timer's whole authority is now the engine leg. */
export interface SegmentCutInput {
  /** Has the `soft_segment_ms` cadence deadline already passed? Before it, the
   *  answer is always 'wait' — a pause at second 3 must not mint a 3-second row. */
  due: boolean;
  /** The engine's CONFIRMED text for the segment now open (never the draft). */
  confirmed: string;
  /** How long the VAD gate has been CONTINUOUSLY closed, in ms; 0 while open.
   *  🔴 Required, not optional-with-a-default: a caller that cannot answer
   *  「how long has it been quiet」 must not get 「long enough」 for free. */
  gateClosedMs: number;
}

/** 'cut' + why, or 'wait'. The reason travels because {@link seamText} needs it. */
export type SegmentCutDecision = { cut: false } | { cut: true; reason: SegmentCutReason };

/**
 * The DELIVERY policy, top-down: nothing before the deadline, and past it only
 * the two boundaries we can defend. There is deliberately no third arm — card
 * SEG-4's whole content is that time alone never again ends a row.
 *
 * 🔴 SENTENCE IS TESTED BEFORE PAUSE and the order is load-bearing, not tidiness:
 * a speaker who ends a sentence and then breathes satisfies both, and the reason
 * decides whether the engine's full stop is kept or removed. Reading that seam
 * as 'pause' would strip a full stop the speaker really did produce.
 */
export function segmentCutDecision(input: SegmentCutInput): SegmentCutDecision {
  if (!input.due) return { cut: false };
  if (endsAtSentenceBoundary(input.confirmed)) return { cut: true, reason: 'sentence' };
  if (input.gateClosedMs >= MIN_PAUSE_MS) return { cut: true, reason: 'pause' };
  return { cut: false };
}

/**
 * 🔴 card SEG-3 — THE ROOT CAUSE THIS ROUND FOUND, and it is not "where we cut".
 *
 * owner, 2026-08-15, holding up one of his own dictations: 「这句被切成了 2 段，
 * 中间用句号连起来，很明显不对」. The two halves were
 *   「…所以呢要不断的去搜查记录与看看要怎么样实现。」  ← full stop nobody spoke
 *   「这个方案，所以说不一定要怎么搞。」
 * and the clause is 「看看要怎么样实现这个方案」.
 *
 * WHERE THE FULL STOP COMES FROM. Not from the flush, and not from us — from the
 * recognizer, and our own engine layer already had it written down:
 * `engines/sherpa-local.ts:196` — 「SenseVoice punctuates AS A FUNCTION OF THE
 * SPAN, so a 「。」 turns into a 「，」 the moment more speech follows it」.
 * ⇒ A segment boundary does not merely SPLIT the text. It changes what the
 * engine DECIDES the text is: hand it half a clause as a closed span and it
 * punctuates that half as a finished sentence, because to the engine it is one.
 * The same mechanism explains owner's other symptom 「中间会丢失几个字」 — span 2
 * decodes with NONE of span 1's acoustic context, so its opening syllables
 * decode worst.
 *
 * ⇒ SEG-1 (cut in a better place) was necessary and CANNOT be sufficient: the
 * ceiling must exist, so forced cuts must exist, so fabricated sentence
 * terminators must exist — unless they are removed on the way out. That is this
 * function, and it is the whole of it.
 *
 * WHAT IT DOES. On a span we closed for TIME (a 'leg' rotation) or for BREATH
 * ('pause'), the confirmed text provably did NOT end at a sentence
 * (`segmentCutDecision` tests that first and would have said 'sentence'), so a
 * terminator on the end of the flush is a property of where the span closed,
 * not of what was said: drop it. On a 'sentence' cut it is the speaker's own,
 * and is kept. Under card SEG-4 the 'leg' arm matters MORE than it did as
 * 'ceiling': the repaired text is banked and the NEXT LEG'S text is appended
 * after it inside the same row, so a surviving fabricated 「。」 would now sever
 * a clause in the middle of one row instead of across two.
 *
 * ⚠️ FAILURE DIRECTION, chosen deliberately. The lossy case is a sentence that
 * completes DURING the flush round-trip: we then drop a full stop that had just
 * become real, and two sentences run together at the seam. That is a missing
 * mark between two intact sentences. The alternative is owner's defect: one
 * sentence severed by a mark that was never spoken. A reader can punctuate the
 * first; nobody can un-split the second.
 *
 * ⚠️ Exactly ONE terminator, and never the whole run: 「…吗？！」 is emphasis the
 * speaker produced, and eating the lot would edit them rather than un-edit us.
 *
 * 🔴 WHITESPACE IS NOT OURS TO TOUCH, and this cost a real defect on the way in.
 * The first version of this function did `trimEnd()` and returned the trimmed
 * string — which silently ate the trailing SPACE that joins two English
 * segments, turning 「…test reports 」+「before friday…」 into
 * 「…test reportsbefore friday…」. `stt-seam-duplication.test.ts` caught it, which
 * is the whole reason that suite exists. So: trimming is used only to FIND the
 * last visible character; every byte that is not the one terminator being
 * removed comes back out untouched. A seam repair that damages the seam is worse
 * than no repair.
 */
export function seamText(finalText: string, reason: SegmentCutReason): string {
  if (reason === 'sentence') return finalText;
  const end = finalText.trimEnd().length; // index just past the last visible char
  if (end === 0) return finalText;
  if (!SENTENCE_TERMINATORS.includes(finalText[end - 1]!)) return finalText;
  return finalText.slice(0, end - 1) + finalText.slice(end);
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
  /** card SEG-4 — the leg span expired: rotate the ENGINE LEG (flush → seam-repair
   *  → bank → fresh leg), and mint NOTHING. The row keeps growing. This used to
   *  be `cutNow()` and used to deliver; the rename is the card. */
  rotateLeg(): void;
}

/**
 * card SEG-1 — the cadence, as its own object.
 * card SEG-4 — what its timer is allowed to do, narrowed by owner's ruling
 * (「彻底优化，不要打补丁」): time can BOUND AN ENGINE LEG, it can never again
 * END A ROW.
 *
 * TWO PHASES ON ONE TIMER. Phase 1 fires at `cadenceMs` and raises {@link due}:
 * the segment starts LOOKING for a decent place to end. Delivery is decided per
 * audio chunk by {@link segmentCutDecision} — a sentence the engine confirmed,
 * or a pause that lasted. Phase 2 fires every `graceMs` after that and rotates
 * the engine leg (an internal act, invisible on the wire); the search for a
 * delivery boundary simply continues into the new leg.
 *
 * ⚠️ A row therefore has a MINIMUM length (`cadenceMs`) and no maximum. That is
 * deliberate and stated: the bounded resource was always the vendor session,
 * and the leg rotation bounds it. A speaker who never pauses and never finishes
 * a sentence accumulates one long row, which is the truth — cutting that
 * speaker off mid-clause to make the row shorter is the defect this card
 * removes, not a property worth keeping. The recording itself is still bounded
 * (quota / hard limit / the user's own thumb), and the terminal final settles
 * whatever the row had accumulated.
 */
export class SoftSegmentCadence {
  private timer: unknown = null;
  private _due = false;
  /** card SEG-3 — when the gate last went closed, or 0 while it is open. Lives
   *  here rather than in the orchestrator so the three facts a cut is decided
   *  from (deadline, silence run, confirmed text) are read in one place. */
  private gateClosedAtMs = 0;
  private _lastCutReason: SegmentCutReason = 'leg';

  /** Why the span now closing was closed. Read by the orchestrator when it emits
   *  a segment final (or banks a rotated leg), so {@link seamText} can undo a
   *  full stop the span produced. Defaults to the strictest reading ('leg' ⇒
   *  repair), so a path that forgets to ask errs toward removing a mark rather
   *  than keeping a fabricated one — {@link seamText}'s failure direction. */
  get lastCutReason(): SegmentCutReason { return this._lastCutReason; }

  /**
   * Called once per audio chunk. Returns true when this chunk is the DELIVERY
   * boundary — the row ends here, by the speech's own shape, never by the clock.
   *
   * ⚠️ `gateOpen` is the SAME predicate that decides whether the chunk is fed to
   * the engine, passed in rather than re-derived: two answers to 「is this voice」
   * inside one decision is this repo's #1 bug shape.
   */
  shouldCut(gateOpen: boolean, nowMs: number, confirmed: string): boolean {
    if (gateOpen) this.gateClosedAtMs = 0;
    else if (this.gateClosedAtMs === 0) this.gateClosedAtMs = nowMs;
    const d = segmentCutDecision({
      due: this._due,
      confirmed,
      gateClosedMs: this.gateClosedAtMs === 0 ? 0 : nowMs - this.gateClosedAtMs,
    });
    if (!d.cut) return false;
    this._lastCutReason = d.reason;
    return true;
  }

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
      // phase 2 — card SEG-4: the leg span expired. Rotate the ENGINE LEG and
      // mint nothing; the row keeps waiting for a boundary it can defend. The
      // reason is recorded BEFORE the hook so the orchestrator's bank read
      // (`lastCutReason`) cannot see a stale 'sentence' from a previous
      // delivery and skip the seam repair.
      this._lastCutReason = 'leg';
      this.hooks.rotateLeg();
      // Re-arm for the NEXT leg span: legs keep rotating for as long as the
      // boundary refuses to arrive. `cadence + grace` (the same span the FIRST
      // leg got), not bare `graceMs`: every rotation is a seam and every seam
      // costs acoustic context, so legs are kept as long as the vendor bound
      // allows rather than as short as the grace. Also load-bearing for the
      // suites that pin `graceMs: 0` — a bare-grace re-arm would be `arm(0)`,
      // a timer that fires at the clock's every step.
      this.arm(this.cadenceMs + this.graceMs);
    }, delayMs);
  }

  clear(): void {
    if (this.timer !== null) { this.hooks.clearTimeout(this.timer); this.timer = null; }
  }

  /** The boundary HAPPENED. Called from the orchestrator's `beginNextSegment`
   *  alongside the index and the clock anchor, so the three facts that together
   *  mean "a new segment is open" cannot drift apart (that drift WAS N1-B1). */
  reset(): void { this._due = false; this.gateClosedAtMs = 0; }
}
