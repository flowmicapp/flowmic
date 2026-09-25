// Integration pin (integ/next-release merge of RC-relay-1 × RC-relay-2, 2026-09-24):
// a row cut that RC-1 DEFERRED because its leg was still opening must still take
// RC-5a's replay floor when it finally runs.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §1.4 (the pause cut inside a
//     redial's connect window), §3.1 (the lost 「是」: the onset hides in the withheld
//     tail of the closed run), §5 RC-1 and RC-5a
//   apps/server-core/src/stt/pause-cut-boundary.ts (the floor rule)
//   apps/server-core/src/stt/orchestrator-rollover.ts `startRollover` (the deferral)
//     and `takeFlushBoundary` (where the floor is read)
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// The two cards were written on sibling branches. RC-5a sets `cutFloorSeq` only for
// the duration of the `startRollover(true)` call a cut makes on the chunk path;
// RC-1 remembers a cut refused on an opening leg (`cutDeferred`) and runs it on the
// first chunk after the leg opens. Running that deferred cut through a bare
// `startRollover(true)` takes the boundary at the mark, so the new leg is handed
// none of the withheld tail and RC-5a is silently lost for exactly the recordings
// RC-1 exists for. The merge routes the deferred cut through `cutRow`, and when the
// chunk it runs on is FED (the voice came back) it reads the floor before that
// chunk ends the withheld run.
//
// The rig is RC-1's own (test/stt-redial-cut-collision.test.ts): a silence redial
// whose `open()` is held while ≥600 ms of closed gate decides a pause cut. Each
// chunk carries its seq in its first four bytes so a leg can say what it was handed.
//
// REVERSE CONTROLS (SAW RED 〔2026-09-24, lane-d, integ merge〕, logs under `.local/integ/`):
//   ① the deferred cut run through a bare `startRollover(true)` (no floor)
//      ⇒ case A red: the fresh leg got [62] and not 61 (`rc-deferred-bare-startRollover-red.log`);
//   ② the pre-`note` floor dropped (`deferredFloor` always null)
//      ⇒ case A red, same reading (`rc-deferred-no-prenote-floor-red.log`).
// Case B stayed green under both, and that is its point: while the gate is still
// closed the pause arm fires again by itself on the next chunk (`due` is still up),
// so that cut is a LIVE one and never needed the deferral. The deferral carries a cut
// only across a chunk on which no arm would fire again, i.e. the voice coming back (A).
// Each restored from a scratchpad copy, same command green again.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { PAUSE_CUT_REPLAY_MAX_MS } from '../src/stt/pause-cut-boundary';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';

class Leg extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'custom-openai-compatible';
  private _state: EngineState = 'closed';
  private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;
  readonly seqs: number[] = [];
  closed = false;
  constructor(readonly name: string, private readonly held: boolean) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> {
    if (this.held) await new Promise<void>((resolve, reject) => { this.pending = { resolve, reject }; });
    this._state = 'open';
  }
  finishOpen(): void { this.pending?.resolve(); this.pending = null; }
  push(chunk: Buffer): void {
    this.seqs.push(chunk.readUInt32LE(0));
    this.emit('interim', { kind: 'interim', text: `${this.name}${this.seqs.length}`, confidence: 0.5, language: 'zh' });
  }
  async flush(): Promise<void> {
    if (this._state !== 'open') return;
    this.emit('final', { kind: 'final', text: `${this.name}:${this.seqs.length}`, confidence: 0.9, language: 'zh', duration_ms: 0 });
  }
  async close(): Promise<void> {
    this.closed = true; this._state = 'closed';
    this.pending?.reject(new Error('closed while connecting')); this.pending = null;
  }
}

interface Rig {
  orch: SttEngineOrchestrator;
  legs: Leg[];
  rows: string[];
  errors: string[];
  nextSeq(): number;
  setVoiced(v: boolean): void;
  pump(n: number): Promise<void>;
}

async function rig(): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
  session.start();
  const legs: Leg[] = [];
  let voiced = true;
  let seqNo = 0;
  const orch = new SttEngineOrchestrator(session, () => {
    const leg = new Leg(`L${legs.length}`, legs.length === 2); // leg 2 = the redial's leg, held open
    legs.push(leg);
    return leg;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 5_000, softSegmentGraceMs: 600_000, engineSpawnTimeoutMs: 5_000,
    shouldFeedEngine: (): boolean => voiced, idleHangupMs: 3_000,
  });
  const r: Rig = {
    orch, legs, rows: [], errors: [],
    nextSeq: () => seqNo,
    setVoiced(v) { voiced = v; },
    async pump(n) {
      for (let i = 0; i < n; i++) {
        const payload = Buffer.alloc(CHUNK_BYTES, voiced ? 0x40 : 0);
        payload.writeUInt32LE(seqNo, 0);
        orch.pushChunk({ seq: seqNo++, ts_ms: clock.now, payload });
        await clock.advance(CHUNK_MS);
      }
    },
  };
  orch.on('error', (e: { code: string }) => r.errors.push(e.code));
  orch.on('engine-status', () => { /* listener mandatory */ });
  orch.on('interim', () => { /* listener mandatory */ });
  orch.on('final', (f: { text: string; is_segment: boolean }) => { if (f.is_segment) r.rows.push(f.text); });
  await orch.start({ language: 'zh', mode: 'realtime' });
  return r;
}

const TAIL_CHUNKS = PAUSE_CUT_REPLAY_MAX_MS / CHUNK_MS;

/** RC-1's sequence up to 「a pause cut was decided while the redial's leg is opening」, then the leg opens. */
async function deferredCutThenOpen(r: Rig): Promise<{ d: Leg; lastWithheld: number }> {
  await r.pump(30);                 // 6 s of speech; `due` at 5 s
  r.setVoiced(false);
  await r.pump(4);                  // ≥600 ms closed ⇒ cut #1 ⇒ leg 1 born
  await r.pump(17);                 // 3 s idle ⇒ hang-up; leg 1 closed
  expect(r.legs[1]!.closed, 'precondition: the silence hang-up happened').toBe(true);
  r.setVoiced(true);
  await r.pump(1);                  // voice ⇒ the redial dials D (held)
  const d = r.legs[2]!;
  expect(d.state, 'precondition: D is still connecting').toBe('closed');
  r.setVoiced(false);
  await r.pump(10);                 // the deadline passes, ≥600 ms closed ⇒ the pause cut is decided INSIDE D's window
  const lastWithheld = r.nextSeq() - 1;
  expect((r.orch as unknown as { cutDeferred: boolean }).cutDeferred, 'precondition: RC-1 deferred that cut').toBe(true);
  d.finishOpen();                   // D opens; the redial replays what it owes
  await drain();
  expect(d.state, 'precondition: D is open').toBe('open');
  return { d, lastWithheld };
}

describe('integration RC-1 × RC-5a — a deferred row cut still hands the next leg the withheld tail', () => {
  it('🔴 A: the voice comes back on the first chunk after the leg opens ⇒ the next leg is handed the onset before it', async () => {
    const r = await rig();
    const { lastWithheld } = await deferredCutThenOpen(r);
    const rowsBefore = r.rows.length;
    r.setVoiced(true);
    const resumed = r.nextSeq();
    await r.pump(1);                // FED chunk ⇒ the deferred cut runs here
    await drain();
    expect(r.rows.length, 'POSITIVE CONTROL: the deferred cut ran and ended the row').toBe(rowsBefore + 1);
    const next = r.legs[3];
    expect(next, 'POSITIVE CONTROL: the cut opened a fresh leg').toBeDefined();
    // The onset of the returning voice sits at the END of the closed run: the last withheld chunk.
    expect(next!.seqs, 'the fresh leg is handed the withheld chunk the onset hides in').toContain(lastWithheld);
    const tail = next!.seqs.filter((s) => s <= lastWithheld);
    expect(tail.length, 'and no more of the silence than RC-5a\'s cap').toBeLessThanOrEqual(TAIL_CHUNKS);
    expect(next!.seqs, 'and the chunk the voice came back on').toContain(resumed);
    expect(r.errors).toEqual([]);
  });

  it('B (control): the pause is still running when the leg opens ⇒ the pause arm re-fires on its own and takes the floor below the run\'s tail', async () => {
    const r = await rig();
    await deferredCutThenOpen(r);
    const rowsBefore = r.rows.length;
    const cutOn = r.nextSeq();
    await r.pump(1);                // still withheld ⇒ the pause arm fires again (a live cut, not only the deferred one)
    await drain();
    expect(r.rows.length, 'POSITIVE CONTROL: the deferred cut ran and ended the row').toBe(rowsBefore + 1);
    const next = r.legs[3];
    expect(next, 'POSITIVE CONTROL: the cut opened a fresh leg').toBeDefined();
    const want = Array.from({ length: TAIL_CHUNKS }, (_, i) => cutOn - TAIL_CHUNKS + 1 + i);
    expect(next!.seqs.slice(0, TAIL_CHUNKS), 'the fresh leg is handed the run\'s last ≤1 s first').toEqual(want);
    expect(r.errors).toEqual([]);
  });
});
