#!/usr/bin/env node
// scripts/eval/speech-quality/compare-ctx.mjs — card CTX-1: compare STT runs
// that differ only in the Soniox `context` they sent. Pure local scoring.
//
//   node scripts/eval/speech-quality/compare-ctx.mjs \
//     --base base-stt-hints.jsonl  default50=ctx1-stt-default50.jsonl  default150=...
//
// Files are resolved against the results dir unless absolute. Every config is
// scored on the ids it shares with --base, split into subsets:
//   jargon   = items tagged jargon or names (what context is supposed to help)
//   control  = everything else (what context must not hurt)
// and per language. Also lists, per config, the items whose edit count got
// WORSE than in --base, so a regression is a sentence you can read, not just a
// rate that moved. Run-to-run noise exists (the same audio does not always
// decode the same way); read single-item flips with that in mind.

import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { RESULTS_DIR, parseArgs, readJsonl } from './lib.mjs';
import { agg, byId, checks, fmtRate, pct, rateName } from './scoring.mjs';

const args = parseArgs();
const R = RESULTS_DIR();
const at = (p) => (isAbsolute(p) ? p : join(R, p));
const rowsOf = (p) => readJsonl(at(p)).filter((r) => !r.meta && r.variant === null);
const base = rowsOf(args.base ?? 'base-stt-hints.jsonl');
const configs = args._.map((spec) => { const [label, file] = spec.split('='); return { label, rows: rowsOf(file) }; });

const subsetOf = (it) => (it.tags.includes('jargon') || it.tags.includes('names') ? 'jargon' : 'control');
const md = [];
const line = (s = '') => md.push(s);
const table = (head, rows) => { line(`| ${head.join(' | ')} |`); line(`|${head.map(() => '---').join('|')}|`); for (const r of rows) line(`| ${r.join(' | ')} |`); line(); };

const rows = [];
for (const sub of ['jargon', 'control']) for (const L of ['en', 'zh', 'mixed']) {
  const ids = new Set(configs.flatMap((c) => c.rows.map((r) => r.id)));
  for (const { label, rows: cr } of [{ label: 'hints (none)', rows: base }, ...configs]) {
    const rs = cr.filter((r) => r.lang === L && ids.has(r.id) && subsetOf(byId.get(r.id)) === sub);
    if (!rs.length) continue;
    const a = agg(rs);
    rows.push([sub, L, label, a.n, `${rateName(L)} ${fmtRate(a)}`, a.termN ? pct(a.termHit, a.termN) : 'n/a', a.termN ? pct(a.termHitCi, a.termN) : 'n/a', a.edits]);
  }
}
line('## CTX-1 context comparison');
line();
line('`hints (none)` is restricted to the ids at least one config ran; each config row covers only the ids that config ran.');
line();
table(['subset', 'lang', 'config', 'n', 'error rate', 'terms exact', 'terms any-case', 'edits'], rows);

for (const { label, rows: cr } of configs) {
  const worse = [], better = [];
  for (const r of cr) {
    const b = base.find((x) => x.id === r.id);
    const it = byId.get(r.id);
    if (!b || !it) continue;
    const cb = checks(it, b.pipeline_text ?? ''), cc = checks(it, r.pipeline_text ?? '');
    const d = cc.edits - cb.edits;
    const rec = [r.id, subsetOf(it), d > 0 ? `+${d}` : `${d}`, String(b.pipeline_text).replace(/\|/g, '/'), String(r.pipeline_text).replace(/\|/g, '/')];
    if (d > 0) worse.push(rec); else if (d < 0) better.push(rec);
  }
  line(`### ${label}: ${better.length} better, ${worse.length} worse than hints`);
  line();
  if (worse.length) table(['id', 'subset', 'Δedits', 'hints', label], worse);
}
const out = args.out ? at(args.out) : null;
if (out) writeFileSync(out, md.join('\n'));
console.log(md.join('\n'));
