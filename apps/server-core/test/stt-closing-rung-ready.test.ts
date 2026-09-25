// card RC6 — the closing rung ends a reconnect, so it says so: `ready` with what
// its replay handed the new leg, on the frames the real SttSessionBridge emits,
// ahead of the terminal final.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md `stt:engine-status` row (the RC6 note)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC6 block, F2 ②)
//   apps/server-core/src/stt/orchestrator-terminal.ts `settleOwedVoice`
//
// THE SHAPE (the CR-12-E re-check 5 yield drill, in miniature): the leg is hung
// up for silence, the user speaks again, the redial is refused (the ladder now
// holds a pending rung), and the release comes. The closing path runs that rung
// once; this time it connects. The phone stopped with its engine "down" and owes
// the tail itself; only this frame can tell it the relay heard the tail after all.
//
// REVERSE CONTROL: the emit removed ⇒ the first case is red (no `ready` after the release).
// POSITIVE CONTROL: an ordinary release (no pending rung) emits no `ready` at all.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from '../src/stt/orchestrator-types';
import { SttSessionBridge } from '../src/engine/stt-session';
import { CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH, drain, frame } from './fixtures/stt-outage-harness';

const SILENCE_CHUNKS = Math.floor(DEFAULT_ENGINE_IDLE_HANGUP_MS / CHUNK_MS) + 1;

/** Leg 0 opens; leg 1 (the redial) is refused unless [redialOk]; leg 2 (the closing rung) opens. */
class ScriptedLeg extends TranscribingEngine {
  constructor(private readonly legIdx: number, clock: FakeClock, private readonly redialOk: boolean) {
    super(ZH, clock, { open: 'ok', finalEveryN: 0 });
  }
  override async open(): Promise<void> {
    if (this.legIdx === 1 && !this.redialOk) throw new Error('connect refused');
    return super.open();
  }
}

async function release(redialOk: boolean): Promise<{ frames: Array<{ event: string; payload: unknown }>; releasedAt: number }> {
  const clock = new FakeClock(T0);
  const frames: Array<{ event: string; payload: unknown }> = [];
  let voiced = true;
  let legs = 0;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => {
      const orchestrator = new SttEngineOrchestrator(session, () => new ScriptedLeg(legs++, clock, redialOk), {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        softSegmentMs: 600_000, shouldFeedEngine: (): boolean => voiced, idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS,
      });
      orchestrator.segmentNotTranscribedDeclared = true;
      return { orchestrator, isByok: false, gated: false };
    },
    emitter: { emit: (event, payload) => frames.push({ event, payload }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => undefined,
    levelIntervalMs: 0,
  });
  await drain();
  let seq = 0;
  const pump = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) { bridge.pushChunk(seq, frame(seq).toString('base64'), clock.now); seq += 1; await clock.advance(CHUNK_MS); }
  };
  await pump(10); // heard by leg 0
  voiced = false; await pump(SILENCE_CHUNKS); // leg 0 hung up
  voiced = true; await pump(4); // the redial
  const releasedAt = frames.length;
  const done = bridge.finish(); await drain(); await clock.advance(20_000); await done;
  bridge.dispose();
  return { frames, releasedAt };
}

const isTerminal = (f: { event: string; payload: unknown }): boolean =>
  f.event === 'stt:final' && (f.payload as { is_segment: boolean }).is_segment === false;

describe('RC6 — the closing rung ends a reconnect with ready{replayed_ms}', () => {
  it('🔴 a rung pending at the release connects ⇒ `ready` with the replayed audio, before the terminal final', async () => {
    const { frames, releasedAt } = await release(false);
    const after = frames.slice(releasedAt);
    const ready = after.findIndex((f) => f.event === 'stt:engine-status' && (f.payload as { status: string }).status === 'ready');
    expect(ready).toBeGreaterThanOrEqual(0);
    const p = frames[releasedAt + ready]!.payload as { replayed_ms?: number };
    // the owed words (4 chunks) at least — the rung's replay is ungated and may carry the window too
    expect(p.replayed_ms).toBeGreaterThanOrEqual(4 * CHUNK_MS);
    expect(ready).toBeLessThan(after.findIndex(isTerminal));
    expect(frames.filter((f) => f.event === 'stt:error')).toEqual([]);
  });

  it('positive control: nothing pending at the release ⇒ no `ready` after it', async () => {
    const { frames, releasedAt } = await release(true);
    expect(frames.slice(releasedAt).filter((f) => f.event === 'stt:engine-status')).toEqual([]);
    expect(frames.slice(releasedAt).some(isTerminal)).toBe(true);
  });
});
