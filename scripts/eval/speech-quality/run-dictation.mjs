#!/usr/bin/env node
// scripts/eval/speech-quality/run-dictation.mjs — card ML-2: dictated
// punctuation through the PRODUCT's final-text pipeline and realtime polish.
//
//   node scripts/eval/speech-quality/run-dictation.mjs --stt <en stt.jsonl>,<ml stt.jsonl> --out <f.jsonl>
//   node scripts/eval/speech-quality/run-dictation.mjs ... --server-core ../flowmic-app/apps/server-core   # another build
//   node scripts/eval/speech-quality/run-dictation.mjs --score <f.jsonl>                                 # score only
//
// Inputs, each at Strict and Smooth:
//   · every corpus item with `spoken_punct` (corpus.json + corpus-ml.json):
//     source `stt` = that STT run's raw final `text`, source `ref` = the
//     reference; both through the bundle's own final-text pipeline, so the
//     English filler strip (EN-1) is part of what a build is measured on;
//   · dictation-controls.json: the command words used as part of the sentence.
// Same LLM path as run-polish.mjs (product managedLlmConfig -> DeepSeek, key
// from .local/deepseek.env, never printed). Calls go into the usage ledger;
// FLOWMIC_EVAL_LLM_CAP (default 600) refuses unless --allow-over.
//
// Scores (a measurement, not a gate — same rules as the README):
//   · converted: a listed command whose word count in the delivered text fell
//     below the input's, with its symbol present in the delivered text;
//   · lost: the word count fell and the symbol is absent;
//   · false conversion: a control whose `keep` word count fell.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HERE, langTag, loadProductBundle, parseArgs, pool, readEnvFile, readJsonl, recordUsage, usageTotals } from './lib.mjs';

const args = parseArgs();

const LATIN_OR_CYR = /^[\p{Script=Latin}\p{Script=Cyrillic}\s'’-]+$/u;
function countWord(text, word) {
  if (!LATIN_OR_CYR.test(word)) return text.split(word).length - 1;
  const re = new RegExp(`(?<![\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}])`, 'giu');
  return text.match(re)?.length ?? 0;
}
const SYMS = { ',': /[,，、]/u, '.': /[.。．]/u, '?': /[?？]/u, '！': /[!！]/u, '!': /[!！]/u, ':': /[:：]/u, '\n': /\n/u, '、': /[,，、]/u, '。': /[.。．]/u, '？': /[?？]/u };
const hasSym = (text, sym) => (SYMS[sym] ?? new RegExp(sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u')).test(text);

function scoreRow(r) {
  if (r.kind === 'control') {
    const lost = r.keep.filter((w) => countWord(r.output, w) < countWord(r.input, w));
    const candLost = r.candidate ? r.keep.filter((w) => countWord(r.candidate, w) < countWord(r.input, w)) : [];
    return { false_conv: lost.length > 0, cand_false_conv: candLost.length > 0 };
  }
  let applicable = 0, converted = 0, lost = 0;
  // Longest commands first, so "point d'interrogation" is not also counted as "point".
  const cmds = [...r.spoken_punct].sort((a, b) => b.cmd.length - a.cmd.length);
  let input = r.input, output = r.output;
  for (const { cmd, sym } of cmds) {
    // A PC-bound run keeps layout commands as words (MAIN 2026-10-14): they
    // are not counted as conversions there; added line breaks are reported.
    if (sym === '\n' && r.line_breaks === false) continue;
    const nIn = countWord(input, cmd);
    const nOut = countWord(output, cmd);
    input = input.split(cmd).join(' ');
    output = output.split(cmd).join(' ');
    if (nIn === 0) continue;
    applicable += nIn;
    const drop = Math.max(0, nIn - nOut);
    if (drop === 0) continue;
    if (hasSym(r.output, sym)) converted += drop; else lost += drop;
  }
  return { applicable, converted, lost, newline: r.line_breaks === false && (r.output.match(/\n/g)?.length ?? 0) > (r.input.match(/\n/g)?.length ?? 0) };
}

function report(rows) {
  const lines = [];
  const groups = new Map();
  for (const r of rows) {
    const s = scoreRow(r);
    const key = `${r.kind === 'control' ? 'control' : r.source}|${r.strength}`;
    const g = groups.get(key) ?? { n: 0, applicable: 0, converted: 0, lost: 0, false_conv: 0, cand_false_conv: 0, refused: 0, newline: 0, byLang: new Map() };
    g.n += 1;
    if (s.newline) g.newline += 1;
    if (String(r.outcome).startsWith('guard_reject')) g.refused += 1;
    for (const k of ['applicable', 'converted', 'lost']) g[k] += s[k] ?? 0;
    if (s.false_conv) g.false_conv += 1;
    if (s.cand_false_conv) g.cand_false_conv += 1;
    const l = g.byLang.get(r.lang) ?? { applicable: 0, converted: 0, lost: 0, false_conv: 0, n: 0 };
    l.n += 1;
    for (const k of ['applicable', 'converted', 'lost']) l[k] += s[k] ?? 0;
    if (s.false_conv) l.false_conv += 1;
    g.byLang.set(r.lang, l);
    groups.set(key, g);
  }
  for (const [key, g] of [...groups].sort()) {
    const [src, strength] = key.split('|');
    if (src === 'control') {
      lines.push(`control ${strength}: ${g.n} items, false conversion delivered ${g.false_conv}/${g.n}, in model candidate ${g.cand_false_conv}/${g.n}, guard refusals ${g.refused}`);
    } else {
      const per = [...g.byLang].sort().map(([lang, l]) => `${lang} ${l.converted}/${l.applicable}${l.lost ? ` lost ${l.lost}` : ''}`).join(', ');
      lines.push(`${src} ${strength}: converted ${g.converted}/${g.applicable} (${g.applicable ? Math.round(100 * g.converted / g.applicable) : 0}%), lost without symbol ${g.lost}, PC line break added ${g.newline}, guard refusals ${g.refused}/${g.n} — ${per}`);
    }
  }
  return lines.join('\n');
}

if (args.score) {
  const rows = readJsonl(resolve(args.score)).filter((r) => r.id);
  console.log(report(rows));
  process.exit(0);
}

if (!args.stt) throw new Error('--stt <stt results .jsonl>[,<more>] is required');
const strengths = String(args.strengths ?? 'strict,smooth').split(',');
const sources = String(args.sources ?? 'stt,ref').split(',');
const cap = Number(process.env.FLOWMIC_EVAL_LLM_CAP ?? 600);
const langSet = args.lang ? new Set(String(args.lang).split(',')) : null;
// MAIN 2026-10-14: default is a PC-bound utterance (line breaks off);
// --line-breaks measures a Notes utterance (delivery 'none').
const lineBreaks = args['line-breaks'] === true || args['line-breaks'] === 'true';

const corpusItems = ['corpus.json', 'corpus-ml.json']
  .flatMap((f) => JSON.parse(readFileSync(join(HERE, f), 'utf8')).items)
  .filter((it) => it.spoken_punct && (!langSet || langSet.has(it.lang)));
const controls = JSON.parse(readFileSync(join(HERE, 'dictation-controls.json'), 'utf8')).items
  .filter((it) => !langSet || langSet.has(it.lang));
const sttById = new Map();
for (const f of String(args.stt).split(',')) {
  for (const r of readJsonl(resolve(f))) if (r.id && !r.variant && typeof r.text === 'string') sttById.set(r.id, r);
}

const { mod: product, head } = await loadProductBundle(args['server-core']);
const pipeline = product.makeFinalTextPipeline(product.buildDictionaryReplacer([]));
const run = (text, lang) => pipeline(text, { isSegment: false, language: langTag(lang) });

const jobs = [];
for (const it of corpusItems) {
  for (const source of sources) {
    const rawText = source === 'stt' ? sttById.get(it.id)?.text : source === 'ref' ? it.reference : undefined;
    if (typeof rawText !== 'string' || rawText.trim() === '') continue;
    for (const strength of strengths) jobs.push({ id: it.id, lang: it.lang, kind: 'command', source, strength, input: run(rawText, it.lang), spoken_punct: it.spoken_punct });
  }
}
for (const it of args['no-controls'] ? [] : controls) {
  for (const strength of strengths) jobs.push({ id: it.id, lang: it.lang, kind: 'control', source: 'control', strength, input: run(it.text, it.lang), keep: it.keep });
}

const ds = readEnvFile('deepseek.env');
if (!ds.FLOWMIC_DEEPSEEK_API_KEY) throw new Error('.local/deepseek.env has no FLOWMIC_DEEPSEEK_API_KEY');
Object.assign(process.env, {
  FLOWMIC_MANAGED_LLM_ENABLED: '1',
  FLOWMIC_MANAGED_LLM_PROTOCOL: 'openai-compatible',
  FLOWMIC_MANAGED_LLM_ENDPOINT: args.endpoint ?? 'https://api.deepseek.com/v1',
  FLOWMIC_MANAGED_LLM_MODEL: args.model ?? ds.FLOWMIC_DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
  FLOWMIC_MANAGED_LLM_API_KEY: ds.FLOWMIC_DEEPSEEK_API_KEY,
  FLOWMIC_LLM_VENDOR_BODY: process.env.FLOWMIC_LLM_VENDOR_BODY ?? '{"thinking":{"type":"disabled"}}',
});
const cfg = product.managedLlmConfig(process.env);

const used = usageTotals();
console.log(`[run-dictation] server-core=${head} model=${cfg.model} calls=${jobs.length}; ledger so far ${used.llm_calls} of cap ${cap}`);
if (args['dry-run']) process.exit(0);
if (used.llm_calls + jobs.length > cap && !args['allow-over']) {
  console.error(`[run-dictation] REFUSED: would exceed the LLM-call cap (${cap}).`);
  process.exit(2);
}
if (!args.out) throw new Error('--out <file.jsonl> is required');
const out = resolve(args.out);
writeFileSync(out, JSON.stringify({ meta: { at: new Date().toISOString(), server_core_head: head, model: cfg.model } }) + '\n');

await pool(jobs, Number(args.concurrency ?? 4), async (job) => {
  product.__resetPolishCacheForTest();
  let candidate = null;
  const streamerFor = (protocol) => {
    const inner = product.llmStreamerFor(protocol);
    return async function* tee(opts) {
      for await (const ev of inner(opts)) {
        if (ev.kind === 'done') candidate = ev.full;
        yield ev;
      }
    };
  };
  let r, err = null;
  try { r = await product.polishFinalText(job.input, cfg, { strength: job.strength, language: langTag(job.lang), lineBreaks, streamerFor }); } catch (e) { err = String(e?.message ?? e); }
  recordUsage({ kind: 'llm', llm_calls: 1 });
  const outcome = err ? 'error' : r.skipReason ? `${r.skipReason}${r.reason ? `:${r.reason}` : ''}` : (r.text === job.input ? 'applied_unchanged' : 'applied');
  appendFileSync(out, JSON.stringify({ ...job, line_breaks: lineBreaks, output: r?.text ?? job.input, candidate, outcome, applied_strength: r?.appliedStrength ?? null }) + '\n');
});
console.log(`[run-dictation] wrote ${out}`);
console.log(report(readJsonl(out).filter((r) => r.id)));
