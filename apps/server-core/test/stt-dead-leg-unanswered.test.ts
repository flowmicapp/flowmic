// card RC-L (relay half) — audio a leg was HANDED and never ANSWERED is kept and replayed to the next leg,
// whether the leg died live (the ladder took over) or died inside its retiring flush. Plus MAIN ruling 6:
// a long recording holds unanswered audio for 180 s.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §1.2 (S4: `needed_from_seq 455`, the dead leg's last
//     1–2 s heard and never answered — 「都记下」), §4.1 (S5: the retiring leg died in its flush, the whole
//     11th sentence below the boundary), §8 RC-L, §11-6 (180 s)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 item 3 (RC-L block)
//   apps/server-core/src/stt/replay-debt.ts `answeredFloorSeq` / `unfedGraceMsFor`
//   apps/server-core/src/stt/leg-facts.ts `answeredThroughSeq`
//
// Drives the REAL orchestrator + AudioSession + ring + ladder. The fake leg is Soniox-shaped where it
// matters: it reports a processed position (`ackedAudioMs`, and `audio_proc_ms` / `hypothesis_last_word_ms`
// on every interim) that trails what it was handed by a fixed lag, and a close during its flush resolves
// the flush with NO final (Soniox's `intentionalClose`: no error either). The seq rides in each payload.
//
// REVERSE CONTROL (see the card report): `spendUnansweredFloor` made a no-op ⇒ the live-death and
// flush-death rows red at the pre-RC-L first seq (the ring's window head / the boundary + 1).

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { unexpectedCloseError } from '../src/stt/engines/base';
import { STT_CUT_EVENT } from '../src/stt/cut-log';
import { STT_REPLAY_SHORT_EVENT } from '../src/stt/orchestrator-replay';
import { CONTINUOUS_RING_MAX_BYTES, CONTINUOUS_UNFED_GRACE_MS, unfedGraceMsFor } from '../src/stt/replay-debt';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0 } from './fixtures/stt-outage-harness';

type FlushEnd = 'answer' | 'die';

class AckLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  readonly seqs: number[] = [];
  private fedMs = 0;
  constructor(private readonly clock: FakeClock, private readonly lagMs: number, private readonly flushEnd: FlushEnd, private readonly refuse: boolean) { super(); }
  get state(): EngineState { return this._state; }
  /** Processed = handed − lag (never below 0): the vendor's position, in this leg's own clock. */
  get ackedAudioMs(): number { return Math.max(0, this.fedMs - this.lagMs); }
  async open(): Promise<void> { if (this.refuse) throw new Error('connect refused'); this._state = 'open'; }
  push(chunk: Buffer): void {
    this.seqs.push(chunk.readUInt32LE(0));
    this.fedMs += CHUNK_MS;
    const acked = this.ackedAudioMs;
    this.emit('interim', { kind: 'interim', text: `h${this.seqs.length}`, confidence: 1, language: 'zh', audio_proc_ms: acked, hypothesis_last_word_ms: acked });
  }
  flush(): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(() => {
        if (this.flushEnd === 'answer') this.emit('final', { kind: 'final', text: `f${this.seqs.length}`, confidence: 1, language: 'zh', duration_ms: 0, audio_proc_floor_ms: this.fedMs });
        else this._state = 'failed'; // the socket closed mid-flush: no final, no error (Soniox `intentionalClose`)
        resolve();
      }, 300);
    });
  }
  async close(): Promise<void> { this._state = 'closed'; }
  drop(): void { this._state = 'failed'; this.emit('error', unexpectedCloseError('ack-leg')); }
}

interface Rig {
  orch: SttEngineOrchestrator;
  legs: AckLeg[];
  clock: FakeClock;
  readies: Record<string, unknown>[];
  cuts: Record<string, unknown>[];
  shorts: Record<string, unknown>[];
  push(seq: number): Promise<void>;
}

async function rig(opts: {
  lagMs: number; flushEnd?: FlushEnd; openAtMs?: number; continuous?: boolean; unbounded?: boolean;
  softSegmentMs?: number; softSegmentGraceMs?: number;
}): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
  session.start();
  const legs: AckLeg[] = [];
  const orch = new SttEngineOrchestrator(session, () => {
    const refuse = legs.length > 0 && opts.openAtMs !== undefined && clock.now < T0 + opts.openAtMs;
    const l = new AckLeg(clock, opts.lagMs, opts.flushEnd ?? 'answer', refuse); legs.push(l); return l;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: opts.softSegmentMs ?? 3_600_000, softSegmentGraceMs: opts.softSegmentGraceMs ?? 3_600_000,
    engineFlushTimeoutMs: 30_000,
    ...(opts.unbounded === true ? { reconnectUnbounded: true } : {}),
    ...(opts.continuous === true ? { continuous: true, reconnectUnbounded: true } : {}),
  });
  const readies: Record<string, unknown>[] = []; const cuts: Record<string, unknown>[] = []; const shorts: Record<string, unknown>[] = [];
  vi.spyOn(log, 'info').mockImplementation((msg: string, f?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(f ?? {}); });
  vi.spyOn(log, 'warn').mockImplementation((msg: string, f?: Record<string, unknown>) => { if (msg === STT_REPLAY_SHORT_EVENT) shorts.push(f ?? {}); });
  orch.on('engine-status', (p: Record<string, unknown>) => { if (p.status === 'ready') readies.push(p); });
  for (const e of ['final', 'error', 'interim', 'error-suppressed']) orch.on(e, () => { /* listeners mandatory */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  return {
    orch, legs, clock, readies, cuts, shorts,
    async push(seq: number): Promise<void> {
      const payload = Buffer.alloc(CHUNK_BYTES, 0x40); payload.writeUInt32LE(seq, 0);
      orch.pushChunk({ seq, ts_ms: clock.now, payload });
      await clock.advance(CHUNK_MS);
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('RC-L — a leg that dies LIVE: what it was handed and never answered goes to the next leg', () => {
  it('🔴 lag 2 s, dropped at 10 s, back after a 7 s outage ⇒ the next leg starts at the dead leg’s answered point + 1', async () => {
    const r = await rig({ lagMs: 2_000, openAtMs: 16_000 }); // PTT ladder: rungs at +1 / +3 / +7 s; the third opens
    for (let seq = 0; seq < 50; seq++) await r.push(seq);
    // Positive control on the premise: the dead leg answered through seq 39 (8,000 ms of its 10,000), not 49.
    expect(r.legs[0]!.ackedAudioMs).toBe(8_000);
    r.legs[0]!.drop();
    for (let seq = 50; seq < 100; seq++) await r.push(seq);
    const back = r.legs[r.legs.length - 1]!;
    expect(back.state, 'precondition: a rung opened').toBe('open');
    expect(r.readies.length).toBe(2); // the cold open, then the rung
    expect(back.seqs[0], 'replay starts at the first chunk the dead leg never answered').toBe(40);
    // Every chunk from there to the live edge reached the new leg, in order, once.
    expect(back.seqs.slice(0, 60)).toEqual(Array.from({ length: 60 }, (_, i) => 40 + i));
    expect(r.readies[1]!.replayed_ms as number).toBeGreaterThanOrEqual((85 - 40) * CHUNK_MS);
    expect(r.shorts).toEqual([]);
    await r.orch.close();
  });

  it('control: a leg that answered everything it was handed (lag 0) keeps today’s replay (from the mark + 1)', async () => {
    // The same run with the lag set to 0: everything handed was answered, so nothing below the mark is owed.
    const r = await rig({ lagMs: 0, openAtMs: 16_000 });
    for (let seq = 0; seq < 50; seq++) await r.push(seq);
    r.legs[0]!.drop();
    for (let seq = 50; seq < 100; seq++) await r.push(seq);
    const back = r.legs[r.legs.length - 1]!;
    expect(back.seqs[0], 'nothing unanswered ⇒ replay from the mark + 1, as before').toBe(50);
    await r.orch.close();
  });
});

describe('RC-L — a retiring leg that dies INSIDE its flush', () => {
  it('🔴 rotation at 3 s, lag 2 s, the flush ends with no final ⇒ the next leg is replayed from the answered point, below the boundary', async () => {
    const r = await rig({ lagMs: 2_000, flushEnd: 'die', softSegmentMs: 2_000, softSegmentGraceMs: 1_000 });
    for (let seq = 0; seq < 40; seq++) await r.push(seq);
    const cut = r.cuts[0]!;
    expect(cut.kind).toBe('segment');
    const boundary = cut.boundary_seq as number;
    const next = r.legs[1]!;
    // The leg rotated at 3 s had been handed 15 chunks before its end-of-stream and 2 more during the 300 ms
    // flush (F-2152): 3,400 ms, of which it answered 1,400 ms = 7 chunks (seqs 0..6) when the socket closed.
    expect(boundary).toBe(14);
    expect(next.seqs[0], 'the retiring leg’s unanswered audio is replayed').toBe(7);
    expect(next.seqs.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => 7 + i));
    await r.orch.close();
  });

  it('positive control: the same flush ANSWERED (end-of-stream final) ⇒ replay from the boundary + 1, nothing re-fed', async () => {
    const r = await rig({ lagMs: 2_000, flushEnd: 'answer', softSegmentMs: 2_000, softSegmentGraceMs: 1_000 });
    for (let seq = 0; seq < 40; seq++) await r.push(seq);
    const boundary = r.cuts[0]!.boundary_seq as number;
    expect(r.legs[1]!.seqs[0]).toBe(boundary + 1);
    await r.orch.close();
  });
});

describe('RC-L × MAIN ruling 6 — a long recording holds unanswered audio for 180 s', () => {
  it('the one number, and what it costs (pinned)', () => {
    expect(CONTINUOUS_UNFED_GRACE_MS).toBe(180_000);
    expect(CONTINUOUS_RING_MAX_BYTES).toBe(5_920_000); // (5 s window + 180 s) × 32 B/ms ≈ 5.9 MB per session
    expect(unfedGraceMsFor(true, 22_000)).toBe(180_000);
    expect(unfedGraceMsFor(false, 22_000), 'push-to-talk keeps the ladder’s own worst case').toBe(22_000);
  });

  it('🔴 continuous: a 151 s engine outage is replayed in full from the dead leg’s answered point', async () => {
    const r = await rig({ lagMs: 1_000, continuous: true, openAtMs: 160_000 }); // unbounded rungs at +1,3,7,15,31,61,91,121,151 s
    for (let seq = 0; seq < 50; seq++) await r.push(seq);
    r.legs[0]!.drop();
    for (let seq = 50; seq < 50 + 5 * 160; seq++) await r.push(seq);
    const back = r.legs[r.legs.length - 1]!;
    expect(back.state).toBe('open');
    expect(back.seqs[0], 'the dead leg answered 9,000 ms = seqs 0..44').toBe(45);
    expect(r.readies[1]!.replayed_ms as number).toBeGreaterThanOrEqual(151_000);
    expect(r.shorts).toEqual([]);
    await r.orch.close();
  });

  it('control: the same outage WITHOUT `continuous` (unbounded ladder only) ⇒ only the ladder’s 22 s grace, the head is gone and said so', async () => {
    const r = await rig({ lagMs: 1_000, unbounded: true, openAtMs: 160_000 });
    for (let seq = 0; seq < 50; seq++) await r.push(seq);
    r.legs[0]!.drop();
    for (let seq = 50; seq < 50 + 5 * 160; seq++) await r.push(seq);
    const back = r.legs[r.legs.length - 1]!;
    expect(back.seqs[0]).toBeGreaterThan(45 + 5 * 100);
    expect(r.shorts.length).toBe(1);
  });

  it('continuous: past 180 s the grace ends — a 211 s outage loses its head, and says so', async () => {
    const r = await rig({ lagMs: 1_000, continuous: true, openAtMs: 200_000 }); // the rung at +211 s opens
    for (let seq = 0; seq < 50; seq++) await r.push(seq);
    r.legs[0]!.drop();
    for (let seq = 50; seq < 50 + 5 * 215; seq++) await r.push(seq);
    const back = r.legs[r.legs.length - 1]!;
    expect(back.state).toBe('open');
    expect(back.seqs[0]).toBeGreaterThan(45);
    expect(r.shorts.length).toBe(1);
    await r.orch.close();
  });
});
