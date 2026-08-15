// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §1 (soft_segment_ms 30000,
//     server_replay_buffer_ms 5000, engine_reconnect backoff/retries), §2
//   Ported from legacy stt/orchestrator-types.ts (mechanism carried over unchanged). Shared option /
//   type contracts split out to keep orchestrator-core.ts under the file cap.

import type { EventEmitter } from 'node:events';
import type { ProcessingMode } from '@flowmic/protocol';
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
export const DEFAULT_ENGINE_SPAWN_TIMEOUT_MS = 5_000;
export const DEFAULT_ENGINE_FLUSH_TIMEOUT_MS = 3_000;

/**
 * Card RT-2 — how long the voice may be absent before the ENGINE LEG is hung up.
 *
 * 3 s is the plan's number, not a tuned one:
 * `docs/strategy/2026-08-08-030-unified-plan-and-ledger.md` RT-2 "silence ≥3s ⇒
 * hang up / press again to redial". It is written down here rather than inlined so that the day it IS
 * measured there is one place to change.
 *
 * ⚠️ It is deliberately NOT a default on {@link OrchestratorOptions}: see
 * `idleHangupMs` for why the orchestrator must be told, not left to infer.
 */
export const DEFAULT_ENGINE_IDLE_HANGUP_MS = 3_000;

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
   * audio handed to the engine, the leg is flushed and hung up; the next chunk
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
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface StartInput {
  language: string;
  mode: ProcessingMode;
  target_lang?: string;
}

/** Per 06 §3 every engine IS an EventEmitter; narrow once for type-safe wiring. */
export type EngineSubscriber = SttEngine & EventEmitter & { open?: () => Promise<void> };

export type EngineHandlers = {
  interim: (e: InterimResult) => void;
  final: (e: FinalResult) => void;
  error: (e: Error) => void;
};
