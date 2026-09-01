// F-2 Fix A — once the billing gate has been closed for MIN_PAUSE_MS, feed ~1 s
// of zeros to a FunASR-family engine (ENGINE ONLY). Probe: 1000 ms closes a
// runtime VAD span, 300 ms does not, 600 ms unprobed.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import type { EngineState, SttEngine } from '../src/stt/engines/base';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { FunasrSpanClosureFeeder } from '../src/stt/funasr-span-closure';
import {
  feedRuntimeSpanClosureSilence, FUNASR_RUNTIME_SPAN_CLOSURE_MS, isFunasrFlushFamily,
} from '../src/stt/flush-final';
import { MIN_PAUSE_MS } from '../src/stt/segment-boundary';
import { PCM_BYTES_PER_MS } from '../src/stt/tuning-env';
import { VadGate } from '../src/stt/vad-gate';

const CLOSURE_BYTES = FUNASR_RUNTIME_SPAN_CLOSURE_MS * PCM_BYTES_PER_MS; // 32000
const CHUNK = 200 * PCM_BYTES_PER_MS; // 6400

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq; this.timers.push({ id, fn, at: this.now + ms }); return id;
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
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    this.now = target;
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
}

class RecordingEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  readonly pushed: Buffer[] = [];
  constructor(public readonly id: SttEngineId) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(chunk: Buffer): void { this.pushed.push(Buffer.from(chunk)); }
  async flush(): Promise<void> {}
  async close(): Promise<void> { this._state = 'closed'; }
}

function closurePushes(eng: RecordingEngine): Buffer[] {
  return eng.pushed.filter((b) => b.length === CLOSURE_BYTES && b.every((x) => x === 0));
}

describe('feedRuntimeSpanClosureSilence', () => {
  it('pushes 1000 ms of s16le zeros to an open funasr engine', () => {
    const eng = new RecordingEngine('funasr');
    void eng.open();
    feedRuntimeSpanClosureSilence(eng, 0);
    expect(eng.pushed).toHaveLength(1);
    expect(eng.pushed[0]!.length).toBe(CLOSURE_BYTES);
    expect(eng.pushed[0]!.every((x) => x === 0)).toBe(true);
  });

  it('does not push to deepgram / a closed engine / null', () => {
    const dg = new RecordingEngine('deepgram');
    void dg.open();
    feedRuntimeSpanClosureSilence(dg, 0);
    expect(dg.pushed).toHaveLength(0);
    const closed = new RecordingEngine('funasr');
    feedRuntimeSpanClosureSilence(closed, 0);
    expect(closed.pushed).toHaveLength(0);
    feedRuntimeSpanClosureSilence(null, 0);
    expect(isFunasrFlushFamily('funasr')).toBe(true);
    expect(isFunasrFlushFamily('deepgram')).toBe(false);
  });
});

describe('FunasrSpanClosureFeeder — once per closure episode', () => {
  function openFunasr(): RecordingEngine {
    const eng = new RecordingEngine('funasr');
    void eng.open();
    return eng;
  }

  it('does not feed until the gate has been closed for MIN_PAUSE_MS after voice', () => {
    const f = new FunasrSpanClosureFeeder();
    const eng = openFunasr();
    f.noteOpen();
    f.noteClosed(eng, 0, MIN_PAUSE_MS - 1);
    expect(closurePushes(eng)).toHaveLength(0);
    f.noteClosed(eng, 0, MIN_PAUSE_MS);
    expect(closurePushes(eng)).toHaveLength(1);
  });

  it('feeds ONCE per episode; a second closed chunk does not push again', () => {
    const f = new FunasrSpanClosureFeeder();
    const eng = openFunasr();
    f.noteOpen();
    f.noteClosed(eng, 0, MIN_PAUSE_MS);
    f.noteClosed(eng, 1, MIN_PAUSE_MS + 400);
    expect(closurePushes(eng)).toHaveLength(1);
  });

  it('a new open starts a new episode', () => {
    const f = new FunasrSpanClosureFeeder();
    const eng = openFunasr();
    f.noteOpen();
    f.noteClosed(eng, 0, MIN_PAUSE_MS);
    f.noteOpen();
    f.noteClosed(eng, 1, MIN_PAUSE_MS);
    expect(closurePushes(eng)).toHaveLength(2);
  });

  it('silence from the start (never opened) does not invent a span to close', () => {
    const f = new FunasrSpanClosureFeeder();
    const eng = openFunasr();
    f.noteClosed(eng, 0, 5_000);
    expect(closurePushes(eng)).toHaveLength(0);
  });

  it('does not feed a non-FunASR engine', () => {
    const f = new FunasrSpanClosureFeeder();
    const eng = new RecordingEngine('deepgram');
    void eng.open();
    f.noteOpen();
    f.noteClosed(eng, 0, MIN_PAUSE_MS);
    expect(eng.pushed).toHaveLength(0);
  });

  it('does not move vad.sessionMs — billing is the gate, not engine-fed bytes', () => {
    const vad = new VadGate({ hangoverMs: 300, thresholdDb: -45 });
    const n = 16_000 * 0.4;
    const sine = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) sine.writeInt16LE(10_000, i * 2);
    vad.process(sine);
    const before = vad.sessionMs;
    const f = new FunasrSpanClosureFeeder();
    const eng = openFunasr();
    f.noteOpen();
    f.noteClosed(eng, 0, MIN_PAUSE_MS);
    expect(vad.sessionMs).toBe(before);
    expect(closurePushes(eng)).toHaveLength(1);
  });
});

describe('F-2 Fix A wiring — the orchestrator actually feeds the zeros', () => {
  async function harness(id: SttEngineId): Promise<{
    orch: SttEngineOrchestrator; clock: FakeClock; eng: RecordingEngine; setVoiced: (v: boolean) => void;
  }> {
    const clock = new FakeClock();
    const eng = new RecordingEngine(id);
    let voiced = true;
    const session = new AudioSession({
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000,
    });
    session.start();
    const orch = new SttEngineOrchestrator(session, () => eng, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: 600_000, engineFlushTimeoutMs: 1_000,
      shouldFeedEngine: (): boolean => voiced,
    });
    await orch.start({ language: 'zh', mode: 'realtime' });
    return { orch, clock, eng, setVoiced: (v) => { voiced = v; } };
  }

  async function chunks(
    orch: SttEngineOrchestrator, clock: FakeClock, from: number, n: number,
  ): Promise<number> {
    let seq = from;
    for (let k = 0; k < n; k++) {
      orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(CHUNK) });
      await clock.advance(200);
    }
    return seq;
  }

  it('after MIN_PAUSE_MS of a closed gate, FunASR receives exactly one 1000 ms zero run', async () => {
    const { orch, clock, eng, setVoiced } = await harness('funasr');
    let seq = await chunks(orch, clock, 0, 2); // voice
    const liveBefore = eng.pushed.length;
    setVoiced(false);
    seq = await chunks(orch, clock, seq, 3); // 0 / 200 / 400 ms closed — a breath
    expect(closurePushes(eng)).toHaveLength(0);
    await chunks(orch, clock, seq, 1); // 600 ms — pause threshold
    expect(closurePushes(eng)).toHaveLength(1);
    // further silence is the same episode
    await chunks(orch, clock, seq + 1, 4);
    expect(closurePushes(eng)).toHaveLength(1);
    // client chunks during the close were 6400 bytes; the synthetic run is 32000
    expect(eng.pushed.slice(liveBefore).every((b) => b.length === CLOSURE_BYTES || b.length === CHUNK)).toBe(true);
    expect(eng.pushed.slice(liveBefore).filter((b) => b.length === CHUNK)).toHaveLength(0);
  });

  it('a second pause after voice is a new episode', async () => {
    const { orch, clock, eng, setVoiced } = await harness('funasr');
    let seq = await chunks(orch, clock, 0, 1);
    setVoiced(false);
    seq = await chunks(orch, clock, seq, 4);
    expect(closurePushes(eng)).toHaveLength(1);
    setVoiced(true);
    seq = await chunks(orch, clock, seq, 1);
    setVoiced(false);
    await chunks(orch, clock, seq, 4);
    expect(closurePushes(eng)).toHaveLength(2);
  });

  it('a gated Deepgram session is not injected — Fix A is FunASR-family only', async () => {
    const { orch, clock, eng, setVoiced } = await harness('deepgram');
    let seq = await chunks(orch, clock, 0, 1);
    setVoiced(false);
    await chunks(orch, clock, seq, 5);
    expect(closurePushes(eng)).toHaveLength(0);
    expect(eng.pushed.every((b) => b.length === CHUNK)).toBe(true);
  });
});

// ── REVERSE CONTROL (2026-08-31, dev-pc-a, run and observed) ────────
// Commenting out the `this.spanClosure.noteClosed(...)` line in
// orchestrator-core.ts `pushChunk` turns
// "after MIN_PAUSE_MS of a closed gate, FunASR receives exactly one 1000 ms
// zero run" red:
//   AssertionError: expected [] to have a length of 1 but got +0
// Restored; marker F2-FIXA-REVERSE-CONTROL grepped to 0 in src/.
