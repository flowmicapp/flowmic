// scripts/loadtest/baseline.mjs — NR-5 S0a: the owner-requested local ramp
// (10 → 50 → 100 → 200 concurrent clients), stopping early if failures spike.
//
// Each step is a FULL, independent run.mjs invocation (fresh spawned server,
// fresh port) rather than growing one long-lived run — that keeps each step's
// numbers free of warm-cache / already-open-socket bias from the step before
// it, at the cost of re-paying server startup between steps. For an
// order-of-magnitude ceiling measurement (which is what S0a asked for, not a
// precise curve) that trade is the right one.
//
// This file NEVER touches a remote host — it calls runLoadTest() from run.mjs
// with the same target-guard config every step, so the loopback-only rule
// (lib/target-guard.mjs) applies identically to every step.
//
// Usage: node scripts/loadtest/baseline.mjs
//        node scripts/loadtest/baseline.mjs --steps 10,50,100,200 --minutes 1 --ramp 5
//        node scripts/loadtest/baseline.mjs --engine local --steps 5,20

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoadTest } from './run.mjs';
import { DEFAULTS } from './lib/cli-args.mjs';
import { RESULTS_DIR } from './lib/report.mjs';

const DEFAULT_STEPS = [10, 50, 100, 200];
const FAIL_CONNECT_PCT = 95; // stop the ramp if fewer than this % of clients connected
const FAIL_PAIR_PCT = 95;    // stop the ramp if fewer than this % of connected clients paired
const FAIL_ERROR_RATE_PCT = 5; // stop the ramp if client-side errors exceed this % of utterance attempts

function parseBaselineArgs(argv) {
  const out = {
    steps: DEFAULT_STEPS,
    minutes: 1,
    ramp: 5,
    engine: DEFAULTS.engine,
    utteranceMs: DEFAULTS.utteranceMs,
    gapMs: DEFAULTS.gapMs,
    heartbeatMs: DEFAULTS.heartbeatMs,
    sampleIntervalMs: DEFAULTS.sampleIntervalMs,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--steps') out.steps = argv[++i].split(',').map(Number);
    else if (a === '--minutes') out.minutes = Number(argv[++i]);
    else if (a === '--ramp') out.ramp = Number(argv[++i]);
    else if (a === '--engine') out.engine = argv[++i];
    else if (a === '--utterance-ms') out.utteranceMs = Number(argv[++i]);
    else if (a === '--gap-ms') out.gapMs = Number(argv[++i]);
    else if (a === '--heartbeat-ms') out.heartbeatMs = Number(argv[++i]);
    else if (a === '--sample-interval-ms') out.sampleIntervalMs = Number(argv[++i]);
    else throw new Error(`unrecognized argument: ${a}`);
  }
  if (out.steps.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`--steps must be a comma list of positive integers, got "${out.steps}"`);
  return out;
}

/** Why THIS step is where the ramp stopped, or null if it should continue. */
function failureReason(report) {
  if (report.summary.connect_rate_pct !== null && report.summary.connect_rate_pct < FAIL_CONNECT_PCT) {
    return `connect success ${report.summary.connect_rate_pct}% < ${FAIL_CONNECT_PCT}%`;
  }
  if (report.summary.pair_rate_pct !== null && report.summary.pair_rate_pct < FAIL_PAIR_PCT) {
    return `pairing success ${report.summary.pair_rate_pct}% < ${FAIL_PAIR_PCT}%`;
  }
  const attempts = report.summary.utterances_attempted || 1;
  const errorRatePct = (report.summary.error_count / attempts) * 100;
  if (errorRatePct > FAIL_ERROR_RATE_PCT) {
    return `client-side error rate ${errorRatePct.toFixed(1)}% > ${FAIL_ERROR_RATE_PCT}% (${report.summary.error_count} errors / ${attempts} attempts)`;
  }
  return null;
}

function renderTable(rows) {
  const cols = [
    ['clients', (r) => r.report.config.clients],
    ['connect%', (r) => r.report.summary.connect_rate_pct],
    ['pair%', (r) => r.report.summary.pair_rate_pct],
    ['start p50', (r) => r.report.latency.audio_start.p50_ms],
    ['start p95', (r) => r.report.latency.audio_start.p95_ms],
    ['start p99', (r) => r.report.latency.audio_start.p99_ms],
    ['hb p95', (r) => r.report.latency.heartbeat.p95_ms],
    ['errors', (r) => r.report.summary.error_count],
    ['cpu% max', (r) => r.report.server_process.cpu_percent.max],
    ['rss MB max', (r) => r.report.server_process.rss_mb.max],
    ['verdict', (r) => (r.stoppedHere ? `STOPPED: ${r.reason}` : 'ok')],
  ];
  const widths = cols.map(([name], i) => Math.max(name.length, ...rows.map((r) => String(cols[i][1](r) ?? 'n/a').length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  const lines = [line(cols.map(([n]) => n))];
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(line(cols.map(([, fn]) => fn(r) ?? 'n/a')));
  return lines.join('\n');
}

export async function runBaseline(args, { log = console.log } = {}) {
  const rows = [];
  for (const clients of args.steps) {
    log(`\n[baseline] === step: ${clients} clients ===`);
    const report = await runLoadTest({
      clients,
      minutes: args.minutes,
      ramp: args.ramp,
      host: null,
      port: null,
      engine: args.engine,
      utteranceMs: args.utteranceMs,
      gapMs: args.gapMs,
      heartbeatMs: args.heartbeatMs,
      sampleIntervalMs: args.sampleIntervalMs,
      allowNonLoopback: false,
      label: `baseline-${args.engine}`,
    }, { log });
    const reason = failureReason(report);
    rows.push({ report, stoppedHere: !!reason, reason });
    if (reason) {
      log(`[baseline] stopping ramp at ${clients} clients — ${reason}`);
      break;
    }
  }

  const table = renderTable(rows);
  log(`\n${table}\n`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const slug = `baseline-${args.engine}-${Date.now()}`;
  const jsonPath = path.join(RESULTS_DIR, `${slug}.json`);
  const txtPath = path.join(RESULTS_DIR, `${slug}.txt`);
  writeFileSync(jsonPath, JSON.stringify({ args, rows: rows.map((r) => ({ ...r, report: r.report })) }, null, 2));
  // Same reason as lib/report.mjs's footer: the machine is READ from the run,
  // never asserted by the template. This file's own README documents running
  // this exact ramp on the VPS, so a hard-coded "not the production VPS" line
  // was a sentence guaranteed to eventually be false in the one output an
  // operator would paste into a report.
  const where = rows[0]?.report?.host_machine;
  writeFileSync(txtPath, `NR-5 S0a baseline ramp — engine='${args.engine}'\n\n${table}\n\n`
    + `MEASURED ON: ${where ? `${where.hostname} (${where.platform}/${where.arch}, ${where.cpus} vCPU, ${where.total_mem_mb} MB RAM, node ${where.node_version})` : 'unrecorded host'}\n`
    + 'Compare only against runs whose machine line you have also read. See README.md.\n');
  log(`[baseline] wrote ${jsonPath}`);
  log(`[baseline] wrote ${txtPath}`);
  return rows;
}

async function main(argv) {
  const args = parseBaselineArgs(argv);
  await runBaseline(args);
}

const invokedDirectly = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => { console.error(`✗ ${e.stack ?? e}`); process.exit(1); });
}
