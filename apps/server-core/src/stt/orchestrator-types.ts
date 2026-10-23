// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §1 (soft_segment_ms 30000,
//     server_replay_buffer_ms 5000, engine_reconnect backoff/retries), §2
//   Ported from legacy stt/orchestrator-types.ts (mechanism carried over unchanged). Shared option /
//   type contracts split out to keep orchestrator-core.ts under the file cap.

import type { EventEmitter } from 'node:events';
import { AUDIO_DEFAULTS, type ProcessingMode } from '@flowmic/protocol';
import type { SttEngine, FinalResult, InterimResult } from './engines/base';

export const DEFAULT_SOFT_SEGMENT_MS = 30_000;
/**
 * card SEG-1 — how long past {@link DEFAULT_SOFT_SEGMENT_MS} the orchestrator
 * keeps looking for a decent place to end the segment before cutting anyway.
 *
 * 15 s, and the reasoning is stated rather than tuned: the boundary signals it
 * waits for (a VAD pause, or a sentence terminator in the engine's CONFIRMED
 * text — `stt/segment-boundary.ts`) arrive within a second or two of the
 * deadline in ordinary speech, so this number is only ever spent by the two
 * cases that produce neither: a speaker who does not pause AND an engine with
 * no punctuation model. Half the cadence bounds the worst-case row at 45 s,
 * which is still one row per stretch of speech rather than one per stopwatch.
 */
export const DEFAULT_SOFT_SEGMENT_GRACE_MS = 15_000;
export const DEFAULT_REPLAY_WINDOW_MS = 5_000;
/** engine.open()/flush() caps so audio:start ack + final always fire. */
export const DEFAULT_ENGINE_SPAWN_TIMEOUT_MS: number = AUDIO_DEFAULTS.engine_spawn_timeout_ms; // NR-96: declared once in the protocol
export const DEFAULT_ENGINE_FLUSH_TIMEOUT_MS: number = AUDIO_DEFAULTS.engine_flush_timeout_ms; // RC4-S5 follow-up: declared once in the protocol

/**
 * NR-38 — the cold-open cap for an engine whose `open()` is a MODEL LOAD rather
 * than a dial.
 *
 * WHY IT HAD TO BE SAID OUT LOUD THE DAY THE LOOP WAS FREED. Until sherpa-local
 * stopped building its ONNX session on the JS thread, the 5 s cap above could
 * not fire against it at all: the native constructor blocked the loop straight
 * past the due time and the settled work promise, a microtask, beat the timer
 * every run (ledger §25 / G10). Freeing the loop makes that cap LIVE on this
 * path for the first time — and 5 s is a number chosen for reaching a SERVER.
 * The measurements say those are not the same question:
 *
 *   SenseVoice, 229 MB   cold open 1_852 ms            (dev-pc-a, measured 2026-09-13)
 *   whisper-turbo, 1.03 GB  frame at 6_019‥7_976 ms    (ledger §25, 8 cold runs)
 *
 * ⇒ keeping 5 s here would have turned a whisper-turbo cold start that works
 * today into a loud STT failure, which is not a defect anyone reported and not
 * what NR-38 asked for. 60 s is NOT a new policy number: it is the ceiling G10
 * already reasoned its way to for this exact path (`verify/golden/
 * g10-record-only.mjs` MOBILE_TOLD_CEILING_MS), and for the reason written
 * there — "a LIVENESS bound, not a performance claim", because what really
 * bounds this open is how long this machine takes to read and load whichever
 * pack the user downloaded, which is not a number the product can know.
 *
 * ⚠️ What it buys: a local open that is genuinely STUCK now ends, loudly, at
 * 60 s. Before this it ended never.
 */
export const LOCAL_MODEL_ENGINE_SPAWN_TIMEOUT_MS = 60_000;

/**
 * The cold-open cap for one engine id, or `undefined` for "the default is
 * right". Exported as a function of the id rather than inlined at the call
 * site so the answer has ONE author and one test.
 */
export function spawnTimeoutForEngine(engineId: string): number | undefined {
  return isLocalModelEngine(engineId) ? LOCAL_MODEL_ENGINE_SPAWN_TIMEOUT_MS : undefined;
}

/**
 * NR-38 — "this engine LOADS A MODEL instead of dialling a server".
 *
 * `sherpa-local` is the only one (probe-routes.ts calls the same id
 * 'local-model'). A second one belongs on this line, not in a second `if`
 * somewhere else — which is why this was lifted out of
 * {@link spawnTimeoutForEngine}: two facts now hang off it and they must not be
 * able to disagree. It answers BOTH "how long may the cold open take"
 * (60 s rather than the 5 s meant for reaching a server) and "does the user get
 * told during that wait" (`engine-status{loading}`, emitted by
 * `orchestrator-core.ts spawnEngine`). An engine that dials gets neither.
 */
export function isLocalModelEngine(engineId: string): boolean {
  return engineId === 'sherpa-local';
}

/**
 * Card RT-2 — how long the voice may be absent before the ENGINE LEG is hung up.
 *
 * 3 s is the plan's number, not a tuned one:
 * `docs/archive/strategy/2026-08-08-030-unified-plan-and-ledger.md` RT-2 "silence ≥3s ⇒
 * hang up / press again to redial". It is written down here rather than inlined so that the day it IS
 * measured there is one place to change.
 *
 * ⚠️ It is deliberately NOT a default on {@link OrchestratorOptions}: see
 * `idleHangupMs` for why the orchestrator must be told, not left to infer.
 */
export const DEFAULT_ENGINE_IDLE_HANGUP_MS = 3_000;
// ⚠️ 更正（IDLE-1，2026-10-14）：「the voice may be absent」 above now means SILENCE
// IN THE RECEIVED AUDIO (gate-refused chunks, by their audio duration), no longer
// wall-clock time without audio (`engine-idle-hangup.ts` `noteChunk`). And 3 s is
// now the LONG-RECORDING value only (RC-E's 「≥3 s of silence ends a row」 hangs off
// it, as does the `ge_3s` closure bucket in `vad-gate.ts`); a held press uses
// {@link PRESS_ENGINE_IDLE_HANGUP_MS}. The one writer that chooses is
// `engine-factory.ts`, from `audio:start.continuous`.

/**
 * card IDLE-1 — the hang-up threshold while a press is held (push-to-talk, i.e.
 * every session that is not a long recording). Owner decision 2026-10-14
 * (`docs/decisions/2026-10-14-owner-long-recording-unpolished-no-mark.md`,
 * appendix 「句中空闲挂断」): production stats put 6 s / 10 s at +0.5% / +0.9%
 * connection time, which removed the cost premise the 3 s was chosen on.
 */
export const PRESS_ENGINE_IDLE_HANGUP_MS = 10_000;

/**
 * card IDLE-1 — wall-clock backstop: a leg that has been handed no audio for this
 * long is hung up (same silent, flush-first path) even though no silence was
 * RECEIVED — the uplink stalled, or the phone sent `audio:pause`. Below the
 * vendor's own idle close (Soniox 22.2 s measured, `soniox.ts` flush doc
 * 「22-second idle close」) so that close never reaches the reconnect ladder as a
 * drop; above {@link PRESS_ENGINE_IDLE_HANGUP_MS}, because gate-refused silence is
 * not handed to the vendor either and the backstop must not pre-empt it.
 */
export const ENGINE_IDLE_WALL_BACKSTOP_MS = 15_000;

/** Each call returns a FRESH (unopened) engine — new session per soft-segment
 *  (06 §2.2, reset STT context). */
export type SttEngineFactory = () => SttEngine;

export interface OrchestratorOptions {
  softSegmentMs?: number;
  /** card SEG-1 — see {@link DEFAULT_SOFT_SEGMENT_GRACE_MS}. */
  softSegmentGraceMs?: number;
  hardLimitMs?: number;
  reconnectBackoffMs?: readonly number[];
  maxRetries?: number;
  /** card RC-1 — this session is a LONG RECORDING (`audio:start.continuous === true`,
   *  book 04): the reconnect ladder never gives up on count
   *  (`EngineSessionLadderOptions.unbounded`). The one production writer is
   *  `engine-factory.ts makeSttOrchestratorFactory`, from the audio handler's
   *  `SttStartArgs.continuous`. Absent ⇒ the push-to-talk ladder. */
  reconnectUnbounded?: boolean;
  /** card RC-E — the same fact (`audio:start.continuous === true`) asked a second question, so it gets a
   *  field of its own rather than being read off {@link reconnectUnbounded} (one value, two questions):
   *  may a ≥3 s silence end a row before the 30 s deadline, and does the redial after a hang-up take the
   *  closed run's tail (`segment-boundary.ts` `continuousSilenceCutAllowed`, book 06 §2 RC-E block).
   *  Same one production writer as above. Absent ⇒ push-to-talk rows, byte for byte. */
  continuous?: boolean;
  /** card SEAM-2 (review F2) — `false` for a RECOVERY LEG (`SttStartArgs.recoveryLeg`, written by `engine-factory.ts`):
   *  its rows and its terminal final keep today's text, as on a long recording (`continuous`), the same pair the
   *  bridge's `segmentKeepsPreSeg1Contract` reads. Absent ⇒ the SEAM-2 seam repair runs (`seam-artifact.ts`). */
  seamRepair?: false;
  replayWindowMs?: number;
  /** caps on engine.open() (5_000 ms) / engine.flush() (3_000 ms). */
  engineSpawnTimeoutMs?: number;
  engineFlushTimeoutMs?: number;
  /** VAD gate (master-plan §2.3): when present, a LIVE chunk is pushed to the
   *  engine only if this predicate returns true. The session ring buffer + seq
   *  tracker still record every chunk (replay/gap correctness), so suppressing
   *  silence keeps a metered streaming session off the clock without breaking
   *  reconnect recovery. Absent (default) = feed every chunk (LAN/batch path). */
  shouldFeedEngine?: (c: { seq: number; ts_ms: number; payload: Buffer }) => boolean;
  /**
   * Card RT-2 — connection lifetime follows the voice. After this many ms with no
   * audio handed to the engine, the leg is flushed and hung up (⚠️ 更正 IDLE-1,
   * 2026-10-14: ms of gate-refused audio RECEIVED, not of clock — see
   * {@link DEFAULT_ENGINE_IDLE_HANGUP_MS}); the next chunk
   * the VAD gate accepts dials a fresh one. `0` / absent = never hang up.
   *
   * 🔴 ABSENT IS THE DEFAULT, and that is the decision, not an oversight. The
   * reason to hang up is that a MANAGED STREAMING session is billed by
   * wall-clock, which is the same condition `shouldFeedEngine` is wired under
   * (`engine-factory.ts` `gated` = a VAD gate exists AND the engine is managed
   * AND it streams). On a local/BYOK engine a hang-up buys nothing and costs a
   * cold spawn in front of the user's next word.
   *
   * ⚠️ Deliberately NOT inferred from `shouldFeedEngine !== undefined`. That
   * predicate answers 「should this chunk be fed」 and the inference would make it
   * answer 「is this leg metered」 as well — one value, two questions, this repo's
   * #1 defect shape. The caller that KNOWS is `makeSttOrchestratorFactory`, and
   * it says so in a field of its own.
   */
  idleHangupMs?: number;
  /** card IDLE-1 — see {@link ENGINE_IDLE_WALL_BACKSTOP_MS}, the default whenever
   *  `idleHangupMs` is set (never below it). Exposed for tests; production never sets it. */
  idleWallBackstopMs?: number;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * 🔴 card P2-5/WP-1 (2026-09-02) — `target_lang?: string` used to sit here too.
 * DELETED: `orchestrator-core.ts` never read it (only `.language` is ever
 * consulted — grep confirms it), and `engine/stt-session.ts`'s construction of
 * this object only ever WROTE it, conditionally, to a field nothing read back.
 * `mode` is kept despite the same "orchestrator-core.ts never reads it" fact —
 * it is a REQUIRED field exercised by every production call and every test in
 * this suite, i.e. established API surface rather than an orphaned write.
 */
export interface StartInput {
  language: string;
  mode: ProcessingMode;
}

/** Per 06 §3 every engine IS an EventEmitter; narrow once for type-safe wiring. */
export type EngineSubscriber = SttEngine & EventEmitter & { open?: () => Promise<void> };

export type EngineHandlers = {
  interim: (e: InterimResult) => void;
  final: (e: FinalResult) => void;
  error: (e: Error) => void;
};
