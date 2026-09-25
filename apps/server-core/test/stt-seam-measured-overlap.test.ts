// card RC-5c — at a leg ROTATION the seam merge reads the vendor's processed
// position: a word the speaker said twice across the seam is kept twice unless
// the old leg's final really covered the audio the new leg re-hears.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §3 (RC-5b and RC-5c blocks)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §3.2 (「没有投票。投票会在」
//     came out with one 「投票」)
//   _dispatch/2026-09-24-rc-relay-2.report.md verdict ② (a rotation's replay overlap
//     equals its flush round trip; measured Soniox EOS→finished 0.6–0.8 s)
//
// Drives the REAL orchestrator. The engine is a Soniox-shaped fake: its flush answers
// after a 600 ms round trip (chunks keep arriving into the old leg meanwhile, exactly
// as on the live vendor), and its end-of-stream final carries what the adapter puts
// there (`audio_proc_floor_ms` = the processed position rounded up to 120 ms, minus
// one step; `token_spans`). Whether the vendor processes audio sent AFTER the
// end-of-stream is not measured, so both answers are scripted: `hearsPastEos`.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { FinalResult, SttEngine, EngineState } from '../src/stt/engines/base';

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

const STEP_MS = 120; // packages/stt-cloud/src/engines/soniox.ts SONIOX_PROC_STEP_MS
const ROUND_TRIP_MS = 600;
const BYTES_PER_MS = 32;

interface LegScript {
  text: string;
  /** Token texts with their start in THIS leg's clock; they concatenate to `text`. */
  tokens: { text: string; start_ms: number }[];
}

class VendorLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  heardBytes = 0;
  eosBytes: number | null = null;
  constructor(private readonly script: LegScript, private readonly clock: FakeClock, private readonly vendor: { hearsPastEos: boolean; reportsFloor: boolean }) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(chunk: Buffer): void { this.heardBytes += chunk.length; }
  flush(): Promise<void> {
    this.eosBytes = this.heardBytes;
    return new Promise((resolve) => {
      this.clock.setTimeout(() => {
        const processedMs = (this.vendor.hearsPastEos ? this.heardBytes : this.eosBytes!) / BYTES_PER_MS;
        const reported = Math.ceil(processedMs / STEP_MS) * STEP_MS; // the vendor's round-up (probe: 55,000 → 55,080)
        const ev: FinalResult = {
          kind: 'final', text: this.script.text, confidence: 1, language: 'zh', duration_ms: 0,
          ...(this.vendor.reportsFloor ? { audio_proc_floor_ms: Math.max(0, reported - STEP_MS) } : {}),
          token_spans: this.script.tokens,
        };
        this.emit('final', ev);
        resolve();
      }, ROUND_TRIP_MS);
    });
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

const zh = (s: string, startMs: number, stepMs = 150): { text: string; start_ms: number }[] =>
  [...s].map((ch, i) => ({ text: ch, start_ms: startMs + i * stepMs }));

async function rotateOnce(scripts: LegScript[], vendor: { hearsPastEos: boolean; reportsFloor: boolean }) {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  const legs: VendorLeg[] = [];
  const orch = new SttEngineOrchestrator(session, () => {
    const leg = new VendorLeg(scripts[Math.min(legs.length, scripts.length - 1)]!, clock, vendor);
    legs.push(leg);
    return leg;
  }, { now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, engineFlushTimeoutMs: 2_000, softSegmentMs: 2_000, softSegmentGraceMs: 1_000 });
  const terminal: string[] = [];
  orch.on('final', (f: { text: string; is_segment: boolean }) => { if (!f.is_segment) terminal.push(f.text); });
  orch.on('error', () => { /* listener mandatory */ });
  orch.on('engine-status', () => { /* not what this file measures */ });
  await orch.start({ language: 'zh', mode: 'realtime' });
  let seq = 0;
  for (let i = 0; i < 25; i++) { // 5 s: the leg span (2 s + 1 s) expires once; nothing ends the row
    orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(6_400) });
    await clock.advance(200);
  }
  const p = orch.stop();
  await clock.advance(3_000);
  await p;
  return { legs, text: terminal.join('') };
}

// Leg A said 「今天没有投票。」; leg B's first tokens are 「投票」 at 100 ms / 250 ms of ITS clock,
// i.e. inside the round-trip audio it was replayed first.
const LEG_A: LegScript = { text: '今天没有投票', tokens: zh('今天没有投票', 400) };
const LEG_B: LegScript = { text: '投票会在周五', tokens: zh('投票会在周五', 100) };

describe('RC-5c — the seam merge trims only what the old leg\'s final covered', () => {
  it('🔴 the old leg processed nothing past its end-of-stream ⇒ 「没有投票」 + 「投票会在周五」 keeps both 「投票」', async () => {
    const r = await rotateOnce([LEG_A, LEG_B], { hearsPastEos: false, reportsFloor: true });
    expect(r.legs).toHaveLength(2); // POSITIVE CONTROL: the seam exists
    // POSITIVE CONTROL: chunks DID land in the old leg during the round trip, so RC-5b alone
    // (「the new leg was replayed audio an earlier leg was handed」) would have merged here.
    expect(r.legs[0]!.heardBytes - r.legs[0]!.eosBytes!).toBeGreaterThanOrEqual((ROUND_TRIP_MS - 200) * BYTES_PER_MS);
    expect(r.text).toBe('今天没有投票投票会在周五');
  });

  it('the old leg DID process the round trip (a true replay) ⇒ the restated 「投票」 is merged once', async () => {
    const r = await rotateOnce([LEG_A, LEG_B], { hearsPastEos: true, reportsFloor: true });
    expect(r.legs).toHaveLength(2);
    expect(r.text).toBe('今天没有投票会在周五');
  });

  it('a covered head never licenses trimming past it: overlap covers 「投」 only ⇒ nothing is trimmed', async () => {
    // Same true replay, but leg B's 「票」 starts at 700 ms — after every byte the old leg
    // could have processed (< 600 ms of its round trip). One covered character is below
    // OVERLAP_MIN_CHARS, and the 2-character match may not reach past the bound.
    const r = await rotateOnce([LEG_A, { text: '投票会在周五', tokens: [{ text: '投', start_ms: 100 }, ...zh('票会在周五', 700)] }], { hearsPastEos: true, reportsFloor: true });
    expect(r.text).toBe('今天没有投票投票会在周五');
  });

  it('fact absent (no processed floor on the final) ⇒ RC-5b\'s rule, unchanged: the round trip counts as re-heard and merges', async () => {
    const r = await rotateOnce([LEG_A, LEG_B], { hearsPastEos: false, reportsFloor: false });
    expect(r.legs).toHaveLength(2);
    expect(r.text).toBe('今天没有投票会在周五');
  });
});
