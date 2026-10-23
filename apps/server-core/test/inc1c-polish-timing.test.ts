// Card INC-1c (design docs/strategy/2026-10-13-realtime-polish-while-speaking-design.md
// §5.4, §9 item 5) — the polish wait is measured on the bridge's clock and reaches
// `latency.segment`; it is ABSENT, never 0, when it was not measured.
//
// Drives the REAL bridge + orchestrator; only the engine and the LLM streamer are
// doubles (same harness shape as seg1-segment-polish.test.ts).

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { __resetLatencyState, markAudioStop, markInjectRequest, markInjectResult, markPolishTiming, markSttFinal } from '../src/obs/latency';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId, LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';
import type { TerminalPolishTiming } from '../src/engine/stt-session-polish-timing';

class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  pushes = 0;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { this.pushes += 1; }
  async flush(): Promise<void> { if (this.finalOnFlush !== null && this.pushes > 0) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'en', duration_ms: 1000 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

const CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'test-model' };
const pcm = (ms: number): string => {
  const n = (16_000 * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16_000)), i * 2);
  return b.toString('base64');
};
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
const slowUpper = (delayMs: number): ((p: LlmProtocol) => LlmStreamer) => () => async function* (opts): AsyncGenerator<LlmEvent> {
  await new Promise((r) => setTimeout(r, delayMs));
  yield { kind: 'done', full: opts.user.charAt(0).toUpperCase() + opts.user.slice(1) } as LlmEvent;
};

function bridgeWith(polish: boolean, timings: TerminalPolishTiming[]): { bridge: SttSessionBridge; eng: FakeEngine; orch: () => SttEngineOrchestrator } {
  const eng = new FakeEngine();
  let orchestrator: SttEngineOrchestrator | null = null;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => { orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }); return { orchestrator, isByok: false, gated: false }; },
    emitter: { emit: () => undefined },
    userId: 'u', mode: 'realtime', sourceLang: 'en', onComplete: () => undefined,
    ...(polish ? { polish: { llm: { cfg: CFG, source: 'user' as const }, deps: { streamerFor: slowUpper(60) } } } : {}),
    onPolishTiming: (t) => timings.push(t),
    levelIntervalMs: 0,
  });
  return { bridge, eng, orch: () => orchestrator! };
}

describe('card INC-1c — the polish wait, measured on the bridge', () => {
  const infos: { msg: string; fields: Record<string, unknown> }[] = [];
  beforeEach(() => {
    __resetPolishCacheForTest(); __resetLatencyState(); infos.splice(0);
    vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { infos.push({ msg, fields: fields ?? {} }); });
  });
  afterEach(() => vi.restoreAllMocks());

  it('🔴 a polished terminal final reports engine_final_ms + polish_wait_ms once, path whole', async () => {
    const timings: TerminalPolishTiming[] = [];
    const { bridge, eng } = bridgeWith(true, timings);
    await tick();
    bridge.pushChunk(0, pcm(300), 0);
    eng.finalOnFlush = 'hello there';
    await bridge.finish();
    bridge.dispose();
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ polish_path: 'whole', polish_chars: 'Hello there'.length });
    expect(timings[0]!.polish_wait_ms).toBeGreaterThanOrEqual(50);
    expect(typeof timings[0]!.engine_final_ms).toBe('number');
    const line = infos.find((l) => l.msg === 'stt.polish.final');
    expect(line?.fields).toMatchObject({ is_segment: false, path: 'whole', spec_calls: null });
  });

  it('a soft-segment final logs its HOLD and does not report a terminal timing', async () => {
    const timings: TerminalPolishTiming[] = [];
    const { bridge, orch } = bridgeWith(true, timings);
    await tick();
    bridge.pushChunk(0, pcm(300), 0);
    orch().emit('final', { text: 'first part of it', confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 1000 });
    await bridge.finish();
    bridge.dispose();
    const seg = infos.find((l) => l.msg === 'stt.polish.final' && l.fields.is_segment === true);
    expect(seg?.fields.wait_ms as number).toBeGreaterThanOrEqual(50);
    expect(seg?.fields.engine_final_ms).toBeNull();
    expect(timings.every((t) => t.polish_chars !== 'First part of it'.length)).toBe(true);
  });

  it('polish OFF ⇒ nothing reported (absent, not 0)', async () => {
    const timings: TerminalPolishTiming[] = [];
    const { bridge, eng } = bridgeWith(false, timings);
    await tick();
    bridge.pushChunk(0, pcm(300), 0);
    eng.finalOnFlush = 'hello there';
    await bridge.finish();
    bridge.dispose();
    expect(timings).toEqual([]);
    expect(infos.some((l) => l.msg === 'stt.polish.final')).toBe(false);
  });

  it('latency.segment carries the split when reported, and OMITS the keys when not', () => {
    let t = 1000;
    const now = (): number => t;
    markAudioStop('r1', now); t += 900;
    markPolishTiming('r1', { engine_final_ms: 700, polish_wait_ms: 200, polish_path: 'whole', polish_chars: 40 });
    markSttFinal('r1', now); markInjectRequest('r1', 'e1', now); t += 50; markInjectResult('r1', 'e1', now);
    markAudioStop('r2', now); t += 400; markSttFinal('r2', now); markInjectRequest('r2', 'e2', now); markInjectResult('r2', 'e2', now);
    const segs = infos.filter((l) => l.msg === 'latency.segment').map((l) => l.fields);
    expect(segs[0]).toMatchObject({ engine_final_ms: 700, polish_wait_ms: 200, polish_path: 'whole', polish_chars: 40 });
    expect('polish_wait_ms' in segs[1]!).toBe(false);
    expect('engine_final_ms' in segs[1]!).toBe(false);
  });
});
