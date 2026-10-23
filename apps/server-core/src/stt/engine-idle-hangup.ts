// SPEC-REF:
//   docs/archive/strategy/2026-08-08-030-unified-plan-and-ledger.md card RT-2
//     (connection lifecycle follows the human voice: silence ≥3s hangs up /
//     speaking again redials)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §2.3 (VAD gating: silence does not occupy a billed streaming session)
//   CLAUDE.md: F-5 "turn 'replacing a live connection' and 'a real disconnect' into two separate things"
//
// EngineIdleHangup — the per-session 「hang up on silence, dial back on voice」
// state machine.
//
// ⚠️ THE SHAPE IS BORROWED ON PURPOSE. This is the same composition
// `EngineSessionReconnectLadder` already uses one file over: the orchestrator
// owns the engine field, the accumulators and the replay buffer; this class owns
// ONLY the countdown and the two transitions, and reaches everything else
// through {@link IdleHangupHooks}. Splitting it out is what kept
// orchestrator-core.ts under the 800-line cap without deleting any of the
// reasoning (repo convention: past 800 lines, do a structural split, don't delete the evidence).

/** Everything this machine needs from the orchestrator. No private-field access,
 *  no duplicated state — the ladder's contract, applied to the second lifecycle. */
export interface IdleHangupHooks {
  /** Is a leg attached right now? */
  hasEngine(): boolean;
  /** True once the recording is closing (either terminal path) or closed. */
  isSettling(): boolean;
  /** True while another owner already has this leg: a segment rollover, a
   *  terminal flush. Starting a second flush on one engine is not a thing. */
  isLegBusy(): boolean;
  /** Feed VAD-closure silence, flush, fold the result back into the
   *  accumulators, and close the leg. Owned by the orchestrator because every
   *  one of those touches state this class must not hold a second copy of. */
  flushAndCloseLeg(): Promise<void>;
  /** Open a fresh leg (capped spawn) and replay what no engine has heard.
   *  Resolves `false` when the dial failed and the ladder has taken over. */
  dialLeg(): Promise<boolean>;
  /** card HANGUP-1 — is there voice no leg has heard (and the recording not yet
   *  torn down)? Read once, right after a hang-up: see {@link hangUp}. */
  voiceOwed(): boolean;
}

/** card IDLE-1 — 'silence': `idleMs` of gate-refused audio was received; 'wall':
 *  the backstop fired (no audio handed to the vendor for `wallBackstopMs`). */
export type IdleHangupTrigger = 'silence' | 'wall';

export class EngineIdleHangup {
  private timer: unknown = null;
  private hangUpWork: Promise<void> | null = null;
  private dialWork: Promise<void> | null = null;
  private hungUp = false;
  /** card IDLE-1 — gate-refused audio received since the leg last heard voice (ms of AUDIO, not of clock). */
  private silentMs = 0;
  private trigger: IdleHangupTrigger = 'silence';

  /**
   * @param idleMs card IDLE-1 — the hang-up threshold, in ms of SILENCE IN THE
   *   RECEIVED AUDIO (see {@link noteChunk}). `0` = never hang up.
   * @param wallBackstopMs card IDLE-1 — a wall-clock cap on how long a leg may go
   *   without being handed audio, for the case no chunk arrives at all (an uplink
   *   stall, `audio:pause`). `0` = none. It is not a second opinion on silence: it
   *   exists because the VENDOR closes a socket that hears nothing (Soniox: 22.2 s
   *   measured, `packages/stt-cloud/src/engines/soniox.ts` flush doc 「22-second idle
   *   close」), and that close would come back through the reconnect ladder as a
   *   drop — the F-5 shape {@link beginHangUp} exists to avoid.
   */
  constructor(
    private readonly hooks: IdleHangupHooks,
    private readonly idleMs: number,
    private readonly _setTimeout: (fn: () => void, ms: number) => unknown,
    private readonly _clearTimeout: (handle: unknown) => void,
    private readonly wallBackstopMs = 0,
  ) {}

  /** card IDLE-1 — what fired the hang-up in flight / last run, for the `stt.cut` line. */
  get lastTrigger(): IdleHangupTrigger { return this.trigger; }

  /** True from a silence hang-up until a dial is under way. It is the ONLY thing
   *  that tells 「we hung up on purpose」 from 「the leg died」, and nothing outside
   *  this process can see it: a hang-up emits no status, no error, no frame. */
  get isHungUp(): boolean { return this.hungUp; }

  /** Is a leg-lifecycle job in flight? Read by the terminal paths, which must
   *  drain it before they flush the same engine themselves. */
  get isBusy(): boolean { return this.hangUpWork !== null || this.dialWork !== null; }

  /** Card RT-3's retention pin reads this: while a dial is in flight the ring must
   *  hold audio nobody has heard yet. Deliberately NOT `isHungUp` — while the leg
   *  is down and the user is quiet nothing is owed a replay, so the ring stays
   *  free to prune the silence. The debt begins when a dial does. */
  get isDialing(): boolean { return this.dialWork !== null; }

  /** (Re)start the wall-clock backstop. Called wherever audio is actually handed
   *  to the vendor, i.e. wherever the answer to "whether anyone is speaking"
   *  changes. A leg's BIRTH calls {@link legBorn} instead (it also zeroes the count).
   *
   *  🔴 card IDLE-1 — this used to start a WALL-CLOCK timer of `idleMs`, so a
   *  stalled uplink (no chunk at all) read exactly like 3 s of silence: 9 of 11
   *  natural mid-press hang-ups in production were stalls (decision record in the
   *  SPEC-REF of `test/stt-idle-hangup-audio-silence.test.ts`). The silence is now
   *  counted by {@link noteChunk}; only the backstop is a timer. */
  arm(): void {
    if (this.idleMs <= 0) return;
    this.clear();
    if (this.wallBackstopMs > 0) this.timer = this._setTimeout(() => { this.beginHangUp('wall'); }, this.wallBackstopMs);
  }

  /** card IDLE-1 — a leg was just born (all four ways, `orchestrator-core.ts`
   *  `spawnEngine`): it has heard nothing yet, so the count starts from zero there,
   *  as the old timer did. */
  legBorn(): void {
    this.silentMs = 0;
    this.arm();
  }

  /**
   * card IDLE-1 — one received chunk, with the gate's one reading of it. The count
   * is the AUDIO received since the last voiced chunk BEGAN (so a voiced chunk sets
   * it to its own length, a refused one adds its length), and reaching `idleMs`
   * hangs the leg up. A chunk that never arrives adds nothing: that is the fix.
   *
   * ⚠️ 「since it BEGAN」, not 「since it ended」, is chosen to keep the moment the
   * old wall-clock timer fired under a steady stream: it was armed when the voiced
   * chunk ARRIVED, i.e. at its start, so it fired one chunk before 「idleMs of
   * refused audio」. Counting from the end moved the long-recording hang-up one
   * chunk later, where RC-E's word-gap arm ends the row first — measured red in
   * `test/stt-continuous-silence-cut.test.ts` 「row age ~23 s」.
   *
   * Called once per chunk from `orchestrator-core.ts` `pushChunk`, after the cut
   * decision (a cut that started a rollover makes the leg busy and this declines;
   * the next refused chunk asks again).
   */
  noteChunk(voiced: boolean, ms: number): void {
    if (this.idleMs <= 0) return;
    if (voiced) { this.silentMs = ms; return; }
    if (!this.hooks.hasEngine()) return;
    this.silentMs += ms;
    if (this.silentMs >= this.idleMs) this.beginHangUp('silence');
  }

  clear(): void {
    if (this.timer !== null) { this._clearTimeout(this.timer); this.timer = null; }
  }

  /**
   * The voice is back — dial the leg. Returns true if a dial was started, so the
   * caller can order it BEFORE the retention pin is set (see `isDialing`).
   *
   * ⚠️ The caller decides what 「the voice is back」 means (a chunk the VAD gate
   * ACCEPTS, never merely 「a chunk arrived」 — the phone streams continuously, so
   * any-chunk would dial straight back into the silence we just hung up on).
   */
  noteVoice(): boolean {
    if (!this.hungUp || this.dialWork !== null) return false;
    this.dialWork = this.dial().finally(() => { this.dialWork = null; });
    return true;
  }

  /** Drain whatever is in flight. Callers guard this with `isBusy` so the common
   *  path does not pay even the extra `await` — see the orchestrator's `stop()`,
   *  where an unconditional await was MEASURED to break the terminal flush. */
  async settle(): Promise<void> {
    if (this.hangUpWork) { try { await this.hangUpWork; } catch { /* its own path cleans up */ } }
    if (this.dialWork) { try { await this.dialWork; } catch { /* ditto */ } }
    this.clear();
  }

  /**
   * 🔴 The leg is hung up because the VOICE stopped, and that fact must never be
   * mistaken for a drop.
   *
   * F-5 is the shape being avoided, verbatim from CLAUDE.md: "turn 'replacing a
   * live connection' and 'a real disconnect' into two separate things" — a deliberate teardown that reports itself
   * exactly like a failure and re-arms a reconnect ladder that then dials all by
   * itself. Three things keep them apart, and all three are mechanism, not
   * intention:
   *
   *  1. `closeEngine()` detaches the `error` handler BEFORE it awaits
   *     `engine.close()`. A ws close/error raised by our own teardown therefore
   *     cannot reach `ladder.handleEngineError` — it is not that we choose to
   *     ignore it, it is that nobody is listening any more.
   *  2. NOTHING is emitted. No `engine-status`, no `stt:error`, no frame. The
   *     session stays 「ready」 because 「ready」 answers 「can this session
   *     transcribe what you say next」 and the answer is still yes (R11: a status
   *     word must answer "what justifies saying so"). Emitting `reconnecting` here would be the
   *     lie — nothing is wrong and nothing is being retried.
   *  3. The dial is driven by AUDIO ARRIVING, never by a timer of its own. There
   *     is no self-dialling path to race the ladder with.
   *
   * ⚠️ IT FLUSHES FIRST (`flushAndCloseLeg`), and that is the whole reason this
   * is safe. Closing a streaming leg discards whatever the vendor has not yet
   * emitted; the flush is what turns it into text.
   *
   * ⚠️ It does NOT emit a server `final` and does NOT spend a `segment_idx`. A
   * pause is not a segment boundary — making it one would mint a row per pause
   * (book 15 §2.0-c). The text stays in the accumulators and leaves on the next real
   * boundary or on the terminal final.
   *
   * 🔴 THAT LAST SENTENCE IS ONLY TRUE BECAUSE CARD RT3-B LANDED FIRST. Before it,
   * `stop()`'s no-engine branch emitted `text: ''` unconditionally — so a hang-up
   * followed by a button release would have thrown the whole utterance away, and
   * RT-2 would have SHIPPED A NEW text-dropping PATH while looking like a billing
   * optimisation. The composition is pinned by a test of its own
   * (`stt-idle-hangup.test.ts`).
   */
  private beginHangUp(trigger: IdleHangupTrigger): void {
    if (this.hooks.isSettling() || !this.hooks.hasEngine()) return;
    if (this.hooks.isLegBusy() || this.hangUpWork !== null) return;
    this.trigger = trigger;
    this.hangUpWork = this.hangUp().finally(() => { this.hangUpWork = null; });
  }

  private async hangUp(): Promise<void> {
    this.clear();
    this.silentMs = 0;
    await this.hooks.flushAndCloseLeg();
    this.hungUp = true;
    // 🔴 card HANGUP-1 — the user started talking while this flush was out, so
    // those chunks went into the leg being closed and were rewound (see
    // `rewindToFlushBoundary`). Waiting for the NEXT accepted chunk to dial is
    // the RT-2 rule, and here it is wrong: that chunk may never come — a short
    // phrase and then quiet, or a release. The debt already exists, so dial now.
    // Still driven by audio (point 3 above): by audio that already arrived.
    if (this.hooks.voiceOwed()) this.noteVoice();
  }

  private async dial(): Promise<void> {
    const ok = await this.hooks.dialLeg();
    // Either way the hang-up is over: on success a leg is attached, and on
    // failure the LADDER owns recovery. Leaving the flag set on failure would let
    // the next chunk dial concurrently with a ladder rung — two dialers, one leg.
    this.hungUp = false;
    if (ok) this.arm();
  }
}
