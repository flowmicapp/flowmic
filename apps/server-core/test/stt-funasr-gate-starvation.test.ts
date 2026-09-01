// F-2 step 0 — pin CURRENT feed + metering before any span-closure change.
//
// Production wiring (engine-factory.ts): a managed streaming FunASR session is
// `gated === true` and `shouldFeedEngine: () => vad.open`. The bridge updates
// the gate BEFORE the orchestrator reads `.open` (stt-session.ts process then
// pushChunk). The question this file answers is: after the gate closes, does
// the engine still receive the client's silence, or only voiced (+ hangover)
// frames?
//
// Probe (p1-packet-E): 1000 ms of silence closes a FunASR runtime VAD span;
// 300 ms does not; 600 ms unprobed. Hangover is 300 ms (vad-gate.ts). If the
// engine never sees a quiet gap long enough, every session is one giant span.
//
// Engine id is deliberately NOT funasr/funspeech: later F-2 Fix A injects
// synthetic zeros to that family only. This pin is about CLIENT chunks.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import type { EngineState, SttEngine } from '../src/stt/engines/base';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { VadGate } from '../src/stt/vad-gate';
import { PCM_BYTES_PER_MS } from '../src/stt/tuning-env';

const SR = 16_000;
const CHUNK_MS = 200;
const CHUNK = CHUNK_MS * PCM_BYTES_PER_MS; // 6400 — the size the phone really sends

function sinePcm(ms: number, amp = 0.3, freq = 440): Buffer {
  const n = (SR * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / SR)), i * 2);
  }
  return b;
}
const silencePcm = (ms: number): Buffer => Buffer.alloc(((SR * ms) / 1000) * 2);

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
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    this.now = target;
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
}

class RecordingEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  readonly id: SttEngineId = 'deepgram';
  readonly pushed: Buffer[] = [];
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(chunk: Buffer): void { this.pushed.push(Buffer.from(chunk)); }
  async flush(): Promise<void> {}
  async close(): Promise<void> { this._state = 'closed'; }
}

describe('F-2 step 0 — VadGate starves a gated engine of post-hangover silence', () => {
  it('a gated feed (vad.open, same predicate as engine-factory) never pushes a client chunk after the gate has closed', async () => {
    const clock = new FakeClock();
    const vad = new VadGate({ hangoverMs: 300, thresholdDb: -45 });
    const eng = new RecordingEngine();
    const session = new AudioSession({
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000,
    });
    session.start();
    const orch = new SttEngineOrchestrator(session, () => eng, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: 600_000, engineFlushTimeoutMs: 1_000,
      shouldFeedEngine: (): boolean => vad.open,
    });
    await orch.start({ language: 'zh', mode: 'realtime' });

    let seq = 0;
    // 400 ms voiced — two phone chunks. Production: stt-session.ts process THEN pushChunk.
    for (const pcm of [sinePcm(CHUNK_MS), sinePcm(CHUNK_MS)]) {
      vad.process(pcm);
      expect(vad.open).toBe(true);
      orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: pcm });
      await clock.advance(CHUNK_MS);
    }
    const pushedAfterVoice = eng.pushed.length;
    expect(pushedAfterVoice).toBe(2);

    // 2000 ms of client silence. Probe: 1000 ms would close a FunASR runtime
    // span; 300 ms would not. If any of these chunks past gate-close reach the
    // engine, the starvation hypothesis is false and Fix A must not ship.
    let firstClosedSeq: number | null = null;
    for (let i = 0; i < 10; i++) {
      const pcm = silencePcm(CHUNK_MS);
      vad.process(pcm);
      const openAfter = vad.open;
      orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: pcm });
      if (!openAfter && firstClosedSeq === null) firstClosedSeq = seq - 1;
      await clock.advance(CHUNK_MS);
    }
    expect(firstClosedSeq).not.toBeNull();
    expect(vad.open).toBe(false);

    // Every client chunk pushed after the gate closed must be absent from the engine.
    // Chunks that ended still-open (hangover) may have been fed — that is the
    // hangover, not a runtime-span-closing gap.
    const silencePushed = eng.pushed.slice(pushedAfterVoice);
    const silenceMs = silencePushed.reduce((ms, b) => ms + b.length / PCM_BYTES_PER_MS, 0);
    expect(silenceMs).toBeLessThan(1000);
    expect(silenceMs).toBeLessThanOrEqual(400); // one 200 ms chunk of hangover, maybe two

    // Billing pin (stt-session.ts settle): gated sessions bill vad.sessionMs,
    // NOT engine-fed bytes. 400 ms voiced + hangover, silence excluded.
    expect(vad.sessionMs).toBeLessThan(1000);
    expect(vad.voicedMs).toBe(400);
  });

  it('metering is gate-open wall time (sessionMs), not bytes handed to the engine', () => {
    // Direct pin of the two numbers settle() chooses between (stt-session.ts):
    //   durationMs = this.gated ? this.vad.sessionMs : this.totalAudioMs
    // Injected engine-only zeros (feedVadClosureSilence today; Fix A if it
    // ships) never call vad.process, so they cannot move sessionMs.
    const vad = new VadGate({ hangoverMs: 300, thresholdDb: -45 });
    vad.process(sinePcm(400));
    const afterVoice = vad.sessionMs;
    expect(afterVoice).toBeGreaterThan(0);
    vad.process(silencePcm(2000));
    expect(vad.sessionMs).toBeLessThan(afterVoice + 400); // hangover only
    expect(vad.sessionMs).toBeLessThan(1000);
    // A 1 s engine-only zero buffer is what Fix A would push. It does not
    // go through this gate, so it is not a billing event.
    const injected = Buffer.alloc(1000 * PCM_BYTES_PER_MS);
    expect(injected.length).toBe(32_000);
    expect(vad.sessionMs).toBeLessThan(1000); // unchanged by a buffer we never process
  });
});
