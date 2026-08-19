// RT-6-a — the engine legs the audio A/B bed can drive.
//
// Every adapter obeys the same three-method contract (see audio-ab-eval.mjs's
// header) and every `probe()` obeys the same rule:
//
//   🔴 A PROBE MUST NOT DOWNLOAD, INSTALL, OR SPEND MONEY. It answers "could this
//   leg run right now, on this machine, as it stands", and nothing else. A probe
//   that fixes what it finds turns "the model is missing" into "the model is
//   here now", which is the difference between a measurement and a side effect.
//   `sherpaLocal.probe()` in particular NEVER consults, sets, or honours
//   FLOWMIC_SHERPA_AUTO_DOWNLOAD — auto-download is opt-in by owner ruling
//   (2026-08-09, DISC-2, commit 2724930) and an eval bed is not the place it
//   gets opted into.
//
// A leg that cannot run reports `{ready:false, reason}` and the bed refuses to
// pretend. It never substitutes an empty transcript for an absent engine: an
// empty transcript scores 0.0 recall, which reads as "this engine is terrible"
// rather than "this engine was never asked".
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 EVERY `transcribe()` MUST DECLARE `completed`. THIS IS THE P0 FIX.
// ─────────────────────────────────────────────────────────────────────────────
// The rule above ("never substitute an empty transcript for an absent engine")
// was stated in this header from day one and the soniox leg violated it, because
// the violation did not go through `probe()`. `finish()` resolved NORMALLY from
// `ws.on('error')`, from a server error frame, and from the timeout — handing the
// bed `text: ''` with no error attached. Three real runs on this machine
// (【measured·dev-pc-b】 2026-08-10, reports in .local/rt6-audio-ab/):
//
//   ws error: Client network socket disconnected before secure TLS connection
//             was established   frames 0, finalTokens 0  → scored recall 0.0000
//   server error 408 Request timeout.  frames 20, finalTokens 0 → recall 0.0000
//   TIMEOUT 120000ms                   frames 99, finalTokens 75 → recall 0.6201
//
// The first two reached a ledger row as a product finding and were retracted.
// The third is the one that matters most here: it has 75 final tokens, so the
// obvious guard ("finalTokens === 0 plus a bad reason") would have let it
// through. A TRUNCATED session is not a smaller result, it is not a result.
//
// ⇒ Completion is a property of the SESSION, not of the token count:
//
//   transcribe() → { text, tailMs?, meta?, completed: boolean, incompleteWhy? }
//
//   completed:true   this leg reached its own clean terminal condition and the
//                    text is the engine's COMPLETE answer to this segment.
//   completed:false  it did not. `incompleteWhy` says so in one line.
//   ABSENT           the bed VOIDS the row and exits non-zero. See
//                    audio-ab-eval.mjs `runLeg` for why the unsafe default is
//                    the one that fabricates a number and the safe one only
//                    refuses loudly.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 EVERY ADAPTER MUST ALSO DECLARE `assembler`. THIS IS THE P2 FIX.
// ─────────────────────────────────────────────────────────────────────────────
// `{ kind: 'product' | 'bed-local', note: string }` — where did the string in
// `text` come from? The soniox leg below assembles tokens ITSELF and has never
// run the product's `TokenAccumulator`, so its output is NOT what a user would
// see. That is not a hypothetical: this bed reported the literal `<end>` inside
// a "final transcript", it was written up as a product defect, and the
// retraction now lives in packages/stt-cloud/src/engines/soniox-markers.ts and
// its test file (「量了仪器、当成被测对象」). A report that silently reads like
// product output IS the defect, so the declaration is data on the leg and the
// renderer prints it — see audio-ab-eval.mjs `renderReport`.
//
// Node 22 ESM.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openrouterSttAdapter } from './audio-ab-openrouter.mjs';
import { assemblyaiSttAdapter } from './audio-ab-assemblyai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const nodeRequire = createRequire(import.meta.url);

/**
 * `ws` is a dependency of the workspace packages that actually talk to Soniox,
 * not of the repo root, and pnpm's strict layout means it is NOT resolvable from
 * `scripts/`. Anchor the require at server-core's manifest — the same trick the
 * L9 capture script used against this same service, and the reason it worked
 * there. Resolving it the naive way fails with MODULE_NOT_FOUND on a correctly
 * installed tree, which reads as "run pnpm install" and sends the operator to
 * fix something that is not broken.
 */
const wsRequire = createRequire(join(REPO_ROOT, 'apps', 'server-core', 'package.json'));

// ---------------------------------------------------------------------------
// spec parsing: `name` or `name:{"json":"config"}`
// ---------------------------------------------------------------------------

/**
 * @param {string} spec
 * @returns {{name: string, config: object}}
 */
export function parseSpec(spec) {
  const s = String(spec ?? '');
  const i = s.indexOf(':');
  if (i < 0) return { name: s, config: {} };
  const name = s.slice(0, i);
  const rest = s.slice(i + 1);
  let config;
  try { config = JSON.parse(rest); } catch (e) {
    throw new Error(`adapter ${JSON.stringify(name)}: config is not JSON — ${e.message}\n  got: ${rest}`);
  }
  if (config === null || typeof config !== 'object') throw new Error(`adapter ${JSON.stringify(name)}: config must be a JSON object`);
  return { name, config };
}

// ---------------------------------------------------------------------------
// Leg: fake — no engine, no network, deterministic
// ---------------------------------------------------------------------------

/**
 * Derives its "transcript" from the segment's own reference, mutating it in a
 * named, deterministic way. Two jobs:
 *
 *  1. It is the drill's subject — a fake that returns KNOWN text produces KNOWN
 *     scores, so the bed can be kept honest in CI with no engine and no network.
 *  2. It makes the CLI exercisable end to end on the real corpus by anyone, on
 *     any machine, before they have a single engine configured. `--a=fake
 *     --b=fake:{"mode":"droptail"}` is a complete, runnable A/B whose answer is
 *     known in advance, which is the cheapest possible check that the bed itself
 *     is not lying before it is pointed at a real engine.
 *
 * Modes and what each one is FOR:
 *   perfect    — echo the reference. recall 1.0000, zero missing. The identity
 *                control: if this is not 1.0, the metric is broken, not the engine.
 *   droptail   — keep the first `fraction` of the script. The real N-1 failure
 *                shape (a whole segment lost) ⇒ P3's `block`.
 *   dropspan   — keep everything but delete the Latin spans. Scores ~1.0 on
 *                recall while failing span survival — the exact "aggregate looks
 *                healthy, the code-switch case is dead" hazard RT-6's
 *                `language_hints_strict` card names.
 *   scatter    — delete every Nth character. Same kind of recall damage as
 *                droptail with the OPPOSITE shape ⇒ P3's `scatter`. The pair
 *                (droptail, scatter) is what proves the shape aid discriminates.
 *   duplicate  — say it all twice. recall stays 1.0000 (recall is blind to extra
 *                text by construction); only `lenRatio` sees it.
 *   silent     — empty transcript. recall 0.0. 🔴 NOT the same thing as
 *                `incomplete`: this is a leg that COMPLETED and said nothing,
 *                which is a real (bad) result. Keeping the two apart is the
 *                whole P0 fix, so the pair is what the drill asserts on.
 *   respaced   — write the Latin spans with their word boundaries moved
 *                (`getUserProfile` → `get user profile`). recall 1.0000, span
 *                survival 1.0 — and the P1 `respaced` signal is the only thing
 *                that sees it. The real measured shape, not an invented one.
 *   incomplete — the session DID NOT FINISH. Returns partial text AND
 *                `completed:false`, reproducing the 2026-08-10 truncation
 *                (75 final tokens, `TIMEOUT 120000ms`) rather than the easier
 *                zero-token shape. The bed must VOID it, never score it.
 *                `voidSegments:["11"]` restricts the failure to named segments,
 *                which is the shape that actually happened — one dead session
 *                inside a run that otherwise looks healthy.
 */
export function fakeAdapter(config = {}) {
  const mode = config.mode ?? 'perfect';
  const fraction = typeof config.fraction === 'number' ? config.fraction : 0.5;
  const every = typeof config.every === 'number' ? config.every : 4;
  const latencyMs = typeof config.latencyMs === 'number' ? config.latencyMs : 0;
  const known = ['perfect', 'droptail', 'dropspan', 'scatter', 'duplicate', 'silent', 'respaced', 'incomplete'];
  if (!known.includes(mode)) throw new Error(`fake adapter: unknown mode ${JSON.stringify(mode)} (known: ${known.join(', ')})`);

  const mutate = (ref) => {
    switch (mode) {
      case 'perfect': return ref;
      case 'droptail': return ref.slice(0, Math.max(1, Math.floor(ref.length * fraction)));
      case 'dropspan': return ref.replace(/[A-Za-z]{2,}/g, '');
      case 'scatter': return [...ref].filter((_, i) => i % every !== 0).join('');
      case 'duplicate': return `${ref}${ref}`;
      case 'silent': return '';
      // Split every camelCase / long Latin run into spaced words. Recall and
      // span survival both stay perfect (normalize() deletes whitespace); only
      // the `respaced` signal moves.
      case 'respaced': return ref.replace(/[A-Za-z]{2,}/g, (w) => (/[a-z][A-Z]/.test(w)
        ? w.replace(/([a-z])([A-Z])/g, '$1 $2')
        : w.split('').join(' ')));
      default: return ref;
    }
  };

  return {
    name: config.__name ?? 'fake',
    describe: () => `fake adapter, mode=${mode}${mode === 'droptail' ? ` fraction=${fraction}` : ''}${mode === 'scatter' ? ` every=${every}` : ''} (no engine, no network)`,
    // There is no engine and therefore no assembler. Saying `bed-local` would
    // overstate the resemblance to a real leg; `synthetic` says what it is.
    assembler: { kind: 'synthetic', note: 'derived from the reference script by a named mutation — not a transcript at all' },
    probe: async () => ({ ready: true }),
    transcribe: async (_pcm, seg) => {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      // `mode:'incomplete'` is the drill's void subject and NOTHING else: it is
      // the only way to exercise the void path without a network. It returns
      // text so that the test proves the bed voids on the DECLARATION, not on
      // the text being empty — an empty-string guard would miss the real 75-token
      // truncation shape measured on 2026-08-10.
      // 🔴 `voidSegments` exists because the realistic shape is 1 void among N,
      // not N of N. The 2026-08-10 defect was ONE dead session inside a 5-segment
      // run, and that is the case where a void is dangerous: the aggregate still
      // looks like a corpus average and is silently over a subset. N-of-N voids
      // are the easy case — they trip "this leg scored nothing" (exit 2).
      if (mode === 'incomplete' && (!Array.isArray(config.voidSegments) || config.voidSegments.map(String).includes(String(seg.id)))) {
        return {
          text: (seg.reference ?? '').slice(0, 8),
          tailMs: null,
          meta: { mode, finalTokens: 3 },
          completed: false,
          incompleteWhy: 'simulated: server error 408 Request timeout.',
        };
      }
      return { text: mutate(seg.reference ?? ''), tailMs: latencyMs, meta: { mode }, completed: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Leg: sherpa-local (built-in offline SenseVoice-small int8)
// ---------------------------------------------------------------------------

/**
 * 🔴 THESE CONSTANTS ARE A SECOND COPY, AND THEY ARE PINNED BY THE DRILL.
 *
 * The authority is `apps/server-core/src/stt/sherpa/model-manifest.ts` and
 * `.../engines/sherpa-local.ts`, which are TypeScript that a plain `.mjs` script
 * cannot import. Rather than leave a comment asking people to keep two copies in
 * step — the shape this repo has watched fail repeatedly — the drill
 * (`scripts/rt6-audio-ab-eval.test.mjs` §6) greps those two sources for every
 * literal below and goes red when one moves. The recognizer options in
 * `loadRecognizer()` matter as much as the file list: decoding the same audio
 * with `useInverseTextNormalization` off would produce 「四点半」 where the
 * product produces 「4:30」, and the bed would then be measuring a configuration
 * nobody ships.
 */
export const SHERPA_REPO_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
export const SHERPA_FILES = [
  { path: 'model.int8.onnx', size: 239_233_841 },
  { path: 'tokens.txt', size: 315_894 },
];
export const SHERPA_RECOGNIZER = {
  sampleRate: 16_000,
  featureDim: 80,
  useInverseTextNormalization: 1,
  language: 'auto',
  provider: 'cpu',
};

/** Mirrors `resolveSherpaModelDir()` — same env override, same default layout. */
export function resolveSherpaModelDir(env = process.env) {
  const override = env.FLOWMIC_SHERPA_MODEL_DIR;
  if (override && override.length > 0) return override;
  const appData = process.platform === 'win32'
    ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
    : (env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
  return join(appData, 'FlowMic', 'models', SHERPA_REPO_DIR);
}

/**
 * Is the model on disk, complete, at the pinned sizes?
 *
 * Size only — the product's own `isModelComplete()` also verifies the pinned
 * SHA-256, and this deliberately does NOT reimplement that: a probe that
 * re-derives the integrity gate would be a second answer to "is this model
 * good?", and the engine's `open()` is going to run the real one seconds later
 * anyway. What this needs to answer is the cheap question — "is there anything
 * here to run at all". It reports `.part` files explicitly, because a partial
 * download is the state that looks like progress and behaves like absence.
 *
 * @param {string} dir
 */
export function inspectSherpaModel(dir) {
  const missing = [];
  const wrongSize = [];
  const partials = [];
  for (const f of SHERPA_FILES) {
    const p = join(dir, f.path);
    if (existsSync(p)) {
      const sz = statSync(p).size;
      if (sz !== f.size) wrongSize.push(`${f.path} is ${sz} B, expected ${f.size} B`);
      continue;
    }
    missing.push(f.path);
    const part = `${p}.part`;
    if (existsSync(part)) partials.push(`${f.path}.part (${statSync(part).size} B — an unfinished download, not a model)`);
  }
  const ok = missing.length === 0 && wrongSize.length === 0;
  return { ok, dir, missing, wrongSize, partials };
}

export function sherpaLocalAdapter(config = {}) {
  const threads = typeof config.threads === 'number' ? config.threads : 2;
  const modelDir = config.modelDir ?? resolveSherpaModelDir();
  let rec = null;

  return {
    name: config.__name ?? 'sherpa-local',
    describe: () => `sherpa-local SenseVoice-small int8, threads=${threads}, model=${modelDir}`,
    // 🔴 `bed-local`, and the honesty here is narrower than it looks. The string
    // does come straight out of `rec.getResult(stream).text` with no joining of
    // our own — but the product's own sherpa engine post-processes what it gets
    // (apps/server-core/src/stt/engines/sherpa-local.ts), and this bed does not
    // run that. So the text is the RECOGNISER's answer, not the PRODUCT's.
    assembler: { kind: 'bed-local', note: 'raw OfflineRecognizer.getResult().text — the product\'s own sherpa engine wrapper is not in this path' },
    probe: async () => {
      // Deliberately NOT reading FLOWMIC_SHERPA_AUTO_DOWNLOAD. See this file's header.
      const m = inspectSherpaModel(modelDir);
      if (!m.ok) {
        const bits = [
          m.missing.length ? `missing: ${m.missing.join(', ')}` : null,
          m.wrongSize.length ? `wrong size: ${m.wrongSize.join('; ')}` : null,
          m.partials.length ? `partial: ${m.partials.join('; ')}` : null,
        ].filter(Boolean);
        return {
          ready: false,
          reason: `model incomplete in ${modelDir} — ${bits.join(' | ')}. This bed will NOT download it ` +
            `(auto-download is opt-in by owner ruling 2026-08-09); supply the model, or point ` +
            `FLOWMIC_SHERPA_MODEL_DIR at a complete copy.`,
        };
      }
      try { nodeRequire.resolve('sherpa-onnx-node'); } catch { return { ready: false, reason: 'sherpa-onnx-node is not resolvable from scripts/ — run pnpm install' }; }
      return { ready: true };
    },
    transcribe: async (pcm) => {
      if (!rec) {
        const sherpa = nodeRequire('sherpa-onnx-node');
        rec = new sherpa.OfflineRecognizer({
          featConfig: { sampleRate: SHERPA_RECOGNIZER.sampleRate, featureDim: SHERPA_RECOGNIZER.featureDim },
          modelConfig: {
            senseVoice: {
              model: join(modelDir, 'model.int8.onnx'),
              useInverseTextNormalization: SHERPA_RECOGNIZER.useInverseTextNormalization,
              language: SHERPA_RECOGNIZER.language,
            },
            tokens: join(modelDir, 'tokens.txt'),
            numThreads: threads,
            provider: SHERPA_RECOGNIZER.provider,
            debug: 0,
          },
        });
      }
      const samples = new Float32Array(pcm.length >> 1);
      for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(i * 2) / 32768;
      // Offline batch decode: nothing happens until every sample is in, so the
      // whole cost IS the tail. Reported as tailMs honestly rather than left
      // null — for this engine the two quantities really are the same one, and
      // saying so is different from silently substituting one for the other.
      const t0 = Date.now();
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate: SHERPA_RECOGNIZER.sampleRate, samples });
      rec.decode(stream);
      const result = rec.getResult(stream);
      // Offline batch decode has no partial terminal state: `decode()` either
      // returns or throws, and a throw is already the bed's error path. There is
      // no third outcome to be honest about, so `completed` is unconditionally
      // true here — and that is a claim about THIS engine's shape, not a default.
      return { text: typeof result?.text === 'string' ? result.text : '', tailMs: Date.now() - t0, meta: { lang: result?.lang ?? null, threads }, completed: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Leg: soniox (real network, real key, real money)
// ---------------------------------------------------------------------------

const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const SONIOX_ENV = join(REPO_ROOT, '.local', 'soniox.env');

/**
 * The ONE terminal condition that means "Soniox has given us its complete answer
 * to this segment". Everything else — a server error frame, the wall-clock
 * timeout, a socket error, a close that arrives before this — is an incomplete
 * session whose text may not be scored.
 *
 * Exported so the drill can pin it: the value has to be the literal `finish()`
 * is called with on the `f.finished === true` branch, and a rename that touched
 * one and not the other would make EVERY session incomplete (loud) rather than
 * every session complete (silent). Failure direction chosen on purpose.
 */
export const SONIOX_CLEAN_FINISH = 'finished:true';

/**
 * Read `.local/soniox.env` into a plain object.
 *
 * The bed never prints a value from this file and never puts one in a report;
 * `describe()` states only the key's LENGTH so a run is reproducible without the
 * secret leaving the machine.
 */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * @param {object} config
 *   model            — override the model id (default: from soniox.env, else stt-rt-v5)
 *   pace             — 'realtime' (default) | 'fast'
 *   languageHints    — default ['zh','en']
 *   extraConfig      — merged into the config frame. THIS IS THE A/B KNOB:
 *                      `{"enable_endpoint_detection":true}` for RT-6 D1b,
 *                      `{"language_hints_strict":true}`, `{"context":"…"}`.
 */
export function sonioxAdapter(config = {}) {
  const env = readEnvFile(SONIOX_ENV);
  const apiKey = config.apiKey ?? env.FLOWMIC_MANAGED_STT_API_KEY ?? process.env.FLOWMIC_MANAGED_STT_API_KEY ?? '';
  const model = config.model ?? env.FLOWMIC_MANAGED_STT_MODEL ?? 'stt-rt-v5';
  const pace = config.pace ?? 'realtime';
  const languageHints = config.languageHints ?? ['zh', 'en'];
  const extraConfig = config.extraConfig ?? {};
  const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : 120_000;

  return {
    name: config.__name ?? 'soniox',
    describe: () =>
      `soniox ${model} · pace=${pace} · hints=${JSON.stringify(languageHints)} · ` +
      `extra=${JSON.stringify(extraConfig)} · key ${apiKey.length} chars (value never printed)`,
    assembler: {
      kind: 'bed-local',
      note:
        'this bed joins Soniox tokens itself (`finals.push(tok.text)` … `join(\'\')`) and NEVER runs the ' +
        'product\'s TokenAccumulator (packages/stt-cloud/src/engines/soniox.ts). Three differences that ' +
        'have already produced a false product finding: (1) control markers are NOT refused, so `<end>` and ' +
        '`<fin>` appear verbatim in the text below and the product would never emit them; (2) markers fused ' +
        'inside a text token are NOT stripped; (3) there is no final/provisional split, so nothing here is ' +
        'the `final` event\'s payload. Read this text as THE VENDOR\'S TOKENS, not as what a user would see.',
    },
    probe: async () => {
      if (!existsSync(SONIOX_ENV) && !process.env.FLOWMIC_MANAGED_STT_API_KEY) {
        return { ready: false, reason: `no key: ${SONIOX_ENV} is absent and FLOWMIC_MANAGED_STT_API_KEY is unset` };
      }
      if (!apiKey) return { ready: false, reason: `no key: FLOWMIC_MANAGED_STT_API_KEY is empty in ${SONIOX_ENV}` };
      try { wsRequire.resolve('ws'); } catch { return { ready: false, reason: "the 'ws' package is not resolvable from apps/server-core — run pnpm install" }; }
      // Deliberately NOT a live connection test. A probe that opens a billed
      // vendor session to prove it can open a billed vendor session has already
      // done the thing it was asked to check for.
      return { ready: true };
    },
    transcribe: (pcm, seg) => new Promise((resolveP) => {
      const WebSocket = wsRequire('ws');
      const ws = new WebSocket(SONIOX_URL);
      /** @type {{t:number, dir:string, v:unknown}[]} */
      const trace = [];
      let lastAudioAt = null;
      let settled = false;
      const t0 = Date.now();
      const finals = [];
      let firstTokenAt = null;

      /**
       * 🔴 `completed` IS DERIVED FROM `why`, NOT PASSED IN BY THE CALLER.
       *
       * Five call sites reach this function and exactly one of them is a clean
       * finish. If each passed its own flag, the P0 defect would be one wrong
       * boolean away from returning — and the wrong boolean is the friendly one.
       * Comparing against SONIOX_CLEAN_FINISH here means a new terminal path
       * added next year is NOT completed until someone deliberately makes it so.
       */
      const finish = (why) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* already closing */ }
        const completed = why === SONIOX_CLEAN_FINISH;
        resolveP({
          text: finals.join(''),
          tailMs: lastAudioAt === null ? null : Date.now() - lastAudioAt,
          completed,
          incompleteWhy: completed ? undefined
            : `${why} — the session never reached ${JSON.stringify(SONIOX_CLEAN_FINISH)}; ` +
              `${finals.length} final token(s) had arrived, over ${trace.length} frame(s)`,
          meta: {
            why,
            model,
            pace,
            extraConfig,
            finalTokens: finals.length,
            firstTokenMs: firstTokenAt === null ? null : firstTokenAt - t0,
            frames: trace.length,
          },
        });
      };

      const timer = setTimeout(() => finish(`TIMEOUT ${timeoutMs}ms`), timeoutMs);

      ws.on('open', async () => {
        ws.send(JSON.stringify({
          api_key: apiKey,
          model,
          audio_format: 'pcm_s16le',
          num_channels: 1,
          sample_rate: seg?.fmt?.sampleRate ?? 16_000,
          language_hints: languageHints,
          ...extraConfig,
        }));
        // 1920 B of s16le mono @16 kHz = 60 ms of audio, the frame size the L9
        // capture used against this same service.
        const FRAME = 1920;
        const perFrameMs = pace === 'realtime' ? 60 : 10;
        for (let off = 0; off < pcm.length; off += FRAME) {
          if (settled) return;
          ws.send(pcm.subarray(off, Math.min(off + FRAME, pcm.length)));
          await new Promise((r) => setTimeout(r, perFrameMs));
        }
        lastAudioAt = Date.now();
        // 🔴 THE END-OF-STREAM FRAME MUST BE AN EMPTY *TEXT* FRAME, NOT AN EMPTY
        // BINARY ONE. This is L9 (2026-08-02): the product shipped an empty
        // binary frame, Soniox never answered `finished:true`, `flush()` never
        // resolved, and every utterance fell through to a 3-second fallback —
        // "the number was real and the conclusion was wrong" for a whole window.
        // Measured proof is in docs/strategy/shots-2026-08-02-l9-soniox-output/
        // soniox-eos-variants.txt: variant A (empty Buffer) never finishes,
        // variant B (empty string) answers in 2,005 ms.
        ws.send('');
      });

      ws.on('message', (d) => {
        let f;
        try { f = JSON.parse(typeof d === 'string' ? d : d.toString('utf8')); } catch { return; }
        trace.push({ t: Date.now() - t0, dir: 'recv', v: f });
        for (const tok of f.tokens ?? []) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          if (tok.is_final === true && typeof tok.text === 'string') finals.push(tok.text);
        }
        if (f.error_code || f.error_message) { clearTimeout(timer); finish(`server error ${f.error_code ?? ''} ${f.error_message ?? ''}`.trim()); }
        if (f.finished === true) { clearTimeout(timer); finish(SONIOX_CLEAN_FINISH); }
      });
      ws.on('close', () => { clearTimeout(timer); finish('ws closed'); });
      ws.on('error', (e) => { clearTimeout(timer); finish(`ws error: ${e.message}`); });
    }),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ADAPTERS = {
  fake: fakeAdapter,
  'sherpa-local': sherpaLocalAdapter,
  soniox: sonioxAdapter,
  openrouter: openrouterSttAdapter,
  assemblyai: assemblyaiSttAdapter,
};

/**
 * @param {string} spec `name` or `name:{json}`
 */
export function buildAdapter(spec) {
  const { name, config } = parseSpec(spec);
  const make = ADAPTERS[name];
  if (!make) throw new Error(`unknown adapter ${JSON.stringify(name)} (known: ${Object.keys(ADAPTERS).join(', ')})`);
  // Two legs of the same engine with different configs must be distinguishable
  // in the report, or an A/B of soniox-vs-soniox prints two columns called
  // "soniox" and the reader has to guess which is which.
  const label = Object.keys(config).length > 0 ? `${name}${suffixFor(config)}` : name;
  return make({ ...config, __name: label });
}

/**
 * A short, distinguishing label for a configured leg.
 *
 * 🔴 Values are included ONLY when they are short scalars. Measured the hard
 * way: the first version interpolated whole config values, and a `context`
 * payload — a field whose entire purpose is to carry up to 10,000 characters of
 * prose — produced a leg name containing quotes, full-width colons and CJK. The
 * bed derives its default report filename from that name, so the run finished,
 * both legs transcribed correctly, and then the write failed with ENOENT. A
 * long-string knob is exactly the case this label must survive, because it is
 * one of the four knobs RT-6 exists to A/B.
 */
function suffixFor(config) {
  if (typeof config.mode === 'string') return `-${config.mode}`;
  if (typeof config.model === 'string' && config.model.length > 0) {
    const slug = config.model.split('/').pop() ?? config.model;
    return `-${slug.length <= 24 ? slug : 'model'}`;
  }
  const extra = config.extraConfig;
  if (extra && typeof extra === 'object') {
    const keys = Object.keys(extra);
    if (keys.length === 0) return '-cfg';
    return `-${keys.map((k) => {
      const v = extra[k];
      const scalar = typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 12);
      return scalar ? `${k}=${v}` : k;
    }).join(',')}`;
  }
  return '-cfg';
}
