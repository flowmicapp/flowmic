#!/usr/bin/env node
// scripts/eval/speech-quality/run-stt.mjs — stream the audio bed to Soniox the
// way the phone does, through the PRODUCT's own engine adapter.
//
//   node scripts/eval/speech-quality/run-stt.mjs --config hints
//   node scripts/eval/speech-quality/run-stt.mjs --config ctx --tags jargon --lang en,mixed
//   node scripts/eval/speech-quality/run-stt.mjs --variants only        # onset/noise files only
//   node scripts/eval/speech-quality/run-stt.mjs --dry-run              # plan + audio minutes, no calls
//
// Config variants (--config):
//   hints       what production sends a user with no terminology configured:
//               `buildConfigFrame` -> language_hints only, no `context`.
//   ctx         hints + the product's current context: `buildSonioxContext`
//               (apps/server-core/src/stt/terminology-context.ts) over a
//               simulated user dictionary = every `terms` entry in the corpus.
//   ctx-struct  hints + Soniox's documented structured context
//               ({ terms: [...] }, https://soniox.com/docs/stt/concepts/context)
//               with the SAME term list. The product cannot send this today
//               (`SttEngineConfig.context` is a string); the harness swaps the
//               field in the first frame on its way to the socket so the two
//               shapes can be compared on identical audio.
//   default     card CTX-1: the product's coding default list ONLY (what a user
//               with no dictionary gets when the PC has an editor/terminal
//               focused), built by the product's `assembleSonioxContext` from
//               `CODING_DEFAULT_TERMS`, first --size N terms (default 150).
//   merged      card CTX-1: the simulated user dictionary FIRST, then the
//               default list, under one total cap of --size terms.
//   domain      card CTX-1: no terms at all, only Soniox's structured
//               `context.general` (domain/topic key-value pairs). The product
//               cannot send this today (string-only `context`); the harness
//               swaps the field the same way as ctx-struct.
//
// Faithfulness: the socket, config frame, token accumulation and final text
// all come from @flowmic/stt-cloud's `SonioxEngine` (imported from its dist,
// built by refresh-derived). Audio is pushed in 200 ms chunks (6,400 bytes) on
// a wall-clock schedule, then `flush()` — the phone's release.
//
// Billing: real Soniox audio-seconds on the TEST key in .local/soniox.env
// (never the production key). Every run is added to the usage ledger, and a run
// that would take the ledger past FLOWMIC_EVAL_SONIOX_CAP_SEC (default 1500 s)
// refuses to start unless --allow-over is given.

import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AUDIO_DIR, REPO, RESULTS_DIR, gitHead, langTag, loadCorpus, loadProductBundle, parseArgs, pcmSeconds, pool, readEnvFile,
  readWav, recordUsage, usageTotals,
} from './lib.mjs';

const args = parseArgs();
const config = args.config ?? 'hints';
const CONFIGS = ['hints', 'ctx', 'ctx-struct', 'default', 'merged', 'domain', 'dictation'];
if (!CONFIGS.includes(config)) throw new Error(`--config must be ${CONFIGS.join('|')}, got ${config}`);
const size = Number(args.size ?? 150);
const CHUNK_MS = 200;
const CHUNK_BYTES = (16000 * 2 * CHUNK_MS) / 1000;
const concurrency = Number(args.concurrency ?? 4);
const capSec = Number(process.env.FLOWMIC_EVAL_SONIOX_CAP_SEC ?? 1500);

const corpus = loadCorpus();
const audioDir = AUDIO_DIR();
const manifestPath = join(audioDir, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error('no audio bed — run gen-audio.mjs first');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// ── job selection ───────────────────────────────────────────────────────────
const byId = new Map(corpus.items.map((it) => [it.id, it]));
const idSet = args.ids ? new Set(String(args.ids).split(',')) : null;
const tagSet = args.tags ? String(args.tags).split(',') : null;
const langSet = args.lang ? new Set(String(args.lang).split(',')) : null;
const notTags = args['not-tags'] ? String(args['not-tags']).split(',') : [];
const pick = (it) => (!idSet || idSet.has(it.id)) && (!langSet || langSet.has(it.lang))
  && (!tagSet || tagSet.some((t) => it.tags.includes(t))) && !notTags.some((t) => it.tags.includes(t));
const jobs = [];
const variantsMode = args.variants ?? 'no'; // no | yes | only
if (variantsMode !== 'only') for (const it of corpus.items) if (pick(it)) jobs.push({ file: it.audio ?? it.id, item: it, variant: null, onset_sec: 0 });
if (variantsMode !== 'no') {
  for (const [name, v] of Object.entries(manifest.variants ?? {})) {
    const it = byId.get(v.base);
    if (it && pick(it)) jobs.push({ file: name, item: it, variant: v.kind, onset_sec: v.onset_sec ?? 0, snr_db: v.snr_db });
  }
}
for (const j of jobs) j.sec = pcmSeconds(readWav(join(audioDir, `${j.file}.wav`)));
const planSec = jobs.reduce((a, j) => a + j.sec, 0);
const used = usageTotals();
console.log(`[run-stt] config=${config} jobs=${jobs.length} audio=${(planSec / 60).toFixed(2)} min; ledger so far ${(used.soniox_audio_sec / 60).toFixed(2)} min of cap ${(capSec / 60).toFixed(1)}`);
if (args['dry-run']) process.exit(0);
if (used.soniox_audio_sec + planSec > capSec && !args['allow-over']) {
  console.error(`[run-stt] REFUSED: would exceed the card's Soniox cap (${capSec} s). Narrow with --ids/--tags or pass --allow-over.`);
  process.exit(2);
}

// ── product modules ─────────────────────────────────────────────────────────
const sttCloudDir = resolve(args['stt-cloud'] ?? join(REPO, 'packages', 'stt-cloud'));
const sttCloud = await import(pathToFileURL(join(sttCloudDir, 'dist', 'index.js')).href);
const WS = createRequire(join(sttCloudDir, 'package.json'))('ws');
const { mod: product, head: scHead } = await loadProductBundle(args['server-core']);
const pipeline = product.makeFinalTextPipeline(product.buildDictionaryReplacer([]));

const soniox = readEnvFile('soniox.env');
const apiKey = soniox.SONIOX_API_KEY;
if (!apiKey) throw new Error('.local/soniox.env has no SONIOX_API_KEY');
// The test key's project lives in Soniox's JP region: measured 2026-10-13, the
// same key answers 401 on stt-rt.soniox.com and stt-rt.eu.soniox.com and is
// accepted on stt-rt.jp.soniox.com. Production (NY relay) talks to the global
// US endpoint, so latency from this harness is NOT production latency.
const endpoint = args.endpoint ?? soniox.SONIOX_WS_ENDPOINT ?? 'wss://stt-rt.jp.soniox.com/transcribe-websocket';

// The simulated user dictionary: every term the corpus expects, de-duplicated.
const vocab = [...new Set(corpus.items.flatMap((it) => it.terms))];
// card CTX-1 — the default list goes through the product's own assembler so
// the measured string is the shipped string.
const needsDefault = config === 'default' || config === 'merged';
if (needsDefault && !product.assembleSonioxContext) throw new Error('this server-core has no assembleSonioxContext (card CTX-1)');
const assembly = config === 'default'
  ? product.assembleSonioxContext([], { category: 'coding', terms: product.CODING_DEFAULT_TERMS, cap: size })
  : config === 'merged'
    ? product.assembleSonioxContext(vocab, { category: 'coding', terms: product.CODING_DEFAULT_TERMS, cap: size })
    : null;
const DOMAIN_GENERAL = [
  { key: 'domain', value: 'Software development' },
  { key: 'topic', value: 'Programming, developer tools, cloud infrastructure and AI coding assistants' },
  { key: 'setting', value: 'Dictating into a code editor or terminal' },
];
// card ML-2: dictated punctuation command words of ONE session language as
// context terms (does naming them stop 改行 -> 開業, てん -> 天, dos puntos ->
// 2 puntos?). Needs a single --lang.
const DICTATION_TERMS = {
  ja: ['てん', 'まる', '改行', 'はてな', '句点', '読点'],
  es: ['dos puntos', 'coma', 'punto', 'nuevo párrafo', 'punto y aparte', 'nueva línea', 'signo de interrogación'],
  ko: ['쉼표', '마침표', '물음표', '줄바꿈', '새 문단'],
};
if (config === 'dictation' && !DICTATION_TERMS[String(args.lang)]) throw new Error(`--config dictation needs one --lang of ${Object.keys(DICTATION_TERMS).join(', ')}`);
const ctxString = assembly ? assembly.context
  : (config === 'ctx' || config === 'ctx-struct') ? product.buildSonioxContext(vocab)
    : config === 'dictation' ? product.buildSonioxContext(DICTATION_TERMS[String(args.lang)]) : undefined;
if (assembly) console.log(`[run-stt] context source=${assembly.source} user=${assembly.userTerms} default=${assembly.defaultTerms} chars=${assembly.chars}`);

const host = {
  SttEngineError: class extends Error { constructor(code, message, retryable) { super(message); this.code = code; this.retryable = retryable; } },
  unexpectedCloseError: (label) => Object.assign(new Error(`${label}: connection closed unexpectedly`), { code: 'STT_ENGINE_CLOSED' }),
};

const langOf = (it) => langTag(it.lang);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function runJob(job) {
  const pcm = readWav(join(audioDir, `${job.file}.wav`));
  const rec = { file: job.file, id: job.item.id, lang: job.item.lang, variant: job.variant, onset_sec: job.onset_sec, config, audio_sec: +job.sec.toFixed(2) };
  const tokens = [];
  let firstTokenAt = null, firstFinalTokenAt = null, configFrame = null, t0 = null, errorMsg = null;
  const connect = (url, options) => {
    const ws = new WS(url, { headers: options.headers });
    const send = ws.send.bind(ws);
    let first = true;
    ws.send = (data, ...rest) => {
      if (first && typeof data === 'string') {
        first = false;
        const frame = JSON.parse(data);
        if (config === 'ctx-struct') { delete frame.context; frame.context = { terms: vocab }; }
        if (config === 'domain') { delete frame.context; frame.context = { general: DOMAIN_GENERAL }; }
        configFrame = { ...frame, context: frame.context === undefined ? undefined : (typeof frame.context === 'string' ? `string(${frame.context.length})` : `object(${Object.keys(frame.context).join('+')})`) };
        return send(JSON.stringify(frame), ...rest);
      }
      return send(data, ...rest);
    };
    ws.on('message', (data) => {
      let f; try { f = JSON.parse(String(data)); } catch { return; }
      const now = Date.now();
      if (f.error_code || f.error_type) errorMsg = `${f.error_code ?? ''} ${f.error_type ?? ''} ${f.error_message ?? ''}`.trim();
      for (const t of f.tokens ?? []) {
        if (typeof t.text !== 'string' || t.text.trim() === '' || /^<.*>$/.test(t.text.trim())) continue;
        if (firstTokenAt === null && t0 !== null) firstTokenAt = now;
        if (t.is_final) {
          if (firstFinalTokenAt === null && t0 !== null) firstFinalTokenAt = now;
          tokens.push({ t: t.text, s: t.start_ms ?? null, e: t.end_ms ?? null, c: typeof t.confidence === 'number' ? +t.confidence.toFixed(3) : null });
        }
      }
    });
    return ws;
  };
  const cfg = { id: 'soniox', endpoint, api_key: apiKey, language: langOf(job.item), sample_rate: 16000, ...(ctxString ? { context: ctxString } : {}) };
  const engine = new sttCloud.SonioxEngine(cfg, host, { connect });
  let finalEv = null;
  engine.on('final', (ev) => { finalEv = ev; finalEv.at = Date.now(); });
  engine.on('error', (err) => { errorMsg = errorMsg ?? `${err.code ?? ''} ${err.message}`.trim(); });
  try {
    const tOpen = Date.now();
    await engine.open();
    rec.open_ms = Date.now() - tOpen;
    t0 = Date.now();
    const n = Math.ceil(pcm.length / CHUNK_BYTES);
    for (let i = 0; i < n; i++) {
      await sleep(t0 + i * CHUNK_MS - Date.now());
      if (engine.state !== 'open') throw new Error(`engine ${engine.state} mid-stream`);
      engine.push(pcm.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES), i * CHUNK_MS);
    }
    // The last chunk covers [n-1, n) * 200 ms of audio; the user releases when
    // that chunk has been "captured", i.e. at t0 + n*200.
    await sleep(t0 + n * CHUNK_MS - Date.now());
    const tRelease = Date.now();
    await Promise.race([engine.flush(), sleep(30_000).then(() => { throw new Error('flush timeout 30 s'); })]);
    rec.release_to_final_ms = (finalEv?.at ?? Date.now()) - tRelease;
  } catch (err) {
    errorMsg = errorMsg ?? String(err?.message ?? err);
  } finally {
    await engine.close().catch(() => {});
  }
  rec.ttft_ms = firstTokenAt === null ? null : firstTokenAt - t0;
  rec.ttft_from_speech_ms = rec.ttft_ms === null ? null : rec.ttft_ms - job.onset_sec * 1000;
  rec.first_final_token_ms = firstFinalTokenAt === null ? null : firstFinalTokenAt - t0;
  rec.text = finalEv?.text ?? null;
  rec.pipeline_text = rec.text === null ? null : pipeline(rec.text, { isSegment: false, language: langOf(job.item) });
  rec.first_word_ms = finalEv?.first_word_ms ?? null;
  rec.error = errorMsg;
  rec.config_frame = configFrame;
  rec.tokens = tokens;
  recordUsage({ kind: 'soniox', config, file: job.file, soniox_audio_sec: job.sec });
  return rec;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
mkdirSync(RESULTS_DIR(), { recursive: true });
const out = resolve(args.out ?? join(RESULTS_DIR(), `stt-${config}-${stamp}.jsonl`));
writeFileSync(out, JSON.stringify({ meta: { config, endpoint, at: new Date().toISOString(), stt_cloud: sttCloudDir, stt_cloud_head: gitHead(sttCloudDir), server_core_head: scHead, vocab_terms: vocab.length, ctx_chars: ctxString?.length ?? 0, chunk_ms: CHUNK_MS } }) + '\n');
let done = 0;
await pool(jobs, concurrency, async (job) => {
  const rec = await runJob(job);
  appendFileSync(out, JSON.stringify(rec) + '\n');
  done++;
  const brief = rec.error ? `ERROR ${rec.error}` : (rec.pipeline_text ?? '').slice(0, 70);
  console.log(`[${done}/${jobs.length}] ${job.file} ttft=${rec.ttft_ms} r2f=${rec.release_to_final_ms} ${brief}`);
});
console.log(`[run-stt] wrote ${out}`);
