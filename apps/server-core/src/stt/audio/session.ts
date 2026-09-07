// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §1 (AUDIO_DEFAULTS hard_limit_ms 300000,
//     server_replay_buffer_ms 5000), §2 (four-layer robustness: soft
//     segmentation / 5-minute hard ceiling)
//   Ported from legacy audio/session.ts (mechanism carried over unchanged).
//
// One AudioSession per active audio:start..audio:stop run. Owns the 5s replay
// ring buffer, sequence tracker, hard-limit timer, and pause state. STT engine
// is created/disposed by the orchestrator (not here); AudioSession is concerned
// with the chunk pipeline only.
//
// 🔴 fix-025: there are TWO ceilings on a run and they want opposite actions —
// the engine-session one recycles the leg, the quota one ends the recording. One
// timer, armed on whichever is nearer, and `limitOrigin` names it. See
// [[HardLimitOrigin]] and [[AudioSession.nextCeiling]].

import { EventEmitter } from 'node:events';
import { AUDIO_DEFAULTS } from '@flowmic/protocol';
import { RingBuffer, type BufferedChunk } from './ring-buffer';
import { SeqTracker, type GapRange } from './seq-tracker';

/** 🔴 card P2-5/WP-1 (2026-09-02) — `'paused'` is now UNREACHABLE: the only two
 *  methods that ever entered it, `pause()`/`resume()`, were dead code (zero
 *  callers, production or test — `audio:pause`/`audio:resume` in
 *  `socket/handlers/audio.handler.ts` set a plain flag on the REGISTRY entry,
 *  never this class's own state machine) and were deleted. Kept in the union
 *  rather than removed, because several defensive `!== 'paused'` guards below
 *  predate this note and are harmless to leave — this is a documented dead
 *  branch, not a silent one. */
export type SessionState =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'processing'
  | 'closed'
  | 'auto_stopped';

/**
 * 🔴 Card N1-B1 — WHICH ceiling the hard-limit timer is enforcing.
 *
 * The timer answers one question, "time's up", but is armed from two facts that
 * want OPPOSITE handling:
 *  · `engine_session` — AUDIO_DEFAULTS.hard_limit_ms, an ENGINEERING fact (one
 *    vendor session may not run forever). The user did nothing wrong; design
 *    §2.3 (`docs/strategy/2026-08-08-design-n1-long-recording.md`) makes this a
 *    rollover to a new engine session in card N1-B4, with the user unaware.
 *  · `quota_budget` — `quota.remainingSttMs` at audio:start (stt-factory). The
 *    user is out of minutes; this one MUST still stop the recording.
 *
 * 🔴 fix-025 — THE TWO ARE NO LONGER ONE NUMBER, and this type is now the label
 * of a real branch rather than a label attached to whichever number won a `min`.
 * See {@link AudioSession.nextCeiling}: they are two deadlines, the nearer one is
 * armed, and this says which. Collapsing them into one field was lossless only
 * while both origins ENDED the recording; after N1-B4 the engine ceiling re-arms
 * itself, so a quota ceiling that lost the `min` was not merely mislabelled — it
 * was unreachable, because every rollover re-anchored the only clock there was.
 */
export type HardLimitOrigin = 'engine_session' | 'quota_budget';

/** Card CR-Q — the minimum spacing between mid-recording budget re-reads.
 *  60 s is chosen against the thing that varies: engine legs are born on speech
 *  boundaries, so their rate is a property of how the user talks, and the floor
 *  is what makes the cost a property of wall time instead. */
export const DEFAULT_QUOTA_REFRESH_FLOOR_MS = 60_000;

export interface AudioSessionOptions {
  /**
   * The ENGINE-SESSION ceiling in ms — 「one vendor session may not run forever」
   * — defaulting to AUDIO_DEFAULTS.hard_limit_ms (5 min). It is re-anchored at
   * every rollover, so it bounds ONE LEG, not the recording.
   *
   * 🔴 NOT the place to put a billing number (fix-025). This field used to
   * receive `quota.remainingSttMs` straight from stt-factory, which made the
   * engineering ceiling vary per account and per how much of the month was left
   * (a fresh free account handed it 1,200,000 ms against a 300,000 ms default),
   * while `limitOrigin` still said `engine_session` — so the ceiling ROLLED OVER
   * and the recording never ended at all. The remaining budget is a different
   * fact with the opposite action: it goes to
   * {@link AudioSession.setQuotaBudgetMs}.
   */
  hardLimitMs?: number;
  /** ms tail kept for replay; defaults to 5 s. */
  replayWindowMs?: number;
  /** Wall-clock supplier; injectable for tests. */
  now?: () => number;
  /** Injected timer fns (FakeClock tests). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface ChunkInput {
  seq: number;
  ts_ms: number;
  payload: Buffer;
}

export class AudioSession extends EventEmitter {
  readonly buffer: RingBuffer;
  readonly seq: SeqTracker;
  private _state: SessionState = 'idle';
  /** When the CURRENT engine leg started — re-anchored at every rollover. */
  private legStartedAt: number | null = null;
  /** When `start()` ran. Never re-anchored: the quota deadline is measured from
   *  here precisely so a rollover cannot push it away (fix-025). */
  private sessionStartedAt: number | null = null;
  private hardLimitTimer: unknown = null;
  /** 🔴 `readonly` since fix-025, and that is the assertion, not the style: the
   *  old field was writable because `clampHardLimitMs` overwrote it with the
   *  billing number. An engineering constant that a billing value can replace is
   *  the defect in one line. */
  private readonly engineSessionLimitMs: number;
  /** ms of monthly budget this session may spend, or `null` for 「there is no
   *  quota ceiling」 (standalone / unmetered). 🔴 `0` is NOT `null` — see
   *  {@link AudioSession.setQuotaBudgetMs}. */
  private quotaBudgetMs: number | null = null;
  private _limitOrigin: HardLimitOrigin = 'engine_session';
  /** Card CR-Q — supplies the fresh monthly remainder, or null when nobody
   *  installed one (tests, standalone). */
  private quotaRefresh: (() => number) | null = null;
  private quotaRefreshFloorMs = DEFAULT_QUOTA_REFRESH_FLOOR_MS;
  /** Seeded at start(), so the first re-read happens one floor in rather than
   *  immediately after the declaration it would only re-confirm. */
  private lastQuotaRefreshAt = 0;
  private readonly now: () => number;
  private readonly _setTimeout: (fn: () => void, ms: number) => unknown;
  private readonly _clearTimeout: (handle: unknown) => void;

  constructor(opts: AudioSessionOptions = {}) {
    super();
    this.engineSessionLimitMs = opts.hardLimitMs ?? AUDIO_DEFAULTS.hard_limit_ms;
    this.buffer = new RingBuffer(opts.replayWindowMs ?? AUDIO_DEFAULTS.server_replay_buffer_ms);
    this.seq = new SeqTracker();
    this.now = opts.now ?? Date.now;
    this._setTimeout = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get state(): SessionState {
    return this._state;
  }

  /**
   * Which ceiling the hard-limit timer is CURRENTLY ARMED ON — and, once one has
   * fired, which one fired. See {@link HardLimitOrigin}.
   *
   * `engine_session` until a quota budget is declared that is nearer than the
   * next engine-leg deadline; it can flip DURING a recording (a 20-minute budget
   * is armed only after the last rollover before it), which is the honest shape:
   * "which ceiling is governing this recording" has different answers at different moments, and the
   * consumer (`orchestrator-core` handleAutoStop) reads it at exactly one — after
   * the fire, when it is the one that fired.
   */
  get limitOrigin(): HardLimitOrigin {
    return this._limitOrigin;
  }

  /**
   * Declare how many ms of monthly STT budget this session may spend
   * (`quota.remainingSttMs` at audio:start). Must be called BEFORE start() (only
   * legal from `idle`).
   *
   * 🔴 fix-025 — THIS REPLACES THE CLAMP, and the difference is the card. The old
   * `clampHardLimitMs` guarded with `ms < this.hardLimitMs`: it only ever
   * TIGHTENED, so it kept the fact only when the budget was smaller than the
   * engine ceiling and dropped it silently otherwise — i.e. for every account with
   * more than five minutes left, which is the normal case. That was lossless while
   * both ceilings ended the recording; after N1-B4 the dropped fact is the billing
   * wall. A budget larger than the engine ceiling is now KEPT, and enforced across
   * the rollovers in between.
   *
   * 🔴 `0` means A CEILING OF ZERO, not 「no ceiling」. The old guard `ms > 0` read
   * a spent budget as 「nothing to clamp」, which is the worst available mapping:
   * the one value that means 「stop this immediately」 was the one value that meant
   * 「never stop」. `Infinity` (and an absent call) is how 「there is no quota
   * ceiling」 is said — standalone and unmetered sessions.
   *
   * ⚠️ `NaN` THROWS rather than being read as 「no ceiling」. It cannot come from
   * `remainingSttMs` (finite limit + `Math.max(0, …)`), so this only fires for a
   * broken meter — and a broken meter that silently disables the wall is the exact
   * failure this card exists to remove.
   *
   * ⚠️ The ceiling is WALL-CLOCK while the meter (`recordSttUsage`) bills audio
   * ms — gated ms for a VAD-gated managed session. So it is conservative in one
   * direction only: it can stop a gated session slightly before its budget is
   * truly spent, and can never let one run past. Stated rather than fixed —
   * changing the metering basis is not this card's, and both facts are honest
   * under "what grounds does this claim rest on": the session really did occupy that many wall seconds.
   */
  setQuotaBudgetMs(ms: number): void {
    if (this._state !== 'idle') {
      throw new Error(`AudioSession.setQuotaBudgetMs: illegal call from ${this._state} (call before start)`);
    }
    if (Number.isNaN(ms)) {
      throw new TypeError('AudioSession.setQuotaBudgetMs: NaN is not a budget (a broken meter must not read as "no ceiling")');
    }
    if (!Number.isFinite(ms)) return; // no quota ceiling — standalone / unmetered
    this.quotaBudgetMs = Math.max(0, ms);
  }

  /**
   * Card CR-Q (owner 2026-08-29) — install the mid-recording budget re-read.
   *
   * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────
   * {@link AudioSession.setQuotaBudgetMs} takes a SNAPSHOT at audio:start and
   * usage is only written at settle, so for the whole length of a recording the
   * declared budget is a number that stopped being checked. That was harmless
   * while an utterance lasted seconds. Continuous transcription (owner
   * 2026-08-29: up to 30 minutes per session) turns it into a half-hour window
   * in which the same account, on a second device, reads and spends the same
   * remaining minutes — each believing it has all of them.
   *
   * ── THE ARITHMETIC, AND WHY IT IS JUST THE FRESH READ ───────────────────
   * The deadline is `sessionStartedAt + quotaBudgetMs`, and `sessionStartedAt`
   * is never re-anchored (fix-025). The monthly read EXCLUDES this session,
   * because this session has not settled. Therefore any DROP between the
   * opening read and a later one is exactly what OTHER sessions settled — which
   * is exactly the amount by which this session's deadline should move in.
   * ⇒ the refreshed budget is the fresh remaining, unchanged in form from the
   * declaration. Nothing is subtracted, and nothing may be: subtracting this
   * session's own elapsed time would count it twice, once here and once when
   * it settles.
   *
   * 🔴 WHAT THIS DOES NOT FIX, said plainly rather than discovered later. Two
   * recordings running AT THE SAME TIME both read the same remaining budget and
   * neither has settled, so together they can still overspend. This narrows the
   * exposure from "the entire length of a session" to "until the other session
   * settles" — it does not close it. Closing it needs in-flight reservation
   * accounting, which is a different card and a different conversation about
   * what a reservation means when a process dies holding one.
   *
   * @param read  supplies remaining monthly budget in ms; `Infinity` for
   *              "no ceiling". MAY THROW — the caller decides what a failed
   *              read means (see {@link AudioSession.refreshQuotaBudget}).
   * @param opts.floorMs  minimum spacing between reads. Defaults to
   *              {@link DEFAULT_QUOTA_REFRESH_FLOOR_MS}.
   */
  setQuotaRefresher(read: () => number, opts: { floorMs?: number } = {}): void {
    if (this._state !== 'idle') {
      throw new Error(`AudioSession.setQuotaRefresher: illegal call from ${this._state} (call before start)`);
    }
    this.quotaRefresh = read;
    this.quotaRefreshFloorMs = opts.floorMs ?? DEFAULT_QUOTA_REFRESH_FLOOR_MS;
  }

  /**
   * Card CR-Q — re-read the budget if it is time to, and re-arm the ceiling.
   *
   * Called from the ONE place an engine leg is born (orchestrator-core's
   * `spawnEngine` tail). owner asked for the check to ride the moment we
   * connect to the vendor and to be "very short"; three things keep it that
   * way, and all three are load-bearing:
   *
   *   ① **the floor**. A leg is born on every soft-segment rollover, which
   *      follows SPEECH — sentence ends and pauses — so on a talkative
   *      recording legs can be born every few seconds. Without a floor this
   *      would be a database read per sentence. With it the cost is bounded by
   *      wall time and is decoupled from how the user talks.
   *   ② **no ceiling ⇒ no read**. A standalone / unmetered session never had a
   *      budget, so there is nothing to refresh and nothing to pay for.
   *   ③ the read itself is one indexed row.
   *
   * ✅ And a correctness property that falls out of the placement rather than
   * being arranged: no leg ⇒ no audio reaching a vendor ⇒ nothing being spent
   * ⇒ nothing to re-check. A silence hang-up (RT-2) therefore stops paying for
   * these reads on its own.
   *
   * 🔴 DOES NOT CATCH. A failed read must not become a stopped recording — but
   * it must not be swallowed either, and this class has no honest place to put
   * a log line. The caller wraps it, keeps the previous budget, and records the
   * failure; see the call site.
   */
  refreshQuotaBudget(): void {
    const read = this.quotaRefresh;
    if (read === null) return;
    // ② — nothing was ever declared, so there is no ceiling to move.
    if (this.quotaBudgetMs === null) return;
    if (this._state !== 'recording' && this._state !== 'paused') return;
    const t = this.now();
    // ① — the floor. First call after start always reads (lastQuotaRefreshAt is
    // seeded at start()), so a short session is not charged for a read it
    // cannot use, and a long one gets its first re-read one floor in.
    if (t - this.lastQuotaRefreshAt < this.quotaRefreshFloorMs) return;
    const fresh = read();
    this.lastQuotaRefreshAt = t;
    // Same two guards as the declaration, for the same reasons: NaN is a broken
    // meter and must never read as "no ceiling", and a non-finite answer means
    // this account stopped being metered — leave the existing ceiling alone
    // rather than inventing an unbounded one mid-recording.
    if (Number.isNaN(fresh)) {
      throw new TypeError('AudioSession.refreshQuotaBudget: NaN is not a budget');
    }
    if (!Number.isFinite(fresh)) return;
    const next = Math.max(0, fresh);
    if (next === this.quotaBudgetMs) return; // nothing moved — do not re-arm
    this.quotaBudgetMs = next;
    // Re-arm through the SAME act that sets the origin, so the number and
    // "which ceiling is governing" cannot disagree (see armHardLimit's doc).
    this.armHardLimit(t);
  }

  /**
   * 🔴 RETAINED NAME ONLY — it no longer clamps. Delegates verbatim to
   * {@link AudioSession.setQuotaBudgetMs}, whose doc explains why the clamping
   * guard had to go.
   *
   * It survives because three test files still call it by this name and they were
   * not this card's to edit: `test/autostop-reason.test.ts`,
   * `test/stt-engine-session-rollover.test.ts`,
   * `test/stt-segment-settlement.test.ts`. All three pass a value SMALLER than
   * their engine ceiling, so the delegation is behaviour-identical for them —
   * checked one by one, not assumed. Production has never called it and must not
   * start: the caller set is pinned by a census in `test/quota-limit-origin.test.ts`
   * that fails both if a production caller appears and if the three test callers
   * ever go away — at which point DELETE THIS METHOD rather than keeping a name
   * that describes an operation the class no longer performs.
   */
  clampHardLimitMs(ms: number): void {
    this.setQuotaBudgetMs(ms);
  }

  start(): void {
    if (this._state !== 'idle') {
      throw new Error(`AudioSession.start: illegal transition from ${this._state}`);
    }
    const t = this.now();
    this.sessionStartedAt = t;
    this.legStartedAt = t;
    // Card CR-Q — the declaration that just happened IS the first read, so the
    // floor starts here. Without this seed the cold-open leg would immediately
    // re-read a number nobody could have changed yet.
    this.lastQuotaRefreshAt = t;
    this.transition('recording');
    this.armHardLimit(t);
  }

  /**
   * 🔴 fix-025 — the two ceilings, as two deadlines, and WHICH one is next.
   *
   * The engine one is measured from the CURRENT LEG (it is re-anchored by every
   * rollover — that is what makes it an engine-session fact); the quota one is
   * measured from `start()` and is never re-anchored, because a budget that reset
   * itself every five minutes would not be a budget. That asymmetry is the whole
   * mechanism: it is why the two cannot be expressed as one number, and why the
   * `min` the clamp performed at audio:start could not have worked even if it had
   * kept the label.
   *
   * ⚠️ A TIE GOES TO THE QUOTA. Both actions are defensible in the abstract and
   * only one is defensible here: rolling a user who is out of minutes into a fresh
   * engine session bills them past their budget with nothing reporting it, while
   * stopping one who had exactly reached their ceiling is the ceiling doing its
   * job. Failure directions, not symmetry.
   *
   * A non-finite engine ceiling is read as 「no engine ceiling」 rather than handed
   * to `setTimeout`, which silently treats an out-of-range delay as 1 ms.
   */
  private nextCeiling(): { at: number; origin: HardLimitOrigin } | null {
    const engineAt = this.legStartedAt !== null && Number.isFinite(this.engineSessionLimitMs)
      ? this.legStartedAt + this.engineSessionLimitMs
      : null;
    const quotaAt = this.sessionStartedAt !== null && this.quotaBudgetMs !== null
      ? this.sessionStartedAt + this.quotaBudgetMs
      : null;
    if (quotaAt !== null && (engineAt === null || quotaAt <= engineAt)) return { at: quotaAt, origin: 'quota_budget' };
    if (engineAt !== null) return { at: engineAt, origin: 'engine_session' };
    return null;
  }

  /** Arm (or re-arm) the single timer on whichever ceiling is next, and record
   *  which one that is. The number and its origin are set HERE, in one act, so
   *  they cannot disagree — the property this card exists to establish. */
  private armHardLimit(t: number): void {
    if (this.hardLimitTimer !== null) {
      this._clearTimeout(this.hardLimitTimer);
      this.hardLimitTimer = null;
    }
    const next = this.nextCeiling();
    if (next === null) return;
    this._limitOrigin = next.origin;
    this.hardLimitTimer = this._setTimeout(() => this.onHardLimit(), Math.max(0, next.at - t));
  }

  /**
   * Card CV-1 — chunks this session took off the wire and did NOT put into the
   * pipeline, because it was no longer recording or paused by the time they
   * would have reached the ring.
   *
   * 🔴 REPLAY DE-DUPLICATION IS NOT COUNTED HERE and must never be: the
   * orchestrator drops an already-observed seq on purpose (that is what makes a
   * reconnect's ring replay safe), so folding it in would report the mechanism
   * working as audio lost.
   *
   * ⚠️ TWO WRITERS, BOTH IN {@link AudioSession.pushChunk} and both the same
   * fact: the frame arrived and went nowhere. One is the state guard (it landed
   * after the session left `recording`), the other is the ceiling check (it
   * arrived past a `quota_budget` deadline and ENDED the recording itself). The
   * second was missing, and a frame the session had just thrown away therefore
   * read as `'fed'` one layer up — see the comment at that branch.
   */
  get droppedChunks(): number { return this._droppedChunks; }
  private _droppedChunks = 0;

  /** Card CV-1 — how many TIMES {@link SeqTracker.observe} reported a gap. */
  get gapEvents(): number { return this._gapEvents; }
  private _gapEvents = 0;

  /**
   * Card CV-1 — how many leg rotations this RUN has ATTEMPTED (soft-segment cuts
   * and engine-ceiling rollovers alike).
   *
   * ⚠️ ATTEMPTS, NOT COMPLETED LEGS, and the word is the correction (audit F4).
   * The sole writer below is called at the TOP of `runRollover`, before
   * `rolloverSegment` runs — a rotation that bails at a fence, or whose spawn is
   * handed to the reconnect ladder, is counted here all the same. It is left
   * that way rather than moved: the receipt's question is 「how many seams did
   * this recording's answer have to survive」, and an attempted rotation is a
   * seam whether or not a new leg came up behind it. What must not happen is a
   * reader treating the number as a count of legs that opened.
   *
   * 🔴 IT IS A PROPERTY OF THE RUN, WHICH IS WHY IT CAN LIVE HERE: "how many
   * seams did this recording's answer have to survive" outlives any one leg, and
   * every leg belongs to exactly one AudioSession. The honest second reason is
   * that `stt/orchestrator-core.ts` — where the rotation happens — was at 799 of
   * the 800-line cap, so the field could not go beside its writer.
   *
   * Sole writer: {@link noteLegRollover}, called from
   * `SttEngineOrchestrator.runRollover`, the ONE place `rolloverWork` is
   * assigned (both the soft-segment trigger and the ceiling trigger route
   * through it).
   */
  get legRollovers(): number { return this._legRollovers; }
  private _legRollovers = 0;
  noteLegRollover(): void { this._legRollovers += 1; }

  pushChunk(c: ChunkInput): GapRange | null {
    // A pre-start (idle) push is a strict ordering violation → throw loudly. A
    // late chunk during stop→flush (processing) or after the session ended
    // (closed / auto_stopped) is fail-soft → drop it.
    if (this._state === 'idle') {
      throw new Error(`AudioSession.pushChunk: illegal in state ${this._state}`);
    }
    if (this._state !== 'recording' && this._state !== 'paused') {
      // Card CV-1 — COUNTED, because "we took it off the wire and it went
      // nowhere" is exactly the fact the coverage receipt exists to report. The
      // early return itself is unchanged and stays fail-soft: a late chunk
      // during stop -> flush is normal, not an error. What was missing is that
      // nothing downstream could ever learn it happened, so the phone had no way
      // to tell "the server consumed all of my audio" from "the server consumed
      // most of it". See `droppedChunks`.
      this._droppedChunks += 1;
      return null;
    }
    const t = this.now();
    // Card N1-B4: the SECOND enforcement point (the timer is the first). It must
    // route through the same decision — a chunk landing past the ceiling on a
    // `engine_session` run is a rollover, not an end. Calling `autoStop` straight
    // from here was correct while there was one ceiling; with two it would let a
    // push decide something the timer decides differently, i.e. the same fact
    // answered two ways depending on which one noticed first.
    // fix-025: 「is any ceiling due」 rather than 「has this leg run long enough」.
    // The old comparison measured `t - startedAt` against the one number, and
    // `startedAt` is re-anchored by every rollover — so this point could never
    // have noticed a quota deadline even when the timer would have.
    const due = this.nextCeiling();
    if (due !== null && t >= due.at) {
      this.onHardLimit();
      if (this._state !== 'recording' && this._state !== 'paused') {
        // 🔴 COUNTED, for the same reason the state guard above counts. A
        // `quota_budget` ceiling ends the recording (`autoStop`), so THIS frame
        // is the one that notices and the one that goes nowhere: it was taken
        // off the wire and never reached the ring. Returning without touching
        // the counter left `orchestrator-core.pushChunk`'s delta at zero, and a
        // zero delta there means `'fed'` — so the last frame of every
        // quota-ended recording was reported to the phone as consumed. The
        // phone compares `fed_frames` against its own send count before
        // deleting its only copy of the audio.
        this._droppedChunks += 1;
        return null;
      }
    }
    // Card M3-4b: `ts_ms` is the PHONE's clock and is carried through untouched
    // (the engine wants capture order); `recv_ms` is OUR clock and is the only
    // thing the ring's retention may compare. Stamping both here is what keeps
    // the 5 s window from being measured with someone else's watch.
    const buffered: BufferedChunk = { seq: c.seq, ts_ms: c.ts_ms, recv_ms: t, payload: c.payload };
    this.buffer.push(buffered, t);
    this.emit('chunk', buffered);
    const gap = this.seq.observe(c.seq);
    // Card CV-1 — count the OCCURRENCES, not the missing seqs. A gap event says
    // "the run was interrupted here"; how many seqs the hole spans is a second
    // question, and one this counter deliberately does not answer, because a
    // later fill can shrink a hole without the event un-happening.
    if (gap) { this._gapEvents += 1; this.emit('gap', gap); }
    return gap;
  }

  /**
   * The replay tail: every chunk RECEIVED within the last `windowMs`.
   *
   * 🔴 Card M3-4b — this exists so the tail is read with THE SAME CLOCK that
   * stamped `recv_ms`. The orchestrator has its own injectable `now`, and a
   * caller that fakes one clock but not the other would re-create the very
   * defect this card closed, one level up: the ring would be stamped by the
   * session's clock and read against the orchestrator's. Retention is the
   * session's question, so the session answers it.
   */
  replayTail(windowMs: number, fedThroughSeq = Number.POSITIVE_INFINITY): BufferedChunk[] {
    return this.buffer.sinceOrUnfed(this.now() - windowMs, fedThroughSeq);
  }

  /** Card RT-3 — forward the ring's retention pin. Retention is the session's
   *  question (see {@link replayTail}), but WHAT HAS BEEN FED is the
   *  orchestrator's: it owns the engine. So the orchestrator supplies the value
   *  and the session still owns the clock the ring is measured with. The default
   *  pin means「everything has been fed」, i.e. the pre-RT-3 behaviour. */
  setRetentionPin(fedThroughSeq: number, graceMs: number): void {
    this.buffer.setRetentionPin(fedThroughSeq, graceMs);
  }

  stop(): void {
    if (this._state === 'closed' || this._state === 'auto_stopped') return;
    this.transition('processing');
  }

  finalize(): void {
    if (this.hardLimitTimer !== null) {
      this._clearTimeout(this.hardLimitTimer);
      this.hardLimitTimer = null;
    }
    this.transition('closed');
    this.removeAllListeners();
  }

  /**
   * 🔴 Card N1-B4 — the ceiling fired. WHICH ceiling decides whether the user's
   * recording ends.
   *
   * Design §2.3 (`docs/strategy/2026-08-08-design-n1-long-recording.md`):
   * "Keep one ceiling, but make it act on the **engine session** rather than on
   * **the user's current utterance**: when it fires, roll over to a new engine
   * session (close the old, open the new, segment numbers stay contiguous), the
   * user notices nothing, no banner pops up, the FSM never leaves RECORDING".
   *
   *  · `engine_session` — an ENGINEERING ceiling. The user did nothing wrong, so
   *    ending their recording was always the wrong price for it. The session
   *    STAYS `recording`, the ceiling is re-armed, and the leg recycle is
   *    announced to whoever owns the engine ({@link AudioSession} owns no engine
   *    and must not pretend to).
   *  · `quota_budget` — the user is out of minutes. UNCHANGED, byte for byte:
   *    this one still stops the recording, still emits `auto_stopped`, still
   *    transitions. N1-B1 exists precisely so this branch has a fact to read;
   *    rolling this ceiling over would switch the billing wall off in silence.
   *
   * ⚠️ THE RE-ARM IS NOT A SECOND TIMER. `start()`'s timer has already fired and
   * is spent; this re-arms the same field. Without it the ceiling would fire once
   * and never again, and 「the engine session may not run forever」 would hold for
   * exactly the first five minutes of a long recording — the failure that reports
   * nothing, which is the only kind this repo really fears.
   *
   * 🔴 fix-025 — WHICH ceiling is decided HERE, from the clock, not read off a
   * field that was set at audio:start. It used to branch on `_limitOrigin`, which
   * a session could only ever have acquired by having its engine ceiling
   * overwritten; a recording that had both a rollover ceiling and a budget could
   * not be expressed at all, and every production session read `engine_session`.
   */
  private onHardLimit(): void {
    if (this._state !== 'recording' && this._state !== 'paused') return;
    const t = this.now();
    const next = this.nextCeiling();
    // Nothing is actually due — only reachable through clock skew between the
    // timer and the injected `now`. Re-arming is the one action that neither ends
    // a recording nor recycles a leg, i.e. the only one that cannot lie; the delay
    // is positive by construction, so this cannot spin.
    if (next === null || t < next.at) { this.armHardLimit(t); return; }
    this._limitOrigin = next.origin;
    if (next.origin === 'quota_budget') { this.autoStop('hard_limit'); return; }
    this.legStartedAt = t;
    this.armHardLimit(t);
    this.emit('engine_session_expired');
  }

  /**
   * 🔴 card B2-G (2026-09-02) — closes "a leg can run about twice hard_limit".
   *
   * `onHardLimit()` above re-anchors `legStartedAt` to `now` UNCONDITIONALLY
   * the instant the `engine_session` ceiling fires, before it can know whether
   * `engine_session_expired`'s one listener (the orchestrator) actually
   * rotated the leg. `onEngineSessionExpired` bails out WITHOUT rotating when
   * a rollover is already in flight, the leg is hung up for idle silence, or
   * there is no engine at all — and in every one of those cases this class had
   * already told itself "a new leg started now" and armed the NEXT check a
   * full `engineSessionLimitMs` away. The real engine leg kept running on the
   * OLD instance, unrotated, for up to ANOTHER full ceiling before the next
   * chance to check — i.e. up to roughly TWICE the configured limit before the
   * engine-layer wall does anything.
   *
   * The orchestrator calls this instead of silently returning from a bailed
   * `onEngineSessionExpired`. Rewinding `legStartedAt` by `engineSessionLimitMs`
   * undoes exactly the premature advance `onHardLimit` just made, so the next
   * check (soon, not a full ceiling later) finds the SAME ceiling still due and
   * emits again — repeating at `delayMs` granularity until a check finally CAN
   * rotate, at which point `onHardLimit` re-anchors `legStartedAt` to that real
   * moment. Bounded overrun becomes "however many `delayMs` polls the busy
   * condition lasted", not "up to one more full ceiling".
   *
   * Only ever called for the `engine_session` origin (the branch that reaches
   * `onEngineSessionExpired` at all), so `engineSessionLimitMs` is guaranteed
   * finite here — the `quota_budget` branch never emits this event.
   */
  retryEngineCeilingSoon(delayMs = 250): void {
    if (this._state !== 'recording' && this._state !== 'paused') return;
    if (this.legStartedAt !== null) this.legStartedAt -= this.engineSessionLimitMs;
    if (this.hardLimitTimer !== null) {
      this._clearTimeout(this.hardLimitTimer);
      this.hardLimitTimer = null;
    }
    this.hardLimitTimer = this._setTimeout(() => this.onHardLimit(), Math.max(0, delayMs));
  }

  private autoStop(reason: 'hard_limit'): void {
    if (this._state === 'closed' || this._state === 'auto_stopped') return;
    if (this.hardLimitTimer !== null) {
      this._clearTimeout(this.hardLimitTimer);
      this.hardLimitTimer = null;
    }
    this.transition('auto_stopped');
    this.emit('auto_stopped', reason);
  }

  private transition(next: SessionState): void {
    this._state = next;
    this.emit('state', next);
  }
}
