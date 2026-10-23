// Card POL-1 (design docs/strategy/2026-10-14-two-stage-polish-design.md §4.1,
// §10) — `stt.polish.final` names the unit it measured (`stage`), and the three
// fields nothing measures yet (`ctx_chars`, `ctx_pending`, `hold_cap_hit`) are
// ABSENT from the record, never 0.
//
// Two layers: the tally alone (classification + absent-vs-measured-0), then the
// REAL bridge + orchestrator with only the engine and the LLM streamer doubled
// (same harness as inc1c-polish-timing.test.ts), so the stage is proved to be
// wired, not just computable.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import { PolishTimingTally } from '../src/engine/stt-session-polish-timing';
import type { AudioSession } from '../src/stt/audio/session';
import type { SttEngineId, LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';

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
const upper = (): ((p: LlmProtocol) => LlmStreamer) => () => async function* (opts): AsyncGenerator<LlmEvent> {
  await new Promise((r) => setTimeout(r, 10));
  yield { kind: 'done', full: opts.user.charAt(0).toUpperCase() + opts.user.slice(1) } as LlmEvent;
};

function bridge(): { bridge: SttSessionBridge; eng: FakeEngine; orch: () => SttEngineOrchestrator } {
  const eng = new FakeEngine();
  let orchestrator: SttEngineOrchestrator | null = null;
  const b = new SttSessionBridge({
    build: (session: AudioSession) => { orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }); return { orchestrator, isByok: false, gated: false }; },
    emitter: { emit: () => undefined },
    userId: 'u', mode: 'realtime', sourceLang: 'en', onComplete: () => undefined,
    polish: { llm: { cfg: CFG, source: 'user' as const }, deps: { streamerFor: upper() } },
    levelIntervalMs: 0,
  });
  return { bridge: b, eng, orch: () => orchestrator! };
}

const UNMEASURED = ['ctx_chars', 'ctx_pending', 'hold_cap_hit'] as const;

describe('card POL-1 — the unit a polished final measured, and absent-not-0', () => {
  const infos: { msg: string; fields: Record<string, unknown> }[] = [];
  beforeEach(() => {
    __resetPolishCacheForTest(); infos.splice(0);
    vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { infos.push({ msg, fields: fields ?? {} }); });
  });
  afterEach(() => vi.restoreAllMocks());
  const finals = (): Record<string, unknown>[] => infos.filter((l) => l.msg === 'stt.polish.final').map((l) => l.fields);

  describe('the tally', () => {
    it('whole: a terminal final with no segment before it', () => {
      const t = new PolishTimingTally(() => 0);
      expect(t.begin(false).stage).toBe('whole');
    });

    it('segment, then tail: once a segment carrying words was seen, the terminal final is the tail', () => {
      const t = new PolishTimingTally(() => 0);
      t.noteSegment();
      expect(t.begin(true).stage).toBe('segment');
      expect(t.begin(false).stage).toBe('tail');
    });

    it('🔴 unmeasured context and hold-cap fields are ABSENT from the record (not 0, not null)', () => {
      const t = new PolishTimingTally(() => 0);
      t.emitted(t.begin(false), undefined, 5);
      const rec = finals()[0]!;
      expect(rec.stage).toBe('whole');
      for (const k of UNMEASURED) expect(k in rec, k).toBe(false);
    });

    it('a MEASURED empty context is written as 0, so "empty" and "not measured" stay two answers', () => {
      const t = new PolishTimingTally(() => 0);
      t.noteSegment();
      const clock = t.begin(false);
      clock.ctx = { chars: 0, pending: false };
      clock.holdCapHit = false;
      t.emitted(clock, undefined, 5);
      expect(finals()[0]).toMatchObject({ stage: 'tail', ctx_chars: 0, ctx_pending: false, hold_cap_hit: false });
    });
  });

  describe('the real bridge', () => {
    it('🔴 an uncut press: the one polished final is stage whole, on both polish lines', async () => {
      const { bridge: b, eng } = bridge();
      await tick();
      b.pushChunk(0, pcm(300), 0);
      eng.finalOnFlush = 'hello there';
      await b.finish();
      b.dispose();
      const f = finals();
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ is_segment: false, stage: 'whole' });
      for (const k of UNMEASURED) expect(k in f[0]!, k).toBe(false);
      const timing = infos.filter((l) => l.msg === 'stt.polish.timing').map((l) => l.fields);
      expect(timing).toHaveLength(1);
      expect(timing[0]).toMatchObject({ is_segment: false, stage: 'whole' });
    });

    it('🔴 a cut press: the segment is stage segment, the terminal final is stage tail', async () => {
      const { bridge: b, eng, orch } = bridge();
      await tick();
      b.pushChunk(0, pcm(300), 0);
      orch().emit('final', { text: 'first part of it', confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 1000 });
      eng.finalOnFlush = 'and the rest';
      await b.finish();
      b.dispose();
      const f = finals();
      expect(f.map((r) => [r.is_segment, r.stage])).toEqual([[true, 'segment'], [false, 'tail']]);
      for (const r of f) for (const k of UNMEASURED) expect(k in r, k).toBe(false);
      const timing = infos.filter((l) => l.msg === 'stt.polish.timing').map((l) => l.fields);
      expect(timing.map((r) => r.stage).sort()).toEqual(['segment', 'tail']);
    });

    it('a soft segment carrying no words is not a cut: the terminal final stays whole', async () => {
      const { bridge: b, eng, orch } = bridge();
      await tick();
      b.pushChunk(0, pcm(300), 0);
      orch().emit('final', { text: '   ', confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 1000 });
      eng.finalOnFlush = 'hello there';
      await b.finish();
      b.dispose();
      expect(finals().map((r) => r.stage)).toEqual(['whole']);
    });
  });
});
