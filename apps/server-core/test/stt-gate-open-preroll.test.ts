// card RC-T — when the VAD gate goes from closed to open, the leg is handed the closed run's last ≤400 ms
// before the chunk that opened it: the onset of the first word after a pause can sit in the last chunk the
// gate still called silence.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §6.1 (「琥珀一号」→「破1号」; the offline probe that cut
//     the onset by 100 ms and reproduced it character for character), §8 RC-T
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-T block)
//   apps/server-core/src/stt/gate-preroll.ts (the rule, by where the audio would go)
//
// Drives the REAL orchestrator + AudioSession + ring. The gate is the orchestrator's own `shouldFeedEngine`
// seam, scripted per seq; the fake leg records every seq it is handed (the seq rides in the payload) and
// reports no processed position, so an accepted chunk is billed when it is handed over (heard-audio.ts).
//
// REVERSE CONTROL (see the card report): the `gateOpenPreroll` call removed from `pushChunk` ⇒ the onset
// chunks are absent from the leg (the rows below red on the expected seq lists).

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0 } from './fixtures/stt-outage-harness';

class SeqLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  readonly seqs: number[] = [];
  constructor(private readonly clock: FakeClock, private readonly openMs: number) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> {
    if (this.openMs > 0) await new Promise<void>((r) => { this.clock.setTimeout(r, this.openMs); });
    this._state = 'open';
  }
  push(chunk: Buffer): void { this.seqs.push(chunk.readUInt32LE(0)); }
  async flush(): Promise<void> { this.emit('final', { kind: 'final', text: this.seqs.length > 0 ? `x${this.seqs.length}` : '', confidence: 1, language: 'zh', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

interface Run { legs: SeqLeg[]; billedMs: number; accepted: number }

/** [voiced] says, per seq, whether the gate accepts it. [legOpenMs] is how long each leg after the first takes to open. */
async function run(total: number, voiced: (seq: number) => boolean, o: { softSegmentMs?: number; legOpenMs?: number } = {}): Promise<Run> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
  session.start();
  const legs: SeqLeg[] = [];
  const orch = new SttEngineOrchestrator(session, () => { const l = new SeqLeg(clock, legs.length === 0 ? 0 : o.legOpenMs ?? 0); legs.push(l); return l; }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: o.softSegmentMs ?? 600_000, softSegmentGraceMs: 600_000,
    shouldFeedEngine: (c) => voiced(c.seq),
  });
  for (const e of ['final', 'error', 'engine-status', 'interim', 'error-suppressed']) orch.on(e, () => { /* listeners mandatory */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  let accepted = 0;
  for (let seq = 0; seq < total; seq++) {
    const payload = Buffer.alloc(CHUNK_BYTES, 0x40); payload.writeUInt32LE(seq, 0);
    if (voiced(seq)) accepted += 1;
    orch.pushChunk({ seq, ts_ms: clock.now, payload });
    await clock.advance(CHUNK_MS);
  }
  const billedMs = orch.uniqueFedAudioMs;
  await orch.close();
  return { legs, billedMs, accepted };
}

const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);

describe('RC-T — the gate-open pre-roll', () => {
  it('🔴 a leg already open: a 1 s pause, then speech ⇒ the pause’s last 400 ms reach the leg, right before the chunk that opened the gate', async () => {
    const r = await run(25, (s) => s < 10 || s >= 15);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]!.seqs).toEqual([...range(0, 10), 13, 14, ...range(15, 25)]);
    // Not billed: the gate refused 13 and 14 (book 22 §4.9 RC-Q).
    expect(r.billedMs).toBe(r.accepted * CHUNK_MS);
  });

  it('🔴 the device’s path — a pause row cut, the new leg already open, the gate opening a chunk late ⇒ that leg hears the onset', async () => {
    // due at 1 s; the pause arm cuts ~600 ms into the quiet (RC-5a hands the new leg the run's tail so far);
    // the quiet goes on 2.4 s more, and speech resumes at seq 25.
    const r = await run(35, (s) => s < 10 || s >= 25, { softSegmentMs: 1_000 });
    expect(r.legs.length, 'precondition: the pause cut rotated the leg (a second 1 s deadline can cut again in the quiet)').toBeGreaterThanOrEqual(2);
    const next = r.legs.find((l) => l.seqs.includes(25))!.seqs;
    expect(r.legs.indexOf(r.legs.find((l) => l.seqs.includes(25))!), 'the word lands on a leg born after the cut').toBeGreaterThan(0);
    const at = next.indexOf(25);
    expect(next.slice(at - 2, at + 1), 'the last 400 ms of the pause, then the word').toEqual([23, 24, 25]);
    expect(new Set(next).size, 'no chunk handed to this leg twice').toBe(next.length);
    expect(r.billedMs).toBe(r.accepted * CHUNK_MS);
  });

  it('🔴 the new leg still OPENING when the gate opens ⇒ its replay starts below the closed run’s tail (RC-E’s rule)', async () => {
    // The cut at ~12 dials a leg that takes 1 s to open; speech resumes at 15, while it is still opening.
    const r = await run(30, (s) => s < 10 || s >= 15, { softSegmentMs: 1_000, legOpenMs: 1_000 });
    expect(r.legs.length).toBe(2);
    const next = r.legs[1]!.seqs;
    const at = next.indexOf(15);
    expect(next.slice(at - 2, at + 1)).toEqual([13, 14, 15]);
    expect(new Set(next).size).toBe(next.length);
  });

  it('control: the gate never closes ⇒ nothing is pre-rolled, every chunk once, in order', async () => {
    const r = await run(25, () => true);
    expect(r.legs[0]!.seqs).toEqual(range(0, 25));
    expect(r.billedMs).toBe(25 * CHUNK_MS);
  });

  it('🔴 a one-chunk dip of the gate ⇒ the chunk it withheld is handed over too (it was lost before RC-T)', async () => {
    const r = await run(20, (s) => s !== 10);
    expect(r.legs[0]!.seqs).toEqual(range(0, 20));
  });
});
