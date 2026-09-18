#!/usr/bin/env node
// verify/run-delivery-fast.mjs — the LANE GATE.
//
// Runs the same checks `pnpm verify:delivery` runs, with the same commands, as
// six concurrent OS processes instead of seventeen sequential ones.
//
// THIS IS NOT THE RELEASE GATE, AND THE DIFFERENCE IS NOT COSMETIC.
// ---------------------------------------------------------------------------
// `pnpm verify:delivery` is untouched, and this runner writes NO receipt and
// does not even call `verify:preflight` — see the Stage 0 note below, where the
// reason is measured rather than stylistic.
//
// 🔴 A RELEASE MAY NOW STAND ON A PARALLEL RUN — BUT NOT ON THIS ONE.
// Since 2026-09-17 (SC-6) there is a second gate that a release may cite:
// `pnpm verify:delivery:release` (verify/run-delivery-release.mjs). It imports
// STAGE0 and LANES FROM THIS FILE — the same table, the same commands, and a
// drill asserts the two plans are byte-identical — and adds the two things this
// runner deliberately lacks: the `--begin`/`--end` receipt, and a refusal to
// start on a dirty tree or beside leftover test processes. What separates them
// is therefore not speed and not parallelism; it is that one of them can say
// WHICH tree it proved and refuses to run where that answer would be unstable.
// This runner keeps `--only`, keeps writing no receipt, and stays the gate of
// the edit/verify loop.
//
// WHAT IT BUYS, MEASURED ON dev-pc-a (Ryzen 9 7945HX, 16C/32T):
// seventeen sequential stages = 961 s
// (docs/strategy/2026-09-12-verify-delivery-speedup-plan.md §1.2, read off the
// one clean EXIT=0 log `.local/build-0382/verify3.log`, START 22:13:21 ->
// DONE 22:29:22). The lane wall clock is whatever the slowest lane is, and the
// slowest lane is MOBILE (~267 s) — which nothing here makes faster. So the
// ceiling on this whole change is "as fast as `flutter test`", and every
// second saved elsewhere is only saved until it reaches that wall.
//
// WHAT IT DOES NOT BUY: any confidence the sequential gate does not already
// give. The same scripts run with the same arguments. If a lane is green here
// and red there, that is a concurrency hazard in THIS file, not a product
// fact — the known ones are named next, each with its handling. No count here:
// hazard 5 was added the day it was measured, and the list above it is what
// answers "how many".
//
// CROSS-LANE HAZARDS (all checked in the tree on 2026-09-12, not assumed):
//
//  1. GOLDEN REBUILDS `packages/protocol/dist`, AND TSC + VITEST READ IT.
//     run-golden.mjs builds protocol and server-core every run, on purpose —
//     its own header records both a false red and a false green caused by a
//     stale dist. Meanwhile `tsc --noEmit` resolves `@flowmic/protocol` to
//     `packages/protocol/dist/index.d.ts` (CLAUDE.md 2026-08-07: there are no
//     path mappings anywhere; tsc type-checks the dist too) and every vitest
//     project imports the same files. tsup deletes and rewrites them, so an
//     overlap is a red with no product meaning.
//     HANDLED: Stage 0 is a hard barrier that builds protocol once, and only
//     the GOLDEN lane carries FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT=1, which
//     makes golden skip ONLY the protocol half. server-core's dist is still
//     rebuilt inside golden, where no other lane reads it.
//
//  2. PORT COLLISIONS BETWEEN GOLDEN'S SERVERS AND THE server-core TESTS.
//     Checked, not assumed: golden's harness spawns with `FLOWMIC_PORT: '0'`
//     (verify/golden/harness.mjs, startServer), and every real bind under
//     apps/server-core/test is `listen(0, ...)`. The `41879` that greps up in
//     those tests is a config VALUE handed to the router, never a bind. Both
//     sides are ephemeral, so there is nothing to serialise. If a fixed port
//     ever appears on either side, GOLDEN and VITEST must become one lane.
//
//  3. FLUTTER TESTS INTERFERING WITH OTHER TREES (shared paths/ports).
//     HANDLED by changing nothing: MOBILE is one lane running
//     `verify:mobile-tests` exactly as it runs today — one `flutter test`, no
//     shards, no second Dart VM. It runs concurrently with the node lanes,
//     which is a different claim from running concurrently with itself.
//     Sharding is a separate and so far unmeasured idea (plan 3.2 / 4(d)) and
//     is deliberately not done here.
//
//  4. THE SCRIPTS POOL now starts several node children at once. Its own
//     header states what makes that safe (every child mkdtemps its own state).
//     Here it also shares the machine with five other lanes, so this runner
//     turns its concurrency down instead of letting it take half the box.
//
//  5. LANES THAT ASSERT ON TIME CAN LOSE TO A LANE THAT EATS THE CPU.
//     This one was not predicted; it was measured here on 2026-09-12, and it
//     is the only hazard on this list that produces a RED rather than a
//     crash. A cold `cargo` build takes every core it is given (default
//     `-j 32` on this box). In the run where the RUST lane did a full cold
//     compile, GOLDEN went red on `G13 … inject:result timeout` and
//     `apps/mobile/test/pending_recovery_actions_test.dart` went red on a
//     10 ms head start it gives a delete over an in-flight attempt — BOTH
//     green on their own, both green in the next run. Nothing about the
//     product changed between those runs; the machine did.
//     HANDLED, PARTLY: the RUST lane is capped with CARGO_BUILD_JOBS so it
//     leaves the box room to answer a socket. That lowers the odds; it does
//     not make an assertion that races a wall clock safe.
//     🔴 SO: A RED LANE HERE IS NOT A VERDICT ABOUT THE PRODUCT UNTIL IT
//     REPRODUCES ON ITS OWN — re-run `--only=<LANE>`, or the sequential gate.
//     The runner says this in its own failure output rather than trusting
//     anyone to remember it. The real fix for those two tests is to make
//     them wait on an event instead of a duration (CLAUDE.md records the
//     same shape as CE-6b: 「两个写死的时间常数互相赛跑」), which is a
//     separate card and deliberately not done here.
//
// Usage:
//   pnpm verify:delivery:fast
//   pnpm verify:delivery:fast --dry-run      # print the plan, execute nothing
//   pnpm verify:delivery:fast --only=RUST,TSC
//
// Per-lane output goes to `.local/gate-fast/<LANE>.log`: six lanes writing into
// one terminal is six lanes nobody can read.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
export const LOG_DIR = path.join(ROOT, '.local', 'gate-fast');

/** 🔴 THE LANE RECEIPT — AND IT IS NOT THE GATE RECEIPT.
 *
 *  `.local/gate-receipt.json` is a PROOF: scripts/publish.mjs may stand on it
 *  instead of re-running the sequential gate, and this runner is forbidden from
 *  writing or deleting it (see the header). This file answers one much smaller
 *  question, and it is a question about SCOPE, never about proof:
 *
 *      "when `pnpm verify:lane` runs on `main`, which commit should it diff
 *       from?" — i.e. the last commit on which THIS machine ran the FULL set
 *       and got green (design 2026-09-13 §3.1).
 *
 *  Nothing may ever read it as "this stage need not run". It is deliberately a
 *  separate path with a separate name so that a future reader grepping for
 *  gate-receipt does not find it and assume the two are related. */
export const LANE_RECEIPT_DIR = path.join(ROOT, '.local', 'lane-gate');
export const LANE_RECEIPT_PATH = path.join(LANE_RECEIPT_DIR, 'last-green.json');

/**
 * Record that the FULL set was green at this tree state.
 *
 * Two guards, both about not overstating what happened:
 *   · the caller only calls this when no `--only` filter was in play, so a
 *     `--only=TSC` green can never become a baseline for skipping GOLDEN;
 *   · the fingerprint is taken AFTER the run, and if it cannot be taken the
 *     receipt is simply not written. A baseline nobody can verify is worse than
 *     no baseline, because the lane gate's fallback for "no baseline" is to run
 *     everything.
 *
 * The `import()` is dynamic on purpose: scripts/gate-fast-runner.test.mjs
 * asserts this file has no top-level `import … gate-receipt` line, because a
 * runner that reaches for that module is one edit away from calling `begin()`
 * and unlinking a standing release proof. Only the two PURE readers are used
 * here — `fingerprint()` and `toolStamp()` compute and return; neither writes.
 */
export async function writeLaneReceipt({ tier = 'T2', now = Date.now() } = {}) {
  const { fingerprint, toolStamp } = await import('../scripts/gate-receipt.mjs');
  const fp = fingerprint(ROOT);
  if (fp == null) return null;
  const receipt = { tier, sha: fp.sha, digest: fp.digest, tools: toolStamp(), finishedAt: now };
  mkdirSync(LANE_RECEIPT_DIR, { recursive: true });
  writeFileSync(LANE_RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

const CORES =
  (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) || 4;

// Six lanes already compete for the machine; the scripts pool must not also
// claim half of it. 4 is a share, not a measurement — raise it only with a
// measurement written down beside it.
const SCRIPTS_CONCURRENCY = String(Math.max(2, Math.min(4, Math.floor(CORES / 4))));

// Cargo's default is one job per logical core, i.e. the whole machine. A cold
// compile then starves the lanes that assert on time — hazard 5 above, and it
// was measured, not feared. A quarter of the box keeps the cold build moving
// without taking the oxygen; a warm cargo run (the normal case) barely
// notices, because it has almost nothing left to compile.
const CARGO_JOBS = String(Math.max(2, Math.floor(CORES / 4)));

const pnpm = (...args) => ({ cmd: 'pnpm', args });

// -- STAGE 0: the barrier. Everything in Stage 1 depends on it. --------------
//
// `node scripts/preflight-toolchain.mjs` AND NOT `pnpm verify:preflight`,
// which is that same script PLUS `node scripts/gate-receipt.mjs --begin`.
// MEASURED, not stylistic: gate-receipt.mjs's `begin()` UNLINKS any existing
// `.local/gate-receipt.json` as its very first act — deliberately, so a stale
// proof cannot survive the start of a new run. Calling `verify:preflight` from
// here would therefore make running the LANE gate DESTROY the RELEASE gate's
// proof, and the next `node scripts/publish.mjs` would silently re-run the
// whole sequential gate. This runner must leave the receipt alone in both
// directions: it may not write one, and it may not delete one.
export const STAGE0 = [
  {
    name: 'preflight',
    cmd: process.execPath,
    args: [path.join('scripts', 'preflight-toolchain.mjs')],
  },
  { name: 'protocol-dist', ...pnpm('verify:protocol-dist') },
];

// -- STAGE 1: six lanes, concurrent. Steps inside a lane stay sequential. ----
export const LANES = [
  {
    name: 'RUST',
    why: 'all three cargo commands share apps/desktop/src-tauri/target; concurrent cargo invocations fight over one build lock',
    // verify:sidecar-resources gets no row of its own: `verify:clippy` and
    // `verify:rust-tests` each already begin with it (see package.json), so a
    // row here would run the same read-only check a third time.
    steps: [
      { ...pnpm('verify:clippy'), env: { CARGO_BUILD_JOBS: CARGO_JOBS } },
      { ...pnpm('verify:rust-tests'), env: { CARGO_BUILD_JOBS: CARGO_JOBS } },
      { ...pnpm('verify:doctests'), env: { CARGO_BUILD_JOBS: CARGO_JOBS } },
    ],
  },
  {
    name: 'TSC',
    why: 'static analysis; nothing here writes, so it can read the dist Stage 0 just built',
    // verify:lint rides this lane rather than getting a seventh of its own:
    // since the worker-thread change it is ~6 s, and a lane for it would add
    // process churn for a stage that finishes before the shortest real lane.
    steps: [pnpm('verify:lint'), pnpm('verify:types'), pnpm('verify:types:desktop')],
  },
  {
    name: 'VITEST',
    why: 'five vitest projects; each already spawns its own workers, so stacking them would oversubscribe the box',
    steps: [
      pnpm('verify:protocol-tests'),
      pnpm('verify:i18n-web-tests'),
      pnpm('verify:server-tests'),
      pnpm('verify:desktop-tests'),
    ],
  },
  {
    name: 'SCRIPTS',
    why: 'the release-tooling drills; internally pooled — see scripts/run-script-tests.mjs',
    steps: [
      { ...pnpm('verify:scripts'), env: { FLOWMIC_SCRIPT_TEST_CONCURRENCY: SCRIPTS_CONCURRENCY } },
    ],
  },
  {
    name: 'GOLDEN',
    why: 'one shared server plus 13 self-starting scenarios, two of which wait on real wall-clock windows (measured 2026-09-13, not estimated: G32 61.4 s, G28 39.3 s — the header said "G28 ~30 s", which was the product constant it waits on and not what the case costs)',
    // 🔴 WHY 3 AND NOT THE 6 `pnpm golden` DEFAULTS TO (card L3, measured).
    // Golden's floor is not the pool — it is ONE case: G32 spends 61.4 s on a
    // product constant (integer-minute plan limits) and no number of workers
    // shortens it. The shared-server chain is 61.0 s beside it. Three workers
    // (G32 ‖ chain ‖ one more) already reach that floor: 4 and 6 measure the
    // same wall clock and only take more of the box.
    // AND THIS LANE IS NOT THE ONE THAT DECIDES WHEN THE GATE ENDS — MOBILE is
    // (~267 s). So the right share for GOLDEN is the SMALLEST one that keeps it
    // far under that ceiling, which is exactly hazard 5's lesson pointed at
    // this lane: every core golden takes is a core the lanes that assert on
    // time do not have. G13 — hazard 5's named victim — is inside the
    // sequential chain, so the pool never runs a second case against the server
    // G13 is talking to; what the pool adds beside it is at most two more node
    // servers, and every wait G13 makes is now a 30 s LIVENESS_CEILING_MS
    // (harness.mjs) rather than the 3 s race window that lost in September.
    steps: [{
      ...pnpm('golden'),
      env: { FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT: '1', FLOWMIC_GOLDEN_CONCURRENCY: '3' },
    }],
  },
  {
    name: 'MOBILE',
    why: 'a single flutter test run, unchanged and unsharded — the lane that sets the floor',
    steps: [pnpm('verify:mobile-tests')],
  },
];

/** Commands this runner must never contain. The gate receipt has exactly one
 *  writer and it is the last link of the sequential chain; `--begin` deletes a
 *  standing receipt, so the preflight wrapper is forbidden here too. */
export const FORBIDDEN_IN_PLAN = ['verify:receipt', 'verify:preflight', 'gate-receipt'];

/** Every command string this runner would execute, flattened. */
export function planCommands(stage0 = STAGE0, lanes = LANES) {
  const out = [];
  for (const t of stage0) out.push(`${t.cmd} ${t.args.join(' ')}`);
  for (const lane of lanes) for (const s of lane.steps) out.push(`${s.cmd} ${s.args.join(' ')}`);
  return out;
}

function spawnStep(step, { logStream = null, label = '' } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(step.cmd, step.args, {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env: { ...process.env, ...(step.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sink = (d) => {
      if (logStream) logStream.write(d);
    };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    child.on('error', (e) => {
      if (logStream) logStream.write(`\n[lane-gate] spawn failed for ${label}: ${e.message}\n`);
      resolve({ code: 1, ms: Date.now() - started });
    });
    child.on('close', (code) => resolve({ code: code ?? 1, ms: Date.now() - started }));
  });
}

/**
 * Run `lanes` concurrently. Steps inside a lane run in order, and the lane
 * STOPS at the first non-zero step: running the rest would spend minutes
 * producing output nobody will read past the first failure.
 *
 * Exported so the exit-code aggregation can be drilled without a four-minute
 * gate run — scripts/gate-fast-runner.test.mjs drives it with synthetic lanes.
 */
export async function runLanes(lanes, { logDir = LOG_DIR, onStart = null, onDone = null } = {}) {
  mkdirSync(logDir, { recursive: true });
  const results = await Promise.all(
    lanes.map(async (lane) => {
      const logPath = path.join(logDir, `${lane.name}.log`);
      const logStream = createWriteStream(logPath);
      const started = Date.now();
      if (onStart) onStart(lane);
      let code = 0;
      let failedStep = null;
      let ran = 0;
      for (const step of lane.steps) {
        const label = `${step.cmd} ${step.args.join(' ')}`;
        logStream.write(`\n-- ${label} ------------------------------------------\n`);
        ran += 1;
        const r = await spawnStep(step, { logStream, label });
        if (r.code !== 0) {
          code = r.code;
          failedStep = label;
          logStream.write(`\n[lane-gate] ${lane.name}: STOPPED - \`${label}\` exited ${r.code}\n`);
          break;
        }
      }
      const ms = Date.now() - started;
      await new Promise((r) => logStream.end(r));
      const result = { lane: lane.name, code, ms, ran, failedStep, logPath };
      if (onDone) onDone(result);
      return result;
    })
  );
  const failed = results.filter((r) => r.code !== 0);
  return { results, failed, exitCode: failed.length === 0 ? 0 : 1 };
}

/** Exported for verify/run-delivery-release.mjs (SC-6), which prints the same
 *  lane table. Two copies of a formatter is two tables that can stop looking
 *  alike, and these two are read side by side. */
export const mmss = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function banner() {
  process.stdout.write(
    '\n' +
      '========================================================================\n' +
      '  LANE GATE - parallel. THIS IS NOT THE RELEASE GATE.\n' +
      '  The release gate is `pnpm verify:delivery` (sequential). That is what\n' +
      '  scripts/publish.mjs runs, and the only run that writes a gate receipt.\n' +
      '  This runner writes no receipt and deletes none. Same checks, same\n' +
      '  commands, six concurrent lanes - for the edit/verify loop.\n' +
      '========================================================================\n\n'
  );
}

/** Exported for the same reason as `mmss`. */
export function tailOf(file, lines = 40) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

export async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const only = onlyArg
    ? new Set(
        onlyArg
          .slice('--only='.length)
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      )
    : null;
  const lanes = only ? LANES.filter((l) => only.has(l.name)) : LANES;

  banner();
  process.stdout.write(`  machine: ${CORES} logical cores - scripts pool ${SCRIPTS_CONCURRENCY}\n`);
  process.stdout.write(`  logs:    ${path.relative(ROOT, LOG_DIR)}${path.sep}<LANE>.log\n\n`);

  if (only && lanes.length !== only.size) {
    process.stdout.write(
      `x --only named a lane that does not exist. Lanes: ${LANES.map((l) => l.name).join(', ')}\n`
    );
    return 1;
  }

  if (dryRun) {
    process.stdout.write('STAGE 0 (barrier)\n');
    for (const t of STAGE0) process.stdout.write(`  - ${t.name}: ${t.cmd} ${t.args.join(' ')}\n`);
    process.stdout.write('\nSTAGE 1 (concurrent lanes)\n');
    for (const lane of lanes) {
      process.stdout.write(`  - ${lane.name} - ${lane.why}\n`);
      for (const s of lane.steps) {
        const env = s.env
          ? ` [${Object.entries(s.env)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')}]`
          : '';
        process.stdout.write(`      ${s.cmd} ${s.args.join(' ')}${env}\n`);
      }
    }
    process.stdout.write('\n(dry run - nothing was executed, no receipt touched)\n');
    return 0;
  }

  // -- Stage 0 ---------------------------------------------------------------
  mkdirSync(LOG_DIR, { recursive: true });
  const t0 = Date.now();
  process.stdout.write('STAGE 0  preflight || protocol-dist (barrier)\n');
  const stage0 = await Promise.all(
    STAGE0.map(async (task) => {
      const logPath = path.join(LOG_DIR, `stage0-${task.name}.log`);
      const logStream = createWriteStream(logPath);
      const r = await spawnStep(task, { logStream, label: task.name });
      await new Promise((res) => logStream.end(res));
      process.stdout.write(
        `  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${task.name.padEnd(14)} ${mmss(r.ms)}  exit ${r.code}\n`
      );
      return { ...task, ...r, logPath };
    })
  );
  const stage0Bad = stage0.filter((t) => t.code !== 0);
  if (stage0Bad.length > 0) {
    // No lane may start: each of them reads what Stage 0 was supposed to
    // produce, so their failures would all be about the barrier, not themselves.
    for (const t of stage0Bad) {
      process.stdout.write(
        `\n-- ${t.name} (last 40 lines of ${path.relative(ROOT, t.logPath)}) --\n`
      );
      process.stdout.write(`${tailOf(t.logPath)}\n`);
    }
    process.stdout.write('\nx STAGE 0 failed - no lane started. Nothing below was verified.\n');
    return 1;
  }

  // -- Stage 1 ---------------------------------------------------------------
  process.stdout.write(`\nSTAGE 1  ${lanes.length} lane(s), concurrent\n`);
  for (const l of lanes) process.stdout.write(`  > ${l.name} started (${l.steps.length} step(s))\n`);
  const { results, failed, exitCode } = await runLanes(lanes, {
    onDone: (r) =>
      process.stdout.write(
        `  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.lane.padEnd(8)} ${mmss(r.ms)}  exit ${r.code}` +
          `${r.failedStep ? `  <- \`${r.failedStep}\`` : ''}\n`
      ),
  });
  const wall = Date.now() - t0;

  // -- Summary ---------------------------------------------------------------
  process.stdout.write('\n  lane      |  wall  | exit | log\n');
  process.stdout.write('  ----------+--------+------+------------------------------\n');
  for (const lane of lanes) {
    const r = results.find((x) => x.lane === lane.name);
    process.stdout.write(
      `  ${r.lane.padEnd(10)}| ${mmss(r.ms).padStart(6)} | ${String(r.code).padStart(4)} | ${path.relative(ROOT, r.logPath)}\n`
    );
  }
  process.stdout.write(
    `\n  stage 0: ${mmss(Math.max(...stage0.map((t) => t.ms)))}    total wall: ${mmss(wall)}\n`
  );

  for (const r of failed) {
    process.stdout.write(`\n-- ${r.lane} (last 40 lines of ${path.relative(ROOT, r.logPath)}) --\n`);
    process.stdout.write(`${tailOf(r.logPath)}\n`);
  }

  // A green FULL set is the one thing that can move the lane gate's baseline on
  // `main`. `only` non-null means a subset ran, and a subset may never claim it.
  if (exitCode === 0 && !only) {
    const receipt = await writeLaneReceipt({ tier: 'T2' });
    process.stdout.write(
      receipt
        ? `\n  lane baseline recorded for ${receipt.sha.slice(0, 12)} (${path.relative(ROOT, LANE_RECEIPT_PATH)})\n` +
            '  It moves the diff base of `pnpm verify:lane` on main. It is NOT a gate receipt.\n'
        : '\n  lane baseline NOT recorded: the tree could not be fingerprinted.\n'
    );
  }

  process.stdout.write(
    exitCode === 0
      ? `\nok ${lanes.length}/${lanes.length} lane(s) green in ${mmss(wall)}.\n` +
          '   This is the LANE gate. A release still needs `pnpm verify:delivery`\n' +
          '   (sequential) - it is the only run that writes a gate receipt.\n'
      : `\nx ${failed.length}/${lanes.length} lane(s) red: ${failed.map((r) => r.lane).join(', ')}\n` +
          '   A red lane here is not yet a verdict about the product. Six lanes share\n' +
          '   one machine, and GOLDEN and MOBILE both contain assertions that race a\n' +
          '   wall clock (measured 2026-09-12: a cold cargo build made G13 time out and\n' +
          `   one mobile test lose a 10 ms head start; both green alone). Re-run it by\n` +
          `   itself before believing it:\n` +
          `     pnpm verify:delivery:fast --only=${failed.map((r) => r.lane).join(',')}\n`
  );
  return exitCode;
}

/** The two files this runner must never create, move, or remove. The drill
 *  snapshots them around a run; `main()` never touches either. */
export const RECEIPT_PATHS = [
  path.join(ROOT, '.local', 'gate-receipt.json'),
  path.join(ROOT, '.local', 'gate-receipt.pending.json'),
];
export const existingReceipts = () => RECEIPT_PATHS.filter((p) => existsSync(p));

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code));
}
