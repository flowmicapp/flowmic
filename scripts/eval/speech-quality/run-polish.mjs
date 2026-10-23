#!/usr/bin/env node
// scripts/eval/speech-quality/run-polish.mjs — run STT finals (and the
// references) through the PRODUCT's realtime polish, Strict and Smooth.
//
//   node scripts/eval/speech-quality/run-polish.mjs --stt <stt-hints.jsonl>
//   node scripts/eval/speech-quality/run-polish.mjs --stt <f> --server-core ../lane-b/apps/server-core
//   node scripts/eval/speech-quality/run-polish.mjs --stt <f> --sources stt --strengths smooth --ids en-fil-01
//
// What is called: `polishFinalText` bundled from <server-core>/src (default:
// this checkout), with the LLM config from the product's own
// `managedLlmConfig(env)` — the same env-gated path the relay uses — pointed at
// DeepSeek with the key in .local/deepseek.env (never printed). The vendor body
// matches production (`FLOWMIC_LLM_VENDOR_BODY={"thinking":{"type":"disabled"}}`,
// web repo deploy/cloud-compose-probe.mjs). Production-equivalent inputs:
// the text is the STT final after the product's final-text pipeline (empty
// dictionary), no protected terms, no scenario block — i.e. a user with nothing
// configured. The in-process polish cache is reset before every call so each
// latency is a real round trip.
//
// Sources: `stt` = the STT run's pipeline_text; `ref` = the corpus reference
// through the same pipeline (isolates polish behaviour from recognition errors).
//
// LLM calls are counted in the usage ledger; a run that would take the card past
// FLOWMIC_EVAL_LLM_CAP (default 600) refuses unless --allow-over.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESULTS_DIR, langTag, loadCorpus, loadProductBundle, parseArgs, pool, readEnvFile, readJsonl, recordUsage, usageTotals } from './lib.mjs';

const args = parseArgs();
if (!args.stt) throw new Error('--stt <stt results .jsonl> is required');
const sources = String(args.sources ?? 'stt,ref').split(',');
const strengths = String(args.strengths ?? 'strict,smooth').split(',');
const concurrency = Number(args.concurrency ?? 4);
const cap = Number(process.env.FLOWMIC_EVAL_LLM_CAP ?? 600);

const corpus = loadCorpus();
const byId = new Map(corpus.items.map((it) => [it.id, it]));
const idSet = args.ids ? new Set(String(args.ids).split(',')) : null;
const langSet = args.lang ? new Set(String(args.lang).split(',')) : null;
const notTags = args['not-tags'] ? String(args['not-tags']).split(',') : [];
// `--ref-not-tags`: skip the reference source for these items only (ML-0: FLEURS
// references are read text, so polishing them measures nothing about dictation).
const refNotTags = args['ref-not-tags'] ? String(args['ref-not-tags']).split(',') : [];
const sttRows = readJsonl(resolve(args.stt)).filter((r) => r.id && r.variant === null && (!idSet || idSet.has(r.id))
  && (!langSet || langSet.has(r.lang)) && !notTags.some((t) => byId.get(r.id)?.tags.includes(t)));

const { mod: product, head } = await loadProductBundle(args['server-core']);
const pipeline = product.makeFinalTextPipeline(product.buildDictionaryReplacer([]));
const langOf = (it) => langTag(it.lang);

const ds = readEnvFile('deepseek.env');
if (!ds.FLOWMIC_DEEPSEEK_API_KEY) throw new Error('.local/deepseek.env has no FLOWMIC_DEEPSEEK_API_KEY');
const llmEnv = {
  FLOWMIC_MANAGED_LLM_ENABLED: '1',
  FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
  FLOWMIC_MANAGED_LLM_ENDPOINT: args.endpoint ?? 'https://api.deepseek.com/v1',
  FLOWMIC_MANAGED_LLM_MODEL: args.model ?? ds.FLOWMIC_DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
  FLOWMIC_MANAGED_LLM_API_KEY: ds.FLOWMIC_DEEPSEEK_API_KEY,
};
Object.assign(process.env, llmEnv, { FLOWMIC_LLM_VENDOR_BODY: process.env.FLOWMIC_LLM_VENDOR_BODY ?? '{"thinking":{"type":"disabled"}}' });
const cfg = product.managedLlmConfig(process.env);

const jobs = [];
for (const row of sttRows) {
  const it = byId.get(row.id);
  if (!it) continue;
  for (const source of sources) {
    if (source === 'ref' && refNotTags.some((t) => it.tags.includes(t))) continue;
    const input = source === 'stt' ? row.pipeline_text : pipeline(it.reference, { isSegment: false, language: langOf(it) });
    if (typeof input !== 'string' || input.trim() === '') continue;
    for (const strength of strengths) jobs.push({ it, source, strength, input });
  }
}
const used = usageTotals();
console.log(`[run-polish] server-core=${head} model=${cfg.model} calls=${jobs.length}; ledger so far ${used.llm_calls} of cap ${cap}`);
if (args['dry-run']) process.exit(0);
if (used.llm_calls + jobs.length > cap && !args['allow-over']) {
  console.error(`[run-polish] REFUSED: would exceed the card's LLM-call cap (${cap}). Narrow with --ids/--sources/--strengths or pass --allow-over.`);
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
mkdirSync(RESULTS_DIR(), { recursive: true });
const out = resolve(args.out ?? join(RESULTS_DIR(), `polish-${stamp}.jsonl`));
writeFileSync(out, JSON.stringify({ meta: { at: new Date().toISOString(), stt: resolve(args.stt), server_core_head: head, model: cfg.model, endpoint: cfg.endpoint } }) + '\n');

let done = 0;
await pool(jobs, concurrency, async ({ it, source, strength, input }) => {
  product.__resetPolishCacheForTest();
  const t = Date.now();
  let r, err = null, candidate = null;
  // ML-0: one entry per model call. A refused smooth attempt is followed by a
  // strict fallback call (stt-polish.ts, QP-1), and `candidate` alone would
  // only keep the second one.
  const candidates = [];
  // Instrument only: the documented `streamerFor` seam wraps the product's own
  // streamer and passes every event through untouched, so we can see what the
  // model proposed when the guard throws it away (the result carries only the
  // input in that case).
  const streamerFor = (protocol) => {
    const inner = product.llmStreamerFor(protocol);
    return async function* tee(opts) {
      let full = '';
      const slot = candidates.push('') - 1;
      for await (const ev of inner(opts)) {
        if (ev.kind === 'delta') full += ev.text;
        if (ev.kind === 'done') full = ev.full;
        candidate = full;
        candidates[slot] = full;
        yield ev;
      }
    };
  };
  try { r = await product.polishFinalText(input, cfg, { strength, language: langOf(it), streamerFor }); } catch (e) { err = String(e?.message ?? e); }
  recordUsage({ kind: 'llm', llm_calls: 1 });
  const outcome = err ? 'error' : r.skipReason ? r.skipReason : (r.text === input ? 'applied_unchanged' : 'applied');
  const rec = {
    id: it.id, lang: it.lang, source, strength, input, output: r?.text ?? input, candidate, outcome,
    reason: r?.reason ?? err, wall_ms: Date.now() - t, elapsed_ms: r?.timing?.elapsedMs ?? null, ttfb_ms: r?.timing?.ttfbMs ?? null,
    budget_ms: r?.timing?.budgetMs ?? null, finish: r?.timing?.finishReason ?? null, usage: r?.usage ?? null,
    applied_strength: r?.appliedStrength ?? null, first_reject: r?.firstReject ?? null, candidates,
  };
  appendFileSync(out, JSON.stringify(rec) + '\n');
  done++;
  if (done % 20 === 0 || outcome !== 'applied') console.log(`[${done}/${jobs.length}] ${it.id} ${source}/${strength} ${outcome}${rec.reason ? ` (${rec.reason})` : ''} ${rec.elapsed_ms}ms`);
});
console.log(`[run-polish] wrote ${out}`);
