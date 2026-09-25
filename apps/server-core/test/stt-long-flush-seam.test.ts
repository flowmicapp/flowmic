// card RC-A — a retiring flush whose round trip outlasts the 5 s replay window
// must not lose the audio the old leg was handed during that round trip.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §4.2 (defect A: the
//     mechanism and the scratch reading 0 / 0 / 14 / 34 chunks lost at
//     0.6 / 4 / 8 / 12 s), §7 RC-A
//   apps/server-core/src/stt/orchestrator-rollover.ts `takeFlushBoundary` /
//     `rewindToFlushBoundary` (F-2152: the old leg keeps taking audio during the
//     flush; the next leg is replayed from the boundary)
//   apps/server-core/src/stt/audio/ring-buffer.ts `prune` (fed chunks keep only
//     the window — during the flush every chunk is 「fed」)
//
// Drives the REAL orchestrator + AudioSession + ring. The fake leg records every
// chunk it is handed (the seq rides in the first four payload bytes) and answers
// its flush after a scripted round trip. Three retirements are driven, each at
// five round trips: a leg ROTATION (cadence phase 2), a PAUSE row cut (RC-5a
// moves its boundary below the closed run's tail), and a SILENCE HANG-UP (the
// redial replays what the old leg heard during the flush). Voice runs through
// every flush, as it did on the device (RO / R100 / R8b).
//
// THE CLAIMS, per case:
//   ① the next leg's first chunk is the boundary + 1, where the boundary is the
//     one the relay itself logged on the `stt.cut` line (RC-5a floor included);
//   ② every chunk the gate accepted up to the end of the run was handed to some
//     leg at least once (the pause case's withheld tail is not voice and is not
//     claimed);
//   ③ no `stt.replay_short` WARN (that line is the relay saying ② broke).
// POSITIVE CONTROL: 0.6 s and 4 s were green before RC-A (the round trip fits the
// window).
// REVERSE CONTROL: see the report for this card; the retiring floor dropped from
// the retention pin must red the 8 s rotation case with the scratch reading
// (`expected 29 to be less than or equal to 15`).

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { STT_CUT_EVENT } from '../src/stt/cut-log';
import { STT_REPLAY_SHORT_EVENT, replayIntoLeg, type ReplayIntoLegHost } from '../src/stt/orchestrator-replay';
import { LegFacts } from '../src/stt/leg-facts';
import { SegmentPauseAccount } from '../src/stt/segment-pause';
import { HeardAudioLedger } from '../src/stt/heard-audio';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0 } from './fixtures/stt-outage-harness';

class SlowLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  readonly seqs: number[] = [];
  constructor(private readonly clock: FakeClock, private readonly roundTripMs: number) { super(); }
  get state(): EngineState { return this._state; }
  /** A real dial is not instant, and a leg is not `open` until it is (Soniox: the
   *  handshake). 50 ms, so a chunk can arrive while the leg is opening. */
  async open(): Promise<void> { await new Promise<void>((r) => { this.clock.setTimeout(r, 50); }); this._state = 'open'; }
  push(chunk: Buffer): void { this.seqs.push(chunk.readUInt32LE(0)); }
  flush(): Promise<void> {
    const n = this.seqs.length;
    return new Promise((resolve) => {
      this.clock.setTimeout(() => {
        this.emit('final', { kind: 'final', text: n > 0 ? `x${n}` : '', confidence: 1, language: 'zh', duration_ms: 0 });
        resolve();
      }, this.roundTripMs);
    });
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

type Retirement = 'rotation' | 'pause' | 'hangup';

/** Chunk seqs the gate withholds, per retirement: none for the rotation, a 1 s pause
 *  after 2.4 s for the pause cut, a 2 s pause after 2 s for the hang-up (1.5 s idle). */
function withheld(kind: Retirement, seq: number): boolean {
  if (kind === 'pause') return seq >= 12 && seq < 17;
  if (kind === 'hangup') return seq >= 10 && seq < 20;
  return false;
}

interface Run { legs: SlowLeg[]; cuts: Record<string, unknown>[]; shorts: Record<string, unknown>[]; voiced: number[]; uniqueFedMs: number; fedMs: number }

async function run(kind: Retirement, roundTripMs: number): Promise<Run> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
  session.start();
  const legs: SlowLeg[] = [];
  const orch = new SttEngineOrchestrator(session, () => { const l = new SlowLeg(clock, roundTripMs); legs.push(l); return l; }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    engineFlushTimeoutMs: 30_000,
    // rotation: due at 2 s, the leg rotates at 3 s. pause: due at 2 s, never rotated.
    // hangup: never due, never rotated; the idle hang-up fires 1.5 s into the pause.
    softSegmentMs: kind === 'hangup' ? 600_000 : 2_000,
    softSegmentGraceMs: kind === 'rotation' ? 1_000 : 600_000,
    ...(kind === 'hangup' ? { idleHangupMs: 1_500 } : {}),
    shouldFeedEngine: (c) => !withheld(kind, c.seq),
  });
  const cuts: Record<string, unknown>[] = [];
  const shorts: Record<string, unknown>[] = [];
  vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(fields ?? {}); });
  vi.spyOn(log, 'warn').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_REPLAY_SHORT_EVENT) shorts.push(fields ?? {}); });
  for (const e of ['final', 'error', 'engine-status', 'interim', 'error-suppressed']) orch.on(e, () => { /* listeners mandatory */ });
  const started = orch.start({ language: 'zh', mode: 'realtime' });
  await clock.advance(50); // the cold open's dial
  await started;
  const voiced: number[] = [];
  // Voice runs through the flush and on until the next leg has been live for 3 s.
  const totalChunks = Math.ceil((5_000 + roundTripMs + 3_000) / CHUNK_MS);
  for (let seq = 0; seq < totalChunks; seq++) {
    const payload = Buffer.alloc(CHUNK_BYTES, 0x40);
    payload.writeUInt32LE(seq, 0);
    if (!withheld(kind, seq)) voiced.push(seq);
    orch.pushChunk({ seq, ts_ms: clock.now, payload });
    await clock.advance(CHUNK_MS);
  }
  const uniqueFedMs = orch.uniqueFedAudioMs; const fedMs = orch.fedAudioMs;
  await orch.close();
  return { legs, cuts, shorts, voiced, uniqueFedMs, fedMs };
}

afterEach(() => { vi.restoreAllMocks(); });

const ROUND_TRIPS = [600, 4_000, 8_000, 12_000, 20_000];

describe('RC-A — a long retiring flush keeps the audio the old leg heard during it', () => {
  for (const kind of ['rotation', 'pause', 'hangup'] as const) {
    for (const rt of ROUND_TRIPS) {
      it(`${kind}, flush round trip ${rt} ms: the next leg starts at the boundary, and every voiced chunk is heard`, async () => {
        const r = await run(kind, rt);
        expect(r.legs.length).toBeGreaterThanOrEqual(2);
        const cut = r.cuts[0]!;
        expect(cut.kind).toBe(kind === 'hangup' ? 'hangup' : 'segment');
        if (kind === 'pause') expect(cut.reason).toBe('pause');
        const boundary = cut.boundary_seq as number;
        const next = r.legs[1]!;
        // ① — the same comparison the scratch reading was taken with.
        expect(next.seqs[0]).toBeLessThanOrEqual(boundary + 1);
        // A hang-up whose redial was dialled by returning voice (not owed at the flush's end) takes
        // the closed run's ≤1 s tail below the mark (RC-E follow-up, every session) — at most five
        // 200 ms chunks earlier; every other retirement starts exactly at the boundary.
        if (kind === 'hangup' && rt < 3_000) expect(boundary + 1 - next.seqs[0]!).toBeLessThanOrEqual(5);
        else expect(next.seqs[0]).toBe(boundary + 1);
        // ②
        const heard = new Set(r.legs.flatMap((l) => l.seqs));
        expect(r.voiced.filter((s) => !heard.has(s))).toEqual([]);
        // ③
        expect(r.shorts).toEqual([]);
        // Codex item 5 — the RC-A replay re-hands audio the old leg heard; the billing base counts each chunk once.
        // ⚠️ 更正（RC-Q，2026-09-24）：原为 `expect(r.uniqueFedMs).toBe(heard.size * CHUNK_MS)` — every chunk any leg
        // was handed. The base now counts only chunks the gate ACCEPTED (book 22 §4.9 RC-Q): the pause cut's
        // withheld tail (RC-5a) and the hang-up's (RC-E) are handed over and not billed. This leg reports no
        // processed position, so an accepted chunk counts when it is handed over.
        expect(r.uniqueFedMs).toBe(r.voiced.filter((s) => heard.has(s)).length * CHUNK_MS);
        if (kind !== 'hangup') expect(r.fedMs, 'precondition: the replay re-handed heard audio').toBeGreaterThan(r.uniqueFedMs);
      });
    }
  }
});

describe('RC-A — `stt.replay_short`: the relay says so when the ring no longer holds what a leg is owed', () => {
  function host(mark: number, ringSeqs: number[]): { h: ReplayIntoLegHost; fed: number[] } {
    const fed: number[] = [];
    const chunks = ringSeqs.map((seq) => { const payload = Buffer.alloc(CHUNK_BYTES); payload.writeUInt32LE(seq, 0); return { seq, ts_ms: seq * CHUNK_MS, payload }; });
    const h: ReplayIntoLegHost = {
      engine: { push: (c: Buffer) => { fed.push(c.readUInt32LE(0)); } }, terminated: false, terminalizing: false,
      lastEngineFedSeq: mark, engineFedBytes: 0, sessionFedBytes: 0, legHeardUpToSeq: -1, legFedBytes: 0,
      unheardVoice: true, pendingOverdueFloor: null, retiringFloorSeq: mark, replayWindowMs: 5_000, heard: new HeardAudioLedger(), unansweredFloorSeq: null,
      session: { replayTail: () => chunks }, idle: { arm: () => { /* no timer here */ } },
      legFacts: new LegFacts(), pauseAccount: new SegmentPauseAccount(),
    };
    return { h, fed };
  }

  it('🔴 the ring starts above the mark ⇒ one WARN naming the gap, and the retiring pin is released by the replay', () => {
    const warns: Record<string, unknown>[] = [];
    vi.spyOn(log, 'warn').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_REPLAY_SHORT_EVENT) warns.push(fields ?? {}); });
    const { h, fed } = host(4, [10, 11, 12]);
    replayIntoLeg(h, true);
    expect(fed).toEqual([10, 11, 12]);
    expect(warns).toEqual([{ needed_from_seq: 5, ring_oldest_seq: 10, short_ms: 5 * CHUNK_MS }]);
    expect(h.retiringFloorSeq).toBeNull();
  });

  it('positive control: the ring holds the chunk just above the mark ⇒ no WARN', () => {
    const warns: unknown[] = [];
    vi.spyOn(log, 'warn').mockImplementation((msg: string) => { if (msg === STT_REPLAY_SHORT_EVENT) warns.push(msg); });
    const { h, fed } = host(4, [2, 3, 4, 5, 6]);
    replayIntoLeg(h, true);
    expect(fed).toEqual([5, 6]);
    expect(warns).toEqual([]);
  });
});
