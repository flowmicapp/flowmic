// Card SEAM-2 — the real orchestrator at pause cuts: an engine that closes its final at end-of-stream
// (Soniox) loses the 「not finished」 mark our cut made it write, and the next row (or the terminal
// final) continues the phrase in lower case for closed words only; an engine that does not (FunASR
// family, F-2) keeps every mark; the hang-up leg seam is SEAM-1's and is not touched.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.2 (card SEAM-2 block)
//   docs/strategy/2026-10-14-soft-seam-root-cause.md §3.1 (test table, second row)
//
// Drives the chunk path with a VAD-gated fake (the same drive as stt-cut-log.test.ts run 1): a 1 s
// cadence, then ≥600 ms of closed gate ⇒ a 'pause' row cut. Each leg answers its flush with a scripted
// text, the way Soniox answers our end-of-stream.

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log';
import { STT_CUT_EVENT } from '../src/stt/cut-log';
import type { SttEngineId } from '@flowmic/protocol';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { joinAtLegSeam } from '../src/stt/leg-seam-join';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';

class ScriptedLeg extends EventEmitter implements SttEngine {
  readonly id: SttEngineId;
  readonly interimShape = 'cumulative' as const;
  readonly finalsOnlyAtFlush?: true;
  private _state: EngineState = 'closed';
  private heard = false;
  constructor(private readonly flushText: string, closesAtFlush: boolean) {
    super();
    this.id = closesAtFlush ? 'soniox' : 'custom-openai-compatible';
    if (closesAtFlush) this.finalsOnlyAtFlush = true;
  }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  // The draft never carries the mark: Soniox writes it only in its answer to the end-of-stream (RCA §1.1 c).
  push(): void { this.heard = true; this.emit('interim', { kind: 'interim', text: this.flushText.replace(/[—….]+$/u, ''), confidence: 0.5, language: 'en' }); }
  async flush(): Promise<void> { if (this.heard) this.emit('final', { kind: 'final', text: this.flushText, confidence: 0.9, language: 'en', duration_ms: 0 }); }
  async close(): Promise<void> { this._state = 'closed'; }
}

interface Final { text: string; is_segment: boolean; seam_from?: number }

/** Speak, pause ≥600 ms, … — one row per pause after the 1 s cadence; the last leg is closed by stop(). */
async function press(texts: readonly string[], closesAtFlush: boolean, plan: readonly (readonly [number, boolean])[], o: { softSegmentMs?: number; continuous?: boolean; seamRepair?: false } = {}): Promise<Final[]> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
  session.start();
  let voiced = true; let legs = 0;
  const orch = new SttEngineOrchestrator(session, () => new ScriptedLeg(texts[Math.min(legs++, texts.length - 1)]!, closesAtFlush), {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: o.softSegmentMs ?? 1_000, softSegmentGraceMs: 600_000, shouldFeedEngine: (): boolean => voiced, idleHangupMs: 3_000,
    ...(o.continuous === true ? { continuous: true } : {}),
    ...(o.seamRepair === false ? { seamRepair: false as const } : {}),
  });
  const finals: Final[] = [];
  for (const ev of ['error', 'engine-status', 'interim']) orch.on(ev, () => { /* listeners mandatory */ });
  orch.on('final', (e: Final) => finals.push({ text: e.text, is_segment: e.is_segment, ...(e.seam_from !== undefined ? { seam_from: e.seam_from } : {}) }));
  await orch.start({ language: 'en', mode: 'realtime' });
  let seq = 0;
  for (const [n, loud] of plan) {
    voiced = loud;
    for (let i = 0; i < n; i++) { orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(CHUNK_BYTES, loud ? 0x40 : 0) }); await clock.advance(CHUNK_MS); }
  }
  await orch.stop();
  await drain();
  await orch.close();
  return finals;
}

const TWO_PAUSES = [[7, true], [5, false], [7, true], [5, false], [3, true]] as const;

afterEach(() => { vi.restoreAllMocks(); });

describe('card SEAM-2 — pause cuts on an engine that closes its final at end-of-stream', () => {
  // Re-review R3: the orchestrator does not lower-case; it tags the next final with the stripped row it continues
  // and the bridge decides on that row's delivered text (seam-polish-terminal.test.ts drives that half).
  it('🔴 the row loses the vendor dash; the next row and the terminal final say which stripped row they continue', async () => {
    const f = await press(['and in the afternoon we—', 'The boat leaves at noon, and—', 'She said it is—'], true, TWO_PAUSES);
    expect(f.map((x) => x.is_segment), 'POSITIVE CONTROL: two pause rows and the terminal final').toEqual([true, true, false]);
    // review C2: the terminal final's closing dash is Soniox's end-of-stream token; dropped, the normalizer closes it.
    expect(f.map((x) => x.text)).toEqual(['and in the afternoon we', 'The boat leaves at noon, and', 'She said it is']);
    expect(f.map((x) => x.seam_from)).toEqual([undefined, 0, 1]);
  });

  // Re-review R1 — every silence cut of a long recording is today's text, the word-gap arm included.
  // REVERSE CONTROL (SAW RED, card SEAM-2): the `host.continuous ?` branch removed from orchestrator-flush.ts ⇒ red.
  // Review F2: the terminal final too ("Und dann—" stays), and F1: each cut still logs seam_open.
  // REVERSE CONTROL (SAW RED, card SEAM-2 F2): `host.seamRepair &&` removed from the terminal emit ⇒ 「Und dann」 red.
  // REVERSE CONTROL (SAW RED, card SEAM-2 F1): `untouchedRow` logging null ⇒ the seam_open row red.
  it.each([['a long recording', { continuous: true }], ['a recovery leg', { seamRepair: false as const }]] as const)(
    '🔴 %s: rows and the terminal final keep today\u2019s text; the cuts are still logged', async (_name, o) => {
      const cuts: Record<string, unknown>[] = [];
      vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(fields ?? {}); });
      const f = await press(['y entonces—', '¿Qué hacemos?—', 'Und dann—'], true, TWO_PAUSES, o);
      expect(f.map((x) => x.is_segment), 'POSITIVE CONTROL: the same two pause rows').toEqual([true, true, false]);
      expect(f.map((x) => x.text)).toEqual(['y entonces—', '¿Qué hacemos?—', 'Und dann—']);
      expect(f.map((x) => x.seam_from)).toEqual([undefined, undefined, undefined]);
      expect(cuts.filter((c) => c.kind === 'segment').map((c) => c.seam_open)).toEqual([true, true]);
    });

  // review C1 — the shipped joiners space rows only after ASCII: a strip that left 「мы」 would glue 「мыПотом」.
  // REVERSE CONTROL (SAW RED, card SEAM-2): `joinSafeEnd` made to return true ⇒ this case red.
  it('🔴 a row that would end on a non-ASCII letter of a spaced script keeps its mark and the next row its capital', async () => {
    const f = await press(['и вечером мы—', 'Потом поедем домой, und dann Fuß—', 'Und weiter'], true, TWO_PAUSES);
    expect(f.map((x) => x.is_segment), 'POSITIVE CONTROL').toEqual([true, true, false]);
    expect(f.map((x) => x.text)).toEqual(['и вечером мы—', 'Потом поедем домой, und dann Fuß—', 'Und weiter']);
  });

  it('a word that is not on the closed list keeps its capital (a name, I, a verb)', async () => {
    const f = await press(['we told the team that—', 'Maria wants it, and—', 'I think so'], true, TWO_PAUSES);
    expect(f.map((x) => x.text)).toEqual(['we told the team that', 'Maria wants it, and', 'I think so']);
  });

  it('a real sentence end keeps its full stop and the next row its capital', async () => {
    const f = await press(['on Tuesday afternoon.', 'The meeting is at three.', 'Thanks'], true, TWO_PAUSES);
    expect(f.map((x) => x.text)).toEqual(['on Tuesday afternoon.', 'The meeting is at three.', 'Thanks']);
  });

  it('🔴 F-2: an engine that does not close at end-of-stream keeps every mark and every capital', async () => {
    const f = await press(['and in the afternoon we—', 'The boat leaves at noon, and—', 'She said it is—'], false, TWO_PAUSES);
    expect(f.map((x) => x.is_segment), 'POSITIVE CONTROL: the same two pause rows').toEqual([true, true, false]);
    expect(f.map((x) => x.text), 'terminal dash kept too (review C2: other engines unchanged)').toEqual(['and in the afternoon we—', 'The boat leaves at noon, and—', 'She said it is—']);
  });

  // review P5 — RC-E is measured, not repaired. REVERSE CONTROL (SAW RED, card SEAM-2): `untouchedRow` replaced by
  // `cutRow(head(…))` in `endRowAtSilence` ⇒ this case red.
  // Re-review R1 — the WORD-GAP arm of a long recording (the gate never closes; the vendor's words stop 3.5 s before
  // the 30 s deadline): the same `host.continuous` branch. REVERSE CONTROL (SAW RED): that branch removed ⇒ red.
  it('🔴 a long recording: a word-gap row cut keeps the vendor mark too', async () => {
    class GapLeg extends EventEmitter implements SttEngine {
      readonly id = 'soniox' as const;
      readonly interimShape = 'cumulative' as const;
      readonly finalsOnlyAtFlush = true as const;
      private _state: EngineState = 'closed';
      private fedMs = 0;
      get ackedAudioMs(): number { return Math.max(0, this.fedMs - 200); }
      get state(): EngineState { return this._state; }
      async open(): Promise<void> { this._state = 'open'; }
      push(chunk: Buffer): void {
        this.fedMs += chunk.length / 32;
        this.emit('interim', { kind: 'interim', confidence: 1, language: 'en', text: 'und dann', finalized_text: '',
          hypothesis_last_word_ms: Math.min(this.fedMs - 300, 26_500), audio_proc_ms: this.fedMs - 200 });
      }
      async flush(): Promise<void> { this.emit('final', { kind: 'final', text: 'und dann—', confidence: 1, language: 'de', duration_ms: 0, last_word_ms: 26_500 }); }
      async close(): Promise<void> { this._state = 'closed'; }
    }
    const cuts: Record<string, unknown>[] = [];
    vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(fields ?? {}); });
    const clock = new FakeClock(T0);
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
    session.start();
    const orch = new SttEngineOrchestrator(session, () => new GapLeg(), {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, softSegmentMs: 30_000, softSegmentGraceMs: 600_000, continuous: true,
    });
    const finals: Final[] = [];
    for (const ev of ['error', 'engine-status', 'interim']) orch.on(ev, () => { /* listeners mandatory */ });
    orch.on('final', (e: Final) => finals.push({ text: e.text, is_segment: e.is_segment, ...(e.seam_from !== undefined ? { seam_from: e.seam_from } : {}) }));
    await orch.start({ language: 'de', mode: 'realtime' });
    for (let seq = 0; seq * CHUNK_MS < 31_000; seq++) { orch.pushChunk({ seq, ts_ms: clock.now, payload: Buffer.alloc(CHUNK_BYTES, 0x40) }); await clock.advance(CHUNK_MS); }
    await orch.stop(); await drain(); await orch.close();
    expect(cuts.find((c) => c.kind === 'segment')?.reason, 'POSITIVE CONTROL: the word-gap arm cut the row').toBe('word_gap');
    expect(finals[0]).toEqual({ text: 'und dann—', is_segment: true });
    expect(cuts.find((c) => c.kind === 'segment')?.seam_open, 'review F1: measured, not repaired').toBe(true);
  });

  it('🔴 RC-E: a long recording\u2019s silence row cut keeps today\u2019s text; its `stt.cut` line still says the cut was open', async () => {
    const cuts: Record<string, unknown>[] = [];
    vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(fields ?? {}); });
    // 11 s of speech (the row is old enough), 4 s of silence (the 3 s hang-up), speech again on a redialled leg.
    const f = await press(['and in the afternoon we—', 'The boat leaves at noon'], true, [[55, true], [20, false], [4, true]], { softSegmentMs: 600_000, continuous: true });
    const hangup = cuts.find((c) => c.kind === 'hangup');
    expect(hangup?.reason, 'POSITIVE CONTROL: the hang-up ended a row').toBe('pause');
    expect(f).toEqual([{ text: 'and in the afternoon we—', is_segment: true }, { text: 'The boat leaves at noon', is_segment: false }]); // no seam_from either
    expect(hangup?.seam_open).toBe(true);
  });

  it('🔴 the hang-up leg seam stays SEAM-1\'s: a banked leg is joined by joinAtLegSeam, no head lower-casing', async () => {
    // No cadence in reach: 3 s of silence hangs the leg up (bank), voice redials; one row = the terminal final.
    const clock = new FakeClock(T0);
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 3_600_000 });
    session.start();
    let voiced = true; let legs = 0;
    const texts = ['and in the afternoon we...', 'The boat leaves at noon']; // an ellipsis: joinAtLegSeam keeps it, a SEAM-2 strip would not
    const orch = new SttEngineOrchestrator(session, () => new ScriptedLeg(texts[Math.min(legs++, 1)]!, true), {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: 600_000, shouldFeedEngine: (): boolean => voiced, idleHangupMs: 3_000,
    });
    const finals: Final[] = [];
    for (const ev of ['error', 'engine-status', 'interim']) orch.on(ev, () => { /* listeners mandatory */ });
    orch.on('final', (e: Final) => finals.push({ text: e.text, is_segment: e.is_segment }));
    await orch.start({ language: 'en', mode: 'realtime' });
    let seq = 0;
    for (const [n, loud] of [[5, true], [20, false], [4, true]] as const) {
      voiced = loud;
      for (let i = 0; i < n; i++) { orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: Buffer.alloc(CHUNK_BYTES, loud ? 0x40 : 0) }); await clock.advance(CHUNK_MS); }
    }
    await orch.stop(); await drain(); await orch.close();
    expect(legs, 'POSITIVE CONTROL: the leg was hung up and redialled').toBe(2);
    expect(finals).toEqual([{ text: joinAtLegSeam(texts[0]!, texts[1]!), is_segment: false }]);
  });
});
