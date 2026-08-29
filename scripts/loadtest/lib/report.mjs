// scripts/loadtest/lib/report.mjs — writes one JSON + one human-readable
// summary per run into scripts/loadtest/results/ (gitignored — these are
// machine-specific measurements, not something to check in).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOADTEST_ROOT } from './local-server.mjs';

export const RESULTS_DIR = path.join(LOADTEST_ROOT, 'results');

function pad2(n) { return String(n).padStart(2, '0'); }

function timestampSlug(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** `report` is the fully-assembled plain object this tool measured. Returns
 *  the two file paths written. */
export function writeReport(report, { label } = {}) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const slug = `${timestampSlug()}-c${report.config.clients}${label ? `-${label}` : ''}`;
  const jsonPath = path.join(RESULTS_DIR, `run-${slug}.json`);
  const txtPath = path.join(RESULTS_DIR, `run-${slug}.txt`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(txtPath, renderSummary(report));
  return { jsonPath, txtPath };
}

function fmt(v, unit = '') {
  if (v === null || v === undefined) return 'n/a';
  return `${v}${unit}`;
}

export function renderSummary(r) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  push(`FlowMic NR-5 S0a load-test run — ${r.started_at}`);
  push('='.repeat(72));
  push(`target:            ${r.target.url}  (${r.target.spawned ? 'spawned locally' : 'pre-existing instance'})`);
  if (r.host_machine) {
    push(`measured on:       ${r.host_machine.hostname}  (${r.host_machine.platform}/${r.host_machine.arch}, `
      + `${r.host_machine.cpus} vCPU, ${r.host_machine.total_mem_mb} MB RAM, node ${r.host_machine.node_version})`);
  }
  push(`clients:           ${r.config.clients}   ramp: ${r.config.ramp}s   minutes: ${r.config.minutes}`);
  push(`engine mode:       ${r.config.engine}`);
  push(`utterance/gap:     ${r.config.utteranceMs}ms / ${r.config.gapMs}ms`);
  push(`wall duration:     ${r.duration_ms}ms`);
  push('');
  push('-- connection / pairing --------------------------------------------');
  push(`connect success:   ${fmt(r.summary.connect_rate_pct, '%')}  (${r.summary.connect_ok}/${r.config.clients})`);
  push(`pairing success:   ${fmt(r.summary.pair_rate_pct, '%')}  (${r.summary.pair_ok}/${r.config.clients})`);
  if (r.config.engine === 'off') {
    push(`engine-off applied: ${fmt(r.summary.engine_off_rate_pct, '%')}  (${r.summary.engine_off_ok}/${r.summary.pair_ok})`);
  }
  push('');
  push('-- utterance loop ---------------------------------------------------');
  push(`utterances attempted / completed: ${r.summary.utterances_attempted} / ${r.summary.utterances_completed}`);
  push(`audio:start refused (acked error): ${r.summary.stt_errors_acked}`);
  if (r.config.engine === 'off') {
    push('  (engine=off means audio:start is EXPECTED to be refused every time —');
    push('   "completed"=0 here is correct, not a failure. Chunks still stream and');
    push('   audio:stop still round-trips for every attempt: see audio:stop ack row');
    push('   below for that count. See README "engine modes".)');
  }
  if (r.config.engine !== 'off') {
    push(`stt:final / stt:error(terminal):   ${r.summary.stt_finals} / ${r.summary.stt_errors_terminal}`);
    push(`terminal-frame timeouts:           ${r.summary.terminal_frame_timeouts}`);
  }
  push('');
  push('-- latency (ms) ------------------------------------------------------');
  const row = (name, s) => push(
    `${name.padEnd(18)} n=${String(s.count).padEnd(6)} p50=${fmt(s.p50_ms).padEnd(7)} p95=${fmt(s.p95_ms).padEnd(7)} p99=${fmt(s.p99_ms).padEnd(7)} max=${fmt(s.max_ms)}`,
  );
  row('audio:start ack', r.latency.audio_start);
  row('audio:stop ack', r.latency.audio_stop);
  row('heartbeat ack', r.latency.heartbeat);
  push('');
  push(`-- server process (measured on ${r.host_machine ? r.host_machine.hostname : 'unrecorded host'}) ---------`);
  push(`CPU% (of one core): max=${fmt(r.server_process.cpu_percent.max)}  p95=${fmt(r.server_process.cpu_percent.p95)}  mean=${fmt(r.server_process.cpu_percent.mean)}`);
  push(`RSS (MB):           max=${fmt(r.server_process.rss_mb.max)}  mean=${fmt(r.server_process.rss_mb.mean)}`);
  push(`(sampled every ${r.server_process.interval_ms}ms via ${fmt(r.server_process.backend)}`
    + `${r.server_process.clk_tck_source ? ` [CLK_TCK ${r.server_process.clk_tck_source}]` : ''}`
    + `, ${r.server_process.sample_count} sample(s), ${r.server_process.skipped_count} skipped)`);
  if (r.server_process.sample_count === 0 && r.target.spawned) {
    // Naming the difference between "nothing to report" and "could not look" —
    // see lib/process-sampler.mjs's header on why a silent n/a is the dangerous
    // one of the two.
    push('⚠️ ZERO samples: the sampler could not read this process at all on this');
    push('   platform. The CPU/RSS rows above are "not measured", NOT "measured low".');
  }
  push('');
  push('-- client-side errors -------------------------------------------------');
  push(`total error events: ${r.summary.error_count}`);
  for (const [stage, count] of Object.entries(r.summary.errors_by_stage)) push(`  ${stage.padEnd(16)} ${count}`);
  if (r.summary.sample_errors.length) {
    push('  sample messages (first 10):');
    for (const e of r.summary.sample_errors.slice(0, 10)) push(`    [${e.stage}] ${e.message}`);
  }
  push('');
  push(`NUMBERS FROM: ${r.host_machine ? r.host_machine.hostname : 'an unrecorded host'}`
    + `${r.host_machine ? ` (${r.host_machine.cpus} vCPU / ${r.host_machine.total_mem_mb} MB)` : ''}.`);
  push('A load-test number only means anything alongside the machine that produced');
  push('it — read the "measured on" line above before comparing this to any other');
  push('run. See scripts/loadtest/README.md.');
  return lines.join('\n') + '\n';
}
