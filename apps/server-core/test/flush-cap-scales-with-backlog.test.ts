// Card RC-2 — the relay half: the flush cap for a network streaming engine
// scales with the audio the vendor has not processed yet, a cap that still
// fires on the TERMINAL flush says STT_ENGINE_TIMEOUT instead of handing a few
// words out as the transcript, and every interim tells the sender how far the
// relay has taken its audio off its hands (`stt:interim.acked_audio_ms`).
//
// The defect (CR-12-E, root-cause doc §1.5/§1.6): a recovery feed pushed 428 s
// of audio in 4.3 s; Soniox takes it all and processes it at about real time;
// the flat 3 s flush cap fired, the 8 characters accumulated by then went out as
// an ordinary terminal final, and the vendor socket was closed while it worked.
//
// The vendor here processes audio at a configurable multiple of real time on
// the test's own clock, and reports its processed position the way Soniox does
// (`total_audio_proc_ms` ⇒ `SttEngine.ackedAudioMs`). Its interims carry only
// what it has processed, which is what makes a premature settle SHORT rather
// than merely late.
//
// Reverse controls (logs under .local/rc-backfill/ in the lane-d slot):
//   ① `resolveFlushTimeoutMs` without the backlog branch (flat 3 s) ⇒ the
//     「1x vendor」 case goes red: no full final, a timeout instead.
//   ② `raceFlushFinal` without the `withholdOnTimeout` branch ⇒ the 「slow
//     vendor」 case goes red: a short final and no error, the CR-12-E shape.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { EngineState, FinalResult, InterimResult, SttEngine } from '../src/stt/engines/base';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_FLUSH_TIMEOUT_MS } from '../src/stt/orchestrator-types';
import { FUNASR_FLUSH_HARD_CAP_MS, NETWORK_FLUSH_TAIL_MS, networkFlushCapMs, resolveFlushTimeoutMs } from '../src/stt/flush-final';
import { engineBacklogMs } from '../src/stt/engine-backlog';
import { SttSessionBridge } from '../src/engine/stt-session';

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
const drain = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const CHUNK_MS = 200;
const CHUNK_BYTES = CHUNK_MS * 32;

/** A streaming vendor that works through what it was sent at `rate` x real time. */
class PacedVendor extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  state: EngineState = 'closed';
  private fedMs = 0;
  private firstPushAt: number | null = null;
  constructor(private readonly clock: FakeClock, private readonly rate: number) { super(); }
  get ackedAudioMs(): number {
    if (this.firstPushAt === null) return 0;
    return Math.min(this.fedMs, (this.clock.now - this.firstPushAt) * this.rate);
  }
  /** One word per chunk; the vendor can only have said the words it has processed. */
  private textUpTo(ms: number): string {
    return Array.from({ length: Math.floor(ms / CHUNK_MS) }, (_, i) => `w${i}`).join(' ');
  }
  async open(): Promise<void> { this.state = 'open'; }
  push(chunk: Buffer, _ts: number): void {
    if (this.firstPushAt === null) this.firstPushAt = this.clock.now;
    this.fedMs += chunk.length / 32;
  }
  /** A frame the vendor sends while it works (the test decides when). */
  tick(): void {
    const ev: InterimResult = { kind: 'interim', text: this.textUpTo(this.ackedAudioMs), confidence: 0.9, language: 'zh' };
    this.emit('interim', ev);
  }
  flush(): Promise<void> {
    const remaining = Math.max(0, this.fedMs - this.ackedAudioMs) / this.rate;
    return new Promise<void>((resolve) => {
      this.clock.setTimeout(() => {
        const ev: FinalResult = { kind: 'final', text: this.textUpTo(this.fedMs), confidence: 0.9, language: 'zh', duration_ms: this.fedMs };
        this.emit('final', ev);
        resolve();
      }, remaining);
    });
  }
  async close(): Promise<void> { this.state = 'closed'; }
}

async function harness(rate: number) {
  const clock = new FakeClock();
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000,
  });
  session.start();
  const vendor = new PacedVendor(clock, rate);
  const orch = new SttEngineOrchestrator(session, () => vendor, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
  });
  const finals: Array<{ text: string; is_segment?: boolean }> = [];
  const interims: Array<{ text: string; acked_audio_ms?: number }> = [];
  const errors: Array<{ code: string; message: string; retryable: boolean }> = [];
  orch.on('final', (p: { text: string; is_segment?: boolean }) => finals.push(p));
  orch.on('interim', (p: { text: string; acked_audio_ms?: number }) => interims.push(p));
  orch.on('error', (p: { code: string; message: string; retryable: boolean }) => errors.push(p));
  await orch.start({ language: 'zh', mode: 'realtime' });
  /** The CR-12-E feed: the whole range at once, stamped in the sender's clock. */
  const burst = (ms: number): void => {
    for (let i = 0; i < ms / CHUNK_MS; i++) orch.pushChunk({ seq: i, ts_ms: i * CHUNK_MS, payload: Buffer.alloc(CHUNK_BYTES) });
  };
  return { orch, clock, vendor, finals, interims, errors, burst };
}

const allWords = (ms: number): string => Array.from({ length: ms / CHUNK_MS }, (_, i) => `w${i}`).join(' ');

describe('RC-2 · the network flush cap scales with unprocessed audio', () => {
  it('max(floor, backlog + tail); explicit config and the other families are unchanged; no position ⇒ flat', () => {
    expect(networkFlushCapMs(DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, 0)).toBe(DEFAULT_ENGINE_FLUSH_TIMEOUT_MS);
    expect(networkFlushCapMs(DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, 60_000)).toBe(60_000 + NETWORK_FLUSH_TAIL_MS);
    expect(resolveFlushTimeoutMs('soniox', DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, false, 60_000, 60_000)).toBe(63_000);
    expect(resolveFlushTimeoutMs('soniox', DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, false, 60_000, null)).toBe(DEFAULT_ENGINE_FLUSH_TIMEOUT_MS);
    expect(resolveFlushTimeoutMs('soniox', 777, true, 60_000, 60_000)).toBe(777);
    expect(resolveFlushTimeoutMs('funasr', DEFAULT_ENGINE_FLUSH_TIMEOUT_MS, false, 60_000, 60_000)).toBe(FUNASR_FLUSH_HARD_CAP_MS);
  });

  it('backlog is fed minus processed on this leg; an engine that reports nothing has an UNKNOWN backlog, not 0', () => {
    expect(engineBacklogMs({ ackedAudioMs: 10_000 }, 60_000 * 32)).toBe(50_000);
    expect(engineBacklogMs({ ackedAudioMs: 70_000 }, 60_000 * 32)).toBe(0);
    expect(engineBacklogMs({}, 60_000 * 32)).toBeNull();
    expect(engineBacklogMs(null, 0)).toBeNull();
  });

  it('a 60 s burst to a 1x vendor: the terminal final carries ALL of it, and nothing is refused', async () => {
    const h = await harness(1);
    h.burst(60_000);
    const stopping = h.orch.stop();
    await drain();
    await h.clock.advance(3_000);
    // Where the flat cap settled on CR-12-E: nothing may have been delivered yet.
    expect(h.finals).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    await h.clock.advance(60_000);
    await stopping;
    expect(h.errors).toHaveLength(0);
    const terminal = h.finals.filter((f) => f.is_segment === false);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.text.replace(/[.。\s]+$/u, '')).toBe(allWords(60_000));
  });

  it('a vendor too slow even for the scaled cap: STT_ENGINE_TIMEOUT (retryable:false) and NO final, not a short one', async () => {
    const h = await harness(0.5);
    h.burst(60_000);
    await h.clock.advance(4_000);
    h.vendor.tick(); // it has said the first 2 s worth of words by now
    expect(h.interims.at(-1)!.text.length).toBeGreaterThan(0);
    const stopping = h.orch.stop();
    await drain();
    await h.clock.advance(200_000);
    await stopping;
    expect(h.finals.filter((f) => f.is_segment === false)).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]!.code).toBe('STT_ENGINE_TIMEOUT');
    expect(h.errors[0]!.retryable).toBe(false);
    // The message names what the vendor had done and the cap that ran out.
    expect(h.errors[0]!.message).toContain('of the 60000 ms it was sent');
  });

  it('every interim carries acked_audio_ms = received end - unprocessed backlog, in the sender clock', async () => {
    const h = await harness(1);
    h.burst(60_000);
    await h.clock.advance(10_000);
    h.vendor.tick();
    expect(h.interims.at(-1)!.acked_audio_ms).toBe(10_000);
    await h.clock.advance(15_000);
    h.vendor.tick();
    expect(h.interims.at(-1)!.acked_audio_ms).toBe(25_000);
  });
});

describe('RC-2 · the bridge carries acked_audio_ms onto the wire stt:interim', () => {
  it('forwards the orchestrator field as-is, and leaves it absent for an engine that reports nothing', async () => {
    // The seam every stt:* frame crosses to reach the socket (`engine/stt-session.ts` wireEvents).
    // A field the orchestrator computes and the bridge drops would reach nobody.
    const run = async (reports: boolean) => {
      const clock = new FakeClock();
      const vendor = new PacedVendor(clock, 1);
      const quiet = Object.assign(new EventEmitter(), {
        id: 'custom-openai-compatible' as const, state: 'closed' as EngineState,
        async open() { quiet.state = 'open'; }, push() {}, async flush() {}, async close() { quiet.state = 'closed'; },
      });
      const engine = reports ? vendor : quiet;
      const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const bridge = new SttSessionBridge({
        build: (session) => ({ orchestrator: new SttEngineOrchestrator(session, () => engine as never, { engineFlushTimeoutMs: 200 }), isByok: false, gated: false }),
        emitter: { emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }) },
        userId: 'u', mode: 'realtime', sourceLang: 'zh', onComplete: () => {}, levelIntervalMs: 0,
      });
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 5; i++) bridge.pushChunk(i, Buffer.alloc(CHUNK_BYTES).toString('base64'), i * CHUNK_MS);
      clock.now = 600; // the vendor has worked through 600 of the 1 000 ms it was handed
      engine.emit('interim', { kind: 'interim', text: 'w0', confidence: 0.9, language: 'zh' });
      await bridge.finish();
      return emitted.find((e) => e.event === 'stt:interim')?.payload;
    };
    const withPosition = await run(true);
    expect(withPosition).toBeDefined();
    // 1 000 ms received, 400 ms of it still unprocessed at the vendor ⇒ 600 in the sender's clock.
    expect(withPosition!.acked_audio_ms).toBe(600);
    const without = await run(false);
    expect(without).toBeDefined();
    expect('acked_audio_ms' in without!).toBe(false);
  });
});
