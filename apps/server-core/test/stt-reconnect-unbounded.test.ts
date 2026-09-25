// Card RC-1 (2026-09-24) — the long-recording reconnect ladder.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §1 `engine_reconnect` row, §2 item 3
//     (2026-08-29 addendum + the RC-1 correction block: a long recording
//     degrades, it does not end; `STT_NETWORK_DROP` stays the push-to-talk code)
//   docs/rebuild/04-PROTOCOL-SPEC.md `audio:start.continuous`
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §5 RC-1
//
// THE CHAIN, one block per link, each on production code:
//   ① audio:start → `SttStartArgs.continuous` (audio.handler.ts), strictly `true`;
//   ② the production factory turns it into an unbounded ladder
//      (stt-factory.ts → engine-factory.ts `reconnectUnbounded`);
//   ③ the ladder itself: five refused rungs, no terminal error, frames without
//      `retry_max`, the capped schedule, and speech after recovery transcribed —
//      with the push-to-talk control on the SAME script giving up at three.
//
// REVERSE CONTROL (card RC-1 ②, SAW RED 〔2026-09-24, lane-c〕): the `unbounded`
// branch removed from `handleEngineError` (`!this.unbounded &&` deleted) ⇒ the
// ③ unbounded row red on `errors` = [STT_NETWORK_DROP]. Log:
// `.local/rc-relay-1/unbounded-red.log`; restored, same command green.
// And the wiring: the `reconnectUnbounded` spread removed from `engine-factory.ts` ⇒ ② red on
// 「args.continuous true ⇒ ladder unbounded true」 (`.local/rc-relay-1/wiring-red.log`).

import { describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { unboundedReconnectDelayMs, UNBOUNDED_BACKOFF_CAP_MS, DEFAULT_BACKOFF_MS } from '../src/stt/engine-session';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { seedDefaultSettings } from '../src/settings/defaults';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import { CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH, frame, type EngineScript } from './fixtures/stt-outage-harness';

const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

class FakeSocket {
  readonly id = 'm';
  data: Record<string, unknown> = { auth: { kind: 'mobile', userId: 'u1' } };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

describe('① audio:start hands `continuous` to the factory — strictly true, nothing else', () => {
  it.each([[true, true], [false, undefined], [undefined, undefined]] as const)('continuous %s ⇒ args.continuous %s', (sent, seen) => {
    const mobile = new FakeSocket();
    const got: unknown[] = [];
    const deps: AudioHandlerDeps = {
      io: {} as unknown as import('socket.io').Server,
      guard: noopGuard,
      usageTracker: noopUsage,
      store: new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>,
      sttFactory: (args: SttStartArgs) => { got.push(args.continuous); return { pushChunk() {}, finish: async () => {}, dispose() {} } as never; },
    };
    registerAudioHandlers(mobile as unknown as Socket, deps);
    mobile.fire('audio:start', sent === undefined ? START : { ...START, continuous: sent }, () => {});
    expect(got, 'POSITIVE CONTROL: the factory was reached at all').toHaveLength(1);
    expect(got[0]).toBe(seen);
  });
});

describe('② the production factory turns it into the unbounded ladder', () => {
  it.each([[true, true], [undefined, false]] as const)('args.continuous %s ⇒ ladder unbounded %s', (continuous, unbounded) => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('rc1-continuous-secret') });
    db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
    seedDefaultSettings(db.settings, 'u1');
    const store = new RoomStore<FakeSocket>() as unknown as RoomStore<Socket>;
    const factory = makeSttSessionFactory({ settings: db.settings, mode: 'standalone', store, quota: noopGuard });
    const args: SttStartArgs = { userId: 'u1', mode: 'realtime', delivery: 'none', sourceLang: 'zh', onComplete: () => {}, ...(continuous ? { continuous } : {}) };
    const bridge = factory(new FakeSocket() as unknown as Socket, args);
    const orch = (bridge as unknown as { orchestrator: SttEngineOrchestrator }).orchestrator;
    expect((orch as unknown as { ladder: { unbounded: boolean } }).ladder.unbounded).toBe(unbounded);
    bridge.dispose();
    db.close();
  });
});

describe('the long-recording schedule', () => {
  it('declared rungs, then doubling, capped at 30 s — the phone link ladder\'s own ceiling', () => {
    const waits = Array.from({ length: 8 }, (_, i) => unboundedReconnectDelayMs(DEFAULT_BACKOFF_MS, i));
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(UNBOUNDED_BACKOFF_CAP_MS).toBe(30_000);
  });
});

interface Run {
  errors: string[];
  statuses: Array<{ status: string; retry_count?: number; retry_max?: number; retry_in_ms?: number }>;
  interimsAfterRecovery: number;
  lastEngineHeard: number;
}

/** Leg 0 live, then five refused rungs, then a leg that opens. */
async function outage(unbounded: boolean): Promise<Run> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
  session.start();
  const scripts: EngineScript[] = [{ open: 'ok' }, ...Array.from({ length: 5 }, () => ({ open: 'reject' as const })), { open: 'ok' }];
  const engines: TranscribingEngine[] = [];
  const orch = new SttEngineOrchestrator(session, () => {
    const e = new TranscribingEngine(ZH, clock, scripts[Math.min(engines.length, scripts.length - 1)]!);
    engines.push(e);
    return e;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, softSegmentMs: 3_600_000,
    ...(unbounded ? { reconnectUnbounded: true } : {}),
  });
  const run: Run = { errors: [], statuses: [], interimsAfterRecovery: 0, lastEngineHeard: 0 };
  let recovered = false;
  orch.on('error', (e: { code: string }) => run.errors.push(e.code));
  orch.on('engine-status', (s: Run['statuses'][number]) => { run.statuses.push(s); if (s.status === 'ready' && run.statuses.length > 1) recovered = true; });
  orch.on('interim', () => { if (recovered) run.interimsAfterRecovery += 1; });
  orch.on('final', () => { /* listener mandatory */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  let seq = 0;
  const speak = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) { orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) }); seq += 1; await clock.advance(CHUNK_MS); }
  };
  await speak(5);
  engines[0]!.emitDrop();
  await clock.advance(0);
  // 1+2+4+8+16 s of refused rungs, then the 30 s wait before the rung that opens.
  await speak((1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 30_000) / CHUNK_MS + 10);
  run.lastEngineHeard = engines[engines.length - 1]!.heard.length;
  return run;
}

describe('③ the ladder — five refused rungs', () => {
  it('unbounded (long recording): no terminal error, no retry_max, the capped schedule, and speech after recovery is transcribed', async () => {
    const run = await outage(true);
    expect(run.errors).toEqual([]);
    const reconnecting = run.statuses.filter((s) => s.status === 'reconnecting');
    expect(reconnecting.map((s) => s.retry_count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(reconnecting.map((s) => s.retry_in_ms)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    for (const s of reconnecting) expect('retry_max' in s, 'an unbounded ladder has no total to state').toBe(false);
    expect(run.statuses.some((s) => s.status === 'failed')).toBe(false);
    expect(run.statuses[run.statuses.length - 1]?.status).toBe('ready');
    expect(run.interimsAfterRecovery, 'new speech reaches the recovered leg').toBeGreaterThan(0);
    expect(run.lastEngineHeard).toBeGreaterThan(0);
  });

  it('push-to-talk control on the SAME script: gives up at three with STT_NETWORK_DROP, frames carry retry_max', async () => {
    const run = await outage(false);
    expect(run.errors).toEqual(['STT_NETWORK_DROP']);
    const reconnecting = run.statuses.filter((s) => s.status === 'reconnecting');
    expect(reconnecting).toHaveLength(3);
    for (const s of reconnecting) expect(s.retry_max).toBe(3);
    expect(run.statuses.some((s) => s.status === 'failed')).toBe(true);
    expect(run.interimsAfterRecovery).toBe(0);
  });
});
