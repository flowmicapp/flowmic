// scripts/loadtest/run.mjs — NR-5 S0a load-test harness, single run.
//
// docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §5
// (NR-5) + docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 7:
// "S0a presses the LOCAL relay's own concurrency ceiling, without touching any
// upstream STT/LLM vendor, and never against production." This file is that:
// it boots a real @flowmic/server-core standalone instance (loopback only, see
// lib/target-guard.mjs) and drives it with N simulated phone+PC pairs talking
// the real socket.io wire protocol (packages/protocol), the way a real Android
// app and a real Windows/macOS app would.
//
// Read scripts/loadtest/README.md before trusting a number this prints — in
// particular the "engine modes" section, which is the honest answer to "does
// this actually exercise decode/VAD or not".
//
// Usage: node scripts/loadtest/run.mjs --clients 50 --minutes 2 --ramp 10
//        node scripts/loadtest/run.mjs --help

import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { parseArgs, USAGE } from './lib/cli-args.mjs';
import { assertTargetAllowed, isLoopbackHost } from './lib/target-guard.mjs';
import { ensureServerBuilt, spawnLocalServer, stopLocalServer } from './lib/local-server.mjs';
import { createProcessSampler } from './lib/process-sampler.mjs';
import { runPhoneClient } from './lib/phone-client.mjs';
import { summarizeLatencies, rate } from './lib/metrics.mjs';
import { writeReport } from './lib/report.mjs';

/** The one function baseline.mjs also calls, so the ramp orchestrator and the
 *  single-run CLI share EXACTLY one "how to run N clients against one server"
 *  implementation — this repo's own header convention against a second copy
 *  of a wire/boot helper drifting from the first. */
export async function runLoadTest(config, { log = console.log } = {}) {
  const host = config.host ?? '127.0.0.1';
  assertTargetAllowed(host, { allowNonLoopback: config.allowNonLoopback });

  const runId = randomBytes(4).toString('hex');
  let server = null;
  let url;
  let spawned = false;
  let serverPid = null;

  if (config.host === null) {
    await ensureServerBuilt({ log });
    log(`[loadtest ${runId}] spawning local server-core (standalone, loopback) …`);
    server = await spawnLocalServer(config.port ? { FLOWMIC_PORT: String(config.port) } : {});
    url = server.url;
    spawned = true;
    serverPid = server.child.pid;
    log(`[loadtest ${runId}] server up: ${url} (pid ${serverPid})`);
  } else {
    url = `http://${config.host}:${config.port}`;
    log(`[loadtest ${runId}] connecting to pre-existing instance: ${url} (NOT spawned by this tool — process CPU/RSS cannot be sampled without a local pid)`);
  }

  const sampler = serverPid ? createProcessSampler(serverPid, { intervalMs: config.sampleIntervalMs }) : null;
  if (sampler) sampler.start();

  const startedAt = new Date();
  const rampMs = config.ramp * 1000;
  const minutesMs = config.minutes * 60_000;
  const testStartMs = Date.now();
  const endAtMs = testStartMs + rampMs + minutesMs;

  log(`[loadtest ${runId}] ${config.clients} client(s), ramp ${config.ramp}s, steady-state ${config.minutes}min, engine='${config.engine}' …`);

  const clientPromises = [];
  for (let i = 0; i < config.clients; i++) {
    const startDelayMs = config.clients > 1 ? Math.floor((i / config.clients) * rampMs) : 0;
    clientPromises.push(runPhoneClient({
      url, index: i, runId,
      engineMode: config.engine,
      utteranceMs: config.utteranceMs,
      gapMs: config.gapMs,
      heartbeatMs: config.heartbeatMs,
      startDelayMs,
      endAtMs,
    }));
  }
  const results = await Promise.all(clientPromises);

  if (sampler) sampler.stop();
  if (spawned) stopLocalServer(server);

  const durationMs = Date.now() - testStartMs;

  // ── aggregate ────────────────────────────────────────────────────────────
  const connectOk = results.filter((r) => r.connect_ok).length;
  const pairOk = results.filter((r) => r.pair_ok).length;
  const engineOffOk = results.filter((r) => r.engine_off_ok === true).length;
  const utterancesAttempted = results.reduce((n, r) => n + r.utterances_attempted, 0);
  const utterancesCompleted = results.reduce((n, r) => n + r.utterances_completed, 0);
  const sttFinals = results.reduce((n, r) => n + r.stt_finals, 0);
  const sttErrorsAcked = results.reduce((n, r) => n + r.stt_errors_acked, 0);
  const sttErrorsTerminal = results.reduce((n, r) => n + r.stt_errors_terminal, 0);
  const terminalTimeouts = results.reduce((n, r) => n + r.terminal_frame_timeouts, 0);

  const errorsByStage = {};
  const sampleErrors = [];
  for (const r of results) {
    for (const e of r.errors) {
      errorsByStage[e.stage] = (errorsByStage[e.stage] ?? 0) + 1;
      if (sampleErrors.length < 50) sampleErrors.push(e);
    }
  }
  const errorCount = Object.values(errorsByStage).reduce((a, b) => a + b, 0);

  const latency = {
    audio_start: summarizeLatencies(results.flatMap((r) => r.audio_start_latencies_ms)),
    audio_stop: summarizeLatencies(results.flatMap((r) => r.audio_stop_latencies_ms)),
    heartbeat: summarizeLatencies(results.flatMap((r) => r.heartbeat_latencies_ms)),
  };

  const report = {
    started_at: startedAt.toISOString(),
    duration_ms: durationMs,
    run_id: runId,
    // 🔴 WHICH MACHINE PRODUCED THIS NUMBER, recorded by the run itself.
    // Before this existed, every report ended with a hard-coded paragraph
    // asserting "this ran on the operator's workstation, NOT the production
    // VPS" — a sentence that was true when it was written and becomes a LIE
    // the first time someone follows this file's own README section on running
    // S0a on the VPS. A claim about the environment has to be MEASURED like
    // any other, not typed once into a template (CLAUDE.md's standing
    // anti-façade rule ④, and its "environment facts must name the machine"
    // corollary). The renderer now reads these fields instead of asserting.
    host_machine: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      total_mem_mb: Math.round(os.totalmem() / (1024 * 1024)),
      node_version: process.version,
      load_avg_1m: os.loadavg()[0],
    },
    target: { url, spawned, host, loopback: isLoopbackHost(host) },
    config: {
      clients: config.clients, minutes: config.minutes, ramp: config.ramp,
      engine: config.engine, utteranceMs: config.utteranceMs, gapMs: config.gapMs,
      heartbeatMs: config.heartbeatMs,
    },
    summary: {
      connect_ok: connectOk, connect_rate_pct: rate(connectOk, config.clients),
      pair_ok: pairOk, pair_rate_pct: rate(pairOk, config.clients),
      engine_off_ok: engineOffOk, engine_off_rate_pct: config.engine === 'off' ? rate(engineOffOk, pairOk) : null,
      utterances_attempted: utterancesAttempted, utterances_completed: utterancesCompleted,
      stt_finals: sttFinals, stt_errors_acked: sttErrorsAcked, stt_errors_terminal: sttErrorsTerminal,
      terminal_frame_timeouts: terminalTimeouts,
      error_count: errorCount, errors_by_stage: errorsByStage, sample_errors: sampleErrors,
    },
    latency,
    server_process: sampler ? sampler.summary() : {
      interval_ms: null, backend: 'none', clk_tck_source: null, sample_count: 0, skipped_count: 0,
      cpu_percent: { max: null, p95: null, mean: null }, rss_mb: { max: null, mean: null },
      note: 'no local pid to sample (pointed at a pre-existing instance)',
    },
    per_client: results,
  };

  const { jsonPath, txtPath } = writeReport(report, { label: config.label });
  log(`[loadtest ${runId}] wrote ${jsonPath}`);
  log(`[loadtest ${runId}] wrote ${txtPath}`);
  return report;
}

async function main(argv) {
  let config;
  try {
    config = parseArgs(argv);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  if (config.help) { console.log(USAGE); return; }
  const report = await runLoadTest(config);
  console.log('');
  console.log(`connect=${report.summary.connect_rate_pct}%  pair=${report.summary.pair_rate_pct}%  `
    + `utterances=${report.summary.utterances_completed}/${report.summary.utterances_attempted}  `
    + `errors=${report.summary.error_count}  audio:start p95=${report.latency.audio_start.p95_ms}ms`);
}

const invokedDirectly = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((e) => { console.error(`✗ ${e.stack ?? e}`); process.exit(1); });
}
