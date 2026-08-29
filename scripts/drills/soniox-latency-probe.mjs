#!/usr/bin/env node
// SONIOX LATENCY PROBE — run this from HK / SG / EU / anywhere, compare regions.
//
// ── READ THIS FIRST, IT IS THE WHOLE POINT ──────────────────────────────────
// `stt-rt.soniox.com` resolves into a Cloudflare anycast range. Measured from
// Tokyo, ICMP ping to it is 1.7 ms (docs/strategy/2026-08-17-cloudflare-and-
// production-origin-plan.md §1-3). That number is the distance to the LOCAL CF
// EDGE, not to Soniox. `ping`, `curl -w time_connect`, and any TCP/TLS-only
// benchmark will therefore look excellent from EVERY region and tell you
// nothing. The latency that reaches a user lives BEHIND the edge, and the only
// way to see it is to run a real transcription session and watch how far the
// server's own audio-processed pointer trails wall clock.
//
// So this probe reports two layers, deliberately side by side:
//   LAYER 1 (edge)    dns / tcp / tls         — cheap, free, nearly meaningless alone
//   LAYER 2 (origin)  ack / ttft / lag / tail — costs audio-seconds, and is the answer
// A region wins or loses on LAYER 2. If layer 1 is flat across regions and
// layer 2 is not, that gap IS the backhaul you are shopping for.
//
// Zero dependencies: Node >= 22 (global WebSocket). No `npm i`, no `ws`.
//
// USAGE
//   node soniox-latency-probe.mjs --label=HK --runs=5 --out=hk.jsonl
//   node soniox-latency-probe.mjs --mode=net --runs=20      (layer 1 only, free, no key)
//
// KEY: --key=..., or $FLOWMIC_MANAGED_STT_API_KEY, or --env=<file containing
//      FLOWMIC_MANAGED_STT_API_KEY=...>. The key is NEVER printed or written out.
//
// AUDIO: --wav=<16 kHz mono s16le WAV of real speech>. Default is the repo
//      fixture apps/mobile/integration_test/fixtures/zh-6s.wav. Silence yields
//      no tokens, so ttft would be null — use real speech.
//
// BILLING: every layer-2 run streams the whole clip to the vendor and is billed
//      as that many audio seconds (6 s for the default fixture). 5 runs x 4
//      regions = 2 minutes of audio. Cheap, but not free.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import os from 'node:os';

// ── args ────────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`bad argument: ${a}`);
    return [m[1], m[2] ?? 'true'];
  }),
);

const LABEL = argv.label ?? os.hostname();
const RUNS = Number(argv.runs ?? 5);
const MODE = argv.mode ?? 'full'; // 'full' | 'net'
const ENDPOINT = argv.endpoint ?? 'wss://stt-rt.soniox.com/transcribe-websocket';
const MODEL = argv.model ?? 'stt-rt-v5';
const HINTS = (argv.hints ?? 'zh,en').split(',').filter(Boolean);
const CHUNK_MS = Number(argv['chunk-ms'] ?? 200); // the phone sends 200 ms slices
const PACE = argv.pace === 'fast' ? 0 : CHUNK_MS; // real time by default
const OUT = argv.out ?? null;
const GAP_S = Number(argv['gap-s'] ?? 3);
const HARD_TIMEOUT_MS = Number(argv.timeout ?? 45_000);

const HOST = new URL(ENDPOINT).hostname;
const PORT = Number(new URL(ENDPOINT).port || 443);

// ── key (never logged) ──────────────────────────────────────────────────────
function loadKey() {
  if (argv.key) return argv.key;
  if (process.env.FLOWMIC_MANAGED_STT_API_KEY) return process.env.FLOWMIC_MANAGED_STT_API_KEY;
  const candidates = [argv.env, '.local/soniox.env', join(os.homedir(), 'soniox.env')].filter(Boolean);
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    for (const line of readFileSync(c, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?FLOWMIC_MANAGED_STT_API_KEY=(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

// ── audio ───────────────────────────────────────────────────────────────────
function pcmOf(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${path}: not a RIFF/WAV file`);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      const ch = b.readUInt16LE(off + 10);
      const rate = b.readUInt32LE(off + 12);
      const bits = b.readUInt16LE(off + 22);
      if (ch !== 1 || rate !== 16000 || bits !== 16) {
        throw new Error(`${path}: need 16 kHz mono s16le, got ${rate} Hz / ${ch} ch / ${bits} bit`);
      }
    }
    if (id === 'data') return b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

// ── stats ───────────────────────────────────────────────────────────────────
const pct = (arr, p) => {
  const s = arr.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null; // no samples has no percentile; printing 0 would be a fabricated datum
  return s[Math.min(Math.ceil((p / 100) * s.length), s.length) - 1];
};
const fmt = (v) => (v === null || v === undefined ? '    —' : String(Math.round(v)).padStart(5));

// ── LAYER 1: edge reachability (free, no key, no billing) ───────────────────
async function netProbe() {
  const out = { dns_ms: null, tcp_ms: null, tls_ms: null, ip: null, tls_proto: null };
  let t = performance.now();
  let addr;
  try {
    addr = await dns.lookup(HOST, { verbatim: true });
    out.dns_ms = performance.now() - t;
    out.ip = addr.address;
  } catch (e) {
    out.error = `dns: ${e.message}`;
    return out;
  }

  await new Promise((done) => {
    t = performance.now();
    const sock = net.connect({ host: addr.address, port: PORT, family: addr.family });
    sock.setTimeout(10_000);
    sock.once('connect', () => {
      out.tcp_ms = performance.now() - t;
      const t2 = performance.now();
      const sec = tls.connect({ socket: sock, servername: HOST });
      sec.once('secureConnect', () => {
        out.tls_ms = performance.now() - t2;
        out.tls_proto = sec.getProtocol();
        sec.destroy();
        done();
      });
      sec.once('error', (e) => { out.error = `tls: ${e.message}`; sec.destroy(); done(); });
    });
    sock.once('timeout', () => { out.error = 'tcp: timeout'; sock.destroy(); done(); });
    sock.once('error', (e) => { out.error = `tcp: ${e.message}`; sock.destroy(); done(); });
  });
  return out;
}

// Which Cloudflare colo answered? That is exactly the variable which makes
// layer 1 look identical from everywhere, so name it instead of guessing.
async function coloProbe() {
  for (const url of [`https://${HOST}/cdn-cgi/trace`, 'https://www.cloudflare.com/cdn-cgi/trace']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const txt = await r.text();
      const colo = /^colo=(.*)$/m.exec(txt)?.[1];
      const loc = /^loc=(.*)$/m.exec(txt)?.[1];
      if (colo) return { colo, loc: loc ?? null, via: url.includes(HOST) ? 'soniox' : 'cloudflare.com' };
    } catch { /* try the next probe */ }
  }
  return { colo: null, loc: null, via: null };
}

// ── LAYER 2: a real transcription session ───────────────────────────────────
function sessionProbe(key, pcm) {
  return new Promise((done) => {
    const r = {
      ws_open_ms: null, // connect start -> WS upgrade complete
      ack_ms: null,     // config frame sent -> first server frame (edge + backhaul + auth)
      ttft_ms: null,    // first audio byte sent -> first frame carrying a token
      lag_p50: null,    // how far the server's audio pointer trails wall clock, mid-stream
      lag_p95: null,
      final_ms: null,   // empty TEXT frame (flush) -> finished:true
      tail_ms: null,    // last audio byte sent -> finished:true  (what the user feels)
      frames: 0,
      tokens_seen: 0,
      text: '',        // final transcript, for cross-endpoint parity (see the is_final note below)
      error: null,
    };
    const lags = [];
    const t0 = performance.now();
    let tConfig = null;
    let tAudioStart = null;
    let tAudioEnd = null;
    let tFlush = null;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err && !r.error) r.error = err;
      r.lag_p50 = pct(lags, 50);
      r.lag_p95 = pct(lags, 95);
      clearTimeout(hard);
      try { ws.close(); } catch { /* already gone */ }
      done(r);
    };
    const hard = setTimeout(
      () => finish(`hard timeout ${HARD_TIMEOUT_MS}ms — finished:true never arrived`),
      HARD_TIMEOUT_MS,
    );

    const ws = new WebSocket(ENDPOINT);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      r.ws_open_ms = performance.now() - t0;
      ws.send(JSON.stringify({
        api_key: key,
        model: MODEL,
        audio_format: 'pcm_s16le',
        num_channels: 1,
        sample_rate: 16000,
        language_hints: HINTS,
      }));
      tConfig = performance.now();

      const FRAME = (16000 * 2 * CHUNK_MS) / 1000; // bytes per chunk at 16 kHz s16le
      tAudioStart = performance.now();
      for (let off = 0; off < pcm.length; off += FRAME) {
        if (settled || ws.readyState !== WebSocket.OPEN) return;
        ws.send(pcm.subarray(off, Math.min(off + FRAME, pcm.length)));
        if (PACE) await new Promise((x) => setTimeout(x, PACE));
      }
      tAudioEnd = performance.now();
      // 🔴 END OF STREAM IS AN EMPTY **TEXT** FRAME, NOT AN EMPTY BINARY FRAME.
      // Sending Buffer.alloc(0) here is the M3-1 bug: the vendor ignores it, the
      // final never arrives, and every run silently measures our own 3 s fallback
      // instead of the vendor. The back-to-back measurement of both frame types
      // against the live service is at packages/stt-cloud/src/engines/soniox.ts:505;
      // the constant itself is `SONIOX_END_OF_STREAM`.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('');
        tFlush = performance.now();
      }
    };

    ws.onmessage = (ev) => {
      const now = performance.now();
      let f;
      try {
        f = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch { return; }
      r.frames += 1;
      if (r.ack_ms === null && tConfig !== null) r.ack_ms = now - tConfig;

      if (f.error_code || f.error_type) {
        // A vendor-named refusal (bad key, exhausted balance, ...). Report it;
        // never average it in — it is not a latency sample.
        finish(`vendor ${f.error_code ?? ''} ${f.error_type ?? ''} ${f.error_message ?? ''}`.trim());
        return;
      }
      const toks = Array.isArray(f.tokens) ? f.tokens : [];
      if (toks.length) {
        r.tokens_seen += toks.length;
        if (r.ttft_ms === null && tAudioStart !== null) r.ttft_ms = now - tAudioStart;
        // 2026-08-29: keep the FINAL text, because "the regional endpoints run the
        // same model" is a vendor claim this repo has never measured. Streaming
        // the same clip at two endpoints and diffing the transcripts settles it
        // without needing a reference transcript at all — the two runs are each
        // other's reference. Only `is_final` tokens are kept: interim tokens get
        // revised, so concatenating them would produce a string neither endpoint
        // ever emitted, and a diff of two such strings would measure our own
        // buffering rather than the models.
        for (const t of toks) if (t?.is_final && typeof t.text === 'string') r.text += t.text;
      }
      // The server states how much audio it has actually processed. Wall-clock
      // elapsed minus that is the true streaming lag, and unlike ttft it keeps
      // reporting for the whole utterance instead of exactly once.
      if (typeof f.total_audio_proc_ms === 'number' && tAudioStart !== null && tFlush === null) {
        const lag = (now - tAudioStart) - f.total_audio_proc_ms;
        if (Number.isFinite(lag)) lags.push(lag);
      }
      if (f.finished === true) {
        if (tFlush !== null) r.final_ms = now - tFlush;
        if (tAudioEnd !== null) r.tail_ms = now - tAudioEnd;
        finish(null);
      }
    };
    ws.onerror = () => finish('ws error (see close code)');
    ws.onclose = (ev) => finish(r.frames ? null : `ws closed before any frame (code=${ev.code})`);
  });
}

// ── main ────────────────────────────────────────────────────────────────────
const rows = [];
const colo = await coloProbe();
console.log(`region=${LABEL}  host=${HOST}  mode=${MODE}  runs=${RUNS}`);
console.log(`cf-edge: colo=${colo.colo ?? '?'} loc=${colo.loc ?? '?'} (via ${colo.via ?? 'unavailable'})`);

let key = null;
let pcm = null;
if (MODE !== 'net') {
  key = loadKey();
  if (!key) {
    console.error('no API key: pass --key=..., set FLOWMIC_MANAGED_STT_API_KEY, or --env=<file>');
    console.error('(or run --mode=net for the free edge-only layer)');
    process.exit(1);
  }
  const wav = resolvePath(argv.wav ?? 'apps/mobile/integration_test/fixtures/zh-6s.wav');
  pcm = pcmOf(wav);
  console.log(`audio: ${wav}  ${(pcm.length / 32000).toFixed(2)} s  chunk=${CHUNK_MS}ms  pace=${PACE ? 'real-time' : 'FAST (NOT a latency measurement)'}`);
  console.log(`billing: ~${((pcm.length / 32000) * RUNS).toFixed(0)} audio-seconds for this invocation\n`);
}

console.log(MODE === 'net'
  ? '  #    dns    tcp    tls   ip'
  : '  #    dns    tcp    tls |  open    ack   ttft  lag50  lag95  final   tail   note');

for (let i = 1; i <= RUNS; i += 1) {
  const nr = await netProbe();
  const row = { label: LABEL, run: i, at: new Date().toISOString(), colo: colo.colo, ...nr };
  if (MODE === 'net') {
    console.log(`${String(i).padStart(3)} ${fmt(nr.dns_ms)}  ${fmt(nr.tcp_ms)}  ${fmt(nr.tls_ms)}   ${nr.ip ?? nr.error ?? ''}`);
  } else {
    const sr = await sessionProbe(key, pcm);
    Object.assign(row, sr);
    console.log(
      `${String(i).padStart(3)} ${fmt(nr.dns_ms)}  ${fmt(nr.tcp_ms)}  ${fmt(nr.tls_ms)} | `
      + `${fmt(sr.ws_open_ms)}  ${fmt(sr.ack_ms)}  ${fmt(sr.ttft_ms)}  ${fmt(sr.lag_p50)}  ${fmt(sr.lag_p95)}  `
      + `${fmt(sr.final_ms)}  ${fmt(sr.tail_ms)}   ${sr.error ?? ''}`,
    );
  }
  rows.push(row);
  if (i < RUNS && GAP_S) await new Promise((x) => setTimeout(x, GAP_S * 1000));
}

const clean = rows.filter((r) => !r.error);
const col = (k) => [pct(rows.map((r) => r[k]), 50), pct(rows.map((r) => r[k]), 95)];
console.log(`\n── ${LABEL} — p50 / p95 over ${clean.length}/${rows.length} clean runs ──`);
const report = MODE === 'net'
  ? ['dns_ms', 'tcp_ms', 'tls_ms']
  : ['dns_ms', 'tcp_ms', 'tls_ms', 'ws_open_ms', 'ack_ms', 'ttft_ms', 'lag_p50', 'lag_p95', 'final_ms', 'tail_ms'];
for (const k of report) {
  const [a, b] = col(k);
  console.log(`  ${k.padEnd(12)} ${fmt(a)} / ${fmt(b)} ms`);
}
if (rows.length !== clean.length) {
  console.log(`\n  ⚠ ${rows.length - clean.length} run(s) errored and are EXCLUDED from the percentiles:`);
  for (const r of rows.filter((x) => x.error)) console.log(`    run ${r.run}: ${r.error}`);
}
if (OUT) {
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\nwrote ${rows.length} rows -> ${OUT}`);
}
process.exit(clean.length ? 0 : 2);
