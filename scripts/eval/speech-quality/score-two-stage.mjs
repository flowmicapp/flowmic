#!/usr/bin/env node
// scripts/eval/speech-quality/score-two-stage.mjs — card POL-2: report for the
// two-stage polish eval (design docs/strategy/2026-10-14-two-stage-polish-design.md §9.4).
//
//   node scripts/eval/speech-quality/score-two-stage.mjs --runs pol2a-pc-runs.jsonl,pol2a-notes-runs.jsonl --prefix pol2a
//   -> <results>/pol2a-two-stage-report.md and pol2a-two-stage.json
//
// Pure local computation over run-two-stage.mjs output (relative paths resolve
// against the results directory). Metric definitions and blind spots are in
// two-stage-scoring.mjs's header and the README. Latency is read only from runs
// made at --concurrency 1 (see README "Through a local relay").

import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { AUDIO_DIR, RESULTS_DIR, parseArgs, percentile, readJsonl, readWav } from './lib.mjs';
import { silenceRuns } from './relay-audio.mjs';
import { scorePress } from './two-stage-scoring.mjs';

process.env.FLOWMIC_EVAL_CORPUS ??= 'corpus-long.json';
const { loadCorpus } = await import('./lib.mjs');
const args = parseArgs();
const R = RESULTS_DIR();
const byId = new Map(loadCorpus().items.map((it) => [it.id, it]));
const files = String(args.runs ?? '').split(',').map((f) => f.trim()).filter(Boolean).map((f) => (isAbsolute(f) ? f : join(R, f)));
if (!files.length) { console.error('--runs a.jsonl[,b.jsonl] required'); process.exit(2); }
const prefix = args.prefix ?? 'two-stage';

const presses = [];
const metas = [];
let refused = 0;
for (const f of files) {
  let workers = null;
  for (const r of readJsonl(f)) {
    if (r.meta) { workers = r.meta.workers; metas.push({ file: f, ...r.meta }); continue; }
    if (r.harness_error) { refused++; console.warn(`[score-two-stage] ${r.id}: harness error, skipped`); continue; }
    // The stamp and the rows are what make a record this eval's: refuse anything else.
    if (r.kind !== 'live' || !Array.isArray(r.rows)) { refused++; console.warn(`[score-two-stage] ${r.id} ${r.strength}/${r.path}: no live stamp or no rows (not a run-two-stage.mjs record), refused`); continue; }
    const it = byId.get(r.id);
    if (!it) throw new Error(`${r.id} is not in corpus-long.json`);
    const rows = r.rows.map((x) => x.text);
    const raw = r.rows.map((x) => x.raw);
    presses.push({ r, it, workers, s: scorePress(it, r.strength, rows, raw.every((x) => typeof x === 'string') ? raw : null) });
  }
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');
const rate = (e, n) => (n ? `${((100 * e) / n).toFixed(1)}%` : 'n/a');
const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) ?? 0), 0);
const q = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? `${percentile(v, 50)} / ${percentile(v, 95)} / ${Math.max(...v)} (n=${v.length})` : 'n/a'; };
const groupKey = (p) => `${p.r.path}/${p.r.strength}`;
const groups = [...new Set(presses.map(groupKey))].sort();
const langs = [...new Set(presses.map((p) => p.it.lang))];
const out = [];
const L = (s = '') => out.push(s);

L(`# Two-stage polish eval — ${prefix}`);
L();
L(`Generated ${new Date().toISOString()} by score-two-stage.mjs. ${presses.length} presses scored, ${refused} refused or failed.`);
for (const m of metas) L(`- \`${m.file.split(/[\\/]/).pop()}\`: server-core ${m.server_core_head ?? '?'}, model ${m.model}, endpoint ${m.endpoint}, workers ${m.workers}, llm_tap ${m.llm_tap}, relay_env ${JSON.stringify(m.relay_env)}`);
L();

// ── plan check ──────────────────────────────────────────────────────────────
const allSeams = presses.flatMap((p) => p.s.seams);
L('## Cuts: planned vs actual');
L();
L(`Presses with rows = planned cuts + 1: ${presses.filter((p) => p.s.rows === p.s.planned_cuts + 1).length}/${presses.length}. Seams: ${allSeams.length} (mid ${allSeams.filter((x) => x.kind === 'mid').length}, end ${allSeams.filter((x) => x.kind === 'end').length}); on a planned cut (±2 tokens): ${allSeams.filter((x) => x.planned).length}; planned kind = measured kind: ${allSeams.filter((x) => x.planned && x.planned === x.kind).length}.`);
L();

// ── text quality per group x language ───────────────────────────────────────
L('## Text (delivered rows, joined; raw = what the relay asked the model to polish)');
L();
L('| group | lang | n | error rate (raw → delivered) | mid seams | cut errors raw → delivered | of which terminator / dash / capital / lead punct | end seams lost terminator | seam words lost+dup raw → delivered | cross-ref right (context had it) | self-correction kept | poison kept | expectations met | term spelling inconsistent |');
L('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const g of groups) for (const lang of langs) {
  const ps = presses.filter((p) => groupKey(p) === g && p.it.lang === lang);
  if (!ps.length) continue;
  const ref = sum(ps, (p) => p.s.ref_tokens);
  const withRaw = ps.filter((p) => p.s.raw);
  const mid = ps.flatMap((p) => p.s.seams.filter((x) => x.kind === 'mid'));
  const midRaw = withRaw.flatMap((p) => p.s.raw.seams.filter((x) => x.kind === 'mid'));
  const end = ps.flatMap((p) => p.s.seams.filter((x) => x.kind === 'end'));
  const errs = (xs, e) => xs.filter((x) => x.errors.includes(e)).length;
  const words = (xs) => sum(xs, (x) => x.lost + x.dup);
  const xr = ps.flatMap((p) => p.s.cross_refs), xrc = xr.filter((x) => x.in_context);
  const sc = ps.filter((p) => p.s.self_correction !== null), po = ps.flatMap((p) => p.s.poison), ex = ps.filter((p) => p.s.expect);
  L(`| ${g} | ${lang} | ${ps.length} | ${rate(sum(withRaw, (p) => p.s.raw.errors), sum(withRaw, (p) => p.s.ref_tokens))} → ${rate(sum(ps, (p) => p.s.errors), ref)} | ${mid.length} | ${midRaw.filter((x) => x.errors.length).length} → ${mid.filter((x) => x.errors.length).length} | ${errs(mid, 'terminator')} / ${errs(mid, 'dash')} / ${errs(mid, 'capital')} / ${errs(mid, 'lead_punct')} | ${errs(end, 'lost_terminator')}/${end.length} | ${words(withRaw.flatMap((p) => p.s.raw.seams))} → ${words(ps.flatMap((p) => p.s.seams))} | ${xr.filter((x) => x.ok).length}/${xr.length} (${xrc.filter((x) => x.ok).length}/${xrc.length}) | ${sc.filter((p) => p.s.self_correction).length}/${sc.length} | ${po.filter((x) => x.ok).length}/${po.length} | ${ex.filter((p) => p.s.expect.ok).length}/${ex.length} | ${sum(ps, (p) => p.s.term_inconsistent)} |`);
}
L();
L('Raw columns cover presses where every row had a tapped polish call; a row whose polish was skipped before any call leaves the press out of the raw column.');
L();

// ── polish status per stage ────────────────────────────────────────────────
L('## Polish status per row (segment rows = stage 1 in the design; terminal row = stage 2)');
L();
L('| group | stage | rows | applied | skipped by reason | no flag |');
L('|---|---|---|---|---|---|');
for (const g of groups) for (const stage of ['segment', 'terminal']) {
  const rows = presses.filter((p) => groupKey(p) === g).flatMap((p) => p.r.rows).filter((x) => (stage === 'terminal') === x.terminal);
  const reasons = {};
  for (const x of rows) if (x.polish === 'skipped') reasons[x.polish_reason ?? 'none'] = (reasons[x.polish_reason ?? 'none'] ?? 0) + 1;
  L(`| ${g} | ${stage} | ${rows.length} | ${pct(rows.filter((x) => x.polish === 'applied').length, rows.length)} | ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') || '-'} | ${rows.filter((x) => !x.polish).length} |`);
}
L();

// ── latency ────────────────────────────────────────────────────────────────
const lat = presses.filter((p) => p.workers === 1);
L(`## Latency (ms, p50 / p95 / max; only runs at --concurrency 1: ${lat.length} presses)`);
L();
L('| group | segment polish hold | terminal polish wait | release → terminal final | release → PC (terminal row) | next row first interim after speech resumes | segment row: phone → PC |');
L('|---|---|---|---|---|---|---|');
for (const g of groups) {
  const ps = lat.filter((p) => groupKey(p) === g);
  if (!ps.length) continue;
  const segHold = ps.flatMap((p) => (p.r.polish_finals ?? []).filter((f) => f.is_segment).map((f) => f.wait_ms));
  const termWait = ps.flatMap((p) => (p.r.polish_finals ?? []).filter((f) => !f.is_segment).map((f) => f.wait_ms));
  const gaps = ps.flatMap((p) => resumeDelays(p));
  const segPc = ps.flatMap((p) => p.r.rows.filter((x) => !x.terminal && x.inject_at_pc_dt !== null).map((x) => x.inject_at_pc_dt - x.dt_press));
  L(`| ${g} | ${q(segHold)} | ${q(termWait)} | ${q(ps.map((p) => p.r.release_to_final_ms))} | ${q(ps.map((p) => p.r.release_to_inject_at_pc_ms))} | ${q(gaps)} | ${q(segPc)} |`);
}
L();
L('Segment polish hold and terminal wait are the relay\'s own `stt.polish.final wait_ms` (final reached the bridge → frame left). "Next row\'s first interim after speech resumes": the k-th planned 2 s silence ends and the speaker goes on, while the relay holds that speech\'s interims behind row k\'s polish (ordered outbox); it is the first non-empty interim of a later segment minus the moment the speech resumed, so it includes the normal first-interim latency (the press\'s own first interim from speech: ' + q(lat.map((p) => p.r.first_interim_from_speech_ms)) + ').');
L();

// ── usage ──────────────────────────────────────────────────────────────────
const calls = presses.flatMap((p) => (p.r.llm_tap ?? []).filter((c) => !/^Connectivity probe/.test(c.system_head ?? '')));
L('## Usage');
L();
L(`Audio streamed ${(sum(presses, (p) => p.r.audio_ms) / 60000).toFixed(1)} min; polish calls tapped ${calls.length}; vendor tokens in ${sum(calls, (c) => c.usage?.in)} (cached ${sum(calls, (c) => c.usage?.cached)}), out ${sum(calls, (c) => c.usage?.out)}. Ledger: \`${process.env.FLOWMIC_EVAL_RELAY_LEDGER ?? 'pol2-relay-usage-ledger.jsonl'}\`.`);
L();

// ── examples ───────────────────────────────────────────────────────────────
L('## Mid-sentence seams with an error (delivered)');
L();
for (const p of presses) for (const x of p.s.seams.filter((y) => y.kind === 'mid' && y.errors.length)) {
  const a = p.r.rows[x.k].text, b = p.r.rows[x.k + 1].text;
  const rawErr = p.s.raw?.seams.find((y) => y.k === x.k)?.errors ?? null;
  L(`- ${p.it.id} ${groupKey(p)} seam ${x.k} [${x.errors.join(', ')}]${rawErr ? ` raw [${rawErr.join(', ') || 'clean'}]` : ''}: …${a.slice(-30)} ‖ ${b.slice(0, 30)}…`);
}
L();
L('## Cross-references missed (context had the right form)');
L();
for (const p of presses) for (const x of p.s.cross_refs.filter((y) => y.in_context && !y.ok)) L(`- ${p.it.id} ${groupKey(p)}: ${x.right}`);

/** Per non-terminal row k of an on-plan press: first non-empty interim of a later segment
 *  minus the end of the k-th planned silence in the audio (relay-audio.mjs silenceRuns). */
function resumeDelays(p) {
  if (p.s.rows !== p.s.planned_cuts + 1) return [];
  const pauses = silenceRuns(readWav(join(AUDIO_DIR(), `${p.it.id}.wav`)), 1500);
  return p.r.rows.filter((x) => !x.terminal).map((x, k) => {
    const resume = pauses[k] ? pauses[k].at_ms + pauses[k].ms : null;
    const first = (p.r.interim_times ?? []).find(([dt, seg, len]) => len > 0 && seg !== null && seg > x.to_seg && resume !== null && dt >= resume);
    return first ? first[0] - resume : null;
  });
}

writeFileSync(join(R, `${prefix}-two-stage-report.md`), out.join('\n') + '\n');
writeFileSync(join(R, `${prefix}-two-stage.json`), JSON.stringify(presses.map((p) => ({ id: p.it.id, lang: p.it.lang, path: p.r.path, strength: p.r.strength, ...p.s })), null, 1));
console.log(`[score-two-stage] ${presses.length} presses -> ${join(R, `${prefix}-two-stage-report.md`)}`);
