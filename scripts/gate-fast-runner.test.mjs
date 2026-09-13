#!/usr/bin/env node
// Drill for verify/run-delivery-fast.mjs — the parallel LANE gate.
//
// Two questions, and they are the two ways this runner could lie:
//
//   1. DOES A RED LANE MAKE THE RUN RED? Six lanes finish in whatever order
//      they finish, and each one's failure is discovered inside a
//      `Promise.all` branch that resolves normally. A runner that forgot to
//      aggregate would print a tidy table with `exit 1` in one row and still
//      hand the shell a 0 — the shape CLAUDE.md calls 「没有静默失败」's second
//      direction: not swallowing a failure, but reporting an unfinished thing
//      as done. So this drill drives a synthetic lane table, both ways: a red
//      lane must produce a non-zero aggregate, and the SAME table with the red
//      step made green must produce zero. Without that second direction the
//      first assertion also passes against a runner hard-coded to fail.
//
//   2. DOES IT LEAVE THE GATE RECEIPT ALONE? `.local/gate-receipt.json` is the
//      proof scripts/publish.mjs reuses instead of re-running the sequential
//      gate. Writing one here would let a parallel run be cited as a release
//      gate. DELETING one is the sharper hazard and the less obvious one:
//      gate-receipt.mjs's `begin()` unlinks the standing receipt as its first
//      act, so a fast runner that called `pnpm verify:preflight` (which is
//      preflight + `--begin`) would destroy a valid proof every time somebody
//      ran the quick gate. Both directions are checked here.
//
// EXIT CODES (scripts/run-script-tests.mjs): 0 PASS, 1 FAIL, 2 SKIP.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RUNNER = path.join(ROOT, 'verify', 'run-delivery-fast.mjs');

const mod = await import(pathToFileURL(RUNNER).href);
const { runLanes, planCommands, FORBIDDEN_IN_PLAN, LANES, STAGE0, RECEIPT_PATHS } = mod;

let failures = 0;
let checks = 0;
const check = (ok, what) => {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL ${what}`);
  }
};
const section = (t) => console.log(`\n${t}`);

// A throwaway directory per run: these drills are pooled now, and two copies
// of this file sharing a fixed path would fail each other intermittently.
const TMP = mkdtempSync(path.join(tmpdir(), 'gate-fast-drill-'));
const script = (name, body) => {
  const p = path.join(TMP, name);
  writeFileSync(p, body);
  return { cmd: process.execPath, args: [p] };
};
const GREEN = script('green.mjs', 'process.exit(0);\n');
const RED = script('red.mjs', 'process.stderr.write("synthetic failure\\n");process.exit(3);\n');

// ---------------------------------------------------------------------------
section('1 exit-code aggregation');

const laneTable = (middleStep) => [
  { name: 'A', steps: [GREEN, GREEN] },
  { name: 'B', steps: [middleStep, GREEN] },
  { name: 'C', steps: [GREEN] },
];

const red = await runLanes(laneTable(RED), { logDir: path.join(TMP, 'logs-red') });
check(red.exitCode !== 0, 'one red lane makes the aggregate exit code non-zero');
check(red.exitCode === 1, `the aggregate is exactly 1 (got ${red.exitCode})`);
check(red.failed.length === 1, `exactly one lane is reported red (got ${red.failed.length})`);
check(red.failed[0]?.lane === 'B', 'the red lane is named');
check(
  red.results.find((r) => r.lane === 'B')?.code === 3,
  "the lane keeps the child's own exit code, it is not flattened to 1",
);
check(
  red.results.find((r) => r.lane === 'B')?.ran === 1,
  'a red step stops its own lane — the step behind it is not run',
);
check(
  red.results.find((r) => r.lane === 'A')?.ran === 2,
  'a red lane does not stop a sibling lane; A still ran both of its steps',
);
check(
  typeof red.failed[0]?.failedStep === 'string' && red.failed[0].failedStep.length > 0,
  'the failing command is recorded by name, so the summary can point at it',
);
check(
  existsSync(red.results.find((r) => r.lane === 'B')?.logPath ?? ''),
  "the red lane's log file exists to be read",
);
check(
  readFileSync(red.results.find((r) => r.lane === 'B').logPath, 'utf8').includes('synthetic failure'),
  "the child's stderr reached the lane log",
);

// REVERSE CONTROL. Without it, every assertion above also passes against a
// runner that returns 1 unconditionally.
const green = await runLanes(laneTable(GREEN), { logDir: path.join(TMP, 'logs-green') });
check(green.exitCode === 0, 'the same table with the red step made green exits 0');
check(green.failed.length === 0, 'no lane is reported red when none is');

// ---------------------------------------------------------------------------
section('2 the gate receipt is neither written nor deleted');

const plan = planCommands();
for (const forbidden of FORBIDDEN_IN_PLAN) {
  check(
    !plan.some((c) => c.includes(forbidden)),
    `the plan contains no \`${forbidden}\` (found: ${plan.filter((c) => c.includes(forbidden)).join(' | ')})`,
  );
}
// POSITIVE CONTROL for the scan above: a plan that had gone empty, or a
// substring search that matched nothing because the shape changed, would pass
// every "does not contain" assertion for the wrong reason.
check(
  plan.some((c) => c.includes('preflight-toolchain.mjs')),
  'the plan DOES still run the toolchain preflight directly (so the scan is not blind)',
);
check(
  plan.some((c) => c.includes('verify:protocol-dist')),
  'the plan DOES still build the protocol dist in stage 0',
);
check(plan.length >= 12, `the plan is not empty (${plan.length} commands)`);

const runnerSrc = readFileSync(RUNNER, 'utf8');
check(
  !/^\s*import[^\n]*gate-receipt/m.test(runnerSrc),
  'the runner does not import gate-receipt.mjs',
);

const snapshot = () =>
  RECEIPT_PATHS.map((p) => {
    if (!existsSync(p)) return `${path.basename(p)}:absent`;
    const st = statSync(p);
    return `${path.basename(p)}:${st.size}:${st.mtimeMs}:${readFileSync(p, 'utf8').length}`;
  }).join('|');

const before = snapshot();
await runLanes(laneTable(GREEN), { logDir: path.join(TMP, 'logs-receipt') });
check(snapshot() === before, 'runLanes() left both receipt files exactly as it found them');

const dry = spawnSync(process.execPath, [RUNNER, '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
check(dry.status === 0, `--dry-run exits 0 (got ${dry.status})`);
check(snapshot() === before, '`--dry-run` left both receipt files exactly as it found them');
check(
  /NOT THE RELEASE GATE/.test(dry.stdout ?? ''),
  'the banner says out loud that this is not the release gate',
);
check(
  /verify:delivery/.test(dry.stdout ?? ''),
  'the banner names the sequential command a release must use instead',
);

// ---------------------------------------------------------------------------
section('3 the lane table matches the hazards it claims to handle');

const goldenLane = LANES.find((l) => l.name === 'GOLDEN');
check(goldenLane !== undefined, 'there is a GOLDEN lane');
check(
  goldenLane.steps.every((s) => s.env?.FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT === '1'),
  'the GOLDEN lane tells golden the protocol dist was already built (stage 0 did it)',
);
// The flag is a promise that somebody else built protocol from this tree. Any
// OTHER lane carrying it would be making that promise without the barrier
// behind it.
for (const lane of LANES.filter((l) => l.name !== 'GOLDEN')) {
  check(
    lane.steps.every((s) => s.env?.FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT === undefined),
    `the ${lane.name} lane does not carry the prebuilt-dist flag`,
  );
}
check(
  STAGE0.some((t) => t.args.join(' ').includes('verify:protocol-dist')),
  'stage 0 is the barrier that actually builds it',
);
const rustLane = LANES.find((l) => l.name === 'RUST');
check(
  rustLane.steps.map((s) => s.args.join(' ')).join(',') ===
    'verify:clippy,verify:rust-tests,verify:doctests',
  'the three cargo commands stay in one lane, in order (they share one target dir)',
);
check(
  rustLane.steps.every((s) => /^[0-9]+$/.test(s.env?.CARGO_BUILD_JOBS ?? '')),
  'every cargo step is capped with CARGO_BUILD_JOBS — an uncapped cold build takes the whole box and times out the lanes that assert on a wall clock (hazard 5)',
);
check(
  LANES.filter((l) => l.steps.some((s) => s.args.join(' ').includes('mobile'))).length === 1,
  'there is exactly one flutter lane',
);

// ---------------------------------------------------------------------------
section('4 the sequential release gate was not touched');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const seq = pkg.scripts['verify:delivery'];
check(typeof seq === 'string' && seq.length > 0, '`verify:delivery` still exists');
check(seq.startsWith('pnpm verify:preflight'), '`verify:delivery` still begins with the preflight');
check(seq.trim().endsWith('pnpm verify:receipt'), '`verify:delivery` still ends with the receipt');
check(!seq.includes('run-delivery-fast'), '`verify:delivery` does not delegate to the fast runner');
check(
  pkg.scripts['verify:delivery:fast'] === 'node verify/run-delivery-fast.mjs',
  '`verify:delivery:fast` is registered and points at the lane runner',
);

const publishSrc = readFileSync(path.join(ROOT, 'scripts', 'publish.mjs'), 'utf8');
check(
  /spawnSync\('pnpm', \['verify:delivery'\]/.test(publishSrc),
  'scripts/publish.mjs still runs the SEQUENTIAL gate',
);
check(
  !publishSrc.includes('verify:delivery:fast') && !publishSrc.includes('run-delivery-fast'),
  'scripts/publish.mjs does not reference the fast runner',
);

// ---------------------------------------------------------------------------
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} gate-fast-runner: ${checks - failures}/${checks} checks`);
console.log(`ACCOUNTING: sections run 4/4, checks ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
