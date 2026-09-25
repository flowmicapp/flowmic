// Card HANGUP-1 — the words a user says while a silence hang-up is still
// closing the leg must reach the transcript.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.3 (replay: a fresh leg is handed only
//     what no leg has heard) — the silence hang-up row
//   CLAUDE.md red line: no silent failure; owner「dropped characters are a veto」
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// A managed streaming leg is hung up after 3 s without voice (card RT-2). The
// hang-up FLUSHES first, and for Soniox a flush is the end-of-stream frame,
// answered by `{finished:true}` (`packages/stt-cloud/src/engines/soniox.ts`
// flush() doc). MEASURED on this card's live runs: 0.3–0.6 s from flush to
// close for a hang-up (the 2.0 s in that doc is a whole utterance's end). The
// leg stays `open` for that whole round trip, so a user who starts talking again inside it has their first
// words pushed into a stream that has already been told it is over. The vendor's
// final does not contain them, and the redial that follows replays only
// `seq > lastEngineFedSeq` — a counter those same pushes had already advanced.
// Net: the words exist nowhere and nothing says so.
//
// The segment rollover had the same exposure and was protected by F-2152 (take
// the seq boundary BEFORE the flush, rewind to it after). The hang-up path took
// no boundary and rewound nothing. See `orchestrator-rollover.ts`
// `takeFlushBoundary` / `rewindToFlushBoundary`, now shared by all three sites.
//
// ⚠️ A SECOND MECHANISM, SAME LOSS — AND THE ONE THE LIVE VENDOR HIT MOST. With
// no segment cut in play (a plain press-and-hold), the live runs lost 「大家好，」
// 6 of 6 times with the hang-up flush long finished: the REDIAL took ~1 s, the
// gate closed in the comma pause after 「大家好，」, and that withheld chunk moved
// the same high-water mark past the words still waiting for the new leg. The
// last case below pins it.
//
// ── WHY THIS RIG AND NOT stt-idle-hangup.test.ts's ──────────────────────────
// That rig flushes instantly, so the window this card is about is zero wide and
// the race can never happen there — every case in it is green on the defect.
// Here the flush takes FLUSH_MS on the fake clock, and speech is scripted to
// start inside it. Each case carries a positive control that the race really
// occurred (the flushing leg WAS handed the words — `seamSeqs`), so a green run
// cannot be a run in which the words simply never reached the danger zone.
//
// ⚠️ THE CORPUS RENDERS VOICED CHUNKS ONLY. The shared harness turns every chunk
// it is handed into a token, silence included, which is the right instrument
// when the gate guarantees silence is never handed over. A rewind hands the new
// leg the rewound range whole — silence and all — and a real recogniser writes
// nothing for silence; rendering it would report an insertion that no user sees.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { DEFAULT_ENGINE_IDLE_HANGUP_MS } from '../src/stt/orchestrator-types';
import {
  CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH,
  frame, mergedFinalText, type Corpus, type ServerFinal, type WireFrame,
} from './fixtures/stt-outage-harness';

/** The vendor's end-of-stream round trip, deliberately at the WIDE end (the
 *  L9 whole-utterance figure; a hang-up measured 0.3–0.6 s) so several chunks
 *  land inside it. Inside the 3 s flush cap, so the flush answers, not times out. */
const FLUSH_MS = 2_000;
/** 16 × 200 ms > 3000 ms: the hang-up fires inside this run (same arithmetic as
 *  stt-idle-hangup.test.ts `SILENCE_CHUNKS`). */
const SILENCE_CHUNKS = Math.floor(DEFAULT_ENGINE_IDLE_HANGUP_MS / CHUNK_MS) + 1;

function voicedOnly(base: Corpus, voiced: ReadonlySet<number>): Corpus {
  const render = (seqs: readonly number[]): string =>
    seqs.filter((s) => voiced.has(s)).map((s) => base.tokens[s % base.tokens.length]!).join('');
  const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);
  return { lang: base.lang, tokens: base.tokens, render, spoken: (n) => render(range(0, n)), slice: (a, b) => render(range(a, b)) };
}

interface Rig {
  readonly clock: FakeClock;
  readonly engines: TranscribingEngine[];
  readonly orch: SttEngineOrchestrator;
  readonly corpus: Corpus;
  speak(chunks: number): Promise<void>;
  quiet(chunks: number): Promise<void>;
  /** Release the button and let every timer the closing path arms run out. */
  release(): Promise<void>;
  merged(): string;
}

async function makeRig(opts: { flushMs: number; redialMs: number }): Promise<Rig> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000,
  });
  session.start();
  const voicedSeqs = new Set<number>();
  const corpus = voicedOnly(ZH, voicedSeqs);
  const engines: TranscribingEngine[] = [];
  let voiced = true;
  const orch = new SttEngineOrchestrator(
    session,
    () => {
      // finalEveryN: 0 — Soniox's shape: nothing is final until the flush.
      const e = new TranscribingEngine(corpus, clock, {
        open: 'ok', finalEveryN: 0, flushDelayMs: opts.flushMs,
        ...(engines.length > 0 ? { openDelayMs: opts.redialMs } : {}),
      });
      engines.push(e);
      return e;
    },
    {
      now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
      softSegmentMs: 600_000, // out of reach: this file is about the leg, not segmentation
      shouldFeedEngine: (): boolean => voiced,
      idleHangupMs: DEFAULT_ENGINE_IDLE_HANGUP_MS, // engine-factory.ts `gated` wiring
    },
  );
  const wire: WireFrame[] = [];
  orch.on('interim', (e: { segment_idx: number; text: string }) => wire.push({ kind: 'interim', segment_idx: e.segment_idx, text: e.text }));
  orch.on('final', (f: ServerFinal) => wire.push({ kind: 'final', segment_idx: f.segment_idx, text: f.text }));
  orch.on('error', () => { /* listener mandatory; errors are asserted where they matter */ });
  await orch.start({ language: corpus.lang, mode: 'realtime' });

  let seq = 0;
  const pump = async (chunks: number): Promise<void> => {
    for (let i = 0; i < chunks; i++) {
      if (voiced) voicedSeqs.add(seq);
      orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
      seq += 1;
      await clock.advance(CHUNK_MS);
    }
  };
  return {
    clock, engines, orch, corpus,
    speak: async (n) => { voiced = true; await pump(n); },
    quiet: async (n) => { voiced = false; await pump(n); },
    release: async () => { const p = orch.stop(); await clock.advance(20_000); await p; },
    merged: () => mergedFinalText(wire),
  };
}

/* Seq map shared by the cases below (one chunk = 200 ms):
 *   0..9    speech          — the leg's last fed chunk is 9, so the hang-up is
 *                             due 3 s later and its flush runs FLUSH_MS from there
 *   10..25  silence         — the hang-up fires inside this run
 *   26..    speech again    — starts INSIDE the flush round trip             */

describe('HANGUP-1 — speech that starts while a silence hang-up is flushing', () => {
  it('🔴 the resumed words reach the transcript when the user keeps talking', async () => {
    const rig = await makeRig({ flushMs: FLUSH_MS, redialMs: 0 });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);   // hang-up fires; its flush is now in flight
    await rig.speak(5);                // 26..30 — inside the flush
    await rig.quiet(5);                // the hang-up completes in here
    await rig.speak(5);                // 36..40 — the voice is plainly back
    await rig.release();

    // RACE CONTROL: the flushing leg really was handed the resumed words — the
    // exact condition of the defect. Without this a green result could be a run
    // in which the words arrived after the hang-up, where nothing was ever wrong.
    expect(rig.engines[0]!.seamSeqs).toEqual([26, 27, 28, 29, 30]);
    // POSITIVE CONTROL: what was said BEFORE the pause is there, so an empty or
    // truncated result below is not a blind instrument.
    expect(rig.merged().startsWith(rig.corpus.slice(0, 10))).toBe(true);
    // THE CLAIM: every voiced chunk, once, in order.
    expect(rig.merged()).toBe(rig.corpus.slice(0, 41));
  });

  it('🔴 the resumed words reach the transcript even if the user then goes quiet for good', async () => {
    // No later voice arrives to trigger a redial. The words spoken inside the
    // flush are the only thing owed, so the hang-up itself must dial for them.
    const rig = await makeRig({ flushMs: FLUSH_MS, redialMs: 0 });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);
    await rig.speak(5);                // 26..30 — inside the flush
    await rig.quiet(SILENCE_CHUNKS * 3);
    await rig.release();

    expect(rig.engines[0]!.seamSeqs).toEqual([26, 27, 28, 29, 30]); // race control
    expect(rig.merged()).toBe(rig.corpus.slice(0, 31));
  });

  it('🔴 the resumed words reach the transcript when the button is released while the hang-up is still flushing', async () => {
    const rig = await makeRig({ flushMs: FLUSH_MS, redialMs: 0 });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);
    await rig.speak(3);                // 26..28 — inside the flush…
    await rig.release();               // …and released before it answers

    expect(rig.engines[0]!.seamSeqs).toEqual([26, 27, 28]); // race control
    expect(rig.merged()).toBe(rig.corpus.slice(0, 29));
  });
});

describe('HANGUP-1 — a short word after the hang-up, while the redial is still connecting', () => {
  it('🔴 a silent chunk behind the word does not mark the word as heard', async () => {
    // The hang-up has completed (instant flush). The user says a two-chunk word;
    // the first chunk dials, the dial takes 600 ms, and the gate closes behind
    // the word before the new leg is up. The withheld chunk used to advance the
    // same high-water mark the redial replays from — past the word.
    const rig = await makeRig({ flushMs: 0, redialMs: 600 });
    await rig.speak(10);
    await rig.quiet(SILENCE_CHUNKS);   // hung up
    expect(rig.engines.length).toBe(1);
    await rig.speak(2);                // 26, 27 — the dial starts on 26
    // RACE CONTROL: the new leg exists and is still connecting as the next
    // (silent) chunk arrives, so the word has to wait for the replay.
    expect(rig.engines.length).toBe(2);
    expect(rig.engines[1]!.state).not.toBe('open');
    await rig.quiet(SILENCE_CHUNKS * 2);
    await rig.release();

    expect(rig.merged()).toBe(rig.corpus.slice(0, 28));
  });
});
