// D-MKT-12 (2026-11-06): the phone's AI polish switch said "Off keeps the text
// exactly as recognized" (i18n/mobile/*.json `polishSub`). It never did, and the
// sentence that replaced it names what still happens. This file is what that
// sentence stands on: if the pure stages ever stop running with polish off, this
// goes red and `polishSub` has to change with it (CLAUDE.md D-6).
//
// The factory is the REAL one, on a REAL settings row with the switch off, and the
// bridge and orchestrator are real; only the engine is a double. `mode:'standalone'`
// is the path both channels run: the cloud relay and the desktop's LAN sidecar are
// the same server-core, and nothing in `makeSttSessionFactory` keys the final-text
// pipeline on the channel (`const finalText = makeFinalTextPipeline(...)`).
//
// REVERSE CONTROL (seen red on this tree, 2026-11-06, `vitest run` on this file
// only): `finalText,` removed from the deps in stt-factory.ts ⇒ all three cases red
// with the engine's text passing through untouched; restored ⇒ green.

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
import { SttSessionBridge } from '../src/engine/stt-session';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { FinalTextTransform } from '../src/stt/final-text-pipeline';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import { seedDefaultSettings } from '../src/settings/defaults';
import type { QuotaGuard } from '../src/billing/quota-guard';
import type { UsageTracker } from '../src/billing/usage-tracker';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamOpts, LlmStreamer } from '../src/compose/llm';
import type { SelectedLlmConfig } from '../src/compose/llm-config';
import { polishSystemPrompt, type PolishDeps } from '../src/stt/stt-polish';

const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
const guard: QuotaGuard = { ensureQuota() {}, remainingSttMs: () => Infinity, continuousCapMs: () => Infinity };

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: 'u1', deviceId: 'pc-1' } };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: { text: string; language: string } | null = null;
  pushes = 0;
  readonly id: SttEngineId = 'custom-openai-compatible';
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { this.pushes += 1; }
  async flush(): Promise<void> {
    if (this.finalOnFlush !== null && this.pushes > 0) {
      this.emit('final', { kind: 'final', text: this.finalOnFlush.text, confidence: 1, language: this.finalOnFlush.language, duration_ms: 1000 });
    }
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

const pcm = (ms: number): string => {
  const n = (16_000 * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16_000)), i * 2);
  return b.toString('base64');
};
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polish off, the way the phone sends it, through the real handler and factory. */
function depsTheFactoryBuilt(sourceLang: string, polish: Record<string, unknown> = { enabled: false }): Record<string, unknown> {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('polish-off-still-tidies') });
  db.users.insert({ id: 'u1', display_name: 'Host', plan: 'free' });
  seedDefaultSettings(db.settings, 'u1');
  db.settings.write('u1', 'stt.polish', polish);
  const store = new RoomStore<FakeSocket>();
  const phone = new FakeSocket('phone');
  const factory = makeSttSessionFactory({
    settings: db.settings, mode: 'standalone', store: store as unknown as RoomStore<Socket>, quota: guard,
  });
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard,
    usageTracker: noopUsage,
    store: store as unknown as RoomStore<Socket>,
    pcRoom: (id: string) => (id === 'pc-1' ? { userId: 'u1', roomKind: null } : null),
    sttFactory: (args: SttStartArgs) => factory(phone as unknown as Socket, args),
  };
  registerAudioHandlers(phone as unknown as Socket, deps);
  phone.fire('audio:start', { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: sourceLang }, () => {});
  phone.fire('audio:stop', {}, () => {});
  const built = bridgeSpy.deps[bridgeSpy.deps.length - 1];
  if (built === undefined) throw new Error('premise: the factory built no bridge');
  return built;
}

/** What the real bridge emits for one engine final, given those deps' transform. */
async function finalThroughRealBridge(finalText: FinalTextTransform, raw: string, language: string, polish?: { llm: SelectedLlmConfig; deps: PolishDeps }): Promise<Record<string, unknown>> {
  const eng = new FakeEngine();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => ({ orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }), isByok: false }),
    emitter: { emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); } },
    userId: 'u1', mode: 'realtime', sourceLang: language, onComplete: () => undefined,
    finalText,
    levelIntervalMs: 0,
    ...(polish ? { polish, polishDelivery: 'sync' } : {}),
  } as unknown as ConstructorParameters<typeof SttSessionBridge>[0]);
  await tick();
  bridge.pushChunk(0, pcm(300), 0);
  eng.finalOnFlush = { text: raw, language };
  await bridge.finish();
  bridge.dispose();
  const final = emitted.find((e) => e.event === 'stt:final');
  if (final === undefined) throw new Error('premise: the bridge emitted no stt:final');
  return final.payload;
}

beforeEach(() => { bridgeSpy.deps.length = 0; });

describe('D-MKT-12: with AI polish off, finals are still tidied', () => {
  it('🔴 English speech: no polish dep, yet a filler goes and end punctuation arrives', async () => {
    const deps = depsTheFactoryBuilt('en');
    expect(deps.polish, 'premise: the switch being off really disarmed polish').toBeUndefined();
    const out = await finalThroughRealBridge(deps.finalText as FinalTextTransform, 'um hello   there', 'en');
    expect(out.text).toBe('Hello there.');
    expect(out.polish_reason, 'and the row is not claimed to have been polished').toBeUndefined();
  });

  it('🔴 Chinese speech: a hesitation sound goes too', async () => {
    const deps = depsTheFactoryBuilt('zh');
    expect(deps.polish).toBeUndefined();
    const out = await finalThroughRealBridge(deps.finalText as FinalTextTransform, '嗯嗯今天开会', 'zh');
    expect(out.text).not.toBe('嗯嗯今天开会');
    expect(String(out.text)).toContain('今天开会');
  });

  it('negative control: German speech keeps its words and gets only the end mark', async () => {
    const deps = depsTheFactoryBuilt('de');
    const out = await finalThroughRealBridge(deps.finalText as FinalTextTransform, 'er kommt morgen', 'de');
    expect(out.text).toBe('er kommt morgen.');
  });
});

// D-MKT-14 (2026-11-07): `polishStrengthNote` said "Strict keeps every word you
// said". These cases are what its replacement stands on, so if they go red the
// sentence changes with them (CLAUDE.md D-6): the tidying runs before the model on
// BOTH strengths, it acts on English and Chinese speech and not on the others, and
// only the Smooth prompt tells the model to remove fillers. The factory is built
// with the strength on the settings row; the model is a double that records what
// it was handed, and the strength reaches it the way stt-factory.ts passes it.
//
// REVERSE CONTROL (seen red on this tree, 2026-11-07, `vitest run` on this file
// only): `finalText,` removed from the deps in stt-factory.ts ⇒ the English and
// Chinese cases below red on both strengths; restored ⇒ green.
describe('D-MKT-14: Strict and Smooth both receive already tidied text', () => {
  /** The text and rules the model was handed for one final, on a real bridge. */
  async function handedToTheModel(strength: 'strict' | 'smooth', raw: string, language: string): Promise<LlmStreamOpts> {
    const deps = depsTheFactoryBuilt(language, { enabled: true, strength });
    let seen: LlmStreamOpts | null = null;
    const streamerFor = (): LlmStreamer => async function* (opts: LlmStreamOpts): AsyncGenerator<LlmEvent> {
      seen = opts;
      yield { kind: 'done', full: opts.user };
    };
    await finalThroughRealBridge(deps.finalText as FinalTextTransform, raw, language, {
      llm: { cfg: { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'test-model' }, source: 'user' },
      deps: { streamerFor, strength },
    });
    if (seen === null) throw new Error('premise: the model was never called');
    return seen;
  }

  for (const strength of ['strict', 'smooth'] as const) {
    it(`🔴 ${strength}, English speech: the filler is gone before the model sees the sentence`, async () => {
      const opts = await handedToTheModel(strength, 'um hello   there', 'en');
      expect(opts.user).toBe('Hello there.');
    });

    it(`🔴 ${strength}, Chinese speech: the same`, async () => {
      const opts = await handedToTheModel(strength, '嗯嗯今天开会', 'zh');
      expect(opts.user).not.toContain('嗯');
      expect(opts.user).toContain('今天开会');
    });

    it(`negative control, ${strength}, French speech: the tidying leaves its hesitation to the model`, async () => {
      const opts = await handedToTheModel(strength, 'euh il arrive demain', 'fr');
      expect(opts.user).toContain('euh');
    });
  }

  it('only the Smooth rules tell the model to remove fillers, and Strict forbids removing content words', () => {
    expect(polishSystemPrompt('smooth')).toContain('Remove fillers');
    expect(polishSystemPrompt('strict')).not.toMatch(/filler/iu);
    expect(polishSystemPrompt('strict')).toContain('Never add or remove content words');
  });
});
