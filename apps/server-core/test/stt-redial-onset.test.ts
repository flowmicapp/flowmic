// card RC-E (second half) — in a LONG RECORDING the redial after a silence hang-up
// hears the closed run's last ≤1 s, so a word whose onset sits in the tail of a chunk
// the gate still called silence is not lost.
//
// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (RC-E block, 「重拨吃 RC-5a 的尾巴」)
//   docs/strategy/2026-09-24-cr12e-rerun-root-cause.md §3.3 E3 (「琥珀」 → 「霍」 / nothing
//     / 「如果你好」, all at a hang-up redial), §7 RC-E
//   apps/server-core/src/stt/pause-cut-boundary.ts (RC-5a: the same tail, for a row cut)
//
// The word model is `fixtures/stt-word-leg.ts`: a word is transcribed only if its
// leg was handed the chunk holding its START, and the gate calls a chunk voice only
// if a word covers ≥150 ms of it. The word here starts 120 ms before the end of its
// chunk, so that chunk is withheld as silence and the NEXT chunk is the one that
// brings the voice back and dials the leg — the E3 shape exactly.
// REVERSE CONTROL (card RC-E): the redial without the tail (`takeRedialOnsetTail`
// not called) reds the 🔴 case — the leg starts at the dialling chunk and the word
// is gone. Follow-up: the tail re-scoped to long recordings only reds the
// push-to-talk row. See the card's report for the logs.

import { describe, expect, it } from 'vitest';
import { AudioSession } from '../src/stt/audio/session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import { FakeClock, T0 } from './fixtures/stt-outage-harness';
import { CHUNK_BYTES, CHUNK_MS, OPEN_MS, WordLeg, chunkOf, gateSaysVoice, tok, words, type Word } from './fixtures/stt-word-leg';

// Words to 12.0 s; silence (the 3 s hang-up fires ~14.85 s, the row is ~15 s old and
// ends there); one word starting at 15.48 s — its onset is the last 120 ms of chunk 77;
// then words on the grid from 16.2 s.
const before = words(0, 12_000);
const onset: Word = { i: before.length, s: 15_480, e: 15_800 }; // ends on the grid: only its ONSET is the question here
const after = words(16_200, 20_000, before.length + 1);
const WS: readonly Word[] = [...before, onset, ...after];
const ONSET_CHUNK = chunkOf(onset.s);

async function run(continuous: boolean): Promise<{ legs: WordLeg[]; all: string }> {
  const clock = new FakeClock(T0);
  const session = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, hardLimitMs: 600_000 });
  session.start();
  const legs: WordLeg[] = [];
  const orch = new SttEngineOrchestrator(session, () => { const l = new WordLeg(WS, clock); legs.push(l); return l; }, {
    now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout,
    softSegmentMs: 30_000, softSegmentGraceMs: 15_000, engineFlushTimeoutMs: 3_000, idleHangupMs: 3_000,
    ...(continuous ? { continuous: true, reconnectUnbounded: true } : {}),
    shouldFeedEngine: (c) => gateSaysVoice(WS, c.seq),
  });
  const texts: string[] = [];
  orch.on('final', (f: { text: string }) => texts.push(f.text));
  for (const e of ['error', 'engine-status', 'interim', 'error-suppressed']) orch.on(e, () => { /* listeners mandatory */ });
  const started = orch.start({ language: 'zh', mode: 'realtime' });
  await clock.advance(OPEN_MS);
  await started;
  for (let seq = 0; seq * CHUNK_MS < 20_000; seq++) {
    const payload = Buffer.alloc(CHUNK_BYTES);
    payload.writeUInt32LE(seq, 0);
    orch.pushChunk({ seq, ts_ms: clock.now, payload });
    await clock.advance(CHUNK_MS);
  }
  const stopped = orch.stop();
  await clock.advance(5_000);
  await stopped;
  return { legs, all: texts.join('') };
}

// Follow-up (MAIN, 2026-09-24): the tail is a word-loss fix, not a cut rule, so push-to-talk
// takes it too — the same sequence with `continuous` absent keeps the onset.
describe.each([['long recording', true], ['push-to-talk (continuous absent)', false]] as const)('RC-E — the redial after a hang-up takes the closed run\'s tail: %s', (_name, continuous) => {
  it('🔴 the onset sits in a withheld chunk ⇒ the redialled leg is handed that chunk first, and the word survives', async () => {
    // The rig's own premise, checked rather than assumed: the onset chunk is silence to
    // the gate and the chunk after it is voice.
    expect(gateSaysVoice(WS, ONSET_CHUNK)).toBe(false);
    expect(gateSaysVoice(WS, ONSET_CHUNK + 1)).toBe(true);
    const r = await run(continuous);
    // POSITIVE CONTROL: a hang-up and a redial happened (a second leg exists).
    expect(r.legs.length).toBeGreaterThanOrEqual(2);
    const redial = r.legs[r.legs.length - 1]!;
    expect(redial.seqs[0]).toBeLessThanOrEqual(ONSET_CHUNK);
    expect(redial.seqs).toContain(ONSET_CHUNK);
    // …and never more than the ≤1 s tail of silence (five 200 ms chunks).
    expect(ONSET_CHUNK - redial.seqs[0]!).toBeLessThan(5);
    expect(r.all).toContain(tok(onset));
    expect(r.all).toBe(WS.map(tok).join(''));
  });
});
