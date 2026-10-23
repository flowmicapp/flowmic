#!/usr/bin/env node
// scripts/eval/speech-quality/compare-builds.mjs — card PRE-0.3.111: compare two
// server-core builds on the SAME jobs (run-relay.mjs --jobs ... --llm-tap) and,
// optionally, on offline run-polish output, item by item.
//
//   FLOWMIC_EVAL_CORPUS=corpus.json node compare-builds.mjs \
//     --base a.jsonl,b.jsonl --cand c.jsonl,d.jsonl \
//     --base-core <lane-b/apps/server-core> --cand-core <lane-a/apps/server-core> \
//     [--offline cand-polish.jsonl] --out report.json
//
// What it separates (the card asks for it):
//   · raw STT per utterance = the text the relay asked the model to polish (the
//     LLM tap's user message) plus any final that reached the phone unpolished;
//     a pair whose raw STT differs is recognition noise until a rerun says not.
//   · guard: every tapped (input, model output) pair of EITHER build is judged
//     by BOTH builds' checkMeaningPreserved, so a guard change is visible on
//     identical model output, independent of model nondeterminism.
// Pure local computation (it bundles both server-core sources with esbuild).

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { langTag, loadProductBundle, parseArgs, percentile, readJsonl } from './lib.mjs';

const args = parseArgs();
const ML = (process.env.FLOWMIC_EVAL_CORPUS ?? 'corpus.json') !== 'corpus.json';
const S = ML ? await import('./ml-scoring.mjs') : await import('./scoring.mjs');
const byId = S.byId;

const toks = (it, text) => {
  const t = text.replace(/([.!?。—–])(?=\p{L})/gu, '$1 ');
  return ML ? S.tokens(it.lang, S.stripCommands(it, S.canonNumbers(it, t))) : S.tokensFor(it.lang, S.stripCommands(it, S.canonNumbers(it, t)));
};
const refToks = (it) => (ML ? S.tokens(it.lang, S.stripCommands(it, it.reference)) : S.tokensFor(it.lang, S.stripCommands(it, it.reference)));
const errs = (it, text) => S.editDistance(refToks(it), toks(it, text ?? ''));

const files = (v) => (typeof v === 'string' ? v.split(',').map((f) => resolve(f)) : []);
const load = (v) => files(v).flatMap((f) => readJsonl(f)).filter((r) => !r.meta && !r.harness_error);
const key = (r) => `${r.id}|${r.scenario}|${r.strength}${r.path ? '|' + r.path : ''}${r.kind && r.kind !== 'live' ? '|' + r.kind : ''}`;

function rawOf(r) {
  const parts = [];
  for (const t of r.llm_tap ?? []) if (t.user && !/Connectivity probe/.test(t.system_head ?? '')) parts.push({ t: t.t0, text: t.user, src: 'tap' });
  for (const f of r.finals ?? []) if (f.text && f.polish === undefined) parts.push({ t: (r.audio_ms ?? 0) + 50 + (f.dt_release ?? 0), text: f.text, src: 'unpolished' });
  parts.sort((a, b) => a.t - b.t);
  // QP-1: a refused smooth attempt is retried strict on the SAME input; count that input once.
  return parts.filter((p, i) => i === 0 || p.text !== parts[i - 1].text).map((p) => p.text).join(' ');
}
// A seam glue: a sentence end or dash with the next word stuck to it ("Kubernetes.And", "should—uh").
// Not "llama.cpp" / "Node.js" (lower case after the dot).
const glued = (s) => (s ?? '').match(/\p{Ll}[.!?](?=\p{Lu})|[—–](?=\p{L})/gu)?.length ?? 0;
const llmMs = (r) => (r.llm_tap ?? []).filter((t) => t.user && !/Connectivity probe/.test(t.system_head ?? '')).reduce((a, t) => a + (t.t1 - t.t0), 0);
const unmarked = (r) => (r.finals ?? []).filter((f) => (f.text ?? '').trim() && f.polish === undefined).length;
const segPolish = (r) => (r.finals ?? []).filter((f) => f.is_segment).map((f) => f.polish ?? 'none').join(',');
const cutKinds = (r) => [...new Set((r.cuts ?? []).map((c) => c.kind))].join(',');

const baseRows = new Map(load(args.base).map((r) => [key(r), r]));
const candRows = new Map(load(args.cand).map((r) => [key(r), r]));

const [B, C] = await Promise.all([loadProductBundle(args['base-core']), loadProductBundle(args['cand-core'])]);
const judge = (mod, it, strength, input, output) => {
  if (!input || output === null || output === undefined) return null;
  const g = mod.checkMeaningPreserved(input.trim(), String(output).trim(), { strength, language: langTag(it.lang) });
  return g.ok ? 'ok' : `reject:${g.reason}`;
};

const pairs = [];
for (const [k, b] of baseRows) {
  const c = candRows.get(k);
  if (!c) continue;
  const it = byId.get(b.id);
  const bt = b.inject_at_pc_text ?? (b.delivery === 'none' ? b.text : '') ?? '', ct = c.inject_at_pc_text ?? (c.delivery === 'none' ? c.text : '') ?? '';
  const bRaw = rawOf(b), cRaw = rawOf(c);
  const guardX = [];
  for (const [who, r] of [['base', b], ['cand', c]]) for (const t of r.llm_tap ?? []) {
    if (!t.user || /Connectivity probe/.test(t.system_head ?? '')) continue;
    const vb = judge(B.mod, it, b.strength, t.user, t.output), vc = judge(C.mod, it, b.strength, t.user, t.output);
    if (vb !== vc) guardX.push({ from: who, input: t.user, output: t.output, base_guard: vb, cand_guard: vc });
  }
  pairs.push({
    key: k, id: b.id, lang: b.lang, scenario: b.scenario, strength: b.strength, path: b.path, kind: b.kind, ref_n: refToks(it).length,
    base: { text: bt, err: errs(it, bt), raw: bRaw, raw_err: errs(it, bRaw), polish: b.polish, reason: b.polish_reason, guard: b.polish_guard?.family ?? null, seg_polish: segPolish(b), cuts: cutKinds(b), unmarked: unmarked(b), glued: glued(bt), rf: b.release_to_final_ms, rpc: b.release_to_inject_at_pc_ms, llm_ms: llmMs(b), attempts: b.polish_timing?.attempts ?? null, drift: ML ? S.detectDrift(b.lang, bt, it.terms ?? []) : null, model_out: (b.llm_tap ?? []).filter((t) => t.user && !/Connectivity/.test(t.system_head ?? '')).map((t) => t.output), sys: (b.llm_tap ?? []).map((t) => t.system_sha) },
    cand: { text: ct, err: errs(it, ct), raw: cRaw, raw_err: errs(it, cRaw), polish: c.polish, reason: c.polish_reason, guard: c.polish_guard?.family ?? null, seg_polish: segPolish(c), cuts: cutKinds(c), unmarked: unmarked(c), glued: glued(ct), rf: c.release_to_final_ms, rpc: c.release_to_inject_at_pc_ms, llm_ms: llmMs(c), attempts: c.polish_timing?.attempts ?? null, drift: ML ? S.detectDrift(c.lang, ct, it.terms ?? []) : null, model_out: (c.llm_tap ?? []).filter((t) => t.user && !/Connectivity/.test(t.system_head ?? '')).map((t) => t.output), sys: (c.llm_tap ?? []).map((t) => t.system_sha) },
    raw_same: toks(it, bRaw).join(' ') === toks(it, cRaw).join(' '),
    guard_disagree: guardX,
  });
}

// Offline polish (run-polish.mjs output of one build): re-judge every model
// candidate with the OTHER build's guard on identical model output.
const offline = [];
for (const r of files(args.offline).flatMap((f) => readJsonl(f)).filter((x) => !x.meta && x.source === 'stt')) {
  const it = byId.get(r.id);
  if (!it || r.candidate === null || r.candidate === undefined) { offline.push({ id: r.id, strength: r.strength, outcome: r.outcome, no_candidate: true }); continue; }
  const vb = judge(B.mod, it, r.strength, r.input, r.candidate), vc = judge(C.mod, it, r.strength, r.input, r.candidate);
  const dB = vb === 'ok' ? String(r.candidate).trim() : r.input, dC = vc === 'ok' ? String(r.candidate).trim() : r.input;
  offline.push({ id: r.id, lang: r.lang, strength: r.strength, outcome: r.outcome, input: r.input, candidate: r.candidate, base_guard: vb, cand_guard: vc, base_err: errs(it, dB), cand_err: errs(it, dC), input_err: errs(it, r.input), ref_n: refToks(it).length, drift_cand: ML ? S.detectDrift(r.lang, dC, it.terms ?? []) : null, drift_base: ML ? S.detectDrift(r.lang, dB, it.terms ?? []) : null });
}

// ── summaries ──────────────────────────────────────────────────────────────
const groups = {};
for (const p of pairs) {
  const g = (groups[`${p.scenario}|${p.lang}${p.path ? '|' + p.path : ''}${p.kind && p.kind !== 'live' ? '|' + p.kind : ''}`] ??= { n: 0, ref: 0, be: 0, ce: 0, bre: 0, cre: 0, pol: { base: {}, cand: {} }, unm: { base: 0, cand: 0 }, glu: { base: 0, cand: 0 }, drift: { base: 0, cand: 0 }, rf: { base: [], cand: [] }, rpc: { base: [], cand: [] }, nonllm: { base: [], cand: [] }, att2: { base: 0, cand: 0 }, worse: 0, better: 0 });
  g.n++; g.ref += p.ref_n; g.be += p.base.err; g.ce += p.cand.err; g.bre += p.base.raw_err; g.cre += p.cand.raw_err;
  for (const w of ['base', 'cand']) {
    const o = p[w].polish ? `${p[w].polish}${p[w].reason ? ':' + p[w].reason : ''}` : 'none';
    g.pol[w][o] = (g.pol[w][o] ?? 0) + 1;
    g.unm[w] += p[w].unmarked; g.glu[w] += p[w].glued; if (p[w].drift?.drifted) g.drift[w]++;
    if (p[w].rf !== null && p[w].rf !== undefined) g.rf[w].push(p[w].rf);
    if (p[w].rpc !== null && p[w].rpc !== undefined) g.rpc[w].push(p[w].rpc);
    if (p[w].rf !== null && p[w].rf !== undefined && p.scenario !== 'tail2') g.nonllm[w].push(p[w].rf - p[w].llm_ms);
    if ((p[w].attempts ?? 1) > 1) g.att2[w]++;
  }
  if (p.cand.err > p.base.err) g.worse++; else if (p.cand.err < p.base.err) g.better++;
}
const summary = Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, {
  n: g.n, err_base: +(100 * g.be / g.ref).toFixed(1), err_cand: +(100 * g.ce / g.ref).toFixed(1), raw_err_base: +(100 * g.bre / g.ref).toFixed(1), raw_err_cand: +(100 * g.cre / g.ref).toFixed(1),
  worse: g.worse, better: g.better, polish: g.pol, unmarked: g.unm, glued: g.glu, drift: g.drift,
  rf: { base: [percentile(g.rf.base, 50), percentile(g.rf.base, 90)], cand: [percentile(g.rf.cand, 50), percentile(g.rf.cand, 90)] },
  rpc: { base: [percentile(g.rpc.base, 50), percentile(g.rpc.base, 90)], cand: [percentile(g.rpc.cand, 50), percentile(g.rpc.cand, 90)] },
  nonllm: { base: [percentile(g.nonllm.base, 50), percentile(g.nonllm.base, 90)], cand: [percentile(g.nonllm.cand, 50), percentile(g.nonllm.cand, 90)] }, two_attempts: g.att2,
}]));
const worse = pairs.filter((p) => p.cand.err > p.base.err).map((p) => ({ key: p.key, d: p.cand.err - p.base.err, raw_same: p.raw_same, raw_d: p.cand.raw_err - p.base.raw_err, base: p.base, cand: p.cand, guard_disagree: p.guard_disagree }));
const offSum = {};
for (const o of offline.filter((x) => !x.no_candidate)) {
  const g = (offSum[`${o.lang}|${o.strength}`] ??= { n: 0, ref: 0, be: 0, ce: 0, flips_to_reject: 0, flips_to_ok: 0, cand_worse: 0, cand_better: 0, drift_base: 0, drift_cand: 0, cand_reject: 0, base_reject: 0 });
  g.n++; g.ref += o.ref_n; g.be += o.base_err; g.ce += o.cand_err;
  if (o.base_guard === 'ok' && o.cand_guard !== 'ok') g.flips_to_reject++;
  if (o.base_guard !== 'ok' && o.cand_guard === 'ok') g.flips_to_ok++;
  if (o.cand_guard !== 'ok') g.cand_reject++; if (o.base_guard !== 'ok') g.base_reject++;
  if (o.cand_err > o.base_err) g.cand_worse++; else if (o.cand_err < o.base_err) g.cand_better++;
  if (o.drift_base?.drifted) g.drift_base++; if (o.drift_cand?.drifted) g.drift_cand++;
}
for (const g of Object.values(offSum)) { g.err_base = +(100 * g.be / g.ref).toFixed(1); g.err_cand = +(100 * g.ce / g.ref).toFixed(1); }
const offWorse = offline.filter((o) => !o.no_candidate && o.cand_err > o.base_err);
const offFlips = offline.filter((o) => !o.no_candidate && o.base_guard !== o.cand_guard);

const out = { heads: { base: B.head, cand: C.head }, n_pairs: pairs.length, summary, worse, guard_disagree_relay: pairs.filter((p) => p.guard_disagree.length).map((p) => ({ key: p.key, g: p.guard_disagree })), offline: { n: offline.length, no_candidate: offline.filter((o) => o.no_candidate).length, summary: offSum, worse: offWorse, flips: offFlips }, pairs };
writeFileSync(resolve(args.out ?? 'compare.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ heads: out.heads, n_pairs: pairs.length, summary, worse: worse.length, offline: { n: offline.length, summary: offSum, worse: offWorse.length, flips: offFlips.length } }, null, 1));
