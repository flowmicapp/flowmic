// WP-R1-3 VAD gate tests (master-plan §2.3): the billed-session / voiced-audio
// ratio stays ≤ 1.3, silence never opens a billed session, and the amplitude
// meter tracks the last frame. Deterministic synthetic PCM (sine = speech,
// zeros = silence) — the LAN-independent counterpart of the measure script.

import { describe, expect, it } from 'vitest';
import { VadGate } from '../src/stt/vad-gate';

const SR = 16_000;
function sinePcm(ms: number, amp = 0.3, freq = 440): Buffer {
  const n = (SR * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / SR)), i * 2);
  return b;
}
const silencePcm = (ms: number): Buffer => Buffer.alloc(((SR * ms) / 1000) * 2);

describe('VadGate — billed-session / voiced-audio ratio (≤ 1.3)', () => {
  it('keeps ratio ≤ 1.3 on speech separated by long silence', () => {
    const gate = new VadGate({ hangoverMs: 300, thresholdDb: -45 });
    const audio = Buffer.concat([
      sinePcm(2000), silencePcm(4000), sinePcm(3000), silencePcm(4000),
    ]);
    gate.process(audio);
    gate.finish();
    expect(gate.voicedMs).toBe(5000);          // exactly the two speech spans
    expect(gate.ratio()).toBeGreaterThan(1.0);  // some hangover overhead
    expect(gate.ratio()).toBeLessThanOrEqual(1.3);
    expect(gate.sessionMs).toBeLessThan(6000);  // silence excluded from billing
  });

  it('opens no billed session for a silence-only stream', () => {
    const gate = new VadGate({ hangoverMs: 300, thresholdDb: -45 });
    gate.process(silencePcm(5000));
    gate.finish();
    expect(gate.open).toBe(false);
    expect(gate.voicedMs).toBe(0);
    expect(gate.sessionMs).toBe(0);
    expect(gate.ratio()).toBe(1); // defined as 1 when nothing was billed
  });

  it('tracks the last-frame amplitude (loud speech >> silence)', () => {
    const gate = new VadGate();
    gate.process(sinePcm(100, 0.5));
    const loud = gate.lastAmplitudeDb;
    gate.process(silencePcm(100));
    const quiet = gate.lastAmplitudeDb;
    expect(loud).toBeGreaterThan(-30);
    expect(quiet).toBeLessThan(-90);
    expect(loud).toBeGreaterThan(quiet);
  });

  it('re-opens across chunk boundaries (residual carry) without losing frames', () => {
    const gate = new VadGate({ hangoverMs: 200, thresholdDb: -45 });
    // Feed in odd-sized chunks to exercise the residual buffer.
    const full = Buffer.concat([sinePcm(500), silencePcm(1000), sinePcm(500)]);
    for (let off = 0; off < full.length; off += 999) gate.process(full.subarray(off, off + 999));
    gate.finish();
    expect(gate.voicedMs).toBeGreaterThanOrEqual(950); // ~1000ms voiced (± a frame)
    expect(gate.ratio()).toBeLessThanOrEqual(1.3);
  });
});
