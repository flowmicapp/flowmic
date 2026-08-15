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

    // 🔴 card SEG-3 — the gate going quiet is NOT the boundary any more, because
    // a breath does that. owner's 2026-08-15 seam was cut in the pause before
    // 「这个方案」, mid-clause. The silence has to LAST (MIN_PAUSE_MS).
    voiced = false;
    await speak(orch, clock, 2, 3); // 0 / 200 / 400 ms of quiet — a breath
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0);

    await speak(orch, clock, 5, 1); // 600 ms — the speaker really did stop
    expect(finals.filter((f) => f.is_segment)).toHaveLength(1);
  });

  it('🔴 card SEG-4: the leg span expiring rotates the ENGINE and mints NOTHING', async () => {
    // Before this card the grace expiry was a CEILING that delivered a row —
    // i.e. time could end the user's sentence, which is owner's 2026-08-15
    // defect at its root. Now it only swaps the vendor leg.
    const engines = [new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines, () => true);
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.textOnFlush = 'one two three four five';
    engines[0]!.emitFinal('one two three four five'); // English: no 「。」 ever

    await clock.advance(30_000);
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0); // deadline alone: nothing
    await clock.advance(15_000);                                // the leg span expires
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0); // 🔴 still no row
    expect(engines[1]!.state).toBe('open');                     // but the LEG rotated
    // …and nothing was lost: the terminal final settles the banked text.
    engines[1]!.textOnFlush = '';
    await orch.stop();
    const terminal = finals.find((f) => !f.is_segment)!;
    expect(terminal.text).toBe('one two three four five');
  });

  it('leg spans keep rotating while the boundary refuses to arrive', async () => {
    // Guards against the obvious wrong shape — a one-shot rotation — which
    // would leave the SECOND leg unbounded for the rest of the recording.
    const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines, () => true);
    await orch.start({ language: 'zh', mode: 'realtime' });
    engines[0]!.textOnFlush = 'no boundary in sight';
    engines[0]!.emitFinal('no boundary in sight');
    await clock.advance(30_000 + 15_000);      // leg 1 rotates out at t=45 s
    expect(engines[1]!.state).toBe('open');
    await clock.advance(45_000);               // a full leg span later, so does leg 2
    expect(engines[2]!.state).toBe('open');
    expect(finals.filter((f) => f.is_segment)).toHaveLength(0); // and still no row
  });

  it('🔴 SEG-3/SEG-4: a leg seam does not leave a full stop nobody spoke inside the row',
    async () => {
      // owner's 2026-08-15 defect, end to end. The recognizer punctuates the
      // SPAN (see SherpaLocalEngine's `interimShape` header), so the rotated
      // leg's flush comes back 「…实现。」 mid-clause. Under SEG-4 that text stays
      // INSIDE the row (the rotation delivers nothing), so an unrepaired seam
      // would now sever the clause in the middle of one row. This asserts the
      // EMITTED frame: `seamText` can be perfect and still not be called.
      const engines = [new FakeEngine(), new FakeEngine()];
      const { orch, clock, finals } = harness(engines, () => true);
      await orch.start({ language: 'zh', mode: 'realtime' });
      // Mid-clause 「…要怎么样实现」 handed back as a finished sentence.
      engines[0]!.textOnFlush = '看看要怎么样实现。';
      engines[0]!.emitFinal('看看要怎么样实现');

      await clock.advance(30_000);
      await clock.advance(15_000); // the leg span expires mid-clause: rotate
      expect(finals.filter((f) => f.is_segment)).toHaveLength(0);
      // The clause CONTINUES in the new leg and the engine confirms its end…
      engines[1]!.textOnFlush = '这个方案，所以说不一定要怎么搞。';
      engines[1]!.emitFinal('这个方案，所以说不一定要怎么搞。');
      await speak(orch, clock, 0, 1); // …and the next chunk delivers the row.

      const segs = finals.filter((f) => f.is_segment);
      expect(segs).toHaveLength(1);
      // 🔴 One row, one clause, and the seam's fabricated 「。」 is gone.
      expect(segs[0]!.text).toBe('看看要怎么样实现这个方案，所以说不一定要怎么搞。');
    });

  it('SEG-3: a segment that ends on a sentence the SPEAKER finished keeps its mark',
    async () => {
      // The other direction, so the repair cannot be widened into "always strip".
      const engines = [new FakeEngine(), new FakeEngine()];
      const { orch, clock, finals } = harness(engines, () => true);
      await orch.start({ language: 'zh', mode: 'realtime' });
      engines[0]!.textOnFlush = '这句真的说完了。';
      engines[0]!.emitFinal('这句真的说完了。'); // CONFIRMED ends the sentence

      await clock.advance(30_000);
      // No pause and no ceiling needed: the confirmed sentence IS the boundary,
      // and it is reported as reason 'sentence', so the mark survives. It still
      // takes a CHUNK to ask — cuts live on the chunk path, never on the timer.
      await speak(orch, clock, 0, 1);
      const segs = finals.filter((f) => f.is_segment);
      expect(segs).toHaveLength(1);
      expect(segs[0]!.text).toBe('这句真的说完了。');
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

// ── REVERSE CONTROL, card SEG-4 (2026-08-15, dev-pc-a — run, observed, reverted) ──
// ① Make the cadence's phase 2 deliver again (`rotateLeg: () => startRollover(true)`,
//    the pre-SEG-4 ceiling) ⇒ 「5 failed | 20 passed」 across this file and
//    stt-orchestrator.test.ts: every 「mints NOTHING」 row sees a row minted by
//    the clock, and the one-clause row gets its clause severed again.
// ② Bank the rotated leg's flush WITHOUT `seamText` ⇒ 「2 failed | 20 passed」,
//    and the one-clause row prints owner's defect INSIDE a single row:
//      Received: "看看要怎么样实现。这个方案，所以说不一定要怎么搞。"
//    — which is why the repair matters MORE under SEG-4, not less: the seam
//    moved inside the row, where no reader could even see it as a seam.
//
// ── REVERSE CONTROL, card SEG-3 (2026-08-15, dev-pc-a — run, observed, reverted) ──
// ① Emit `r.text` instead of `seamText(r.text, …)` in `flushAndEmitFinal` ⇒
//    「1 failed | 6 passed」, and the failure prints owner's defect verbatim:
//      Expected: "看看要怎么样实现"   Received: "看看要怎么样实现。"
//    That is the whole card in one line — the mark is added by the SPAN, and the
//    only place it can be taken back off is the emit.
// ② Relax the silence run back to `gateClosedMs > 0` (i.e. SEG-1's instant gate
//    reading) ⇒ 「2 failed | 28 passed」 across this file and the policy file:
//    the breath-length row cuts again ('cut' where 'wait' is expected) and the
//    wire row mints a segment 400 ms into a pause. Those two ARE the reported
//    seam: SEG-1 would have cut in the breath before 「这个方案」 as surely as the
//    30 s stopwatch did, just one second later.
