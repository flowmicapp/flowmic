// Card RC-1b (2026-09-24) — managed streaming bills the audio an engine was
// actually handed, not the wall time the VAD gate held open.
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.9 (the base, and why
//     `min(gate-open ms, fed ms)`: each term guards one direction)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §1.3 (A1: billed
//     329,860 ms ＝ 5.50 min for a session whose engine died at 1:57)
//   CLAUDE.md D-21: the NAME (「transcription usage」) and the NUMBER that takes
//     effect are asserted separately — here the number is what `onComplete`
//     receives, read off the real bridge, never off a helper.
//
// Driven through the PRODUCTION pieces: SttSessionBridge + VadGate +
// AudioSession + SttEngineOrchestrator wired exactly as `engine-factory.ts`
// wires a managed streaming leg (`shouldFeedEngine: () => vad.open`). Only the
// engine is a stand-in, because the fault (an engine that is gone) cannot be
// injected otherwise.
//
// REVERSE CONTROL (card RC-1 ③, SAW RED 〔2026-09-24, lane-c〕): `settle()` put back
// to `this.vad.sessionMs` ⇒ the engine-gone row red (billed ≈ the whole gate-open
// time). Log `.local/rc-relay-1/billing-red.log`; restored, same command green.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { AudioSession } from '../src/stt/audio/session';
import type { VadGate } from '../src/stt/vad-gate';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { unexpectedCloseError } from '../src/stt/engines/base';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';

class StubLeg extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'soniox';
  private _state: EngineState = 'closed';
  pushedBytes = 0;
  readonly seqsHanded: number[] = []; // card RC-Q — the seq rides in the first two payload bytes
  constructor(private readonly refuse: boolean) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { if (this.refuse) throw new Error('connect refused'); this._state = 'open'; }
  push(chunk: Buffer): void { this.pushedBytes += chunk.length; this.seqsHanded.push(chunk.readUInt16LE(0)); }
  async flush(): Promise<void> { this.emit('final', { kind: 'final', text: 'ok', confidence: 0.9, language: 'zh', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
  drop(): void { this.emit('error', unexpectedCloseError('stub')); }
}

/** A loud 200 ms chunk (well above the gate's −45 dBFS) carrying its seq. */
function voiced(seq: number): string {
  const b = Buffer.alloc(CHUNK_BYTES);
  for (let i = 0; i < CHUNK_BYTES; i += 2) b.writeInt16LE(i % 64 < 32 ? 8_000 : -8_000, i);
  b.writeUInt16LE(seq, 0);
  return b.toString('base64');
}

interface Outcome { billedMs: number; gateOpenMs: number; fedMs: number; totalMs: number }

/**
 * `speakMs` of continuous speech. The current leg drops at each `dropAtMs` (never, if
 * undefined); `rungs` says whether each later leg opens (`true`) or refuses.
 */
async function run(speakMs: number, dropAtMs: number | readonly number[] | undefined, rungs: boolean[]): Promise<Outcome> {
  const drops = dropAtMs === undefined ? [] : typeof dropAtMs === 'number' ? [dropAtMs] : dropAtMs;
  const clock = new FakeClock(T0);
  const legs: StubLeg[] = [];
  let billed = -1;
  let orch: SttEngineOrchestrator | null = null;
  let gate: VadGate | undefined;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession, _l: string, _u: string, vad?: VadGate) => {
      gate = vad;
      orch = new SttEngineOrchestrator(session, () => {
        const leg = new StubLeg(legs.length > 0 && rungs[legs.length - 1] === false);
        legs.push(leg);
        return leg;
      }, {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        softSegmentMs: 3_600_000, shouldFeedEngine: (): boolean => vad!.open,
      });
      return { orchestrator: orch, isByok: false, gated: true };
    },
    emitter: { emit: () => {} },
    userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: (d) => { billed = d; },
    levelIntervalMs: 0,
    now: clock.nowFn,
  });
  await drain();
  for (let seq = 0; seq * CHUNK_MS < speakMs; seq++) {
    if (drops.includes(seq * CHUNK_MS)) { legs[legs.length - 1]!.drop(); await drain(); } // the CURRENT leg drops
    bridge.pushChunk(seq, voiced(seq), clock.now);
    await clock.advance(CHUNK_MS);
  }
  const finishing = bridge.finish();
  await clock.advance(10_000); // the terminal flush cap, on the fake clock
  await finishing;
  return {
    billedMs: billed,
    gateOpenMs: gate!.sessionMs,
    fedMs: (orch as unknown as SttEngineOrchestrator).fedAudioMs,
    totalMs: speakMs,
  };
}

describe('RC-1b — the managed streaming billing base', () => {
  it('🔴 engine gone after 80 s of a 200 s recording ⇒ billed ≈ 80 s, not the 200 s the gate stayed open', async () => {
    const o = await run(200_000, 80_000, [false, false, false]); // three refused rungs ⇒ the PTT ladder gives up
    // Positive control: the gate really was open the whole time, so the old base WOULD have billed ~200 s.
    expect(o.gateOpenMs).toBeGreaterThan(199_000);
    expect(o.fedMs).toBe(80_000);
    expect(o.billedMs).toBeLessThanOrEqual(80_000);
    expect(o.billedMs).toBeGreaterThan(79_000);
  });

  it('control: engine there throughout ⇒ billed is the gate-open time, exactly as before', async () => {
    const o = await run(60_000, undefined, []);
    expect(o.fedMs).toBeGreaterThanOrEqual(o.gateOpenMs - CHUNK_MS);
    expect(o.billedMs).toBe(Math.round(Math.min(o.gateOpenMs, o.fedMs)));
    expect(o.billedMs).toBeGreaterThan(59_000);
  });

  it('a ladder recovery re-feeds heard audio ⇒ fed exceeds the gate-open time, and the bill does not', async () => {
    const o = await run(60_000, 20_000, [true]); // rung 1 opens and replays the window, heard audio included
    expect(o.fedMs, 'precondition: the replay really handed the engine audio twice').toBeGreaterThan(o.gateOpenMs);
    expect(o.billedMs).toBeLessThanOrEqual(Math.round(o.gateOpenMs));
  });

  it('🔴 Codex item 5 — a recovered drop (heard audio replayed) and then an unrecovered outage ⇒ the replay is not billed twice', async () => {
    // Leg 0 drops at 20 s; rung 1 opens and replays the ring window, audio leg 0
    // had ALREADY heard included. Leg 1 drops at 40 s and every rung refuses, so
    // the last 60 s reach no engine. Unique audio any engine heard ≈ 40 s; the
    // unheard 60 s leave room under the gate-open term for the duplicate replay.
    const o = await run(100_000, [20_000, 40_000], [true, false, false, false]);
    expect(o.gateOpenMs, 'precondition: the gate stayed open for the whole recording').toBeGreaterThan(99_000);
    expect(o.fedMs, 'precondition: the replay handed an engine heard audio a second time').toBeGreaterThan(40_000 + CHUNK_MS);
    expect(o.billedMs, 'billed = unique audio an engine heard, not every byte it was handed').toBeLessThanOrEqual(40_000);
    expect(o.billedMs).toBeGreaterThan(39_000);
  });
});

// ── card RC-Q (2026-09-24) — the base counts audio the gate ACCEPTED and an engine ANSWERED, once ──────────
//
// SPEC-REF: docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.9 (RC-Q block);
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §2.1 (opus: outage silence replayed as unique fed —
//   the scratch reading `WITH-SILENCE {billed 74280, gateOpenMs 74280, uniqueFedMs 76200, loudHeardMs 70200}`)
//   and §11 (Codex: audio pushed into a leg that dies before answering it, billed here and again by recovery).
// As above, the number asserted is what `onComplete` receives (D-21), off the real bridge.
//
// REVERSE CONTROL (see the card report): `HeardAudioLedger` counting every chunk on hand-over (acceptance and
// the answered position both ignored) ⇒ both 🔴 rows red at the pre-RC-Q readings.

/** A leg that reports a processed position trailing what it was handed by [lagMs]; its end-of-stream answer
 *  (the flush) catches up with everything, as Soniox's `finished` frame does. */
class AckStubLeg extends StubLeg {
  private fedMs = 0; private finished = false;
  constructor(refuse: boolean, private readonly lagMs: number) { super(refuse); }
  get ackedAudioMs(): number { return this.finished ? this.fedMs : Math.max(0, this.fedMs - this.lagMs); }
  override push(chunk: Buffer): void { super.push(chunk); this.fedMs += CHUNK_MS; }
  override async flush(): Promise<void> { this.finished = true; await super.flush(); }
}

function silent(seq: number): string {
  const b = Buffer.alloc(CHUNK_BYTES);
  b.writeUInt16LE(seq, 0);
  return b.toString('base64');
}

interface OutageOutcome { billedMs: number; gateOpenMs: number; loudHeardMs: number }

/**
 * `speakMs` of speech in 200 ms chunks, silent where [quiet] says. The first leg drops at [dropAtMs]; the leg
 * built at or after [openAtMs] (fake clock, from the start) opens, every one before it refuses. Legs report a
 * processed position when [lagMs] is given.
 */
async function runOutage(o: { speakMs: number; dropAtMs: number; openAtMs: number; quiet?: (ms: number) => boolean; lagMs?: number; unbounded?: boolean }): Promise<OutageOutcome> {
  const clock = new FakeClock(T0);
  const legs: StubLeg[] = [];
  let billed = -1; let gate: VadGate | undefined;
  const bridge = new SttSessionBridge({
    build: (session: AudioSession, _l: string, _u: string, vad?: VadGate) => {
      gate = vad;
      const orch = new SttEngineOrchestrator(session, () => {
        const refuse = legs.length > 0 && clock.now < T0 + o.openAtMs;
        const leg = o.lagMs === undefined ? new StubLeg(refuse) : new AckStubLeg(refuse, o.lagMs);
        legs.push(leg);
        return leg;
      }, {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        softSegmentMs: 3_600_000, shouldFeedEngine: (): boolean => vad!.open,
        ...(o.unbounded === true ? { reconnectUnbounded: true } : {}),
      });
      return { orchestrator: orch, isByok: false, gated: true };
    },
    emitter: { emit: () => {} }, userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: (d) => { billed = d; }, levelIntervalMs: 0, now: clock.nowFn,
  });
  await drain();
  const loud = new Set<number>();
  for (let seq = 0; seq * CHUNK_MS < o.speakMs; seq++) {
    if (seq * CHUNK_MS === o.dropAtMs) { legs[0]!.drop(); await drain(); }
    const isQuiet = o.quiet?.(seq * CHUNK_MS) === true;
    if (!isQuiet) loud.add(seq);
    bridge.pushChunk(seq, isQuiet ? silent(seq) : voiced(seq), clock.now);
    await clock.advance(CHUNK_MS);
  }
  const finishing = bridge.finish();
  await clock.advance(10_000);
  await finishing;
  // Loud chunks some leg was handed — for a leg that reports no position, handed IS the measure (heard-audio.ts).
  const handed = new Set<number>();
  for (const l of legs) for (const s of l.seqsHanded) handed.add(s);
  return { billedMs: billed, gateOpenMs: gate!.sessionMs, loudHeardMs: [...loud].filter((s) => handed.has(s)).length * CHUNK_MS };
}

describe('RC-Q — the managed streaming base counts audio the gate accepted AND an engine answered', () => {
  it('🔴 opus §2.1 — an outage with a pause in it: the replayed silence does not lift the bill over the voice anyone heard', async () => {
    // 80 s of speech, the leg drops at 20 s, the unbounded ladder refuses four rungs and the fifth opens 31 s later;
    // 40–46 s is silence. The ring keeps 27 s (the ladder's 22 s + the 5 s window): ~4 s of the outage is gone.
    const o = await runOutage({ speakMs: 80_000, dropAtMs: 20_000, openAtMs: 51_000, unbounded: true, quiet: (ms) => ms >= 40_000 && ms < 46_000 });
    expect(o.loudHeardMs, 'precondition: part of the outage reached no engine').toBeLessThan(74_000 - 1_000);
    expect(o.billedMs, 'billed ≤ voice an engine heard + the gate hangover').toBeLessThanOrEqual(o.loudHeardMs + 600);
    expect(o.billedMs).toBeGreaterThanOrEqual(o.loudHeardMs - CHUNK_MS);
  });

  it('control — the same outage with no pause in it: billed = the voice an engine heard', async () => {
    const o = await runOutage({ speakMs: 80_000, dropAtMs: 20_000, openAtMs: 51_000, unbounded: true });
    expect(o.billedMs).toBeLessThanOrEqual(o.loudHeardMs + 600);
    expect(o.billedMs).toBeGreaterThanOrEqual(o.loudHeardMs - CHUNK_MS);
  });

  it('🔴 Codex — a leg that dies 2 s behind: what it was handed and never answered is not billed', async () => {
    // 100 s of speech; the leg (2 s behind the audio) drops at 40 s and every PTT rung refuses. It answered 38 s.
    const o = await runOutage({ speakMs: 100_000, dropAtMs: 40_000, openAtMs: 3_600_000, lagMs: 2_000 });
    expect(o.gateOpenMs, 'precondition: the gate stayed open').toBeGreaterThan(99_000);
    expect(o.billedMs).toBe(38_000);
  });

  it('control — the same leg, never dropped: its end-of-stream answer covers everything, and all of it is billed', async () => {
    const o = await runOutage({ speakMs: 60_000, dropAtMs: -1, openAtMs: 0, lagMs: 2_000 });
    expect(o.billedMs).toBeGreaterThan(59_000);
    expect(o.billedMs).toBe(Math.round(Math.min(o.gateOpenMs, 60_000)));
  });
});
