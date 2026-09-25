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
import { legAudioBudgetMs, SoftSegmentCadence } from './segment-boundary'; import { flushAndEmitFinal, type FlushEmitHost } from './orchestrator-flush'; // D-14
import { FunasrSpanClosureFeeder } from './funasr-span-closure';
import { recheckQuotaOnLegBirth } from './quota-recheck';
import { retentionFloorSeq, answeredFloorSeq, unfedGraceMsFor } from './replay-debt'; import { HeardAudioLedger } from './heard-audio'; import { gateOpenPreroll, type GatePrerollHost } from './gate-preroll'; // RC-L / RC-Q / RC-T
import { EngineSessionReconnectLadder, DEFAULT_BACKOFF_MS, DEFAULT_MAX_RETRIES, engineReconnectWorstCaseMs, type EngineSessionHooks, type SpawnAttempt } from './engine-session';
import { EngineIdleHangup, type IdleHangupHooks } from './engine-idle-hangup';
import { raceSpawnTimeout } from './spawn-timeout'; import { openLeg, type SpawnOpenHost } from './orchestrator-spawn';
import { SttConfigMissingError } from './engine-router';
import { foldInterim, foldConfirmedWithDraft, bankDraftAcrossLegs } from './text-merge';
import { replayIntoLeg, type ReplayIntoLegHost } from './orchestrator-replay';
import { startRollover, runRollover, flushAndCloseLegForSilence, dialLeg, type RolloverHost } from './orchestrator-rollover';
import { raceFlushFinal, resolveFlushTimeoutMs, localFlushRefusalError, networkFlushRefusalError, isLocalDecodeEngine, type FlushOutcome } from './flush-final';
import { engineBacklogMs, ReceivedAudioEnd, backlogHoldsCutArms } from './engine-backlog';
import { PCM_BYTES_PER_MS } from './tuning-env';
import { stopRecording, handleAutoStop, emitTerminalFinal, type TerminalHost } from './orchestrator-terminal';
import { silentEmptyFinalError, vendorNoAudioIsOurSilence } from './empty-final-verdicts';
import { coldOpenErrorVerdict } from './cold-open-verdict';
import { segmentDurationMs as segmentDurationAccountMs } from './segment-duration-account';
import { SegmentPauseAccount } from './segment-pause'; import { cutPointFacts, type LastFlushFacts, type CutPointFacts } from './cut-log'; // one line: a mobile test cites a coordinate below
import { LegFacts } from './leg-facts'; import { ClosedRunTail } from './pause-cut-boundary'; import { OverdueCut, OVERDUE_HOLD_GRACE_MS, type OverdueCandidate } from './overdue-cut'; // one line: a test cites a coordinate below (coordinate-anchors)

export * from './orchestrator-types';

/**
 * Audit F3 — what happened to one pushed chunk.
 *   · `'fed'`     — AudioSession took it into the pipeline.
 *   · `'deduped'` — an already-observed seq: the ring replay working as designed.
 *                   Its content is in the pipeline; it got there the first time.
 *   · `'refused'` — received and delivered nowhere (past the terminal fence, or
 *                   turned away by AudioSession's own state guard).
 * The receipt's counting rule for each is argued in engine/stt-session-intake.ts.
 */
export type ChunkIntake = 'fed' | 'deduped' | 'refused';

export class SttEngineOrchestrator extends EventEmitter {
  private engine: EngineSubscriber | null = null;
  private currentSegmentIdx = 0;
  private segmentStartMs = 0;
  /** card CR-12-D — 「这一段开始前静了多久」, folded from the engine's own word
   *  timestamps. The clock it measures in, and the four cases in which it
   *  deliberately answers null instead of a number, are argued in full in
   *  `segment-pause.ts`; this class only feeds it and reads it. */
  private readonly pauseAccount = new SegmentPauseAccount();
  /** card SEG-1 — composed like {@link idle}/{@link ladder}: it owns the timer,
   *  both phases and `due`. Account: `stt/segment-boundary.ts`. */
  private readonly cadence: SoftSegmentCadence;
  private readonly spanClosure = new FunasrSpanClosureFeeder();
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
  /** card CR-12-D — `RolloverHost.legHeardUpToSeq`; -1 = no overlap pending. */
  private legHeardUpToSeq = -1;
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
  /** card EMPTY-1 — the two RECORDING-WIDE facts {@link emptyFinalCause} judges on;
   *  reset with the byte counters above, being per-recording like those. Why each one
   *  narrows the claim, and what a missing one would let us say falsely, is argued in
   *  full on that function — read it before touching either latch. */
  private engineErrorEmitted = false;
  private sessionProducedText = false;
  private readonly ladder: EngineSessionReconnectLadder;
  /** card RT-3 — the longest the reconnect ladder can possibly spend before it
   *  either recovers or gives up. ⚠️ 更正（NR-96，2026-09-24）：原为「the SUM of its own backoff rungs」
   *  — each rung's spawn is capped now, so it is waits + caps (`engineReconnectWorstCaseMs`). Audio that
   *  no engine has heard is held for this long BEYOND the replay window, and no longer. 🔴 It is READ FROM
   *  THE SCHEDULE, not chosen — "tuning a new number with no measurement behind it" is the mistake this whole card exists to not repeat. */
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
    if (this.rolloverWork || this.idle.isBusy || !this.engine || this.engineOpening) { this.session.retryEngineCeilingSoon(); return; } // RC-1: an opening leg cannot be flushed // B2-G: retry soon, don't leave the leg unrotated a full ceiling (see that method's doc)
    runRollover(this.asRolloverHost(), false);
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
        isFinished: () => this.terminated || this.terminalizing, holdLegRotation: () => this.backlogHoldsCutArms() }); // RC-U
    this.replayWindowMs = options.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
    this.engineSpawnTimeoutMs = options.engineSpawnTimeoutMs ?? DEFAULT_ENGINE_SPAWN_TIMEOUT_MS;
    this.unfedGraceMs = unfedGraceMsFor(options.continuous === true, engineReconnectWorstCaseMs(options.reconnectBackoffMs ?? DEFAULT_BACKOFF_MS, options.maxRetries ?? DEFAULT_MAX_RETRIES, this.engineSpawnTimeoutMs)); // NR-96: the ladder's real worst case; RC-L: a long recording's is 180 s
    this.engineFlushTimeoutMs = options.engineFlushTimeoutMs ?? DEFAULT_ENGINE_FLUSH_TIMEOUT_MS; this.engineFlushTimeoutExplicit = options.engineFlushTimeoutMs !== undefined;
    this.now = options.now ?? Date.now; this.continuous = options.continuous === true; // RC-E (one line: a mobile test cites a coordinate below)
    this.shouldFeedEngine = options.shouldFeedEngine ?? ((): boolean => true);
    this._setTimeout = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = options.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const hooks: EngineSessionHooks = {
      spawnEngine: (a) => this.spawnEngine(false, a), closeEngine: (leg) => this.closeEngine(leg), // card RC-1: attempt + leg identity
      replayBufferTail: () => Math.floor(this.replayBufferTail() / PCM_BYTES_PER_MS), currentEngineId: () => this.engine?.id ?? 'unknown',
      emitStatus: (p) => this.emit('engine-status', p), emitError: (p) => { this.emitEngineError(p); }, // ENG-4 lives in emitEngineError, not here — this was the ONLY wired site until 2026-09-03 (see that method)
      clearSoftSegmentTimer: () => this.cadence.clear(), isTerminated: () => this.terminated,
    };
    this.ladder = new EngineSessionReconnectLadder(hooks, {
      ...(options.reconnectBackoffMs !== undefined ? { reconnectBackoffMs: options.reconnectBackoffMs } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      attemptTimeoutMs: this.engineSpawnTimeoutMs, ...(options.reconnectUnbounded === true ? { unbounded: true } : {}), // NR-96: a rung's spawn gets the cold open's cap; RC-1: a long recording never gives up on count
      setTimeoutFn: this._setTimeout, clearTimeoutFn: this._clearTimeout,
    });
    const idleHooks: IdleHangupHooks = {
      hasEngine: () => this.engine !== null,
      isSettling: () => this.terminated || this.terminalizing,
      // A rollover or a terminal flush already owns this leg. `flushing` is in
      // here too: a flush in progress IS the leg being used.
      isLegBusy: () => this.rolloverWork !== null || this.flushing || this.engineOpening, // RC-1: never hang up a leg still opening
      flushAndCloseLeg: () => this.flushAndCloseLegForSilence(),
      dialLeg: () => this.dialLeg(), voiceOwed: () => this.unheardVoice && !this.terminated, // voiceOwed: card HANGUP-1
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
    this.spanClosure.reset();
    this.offlineAccum = '';
    this.onlineDraft = '';
    this.accumEmittedByFinal = false;
    this.lastEngineFedSeq = -1; this.unheardVoice = false; this.closingDialError = null; this.terminalErrorSpoken = false; this.cutDeferred = false; // HANGUP-3 ×2, RC-1
    this.engineFedBytes = 0; this.voiceBytesCaptured = 0; this.sessionFedBytes = 0; this.engineErrorEmitted = false; this.sessionProducedText = false; this.heard.reset(); this.unansweredFloorSeq = null; // Codex item 5 → RC-Q; RC-L
    this.pauseAccount.reset(); this.closedRunTail.reset(); this.retiringFloorSeq = null; // RC-A
    this.session.on('auto_stopped', this.onSessionAutoStopped);
    this.session.on('engine_session_expired', this.onEngineSessionExpired); // card N1-B4
    // no implicit fallback #16: an unreachable engine surfaces a terminal error → engine-status{failed} + stt:error, so audio:start acks fail.
    // 🔴 card K-7 CORRECTION — the ROUTER's SttConfigMissingError is rethrown UNSPOKEN below, and this line used to end "propagates raw (audio.handler maps it)", which cannot be true: the BRIDGE fires start() and forgets it (stt-session.ts `.catch`), so by the time this rejects, audio.handler has already answered `safeAck(ack,{ok:true})`. Nothing maps it.
    // Its answer is now SttSessionBridge.onColdOpenRejection, which is the exact COMPLEMENT of the `instanceof` rethrow below — keep them complementary or a cold-open failure gets narrated twice.
    // card ENG-2 (fix-029): STT_NETWORK_DROP is the FALLBACK only — an engine that
    // NAMED its open failure (e.g. sherpa-local's STT_CONFIG_MISSING for a
    // missing addon/model) keeps its code + message; see cold-open-verdict.ts.
    try {
      // NR-38: `true` = THIS is the cold open — the one spawn of the four that
      // is followed by the `ready` below. It is what licenses the
      // `engine-status{loading}` announcement inside spawnEngine; see there.
      await raceSpawnTimeout(this.spawnEngine(true), this.engineSpawnTimeoutMs, this._setTimeout, this._clearTimeout);
    } catch (err) {
      this.session.off('auto_stopped', this.onSessionAutoStopped);
      this.session.off('engine_session_expired', this.onEngineSessionExpired);
      if (err instanceof SttConfigMissingError) throw err;
      this.emit('engine-status', { provider: (this.engine as EngineSubscriber | null)?.id ?? 'unknown', status: 'failed' });
      this.engineErrorEmitted = true; this.emit('error', coldOpenErrorVerdict(err)); // deliberately NOT emitEngineError — a cold open has fed nothing yet, so ENG-4 would mute EVERY code here; see that method
      throw err;
    }
    this.replayBufferTail(true); // feed chunks buffered during the cold-open spawn
    this.cadence.arm();
    this.emit('engine-status', { provider: this.engine!.id, status: 'ready' });
  }

  /**
   * Audit F3 — what the pipeline DID with this frame, so the bridge's tally can
   * be a measurement rather than an assumption.
   *
   * 🔴 THE BRIDGE CANNOT DERIVE THIS. Two of the three outcomes below leave no
   * trace it can read: a frame refused by the terminal fence never reaches
   * `AudioSession` at all, so `droppedChunks` does not move, and the bridge would
   * report a frame that went nowhere as fed — which is the number the phone
   * checks before deleting its only copy of the audio.
   */
  pushChunk(c: { seq: number; ts_ms: number; payload: Buffer }): ChunkIntake {
    // The recording is over as far as this orchestrator is concerned: taken off
    // the wire, delivered nowhere. NOT an error — a late chunk during
    // stop -> flush is normal — but it is a drop, not a feed.
    if (this.terminated || this.terminalizing) return 'refused';
    // F-2149: feed each seq AT MOST ONCE — a reconnect replays already-delivered
    // seqs; an observed seq is dropped, a never-seen gap-fill still flows.
    if (this.session.seq.hasObserved(c.seq)) return 'deduped';
    // Whether AudioSession's own state guard takes it. Read as a DELTA rather
    // than by asking the session's state, because that guard is the sole writer
    // of the counter the receipt adds to this verdict — one fact, one author.
    const sessionDropsBefore = this.session.droppedChunks;
    // 🔴 card RT-2 — the voice came back ⇒ dial the leg. This runs BEFORE the
    // retention pin below and that order is the mechanism, not tidiness:
    // `replayStillOwed()` reads `idle.isDialing`, so setting it first is what stops
    // the ring from evicting the very chunks the new leg will be replayed.
    //
    // ⚠️ The trigger is a chunk THE GATE ACCEPTS, not any chunk. The phone
    // streams continuously — silence included — so "audio arrived" would dial
    // straight back into the silence we just hung up on.
    if (this.idle.isHungUp && !this.ladder.gaveUp && this.shouldFeedEngine(c) && this.idle.noteVoice()) this.takeRedialOnsetTail(); // RC-7: no redial after the verdict; RC-E (every session, follow-up)
    // card RT-3: set the ring's retention pin BEFORE the push prunes it. While an
    // engine is live `lastEngineFedSeq` IS the newest seq, so the pin is inert
    // and the window behaves exactly as it always has (no memory cost, no
    // latency, common path untouched). While one is being reconnected — or is
    // mid-rollover — it is what stops the 5 s window from evicting audio that no
    // engine has been given. Released once nothing will ever replay again, so a
    // ladder that has given up cannot pin the ring for the rest of the session.
    // card RC-4 follow-up — an overdue cut lands seconds in the PAST, so while the arm is armed
    // (and until a pending overdue replay has happened) the ring keeps this leg's audio from there.
    const overdueHold = this.pendingOverdueFloor ?? (this.engine ? this.overdue.holdSeq(this.legFacts, this.engine) : null);
    // card RC-A — and while a retiring flush is in flight, from its boundary (`replay-debt.ts` `retentionFloorSeq`)
    // for as long as that flush may run plus the ladder's worst case for the next leg to be born.
    this.session.setRetentionPin(
      Math.min(retentionFloorSeq({ hasEngine: this.engine !== null, rolloverInFlight: this.rolloverWork !== null,
        redialInFlight: this.idle.isDialing, reconnectPending: this.ladder.hasPendingReconnect() },
        this.lastEngineFedSeq, this.retiringFloorSeq), overdueHold ?? Number.POSITIVE_INFINITY, answeredFloorSeq(this.engine ? this.legFacts.answeredThroughSeq(this.engine.ackedAudioMs) : null, this.unansweredFloorSeq, !this.ladder.gaveUp)), // RC-L
      Math.max(overdueHold === null ? this.unfedGraceMs : Math.max(this.unfedGraceMs, OVERDUE_HOLD_GRACE_MS),
        this.retiringFloorSeq === null ? 0 : this.lastFlushCapMs + this.unfedGraceMs),
    );
    this.session.pushChunk(c);
    const intake: ChunkIntake = this.session.droppedChunks === sessionDropsBefore ? 'fed' : 'refused';
    if (intake === 'fed') this.receivedEnd.note(c.ts_ms, c.payload.length); // card RC-2 — see `engine-backlog.ts`
    // AudioSession owns the hard-limit boundary; never leak a rejected boundary
    // chunk into the engine.
    if (this.terminalizing || !this.session.seq.hasObserved(c.seq)) return intake;
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
    // card CR-12-D — classify this chunk for the pause account HERE, off the
    // same single read of `feed` that decides everything below. Two reads of the
    // gate could disagree, and the whole licence to ADD the withheld half to the
    // engine's word gap is that no chunk is in both (`segment-pause.ts` header).
    // card HANGUP-1: a withheld chunk behind unheard voice is replayed WITH it (see below), so it lands in a leg's clock.
    this.pauseAccount.noteChunk(feed || this.unheardVoice, c.payload.length / PCM_BYTES_PER_MS, this.engineFedBytes / PCM_BYTES_PER_MS);
    // 🔴 card SEG-1/SEG-4 — THE ONE PLACE A ROW IS ENDED (timers only rotate
    // legs now). On the CHUNK path, not in the engine's `final` handler: that
    // handler runs inside the vendor adapter's callback and a rollover issues
    // `engine.flush()`, i.e. it would re-enter the adapter from its own event.
    // ~200 ms chunks ⇒ one chunk of latency, every cut on a stack we own.
    // `feed` is passed, not re-derived (one gate reading per chunk); the cadence
    // owns the silence RUN too (SEG-3) — measured, not one instant reading.
    // card RC-4 — CONFIRMED text = the bank + this leg's vendor-finalised prefix (never
    // the draft), and the engine's own word gap as the third arm (`segmentCutDecision`).
    // card RC-4 follow-up — the overdue arm, only for an engine that can cut its final at a time, and never
    // while a rollover is in flight: a second, refused cut would undo the first one's pending limit (`cutRow`).
    const overdue = this.engine?.limitFinalTo && this.rolloverWork === null ? this.overdue.decide({ segmentIdx: this.currentSegmentIdx, rowAgeMs: this.now() - this.segmentStartMs,
      legFedMs: this.legFedBytes / PCM_BYTES_PER_MS, facts: this.legFacts, legId: this.engine }) : null;
    // ⚠️ 更正（RC-D，2026-09-24）：the RC-4 lines above said CONFIRMED = bank + prefix for every engine. For an engine that
    // declares `finalsOnlyAtFlush` (Soniox) the sentence arm now reads '' — prefix AND bank (book 06 §2 RC-D block).
    const cut = this.cadence.shouldCut(feed, this.now(), this.legFinalsOnlyAtFlush ? '' : this.offlineAccum + this.legFacts.finalizedText,
      this.backlogHoldsCutArms() ? null : this.pauseAccount.liveWordGap(this.legFacts.liveWords(this.engineFedBytes / PCM_BYTES_PER_MS)), overdue?.kind ?? null, // RC-U: held while the vendor is behind
      this.continuous ? { rowAgeMs: this.now() - this.segmentStartMs, rowText: this.offlineAccum + this.onlineDraft } : null); // card RC-E (a cut during a hang-up flush is refused in `startRollover`)
    // F-2 Fix A: feed ~1 s of zeros to FunASR AFTER the silence-run is updated
    // and BEFORE startRollover, so a pause-cut flush can wait on a span the
    // runtime has actually been shown. Client silence still does not go through.
    if (feed) this.spanClosure.noteOpen();
    else this.spanClosure.noteClosed(this.engine, this.now(), this.cadence.gateClosedMs(this.now()));
    // card HANGUP-1: never past voice no leg has heard — the mark would bury it (`rewindToFlushBoundary`).
    // 🔴 card HANGUP-2: and it moves BEFORE the cut takes its boundary. A pause cut is decided ON a withheld
    // chunk; marking it after `startRollover` put that silent chunk above the boundary, so the replay handed
    // it to the new leg — a vendor fed 200 ms the gate had refused, and a leg that was never EMPTY to the
    // hang-up's empty-leg rule (`flushAndCloseLegForSilence`; test/stt-empty-leg-and-owed-voice.test.ts).
    // ⚠️ 更正（RC-5a，2026-09-24）：the HANGUP-2 half above is kept as written, but the silent
    // chunk it keeps out of the new leg is now handed to it on purpose: a row cut decided on a
    // withheld chunk takes its boundary below the closed run's last ≤1 s (`pause-cut-boundary.ts`),
    // because the next syllable's onset can hide in that tail. The empty-leg rule reads voice now.
    if (!feed && !this.unheardVoice) this.lastEngineFedSeq = Math.max(this.lastEngineFedSeq, c.seq);
    // card RC-1 × RC-5a (integration): a cut refused while the leg opened runs on the first chunk after, and it runs
    // through `cutRow` so its boundary still takes RC-5a's floor. A FED chunk ends the withheld run, so for that
    // chunk the floor is read before `note` — the run's tail is where the onset sits (test/stt-deferred-cut-onset.test.ts).
    const deferredFloor = this.cutDeferred && feed ? this.closedRunTail.boundaryBelow(this.lastEngineFedSeq) : null;
    if (feed) gateOpenPreroll(this as unknown as GatePrerollHost); // card RC-T — the gate just opened: the closed run's last ≤400 ms first (`gate-preroll.ts`)
    this.closedRunTail.note(feed, c.seq, c.payload.length / PCM_BYTES_PER_MS);
    if (cut || this.cutDeferred) this.cutRow(cut && this.cadence.lastCutReason === 'overdue' ? overdue : null, deferredFloor);
    if (!feed) return intake;
    // card fix-022 / G-23: the gate just said this audio is worth sending, so this
    // is the ONE site that can record "the user really did speak" — and it is the same
    // predicate the feed below consults, which is what stops the two from ever
    // becoming different opinions about what counts as speech.
    this.voiceBytesCaptured += c.payload.length; this.heard.noteAccepted(c.seq); // RC-Q: the gate's one reading
    const legBytesBefore = this.legFedBytes;
    if (this.engine && this.engine.state === 'open') {
      try { this.engine.push(c.payload, c.ts_ms); this.engineFedBytes += c.payload.length; this.legFedBytes += c.payload.length; this.sessionFedBytes += c.payload.length; this.heard.noteFed(c.seq, c.payload.length, this.legFedBytes / PCM_BYTES_PER_MS); this.heard.settle(this.engine.ackedAudioMs); this.lastEngineFedSeq = Math.max(this.lastEngineFedSeq, c.seq); this.unheardVoice = false; this.idle.arm(); } catch (err) { console.error('[SttEngineOrchestrator] pushChunk engine.push error (reconnect ladder will handle):', err); }
      if (this.legFedBytes > legBytesBefore) this.legFacts.noteLegChunk(c.seq, this.legFedBytes / PCM_BYTES_PER_MS); // RC-4 overdue
      // card NR-60 — AFTER the feed, because the number it reads is「what this
      // leg has been handed」and this chunk is part of it.
      this.enforceLegAudioBudget();
    } else this.unheardVoice = true; // card HANGUP-1: no open leg — this waits for a replay
    // ⚠️ The verdict is about the SESSION, not the engine. A frame the VAD gate
    // held back, or one buffered while an engine is being reconnected, is in the
    // pipeline and will be replayed — the receipt's `fed_frames` answers 「did we
    // take your audio」, never 「did a vendor already hear it」.
    return intake;
  }

  /** 🔴 W2.5-B — the button release; moved VERBATIM (doc included) to
   *  `orchestrator-terminal.ts` as `stopRecording` (800-line cap, card HANGUP-2).
   *  ⚠️ Deliberately NOT `async`: it returns that function's own promise, so the
   *  common path gains no extra microtask turn (the load-bearing `if` there says why that matters). */
  stop(): Promise<void> {
    return stopRecording(this.asTerminalHost());
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

  /** card SEG-1 — moved VERBATIM to `orchestrator-rollover.ts` (800-line cap):
   *  rollover start/spawn/dial + the segment-cut bank+emit are all typed
   *  against `RolloverHost` there, not against this class, so this cast is
   *  the ONE place private state crosses that boundary — same object, same
   *  fields, only the compile-time view widens for the call. */
  private asRolloverHost(): RolloverHost { return this as unknown as RolloverHost; }
  /** card HANGUP-2 — the same cast for the terminal family (`orchestrator-terminal.ts`). */
  private asTerminalHost(): TerminalHost { return this as unknown as TerminalHost; }

  /** card SEG-1 — moved VERBATIM to `orchestrator-rollover.ts`. This wrapper
   *  keeps the name `startRollover` reachable — nothing else changed; see
   *  that file's header for why. */
  private startRollover(deliver: boolean): boolean {
    return startRollover(this.asRolloverHost(), deliver);
  }

  /** card NR-60 — rotate the leg before its span outgrows what this engine's
   *  decoder will actually read. Policy, measurement and cost: `legAudioBudgetMs`
   *  in `segment-boundary.ts`; the declaration: `SttEngine.maxDecodeAudioMs`. */
  private enforceLegAudioBudget(): void {
    const budgetMs = legAudioBudgetMs(this.engine?.maxDecodeAudioMs);
    if (budgetMs === 0 || this.engineFedBytes < budgetMs * PCM_BYTES_PER_MS) return;
    this.cadence.rotateLegForAudioBudget();
  }

  /** card RT-2 hook — moved VERBATIM to `orchestrator-rollover.ts`; wrapper
   *  keeps the name `flushAndCloseLegForSilence` reachable (referenced by
   *  name in `empty-final-verdicts.ts`). */
  private async flushAndCloseLegForSilence(): Promise<void> {
    return flushAndCloseLegForSilence(this.asRolloverHost());
  }

  /** card RT-2 hook — moved VERBATIM to `orchestrator-rollover.ts`; wrapper
   *  keeps the name `dialLeg` reachable (the `EngineIdleHangup` hook is wired
   *  to this method by name in the constructor, and `engine-idle-hangup.ts`'s
   *  own hook interface calls its hook `dialLeg` too). */
  private async dialLeg(): Promise<boolean> {
    return dialLeg(this.asRolloverHost());
  }

  /** card N1-B1 — the auto-stop exit; moved VERBATIM (doc included) to
   *  `orchestrator-terminal.ts` (800-line cap, card HANGUP-2). Wrapper keeps the name. */
  private handleAutoStop(reason: 'hard_limit'): Promise<void> {
    return handleAutoStop(this.asTerminalHost(), reason);
  }

  /** card N1-B1 — the ONE question `duration_ms` answers on BOTH exits: "how
   *  long is this segment" (never the whole session — that used to double-count,
   *  card N1-B1b closed it). Full account (why it is a contract change, the two
   *  compat directions, why the `totalAudioMs` replacement was rejected) moved
   *  VERBATIM to `segment-duration-account.ts` (800-line cap) — behaviour
   *  unchanged, only the call stayed behind. */
  private segmentDurationMs(atMs = this.now()): number { return segmentDurationAccountMs(atMs, this.segmentStartMs); } // atMs: card RC4-S5 (orchestrator-terminal.ts `terminalRowMs`)

  /** Moved VERBATIM to `orchestrator-flush.ts` (D-14, before cards RC-A/D/E/J); wrapper keeps the name. */
  private flushAndEmitFinal(isSegment: boolean, durationMs: number): Promise<boolean> {
    return flushAndEmitFinal(this as unknown as FlushEmitHost, isSegment, durationMs);
  }

  /** 🔴 No silent failure, the flush-cap half. The rule, the L9 finding it came from and
   *  why each of its three conditions exists moved VERBATIM to
   *  {@link silentEmptyFinalError} (800-line cap, card fix-022) — behaviour
   *  unchanged, only the emit stayed behind. */
  private reportSilentEmptyFinal(text: string, timedOut: boolean): void {
    const err = silentEmptyFinalError(this.engineFedBytes, text, timedOut);
    if (err) { this.engineErrorEmitted = true; this.emit('error', err); }
  }

  /** 🔴 card fix-022 / G-23 + card EMPTY-1 — the verdict site; moved VERBATIM to
   *  `orchestrator-terminal.ts` (800-line cap, card HANGUP-2). Wrapper keeps the name. */
  private emitTerminalFinal(r: Pick<FinalResult, 'text' | 'confidence' | 'language'>, durationMs: number): boolean {
    return emitTerminalFinal(this.asTerminalHost(), r, durationMs);
  }

  /** 🔴 No silent failure, flush-phase half — rule VERBATIM in {@link flushErrorVerdict}; latched ONLY when spoken (why: that module, ENG-4 2026-09-03). */
  private handleFlushError(err: Error): void { if (this.emitEngineError(flushErrorVerdict(err))) this.flushErrored = true; }
  /** 🔴 ENG-4 — the ONE exit for a LIVE-LEG engine error (ladder rung, flush phase); the cold open in `start` stays loud on purpose.
   *  Wired to the ladder hook alone until 2026-09-03; the account is on {@link vendorNoAudioIsOurSilence}. Returns whether the frame went out. */
  private emitEngineError(p: { code: string; message: string; retryable: boolean }): boolean {
    if (vendorNoAudioIsOurSilence(p.code, this.voiceBytesCaptured)) { this.emit('error-suppressed', p); return false; } // logged by engine/stt-session.ts
    this.engineErrorEmitted = true; if (!p.retryable) this.terminalErrorSpoken = true; this.emit('error', p); return true; // HANGUP-3: see `owedVoiceLostError`
  }

  /**
   * @param coldOpen `true` only from {@link start} — the FIRST leg of a
   * recording, the one this method's caller closes with `engine-status{ready}`.
   * A leg is born four ways (see the comment at the end of this method) and the
   * other three — soft-segment rollover, silence redial, ladder rung — emit no
   * `ready`, so an announcement made on those paths would never be closed.
   */
  /** NR-96 — bumped by every `spawnEngine`; see the guard there. (Declared here,
   *  not with the other fields, so no coordinate anchored above it moves.) */
  private spawnGeneration = 0;
  private async spawnEngine(coldOpen = false, attempt?: SpawnAttempt): Promise<void> {
    // Never orphan a live engine on a stray double-spawn. card RC-1: an OPENING leg closed here rejects as
    // SupersededLegError (catch below), so the attempt it belonged to counts no rung — cancelled, not failed.
    if (this.engine) await this.closeEngine();
    const banked = bankDraftAcrossLegs(this.legInterimShape, this.offlineAccum, this.onlineDraft);
    if (banked !== null) { this.offlineAccum = banked; this.onlineDraft = ''; }
    const engine = this.engineFactory() as EngineSubscriber;
    if (attempt) attempt.leg = engine; // card RC-1 — so a timeout or refusal can name this leg, not 「the current one」
    const handlers: EngineHandlers = {
      // F-2100: monotonic-cumulative preview per segment_idx (client REPLACES).
      // 🔴 INT-2: WHICH fold is the ENGINE'S OWN DECLARATION, never a guess read
      // off the strings — measurement + argument in text-merge.ts `foldInterim`.
      interim: (e) => {
        if (this.terminated || this.terminalizing) return;
        this.legFacts.noteInterim(e); // card RC-4
        this.onlineDraft = foldInterim(engine.interimShape, this.onlineDraft, e.text);
        this.accumEmittedByFinal = false; // card RT3-B: content no final has carried
        this.emit('interim', {
          text: this.offlineAccum + this.onlineDraft,
          confidence: e.confidence, language: e.language, segment_idx: this.currentSegmentIdx,
          ...(engine === this.engine ? this.receivedEnd.wireField(engineBacklogMs(engine, this.legFedBytes)) : {}), // card RC-2
        });
      },
      // F-2069/F-2100: fold the offline final in, reset the draft. F-2152: mark
      // everything fed so far as finalized.
      final: (e) => {
        if (this.terminated || (this.terminalizing && !this.flushing)) return;
        this.offlineAccum = this.legFacts.foldFinal(this.offlineAccum, e.text, e); this.onlineDraft = ''; // RC-5b/5c: merge only what the old final covered (RC-4: spends the prefix)
        this.spanClosure.notifyFold();
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
      error: (e) => { if (this.engineOpening || this.terminated) return; if (this.flushing) return this.handleFlushError(e); if (this.terminalizing) return; this.noteLegUnanswered(engine); this.ladder.handleEngineError(e, engine); }, // RC-1: names the leg; RC-L: what it never answered is owed
    };
    engine.on('interim', handlers.interim);
    engine.on('final', handlers.final);
    engine.on('error', handlers.error);
    this.engine = engine; this.legFedBytes = 0; this.legFacts.reset(); // card HANGUP-2 (+RC-4) — the ONE place a leg is born (all four ways, see below)
    this.legInterimShape = engine.interimShape; // REQ-14-01: remembered past this leg's death — see the field
    this.legFinalsOnlyAtFlush = engine.finalsOnlyAtFlush === true; // card RC-D: ditto — a hung-up session still has a bank
    this.boundHandlers = handlers;
    await openLeg(this as unknown as SpawnOpenHost, engine, coldOpen); // D-14 split: the NR-38 / NR-96 / RC-1 / RC-7 open step moved VERBATIM to orchestrator-spawn.ts
    // 🔴 card RT-2 — ONE place, because there are FOUR ways a leg is born: the cold
    // open, a soft-segment rollover, a silence redial, and a LADDER RUNG (which
    // reaches `spawnEngine` through a hook and touches no other orchestrator
    // code). Arming at the call sites would have covered three of them and left
    // a reconnected session unable to ever hang up again — a hole with no symptom
    // except a bill. The rule is "a leg exists ⇒ the countdown runs".
    this.idle.arm();
    // 🔴 card CR-Q — here for the same reason `idle.arm()` is: a leg is being
    // born, so we are about to spend money again. Cheap on every path, and the
    // whole account (floor, failure direction, log line) is in quota-recheck.ts.
    recheckQuotaOnLegBirth(this.session);
  }

  /** card RC-1 — leg given ⇒ close only if it IS the current leg (the ladder names the leg that failed). */
  private async closeEngine(leg?: unknown): Promise<void> {
    const engine = this.engine;
    if (!engine || (leg !== undefined && leg !== engine)) return;
    if (this.boundHandlers) {
      engine.off('interim', this.boundHandlers.interim);
      engine.off('final', this.boundHandlers.final);
      engine.off('error', this.boundHandlers.error);
      this.boundHandlers = null;
    }
    this.heard.endLeg(engine.ackedAudioMs); this.engine = null; // RC-Q: count what this leg answered; the rest is owed to a replay
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
  flushSentHook: (() => void) | undefined = undefined; // WP2-6a: stt-factory → markFlushSent; raceFlushFinal is the one author
  /** card HANGUP-3 — the client declared `stt.segment_not_transcribed` at admission. Written ONLY by
   *  stt-factory.ts (from `audio:start`'s socket); read by the owed-voice verdict. Default false = today's behaviour. */
  segmentNotTranscribedDeclared = false;
  /** `askEngine: false` — card HANGUP-2: race NO engine, i.e. settle on the folded accumulators
   *  exactly as a flush that produced nothing would (no words, no timestamps, nothing sent).
   *  Only the silence hang-up passes it, for a leg that was handed no audio — see
   *  `flushAndCloseLegForSilence` in orchestrator-rollover.ts for the ruling and why. */
  private flushFinal(askEngine = true, withholdOnTimeout = false): Promise<FlushOutcome> {
    const startedMs = this.now(), leg = this.engine; // card RC-6; leg: card RC-L — the flush facts the `stt.cut` line reads (cut-log.ts), recorded at the ONE flush chokepoint
    this.lastFlushCapMs = this.flushCapMs(); // card RC-2: the cap actually raced, for the refusal's message
    return raceFlushFinal({ engine: askEngine ? this.engine : null, getOfflineText: () => foldConfirmedWithDraft(this.offlineAccum, this.onlineDraft), language: this.startInput?.language ?? '', timeoutMs: this.lastFlushCapMs, setTimeoutFn: this._setTimeout, clearTimeoutFn: this._clearTimeout, onFlushSent: this.flushSentHook, withholdOnTimeout })
      .then((o) => { this.lastFlush = { startedMs, endedMs: this.now(), timedOut: o.timedOut, lastWordMs: typeof o.result.last_word_ms === 'number' ? o.result.last_word_ms : null, legFedMs: this.legFedBytes / PCM_BYTES_PER_MS }; if (askEngine && leg !== null && !o.engineFinal) this.noteLegUnanswered(leg); return o; }); // RC-L
  }

  /** NR-50 — the cap this leg's flush races. `engineFedBytes` is exactly the
   *  audio THIS leg was handed (reset on every rollover), which is what a local
   *  decode's cost is a function of — see `localFlushCapMs`.
   *  Card RC-2 — a network engine that reports a processed position races
   *  `networkFlushCapMs` of its unprocessed backlog instead of the flat cap. */
  private flushCapMs(): number {
    return resolveFlushTimeoutMs(this.engine?.id ?? '', this.engineFlushTimeoutMs, this.engineFlushTimeoutExplicit, this.engineFedBytes / PCM_BYTES_PER_MS, engineBacklogMs(this.engine, this.legFedBytes));
  }
  /** card RC-2 — written by {@link flushFinal} only; read by {@link noteFlushRefused}. */
  private lastFlushCapMs = 0;
  /** card RC-2 — the end of the audio this recording has received, in the sender's clock (`engine-backlog.ts`). */
  private readonly receivedEnd = new ReceivedAudioEnd();

  /** NR-50 — the ONE exit for a withheld local flush (`FlushOutcome.refused`),
   *  reached from `flushAndEmitFinal` and from the two rollover sites that bank
   *  the flush text directly. If the engine's own flush-phase error already went
   *  out (`handleFlushError` ⇒ `flushErrored`), that frame — terminal for this
   *  engine — is the refusal and nothing is repeated; otherwise the cap fired
   *  and this is the only frame the phone will get for the utterance. */
  private noteFlushRefused(timedOut: boolean): void {
    if (this.flushErrored) return;
    this.engineErrorEmitted = true;
    // card RC-2 — the other refusal: a network engine's terminal flush that outran its backlog-scaled cap.
    const network = !isLocalDecodeEngine(this.engine?.id ?? '') && engineBacklogMs(this.engine, this.legFedBytes) !== null;
    this.emit('error', network
      ? networkFlushRefusalError(this.legFedBytes / PCM_BYTES_PER_MS, this.engine?.ackedAudioMs ?? null, this.lastFlushCapMs)
      : localFlushRefusalError(this.engineFedBytes, this.flushCapMs(), timedOut));
  }

  /** card HANGUP-1 — voice above `lastEngineFedSeq` that no leg has heard; rule + why in `rewindToFlushBoundary`.
   *  Declared here, beside the replay that clears it (a field above `start()` would shift a line coordinate
   *  `apps/mobile/test/retained_audio_session_identity_test.dart` cites into this file). */
  private unheardVoice = false;
  /** card HANGUP-2 — bytes handed to THIS leg (live pushes + replay); zeroed in `spawnEngine`, where every leg is
   *  born. Unlike `engineFedBytes` it is never carried across a ladder rung. Read by `flushAndCloseLegForSilence` only. */
  private legFedBytes = 0;
  /** card RC-4 — facts about the leg now open, reset in `spawnEngine`; see `leg-facts.ts`. */
  private readonly legFacts = new LegFacts();
  /** card RC-5a — `RolloverHost.cutFloorSeq` and its source. */
  private readonly closedRunTail = new ClosedRunTail();
  private cutFloorSeq: number | null = null;
  /** card RC-4 follow-up — the overdue arm, its cut point until the leg closes, and the replay it owes. */
  private readonly overdue = new OverdueCut();
  private rewindLegMs: number | null = null;
  private pendingOverdueFloor: number | null = null;
  private legVoicedBytes(): number { return this.legFacts.voicedBytes(this.legFedBytes); }
  /** card HANGUP-3 — why the last dial made while the recording was CLOSING failed (`dialLeg` / `spawnRolloverEngine`
   *  in orchestrator-rollover.ts, `settleOwedVoice` in orchestrator-terminal.ts); read by the owed-voice verdict. */
  private closingDialError: Error | null = null;
  /** card HANGUP-3 — a `retryable:false` frame already went out for this recording (the phone holds one terminal stall). */
  private terminalErrorSpoken = false;
  /** card RC-1 — a DELIVERY cut startRollover refused because the leg was still OPENING (a pause cut inside a redial's
   *  connect window closed that leg — CR-12-E root cause §1.4 step 1). The cut stays owed and runs on the first chunk
   *  after the leg opens (pushChunk); cleared where a delivery rollover actually starts (orchestrator-rollover.ts). */
  private cutDeferred = false;
  /** card RC-6 — the most recent flush's facts, written by `flushFinal` only; read by the `stt.cut` line. */
  private lastFlush: LastFlushFacts | null = null;
  /** card RC-A — the boundary of a retiring flush in flight that still owes the next leg its replay; the
   *  ring is pinned there (`replay-debt.ts` `retentionFloorSeq`). Written in `orchestrator-rollover.ts`, released by `replayIntoLeg`. */
  private retiringFloorSeq: number | null = null;
  /** card RC-D — the last-born leg's `finalsOnlyAtFlush`, kept past its death like {@link legInterimShape}: while hung up
   *  there is no leg, and the bank a hang-up left (terminator kept) must not fire the sentence arm at `due` either. */
  private legFinalsOnlyAtFlush = false;
  /** card RC-J — `RolloverHost.cutPoint`: set only for the instant an overdue cut starts its rollover. */
  private cutPoint: CutPointFacts | null = null;
  /** card RC-E — `OrchestratorOptions.continuous` (assigned in the constructor, beside `now`). */
  private readonly continuous: boolean;

  /**
   * ⚠️ 更正（RC-E follow-up, MAIN 2026-09-24）：「a LONG RECORDING's」 below is now every session's — the tail
   * is a word-loss fix, not a cut rule, so push-to-talk takes it too (test/stt-redial-onset.test.ts, both rows).
   * card RC-E — a LONG RECORDING's redial after a silence hang-up hears the closed run's last
   * <=1 s, exactly as a row cut does (RC-5a, `pause-cut-boundary.ts`): the onset of the word that
   * brought the voice back can sit in the tail of the chunk the gate still called silence
   * (CR-12-E rerun §3.3 E3: 「琥珀」 → 「霍」 / nothing). Called on the chunk that started the dial,
   * BEFORE `closedRunTail.note(fed=true)` clears the run. The mark is lowered so the dial's gated
   * replay starts below the tail (the redial's retention pin, at the mark, then holds it), and
   * `legHeardUpToSeq` is raised to the old mark so the pause account files those chunks once — as
   * the closed run they already are — and subtracts them from the new leg's head as overlap.
   */
  private takeRedialOnsetTail(): void {
    const floor = this.closedRunTail.boundaryBelow(this.lastEngineFedSeq);
    if (floor >= this.lastEngineFedSeq) return;
    this.legHeardUpToSeq = Math.max(this.legHeardUpToSeq, this.lastEngineFedSeq);
    this.lastEngineFedSeq = floor;
  }
  /** card RC-3b — returns the bytes this replay handed the leg (the ladder's `ready.replayed_ms`).
   *  Body moved VERBATIM to `orchestrator-replay.ts` `replayIntoLeg` (D-14); wrapper keeps the name. */
  private replayBufferTail(gateUnfed = false, whileClosing = false): number {
    return replayIntoLeg(this as unknown as ReplayIntoLegHost, gateUnfed, whileClosing);
  }

  /** card CR-12-D — the index was spent: bank the closing segment's trailing
   *  silence and start the next segment's clock. Called from `beginNextSegment`
   *  in `orchestrator-rollover.ts`, beside the two facts N1-B1 already moves
   *  there together, so the three cannot drift apart. */
  private beginPauseSegment(): void { this.pauseAccount.beginSegment(); }

  /** card CR-12-D — one leg's word spans, in that leg's own fed-audio clock. */
  private noteLegClosed(r: FinalResult): void {
    this.pauseAccount.noteLegFinal({
      legFedMs: this.rewindLegMs ?? this.engineFedBytes / PCM_BYTES_PER_MS, // RC-4 overdue: the row ended at the cut, not at the live edge
      firstWordMs: typeof r.first_word_ms === 'number' ? r.first_word_ms : null,
      lastWordEndMs: typeof r.last_word_ms === 'number' ? r.last_word_ms : null,
    });
    this.legFacts.closeLeg(this.rewindLegMs); // RC-5c: what this leg's final covered, for the next replay
    this.rewindLegMs = null;
  }

  /**
   * One ROW cut decided on the chunk path. Live-edge arms take RC-5a's floor. The overdue
   * arm cuts at a proven point X in the past (`overdue-cut.ts`): the leg's final is limited
   * to tokens that started before X, the boundary hands the next leg the chunk containing X,
   * and the words after X — heard by this leg but cut from its final — are owed to the next
   * one (`unheardVoice`, so its replay counts as voice). All of it is undone if no rollover starts.
   */
  private cutRow(past: OverdueCandidate | null, deferredFloor: number | null = null): void {
    const voiceWas = this.unheardVoice;
    this.cutFloorSeq = past ? past.boundarySeq : deferredFloor ?? this.closedRunTail.boundaryBelow(this.lastEngineFedSeq);
    this.cutPoint = past ? cutPointFacts(past, this.legFacts.seam) : null; // card RC-J — read by the `stt.cut` line the rollover writes
    if (past) { this.engine?.limitFinalTo?.(past.legMs); this.rewindLegMs = past.legMs; this.pendingOverdueFloor = past.boundarySeq; this.unheardVoice = true; }
    const started = this.startRollover(true);
    this.cutFloorSeq = null; this.cutPoint = null;
    if (!started && past) { this.engine?.limitFinalTo?.(null); this.rewindLegMs = null; this.pendingOverdueFloor = null; this.unheardVoice = voiceWas; }
  }

  /** 🔴 card RC-1b — audio actually handed to ANY engine this recording (live pushes + replay), in ms: the
   *  managed-streaming billing base's second term (book 22 §4.9; the rule and why `min` lives in
   *  `engine/stt-session.ts settle`). Read off {@link sessionFedBytes}, which is RECORDED at the one site that
   *  calls `engine.push` and at the replay — never inferred from the gate. */
  get fedAudioMs(): number { return this.sessionFedBytes / PCM_BYTES_PER_MS; }

  /** 🔴 Codex review item 5 — the billing base's second term now (book 22 §4.9 correction): audio handed to ANY
   *  engine counted ONCE per chunk, the first time a leg is handed it; every replay of it (a ladder reconnect, a
   *  rotation or cut seam, the RC-5a / RC-E tails, the RC-A boundary) adds nothing. {@link fedAudioMs} above is
   *  still every byte handed over, and stays the answer to 「how much did the vendor receive」. Recorded at the same
   *  two `engine.push` sites as `sessionFedBytes` (here and `orchestrator-replay.ts` `replayIntoLeg`), never inferred. */
  /** ⚠️ 更正（RC-Q，2026-09-24）：the paragraph above is kept as written; the name stays, the number narrowed. A
   *  chunk now counts once, the first time the gate had ACCEPTED it and a leg it was handed has ANSWERED past it
   *  (`heard-audio.ts`, book 22 §4.9 RC-Q block): outage silence a ladder replays, the RC-5a / RC-E / RC-T tails and
   *  audio a dying leg never answered add nothing. An engine reporting no processed position counts on hand-over. */
  get uniqueFedAudioMs(): number { return this.heard.billableMs(this.engine?.ackedAudioMs); }
  /** card RC-Q — see {@link uniqueFedAudioMs}; reset with the other per-recording byte facts in `start()`. */
  private readonly heard = new HeardAudioLedger();
  /** card RC-L — the highest seq a DEAD leg answered (the ladder took over, or a retiring flush ended without the
   *  vendor's final); everything above it is owed to the next leg. Pins the ring (`replay-debt.ts` `answeredFloorSeq`)
   *  and is spent by the replay that hands it over (`orchestrator-replay.ts` `replayIntoLeg`). RC-T writes it too. */
  private unansweredFloorSeq: number | null = null;
  /** card RC-L — record what [leg] was handed and never answered, before it is closed. No-op for an engine that
   *  reports no processed position, and for a leg that answered everything it was handed. */
  private noteLegUnanswered(leg: EngineSubscriber): void {
    if (leg !== this.engine) return;
    const s = this.legFacts.answeredThroughSeq(leg.ackedAudioMs);
    if (s === null) return;
    this.unansweredFloorSeq = Math.min(this.unansweredFloorSeq ?? s, s); this.unheardVoice = true; // HANGUP-1: voice is owed
  }
  /** card RC-U — the current leg's vendor backlog is over `BACKLOG_HOLDS_CUT_ARMS_MS` (`engine-backlog.ts`). */
  private backlogHoldsCutArms(): boolean { return backlogHoldsCutArms(engineBacklogMs(this.engine, this.legFedBytes)); }
}
