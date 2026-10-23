// Card SEG-1b, review fix: the FACTORY step that carries `recoveryLeg` from the
// handler's start args into the bridge deps (`stt-factory.ts`, the
// `args.recoveryLeg === true ? { recoveryLeg: true } : {}` line) had no test —
// the handler half is pinned by seg1b-live-press-is-not-recovery.test.ts and the
// bridge half by seg1-segment-polish.test.ts, and deleting the line between them
// left every one of them green.
//
// Here `audio:start` goes through the REAL `registerAudioHandlers` and the REAL
// `makeSttSessionFactory`; the bridge class is wrapped only to capture the deps
// the factory built (same technique as emb15-integrator-no-llm.test.ts). Those
// captured deps — unmodified except for the three seams that would otherwise
// reach the network (engine build, emitter, LLM streamer) — then drive one
// soft-segment final, and the wire frame is asserted.
//
// REVERSE CONTROL (run on this tree): delete that factory line ⇒ the recovery-leg
// case goes red (the segment is polished and the LLM is called); restored ⇒ green.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';

const bridgeSpy = vi.hoisted(() => ({ deps: [] as Array<Record<string, unknown>> }));
vi.mock('../src/engine/stt-session', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine/stt-session')>();
  class CapturingBridge extends real.SttSessionBridge {
    constructor(d: ConstructorParameters<typeof real.SttSessionBridge>[0]) {
      super(d);
      bridgeSpy.deps.push(d as unknown as Record<string, unknown>);
    }
  }
  return { ...real, SttSessionBridge: CapturingBridge };
});

import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { RoomStore } from '../src/room/store';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { seedDefaultSettings } from '../src/settings/defaults';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import type { SttSessionDeps } from '../src/engine/stt-session-deps';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> { this._state = 'closed'; }
}

class FakeSocket {
  readonly id = 'phone';
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: 'u1' } };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

const noopGuard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };
const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
const NOTES_PRESS = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', send_policy: 'direct', delivery: 'none', source_lang: 'en' };
const LIVE_STAMP = { recording_id: 'sess-1#1760371200000', attempt_id: 'att-live-1', attempt_kind: 'live', range_start_sample: 0, audio_format_version: 1 };
const RETRY_STAMP = { recording_id: 'sess-1#1760371200000', attempt_id: 'att-retry-1', attempt_kind: 'auto_retry', range_start_sample: 0, range_end_sample: 960_000, audio_format_version: 1 };
const SEG = 'so the first thing we need to do is look at the numbers for the third quarter';
const SEG_POLISHED = 'So the first thing we need to do is look at the numbers for the third quarter.';

/** The deps the REAL factory built for one `audio:start`. */
function factoryDepsFor(start: Record<string, unknown>): SttSessionDeps {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('seg1b-factory-secret') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  seedDefaultSettings(db.settings, 'u1');
  db.settings.write('u1', 'llm.config', { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'm' });
  db.settings.write('u1', 'stt.polish', { enabled: true });
  const store = new RoomStore<FakeSocket>();
  const phone = new FakeSocket();
  const factory = makeSttSessionFactory({ settings: db.settings, mode: 'standalone', store: store as unknown as RoomStore<Socket>, quota: noopGuard });
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard: noopGuard, usageTracker: noopUsage,
    store: store as unknown as RoomStore<Socket>,
    sttFactory: (args: SttStartArgs) => factory(phone as unknown as Socket, args),
  };
  registerAudioHandlers(phone as unknown as Socket, deps);
  let ack: Record<string, unknown> | undefined;
  phone.fire('audio:start', start, (r) => { ack = r as Record<string, unknown>; });
  phone.fire('audio:stop', {}, () => {});
  expect(ack?.ok, `audio:start refused: ${JSON.stringify(ack)}`).toBe(true);
  const built = bridgeSpy.deps[bridgeSpy.deps.length - 1] as unknown as SttSessionDeps | undefined;
  expect(built, 'the factory built no bridge').toBeDefined();
  // Positive control: polish IS armed, so 「no polish field」 below can only come from the segment gate.
  expect(built!.polish).toBeDefined();
  return built!;
}

/** Replay one soft-segment final through a bridge built from those deps. */
async function segmentFinalWith(factoryDeps: SttSessionDeps): Promise<{ frame: Record<string, unknown> | undefined; llmCalls: string[] }> {
  const llmCalls: string[] = [];
  const streamerFor = (): LlmStreamer => async function* (opts): AsyncGenerator<LlmEvent> { llmCalls.push(opts.user); yield { kind: 'done', full: SEG_POLISHED }; };
  const frames: Array<Record<string, unknown>> = [];
  let orch: SttEngineOrchestrator | null = null;
  const bridge = new SttSessionBridge({
    ...factoryDeps,
    build: (session: AudioSession) => { orch = new SttEngineOrchestrator(session, () => new FakeEngine(), { engineFlushTimeoutMs: 200 }); return { orchestrator: orch, isByok: false, gated: false }; },
    emitter: { emit: (event, payload) => { if (event === 'stt:final') frames.push(payload as Record<string, unknown>); } },
    polish: { ...factoryDeps.polish!, deps: { ...factoryDeps.polish!.deps, streamerFor } },
    levelIntervalMs: 0,
  });
  await new Promise((r) => setTimeout(r, 5));
  orch!.emit('final', { text: SEG, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000 });
  await new Promise((r) => setTimeout(r, 50));
  bridge.dispose();
  return { frame: frames[0], llmCalls };
}

describe('card SEG-1b — the factory carries recoveryLeg from audio:start to the segment polish gate', () => {
  beforeEach(() => { bridgeSpy.deps.length = 0; __resetPolishCacheForTest(); });

  it('🔴 a recovery leg (auto_retry): the segment final carries no polish field and the LLM is never called', async () => {
    const built = factoryDepsFor({ ...RETRY_STAMP, ...NOTES_PRESS });
    const { frame, llmCalls } = await segmentFinalWith(built);
    // The wire first, so the reverse control reds on what the phone would see.
    expect(llmCalls).toEqual([]);
    expect(frame).toMatchObject({ is_segment: true, text: SEG });
    expect(frame?.polish).toBeUndefined();
    expect(built.recoveryLeg).toBe(true);
  });

  it('a live press (attempt_kind live, the Play build\'s Notes press): the segment final is polished and says applied', async () => {
    const built = factoryDepsFor({ ...LIVE_STAMP, ...NOTES_PRESS });
    expect(built.recoveryLeg).toBeUndefined();
    expect(built.recovery).toMatchObject({ attempt_id: 'att-live-1' });
    const { frame, llmCalls } = await segmentFinalWith(built);
    expect(frame).toMatchObject({ is_segment: true, text: SEG_POLISHED, polish: 'applied' });
    expect(llmCalls).toEqual([SEG]);
  });
});
