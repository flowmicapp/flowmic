import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine } from '../src/stt/engines/base';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import * as shadow from '../src/stt/stt-polish-guard-v2';
import { logPolishGuard } from '../src/obs/polish-telemetry';
import * as telemetry from '../src/obs/polish-telemetry';
import * as deltas from '../src/stt/stt-polish-guard-deltas';
import * as bounds from '../src/stt/stt-polish-guard-bounds';
import { log } from '../src/log';

const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const cfg = { protocol: 'openai-compatible' as const, endpoint: 'http://synthetic.invalid', model: 'synthetic', api_key: 'unused' };
beforeEach(() => {
  __resetPolishCacheForTest();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(log, level).mockImplementation(() => {});
});
afterEach(async () => { await drain(); vi.restoreAllMocks(); });

async function deliver(raw = '他跑的很快', polished = '他跑得很快') {
  class Engine extends EventEmitter {
    id = 'custom-openai-compatible'; state = 'closed';
    async open() { this.state = 'open'; }
    push() {}
    async close() { this.state = 'closed'; }
    async flush() { this.emit('final', { kind: 'final', text: raw, confidence: 1, language: 'zh', duration_ms: 200 }); }
  }
  const engine = new Engine();
  const frames: { event: string; payload: Record<string, unknown>; at: number }[] = [];
  const bridge = new SttSessionBridge({
    userId: 'synthetic', mode: 'realtime', sourceLang: 'zh', onComplete: () => {},
    emitter: { emit: (event, payload) => { frames.push({ event, payload: payload as Record<string, unknown>, at: Date.now() }); } },
    build: session => ({ orchestrator: new SttEngineOrchestrator(session, () => engine as unknown as SttEngine, { engineFlushTimeoutMs: 100 }), isByok: false, gated: false }),
    polishDelivery: 'sync', polish: { llm: { source: 'user', cfg }, deps: { language: 'zh', streamerFor: () => async function* () { yield { kind: 'done', full: polished }; } } },
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  bridge.pushChunk(0, Buffer.alloc(6400, 12).toString('base64'), 0);
  await bridge.finish();
  bridge.dispose();
  return frames;
}

it('sends the real final before a slow shadow guard, excludes its cost, and never reorders frames', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const slow = vi.spyOn(shadow, 'checkMeaningPreservedV2').mockImplementation(() => {
    const start = performance.now();
    while (performance.now() - start < 40) { /* Deliberately slow synchronous guard. */ }
    now += 500;
    return { ok: true, explained: { r1: 0, r2: 0, r3: 1 } };
  });
  const frames = await deliver();
  expect(slow).not.toHaveBeenCalled();
  const final = frames.find(f => f.event === 'stt:final')!;
  expect(final.payload.text).toBe('他跑的很快');
  expect(final.at).toBe(1000);
  const timing = vi.mocked(log.info).mock.calls.find(([name]) => name === 'stt.polish.timing')![1]!;
  expect(timing.elapsed_ms).toBe(0);
  const sent = structuredClone(frames);
  await drain();
  expect(slow).toHaveBeenCalledTimes(1);
  expect(now).toBe(1500);
  expect(frames).toEqual(sent);
  expect(timing.elapsed_ms).toBe(0);
});

it.each([[1500, 1500, 1], [1501, 1, 0], [1, 1501, 0]])('caps either input at 1500: %i / %i', async (a, b, calls) => {
  const guard = vi.spyOn(shadow, 'checkMeaningPreservedV2').mockReturnValue({ ok: true, explained: { r1: 0, r2: 0, r3: 0 } });
  logPolishGuard('甲'.repeat(a), '甲'.repeat(b), { ok: true }, {});
  await drain();
  expect(guard).toHaveBeenCalledTimes(calls);
  const fields = vi.mocked(log.info).mock.calls.find(([name]) => name === 'stt.polish.guard')![1]!;
  expect(fields.v2_family).toBe(calls ? 'none' : 'skipped_len');
  expect(fields.v2_verdict).toBe(calls ? 'ok' : null);
});

it.each([['我去。', '我去。'], ['他跑的很快', '他跑得很快']])('a throwing guard-logging stub cannot change live delivery: %s', async (raw, polished) => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const baseline = (await deliver(raw, polished)).find(f => f.event === 'stt:final')!.payload;
  await drain();
  __resetPolishCacheForTest();
  vi.spyOn(telemetry, 'logPolishGuard').mockImplementation(() => { throw new Error('synthetic observation failure'); });
  const actual = (await deliver(raw, polished)).find(f => f.event === 'stt:final')!.payload;
  const { utterance_id: _baseId, ...base } = baseline;
  const { utterance_id: _actualId, ...result } = actual;
  expect(result).toEqual(base);
  expect(vi.mocked(log.error).mock.calls).toEqual([]);
});

it('a throwing timing logger cannot change an accepted final into skipped', async () => {
  vi.mocked(log.info).mockImplementation(name => { if (name === 'stt.polish.timing') throw new Error('synthetic logger failure'); });
  const final = (await deliver('我去。', '我去。')).find(f => f.event === 'stt:final')!.payload;
  expect(final.text).toBe('我去。');
  expect(final.polish).toBe('applied');
  expect(final.polish_reason).toBeUndefined();
  expect(vi.mocked(log.error).mock.calls).toEqual([]);
});

it('a throwing category formatter cannot turn a guard refusal into a polish exception', async () => {
  vi.spyOn(telemetry, 'guardFamily').mockImplementation(() => { throw new Error('synthetic category failure'); });
  const final = (await deliver()).find(f => f.event === 'stt:final')!.payload;
  expect(final.text).toBe('他跑的很快');
  expect(final.polish_reason).toBe('guard_reject');
  expect(vi.mocked(log.error).mock.calls).toEqual([]);
});

it.each(['deltas', 'bounds', 'logger'] as const)('contains deferred %s exceptions', async failure => {
  if (failure === 'deltas') vi.spyOn(deltas, 'closedClassDeltas').mockImplementation(() => { throw new Error('synthetic'); });
  if (failure === 'bounds') vi.spyOn(bounds, 'checkOriginalBounds').mockImplementation(() => { throw new Error('synthetic'); });
  if (failure === 'logger') vi.mocked(log.info).mockImplementation(() => { throw new Error('synthetic'); });
  expect(() => logPolishGuard('他跑的很快', '他跑得很快', { ok: false }, {})).not.toThrow();
  await drain(); // Escaping callback exceptions are a test failure, not swallowed by the harness.
  expect(vi.mocked(log.error).mock.calls).toEqual([]);
});

it('contains failure to schedule an observation', () => {
  const schedule = vi.spyOn(globalThis, 'setImmediate').mockImplementation(() => { throw new Error('synthetic'); });
  try { expect(() => logPolishGuard('甲', '甲', { ok: true }, {})).not.toThrow(); }
  finally { schedule.mockRestore(); }
});
