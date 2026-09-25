// card RC-U — while the vendor is more than 5 s behind the audio it was handed, the word-gap arm and the
// timed leg rotation are on hold; the silence hang-up, the sentence / pause arms and the overdue arm are not.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §5 (the backlog is MOVED leg to leg by every
//     break-before-make rotation; the word-gap arm reads ≥3 s where the speaker paused 0.6–1 s), §8 RC-U,
//     §11-7 (MAIN: in 0.3.95, measured first)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-U block)
//   apps/server-core/src/stt/engine-backlog.ts `backlogHoldsCutArms`
//
// Drives the REAL orchestrator + AudioSession. The fake leg's processed position and last hypothesis word are
// set by the test, so the backlog (handed − processed) and the word gap the arm reads are exactly what each
// row says they are.
//
// REVERSE CONTROL (see the card report): `backlogHoldsCutArms` answering false ⇒ the two 🔴 rows red (a
// word-gap cut and a rotation during a 20 s backlog).

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { STT_CUT_EVENT } from '../src/stt/cut-log';
import { BACKLOG_HOLDS_CUT_ARMS_MS, backlogHoldsCutArms } from '../src/stt/engine-backlog';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0 } from './fixtures/stt-outage-harness';

/** A leg whose vendor position trails what it was handed by `behindMs`, and whose last hypothesis word ended
 *  `gapMs` before that position — both set by the test. */
class BehindLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  private fedMs = 0;
  constructor(private readonly cfg: { behindMs: number; gapMs: number }) { super(); }
  get state(): EngineState { return this._state; }
  get ackedAudioMs(): number { return Math.max(0, this.fedMs - this.cfg.behindMs); }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {
    this.fedMs += CHUNK_MS;
    const proc = this.ackedAudioMs;
    this.emit('interim', { kind: 'interim', text: 'words so far', confidence: 1, language: 'zh', audio_proc_ms: proc, hypothesis_last_word_ms: Math.max(0, proc - this.cfg.gapMs) });
  }
  async flush(): Promise<void> { this.emit('final', { kind: 'final', text: 'words so far', confidence: 1, language: 'zh', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

async function run(cfg: { behindMs: number; gapMs: number }, o: { continuous?: boolean; softSegmentMs?: number; graceMs?: number; seconds: number }): Promise<{ cuts: Record<string, unknown>[]; legs: number }> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
  session.start();
  let legs = 0;
  const orch = new SttEngineOrchestrator(session, () => { legs += 1; return new BehindLeg(cfg); }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: o.softSegmentMs ?? 3_600_000, softSegmentGraceMs: o.graceMs ?? 3_600_000,
    ...(o.continuous === true ? { continuous: true, reconnectUnbounded: true } : {}),
  });
  const cuts: Record<string, unknown>[] = [];
  vi.spyOn(log, 'info').mockImplementation((msg: string, f?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(f ?? {}); });
  for (const e of ['final', 'error', 'engine-status', 'interim', 'error-suppressed']) orch.on(e, () => { /* listeners mandatory */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  for (let seq = 0; seq * CHUNK_MS < o.seconds * 1_000; seq++) {
    const payload = Buffer.alloc(CHUNK_BYTES, 0x40); payload.writeUInt32LE(seq, 0);
    orch.pushChunk({ seq, ts_ms: clock.now, payload });
    await clock.advance(CHUNK_MS);
  }
  await orch.close();
  return { cuts, legs };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('RC-U — the backlog predicate', () => {
  it('holds strictly above 5 s, and never on an unknown backlog', () => {
    expect(BACKLOG_HOLDS_CUT_ARMS_MS).toBe(5_000);
    expect(backlogHoldsCutArms(null)).toBe(false);
    expect(backlogHoldsCutArms(5_000)).toBe(false);
    expect(backlogHoldsCutArms(5_001)).toBe(true);
  });
});

describe('RC-U — the word-gap arm is on hold while the vendor is behind', () => {
  it('🔴 a long recording, 20 s behind, the leg reporting a 4 s 「gap」 ⇒ no word-gap cut in 30 s', async () => {
    const r = await run({ behindMs: 20_000, gapMs: 4_000 }, { continuous: true, seconds: 30 });
    expect(r.cuts.filter((c) => c.reason === 'word_gap')).toEqual([]);
  });

  it('control: the same 4 s gap with the vendor caught up ⇒ the arm cuts (once the row is 10 s old)', async () => {
    const r = await run({ behindMs: 0, gapMs: 4_000 }, { continuous: true, seconds: 30 });
    expect(r.cuts.filter((c) => c.reason === 'word_gap').length).toBeGreaterThan(0);
  });
});

describe('RC-U — the timed leg rotation is on hold while the vendor is behind', () => {
  it('🔴 the vendor has processed nothing: at each 7 s rotation the backlog is 7 s, 14 s ⇒ no rotation in 20 s', async () => {
    const r = await run({ behindMs: 3_600_000, gapMs: 0 }, { softSegmentMs: 6_000, graceMs: 1_000, seconds: 20 });
    expect(r.cuts.filter((c) => c.reason === 'leg')).toEqual([]);
    expect(r.legs).toBe(1);
  });

  it('control: caught up ⇒ the leg rotates on its timer', async () => {
    const r = await run({ behindMs: 0, gapMs: 0 }, { softSegmentMs: 6_000, graceMs: 1_000, seconds: 20 });
    expect(r.cuts.filter((c) => c.reason === 'leg').length).toBeGreaterThan(0);
    expect(r.legs).toBeGreaterThan(1);
  });
});
