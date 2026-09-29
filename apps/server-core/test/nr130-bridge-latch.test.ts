// NR-130 — the REAL polish bridge (engine/stt-session.ts `runPolishedFinal`) is
// the one production writer of stt/llm-reject-latch.ts, the fact behind the
// desktop's `capability.llm.rejected`. This drives the bridge end to end with a
// fake engine and a fake streamer and asserts on the latch, so "the bridge
// reports what it put on the wire" is pinned by a run, not by a comment.
// (Kept out of stt-session-bridge.test.ts, which sits at its 1200-line cap; the
// engine double below is the same shape as the one there.)
//
// REVERSE CONTROL (2026-09-29): the `observePolishSignal(...)` line in
// stt-session.ts commented out ⇒ this case red ("expected false to be true"),
// restored ⇒ green. Command: `npx vitest run test/nr130-bridge-latch.test.ts`.

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { __resetLlmRejectLatchForTest, isLlmConfigRejected } from '../src/stt/llm-reject-latch';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId, LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import type { LlmConfigSource } from '../src/compose/llm-config';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  pushes = 0;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { this.pushes += 1; }
  async flush(): Promise<void> { if (this.finalOnFlush !== null && this.pushes > 0) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'zh', duration_ms: 1234 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

const CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'sk-user', model: 'test-model' };
const sine = (ms: number): Buffer => {
  const n = Math.round((16_000 * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16_000) * 0.3 * 32767), i * 2);
  return b;
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

async function speak(events: LlmEvent[], source: LlmConfigSource = 'user'): Promise<{ polish?: string; polish_reason?: string }> {
  const eng = new FakeEngine();
  const emitted: { event: string; payload: unknown }[] = [];
  const streamerFor = (_p: LlmProtocol): LlmStreamer => async function* (): AsyncGenerator<LlmEvent> { for (const e of events) yield e; };
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => ({ orchestrator: new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }), isByok: false, gated: false }),
    emitter: { emit: (event, payload) => emitted.push({ event, payload }) },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: () => {},
    polish: { llm: { cfg: CFG, source }, deps: { streamerFor } },
    levelIntervalMs: 0,
  });
  await tick();
  bridge.pushChunk(0, sine(200).toString('base64'), 0);
  eng.finalOnFlush = '你好世界';
  await bridge.finish();
  return emitted.find((e) => e.event === 'stt:final')?.payload as { polish?: string; polish_reason?: string };
}

beforeEach(() => { __resetLlmRejectLatchForTest(); __resetPolishCacheForTest(); });

describe('NR-130 — the polish bridge feeds capability.llm.rejected', () => {
  it('remembers a refused config, keeps it through a timeout, forgets it on an applied final', async () => {
    expect(isLlmConfigRejected('u', CFG)).toBe(false); // positive control: starts clean
    expect((await speak([{ kind: 'error', code: 'LLM_AUTH_FAIL', message: 'x' }])).polish_reason).toBe('model_rejected');
    expect(isLlmConfigRejected('u', CFG)).toBe(true);
    // Only THAT config: the same user with another key is not "refused".
    expect(isLlmConfigRejected('u', { ...CFG, api_key: 'sk-other' })).toBe(false);
    // A timeout says nothing about the config — the fact stays.
    expect((await speak([{ kind: 'error', code: 'LLM_TIMEOUT', message: 'x' }])).polish_reason).toBe('timeout');
    expect(isLlmConfigRejected('u', CFG)).toBe(true);
    // The provider answered ⇒ the config works ⇒ forgotten.
    expect((await speak([{ kind: 'done', full: '你好世界。' }])).polish).toBe('applied');
    expect(isLlmConfigRejected('u', CFG)).toBe(false);
  });

  it('a refused MANAGED key reaches the phone as llm_error and records nothing for the user', async () => {
    const f = await speak([{ kind: 'error', code: 'LLM_AUTH_FAIL', message: 'x' }], 'managed-default');
    expect(f).toMatchObject({ polish: 'skipped', polish_reason: 'llm_error' });
    expect(isLlmConfigRejected('u', CFG)).toBe(false);
  });
});
