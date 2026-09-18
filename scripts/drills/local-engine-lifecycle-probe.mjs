#!/usr/bin/env node
// LOCAL ENGINE LIFECYCLE PROBE — the three facts NR-45 and NR-46 turn on.
//
// ── READ THIS FIRST ─────────────────────────────────────────────────────────
// Every number and every verdict about the built-in offline engine in the
// ledger was taken with THIS file. It exists because all three questions below
// are questions about somebody else's code (sherpa-onnx-node, onnxruntime) and
// the repo's standing rule is that a claim about somebody else's code must be
// re-measurable rather than remembered.
//
//   --surface      what `OfflineRecognizer` actually offers a JS caller, and
//                  whether the native addon exports anything that frees a
//                  recognizer.  (NR-45's question.)
//   --delete-lock  can a model pack be deleted WHILE a recognizer built from it
//                  is alive and decoding — and does that recognizer survive it?
//                  (It WAS the premise of the `recognizer_loaded` delete
//                  refusal; that hold was removed by NR-49 / owner ruling
//                  2026-09-16 §1, so this arm is now the standing re-measure
//                  of whether deleting a warm pack is safe on THIS machine —
//                  the open question is a future onnxruntime that memory-maps
//                  its weights, which `stt/sherpa/model-in-use.ts` records.)
//   --decode-cost  how long ONE decode holds the event loop, by audio length,
//                  synchronous vs `decodeAsync`.  (NR-46's question.)
//
// Default: all three.
//
// 🔴 WHY THIS IS A DRILL AND NOT A TEST. It needs the native addon (an
// optionalDependency) AND real model packs (hundreds of MB, not in the repo),
// so on CI it would prove nothing while looking green. The half that CAN be
// pinned everywhere the addon resolves — "no free-like member appeared, and
// `decodeAsync` is still there" — is pinned by
// `apps/server-core/test/sherpa-addon-surface.test.ts`; this file is the other
// half, and it is the one that produces numbers.
//
// ── RUN IT ──────────────────────────────────────────────────────────────────
//   node scripts/drills/local-engine-lifecycle-probe.mjs \
//     --models="$APPDATA/FlowMic/models" \
//     --wav=apps/mobile/integration_test/fixtures/zh-6s.wav
//
// `--models` defaults to the platform models root the app itself uses
// (%APPDATA%\FlowMic\models on Windows, $XDG_DATA_HOME/FlowMic/models
// elsewhere); `--wav` defaults to the repo's own 6 s Chinese fixture. Packs are
// discovered by directory name, so the drill runs with whatever the machine has
// downloaded and says which packs it found.
//
// ⚠️ `--delete-lock` COPIES the pack before deleting it. It never touches the
// real models root. If you point `--models` somewhere unusual, read that line
// again before running it.
//
// ⚠️ Put the copies on the same volume as the repo, not on C: (CLAUDE.md's
// dev-tree rule); the drill writes them under `.tmp-engine-lifecycle/` beside
// the current working directory, which the root .gitignore already covers.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Resolved from `apps/server-core` rather than from this file: the addon is a
// dependency of that workspace package, not of the root, so a require anchored
// here finds nothing under pnpm's layout. `--server-core=` covers a checkout
// whose layout has moved.
const SERVER_CORE = resolve(
  (process.argv.slice(2).find((a) => a.startsWith('--server-core=')) ?? '=apps/server-core').split('=')[1],
  'package.json',
);
const require = createRequire(existsSync(SERVER_CORE) ? SERVER_CORE : import.meta.url);
const SAMPLE_RATE = 16_000;

// ── arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const wantAll = !flag('surface') && !flag('delete-lock') && !flag('decode-cost');
const want = {
  surface: wantAll || flag('surface'),
  deleteLock: wantAll || flag('delete-lock'),
  decodeCost: wantAll || flag('decode-cost'),
};

function defaultModelsRoot() {
  // Mirrors `stt/sherpa/model-manifest.ts` appDataBase() — deliberately a COPY
  // rather than an import: this file must run from a plain `node` with no build
  // step, and the path is three segments that have not moved since LM-CAT.
  const base = process.platform === 'win32'
    ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
  return join(base, 'FlowMic', 'models');
}

const MODELS_ROOT = resolve(opt('models', process.env.FLOWMIC_MODELS_ROOT ?? defaultModelsRoot()));
const WAV = resolve(opt('wav', 'apps/mobile/integration_test/fixtures/zh-6s.wav'));
const TMP = resolve('.tmp-engine-lifecycle');

// ── the addon ───────────────────────────────────────────────────────────────
// #3059 (spike §2.1): prepend the bundled win-x64 directory to PATH so its
// onnxruntime.dll wins over a stale system copy. Same step `sherpa-local.ts`
// does in `prependNativeDllDir`; without it the require below fails on Windows
// with a message about a missing module rather than about a DLL.
function loadAddon() {
  let glueDir;
  try {
    glueDir = dirname(require.resolve('sherpa-onnx-node/package.json'));
  } catch {
    console.error('sherpa-onnx-node does not resolve from here. Run this from the repo root after `pnpm install`.');
    process.exit(2);
  }
  const winBin = join(glueDir, '..', 'sherpa-onnx-win-x64');
  if (process.platform === 'win32' && existsSync(winBin)) {
    process.env.PATH = `${winBin};${process.env.PATH ?? ''}`;
  }
  return {
    glueDir,
    api: require('sherpa-onnx-node'),
    addon: require(join(glueDir, 'addon.js')),
    // `OfflineStream` is NOT on the package's public export map — only
    // `OfflineRecognizer` is, and the stream class comes back from
    // `createStream()`. Reached through the module that defines it, because
    // NR-45's question is about the whole object graph a recognizer owns, and
    // the stream is half of it.
    asr: require(join(glueDir, 'non-streaming-asr.js')),
  };
}

// ── model packs ─────────────────────────────────────────────────────────────
// Config builders, copied from `stt/sherpa/loader-config.ts`'s senseVoice,
// offline-transducer and whisper arms. A pack this drill does not recognise is
// reported and skipped rather than fed to the wrong loader (which is how a
// German utterance came back as "." once).
//
// 🔴 `maxDecodeAudioMs` (card NR-60) is NOT decoration and not a product
// setting: it is what the recognizer will actually READ. A whisper recognizer
// keeps the first 30 s of any wave and discards the rest — the shipped
// `sherpa-onnx-c-api.dll` says so itself ("Only waves less than 30 seconds are
// supported. We process only the first 30 seconds and discard the remaining
// data"). So a 45 s entry in LENGTHS_MS, measured against a whisper pack, would
// time a 30 s decode and print it next to the label "45.0s": an RTF a third too
// low, in a file whose entire purpose is to produce trustworthy numbers. The
// decode-cost section skips those lengths and says why.
const PACKS = [
  {
    name: 'senseVoice',
    match: (id) => id.includes('sense-voice'),
    maxDecodeAudioMs: null,
    config: (dir, files) => ({
      senseVoice: { model: join(dir, files.model), useInverseTextNormalization: 1, language: 'auto' },
    }),
    files: (names) => {
      const model = names.find((n) => n.endsWith('.onnx'));
      const tokens = names.find((n) => n.endsWith('tokens.txt'));
      return model === undefined || tokens === undefined ? null : { model, tokens };
    },
  },
  {
    name: 'offline-transducer',
    match: (id) => id.includes('zipformer') || id.includes('transducer'),
    maxDecodeAudioMs: null,
    config: (dir, files) => ({
      transducer: {
        encoder: join(dir, files.encoder),
        decoder: join(dir, files.decoder),
        joiner: join(dir, files.joiner),
      },
    }),
    files: (names) => {
      const encoder = names.find((n) => n.startsWith('encoder'));
      const decoder = names.find((n) => n.startsWith('decoder'));
      const joiner = names.find((n) => n.startsWith('joiner'));
      const tokens = names.find((n) => n.endsWith('tokens.txt'));
      return encoder && decoder && joiner && tokens ? { encoder, decoder, joiner, tokens } : null;
    },
  },
  {
    // The catalog's one multilingual row is `sherpa-onnx-whisper-turbo`, whose
    // files are `turbo-encoder.int8.onnx` / `turbo-decoder.int8.onnx` /
    // `turbo-tokens.txt` — hence the suffix matching rather than the transducer
    // arm's `startsWith`, and hence `files.tokens` existing at all (this drill
    // used to hard-code `tokens.txt`, which no whisper pack ships).
    name: 'whisper',
    match: (id) => id.includes('whisper'),
    maxDecodeAudioMs: 30_000,
    config: (dir, files) => ({
      // `language: ''` = let Whisper detect, matching loader-config.ts's
      // wildcard arm. This drill measures cost, and a wrong language hint would
      // change the text without changing the wall time it is here to report.
      whisper: { encoder: join(dir, files.encoder), decoder: join(dir, files.decoder), language: '', task: 'transcribe' },
    }),
    files: (names) => {
      const encoder = names.find((n) => n.endsWith('encoder.int8.onnx') || n.endsWith('encoder.onnx'));
      const decoder = names.find((n) => n.endsWith('decoder.int8.onnx') || n.endsWith('decoder.onnx'));
      const tokens = names.find((n) => n.endsWith('tokens.txt'));
      return encoder && decoder && tokens ? { encoder, decoder, tokens } : null;
    },
  },
];

function discoverPacks() {
  if (!existsSync(MODELS_ROOT)) return [];
  const out = [];
  for (const id of readdirSync(MODELS_ROOT)) {
    const dir = join(MODELS_ROOT, id);
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    const kind = PACKS.find((p) => p.match(id));
    if (kind === undefined) { console.log(`  (skipping '${id}' — this drill knows ${PACKS.map((p) => p.name).join(' / ')} packs only)`); continue; }
    const files = kind.files(names);
    if (files === null) { console.log(`  (skipping '${id}' — its files do not look like a ${kind.name} pack)`); continue; }
    out.push({ id, dir, kind, files });
  }
  return out;
}

const recognizerConfig = (pack, dir) => ({
  featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
  modelConfig: {
    ...pack.kind.config(dir, pack.files),
    tokens: join(dir, pack.files.tokens),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  },
});

// ── audio ───────────────────────────────────────────────────────────────────
// The fixture is 16 kHz mono s16le with a 44-byte canonical WAV header. Spans
// longer than the clip repeat it; that is honest for a COST measurement (cost
// is a function of length, not of what was said) and dishonest for anything
// about accuracy, which this drill does not claim.
function samplesFor(pcm, ms) {
  const want = Math.round((SAMPLE_RATE * 2 * ms) / 1000);
  const parts = [];
  for (let have = 0; have < want;) {
    const take = Math.min(pcm.length, want - have);
    parts.push(pcm.subarray(0, take));
    have += take;
  }
  const buf = Buffer.concat(parts, want);
  const n = want >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Max latency of a fixed-period timer, i.e. how long the loop was unavailable.
 *  VERBATIM from `apps/server-core/test/stt-cold-start-loop.test.ts` (NR-38), so
 *  the numbers this drill prints are on the same scale as the ones recorded
 *  there. The TRAILING gap is folded in at `stop()` on purpose: a stall that
 *  swallows every tick leaves `max` at 0 otherwise, which reads as "no stall". */
class LoopWatch {
  #max = 0; #ticks = 0; #last = 0; #handle = null;
  constructor(periodMs = 20) { this.periodMs = periodMs; }
  start() {
    this.#last = performance.now();
    this.#handle = setInterval(() => {
      const now = performance.now();
      const lag = now - this.#last - this.periodMs;
      if (lag > this.#max) this.#max = lag;
      this.#ticks++;
      this.#last = now;
    }, this.periodMs);
    return this;
  }
  stop() {
    const tail = performance.now() - this.#last - this.periodMs;
    if (tail > this.#max) this.#max = tail;
    if (this.#handle) clearInterval(this.#handle);
    return { maxLagMs: Math.round(this.#max), ticks: this.#ticks };
  }
}

// ── §1 the addon surface ────────────────────────────────────────────────────
const FREE_LIKE = /free|destroy|delete|release|dispose|close|shutdown|unload/i;

function reportSurface({ api, addon, asr }) {
  console.log('\n=== SURFACE — what a JS caller can do to a recognizer');
  const proto = Object.getOwnPropertyNames(api.OfflineRecognizer.prototype);
  const statics = Object.getOwnPropertyNames(api.OfflineRecognizer)
    .filter((n) => !['length', 'name', 'prototype'].includes(n));
  const streamProto = Object.getOwnPropertyNames(asr.OfflineStream.prototype);
  console.log(`  OfflineRecognizer.prototype : ${proto.join(', ')}`);
  console.log(`  OfflineRecognizer statics   : ${statics.join(', ')}`);
  console.log(`  OfflineStream.prototype     : ${streamProto.join(', ')}`);
  const jsFree = [...proto, ...statics, ...streamProto].filter((n) => FREE_LIKE.test(n));
  const exports = Object.keys(addon).sort();
  const nativeFree = exports.filter((n) => FREE_LIKE.test(n));
  console.log(`  native addon exports        : ${exports.length}`);
  console.log(`  free-like on the JS classes : ${jsFree.length === 0 ? '(none)' : jsFree.join(', ')}`);
  console.log(`  free-like in the addon      : ${nativeFree.length === 0 ? '(none)' : nativeFree.join(', ')}`);
  console.log(`  decodeAsync present         : ${proto.includes('decodeAsync')}`);
  console.log(`  createAsync present         : ${statics.includes('createAsync')}`);
  // The C library DOES have a destroy; it is simply not reachable from here.
  // Reported as a string scan of the shipped binary so the claim is checkable
  // rather than asserted.
  for (const bin of ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll']) {
    const p = join(dirname(require.resolve('sherpa-onnx-node/package.json')), '..', `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`, bin);
    if (!existsSync(p)) continue;
    const text = readFileSync(p).toString('latin1');
    const hit = [...new Set(text.match(/SherpaOnnxDestroy[A-Za-z0-9_]{0,40}/g) ?? [])]
      .filter((n) => /Offline(Recognizer|Stream)$/.test(n));
    console.log(`  ${bin}: destroy symbols present = ${hit.length === 0 ? '(none)' : hit.join(', ')}`);
  }
}

// ── §2 can a loaded pack be deleted ─────────────────────────────────────────
async function reportDeleteLock({ api }, packs, pcm) {
  console.log('\n=== DELETE-LOCK — delete a pack while a recognizer built from it is alive');
  console.log('  (every pack below is COPIED first; the real models root is never touched)');
  const samples = samplesFor(pcm, 6000);
  const decode = (rec) => {
    const s = rec.createStream();
    s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    rec.decode(s);
    return rec.getResult(s).text ?? '';
  };
  for (const pack of packs) {
    const copy = join(TMP, `live-${pack.id}`);
    rmSync(copy, { recursive: true, force: true });
    mkdirSync(copy, { recursive: true });
    cpSync(pack.dir, copy, { recursive: true });

    // CONTROL: the same copy, never loaded, deletes cleanly. Without it a
    // successful delete below could just mean "this filesystem never locks".
    const control = join(TMP, `control-${pack.id}`);
    rmSync(control, { recursive: true, force: true });
    mkdirSync(control, { recursive: true });
    cpSync(pack.dir, control, { recursive: true });
    let controlVerdict = 'OK';
    try { rmSync(control, { recursive: true }); } catch (e) { controlVerdict = `FAILED ${e.code}`; }

    const rec = await api.OfflineRecognizer.createAsync(recognizerConfig(pack, copy));
    const before = decode(rec);
    let single = 'OK';
    const firstFile = join(copy, readdirSync(copy).find((n) => n.endsWith('.onnx')));
    try { unlinkSync(firstFile); } catch (e) { single = `FAILED ${e.code}`; }
    let whole = 'OK';
    try { rmSync(copy, { recursive: true }); } catch (e) { whole = `FAILED ${e.code}`; }
    const gone = !existsSync(copy);
    // The question that decides whether refusing the delete is protecting
    // anything: does the LOADED recognizer still work with its files gone?
    const after = decode(rec);
    console.log(`  ${pack.id} [${pack.kind.name}]`);
    console.log(`    control (never loaded) recursive delete : ${controlVerdict}`);
    console.log(`    unlink one .onnx while loaded           : ${single}`);
    console.log(`    recursive delete of the pack while loaded: ${whole}  (directory gone: ${gone})`);
    console.log(`    decode after the delete matches before  : ${after === before} (${before.length} chars)`);
    rmSync(copy, { recursive: true, force: true });
  }
}

// ── §3 what one decode costs the event loop ─────────────────────────────────
// 45 s is the WORST single decode a leg can hand the recognizer: the soft
// segment (`DEFAULT_SOFT_SEGMENT_MS` 30 s) plus its grace (`DEFAULT_SOFT_SEGMENT_GRACE_MS`
// 15 s) — NR-50 sizes the local flush cap from THAT span, not from 30 s.
// ⚠️ card NR-60: on a whisper pack that sentence stopped being true — such a leg
// is now bounded by the pack's own 30 s decode window instead of by the clock —
// so the 45 s row is skipped for those packs rather than reported (see PACKS).
const LENGTHS_MS = [1_000, 3_000, 6_000, 12_000, 30_000, 45_000];

/** How much lag a 20 ms timer already sees with NOTHING running. The control
 *  for every number in this section, and it is not decoration: the same 6 s
 *  SenseVoice decode measured 488 ms on this box idle and 12_028 ms while
 *  another session was running a six-lane gate — 25x, with the drill reporting
 *  it just as confidently. A reading taken next to a busy machine is a
 *  measurement of the machine, so the run says up front whether it is one.
 *  Below IDLE_LAG_SUSPECT_MS is "this box was quiet"; above it, the numbers
 *  that follow are not about sherpa. */
const IDLE_LAG_SUSPECT_MS = 50;

async function idleControl() {
  const w = new LoopWatch().start();
  await new Promise((r) => { setTimeout(r, 600); });
  const m = w.stop();
  console.log(`  CONTROL idle loop lag over 600 ms with nothing running: maxLag=${m.maxLagMs}ms ticks=${m.ticks}`);
  if (m.maxLagMs >= IDLE_LAG_SUSPECT_MS) {
    console.log(`  🔴 THIS BOX IS BUSY (idle lag ${m.maxLagMs}ms >= ${IDLE_LAG_SUSPECT_MS}ms). Everything below measures the load, not the decode. Do not record it.`);
  }
}

async function reportDecodeCost({ api }, packs, pcm) {
  console.log('\n=== DECODE-COST — how long one decode holds the event loop');
  console.log('  maxLag = longest gap a 20 ms timer saw; ticks = timers that ran during the decode');
  await idleControl();
  for (const pack of packs) {
    const load = new LoopWatch().start();
    const rec = await api.OfflineRecognizer.createAsync(recognizerConfig(pack, pack.dir));
    const lm = load.stop();
    console.log(`  ${pack.id} [${pack.kind.name}] createAsync: maxLag=${lm.maxLagMs}ms ticks=${lm.ticks}`);
    const sync = (samples) => {
      const s = rec.createStream();
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      const t0 = performance.now();
      const w = new LoopWatch().start();
      rec.decode(s);
      const m = w.stop();
      return { ...m, wallMs: Math.round(performance.now() - t0) };
    };
    const async_ = async (samples) => {
      const s = rec.createStream();
      s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      const t0 = performance.now();
      const w = new LoopWatch().start();
      await rec.decodeAsync(s);
      const m = w.stop();
      return { ...m, wallMs: Math.round(performance.now() - t0) };
    };
    // Warm-up, reported and then discarded: the FIRST decode after a load pays
    // that model's one-time ONNX arena / thread-pool / first-graph-run cost,
    // which by construction cannot repeat (sherpa-preview.ts header ②).
    const warm = sync(samplesFor(pcm, 6000));
    console.log(`    warm-up   6.0s sync : maxLag=${warm.maxLagMs}ms ticks=${warm.ticks} wall=${warm.wallMs}ms  (discarded)`);
    // card NR-60 — a length this pack's decoder would truncate is not a
    // measurement of this pack, it is a measurement of 30 s with the wrong
    // label on it. Skipped and SAID, never silently clamped.
    const cap = pack.kind.maxDecodeAudioMs;
    for (const ms of LENGTHS_MS) {
      if (cap !== null && ms > cap) {
        console.log(`  ${`${(ms / 1000).toFixed(1)}s`.padStart(6)} skipped: a ${pack.kind.name} recognizer decodes only the first ${cap / 1000}s of a wave and discards the rest`);
        continue;
      }
      const samples = samplesFor(pcm, ms);
      const a = sync(samples), b = sync(samples);
      const c = await async_(samples), d = await async_(samples);
      const s = `${(ms / 1000).toFixed(1)}s`.padStart(6);
      console.log(`  ${s} sync : maxLag=${a.maxLagMs}/${b.maxLagMs}ms ticks=${a.ticks}/${b.ticks} wall=${a.wallMs}/${b.wallMs}ms`);
      console.log(`  ${s} async: maxLag=${c.maxLagMs}/${d.maxLagMs}ms ticks=${c.ticks}/${d.ticks} wall=${c.wallMs}/${d.wallMs}ms`);
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const loaded = loadAddon();
console.log(`machine: ${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? '(unknown)'} · node ${process.version} · ${process.platform}-${process.arch}`);
console.log(`addon  : sherpa-onnx-node ${require('sherpa-onnx-node/package.json').version} at ${loaded.glueDir}`);
console.log(`models : ${MODELS_ROOT}`);

if (want.surface) reportSurface(loaded);

if (want.deleteLock || want.decodeCost) {
  const packs = discoverPacks();
  if (packs.length === 0) {
    console.log(`\nNO MODEL PACKS under ${MODELS_ROOT} — the delete-lock and decode-cost sections need one.`);
    console.log('Download a pack from the desktop app (Settings → Speech recognition) or pass --models=<dir>.');
    console.log('🔴 Nothing below was measured. Do not record an absence here as a reading.');
  } else {
    if (!existsSync(WAV)) {
      console.log(`\nWAV fixture not found: ${WAV}`);
      process.exit(2);
    }
    const pcm = readFileSync(WAV).subarray(44);
    mkdirSync(TMP, { recursive: true });
    try {
      if (want.deleteLock) await reportDeleteLock(loaded, packs, pcm);
      if (want.decodeCost) await reportDecodeCost(loaded, packs, pcm);
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  }
}
