// WP-R1-3 LIVE transcription checks — reuse the REAL engine classes (no
// duplication). Gated so the normal suite stays fast/offline:
//   - sherpa-local runs when FLOWMIC_SHERPA_MODEL_DIR points at a model
//     (reuse the spike's 228 MB int8 model).
//   - LAN funasr / sensevoice run when FLOWMIC_LAN_SMOKE=1 AND the office
//     endpoint is reachable; otherwise the case SKIPs (endpoints are
//     owner-network only — SKIP honestly, never fabricate a transcript).

import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SherpaLocalEngine } from '../src/stt/engines/sherpa-local';
import { FunasrEngine } from '../src/stt/engines/funasr';
import { CustomOpenAiCompatibleEngine } from '../src/stt/engines/custom-openai-compatible';
import type { SttEngine } from '../src/stt/engines/base';

function wavPcm(path: string): Buffer {
  const buf = readFileSync(path);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  return buf.subarray(44);
}

async function transcribeOnce(engine: SttEngine & EventEmitter, pcm: Buffer): Promise<string> {
  let text = '';
  engine.on('final', (e: { text: string }) => { text = e.text; });
  if (engine.open) await engine.open();
  // push in 200ms (6400-byte) chunks like the mobile client
  for (let off = 0; off < pcm.length; off += 6400) engine.push(pcm.subarray(off, off + 6400), off);
  await engine.flush();
  await engine.close();
  return text;
}

function reachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean): void => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

const SHERPA_DIR = process.env.FLOWMIC_SHERPA_MODEL_DIR;
const RUN_SHERPA = !!SHERPA_DIR && existsSync(join(SHERPA_DIR, 'model.int8.onnx'));
const RUN_LAN = process.env.FLOWMIC_LAN_SMOKE === '1';

describe.skipIf(!RUN_SHERPA)('sherpa-local (built-in) — live', () => {
  it('transcribes zh.wav to non-empty Chinese text', async () => {
    const engine = new SherpaLocalEngine({ id: 'sherpa-local', language: 'zh', sample_rate: 16_000 });
    const text = await transcribeOnce(engine, wavPcm(join(SHERPA_DIR!, 'test_wavs', 'zh.wav')));
    console.log('[sherpa-local zh]', JSON.stringify(text));
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  it('transcribes en.wav to non-empty text', async () => {
    const engine = new SherpaLocalEngine({ id: 'sherpa-local', language: 'en', sample_rate: 16_000 });
    const text = await transcribeOnce(engine, wavPcm(join(SHERPA_DIR!, 'test_wavs', 'en.wav')));
    console.log('[sherpa-local en]', JSON.stringify(text));
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!RUN_LAN)('LAN funasr (ws://100.64.7.68:10095) — live', () => {
  it('transcribes zh.wav or SKIPs on unreachable', async (ctx) => {
    if (!(await reachable('100.64.7.68', 10095))) { console.warn('SKIP funasr: 100.64.7.68:10095 unreachable'); ctx.skip(); return; }
    const wav = process.env.FLOWMIC_SHERPA_MODEL_DIR ? join(process.env.FLOWMIC_SHERPA_MODEL_DIR, 'test_wavs', 'zh.wav') : '';
    const engine = new FunasrEngine({ id: 'funasr', language: 'zh-CN', sample_rate: 16_000, endpoint: 'ws://100.64.7.68:10095' });
    const text = await transcribeOnce(engine, wavPcm(wav));
    console.log('[LAN funasr zh]', JSON.stringify(text));
    expect(text.length).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(!RUN_LAN)('LAN SenseVoice (http://100.64.7.68:50000/v1) — live', () => {
  it('transcribes zh.wav or SKIPs on unreachable', async (ctx) => {
    if (!(await reachable('100.64.7.68', 50000))) { console.warn('SKIP sensevoice: 100.64.7.68:50000 unreachable'); ctx.skip(); return; }
    const wav = process.env.FLOWMIC_SHERPA_MODEL_DIR ? join(process.env.FLOWMIC_SHERPA_MODEL_DIR, 'test_wavs', 'zh.wav') : '';
    const engine = new CustomOpenAiCompatibleEngine({ id: 'custom-openai-compatible', language: 'zh', model: 'SenseVoiceSmall', api_key: '', sample_rate: 16_000, endpoint: 'http://100.64.7.68:50000/v1' });
    const text = await transcribeOnce(engine, wavPcm(wav));
    console.log('[LAN sensevoice zh]', JSON.stringify(text));
    expect(text.length).toBeGreaterThan(0);
  }, 30_000);
});
