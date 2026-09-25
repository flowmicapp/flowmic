// NR-96 follow-up (2026-09-24) — the relay's audio retention window is the
// reconnect ladder's REAL worst case, derived once.
//
// Card RT-3 pinned unheard audio in the ring for "the longest the ladder can
// possibly spend before it recovers or gives up", and computed that as the
// backoff sum (1+2+4 = 7 s). Since NR-96-A each rung's spawn is capped rather
// than unbounded, so the longest is every wait PLUS every cap
// (`engineReconnectWorstCaseMs`, @flowmic/protocol: 7 s + 3 × 5 s = 22 s).
// With the old number, a recovery on the third rung after two hung dials
// evicted what the user said right after the drop — before any engine heard it.
//
// ⚠️ This is the retention path the CR-12-E root-cause investigation is also
// reading; the change is the grace length only, not the pin logic.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { ENGINE_RECONNECT_WORST_CASE_MS, engineReconnectWorstCaseMs } from '@flowmic/protocol';
import { CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH, frame, type EngineScript } from './fixtures/stt-outage-harness';

function grace(orch: SttEngineOrchestrator): number {
  return (orch as unknown as { unfedGraceMs: number }).unfedGraceMs;
}

describe('NR-96 retention window = the ladder\'s worst case', () => {
  it('defaults: the orchestrator holds exactly ENGINE_RECONNECT_WORST_CASE_MS (22 s), not the 7 s backoff sum', () => {
    const session = new AudioSession({});
    const orch = new SttEngineOrchestrator(session, () => { throw new Error('not spawned'); });
    expect(grace(orch)).toBe(ENGINE_RECONNECT_WORST_CASE_MS);
    expect(grace(orch)).toBe(22_000);
  });

  it('custom options go through the same derivation (schedule, attempts AND the session\'s own spawn cap)', () => {
    const session = new AudioSession({});
    const orch = new SttEngineOrchestrator(session, () => { throw new Error('not spawned'); }, {
      reconnectBackoffMs: [500, 700], maxRetries: 4, engineSpawnTimeoutMs: 12_000,
    });
    expect(grace(orch)).toBe(engineReconnectWorstCaseMs([500, 700], 4, 12_000));
    expect(grace(orch)).toBe(500 + 700 + 700 + 700 + 4 * 12_000);
  });

  it('two hung rungs then a recovery: what was said right after the drop still reaches the recovered engine', async () => {
    const clock = new FakeClock(T0);
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
    session.start();
    const scripts: EngineScript[] = [{ open: 'ok' }, { open: 'hang' }, { open: 'hang' }, { open: 'ok' }];
    const engines: TranscribingEngine[] = [];
    const orch = new SttEngineOrchestrator(session, () => {
      const e = new TranscribingEngine(ZH, clock, { ...scripts[Math.min(engines.length, scripts.length - 1)]!, finalEveryN: 0 });
      engines.push(e);
      return e;
    }, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: 600_000, engineSpawnTimeoutMs: 5_000,
    });
    orch.on('interim', () => { /* listener mandatory */ });
    orch.on('final', () => { /* listener mandatory */ });
    orch.on('error', () => { /* none expected */ });
    orch.on('engine-status', () => { /* noop */ });
    await orch.start({ language: 'zh', mode: 'realtime' });

    let seq = 0;
    const speak = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) { orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) }); seq += 1; await clock.advance(CHUNK_MS); }
    };
    await speak(20);                        // 0‥4 s, heard by the first leg
    engines[0]!.emitDrop();                 // drop at 4 s
    await clock.advance(0);
    const firstUnheard = seq;               // said at 4 s, 0 ms after the drop
    // rung 1 at 5 s hangs → cap at 10 s; rung 2 at 12 s hangs → cap at 17 s;
    // rung 3 at 21 s opens. The user keeps talking the whole time (every push prunes).
    await speak(95);                        // 4 s ‥ 23 s

    expect(engines, 'cold + three rungs').toHaveLength(4);
    const recovered = engines[3]!;
    // Received at 4 s, replayed at 21 s: 17 s old. The backoff sum (7 s) + the 5 s
    // window would have evicted it at 16 s; the real worst case keeps it.
    expect(recovered.heard, 'the first words after the drop reach the engine that finally answered').toContain(firstUnheard);
  });
});
