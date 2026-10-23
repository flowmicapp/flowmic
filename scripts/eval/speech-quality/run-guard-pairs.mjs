#!/usr/bin/env node
// scripts/eval/speech-quality/run-guard-pairs.mjs — card ML-0 adversarial pairs
// through the PRODUCT's guards. Pure local, no network, no cost.
//
//   node scripts/eval/speech-quality/run-guard-pairs.mjs                       # this checkout
//   node scripts/eval/speech-quality/run-guard-pairs.mjs --server-core ../lane-b/apps/server-core
//   node scripts/eval/speech-quality/run-guard-pairs.mjs --pairs other.jsonl --out x.jsonl
//
// Each line of guard-pairs-ml.jsonl is {id, lang, kind, harmful, expect:{strict,
// smooth}, raw, polished}. `expect` is accept | reject | any. Every pair is
// judged by:
//   · the realtime polish guard `checkMeaningPreserved` at strict and smooth
//     (what decides whether a polish replaces the STT final), and
//   · the compose output guard `guardComposeOutput` as task `draft_polish` and
//     `organize` with source_lang = the pair's language (the closest compose
//     analogue of a same-language rewrite). That guard is built to catch
//     assistant frames, wrong script and runaway volume, not meaning edits, so
//     its "accept" on a negation flip is reported, not scored as its failure.
// The language-drift detector from ml-scoring.mjs is run on every polished side
// too, so the report can say what a drift check would have caught.

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HERE, RESULTS_DIR, langTag, loadProductBundle, parseArgs, readJsonl } from './lib.mjs';
import { detectDrift } from './ml-scoring.mjs';

const args = parseArgs();
const pairs = readJsonl(resolve(args.pairs ?? join(HERE, 'guard-pairs-ml.jsonl')));
const { mod, head } = await loadProductBundle(args['server-core']);
const out = [];
for (const p of pairs) {
  const strict = mod.checkMeaningPreserved(p.raw, p.polished, { strength: 'strict', language: p.lang });
  const smooth = mod.checkMeaningPreserved(p.raw, p.polished, { strength: 'smooth', language: p.lang });
  const compose = {};
  for (const task of ['draft_polish', 'organize']) {
    const v = mod.guardComposeOutput({ task, source: p.raw, output: p.polished, source_lang: langTag(p.lang) });
    compose[task] = v.ok ? 'accept' : `reject:${v.rule}`;
  }
  const verdict = (g) => (g.ok ? 'accept' : 'reject');
  const wrong = (exp, got) => exp !== 'any' && exp !== got;
  const drift = detectDrift(p.lang, p.polished);
  out.push({
    ...p,
    strict: verdict(strict), strict_reason: strict.reason ?? null, strict_metrics: strict.metrics ?? null,
    smooth: verdict(smooth), smooth_reason: smooth.reason ?? null, smooth_metrics: smooth.metrics ?? null,
    compose,
    drift_detected: drift.drifted ? drift.detected : null,
    wrong_strict: wrong(p.expect.strict, verdict(strict)),
    wrong_smooth: wrong(p.expect.smooth, verdict(smooth)),
  });
}
const dest = resolve(args.out ?? join(RESULTS_DIR(), 'ml0-guard-pairs.jsonl'));
writeFileSync(dest, JSON.stringify({ meta: { at: new Date().toISOString(), server_core_head: head, pairs: pairs.length } }) + '\n' + out.map((r) => JSON.stringify(r)).join('\n') + '\n');
const by = {};
for (const r of out) {
  const b = (by[r.lang] ??= { n: 0, harm: 0, accStrict: 0, accSmooth: 0, benign: 0, refStrict: 0, refSmooth: 0 });
  b.n++;
  if (r.harmful) { b.harm++; if (r.strict === 'accept') b.accStrict++; if (r.smooth === 'accept') b.accSmooth++; }
  else { b.benign++; if (r.wrong_strict) b.refStrict++; if (r.wrong_smooth) b.refSmooth++; }
}
console.log(`[guard-pairs] server-core ${head}: ${out.length} pairs -> ${dest}`);
for (const [l, b] of Object.entries(by)) console.log(`  ${l}: harmful ${b.harm} — wrongly accepted strict ${b.accStrict}, smooth ${b.accSmooth}; benign ${b.benign} — wrongly refused strict ${b.refStrict}, smooth ${b.refSmooth}`);
