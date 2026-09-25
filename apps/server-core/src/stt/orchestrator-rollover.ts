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
import type { FinalResult } from './engines/base';
import type { AudioSession } from './audio/session';
import type { EngineSessionReconnectLadder, SpawnAttempt } from './engine-session';
import type { SoftSegmentCadence } from './segment-boundary';
import type { FunasrSpanClosureFeeder } from './funasr-span-closure';
import { seamText, endsAtSentenceBoundary, continuousSilenceCutAllowed } from './segment-boundary';
import { foldConfirmedWithDraft } from './text-merge';
import type { SegmentPauseAccount } from './segment-pause';
import { isFunasrFlushFamily, feedVadClosureSilence, type FlushOutcome } from './flush-final';
import { raceSpawnTimeout } from './spawn-timeout';
import { recordClosingDialFailure } from './owed-voice-verdict';
import { logCutIfFlushed, type LastFlushFacts, type CutPointFacts } from './cut-log';
import { PCM_BYTES_PER_MS } from './tuning-env';

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
  /** card CR-12-D — see `ReplayTailHost.heardUpToSeq`. Set ONLY where the feed
   *  gate is rewound ({@link rewindToFlushBoundary}); consumed and cleared by the
   *  next replay.
   *  ⚠️ CORRECTED by card HANGUP-1: this used to add 「so a redial after a
   *  hang-up — which rewinds nothing and replays only audio no leg heard —
   *  reports zero overlap」. The hang-up now rewinds too; what stays true is
   *  that audio which arrived while NO leg was attached sits above this seq and
   *  is never counted as overlap. */
  legHeardUpToSeq: number;
  /** card HANGUP-1 — see {@link rewindToFlushBoundary}. */
  unheardVoice: boolean;
  /** card HANGUP-3 — set by {@link recordClosingDialFailure}; read by the owed-voice verdict. */
  closingDialError: Error | null;
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
  /** card RC-1 — ttempt.leg names the leg this spawn created, so its failure closes that leg and no other. */
  spawnEngine(coldOpen?: boolean, attempt?: SpawnAttempt): Promise<void>;
  /** card RC-1 — the current leg is still opening (spawnEngine); a cut must not flush it. */
  readonly engineOpening: boolean;
  /** card RC-1 — see {@link startRollover}. */
  cutDeferred: boolean;
  closeEngine(): Promise<void>;
  /** `askEngine: false` — card HANGUP-2, see {@link flushAndCloseLegForSilence}. */
  flushFinal(askEngine?: boolean): Promise<FlushOutcome>;
  /** card HANGUP-2 — bytes handed to THIS leg; zeroed where every leg is born (`spawnEngine`). */
  legFedBytes: number;
  /** card RC-5a — the part of {@link legFedBytes} that carried gate-accepted audio (`leg-facts.ts`). */
  legVoicedBytes(): number;
  /** card RC-5a — set only for the instant a ROW cut on a withheld chunk starts: the
   *  boundary below the closed run's tail (`pause-cut-boundary.ts`); null otherwise. */
  cutFloorSeq: number | null;
  /** NR-50 — the withheld-flush exit (`FlushOutcome.refused`): says so on the
   *  wire, since the leg's text is about to be banked as `''`. */
  noteFlushRefused(timedOut: boolean): void;
  /** `whileClosing` — card HANGUP-1, see {@link dialLeg}. */
  replayBufferTail(gateUnfed?: boolean, whileClosing?: boolean): void;
  flushAndEmitFinal(isSegment: boolean, durationMs: number): Promise<boolean>;
  /** card CR-12-D — fold one closed leg's word spans into the pause account.
   *  `flushAndEmitFinal` calls it for itself; the two flushes in THIS file that
   *  bank without emitting (leg rotation, silence hang-up) have to call it, or
   *  a segment that crossed a leg seam loses the half of its audio that ran
   *  before the seam and reports a pause shorter than it was. */
  noteLegClosed(r: FinalResult): void;
  /** card CR-12-D — see {@link beginNextSegment}. */
  beginPauseSegment(): void;
  /** card RC-6 — written by `flushFinal` only; read for the `stt.cut` line (cut-log.ts). */
  readonly lastFlush: LastFlushFacts | null;
  /** card RC-A — the boundary a retiring flush in flight still owes the next leg; the ring is pinned there
   *  (`replay-debt.ts` `retentionFloorSeq`). Set by {@link holdRetiringFloor}, released by the replay. */
  retiringFloorSeq: number | null;
  /** card RC-J — an overdue cut's point, set only for the instant its rollover starts (like {@link cutFloorSeq}). */
  readonly cutPoint: CutPointFacts | null;
  /** card RC-E — `OrchestratorOptions.continuous`; read by {@link flushAndCloseLegForSilence}. */
  readonly continuous: boolean;
  /** card RC-E — the facts a row final carries out of the class, for the hang-up's row cut
   *  ({@link endRowAtSilence}); the same ones `flushAndEmitFinal` writes and reads. */
  accumEmittedByFinal: boolean;
  sessionProducedText: boolean;
  readonly pauseAccount: SegmentPauseAccount;
  emit(event: string, payload: unknown): boolean;
}

/** card SEG-1 — at most one rollover in flight; the ONE place a cut verdict
 *  becomes work. `deliver` carries whether this is a ROW ending or only a LEG
 *  (card SEG-4). Policy + full account: `stt/segment-boundary.ts`.
 *
 *  card NR-60 — returns whether this call BECAME work. The guard is unchanged;
 *  it just stopped being silent about refusing, because the audio budget fires
 *  from the chunk path and has to know (see `SoftSegmentCadence.rotateLegForAudioBudget`). */
export function startRollover(host: RolloverHost, deliver: boolean): boolean {
  if (host.rolloverWork || host.terminated || host.terminalizing || !host.engine) return false;
  // 🔴 card RC-1 — never flush a leg that is still OPENING. It has heard nothing (Soniox answers lush() on a
  // non-open socket at once, so the row was minted from the bank), and closing it rejected the opening leg ⇒
  // the ladder counted our own act as a failure (CR-12-E root cause §1.4 step 1). A DELIVERY cut is not
  // dropped: it is owed, and pushChunk runs it on the first chunk after the leg opens — by then the leg has
  // been replayed what it owes, so the words said before the pause land in the row the pause ends. A leg
  // ROTATION is simply refused (the cadence re-arms; the leg that is opening is a fresh leg anyway).
  if (host.engineOpening) { if (deliver) host.cutDeferred = true; return false; }
  // 🔴 RC-E follow-up (MAIN 2026-09-24) — never start a second flush on a leg the idle hang-up is already
  // flushing (`flushing` outside a rollover or a terminal flush is exactly that; `engine-idle-hangup.ts`
  // `isLegBusy` reads the same fact from the other side). Refused, NOT deferred: the hang-up folds this row's
  // text into the bank (or, in a long recording, ends the row itself), so there is nothing left for the cut
  // to carry. Reached in push-to-talk when `due` flips inside the hang-up's flush window and the pause arm
  // fires; before this guard the leg was flushed twice (test/stt-hangup-cut-race.test.ts).
  if (host.flushing) return false;
  if (deliver) host.cutDeferred = false;
  runRollover(host, deliver);
  return true;
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
  const attempt: SpawnAttempt = { leg: null }; // card RC-1
  try {
    await raceSpawnTimeout(host.spawnEngine(false, attempt), host.engineSpawnTimeoutMs, host._setTimeout, host._clearTimeout);
  } catch (err) {
    if (!host.terminated && !host.terminalizing) host.ladder.handleEngineError(err as Error, attempt.leg);
    else recordClosingDialFailure(host, err); // card HANGUP-3
    return false;
  }
  if (host.terminated) { await host.closeEngine(); return false; }
  // 🔴 card HANGUP-2 — {@link dialLeg}'s HANGUP-1 rule, which this spawn did not
  // have: a leg that lands while the recording is CLOSING is kept, handed what no
  // leg has heard, and left for the closing flush. Closing it here dropped the
  // words said during the rollover's flush round trip (they were rewound above
  // the boundary and owed to exactly this leg), silently.
  if (host.terminalizing) { host.replayBufferTail(true, true); return false; }
  return true;
}

/**
 * 🔴 card HANGUP-1 — F-2152's seam as ONE guard for every flush that retires a
 * leg: both rollover branches below AND the silence hang-up. Two copies of a
 * seam rule is how they drift, and they had: the rollover took this boundary
 * and the hang-up never did.
 *
 * THE FACT IT RESTS ON. A flush does not stop the leg taking audio — the leg
 * stays `open` for the whole round trip (Soniox: the end-of-stream frame is
 * answered by `{finished:true}`, `packages/stt-cloud/src/engines/soniox.ts`
 * `flush()`), so the chunk path keeps pushing into it and keeps advancing
 * `lastEngineFedSeq`. Those chunks are not in the flush's final (F-2152), and
 * the next leg is replayed only `seq > lastEngineFedSeq`. Without the rewind,
 * speech that starts while a silence hang-up is closing the leg exists nowhere,
 * and nothing says so.
 *
 * THE OTHER HALF — `unheardVoice`. `lastEngineFedSeq` is a HIGH-WATER MARK, and
 * the chunk path also advances it for chunks the VAD gate withheld (so a long
 * silence is never replayed — RT-2). That is only sound while every voiced chunk
 * below the mark has been handed to some leg. While one has not (no leg open:
 * a redial or rollover still connecting, a cold open, a ladder rung — or the
 * rewound range below), a withheld chunk that advances the mark buries the
 * voice beneath it, and the replay skips it. MEASURED against the live vendor
 * (card HANGUP-1): a redial took ~1 s, 「大家好，」 is followed by a comma-length
 * pause, the gate closed in it, and 「大家好，」 was lost in 6 of 6 runs — with
 * the hang-up flush long finished. Pinned by
 * `test/stt-idle-hangup-flush-window.test.ts` 「a silent chunk behind the word
 * does not mark the word as heard」. So while `unheardVoice` is set
 * the mark does not move on withheld chunks (they are replayed with the voice),
 * and it is cleared by the replay that hands everything above the mark to a leg
 * (`orchestrator-core.ts` `replayBufferTail`) or by a live push.
 *
 * It is set here — the flush handed the old leg audio past the boundary, i.e.
 * voiced audio, since withheld chunks are never pushed — and on the chunk path
 * when an accepted chunk finds no open leg. `fedBytes` (not the seq) decides
 * because the seq range also covers withheld chunks, which owe nobody anything.
 */
export interface FlushBoundary { readonly seq: number; readonly fedBytes: number }

/** card RC-A — pin the ring at [boundary] for the flush that is about to start: the leg keeps being
 *  handed audio during the round trip, the mark runs ahead of the boundary, and a round trip longer
 *  than the 5 s window would otherwise prune the head of what the next leg is replayed
 *  (`replay-debt.ts` `retentionFloorSeq` has the whole account). */
function holdRetiringFloor(host: RolloverHost, boundary: FlushBoundary): void { host.retiringFloorSeq = boundary.seq; }

export function takeFlushBoundary(host: RolloverHost): FlushBoundary {
  // card RC-5a: a row cut decided on a withheld chunk takes its boundary below the
  // closed run's tail, so the next leg hears the onset that tail may hold. Only the
  // boundary moves — `lastEngineFedSeq` does not, so `rewindToFlushBoundary`'s
  // `legHeardUpToSeq` still covers those chunks and the pause arithmetic counts them once.
  const seq = host.cutFloorSeq === null ? host.lastEngineFedSeq : Math.min(host.lastEngineFedSeq, host.cutFloorSeq);
  return { seq, fedBytes: host.engineFedBytes };
}

/** Called once the old leg is closed and BEFORE `engineFedBytes` is reset —
 *  see {@link takeFlushBoundary}. */
export function rewindToFlushBoundary(host: RolloverHost, boundary: FlushBoundary): void {
  host.legHeardUpToSeq = host.lastEngineFedSeq; // CR-12-D: what the old leg heard, BEFORE the rewind
  host.lastEngineFedSeq = boundary.seq;
  if (host.engineFedBytes > boundary.fedBytes) host.unheardVoice = true;
  // card RC-A — nothing voiced above the boundary ⇒ the replay owes nothing from it (withheld chunks advance
  // the mark again as they arrive, RT-2), so the ring may prune it. Voice owed ⇒ the replay releases it.
  else host.retiringFloorSeq = null;
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
  const boundaryMs = host.now(); // card RC-E — the row's end, if this hang-up ends it (the N1-B1 instant)
  const boundary = takeFlushBoundary(host); // card HANGUP-1 — the seam the rollover already had
  holdRetiringFloor(host, boundary); // card RC-A
  feedVadClosureSilence(engine, host.now());
  host.flushErrored = false; host.flushing = true;
  // 🔴 card HANGUP-2 — a leg that was handed NO audio is not asked for a transcript
  // (primary-owner ruling). Its answer is already known, and asking is not free:
  // Soniox answers an end-of-stream on a session that got no audio with
  // `[invalid_request] No audio received.`, stt-cloud maps that to
  // STT_NO_ENGINE_REACHED (retryable:false), and when the RECORDING did capture
  // voice ENG-4 rightly lets it through — so a leg opened by a segment cut and
  // hung up in the silence after it put 「nothing was transcribed」 on the phone
  // next to a row holding every word (card HANGUP-1's live runs: 2 of 6).
  // Not asking settles on exactly what a flush that produced nothing settles on.
  // ⚠️ Keyed on `legFedBytes`, THIS leg's own count — not `engineFedBytes` (a
  // ladder rung inherits it) and not a recording-wide fact. Widening ENG-4
  // instead would make one code answer both 「unreachable」 and 「empty leg」.
  // ⚠️ Scope when written: the hang-up only. card HANGUP-3 extended the same rule
  // to the terminal flush (`flushAndEmitFinal`, orchestrator-core.ts); the leg
  // ROTATION flush in `rolloverSegment` below still asks. Pinned by
  // test/stt-empty-leg-and-owed-voice.test.ts.
  // ⚠️ 更正（RC-5a，2026-09-24）：the test was `host.legFedBytes > 0` (bytes). A row cut now
  // replays the withheld tail of its closed run, so a leg can hold bytes and no voice; the
  // rule is about voice (book 15 §2.0-d RC-5a correction), and so is the test.
  const sinceMs = host.now(); // card RC-6
  const { result, refused, timedOut } = await host.flushFinal(host.legVoicedBytes() > 0);
  host.flushing = false;
  host.noteLegClosed(result); // card CR-12-D — this leg's audio ran even if its text was withheld
  // 🔴 card RC-E — in a LONG RECORDING this hang-up ends the row instead of banking it, when the row is old
  // enough and holds a word (`continuousSilenceCutAllowed`). Never on a withheld / errored-empty flush (no
  // final of any kind leaves then, as in `flushAndEmitFinal`), never once the recording is closing (the
  // terminal final settles the bank). The `stt.cut` line says which: reason 'pause' ⇒ a row ended here.
  const endsRow = host.continuous && !refused && !(host.flushErrored && result.text === '') && !host.terminalizing
    && continuousSilenceCutAllowed(boundaryMs - host.segmentStartMs, result.text);
  logCutIfFlushed({ kind: 'hangup', reason: endsRow ? 'pause' : null, segment_idx: host.currentSegmentIdx, boundary_seq: boundary.seq, replayed_ms: null }, host.lastFlush, sinceMs); // card RC-6
  if (host.terminated) { host.retiringFloorSeq = null; return; } // RC-A: no leg will be replayed
  if (refused) host.noteFlushRefused(timedOut); // NR-50: `result.text` is '' by refusal — say so before banking it
  if (endsRow) endRowAtSilence(host, result, boundaryMs);
  else { host.offlineAccum = result.text; host.onlineDraft = ''; }
  await host.closeEngine();
  rewindToFlushBoundary(host, boundary);
}

/**
 * card RC-E — the hang-up's row cut: the same final `flushAndEmitFinal` mints for a row
 * (`orchestrator-flush.ts`: the RT3-B / EMPTY-1 latches, `pause_before_ms`, then the
 * index spent with the clock through {@link beginNextSegment}), with the text the flush
 * just settled — which IS the whole row, bank included (`raceFlushFinal`). 'pause' for
 * the seam: the terminator on it is the engine's, produced at a real silence. The
 * cadence is re-armed because the row it was timing has ended; with no leg attached its
 * phase 1 re-arms itself until the redial (`SoftSegmentCadence.arm`).
 */
function endRowAtSilence(host: RolloverHost, r: FinalResult, boundaryMs: number): void {
  host.accumEmittedByFinal = true; if (r.text !== '') host.sessionProducedText = true;
  const pauseBeforeMs = host.pauseAccount.pauseBeforeMs();
  host.emit('final', {
    text: seamText(r.text, 'pause'), confidence: r.confidence, language: r.language,
    segment_idx: host.currentSegmentIdx, is_segment: true, duration_ms: boundaryMs - host.segmentStartMs,
    ...(pauseBeforeMs !== null ? { pause_before_ms: pauseBeforeMs } : {}),
  });
  beginNextSegment(host, boundaryMs);
  host.offlineAccum = ''; host.onlineDraft = '';
  host.cadence.arm();
}

/**
 * card RT-2 hook — dial the leg back because audio is here again.
 *
 * ⚠️ The spawn is capped by `raceSpawnTimeout`, unlike the ladder's reconnect
 * (RT3-C: "the reconnect path has no spawn timeout", an OPEN account this card does not close
 * because changing the ladder's timing is a product ruling). This is a NEW path,
 * so it gets the cap the cold open already has and inherits no debt.
 * ⚠️ 更正（NR-96，2026-09-24）：the ladder's reconnect spawn is now capped too
 * (`engine-session.ts attemptReconnect`, `attemptTimeoutMs` = this same
 * `engineSpawnTimeoutMs`); RT3-C is closed. The sentence above is kept as history.
 *
 * Returns false when the dial failed and the LADDER has taken over, so recovery
 * has exactly one owner.
 */
export async function dialLeg(host: RolloverHost): Promise<boolean> {
  const attempt: SpawnAttempt = { leg: null }; // card RC-1
  try {
    await raceSpawnTimeout(host.spawnEngine(false, attempt), host.engineSpawnTimeoutMs, host._setTimeout, host._clearTimeout);
  } catch (err) {
    if (!host.terminated && !host.terminalizing) host.ladder.handleEngineError(err as Error, attempt.leg);
    else recordClosingDialFailure(host, err); // card HANGUP-3
    return false;
  }
  // 🔴 card HANGUP-1 — only `terminated` closes the leg now. A dial that lands
  // while the recording is CLOSING (a release, an auto-stop) exists because
  // voice arrived that no leg has heard; both terminal paths await this dial
  // (`idle.settle()`) BEFORE they read `engine`, so the leg is kept and the
  // closing flush transcribes it. Closing it here was the old answer, and it
  // dropped every word said between a hang-up and a release.
  if (host.terminated) { await host.closeEngine(); return false; }
  host.engineFedBytes = 0; // a fresh leg has been handed nothing yet
  host.replayBufferTail(true, host.terminalizing); // gated: only what no engine has heard
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
  // 🔴 card RC-6 — ONE `stt.cut` line per rollover that flushed a leg, on every exit (cut-log.ts). The
  // head is taken HERE, before the first await, i.e. the same instant `takeFlushBoundary` reads.
  const sinceMs = host.now();
  const head = { kind: 'segment' as const, reason: deliver ? host.cadence.lastCutReason : 'leg' as const, segment_idx: host.currentSegmentIdx, boundary_seq: takeFlushBoundary(host).seq, replayed_ms: null as number | null, x: host.cutPoint }; // RC-5a floor included (integration); RC-J cut point
  try { await rolloverSegmentBody(host, deliver, head); } finally {
    logCutIfFlushed(head, host.lastFlush, sinceMs);
    // card RC-A — a rollover that ended without handing the next leg its replay releases the pin only when no
    // leg ever will: the recording is closing. A failed spawn keeps it — the ladder's rung replays from there.
    if (host.terminated || host.terminalizing) host.retiringFloorSeq = null;
  }
}

/** The rollover itself; `rolloverSegment` above only wraps it with the RC-6 line. `cut.replayed_ms` is filled
 *  where the next leg is handed its replay. */
async function rolloverSegmentBody(host: RolloverHost, deliver: boolean, cut: { replayed_ms: number | null }): Promise<void> {
  if (host.terminated || host.terminalizing || !host.engine) return;
  // F-2152: chunks fed during the flush round-trip aren't in segment N's final;
  // re-arm the gate to this PRE-flush boundary so the seam carries.
  // (card HANGUP-1: taken and applied through the shared guard.)
  const boundary = takeFlushBoundary(host);
  holdRetiringFloor(host, boundary); // card RC-A
  // card N1-B1: ONE instant is the segment boundary, and both gates are read off
  // it — the seq gate above (F-2152) and the clock anchor below. Taken BEFORE
  // the flush for the same reason `boundary` (was `finalizedSeq`) is: audio arriving during the
  // flush round trip belongs to the NEXT segment, so the round trip must not
  // land inside the segment that is closing.
  const boundaryMs = host.now();
  if (!deliver) {
    host.flushErrored = false; host.flushing = true;
    const { result, refused, timedOut } = await host.flushFinal();
    host.flushing = false;
    host.noteLegClosed(result); // card CR-12-D — same reason as the silence hang-up above
    if (host.terminated) return;
    if (refused) host.noteFlushRefused(timedOut); // NR-50: '' by refusal, not by emptiness
    // The bank; `accumEmittedByFinal` stays false — no wire final carried this.
    host.offlineAccum = seamText(result.text, 'leg');
    host.onlineDraft = '';
    if (host.terminalizing) { await payClosingSeam(host, boundary, false); return; } // stop() settles from the bank (RC4-S5: after the seam is paid)
    await host.closeEngine();
    if (host.terminated) return;
    if (host.terminalizing) { await payClosingSeam(host, boundary, false); return; } // card RC4-S5
    rewindToFlushBoundary(host, boundary);
    host.engineFedBytes = 0;
    if (!(await spawnRolloverEngine(host))) return; // card P0-1: ladder has taken over
    host.replayBufferTail(true);
    cut.replayed_ms = host.legFedBytes / PCM_BYTES_PER_MS; // card RC-6 — a fresh leg: all it holds is the replay
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
  if (host.terminalizing) { if (emitted) beginNextSegment(host, boundaryMs); await payClosingSeam(host, boundary, emitted); return; } // card RC4-S5
  await host.closeEngine();
  if (host.terminated) return;
  if (host.terminalizing) { if (emitted) beginNextSegment(host, boundaryMs); await payClosingSeam(host, boundary, emitted); return; } // card RC4-S5
  beginNextSegment(host, boundaryMs);
  host.offlineAccum = '';
  host.onlineDraft = '';
  rewindToFlushBoundary(host, boundary);
  host.engineFedBytes = 0; // a fresh engine has been handed nothing yet
  if (!(await spawnRolloverEngine(host))) return; // card P0-1: ladder has taken over
  host.replayBufferTail(true);
  cut.replayed_ms = host.legFedBytes / PCM_BYTES_PER_MS; // card RC-6
  host.cadence.arm();
}

/**
 * 🔴 card RC4-S5 — THE RELEASE CAME WHILE THIS ROLLOVER'S FLUSH WAS OUT, AND THE
 * USER KEPT TALKING. The leg stays `open` for the whole round trip, so the chunk
 * path keeps handing it audio — after its end-of-stream frame, which the vendor
 * does not transcribe (measured for Soniox, test/fixtures/stt-outage-harness.ts,
 * HANGUP-2 block). On the ordinary path those chunks are rewound and replayed to
 * the next leg (F-2152). The terminal fence used to make this rollover bail right
 * after its flush — `stopRecording` says why: not to open a vendor connection only
 * to close it — and the stop path then flushed the SAME, already-finished leg: no
 * leg ever heard what was said during the round trip, and the relay said
 * STT_SEGMENT_NOT_TRANSCRIBED. Measured on the device (CR-12-E re-run 4, S5): a
 * 36.6 s flush, 19.6 s of speech in it, never transcribed.
 *
 * So the fence keeps its reason and loses its reach: nothing voiced past the
 * boundary ⇒ bail exactly as before (the leg stays attached, the release settles
 * on it). Voice owed ⇒ the leg is closed, the boundary rewound, and ONE closing
 * leg is dialled through {@link spawnRolloverEngine} — HANGUP-2's rule: a leg that
 * lands while the recording is closing is kept, handed the gated replay, and left
 * for the closing flush. Its failure is recorded for the owed-voice verdict.
 *
 * [rowDelivered] — the row's final already went out (the fence rose while the leg
 * was being closed): its text left with it, so the bank is emptied as the ordinary
 * path empties it, or the closing flush would send the row a second time. Otherwise
 * the row's text stays in the bank and the terminal final carries it with the tail.
 */
async function payClosingSeam(host: RolloverHost, boundary: FlushBoundary, rowDelivered: boolean): Promise<void> {
  if (host.terminated || !(host.unheardVoice || host.engineFedBytes > boundary.fedBytes)) return;
  if (rowDelivered) host.offlineAccum = '';
  else host.offlineAccum = foldConfirmedWithDraft(host.offlineAccum, host.onlineDraft);
  host.onlineDraft = '';
  if (host.engine) await host.closeEngine();
  if (host.terminated) return;
  rewindToFlushBoundary(host, boundary);
  host.engineFedBytes = 0;
  await spawnRolloverEngine(host);
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
  // card CR-12-D — the FOURTH fact that means 「a new segment is open」, put here
  // with the other three for exactly the reason N1-B1 gave: facts that move
  // together must move in one place or they drift. It banks the closing
  // segment's trailing silence, which the NEXT segment's final will report.
  host.beginPauseSegment();
  // card SEG-1 — the third fact that means "a new segment is open", moved
  // here with the other two so they cannot drift apart (that WAS N1-B1).
  host.cadence.reset();
}
