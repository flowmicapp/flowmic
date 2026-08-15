// Card N1-B1 — 「segment final and terminal-segment final exits both carry every field settlement needs」.
//
// CONTRACT: docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-c
// (one segment (segment_idx) = one row; EVERY final mints a row and enqueues a delivery
// item — not just the terminal one) and §2.0-b. Design:
// docs/strategy/2026-08-08-design-n1-long-recording.md §2.1 / §2.3.
//
// While only the TERMINAL final settled, the segment exit was never required to
// be complete — nothing downstream read it except the display assembler. Under
// §2.0-c both exits settle, so both must answer the same questions with the same
// fields. The one that did not was `duration_ms`: the segment exit measured the
// SEGMENT and the terminal exit measured the SESSION.
//
// These tests drive the REAL orchestrator with a fake engine and a fake clock.
// Every assertion is on emitted payloads, never on internals — an assertion on a
// private field would still pass if no consumer could ever see the value.

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

/** Batch-style engine id — deliberately not one of the streaming ids, which
 *  carry a 5 s flush floor that would move the clock these tests measure. */
class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  opens = 0;
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this.opens++; this._state = 'open'; }
  push(): void { /* the byte path is not what these tests measure */ }
  async flush(): Promise<void> { this.emitFinal(this.textOnFlush); }
  async close(): Promise<void> { this._state = 'closed'; }
  textOnFlush = 'text';
  emitFinal(text: string): void { this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0 }); }
}

interface FinalEvent { text: string; confidence: number; language: string; segment_idx: number; is_segment: boolean; duration_ms: number }
interface AutoStopEvent { reason: string; limit_origin: string }

function harness(engines: FakeEngine[], sessionOpts: { hardLimitMs?: number; clampMs?: number } = {}): {
  orch: SttEngineOrchestrator; clock: FakeClock; session: AudioSession; finals: FinalEvent[]; autoStops: AutoStopEvent[];
} {
  const clock = new FakeClock();
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: sessionOpts.hardLimitMs ?? 300_000,
  });
  // The production order: stt-factory clamps to the remaining quota BEFORE
  // start() (clampHardLimitMs is only legal from `idle`).
  if (sessionOpts.clampMs !== undefined) session.clampHardLimitMs(sessionOpts.clampMs);
  session.start();
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, engineFlushTimeoutMs: 1_000,
    // card SEG-4 — rows are minted only at boundaries now, so the flows below
    // deliver by confirming a sentence and pushing one chunk (the cut lives on
    // the chunk path), inside the 15 s seek window past each 30 s deadline.
    // ⚠️ NOT zero grace: at grace 0 the leg rotates the same instant `due`
    // rises, and the rotation's seam repair eats the very terminator the flow
    // was about to deliver on — the first draft of this harness proved it.
    // These rows are about settlement fields, not about WHERE a sentence ends —
    // that policy has its own file (stt-segment-boundary.test.ts).
    softSegmentGraceMs: 15_000,
  });
  const finals: FinalEvent[] = [];
  const autoStops: AutoStopEvent[] = [];
  orch.on('final', (p: FinalEvent) => finals.push(p));
  orch.on('auto-stopped', (p: AutoStopEvent) => autoStops.push(p));
  return { orch, clock, session, finals, autoStops };
}

/** card SEG-4: deliveries happen on the CHUNK path, so settlement flows push
 *  one chunk to turn a confirmed boundary into a row. */
function boundaryChunk(orch: SttEngineOrchestrator, clock: FakeClock, seq: number): void {
  orch.pushChunk({ seq, ts_ms: clock.now, payload: Buffer.alloc(6_400) });
}

/** The settlement-relevant key set. Written out rather than derived from one of
 *  the two exits, so that adding a field to ONE exit fails here instead of
 *  quietly making the two exits agree with each other about being incomplete. */
const SETTLEMENT_KEYS = ['confidence', 'duration_ms', 'is_segment', 'language', 'segment_idx', 'text'];

describe('N1-B1: both final exits are field-complete for settlement', () => {
  it('🔴 every final of a multi-rollover session carries the SAME settlement fields', async () => {
    // 3 segments: two soft-segment rollovers, then a release.
    const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines);
    await orch.start({ language: 'zh', mode: 'realtime' });

    engines[0]!.textOnFlush = '第一段。';
    engines[0]!.emitFinal('第一段。');       // the engine confirms a sentence…
    await clock.advance(30_000);             // …the cadence deadline passes…
    boundaryChunk(orch, clock, 0);           // …and the next chunk delivers.
    await drain();
    engines[1]!.textOnFlush = '第二段。';
    engines[1]!.emitFinal('第二段。');
    await clock.advance(30_000);
    boundaryChunk(orch, clock, 1);
    await drain();
    engines[2]!.textOnFlush = '第三段';
    await orch.stop();

    expect(finals).toHaveLength(3);
    expect(finals.map((f) => f.is_segment)).toEqual([true, true, false]);
    for (const f of finals) {
      expect(Object.keys(f).sort()).toEqual(SETTLEMENT_KEYS);
      // Non-null is not enough: a settlement row needs values it can print.
      expect(typeof f.text).toBe('string');
      expect(f.language).toBe('zh');
      expect(Number.isInteger(f.segment_idx)).toBe(true);
      expect(Number.isFinite(f.duration_ms)).toBe(true);
      expect(f.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('🔴 `duration_ms` answers ONE question on both exits: how long is THIS segment', async () => {
    // The exact defect §2.0-c exposes. Old code: 30_000 / 30_000 / 60_000 —
    // the last row claiming the whole session, so the desktop stats tile (which
    // sums rows) reports 120 s for a 60 s recording.
    const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines);
    await orch.start({ language: 'zh', mode: 'realtime' });

    engines[0]!.emitFinal('第一段。');
    await clock.advance(30_000);
    boundaryChunk(orch, clock, 0);               // boundary 1 → segment final idx 0, t=30_000
    await drain();
    engines[1]!.emitFinal('第二段。');
    await clock.advance(30_000);
    boundaryChunk(orch, clock, 1);               // boundary 2 → segment final idx 1, t=60_000
    await drain();
    await orch.stop();                           // terminal final idx 2, at t=60_000

    expect(finals.map((f) => f.duration_ms)).toEqual([30_000, 30_000, 0]);
    // Stated as the property, not as three numbers: the rows partition the
    // recording instead of overlapping it.
    const total = finals.reduce((sum, f) => sum + f.duration_ms, 0);
    expect(total).toBe(clock.now);
  });

  it('🔴 a release landing inside a LEG rotation loses no text and skips no index', async () => {
    // The FB-6 shape (stt-terminal-rollover-collision.test.ts case 2), remade by
    // card SEG-4: the release lands while the rotation sits inside
    // engine.close(). Under the old model that rotation had already DELIVERED a
    // row and spent idx 0, so the terminal came out EMPTY under idx 1. A
    // rotation delivers nothing now — so the same collision must hand the
    // banked text to the terminal final, under the index the rotation never
    // spent, with the duration measured from the segment's real start. The
    // empty-terminal variant still exists and still settles (a row with no
    // words is how a silent release looks); it just needs an emptier flow than
    // this one to produce it.
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, finals } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    let releaseClose!: () => void;
    const closing = new Promise<void>((r) => { releaseClose = r; });
    a.close = async (): Promise<void> => { await closing; };

    await clock.advance(45_000);   // deadline + grace ⇒ the leg rotates, banking 'text'
    const stopped = orch.stop();
    releaseClose();
    await drain();
    await stopped;
    await drain();

    const terminal = finals.find((f) => !f.is_segment)!;
    expect(terminal).toBeDefined();
    expect(terminal.text).toBe('text');           // the bank came out — no silent loss
    expect(terminal.segment_idx).toBe(0);         // the rotation spent nothing
    expect(finals).toHaveLength(1);               // and minted nothing of its own
    expect(Object.keys(terminal).sort()).toEqual(SETTLEMENT_KEYS);
    // The segment began at t=0 and never ended until the stop.
    expect(terminal.duration_ms).toBe(45_000);
  });

  it('🔴 one final per segment_idx still holds ACROSS rollovers — the settlement idempotency key', async () => {
    // §2.0-c adopts `(session, segment_idx)` as the settlement key, inheriting
    // W2.5-B. A duplicate index is no longer only a display REPLACE: it is a
    // second row and a second delivery item for one span.
    const engines = [new FakeEngine(), new FakeEngine(), new FakeEngine(), new FakeEngine()];
    const { orch, clock, finals } = harness(engines);
    await orch.start({ language: 'zh', mode: 'realtime' });
    for (let k = 0; k < 3; k++) {
      engines[k]!.emitFinal(`第${k}句。`);
      await clock.advance(30_000);
      boundaryChunk(orch, clock, k);
      await drain();
    }
    await orch.stop();

    const idxs = finals.map((f) => f.segment_idx);
    expect(idxs).toEqual([0, 1, 2, 3]);           // consecutive, so nothing was skipped either
    expect(new Set(idxs).size).toBe(idxs.length); // and nothing was reused
  });
});

describe('N1-B1: the narrowed meaning of an auto-stop', () => {
  it('🔴 card N1-B4: the ENGINE-session ceiling now ROLLS OVER instead of stopping', async () => {
    // ⚠️ N1-B1 left this test asserting 「it still stops」 with the note 「N1-B4 is
    // what makes this origin roll over instead」. This is that card. The origin
    // assertions are UNCHANGED — they are what the branch reads — and only the
    // outcome moved.
    const engines = [new FakeEngine(), new FakeEngine()];
    const { orch, clock, session, autoStops, finals } = harness(engines, { hardLimitMs: 300_000 });
    await orch.start({ language: 'zh', mode: 'realtime' });
    await clock.advance(300_000);
    await drain();

    expect(session.limitOrigin).toBe('engine_session');
    expect(autoStops).toHaveLength(0);        // nothing told the user to stop
    expect(session.state).toBe('recording');  // the FSM the phone mirrors never moved
    expect(finals.every((f) => f.is_segment)).toBe(true);
  });

  it('🔴 a ceiling that came from the user\'s remaining quota is a DIFFERENT fact', async () => {
    // stt-factory clamps the session to `quota.remainingSttMs`. This one must
    // still stop after N1-B4: rolling it over would bill a user past their
    // budget with nothing reporting it.
    const eng = new FakeEngine();
    const { orch, clock, session, autoStops } = harness([eng], { hardLimitMs: 300_000, clampMs: 120_000 });
    await orch.start({ language: 'zh', mode: 'realtime' });
    await clock.advance(120_000);
    await orch.waitForTerminal();
    await drain();

    expect(autoStops).toHaveLength(1);
    expect(autoStops[0]!.limit_origin).toBe('quota_budget');
    expect(session.limitOrigin).toBe('quota_budget');
  });

  it('a clamp that does NOT tighten leaves the origin alone (positive control)', async () => {
    // `clampHardLimitMs` ignores a value that is not smaller — Pro/standalone
    // pass Infinity. If the origin were stamped on the CALL rather than on the
    // assignment, every session would report `quota_budget`.
    const eng = new FakeEngine();
    const { session } = harness([eng], { hardLimitMs: 300_000, clampMs: Number.POSITIVE_INFINITY });
    expect(session.limitOrigin).toBe('engine_session');
    void eng;
  });

  it('🔴 releasing the button is NOT an auto-stop — the event stays reserved', async () => {
    // The narrowing's negative half, with its positive control beside it: the
    // ordinary ending emits no `auto-stopped` at all, while still producing the
    // terminal final (so a green here cannot mean 「nothing happened」).
    const a = new FakeEngine(); const b = new FakeEngine();
    const { orch, clock, finals, autoStops } = harness([a, b]);
    await orch.start({ language: 'zh', mode: 'realtime' });
    await clock.advance(30_000);   // a rollover is not an auto-stop either
    await orch.stop();

    expect(autoStops).toHaveLength(0);
    expect(finals.filter((f) => !f.is_segment)).toHaveLength(1);
  });
});
