// WP-R1-3 LAN STT smoke — probe + minimal transcription against the office LAN
// reference infra (06 §7). Endpoints are OWNER-NETWORK ONLY; when unreachable
// this prints SKIP + the network error (never a fabricated transcript).
//
// Run:  node scripts/smoke-lan-stt.mjs
// Uses the spike WAVs; override the dir with FLOWMIC_VAD_WAV_DIR.
// The high-fidelity path (the real FunasrEngine / CustomOpenAiCompatibleEngine)
// is test/stt-live.test.ts under FLOWMIC_LAN_SMOKE=1 — this script is a
// dependency-free operational probe.

import WebSocket from 'ws';
import { connect } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAV_DIR = process.env.FLOWMIC_VAD_WAV_DIR
  ?? join(HERE, '..', '..', '..', 'scratch', 'spike-sherpa', 'models',
          'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', 'test_wavs');
const FUNASR = { host: '100.64.7.68', port: 10095 };
const SENSEVOICE = { host: '100.64.7.68', port: 50000 };

function wavPcm(path) {
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
function buildWav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function reachable({ host, port }, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(null));
    s.once('timeout', () => done('timeout'));
    s.once('error', (e) => done(e.code || e.message));
  });
}

async function funasr(pcm) {
  const err = await reachable(FUNASR);
  if (err) return { skip: `funasr ${FUNASR.host}:${FUNASR.port} unreachable (${err})` };
  return await new Promise((resolve) => {
    const ws = new WebSocket(`ws://${FUNASR.host}:${FUNASR.port}`);
    let text = '';
    const t = setTimeout(() => { ws.close(); resolve({ text, note: 'timeout waiting for offline final' }); }, 15000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ mode: '2pass', chunk_size: [5, 10, 5], chunk_interval: 10, wav_name: 'h5', audio_fs: 16000, itn: true, is_speaking: true }));
      for (let o = 0; o < pcm.length; o += 6400) ws.send(pcm.subarray(o, o + 6400));
      ws.send(JSON.stringify({ is_speaking: false }));
    });
    ws.on('message', (d) => {
      try { const f = JSON.parse(d.toString('utf8')); if (f.mode === '2pass-offline' && typeof f.text === 'string') { text = f.text; if (f.is_final) { clearTimeout(t); ws.close(); resolve({ text }); } } } catch { /* ignore */ }
    });
    ws.on('error', (e) => { clearTimeout(t); resolve({ skip: `funasr ws error: ${e.message}` }); });
  });
}

async function sensevoice(pcm) {
  const err = await reachable(SENSEVOICE);
  if (err) return { skip: `sensevoice ${SENSEVOICE.host}:${SENSEVOICE.port} unreachable (${err})` };
  const form = new FormData();
  form.set('file', new Blob([buildWav(pcm)], { type: 'audio/wav' }), 'audio.wav');
  form.set('model', 'SenseVoiceSmall'); form.set('language', 'zh'); form.set('response_format', 'json');
  try {
    const res = await fetch(`http://${SENSEVOICE.host}:${SENSEVOICE.port}/v1/audio/transcriptions`, { method: 'POST', body: form });
    if (!res.ok) return { skip: `sensevoice HTTP ${res.status}` };
    const body = await res.json();
    return { text: typeof body.text === 'string' ? body.text : '' };
  } catch (e) { return { skip: `sensevoice fetch error: ${e.message}` }; }
}

async function main() {
  const zhPath = join(WAV_DIR, 'zh.wav');
  if (!existsSync(zhPath)) { console.error(`no zh.wav in ${WAV_DIR}`); process.exit(2); }
  const pcm = wavPcm(zhPath);
  console.log('=== LAN STT smoke (zh.wav) ===');
  const f = await funasr(pcm);
  console.log('funasr    :', f.skip ? `SKIP — ${f.skip}` : `"${f.text}"${f.note ? ' (' + f.note + ')' : ''}`);
  const s = await sensevoice(pcm);
  console.log('sensevoice:', s.skip ? `SKIP — ${s.skip}` : `"${s.text}"`);
}

main().catch((e) => { console.error('smoke error:', e.message); process.exit(1); });
