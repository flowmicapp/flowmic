// W2.5-B — 「one segment_idx may have only one server final」.
//
// The phone adopts a server final PER `segment_idx`: same idx ⇒ this is a
// revision of what I already have ⇒ REPLACE; different idx ⇒ a disjoint span ⇒
// CONCATENATE. So two finals carrying one idx do not merely look untidy — the
// second one DELETES the first, and an entire finalized segment leaves the
// transcript without a single failure anywhere. That lands on FB-6, dropped characters.
//
// The window: `stop()` (the user releasing the button) used to be the ONE
// terminal path that neither raised the `terminalizing` fence nor awaited an
// in-flight `rolloverWork`, while `handleHardLimit()` — the same author, 45
// lines away — did both. So a release that landed inside a soft-segment
// rollover's flush produced a segment final at idx N and then a terminal final
// at idx N, because nothing had incremented the counter yet.
//
// These tests drive the REAL orchestrator with a fake engine and a fake clock;
// every assertion is on the emitted `segment_idx` values, never on internals.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

class FakeClock {
  now = 0;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number): number => { const id = ++this.seq; this.timers.push({ id, fn, at: this.now + ms }); return id; };
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
const drain = async (): Promise<void> => { for (let i = 0; i < 24; i++) await Promise.resolve(); };

/** Batch-style engine (the id deliberately avoids the 5s streaming flush floor). */
class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  opens = 0;
  flushes = 0;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this.opens++; this._state = 'open'; }
  push(): void { /* the byte path is not what these tests measure */ }
  async flush(): Promise<void> { this.flushes++; }
  async close(): Promise<void> { this._state = 'closed'; }
  emitFinal(text: string): void { this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0 }); }
}

interface FinalEvent { text: string; segment_idx: number; is_segment: boolean }

function harness(engines: FakeEngine[], opts: Record<string, unknown> = {}): {
  orch: SttEngineOrchestrator; clock: FakeClock; finals: FinalEvent[]; errors: { code: string }[];
} {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, engineFlushTimeoutMs: 1_000, ...opts,
  });
  const finals: FinalEvent[] = [];
  const errors: { code: string }[] = [];
  orch.on('final', (p: FinalEvent) => finals.push(p));
  orch.on('error', (p: { code: string }) => errors.push(p));
  return { orch, clock, finals, errors };
}

describe('W2.5-B: at most ONE server final per segment_idx', () => {
  it('🔴 releasing the button mid-rollover must not put two finals on one segment_idx', async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, finals } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });

    // Both flushes — the rollover's, and the one `stop()` issues — go to the
    // SAME live engine and settle together when the vendor finally answers.
    // That is the real shape: `stop()` does not get its own private engine.
    let releaseVendor!: () => void;
    const vendorAnswered = new Promise<void>((r) => { releaseVendor = r; });
    a.flush = async (): Promise<void> => { a.flushes++; await vendorAnswered; a.emitFinal('前半句'); };

    await clock.advance(30_000);          // soft-segment boundary → rolloverSegment() parks in its flush
    expect(finals).toHaveLength(0);       // the precondition this test rests on, asserted not assumed
    expect(a.flushes).toBe(1);

    const stopped = orch.stop();          // the user releases the button, mid-rollover
    releaseVendor();
    await drain();
    await stopped;
    await drain();

    const idxs = finals.map((f) => f.segment_idx);
    // The invariant, stated as the invariant — not as 「the finals look right」.
    expect(new Set(idxs).size).toBe(idxs.length);
    // And the same fact from the phone's side: whatever index the terminal final
    // carries, no segment final may already have claimed it.
    const terminal = finals.find((f) => !f.is_segment);
    expect(terminal).toBeDefined();
    expect(finals.filter((f) => f.segment_idx === terminal!.segment_idx)).toHaveLength(1);
  });

  it('🔴 an EMITTED segment final consumes its index, whichever fence check sees the stop', async () => {
    // The second asymmetry: `rolloverSegment()` used to return WITHOUT
    // incrementing when the fence was seen right after the flush, but WITH
    // incrementing when it was seen right after closeEngine() — the same fact
    // (`terminalizing`) treated two ways at two moments, 45µs apart. Here the
    // release lands while the rollover sits inside `engine.close()`, i.e. AFTER
    // its segment final for idx 0 is already on the wire.
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, finals } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.flush = async (): Promise<void> => { a.flushes++; a.emitFinal('segment one'); };
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => { releaseClose = r; });
    a.close = async (): Promise<void> => { await closing; };

    await clock.advance(30_000);
    expect(finals).toHaveLength(1);              // the segment final for idx 0 is already out
    expect(finals[0]!.segment_idx).toBe(0);
    expect(finals[0]!.is_segment).toBe(true);

    const stopped = orch.stop();                 // release, while the rollover is inside engine.close()
    releaseClose();
    await drain();
    await stopped;
    await drain();

    const terminal = finals.find((f) => !f.is_segment);
    // 🔴 It must EXIST. The pre-fix code took the `if (!this.engine)` branch here
    // — closeEngine() nulls the field before awaiting — and returned in silence,
    // so the phone's FSM sat in PROCESSING until its 15s stall net with no
    // terminal final ever arriving.
    expect(terminal).toBeDefined();
    // And it must not re-use idx 0, which the segment final above already spent.
    expect(terminal!.segment_idx).toBe(1);
    // Its text is empty ON PURPOSE: `offlineAccum` still holds 'segment one',
    // which idx 0 already carried. Re-sending it under idx 1 reads as a disjoint
    // span on the phone ⇒ CONCATENATE ⇒ the sentence would be duplicated.
    //
    // 🔴 card RT3-B (2026-08-08) — THIS LINE IS NOW ALSO THAT CARD'S POSITIVE
    // CONTROL, and it is why the card could be taken narrowly. RT3-B makes the
    // no-engine branch emit the accumulators when no final has carried them out;
    // the rollover caller HAS carried them out, so it must still get `''`. The
    // difference is that the reason is now a RECORDED fact
    // (`accumEmittedByFinal`) rather than a comment asserting another path's
    // behaviour. Contract: docs/rebuild/15 §2.0-d.
    expect(terminal!.text).toBe('');
  });

  it('the ordinary rollover→stop sequence still hands out consecutive indices', async () => {
    // Positive control. If the fix worked by simply never emitting a segment
    // final, or never incrementing, this is the test that would notice.
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, finals } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.flush = async (): Promise<void> => { a.emitFinal('segment one'); };
    await clock.advance(30_000);
    b.flush = async (): Promise<void> => { b.emitFinal('segment two'); };
    await orch.stop();
    expect(finals.map((f) => [f.segment_idx, f.is_segment])).toEqual([[0, true], [1, false]]);
    expect(finals[0]!.text).toBe('segment one');
    expect(finals[1]!.text).toBe('segment two');
  });
});

describe('W2.5-B: the fix costs the common path nothing', () => {
  it('no rollover in flight ⇒ stop() consumes zero additional time and spawns no engine', async () => {
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, finals } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.flush = async (): Promise<void> => { a.emitFinal('大家好'); };
    const before = clock.now;
    await orch.stop();
    // Measured on the injected clock: `if (this.rolloverWork)` is not taken, so
    // not even the extra `await` is executed.
    expect(clock.now).toBe(before);
    expect(b.opens).toBe(0);
    expect(finals).toEqual([expect.objectContaining({ text: '大家好', segment_idx: 0, is_segment: false })]);
  });

  it('🔴 the fence ALONE is not enough — without the await the terminal flush loses its own final', async () => {
    // The tempting cheap fix is 「raise the fence only, do not await」: the fenced rollover
    // declines to emit, so the indices stop colliding and the collision test
    // above goes green. It is a trap. `flushing` is ONE boolean shared by both
    // flushes, so the rollover's flush clears it while the terminal flush is
    // still in the air, and from that moment the engine `final` handler reads
    // `terminalizing && !flushing` as 「wrapping up, leave it」 and DROPS the terminal
    // flush's own answer. Same red line, one layer down.
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, finals } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    let releaseRollover!: () => void; let releaseTerminal!: () => void;
    const rolloverAnswered = new Promise<void>((r) => { releaseRollover = r; });
    const terminalAnswered = new Promise<void>((r) => { releaseTerminal = r; });
    let call = 0;
    a.flush = async (): Promise<void> => {
      a.flushes++;
      if (++call === 1) { await rolloverAnswered; a.emitFinal('前半句'); return; }
      await terminalAnswered; a.emitFinal('前半句后半句');
    };

    await clock.advance(30_000);
    const stopped = orch.stop();
    releaseRollover(); await drain();
    releaseTerminal(); await drain();
    await stopped; await drain();

    const terminal = finals.find((f) => !f.is_segment);
    expect(terminal).toBeDefined();
    // 后半句 is the word that disappears when the two flushes are allowed to
    // overlap. Awaiting the fenced rollover serialises them, so `flushing` is
    // true for the whole of the terminal flush and the fold happens.
    expect(terminal!.text).toContain('后半句');
  });

  it('worst case is bounded by ONE extra flush cap, and never by an engine spawn', async () => {
    // The naive fix — `await this.rolloverWork` without raising the fence first —
    // would wait for `rolloverSegment()` to run to completion, and it ends with
    // `await this.spawnEngine()`: a brand-new vendor connection, opened only to
    // be closed one line later. Raising the fence BEFORE the await makes the
    // rollover bail at its first fence check, so the wait is bounded by the
    // remaining time on the flush it had ALREADY issued.
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, finals } = harness([a, b]);           // engineFlushTimeoutMs: 1_000
    await orch.start({ language: 'zh', mode: 'realtime' });
    a.flush = (): Promise<void> => new Promise<void>(() => { /* the L9 Soniox shape: never resolves */ });

    await clock.advance(30_000);                                // rollover parks in a flush that will never answer
    const stopped = orch.stop();
    await clock.advance(1_000);                                 // the rollover's cap fires → it bails, no closeEngine, no spawn
    expect(b.opens).toBe(0);                                    // 🔴 no new vendor connection was opened to be thrown away
    await clock.advance(1_000);                                 // the terminal flush's own cap — the one stop() always pays
    await stopped;

    expect(clock.now).toBe(32_000);                             // 30s boundary + 2 × 1s cap
    expect(b.opens).toBe(0);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.is_segment).toBe(false);
  });
});
