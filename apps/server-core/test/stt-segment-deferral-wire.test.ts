// card SEG-1, THE WIRING HALF — the orchestrator really defers the cut.
//
// `stt-segment-boundary.test.ts` proves the POLICY (a pure verdict function).
// This file proves the policy is CONNECTED: that the soft-segment deadline no
// longer cuts by itself, that a confirmed sentence is what releases it, and that
// the grace ceiling still ends a segment when nothing else will.
//
// 🔴 WHY BOTH FILES EXIST. Delete the `segmentCutVerdict(...)` call from
// `orchestrator-core.ts`'s `pushChunk` and every row in the policy file stays
// green — it is a pure function with its own callers in the test. That is the
// repo's own rule ("单测全绿对「接线」零证明力"), and the reverse control below
// was run rather than assumed: see the block at the foot of this file.

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SttEngineId } from '@flowmic/protocol';
import type { EngineState } from '../src/stt/engines/base';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';

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
  readonly id: SttEngineId = 'custom-openai-compatible';
  readonly interimShape = 'cumulative' as const;
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

const CHUNK = 6_400; // 200 ms @16k mono s16le — the size the phone really sends

/** `voiced` decides what the VAD gate would say about this chunk. The production
 *  wiring is `shouldFeedEngine: () => vad.open` (stt/engine-factory.ts). */
function harness(engines: FakeEngine[], voiced: () => boolean, graceMs = 15_000): {
  orch: SttEngineOrchestrator; clock: FakeClock; finals: Array<{ text: string; is_segment: boolean; segment_idx: number }>;
} {
  const clock = new FakeClock();
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000,
  });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, softSegmentGraceMs: graceMs, engineFlushTimeoutMs: 1_000,
    shouldFeedEngine: () => voiced(),
  });
  const finals: Array<{ text: string; is_segment: boolean; segment_idx: number }> = [];
  orch.on('final', (p) => finals.push(p as never));
  return { orch, clock, finals };
}

/** Feed `n` chunks of continuous speech, advancing the clock one chunk each. */
async function speak(orch: SttEngineOrchestrator, clock: FakeClock, from: number, n: number): Promise<number> {
  let seq = from;
  for (let k = 0; k < n; k++) {
    orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(CHUNK) });
    await clock.advance(200);
  }
  return seq;
}

describe('SEG-1 wiring — the deadline asks for a boundary, it does not take one', () => {
  it('🔴 30 s of unbroken mid-sentence speech produces NO segment final', async () => {
    const engines = [new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines, () => true);
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.textOnFlush = 'should not be cut here';

    // The engine has confirmed a clause, NOT a sentence — 「本质上安倍」, the
    // exact shape of the reported defect.
    engines[0]!.emitFinal('所以呢，本质上安倍');
    await clock.advance(30_000);           // the cadence deadline passes
    await speak(orch, clock, 0, 10);       // 2 more seconds of speech

    expect(finals.filter((f) => f.is_segment)).toHaveLength(0);
  });

  it('cuts on the next chunk once the engine CONFIRMS a sentence', async () => {
    const engines = [new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines, () => true);
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.emitFinal('所以呢，本质上安倍');
    await clock.advance(30_000);
    await speak(orch, clock, 0, 3);
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0);

    // The sentence lands. The next chunk is allowed to end the segment.
    engines[0]!.textOnFlush = '所以呢，本质上安倍经济学是这样。';
    engines[0]!.emitFinal('所以呢，本质上安倍经济学是这样。');
    await speak(orch, clock, 3, 1);

    const segs = finals.filter((f) => f.is_segment);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe('所以呢，本质上安倍经济学是这样。');
    expect(segs[0]!.segment_idx).toBe(0);
  });

  it('a real pause cuts too, without waiting for punctuation', async () => {
    const engines = [new FakeEngine(), new FakeEngine()];
    let voiced = true;
    const { orch, clock, finals } = harness(engines, () => voiced);
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.textOnFlush = '没有标点也可以切';
    engines[0]!.emitFinal('没有标点也可以切');
    await clock.advance(30_000);
    await speak(orch, clock, 0, 2);
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0);

    voiced = false; // the VAD hangover elapsed — the speaker stopped
    await speak(orch, clock, 2, 1);
    expect(finals.filter((f) => f.is_segment)).toHaveLength(1);
  });

  it('🔴 the ceiling ends a segment nothing else would: no pause, no punctuation', async () => {
    const engines = [new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines, () => true);
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.textOnFlush = 'one two three four five';
    engines[0]!.emitFinal('one two three four five'); // English: no 「。」 ever

    await clock.advance(30_000);
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0); // deadline alone: nothing
    await clock.advance(15_000);                                // the grace expires
    expect(finals.filter((f) => f.is_segment)).toHaveLength(1);
  });

  it('the deadline does not re-fire while the segment is waiting for its boundary', async () => {
    // Guards against the obvious wrong fix — re-arming phase 1 instead of the
    // ceiling — which would leave a session that never cuts at all.
    const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines, () => true);
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.textOnFlush = 'no boundary in sight';
    engines[0]!.emitFinal('no boundary in sight');
    await clock.advance(30_000 + 15_000 + 30_000);
    // Exactly one cut from the first ceiling; the second segment's own deadline
    // has passed but its grace has not.
    expect(finals.filter((f) => f.is_segment)).toHaveLength(1);
  });
});

// ── REVERSE CONTROL (2026-08-15, dev-pc-a, run and observed) ──────────
// Removing the `segmentCutVerdict(...)` block from `orchestrator-core.ts`'s
// `pushChunk` — i.e. leaving the ceiling as the only cut — turns this file to
// 「2 failed | 3 passed」, both failures reading `expected [] to have a length of
// 1 but got +0`: the sentence-confirmed row and the pause row lose their segment
// final. Restored and re-run: 5 passed.
//
// ⚠️ I PREDICTED 「3 failed」 HERE AND THE MACHINE SAID 2 — recorded rather than
// quietly corrected. The row I expected to fall is the FIRST one, and it cannot:
// it asserts that NO cut happens, so deleting the only code that can cut leaves
// it green. That is worth knowing about it — on its own it is satisfied by the
// feature being absent, which is why it never travels alone.
//
// The complementary control lives in the policy file, where widening
// SENTENCE_TERMINATORS to include the ASCII period turns the "U.S." / "3.5" row
// red.
