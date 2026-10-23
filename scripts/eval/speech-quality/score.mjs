#!/usr/bin/env node
// scripts/eval/speech-quality/score.mjs — score STT + polish runs, write a
// markdown report. Pure local computation: no network, no cost.
//
//   node scripts/eval/speech-quality/score.mjs --prefix base --out report.md
//     reads <results>/base-stt-hints.jsonl, base-stt-hints-variants.jsonl,
//     base-stt-ctx.jsonl, base-stt-ctx-struct.jsonl, base-polish.jsonl
//     (any that are missing are skipped; each can be overridden with
//     --stt / --variants / --ctx / --ctx-struct / --polish).
//
// Every metric's blind spots are listed in README.md. Read them before quoting
// a number from this report.

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESULTS_DIR, parseArgs, percentile, readJsonl, usageTotals } from './lib.mjs';
import { agg, byId, checks, corpus, expectChecks, fmtRate, ms, pct, rateName } from './scoring.mjs';

const args = parseArgs();
const R = RESULTS_DIR();
const prefix = args.prefix ?? 'base';
const pathOf = (flag, suffix) => resolve(args[flag] ?? join(R, `${prefix}-${suffix}.jsonl`));
const load = (flag, suffix) => { const p = pathOf(flag, suffix); return existsSync(p) ? readJsonl(p) : []; };
const sttAll = load('stt', 'stt-hints');
const variantsAll = load('variants', 'stt-hints-variants');
const ctxAll = load('ctx', 'stt-ctx');
const ctxsAll = load('ctx-struct', 'stt-ctx-struct');
const polishAll = load('polish', 'polish');
// Optional: a targeted re-run that captured the model's rejected candidates
// (run-polish records `candidate` since the tee was added; older files lack it).
const candRows = load('candidates', 'polish-rejects-rerun').filter((r) => !r.meta);
const metaOf = (rows) => rows.find((r) => r.meta)?.meta ?? null;
const rowsOf = (rows) => rows.filter((r) => !r.meta);
const stt = rowsOf(sttAll).filter((r) => r.variant === null);
const variants = rowsOf(variantsAll);
const ctx = rowsOf(ctxAll);
const ctxs = rowsOf(ctxsAll);
const polish = rowsOf(polishAll);



const md = [];
const line = (s = '') => md.push(s);
const table = (head, rows) => { line(`| ${head.join(' | ')} |`); line(`|${head.map(() => '---').join('|')}|`); for (const r of rows) line(`| ${r.join(' | ')} |`); line(); };
const LANGS = ['en', 'zh', 'mixed'];

// ── header ──────────────────────────────────────────────────────────────────
const m = metaOf(sttAll), pm = metaOf(polishAll), usage = usageTotals();
line(`# Speech-quality eval report (${prefix})`);
line();
line(`Generated ${new Date().toISOString()} by scripts/eval/speech-quality/score.mjs.`);
if (m) line(`STT: Soniox via @flowmic/stt-cloud SonioxEngine (stt-cloud ${m.stt_cloud_head}), endpoint \`${m.endpoint}\`, ${m.chunk_ms} ms chunks at real-time pace. Simulated dictionary = ${m.vocab_terms} terms.`);
if (pm) line(`Polish: \`polishFinalText\` from server-core ${pm.server_core_head}, model \`${pm.model}\` (${pm.endpoint}).`);
line(`Card usage ledger: Soniox ${(usage.soniox_audio_sec / 60).toFixed(1)} audio-min, LLM ${usage.llm_calls} calls.`);
line();
line('Error rates: WER for English (words), CER for Chinese (characters), MER for mixed (Han chars + Latin words as tokens). Fillers (um/uh/er/hmm, 嗯/呃) are removed from both sides before the edit distance. Lower is better. See README.md for every blind spot.');
line();

// ── 1. STT by language ──────────────────────────────────────────────────────
if (stt.length) {
  line('## 1. STT (config `hints`, production default) by language');
  line();
  const rows = [];
  for (const L of [...LANGS, 'all']) {
    const rs = stt.filter((r) => L === 'all' || r.lang === L);
    if (!rs.length) continue;
    const a = agg(rs);
    rows.push([L, a.n, `${L === 'all' ? 'err' : rateName(L)} ${fmtRate(a)}`, pct(a.termHit, a.termN), pct(a.termHitCi, a.termN), pct(a.numHit, a.numN), pct(a.conHit, a.conN), `${a.onsetLost}/${a.n}`,
      ms(percentile(rs.map((r) => r.ttft_ms), 50)), ms(percentile(rs.map((r) => r.ttft_ms), 90)),
      ms(percentile(rs.map((r) => r.release_to_final_ms), 50)), ms(percentile(rs.map((r) => r.release_to_final_ms), 90)), rs.filter((r) => r.error).length]);
  }
  table(['lang', 'n', 'error rate', 'terms exact', 'terms any-case', 'numbers', 'contractions', 'first word wrong', 'TTFT p50', 'TTFT p90', 'release→final p50', 'p90', 'errors'], rows);

  line('### STT by tag');
  line();
  const tags = [...new Set(corpus.items.flatMap((it) => it.tags))].sort();
  const trows = [];
  for (const tag of tags) for (const L of LANGS) {
    const rs = stt.filter((r) => r.lang === L && byId.get(r.id)?.tags.includes(tag));
    if (!rs.length) continue;
    const a = agg(rs);
    trows.push([tag, L, a.n, `${rateName(L)} ${fmtRate(a)}`, pct(a.termHit, a.termN), pct(a.numHit, a.numN), a.spN ? pct(a.spHit, a.spN) : '-', a.fillerItems ? `${a.fillerItems - a.fillerClean}/${a.fillerItems} kept` : '-']);
  }
  table(['tag', 'lang', 'n', 'error rate', 'terms exact', 'numbers', 'spoken punct converted', 'fillers in STT'], trows);

  const missed = agg(stt).missed;
  line(`Missed terms (exact case) in STT: ${missed.length ? missed.join(', ') : 'none'}`);
  line();
  const onsetLost = stt.filter((r) => checks(byId.get(r.id), r.pipeline_text ?? '').onsetLost);
  line(`First word wrong or missing (onset proxy; see README): ${onsetLost.length ? onsetLost.map((r) => `${r.id} "${(r.pipeline_text ?? '').slice(0, 24)}"`).join('; ') : 'none'}`);
  line();
  const worst = stt.map((r) => ({ r, c: checks(byId.get(r.id), r.pipeline_text ?? '') })).filter((x) => x.c.refLen > 0)
    .sort((a, b) => b.c.edits / b.c.refLen - a.c.edits / a.c.refLen).slice(0, 12);
  line('### Worst STT items');
  line();
  table(['id', 'rate', 'reference', 'STT (after pipeline)'], worst.map(({ r, c }) => [r.id, `${((100 * c.edits) / c.refLen).toFixed(0)}%`, byId.get(r.id).reference.replace(/\|/g, '/'), (r.pipeline_text ?? `ERROR ${r.error}`).replace(/\|/g, '/')]));
}

// ── 2. context configs ──────────────────────────────────────────────────────
if (ctx.length || ctxs.length) {
  line('## 2. Context configs on the same items (jargon + names, en + mixed, short)');
  line();
  const ids = new Set([...ctx, ...ctxs].map((r) => r.id));
  const rows = [];
  for (const L of ['en', 'mixed']) for (const [name, set] of [['hints', stt], ['ctx (product string)', ctx], ['ctx-struct ({terms})', ctxs]]) {
    const rs = set.filter((r) => r.lang === L && ids.has(r.id) && r.variant === null);
    if (!rs.length) continue;
    const a = agg(rs);
    rows.push([L, name, a.n, `${rateName(L)} ${fmtRate(a)}`, pct(a.termHit, a.termN), pct(a.termHitCi, a.termN), ms(percentile(rs.map((r) => r.ttft_ms), 50)), ms(percentile(rs.map((r) => r.release_to_final_ms), 50))]);
  }
  table(['lang', 'config', 'n', 'error rate', 'terms exact', 'terms any-case', 'TTFT p50', 'release→final p50'], rows);
  const diffs = [];
  for (const id of ids) {
    const h = stt.find((r) => r.id === id), c = ctx.find((r) => r.id === id), s = ctxs.find((r) => r.id === id);
    if (h && c && s && !(h.pipeline_text === c.pipeline_text && c.pipeline_text === s.pipeline_text)) diffs.push([id, h.pipeline_text, c.pipeline_text, s.pipeline_text].map((x) => String(x).replace(/\|/g, '/')));
  }
  line(`Items whose text differs between configs: ${diffs.length}/${ids.size}`);
  line();
  if (diffs.length) table(['id', 'hints', 'ctx', 'ctx-struct'], diffs);
}

// ── 3. onset / noise variants ───────────────────────────────────────────────
if (variants.length) {
  line('## 3. Quiet onset and mild noise (variant subset)');
  line();
  const ids = new Set(variants.map((r) => r.id));
  const groups = [['base (0 s)', stt.filter((r) => ids.has(r.id))]];
  for (const s of corpus.variants.onset_silence_sec.filter((x) => x > 0)) groups.push([`onset ${s} s`, variants.filter((r) => r.variant === 'onset' && r.onset_sec === s)]);
  groups.push([`noise ${corpus.variants.noise_snr_db} dB SNR`, variants.filter((r) => r.variant === 'noise')]);
  const rows = groups.map(([name, rs]) => {
    const a = agg(rs);
    const en = agg(rs.filter((r) => r.lang === 'en')), zh = agg(rs.filter((r) => r.lang !== 'en'));
    return [name, a.n, `WER ${fmtRate(en)} / CER+MER ${fmtRate(zh)}`, pct(a.termHit, a.termN), `${a.onsetLost}/${a.n}`, ms(percentile(rs.map((r) => r.ttft_ms), 50)), ms(percentile(rs.map((r) => r.ttft_from_speech_ms), 50)), ms(percentile(rs.map((r) => r.release_to_final_ms), 50))];
  });
  table(['variant', 'n', 'error rate', 'terms exact', 'first word wrong', 'TTFT p50 (from stream start)', 'TTFT p50 (from speech)', 'release→final p50'], rows);
  const lost = variants.filter((r) => checks(byId.get(r.id), r.pipeline_text ?? '').onsetLost);
  if (lost.length) table(['file', 'reference', 'STT'], lost.map((r) => [r.file, byId.get(r.id).reference, r.pipeline_text ?? `ERROR ${r.error}`]));
}

// ── 4. polish ───────────────────────────────────────────────────────────────
if (polish.length) {
  line('## 4. Realtime polish (Strict / Smooth)');
  line();
  line('Outcome: `applied` = guard accepted a changed text; `applied_unchanged` = model returned the input; anything else = the user receives the unpolished STT text.');
  line();
  const outcomes = ['applied', 'applied_unchanged', 'guard_reject', 'timeout', 'llm_error', 'empty_output', 'model_rejected', 'error'];
  const orows = [];
  for (const source of ['stt', 'ref']) for (const strength of ['strict', 'smooth']) for (const L of [...LANGS, 'all']) {
    const rs = polish.filter((r) => r.source === source && r.strength === strength && (L === 'all' || r.lang === L));
    if (!rs.length) continue;
    const cnt = (o) => rs.filter((r) => r.outcome === o).length;
    orows.push([source, strength, L, rs.length, ...outcomes.map((o) => (cnt(o) ? `${cnt(o)} (${pct(cnt(o), rs.length)})` : '0')),
      ms(percentile(rs.map((r) => r.elapsed_ms), 50)), ms(percentile(rs.map((r) => r.elapsed_ms), 90))]);
  }
  table(['input', 'strength', 'lang', 'n', ...outcomes, 'latency p50', 'p90'], orows);

  const reasons = {};
  for (const r of polish.filter((x) => x.outcome !== 'applied' && x.outcome !== 'applied_unchanged')) {
    const k = `${r.strength} ${r.outcome}: ${String(r.reason ?? '').replace(/:.*$/, '')}`;
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  line('### Reject / skip reasons (family, both inputs)');
  line();
  table(['strength / outcome / check', 'count'], Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]));

  line('### What the user ends up reading (STT input), by strength');
  line();
  line('`error vs reference` compares the delivered text with the verbatim reference (fillers removed both sides). For Smooth a non-zero value can be correct (self-corrections may be resolved).');
  line();
  const qrows = [];
  for (const strength of ['none (STT only)', 'strict', 'smooth']) for (const L of [...LANGS, 'all']) {
    const rs = strength.startsWith('none')
      ? stt.filter((r) => L === 'all' || r.lang === L).map((r) => ({ ...r, output: r.pipeline_text }))
      : polish.filter((r) => r.source === 'stt' && r.strength === strength && (L === 'all' || r.lang === L));
    if (!rs.length) continue;
    const a = agg(rs, 'output');
    let ef = 0, en = 0;
    if (!strength.startsWith('none')) for (const r of rs) { const f = expectChecks(byId.get(r.id), strength, r.output); if (f) { en++; if (f.length) ef++; } }
    qrows.push([strength, L, rs.length, `${L === 'all' ? 'err' : rateName(L)} ${fmtRate(a)}`, pct(a.termHit, a.termN), pct(a.numHit, a.numN), a.fillerItems ? `${a.fillerClean}/${a.fillerItems}` : '-', pct(a.conHit, a.conN), a.spN ? pct(a.spHit, a.spN) : '-', en ? `${en - ef}/${en}` : '-']);
  }
  table(['strength', 'lang', 'n', 'error vs reference', 'terms exact', 'numbers', 'filler-free items', 'contractions', 'spoken punct converted', 'expectations met'], qrows);

  const fails = [];
  for (const r of polish.filter((x) => x.source === 'stt')) {
    const f = expectChecks(byId.get(r.id), r.strength, r.output);
    if (f && f.length) fails.push([r.id, r.strength, r.outcome, f.join('; '), String(r.output).replace(/\|/g, '/')]);
  }
  if (fails.length) { line('### Expectation failures (STT input)'); line(); table(['id', 'strength', 'outcome', 'failed', 'output'], fails); }

  const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ⏎ ');
  const acc = polish.filter((r) => r.source === 'stt' && r.outcome === 'applied');
  if (acc.length) {
    line('### Accepted changes on STT input (the guard let these through: read them)');
    line();
    table(['id', 'strength', 'input', 'delivered'], acc.map((r) => [r.id, r.strength, cell(r.input), cell(r.output)]));
  }
  const rej = polish.filter((r) => r.source === 'stt' && r.outcome === 'guard_reject');
  const cand = (r) => r.candidate ?? candRows.find((c) => c.id === r.id && c.strength === r.strength && c.source === r.source)?.candidate ?? 'n/a';
  if (rej.length) {
    line('### Guard rejects on STT input');
    line();
    line('`model candidate` is what the model proposed and the guard discarded (from the same run, or from a targeted re-run when the run predates candidate capture: a re-run is a new sample, not the same answer).');
    line();
    table(['id', 'strength', 'check', 'input (delivered unchanged)', 'model candidate (discarded)'], rej.map((r) => [r.id, r.strength, r.reason, cell(r.input), cell(cand(r))]));
  }
}

const out = resolve(args.out ?? join(R, `${prefix}-report.md`));
writeFileSync(out, md.join('\n'));
console.log(`[score] wrote ${out}`);
