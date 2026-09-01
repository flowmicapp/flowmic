// F-2 Fix B — on a PAUSE-triggered FunASR rollover only, wait ≤800 ms for the
// covering 2pass-offline (punctuated) to fold into offlineAccum before minting
// the row. Expiry mints with today's text. Sentence cuts and non-FunASR pause
// cuts are unchanged. Added latency is pause-cut rows only, at most 0.8 s.

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SttEngineId } from '@flowmic/protocol';
import type { EngineState } from '../src/stt/engines/base';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { FunasrSpanClosureFeeder, PAUSE_OFFLINE_WAIT_MS } from '../src/stt/funasr-span-closure';

class FakeClock {
  now = 1_754_100_000_000;
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
      for (let i = 0; i < 24; i++) await Promise.resolve();
    }
    this.now = target;
    for (let i = 0; i < 24; i++) await Promise.resolve();
  }
}

class FakeEngine extends EventEmitter {
  private _state: EngineState = 'closed';
  textOnFlush: string | null = null;
  readonly interimShape = 'cumulative' as const;
  constructor(public readonly id: SttEngineId) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {
    if (this.textOnFlush !== null) {
      this.emit('final', { kind: 'final', text: this.textOnFlush, confidence: 1, language: 'zh', duration_ms: 0 });
    }
  }
  async close(): Promise<void> { this._state = 'closed'; }
  emitFinal(text: string): void {
    this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0 });
  }
}

const CHUNK = 6_400;
const TODAY = '没有标点也可以切';
const COVERING = '没有标点也可以切，覆盖离线来了';

async function drain(): Promise<void> {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

function harness(engines: FakeEngine[], voiced: () => boolean): {
  orch: SttEngineOrchestrator; clock: FakeClock; finals: Array<{ text: string; is_segment: boolean }>;
} {
  const clock = new FakeClock();
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000,
  });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, softSegmentGraceMs: 15_000, engineFlushTimeoutMs: 1_000,
    shouldFeedEngine: () => voiced(),
  });
  const finals: Array<{ text: string; is_segment: boolean }> = [];
  orch.on('final', (p) => finals.push(p as never));
  return { orch, clock, finals };
}

async function speak(orch: SttEngineOrchestrator, clock: FakeClock, from: number, n: number): Promise<number> {
  let seq = from;
  for (let k = 0; k < n; k++) {
    orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(CHUNK) });
    await clock.advance(200);
  }
  return seq;
}

/** Voice past the cadence, then quiet through 400 ms. The NEXT push is the 600 ms pause cut. */
async function dueThenQuiet400(
  orch: SttEngineOrchestrator, clock: FakeClock, engine: FakeEngine, setVoiced: (v: boolean) => void,
): Promise<number> {
  engine.textOnFlush = TODAY;
  engine.emitFinal(TODAY);
  await clock.advance(30_000);
  const seq = await speak(orch, clock, 0, 2);
  setVoiced(false);
  return speak(orch, clock, seq, 3); // 0 / 200 / 400 ms — a breath, no cut
}

describe('FunasrSpanClosureFeeder.waitForCoveringOffline', () => {
  function clockHarness(): FakeClock {
    return new FakeClock();
  }

  it('resolves immediately when disabled or already covered', async () => {
    const f = new FunasrSpanClosureFeeder();
    const clock = clockHarness();
    let n = 0;
    await f.waitForCoveringOffline({
      enabled: false, alreadyCovered: false,
      setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    });
    n++;
    await f.waitForCoveringOffline({
      enabled: true, alreadyCovered: true,
      setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    });
    n++;
    expect(n).toBe(2);
  });

  it('notifyFold unblocks before the timeout', async () => {
    const f = new FunasrSpanClosureFeeder();
    const clock = clockHarness();
    let done = false;
    const p = f.waitForCoveringOffline({
      enabled: true, alreadyCovered: false, timeoutMs: PAUSE_OFFLINE_WAIT_MS,
      setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    }).then(() => { done = true; });
    await drain();
    expect(done).toBe(false);
    f.notifyFold();
    await p;
    expect(done).toBe(true);
  });

  it('expires at PAUSE_OFFLINE_WAIT_MS when nothing folds', async () => {
    const f = new FunasrSpanClosureFeeder();
    const clock = clockHarness();
    let done = false;
    const p = f.waitForCoveringOffline({
      enabled: true, alreadyCovered: false,
      setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    }).then(() => { done = true; });
    await clock.advance(PAUSE_OFFLINE_WAIT_MS - 1);
    expect(done).toBe(false);
    await clock.advance(1);
    await p;
    expect(done).toBe(true);
  });
});

describe('F-2 Fix B wiring — pause-cut FunASR waits for covering offline', () => {
  it('a covering offline that arrives during the wait is what the row carries', async () => {
    const engines = [new FakeEngine('funasr'), new FakeEngine('funasr')];
    let voiced = true;
    const { orch, clock, finals } = harness(engines, () => voiced);
    await orch.start({ language: 'zh', mode: 'realtime' });
    const seq = await dueThenQuiet400(orch, clock, engines[0]!, (v) => { voiced = v; });

    orch.pushChunk({ seq, ts_ms: clock.now, payload: Buffer.alloc(CHUNK) }); // 600 ms — pause cut, wait starts
    await drain();
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0);

    engines[0]!.emitFinal(COVERING);
    await drain();
    const segs = finals.filter((f) => f.is_segment);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe(COVERING);
  });

  it('expiry at 800 ms mints with today\'s text', async () => {
    const engines = [new FakeEngine('funasr'), new FakeEngine('funasr')];
    let voiced = true;
    const { orch, clock, finals } = harness(engines, () => voiced);
    await orch.start({ language: 'zh', mode: 'realtime' });
    const seq = await dueThenQuiet400(orch, clock, engines[0]!, (v) => { voiced = v; });

    orch.pushChunk({ seq, ts_ms: clock.now, payload: Buffer.alloc(CHUNK) });
    await drain();
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0);

    await clock.advance(PAUSE_OFFLINE_WAIT_MS - 1);
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0);
    await clock.advance(1);
    const segs = finals.filter((f) => f.is_segment);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe(TODAY);
  });

  it('a sentence cut does not wait — the row mints on the confirming chunk', async () => {
    const engines = [new FakeEngine('funasr'), new FakeEngine('funasr')];
    const { orch, clock, finals } = harness(engines, () => true);
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.textOnFlush = '这句真的说完了。';
    engines[0]!.emitFinal('这句真的说完了。');
    await clock.advance(30_000);
    await speak(orch, clock, 0, 1);
    const segs = finals.filter((f) => f.is_segment);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe('这句真的说完了。');
  });

  it('a non-FunASR pause cut still mints on the pause chunk (no 800 ms hold)', async () => {
    const engines = [new FakeEngine('custom-openai-compatible'), new FakeEngine('custom-openai-compatible')];
    let voiced = true;
    const { orch, clock, finals } = harness(engines, () => voiced);
    await orch.start({ language: 'zh', mode: 'realtime' });
    const seq = await dueThenQuiet400(orch, clock, engines[0]!, (v) => { voiced = v; });
    orch.pushChunk({ seq, ts_ms: clock.now, payload: Buffer.alloc(CHUNK) });
    await drain();
    expect(finals.filter((f) => f.is_segment)).toHaveLength(1);
  });

  it('a FunASR pause-cut row keeps the covering offline terminator', async () => {
    const engines = [new FakeEngine('funasr'), new FakeEngine('funasr')];
    let voiced = true;
    const { orch, clock, finals } = harness(engines, () => voiced);
    await orch.start({ language: 'zh', mode: 'realtime' });
    const seq = await dueThenQuiet400(orch, clock, engines[0]!, (v) => { voiced = v; });
    orch.pushChunk({ seq, ts_ms: clock.now, payload: Buffer.alloc(CHUNK) });
    await drain();
    engines[0]!.emitFinal(`${COVERING}。`);
    await drain();
    const segs = finals.filter((f) => f.is_segment);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe(`${COVERING}。`);
  });
});

// ── REVERSE CONTROL (2026-08-31, dev-pc-a, run and observed) ────────
// Commenting out the `await this.spanClosure.waitForCoveringOffline(...)`
// block in orchestrator-core.ts `rolloverSegment` turns both wait-path
// rows red at the "row is not minted yet" assertion — without the wait
// the pause chunk flushes immediately:
//   AssertionError: expected [ { text: '没有标点也可以切', …(5) } ] to have a length of +0 but got 1
// Restored; marker F2-FIXB-REVERSE-CONTROL grepped to 0 in src/.
//
// F-2 Fix C reverse control (same day, same machine): dropping
// `|| reason === 'pause'` from seamText turns the terminator wiring row red:
//   AssertionError: expected '没有标点也可以切，覆盖离线来了' to be '没有标点也可以切，覆盖离线来了。'
// Restored; marker F2-FIXC-REVERSE-CONTROL grepped to 0 in src/.
