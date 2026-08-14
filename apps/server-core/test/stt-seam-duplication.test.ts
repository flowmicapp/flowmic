// Card RT-3 · The soft-segment SEAM — W4S §6.1 / §6.2, answered as far as this
// side can answer it.
//
// SPEC-REF:
//   docs/strategy/2026-08-07-w4s-server-batch-ledger.md §6.1 / §6.2
//   apps/mobile/lib/src/stt/segment_buffer.dart — `joined` doc, W5a/W2.5-H:
//     「HOW OFTEN IT FIRES IS UNKNOWN AND CANNOT BE DETERMINED FROM THIS SIDE …
//      The structurally correct fix is on the server, which is the only place
//      that knows `finalizedSeq`」
//
// THE OPEN ACCOUNT, restated. `rolloverSegment()` captures the PRE-flush
// boundary (`const finalizedSeq = this.lastEngineFedSeq`) and re-feeds
// everything past it into the NEXT engine (`replayBufferTail(true)`). Its
// comment (F-2152) asserts those chunks 「aren't in segment N's final」. That is
// an assertion about A VENDOR, made by us, never measured. The phone deleted its
// seam trimmer (owner's veto: dropped characters are a veto), so if the assertion is false the
// user now SEES the seam twice.
//
// WHAT THIS FILE CAN AND CANNOT SETTLE.
//   ✅ CAN: the seam WIDTH — how many chunks land in the window — as a function
//      of flush latency. That is a property of our own code and the clock, and
//      it is measured below.
//   ✅ CAN: what the merged final looks like under EACH answer to the open
//      question, so the size of the bet is visible.
//   ❌ CANNOT: how often a real vendor includes late audio in its flush final.
//      That needs a real vendor on a real socket. It is left open, not guessed.
//      🔴 No frequency number is invented here.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import {
  CHUNK_MS, EN, FakeClock, T0, TranscribingEngine, ZH,
  frame, mergedFinalText, type Corpus, type SeamPolicy, type ServerFinal, type WireFrame,
} from './fixtures/stt-outage-harness';

/** ⚠️ 4 s, not the production 30 s. The seam width is a function of FLUSH
 *  latency and the chunk period — NOT of the segment length — so shortening the
 *  period changes nothing being measured, and it keeps the whole run inside the
 *  64 distinct corpus tokens so a repeated token cannot manufacture a merge
 *  coincidence. */
const SOFT_SEGMENT_MS = 4_000;
const SEG0_CHUNKS = SOFT_SEGMENT_MS / CHUNK_MS;   // 20
/** 🔴 35 chunks = 7.0 s, chosen so EXACTLY ONE rollover happens. The first draft
 *  used 50 and the run produced TWO seams — the soft timer is re-armed when the
 *  rollover finishes, so a second one fired at 9.0 s and duplicated seq 45..49
 *  as well. That was a real observation, not noise: EVERY rollover carries a
 *  seam, so a 5-minute recording has ~10 of them. It is scoped down here so the
 *  assertion can NAME the duplicated span instead of counting anonymous extras. */
const TOTAL = 35;

interface SeamRun {
  merged: string;
  seamSeqs: number[];
  finals: ServerFinal[];
}

async function runRollover(corpus: Corpus, flushDelayMs: number, seamPolicy: SeamPolicy): Promise<SeamRun> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: 300_000,
  });
  session.start();
  const engines: TranscribingEngine[] = [];
  const orch = new SttEngineOrchestrator(
    session,
    () => {
      // finalEveryN: 0 — the flush IS the only final, which is both the Soniox
      // shape and the shape that makes the seam question crisp.
      const e = new TranscribingEngine(corpus, clock, { open: 'ok', finalEveryN: 0, flushDelayMs, seamPolicy });
      engines.push(e);
      return e;
    },
    {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: SOFT_SEGMENT_MS,
    },
  );
  const finals: ServerFinal[] = [];
  // Interims are recorded for the same reason as in stt-outage-loss.test.ts: the
  // phone's slot content is a function of BOTH channels (PhoneSegmentBuffer).
  const wire: WireFrame[] = [];
  orch.on('interim', (e: { segment_idx: number; text: string }) => wire.push({ kind: 'interim', segment_idx: e.segment_idx, text: e.text }));
  orch.on('final', (f: ServerFinal) => {
    finals.push({ segment_idx: f.segment_idx, is_segment: f.is_segment, text: f.text });
    wire.push({ kind: 'final', segment_idx: f.segment_idx, text: f.text });
  });
  orch.on('error', () => { /* none expected; a listener is mandatory on EventEmitter */ });
  await orch.start({ language: corpus.lang, mode: 'realtime' });

  for (let seq = 0; seq < TOTAL; seq++) {
    orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
    await clock.advance(CHUNK_MS);
  }
  // The TERMINAL flush also takes `flushDelayMs` on the fake clock, so stop()
  // cannot be awaited before the clock is moved — awaiting first deadlocks the
  // test rather than the product.
  const stopped = orch.stop();
  await clock.advance(flushDelayMs + 3_000);
  await stopped;
  return { merged: mergedFinalText(wire), seamSeqs: engines[0]!.seamSeqs, finals };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.2 — THE WIDTH. This is the half nobody could answer from the phone.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-3 seam §6.2 — how much audio lands in the seam (the number the phone cannot compute)', () => {
  /** flush latency → chunks that arrive after `finalizedSeq` was captured. */
  const SWEEP = [0, 200, 600, 1_000, 2_000, 2_600];

  for (const delay of SWEEP) {
    it(`flush latency ${delay} ms ⇒ seam is ${delay / CHUNK_MS} chunk(s) = ${delay} ms of speech`, async () => {
      const r = await runRollover(ZH, delay, 'vendor-excludes-late-audio');
      expect(r.seamSeqs).toHaveLength(delay / CHUNK_MS);
      // Named, not just counted: the seam is the run immediately after the
      // pre-flush boundary, so an off-by-one here is a different defect.
      expect(r.seamSeqs).toEqual(
        Array.from({ length: delay / CHUNK_MS }, (_, i) => SEG0_CHUNKS + i),
      );
    });
  }

  /**
   * 🔴 THE CEILING, and it is not a guess: the flush cap is
   * `DEFAULT_ENGINE_FLUSH_TIMEOUT_MS = 3_000` (5_000 for funasr/funspeech via
   * `resolveFlushTimeoutMs`). At the phone's 200 ms chunk period that is up to
   * 15 chunks — 3 seconds of speech — and up to 25 chunks / 5 s on the two
   * streaming engine families. Beyond the cap the flush is abandoned, which is a
   * different failure and not this one.
   */
  it('the seam cannot exceed the flush cap: ≤ 15 chunks (3 s) here, ≤ 25 (5 s) for funasr/funspeech', async () => {
    const r = await runRollover(ZH, 2_600, 'vendor-excludes-late-audio');
    expect(r.seamSeqs.length).toBeLessThanOrEqual(3_000 / CHUNK_MS);
    expect(r.seamSeqs.length).toBe(13);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * §6.1 — WHAT THE ANSWER IS WORTH. Same fault, same code, the ONE unverified
 * vendor property flipped.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('RT-3 seam §6.1 — today\'s correctness rests entirely on an unmeasured vendor property', () => {
  const DELAY = 1_000;
  const SEAM = DELAY / CHUNK_MS; // 5 chunks

  for (const corpus of [ZH, EN]) {
    it(`[${corpus.lang}] vendor EXCLUDES late audio (what F-2152 assumes) ⇒ the merged final is exact`, async () => {
      const r = await runRollover(corpus, DELAY, 'vendor-excludes-late-audio');
      expect(r.merged).toBe(corpus.spoken(TOTAL));
      // Two segments really were produced — otherwise this row proves nothing
      // about seams.
      expect(new Set(r.finals.map((f) => f.segment_idx)).size).toBeGreaterThan(1);
    });

    it(`[${corpus.lang}] vendor INCLUDES late audio ⇒ the merged final says the seam twice`, async () => {
      const r = await runRollover(corpus, DELAY, 'vendor-includes-late-audio');
      const spoken = corpus.spoken(TOTAL);
      expect(r.merged).not.toBe(spoken);
      expect(r.merged).toBe(corpus.slice(0, SEG0_CHUNKS + SEAM) + corpus.slice(SEG0_CHUNKS, TOTAL));
      expect(r.merged.length - spoken.length).toBe(corpus.slice(SEG0_CHUNKS, SEG0_CHUNKS + SEAM).length);
      // 🔴 Nothing on the wire distinguishes this run from the one above. The
      // phone receives two finals under two indices in both cases; the only
      // difference is inside the strings. That is §6.1 in one assertion.
      expect(r.finals.map((f) => f.segment_idx)).toEqual(
        (await runRollover(corpus, DELAY, 'vendor-excludes-late-audio')).finals.map((f) => f.segment_idx),
      );
    });
  }
});
