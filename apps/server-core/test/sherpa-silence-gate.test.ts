// REQ-13-19 — the silence-hallucination gates around sherpa-local's terminal
// decode (docs/strategy/2026-08-13-0263-requirements-backlog.md §REQ-13-19;
// measurements: scratch/q1-silence-hallucination-findings-2026-08-13.md).
//
// The native addon is NOT involved: `openRecognizer` is injected, so what this
// file proves is the GATE POLICY — when the decode is skipped, when its output
// is demoted to an empty final, and when it is left alone. What it CANNOT prove
// is that the real model hallucinates on silence — that is pinned engine-direct
// by scratch/_q1-engine-silence.mjs (production config, real addon, passing
// speech positive control). The two instruments answer different questions;
// neither substitutes for the other. unit tests all green prove nothing about wiring — the phone-side
// leg (a silent hold ends in the no-transcript notice, not a delivered "我")
// belongs to the device line.
//
// The failure directions are asymmetric and both assertions below encode that:
// a floor set too high silently eats soft speech (red line: no silent failure),
// a floor set too low delivers fiction to the user's editor (the defect). The
// floor-bracket case pins the constant between the measured hallucination band
// (peak ≤ 328 → "그") and a quiet room's ambient (peak 2136), so a casual
// retune in either direction goes red with the measurement in its face.
//
// 🔴 Reverse controls, actually seen red (2026-08-13, this machine), each by
// flipping the gate's condition to `if (false)`, then restored:
//   energy gate disabled → 2 failed: `expected '我.' to be ''` and
//     `expected '그.' to be ''` — the exact defect shape, fabricated words
//     from zero/near-zero-energy input;
//   content gate disabled → 1 failed: `expected '.' to be ''` — the in-situ
//     quiet-room delivery.

import { describe, expect, it } from 'vitest';
import type { FinalResult } from '../src/stt/engines/base';
import {
  SherpaLocalEngine,
  SILENCE_PEAK_ABS_FLOOR,
  hasLexicalContent,
  utterancePeakAbs,
  type OfflineRecognizer,
} from '../src/stt/engines/sherpa-local';

const SECOND_BYTES = 32_000; // 1s @ 16 kHz s16le

function pcmOfPeak(peak: number, bytes = SECOND_BYTES): Buffer {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes / 2; i += 1) b.writeInt16LE(i % 2 === 0 ? peak : -peak, i * 2);
  return b;
}

/** A rig whose recognizer answers every decode with `decodedText` and counts
 *  how often it was consulted. Preview decodes also land in the counter, so
 *  every case snapshots the count AFTER pushes and asserts the DELTA across
 *  flush() — the assertion is about the terminal decode only. */
async function makeRig(decodedText: string) {
  let decodes = 0;
  const rec: OfflineRecognizer = {
    createStream: () => ({ acceptWaveform: () => {} }),
    decode: () => { decodes += 1; },
    getResult: () => ({ text: decodedText }),
  };
  const eng = new SherpaLocalEngine(
    { id: 'sherpa-local', language: 'auto', sample_rate: 16_000 },
    { openRecognizer: async () => rec },
  );
  await eng.open();
  const finals: FinalResult[] = [];
  eng.on('final', (ev: FinalResult) => finals.push(ev));
  return { eng, finals, decodeCount: () => decodes };
}

describe('REQ-13-19 · the energy gate (pre-decode)', () => {
  it('pure zeros: the final is empty and the decoder is never consulted', async () => {
    const r = await makeRig('我.'); // what the real model answers on zeros
    r.eng.push(pcmOfPeak(0));
    const before = r.decodeCount();
    await r.eng.flush();
    expect(r.finals).toHaveLength(1);
    expect(r.finals[0]!.text).toBe('');
    // Skipping the decode IS the fix: on zero-energy input every token the
    // model would emit is fiction, so consulting it at all is the defect.
    expect(r.decodeCount() - before).toBe(0);
  });

  it('sub-floor noise (the measured 「그」 band, peak 300): same', async () => {
    const r = await makeRig('그.');
    r.eng.push(pcmOfPeak(300));
    const before = r.decodeCount();
    await r.eng.flush();
    expect(r.finals[0]!.text).toBe('');
    expect(r.decodeCount() - before).toBe(0);
  });

  it('speech-level audio decodes, and the text passes through verbatim', async () => {
    const r = await makeRig('跟你说个事啊，明天下午3点的。');
    r.eng.push(pcmOfPeak(8_000));
    const before = r.decodeCount();
    await r.eng.flush();
    expect(r.finals[0]!.text).toBe('跟你说个事啊，明天下午3点的。');
    expect(r.decodeCount() - before).toBe(1);
  });

  it('the floor sits between the hallucination band and quiet-room ambient', () => {
    // 328 = measured peak of the noise that hallucinated 「그」 (float amp 1e-2);
    // 2136 = a quiet ROOM's ambient peak. Below the first the gate is not doing
    // its job; at or above the second it starts eating rooms, and soft speech
    // is the next thing up. Both numbers are measurements, not preferences —
    // see the constant's own doc block for provenance.
    expect(SILENCE_PEAK_ABS_FLOOR).toBeGreaterThan(328);
    expect(SILENCE_PEAK_ABS_FLOOR).toBeLessThan(2136);
  });
});

describe('REQ-13-19 · the content gate (post-decode)', () => {
  it('punctuation-only decode (the in-situ 「.」) becomes an empty final', async () => {
    const r = await makeRig('.');
    r.eng.push(pcmOfPeak(8_000)); // loud enough that the energy gate passes it
    const before = r.decodeCount();
    await r.eng.flush();
    expect(r.finals[0]!.text).toBe('');
    // The decode DID run — this gate judges its output, not the audio.
    expect(r.decodeCount() - before).toBe(1);
  });

  it('lexical text keeps its punctuation — the gate demotes, never trims', async () => {
    const r = await makeRig('我.');
    r.eng.push(pcmOfPeak(8_000));
    await r.eng.flush();
    expect(r.finals[0]!.text).toBe('我.');
  });
});

describe('REQ-13-19 · the pure functions', () => {
  it('utterancePeakAbs reads the true peak, sign-independent', () => {
    const b = Buffer.alloc(8);
    b.writeInt16LE(12, 0);
    b.writeInt16LE(-500, 2);
    b.writeInt16LE(499, 4);
    b.writeInt16LE(0, 6);
    expect(utterancePeakAbs(b)).toBe(500);
    expect(utterancePeakAbs(Buffer.alloc(SECOND_BYTES))).toBe(0);
  });

  it('hasLexicalContent: letters and digits in any script count, punctuation does not', () => {
    expect(hasLexicalContent('.')).toBe(false);
    expect(hasLexicalContent('……')).toBe(false);
    expect(hasLexicalContent('')).toBe(false);
    expect(hasLexicalContent(' 。，!?')).toBe(false);
    expect(hasLexicalContent('我.')).toBe(true);
    expect(hasLexicalContent('그.')).toBe(true);
    expect(hasLexicalContent('a')).toBe(true);
    expect(hasLexicalContent('3.')).toBe(true);
  });
});
