#!/usr/bin/env node
// Drill for verify/run-lane-gate.mjs — T1, the scoped gate.
//
// A scoped gate can lie in exactly three ways, and each section below is one of
// them. None of them is caught by "does it exit 0".
//
//   1. IT SKIPS SOMETHING WITHOUT SAYING SO. The whole safety of scoping rests
//      on the reader being able to see what did not run. So: one `SKIP <stage>`
//      line per unselected stage — never a summarising sentence — and a last
//      line that names both sets. Design §9-1 refuses a run that ends on a bare
//      "ok".
//   2. IT TOUCHES THE RELEASE GATE'S RECEIPT. `pnpm verify:preflight` is
//      preflight + `gate-receipt.mjs --begin`, and `begin()` UNLINKS the
//      standing `.local/gate-receipt.json` as its first act. A quick scoped run
//      that quietly destroyed a valid release proof would be discovered by
//      `scripts/publish.mjs` re-running the whole sequential gate for no
//      visible reason. Both directions checked, and the plan is scanned for the
//      forbidden strings with a positive control so the scan cannot be blind.
//   3. IT SCOPES A DIFF IT CANNOT SEE. An unmapped path must select everything
//      and say `UNMAPPED` — the table falling behind the tree has to be loud.
//
// Section 4b pins the one deliberate difference between T1's Stage 0 and the
// fast runner's: T1 builds the protocol dist and does NOT probe the toolchain
// (ruling MAIN 2026-09-13 — the probe exists to stamp a release receipt, costs
// ~12.6 s, and T1 writes no receipt).
//
// Section 7 covers T0 (`.husky/pre-commit` + verify/precommit-types.mjs), whose
// one non-obvious requirement is a compiler flag. Dropping `--tsBuildInfoFile`
// does NOT fail loudly under `-p <tsconfig>` (measured 2026-09-13, tsc 5.9.3:
// exit 0) — it succeeds and drops `apps/server-core/tsconfig.tsbuildinfo` into
// the working tree, where `git status --porcelain` reports it and
// scripts/gate-receipt.mjs fingerprints it. A type check with a side effect on
// the evidence is the quiet version of the failure, so the flag is pinned here.
//
// EXIT CODES (scripts/run-script-tests.mjs): 0 PASS, 1 FAIL, 2 SKIP.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RUNNER = path.join(ROOT, 'verify', 'run-lane-gate.mjs');

const gate = await import(pathToFileURL(RUNNER).href);
const map = await import(pathToFileURL(path.join(ROOT, 'verify', 'lane-map.mjs')).href);
const fast = await import(pathToFileURL(path.join(ROOT, 'verify', 'run-delivery-fast.mjs')).href);
const pre = await import(pathToFileURL(path.join(ROOT, 'verify', 'precommit-types.mjs')).href);

const { buildPlan, summaryLine, lanesFor, RECEIPT_PATHS, STAGE0_LANE, FORBIDDEN_IN_LANE_PLAN } = gate;
const { FULL_STAGES } = map;
const { FORBIDDEN_IN_PLAN } = fast;

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

/** Run the real CLI in plan mode with a synthetic diff. `--paths` is a
 *  test-only hook and the runner refuses it without `--plan`, which section 3
 *  checks — a synthetic path list may decide what is PRINTED, never what runs. */
const plan = (paths, extra = []) =>
  spawnSync(process.execPath, [RUNNER, '--plan', `--paths=${paths.join(',')}`, ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
  });

const lastLine = (s) =>
  `${s}`.split('\n').map((l) => l.trimEnd()).filter(Boolean).pop() ?? '';

// ---------------------------------------------------------------------------
section('1 a docs-only diff runs lint, and says what it did not run');

const docs = plan(['docs/x.md'], ['--base', 'HEAD']);
check(docs.status === 0, `--plan exits 0 (got ${docs.status})`);
const docsOut = docs.stdout ?? '';
check(/RUN\s+TSC\s+verify:lint/.test(docsOut), 'it plans verify:lint');
// RULING (MAIN, 2026-09-13): `verify:scripts` is unconditional, so a docs-only
// diff is TWO stages and not one. scripts/ is not only release tooling —
// scripts/w2-eval-corpus.test.mjs:147 bundles the production compose guard
// apps/server-core/src/compose/output-guard.ts, so scoping it away would skip a
// real gate to save the whole set's measured 10.9 s.
check(/RUN\s+SCRIPTS\s+verify:scripts/.test(docsOut), 'it also plans verify:scripts');
const UNCONDITIONAL = ['verify:lint', 'verify:scripts'];
const skipLines = docsOut.split('\n').filter((l) => /^\s*SKIP /.test(l));
check(
  skipLines.length === FULL_STAGES.length - UNCONDITIONAL.length,
  `one SKIP line per unselected stage (${skipLines.length} lines, ${FULL_STAGES.length - UNCONDITIONAL.length} unselected)`,
);
check(
  !skipLines.some((l) => UNCONDITIONAL.some((u) => l.includes(`SKIP ${u} `))),
  'neither unconditional stage is ever reported as skipped',
);
for (const stage of FULL_STAGES.filter((s) => !UNCONDITIONAL.includes(s))) {
  check(
    skipLines.some((l) => l.includes(`SKIP ${stage} `)),
    `\`${stage}\` has its own SKIP line`,
  );
}
check(
  skipLines.every((l) => /not selected: /.test(l)),
  'every SKIP line carries a reason, not just the stage name',
);
// REVERSE CONTROL for the count above: a diff that selects everything must
// produce ZERO skip lines, otherwise the assertion would also pass against a
// runner that prints a fixed block of SKIPs.
const everything = plan(['packages/protocol/src/constants.ts']);
check(
  everything.stdout.split('\n').filter((l) => /^\s*SKIP /.test(l)).length === 0,
  'a full-set diff prints no SKIP lines at all',
);
check(/STAGE 0 \(barrier/.test(everything.stdout), 'a protocol diff plans the Stage 0 barrier');
// Stage 0 runs even here, and that is a cost worth pinning rather than
// rediscovering: `verify:scripts` bundles server-core source, which needs
// packages/protocol/dist. Measured — with the dist moved aside
// scripts/w2-eval-corpus.test.mjs prints `FAILED sections: replay, guard`. A
// fresh worktree has no dist, so without the barrier this would be a red about
// somebody's checkout rather than about their code.
check(
  /STAGE 0 \(barrier/.test(docsOut),
  'a docs-only diff still runs the Stage 0 barrier (verify:scripts reads the dist)',
);

// ---------------------------------------------------------------------------
section('2 the last line names both sets, always');

for (const [label, r] of [['docs-only', docs], ['full', everything]]) {
  const line = lastLine(r.stdout);
  check(line.startsWith('LANE GATE '), `${label}: the last line is the summary (got: ${line.slice(0, 60)})`);
  check(/would run:|ran:/.test(line), `${label}: the summary names what ran`);
  check(/would skip:|skipped:/.test(line), `${label}: the summary names what was skipped`);
}
check(
  lastLine(docs.stdout).includes('verify:golden') === false &&
    lastLine(docs.stdout).includes('golden'),
  'the docs-only summary lists golden among the skipped stages',
);
// The summary must be derived, not typed: a plan with different contents must
// produce a different line.
check(
  lastLine(docs.stdout) !== lastLine(everything.stdout),
  'two different plans produce two different summary lines',
);
check(
  summaryLine({ stages: ['a'], skipped: ['b'] }, 'PLAN') === 'LANE GATE PLAN | would run: a | would skip: b',
  'a plan summary says "would run", not "ran"',
);
check(
  summaryLine({ stages: ['a'], skipped: [] }, 'OK') === 'LANE GATE OK | ran: a | skipped: (none)',
  'a real summary says "ran", and an empty set is spelled out rather than blank',
);

// ---------------------------------------------------------------------------
section('3 unmapped paths fail closed and say so');

const unknown = plan(['zzz/x.txt']);
check(unknown.status === 0, 'an unmapped path still plans cleanly');
check(
  /UNMAPPED zzz\/x\.txt → running every stage/.test(unknown.stdout),
  'the unmapped path is named on its own line',
);
check(
  unknown.stdout.split('\n').filter((l) => /^\s*SKIP /.test(l)).length === 0,
  'an unmapped path leaves nothing skipped',
);
const unknownRan = /(?:would run|ran): ([^|]+)/.exec(lastLine(unknown.stdout))?.[1]?.trim() ?? '';
check(
  unknownRan.split(', ').length === FULL_STAGES.length,
  `the summary of an unmapped diff lists every stage (${unknownRan.split(', ').length}/${FULL_STAGES.length})`,
);
// The hook must not become a way to run a narrower gate than the tree deserves.
const hookWithoutPlan = spawnSync(process.execPath, [RUNNER, '--paths=docs/x.md'], {
  cwd: ROOT,
  encoding: 'utf8',
});
check(hookWithoutPlan.status === 1, '`--paths` without `--plan` is refused');
check(
  /--paths is a test hook/.test(hookWithoutPlan.stdout ?? ''),
  'and it says why, rather than silently running something else',
);

// ---------------------------------------------------------------------------
section('4 the release gate receipt is neither written nor deleted');

// The scanned list is the runner's own, which is the fast runner's plus the
// toolchain probe — see FORBIDDEN_IN_LANE_PLAN and the ruling in section 4b.
for (const paths of [['docs/x.md'], ['packages/protocol/src/constants.ts'], ['zzz/x.txt']]) {
  const p = buildPlan({ paths, base: 'HEAD', baseWhy: 'drill' });
  for (const forbidden of [...FORBIDDEN_IN_PLAN, ...FORBIDDEN_IN_LANE_PLAN]) {
    check(
      !p.commands.some((c) => c.includes(forbidden)),
      `the plan for ${paths[0]} contains no \`${forbidden}\``,
    );
  }
}
// POSITIVE CONTROL: a plan that had gone empty would pass every "does not
// contain" assertion above for entirely the wrong reason. It cannot be the
// preflight spawn any more (section 4b), so the barrier itself is the control.
const fullPlan = buildPlan({ paths: ['zzz/x.txt'], base: 'HEAD', baseWhy: 'drill' });
check(fullPlan.commands.length >= 12, `the full plan is not empty (${fullPlan.commands.length} commands)`);
check(
  fullPlan.commands.some((c) => c.includes('verify:protocol-dist')),
  'the full plan DOES build the protocol dist in Stage 0 (so the scan is not blind)',
);
check(
  fullPlan.commands.some((c) => c.includes('verify:mobile-tests')),
  'and it DOES reach the far end of the lane table',
);

// ---------------------------------------------------------------------------
section('4b Stage 0 is the protocol dist barrier and nothing else');

// RULING (MAIN, 2026-09-13). The fast runner's Stage 0 is preflight + dist; T1
// keeps only the dist. scripts/preflight-toolchain.mjs exists to produce the
// readings that stamp a release receipt (gate-receipt.mjs's toolStamp is built
// from its probeTools), it costs ~12.6 s — almost all of it `flutter --version`
// — and T1 writes no receipt. Asserting on the PLAN and not on the source,
// because what matters is what gets spawned.
check(STAGE0_LANE.length === 1, `T1's Stage 0 is exactly one task (got ${STAGE0_LANE.length})`);
check(
  STAGE0_LANE[0]?.args.join(' ').includes('verify:protocol-dist'),
  'and that task is the protocol-dist build',
);
check(
  fast.STAGE0.some((t) => t.args.join(' ').includes('preflight-toolchain')),
  "the fast runner DOES still probe the toolchain (so the check above is a difference, not a tree with no preflight in it at all)",
);
for (const paths of [['docs/x.md'], ['zzz/x.txt'], ['apps/desktop/src-tauri/src/main.rs']]) {
  const p = buildPlan({ paths, base: 'HEAD', baseWhy: 'drill' });
  check(
    !p.commands.some((c) => /preflight/.test(c)),
    `the plan for ${paths[0]} spawns no preflight of any spelling`,
  );
}
// The RUN-MODE heading is a claim about what is executing under it, and it was
// wrong for one commit: it still read "preflight || protocol-dist", copied from
// the fast runner where that is still true. Pinned by deriving it from
// STAGE0_LANE, and asserted here on the source because only a real run prints it.
const runnerSrcForHeading = readFileSync(RUNNER, 'utf8');
check(
  !/STAGE 0  preflight \|\| protocol-dist/.test(runnerSrcForHeading),
  'the run-mode Stage 0 heading no longer names a preflight this gate does not run',
);
check(
  /STAGE 0  \$\{STAGE0_LANE\.map/.test(runnerSrcForHeading),
  'and it is derived from STAGE0_LANE rather than typed, so it cannot drift again',
);
const runnerHasSpawn = /STAGE0_LANE|STAGE0/.test(readFileSync(RUNNER, 'utf8'));
check(runnerHasSpawn, 'the runner still derives its barrier from the fast runner rather than re-spelling the command');

const runnerSrc = readFileSync(RUNNER, 'utf8');
check(
  !/verify:preflight|verify:receipt/.test(runnerSrc.replace(/^\s*(\/\/|\*).*$/gm, '')),
  'the runner does not name verify:preflight or verify:receipt outside its comments',
);

const snapshot = () =>
  RECEIPT_PATHS.map((p) => {
    if (!existsSync(p)) return `${path.basename(p)}:absent`;
    const st = statSync(p);
    return `${path.basename(p)}:${st.size}:${st.mtimeMs}`;
  }).join('|');
const before = snapshot();
plan(['packages/protocol/src/constants.ts']);
check(snapshot() === before, 'a --plan run left both receipt files exactly as it found them');

// ---------------------------------------------------------------------------
section('5 verify:scripts is unconditional — no path can scope it away');

// 🔴 THIS SECTION USED TO ASSERT THE OPPOSITE, and the old version is worth a
// sentence because it is the shape CLAUDE.md warns about: a reverse control
// pointed the wrong way pins the defect as the specification. Design §4c argued
// scripts/ holds release-tooling drills that a change to apps/mobile/lib cannot
// break, and this drill dutifully asserted `apps/server-core/src/index.ts` does
// NOT select verify:scripts. That assertion was green and wrong:
// scripts/w2-eval-corpus.test.mjs:147 loads
// apps/server-core/src/compose/output-guard.ts — the production compose guard —
// and `:18` the production accumulator fold apps/server-core/src/stt/text-merge.ts,
// both through esbuild. So the one path the old table was most confident about
// skipping was a path with a resident production gate behind it.
// Ruling MAIN 2026-09-13; the skip bought 10.9 s (ledger §7).
for (const p of [
  'scripts/publish.mjs',
  'verify/lint/run-all.mjs',
  'verify/run-delivery-fast.mjs',
  'package.json',
  '.husky/pre-commit',
  '.github/workflows/private-nightly.yml',
  'apps/desktop/scripts/build-sidecar.mjs',
  'apps/mobile/lib/src/ui/tokens.dart',
  'apps/server-core/src/index.ts',
  'apps/server-core/src/compose/output-guard.ts',
  'apps/server-core/src/stt/text-merge.ts',
  'docs/x.md',
  'i18n/desktop/en.json',
  'packages/protocol/src/constants.ts',
  'zzz/unmapped.txt',
]) {
  const stages = map.selectStages([p]).stages;
  check(stages.includes('verify:scripts'), `\`${p}\` selects verify:scripts`);
  check(stages.includes('verify:lint'), `\`${p}\` selects verify:lint`);
}
// REVERSE CONTROL: the selector must still be capable of leaving a stage out,
// or the loop above passes against a table that selects everything for
// everything — which would make the whole lane gate pointless while looking
// exactly like this.
const docsStages = map.selectStages(['docs/x.md']).stages;
check(!docsStages.includes('golden'), 'a docs-only diff still leaves golden out');
check(docsStages.length === 2, `a docs-only diff is still only two stages (got ${docsStages.length})`);

// ---------------------------------------------------------------------------
section('6 the lanes are the fast runner\'s lanes, filtered');

const lanes = lanesFor(['verify:lint', 'golden', 'verify:clippy']);
check(lanes.length === 3, `three stages land in three lanes (got ${lanes.length})`);
const golden = lanes.find((l) => l.name === 'GOLDEN');
check(
  golden?.steps.every((s) => s.env?.FLOWMIC_GATE_PROTOCOL_DIST_PREBUILT === '1'),
  'the GOLDEN step keeps the prebuilt-dist flag it carries in the fast runner',
);
check(
  map.DIST_READERS.has('golden'),
  'and golden is a dist reader, so selecting it always brings the Stage 0 that makes that flag true',
);
const rust = lanes.find((l) => l.name === 'RUST');
check(
  rust?.steps.every((s) => /^[0-9]+$/.test(s.env?.CARGO_BUILD_JOBS ?? '')),
  'the cargo step keeps its CARGO_BUILD_JOBS cap (hazard 5 in run-delivery-fast.mjs)',
);
check(lanesFor([]).length === 0, 'an empty selection produces no lanes');

// ---------------------------------------------------------------------------
section('7 T0: the commit hook and its incremental type check');

const hook = readFileSync(path.join(ROOT, '.husky', 'pre-commit'), 'utf8');
check(/^pnpm verify:lint$/m.test(hook), 'the hook still runs the whole verify:lint');
check(/verify\/precommit-types\.mjs/.test(hook), 'the hook runs the scoped type check');
check(
  !/^pnpm verify:types$/m.test(hook),
  'the hook no longer runs the cold four-package verify:types',
);
// PATH A, KEPT — and the decision had a reversal in it, so the hook must carry
// the readings rather than just the verdict. Median total 11086 ms, median
// types 3.4 s (budget 4 s). The 1.1 s the total is over by is process startup,
// not checking, and paying for startup by deleting a check is the wrong trade.
check(!/TIMING: pending/.test(hook), 'the pending-measurement marker is gone');
check(
  /11086ms/.test(hook) && /3\.4s/.test(hook) && /7130ms/.test(hook),
  'all three readings are written down where the decision is',
);
check(/PATH A, KEPT/.test(hook), 'and the decision is named rather than left to be inferred');
check(
  /ONE node process/.test(hook),
  'the open item (one node process for the whole hook) is logged, not silently dropped',
);

for (const proj of pre.TS_PROJECTS) {
  const args = pre.tscArgs(proj);
  // Drop this flag and the run still exits 0 — measured, tsc 5.9.3 with
  // `-p <tsconfig>` — while writing a buildinfo into the working tree
  // (apps/server-core/tsconfig.tsbuildinfo, which `git status --porcelain`
  // reports and scripts/gate-receipt.mjs then fingerprints). The quiet version
  // of the failure, which is why it is pinned here.
  check(args.includes('--tsBuildInfoFile'), `${proj.id}: --tsBuildInfoFile is passed`);
  check(args.includes('--incremental'), `${proj.id}: --incremental is passed`);
  check(args.includes('--noEmit'), `${proj.id}: --noEmit is passed`);
  check(existsSync(path.join(ROOT, proj.project)), `${proj.id}: ${proj.project} exists`);
}
// The buildinfo files must land somewhere git ignores, or the hook would dirty
// the tree it is about to let you commit.
check(
  pre.tscArgs(pre.TS_PROJECTS[0]).some((a) => a.replace(/\\/g, '/').startsWith('.local/')),
  'the buildinfo lives under .local/ (gitignored, and pruned by every tree walker in verify/)',
);

// A staged protocol change must select ALL FOUR projects and rebuild the dist:
// the other three read `packages/protocol/dist/index.d.ts`.
const protoSel = pre.selectProjects(['packages/protocol/src/constants.ts']);
check(protoSel.rebuildProtocol === true, 'a staged protocol change rebuilds the dist first');
check(
  protoSel.projects.length === pre.TS_PROJECTS.length,
  `a staged protocol change checks every package (${protoSel.projects.length}/${pre.TS_PROJECTS.length})`,
);
const serverSel = pre.selectProjects(['apps/server-core/src/index.ts']);
check(serverSel.rebuildProtocol === false, 'a server-core change does not rebuild the protocol dist');
check(
  serverSel.projects.map((p) => p.id).join(',') === 'server-core',
  `a server-core change checks server-core only (got ${serverSel.projects.map((p) => p.id).join(',')})`,
);
check(
  pre.selectProjects(['docs/x.md']).projects.length === 0,
  'a docs-only commit runs no compiler at all',
);
// "cannot tell" must mean "check everything", never "check nothing".
check(
  pre.selectProjects(null).projects.length === pre.TS_PROJECTS.length,
  'if git cannot list the staged files, every package is checked',
);

// KEPT FROM THE PATH-B ROUND ON PURPOSE. T0 catches type errors at commit time,
// but a second net one layer up costs nothing to assert and answers "what if
// somebody commits with --no-verify": every rule covering TypeScript must also
// select a type-checking stage at T1.
for (const [tsPath, want] of [
  ['packages/protocol/src/constants.ts', 'verify:types'],
  ['apps/server-core/src/index.ts', 'verify:types'],
  ['apps/server-core/test/plan-limits.test.ts', 'verify:types'],
  ['packages/stt-cloud/src/index.ts', 'verify:types'],
  ['packages/i18n-web/src/index.ts', 'verify:types'],
  ['apps/desktop/src/main.ts', 'verify:types:desktop'],
  ['i18n/desktop/en.json', 'verify:types:desktop'],
]) {
  check(
    map.selectStages([tsPath]).stages.includes(want),
    `a change to \`${tsPath}\` also meets \`${want}\` at T1`,
  );
}
// REVERSE CONTROL: the selector must be able to leave a type check out, or the
// loop above passes against a table that selects everything for everything.
check(
  !map.selectStages(['docs/x.md']).stages.includes('verify:types'),
  'a docs-only diff still does not drag in a type check',
);

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} lane-gate: ${checks - failures}/${checks} checks`);
console.log(`ACCOUNTING: sections run 8/8, checks ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
