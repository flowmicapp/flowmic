// scripts/eval/speech-quality/lib.mjs
//
// Shared plumbing for the speech-quality harness (card EVAL-1): paths, secret
// loading, WAV I/O, the production-source bundle, a tiny pool, and the
// per-card usage ledger.
//
// NOT A GATE. Nothing here may be wired into verify:* — every runner calls a
// paid external API (Soniox, DeepSeek). See README.md.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..', '..');

/** The MAIN checkout's `.local/` (gitignored). A lane worktree has no secrets
 *  and must not grow its own audio bed, so every lane writes to the one place.
 *  Override with FLOWMIC_EVAL_DATA. */
export function dataRoot() {
  if (process.env.FLOWMIC_EVAL_DATA) return resolve(process.env.FLOWMIC_EVAL_DATA);
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim();
  return join(dirname(common), '.local');
}
export const AUDIO_DIR = () => join(dataRoot(), 'eval-audio');
export const RESULTS_DIR = () => join(dataRoot(), 'eval-speech');

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}

/** KEY=VALUE reader for `.local/*.env`. Returns a plain object; never logs. */
export function readEnvFile(name) {
  const p = join(dataRoot(), name);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  const env = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/** Card ML-0: FLOWMIC_EVAL_CORPUS=corpus-ml.json selects the multilingual
 *  corpus for every runner and scorer (they all load through here). */
export function loadCorpus() {
  return JSON.parse(readFileSync(join(HERE, process.env.FLOWMIC_EVAL_CORPUS ?? 'corpus.json'), 'utf8'));
}

/** The wire language tag a corpus `lang` stands for (what the phone sends as
 *  the session language). Corpus codes ARE wire tags (en, fr, ja, ...), except
 *  the two Chinese sets: `zh` and `mixed` (Chinese-first speech with English
 *  terms) are sent as zh-CN, which is what EVAL-1 always sent for both.
 *  Deliberately not a table of languages: that list lives in
 *  packages/protocol/src/locales.ts and kSpokenLangs (lint i18n-add-locale-cost). */
export function langTag(lang) {
  if (typeof lang !== 'string' || !/^[a-z]{2,3}$|^mixed$/.test(lang)) throw new Error(`no language tag for corpus lang ${lang}`);
  return lang === 'zh' || lang === 'mixed' ? 'zh-CN' : lang;
}

// ── WAV (16 kHz mono s16le only) ─────────────────────────────────────────────
export function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not RIFF/WAVE`);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = b.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    else if (id === 'data') data = body;
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt/data chunk`);
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16) {
    throw new Error(`${path}: need PCM 16 kHz mono 16-bit, got ${JSON.stringify(fmt)}`);
  }
  return Buffer.from(data);
}

export function writeWav(path, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([h, pcm]));
}

export const pcmSeconds = (pcm) => pcm.length / 32000;

// ── usage ledger (card budget: Soniox audio minutes, LLM calls) ─────────────
/** `name` lets a runner keep its own ledger (run-relay.mjs: relay-usage-ledger.jsonl). */
/** FLOWMIC_EVAL_LEDGER renames the default ledger, so a new card can start its
 *  own budget without touching another card's file (ML-0). */
export function ledgerPath(name = process.env.FLOWMIC_EVAL_LEDGER ?? 'usage-ledger.jsonl') { return join(RESULTS_DIR(), name); }
export function recordUsage(entry, name) {
  mkdirSync(RESULTS_DIR(), { recursive: true });
  appendFileSync(ledgerPath(name), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}
export function usageTotals(name) {
  const t = { soniox_audio_sec: 0, llm_calls: 0 };
  if (!existsSync(ledgerPath(name))) return t;
  for (const line of readFileSync(ledgerPath(name), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    t.soniox_audio_sec += e.soniox_audio_sec ?? 0;
    t.llm_calls += e.llm_calls ?? 0;
  }
  return t;
}

// ── bounded concurrency ─────────────────────────────────────────────────────
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function gitHead(dir) {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

// ── production source → one ESM bundle ──────────────────────────────────────
//
// The product symbols are IMPORTED from server-core source, never re-typed:
// a copy of the polish prompt or the context builder would drift and the
// harness would then measure something the product does not run. Same route
// verify/eval/eval-prod-bundle.mjs takes (and the same esbuild resolver, which
// carries the account of why a plain require.resolve('esbuild') fails here).
//
// `serverCoreDir` defaults to this checkout's apps/server-core; pass another
// lane's apps/server-core to compare builds (`--server-core <path>`).
export async function loadProductBundle(serverCoreDir = join(REPO, 'apps', 'server-core')) {
  const { resolveEsbuild } = await import(pathToFileURL(join(REPO, 'verify', 'eval', 'eval-prod-bundle.mjs')).href);
  const found = resolveEsbuild();
  if (!found.ok) throw new Error(found.reason);
  const esbuild = await import(pathToFileURL(found.entry).href);
  const src = (rel) => join(resolve(serverCoreDir), 'src', rel).replace(/\\/g, '/');
  if (!existsSync(join(resolve(serverCoreDir), 'src', 'stt', 'stt-polish.ts'))) throw new Error(`${serverCoreDir} does not look like apps/server-core`);
  const entrySrc = [
    `export { polishFinalText, __resetPolishCacheForTest } from '${src('stt/stt-polish')}';`,
    `export { managedLlmConfig } from '${src('compose/llm-config')}';`,
    `export { makeFinalTextPipeline } from '${src('stt/final-text-pipeline')}';`,
    `export { buildDictionaryReplacer } from '${src('compose/dictionary-replace')}';`,
    `export { buildSonioxContext } from '${src('stt/terminology-context')}';`,
    // card CTX-1 — optional so an older lane (no default list yet) still bundles.
    ...(existsSync(join(resolve(serverCoreDir), 'src', 'stt', 'coding-terms.ts'))
      ? [`export { assembleSonioxContext } from '${src('stt/terminology-context')}';`,
         `export { CODING_DEFAULT_TERMS } from '${src('stt/coding-terms')}';`]
      : []),
    `export { streamerFor as llmStreamerFor } from '${src('compose/llm')}';`,
    // card ML-0: the two guards and the compose prompt, for run-compose.mjs and
    // run-guard-pairs.mjs. Imported, never re-typed (same rule as above).
    `export { checkMeaningPreserved } from '${src('stt/stt-polish-guard')}';`,
    `export { guardComposeOutput } from '${src('compose/output-guard')}';`,
    `export { renderSystemPrompt } from '${src('compose/prompt')}';`,
  ].join('\n');
  const tag = createHash('sha256').update(entrySrc).digest('hex').slice(0, 10);
  const buildDir = join(RESULTS_DIR(), 'build');
  mkdirSync(buildDir, { recursive: true });
  const entry = join(buildDir, `entry-${tag}.ts`);
  const outfile = join(buildDir, `product-${tag}-${Date.now()}.mjs`);
  writeFileSync(entry, entrySrc, 'utf8');
  esbuild.buildSync({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error',
    // Fully bundled (no `packages: 'external'`): the outfile lives outside any
    // package, so a bare import left in it would not resolve.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, head: gitHead(serverCoreDir), dir: resolve(serverCoreDir) };
}

export function percentile(xs, p) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
