// card CR-12-D (D-ter, primary-owner ruling 2026-09-23) — the pause in front of
// a segment is the WALL-CLOCK pause: the silence the engine heard PLUS the
// silence the VAD gate withheld from it. This file proves that sum in the three
// rooms that decide whether it is right.
//
// WHY A REAL GATE AND REAL PCM. The whole defect lived in the interaction between
// `VadGate` (what gets withheld), the idle hang-up (the leg disappears mid-pause)
// and the engine's word clock (which only counts what it was handed). A test that
// stubbed any one of the three would be measuring what this file believes the
// other two do. So: the production `VadGate` class with its production defaults
// (−45 dBFS, 300 ms hangover), fed synthesized PCM in the production order
// (`vad.process` BEFORE `pushChunk`, as `engine/stt-session.ts:588` does), wired
// exactly as `engine-factory.ts:507` wires it for a managed streaming leg
// (`shouldFeedEngine: () => vad.open`, `idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS`).
//
// The engine is a stand-in recogniser: it hears only what the orchestrator hands
// it and reports word positions IN THAT AUDIO, which is precisely the property of
// Soniox's `start_ms`/`end_ms` that caused the defect (a real session through the
// real adapter is the probe in the card report, not this file).
//
// THE THREE ROOMS
//   quiet  — digital silence: the gate closes 300 ms into the pause, the leg is
//            hung up 3 s later, and most of the pause is never handed to anyone.
//   noisy  — −40 dBFS noise, above the −45 dBFS threshold: the gate never
//            closes, every byte of the pause is inside the word gap, and the
//            withheld half must contribute EXACTLY nothing.
//   mixed  — the first half of the pause noisy, the second half silent: both
//            halves of the sum are large at once, which is where an overlap
//            between them — the same silence counted twice — has the most room
//            to show.
//
// TOLERANCE, and why it is this: ±200 ms. The gate's verdict is taken per chunk
// (a 200 ms chunk is fed or withheld whole — `pushChunk` reads `vad.open` once
// per chunk), the stand-in marks words per chunk, and the result is rounded to
// the vendor's 60 ms grid. One chunk of disagreement is the finest this rig can
// resolve; anything beyond it is a real error, and the defect this file exists
// for is 4,800 ms wide.

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from '../src/stt/orchestrator-types';
import { VadGate } from '../src/stt/vad-gate';
import { PAUSE_CUT_REPLAY_MAX_MS } from '../src/stt/pause-cut-boundary';
import type { SttEngineId } from '@flowmic/protocol';
import type { SttEngine, EngineState } from '../src/stt/engines/base';

const SR = 16_000;
const CHUNK_MS = 200;
const CHUNK_BYTES = CHUNK_MS * 32;
const PAUSE_MS = 5_000;
const TOLERANCE_MS = 200;
/** A dial is a network round trip, not an instant. Every leg after the cold open
 *  takes this long to open on the fake clock, so the chunks that arrive while it
 *  dials WAIT and reach the new leg by replay — the production shape. A first
 *  draft of this rig opened instantly, and the one fix that depends on a waiting
 *  chunk (count only the replay OVERLAP, not the whole replay) could not go red. */
const DIAL_MS = 400;
/** Longer than the pause, as production's 30 s is (see the rig). */
const CADENCE_MS = 6_000;

// ── PCM ─────────────────────────────────────────────────────────────────────

function pcm(ms: number, sample: (i: number) => number): Buffer {
  const n = Math.round((SR * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample(i) * 32767))), i * 2);
  return b;
}
/** A voice stand-in: a 220 Hz tone at about −17 dBFS. */
const speech = (ms: number): Buffer => pcm(ms, (i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR));
/** Digital silence — the room where the gate closes. */
const silence = (ms: number): Buffer => Buffer.alloc(Math.round((SR * ms) / 1000) * 2);
/** Deterministic white noise at `db` dBFS RMS (uniform on ±a has RMS a/√3). */
function noise(ms: number, db: number): Buffer {
  const a = Math.pow(10, db / 20) * Math.sqrt(3);
  let s = 0x2545f491;
  return pcm(ms, () => { s = (Math.imul(s, 1_103_515_245) + 12_345) >>> 0; return ((s / 0xffffffff) * 2 - 1) * a; });
}
function rmsDb(b: Buffer): number {
  let sum = 0; const n = b.length >> 1;
  for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 2) / 32768; sum += v * v; }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

// ── rig ─────────────────────────────────────────────────────────────────────

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
const drain = async (): Promise<void> => { for (let i = 0; i < 32; i++) await Promise.resolve(); };

/** Hears only what it is handed; a chunk louder than −30 dBFS is 「a word」, and
 *  its position is reported in THIS leg's fed-audio clock — the property of the
 *  vendor's timestamps that made the defect possible. Speech is −17 dBFS, the
 *  noisiest room is −40, so the two can never be confused. */
class ListeningEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  readonly id: SttEngineId = 'custom-openai-compatible';
  fedMs = 0;
  first: number | null = null;
  last: number | null = null;
  openedAtChunk = -1;
  closedAtChunk = -1;
  constructor(
    private readonly chunkNow: () => number,
    private readonly dial: () => Promise<void>,
    // card HANGUP-1 — the vendor's end-of-stream round trip. Words are FROZEN when
    // the flush is issued: audio pushed after the end-of-stream frame is not in
    // the vendor's final (F-2152; Soniox's `flush()` doc). 0 = instant, the
    // behaviour every earlier case was written against.
    private readonly flushWait: () => Promise<void> = () => Promise.resolve(),
  ) { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { await this.dial(); this._state = 'open'; this.openedAtChunk = this.chunkNow(); }
  push(b: Buffer): void {
    const start = this.fedMs;
    this.fedMs += b.length / 32;
    if (rmsDb(b) > -30) { this.first ??= start; this.last = this.fedMs; }
  }
  async flush(): Promise<void> {
    const first = this.first; const last = this.last;
    await this.flushWait();
    this.emit('final', {
      kind: 'final', text: first === null ? '' : '话。', confidence: 1, language: 'zh', duration_ms: 0,
      ...(first !== null && last !== null ? { first_word_ms: first, last_word_ms: last } : {}),
    });
  }
  async close(): Promise<void> { if (this._state !== 'closed') this.closedAtChunk = this.chunkNow(); this._state = 'closed'; }
  /** What the recogniser says mid-stream when a sentence ends — the confirmed
   *  terminator `segmentCutDecision` cuts on. Carries no spans, like a live final. */
  confirm(text: string): void { this.emit('final', { kind: 'final', text, confidence: 1, language: 'zh', duration_ms: 0 }); }
}

interface FinalEvent { segment_idx: number; is_segment: boolean; pause_before_ms?: number }

/** One recording: speech · pause · speech · a breath. The pause is `pause`,
 *  a buffer of exactly PAUSE_MS. Returns what reached the orchestrator's exit
 *  and the leg history the idle hang-up left behind. */
async function record(
  pause: Buffer,
  // card HANGUP-1 — optional: how long a redial takes, and what the speaker says
  // first after the pause (before the long run of speech). Defaults keep every
  // existing case byte-identical.
  opts: { dialMs?: number; opening?: Buffer; flushMs?: number } = {},
): Promise<{ finals: FinalEvent[]; legs: ListeningEngine[]; pauseChunks: [number, number] }> {
  const clock = new FakeClock();
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
  session.start();
  const vad = new VadGate();
  let seq = 0;
  const legs: ListeningEngine[] = [];
  const dial = (): Promise<void> => (legs.length <= 1
    ? Promise.resolve()                                   // the cold open is awaited by start()
    : new Promise<void>((r) => { clock.setTimeout(r, opts.dialMs ?? DIAL_MS); }));
  const flushWait = (): Promise<void> => (opts.flushMs
    ? new Promise<void>((r) => { clock.setTimeout(r, opts.flushMs!); })
    : Promise.resolve());
  const orch = new SttEngineOrchestrator(session, () => { const e = new ListeningEngine(() => seq, dial, flushWait); legs.push(e); return e; }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    // PROPORTIONS, not values: production's cadence (30 s) is far longer than a
    // paragraph pause, so a pause never outlives a whole cadence and never mints
    // an empty segment of its own. A first draft of this rig used 3 s and did
    // exactly that in the mixed room — measuring the rig, not the product.
    softSegmentMs: CADENCE_MS, softSegmentGraceMs: 15_000, engineFlushTimeoutMs: opts.flushMs ? opts.flushMs + 1_000 : 1_000,
    shouldFeedEngine: (): boolean => vad.open,            // engine-factory.ts:507, verbatim
    idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS,          // the same line
  });
  const finals: FinalEvent[] = [];
  orch.on('final', (p: FinalEvent) => finals.push(p));
  await orch.start({ language: 'zh', mode: 'realtime' });

  const play = async (buf: Buffer): Promise<void> => {
    for (let o = 0; o < buf.length; o += CHUNK_BYTES) {
      const c = buf.subarray(o, o + CHUNK_BYTES);
      vad.process(c);                                    // stt-session.ts:630 order
      orch.pushChunk({ seq: seq++, ts_ms: clock.now, payload: c });
      await clock.advance(CHUNK_MS);
    }
  };
  const current = (): ListeningEngine => legs[legs.length - 1]!;

  await play(speech(CADENCE_MS + 400));   // past the cadence, so the sentence may end the row
  current().confirm('第一段。');   // the sentence is confirmed as the speaker stops…
  const pauseFrom = seq;
  await play(pause);               // …so the cut lands on the first chunk of the pause
  const pauseTo = seq;
  if (opts.opening) await play(opts.opening);
  await play(speech(CADENCE_MS + 400));
  current().confirm('第二段。');
  await play(silence(400));
  // stop() waits for any rollover in flight, and that rollover may be waiting
  // on a dial timer — so the clock has to keep running while it settles.
  const stopping = orch.stop();
  await clock.advance(DIAL_MS * 4 + (opts.flushMs ?? 0) * 2);
  await stopping;
  return { finals, legs, pauseChunks: [pauseFrom, pauseTo] };
}

const pauseOf = (finals: FinalEvent[]): number | undefined =>
  finals.find((f) => f.segment_idx === 1)?.pause_before_ms;

describe('CR-12-D D-ter — the pause is the wall-clock pause, in every room', () => {
  it('🔴 QUIET ROOM: the gate closes and the leg hangs up, and the pause still reads 5 s', async () => {
    const { finals, legs, pauseChunks: [from, to] } = await record(silence(PAUSE_MS));
    // POSITIVE CONTROLS — the mechanisms this case is about really did fire,
    // otherwise a good number here would prove nothing about them:
    //   ① segment 1 exists and carries the field;
    expect(finals.filter((f) => f.is_segment).map((f) => f.segment_idx)).toEqual([0, 1]);
    //   ② a leg was hung up INSIDE the pause, and the next one only opened once
    //      speech came back — i.e. part of the pause had no leg at all.
    const hungUp = legs.find((l) => l.closedAtChunk > from && l.closedAtChunk < to && l.first === null);
    expect(hungUp, 'an idle hang-up inside the pause').toBeDefined();
    const redial = legs.find((l) => l.openedAtChunk >= to);
    expect(redial, 'a redial after the pause').toBeDefined();
    // The measurement: the chunks that arrived while NO leg existed.
    const noLegChunks = redial!.openedAtChunk - hungUp!.closedAtChunk;
    expect(noLegChunks * CHUNK_MS).toBeGreaterThanOrEqual(1_000);

    const got = pauseOf(finals)!;
    expect(Math.abs(got - PAUSE_MS)).toBeLessThanOrEqual(TOLERANCE_MS);
  });

  it('🔴 NOISY ROOM: the gate never closes, and the reading is the same 5 s — not 10', async () => {
    const { finals, legs, pauseChunks: [from, to] } = await record(noise(PAUSE_MS, -40));
    // POSITIVE CONTROL: the noise really kept the gate open — no leg was hung up
    // inside the pause, so every byte of it went to an engine.
    // (A leg that heard words and closed early in the pause is the boundary
    // rollover retiring the old leg, not a hang-up; a hang-up leg heard nothing.)
    expect(legs.filter((l) => l.first === null && l.closedAtChunk > from && l.closedAtChunk < to)).toEqual([]);
    const got = pauseOf(finals)!;
    expect(Math.abs(got - PAUSE_MS)).toBeLessThanOrEqual(TOLERANCE_MS);
  });

  it('🔴 QUIET ROOM, SHORT OPENING WORD: the gate closes again while the redial is still connecting, and the pause still reads 5 s', async () => {
    // card HANGUP-1. The first thing said after the pause is one short word, and
    // the gate closes behind it before the new leg is up (a 1 s dial — the figure
    // measured against the live vendor). The chunks withheld in that gap now WAIT
    // with the word and are replayed into the new leg (they no longer advance the
    // fed mark past it), so they are in that leg's word clock — and must not ALSO
    // be counted on the withheld side, or the pause reads long by that gap.
    const opening = Buffer.concat([speech(CHUNK_MS), silence(1_000)]);
    const { finals, legs, pauseChunks: [, to] } = await record(silence(PAUSE_MS), { dialMs: 1_000, opening });
    // POSITIVE CONTROL: the opening word is the very first thing the redialled
    // leg heard (position 0 of its clock) — so the reading below is anchored on
    // it, not on the long speech that follows.
    // ⚠️ 更正（RC-E follow-up, 2026-09-24）：this control was `toBe(0)` — 「the opening word is
    // position 0」. Every redial now first hears the closed run's last ≤1 s (the onset tail,
    // `orchestrator-core.ts` `takeRedialOnsetTail`), so the opening word sits right after that
    // silence: still the first thing with a word in it, and still ahead of the long speech
    // (which starts 1.2 s after it), which is all this control is for.
    const redial = legs.find((l) => l.openedAtChunk >= to)!;
    expect(redial.first, 'the redialled leg opened on the opening word').toBeLessThanOrEqual(PAUSE_CUT_REPLAY_MAX_MS);
    const got = pauseOf(finals)!;
    expect(Math.abs(got - PAUSE_MS)).toBeLessThanOrEqual(TOLERANCE_MS);
  });

  it('🔴 QUIET ROOM, SPEECH RESUMES INSIDE THE HANG-UP FLUSH: the words are kept and the pause still reads right', async () => {
    // card HANGUP-1 — the case measured against the live vendor (6,060 ms read
    // for a ~5,700 ms pause, 「大家好，」 gone). A 2 s end-of-stream round trip on
    // every flush: the boundary rollover's flush + a 400 ms dial put the fresh
    // leg up ~2.4 s into the pause, it is hung up 3 s later, and its flush is
    // still out when the speaker starts again 6 s into the pause.
    const PAUSE = 6_000;
    const { finals, legs, pauseChunks: [from, to] } = await record(silence(PAUSE), { flushMs: 2_000 });
    // RACE CONTROL: the leg opened inside the pause was still closing when the
    // speech came back, and was handed some of it — the exact condition.
    const closing = legs.find((l) => l.openedAtChunk > from && l.openedAtChunk < to && l.closedAtChunk > to);
    expect(closing, 'a hang-up whose flush was still out when speech resumed').toBeDefined();
    expect(closing!.first, 'the closing leg was pushed resumed speech').not.toBeNull();
    // THE WORDS: the leg dialled after that hang-up heard the resumed speech
    // WHOLE — first loud chunk to last, the full run. Losing its opening chunks
    // (the defect) shortens this span by exactly those chunks.
    const redial = legs.find((l) => l.openedAtChunk >= to)!;
    expect(redial.last! - redial.first!).toBe(CADENCE_MS + 400);
    const got = pauseOf(finals)!;
    expect(Math.abs(got - PAUSE)).toBeLessThanOrEqual(TOLERANCE_MS);
  });

  it('🔴 MIXED ROOM: half heard, half withheld — the two halves sum to the pause, they do not overlap', async () => {
    const { finals } = await record(Buffer.concat([noise(PAUSE_MS / 2, -40), silence(PAUSE_MS / 2)]));
    const got = pauseOf(finals)!;
    expect(Math.abs(got - PAUSE_MS)).toBeLessThanOrEqual(TOLERANCE_MS);
  });
});
