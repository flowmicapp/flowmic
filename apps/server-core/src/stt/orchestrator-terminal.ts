// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness: soft segmentation 30s / 5-minute hard cap /
//     engine reconnect ladder / no silent failure), §3 (one instance per recording)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the terminal final)
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `orchestrator-core.ts` sat exactly on the 800-line cap and card HANGUP-2 has
// to change its closing path. The family moved here is the TERMINAL EXIT: the
// button release (`stop()`), the auto-stop, and the one site every terminal
// final passes through. Behaviour is unchanged — this is a structural split,
// not a rewrite (repo convention, CLAUDE.md D-14; precedent
// `orchestrator-rollover.ts`); every comment below carries the reasoning it
// carried inside the class, only the receiver changed from `this` to `host`.
//
// `stop` / `handleAutoStop` / `emitTerminalFinal` stay reachable under those
// names on the orchestrator (thin wrappers that delegate here), because other
// files reference them by name. `emitNoEngineTerminalFinal` has no caller left
// inside the class, so it has no wrapper: its two callers both live here.

import type { FinalResult } from './engines/base';
import type { AudioSession } from './audio/session';
import type { EngineSessionReconnectLadder } from './engine-session';
import type { EngineIdleHangup } from './engine-idle-hangup';
import type { SoftSegmentCadence } from './segment-boundary';
import type { SegmentPauseAccount } from './segment-pause';
import type { EngineSubscriber, StartInput } from './orchestrator-types';
import { foldConfirmedWithDraft } from './text-merge';
import { feedVadClosureSilence } from './flush-final';
import { noEngineTerminalText } from './terminal-final-text';
import { noEngineReachedError } from './empty-final-verdicts';
import { emptyFinalCause } from './empty-final-cause';
import { raceSpawnTimeout } from './spawn-timeout';
import { owedVoiceLostError, recordClosingDialFailure, unheardFromMs } from './owed-voice-verdict';
import { logCutIfFlushed, type LastFlushFacts } from './cut-log';
import { PCM_BYTES_PER_MS } from './tuning-env';

/**
 * Everything the terminal family needs off the orchestrator — the same
 * structural-interface pattern as `RolloverHost`: `orchestrator-core.ts` casts
 * `this` to it at the ONE place private state crosses the boundary.
 */
export interface TerminalHost {
  engine: EngineSubscriber | null;
  terminated: boolean;
  terminalizing: boolean;
  terminalFinalEmitted: boolean;
  rolloverWork: Promise<void> | null;
  offlineAccum: string;
  onlineDraft: string;
  accumEmittedByFinal: boolean;
  voiceBytesCaptured: number;
  sessionFedBytes: number;
  engineErrorEmitted: boolean;
  sessionProducedText: boolean;
  /** card HANGUP-2 — voice no leg has heard (the rule is at `rewindToFlushBoundary`, orchestrator-rollover.ts). */
  unheardVoice: boolean;
  /** card HANGUP-3 — the three further facts the owed-voice verdict reads (owed-voice-verdict.ts). */
  closingDialError: Error | null;
  terminalErrorSpoken: boolean;
  readonly segmentNotTranscribedDeclared: boolean;
  currentSegmentIdx: number;
  startInput: StartInput | null;
  readonly cadence: SoftSegmentCadence;
  readonly idle: EngineIdleHangup;
  readonly ladder: EngineSessionReconnectLadder;
  readonly session: AudioSession;
  readonly pauseAccount: SegmentPauseAccount;
  now(): number;
  emit(event: string, payload: unknown): boolean;
  /** [atMs] — card RC4-S5: the row ends where the recording ended, not where its final left. */
  segmentDurationMs(atMs?: number): number;
  flushAndEmitFinal(isSegment: boolean, durationMs: number): Promise<boolean>;
  closeEngine(): Promise<void>;
  /** card HANGUP-2 — what the ladder's rung does (`attemptReconnect`, engine-session.ts), run by {@link settleOwedVoice}. */
  spawnEngine(): Promise<void>;
  /** Returns the bytes the replay handed the leg (card RC-3b; RC6 reads it for the closing rung's `ready`). */
  replayBufferTail(gateUnfed?: boolean, whileClosing?: boolean): number;
  readonly engineSpawnTimeoutMs: number;
  readonly _setTimeout: (fn: () => void, ms: number) => unknown;
  readonly _clearTimeout: (handle: unknown) => void;
  /** card RC-6 — for the terminal `stt.cut` line (cut-log.ts). */
  readonly lastFlush: LastFlushFacts | null;
  readonly lastEngineFedSeq: number;
  /** card RC4-S5 — a dead leg's unanswered floor (card RC-L, `orchestrator-core.ts`), for {@link unheardFromMs}. */
  readonly unansweredFloorSeq: number | null;
}

/**
 * 🔴 card HANGUP-2 — the release came while words were owed a replay AND the
 * ladder was waiting to deliver them (a leg dropped, or a redial after a silence
 * hang-up was refused). Cancelling that rung — which both terminal paths must do,
 * a rung is not allowed to dial after the fence — used to leave those words with
 * no leg at all and no frame saying so. So the rung runs now, ONCE, and does
 * what the rung does (`attemptReconnect`: spawn, then the UNGATED replay of the
 * window — a leg that DROPPED took its unfinalised audio with it, and only a
 * re-feed recovers it; the gated replay a silence redial uses hands over just the
 * owed words and lets the new leg's final overwrite the dropped leg's draft,
 * measured in test/stt-empty-leg-and-owed-voice.test.ts), with the spawn cap the
 * rung itself lacks (≤ `engineSpawnTimeoutMs`, as `dialLeg`), and keeps the leg
 * for the closing flush.
 * ⚠️ 更正（NR-96，2026-09-24）：「the rung itself lacks」 is no longer true — the
 * ladder's own rung races the same cap now (`engine-session.ts attemptReconnect`).
 * The cap here is unchanged; only that contrast went stale.
 *
 * ⚠️ Only for a rung that was PENDING at release. A dial that was already under
 * way when the button came up has been awaited by `idle.settle()` and, if it
 * failed, is not repeated: two capped dials back to back plus the closing flush
 * could outlast the phone's 15 s PROCESSING net.
 * If this dial fails too, the words are still owed and `owedVoiceLostError` says
 * so at the terminal final (card HANGUP-3) — to a client that declared it can;
 * book 15 §6 G-23 records what an undeclared client gets.
 */
function owesClosingRung(host: TerminalHost, rungPending: boolean): boolean {
  return rungPending && host.engine === null && host.unheardVoice && !host.terminated;
}

/** Guarded by {@link owesClosingRung} at both call sites, and the guard is SYNCHRONOUS on
 *  purpose: an unconditional `await` here would cost the common release one microtask turn,
 *  which is the exact 10-red timeout `stopRecording`'s load-bearing `if` already documents. */
async function settleOwedVoice(host: TerminalHost): Promise<void> {
  try {
    await raceSpawnTimeout(host.spawnEngine(), host.engineSpawnTimeoutMs, host._setTimeout, host._clearTimeout);
  } catch (err) {
    console.error('[SttEngineOrchestrator] closing rung failed — the owed words are lost (G-23):', err);
    recordClosingDialFailure(host, err); // card HANGUP-3
    return;
  }
  if (host.terminated) { await host.closeEngine(); return; }
  const replayedBytes = host.replayBufferTail(false, true);
  host.idle.clear(); // the leg's birth armed a hang-up countdown; nothing may hang up a leg the closing flush owns
  // 🔴 card RC6 — this IS the rung the release cancelled, run once: it ends a reconnect, so it says so exactly as the
  // ladder's rung does (`engine-session.ts attemptReconnect`: `ready` + what the replay handed the new leg). The
  // phone reads it for a long recording that stopped with its engine down: a replay reaching back to where its owed
  // tail starts means this leg heard the whole tail, and the phone withdraws it instead of transcribing it a second
  // time (book 15 §2.0-d RC6 block; CR-12-E re-check 5, the yield drill: 92 s twice). Before RC6 no frame said so.
  if (host.engine) host.emit('engine-status', { provider: host.engine.id, status: 'ready', replayed_ms: Math.floor(replayedBytes / PCM_BYTES_PER_MS) });
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
 *
 * ⚠️ 更正（RC4-S5，2026-09-25）：「it never reaches `closeEngine()` and never reaches
 * `await this.spawnEngine()`」 holds only when nothing was said past the rollover's
 * boundary. When voice was handed to the retiring leg during its flush round trip
 * (after its end-of-stream frame, where the vendor does not transcribe it), the
 * rollover now closes that leg and dials ONE closing leg for it
 * (`orchestrator-rollover.ts` `payClosingSeam`), and this await is bounded by that
 * dial too (≤ `engineSpawnTimeoutMs`). Measured cost of not doing so (CR-12-E re-run
 * 4, S5): 19.6 s of speech in no transcript.
 */
export async function stopRecording(host: TerminalHost): Promise<void> {
  if (host.terminated || host.terminalizing) return;
  host.terminalizing = true;
  const endedAtMs = host.now(); // card RC4-S5 — see {@link terminalRowMs}
  host.cadence.clear();
  host.idle.clear();
  const rungPending = host.ladder.hasPendingReconnect(); // card HANGUP-2 — read before the line below erases it
  host.ladder.clearReconnectTimer();
  if (host.rolloverWork) {
    try { await host.rolloverWork; } catch { /* the rollover's own path handles its cleanup */ }
    // A rollover that had already passed every fence check re-armed the soft
    // timer and spawned its next engine before we got here.
    host.cadence.clear();
    host.idle.clear();
    host.ladder.clearReconnectTimer();
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
  if (host.idle.isBusy) await host.idle.settle();
  if (owesClosingRung(host, rungPending)) await settleOwedVoice(host); // card HANGUP-2 — the `if` is load-bearing, as above
  if (!host.engine) { emitNoEngineTerminalFinal(host, endedAtMs); host.terminated = true; return; }
  feedVadClosureSilence(host.engine, host.now());
  const sinceMs = host.now(), head = { kind: 'stop' as const, reason: null, segment_idx: host.currentSegmentIdx, boundary_seq: host.lastEngineFedSeq, replayed_ms: null }; // card RC-6
  // The terminal flush is issued even when the rollover's flush had just timed
  // out. Skipping it to save a cap would trade dropped content for latency: audio pushed
  // after that flush was issued sits inside the engine and only a flush
  // retrieves it. The cost of not skipping is latency ONLY — `getOfflineText`
  // is late-bound (flush-final.ts), so a terminal flush that also times out
  // still settles on every word the rollover's flush had confirmed.
  await host.flushAndEmitFinal(false, terminalRowMs(host, endedAtMs));
  logCutIfFlushed(head, host.lastFlush, sinceMs); // card RC-6
  await host.closeEngine();
  host.terminated = true;
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
export async function handleAutoStop(host: TerminalHost, reason: 'hard_limit'): Promise<void> {
  host.emit('auto-stopped', { reason, limit_origin: host.session.limitOrigin });
  const endedAtMs = host.now(); // card RC4-S5 — see {@link terminalRowMs}
  const rungPending = host.ladder.hasPendingReconnect(); // card HANGUP-2 — see stopRecording
  host.cadence.clear(); host.idle.clear(); host.ladder.clearReconnectTimer();
  if (host.rolloverWork) { try { await host.rolloverWork; } catch { /* terminal path handles cleanup */ } }
  if (host.idle.isBusy) await host.idle.settle(); // card RT-2, and the `if` is load-bearing — see stop()
  if (owesClosingRung(host, rungPending)) await settleOwedVoice(host); // card HANGUP-2 — the `if` is load-bearing, as above
  if (!host.engine) { emitNoEngineTerminalFinal(host, endedAtMs); host.terminated = true; return; }
  const sinceMs = host.now(), head = { kind: 'stop' as const, reason: null, segment_idx: host.currentSegmentIdx, boundary_seq: host.lastEngineFedSeq, replayed_ms: null }; // card RC-6
  await host.flushAndEmitFinal(false, terminalRowMs(host, endedAtMs));
  logCutIfFlushed(head, host.lastFlush, sinceMs);
  await host.closeEngine();
  host.terminated = true;
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
export function emitNoEngineTerminalFinal(host: TerminalHost, endedAtMs?: number): void {
  const text = noEngineTerminalText(host.accumEmittedByFinal, host.offlineAccum, host.onlineDraft, foldConfirmedWithDraft);
  emitTerminalFinal(host, { text, confidence: 0, language: host.startInput?.language ?? '' }, endedAtMs === undefined ? host.segmentDurationMs() : terminalRowMs(host, endedAtMs));
}

/**
 * 🔴 card RC4-S5 — the last row's `duration_ms` is measured to the moment the recording ENDED (the release,
 * or the auto-stop), taken before anything is awaited. It used to be read when the terminal path reached its
 * flush (or its no-engine exit), i.e. after the in-flight rollover, the idle hang-up and any closing dial had
 * run: the phone sums the rows into the article's head, so every second of that closing work was reported as
 * recorded speech. Measured on the device (CR-12-E re-run 4, S5): a row-cut flush that returned 18.0 s after
 * the stop, and the head read 3:48 for a 3:30 recording. The row cannot end before it started, hence the floor.
 */
function terminalRowMs(host: TerminalHost, endedAtMs: number): number {
  return Math.max(0, host.segmentDurationMs(endedAtMs));
}

/** 🔴 card fix-022 / G-23 asks its verdict HERE — why this site and why the error
 *  precedes the final moved VERBATIM to the 「THE VERDICT SITE」
 *  note at the foot of `empty-final-verdicts.ts` (800-line cap); card EMPTY-1 stamps `empty_reason` from the SAME site and for the same
 *  reason, and only after `unheard` so it can see whether an error already spoke. */
export function emitTerminalFinal(host: TerminalHost, r: Pick<FinalResult, 'text' | 'confidence' | 'language'>, durationMs: number): boolean {
  if (host.terminalFinalEmitted) return false; host.terminalFinalEmitted = true;
  const unheard = noEngineReachedError(host.voiceBytesCaptured, host.sessionFedBytes, r.text);
  if (unheard) { host.engineErrorEmitted = true; host.emit('error', unheard); }
  // card HANGUP-3 — captured words the closing path could not deliver are SAID, before the final (same order,
  // same reason), and only to a client that declared it can render the code (owed-voice-verdict.ts).
  const owed = unheard ? null : owedVoiceLostError(host.unheardVoice, host.terminalErrorSpoken, host.closingDialError, host.segmentNotTranscribedDeclared,
    host.unheardVoice ? unheardFromMs(host.session.replayTail(Number.POSITIVE_INFINITY), Math.min(host.lastEngineFedSeq, host.unansweredFloorSeq ?? Number.POSITIVE_INFINITY)) : null); // card RC4-S5
  if (owed) { host.engineErrorEmitted = true; host.terminalErrorSpoken = true; host.emit('error', owed); }
  const emptyReason = emptyFinalCause(r.text, host.voiceBytesCaptured, host.engineErrorEmitted, host.sessionProducedText);
  // card CR-12-D — the terminal final closes the LAST segment, so it carries
  // that segment's pause exactly as a soft-segment final carries its own. A
  // recording whose only segment is idx 0 has no previous segment and so gets
  // no field, which the account already answers with null.
  const pauseBeforeMs = host.pauseAccount.pauseBeforeMs();
  host.emit('final', { text: r.text, confidence: r.confidence, language: r.language, segment_idx: host.currentSegmentIdx,
    is_segment: false, duration_ms: durationMs, ...(emptyReason ? { empty_reason: emptyReason } : {}),
    ...(pauseBeforeMs !== null ? { pause_before_ms: pauseBeforeMs } : {}) }); return true;
}
