#!/usr/bin/env node
// scripts/eval/speech-quality/run-compose.mjs — card ML-0: the organize and
// translate modes on STT output, through the PRODUCT's prompt and output guard.
//
//   node scripts/eval/speech-quality/run-compose.mjs --stt <stt.jsonl> --ids fr-ram-01,de-fil-01
//   node scripts/eval/speech-quality/run-compose.mjs --stt <f> --tasks organize,translate:en,translate:zh-CN --dry-run
//
// What runs: the system prompt from `renderSystemPrompt({task, source_lang,
// target_lang}, '')` (no scenario block: a user with nothing configured), the
// STT final as the user message (compose/orchestrator.ts sends
// `input.source_text` after dictionary replace; the dictionary is empty here),
// the product's streamer with `maxTokens` 8192 for organize/translate
// (COMPOSE_MAX_OUTPUT_TOKENS, compose/orchestrator.ts:34), and then
// `guardComposeOutput` on the complete text — the same three calls the
// orchestrator makes, without its session, billing and wire plumbing. Model and
// vendor body as run-polish.mjs (DeepSeek, `managedLlmConfig`).
//
// LLM calls count against the usage ledger (FLOWMIC_EVAL_LLM_CAP).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESULTS_DIR, langTag, loadCorpus, loadProductBundle, parseArgs, pool, readEnvFile, readJsonl, recordUsage, usageTotals } from './lib.mjs';

const COMPOSE_MAX_OUTPUT_TOKENS = 8192; // compose/orchestrator.ts:34 — restated because importing the orchestrator drags in the session stack
const args = parseArgs();
if (!args.stt) throw new Error('--stt <stt results .jsonl> is required');
const tasks = String(args.tasks ?? 'organize,translate:en,translate:zh-CN').split(',').map((t) => { const [task, target] = t.split(':'); return { task, target: target ?? null }; });
const cap = Number(process.env.FLOWMIC_EVAL_LLM_CAP ?? 600);
const corpus = loadCorpus();
const byId = new Map(corpus.items.map((it) => [it.id, it]));
const idSet = args.ids ? new Set(String(args.ids).split(',')) : null;
const rows = readJsonl(resolve(args.stt)).filter((r) => r.id && r.variant === null && (!idSet || idSet.has(r.id)) && typeof r.pipeline_text === 'string' && r.pipeline_text.trim());

const { mod: product, head } = await loadProductBundle(args['server-core']);
const ds = readEnvFile('deepseek.env');
Object.assign(process.env, {
  FLOWMIC_MANAGED_LLM_ENABLED: '1', FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
  FLOWMIC_MANAGED_LLM_ENDPOINT: args.endpoint ?? 'https://api.deepseek.com/v1',
  FLOWMIC_MANAGED_LLM_MODEL: args.model ?? ds.FLOWMIC_DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
  FLOWMIC_MANAGED_LLM_API_KEY: ds.FLOWMIC_DEEPSEEK_API_KEY,
  FLOWMIC_LLM_VENDOR_BODY: process.env.FLOWMIC_LLM_VENDOR_BODY ?? '{"thinking":{"type":"disabled"}}',
});
const cfg = product.managedLlmConfig(process.env);

const jobs = rows.flatMap((row) => tasks.map((t) => ({ row, it: byId.get(row.id), ...t }))).filter((j) => j.it);
const used = usageTotals();
console.log(`[run-compose] server-core=${head} model=${cfg.model} calls=${jobs.length}; ledger so far ${used.llm_calls} of cap ${cap}`);
if (args['dry-run']) process.exit(0);
if (used.llm_calls + jobs.length > cap && !args['allow-over']) { console.error('[run-compose] REFUSED: over the LLM-call cap'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
mkdirSync(RESULTS_DIR(), { recursive: true });
const out = resolve(args.out ?? join(RESULTS_DIR(), `compose-${stamp}.jsonl`));
writeFileSync(out, JSON.stringify({ meta: { at: new Date().toISOString(), stt: resolve(args.stt), server_core_head: head, model: cfg.model } }) + '\n');
let done = 0;
await pool(jobs, Number(args.concurrency ?? 4), async ({ row, it, task, target }) => {
  const source_lang = langTag(it.lang);
  const ctx = { task, source_lang, ...(target ? { target_lang: target } : {}) };
  const system = product.renderSystemPrompt(ctx, '');
  const user = row.pipeline_text;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  const t0 = Date.now();
  let full = '', err = null;
  try {
    for await (const ev of product.llmStreamerFor(cfg.protocol)({ cfg, system, user, signal: ctrl.signal, maxTokens: COMPOSE_MAX_OUTPUT_TOKENS })) {
      if (ev.kind === 'delta') full += ev.text;
    }
  } catch (e) { err = String(e?.message ?? e); } finally { clearTimeout(timer); }
  recordUsage({ kind: 'llm', llm_calls: 1 });
  const verdict = err ? null : product.guardComposeOutput({ task, source: user, output: full, source_lang, ...(target ? { target_lang: target } : {}) });
  const rec = { id: it.id, lang: it.lang, task, target, input: user, output: full, error: err, guard: verdict ? (verdict.ok ? 'ok' : `reject:${verdict.rule}`) : null, guard_detail: verdict && !verdict.ok ? verdict.detail : null, wall_ms: Date.now() - t0 };
  appendFileSync(out, JSON.stringify(rec) + '\n');
  done++;
  console.log(`[${done}/${jobs.length}] ${it.id} ${task}${target ? `->${target}` : ''} ${rec.guard ?? `ERROR ${err}`} ${rec.wall_ms}ms`);
});
console.log(`[run-compose] wrote ${out}`);
