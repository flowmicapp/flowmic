// Follow-up to card RC-E (MAIN, 2026-09-24) — a row cut must not start a second flush
// on a leg the idle hang-up is already flushing, in ANY session. Found while RC-E was
// written (the early word-gap arm fired into the hang-up flush); push-to-talk has the
// same race through the pause arm when `due` flips inside the hang-up's flush window.
//
// SPEC-REF:
//   apps/server-core/src/stt/orchestrator-rollover.ts `startRollover` (the guard)
//   apps/server-core/src/stt/engine-idle-hangup.ts `isLegBusy` (「a flush in progress IS
//     the leg being used」 — the same fact, read on the hang-up's side)
//
// The sequence, push-to-talk (`continuous` absent), quiet room (`fixtures/stt-word-leg.ts`):
// words to 7.0 s, then silence. The last fed chunk arms the 3 s idle timer, so the hang-up
// flush runs ~9.85–10.25 s; the cadence's `due` flips at ~10.05 s, inside it, with the gate
// long closed — the pause arm fires on the next chunk. Speech resumes at 10.6 s.
// Claims: no leg is ever asked to flush twice; every word comes out exactly once.
// REVERSE CONTROL: the guard re-scoped to long recordings only reds this case (log in the report).

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { FakeClock, T0 } from './fixtures/stt-outage-harness';
import { CHUNK_BYTES, CHUNK_MS, OPEN_MS, WordLeg, gateSaysVoice, tok, words } from './fixtures/stt-word-leg';

describe('a pause cut during an idle hang-up flush of the same leg', () => {
  it.each([['push-to-talk (continuous absent)', false], ['long recording', true]] as const)('🔴 %s: no second flush on the hanging-up leg, every word once', async (_n, continuous) => {
    const first = words(0, 7_000);
    const WS = [...first, ...words(10_600, 14_000, first.length)];
    const clock = new FakeClock(T0);
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
    session.start();
    const legs: WordLeg[] = [];
    const orch = new SttEngineOrchestrator(session, () => { const l = new WordLeg(WS, clock); legs.push(l); return l; }, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: 10_000, softSegmentGraceMs: 600_000, engineFlushTimeoutMs: 3_000, idleHangupMs: 3_000,
      ...(continuous ? { continuous: true, reconnectUnbounded: true } : {}),
      shouldFeedEngine: (c) => gateSaysVoice(WS, c.seq),
    });
    const texts: string[] = [];
    orch.on('final', (f: { text: string }) => texts.push(f.text));
    for (const e of ['error', 'engine-status', 'interim', 'error-suppressed']) orch.on(e, () => { /* listeners mandatory */ });
    const started = orch.start({ language: 'zh', mode: 'realtime' });
    await clock.advance(OPEN_MS);
    await started;
    for (let seq = 0; seq * CHUNK_MS < 14_000; seq++) {
      const payload = Buffer.alloc(CHUNK_BYTES);
      payload.writeUInt32LE(seq, 0);
      orch.pushChunk({ seq, ts_ms: clock.now, payload });
      await clock.advance(CHUNK_MS);
    }
    const stopped = orch.stop();
    await clock.advance(5_000);
    await stopped;
    // POSITIVE CONTROL: the hang-up did flush the first leg (the race window existed).
    expect(legs[0]!.flushes).toBeGreaterThanOrEqual(1);
    expect(legs.map((l) => l.flushes).filter((n) => n > 1)).toEqual([]);
    expect(texts.join('')).toBe(WS.map(tok).join(''));
  });
});
