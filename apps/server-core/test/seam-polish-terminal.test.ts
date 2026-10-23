// Card SEAM-2 — the segment polish may not put back the end-of-sentence mark that the row cut left
// out: the bridge strips it and the row still says `polish:'applied'`. Real bridge + orchestrator;
// only the engine and the LLM streamer are doubles (the harness shape of seg1-segment-polish.test.ts).
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (card SEAM-2 block, second bullet)
//   docs/strategy/2026-10-14-soft-seam-root-cause.md §3.1 rule 3

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { __resetPolishCacheForTest } from '../src/stt/stt-polish';
import type { AudioSession } from '../src/stt/audio/session';
import type { VadGate } from '../src/stt/vad-gate';
import type { LlmConfig, LlmProtocol } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { LlmEvent, LlmStreamer } from '../src/compose/llm';

class FakeEngine extends EventEmitter implements SttEngine {
  readonly id = 'custom-openai-compatible' as const;
  private _state: EngineState = 'closed';
  finalOnFlush: string | null = null;
  pushes = 0;
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { this.pushes += 1; }
  async flush(): Promise<void> { if (this.finalOnFlush !== null && this.pushes > 0) this.emit('final', { kind: 'final', text: this.finalOnFlush, confidence: 1, language: 'en', duration_ms: 1000 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

const CFG: LlmConfig = { protocol: 'openai-compatible', endpoint: 'http://test.invalid/v1', api_key: 'EMPTY', model: 'test-model' };
const sine = (ms: number): string => {
  const n = (16_000 * ms) / 1000; const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16_000)), i * 2);
  return b.toString('base64');
};
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The model capitalises and closes whatever it is given. */
const closingModel = (): ((p: LlmProtocol) => LlmStreamer) => () => async function* (opts): AsyncGenerator<LlmEvent> {
  const u = opts.user.trim();
  yield { kind: 'done', full: (u[0]!.toUpperCase() + u.slice(1)).replace(/[.。]?$/u, /\p{Script=Han}/u.test(u) ? '。' : '.') };
};

async function cutPress(segment: string, tail: string, seamOpen: boolean): Promise<Record<string, unknown>[]> {
  const eng = new FakeEngine();
  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  let orchestrator: SttEngineOrchestrator | null = null;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession) => {
      orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 });
      return { orchestrator, isByok: false, gated: false };
    },
    emitter: { emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }) },
    userId: 'u', mode: 'realtime', sourceLang: 'en', onComplete: () => undefined,
    polish: { llm: { cfg: CFG, source: 'user' as const }, deps: { streamerFor: closingModel(), budgetMs: 10_000 } },
    levelIntervalMs: 0,
  });
  await tick();
  bridge.pushChunk(0, sine(300), 0);
  orchestrator!.emit('final', { text: segment, confidence: 1, language: 'en', segment_idx: 0, is_segment: true, duration_ms: 31_000, ...(seamOpen ? { seam_open: true } : {}) });
  eng.finalOnFlush = tail;
  await bridge.finish();
  bridge.dispose();
  return emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload);
}

describe('card SEAM-2 — the polish may not close an open segment row', () => {
  beforeEach(() => __resetPolishCacheForTest());

  // REVERSE CONTROL (SAW RED, card SEAM-2): the `stripAddedTerminal` line in `runPolishedFinal` removed ⇒
  // the first case red (「And in the afternoon we.」).
  it('🔴 an open segment row comes back from the polish with a full stop ⇒ delivered without it, still applied', async () => {
    const f = await cutPress('and in the afternoon we', 'take a boat', true);
    expect(f[0]).toMatchObject({ is_segment: true, text: 'And in the afternoon we', polish: 'applied' });
    expect('seam_open' in f[0]!, 'the internal field never reaches the wire').toBe(false);
    // The terminal final may end a sentence: the polish's full stop stays there.
    expect(f[1]).toMatchObject({ is_segment: false, text: 'Take a boat.', polish: 'applied' });
  });

  it('a segment row that already ended a sentence keeps the polish output untouched', async () => {
    const f = await cutPress('on Tuesday afternoon.', 'thanks', false);
    expect(f[0]).toMatchObject({ is_segment: true, text: 'On Tuesday afternoon.', polish: 'applied' });
  });

  it('a row the cut did not open keeps the full stop the polish wrote (the row may have ended a sentence)', async () => {
    const f = await cutPress('so the first thing we need to do is look at the numbers', 'thanks', false);
    expect(f[0]).toMatchObject({ is_segment: true, text: 'So the first thing we need to do is look at the numbers.', polish: 'applied' });
  });

  // REVERSE CONTROL (SAW RED, card SEAM-2): the `trailingDictatedCommand` test removed from `keepOpenEnd` ⇒ this case red.
  it('🔴 a dictated end-of-sentence command keeps the polish symbol even on an open row', async () => {
    const f = await cutPress('so please send me the report period', 'thanks', true);
    expect(f[0]).toMatchObject({ is_segment: true, text: 'So please send me the report period.', polish: 'applied' });
  });

  // The producer→consumer link, end to end (CLAUDE.md anti-facade ⑥): the orchestrator puts `seam_open` on the
  // row it stripped, the bridge's polish exit reads it. Real bridge, real orchestrator, real VAD gate, real timers;
  // the engine closes its final at end-of-stream like Soniox. REVERSE CONTROL (SAW RED, card SEAM-2):
  // `...host.seamCarry.finalField()` removed from orchestrator-flush.ts ⇒ red (「And in the afternoon we.」).
  it('🔴 end to end: a pause cut strips the vendor dash, and the polish may not put a full stop in its place', async () => {
    class ClosingLeg extends EventEmitter implements SttEngine {
      readonly id = 'soniox' as const;
      readonly interimShape = 'cumulative' as const;
      readonly finalsOnlyAtFlush = true as const;
      private _state: EngineState = 'closed';
      private heard = false;
      constructor(private readonly text: string) { super(); }
      get state(): EngineState { return this._state; }
      async open(): Promise<void> { this._state = 'open'; }
      push(): void { this.heard = true; this.emit('interim', { kind: 'interim', text: this.text.replace(/—$/u, ''), confidence: 0.5, language: 'en' }); }
      async flush(): Promise<void> { if (this.heard) this.emit('final', { kind: 'final', text: this.text, confidence: 1, language: 'en', duration_ms: 0 }); }
      async close(): Promise<void> { this._state = 'closed'; }
    }
    const texts = ['and in the afternoon we—', 'until it is—']; // review C2: the terminal leg ends on Soniox's closing dash
    let legs = 0;
    const emitted: { event: string; payload: Record<string, unknown> }[] = [];
    const bridge = new SttSessionBridge({
      build: (session: AudioSession, _l: string, _u: string, vad?: VadGate) => ({
        orchestrator: new SttEngineOrchestrator(session, () => new ClosingLeg(texts[Math.min(legs++, 1)]!), {
          shouldFeedEngine: (): boolean => vad!.open, engineFlushTimeoutMs: 200, softSegmentMs: 600, softSegmentGraceMs: 600_000, idleHangupMs: 60_000,
        }),
        isByok: false, gated: true,
      }),
      emitter: { emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }) },
      userId: 'u', mode: 'realtime', sourceLang: 'en', onComplete: () => undefined,
      polish: { llm: { cfg: CFG, source: 'user' as const }, deps: { streamerFor: closingModel(), budgetMs: 10_000 } },
      levelIntervalMs: 0,
    });
    await tick();
    const silence = Buffer.alloc(3_200).toString('base64');
    let seq = 0;
    for (const [n, loud] of [[10, true], [14, false], [5, true]] as const) {
      for (let i = 0; i < n; i++) { bridge.pushChunk(seq++, loud ? sine(100) : silence, 0); await tick(100); }
    }
    await bridge.finish();
    bridge.dispose();
    const f = emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload);
    expect(f.map((x) => x.is_segment), 'POSITIVE CONTROL: the pause cut a row').toEqual([true, false]);
    expect(f[0]).toMatchObject({ text: 'And in the afternoon we', polish: 'applied' });
    expect('seam_open' in f[0]!).toBe(false);
    // review C2: the closing dash dropped, the normalizer closed the sentence, the polish took 「until it is.」 as input.
    expect(f[1]).toMatchObject({ text: 'Until it is.', polish: 'applied' });
  }, 15_000);

  // Re-review R3 — the next row is lower-cased only on what row N actually DELIVERED. Rows are emitted straight on
  // the orchestrator (with the internal fields it would carry); [answer] is the model, [delayMs] its latency.
  async function rows(frames: Record<string, unknown>[], answer: ((u: string) => string) | null, delayMs = 0): Promise<{ f: Record<string, unknown>[]; seen: string[] }> {
    const eng = new FakeEngine();
    const emitted: { event: string; payload: Record<string, unknown> }[] = [];
    const seen: string[] = [];
    let orchestrator: SttEngineOrchestrator | null = null;
    const model = (): LlmStreamer => async function* (opts): AsyncGenerator<LlmEvent> {
      seen.push(opts.user);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      yield { kind: 'done', full: answer!(opts.user) };
    };
    const bridge = new SttSessionBridge({
      build: (session: AudioSession) => { orchestrator = new SttEngineOrchestrator(session, () => eng, { engineFlushTimeoutMs: 200 }); return { orchestrator, isByok: false, gated: false }; },
      emitter: { emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }) },
      userId: 'u', mode: 'realtime', sourceLang: 'en', onComplete: () => undefined,
      ...(answer !== null ? { polish: { llm: { cfg: CFG, source: 'user' as const }, deps: { streamerFor: model, budgetMs: 10_000 } } } : {}),
      levelIntervalMs: 0,
    });
    await tick();
    bridge.pushChunk(0, sine(300), 0);
    for (const fr of frames) { orchestrator!.emit('final', { confidence: 1, language: 'en', is_segment: true, duration_ms: 31_000, ...fr }); await tick(); }
    eng.finalOnFlush = null;
    await bridge.finish();
    bridge.dispose();
    return { f: emitted.filter((e) => e.event === 'stt:final').map((e) => e.payload), seen };
  }
  const OPEN_ROW = { text: 'and in the afternoon we', segment_idx: 0, seam_open: true };

  it('🔴 row N delivered open ⇒ row N+1 starts in lower case (no polish)', async () => {
    const { f } = await rows([OPEN_ROW, { text: 'The boat leaves at noon', segment_idx: 1, seam_from: 0 }], null);
    expect(f.map((x) => x.text)).toEqual(['and in the afternoon we', 'the boat leaves at noon', '']);
    expect(f.every((x) => !('seam_from' in x))).toBe(true);
  });

  // REVERSE CONTROL (SAW RED, card SEAM-2): the ENDS_TERMINAL test removed from `DeliveredSeam.head` ⇒ red.
  it('🔴 row N delivered closed (the model kept a question mark) ⇒ row N+1 keeps its capital', async () => {
    const { f, seen } = await rows([{ ...OPEN_ROW, text: 'what time is it' }, { text: 'The boat leaves at noon', segment_idx: 1, seam_from: 0 }], (u) => (u.startsWith('what') ? 'What time is it?' : u));
    expect(f[0]).toMatchObject({ text: 'What time is it?', polish: 'applied' });
    expect(seen[1]).toBe('The boat leaves at noon');
  });

  it('row N delivered open after the guard took the polish stop off ⇒ row N+1 is lower-cased before its own polish', async () => {
    const { f, seen } = await rows([OPEN_ROW, { text: 'The boat leaves at noon', segment_idx: 1, seam_from: 0 }], (u) => `${u}.`);
    expect(f[0]).toMatchObject({ text: 'and in the afternoon we', polish: 'applied' });
    expect(seen[1]).toBe('the boat leaves at noon');
  });

  // REVERSE CONTROL (SAW RED, card SEAM-2): `DeliveredSeam.head` made to ignore which row was last delivered ⇒ red.
  it('🔴 row N still in its polish when row N+1 arrives ⇒ no guess: row N+1 keeps its capital', async () => {
    const { f, seen } = await rows([OPEN_ROW, { text: 'The boat leaves at noon', segment_idx: 1, seam_from: 0 }], (u) => u, 150);
    expect(f.map((x) => x.text)).toEqual(['and in the afternoon we', 'The boat leaves at noon', '']);
    expect(seen).toEqual(['and in the afternoon we', 'The boat leaves at noon']);
  });
});
