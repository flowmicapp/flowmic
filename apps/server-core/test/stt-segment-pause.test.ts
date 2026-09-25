// card CR-12-D — `stt:final.pause_before_ms`: the silence before a segment's
// first word, folded from the engine's own word timestamps.
//
// CONTRACT: docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (d), docs/rebuild/06 §2.
// The clock, and the four cases in which the answer is deliberately ABSENT
// rather than a number, are argued in `src/stt/segment-pause.ts`.
//
// TWO LAYERS, ON PURPOSE. The arithmetic is a pure class, so it is tested as
// one; the WIRING is then driven through the real orchestrator with a fake
// engine and a fake clock, because 「单测对接线零证明力」 — the account can be
// perfectly right while nobody feeds it the leg that ran before a seam.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { SegmentPauseAccount } from '../src/stt/segment-pause';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

describe('SegmentPauseAccount — the arithmetic', () => {
  it('one leg per segment: trailing silence of N plus leading silence of N+1', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 55_000, firstWordMs: 60, lastWordEndMs: 49_960 }); // 5,040 ms trailing
    expect(a.pauseBeforeMs()).toBeNull(); // segment 0 — nothing came before it
    a.beginSegment();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 20_000, firstWordMs: 300, lastWordEndMs: 19_000 });
    expect(a.pauseBeforeMs()).toBe(5_340); // 5,040 + 300
  });

  it('the replay tail is counted once, at the end of N, not twice', () => {
    // A rollover hands the NEXT leg the chunks that arrived during the flush.
    // They are inside leg N's fed bytes AND at the head of leg N+1, so the head
    // term subtracts them. Getting this wrong double-counts the flush round trip.
    const a = new SegmentPauseAccount();
    a.reset();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 55_000, firstWordMs: 60, lastWordEndMs: 49_960 });
    a.beginSegment();
    a.noteLegReplay(200);                                                    // 200 ms replayed
    a.noteLegFinal({ legFedMs: 20_000, firstWordMs: 200, lastWordEndMs: 19_000 }); // speech starts AT the seam
    expect(a.pauseBeforeMs()).toBe(5_040); // exactly the trailing silence, nothing added
  });

  it('a segment spanning two engine legs keeps the audio that ran before the seam', () => {
    // Leg rotation (cadence phase 2 / silence redial) banks text without minting
    // a row. If the second leg's clock were read as the segment's, everything
    // before the seam would vanish and the NEXT segment's pause would be wrong.
    const a = new SegmentPauseAccount();
    a.reset();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 30_000, firstWordMs: 0, lastWordEndMs: 29_000 });
    a.noteLegReplay(0);                                                       // same segment, new leg
    a.noteLegFinal({ legFedMs: 10_000, firstWordMs: 100, lastWordEndMs: 4_000 });
    a.beginSegment();
    // fedEnd = 30_000 + 10_000 = 40_000; last word = 30_000 + 4_000 = 34_000.
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 5_000, firstWordMs: 0, lastWordEndMs: 4_000 });
    expect(a.pauseBeforeMs()).toBe(6_000);
  });

  it('a first word inside the replayed tail clamps at 0 — the speaker never stopped', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 30_000, firstWordMs: 0, lastWordEndMs: 30_000 }); // 0 trailing
    a.beginSegment();
    a.noteLegReplay(1_000);
    a.noteLegFinal({ legFedMs: 20_000, firstWordMs: 0, lastWordEndMs: 19_000 }); // −1,000
    expect(a.pauseBeforeMs()).toBe(0);
  });

  it('🔴 no timestamps ⇒ null, NOT 0 — absence is its own answer', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 30_000, firstWordMs: null, lastWordEndMs: null });
    a.beginSegment();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 20_000, firstWordMs: null, lastWordEndMs: null });
    expect(a.pauseBeforeMs()).toBeNull();
  });

  it('🔴 a ladder reconnect poisons the segment — an unknowable mapping is refused', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 30_000, firstWordMs: 0, lastWordEndMs: 25_000 });
    a.beginSegment();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 5_000, firstWordMs: 100, lastWordEndMs: 4_000 });
    // POSITIVE CONTROL: with no reconnect this very shape produces a number.
    expect(a.pauseBeforeMs()).toBe(5_100);

    const b = new SegmentPauseAccount();
    b.reset();
    b.noteLegReplay(0);
    b.noteLegFinal({ legFedMs: 30_000, firstWordMs: 0, lastWordEndMs: 25_000 });
    b.beginSegment();
    b.noteLegReplay(null);                                                    // the reconnect
    b.noteLegFinal({ legFedMs: 5_000, firstWordMs: 100, lastWordEndMs: 4_000 });
    expect(b.pauseBeforeMs()).toBeNull();
  });

  it('a fresh recording claims nothing about what came before it', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 10_000, firstWordMs: 0, lastWordEndMs: 9_000 });
    expect(a.pauseBeforeMs()).toBeNull();
    a.reset();                                                                // a NEW recording
    a.noteLegReplay(0);
    a.noteLegFinal({ legFedMs: 10_000, firstWordMs: 500, lastWordEndMs: 9_000 });
    expect(a.pauseBeforeMs()).toBeNull();
  });
});

// ── THE WIRING ──────────────────────────────────────────────────────────────

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

/** A leg that reports word timestamps the way Soniox does — positions in the
 *  audio THIS leg was handed. `spans: null` is every other engine we ship. */
class TimedEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  constructor(
    public spans: { first: number; last: number } | null,
    public textOnFlush = '一段话。',
    public readonly id: SttEngineId = 'custom-openai-compatible',
  ) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { /* the byte path is the orchestrator's own bookkeeping */ }
  async flush(): Promise<void> { this.emitFinal(this.textOnFlush); }
  async close(): Promise<void> { this._state = 'closed'; }
  emitFinal(text: string): void {
    this.emit('final', {
      kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0,
      ...(this.spans ? { first_word_ms: this.spans.first, last_word_ms: this.spans.last } : {}),
    });
  }
}

interface FinalEvent { text: string; segment_idx: number; is_segment: boolean; duration_ms: number; pause_before_ms?: number }

const CHUNK_BYTES = 6_400; // 200 ms at 16 kHz mono s16le

function harness(engines: TimedEngine[]): {
  orch: SttEngineOrchestrator; clock: FakeClock; finals: FinalEvent[];
} {
  const clock = new FakeClock();
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: 600_000,
  });
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, softSegmentGraceMs: 15_000, engineFlushTimeoutMs: 1_000,
  });
  const finals: FinalEvent[] = [];
  orch.on('final', (p: FinalEvent) => finals.push(p));
  return { orch, clock, finals };
}

/** Hand the leg `count` chunks of audio without moving the clock — the cadence
 *  deadline is a wall-clock fact, the leg's audio position is a byte fact, and
 *  this card's whole point is that they are different questions. */
function feed(orch: SttEngineOrchestrator, clock: FakeClock, from: number, count: number): number {
  for (let k = 0; k < count; k++) orch.pushChunk({ seq: from + k, ts_ms: clock.now, payload: Buffer.alloc(CHUNK_BYTES) });
  return from + count;
}

describe('RC-4 SegmentPauseAccount.liveWordGap — the input of the third arm', () => {
  it('heard silence after the word plus what the gate withheld, and the vendor-certain part apart', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    // cold-open leg: word ends at 5,000 ms; 600 ms of room noise handed over, then
    // the gate withheld 800 ms (filed at leg position 5,600).
    a.noteChunk(false, 800, 5_600);
    expect(a.liveWordGap({ legFedMs: 6_200, lastWordEndMs: 5_000, vendorProcMs: 5_900 }))
      .toEqual({ ms: 1_200 + 800, certainMs: 900 + 800 });
  });

  it('a withheld run BEFORE the word is not part of the gap after it', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    a.noteChunk(false, 1_000, 2_000);
    expect(a.liveWordGap({ legFedMs: 6_000, lastWordEndMs: 5_000, vendorProcMs: 6_000 }))
      .toEqual({ ms: 1_000, certainMs: 1_000 });
  });

  it('the vendor cannot certify audio it was never handed (processed is capped at fed)', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    expect(a.liveWordGap({ legFedMs: 6_000, lastWordEndMs: 5_000, vendorProcMs: 9_000 })!.certainMs).toBe(1_000);
  });

  it('null — never 0 — when it would be a guess', () => {
    const a = new SegmentPauseAccount();
    a.reset();
    expect(a.liveWordGap(null)).toBeNull();                       // no live word (no timestamps / no word yet)
    a.noteLegReplay(null);                                          // a LADDER reconnect poisons the clock
    expect(a.liveWordGap({ legFedMs: 9_000, lastWordEndMs: 1_000, vendorProcMs: 9_000 })).toBeNull();
    const b = new SegmentPauseAccount();
    b.reset();
    b.noteLegFinal({ legFedMs: 4_000, firstWordMs: 0, lastWordEndMs: 3_000 }); // leg closed, next not yet open
    expect(b.liveWordGap({ legFedMs: 9_000, lastWordEndMs: 1_000, vendorProcMs: 9_000 })).toBeNull();
  });
});

describe('CR-12-D wiring — the number that reaches the wire', () => {
  it('🔴 「说 50 s · 停 5 s · 再说」 ⇒ the second segment reports the pause', async () => {
    // Leg 0 is handed 55,000 ms of audio (274 chunks + the boundary chunk, which
    // is fed synchronously after the rollover is kicked off) and the engine says
    // its last word ended at 49,960 ⇒ 5,040 ms of trailing silence. Leg 1 opens
    // on the replayed boundary chunk (200 ms) and its first word sits right at
    // the seam ⇒ nothing is added, and the reported pause IS the silence.
    const a = new TimedEngine({ first: 60, last: 49_960 });
    const b = new TimedEngine({ first: 200, last: 18_000 });
    const { orch, clock, finals } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });

    const next = feed(orch, clock, 0, 274);
    a.emitFinal('第一段。');          // the engine confirms a sentence…
    await clock.advance(30_000);      // …the cadence deadline passes…
    feed(orch, clock, next, 1);       // …and the next chunk delivers the boundary.
    await drain();

    feed(orch, clock, next + 1, 100);
    b.emitFinal('第二段。');
    await clock.advance(30_000);
    feed(orch, clock, next + 101, 1);
    await drain();
    await orch.stop();

    expect(finals.map((f) => f.is_segment)).toEqual([true, true, false]);
    // POSITIVE CONTROL: segment 0 has no predecessor, so the field is ABSENT —
    // if this key were present here, the number below would be meaningless.
    expect('pause_before_ms' in finals[0]!).toBe(false);
    expect(finals[1]!.pause_before_ms).toBe(5_040);
  });

  it('🔴 an engine that reports no word timestamps leaves the field ABSENT', async () => {
    const a = new TimedEngine(null, '第一段。');
    const b = new TimedEngine(null, '第二段。');
    const { orch, clock, finals } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });

    const next = feed(orch, clock, 0, 274);
    a.emitFinal('第一段。');
    await clock.advance(30_000);
    feed(orch, clock, next, 1);
    await drain();
    feed(orch, clock, next + 1, 100);
    b.emitFinal('第二段。');
    await clock.advance(30_000);
    feed(orch, clock, next + 101, 1);
    await drain();
    await orch.stop();

    // POSITIVE CONTROL: the same flow DID produce the segments, so a missing
    // key here is the rule working rather than the probe looking at nothing.
    expect(finals.map((f) => f.is_segment)).toEqual([true, true, false]);
    for (const f of finals) expect(f.text.length).toBeGreaterThan(0);
    for (const f of finals) expect('pause_before_ms' in f).toBe(false);
  });

  it('a leg rotation inside a segment does not erase the audio before the seam', async () => {
    // Deadline + grace with no defensible boundary ⇒ the leg rotates and mints
    // nothing (SEG-4). Segment 0 therefore spans two legs; its trailing silence
    // has to be measured across both.
    const a = new TimedEngine({ first: 0, last: 30_000 }, 'no terminator here');
    const b = new TimedEngine({ first: 0, last: 5_000 }, 'still going');
    const c = new TimedEngine({ first: 0, last: 9_000 }, '第二段。');
    const { orch, clock, finals } = harness([a, b, c]);
    await orch.start({ language: 'zh', mode: 'realtime' });

    let next = feed(orch, clock, 0, 150);      // 30,000 ms into leg 0
    await clock.advance(45_000);               // deadline + grace ⇒ leg rotation, no row
    next = feed(orch, clock, next, 50);        // 10,000 ms into leg 1
    b.emitFinal('第一段。');
    await clock.advance(30_000);
    next = feed(orch, clock, next, 1);         // boundary ⇒ segment 0 closes
    await drain();

    next = feed(orch, clock, next, 50);
    c.emitFinal('第二段。');
    await clock.advance(30_000);
    feed(orch, clock, next, 1);
    await drain();
    await orch.stop();

    // Segment 0 fed 30,000 (leg 0) + 10,200 (leg 1, incl. the boundary chunk)
    // = 40,200 ms of audio; its last word ended at 30,000 + 5,000 = 35,000 ⇒
    // 5,200 ms trailing. Leg 2 opens on the 200 ms replay and speaks at 0 ⇒
    // −200. 5,000 exactly, reported on the vendor's 60 ms grid.
    expect(finals[1]!.pause_before_ms).toBe(4_980);
  });
});
