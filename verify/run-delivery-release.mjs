#!/usr/bin/env node
// verify/run-delivery-release.mjs — `pnpm verify:delivery:release`, THE RELEASE
// GATE RUN IN PARALLEL (card SC-6).
//
// It is the six-lane plan of verify/run-delivery-fast.mjs — the same lane
// table, the same commands, imported rather than copied — wrapped in the two
// things that make a run citable by a release: the gate receipt, and a refusal
// to start on ground that would make the receipt a lie.
//
// 🔴 WHY A PARALLEL RUN IS ALLOWED TO BE A RELEASE AUTHORITY AT ALL.
// Until today RELEASE-IRONRULES said only the sequential `pnpm verify:delivery`
// counted, and scripts/gate-fast-runner.test.mjs nailed the fast runner to
// "writes no receipt, deletes no receipt". That nail had two reasons and only
// one of them was about evidence:
//
//   · the fast runner has no `--begin` fingerprint, so a receipt it wrote could
//     not say WHICH tree was tested. That reason is real, and this file answers
//     it by taking the fingerprint the same way the sequential chain does —
//     before the first stage, not after the last.
//   · "sequential is more trustworthy than parallel" is NOT an evidence
//     difference. Both run the same commands; parallelism adds machine
//     contention, and contention can turn a green test RED (measured
//     2026-09-12: five time-racing tests, all since made event-driven). It
//     cannot turn a red test green — a test that only passes under contention
//     was passing by luck sequentially too. So the parallel run is the
//     STRICTER one (design 2026-09-17 §2.3).
//
// The honest cost of that argument is stated rather than implied: a red lane
// here still may be contention rather than product, which is why the failure
// text says so and names the re-run. But a red lane, whatever its cause, writes
// NO receipt — the failure mode of this gate is "you must run a gate again",
// never "you shipped on a proof nobody earned".
//
// 🔴 WHAT THIS REFUSES TO START ON, AND WHY EACH ONE IS A REFUSAL AND NOT A
// WARNING. Both preconditions cost under a second and both fail closed:
//
//   1. A DIRTY WORKING TREE. This is STRICTER THAN THE SEQUENTIAL GATE, on
//      purpose, and the difference is worth writing down: `verify:delivery`
//      happily proves a dirty tree (the fingerprint covers the uncommitted
//      bytes and the receipt records `dirtyCount`). What it cannot survive is
//      the tree MOVING mid-run — `--end` then refuses, and you learn that after
//      the minutes, not before them. A release gate is run on a tree somebody
//      is about to publish; if that tree is dirty, either the edits are part of
//      the release (commit them) or they are not (stash them), and both answers
//      are cheaper now than after the run. Refusing in 0.2 s beats discovering
//      in 160 s that the run produced no proof.
//   2. ORPHAN TEST PROCESSES. A leftover flutter_tester, vitest, golden runner
//      or cargo from a killed run is the measured cause of the reds this repo
//      keeps re-diagnosing as product defects (CLAUDE.md 2026-09-13: 「门禁红先
//      查有没有孤儿 pnpm golden/测试进程在抢机器」— four reds in one window,
//      all of them this). Six lanes make it worse, not better.
//      What this does NOT do is refuse because the machine is merely busy:
//      there is no measured threshold for "busy", and a gate that refuses on a
//      number nobody measured is a gate people learn to work around. A cargo
//      started AFTER this check (the orchestrator's own plan runs the desktop
//      build beside the gate) is likewise not refused — it cannot be; hazard 5
//      is reported in the red-lane advice instead of pretended away.
//
// If the process list cannot be read at all, that is a refusal too: "I could
// not ask" and "there is nothing there" are different answers and must never
// share a screen (the §1-21 lesson, three-state, never DONE from UNKNOWN).
//
// 🔴 `--dist-ready` — THE ONE STAGE THIS GATE WILL NOT RUN, AND WHY THAT IS
// NOT A SKIP SWITCH. Stage 0 rebuilds `packages/protocol/dist` with tsup's
// `clean: true`: it deletes the directory and writes it again. Everything that
// reads that dist must therefore stay out of the gate's way — including the
// desktop build, which is the longest thing that could otherwise run BESIDE the
// gate instead of after it (measured 2026-09-18: serialising it cost the design
// its biggest overlap, 384 s -> 486 s of planning critical path).
//
// So the rebuild is allowed to happen ONCE, outside, in a step both the gate
// and the desktop build wait on (`scripts/ship.mjs`'s DIST node). `--dist-ready`
// says "that already happened"; this gate then VERIFIES it by content hash —
// `scripts/protocol-dist-stamp.mjs` fingerprints every build input and the
// stamp says which fingerprint the dist on disk was built from — and refuses
// the whole run if the answer is anything but yes. It never rebuilds silently
// and it never proceeds on doubt: a missing stamp, an unreadable stamp, a
// changed source and a shrunken dist are four different refusals, all before
// `begin()` and therefore all before any receipt exists.
//
// What the receipt then means is unchanged in substance: every stage ran except
// one whose output was proved, by content, to be exactly what running it would
// have produced. What it does NOT mean is "a stage was dropped because someone
// was in a hurry" — there is no flag in this file with that effect, and the
// difference is that this one is checked and can refuse.
//
// Usage:
//   pnpm verify:delivery:release
//   pnpm verify:delivery:release --dist-ready  # protocol/dist already built+stamped
//   pnpm verify:delivery:release --dry-run     # plan + preconditions, no side effects
//   (there is deliberately no --only, and no flag that skips anything unproved)
//
// Per-lane output: `.local/gate-release/<LANE>.log`. Timings: see TIMINGS_PATH.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { LANES, ROOT, STAGE0, mmss, planCommands, runLanes, tailOf } from './run-delivery-fast.mjs';
import { STAMP_PATH, checkStamp } from '../scripts/protocol-dist-stamp.mjs';
import {
  ACCEPTED_GATE_NAMES,
  RECEIPT_DIR,
  RELEASE_GATE_NAME,
  abandon,
  begin,
  dirtyPaths,
  end,
  receiptPathIn,
} from '../scripts/gate-receipt.mjs';

export const LOG_DIR = path.join(ROOT, '.local', 'gate-release');

/** One newline, named, because the two multi-line refusal texts below are
 *  assembled from arrays of lines rather than from one string with escapes in
 *  it — a refusal is read by a person under time pressure, and keeping each
 *  line a line in the source is what stops one of them from silently losing its
 *  break during an edit. */
const NL = String.fromCharCode(10);

/** The exact command list this gate runs, frozen at import so a drill can
 *  compare it against the lane gate's WITHOUT executing anything.
 *
 *  It does not merely resemble that plan — it is computed by the same function
 *  over the same two tables, imported from the same module. The drill asserts
 *  the two arrays are identical element for element, which is what stops the
 *  two gates from drifting: a stage added to the sequential chain and to the
 *  lane table lands here for free, and a stage added to only one of them is a
 *  red drill rather than a release proved by fifteen of sixteen stages. */
export const PLAN = Object.freeze(planCommands());

/** Per-lane and total wall clocks, written on EVERY run — green or red.
 *
 *  It is deliberately NOT part of the receipt. A receipt is a proof and gets
 *  four conditions checked before anyone may stand on it; these numbers are
 *  measurements, they are useful precisely when the run went red, and mixing
 *  the two would mean a red run either wrote a receipt-shaped file (which is
 *  the one thing this gate must never do) or threw its own measurements away.
 *  The design's §2.2 critical path is updated from this file. */
export const TIMINGS_PATH = path.join(LOG_DIR, 'last-run.json');

/** What counts as a leftover test process.
 *
 *  Matched on the COMMAND LINE, not on the executable name alone, for the two
 *  cases where the name lies in both directions: this machine permanently runs
 *  several `dart.exe` (language server, devtools, tooling daemon) that are not
 *  tests and must not be refused, and a `node.exe` is only interesting when it
 *  is running one of our test runners rather than an editor's helper — the box
 *  normally has 60+ of them (measured 2026-09-17: 84 node processes, none of
 *  them a test).
 *
 *  Not scoped to THIS checkout on purpose: a sibling worktree's `flutter test`
 *  is the known cross-talk hazard (CLAUDE.md 「并行 flutter 测试互踩」), so
 *  "it belongs to another tree" is a reason to refuse, not a reason to allow. */
export const ORPHAN_RULES = [
  {
    id: 'flutter_tester',
    why: 'a Dart test VM — a leftover one keeps the mobile lane\'s ports and temp state',
    match: (p) => /(^|[\\/])flutter_tester(\.exe)?$/i.test(p.name),
  },
  {
    id: 'flutter-test',
    why: 'a `flutter test` run (the mobile lane cannot share a machine with another one)',
    match: (p) => /flutter_tools\.snapshot["'\s].*\btest\b/i.test(p.cmd),
  },
  {
    id: 'vitest',
    why: 'a vitest run — it will contend with the VITEST lane for the box',
    match: (p) => /[\\/]vitest[\\/.]/i.test(p.cmd) || /\bvitest\b\s+run\b/i.test(p.cmd),
  },
  {
    id: 'golden',
    why: 'a golden-path run — it starts real servers and two of its cases wait on wall clocks',
    match: (p) => /run-golden\.mjs/i.test(p.cmd) || /verify[\\/]golden[\\/]/i.test(p.cmd),
  },
  {
    id: 'gate',
    why: 'another gate runner in flight — two of them would prove two different trees at once',
    match: (p) =>
      /run-delivery-(fast|release)\.mjs/i.test(p.cmd)
      || /run-lane-gate\.mjs/i.test(p.cmd)
      || /run-script-tests\.mjs/i.test(p.cmd),
  },
  {
    id: 'cargo',
    why: 'a cargo build/test — it takes every core it is given and starves the lanes that assert on time (hazard 5)',
    match: (p) => /(^|[\\/])cargo(\.exe)?$/i.test(p.name),
  },
];

/** Read the process table. Returns `{ ok, procs, reason }` — never throws, and
 *  never reports an empty list as success when the read itself failed. */
export function listProcesses() {
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    if (r.error || r.status !== 0) {
      return { ok: false, procs: [], reason: `powershell could not list processes (${r.error?.message ?? `exit ${r.status}`})` };
    }
    let raw;
    try {
      raw = JSON.parse(r.stdout);
    } catch (e) {
      return { ok: false, procs: [], reason: `the process list did not parse as JSON (${e.message})` };
    }
    const rows = Array.isArray(raw) ? raw : [raw];
    return {
      ok: true,
      procs: rows.map((p) => ({
        pid: Number(p.ProcessId),
        ppid: Number(p.ParentProcessId),
        name: String(p.Name ?? ''),
        cmd: String(p.CommandLine ?? ''),
      })),
    };
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    return { ok: false, procs: [], reason: `ps could not list processes (${r.error?.message ?? `exit ${r.status}`})` };
  }
  const procs = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] });
  }
  return { ok: true, procs };
}

/** Our own process and everything that spawned it (pnpm, the shell, the editor).
 *  Without this the runner refuses ITSELF: its own command line matches the
 *  `gate` rule, which is exactly what that rule is for. */
export function selfAncestry(procs, pid = process.pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set([pid]);
  let cur = byPid.get(pid);
  for (let i = 0; i < 32 && cur && cur.ppid && !out.has(cur.ppid); i += 1) {
    out.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

/** The pids belonging to THIS invocation, when this gate was started by
 *  `scripts/ship.mjs` as one step of a parallel plan.
 *
 *  🔴 Ancestry alone is not enough, and the hole is structural rather than
 *  incidental. `selfAncestry` walks UPWARD, so it knows about ship, pnpm and
 *  the shell — but the step running beside us (BUILD_SITE, whose `pnpm build`
 *  in the marketing-site repo chains `vue-tsc && vitest run && vite build`) is ship's
 *  CHILD, not our ancestor. The `vitest` rule therefore matched our own
 *  sibling and the gate refused before running a single stage
 *  [measured 2026-09-18, dev-pc-a, .local/ship/e32c929ef8df/GATE.log: "2
 *  leftover test process(es)" = cmd.exe + node.exe, both BUILD_SITE's].
 *
 *  So ship hands every child `FLOWMIC_SHIP_RUN_PID` (its own pid) and we take
 *  the DESCENDANT closure of that one anchor. Deliberately not the descendant
 *  closure of the whole ancestry: that would also swallow everything else the
 *  editor ever launched, including another session's run in a sibling worktree
 *  — which this gate must keep refusing (today's PRE correctly flagged one).
 *
 *  The anchor is verified before it is trusted: a pid is a recycled number, so
 *  we only accept it when the live process table shows that pid running
 *  something whose command line is ship itself. A stale or reused pid then
 *  degrades to plain ancestry — the refusing behaviour — rather than to a
 *  blanket exemption. */
export function invocationPids(procs, { pid = process.pid, anchorPid = null, anchorNeedle = /ship\.mjs/i } = {}) {
  const self = selfAncestry(procs, pid);
  const anchor = Number(anchorPid);
  if (!Number.isInteger(anchor) || anchor <= 0) return self;
  const anchorProc = procs.find((p) => p.pid === anchor);
  if (!anchorProc || !anchorNeedle.test(anchorProc.cmd || '')) return self;
  const childrenOf = new Map();
  for (const p of procs) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p.pid);
  }
  const out = new Set(self);
  out.add(anchor);
  const stack = [anchor];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const kid of childrenOf.get(cur) ?? []) {
      if (out.has(kid)) continue;
      out.add(kid);
      stack.push(kid);
    }
  }
  return out;
}

export function orphanFindings(procs, { selfPids = new Set() } = {}) {
  const out = [];
  for (const p of procs) {
    if (selfPids.has(p.pid)) continue;
    const rule = ORPHAN_RULES.find((r) => r.match(p));
    if (rule) out.push({ pid: p.pid, name: p.name, rule: rule.id, why: rule.why, cmd: p.cmd });
  }
  return out;
}

/**
 * The refusals, as text, from facts already gathered — pure so the drill can
 * drive every branch without a machine in a particular state.
 */
export function precheckRefusals({ dirty = [], orphans = [], processProbe = { ok: true }, distStamp = null } = {}) {
  const refusals = [];
  // Fail closed, and FIRST: if the caller claimed the dist was already built,
  // that claim is the ground the whole run stands on. `distStamp` is null when
  // the flag was not passed — the gate then builds the dist itself, as always.
  if (distStamp && !distStamp.ok) {
    refusals.push([
      '--dist-ready was passed, but packages/protocol/dist is not provably the build of this source:',
      `      ${distStamp.reason}`,
      '    Nothing was rebuilt in response, on purpose: this flag exists because something',
      '    else (the desktop build) is reading that directory right now, and rebuilding it',
      '    under a reader is the exact failure the flag was introduced to avoid.',
      '    Re-run `pnpm verify:protocol-dist` (it writes the stamp), or drop --dist-ready',
      '    and let this gate own the rebuild again.',
    ].join(NL));
  }
  if (!processProbe.ok) {
    refusals.push(
      `could not read the process table: ${processProbe.reason}\n`
        + '    That is a refusal, not a pass: "nothing is running" and "I could not ask" are\n'
        + '    different answers, and a release gate may not treat the second as the first.'
    );
  }
  if (orphans.length > 0) {
    const lines = orphans.map((o) => `      pid ${o.pid}  ${o.name}  [${o.rule}] — ${o.why}`);
    refusals.push(
      `${orphans.length} leftover test process(es) are running:\n${lines.join('\n')}\n`
        + '    Six lanes already share this machine. A red lane produced next to these is a\n'
        + '    question about the machine, not about the product — and it costs minutes to ask.\n'
        + '    Stop them (or wait for them), then re-run.'
    );
  }
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10).map((p) => `      ${p}`);
    const more = dirty.length > 10 ? `\n      … and ${dirty.length - 10} more` : '';
    refusals.push(
      `the working tree is not clean (${dirty.length} path(s)):\n${shown.join('\n')}${more}\n`
        + '    Commit them if they are part of this release, stash them if they are not.\n'
        + '    The sequential gate would run and then refuse the receipt if any of these moved\n'
        + '    mid-run; this refusal is the same answer, delivered before the minutes.'
    );
  }
  return refusals;
}

const defaultProbe = {
  dirty: (root) => {
    try {
      return dirtyPaths(root);
    } catch {
      // Same rule as the process table: a question we could not ask is not a
      // clean answer. An unreadable git state is reported as one dirty path so
      // the refusal fires rather than the run starting blind.
      return ['(git status could not be read — refusing rather than assuming clean)'];
    }
  },
  processes: () => listProcesses(),
};

function writeTimings(timingsPath, payload) {
  try {
    mkdirSync(path.dirname(timingsPath), { recursive: true });
    writeFileSync(timingsPath, `${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole gate. Every collaborator is injectable because the drill has to be
 * able to prove the two properties that matter — "writes a receipt only when
 * every lane is green" and "refuses a dirty tree" — WITHOUT running the real
 * four-minute plan, and without ever touching the real `.local/gate-receipt.json`
 * (a drill that reached outside its sandbox once deleted a live run's pending
 * marker; see the header of scripts/gate-receipt.mjs).
 *
 * `clock` is called exactly twice: the `--begin` stamp and the `--end` stamp.
 * Wall clocks for the report come from Date.now() and are never the clock's
 * business — the drill needs to fake elapsed minutes without faking durations.
 */
export async function runRelease({
  root = ROOT,
  receiptDir = RECEIPT_DIR,
  stage0 = STAGE0,
  lanes = LANES,
  logDir = LOG_DIR,
  timingsPath = TIMINGS_PATH,
  probe = defaultProbe,
  clock = () => Date.now(),
  write = (s) => process.stdout.write(s),
  distReady = false,
  checkDist = checkStamp,
} = {}) {
  write(
    '\n'
      + '========================================================================\n'
      + `  RELEASE GATE - parallel plan, with a receipt.   ${RELEASE_GATE_NAME}\n`
      + '  Same stages, same commands as the sequential `pnpm verify:delivery`;\n'
      + '  six concurrent lanes instead of seventeen sequential ones.\n'
      + '  Quote it BY NAME (RELEASE-IRONRULES §1-22): "gate T3p" is not "T3".\n'
      + '========================================================================\n\n'
  );

  // -- preconditions ---------------------------------------------------------
  const probeResult = probe.processes();
  const orphans = probeResult.ok
    ? orphanFindings(probeResult.procs, {
      selfPids: invocationPids(probeResult.procs, { anchorPid: process.env.FLOWMIC_SHIP_RUN_PID }),
    })
    : [];
  const dirty = probe.dirty(root);
  const distStamp = distReady ? checkDist(root) : null;
  const refusals = precheckRefusals({ dirty, orphans, processProbe: probeResult, distStamp });
  if (refusals.length > 0) {
    write('x REFUSED before the first stage — nothing was run, no receipt was touched.\n\n');
    for (const r of refusals) write(`  - ${r}\n\n`);
    return 1;
  }
  write(`  preconditions: clean tree, no leftover test processes (${probeResult.procs.length} processes scanned)\n\n`);

  // -- open the proof --------------------------------------------------------
  // `begin()` fingerprints the tree ABOUT TO BE TESTED and unlinks any standing
  // receipt as its first act: from this second the tree is being re-proved, and
  // an older proof must not be available to a publish that has no idea a gate is
  // mid-flight.
  const startedAt = clock();
  if (begin({ root, dir: receiptDir, now: startedAt, gate: RELEASE_GATE_NAME }) !== 0) return 1;

  const t0 = Date.now();
  // The stage is dropped only after `distStamp.ok` — which is the only state
  // that gets this far, because a bad stamp refused above. The line it prints
  // in its place names the fingerprint, so the run's own output says what the
  // skipped stage was replaced BY.
  const stage0Run = distStamp?.ok ? stage0.filter((t) => t.name !== 'protocol-dist') : stage0;
  if (distStamp?.ok) {
    write([
      `  stage 0: protocol-dist NOT rebuilt — ${distStamp.reason}`,
      `           (--dist-ready; proof read from ${STAMP_PATH})`,
      '', '',
    ].join(NL));
  }
  const stage0Lanes = stage0Run.map((t) => ({ name: t.name, steps: [{ cmd: t.cmd, args: t.args, env: t.env }] }));
  const s0 = await runLanes(stage0Lanes, { logDir: path.join(logDir, 'stage0') });
  for (const r of s0.results) {
    write(`  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.lane.padEnd(14)} ${mmss(r.ms)}  exit ${r.code}\n`);
  }

  const finish = (exitCode, laneResults, note) => {
    const finishedAt = Date.now();
    const payload = {
      gate: RELEASE_GATE_NAME,
      green: exitCode === 0,
      sha: (() => {
        try {
          return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
        } catch {
          return null;
        }
      })(),
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      totalMs: finishedAt - t0,
      stage0: s0.results.map((r) => ({ name: r.lane, ms: r.ms, code: r.code })),
      distReady: distStamp?.ok ? { skipped: 'protocol-dist', proof: distStamp.reason } : null,
      lanes: laneResults.map((r) => ({ lane: r.lane, ms: r.ms, code: r.code, ran: r.ran, failedStep: r.failedStep })),
      machine: {
        platform: process.platform,
        cores: (typeof availableParallelism === 'function' ? availableParallelism() : cpus().length) || 0,
      },
      note,
    };
    writeTimings(timingsPath, payload);
    return payload;
  };

  if (s0.exitCode !== 0) {
    for (const r of s0.failed) {
      write(`\n-- ${r.lane} (last 40 lines of ${path.relative(root, r.logPath)}) --\n${tailOf(r.logPath)}\n`);
    }
    abandon({ dir: receiptDir });
    finish(1, [], 'stage 0 failed; no lane started');
    write('\nx STAGE 0 failed - no lane started, NO RECEIPT. Nothing below was verified.\n');
    return 1;
  }

  // -- the six lanes ---------------------------------------------------------
  write(`\n  ${lanes.length} lane(s), concurrent\n`);
  const { results, failed, exitCode } = await runLanes(lanes, {
    logDir,
    onDone: (r) =>
      write(
        `  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.lane.padEnd(8)} ${mmss(r.ms)}  exit ${r.code}`
          + `${r.failedStep ? `  <- \`${r.failedStep}\`` : ''}\n`
      ),
  });

  write('\n  lane      |  wall  | exit | log\n');
  write('  ----------+--------+------+------------------------------\n');
  for (const r of results) {
    write(`  ${r.lane.padEnd(10)}| ${mmss(r.ms).padStart(6)} | ${String(r.code).padStart(4)} | ${path.relative(root, r.logPath)}\n`);
  }

  if (exitCode !== 0) {
    for (const r of failed) {
      write(`\n-- ${r.lane} (last 40 lines of ${path.relative(root, r.logPath)}) --\n${tailOf(r.logPath)}\n`);
    }
    // FAIL CLOSED, and in both directions: no receipt is written, AND the
    // pending marker is dropped so nothing can close this run later.
    abandon({ dir: receiptDir });
    const t = finish(1, results, `${failed.length} lane(s) red`);
    write(
      `\nx ${failed.length}/${lanes.length} lane(s) red: ${failed.map((r) => r.lane).join(', ')} — NO RECEIPT WRITTEN.\n`
        + `   total wall: ${mmss(t.totalMs)}   timings: ${path.relative(root, timingsPath)}\n`
        + '   A red lane is not yet a verdict about the product: six lanes share one machine\n'
        + '   and two of them contain assertions that race a wall clock. Re-run the lane by\n'
        + '   itself before believing it:\n'
        + `     pnpm verify:delivery:fast --only=${failed.map((r) => r.lane).join(',')}\n`
        + '   Whatever the cause, this run proved nothing: publish/deploy will run a gate again.\n'
    );
    return 1;
  }

  // -- close the proof -------------------------------------------------------
  const endedAt = clock();
  end({ root, dir: receiptDir, now: endedAt, gate: RELEASE_GATE_NAME });

  const receiptPath = receiptPathIn(receiptDir);
  let receipt = null;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    receipt = null;
  }
  const t = finish(0, results, receipt ? 'green, receipt written' : 'green, NO receipt (see run output)');
  write(`\n  total wall: ${mmss(t.totalMs)}   timings: ${path.relative(root, timingsPath)}\n`);

  if (!receipt || receipt.gate !== RELEASE_GATE_NAME) {
    // Green, and yet the thing this command exists to produce does not exist.
    // Reported as a failure rather than a footnote — a command that succeeds
    // without doing its job is the shape this repo pays for most — and the
    // wording says out loud which half failed.
    write(
      '\nx the LANES WERE GREEN, but this run produced NO RECEIPT.\n'
        + '   (`--end` prints the reason above; the usual one is that the working tree moved\n'
        + '    while the gate was running, which makes the run a proof about no single state.)\n'
        + '   The refusal is about the proof, not about the product. Re-run it on a still tree.\n'
    );
    return 1;
  }

  write(
    `\nok RELEASE GATE green in ${mmss(t.totalMs)} — receipt written for ${String(receipt.sha).slice(0, 12)}.\n`
      + `   gate name: ${RELEASE_GATE_NAME}. Quote THAT when you quote this green\n`
      + '   (RELEASE-IRONRULES §1-22). publish.mjs and the deploy scripts accept it:\n'
      + `   ${ACCEPTED_GATE_NAMES.join(' | ')}\n`
  );
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  // 🔴 NO `--only`, and the refusal is explicit rather than the flag merely
  // being absent. A release proof about a subset is the one thing a receipt
  // must never be able to mean, and "the flag does not exist" is a fact a
  // future edit can change without noticing what it changed.
  const only = argv.find((a) => a.startsWith('--only'));
  if (only) {
    process.stdout.write(
      `x \`${only}\` is not accepted by the release gate.\n`
        + '  A receipt says the WHOLE set was green; a filtered run cannot mean that.\n'
        + '  Use `pnpm verify:delivery:fast --only=…` for the edit loop — it writes no receipt.\n'
    );
    return 1;
  }
  const distReady = argv.includes('--dist-ready');
  if (argv.includes('--dry-run')) {
    process.stdout.write(`plan for ${RELEASE_GATE_NAME} (identical to verify:delivery:fast, unfiltered):\n`);
    for (const c of PLAN) process.stdout.write(`  ${c}\n`);
    const probeResult = listProcesses();
    const orphans = probeResult.ok
      ? orphanFindings(probeResult.procs, {
      selfPids: invocationPids(probeResult.procs, { anchorPid: process.env.FLOWMIC_SHIP_RUN_PID }),
    })
      : [];
    const refusals = precheckRefusals({
      dirty: dirtyPaths(ROOT), orphans, processProbe: probeResult, distStamp: distReady ? checkStamp(ROOT) : null,
    });
    process.stdout.write(
      refusals.length === 0
        ? '\npreconditions: OK (clean tree, no leftover test processes)\n'
        : `\npreconditions would REFUSE this run:\n${refusals.map((r) => `  - ${r}\n`).join('\n')}`
    );
    process.stdout.write('\n(dry run - nothing was executed, no receipt touched)\n');
    return 0;
  }
  return runRelease({ distReady });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code));
}
