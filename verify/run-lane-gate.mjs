#!/usr/bin/env node
// verify/run-lane-gate.mjs — T1, the SCOPED gate. `pnpm verify:lane`.
//
// It runs the stages your diff can plausibly break, and prints one line per
// stage it did NOT run saying why. Design:
// docs/strategy/2026-09-13-gate-tiering-design.md §1 (T1), §2 (the table), §9.
//
// 🔴🔴 WHAT ITS GREEN MEANS, AND WHAT IT DOES NOT.
// Three gates in this repo end their output with something that reads like
// "ok", and only the reader can tell them apart:
//   T1 `pnpm verify:lane`          — "the stages MY DIFF touches are green"
//   T2 `pnpm verify:delivery:fast` — "every stage is green (six lanes)"
//   T3 `pnpm verify:delivery`      — "every stage is green (sequential), with a
//                                     receipt" — the only one a release may cite
//                                     (scripts/publish.mjs GATE 0 runs it).
// So this runner is FORBIDDEN from ending on a bare "ok": its last line always
// names the stages it ran and the stages it skipped, and
// scripts/lane-gate.test.mjs asserts that line exists. Quote that line, not the
// word "green", when you write down that this gate passed.
//
// 🔴 IT MUST NOT TOUCH `.local/gate-receipt.json`, IN EITHER DIRECTION.
// Not write one (a scoped run is not a release proof) and not delete one —
// scripts/gate-receipt.mjs's `begin()` unlinks the standing receipt as its first
// act, so calling `pnpm verify:preflight` from here would destroy a valid proof
// every time somebody ran the quick gate. The forbidden strings are enforced,
// not remembered: `FORBIDDEN_IN_LANE_PLAN` is checked against this runner's own
// plan before anything is spawned.
//
// 🔴 AND IT DOES NOT RUN THE TOOLCHAIN PROBE AT ALL (ruling, MAIN 2026-09-13).
// verify/run-delivery-fast.mjs's Stage 0 is `preflight-toolchain.mjs` +
// `verify:protocol-dist`; T1 keeps only the second. `scripts/preflight-toolchain.mjs`
// exists to produce the readings that stamp a release receipt — gate-receipt.mjs's
// `toolStamp()` is built from `probeTools()` — and it costs ~12.6 s, almost all
// of it in `flutter --version`. T1 writes no receipt, so it would be paying
// twelve seconds per run for a stamp nobody reads. What a missing toolchain
// costs instead is one raw error from cargo or flutter, in the inner loop,
// where the developer is standing right there. The full gates still probe.
//
// ⚠️ THE HONEST HOLE, stated rather than discovered later: this gate can only
// see paths git reports in THIS repository. The mirror lints read sibling repos
// (verify/lint/password-policy-mirror.mjs and friends), and a change over there
// is in no diff. `verify:lint` is unscoped and rides EVERY row precisely so
// those lints run whenever this gate runs at all — but a diff that selects no
// stage at all selects no lint either.
//
// 🔴 TWO STAGES ARE NEVER SCOPED: `verify:lint` and `verify:scripts` (ruling,
// MAIN 2026-09-13; the argument for each is on `ALWAYS` in verify/lane-map.mjs).
// The second one is the surprising half — scripts/ holds a resident gate on
// server-core PRODUCTION code (scripts/w2-eval-corpus.test.mjs:147 bundles
// apps/server-core/src/compose/output-guard.ts), so scoping it away would have
// skipped a real gate to save the set's whole measured cost of 10.9 s.
// A consequence worth knowing before it surprises you: `verify:scripts` also
// needs the protocol dist, so Stage 0 now runs on every non-empty selection,
// docs-only included.
//
// Usage:
//   pnpm verify:lane
//   pnpm verify:lane --plan                 # print the plan, run nothing, exit 0
//   pnpm verify:lane --base <sha>           # diff against <sha> instead of the default
//   pnpm verify:lane --paths a/b.ts,c/d.md  # TEST HOOK, see below

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dirtyPaths } from '../scripts/gate-receipt.mjs';
import {
  FORBIDDEN_IN_PLAN,
  LANES,
  LANE_RECEIPT_PATH,
  ROOT,
  STAGE0,
  runLanes,
} from './run-delivery-fast.mjs';
import { FULL_STAGES, RULES, needsStage0, selectStages } from './lane-map.mjs';

const LOG_DIR = path.join(ROOT, '.local', 'lane-gate');

/**
 * T1's Stage 0: the protocol-dist barrier, and nothing else.
 *
 * DERIVED from the fast runner's STAGE0 rather than re-spelled, so the command
 * cannot drift between the two gates — and it THROWS if that entry disappears
 * or is renamed, because the alternative is a lane gate that silently stops
 * building the dist and then reports reds about a stale contract. The filter is
 * the one deliberate difference between T1's barrier and T2's; see the header
 * for why the toolchain probe is not here.
 */
export const STAGE0_LANE = STAGE0.filter((t) => t.name === 'protocol-dist');
if (STAGE0_LANE.length !== 1) {
  throw new Error(
    `verify/run-lane-gate.mjs: expected exactly one 'protocol-dist' task in run-delivery-fast's STAGE0, found ${STAGE0_LANE.length}`
  );
}

/** What this runner's plan may never contain. The fast runner's list plus the
 *  toolchain probe, which T1 drops for cost (see the header) — and `verify:preflight`
 *  alone would not catch it, since Stage 0 used to spawn the script directly. */
export const FORBIDDEN_IN_LANE_PLAN = [...FORBIDDEN_IN_PLAN, 'preflight-toolchain', 'preflight'];

const git = (args) => {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

const revParse = (ref) => git(['rev-parse', '--verify', '--quiet', ref])?.trim() || null;
const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]) !== null;

/**
 * Which commit this diff is measured from, and — just as important — the one
 * sentence explaining the choice, because every branch here changes how much
 * gets skipped.
 *
 * 🔴 LOCAL `main`, NEVER `origin/main`, when we are on a lane branch. Measured
 * on 2026-09-13 (design §2.3): this machine's `main` is 53 commits ahead of
 * `origin/main`, so merge-basing against the remote would fold 53 commits'
 * worth of paths into the diff. That direction is SAFE — it only ever runs more
 * — but it turns the scoping off while still printing the word "scoped", which
 * is the worse failure of the two.
 */
export function resolveBase({ override = null, head = 'HEAD' } = {}) {
  if (override) {
    const sha = revParse(override);
    if (!sha) return { base: null, why: `--base ${override} is not a commit in this repo` };
    return { base: sha, why: `--base ${override}` };
  }
  const branch = git(['rev-parse', '--abbrev-ref', head])?.trim() ?? '';
  if (branch !== 'main') {
    const localMain = revParse('refs/heads/main');
    if (localMain) {
      const mb = git(['merge-base', head, 'refs/heads/main'])?.trim();
      if (mb) return { base: mb, why: `merge-base with local main (branch ${branch})` };
    }
    const originMain = revParse('refs/remotes/origin/main');
    if (originMain) {
      const mb = git(['merge-base', head, 'refs/remotes/origin/main'])?.trim();
      if (mb) {
        return { base: mb, why: `merge-base with origin/main — no local main (branch ${branch})` };
      }
    }
    return { base: null, why: `no local main and no origin/main to diff against (branch ${branch})` };
  }
  // On main the only honest baseline is the last commit this machine proved
  // green with the FULL set. Anything else would let a scoped run inherit a
  // claim nobody made.
  let receipt = null;
  try {
    receipt = JSON.parse(readFileSync(LANE_RECEIPT_PATH, 'utf8'));
  } catch {
    return { base: null, why: 'on main and no lane receipt (.local/lane-gate/last-green.json)' };
  }
  const sha = typeof receipt?.sha === 'string' ? revParse(receipt.sha) : null;
  if (!sha) return { base: null, why: 'on main and the lane receipt names no commit in this repo' };
  if (!isAncestor(sha, head)) {
    return { base: null, why: `on main and the lane receipt's ${sha.slice(0, 12)} is not an ancestor of HEAD` };
  }
  return { base: sha, why: `last full-set green on this machine (${sha.slice(0, 12)}, ${receipt.tier ?? '?'})` };
}

/** Committed changes since `base`, plus everything uncommitted. `dirtyPaths` is
 *  imported from scripts/gate-receipt.mjs rather than reimplemented: it already
 *  handles `-z` (this repo has CJK filenames, and `core.quotePath` would hand
 *  back a name that is not on disk) and rename records. */
export function changedPaths({ base }) {
  const out = new Set();
  if (base) {
    const raw = git(['diff', '--name-only', '-z', base, 'HEAD']) ?? '';
    for (const p of raw.split('\0')) if (p.trim()) out.add(p.trim());
  }
  try {
    for (const p of dirtyPaths(ROOT)) if (p.trim()) out.add(p.trim());
  } catch {
    /* a repo git cannot read gets no scoping — the caller falls back to full */
  }
  return [...out].sort();
}

/** Rule ids that would have selected `stage`, for the SKIP line's reason. */
const rulesSelecting = (stage) => RULES.filter((r) => r.stages.includes(stage)).map((r) => r.id);

/** The lanes of verify/run-delivery-fast.mjs, keeping only the selected steps.
 *  Reusing its step OBJECTS verbatim keeps their env with them — CARGO_BUILD_JOBS
 *  on the cargo steps and FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT on GOLDEN — so this
 *  runner cannot drift from the hazards that file documents. */
export function lanesFor(stages) {
  const want = new Set(stages);
  return LANES.map((lane) => ({
    ...lane,
    steps: lane.steps.filter((s) => s.cmd === 'pnpm' && want.has(s.args[0])),
  })).filter((lane) => lane.steps.length > 0);
}

/**
 * Everything the run WOULD do, decided before anything is spawned.
 * Exported so scripts/lane-gate.test.mjs can assert on the plan without paying
 * for a gate run — the same shape as `planCommands()` in the fast runner.
 */
export function buildPlan({ paths, base, baseWhy, full = false, fullWhy = '' }) {
  const sel = full
    ? { stages: [...FULL_STAGES], matched: [], unmapped: [], ignored: [], stage0: true }
    : selectStages(paths);
  const stages = sel.stages;
  const skipped = FULL_STAGES.filter((s) => !stages.includes(s));
  const stage0 = stages.length > 0 && (full || needsStage0(new Set(stages)));
  const lanes = lanesFor(stages);
  const commands = [
    ...(stage0 ? STAGE0_LANE.map((t) => `${t.cmd} ${t.args.join(' ')}`) : []),
    ...lanes.flatMap((l) => l.steps.map((s) => `${s.cmd} ${s.args.join(' ')}`)),
  ];
  return {
    base,
    baseWhy,
    full,
    fullWhy,
    paths,
    stages,
    skipped,
    stage0,
    lanes,
    commands,
    matched: sel.matched,
    unmapped: sel.unmapped,
    ignored: sel.ignored,
  };
}

/** The last line, and it is not decoration. See the header.
 *  `PLAN` says "would run" rather than "ran" because a plan that claims to have
 *  run something is the same lie in miniature that this whole file is against. */
export function summaryLine(plan, verdict) {
  const [ranWord, skipWord] = verdict === 'PLAN' ? ['would run', 'would skip'] : ['ran', 'skipped'];
  return (
    `LANE GATE ${verdict} | ${ranWord}: ${plan.stages.join(', ') || '(none)'}` +
    ` | ${skipWord}: ${plan.skipped.join(', ') || '(none)'}`
  );
}

function printPlan(plan, out) {
  out(`\n  base:    ${plan.base ? plan.base.slice(0, 12) : '(none)'}  — ${plan.baseWhy}\n`);
  out(`  paths:   ${plan.paths.length} changed\n`);
  if (plan.full) {
    out(`  scope:   EVERY STAGE — ${plan.fullWhy}\n`);
  } else {
    const names = plan.matched.map((m) => `${m.rule.id}(${m.paths.length})`).join(', ');
    out(`  rules:   ${names || '(none matched)'}\n`);
  }
  if (plan.ignored.length > 0) out(`  ignored: ${plan.ignored.length} gitignored path(s)\n`);
  // Fail closed, and say so per path: an unmapped path is a table that has not
  // caught up with the tree, and the only place anyone will see that is here.
  for (const p of plan.unmapped) out(`  UNMAPPED ${p} → running every stage\n`);
  out('\n');
  if (plan.stage0) {
    out('  STAGE 0 (barrier — a selected stage reads packages/protocol/dist)\n');
    for (const t of STAGE0_LANE) out(`    - ${t.cmd} ${t.args.join(' ')}\n`);
  } else {
    // Unreachable for any non-empty selection since `verify:scripts` became
    // unconditional AND a dist reader (verify/lane-map.mjs `ALWAYS` and
    // `DIST_READERS`). Kept rather than deleted because it is the branch that
    // will describe the world correctly again the day scripts/ stops bundling
    // server-core source — and because a runner that always prints "barrier"
    // teaches the reader nothing about why.
    out('  STAGE 0  not needed: no selected stage reads packages/protocol/dist\n');
  }
  out('\n');
  for (const lane of plan.lanes) {
    out(`  RUN  ${lane.name.padEnd(8)} ${lane.steps.map((s) => s.args.join(' ')).join(' , ')}\n`);
  }
  // One line per skipped stage. Never "and the rest were skipped": a reader who
  // cannot see WHICH stage was skipped cannot tell this run from a full one.
  for (const s of plan.skipped) {
    const rules = rulesSelecting(s);
    out(
      `  SKIP ${s}  not selected: no changed path matches (rules: ${rules.join(', ') || 'none — only an unmapped path can select it'})\n`
    );
  }
}

export async function main(argv = process.argv.slice(2), { out = (s) => process.stdout.write(s) } = {}) {
  const planOnly = argv.includes('--plan') || argv.includes('--dry-run');
  const baseArg = argv.find((a) => a === '--base' || a.startsWith('--base='));
  let override = null;
  if (baseArg) {
    override = baseArg.startsWith('--base=')
      ? baseArg.slice('--base='.length)
      : argv[argv.indexOf(baseArg) + 1];
  }
  // TEST HOOK — `--paths a,b,c` substitutes a synthetic diff for git's answer.
  // It exists so scripts/lane-gate.test.mjs can pin the table's behaviour on a
  // docs-only or unknown-path diff without making commits in a scratch clone.
  // It is inert without `--plan`: a synthetic path list may decide what to
  // PRINT, never what to RUN, so it cannot become a way to run a narrower gate
  // than the tree deserves.
  const pathsArg = argv.find((a) => a.startsWith('--paths='));

  out(
    '\n' +
      '========================================================================\n' +
      '  LANE GATE (T1) - SCOPED TO YOUR DIFF. NOT the release gate, and not\n' +
      '  the full parallel gate either. Before merging to main run\n' +
      '  `pnpm verify:delivery:fast`; a release runs `pnpm verify:delivery`,\n' +
      '  the only run that writes a gate receipt. This one writes none and\n' +
      '  deletes none.\n' +
      '========================================================================\n'
  );

  const { base, why: baseWhy } = resolveBase({ override });

  let paths;
  let full = false;
  let fullWhy = '';
  if (pathsArg) {
    if (!planOnly) {
      out('\nx --paths is a test hook and only works with --plan.\n');
      return 1;
    }
    paths = pathsArg
      .slice('--paths='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (!base) {
    full = true;
    fullWhy = `${baseWhy} ⇒ nothing to diff against, so nothing may be skipped`;
    paths = [];
  } else {
    paths = changedPaths({ base });
  }

  const plan = buildPlan({ paths, base, baseWhy, full, fullWhy });

  // The forbidden-command check runs on OUR plan, before a single spawn, rather
  // than living only in a drill: a runner that grew a `verify:preflight` would
  // otherwise delete a standing release proof on the next run somebody made.
  const illegal = plan.commands.filter((c) => FORBIDDEN_IN_LANE_PLAN.some((f) => c.includes(f)));
  if (illegal.length > 0) {
    out(`\nx this plan contains a forbidden command: ${illegal.join(' | ')}\n`);
    out('  The gate receipt has exactly one writer and it is the sequential gate.\n');
    return 1;
  }

  printPlan(plan, out);

  if (plan.stages.length === 0) {
    out(`\n  nothing to run: no changed path selects any stage.\n`);
    out(`\n${summaryLine(plan, 'EMPTY')}\n`);
    return 0;
  }

  if (planOnly) {
    out('\n(--plan: nothing was executed, no receipt touched)\n');
    out(`\n${summaryLine(plan, 'PLAN')}\n`);
    return 0;
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const t0 = Date.now();
  const mmss = (ms) => {
    const s = Math.round(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  if (plan.stage0) {
    // The heading names what actually runs. It said "preflight || protocol-dist"
    // for one commit after the probe was dropped — copied from the fast runner,
    // where it is still true. A heading is a claim about the run underneath it.
    out(`\nSTAGE 0  ${STAGE0_LANE.map((t) => t.name).join(' || ')} (barrier)\n`);
    const { failed } = await runLanes(
      STAGE0_LANE.map((t) => ({ name: `stage0-${t.name}`, steps: [t] })),
      { logDir: LOG_DIR }
    );
    if (failed.length > 0) {
      for (const f of failed) {
        out(`  FAIL ${f.lane}  exit ${f.code}  ${path.relative(ROOT, f.logPath)}\n`);
        out(`${tail(f.logPath)}\n`);
      }
      out('\nx STAGE 0 failed - no lane started. Nothing below was verified.\n');
      out(`\n${summaryLine({ ...plan, stages: [] }, 'RED')}\n`);
      return 1;
    }
    out(`  ok  stage 0  ${mmss(Date.now() - t0)}\n`);
  }

  out(`\nSTAGE 1  ${plan.lanes.length} lane(s), concurrent\n`);
  const { results, failed, exitCode } = await runLanes(plan.lanes, {
    logDir: LOG_DIR,
    onDone: (r) =>
      out(
        `  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.lane.padEnd(8)} ${mmss(r.ms)}  exit ${r.code}` +
          `${r.failedStep ? `  <- \`${r.failedStep}\`` : ''}\n`
      ),
  });
  for (const r of failed) {
    out(`\n-- ${r.lane} (last 40 lines of ${path.relative(ROOT, r.logPath)}) --\n${tail(r.logPath)}\n`);
  }
  out(`\n  total wall: ${mmss(Date.now() - t0)}   (${results.length} lane(s))\n`);
  if (exitCode !== 0) {
    // The same caveat the fast runner prints, for the same measured reason
    // (hazard 5 in verify/run-delivery-fast.mjs): lanes share one machine and
    // two suites contain assertions that race a wall clock.
    out('\n  A red lane is not yet a verdict about the product — re-run that stage alone.\n');
  }
  out(`\n${summaryLine(plan, exitCode === 0 ? 'OK' : 'RED')}\n`);
  return exitCode;
}

function tail(file, lines = 40) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/** The receipt files this runner must never create, move, or remove. Same list
 *  the fast runner exports; repeated here so the drill can snapshot them around
 *  a run of THIS file. */
export const RECEIPT_PATHS = [
  path.join(ROOT, '.local', 'gate-receipt.json'),
  path.join(ROOT, '.local', 'gate-receipt.pending.json'),
];
export const existingReceipts = () => RECEIPT_PATHS.filter((p) => existsSync(p));

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code));
}
