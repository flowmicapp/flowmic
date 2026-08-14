// Card M3-4b · The server replay ring buffer compared two clocks against each other — reverse control
//
// SPEC-REF:
//   docs/strategy/2026-08-02-card-m3-4b-ring-buffer-clock-mixing.md
//     §1.2 (write side session.ts / read side orchestrator-core.ts both mixed),
//     §1.3 (the threshold is 5 seconds, not minutes), §2.2 (three reverse controls), §3 (do not touch the phone)
//   docs/rebuild/06-STT-ENGINE-LAYER.md §1 (server_replay_buffer_ms 5000),
//     §2.3 (engine auto-reconnect → replay the 5s replay buffer)
//   CLAUDE.md red line: no silent failure / one value answers one question
//
// Defect (0.2.48 and earlier): ring-buffer entries carry the **phone**'s `ts_ms` (`audio_capture.dart:126`
// `DateTime.now()`), while prune and read cutoffs come from the **server**'s `Date.now()`.
// As soon as the two wall clocks differ by more than 5 seconds (server_replay_buffer_ms) the chain breaks, and **neither direction reports an error**:
//   · Phone clock slow > 5s ⇒ every incoming chunk is pruned on arrival ⇒ buffer stays empty ⇒ on engine reconnect **zero chunks are replayed**,
//     the 1–2 seconds of audio in the reconnect window are permanently lost (the user only sees half a sentence missing; no error on any of the three ends);
//   · Phone clock fast > 5s ⇒ never pruned ⇒ buffer grows unbounded, replay re-feeds the engine far more than 5 seconds of audio.
// An Android device without NTP can drift past 5 seconds in ordinary daily use.
//
// 🔴 Why the assertion is not `size` (the warning in card §2.2, the easiest pitfall on this card):
// `size` is correct in the 「fast」 direction, and in the 「slow」 direction it is also 「0」, and 「0」 can mean either a correct prune
// or **everything was pruned away**. So the primary assertion is 「how many chunks / how many bytes replay **actually fed**」—
// read from **what the engine itself received** (the fake engine records every push), which is what the vendor actually heard,
// harder than any internal counter. `size` is only a subordinate assertion.
//
// 🔴 This file drives the production classes themselves (AudioSession + SttEngineOrchestrator + the real reconnect ladder);
// only the engine is a stand-in — the defect lives on the 「engine dropped and reconnected」 path, and substituting the engine is what reaches it.
//
// ── [measured] 2026-08-02 reverse-control four states (same assertions, only the implementation changes)────────────────────
//   implementation state            skew=0                 skew=−10s              skew=+10s
//   ① before the fix (0.2.48)    19 chunks/121,600B/size 26  0 chunks/0B/size 0        30 chunks/192,000B/size 30
//   ② write side only            19 chunks/121,600B/size 26  0 chunks/0B/size 0        30 chunks/192,000B/size 30
//   ③ read side only             19 chunks/121,600B/size 26  0 chunks/0B/**size 26**   26 chunks/166,400B/size 26
//   ④ both sides fixed (status quo)  19 chunks/121,600B/size 26  19 chunks/121,600B/size 26 19 chunks/121,600B/size 26
//
// Column ③ is the cell this card most needs remembered: **the write side is already fixed, `size` is already a healthy 26, and replay still feeds 0 bytes**.
// A test that only asserts `size` is **all green** in that cell, and the user still loses the half-sentence in the reconnect window.
// That is the measured shape of the warning in card §2.2, and the evidence that 「fixing one side = not fixing」 (② and ③ each prove half).

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { RingBuffer } from '../src/stt/audio/ring-buffer';
import type { SttEngineId } from '@flowmic/protocol';
import type { EngineState, SttEngine } from '../src/stt/engines/base';

/** 200 ms @ 16 kHz mono s16le —— the chunk size the phone actually emits. */
const CHUNK_BYTES = 6_400;
const CHUNK_MS = 200;
/** 6 seconds of speech, 30 chunks —— longer than the 5 s replay window, so 「bounded」 is observable. */
const CHUNKS = 30;
const WINDOW_MS = 5_000;
/** Fixed epoch ms; never 0: a real wall clock is a large number, and a negative cutoff hides a class of boundary bugs. */
const T0 = 1_754_100_000_000;
/** owner 2026-08-02 bookkeeping scale: an Android device without NTP can drift this far in ordinary daily use. */
const SKEW_MS = 10_000;

const drain = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

class FakeClock {
  now: number;
  private timers: { id: number; fn: () => void; at: number }[] = [];
  private seq = 0;
  constructor(start: number) { this.now = start; }
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

/** Fake engine that records every push: **what THIS engine actually received**. */
class RecordingEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  readonly pushed: { seq: number; ts_ms: number; bytes: number }[] = [];
  readonly id: SttEngineId = 'custom-openai-compatible';
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(chunk: Buffer, ts_ms: number): void {
    // seq is written in the payload's first two bytes —— asserting 「which chunks were replayed」 must name them,
    // a mere count cannot tell 「replayed the newest 19」 from 「replayed the oldest 19」.
    this.pushed.push({ seq: chunk.readUInt16LE(0), ts_ms, bytes: chunk.length });
  }
  async flush(): Promise<void> { /* this file never takes the flush path */ }
  async close(): Promise<void> { this._state = 'closed'; }
  /** One 「involuntary drop」—— the only reason the replay buffer exists. */
  emitDrop(): void { this.emit('error', new Error('socket closed')); }
  get seqs(): number[] { return this.pushed.map((p) => p.seq); }
  get bytes(): number { return this.pushed.reduce((n, p) => n + p.bytes, 0); }
}

function frame(seq: number): Buffer {
  const b = Buffer.alloc(CHUNK_BYTES);
  b.writeUInt16LE(seq, 0);
  return b;
}

interface RunOutcome {
  /** What the engine received before the drop (live feed). */
  readonly live: RecordingEngine;
  /** What the new engine received after reconnect —— **this is the replay**, not one chunk more or less. */
  readonly replay: RecordingEngine;
  /** How many entries the buffer still held at reconnect (subordinate observation, see the file-header warning). */
  readonly bufferSize: number;
}

/**
 * One complete 「speak 6 s → engine drops → ladder reconnects → replay the tail」.
 *
 * @param skewMs phone wall-clock offset relative to the server wall clock (negative = phone is slow).
 *   This is the parameterized form of the `ts_ms` unit error in the L9 drill script (card §1.5):
 *   that run fed audio-relative time, equivalent to a 「phone clock slow」 of about 55 years.
 */
async function runUtterance(skewMs: number): Promise<RunOutcome> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: 300_000, replayWindowMs: WINDOW_MS,
  });
  session.start();
  const engines = [new RecordingEngine(), new RecordingEngine()];
  let i = 0;
  const orch = new SttEngineOrchestrator(session, () => engines[Math.min(i++, engines.length - 1)]!, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    // Soft segmentation pushed out of reach: this file measures reconnect replay, not the 30s rollover.
    softSegmentMs: 300_000, replayWindowMs: WINDOW_MS, engineFlushTimeoutMs: 1_000,
  });
  await orch.start({ language: 'zh', mode: 'realtime' });

  for (let seq = 0; seq < CHUNKS; seq++) {
    // 🔴 The frame's ts_ms is stamped by the **phone** (`audio_capture.dart:126 _wallClock()`);
    // the server just forwards it as-is —— this line is where the two clocks meet.
    orch.pushChunk({ seq, ts_ms: clock.now + skewMs, payload: frame(seq) });
    await clock.advance(CHUNK_MS);
  }

  engines[0]!.emitDrop();
  await drain();
  await clock.advance(1_000);          // backoff[0] → reconnect → replayBufferTail()

  return { live: engines[0]!, replay: engines[1]!, bufferSize: session.buffer.size };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Derivation of the expected values (hard-coded literals; do not invert the same formula the implementation uses —— that would be tautology)
 *
 * Pushes at T0+200·seq (seq = 0..29), last chunk at T0+5800; 1s backoff after the drop,
 * replay happens at T0+7000.
 *   · Prune on the last push: cutoff = 5800−5000 = 800 ⇒ drop seq 0..3 ⇒ 26 entries remain;
 *   · Replay read: cutoff = 7000−5000 = 2000 ⇒ keep 200·seq > 2000 ⇒ seq 11..29 ⇒ 19 chunks.
 * ────────────────────────────────────────────────────────────────────────── */
const EXPECT_REPLAY_SEQS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
const EXPECT_REPLAY_BYTES = EXPECT_REPLAY_SEQS.length * CHUNK_BYTES;   // 121_600
const EXPECT_BUFFER_SIZE = 26;

describe('replay ring buffer retention is measured by ONE clock (card M3-4b)', () => {
  /**
   * ① skew = 0 —— positive control.
   *
   * 🔴 Without this row, 「equal」 on the next two could mean the probe is blind rather than the implementation being correct (G13 rule ②).
   * It also pins **boundedness**: replay gets the last 5 seconds of tail, not the whole history.
   */
  it('① skew 0 (positive control): reconnect replay gets the last 5 s of tail, and only that span', async () => {
    const r = await runUtterance(0);

    // The live engine really received audio —— otherwise 「replay is empty」 could just mean nobody spoke.
    expect(r.live.seqs, 'the live feed before the drop never happened — every measurement after this is meaningless').toHaveLength(CHUNKS);

    expect(r.replay.seqs, 'the new engine after reconnect received zero chunks — replay was a no-op').not.toHaveLength(0);
    expect(r.replay.seqs).toEqual(EXPECT_REPLAY_SEQS);
    expect(r.replay.bytes).toBe(EXPECT_REPLAY_BYTES);
    // Two reverse faces of boundedness: the oldest was not replayed (otherwise 「never pruned」), the newest was (otherwise 「all pruned away」).
    expect(r.replay.seqs, 'audio older than the 5 s window was re-fed — that is duplicate transcription').not.toContain(0);
    expect(r.replay.seqs, 'the newest chunk was not in the replay — that is how speech in the reconnect window is lost').toContain(CHUNKS - 1);
    expect(r.bufferSize).toBe(EXPECT_BUFFER_SIZE);
  });

  /**
   * ② Phone clock 10 seconds slow —— before the fix: buffer always empty, replay zero chunks, **zero errors**.
   * measured before the fix: replay.seqs = [], bytes = 0, bufferSize = 0.
   */
  it('② phone clock 10 s slow: replay still feeds the same 19 chunks (0 chunks and fully silent before the fix)', async () => {
    const r = await runUtterance(-SKEW_MS);
    expect(
      r.replay.seqs,
      'a phone wall-clock 10 s slow makes replay a no-op — audio in the reconnect window is permanently lost, and none of the three ends reports an error',
    ).toEqual(EXPECT_REPLAY_SEQS);
    expect(r.replay.bytes).toBe(EXPECT_REPLAY_BYTES);
    expect(r.bufferSize, 'the buffer was pruned empty by the phone clock').toBe(EXPECT_BUFFER_SIZE);
  });

  /**
   * ③ Phone clock 10 seconds fast —— before the fix: never pruned, buffer unbounded, replay re-feeds the whole history.
   * measured before the fix: replay.seqs = 0..29 (30 chunks / 192,000 B), bufferSize = 30.
   */
  it('③ phone clock 10 s fast: still only replays 19 chunks, buffer still pruned to the 5 s window (before the fix all 30 chunks were re-fed)', async () => {
    const r = await runUtterance(SKEW_MS);
    expect(
      r.replay.seqs,
      'a phone wall-clock 10 s fast voids the 5 s window — audio far beyond the window is re-fed to the engine (duplicate transcription), and the buffer grows unbounded',
    ).toEqual(EXPECT_REPLAY_SEQS);
    expect(r.replay.bytes).toBe(EXPECT_REPLAY_BYTES);
    expect(r.bufferSize, 'never pruned — a long session\'s buffer would keep growing').toBe(EXPECT_BUFFER_SIZE);
  });

  /**
   * 🔴 This is the real contract sentence: **replay's result must not depend on the phone's clock, not even a little.**
   * The three rows above each pin one number; this one pins 「the three numbers must be the same number」——
   * whoever later swaps a cutoff back to `ts_ms`, write side or read side, this goes red.
   */
  it('🔴 under all three clock skews, the chunks and bytes replay feeds must be byte-identical', async () => {
    const [slow, zero, fast] = await Promise.all([
      runUtterance(-SKEW_MS), runUtterance(0), runUtterance(SKEW_MS),
    ]);
    expect(slow.replay.seqs).toEqual(zero.replay.seqs);
    expect(fast.replay.seqs).toEqual(zero.replay.seqs);
    expect([slow.replay.bytes, zero.replay.bytes, fast.replay.bytes])
      .toEqual([EXPECT_REPLAY_BYTES, EXPECT_REPLAY_BYTES, EXPECT_REPLAY_BYTES]);
    expect([slow.bufferSize, zero.bufferSize, fast.bufferSize])
      .toEqual([EXPECT_BUFFER_SIZE, EXPECT_BUFFER_SIZE, EXPECT_BUFFER_SIZE]);
  });

  /**
   * 🔴 The other half of the boundary, card §2.1 writes 「do not touch」: **the `ts_ms` fed to the engine is still the phone's clock**.
   * That site wants **capture timing**, and it is correct. Without this row, a 「fix」 that wholesale-replaces `ts_ms`
   * with `recv_ms` would keep the four rows above green while quietly changing the timeline fed to the vendor.
   */
  it('🔴 ts_ms fed to the engine is still the phone clock (capture timing), not replaced by the server instant', async () => {
    const r = await runUtterance(SKEW_MS);
    // Live feed: chunk 0's ts_ms = phone clock = T0 + skew.
    expect(r.live.pushed[0]!.ts_ms).toBe(T0 + SKEW_MS);
    // Replay feed: seq 11's ts_ms is likewise the one the phone stamped, not the instant replay happened.
    expect(r.replay.pushed[0]!.seq).toBe(11);
    expect(r.replay.pushed[0]!.ts_ms).toBe(T0 + 11 * CHUNK_MS + SKEW_MS);
  });
});

describe('RingBuffer retention only honours the instant the server received the chunk (card M3-4b unit face)', () => {
  /**
   * State 「one clock」 as an assertion directly: give each entry's `ts_ms` three absurd values (one hour early /
   * aligned / one hour late); retention behaviour must be **identical**.
   */
  it('however absurd an entry\'s ts_ms is, prune and read are unaffected', () => {
    const HOUR = 3_600_000;
    for (const bogus of [-HOUR, 0, HOUR]) {
      const ring = new RingBuffer(WINDOW_MS);
      for (let seq = 0; seq < CHUNKS; seq++) {
        const recv = T0 + seq * CHUNK_MS;
        ring.push({ seq, ts_ms: recv + bogus, recv_ms: recv, payload: frame(seq) }, recv);
      }
      expect(ring.size, `a ts_ms offset of ${bogus}ms changed the prune result`).toBe(EXPECT_BUFFER_SIZE);
      // cutoff = T0+6000−5000 = T0+1000, receive instant 200·seq > 1000 ⇒ seq 6..29 (24 entries).
      const tail = ring.since(T0 + CHUNKS * CHUNK_MS - WINDOW_MS);
      expect(tail.map((c) => c.seq), `a ts_ms offset of ${bogus}ms changed the replay-read result`)
        .toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    }
  });

  /**
   * Default self-compare still holds: when `now` is omitted, use the entry's own `recv_ms` (the same clock).
   * 🔴 Each entry's `ts_ms` is deliberately **the same constant** (a phone whose clock has stopped): if the default `now` were still
   * `chunk.ts_ms`, the cutoff would be constant and nothing would be pruned (30 entries); this assertion is what tells the two implementations apart.
   */
  it('push without now self-compares on the entry\'s own recv_ms (and does not fall back to ts_ms)', () => {
    const ring = new RingBuffer(WINDOW_MS);
    for (let seq = 0; seq < CHUNKS; seq++) {
      const recv = T0 + seq * CHUNK_MS;
      ring.push({ seq, ts_ms: T0, recv_ms: recv, payload: frame(seq) });
    }
    expect(ring.size).toBe(EXPECT_BUFFER_SIZE);
  });
});
