// card RC4-S5 — the release comes while a row cut's retiring flush is still out,
// and the user kept talking during that flush. The words said in that window
// must be transcribed once, in order, by the closing path — not dropped with an
// `STT_SEGMENT_NOT_TRANSCRIBED` — and the last row's length must stop at the
// release, not at the terminal final.
//
// SPEC-REF:
//   CR-12-E device re-run 4 report (2026-09-24, build d7d1e919), S5 section
//     (relay: pause cut at boundary seq 954, flush 36.6 s, returned 18 s after
//     the stop; chunks 954→1052 heard by no leg; `STT_SEGMENT_NOT_TRANSCRIBED`;
//     the last row 120.7 s for a 102.7 s stretch ⇒ header +18.0 s)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the RC4-S5 block)
//   docs/rebuild/04-PROTOCOL-SPEC.md `stt:error` row (`unheard_from_ms`)
//   apps/server-core/src/stt/orchestrator-rollover.ts `rolloverSegmentBody` (the
//     post-flush fence) / `payClosingSeam`
//   apps/server-core/src/stt/orchestrator-terminal.ts `stopRecording` / `terminalRowMs`
//
// Drives the REAL orchestrator + AudioSession + ring. The fake leg models what
// was measured for Soniox (test/fixtures/stt-outage-harness.ts, HANGUP-2 block):
// audio pushed after the end-of-stream frame is NOT in the flush's final, and
// the vendor's processed position stops there. Its final lists the voiced chunks
// it was handed before `flush()` as `[seq]` tokens, so a dropped or repeated
// chunk shows as a missing or repeated token.
//
// THE SHAPE (chunks of 200 ms): voice 0..11, a 1 s pause 12..16 (the row cut),
// voice again from 17 on. The first leg's flush takes 20 s; the release comes
// 10 s into it, with the user speaking the whole time.
//
// THE CLAIMS:
//   ① no `STT_SEGMENT_NOT_TRANSCRIBED` (no other error either);
//   ② every voiced chunk appears exactly once across the finals, in order;
//   ③ Σ duration_ms of the finals = the recorded length ±1 s;
//   ④ billed once: the billing base counts each voiced chunk once.
// Two more branches of the same fence: the release lands while the retiring leg
// is being CLOSED (its row final already went out — nothing may be sent twice),
// and the user was SILENT after the cut (nothing owed ⇒ no vendor connection is
// opened just to be closed: the pre-card behaviour, kept). When the closing dial
// fails, `STT_SEGMENT_NOT_TRANSCRIBED` names the first chunk no leg heard
// (`unheard_from_ms`), asserted on the orchestrator and on the frame the real
// SttSessionBridge puts on the wire.
// REVERSE CONTROLS: see the RC4-S5 report (the fence restored ⇒ ①② red; the
// terminal row measured at the final again ⇒ ③ red; the field dropped ⇒ the
// `unheard_from_ms` rows red).

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import { SttSessionBridge } from '../src/engine/stt-session';
import { log } from '../src/log';
import { STT_CUT_EVENT } from '../src/stt/cut-log';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';

class TokenLeg extends EventEmitter implements SttEngine {
  readonly id = 'soniox' as const;
  readonly interimShape = 'cumulative' as const;
  private _state: EngineState = 'closed';
  readonly seqs: number[] = [];
  /** Silence is handed over sometimes (RC-5a / RC-T tails) and, as with a real engine, yields no word. */
  private readonly spoken = new Set<number>();
  flushCalls = 0;
  private eosSent = false;
  private answeredMs = 0;
  constructor(private readonly clock: FakeClock, private readonly roundTripMs: number, private readonly openFails: boolean, private readonly closeMs = 0) { super(); }
  get state(): EngineState { return this._state; }
  /** The vendor's processed position in this leg's fed-audio clock (Soniox reports one): it answers what it
   *  gets at once, and nothing that arrives after its end-of-stream frame. */
  get ackedAudioMs(): number { return this.answeredMs; }
  async open(): Promise<void> {
    await new Promise<void>((r) => { this.clock.setTimeout(r, 50); });
    if (this.openFails) throw new Error('connect EACCES');
    this._state = 'open';
  }
  push(chunk: Buffer): void {
    this.seqs.push(chunk.readUInt32LE(0));
    if (chunk.readUInt8(4) === 1) this.spoken.add(chunk.readUInt32LE(0));
    if (!this.eosSent) this.answeredMs += chunk.length / 32;
  }
  /** Soniox (`packages/stt-cloud/src/engines/soniox.ts`): `flush()` on a socket that is not open resolves at
   *  once; the end-of-stream frame is answered by the final, then the vendor closes and the state leaves `open`. */
  flush(): Promise<void> {
    if (this._state !== 'open') return Promise.resolve();
    this.flushCalls += 1;
    this.eosSent = true;
    const heard = this.seqs.filter((s) => this.spoken.has(s)); // the words that reached the vendor before its end-of-stream frame
    return new Promise((resolve) => {
      this.clock.setTimeout(() => {
        this.emit('final', { kind: 'final', text: heard.map((s) => `[${s}]`).join(''), confidence: 1, language: 'zh', duration_ms: 0 });
        this._state = 'failed';
        resolve();
      }, this.roundTripMs);
    });
  }
  async close(): Promise<void> {
    if (this.closeMs > 0) await new Promise<void>((r) => { this.clock.setTimeout(r, this.closeMs); });
    this._state = 'closed';
  }
}

interface Final { text: string; segment_idx: number; is_segment: boolean; duration_ms: number }
interface Err { code: string; message: string; retryable: boolean; unheard_from_ms?: number }

const PAUSE = (seq: number): boolean => seq >= 12 && seq < 17;

interface Opts {
  /** The closing leg's open is refused. */
  closingDialFails?: boolean;
  /** How long closing the retiring leg takes (the release can land inside it). */
  closeMs?: number;
  /** Chunks pushed before the release (67 = 10 s into the 20 s flush). */
  total?: number;
  /** No voice after the cut. */
  silentAfterCut?: boolean;
  /** Drive it through the real SttSessionBridge and keep the frames it emits. */
  viaBridge?: boolean;
}

function payload(seq: number, voiced: boolean): Buffer {
  const b = Buffer.alloc(CHUNK_BYTES, 0x40);
  b.writeUInt32LE(seq, 0);
  b.writeUInt8(voiced ? 1 : 0, 4);
  return b;
}

async function s5(o: Opts = {}) {
  const clock = new FakeClock(T0);
  const legs: TokenLeg[] = [];
  const spoken = (seq: number): boolean => !PAUSE(seq) && !(o.silentAfterCut === true && seq >= 17);
  const build = (session: AudioSession): SttEngineOrchestrator => {
    const orch = new SttEngineOrchestrator(session, () => {
      const first = legs.length === 0;
      const l = new TokenLeg(clock, first ? 20_000 : 2_000, !first && o.closingDialFails === true, first ? (o.closeMs ?? 0) : 0);
      legs.push(l);
      return l;
    }, {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      engineFlushTimeoutMs: 60_000,
      softSegmentMs: 2_000, softSegmentGraceMs: 600_000, // due at 2 s; the pause 12..16 cuts the row
      continuous: true, reconnectUnbounded: true,
      shouldFeedEngine: (c) => spoken(c.seq),
    });
    orch.segmentNotTranscribedDeclared = true;
    return orch;
  };
  const cuts: Record<string, unknown>[] = [];
  vi.spyOn(log, 'info').mockImplementation((msg: string, fields?: Record<string, unknown>) => { if (msg === STT_CUT_EVENT) cuts.push(fields ?? {}); });
  const finals: Final[] = [];
  const errors: Err[] = [];
  const frames: Array<{ event: string; payload: unknown }> = [];
  let orch: SttEngineOrchestrator | null = null;
  let bridge: SttSessionBridge | null = null;
  if (o.viaBridge === true) {
    bridge = new SttSessionBridge({
      build: (session: AudioSession) => { orch = build(session); return { orchestrator: orch, isByok: false, gated: false }; },
      emitter: { emit: (event, p) => {
        frames.push({ event, payload: p });
        if (event === 'stt:final') finals.push(p as Final);
        if (event === 'stt:error') errors.push(p as Err);
      } },
      userId: 'u', mode: 'realtime', sourceLang: 'zh', onComplete: () => undefined, levelIntervalMs: 0,
    });
    await drain();
    await clock.advance(50);
  } else {
    const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
    session.start();
    const o2 = build(session);
    orch = o2;
    o2.on('final', (f: Final) => { finals.push(f); });
    o2.on('error', (e: Err) => { errors.push(e); });
    for (const e of ['engine-status', 'interim', 'error-suppressed', 'auto-stopped']) o2.on(e, () => { /* listeners mandatory */ });
    const started = o2.start({ language: 'zh', mode: 'realtime' });
    await clock.advance(50);
    await started;
  }
  const o3 = orch as unknown as SttEngineOrchestrator;
  const startedAt = clock.now;
  const voiced: number[] = [];
  const ts = new Map<number, number>();
  const TOTAL = o.total ?? 17 + 50;
  for (let seq = 0; seq < TOTAL; seq++) {
    const p = payload(seq, spoken(seq));
    if (spoken(seq)) voiced.push(seq);
    ts.set(seq, clock.now);
    if (bridge) bridge.pushChunk(seq, p.toString('base64'), clock.now);
    else o3.pushChunk({ seq, ts_ms: clock.now, payload: p });
    await clock.advance(CHUNK_MS);
  }
  const recordedMs = clock.now - startedAt;
  const legsAtRelease = legs.length;
  const flushInFlight = legs[0]!.flushCalls === 1 && legs.length === 1;
  const stopped = bridge ? bridge.finish() : o3.stop();
  await drain();
  await clock.advance(60_000);
  await stopped;
  const uniqueFedMs = o3.uniqueFedAudioMs;
  bridge?.dispose();
  const tokens = finals.flatMap((f) => [...f.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return { legs, finals, errors, frames, voiced, tokens, recordedMs, flushInFlight, legsAtRelease, ts, cuts, uniqueFedMs };
}

const rowsMs = (r: { finals: Final[] }): number => r.finals.reduce((s, f) => s + f.duration_ms, 0);

afterEach(() => { vi.restoreAllMocks(); });

describe('RC4-S5 — a release during a long row-cut flush, with the user still talking', () => {
  it('🔴 the words said during the flush are transcribed once, in order, and the rows add up to the recording', async () => {
    const r = await s5();
    // PRECONDITION — the S5 shape: at the release the row cut's flush was still out and no second leg existed.
    expect(r.flushInFlight).toBe(true);
    expect(r.cuts[0]).toMatchObject({ kind: 'segment', reason: 'pause' });
    // ①
    expect(r.errors.map((e) => e.code)).toEqual([]);
    // ②
    expect(r.tokens).toEqual(r.voiced);
    // A closing leg took the stretch — not the retiring leg (its end-of-stream was already sent).
    expect(r.legs).toHaveLength(2);
    expect(r.legs[1]!.seqs[0]).toBe((r.cuts[0]!.boundary_seq as number) + 1);
    // ③ — the header: every row's length, summed, is how long the person recorded (S5: +18.0 s).
    expect(Math.abs(rowsMs(r) - r.recordedMs)).toBeLessThanOrEqual(1_000);
    expect(r.finals.filter((f) => !f.is_segment)).toHaveLength(1);
    // ④ — each voiced chunk counted once, although the closing leg was re-handed what the retiring leg got after its end-of-stream.
    expect(r.uniqueFedMs).toBe(r.voiced.length * CHUNK_MS);
  });

  it('🔴 the release lands while the retiring leg is being closed (its row already went out): the row is not sent twice, the rest is transcribed once', async () => {
    // The cut is decided around seq 16 (t 3.4 s); its 20 s flush returns near 23.4 s and closing the leg takes 1 s.
    const r = await s5({ closeMs: 1_000, total: 118 });
    expect(r.legsAtRelease).toBe(1);
    expect(r.finals.filter((f) => f.is_segment)).toHaveLength(1); // PRECONDITION: the row final went out before the release
    expect(r.errors.map((e) => e.code)).toEqual([]);
    expect(r.tokens).toEqual(r.voiced);
    expect(r.legs).toHaveLength(2);
    expect(Math.abs(rowsMs(r) - r.recordedMs)).toBeLessThanOrEqual(1_000);
    expect(r.uniqueFedMs).toBe(r.voiced.length * CHUNK_MS);
  });

  it('positive control: nothing said after the cut ⇒ no closing leg is dialled (no vendor connection opened just to be closed)', async () => {
    const r = await s5({ silentAfterCut: true });
    expect(r.flushInFlight).toBe(true);
    expect(r.legs).toHaveLength(1);
    expect(r.errors.map((e) => e.code)).toEqual([]);
    expect(r.tokens).toEqual(r.voiced);
    expect(Math.abs(rowsMs(r) - r.recordedMs)).toBeLessThanOrEqual(1_000);
  });

  it('the closing dial fails ⇒ STT_SEGMENT_NOT_TRANSCRIBED names where the unheard stretch begins, and the rest is delivered', async () => {
    const r = await s5({ closingDialFails: true });
    expect(r.flushInFlight).toBe(true);
    const owed = r.errors.filter((e) => e.code === 'STT_SEGMENT_NOT_TRANSCRIBED');
    expect(owed).toHaveLength(1);
    // The retiring leg's final carries everything it heard before its end-of-stream frame, once, in order.
    const boundary = r.cuts[0]!.boundary_seq as number;
    expect(r.tokens).toEqual(r.voiced.filter((s) => s <= boundary));
    // The first chunk no leg heard, in the sender's clock (the clock `acked_audio_ms` answers in).
    expect(owed[0]!.unheard_from_ms).toBe(r.ts.get(boundary + 1));
    expect(Math.abs(rowsMs(r) - r.recordedMs)).toBeLessThanOrEqual(1_000);
    // Billed once: this session bills only what a leg answered; the phone's recovery of the rest is its own charge.
    expect(r.uniqueFedMs).toBe(r.voiced.filter((s) => s <= boundary).length * CHUNK_MS);
  });

  it('…and the frame the real SttSessionBridge puts on the wire carries it, ahead of the terminal final', async () => {
    const r = await s5({ closingDialFails: true, viaBridge: true });
    const i = r.frames.findIndex((f) => f.event === 'stt:error');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.frames[i]!.payload).toMatchObject({ code: 'STT_SEGMENT_NOT_TRANSCRIBED', retryable: false,
      unheard_from_ms: r.ts.get((r.cuts[0]!.boundary_seq as number) + 1) });
    expect(i).toBeLessThan(r.frames.findIndex((f) => f.event === 'stt:final' && (f.payload as Final).is_segment === false));
  });
});
