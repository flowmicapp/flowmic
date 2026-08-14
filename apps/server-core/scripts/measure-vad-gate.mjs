// WP-R1-3 re-runnable VAD-gate measurement (master-plan §2.3): billed
// streaming-session ms / voiced-audio ms ≤ 1.3. Builds a test signal from the
// spike's REAL 16k-mono speech WAVs (zh.wav + en.wav) padded with synthetic
// silence, runs the production VadGate, and prints the ratio.
//
// Run:  node --experimental-strip-types scripts/measure-vad-gate.mjs
//   (imports the real src/stt/vad-gate.ts — no logic duplication.)
// Optional: FLOWMIC_VAD_WAV_DIR overrides the WAV source dir.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VadGate } from '../src/stt/vad-gate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAV_DIR = process.env.FLOWMIC_VAD_WAV_DIR
  ?? join(HERE, '..', '..', '..', 'scratch', 'spike-sherpa', 'models',
          'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', 'test_wavs');

/** Read a 16k mono s16le WAV and return the PCM body (skip the 44-byte header). */
function wavPcm(path) {
  const buf = readFileSync(path);
  // Find the 'data' chunk (canonical header is 44 bytes; be defensive).
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  return buf.subarray(44);
}
const silence = (ms) => Buffer.alloc(((16_000 * ms) / 1000) * 2);
const pcmMs = (pcm) => (pcm.length / 2 / 16_000) * 1000;

function main() {
  const zhPath = join(WAV_DIR, 'zh.wav');
  const enPath = join(WAV_DIR, 'en.wav');
  if (!existsSync(zhPath) || !existsSync(enPath)) {
    console.error(`SKIP: WAVs not found in ${WAV_DIR} (run the sherpa spike download, or set FLOWMIC_VAD_WAV_DIR).`);
    process.exit(2);
  }
  const zh = wavPcm(zhPath);
  const en = wavPcm(enPath);
  // Signal: [zh speech][8s silence][en speech][8s silence] — the long silences
  // are what a naive always-open streaming session would bill for nothing.
  const parts = [zh, silence(8_000), en, silence(8_000)];
  const audio = Buffer.concat(parts);

  const gate = new VadGate({ hangoverMs: 300, thresholdDb: -45 });
  // Feed in 200ms chunks (the mobile chunk cadence, 06 §1).
  const chunkBytes = ((16_000 * 200) / 1000) * 2;
  for (let off = 0; off < audio.length; off += chunkBytes) gate.process(audio.subarray(off, off + chunkBytes));
  gate.finish();

  const totalMs = pcmMs(audio);
  const ratio = gate.ratio();
  console.log('=== VAD gate measurement (managed streaming session) ===');
  console.log(`wav dir           : ${WAV_DIR}`);
  console.log(`zh speech         : ${pcmMs(zh).toFixed(0)} ms`);
  console.log(`en speech         : ${pcmMs(en).toFixed(0)} ms`);
  console.log(`total audio       : ${totalMs.toFixed(0)} ms (incl. 16000 ms inserted silence)`);
  console.log(`voiced audio      : ${gate.voicedMs.toFixed(0)} ms`);
  console.log(`billed session    : ${gate.sessionMs.toFixed(0)} ms`);
  console.log(`RATIO session/voiced = ${ratio.toFixed(3)}  (target ≤ 1.30)`);
  console.log(ratio <= 1.3 ? 'PASS ✅' : 'FAIL ❌');
  process.exit(ratio <= 1.3 ? 0 : 1);
}

main();
