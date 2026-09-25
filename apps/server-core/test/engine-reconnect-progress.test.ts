// NR-96-A (2026-09-24) — the relay's engine reconnect ladder puts its budget on
// the wire, and a rung's spawn is bounded.
//
// Contract: book 15 §2.7 (the five laws) and the §3.2 engine-ladder row; book 04
// §3 `stt:engine-status` row; book 06 §1 `engine_reconnect` row. Design:
// docs/strategy/2026-09-24-reconnect-visibility-design.md §3.5 and card A.
//
// Four claims, one describe each:
//   ① every `reconnecting` frame carries retry_count / retry_max / retry_in_ms /
//      attempt_timeout_ms, with retry_in_ms equal to the delay the ladder really
//      armed; `ready` and `failed` carry none of the three;
//   ② on give-up the `failed` status goes out BEFORE `stt:error` — a client
//      clears its "reconnecting" face on the first of the two, so the order is
//      what keeps "reconnecting" off every screen after the ladder gave up;
//   ③ a reconnect spawn that never completes counts as ONE failed rung after
//      attempt_timeout_ms (it used to hang the ladder forever: RT3-C, the old
//      CASE 4 in stt-outage-loss.test.ts, now corrected there);
//   ④ the bridge copies the three fields onto the outbound socket frame (it
//      builds that frame field by field — a field it does not copy is a field no
//      phone ever sees, and a test that only reads `provider/status` is blind
//      to it).

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { EngineSessionReconnectLadder, type EngineStatusPayload } from '../src/stt/engine-session';
import { SttSessionBridge } from '../src/engine/stt-session';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => { const id = ++this.seq; this.timers.push({ id, fn, at: this.now + ms }); return id; };
  clearTimeout = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  nowFn = (): number => this.now;
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
      await drain();
    }
    this.now = target;
    await drain();
  }
}
const drain = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

type OpenMode = 'ok' | 'reject' | 'hang';
class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  constructor(private readonly openMode: OpenMode = 'ok', public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> {
    if (this.openMode === 'reject') throw new Error('connect refused');
    if (this.openMode === 'hang') await new Promise<never>(() => { /* never settles */ });
    this._state = 'open';
  }
  push(): void { /* noop */ }
  async flush(): Promise<void> { /* noop */ }
  async close(): Promise<void> { this._state = 'closed'; }
  drop(): void { this.emit('error', new Error('drop')); }
}

function orchestrator(engines: FakeEngine[], opts: { engineSpawnTimeoutMs?: number } = {}): {
  orch: SttEngineOrchestrator; clock: FakeClock; statuses: EngineStatusPayload[]; log: string[];
} {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    ...opts,
  });
  const statuses: EngineStatusPayload[] = [];
  const log: string[] = [];
  orch.on('engine-status', (s: EngineStatusPayload) => { statuses.push(s); log.push(`status:${s.status}`); });
  orch.on('error', (e: { code: string }) => { log.push(`error:${e.code}`); });
  return { orch, clock, statuses, log };
}

const rungs = (s: EngineStatusPayload[]): EngineStatusPayload[] => s.filter((x) => x.status === 'reconnecting');

describe('NR-96-A ① each rung frame carries the budget, read from the schedule it armed', () => {
  it('three refused rungs: n = 1,2,3; max = 3; retry_in_ms = backoff[n-1]; attempt_timeout_ms = the spawn cap', async () => {
    const { orch, clock, statuses } = orchestrator(
      [new FakeEngine('ok'), new FakeEngine('reject'), new FakeEngine('reject'), new FakeEngine('reject')],
      { engineSpawnTimeoutMs: 5_000 },
    );
    await orch.start({ language: 'zh', mode: 'realtime' });
    const first = (orch as unknown as { engine: FakeEngine }).engine;
    first.drop();
    await drain();
    await clock.advance(1_000 + 2_000 + 4_000);

    // `provider` is left out on purpose: after a refused rung there is no engine
    // and the hook answers 'unknown' — pre-existing, and not this card's question.
    expect(rungs(statuses).map(({ provider: _p, ...rest }) => rest)).toEqual([
      { status: 'reconnecting', retry_count: 1, retry_max: 3, retry_in_ms: 1_000, attempt_timeout_ms: 5_000 },
      { status: 'reconnecting', retry_count: 2, retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 },
      { status: 'reconnecting', retry_count: 3, retry_max: 3, retry_in_ms: 4_000, attempt_timeout_ms: 5_000 },
    ]);
    // `ready` / `failed` never carry the budget (they answer "alive?", not "how many").
    for (const s of statuses.filter((x) => x.status !== 'reconnecting')) {
      expect(s, s.status).not.toHaveProperty('retry_max');
      expect(s, s.status).not.toHaveProperty('retry_in_ms');
      expect(s, s.status).not.toHaveProperty('attempt_timeout_ms');
    }
    expect(statuses.at(-1)?.status).toBe('failed');
  });

  it('the orchestrator hands the ladder its DEFAULT spawn cap when none is configured', async () => {
    const { orch, statuses } = orchestrator([new FakeEngine('ok'), new FakeEngine('ok')]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    (orch as unknown as { engine: FakeEngine }).engine.drop();
    await drain();
    expect(rungs(statuses)[0]).toMatchObject({ retry_count: 1, retry_max: 3, retry_in_ms: 1_000, attempt_timeout_ms: 5_000 });
  });

  it('a ladder built WITHOUT a spawn cap does not claim one (no attempt_timeout_ms on the frame)', () => {
    const emitted: EngineStatusPayload[] = [];
    const ladder = new EngineSessionReconnectLadder({
      spawnEngine: () => new Promise(() => { /* not reached in this row */ }),
      closeEngine: async () => { /* noop */ }, replayBufferTail: () => { /* noop */ },
      currentEngineId: () => 'soniox', emitStatus: (p) => { emitted.push(p); }, emitError: () => { /* noop */ },
      clearSoftSegmentTimer: () => { /* noop */ }, isTerminated: () => false,
    }, { setTimeoutFn: () => 1, clearTimeoutFn: () => { /* noop */ } });
    ladder.handleEngineError(new Error('drop'));
    expect(emitted).toEqual([{ provider: 'soniox', status: 'reconnecting', retry_count: 1, retry_max: 3, retry_in_ms: 1_000 }]);
  });
});

describe('NR-96-A ② give-up: `failed` status precedes `stt:error`', () => {
  it('the first give-up frame a client sees is the status, so its reconnecting face is gone before the error lands', async () => {
    const { orch, clock, log } = orchestrator(
      [new FakeEngine('ok'), new FakeEngine('reject'), new FakeEngine('reject'), new FakeEngine('reject')],
    );
    await orch.start({ language: 'zh', mode: 'realtime' });
    (orch as unknown as { engine: FakeEngine }).engine.drop();
    await drain();
    await clock.advance(7_000);
    const tail = log.slice(log.indexOf('status:failed'));
    expect(tail.slice(0, 2)).toEqual(['status:failed', 'error:STT_NETWORK_DROP']);
    // and nothing says "reconnecting" after the give-up began
    expect(tail.filter((l) => l === 'status:reconnecting')).toEqual([]);
  });
});

describe('NR-96-A ③ a hung reconnect spawn is ONE failed rung after attempt_timeout_ms', () => {
  it('rung 1 hangs → at 1 000 + 5 000 ms it counts as failed and rung 2 is announced', async () => {
    const { orch, clock, statuses, log } = orchestrator(
      [new FakeEngine('ok'), new FakeEngine('hang'), new FakeEngine('ok')],
      { engineSpawnTimeoutMs: 5_000 },
    );
    await orch.start({ language: 'zh', mode: 'realtime' });
    (orch as unknown as { engine: FakeEngine }).engine.drop();
    await drain();
    await clock.advance(1_000);            // rung 1 fires, its spawn hangs
    await clock.advance(4_999);
    expect(rungs(statuses).map((s) => s.retry_count), 'the cap must not fire early').toEqual([1]);
    await clock.advance(1);                // the cap fires → one failed rung
    expect(rungs(statuses).map((s) => s.retry_count)).toEqual([1, 2]);
    await clock.advance(2_000);            // rung 2 succeeds on a healthy engine
    // ⚠️ 更正（RC-3b，2026-09-24）：原为 `{ provider, status: 'ready' }`. The `ready` that ends a
    // reconnect now says how much audio the replay re-fed (book 04 RC-3b note); nothing was
    // spoken in this row, so the fact is 0. Pinned in engine-ready-replayed-ms.test.ts.
    expect(statuses.at(-1)).toEqual({ provider: 'custom-openai-compatible', status: 'ready', replayed_ms: 0 });
    expect(log.filter((l) => l.startsWith('error:'))).toEqual([]);
  });

  it('every rung hangs → the ladder still gives up, bounded by Σbackoff + 3 × cap', async () => {
    const { orch, clock, log } = orchestrator(
      [new FakeEngine('ok'), new FakeEngine('hang'), new FakeEngine('hang'), new FakeEngine('hang')],
      { engineSpawnTimeoutMs: 5_000 },
    );
    await orch.start({ language: 'zh', mode: 'realtime' });
    (orch as unknown as { engine: FakeEngine }).engine.drop();
    await drain();
    await clock.advance(1_000 + 2_000 + 4_000 + 3 * 5_000);
    expect(log.slice(-2)).toEqual(['status:failed', 'error:STT_NETWORK_DROP']);
  });
});

describe('NR-96-A ④ the bridge copies the budget onto the outbound socket frame', () => {
  it('stt:engine-status leaves the bridge with all four progress fields', async () => {
    const emitted: { event: string; payload: unknown }[] = [];
    let orch: SttEngineOrchestrator | null = null;
    new SttSessionBridge({
      build: (session: AudioSession) => {
        orch = new SttEngineOrchestrator(session, () => new FakeEngine('ok'), { engineFlushTimeoutMs: 200 });
        return { orchestrator: orch, isByok: false, gated: false };
      },
      emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
      userId: 'u', mode: 'realtime', sourceLang: 'zh',
      onComplete: () => { /* noop */ },
      levelIntervalMs: 0,
    });
    await new Promise((r) => setTimeout(r, 5));
    orch!.emit('engine-status', { provider: 'soniox', status: 'reconnecting', retry_count: 2, retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 });
    orch!.emit('engine-status', { provider: 'soniox', status: 'ready' });
    const frames = emitted.filter((e) => e.event === 'stt:engine-status').map((e) => e.payload);
    expect(frames).toContainEqual({ provider: 'soniox', status: 'reconnecting', retry_count: 2, retry_max: 3, retry_in_ms: 2_000, attempt_timeout_ms: 5_000 });
    expect(frames.at(-1)).toEqual({ provider: 'soniox', status: 'ready' });
  });
});
