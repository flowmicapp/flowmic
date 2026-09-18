#!/usr/bin/env node
// Drill for the two parallel gates: verify/run-delivery-fast.mjs (the LANE
// gate, no receipt) and verify/run-delivery-release.mjs (the RELEASE gate,
// SC-6 — same plan, with a receipt).
//
// Sections 1-4 are the lane gate's two questions, and they are the two ways
// that runner could lie:
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

// Section 5 adds the release gate's three, which are the three properties the
// design (2026-09-17 §2.3) argues a parallel run must have before a release may
// stand on it:
//
//   3. IT WRITES A RECEIPT ONLY WHEN EVERY LANE IS GREEN — and a red run must
//      also leave nothing behind that a later `--end` could close. `begin()`
//      unlinks the standing receipt as its first act, so a run that starts and
//      fails must INVALIDATE the previous proof rather than leave it lying
//      around next to a tree that has since been re-proved into redness.
//   4. IT REFUSES A DIRTY TREE (and leftover test processes, and a process
//      table it could not read). Stricter than the sequential gate on purpose;
//      the reasoning is in the runner's header.
//   5. ITS STAGE SET IS THE SEQUENTIAL GATE'S STAGE SET. Asserted against
//      `package.json`'s own `verify:delivery` string rather than against a
//      list retyped here — a list retyped here is a third copy, and the defect
//      being prevented is exactly that two of the copies stop agreeing. A stage
//      added to one gate and not the other is then a red drill instead of a
//      release proved by fifteen of sixteen stages.
//
// EXIT CODES (scripts/run-script-tests.mjs): 0 PASS, 1 FAIL, 2 SKIP.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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
section('5 the RELEASE gate (verify:delivery:release) — receipt, refusals, same stages');

const rel = await import(pathToFileURL(path.join(ROOT, 'verify', 'run-delivery-release.mjs')).href);
const gr = await import(pathToFileURL(path.join(ROOT, 'scripts', 'gate-receipt.mjs')).href);

// 5.1 THE TWO GATES RUN THE SAME COMMANDS — element for element, not "about
// the same". This is the assertion that makes 5.2 meaningful: without it the
// release gate could mint a receipt for a plan that had quietly shrunk.
check(
  JSON.stringify(rel.PLAN) === JSON.stringify(plan),
  `the release gate's plan is the lane gate's plan, verbatim (${rel.PLAN.length} vs ${plan.length} commands)`,
);

// 5.2 ...AND THAT PLAN IS THE SEQUENTIAL GATE'S STAGE SET. Read out of
// package.json, never retyped: the whole point is that the two cannot drift.
const seqChain = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['verify:delivery'];
const seqStages = seqChain
  .split('&&')
  .map((c) => c.trim())
  // The receipt wrapper is not a STAGE; it is the proof machinery this gate
  // performs in-process instead (begin/end), so it is excluded from both sides.
  .filter((c) => c !== 'pnpm verify:preflight' && c !== 'pnpm verify:receipt');
const parallelStages = rel.PLAN.filter((c) => c.startsWith('pnpm '));
const missing = seqStages.filter((c) => !parallelStages.includes(c));
const extra = parallelStages.filter((c) => !seqStages.includes(c));
check(seqStages.length >= 14, `the sequential chain still parses into stages (${seqStages.length})`);
check(missing.length === 0, `every sequential stage is in the parallel plan (missing: ${missing.join(' | ')})`);
check(extra.length === 0, `the parallel plan invents no stage of its own (extra: ${extra.join(' | ')})`);
// The preflight half of `verify:preflight` is not dropped, only unwrapped: the
// parallel gate runs the toolchain probe directly and does the `--begin` itself.
check(
  rel.PLAN.some((c) => c.includes('preflight-toolchain.mjs')),
  'the toolchain preflight is still in the plan (the receipt half is done in-process)',
);

// 5.3 A FILTERED RELEASE RUN IS REFUSED, and refused by name rather than by the
// flag merely not existing — "the flag is absent" is a fact one edit changes.
const onlyRun = spawnSync(process.execPath, [path.join(ROOT, 'verify', 'run-delivery-release.mjs'), '--only=TSC'], {
  cwd: ROOT,
  encoding: 'utf8',
});
check(onlyRun.status === 1, `the release gate refuses --only (exit ${onlyRun.status})`);
check(/not accepted by the release gate/.test(onlyRun.stdout ?? ''), '  ...and says so in words');

const relPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['verify:delivery:release'];
check(relPkg === 'node verify/run-delivery-release.mjs', `verify:delivery:release is registered (${relPkg})`);

// -- the behavioural half: drive runRelease() against a throwaway repo -------
//
// 🔴 EVERY path below is a temporary one, and the receipt directory is OUTSIDE
// the repo being fingerprinted. Both halves were learned the expensive way and
// are recorded in scripts/gate-receipt.mjs: this drill runs INSIDE
// `verify:scripts`, i.e. in the middle of a real gate run, so a receipt path
// that reached the real `.local/` would delete a live run's pending marker; and
// a receipt written inside the tree it certifies changes the fingerprint it is
// compared against.
const relBefore = snapshot();
{
  const repo = mkdtempSync(path.join(TMP, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'drill@example.test');
  git('config', 'user.name', 'drill');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first');

  const sentinel = path.join(TMP, 'lane-ran.txt');
  const TOUCH = script(
    'touch.mjs',
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'ran');\n`,
  );
  const cleanProbe = { dirty: () => [], processes: () => ({ ok: true, procs: [] }) };
  // `clock` is called exactly twice (the --begin and --end stamps). The gate's
  // own floor refuses a receipt for anything that finished in under a minute, so
  // a synthetic run has to be able to claim plausible elapsed time without
  // actually spending it — that is the only reason this parameter exists.
  const fakeClock = () => {
    let n = 0;
    return () => (n++ === 0 ? 1_000_000 : 1_000_000 + gr.MIN_GATE_MS + 1_000);
  };
  const run = async (lanes, probe = cleanProbe, dir = mkdtempSync(path.join(TMP, 'receipts-'))) => {
    let out = '';
    const code = await rel.runRelease({
      root: repo,
      receiptDir: dir,
      stage0: [{ name: 'stage0', cmd: GREEN.cmd, args: GREEN.args }],
      lanes,
      logDir: mkdtempSync(path.join(TMP, 'logs-rel-')),
      timingsPath: path.join(mkdtempSync(path.join(TMP, 'timings-')), 'last-run.json'),
      probe,
      clock: fakeClock(),
      write: (t) => { out += t; },
    });
    const receiptPath = gr.receiptPathIn(dir);
    const pendingPath = gr.pendingPathIn(dir);
    let receipt = null;
    try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { receipt = null; }
    return { code, out, dir, receipt, pendingExists: existsSync(pendingPath) };
  };

  // GREEN: the receipt is written, and it names this gate.
  const greenRun = await run([
    { name: 'A', steps: [GREEN] },
    { name: 'B', steps: [GREEN, GREEN] },
  ]);
  check(greenRun.code === 0, `an all-green release run exits 0 (got ${greenRun.code})`);
  check(greenRun.receipt != null, 'an all-green release run WRITES a gate receipt');
  check(
    greenRun.receipt?.gate === gr.RELEASE_GATE_NAME,
    `the receipt names the gate that made it (${greenRun.receipt?.gate})`,
  );
  check(
    greenRun.receipt?.sha === execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    'the receipt is about the tree that was tested',
  );
  check(greenRun.pendingExists === false, 'the pending marker is consumed by a green run');
  check(/RELEASE GATE green/.test(greenRun.out), 'the summary names the gate (§1-22)');

  // REVERSE CONTROL — the same table with one step red. Without this, every
  // assertion above also passes against a runner that writes a receipt always.
  const redRun = await run([
    { name: 'A', steps: [GREEN] },
    { name: 'B', steps: [RED, GREEN] },
  ]);
  check(redRun.code !== 0, `a red lane makes the release run non-zero (got ${redRun.code})`);
  check(redRun.receipt === null, 'REVERSE CONTROL: a red lane writes NO receipt');
  check(
    redRun.pendingExists === false,
    'REVERSE CONTROL: a red run also drops the pending marker, so no later --end can close it',
  );
  check(/NO RECEIPT WRITTEN/.test(redRun.out), '  ...and says so where the operator will read it');

  // A STANDING RECEIPT IS INVALIDATED BY A RUN THAT THEN GOES RED. The hazard is
  // not the red run; it is the proof from ten minutes ago still sitting on disk,
  // valid by all four conditions, next to a tree somebody has just re-proved
  // into redness.
  const dir2 = mkdtempSync(path.join(TMP, 'receipts-standing-'));
  const standing = {
    version: gr.RECEIPT_VERSION,
    gate: gr.SEQUENTIAL_GATE_NAME,
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    digest: gr.fingerprint(repo).digest,
    dirtyCount: 0,
    tools: gr.toolStamp(),
    startedAt: 1, finishedAt: Date.now(),
  };
  mkdirSync(dir2, { recursive: true });
  writeFileSync(gr.receiptPathIn(dir2), JSON.stringify(standing));
  check(
    gr.readValidReceipt({ root: repo, dir: dir2 }).ok === true,
    'POSITIVE CONTROL: the planted receipt is valid before the run (otherwise the next check proves nothing)',
  );
  const afterRed = await run([{ name: 'A', steps: [RED] }], cleanProbe, dir2);
  check(afterRed.receipt === null, 'a run that starts and goes red INVALIDATES the receipt that was there');

  // REFUSALS. Each one must stop the gate before a single lane starts — asserted
  // with a sentinel a lane writes, not by reading the summary text.
  rmSync(sentinel, { force: true });
  const dirtyRun = await run([{ name: 'A', steps: [TOUCH] }], {
    dirty: () => ['apps/mobile/lib/x.dart'],
    processes: () => ({ ok: true, procs: [] }),
  });
  check(dirtyRun.code === 1, 'a dirty tree is refused');
  check(existsSync(sentinel) === false, '  ...before any lane runs');
  check(/working tree is not clean/.test(dirtyRun.out), '  ...naming the tree, and the paths');
  check(/apps\/mobile\/lib\/x\.dart/.test(dirtyRun.out), '  ...listing the actual paths');
  check(dirtyRun.receipt === null, '  ...and no receipt is written');

  // The sentinel is per-case: without this reset, one failing refusal would make
  // every later "...before any lane runs" fail too, and a cascade reads like
  // five defects when there is one.
  rmSync(sentinel, { force: true });
  const orphanRun = await run([{ name: 'A', steps: [TOUCH] }], {
    dirty: () => [],
    processes: () => ({ ok: true, procs: [{ pid: 4242, ppid: 1, name: 'flutter_tester.exe', cmd: 'flutter_tester.exe' }] }),
  });
  check(orphanRun.code === 1, 'a leftover test process is refused');
  check(existsSync(sentinel) === false, '  ...before any lane runs');
  check(/pid 4242/.test(orphanRun.out), '  ...naming the PID so it can be dealt with');

  rmSync(sentinel, { force: true });
  const blindRun = await run([{ name: 'A', steps: [TOUCH] }], {
    dirty: () => [],
    processes: () => ({ ok: false, procs: [], reason: 'powershell is not on PATH' }),
  });
  check(blindRun.code === 1, 'a process table that could not be READ is refused, not assumed empty');
  check(/could not read the process table/.test(blindRun.out), '  ...and says which question went unanswered');

  // POSITIVE CONTROL for the three refusals above: the same lane, same sentinel,
  // with nothing to refuse — otherwise "the sentinel is absent" would also be
  // true of a runner that never runs anything at all.
  rmSync(sentinel, { force: true });
  const okRun = await run([{ name: 'A', steps: [TOUCH] }]);
  check(okRun.code === 0 && existsSync(sentinel), 'POSITIVE CONTROL: with clean preconditions the lane DOES run');

  // -- 5.4 --dist-ready: the only stage this gate will not run ---------------
  //
  // The claim being checked is narrow and load-bearing: `--dist-ready` may drop
  // the protocol-dist stage ONLY when the dist on disk is provably the build of
  // the source on disk, and must refuse — before `begin()`, before any lane —
  // when it is not. `scripts/protocol-dist-stamp.test.mjs` drives the judgment
  // itself; these cases drive the WIRING, which is the half that can be right
  // in a module and wrong in the gate.
  const distStage = (name) => [{ name, cmd: GREEN.cmd, args: GREEN.args }];
  const runDist = async (opts) => {
    let out = '';
    const dir = mkdtempSync(path.join(TMP, 'receipts-dist-'));
    const code = await rel.runRelease({
      root: repo,
      receiptDir: dir,
      stage0: [...distStage('preflight'), { name: 'protocol-dist', cmd: TOUCH.cmd, args: TOUCH.args }],
      lanes: [{ name: 'A', steps: [GREEN] }],
      logDir: mkdtempSync(path.join(TMP, 'logs-dist-')),
      timingsPath: path.join(mkdtempSync(path.join(TMP, 'timings-dist-')), 'last-run.json'),
      probe: cleanProbe,
      clock: fakeClock(),
      write: (t) => { out += t; },
      ...opts,
    });
    let receipt = null;
    try { receipt = JSON.parse(readFileSync(gr.receiptPathIn(dir), 'utf8')); } catch { receipt = null; }
    return { code, out, receipt };
  };

  // Without the flag the stage runs — the sentinel IS the protocol-dist stage
  // here, so "did it run" is a fact on disk rather than a line of text.
  rmSync(sentinel, { force: true });
  const noFlag = await runDist({});
  check(noFlag.code === 0 && existsSync(sentinel), 'without --dist-ready the protocol-dist stage RUNS (default behaviour untouched)');

  // With the flag and a good proof it does not run, and the run still ends in a
  // receipt: the proof replaced the stage, it did not excuse it.
  rmSync(sentinel, { force: true });
  const ready = await runDist({ distReady: true, checkDist: () => ({ ok: true, reason: 'fingerprint deadbeefcafe… (drill)' }) });
  check(ready.code === 0, 'with --dist-ready and a valid stamp the run is green');
  check(existsSync(sentinel) === false, '  ...and the protocol-dist stage did NOT run (no sentinel)');
  check(/protocol-dist NOT rebuilt/.test(ready.out), '  ...and the run says which stage it skipped');
  check(/deadbeefcafe/.test(ready.out), '  ...and names the proof it stood on, not just that it had one');
  check(ready.receipt != null, '  ...and a receipt is still written');

  // REVERSE CONTROL — the same flag with a stamp that does not match. This is
  // the red line the whole flag hangs on: a stale dist must stop the gate
  // BEFORE the receipt exists, not produce one for a stale contract.
  rmSync(sentinel, { force: true });
  const stale = await runDist({ distReady: true, checkDist: () => ({ ok: false, reason: 'the dist on disk is the build of a DIFFERENT source (drill)' }) });
  check(stale.code === 1, 'REVERSE CONTROL: --dist-ready with a stale stamp REFUSES (exit 1)');
  check(stale.receipt === null, '  ...writes no receipt');
  check(existsSync(sentinel) === false, '  ...and refuses before any stage runs');
  check(/--dist-ready was passed, but/.test(stale.out), '  ...naming the flag and what it could not prove');
  check(/DIFFERENT source/.test(stale.out), '  ...and quoting the judgment verbatim rather than summarising it');

  // And the real judgment, against a real tree with no protocol package in it
  // at all: the wiring reaches the actual checkStamp, not only an injected fake.
  rmSync(sentinel, { force: true });
  const realJudge = await runDist({ distReady: true });
  check(realJudge.code === 1, 'the DEFAULT judgment is the real checkStamp (a sandbox with no stamp is refused)');
  check(/no stamp at/.test(realJudge.out), '  ...with the real module own words (no stamp at all)');
}
check(snapshot() === relBefore, 'section 5 left the real gate receipt files exactly as it found them');

// The gate names a release may cite is ONE list, and the deploy side (web repo,
// SC-2) reads it rather than keeping a copy.
check(
  Array.isArray(gr.ACCEPTED_GATE_NAMES)
    && gr.ACCEPTED_GATE_NAMES.includes('verify:delivery')
    && gr.ACCEPTED_GATE_NAMES.includes('verify:delivery:release'),
  `ACCEPTED_GATE_NAMES holds both gates (${(gr.ACCEPTED_GATE_NAMES ?? []).join(', ')})`,
);
const gatesOut = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gate-receipt.mjs'), '--gates'], {
  cwd: ROOT, encoding: 'utf8',
});
check(
  gatesOut.status === 0
    && gatesOut.stdout.trim().split(/\r?\n/).join('|') === gr.ACCEPTED_GATE_NAMES.join('|'),
  '`gate-receipt.mjs --gates` prints exactly that list, one per line, for the deploy side to read',
);
check(
  /readValidReceipt\(/.test(readFileSync(path.join(ROOT, 'scripts', 'publish.mjs'), 'utf8')),
  'publish.mjs still delegates the accept decision to readValidReceipt (so both gates are accepted there by construction)',
);

// ---------------------------------------------------------------------------
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} gate-fast-runner: ${checks - failures}/${checks} checks`);
console.log(`ACCOUNTING: sections run 5/5, checks ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
