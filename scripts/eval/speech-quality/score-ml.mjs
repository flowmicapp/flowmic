#!/usr/bin/env node
// scripts/eval/speech-quality/score-ml.mjs — card ML-0 report: fr / es / de /
// ja / ko / ru. Pure local computation, no network, no cost.
//
//   FLOWMIC_EVAL_CORPUS=corpus-ml.json node scripts/eval/speech-quality/score-ml.mjs --prefix ml0
//     reads <results>/ml0-stt-hints.jsonl, ml0-stt-default150.jsonl,
//     ml0-polish.jsonl (+ ml0-polish-rerun.jsonl for keys the first file lacks),
//     ml0-compose.jsonl, ml0-guard-pairs.jsonl; writes ml0-report.md.
//
// Units and blind spots: ml-scoring.mjs header and README.md "ML-0".

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RESULTS_DIR, parseArgs, percentile, readJsonl, usageTotals } from './lib.mjs';
import { ML_LANGS, agg, byId, checks, detectDrift, expectChecks, rateName } from './ml-scoring.mjs';

if (!process.env.FLOWMIC_EVAL_CORPUS) throw new Error('set FLOWMIC_EVAL_CORPUS=corpus-ml.json');
const args = parseArgs();
const R = RESULTS_DIR();
const prefix = args.prefix ?? 'ml0';
const load = (suffix) => { const p = resolve(join(R, `${prefix}-${suffix}.jsonl`)); return existsSync(p) ? readJsonl(p).filter((r) => !r.meta) : []; };
const stt = load('stt-hints').filter((r) => r.variant === null);
const sttDef = load('stt-default150');
const polishKey = (r) => `${r.id}/${r.source}/${r.strength}`;
const polish = load('polish');
const have = new Set(polish.map(polishKey));
for (const r of load('polish-rerun')) if (!have.has(polishKey(r))) { polish.push({ ...r, rerun: true }); have.add(polishKey(r)); }
const compose = load('compose');
const smooth2 = load('polish-smooth2');
const pairs = load('guard-pairs');

const md = [];
const line = (s = '') => md.push(s);
const table = (head, rows) => { line(`| ${head.join(' | ')} |`); line(`|${head.map(() => '---').join('|')}|`); for (const r of rows) line(`| ${r.join(' | ')} |`); line(); };
const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(0)}%` : '–');
const frac = (a, b) => (b > 0 ? `${a}/${b}` : '–');
const rate = (x) => (x === null || x === undefined ? '–' : `${(100 * x).toFixed(1)}%`);
const ms = (x) => (x === null || x === undefined ? '–' : `${Math.round(x)}`);
const isFl = (id) => byId.get(id)?.tags.includes('fleurs');
const usage = usageTotals();

line(`# ML-0 multilingual baseline (${prefix})`);
line();
line(`Generated ${new Date().toISOString()} by scripts/eval/speech-quality/score-ml.mjs. Ledger: Soniox ${(usage.soniox_audio_sec / 60).toFixed(1)} audio-min, LLM ${usage.llm_calls} calls.`);
line();
line('Error unit: WER (words) for fr/es/de/ru, CER (characters) for ja and ko; ko also shows eojeol WER. Fillers in ml-scoring.mjs DROP_FILLERS removed from both sides; listed number forms mapped to the reference form; spoken punctuation commands removed (own metric). `syn` = macOS TTS items written for this card, `fl` = FLEURS real read speech.');
line();

// ── 1. STT ──────────────────────────────────────────────────────────────────
line('## 1. STT, config `hints` (production default: language_hints only)');
line();
{
  const rows = [];
  for (const L of ML_LANGS) for (const part of ['syn', 'fl', 'all']) {
    const rs = stt.filter((r) => r.lang === L && (part === 'all' || (part === 'fl') === isFl(r.id)));
    if (!rs.length) continue;
    const a = agg(rs, 'pipeline_text');
    rows.push([L, part, a.n, `${rateName(L)} ${rate(a.rate)}`, L === 'ko' ? rate(a.wRate) : '', frac(a.termHit, a.termN), frac(a.termHitCi, a.termN), a.numN ? `${frac(a.numHit, a.numN)} (d${a.numDigit}/w${a.numWord})` : '–', frac(a.spHit, a.spN), frac(a.fillerClean, a.fillerItems), a.drift.length,
      ms(percentile(rs.map((r) => r.ttft_ms), 50)), ms(percentile(rs.map((r) => r.ttft_ms), 90)), ms(percentile(rs.map((r) => r.release_to_final_ms), 50)), ms(percentile(rs.map((r) => r.release_to_final_ms), 90)), rs.filter((r) => r.error).length]);
  }
  table(['lang', 'set', 'n', 'error', 'ko eojeol WER', 'terms exact', 'terms any-case', 'numbers hit (digit/word form)', 'spoken punct converted', 'filler-free', 'drift', 'TTFT p50', 'p90', 'release→final p50', 'p90', 'errors'], rows);
  line('### STT by tag (synthetic items)');
  line();
  const tags = ['numbers', 'names', 'jargon', 'fillers', 'self_correction', 'negation', 'register', 'spoken_punctuation', 'long_ramble'];
  const trows = [];
  for (const tag of tags) {
    const cells = [tag];
    for (const L of ML_LANGS) {
      const rs = stt.filter((r) => r.lang === L && byId.get(r.id)?.tags.includes(tag) && !isFl(r.id));
      cells.push(rs.length ? rate(agg(rs, 'pipeline_text').rate) : '–');
    }
    trows.push(cells);
  }
  table(['tag', ...ML_LANGS.map((l) => `${l} ${rateName(l)}`)], trows);
  line('### Missed terms and numbers (STT)');
  line();
  for (const L of ML_LANGS) {
    const a = agg(stt.filter((r) => r.lang === L), 'pipeline_text');
    line(`- **${L}** terms: ${a.missed.join(', ') || 'none'}; numbers: ${a.missedNumbers.join(', ') || 'none'}`);
  }
  line();
  const drifts = stt.flatMap((r) => { const c = checks(byId.get(r.id), r.pipeline_text); return c.drift ? [`${r.id}: ${JSON.stringify(c.drift.sentences)}`] : []; });
  line(`STT language drift cases: ${drifts.length}${drifts.length ? '' : ' (none)'}`);
  for (const d of drifts) line(`- ${d}`);
  line();
}

// ── 2. coding default context on jargon ─────────────────────────────────────
if (sttDef.length) {
  line('## 2. STT `default` (coding default context, 150 terms) vs `hints`, jargon items');
  line();
  const rows = [];
  for (const L of ML_LANGS) {
    const ids = new Set(sttDef.filter((r) => r.lang === L).map((r) => r.id));
    if (!ids.size) continue;
    const a = agg(stt.filter((r) => ids.has(r.id)), 'pipeline_text');
    const b = agg(sttDef.filter((r) => ids.has(r.id)), 'pipeline_text');
    rows.push([L, ids.size, `${a.edits}/${a.refLen}`, `${b.edits}/${b.refLen}`, frac(a.termHit, a.termN), frac(b.termHit, b.termN), b.drift.length]);
  }
  table(['lang', 'items', 'hints edits', 'default edits', 'hints terms exact', 'default terms exact', 'default drift'], rows);
  line('Items where default changed the text:');
  line();
  for (const r of sttDef) {
    const h = stt.find((x) => x.id === r.id);
    if (h && h.pipeline_text !== r.pipeline_text) line(`- ${r.id}: hints «${h.pipeline_text}» → default «${r.pipeline_text}»`);
  }
  line();
}

// ── 3. polish ───────────────────────────────────────────────────────────────
line('## 3. Realtime polish (Strict / Smooth) on STT output and on references');
line();
{
  const rows = [];
  for (const L of ML_LANGS) for (const source of ['stt', 'ref']) for (const strength of ['strict', 'smooth']) {
    const rs = polish.filter((r) => r.lang === L && r.source === source && r.strength === strength);
    if (!rs.length) continue;
    const cnt = (o) => rs.filter((r) => r.outcome === o).length;
    const rejects = {};
    for (const r of rs.filter((x) => x.outcome === 'guard_reject')) rejects[r.reason] = (rejects[r.reason] ?? 0) + 1;
    const ain = agg(rs.map((r) => ({ id: r.id, text: r.input })), 'text');
    const aout = agg(rs.map((r) => ({ id: r.id, text: r.output })), 'text');
    const aSyn = agg(rs.filter((r) => !isFl(r.id)).map((r) => ({ id: r.id, text: r.output })), 'text');
    const exp = rs.map((r) => expectChecks(byId.get(r.id), strength, r.output)).filter((x) => x !== null);
    rows.push([L, source, strength, rs.length, pct(cnt('applied'), rs.length), pct(cnt('applied_unchanged'), rs.length),
      `${cnt('guard_reject')}${Object.keys(rejects).length ? ` (${Object.entries(rejects).map(([k, v]) => `${k.replace('closed-class-drift:', 'cc:')}×${v}`).join(', ')})` : ''}`,
      cnt('timeout') + cnt('llm_error') + cnt('error'), `${rate(ain.rate)}→${rate(aout.rate)}`,
      frac(aSyn.fillerClean, aSyn.fillerItems), frac(aSyn.regOk, aSyn.regN), frac(aSyn.negOk, aSyn.negN), frac(aSyn.scResolved, aSyn.scN), frac(aSyn.spHit, aSyn.spN),
      aSyn.numN ? `${frac(aSyn.numHit, aSyn.numN)} (d${aSyn.numDigit}/w${aSyn.numWord})` : '–', aout.drift.length,
      frac(exp.filter((f) => f.length === 0).length, exp.length),
      ms(percentile(rs.map((r) => r.elapsed_ms), 50)), ms(percentile(rs.map((r) => r.elapsed_ms), 90))]);
  }
  table(['lang', 'src', 'strength', 'n', 'applied (changed)', 'unchanged', 'refused (check)', 'timeout/err', 'error vs ref in→out', 'filler-free', 'register kept', 'negation kept', 'self-corr resolved', 'spoken punct', 'numbers (digit/word)', 'drift', 'expect met', 'ms p50', 'p90'], rows);
  line('Columns from `filler-free` to `numbers` are on synthetic items only (FLEURS items carry none of those facts).');
  line();
  line('### Every polish output that left the input language');
  line();
  let any = false;
  for (const r of polish) {
    const d = detectDrift(r.lang, r.output, byId.get(r.id)?.terms ?? []);
    if (d.drifted) { any = true; line(`- ${r.id} ${r.source}/${r.strength} (${r.outcome}): ${JSON.stringify(d.sentences)}`); }
    const c = r.candidate ? detectDrift(r.lang, r.candidate, byId.get(r.id)?.terms ?? []) : null;
    if (c?.drifted && r.output !== r.candidate) { any = true; line(`- ${r.id} ${r.source}/${r.strength} CANDIDATE refused by ${r.reason}: ${JSON.stringify(c.sentences)}`); }
  }
  if (!any) line('- none');
  line();
  line('### Guard refusals (input → model candidate)');
  line();
  for (const r of polish.filter((x) => x.outcome === 'guard_reject')) line(`- ${r.id} ${r.source}/${r.strength} **${r.reason}**: «${r.input.slice(0, 160)}» → «${(r.candidate ?? '').slice(0, 160)}»`);
  line();
  line('### Expectation failures on delivered text');
  line();
  for (const r of polish) {
    const f = expectChecks(byId.get(r.id), r.strength, r.output);
    if (f && f.length) line(`- ${r.id} ${r.source}/${r.strength} (${r.outcome}): ${f.join('; ')} — «${r.output.slice(0, 160)}»`);
  }
  line();
  line('### Register, negation and self-correction outcomes on delivered text (synthetic)');
  line();
  for (const r of polish.filter((x) => !isFl(x.id))) {
    const it = byId.get(r.id), c = checks(it, r.output), notes = [];
    if (c.regOk === false) notes.push(`register ${it.register.form} broken: kept=${c.regKept} flipped=${c.regFlipped.join('/')}`);
    if (c.negOk === false) notes.push(`negation lost: ${c.negLost.join('/')}`);
    if (c.scResolved === false && r.strength === 'smooth') notes.push(`self-correction ${c.scRight && c.scWrong ? 'kept both' : c.scRight ? 'resolved' : 'lost the correction'}`);
    if (notes.length) line(`- ${r.id} ${r.source}/${r.strength} (${r.outcome}): ${notes.join('; ')} — «${r.output.slice(0, 140)}»`);
  }
  line();
}

// ── 3b. smooth first attempt (instrumented rerun) ──
if (smooth2.length) {
  line('### 3b. Smooth: how often the smooth attempt itself was refused (instrumented rerun, STT source, synthetic items)');
  line();
  line('run-polish now records `applied_strength`, `first_reject` and every model candidate. A refused smooth attempt falls back to ONE strict attempt (stt-polish.ts QP-1); the main table above cannot tell the two apart. Separate run, so single items can differ from the table above (the model is not deterministic, and this run met more vendor timeouts).');
  line();
  const rows = [];
  for (const L of ML_LANGS) {
    const rs = smooth2.filter((r) => r.lang === L);
    if (!rs.length) continue;
    const refused = rs.filter((r) => r.first_reject);
    rows.push([L, rs.length, refused.length, refused.map((r) => `${r.id}:${r.first_reject.replace('closed-class-drift:', 'cc:')}→${r.applied_strength ? 'strict ' + r.outcome : 'kept raw'}`).join('; ') || '–', rs.filter((r) => r.outcome === 'timeout').length]);
  }
  table(['lang', 'n', 'smooth refused', 'which (→ what the user got)', 'timeouts'], rows);
  for (const r of smooth2.filter((x) => x.first_reject)) line(`- ${r.id}: smooth candidate «${(r.candidates?.[0] ?? '').slice(0, 140)}» refused by ${r.first_reject}; delivered «${r.output.slice(0, 140)}»`);
  line();
}

// ── 4. compose ──────────────────────────────────────────────────────────────
if (compose.length) {
  line('## 4. Compose organize / translate on STT output');
  line();
  const rows = [];
  const notes = [];
  for (const L of ML_LANGS) for (const t of ['organize', 'translate:en', 'translate:zh-CN']) {
    const [task, target] = t.split(':');
    const rs = compose.filter((r) => r.lang === L && r.task === task && (r.target ?? undefined) === target);
    if (!rs.length) continue;
    let wrongLang = 0, negLost = 0;
    for (const r of rs) {
      const want = task === 'organize' ? L : target === 'en' ? 'en' : 'zh';
      const d = detectDrift(want, r.output, byId.get(r.id)?.terms ?? []);
      if (d.drifted) { wrongLang++; notes.push(`- ${r.id} ${t}: output not in ${want}: ${JSON.stringify(d.sentences)}`); }
      if (task === 'organize') { const c = checks(byId.get(r.id), r.output); if (c.negOk === false) { negLost++; notes.push(`- ${r.id} organize: negation lost ${c.negLost.join('/')} — «${r.output.slice(0, 140)}»`); } }
    }
    rows.push([L, t, rs.length, rs.filter((r) => r.guard === 'ok').length, rs.filter((r) => r.guard?.startsWith('reject')).map((r) => r.guard).join(' ') || '–', wrongLang, task === 'organize' ? negLost : '–', ms(percentile(rs.map((r) => r.wall_ms), 50))]);
  }
  table(['lang', 'task', 'n', 'guard ok', 'guard rejects', 'wrong output language', 'negation lost', 'ms p50'], rows);
  for (const n of notes) line(n);
  line();
}

// ── 5. adversarial pairs ────────────────────────────────────────────────────
if (pairs.length) {
  line('## 5. Adversarial guard pairs (guard-pairs-ml.jsonl) through the current guards');
  line();
  const rows = [];
  for (const L of ML_LANGS) {
    const rs = pairs.filter((r) => r.lang === L);
    const harm = rs.filter((r) => r.harmful), ben = rs.filter((r) => !r.harmful);
    rows.push([L, harm.length, harm.filter((r) => r.strict === 'accept').length, harm.filter((r) => r.smooth === 'accept').length,
      harm.filter((r) => r.compose.draft_polish === 'accept').length, harm.filter((r) => r.drift_detected).length,
      ben.length, ben.filter((r) => r.wrong_strict).length, ben.filter((r) => r.wrong_smooth).length]);
  }
  table(['lang', 'harmful', 'wrongly accepted strict', 'wrongly accepted smooth', 'compose(draft_polish) accepted', 'caught by ML-0 drift check', 'benign', 'wrongly refused strict', 'wrongly refused smooth'], rows);
  line('### Wrongly accepted (harmful pair passed the realtime guard)');
  line();
  for (const r of pairs.filter((x) => x.harmful && (x.strict === 'accept' || x.smooth === 'accept'))) {
    line(`- ${r.id} ${r.kind}: strict ${r.strict}, smooth ${r.smooth}${r.drift_detected ? `, drift check: ${r.drift_detected}` : ''}; compose draft_polish ${r.compose.draft_polish}, organize ${r.compose.organize} — «${r.raw}» → «${r.polished}»${r.note ? ` (${r.note})` : ''}`);
  }
  line();
  line('### Harmful pairs refused, and by which check');
  line();
  for (const r of pairs.filter((x) => x.harmful && x.strict === 'reject')) line(`- ${r.id} ${r.kind}: strict ${r.strict_reason}, smooth ${r.smooth_reason ?? 'accept'}`);
  line();
  line('### Wrongly refused (benign pair refused)');
  line();
  for (const r of pairs.filter((x) => !x.harmful && (x.wrong_strict || x.wrong_smooth))) {
    line(`- ${r.id} ${r.kind}: strict ${r.strict}${r.strict_reason ? ` (${r.strict_reason})` : ''}, smooth ${r.smooth}${r.smooth_reason ? ` (${r.smooth_reason})` : ''} — «${r.raw}» → «${r.polished}»${r.note ? ` (${r.note})` : ''}`);
  }
  line();
}

const outPath = resolve(args.out ?? join(R, `${prefix}-report.md`));
writeFileSync(outPath, md.join('\n'));
console.log(`[score-ml] wrote ${outPath}`);
