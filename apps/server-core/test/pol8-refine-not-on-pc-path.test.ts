// Card POL-8 (NR-261 server half): a PC-path press (`delivery:'inject'`) never
// runs the second pass and never puts an `stt:refined` on the wire; a Notes
// press (`delivery:'none'`) still does. Contract: docs/rebuild/15-MESSAGE-STATES.md
// §2.0-c freeze rule ③, docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md
// §4 R12, docs/rebuild/06-STT-ENGINE-LAYER.md §5 (two-stage block).
//
// Technique (same as seg1b-factory-recovery-leg.test.ts): `audio:start` goes
// through the REAL `registerAudioHandlers` and the REAL `makeSttSessionFactory`;
// the bridge class is wrapped only to capture the deps the factory built. Those
// deps — replaced only at the three seams that would reach the network (engine
// build, emitter, LLM streamer) — then drive one whole utterance to its terminal
// final, and EVERY frame the session emits is recorded (the `onAny` equivalent)
// and searched for the refine model's unique answer.
//
// REVERSE CONTROL: stt-factory.ts `const refineForDelivery = args.delivery === 'none';`
// replaced by `= true` (the gate removed) ⇒ the PC-path cases go red; restored ⇒ green.

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
  constructor(private readonly finalText: string, public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {
    this.emit('final', { kind: 'final', text: this.finalText, confidence: 1, language: 'en', duration_ms: 1500 });
  }
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
const BASE = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', send_policy: 'direct', source_lang: 'en' };
// The phone carries its switches in `prefs` (phone-owned keys; a bundle is answered
// ONLY from the bundle). Refine floor 1 s so a 1.2 s utterance clears it; polish OFF
// so the ONLY language-model leg (and the only LLM meter) is refine.
const REFINE_ON = { prefs: { 'stt.refine': { enabled: true, min_utterance_ms: 1000 }, 'stt.polish': { enabled: false } } };
const RAW = 'please send the quarterly report to the whole team before friday';
// The refine model's answer — a string no other stage of this pipeline can
// produce (polish is OFF in this rig), so its presence in ANY frame means the
// second pass reached the wire.
const MARKER = 'Please send the quarterly report to the whole team before Friday.';

/** The deps the REAL factory built for one `audio:start`. */
function factoryDepsFor(start: Record<string, unknown>): SttSessionDeps {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('pol8-refine-secret') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  seedDefaultSettings(db.settings, 'u1');
  db.settings.write('u1', 'llm.config', { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'm' });
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
  expect(built!.polish, 'rig: polish must be off').toBeUndefined();
  return built!;
}

const SR = 16_000;
const sine = (ms: number): Buffer => {
  const n = (SR * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);
  return b;
};

/** Drive one whole utterance through a bridge built from those deps; record every frame. */
async function utteranceWith(factoryDeps: SttSessionDeps): Promise<{ frames: Array<{ event: string; payload: unknown }>; llmCalls: number; metered: number[][] }> {
  let llmCalls = 0;
  const streamerFor = (): LlmStreamer => async function* (): AsyncGenerator<LlmEvent> {
    llmCalls += 1;
    yield { kind: 'done', full: MARKER, usage: { tokens_in: 40, tokens_out: 12 } };
  };
  const frames: Array<{ event: string; payload: unknown }> = [];
  const metered: number[][] = [];
  const bridge = new SttSessionBridge({
    ...factoryDeps,
    build: (session: AudioSession) => ({
      orchestrator: new SttEngineOrchestrator(session, () => new FakeEngine(RAW), { engineFlushTimeoutMs: 200 }),
      isByok: false, gated: false,
    }),
    emitter: { emit: (event, payload) => { frames.push({ event, payload }); } },
    ...(factoryDeps.refine ? { refine: { ...factoryDeps.refine, deps: { ...factoryDeps.refine.deps, streamerFor } } } : {}),
    onPolishUsage: (tokensIn, tokensOut) => { metered.push([tokensIn, tokensOut]); },
    levelIntervalMs: 0,
  });
  await new Promise((r) => setTimeout(r, 5));
  bridge.pushChunk(0, sine(1200).toString('base64'), 0);
  await bridge.finish();
  bridge.dispose(); // exactly what audio.handler does next
  await new Promise((r) => setTimeout(r, 50));
  return { frames, llmCalls, metered };
}

const carriesMarker = (frames: Array<{ event: string; payload: unknown }>): string[] =>
  frames.filter((f) => JSON.stringify(f.payload ?? null).includes(MARKER)).map((f) => f.event);

describe('card POL-8 — the second pass never runs on a PC-path press', () => {
  beforeEach(() => { bridgeSpy.deps.length = 0; });

  it('🔴 delivery:\'inject\': no frame of any event carries the refined text, no stt:refined, no LLM call, nothing metered', async () => {
    const built = factoryDepsFor({ ...BASE, ...REFINE_ON, delivery: 'inject' });
    const { frames, llmCalls, metered } = await utteranceWith(built);
    // The wire first, so the reverse control reds on what the phone would see.
    expect(carriesMarker(frames)).toEqual([]);
    expect(frames.filter((f) => f.event === 'stt:refined')).toEqual([]);
    expect(llmCalls).toBe(0);
    expect(metered).toEqual([]);
    expect(built.refine).toBeUndefined();
    // The utterance itself still completed — the probe was not blind.
    // (The normalizer adds the closing period; polish is off, so nothing else moves.)
    const finals = frames.filter((f) => f.event === 'stt:final').map((f) => f.payload as { text: string; is_segment: boolean });
    expect(finals).toMatchObject([{ is_segment: false, text: `${RAW}.` }]);
  });

  it('🔴 delivery absent on the frame (pre-0.1.0 client; the relay reads it as inject): same — no second pass', async () => {
    const built = factoryDepsFor({ ...BASE, ...REFINE_ON });
    const { frames, llmCalls, metered } = await utteranceWith(built);
    expect(carriesMarker(frames)).toEqual([]);
    expect(llmCalls).toBe(0);
    expect(metered).toEqual([]);
    expect(built.refine).toBeUndefined();
  });

  it('POSITIVE CONTROL — delivery:\'none\' (Notes): stt:refined carries the refined text, once, and the refine tokens are metered', async () => {
    const built = factoryDepsFor({ ...BASE, ...REFINE_ON, delivery: 'none' });
    expect(built.refine).toBeDefined();
    const { frames, llmCalls, metered } = await utteranceWith(built);
    expect(carriesMarker(frames)).toEqual(['stt:refined']);
    const final = frames.find((f) => f.event === 'stt:final') as { payload: { utterance_id?: string } } | undefined;
    const refined = frames.filter((f) => f.event === 'stt:refined').map((f) => f.payload as { text: string; utterance_id: string });
    expect(refined).toEqual([{ text: MARKER, utterance_id: final?.payload.utterance_id }]);
    expect(llmCalls).toBe(1);
    expect(metered).toEqual([[40, 12]]);
  });
});
