// card RC-5a — a row cut decided on a chunk the gate withheld must not leave the
// next syllable's onset below the replay boundary.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (HANGUP-1 seam bullet, RC-5a block)
//   docs/strategy/2026-09-24-cr12e-defects-root-cause.md §3.1
//
// ── THE DEFECT, MEASURED ────────────────────────────────────────────────────
// CR-12-E A2: 「…事」 ends at 53.2 s, digital silence, 「是」 starts at 53.85 s.
// The pause cut was decided on a withheld chunk, every withheld chunk had already
// pushed the replay mark past itself, so the new leg started after the chunk
// holding the onset — and Soniox, probed with the same audio started 50 ms late,
// deletes the whole syllable (root-cause §3.1). Row N+1 read 「关于周末…」.
//
// ── THE RIG ─────────────────────────────────────────────────────────────────
// The harness engine transcribes every chunk it is handed; the corpus renders
// only chunks that carry SPEECH. That lets one chunk be both 「the gate called it
// silence」 and 「it holds the onset」 — which is the whole shape. The gate is
// scripted per chunk (`shouldFeedEngine`), the flush takes a realistic round
// trip, and the cadence is 2 s so a cut lands inside the test.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { PAUSE_CUT_REPLAY_MAX_MS } from '../src/stt/pause-cut-boundary';
import {
  CHUNK_MS, FakeClock, T0, TranscribingEngine, ZH,
  frame, mergedFinalText, type Corpus, type ServerFinal, type WireFrame,
} from './fixtures/stt-outage-harness';

function speechOnly(base: Corpus, speech: ReadonlySet<number>): Corpus {
  const render = (seqs: readonly number[]): string =>
    seqs.filter((s) => speech.has(s)).map((s) => base.tokens[s % base.tokens.length]!).join('');
  const range = (a: number, b: number): number[] => Array.from({ length: b - a }, (_, i) => a + i);
  return { lang: base.lang, tokens: base.tokens, render, spoken: (n) => render(range(0, n)), slice: (a, b) => render(range(a, b)) };
}

/** Each chunk: does it hold speech, and does the gate let it through. */
type Chunk = { speech: boolean; gate: boolean };
const SPEAK: Chunk = { speech: true, gate: true };
const QUIET: Chunk = { speech: false, gate: false };
/** The shape: the onset sits at the end of the chunk, the gate calls it silence. */
const ONSET: Chunk = { speech: true, gate: false };

async function run(script: Chunk[]): Promise<{ engines: TranscribingEngine[]; merged: string; rows: ServerFinal[]; corpus: Corpus }> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 300_000 });
  session.start();
  const speech = new Set<number>();
  script.forEach((c, i) => { if (c.speech) speech.add(i); });
  const corpus = speechOnly(ZH, speech);
  const engines: TranscribingEngine[] = [];
  let gate = true;
  const orch = new SttEngineOrchestrator(session, () => {
    // 400 ms: a Soniox end-of-stream round trip (book 06 §3 RC-5b block measured 0.6–0.8 s at the end of a 55 s stream).
    const e = new TranscribingEngine(corpus, clock, { open: 'ok', finalEveryN: 0, flushDelayMs: 400 });
    engines.push(e);
    return e;
  }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 2_000, softSegmentGraceMs: 15_000,
    shouldFeedEngine: (): boolean => gate,
  });
  const wire: WireFrame[] = [];
  const rows: ServerFinal[] = [];
  orch.on('interim', (e: { segment_idx: number; text: string }) => wire.push({ kind: 'interim', segment_idx: e.segment_idx, text: e.text }));
  orch.on('final', (f: ServerFinal) => { wire.push({ kind: 'final', segment_idx: f.segment_idx, text: f.text }); if (f.is_segment) rows.push(f); });
  orch.on('error', () => { /* listener mandatory */ });
  await orch.start({ language: corpus.lang, mode: 'realtime' });
  for (let seq = 0; seq < script.length; seq++) {
    gate = script[seq]!.gate;
    orch.pushChunk({ seq, ts_ms: clock.now, payload: frame(seq) });
    await clock.advance(CHUNK_MS);
  }
  const stopped = orch.stop();
  await clock.advance(5_000);
  await stopped;
  return { engines, merged: mergedFinalText(wire), rows, corpus };
}

const times = (n: number, c: Chunk): Chunk[] => Array.from({ length: n }, () => c);

describe('RC-5a — the pause cut replays the tail of the closed run it stood on', () => {
  it('🔴 the onset hidden in the withheld chunk the cut was decided on reaches the new leg', async () => {
    // 0..11 speech (past the 2 s deadline), 12..14 quiet, 15 = onset the gate
    // withholds (the gate has now been closed 600 ms ⇒ the cut is decided ON it),
    // then 16..20 the rest of the word and sentence.
    const r = await run([...times(12, SPEAK), ...times(3, QUIET), ONSET, ...times(5, SPEAK)]);
    // POSITIVE CONTROL — the cut really happened, on a pause, after chunk 11's words.
    expect(r.rows.map((f) => f.text)).toEqual([r.corpus.slice(0, 12)]);
    expect(r.engines.length).toBeGreaterThanOrEqual(2);
    // THE MECHANISM — the new leg is handed the withheld tail first, onset included.
    expect(r.engines[1]!.heard.slice(0, 4)).toEqual([12, 13, 14, 15]);
    // THE CLAIM — nothing the speaker said is missing.
    expect(r.merged).toBe(r.corpus.slice(0, 21));
  });

  it(`a run that began long before the deadline is replayed only in its last ${PAUSE_CUT_REPLAY_MAX_MS} ms`, async () => {
    // 0..4 speech (1 s), then quiet from 1 s: the 2 s deadline arrives with the
    // gate already closed 1 s ⇒ the cut is decided on chunk 10, the run is 5..10
    // (1.2 s) and only its last 1 s (6..10) is handed over.
    const r = await run([...times(5, SPEAK), ...times(5, QUIET), ONSET, ...times(4, SPEAK)]);
    expect(r.rows.map((f) => f.text)).toEqual([r.corpus.slice(0, 5)]);
    expect(r.engines[1]!.heard[0]).toBe(6);
    expect(r.engines[1]!.heard).not.toContain(5);
    expect(r.merged).toBe(r.corpus.slice(0, 15));
  });

  it('NEGATIVE CONTROL — no withheld run, no cut: every chunk reaches leg 0 exactly once', async () => {
    // No pause at all: no cut happens; every chunk goes to leg 0 exactly once.
    const r = await run(times(15, SPEAK));
    expect(r.rows).toEqual([]);
    expect(r.engines[0]!.heard).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });
});
