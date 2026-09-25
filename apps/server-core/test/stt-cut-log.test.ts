// Card RC-6 (2026-09-24) — one `stt.cut` INFO line per retired leg, and the
// gate-closure counts on `audio intake`.
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §3.3 (「演练一次」: two
//     candidate mechanisms nobody could tell apart, because the relay logged no
//     reason, boundary, fed audio or vendor position for any cut), §5 RC-6
//   apps/server-core/src/stt/cut-log.ts (the field list and what each means)
//
// Asserted on the LINE the logger receives (`log.info` spied), from the real
// orchestrator — every retirement site driven, not the helper called by hand.
// `reason` is exhausted against `SegmentCutReason` by a typed table: a fourth
// cut reason added to segment-boundary.ts fails this file at compile time until
// somebody decides what its line says.
// ⚠️ 更正（integ merge RC-relay-1 × RC-relay-2，2026-09-24）：原为 three reasons. RC-4 added
// `word_gap` and `overdue`, so the typed table now has five and the test drives a
// cut for each: runs 3 and 4 below use Soniox-shaped fakes condensed from
// stt-soniox-cut-arms.test.ts and stt-overdue-cut.test.ts, since those two arms
// read engine facts the plain `Leg` does not emit.
//
// REVERSE CONTROL (SAW RED 〔2026-09-24, lane-c〕): the `logCutIfFlushed` call in
// `rolloverSegment`'s `finally` removed ⇒ the exhaustiveness row red (no
// 'segment' lines). Log `.local/rc-relay-1/cutlog-red.log`; restored, same
// command green. And `gate_closures` dropped from the bridge's `audio intake` line ⇒ the
// intake row red (`.local/rc-relay-1/intake-red.log`).

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SttEngineId } from '@flowmic/protocol';
import { log } from '../src/log';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { VadGate } from '../src/stt/vad-gate';
import { SttSessionBridge } from '../src/engine/stt-session';
import { STT_CUT_EVENT, type SttCutRecord } from '../src/stt/cut-log';
import type { SegmentCutReason } from '../src/stt/segment-boundary';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';

const FIELDS: readonly (keyof SttCutRecord)[] = [
  'kind', 'reason', 'segment_idx', 'boundary_seq', 'leg_fed_ms', 'vendor_last_word_ms', 'flush_ms', 'timed_out', 'replayed_ms',
  'x_leg_ms', 'leg_seam_ms', 'x_left_word_leg', 'x_right_word_leg', // card RC-J
];
const EVERY_REASON: Record<SegmentCutReason, true> = { sentence: true, pause: true, word_gap: true, overdue: true, leg: true };

class Leg extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'custom-openai-compatible';
  private _state: EngineState = 'closed';
  heard = 0;
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void { this.heard += 1; this.emit('interim', { kind: 'interim', text: `w${this.heard}`, confidence: 0.5, language: 'zh' }); }
  async flush(): Promise<void> { this.emit('final', { kind: 'final', text: `w${this.heard}`, confidence: 0.9, language: 'zh', duration_ms: 0, last_word_ms: this.heard * CHUNK_MS }); }
  async close(): Promise<void> { this._state = 'closed'; }
  sentenceEnd(): void { this.emit('final', { kind: 'final', text: '好。', confidence: 0.9, language: 'zh', duration_ms: 0 }); }
}

/** RC-4 word-gap arm: final only on flush; the interims carry the adapter-internal facts. Words stop at 26.5 s of
 *  this leg's audio and the vendor has processed up to 200 ms behind the feed (stt-soniox-cut-arms.test.ts). */
class GapLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  private fedMs = 0;
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(chunk: Buffer): void {
    this.fedMs += chunk.length / 32;
    this.emit('interim', { kind: 'interim', confidence: 1, language: 'zh', text: '没有句号的一段话', finalized_text: '',
      hypothesis_last_word_ms: Math.min(this.fedMs - 300, 26_500), audio_proc_ms: this.fedMs - 200 });
  }
  async flush(): Promise<void> { this.emit('final', { kind: 'final', text: '没有句号的一段话。', confidence: 1, language: 'zh', duration_ms: 0, last_word_ms: 26_500 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

/** RC-4 overdue arm: 400 ms words 300 ms apart (no gap ≥600 ms ⇒ the 120 s fallback), vendor-final 4.5 s behind,
 *  and a final that honours `limitFinalTo` (condensed from stt-overdue-cut.test.ts's WordLeg). */
class WordLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  private heardMs = 0;
  private finalSent = 0;
  private cutoff: number | null = null;
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  limitFinalTo(legMs: number | null): void { this.cutoff = legMs; }
  private static words(untilMs: number): { s: number; e: number }[] {
    const out: { s: number; e: number }[] = [];
    for (let t = 0; t + 400 <= untilMs; t += 700) out.push({ s: t, e: t + 400 });
    return out;
  }
  push(chunk: Buffer): void {
    this.heardMs += chunk.length / 32;
    const ws = WordLeg.words(this.heardMs); const fin = WordLeg.words(this.heardMs - 4_500);
    const fresh = fin.slice(this.finalSent); this.finalSent = fin.length;
    if (ws.length === 0) return;
    this.emit('interim', { kind: 'interim', confidence: 1, language: 'zh', text: ws.map((_, i) => `w${i} `).join(''),
      finalized_text: fin.map((_, i) => `w${i} `).join(''), hypothesis_last_word_ms: ws[ws.length - 1]!.e, audio_proc_ms: this.heardMs,
      ...(fresh.length > 0 ? { finalized_word_spans: fresh.map((w) => ({ start_ms: w.s, end_ms: w.e })) } : {}) });
  }
  async flush(): Promise<void> {
    const kept = WordLeg.words(this.heardMs).filter((w) => this.cutoff === null || w.s < this.cutoff);
    this.emit('final', { kind: 'final', text: kept.map((_, i) => `w${i} `).join(''), confidence: 1, language: 'zh', duration_ms: 0 });
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('RC-6 — the stt.cut line', () => {
  it('every retirement site writes one line with every field; reason covers every cut reason', async () => {
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) lines.push(fields ?? {}); });
    const drive = async (softSegmentMs: number, script: (pump: (n: number, loud: boolean) => Promise<void>, legs: Leg[]) => Promise<void>): Promise<void> => {
      const clock = new FakeClock(T0);
      const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
      session.start();
      const legs: Leg[] = [];
      let voiced = true;
      const orch = new SttEngineOrchestrator(session, () => { const l = new Leg(); legs.push(l); return l; }, {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
        softSegmentMs, softSegmentGraceMs: 1_000, shouldFeedEngine: (): boolean => voiced, idleHangupMs: 3_000,
      });
      for (const ev of ['error', 'engine-status', 'interim', 'final']) orch.on(ev, () => { /* listeners mandatory */ });
      await orch.start({ language: 'zh', mode: 'realtime' });
      let seq = 0;
      await script(async (n, loud) => {
        voiced = loud;
        for (let i = 0; i < n; i++) { orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(CHUNK_BYTES, loud ? 0x40 : 0) }); await clock.advance(CHUNK_MS); }
      }, legs);
      await orch.stop();                         // the terminal flush ⇒ 'stop'
      await drain();
    };
    // Run 1 — a 1 s cadence: the leg rotates, a confirmed sentence cuts, a pause cuts.
    await drive(1_000, async (pump, legs) => {
      await pump(12, true);                      // due at 1 s, the leg rotates at 2 s ⇒ 'leg'
      legs[legs.length - 1]!.sentenceEnd();      // the engine confirms a sentence ⇒ the next chunk cuts on it
      await pump(1, true);                       // ⇒ 'sentence'
      await pump(7, true);                       // due again
      await pump(5, false);                      // ≥600 ms closed ⇒ 'pause'
    });
    // Run 2 — no cadence in reach: 3 s of silence hangs the leg up.
    await drive(600_000, async (pump) => {
      await pump(5, true);
      await pump(20, false);                     // ⇒ the hang-up
      await pump(2, true);                       // voice ⇒ redial, so the stop has a leg to flush
    });
    // Runs 3 and 4 — the gate never closes (the CR-12-E rooms); the leg never rotates (grace out of reach).
    const driveLeg = async (makeLeg: () => SttEngine, untilMs: number): Promise<void> => {
      const clock = new FakeClock(T0);
      const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
      session.start();
      const orch = new SttEngineOrchestrator(session, makeLeg, {
        now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, softSegmentMs: 30_000, softSegmentGraceMs: 600_000,
      });
      for (const ev of ['error', 'engine-status', 'interim', 'final']) orch.on(ev, () => { /* listeners mandatory */ });
      await orch.start({ language: 'zh', mode: 'realtime' });
      for (let seq = 0; seq * CHUNK_MS < untilMs; seq++) { orch.pushChunk({ seq, ts_ms: clock.now, payload: Buffer.alloc(CHUNK_BYTES, 0x40) }); await clock.advance(CHUNK_MS); }
      await orch.stop();
      await drain();
    };
    await driveLeg(() => new GapLeg(), 31_000);   // 3.5 s past the last word, past `due` ⇒ 'word_gap'
    await driveLeg(() => new WordLeg(), 122_000); // no ≥600 ms gap by 120 s ⇒ 'overdue'
    expect(lines.length, 'POSITIVE CONTROL: the probe saw lines at all').toBeGreaterThan(0);
    for (const l of lines) expect(Object.keys(l).sort(), JSON.stringify(l)).toEqual([...FIELDS].sort());
    const kinds = new Set(lines.map((l) => l.kind));
    expect([...kinds].sort()).toEqual(['hangup', 'segment', 'stop']);
    const reasons = new Set(lines.filter((l) => l.kind === 'segment').map((l) => l.reason));
    expect([...reasons].sort()).toEqual(Object.keys(EVERY_REASON).sort());
    for (const l of lines.filter((x) => x.kind !== 'segment')) expect(l.reason).toBeNull();
    // card RC-J — the cut-point fields are an overdue cut's, and only its: numbers there, null everywhere else.
    for (const l of lines) {
      if (l.reason === 'overdue') { expect(typeof l.x_leg_ms).toBe('number'); expect(typeof l.leg_seam_ms).toBe('number'); expect(['current', 'previous']).toContain(l.x_left_word_leg); }
      else expect([l.x_leg_ms, l.leg_seam_ms, l.x_left_word_leg, l.x_right_word_leg]).toEqual([null, null, null, null]);
    }
    const rows = lines.filter((l) => l.kind === 'segment');
    for (const l of rows) {
      expect(typeof l.boundary_seq).toBe('number');
      expect(l.leg_fed_ms as number).toBeGreaterThanOrEqual(0);
      expect(l.timed_out).toBe(false);
      expect(typeof l.flush_ms).toBe('number');
      expect(typeof l.replayed_ms, 'a rollover that opened a new leg says what it replayed into it').toBe('number');
    }
    expect(rows.some((l) => typeof l.vendor_last_word_ms === 'number'), 'the vendor position rides through when the engine gives one').toBe(true);
    expect(lines.find((l) => l.kind === 'hangup')!.replayed_ms).toBeNull();
  });
});

describe('RC-6 — gate closures on audio intake', () => {
  const frames = (ms: number, loud: boolean): Buffer => {
    const b = Buffer.alloc((16_000 * 2 * ms) / 1000);
    if (loud) for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 64 < 32 ? 8_000 : -8_000, i);
    return b;
  };
  it('counts closures after the gate was open, and buckets them at 600 ms and 3 s of gate time', () => {
    const vad = new VadGate({ thresholdDb: -45, hangoverMs: 300 });
    vad.process(frames(500, false));   // before any voice: not a closure
    vad.process(frames(1_000, true));
    vad.process(frames(1_000, false)); // closes after 300 ms ⇒ 700 ms closed ⇒ ≥600
    vad.process(frames(1_000, true));
    vad.process(frames(4_000, false)); // 3 700 ms closed ⇒ ≥600 and ≥3 s
    vad.process(frames(1_000, true));
    vad.process(frames(200, false));   // shorter than the hangover: the gate never closed
    vad.process(frames(1_000, true));
    vad.process(frames(500, false));   // 200 ms closed, still running at finish
    vad.finish();
    expect(vad.closures).toEqual({ count: 3, ge_600ms: 2, ge_3s: 1 });
  });

  it('the bridge puts them on the `audio intake` line (the production reader)', async () => {
    const intake: Record<string, unknown>[] = [];
    vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === 'audio intake') intake.push(fields ?? {}); });
    const bridge = new SttSessionBridge({
      build: (session: AudioSession, _l: string, _u: string, vad?: VadGate) => ({
        orchestrator: new SttEngineOrchestrator(session, () => new Leg(), { shouldFeedEngine: (): boolean => vad!.open, engineFlushTimeoutMs: 50 }),
        isByok: false, gated: true,
      }),
      emitter: { emit: () => {} }, userId: 'u', mode: 'realtime', sourceLang: 'zh', onComplete: () => {}, levelIntervalMs: 0,
    });
    await drain();
    let seq = 0;
    for (const [ms, loud] of [[1_000, true], [1_000, false], [1_000, true]] as const) {
      const b = frames(ms, loud);
      for (let o = 0; o < b.length; o += CHUNK_BYTES) bridge.pushChunk(seq++, b.subarray(o, o + CHUNK_BYTES).toString('base64'), 0);
    }
    await bridge.finish();
    expect(intake).toHaveLength(1);
    expect(intake[0]!.gate_closures).toEqual({ count: 1, ge_600ms: 1, ge_3s: 0 });
  });
});