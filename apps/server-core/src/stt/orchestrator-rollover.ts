// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness: soft segmentation 30s / 5-minute hard cap /
//     engine reconnect ladder / no silent failure), §3 (one instance per recording; soft-segment timer; 5s replay window;
//     spawn/flush timeout; interim = offlineAccum + onlineDraft concatenation; segment dedup-merge)
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `orchestrator-core.ts` sits on the 800-line cap. The family moved here is
// SEGMENT ROLLOVER: cutting the current engine leg (soft-segment boundary,
// silence redial, or a fresh leg after a pause-cut final) and dialing the
// next one. Behaviour is unchanged — this is a structural split, not a
// rewrite; every comment below carries the same reasoning it carried inside
// the class, only the receiver changed from `this` to `host`.
//
// `startRollover` / `flushAndCloseLegForSilence` / `dialLeg` stay reachable
// under those exact names because other files reference them by name in
// comments (`text-merge.ts`, `segment-boundary.ts`, `empty-final-verdicts.ts`,
// `engine-idle-hangup.ts`'s `dialLeg` hook) — the orchestrator keeps thin
// wrapper methods of the same names that delegate here. `runRollover` is
// exported too: the N1-B4 engine-session-ceiling handler in the constructor
// calls it directly (that call site never went through `startRollover`'s
// guard, on purpose — see that handler's doc comment).

import type { EngineSubscriber } from './orchestrator-types';
import type { AudioSession } from './audio/session';
import type { EngineSessionReconnectLadder } from './engine-session';
import type { SoftSegmentCadence } from './segment-boundary';
import type { FunasrSpanClosureFeeder } from './funasr-span-closure';
import { seamText, endsAtSentenceBoundary } from './segment-boundary';
import { isFunasrFlushFamily, feedVadClosureSilence, type FlushOutcome } from './flush-final';
import { raceSpawnTimeout } from './spawn-timeout';

/**
 * Everything the rollover family needs off the orchestrator. Deliberately a
 * plain structural interface (not the class itself): passing `this` in from
 * `orchestrator-core.ts` at each call site satisfies it without exposing any
 * of these members to callers outside that file — TypeScript's structural
 * check here only looks at what THIS interface declares.
 */
export interface RolloverHost {
  engine: EngineSubscriber | null;
  terminated: boolean;
  terminalizing: boolean;
  rolloverWork: Promise<void> | null;
  offlineAccum: string;
  onlineDraft: string;
  lastEngineFedSeq: number;
  engineFedBytes: number;
  flushErrored: boolean;
  flushing: boolean;
  currentSegmentIdx: number;
  segmentStartMs: number;
  readonly cadence: SoftSegmentCadence;
  readonly spanClosure: FunasrSpanClosureFeeder;
  readonly session: AudioSession;
  readonly ladder: EngineSessionReconnectLadder;
  readonly engineSpawnTimeoutMs: number;
  readonly _setTimeout: (fn: () => void, ms: number) => unknown;
  readonly _clearTimeout: (handle: unknown) => void;
  now(): number;
  spawnEngine(): Promise<void>;
  closeEngine(): Promise<void>;
  flushFinal(): Promise<FlushOutcome>;
  replayBufferTail(gateUnfed?: boolean): void;
  flushAndEmitFinal(isSegment: boolean, durationMs: number): Promise<boolean>;
}

/** card SEG-1 — at most one rollover in flight; the ONE place a cut verdict
 *  becomes work. `deliver` carries whether this is a ROW ending or only a LEG
 *  (card SEG-4). Policy + full account: `stt/segment-boundary.ts`. */
export function startRollover(host: RolloverHost, deliver: boolean): void {
  if (host.rolloverWork || host.terminated || host.terminalizing || !host.engine) return;
  runRollover(host, deliver);
}

/**
 * 🔴 card P0-1 — the ONE place `rolloverWork` is assigned, shared by
 * `startRollover` (soft-segment / sentence-or-pause cut) and
 * `onEngineSessionExpired` (N1-B4's 5-minute wall). Both used to write
 * `this.rolloverSegment(...).finally(...)` with no `.catch`, and the
 * rollover-phase spawn inside it was a bare `await this.spawnEngine()` (see
 * {@link spawnRolloverEngine}) — so an `open()` rejection on EITHER trigger
 * became an `unhandledRejection`, which `error-handling.ts` hands to
 * `onFatal` → `exit(FATAL_EXIT_CODE)`: ONE Soniox rollover-open failure took
 * the whole relay process down for every other live session. `dialLeg` (the
 * silence-redial spawn) never had this hole; it was already wrapped, which is
 * what made these two a gap rather than a design choice.
 *
 * The `.catch` here is a terminal safety net, not the primary handler — every
 * spawn failure `rolloverSegment` knows about is already routed to the ladder
 * from inside `spawnRolloverEngine`. What lands here is a defect neither
 * anticipated, and it must still reach the ladder's terminal channel rather than crash the process or vanish silently.
 */
export function runRollover(host: RolloverHost, deliver: boolean): void {
  // card CV-1 — the ONE place a leg is rotated; the counter lives on AudioSession
  // (this file is at the 800-line cap). ⚠️ Counted HERE, before the work: the
  // number is ATTEMPTED rotations, not legs that opened (audit F4, and that
  // getter's doc says so too).
  host.session.noteLegRollover();
  host.rolloverWork = rolloverSegment(host, deliver)
    .catch((err) => { if (!host.terminated && !host.terminalizing) host.ladder.handleEngineError(err as Error); })
    .finally(() => { host.rolloverWork = null; });
}

/**
 * 🔴 card P0-1 — every ROLLOVER spawn must go through this, never a bare
 * `await this.spawnEngine()`. Same shape as {@link dialLeg}'s cap-and-catch:
 * race against `engineSpawnTimeoutMs`, hand a rejection to
 * `this.ladder.handleEngineError` instead of letting it propagate — the
 * ladder already owns "an engine session died, try again", and a second,
 * uncaught copy of that decision is exactly how P0-1 happened.
 *
 * Returns `false` when the spawn failed (ladder has taken over the retry) or
 * the orchestrator finished mid-spawn — either way the caller must stop its
 * own rollover bookkeeping right there, exactly as `dialLeg`'s callers do.
 */
async function spawnRolloverEngine(host: RolloverHost): Promise<boolean> {
  try {
    await raceSpawnTimeout(host.spawnEngine(), host.engineSpawnTimeoutMs, host._setTimeout, host._clearTimeout);
  } catch (err) {
    if (!host.terminated && !host.terminalizing) host.ladder.handleEngineError(err as Error);
    return false;
  }
  if (host.terminated || host.terminalizing) { await host.closeEngine(); return false; }
  return true;
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
export async function flushAndCloseLegForSilence(host: RolloverHost): Promise<void> {
  const engine = host.engine;
  if (!engine) return;
  feedVadClosureSilence(engine, host.now());
  host.flushErrored = false; host.flushing = true;
  const { result } = await host.flushFinal();
  host.flushing = false;
  if (host.terminated) return;
  host.offlineAccum = result.text; host.onlineDraft = '';
  await host.closeEngine();
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
export async function dialLeg(host: RolloverHost): Promise<boolean> {
  try {
    await raceSpawnTimeout(host.spawnEngine(), host.engineSpawnTimeoutMs, host._setTimeout, host._clearTimeout);
  } catch (err) {
    if (!host.terminated && !host.terminalizing) host.ladder.handleEngineError(err as Error);
    return false;
  }
  if (host.terminated || host.terminalizing) { await host.closeEngine(); return false; }
  host.engineFedBytes = 0; // a fresh leg has been handed nothing yet
  host.replayBufferTail(true); // gated: only what no engine has heard
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
async function rolloverSegment(host: RolloverHost, deliver: boolean): Promise<void> {
  if (host.terminated || host.terminalizing || !host.engine) return;
  // F-2152: chunks fed during the flush round-trip aren't in segment N's final;
  // re-arm the gate to this PRE-flush boundary so the seam carries.
  const finalizedSeq = host.lastEngineFedSeq;
  // card N1-B1: ONE instant is the segment boundary, and both gates are read off
  // it — the seq gate above (F-2152) and the clock anchor below. Taken BEFORE
  // the flush for the same reason `finalizedSeq` is: audio arriving during the
  // flush round trip belongs to the NEXT segment, so the round trip must not
  // land inside the segment that is closing.
  const boundaryMs = host.now();
  if (!deliver) {
    host.flushErrored = false; host.flushing = true;
    const { result } = await host.flushFinal();
    host.flushing = false;
    if (host.terminated) return;
    // The bank; `accumEmittedByFinal` stays false — no wire final carried this.
    host.offlineAccum = seamText(result.text, 'leg');
    host.onlineDraft = '';
    if (host.terminalizing) return; // stop() settles from the bank
    await host.closeEngine();
    if (host.terminated || host.terminalizing) return;
    host.lastEngineFedSeq = finalizedSeq;
    host.engineFedBytes = 0;
    if (!(await spawnRolloverEngine(host))) return; // card P0-1: ladder has taken over
    host.replayBufferTail(true);
    return; // the cadence re-arms its own leg timer; `due` stays raised
  }
  // F-2 Fix B: pause-cut only, FunASR family only. Wait ≤800 ms for the
  // covering 2pass-offline (punctuated) to fold into offlineAccum; on expiry
  // mint with today's text. Sentence cuts and non-FunASR pause cuts unchanged.
  if (host.cadence.lastCutReason === 'pause') {
    await host.spanClosure.waitForCoveringOffline({
      enabled: isFunasrFlushFamily(host.engine.id),
      alreadyCovered: endsAtSentenceBoundary(host.offlineAccum),
      setTimeoutFn: host._setTimeout, clearTimeoutFn: host._clearTimeout,
    });
    if (host.terminated || host.terminalizing || !host.engine) return;
  }
  const emitted = await host.flushAndEmitFinal(true, boundaryMs - host.segmentStartMs);
  if (host.terminated) return;
  // W2.5-B: both fence checks spend the index the same way ("once it's sent
  // out, spend that number"). CRITERION, so nobody burns an afternoon testing
  // it: today this branch cannot be reached with `emitted === true` — no yield
  // point sits between flushAndEmitFinal's own fence check and this one, so
  // `terminalizing` here implies `emitted === false`. Written the safe way for
  // the day someone adds an await in between. REVERSE CONTROL (2026-08-07,
  // dev-pc-a): reverting this line leaves all 21 tests green — honest result,
  // reason above; not a hole in stt-terminal-rollover-collision.test.ts.
  if (host.terminalizing) { if (emitted) beginNextSegment(host, boundaryMs); return; }
  await host.closeEngine();
  if (host.terminated) return;
  if (host.terminalizing) { if (emitted) beginNextSegment(host, boundaryMs); return; }
  beginNextSegment(host, boundaryMs);
  host.offlineAccum = '';
  host.onlineDraft = '';
  host.lastEngineFedSeq = finalizedSeq;
  host.engineFedBytes = 0; // a fresh engine has been handed nothing yet
  if (!(await spawnRolloverEngine(host))) return; // card P0-1: ladder has taken over
  host.replayBufferTail(true);
  host.cadence.arm();
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
function beginNextSegment(host: RolloverHost, boundaryMs: number): void {
  host.currentSegmentIdx += 1;
  host.segmentStartMs = boundaryMs;
  // card SEG-1 — the third fact that means "a new segment is open", moved
  // here with the other two so they cannot drift apart (that WAS N1-B1).
  host.cadence.reset();
}
