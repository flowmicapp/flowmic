// Card P0-1 — a rollover-phase engine spawn failure must never crash the relay.
//
// SPEC-REF:
//   docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md §2 P0-1
//   apps/server-core/src/error-handling.ts installProcessGuards (every real
//     `unhandledRejection` is handed to `onFatal` -> `exit(FATAL_EXIT_CODE)`)
//
// ── THE ACCOUNT ──────────────────────────────────────────────────────────────
// `onEngineSessionExpired` / `startRollover` used to assign
// `this.rolloverSegment(...).finally(...)` to `rolloverWork` with no `.catch`,
// and `rolloverSegment`'s own rollover-phase spawn was a bare
// `await this.spawnEngine()` — no `raceSpawnTimeout`, no catch — unlike
// `dialLeg` (the silence-redial spawn), which was already wrapped. An `open()`
// rejection during a rollover therefore became a real Node `unhandledRejection`,
// which the process guard turns into `exit(FATAL_EXIT_CODE)` for the WHOLE
// relay process: ONE Soniox rollover-open refusal on ONE session took down
// every other live session on the box.
//
// This drives the REAL orchestrator + REAL ladder against the N1-B4
// engine-session wall (the deterministic, VAD/sentence-independent rollover
// trigger already used by stt-engine-session-rollover.test.ts) and fails the
// SECOND engine's `open()`. The assertion is a real process-level
// `unhandledRejection` watch — the exact signal error-handling.ts reacts to —
// not an inference from which internal method got called.
//
// ── REVERSE CONTROL ──────────────────────────────────────────────────────────
// Reverting the fix (restoring the bare `await this.spawnEngine()` in
// `rolloverSegment` and the bare `.finally()` with no `.catch` in
// `startRollover`/`onEngineSessionExpired`) turns this test RED: at least one
// `unhandledRejection` is observed. Seen red locally against the pre-fix
// source, then the fix was restored — see the WP-1 report for this run.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH, drain, frame } from './fixtures/stt-outage-harness';

/** 2 s = 10 chunks — the engine-session ceiling, not the quota one (same
 *  construction as stt-engine-session-rollover.test.ts). */
const WALL_MS = 2_000;

/** Real macrotask wait. `unhandledRejection` fires on the tick AFTER the
 *  microtask queue drains (same note as stt-session-bridge.test.ts's
 *  `settleDetached`) — and it rides the REAL event loop even though every
 *  orchestrator/ladder timer in this test is on the FakeClock, because a
 *  rejected promise's `unhandledRejection` dispatch is a Node runtime fact,
 *  not something an injected clock can drive. */
const settleReal = (ms = 30): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('P0-1 — a rollover spawn failure never becomes an unhandledRejection', () => {
  it('open() rejects on the ROLLOVER engine ⇒ the ladder engages instead of crashing the process', async () => {
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);

    const clock = new FakeClock(T0);
    const session = new AudioSession({
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      hardLimitMs: WALL_MS,
    });
    session.start();

    let spawnCount = 0;
    const orch = new SttEngineOrchestrator(
      session,
      () => {
        spawnCount += 1;
        // Cold open (spawn #1) succeeds; every ROLLOVER spawn after it fails —
        // this is the exact shape P0-1 names: the failure lands mid-recording,
        // not at audio:start (which was already covered by raceSpawnTimeout).
        return new TranscribingEngine(ZH, clock, { open: spawnCount === 1 ? 'ok' : 'reject' });
      },
      {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        softSegmentMs: 600_000, // out of reach — only the engine-session wall may fire
      },
    );

    const statuses: { status: string }[] = [];
    orch.on('engine-status', (p: { status: string }) => statuses.push(p));
    orch.on('error', () => { /* listener mandatory on EventEmitter; content not this test's subject */ });
    orch.on('final', () => { /* ditto */ });

    try {
      await orch.start({ language: ZH.lang, mode: 'realtime' });

      let seq = 0;
      for (let i = 0; i < 20; i++) { // 4 s of audio — two engine-session ceilings
        orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
        seq += 1;
        await clock.advance(CHUNK_MS);
      }
      // Let the ladder's own backoff timers (1s/2s/4s, also on the FakeClock)
      // play all the way out to exhaustion, generously bounded.
      await clock.advance(20_000);
      await drain();
      await settleReal(); // give a real unhandledRejection, if any, its own tick to fire

      // Positive control FIRST: the rollover really did try a second engine,
      // and it really did fail — otherwise "no rejection" would be vacuous.
      expect(spawnCount).toBeGreaterThan(1);
      expect(statuses.some((s) => s.status === 'reconnecting' || s.status === 'failed')).toBe(true);

      // 🔴 THE ASSERTION — no unhandled rejection reached the process. This is
      // the exact signal `error-handling.ts` turns into `exit(FATAL_EXIT_CODE)`.
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      await orch.close();
    }
  });
});
