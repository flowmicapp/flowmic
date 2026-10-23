#!/usr/bin/env node
// scripts/eval/speech-quality/run-two-stage.mjs — card POL-2: the two-stage
// polish eval runner (design docs/strategy/2026-10-14-two-stage-polish-design.md §9).
//
//   node scripts/eval/speech-quality/run-two-stage.mjs --check-audio            # planned cuts vs the 30 s window
//   node scripts/eval/speech-quality/run-two-stage.mjs --arm A --paths pc --dry-run
//   node scripts/eval/speech-quality/run-two-stage.mjs --arm A --paths pc --strengths strict,smooth --prefix pol2a-pc
//   node scripts/eval/speech-quality/run-two-stage.mjs --arm A --paths notes --concurrency 3 --prefix pol2a-notes
//   node scripts/eval/speech-quality/score-two-stage.mjs --runs pol2a-pc-runs.jsonl,pol2a-notes-runs.jsonl --prefix pol2a
//
// It is a thin wrapper around run-relay.mjs that pins what this eval must never
// run without:
//   · the long corpus (FLOWMIC_EVAL_CORPUS=corpus-long.json);
//   · --live-stamp: every shipped phone sends the live-start fields
//     (apps/mobile/lib/src/session/recovery_identity.dart `liveStartFields`), and
//     without them the relay's segment path is not the one users get — on
//     2026-10-13 a fix was A/B'd without the stamp and shipped as a no-op;
//   · --record-finals: per-row settlement and per-row delivery (relay-rows.mjs);
//   · --llm-tap: the raw text of each polish call and the vendor's token usage;
//   · its own relay ledger (pol2-relay-usage-ledger.jsonl unless
//     FLOWMIC_EVAL_RELAY_LEDGER is set) with caps sized for this corpus.
// The scorer refuses records that lack the stamp or the rows, so a run made
// without this wrapper cannot be scored by accident.
//
// Arms: the relay build and environment that stand for one design variant.
//   A  legacy: today's main, every row polished on its own (no extra env).
// Arm B (rows polished with the earlier rows as context) needs the POL-3 relay
// and its switch; it is added here when that card lands, not before.
//
// Before every run it checks the audio (relay-audio.mjs silenceRuns): each
// planned 2 s silence must fall where the relay's soft-segment rule will cut on
// it (past 30 s of the row, before the 45 s ceiling), and no natural pause in
// the window may be long enough (>= 600 ms, segment-boundary.ts MIN_PAUSE_MS)
// to be cut on instead. A failed check refuses to spend.
//
// NOT A GATE: it spends Soniox seconds and DeepSeek calls (see README.md).

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_DIR, HERE, RESULTS_DIR, loadCorpus, parseArgs, readWav } from './lib.mjs';
import { silenceRuns } from './relay-audio.mjs';

process.env.FLOWMIC_EVAL_CORPUS = 'corpus-long.json';
process.env.FLOWMIC_EVAL_RELAY_LEDGER ??= 'pol2-relay-usage-ledger.jsonl';
process.env.FLOWMIC_EVAL_SONIOX_CAP_SEC ??= '9000';
process.env.FLOWMIC_EVAL_LLM_CAP ??= '1500';

const args = parseArgs();
const corpus = loadCorpus();
const list = (v, d) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

const ARMS = { A: { relayEnv: {}, note: 'legacy: each row polished on its own (current main)' } };

// segment-boundary.ts / orchestrator-types.ts: cut due 30 s into a row, ceiling 15 s later,
// a closed gate of MIN_PAUSE_MS counts as a pause. Margins: the row clock starts a little
// after the previous silence began, and the gate needs MIN_PAUSE_MS of it.
const DUE_MS = 30_000, CEILING_MS = 45_000, MIN_PAUSE_MS = 600, PLANNED_MIN_MS = 1500;
function checkItemAudio(pcm) {
  const planned = silenceRuns(pcm, PLANNED_MIN_MS);
  const natural = silenceRuns(pcm, MIN_PAUSE_MS - 100).filter((r) => r.ms < PLANNED_MIN_MS);
  const problems = [];
  let rowStart = 0;
  for (const p of planned) {
    const into = p.at_ms - rowStart;
    if (into < DUE_MS + 300) problems.push(`silence at ${(p.at_ms / 1000).toFixed(1)} s is only ${(into / 1000).toFixed(1)} s into its row (< 30.3 s): no cut there`);
    if (into > CEILING_MS - 1500) problems.push(`silence at ${(p.at_ms / 1000).toFixed(1)} s is ${(into / 1000).toFixed(1)} s into its row: the 45 s ceiling may cut first`);
    for (const n of natural) if (n.at_ms > rowStart + DUE_MS && n.at_ms < p.at_ms) problems.push(`natural pause of ${n.ms} ms at ${(n.at_ms / 1000).toFixed(1)} s may be cut on before the planned one`);
    rowStart = p.at_ms + MIN_PAUSE_MS;
  }
  return { planned: planned.map((p) => +(p.at_ms / 1000).toFixed(1)), max_natural_ms: Math.max(0, ...silenceRuns(pcm, 200).filter((r) => r.ms < PLANNED_MIN_MS).map((r) => r.ms)), problems };
}

const onlyIds = list(args.ids, null), onlyLang = list(args.lang, null);
const items = corpus.items.filter((it) => (!onlyIds || onlyIds.includes(it.id)) && (!onlyLang || onlyLang.includes(it.lang)));
let bad = 0;
for (const it of items) {
  const c = checkItemAudio(readWav(join(AUDIO_DIR(), `${it.id}.wav`)));
  if (c.planned.length !== it.cuts.length) c.problems.push(`${c.planned.length} planned silences in the audio, ${it.cuts.length} cuts in the corpus`);
  if (args['check-audio'] || c.problems.length) console.log(`[run-two-stage] ${it.id}: silences at ${c.planned.join(', ')} s, longest natural pause ${c.max_natural_ms} ms${c.problems.length ? ' — ' + c.problems.join('; ') : ''}`);
  if (c.problems.length) bad++;
}
if (bad) { console.error(`[run-two-stage] ${bad} item(s) would not be cut where the corpus says; fix the text or re-render (gen-audio.mjs) first.`); process.exit(2); }
if (args['check-audio']) process.exit(0);

const arm = String(args.arm ?? '');
if (!ARMS[arm]) { console.error(`[run-two-stage] --arm must be one of ${Object.keys(ARMS).join(', ')}`); process.exit(2); }
const paths = list(args.paths, ['pc', 'notes']);
const strengths = list(args.strengths, ['strict', 'smooth']);
for (const p of paths) if (p !== 'pc' && p !== 'notes') throw new Error(`--paths: ${p} (pc | notes)`);
// Path-major order: a worker restarts its relay before it repeats an item (polish cache),
// so running every item once per pass keeps the relay restarts to one per pass.
const jobs = [];
for (const path of paths) for (const strength of strengths) for (const it of items) jobs.push({ id: it.id, scenario: 'base', strength, path, kind: 'live' });
const R = RESULTS_DIR();
mkdirSync(R, { recursive: true });
const prefix = args.prefix ?? `pol2${arm.toLowerCase()}`;
const jobsFile = join(R, `${prefix}-jobs.json`);
writeFileSync(jobsFile, JSON.stringify(jobs));
const relayEnv = Object.entries(ARMS[arm].relayEnv).map(([k, v]) => `${k}=${v}`).join(';');
const argv = [join(HERE, 'run-relay.mjs'), '--jobs', jobsFile, '--live-stamp', '--record-finals', '--llm-tap',
  '--out', join(R, `${prefix}-runs.jsonl`), '--concurrency', String(args.concurrency ?? 1),
  ...(relayEnv ? ['--relay-env', relayEnv] : []),
  ...['server-core', 'stt-cloud', 'endpoint', 'model'].flatMap((k) => (typeof args[k] === 'string' ? [`--${k}`, args[k]] : [])),
  ...(args['dry-run'] ? ['--dry-run'] : []), ...(args['allow-over'] ? ['--allow-over'] : []), ...(args['keep-home'] ? ['--keep-home'] : [])];
console.log(`[run-two-stage] arm ${arm} (${ARMS[arm].note}): ${jobs.length} jobs = ${items.length} items x paths ${paths.join('/')} x ${strengths.join('/')}; ledger ${process.env.FLOWMIC_EVAL_RELAY_LEDGER}`);
const r = spawnSync(process.execPath, argv, { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
