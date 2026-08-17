// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness: soft segmentation 30s / 5-minute hard cap /
//     engine reconnect ladder / no silent failure), §3 (one instance per recording; soft-segment timer; 5s replay window;
//     spawn/flush timeout; interim = offlineAccum + onlineDraft concatenation; segment dedup-merge)
//   Ported from legacy stt/orchestrator.ts (mechanism unchanged, F-403/F-405/F-2044/
//     F-2050/F-2069/F-2100/F-2149/F-2152).
//
// One SttEngineOrchestrator per audio:start..audio:stop run. The EventEmitter
// engine driver: it owns the engine field + soft-segment timer + replay feed,
// composes an EngineSessionReconnectLadder, and emits interim/final/error/
// engine-status/auto-stopped. Named distinctly from the SttOrchestrator SEAM
// (engine/orchestrator.ts) which the audio handler consumes — the bridge in
// engine/stt-session.ts adapts this driver to that seam.

import { EventEmitter } from 'node:events';
import type { FinalResult, InterimShape } from './engines/base';
import { flushErrorVerdict } from './flush-error-verdict';
import type { AudioSession } from './audio/session';
import {
  DEFAULT_SOFT_SEGMENT_MS, DEFAULT_SOFT_SEGMENT_GRACE_MS, DEFAULT_REPLAY_WINDOW_MS,
  DEFAULT_ENGINE_SPAWN_TIMEOUT_MS, DEFAULT_ENGINE_FLUSH_TIMEOUT_MS,
  type OrchestratorOptions, type StartInput, type SttEngineFactory,
  type EngineSubscriber, type EngineHandlers,
} from './orchestrator-types';
import { seamText, SoftSegmentCadence } from './segment-boundary';
import { EngineSessionReconnectLadder, DEFAULT_BACKOFF_MS, type EngineSessionHooks } from './engine-session';
import { EngineIdleHangup, type IdleHangupHooks } from './engine-idle-hangup';
import { raceSpawnTimeout } from './spawn-timeout';
import { SttConfigMissingError } from './engine-router';
import { mergeOverlap, foldInterim, foldConfirmedWithDraft, bankDraftAcrossLegs } from './text-merge';
import { raceFlushFinal, resolveFlushTimeoutMs, feedVadClosureSilence, type FlushOutcome } from './flush-final';
import { noEngineTerminalText } from './terminal-final-text';
import { silentEmptyFinalError, noEngineReachedError, vendorNoAudioIsOurSilence } from './empty-final-verdicts';
import { coldOpenErrorVerdict } from './cold-open-verdict';

export * from './orchestrator-types';

export class SttEngineOrchestrator extends EventEmitter {
  private engine: EngineSubscriber | null = null;
  private currentSegmentIdx = 0;
  private segmentStartMs = 0;
  /** card SEG-1 — composed like {@link idle}/{@link ladder}: it owns the timer,
   *  both phases and `due`. Account: `stt/segment-boundary.ts`. */
  private readonly cadence: SoftSegmentCadence;
  private terminated = false;
  /** F-405 / W2.5-B: synchronous fence raised by BOTH terminal paths — hard-limit
   *  fan-out and stop() — before their closing flush begins. It means "this
   *  recording is now wrapping up, no more segment work", which is exactly as true of a button release as it
   *  is of the hard limit; stop() not raising it was an omission, not a
   *  distinction (see stop()). */
  private terminalizing = false; private terminalFinalEmitted = false;
  private rolloverWork: Promise<void> | null = null; private terminalWork: Promise<void> = Promise.resolve();
  /** true while awaiting engine.flush() — a flush-phase error is a one-shot stt:error, not a ladder trigger. */
  private flushing = false;
  private flushErrored = false;
  private startInput: StartInput | null = null;
  private boundHandlers: EngineHandlers | null = null;
  /** F-2044: true while mid-open(); a connect 'error' is owned by the spawn rejection, not the ladder. */
  private engineOpening = false;
  /** F-2069 offlineAccum: 2pass offline finals; F-2100 onlineDraft: live-VAD span. */
  private offlineAccum = '';
  private onlineDraft = '';
  /** REQ-14-01: declared shape of the leg whose interims built `onlineDraft`, captured at
   *  spawn (at ladder-respawn that leg is closed, `engine` null). Read only by the bank. */
  private legInterimShape: InterimShape | undefined;
  /**
   * card RT3-B — has the text CURRENTLY sitting in the accumulators already left
   * this server on some `final`?
   *
   * 🔴 It exists because the question `stop()`'s no-engine branch has to answer
   * is "has it gone out or not" and the old code answered "who called me" instead. See
   * {@link emitNoEngineTerminalFinal} for the whole account. It is a RECORDED
   * fact, not an inference: set where a final is actually emitted, cleared
   * wherever the accumulators take on content that final did not carry.
   */
  private accumEmittedByFinal = false;
  /** card RT-2 — the silence hang-up / voice redial lifecycle. Composed exactly as
   *  {@link ladder} is: it owns the countdown and the two transitions, this class
   *  owns the engine field and the accumulators. See engine-idle-hangup.ts. */
  private readonly idle: EngineIdleHangup;
  /** F-2152: highest chunk seq fed to an engine. ROLLOVER re-feeds only
   *  seq > this; at rollover it is re-armed to the pre-flush (finalized) boundary. */
  private lastEngineFedSeq = -1;
  /** Bytes actually handed to the CURRENT engine (live pushes + replay). Reset
   *  per engine session, because the question it answers is "has this particular
   *  engine ever received audio" — see {@link reportSilentEmptyFinal}. Deliberately NOT derived
   *  from `lastEngineFedSeq`: that counter is also advanced for chunks the VAD
   *  gate REFUSED to feed (so a replay does not re-inject them), i.e. it answers
   *  "has this seq been processed" and would report audio that never reached the vendor. */
  private engineFedBytes = 0;
  /** card fix-022 / G-23 — the two SESSION-wide byte facts. `voiceBytesCaptured`:
   *  bytes the feed gate ACCEPTED; `sessionFedBytes`: bytes actually handed to
   *  ANY engine (live pushes + replay). Neither is ever reset inside a run —
   *  that is the whole difference from {@link engineFedBytes} above, which is
   *  per-leg and would call a recovered session unheard. They are RECORDED at
   *  the sites that do the accepting and the handing over, never inferred; the
   *  rule they feed, and everything they must not be used for, lives in
   *  {@link noEngineReachedError}. */
  private voiceBytesCaptured = 0;
  private sessionFedBytes = 0;
  private readonly ladder: EngineSessionReconnectLadder;
  /** card RT-3 — the longest the reconnect ladder can possibly spend before it
   *  either recovers or gives up: the SUM of its own backoff rungs. Audio that
   *  no engine has heard is held for this long BEYOND the replay window, and no
   *  longer. 🔴 It is READ FROM THE SCHEDULE, not chosen — "tuning a new number
   *  with no measurement behind it" is the mistake this whole card exists to not repeat. */
  private readonly unfedGraceMs: number;
  private readonly replayWindowMs: number;
  private readonly engineSpawnTimeoutMs: number;
  private readonly engineFlushTimeoutMs: number;
  private readonly engineFlushTimeoutExplicit: boolean; // streaming 5s floor only for the DEFAULT cap.
  private readonly now: () => number;
  private readonly shouldFeedEngine: (c: { seq: number; ts_ms: number; payload: Buffer }) => boolean;
  private readonly _setTimeout: (fn: () => void, ms: number) => unknown;
  private readonly _clearTimeout: (handle: unknown) => void;
  private readonly onSessionAutoStopped = (r: 'hard_limit'): void => {
    if (this.terminated || this.terminalizing) return;
    this.terminalizing = true;
    this.terminalWork = Promise.resolve().then(() => this.handleAutoStop(r));
  };
  /**
   * 🔴 card N1-B4 — the engine-session ceiling fired and the RECORDING CONTINUES:
   * new leg, no banner, the phone's FSM never leaves RECORDING. `AudioSession`
   * already decided this is `engine_session` and not `quota_budget` (N1-B1).
   *
   * ⚠️ IT ROLLS THROUGH `rolloverSegment`, IT DOES NOT INVENT A SECOND RECYCLE —
   * that method owns the four seam facts (pre-flush seq gate F-2152, pre-flush
   * clock N1-B1, replay into the new leg, flush-first ordering) whose drift
   * already cost a real dropped-content incident (W2.5-B/FB-6). A rollover
   * ALREADY IN FLIGHT satisfies the ceiling (a second would put two flushes on
   * one engine); skipped while hung up for silence (RT-2 — no leg to recycle).
   *
   * card SEG-4: `deliver: false` — the ceiling is an ENGINE fact, so it rotates
   * the leg and mints nothing. Before this card it delivered a row here, i.e.
   * the vendor's session limit could end the user's sentence.
   */
  private readonly onEngineSessionExpired = (): void => {
    if (this.terminated || this.terminalizing) return;
    if (this.rolloverWork || this.idle.isBusy || !this.engine) return;
    this.rolloverWork = this.rolloverSegment(false).finally(() => { this.rolloverWork = null; });
  };
  constructor(
    private readonly session: AudioSession,
    private readonly engineFactory: SttEngineFactory,
    options: OrchestratorOptions = {},
  ) {
    super();
    this.cadence = new SoftSegmentCadence(
      options.softSegmentMs ?? DEFAULT_SOFT_SEGMENT_MS,
      options.softSegmentGraceMs ?? DEFAULT_SOFT_SEGMENT_GRACE_MS,
      { setTimeout: (fn, ms) => this._setTimeout(fn, ms), clearTimeout: (h) => this._clearTimeout(h),
        hasEngine: () => this.engine !== null, rotateLeg: () => this.startRollover(false),
        isFinished: () => this.terminated || this.terminalizing });
    this.replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.unfedGraceMs = (options.reconnectBackoffMs ?? DEFAULT_BACKOFF_MS).reduce((a, b) => a + b, 0);
    this.engineSpawnTimeoutMs = options.engineSpawnTimeoutMs ?? DEFAULT_ENGINE_SPAWN_TIMEOUT_MS;
    this.engineFlushTimeoutMs = options.engineFlushTimeoutMs ?? DEFAULT_ENGINE_FLUSH_TIMEOUT_MS; this.engineFlushTimeoutExplicit = options.engineFlushTimeoutMs !== undefined;
    this.now = options.now ?? Date.now;
    this.shouldFeedEngine = options.shouldFeedEngine ?? ((): boolean => true);
    this._setTimeout = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const hooks: EngineSessionHooks = {
      spawnEngine: () => this.spawnEngine(), closeEngine: () => this.closeEngine(),
      replayBufferTail: () => this.replayBufferTail(), currentEngineId: () => this.engine?.id ?? 'unknown',
      emitStatus: (p) => this.emit('engine-status', p), emitError: (p) => this.emit(vendorNoAudioIsOurSilence(p.code, this.voiceBytesCaptured) ? 'error-suppressed' : 'error', p), // ENG-4: this class holds the only copy of that counter; rule + production trace + why this is not a silent failure are all on the verdict, and `error-suppressed` is logged by engine/stt-session.ts
      clearSoftSegmentTimer: () => this.cadence.clear(), isTerminated: () => this.terminated,
    };
    this.ladder = new EngineSessionReconnectLadder(hooks, {
      ...(options.reconnectBackoffMs !== undefined ? { reconnectBackoffMs: options.reconnectBackoffMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      setTimeoutFn: this._setTimeout, clearTimeoutFn: this._clearTimeout,
    });
    const idleHooks: IdleHangupHooks = {
      hasEngine: () => this.engine !== null,
      isSettling: () => this.terminated || this.terminalizing,
      // A rollover or a terminal flush already owns this leg. `flushing` is in
      // here too: a flush in progress IS the leg being used.
      isLegBusy: () => this.rolloverWork !== null || this.flushing,
      flushAndCloseLeg: () => this.flushAndCloseLegForSilence(),
      dialLeg: () => this.dialLeg(),
    };
    // card RT-2: opt-IN (0 = never) — see OrchestratorOptions.idleHangupMs for why
    // the orchestrator is TOLD rather than left to infer it from the VAD gate.
    this.idle = new EngineIdleHangup(idleHooks, options.idleHangupMs ?? 0, this._setTimeout, this._clearTimeout);
  }

  async start(input: StartInput): Promise<void> {
    if (this.engine) throw new Error('SttEngineOrchestrator.start: already started');
    this.startInput = input;
    this.segmentStartMs = this.now();
    this.currentSegmentIdx = 0;
    this.cadence.reset(); // card SEG-1 — a fresh recording is never already due
    this.offlineAccum = '';
    this.onlineDraft = '';
    this.accumEmittedByFinal = false;
    this.lastEngineFedSeq = -1;
    this.engineFedBytes = 0; this.voiceBytesCaptured = 0; this.sessionFedBytes = 0;
    this.session.on('auto_stopped', this.onSessionAutoStopped);
    this.session.on('engine_session_expired', this.onEngineSessionExpired); // card N1-B4
    // no implicit fallback #16: an unreachable engine surfaces a terminal error → engine-status{failed} + stt:error, so audio:start acks fail.
    // 🔴 card K-7 CORRECTION — the ROUTER's SttConfigMissingError is rethrown UNSPOKEN below, and this line used to end "propagates raw (audio.handler maps it)", which cannot be true: the BRIDGE fires start() and forgets it (stt-session.ts `.catch`), so by the time this rejects, audio.handler has already answered `safeAck(ack,{ok:true})`. Nothing maps it.
    // Its answer is now SttSessionBridge.onColdOpenRejection, which is the exact COMPLEMENT of the `instanceof` rethrow below — keep them complementary or a cold-open failure gets narrated twice.
    // card ENG-2 (fix-029): STT_NETWORK_DROP is the FALLBACK only — an engine that
    // NAMED its open failure (e.g. sherpa-local's STT_CONFIG_MISSING for a
    // missing addon/model) keeps its code + message; see cold-open-verdict.ts.
    try {
      await raceSpawnTimeout(this.spawnEngine(), this.engineSpawnTimeoutMs, this._setTimeout, this._clearTimeout);
    } catch (err) {
      this.session.off('auto_stopped', this.onSessionAutoStopped);
      this.session.off('engine_session_expired', this.onEngineSessionExpired);
      if (err instanceof SttConfigMissingError) throw err;
      this.emit('engine-status', { provider: (this.engine as EngineSubscriber | null)?.id ?? 'unknown', status: 'failed' });
      this.emit('error', coldOpenErrorVerdict(err));
      throw err;
    }
    this.replayBufferTail(true); // feed chunks buffered during the cold-open spawn
    this.cadence.arm();
    this.emit('engine-status', { provider: this.engine!.id, status: 'ready' });
  }

  pushChunk(c: { seq: number; ts_ms: number; payload: Buffer }): void {
    if (this.terminated || this.terminalizing) return;
    // F-2149: feed each seq AT MOST ONCE — a reconnect replays already-delivered
    // seqs; an observed seq is dropped, a never-seen gap-fill still flows.
    if (this.session.seq.hasObserved(c.seq)) return;
    // 🔴 card RT-2 — the voice came back ⇒ dial the leg. This runs BEFORE the
    // retention pin below and that order is the mechanism, not tidiness:
    // `replayStillOwed()` reads `idle.isDialing`, so setting it first is what stops
    // the ring from evicting the very chunks the new leg will be replayed.
    //
    // ⚠️ The trigger is a chunk THE GATE ACCEPTS, not any chunk. The phone
    // streams continuously — silence included — so "audio arrived" would dial
    // straight back into the silence we just hung up on.
    if (this.idle.isHungUp && this.shouldFeedEngine(c)) this.idle.noteVoice();
    // card RT-3: set the ring's retention pin BEFORE the push prunes it. While an
    // engine is live `lastEngineFedSeq` IS the newest seq, so the pin is inert
    // and the window behaves exactly as it always has (no memory cost, no
    // latency, common path untouched). While one is being reconnected — or is
    // mid-rollover — it is what stops the 5 s window from evicting audio that no
    // engine has been given. Released once nothing will ever replay again, so a
    // ladder that has given up cannot pin the ring for the rest of the session.
    this.session.setRetentionPin(
      this.replayStillOwed() ? this.lastEngineFedSeq : Number.POSITIVE_INFINITY,
      this.unfedGraceMs,
    );
    this.session.pushChunk(c);
    // AudioSession owns the hard-limit boundary; never leak a rejected boundary
    // chunk into the engine.
    if (this.terminalizing || !this.session.seq.hasObserved(c.seq)) return;
    // VAD gate (master-plan §2.3): silence is buffered (above) but NOT pushed to
    // a metered streaming engine → it never accrues billed session time. The seq
    // is still marked fed so a replay/rollover won't re-inject it.
    //
    // 🔴 card RT-2 MOVED THIS OUT of the `engine !== null` block, and the move is a
    // fix, not a tidy-up. The gate answers "is this audio worth sending to the vendor" — a question
    // whose answer does not depend on whether a leg happens to be attached right
    // now. Inside the block, silence arriving with NO leg (hung up, mid-redial,
    // or a ladder rung in flight) stayed unmarked, and RT-3's retention pin
    // deliberately keeps unmarked audio "whatever its age" ⇒ the next leg was
    // replayed the ENTIRE silence, unbounded by the 5 s window. RT-2 makes that
    // routine (every pause), but the ladder could already reach it.
    const feed = this.shouldFeedEngine(c);
    // 🔴 card SEG-1/SEG-4 — THE ONE PLACE A ROW IS ENDED (timers only rotate
    // legs now). On the CHUNK path, not in the engine's `final` handler: that
    // handler runs inside the vendor adapter's callback and a rollover issues
    // `engine.flush()`, i.e. it would re-enter the adapter from its own event.
    // ~200 ms chunks ⇒ one chunk of latency, every cut on a stack we own.
    // `feed` is passed, not re-derived (one gate reading per chunk); the cadence
    // owns the silence RUN too (SEG-3) — measured, not one instant reading.
    if (this.cadence.shouldCut(feed, this.now(), this.offlineAccum)) this.startRollover(true);
    if (!feed) { this.lastEngineFedSeq = Math.max(this.lastEngineFedSeq, c.seq); return; }
    // card fix-022 / G-23: the gate just said this audio is worth sending, so this
    // is the ONE site that can record "the user really did speak" — and it is the same
    // predicate the feed below consults, which is what stops the two from ever
    // becoming different opinions about what counts as speech.
    this.voiceBytesCaptured += c.payload.length;
    if (this.engine && this.engine.state === 'open') {
      try { this.engine.push(c.payload, c.ts_ms); this.engineFedBytes += c.payload.length; this.sessionFedBytes += c.payload.length; this.lastEngineFedSeq = Math.max(this.lastEngineFedSeq, c.seq); this.idle.arm(); } catch (err) { console.error('[SttEngineOrchestrator] pushChunk engine.push error (reconnect ladder will handle):', err); }
    }
  }

  /**
   * 🔴 W2.5-B: "one segment_idx may have only one server final".
   *
   * This used to be the ONE terminal path that neither raised the
   * `terminalizing` fence nor awaited an in-flight `rolloverWork`, while
   * {@link handleAutoStop} (then named `handleHardLimit`) did both. So a release landing
   * inside a soft-segment rollover's flush emitted its terminal final under a
   * `currentSegmentIdx` the rollover had not incremented yet. The phone adopts
   * a final PER index: same idx ⇒ revision ⇒ REPLACE ⇒ a whole finalized
   * segment left the transcript with nothing anywhere reporting a failure
   * (FB-6, dropped content). The fix is the neighbouring function.
   *
   * ⚠️ THE ORDER IS THE MECHANISM, not tidiness. Raising the fence BEFORE the
   * await makes the in-flight rollover bail at its FIRST fence check: it never
   * reaches `closeEngine()` and never reaches `await this.spawnEngine()`. So
   * this await is bounded by the remaining time on the flush the rollover had
   * ALREADY issued (≤ one flush cap — 3s, or 5s for funasr/funspeech), instead
   * of by the round trip of opening a brand-new vendor connection only to close
   * it one line later. A bare `await this.rolloverWork` without the fence would
   * do exactly that.
   *
   * ⚠️ Common path is untouched: with no rollover in flight the branch below is
   * not taken and not even the extra `await` runs.
   */
  async stop(): Promise<void> {
    if (this.terminated || this.terminalizing) return;
    this.terminalizing = true;
    this.cadence.clear();
    this.idle.clear();
    this.ladder.clearReconnectTimer();
    if (this.rolloverWork) {
      try { await this.rolloverWork; } catch { /* the rollover's own path handles its cleanup */ }
      // A rollover that had already passed every fence check re-armed the soft
      // timer and spawned its next engine before we got here.
      this.cadence.clear();
      this.idle.clear();
      this.ladder.clearReconnectTimer();
    }
    // card RT-2: same reason the rollover is awaited — a hang-up or a redial that
    // is already past its fence owns this leg, and two flushes on one engine is
    // not a thing. The fence above is raised FIRST, so neither can START now.
    //
    // 🔴 THE `if` IS LOAD-BEARING, exactly as it is for `rolloverWork` above, and
    // this method's own doc already said why: "with no rollover in flight the
    // branch below is not taken and NOT EVEN THE EXTRA `await` RUNS". Making it
    // unconditional costs one microtask turn on the common path, and that turn
    // moves the terminal flush's timer registration to AFTER the caller's
    // `clock.advance()` has finished scanning — measured, not reasoned:
    // stt-seam-duplication.test.ts went 10 red with "Test timed out in 5000ms"
    // and NOT ONE assertion failure, because the flush timer was armed at a fake
    // time nobody would ever advance past.
    if (this.idle.isBusy) await this.idle.settle();
    if (!this.engine) { this.emitNoEngineTerminalFinal(); this.terminated = true; return; }
    feedVadClosureSilence(this.engine, this.now());
    // The terminal flush is issued even when the rollover's flush had just timed
    // out. Skipping it to save a cap would trade dropped content for latency: audio pushed
    // after that flush was issued sits inside the engine and only a flush
    // retrieves it. The cost of not skipping is latency ONLY — `getOfflineText`
    // is late-bound (flush-final.ts), so a terminal flush that also times out
    // still settles on every word the rollover's flush had confirmed.
    await this.flushAndEmitFinal(false, this.segmentDurationMs());
    await this.closeEngine();
    this.terminated = true;
  }

  async close(): Promise<void> {
    this.terminated = true;
    this.cadence.clear();
    this.idle.clear();
    this.ladder.clearReconnectTimer();
    this.session.off('auto_stopped', this.onSessionAutoStopped);
    this.session.off('engine_session_expired', this.onEngineSessionExpired);
    if (this.engine) await this.closeEngine();
    this.removeAllListeners();
  }

  /** Resolves after the auto-stop closing final and engine close settle
   *  (see {@link handleAutoStop} for what still counts as an auto-stop). */
  waitForTerminal(): Promise<void> { return this.terminalWork; }

  /** card SEG-1 — at most one rollover in flight; the ONE place a cut verdict
   *  becomes work. `deliver` carries whether this is a ROW ending or only a LEG
   *  (card SEG-4). Policy + full account: `stt/segment-boundary.ts`. */
  private startRollover(deliver: boolean): void {
    if (this.rolloverWork || this.terminated || this.terminalizing || !this.engine) return;
    this.rolloverWork = this.rolloverSegment(deliver).finally(() => { this.rolloverWork = null; });
  }

  /**
   * card RT-2 hook — flush the leg, keep every word it had, then close it.
   *
   * ⚠️ The flush result IS `foldConfirmedWithDraft(offlineAccum, onlineDraft)` on
   * every branch of `raceFlushFinal` but one — the timeout branch, which returns
   * a captured final that CONTAINS it as a prefix, i.e. strictly more. So the
   * assignment below can only preserve or extend; it can never shorten.
   *
   * ⚠️ `accumEmittedByFinal` is deliberately NOT touched (card RT3-B). The engine's
   * own `final` handler already cleared it if new text arrived, and clearing it
   * here unconditionally would re-send text a segment final had already carried —
   * the exact duplication that branch exists to prevent.
   */
  private async flushAndCloseLegForSilence(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    feedVadClosureSilence(engine, this.now());
    this.flushErrored = false; this.flushing = true;
    const { result } = await this.flushFinal();
    this.flushing = false;
    if (this.terminated) return;
    this.offlineAccum = result.text; this.onlineDraft = '';
    await this.closeEngine();
  }

  /**
   * card RT-2 hook — dial the leg back because audio is here again.
   *
   * ⚠️ The spawn is capped by `raceSpawnTimeout`, unlike the ladder's reconnect
   * (RT3-C: "the reconnect path has no spawn timeout", an OPEN account this card does not close
   * because changing the ladder's timing is a product ruling). This is a NEW path,
   * so it gets the cap the cold open already has and inherits no debt.
   *
   * Returns false when the dial failed and the LADDER has taken over, so recovery
   * has exactly one owner.
   */
  private async dialLeg(): Promise<boolean> {
    try {
      await raceSpawnTimeout(this.spawnEngine(), this.engineSpawnTimeoutMs, this._setTimeout, this._clearTimeout);
    } catch (err) {
      if (!this.terminated && !this.terminalizing) this.ladder.handleEngineError(err as Error);
      return false;
    }
    if (this.terminated || this.terminalizing) { await this.closeEngine(); return false; }
    this.engineFedBytes = 0; // a fresh leg has been handed nothing yet
    this.replayBufferTail(true); // gated: only what no engine has heard
    return true;
  }

  /**
   * card SEG-4 — ONE method, TWO meanings, told apart by `deliver`:
   * `true` = the row ends HERE (a boundary `segmentCutDecision` defended): flush
   * → emit `is_segment` final → spend the index → fresh leg. `false` = only the
   * ENGINE LEG's span expired (cadence phase 2 / N1-B4): flush →
   * `seamText(…, 'leg')` → bank into `offlineAccum` (RT-2's own fold, see
   * `flushAndCloseLegForSilence`) → fresh leg; nothing reaches the wire and the
   * row keeps growing across the seam. One method, not two: the F-2152/N1-B1
   * seam facts are identical in both, and two copies is how they drift apart.
   */
  private async rolloverSegment(deliver: boolean): Promise<void> {
    if (this.terminated || this.terminalizing || !this.engine) return;
    // F-2152: chunks fed during the flush round-trip aren't in segment N's final;
    // re-arm the gate to this PRE-flush boundary so the seam carries.
    const finalizedSeq = this.lastEngineFedSeq;
    // card N1-B1: ONE instant is the segment boundary, and both gates are read off
    // it — the seq gate above (F-2152) and the clock anchor below. Taken BEFORE
    // the flush for the same reason `finalizedSeq` is: audio arriving during the
    // flush round trip belongs to the NEXT segment, so the round trip must not
    // land inside the segment that is closing.
    const boundaryMs = this.now();
    if (!deliver) {
      this.flushErrored = false; this.flushing = true;
      const { result } = await this.flushFinal();
      this.flushing = false;
      if (this.terminated) return;
      // The bank; `accumEmittedByFinal` stays false — no wire final carried this.
      this.offlineAccum = seamText(result.text, 'leg');
      this.onlineDraft = '';
      if (this.terminalizing) return; // stop() settles from the bank
      await this.closeEngine();
      if (this.terminated || this.terminalizing) return;
      this.lastEngineFedSeq = finalizedSeq;
      this.engineFedBytes = 0;
      await this.spawnEngine();
      this.replayBufferTail(true);
      return; // the cadence re-arms its own leg timer; `due` stays raised
    }
    const emitted = await this.flushAndEmitFinal(true, boundaryMs - this.segmentStartMs);
    if (this.terminated) return;
    // W2.5-B: both fence checks spend the index the same way ("once it's sent
    // out, spend that number"). CRITERION, so nobody burns an afternoon testing
    // it: today this branch cannot be reached with `emitted === true` — no yield
    // point sits between flushAndEmitFinal's own fence check and this one, so
    // `terminalizing` here implies `emitted === false`. Written the safe way for
    // the day someone adds an await in between. REVERSE CONTROL (2026-08-07,
    // dev-pc-a): reverting this line leaves all 21 tests green — honest result,
    // reason above; not a hole in stt-terminal-rollover-collision.test.ts.
    if (this.terminalizing) { if (emitted) this.beginNextSegment(boundaryMs); return; }
    await this.closeEngine();
    if (this.terminated) return;
    if (this.terminalizing) { if (emitted) this.beginNextSegment(boundaryMs); return; }
    this.beginNextSegment(boundaryMs);
    this.offlineAccum = '';
    this.onlineDraft = '';
    this.lastEngineFedSeq = finalizedSeq;
    this.engineFedBytes = 0; // a fresh engine has been handed nothing yet
    await this.spawnEngine();
    this.replayBufferTail(true);
    this.cadence.arm();
  }

  /**
   * 🔴 card N1-B1 — spend the index and re-anchor the segment clock TOGETHER.
   * They used to move in different places (index at the fence returns, clock
   * only on the path that opens the next engine), so a release landing on a
   * fence spent idx N with the clock still at N-1's start ⇒ the terminal final
   * reported the settled segment's 30 s a second time — under book 15 §2.0-c a
   * second ROW claiming the same seconds. One method now (W2.5-B's shape:
   * "the same fact handled once in each of two places"), so no drift.
   */
  private beginNextSegment(boundaryMs: number): void {
    this.currentSegmentIdx += 1;
    this.segmentStartMs = boundaryMs;
    // card SEG-1 — the third fact that means "a new segment is open", moved
    // here with the other two so they cannot drift apart (that WAS N1-B1).
    this.cadence.reset();
  }

  /**
   * 🔴 card N1-B1 — the narrowing. This used to be `handleHardLimit`, and the name
   * was the whole problem: it read as "time's up" and it fired for two facts that
   * want opposite handling.
   *
   * What it means NOW: "this recording must actually end" — the resource/quota/abnormal set of
   * design §2.3. "time's up" is no longer one of its meanings; it is a property of
   * the ENGINE session, and card N1-B4 turns that one into a rollover the user
   * never sees. Which of the two arrived is {@link HardLimitOrigin}, read from
   * the session because the clamp is where the difference is otherwise lost.
   *
   * ⚠️ ZERO behaviour change here, deliberately: both origins still end the
   * recording exactly as before, because the rollover is N1-B4's — the highest
   * risk change in the design and scheduled alone. What this card delivers is
   * that when B4 arrives, the branch it needs has a fact to branch on. Without
   * it, B4's only available reading is "a hard limit fired" ⇒ it would roll a
   * user who is OUT OF MINUTES into a fresh engine session and bill them past
   * their budget, with the wall reporting nothing.
   *
   * ⚠️ `limit_origin` does not reach the wire and must not be assumed to: the
   * bridge (`engine/stt-session.ts` `onAutoStopped`) emits a hardcoded
   * `audio:auto-stopped{reason:'hard_limit'}` and reads no payload. Widening
   * `AudioAutoStoppedSchema`'s closed enum is an owner gate; this card does not
   * touch it and does not pretend the phone can tell the two apart yet.
   */
  private async handleAutoStop(reason: 'hard_limit'): Promise<void> {
    this.emit('auto-stopped', { reason, limit_origin: this.session.limitOrigin });
    this.cadence.clear(); this.idle.clear(); this.ladder.clearReconnectTimer();
    if (this.rolloverWork) { try { await this.rolloverWork; } catch { /* terminal path handles cleanup */ } }
    if (this.idle.isBusy) await this.idle.settle(); // card RT-2, and the `if` is load-bearing — see stop()
    if (!this.engine) { this.emitNoEngineTerminalFinal(); this.terminated = true; return; }
    await this.flushAndEmitFinal(false, this.segmentDurationMs());
    await this.closeEngine();
    this.terminated = true;
  }

  /**
   * 🔴 card N1-B1 — the ONE question `duration_ms` answers, on BOTH exits: "how
   * long is this segment".
   *
   * It used to answer two. The soft-segment exit passed `now - segmentStartMs`
   * and BOTH terminal exits passed `now - sessionStartMs`, so the same wire field
   * meant "this segment" on one final and "the whole utterance" on the next.
   * That was internally consistent while a whole utterance settled as ONE row:
   * the phone assembled every segment into one entry and read the duration off
   * the terminal final only. book 15 §2.0-c ends that — "one segment (segment_idx) = one row"
   * — and under it the old shape double-counts: a 10-minute recording mints ~20
   * rows of 30 s each PLUS a last row claiming 600 s, and the desktop stats tile
   * sums rows (`entry-metrics.ts` rowDurationMs).
   *
   * ⚠️ Not a bug fix — a contract change. Read the two directions before shipping:
   *  · new relay + OLD phone (settles only on the terminal final): a >30 s
   *    utterance's single row under-reports its duration. No text is lost.
   *  · new phone + OLD relay: every per-segment row claims the whole session's
   *    duration. No text is lost. Both degrade a number, neither drops a word —
   *    which is why this may ship ahead of N1-B2, though shipping them together
   *    is what keeps the number right.
   *
   * ⚠️ It cannot reach billing: the STT meter is settled from `totalAudioMs` /
   * `vad.sessionMs` in the bridge's `settle()`, never from a final's payload.
   *
   * ✅ CLOSED by card N1-B1b (`031660c`) — this block used to read "OPEN ACCOUNT …
   * it is reported, not done here", and every clause of it went false the moment
   * that card landed in a lane this one may not touch. Corrected in place rather
   * than deleted, because the account was real and the fix it PROPOSED was wrong:
   *
   * The account: the bridge's `kickRefine` passed this same number to
   * `shouldRefine`, whose floor is "only re-transcribe an utterance of at least N
   * seconds" while `RetainedAudio` holds the WHOLE utterance ⇒ a per-segment
   * duration made that gate read one segment and judge the whole. Real defect:
   * release a few seconds past a rollover and refine silently never ran, on
   * exactly the long recordings GA-14 exists to improve.
   *
   * 🔴 Why the replacement proposed here was REJECTED — keep this, or it will be
   * proposed again: `totalAudioMs` counts every byte the phone offered, INCLUDING
   * bytes `RetainedAudio` refused (cap) and replayed reconnect chunks. On an
   * overflowed buffer it would clear the floor and then hand `take()` an empty
   * buffer — re-creating the very "the gate judges something other than what it
   * bills" shape it was meant to close. The number that cannot disagree with
   * `take()` is the retained buffer's own length, and that is what shipped.
   *
   * ⚠️ Nothing here reads a final's `duration_ms` for that decision any more, so
   * this method is once again free to mean only what its name says.
   */
  private segmentDurationMs(): number { return this.now() - this.segmentStartMs; }

  private async flushAndEmitFinal(isSegment: boolean, durationMs: number): Promise<boolean> {
    this.flushErrored = false; this.flushing = true;
    const { result: r, timedOut } = await this.flushFinal();
    this.flushing = false;
    if (this.terminated || (isSegment && this.terminalizing)) return false;
    if (this.flushErrored && r.text === '') return false; // no empty final on a flush error
    this.reportSilentEmptyFinal(r.text, timedOut);
    // card RT3-B: every final emitted below carries the accumulators out — see
    // `raceFlushFinal`, whose result text IS `getOfflineText()` on every branch
    // but one (timeout + a captured final that CONTAINS it as a prefix, i.e.
    // strictly more). Recording it here rather than at the two emit sites keeps
    // the fact in one place; {@link emitNoEngineTerminalFinal} is its only reader.
    this.accumEmittedByFinal = true;
    if (!isSegment) return this.emitTerminalFinal(r, durationMs);
    // 🔴 card SEG-3 — the one place a segment's text leaves this class, so the one
    // place a full stop the SPAN produced (not the speaker) can be taken back off.
    this.emit('final', {
      text: seamText(r.text, this.cadence.lastCutReason), confidence: r.confidence, language: r.language,
      segment_idx: this.currentSegmentIdx, is_segment: isSegment, duration_ms: durationMs,
    });
    return true;
  }

  /** 🔴 No silent failure, the flush-cap half. The rule, the L9 finding it came from and
   *  why each of its three conditions exists moved VERBATIM to
   *  {@link silentEmptyFinalError} (800-line cap, card fix-022) — behaviour
   *  unchanged, only the emit stayed behind. */
  private reportSilentEmptyFinal(text: string, timedOut: boolean): void {
    const err = silentEmptyFinalError(this.engineFedBytes, text, timedOut);
    if (err) this.emit('error', err);
  }

  /**
   * 🔴 card RT3-B — the ONE no-engine terminal exit, shared by `stop()` and
   * {@link handleAutoStop}. Two copies of this branch is how they drift apart.
   *
   * Contract: docs/rebuild/15 §2.0-d (edited BEFORE this code, per that
   * document's §5 change discipline — it changes final-transcript semantics).
   * The rule, its evidence and everything it must never be extended to do live
   * in {@link noEngineTerminalText}; this method is only the wiring.
   */
  private emitNoEngineTerminalFinal(): void {
    const text = noEngineTerminalText(this.accumEmittedByFinal, this.offlineAccum, this.onlineDraft, foldConfirmedWithDraft);
    this.emitTerminalFinal({ text, confidence: 0, language: this.startInput?.language ?? '' }, this.segmentDurationMs());
  }

  /**
   * 🔴 card fix-022 / G-23 asks its verdict HERE, and the site is the point: this
   * is the one place EVERY terminal exit passes through — `stop()` and
   * {@link handleAutoStop}, with an engine to flush and without one — behind a
   * latch that already guarantees once per recording. Asking it at the two
   * callers instead would be two copies of "this recording has ended, we owe the user some kind of statement",
   * which is how they drift apart (the shape card RT3-B closed one method over).
   *
   * ⚠️ The error goes out BEFORE the final, exactly as `reportSilentEmptyFinal`'s
   * does. It is safe in this order for a reason the verdict itself guarantees:
   * it only fires when the transcript is empty, so a phone that closes
   * PROCESSING on `retryable:false` cannot lose text by acting on it first.
   */
  private emitTerminalFinal(r: Pick<FinalResult, 'text' | 'confidence' | 'language'>, durationMs: number): boolean {
    if (this.terminalFinalEmitted) return false; this.terminalFinalEmitted = true;
    const unheard = noEngineReachedError(this.voiceBytesCaptured, this.sessionFedBytes, r.text);
    if (unheard) this.emit('error', unheard);
    this.emit('final', { text: r.text, confidence: r.confidence, language: r.language, segment_idx: this.currentSegmentIdx,
      is_segment: false, duration_ms: durationMs }); return true;
  }

  /** 🔴 No silent failure, the flush-phase half. The rule, the L2 finding it came from
   *  and why an engine's own `retryable:false` survives the phase it arrived in
   *  moved VERBATIM to {@link flushErrorVerdict} (800-line cap) — behaviour
   *  unchanged, only the latch and the emit stayed behind. */
  private handleFlushError(err: Error): void {
    this.flushErrored = true;
    this.emit('error', flushErrorVerdict(err));
  }

  /**
   * 🔴 REQ-14-01 — a DEAD leg's cumulative draft becomes confirmed text before
   * the next leg starts, or the next leg's final erases it (`onlineDraft = ''`
   * in the `final` handler). Verdict, gate (declared-cumulative legs only) and
   * the duplication trade: {@link bankDraftAcrossLegs}; measurements:
   * `test/stt-outage-loss.test.ts` REQ-14-01 rows. Only the LADDER's respawn
   * arrives here with a non-empty draft (`start()`/`rolloverSegment()`/
   * `dialLeg()` clear or fold the accumulators before spawning).
   * ⚠️ `accumEmittedByFinal` deliberately untouched: the interims that built
   * the draft already cleared it and no final has run since (the leg died) —
   * the banked text is exactly "content no final has carried".
   */
  private bankCumulativeDraftFromDeadLeg(): void {
    const banked = bankDraftAcrossLegs(this.legInterimShape, this.offlineAccum, this.onlineDraft);
    if (banked !== null) { this.offlineAccum = banked; this.onlineDraft = ''; }
  }

  private async spawnEngine(): Promise<void> {
    if (this.engine) await this.closeEngine(); // never orphan a live engine on a stray double-spawn
    this.bankCumulativeDraftFromDeadLeg();
    const engine = this.engineFactory() as EngineSubscriber;
    const handlers: EngineHandlers = {
      // F-2100: monotonic-cumulative preview per segment_idx (client REPLACES).
      // 🔴 INT-2: WHICH fold is the ENGINE'S OWN DECLARATION, never a guess read
      // off the strings — measurement + argument in text-merge.ts `foldInterim`.
      interim: (e) => {
        if (this.terminated || this.terminalizing) return;
        this.onlineDraft = foldInterim(engine.interimShape, this.onlineDraft, e.text);
        this.accumEmittedByFinal = false; // card RT3-B: content no final has carried
        this.emit('interim', {
          text: this.offlineAccum + this.onlineDraft,
          confidence: e.confidence, language: e.language, segment_idx: this.currentSegmentIdx,
        });
      },
      // F-2069/F-2100: fold the offline final in, reset the draft. F-2152: mark
      // everything fed so far as finalized.
      final: (e) => {
        if (this.terminated || (this.terminalizing && !this.flushing)) return;
        this.offlineAccum = mergeOverlap(this.offlineAccum, e.text); this.onlineDraft = '';
        this.accumEmittedByFinal = false; // card RT3-B: ditto — an ENGINE final is not a SERVER final
      },
      // F-2044: attached BEFORE open() (connect error owned by spawn). Flush-phase error is one-shot, never the ladder.
      // 🔴 W2.5-B: `flushing` is answered BEFORE `terminalizing`, and the order
      // is load-bearing. It used to be the other way round, which stayed
      // invisible only because `terminalizing` was raised exclusively by the
      // hard-limit path — so "the engine threw an error inside the closing flush" was already being
      // dropped there, and nobody had chosen that. Now that stop() raises the
      // same fence, leaving `terminalizing` first would extend that silence to
      // EVERY button release (no silent failure). `flushing` is the narrower fact and
      // has its own one-shot handler; the phase an error arrived in does not
      // erase the error — the same argument handleFlushError already makes
      // about `retryable`.
      error: (e) => { if (this.engineOpening || this.terminated) return; if (this.flushing) return this.handleFlushError(e); if (this.terminalizing) return; this.ladder.handleEngineError(e); },
    };
    engine.on('interim', handlers.interim);
    engine.on('final', handlers.final);
    engine.on('error', handlers.error);
    this.engine = engine;
    this.legInterimShape = engine.interimShape; // REQ-14-01: remembered past this leg's death — see the field
    this.boundHandlers = handlers;
    if (typeof engine.open === 'function') {
      this.engineOpening = true;
      try {
        await engine.open();
      } catch (err) {
        await this.closeEngine();
        throw err;
      } finally {
        this.engineOpening = false;
      }
    }
    // 🔴 card RT-2 — ONE place, because there are FOUR ways a leg is born: the cold
    // open, a soft-segment rollover, a silence redial, and a LADDER RUNG (which
    // reaches `spawnEngine` through a hook and touches no other orchestrator
    // code). Arming at the call sites would have covered three of them and left
    // a reconnected session unable to ever hang up again — a hole with no symptom
    // except a bill. The rule is "a leg exists ⇒ the countdown runs".
    this.idle.arm();
  }

  private async closeEngine(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    if (this.boundHandlers) {
      engine.off('interim', this.boundHandlers.interim);
      engine.off('final', this.boundHandlers.final);
      engine.off('error', this.boundHandlers.error);
      this.boundHandlers = null;
    }
    this.engine = null;
    try { await engine.close(); } catch (err) { console.error('[SttEngineOrchestrator] closeEngine engine.close error:', err); }
  }

  /** flush race. offlineAccum + onlineDraft folded. Streaming default 5s floor
   *  via resolveFlushTimeoutMs (explicit cap wins).
   *
   *  🔴 W2/FB-6: the fold is `foldConfirmedWithDraft`, NOT `mergeOnlineDraft`.
   *  The two accumulators are disjoint spans (`onlineDraft` is cleared below
   *  whenever a final lands), so the revision/restatement branches of
   *  `mergeOnlineDraft` — which exist to pick between two hypotheses OF THE SAME
   *  span — were discarding confirmed speech here. This string is the terminal
   *  transcript, not a preview: see `flush-final.ts:104-109`. */
  private flushFinal(): Promise<FlushOutcome> {
    const tMs = resolveFlushTimeoutMs(this.engine?.id ?? '', this.engineFlushTimeoutMs, this.engineFlushTimeoutExplicit);
    return raceFlushFinal({ engine: this.engine, getOfflineText: () => foldConfirmedWithDraft(this.offlineAccum, this.onlineDraft), language: this.startInput?.language ?? '', timeoutMs: tMs, setTimeoutFn: this._setTimeout, clearTimeoutFn: this._clearTimeout });
  }

  /** card RT-3 — is any engine still expected to be handed audio? Live, mid-rollover,
   *  or a reconnect rung armed. Once all three are false the ladder has given up
   *  and no replay will ever happen, so holding unheard audio would only leak. */
  private replayStillOwed(): boolean {
    // card RT-2: `idle.isDialing` — and NOT `idle.isHungUp` — is the fourth term.
    // While the leg is hung up and the user is quiet nothing is owed a replay,
    // so the ring must be free to prune the silence; the debt begins the instant
    // a chunk the gate accepts starts a redial, and lasts until it is fed.
    return this.engine !== null || this.rolloverWork !== null
      || this.idle.isDialing || this.ladder.hasPendingReconnect();
  }

  /// Re-feed buffered tail: RECONNECT (gateUnfed=false) full 5s; ROLLOVER (true) seq>lastFed.
  private replayBufferTail(gateUnfed = false): void {
    if (!this.engine || this.terminated || this.terminalizing) return;
    // card M3-4b: the window is measured on the RECEIVE clock, by the session that
    // stamped it — never `this.now()` against the phone's `ts_ms`. `chunk.ts_ms`
    // below is deliberately untouched: the engine wants CAPTURE order, and that
    // is the one question the phone's clock is the right answer to.
    // card RT-3, the READ half. The window still decides how much ALREADY-FED audio
    // is re-offered for context (so the duplication exposure measured in CASE 3
    // is unchanged, deliberately — owner already chose duplication over dropped content). What is
    // added is every chunk NO engine has heard, whatever its age: a window may
    // not decide whether unheard speech is delivered.
    const tail = this.session.replayTail(this.replayWindowMs, this.lastEngineFedSeq);
    let fed = 0;
    for (const chunk of tail) {
      if (gateUnfed && chunk.seq <= this.lastEngineFedSeq) continue;
      try { this.engine.push(chunk.payload, chunk.ts_ms); this.engineFedBytes += chunk.payload.length; this.sessionFedBytes += chunk.payload.length; this.lastEngineFedSeq = Math.max(this.lastEngineFedSeq, chunk.seq); fed += 1; } catch (err) { console.error('[SttEngineOrchestrator] replayBufferTail engine.push error (will surface via reconnect):', err); }
    }
    // card RT-2: replayed bytes are bytes the vendor received, so they restart the
    // silence countdown for the same reason a live push does.
    if (fed > 0) this.idle.arm();
  }
}
