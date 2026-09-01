// F-1 / F-1b — FunASR flush correctness. Fixtures replay the measured post-flush
// sequences from p1-packet-E (2026-08-31, ws://100.64.7.68:10095).
// T3: single 2pass-offline is_final=true.
// T1/T5: 2pass-offline is_final=false, then empty mode-omitted is_final=true trailer.
// T2_linger: dual-offline drain past the old 5s cap; the tail sentence is only
// in the SECOND offline.
// F-1b: a straggler 2pass-online at +300 ms must not quiescence-settle at ~+2.3 s
// before the first post-attach offline.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FunasrEngine } from '../src/stt/engines/funasr';
import type { SttEngine, SttEngineConfig, FinalResult } from '../src/stt/engines/base';
import type { SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import {
  raceFlushFinal,
  resolveFlushTimeoutMs,
  FUNASR_FLUSH_HARD_CAP_MS,
  FUNASR_FLUSH_QUIESCENCE_MS,
} from '../src/stt/flush-final';

class FakeWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  constructor(public url: string) { super(); }
  send(data: string | Buffer): void { this.sent.push(data); }
  close(): void { this.emit('close'); }
  openIt(): void { this.emit('open'); }
  frame(obj: unknown): void { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.push({ id, fn, at: this.now + ms });
    return id;
  };
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

const drain = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

const cfg = (over: Partial<SttEngineConfig> = {}): SttEngineConfig => ({
  id: 'funasr', language: 'en', sample_rate: 16_000, endpoint: 'ws://fake:10095', ...over,
});

/** Probe T3 last offline (hard cut, is_final=true, terminal 。). */
const T3_OFFLINE =
  ' the weather today is quite pleasant， so we will walk together in the park after lunch。 and the final keyword iswatermelon。';
/** Probe T1/T5 last offline (is_final=false, no terminal 。). */
const T1_OFFLINE =
  ' the weather today is quite pleasant， so we will walk together in the park after lunch。 and the final keyword iswatermelon';
/** Probe T2_linger first post-flush offline (+7264 ms). Body only — no pineapple. */
const T2_OFFLINE_1 =
  ' please record this long passage carefully， so the recognizers stays busy for more than one minute of continuous speech。 the first topic is morning light on the river boats， moving slowly and birds calling from a far bank。 the second topic is a quiet kitchen， boiling water， fresh tea leaves and a wooden table near the window。 the third topic is a city street at dusk， yellow lamps， bicycle bells and people walking home after work。 the fourth topic is a small library tall， l shelves paper pages。 turning and a clock ticking on the wall。 the fifth topic is a garden。 after roll wet stones， green leaves and a smell of soil in the air。 the six topic is a train at night， steel rails， a distant whistle and windows filled with passing lights。 this passage is now completethe';
/** Probe T2_linger second post-flush offline (+8110 ms). The tail sentence. */
const T2_OFFLINE_2 = ' distinctive final word is pineapple。al。';
const T2_TAIL = 'distinctive final word is pineapple';

/** Measured post-flush offsets from T2_linger (ms from is_speaking:false). */
const T2_DRAIN: ReadonlyArray<{ off: number; mode: string | undefined; is_final: boolean; text: string }> = [
  { off: 7264, mode: '2pass-offline', is_final: false, text: T2_OFFLINE_1 },
  { off: 7368, mode: '2pass-online', is_final: false, text: 'the di ' },
  { off: 7473, mode: '2pass-online', is_final: false, text: 'stinctive' },
  { off: 7577, mode: '2pass-online', is_final: false, text: 'final wor ' },
  { off: 7682, mode: '2pass-online', is_final: false, text: 'd is p ' },
  { off: 8110, mode: '2pass-offline', is_final: true, text: T2_OFFLINE_2 },
];

async function openFunasr(): Promise<{ engine: FunasrEngine; ws: FakeWs }> {
  let ws!: FakeWs;
  const engine = new FunasrEngine(cfg(), {
    connect: (url) => { ws = new FakeWs(url); return ws as never; },
  });
  const opened = engine.open();
  ws.openIt();
  await opened;
  return { engine, ws };
}

async function notSettled(p: Promise<unknown>): Promise<void> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await drain();
  expect(settled, 'flush settled before the measured is_final frame').toBe(false);
}

class HangEngine extends EventEmitter {
  constructor(public readonly id: SttEngineId) { super(); }
  flush(): Promise<void> { return new Promise(() => { /* never */ }); }
}

function hangAsEngine(id: SttEngineId): SttEngine & EventEmitter {
  return new HangEngine(id) as unknown as SttEngine & EventEmitter;
}

function finalOf(text: string): FinalResult {
  return { kind: 'final', text, confidence: 1, language: 'en', duration_ms: 0 };
}

describe('resolveFlushTimeoutMs — F-1 family vs everyone else', () => {
  it('funasr / funspeech default is the 15s hard cap, not the old 5s floor', () => {
    expect(resolveFlushTimeoutMs('funasr', 3_000, false)).toBe(FUNASR_FLUSH_HARD_CAP_MS);
    expect(resolveFlushTimeoutMs('funspeech-http', 3_000, false)).toBe(FUNASR_FLUSH_HARD_CAP_MS);
    expect(FUNASR_FLUSH_HARD_CAP_MS).toBe(15_000);
    expect(FUNASR_FLUSH_QUIESCENCE_MS).toBe(2_000);
  });

  it('an explicit cap still wins; soniox and the other engines are unchanged', () => {
    expect(resolveFlushTimeoutMs('funasr', 8_000, true)).toBe(8_000);
    expect(resolveFlushTimeoutMs('soniox', 3_000, false)).toBe(3_000);
    expect(resolveFlushTimeoutMs('deepgram', 3_000, false)).toBe(3_000);
    expect(resolveFlushTimeoutMs('openai-whisper', 3_000, false)).toBe(3_000);
  });
});

describe('FunasrEngine.flush — first post-flush is_final (probe T3 / T1 / T5)', () => {
  it('T3: a single 2pass-offline is_final=true settles flush and keeps watermelon', async () => {
    const { engine, ws } = await openFunasr();
    const finals: string[] = [];
    engine.on('final', (e) => finals.push(e.text));
    const flushed = engine.flush();
    await notSettled(flushed);
    ws.frame({ mode: '2pass-offline', is_final: true, text: T3_OFFLINE });
    await flushed;
    expect(finals).toEqual([T3_OFFLINE]);
    expect(finals[0]).toContain('watermelon');
    await engine.close();
  });

  it('T1/T5: offline is_final=false does not settle; the empty trailer does, and adds no text', async () => {
    const { engine, ws } = await openFunasr();
    const finals: string[] = [];
    const interims: string[] = [];
    engine.on('final', (e) => finals.push(e.text));
    engine.on('interim', (e) => interims.push(e.text));
    const flushed = engine.flush();
    ws.frame({ mode: '2pass-offline', is_final: false, text: T1_OFFLINE });
    await notSettled(flushed);
    expect(finals).toEqual([T1_OFFLINE]);
    // Probe raw trailer: {is_final:true, text:"", wav_name:"probe"} — no mode key.
    ws.frame({ is_final: true, text: '', wav_name: 'probe' });
    await flushed;
    expect(finals).toEqual([T1_OFFLINE]);
    expect(interims).toEqual([]);
    expect(finals[0]).toContain('watermelon');
    await engine.close();
  });

  it('mid-session offline (even is_final=true) does not settle a flush that has not been sent', async () => {
    const { engine, ws } = await openFunasr();
    ws.frame({ mode: '2pass-offline', is_final: true, text: 'hello' });
    const flushed = engine.flush();
    await notSettled(flushed);
    ws.frame({ mode: '2pass-offline', is_final: true, text: 'hello there' });
    await flushed;
    await engine.close();
  });
});

describe('raceFlushFinal — activity-extended deadline (funasr family only)', () => {
  function race(engine: SttEngine & EventEmitter, clock: FakeClock, getText: () => string, timeoutMs: number) {
    return raceFlushFinal({
      engine,
      getOfflineText: getText,
      language: 'en',
      timeoutMs,
      setTimeoutFn: clock.setTimeout,
      clearTimeoutFn: clock.clearTimeout,
    });
  }

  it('a silent funasr flush is still open at the old 5s cap and falls back at 15s', async () => {
    const clock = new FakeClock();
    const engine = hangAsEngine('funasr');
    let done: Awaited<ReturnType<typeof raceFlushFinal>> | undefined;
    const p = race(engine, clock, () => 'draft', FUNASR_FLUSH_HARD_CAP_MS).then((o) => { done = o; });
    await clock.advance(5_000);
    expect(done).toBeUndefined();
    await clock.advance(FUNASR_FLUSH_HARD_CAP_MS - 5_000);
    await p;
    expect(done?.timedOut).toBe(true);
    expect(done?.result.text).toBe('draft');
  });

  it('F-1b: a straggler 2pass-online must not quiescence-settle before the first post-attach final', async () => {
    const clock = new FakeClock();
    const engine = hangAsEngine('funasr');
    let offline = '';
    let done: Awaited<ReturnType<typeof raceFlushFinal>> | undefined;
    let settledAt: number | undefined;
    const p = race(engine, clock, () => offline, FUNASR_FLUSH_HARD_CAP_MS).then((o) => {
      done = o;
      settledAt = clock.now;
    });
    // +300 ms: in-flight 2pass-online landing after flush()/listener attach.
    await clock.advance(300);
    engine.emit('interim', { kind: 'interim', text: 'the di ', confidence: 0.5, language: 'en' });
    // Silence through the would-be +2.3 s settle, until offline #1 (body, no tail).
    await clock.advance(7264 - 300);
    offline = T2_OFFLINE_1;
    engine.emit('final', finalOf(T2_OFFLINE_1));
    await clock.advance(8110 - 7264);
    offline = T2_OFFLINE_1 + T2_OFFLINE_2;
    engine.emit('final', finalOf(T2_OFFLINE_2));
    await clock.advance(FUNASR_FLUSH_QUIESCENCE_MS);
    await p;
    expect(
      done?.result.text,
      `F-1b tail must survive a straggler online (settled at +${settledAt ?? 'never'}ms)`,
    ).toContain(T2_TAIL);
  });

  it('T2_linger drain: frames past 5s keep the race open; 2s of quiescence then falls back', async () => {
    const clock = new FakeClock();
    const engine = hangAsEngine('funasr');
    let offline = '';
    let done: Awaited<ReturnType<typeof raceFlushFinal>> | undefined;
    const p = race(engine, clock, () => offline, FUNASR_FLUSH_HARD_CAP_MS).then((o) => { done = o; });
    let cursor = 0;
    for (const f of T2_DRAIN) {
      await clock.advance(f.off - cursor);
      cursor = f.off;
      expect(done, `settled at +${f.off}ms — that is the old 5s-cap shape`).toBeUndefined();
      if (f.mode === '2pass-offline') {
        offline = offline + f.text;
        engine.emit('final', finalOf(f.text));
      } else {
        engine.emit('interim', { kind: 'interim', text: f.text, confidence: 0.5, language: 'en' });
      }
    }
    await clock.advance(FUNASR_FLUSH_QUIESCENCE_MS);
    await p;
    expect(done?.timedOut).toBe(true);
    expect(done?.result.text).toContain(T2_TAIL);
  });

  it('soniox (and any non-family engine) still uses a flat cap — frames do not extend it', async () => {
    const clock = new FakeClock();
    const engine = hangAsEngine('soniox');
    let done: Awaited<ReturnType<typeof raceFlushFinal>> | undefined;
    const p = race(engine, clock, () => '', 1_000).then((o) => { done = o; });
    engine.emit('final', finalOf('hello'));
    await clock.advance(500);
    engine.emit('final', finalOf('hello world'));
    await clock.advance(500);
    await p;
    expect(done?.timedOut).toBe(true);
  });
});

describe('orchestrator fold — empty final must not wipe a longer onlineDraft; T2 keeps the tail', () => {
  async function harness(): Promise<{
    orch: SttEngineOrchestrator;
    clock: FakeClock;
    ws: FakeWs;
    events: { final: Array<{ text: string }> };
  }> {
    const clock = new FakeClock();
    let ws!: FakeWs;
    const engine = new FunasrEngine(cfg(), {
      connect: (url) => {
        ws = new FakeWs(url);
        queueMicrotask(() => ws.openIt());
        return ws as never;
      },
    });
    const session = new AudioSession({
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000,
    });
    session.start();
    const orch = new SttEngineOrchestrator(session, () => engine, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    });
    const events: { final: Array<{ text: string }> } = { final: [] };
    orch.on('final', (p: { text: string }) => events.final.push(p));
    await orch.start({ language: 'en', mode: 'realtime' });
    orch.pushChunk({ seq: 0, ts_ms: 0, payload: Buffer.alloc(6400) });
    return { orch, clock, ws, events };
  }

  it('an empty is_final trailer at settle leaves a longer onlineDraft intact', async () => {
    const { orch, ws, events } = await harness();
    ws.frame({ mode: '2pass-online', is_final: false, text: 'keyword is watermelon' });
    await drain();
    const stopped = orch.stop();
    await drain();
    ws.frame({ is_final: true, text: '' });
    await stopped;
    const text = events.final.at(-1)?.text ?? '';
    expect(text).toContain('watermelon');
    expect(text.length).toBeGreaterThan(0);
    await orch.close();
  });

  it('T2_linger: terminal text contains the tail sentence that lives in the second offline', async () => {
    const { orch, clock, ws, events } = await harness();
    const stopped = orch.stop();
    await drain();
    let cursor = 0;
    for (const f of T2_DRAIN) {
      await clock.advance(f.off - cursor);
      cursor = f.off;
      const frame: Record<string, unknown> = { mode: f.mode, is_final: f.is_final, text: f.text };
      ws.frame(frame);
      await drain();
    }
    await stopped;
    const text = events.final.at(-1)?.text ?? '';
    expect(text, 'T2_linger tail sentence must survive the flush race').toContain(T2_TAIL);
    expect(text).not.toBe(T2_OFFLINE_1);
    await orch.close();
  });
});
