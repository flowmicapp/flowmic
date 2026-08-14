// Card N1-B4 — the 5-minute wall becomes an ENGINE-SESSION rollover.
//
// SPEC-REF:
//   docs/strategy/2026-08-08-design-n1-long-recording.md §2.3 (M3:「keep a ceiling,
//     but let it act on the engine session rather than this user utterance: at the mark, roll over to a new engine session (close old, open new,
//     segment indices stay consecutive); the user feels nothing, no banner, FSM does not leave RECORDING」), §1.2 (the already-
//     written invariant 「one segment_idx may have only one server final」 and the dropped-characters
//     incident that produced it), §5 (「B4 rollover is this card's most dangerous step」)
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-c (one segment = one row)
//   orchestrator-core.ts F-2152 — the handoff rule this file tests directly
//
// ── 🔴 WHY THIS FILE IS MOSTLY ABOUT ONE CHUNK ──────────────────────────────
// Design §2.3 names exactly one hazard: 「the rollover point must align with a soft-segment boundary, otherwise the engine is swapped mid-flush」. The audio at risk is not a five-minute recording — it is the
// handful of chunks that arrive DURING the closing flush's round trip, after the
// old leg's final has been decided and before the new leg exists. F-2152 is the
// rule that saves them: `rolloverSegment` captures `finalizedSeq =
// lastEngineFedSeq` BEFORE the flush, then re-arms `lastEngineFedSeq` to that
// pre-flush boundary so `replayBufferTail(true)` hands the seam to the NEW leg.
//
// The seam is invisible to every coarser assertion. A test that only checks
// 「the recording continued」 or 「the indices are consecutive」 is green while the
// boundary chunks are silently dropped — which is why this file asserts on the
// SPECIFIC seq that landed inside the flush, and on the merged transcript.
//
// ⚠️ `softSegmentMs` is pushed out of reach in every test here ON PURPOSE. The
// soft rollover already recycles the leg every 30 s, so with it running, a
// passing test would not distinguish 「the wall rolled over」 from 「the soft timer
// happened to fire」. The wall must be the only thing that can move.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import {
  CHUNK_MS, EN, FakeClock, T0, TranscribingEngine, ZH, drain,
  frame, mergedFinalText, type Corpus, type ServerFinal, type WireFrame,
} from './fixtures/stt-outage-harness';

/** 2 s = 10 chunks. The real ceiling is 300 s; the MECHANISM is identical and a
 *  fake clock does not care, while a 300 s pump would be 1500 chunks of noise. */
const WALL_MS = 2_000;

interface Rig {
  readonly clock: FakeClock;
  readonly session: AudioSession;
  readonly engines: TranscribingEngine[];
  readonly orch: SttEngineOrchestrator;
  readonly finals: ServerFinal[];
  readonly autoStops: unknown[];
  readonly wire: WireFrame[];
  push(chunks: number): Promise<void>;
  /** ⚠️ NOT `orch.stop()` directly. The terminal flush also costs `flushDelayMs`
   *  ON THE FAKE CLOCK, so awaiting stop() before the clock is moved deadlocks
   *  the TEST, not the product — the same note stt-seam-duplication.test.ts
   *  carries, and the same 「Test timed out in 5000ms」 with zero failed
   *  assertions that this file produced on its first run. */
  stop(): Promise<void>;
  merged(): string;
}

async function makeRig(
  corpus: Corpus,
  opts: { flushDelayMs?: number; clampMs?: number } = {},
): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: WALL_MS,
  });
  // Production order: stt-factory clamps to the remaining quota BEFORE start().
  if (opts.clampMs !== undefined) session.clampHardLimitMs(opts.clampMs);
  session.start();
  const engines: TranscribingEngine[] = [];
  const orch = new SttEngineOrchestrator(
    session,
    () => {
      const e = new TranscribingEngine(corpus, clock, {
        open: 'ok', finalEveryN: 0, ...(opts.flushDelayMs !== undefined ? { flushDelayMs: opts.flushDelayMs } : {}),
      });
      engines.push(e);
      return e;
    },
    {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: 600_000, // out of reach — the wall must be the only mover
    },
  );
  const finals: ServerFinal[] = [];
  const wire: WireFrame[] = [];
  const autoStops: unknown[] = [];
  orch.on('interim', (e: { segment_idx: number; text: string }) => wire.push({ kind: 'interim', segment_idx: e.segment_idx, text: e.text }));
  orch.on('final', (f: ServerFinal) => {
    finals.push({ segment_idx: f.segment_idx, is_segment: f.is_segment, text: f.text });
    wire.push({ kind: 'final', segment_idx: f.segment_idx, text: f.text });
  });
  orch.on('auto-stopped', (p: unknown) => autoStops.push(p));
  orch.on('error', () => { /* listener mandatory on EventEmitter */ });
  orch.on('engine-status', () => { /* ditto */ });
  await orch.start({ language: corpus.lang, mode: 'realtime' });

  let seq = 0;
  return {
    clock, session, engines, orch, finals, autoStops, wire,
    push: async (chunks) => {
      for (let i = 0; i < chunks; i++) {
        orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
        seq += 1;
        await clock.advance(CHUNK_MS);
      }
    },
    stop: async () => {
      const stopped = orch.stop();
      await clock.advance((opts.flushDelayMs ?? 0) + 3_000);
      await stopped;
      await drain();
    },
    merged: () => mergedFinalText(wire),
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 1 — THE USER NEVER FINDS OUT.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('N1-B4 — the engine-session wall recycles the leg, not the recording', () => {
  it('the session stays RECORDING and nothing is auto-stopped', async () => {
    const rig = await makeRig(ZH);
    await rig.push(20); // 4 s — two full ceilings

    expect(rig.session.state).toBe('recording');
    expect(rig.autoStops).toEqual([]);
    // Every final so far closed a SEGMENT. One `is_segment:false` would mean the
    // phone had been told the utterance ended while the button was still held.
    expect(rig.finals.every((f) => f.is_segment)).toBe(true);
    expect(rig.engines.length).toBeGreaterThan(1); // the leg really was recycled
  });

  it('the ceiling RE-ARMS — a long recording crosses it more than once', async () => {
    // 🔴 A one-shot ceiling would hold 「an engine session may not run forever」
    // for exactly the first wall and then never again, and nothing would report
    // it. The re-arm is the half that has no user-visible symptom when missing.
    const rig = await makeRig(ZH);
    await rig.push(30); // 6 s ⇒ three ceilings
    expect(rig.engines.length).toBe(4); // one cold open + three rollovers
    expect(rig.session.state).toBe('recording');
  });

  it('segment indices stay consecutive across the wall, and no index is reused', async () => {
    // The invariant the dropped-characters incident produced (W2.5-B): 「one segment_idx may have only
    // one server final」. A wall rollover that forgot to spend the index would
    // publish the next final under one the phone has already finalised ⇒ REPLACE
    // ⇒ a whole segment leaves the transcript with nothing reporting a failure.
    const rig = await makeRig(ZH);
    await rig.push(20);
    await rig.stop();

    const idxs = rig.finals.map((f) => f.segment_idx);
    expect(idxs).toEqual(idxs.map((_, i) => i)); // 0,1,2,… consecutive
    expect(new Set(idxs).size).toBe(idxs.length); // and never reused
    expect(rig.finals.at(-1)!.is_segment).toBe(false); // the release still closes it
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 2 — 🔴 THE SEAM. The boundary chunk, named and tracked.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('N1-B4 — the handoff drops nothing at the boundary', () => {
  for (const corpus of [ZH, EN]) {
    it(`[${corpus.lang}] chunks that arrive DURING the wall's flush are handed to the new leg`, async () => {
      // A 600 ms flush spans three chunks. Those three are the seam: the old
      // leg's final was already decided when they arrived (default
      // `vendor-excludes-late-audio`), and the new leg does not exist yet.
      const rig = await makeRig(corpus, { flushDelayMs: 600 });
      await rig.push(20);
      await rig.stop();

      expect(rig.engines.length).toBeGreaterThan(1);
      const first = rig.engines[0]!;
      const later = rig.engines.slice(1).flatMap((e) => e.heard);

      // The seam, computed from the run rather than assumed: the seqs the FIRST
      // leg was handed after its flush was issued.
      const seam = first.seamSeqs;
      expect(seam.length).toBeGreaterThan(0); // positive control: there IS a seam
      // 🔴 EVERY ONE of them reached a later leg. This is F-2152's re-arm of
      // `lastEngineFedSeq` to the pre-flush boundary; without it the replay is
      // gated above the seam and these chunks are heard by nobody.
      for (const s of seam) expect(later).toContain(s);
    });
  }

  it('🔴 and the words survive: the merged transcript is the whole utterance, once', async () => {
    // The acceptance criterion is the WORDS the phone assembles, not the chunk
    // bookkeeping above — owner's rule: dropped characters are a veto. The seam is also where
    // duplication would appear, so this asserts EQUALITY, not containment.
    const rig = await makeRig(ZH, { flushDelayMs: 600 });
    await rig.push(20);
    await rig.stop();
    await drain();

    expect(rig.merged()).toBe(ZH.spoken(20));
  });

  it('the wall does not fire mid-flush: a leg is never swapped while its flush is open', async () => {
    // 「the rollover point must align with a soft-segment boundary, otherwise the engine is swapped mid-flush」 (design §2.3).
    // The mechanism is that the wall goes through `rolloverSegment`, which
    // flushes BEFORE it closes; so every engine that was ever flushed had its
    // flush COMPLETE (its final emitted) before it was closed. A mid-flush swap
    // shows up as a leg that was closed having emitted nothing.
    const rig = await makeRig(ZH, { flushDelayMs: 600 });
    await rig.push(20);
    await rig.stop();

    // Every leg but the last one was rolled; each must have produced its final.
    for (const e of rig.engines.slice(0, -1)) {
      expect(e.finalsEmitted.length).toBeGreaterThan(0);
      expect(e.state).toBe('closed');
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 3 — 🔴 THE OTHER CEILING MUST STILL STOP. Without this, N1-B4 reads as
 * 「the five-minute wall no longer stops anything」 — and the billing wall is the
 * same timer.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('N1-B4 — a quota ceiling is a different fact and still ends the recording', () => {
  it('clamped to the remaining quota ⇒ auto-stop, exactly as before', async () => {
    const rig = await makeRig(ZH, { clampMs: 1_000 }); // 5 chunks of budget
    await rig.push(12);
    await rig.orch.waitForTerminal();
    await drain();

    expect(rig.session.limitOrigin).toBe('quota_budget');
    expect(rig.session.state).toBe('auto_stopped');
    expect(rig.autoStops).toHaveLength(1);
    expect(rig.finals.at(-1)!.is_segment).toBe(false); // the utterance was closed
  });

  it('🔴 W8-3/C3: a budget that OUTLIVES the rollovers still stops — and the stop is EMITTED', async () => {
    // The branch-(ii) shape card C3 names: B4's re-arm re-anchors the engine
    // ceiling at every rollover, so this is the one ordering where a bug in the
    // re-arm could END a recording (or let it run forever) WITHOUT the
    // orchestrator's `auto-stopped` event — and that event is the only thing
    // the bridge turns into the wire `audio:auto-stopped` the phone's banner
    // rides. quota-limit-origin.test.ts pins this ordering at the SESSION
    // level; this is the same ordering one seam up, where the emit lives.
    // 5 s of budget over a 2 s wall: legs recycle at 2 s and 4 s, then the
    // budget — measured from start(), never re-anchored — fires at 5 s.
    const rig = await makeRig(ZH, { clampMs: 5_000 });
    await rig.push(30); // 6 s of chunks; the stop lands mid-way, at 5 s
    await rig.orch.waitForTerminal();
    await drain();

    // Positive control first: the rollovers really did happen before the stop,
    // so the assertion below is about 「the emit survived the re-arm」 and not
    // about the plain no-rollover path §3 already covers.
    expect(rig.engines.length).toBeGreaterThan(2);
    expect(rig.session.state).toBe('auto_stopped');
    // 🔴 The EMIT is the subject, payload and all — `computed but not emitted`
    // is exactly the silence W8-3 measured on a device. `limit_origin` is what
    // the bridge maps to `reason:quota_exhausted` (stt-session-autostop.ts).
    expect(rig.autoStops).toEqual([
      { reason: 'hard_limit', limit_origin: 'quota_budget' },
    ]);
    expect(rig.finals.at(-1)!.is_segment).toBe(false); // the utterance was closed
  });

  it('🔴 the two ceilings are told apart by the ORIGIN, not by the number', async () => {
    // Reverse-facing control for the branch itself: same clock, same ceiling
    // VALUE (1 s), opposite outcome — one stops, the other rolls. If the branch
    // ever read the number instead of the origin, exactly one of these two goes
    // red and it would be obvious which.
    const quota = await makeRig(ZH, { clampMs: 1_000 });
    await quota.push(12);
    await quota.orch.waitForTerminal();
    await drain();
    expect(quota.session.state).toBe('auto_stopped');

    const engineSession = await makeRig(ZH); // WALL_MS = 2 s, origin engine_session
    await engineSession.push(20);
    expect(engineSession.session.state).toBe('recording');
    await engineSession.stop();
  });
});
