// NR-103: retained PCM is local-only; no human recording is added to git.
// Percentages mean admitted RECORDING time, not annotated speech recall.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VadGate } from '../src/stt/vad-gate';
import { SttSessionBridge } from '../src/engine/stt-session';
import { makeSttOrchestratorFactory } from '../src/stt/engine-factory';
import { managedDefaultRouting } from '../src/stt/managed-default';
import type { SettingsRepo } from '../src/db/repos/settings.repo';
import type { EngineState, SttEngine } from '../src/stt/engines/base';
import { FakeClock, T0, drain } from './fixtures/stt-outage-harness';

const FRAME_BYTES = 640;
const CHUNK_BYTES = 6400;
const zeros = (ms: number): Buffer => Buffer.alloc(ms * 32);
function tone(ms: number, db: number): Buffer {
  const pcm = zeros(ms);
  const amplitude = 32768 * Math.sqrt(2) * 10 ** (db / 20);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2);
  return pcm;
}
// Seeded uniform room hiss. Not a recording or a speech/noise classifier.
function hiss(ms: number, db: number): Buffer {
  const pcm = zeros(ms); let seed = 103;
  const amplitude = 32768 * Math.sqrt(3) * 10 ** (db / 20);
  for (let i = 0; i < pcm.length / 2; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pcm.writeInt16LE(Math.round(amplitude * (seed / 2 ** 31 - 1)), i * 2);
  }
  return pcm;
}

// Independent frozen -45 dBFS / 300 ms baseline, including final-frame chunk
// selection. No adaptive constants or decisions are shared with production.
function baseline(pcm: Buffer): { framePct: number; chunkPct: number } {
  let open = false, silenceMs = 0, frames = 0, acceptedBytes = 0;
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    const end = Math.min(pcm.length, off + CHUNK_BYTES);
    for (let f = off; f + FRAME_BYTES <= end; f += FRAME_BYTES) {
      let square = 0;
      for (let s = f; s < f + FRAME_BYTES; s += 2) square += (pcm.readInt16LE(s) / 32768) ** 2;
      if (10 * Math.log10(square / 320) > -45) { open = true; silenceMs = 0; }
      else if (open) { silenceMs += 20; if (silenceMs >= 300) open = false; }
      if (open) frames++;
    }
    if (open) acceptedBytes += end - off;
  }
  return { framePct: frames * 20 / (pcm.length / 32) * 100, chunkPct: acceptedBytes / pcm.length * 100 };
}
function measure(name: string, pcm: Buffer): { framePct: number; chunkPct: number } {
  const gate = new VadGate(); let accepted = 0;
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    const chunk = pcm.subarray(off, off + CHUNK_BYTES);
    gate.process(chunk);
    if (gate.admitChunk) accepted += chunk.length;
  }
  gate.finish();
  const after = { framePct: gate.sessionMs / (pcm.length / 32) * 100, chunkPct: accepted / pcm.length * 100 };
  console.log('NR103', JSON.stringify({ name, durationMs: pcm.length / 32, before: baseline(pcm), after }));
  return after;
}

const evidence = process.env.NR103_FIXTURE_DIR ?? fileURLToPath(new URL('../../../../lane-a/.local/cr12e/evidence/', import.meta.url));
const captures = [
  { name: 'quiet material A', file: 'r4-E3q-prestop-a2-1790261734711784-r1790261734717779.pcm', sha256: 'bbae9eb72be66a9289faa773d2680be942af857657311eb3cfaca36a95d45f8a', target: 65 },
  { name: 'noisy material A', file: 'r4-E3n-prestop-a4-1790262974651555-r1790262974664653.pcm', sha256: 'fe9414736f28ab91fc12b4cc1df55c675c707d398b95cc2660e5aa75c62ff3f5', target: 63 },
];
describe('NR-103 retained 16 kHz mono s16le captures (local; explicit skip if unavailable)', () => {
  for (const capture of captures) {
    const path = resolve(evidence, capture.file);
    it.skipIf(!existsSync(path))(`${capture.name}: admitted recording time >= ${capture.target}%`, () => {
      const pcm = readFileSync(path);
      expect(createHash('sha256').update(pcm).digest('hex')).toBe(capture.sha256);
      expect(measure(capture.name, pcm).framePct).toBeGreaterThanOrEqual(capture.target);
    });
  }
});

describe('NR-103 adaptive gate controls', () => {
  it('digital silence never opens the gate', () => {
    expect(measure('digital silence', zeros(60000))).toEqual({ framePct: 0, chunkPct: 0 });
  });
  it('near-silence after digital zero never opens the gate (absolute floor)', () => {
    expect(measure('zero then -80 dBFS hiss', Buffer.concat([zeros(2000), hiss(58000, -80)])))
      .toEqual({ framePct: 0, chunkPct: 0 });
  });
  for (const leadingSilence of [0, 2000]) {
    it(`seeded -55 dBFS room hiss, ${leadingSilence} ms leading silence: <=3% admission`, () => {
      const result = measure(`room hiss, lead ${leadingSilence}`, Buffer.concat([zeros(leadingSilence), hiss(60000 - leadingSilence, -55)]));
      expect(result.framePct).toBeLessThanOrEqual(3);
      expect(result.chunkPct).toBeLessThanOrEqual(3);
    });
  }
  it('normal-volume speech preserves every frame admitted by the fixed gate', () => {
    const wav = readFileSync(new URL('../../mobile/integration_test/fixtures/zh-6s.wav', import.meta.url));
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    const pcm = wav.subarray(44);
    const after = measure('normal zh-6s', pcm);
    // The recording includes low-energy edges: preserving them adds 80 ms.
    // "Unchanged" here means no loss of previously admitted speech or PCM
    // modification, not requiring the newly recovered quiet edges to vanish.
    expect(after.framePct).toBeGreaterThanOrEqual(baseline(pcm).framePct);
    const gate = new VadGate();
    const frames = gate.process(pcm);
    let oldOpen = false, oldQuietMs = 0;
    for (const frame of frames) {
      if (frame.amplitudeDb > -45) { oldOpen = true; oldQuietMs = 0; }
      else if (oldOpen) { oldQuietMs += 20; if (oldQuietMs >= 300) oldOpen = false; }
      if (oldOpen) expect(frame.gateOpen).toBe(true);
    }
  });
  it('normal-volume synthetic speech preserves every voiced frame and 300 ms closure', () => {
    const normal = tone(2000, -25);
    expect(measure('normal steady tone', normal)).toEqual(baseline(normal));
    const gate = new VadGate();
    const speech = gate.process(normal);
    expect(speech.every(f => f.voiced && f.gateOpen)).toBe(true);
    const tail = gate.process(zeros(300));
    expect(tail.filter(f => f.gateOpen)).toHaveLength(14);
    expect(gate.open).toBe(false);
    expect(gate.admitChunk).toBe(true);
  });
  it('quiet startup, dips, chunk shifts and a partial final frame retain speech', () => {
    const pcm = Buffer.concat([tone(200, -56), zeros(100), tone(200, -56), zeros(200), tone(200, -56), tone(10, -50)]);
    const aligned = new VadGate(); aligned.process(pcm); aligned.finish();
    for (const size of [6400, 999, 137]) {
      const gate = new VadGate();
      for (let off = 0; off < pcm.length; off += size) gate.process(pcm.subarray(off, off + size));
      gate.finish();
      expect(gate.sessionMs).toBe(aligned.sessionMs);
      expect(gate.voicedMs).toBe(aligned.voicedMs);
    }
    expect(aligned.sessionMs).toBe(910);
  });
});

class RecordingEngine extends EventEmitter implements SttEngine {
  readonly id = 'deepgram' as const;
  state: EngineState = 'closed';
  readonly chunks: Buffer[] = [];
  get ackedAudioMs(): number { return this.chunks.reduce((n, b) => n + b.length / 32, 0); }
  async open(): Promise<void> { this.state = 'open'; }
  push(chunk: Buffer): void { this.chunks.push(Buffer.from(chunk)); }
  async flush(): Promise<void> { this.emit('final', { kind: 'final', text: 'ok', confidence: 1, language: 'zh', duration_ms: 0 }); }
  async close(): Promise<void> { this.state = 'closed'; }
}

it('NR-103 production bridge/factory: quiet PCM and closing-chunk padding reach the engine; rejected pre-roll stays unbilled', async () => {
  const clock = new FakeClock(T0); const engines: RecordingEngine[] = []; let billed = -1;
  const settings: SettingsRepo = { readAll: () => [], read: () => null, write: () => { throw new Error('unused'); }, remove: () => false };
  const build = makeSttOrchestratorFactory({
    settings, mode: 'saas',
    managedDefault: () => managedDefaultRouting({ FLOWMIC_MANAGED_STT_ENABLED: '1', FLOWMIC_MANAGED_STT_ENGINE: 'deepgram', FLOWMIC_MANAGED_STT_API_KEY: 'test' }),
    engineFactory: () => { const engine = new RecordingEngine(); engines.push(engine); return engine; },
    orchestratorOptions: { now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout },
  });
  const bridge = new SttSessionBridge({ build, emitter: { emit: () => {} }, userId: 'u', mode: 'realtime', sourceLang: 'zh',
    onComplete: ms => { billed = ms; }, levelIntervalMs: 0, now: clock.nowFn });
  await drain();
  // 600 ms rejected; 400 ms pre-roll; quiet onset; 200 ms padding then 80 ms
  // padding at the start of the closing chunk. The final 200 ms is rejected.
  const chunks = [zeros(200), zeros(200), zeros(200), tone(200, -56), zeros(200), zeros(200), zeros(200)];
  for (const [seq, pcm] of chunks.entries()) {
    bridge.pushChunk(seq, pcm.toString('base64'), clock.now);
    await clock.advance(200);
  }
  const finishing = bridge.finish(); await clock.advance(10000); await finishing;
  expect(engines).toHaveLength(1);
  expect(Buffer.concat(engines[0]!.chunks)).toEqual(Buffer.concat(chunks.slice(1, 6)));
  // Existing min(gate-open time, unique accepted+answered time): 200+280.
  // Pre-roll is delivered but was rejected, so it cannot increase allowance.
  expect(billed).toBe(480);
});
