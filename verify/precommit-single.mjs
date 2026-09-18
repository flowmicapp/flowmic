#!/usr/bin/env node
// verify/precommit-single.mjs — T0 (the commit gate) as ONE node process.
// SC-10, design 2026-09-17-ship-chain-eight-minute-design.md §5 (SC-10 row).
//
// WHY THIS EXISTS. `.husky/pre-commit` used to be two lines — `pnpm
// verify:lint` (which is itself `pnpm` spawning a `node` for
// verify/lint/run-all.mjs) and `node verify/precommit-types.mjs` — three
// process starts total (pnpm, node, node) for two stages of actual checking.
// verify/precommit-types.mjs's own header logged this as an open item in
// 2026-09-13 ("running the whole hook as ONE node process instead of two pnpm
// launches plus a node... is worth more than any further slicing of checks,
// and it removes no coverage") and deliberately did not build it. This file
// is that: it imports each stage's own main() and awaits them in the same
// process, instead of re-entering through `pnpm`/a second `node`.
//
// SAME STAGE SET, SAME OUTPUT, ONLY THE PROCESS COUNT CHANGES. Both
// verify/lint/run-all.mjs's main() and verify/precommit-types.mjs's main()
// print their own PASS/SKIP/FAIL lines and their own summary exactly as they
// did when invoked as separate processes — this file adds no console output
// of its own beyond the two stages' unmodified writes, and returns their exit
// codes unmodified. `git diff <SC-10 lane>...HEAD -- verify/lint/run-all.mjs
// verify/precommit-types.mjs` shows only the process.exit()-vs-return change
// documented in each file's own header; neither stage's checking logic moved.
//
// FAIL-FAST, MATCHING THE OLD TWO-LINE HOOK'S ACTUAL SEMANTICS — not the
// naive "two lines run either way" reading. `.husky/_/h` invokes every hook
// file as `sh -e "$s"` (`.husky/_/h`, measured 2026-09-17): with `-e`, a
// nonzero `pnpm verify:lint` aborts the script before the second line is ever
// reached, and the script's own exit code is that nonzero status. This file
// reproduces exactly that: lint runs first, and a nonzero result returns
// immediately WITHOUT running the type check.
//
// MEASURED (dev-pc-a, 2026-09-17/18), three real `git commit`s each, before
// (two-line hook: `pnpm verify:lint` then `node verify/precommit-types.mjs`)
// and after (this file), sampled the same way verify/precommit-types.mjs's
// own header samples them (no other lane holding the machine lock):
//
//   docs-only touch (CHANGELOG.md, no staged TS -> "nothing to do" for types)
//     before  median  see .husky/pre-commit's own comment for the two-line baseline
//     after   median  <written into .husky/pre-commit alongside this file>
//   apps/server-core/src change (the one project verify/precommit-types.mjs's
//   own header calls its worst case)
//     before / after  <written into .husky/pre-commit>
//
// The full three-run tables and the process-count accounting live in
// .husky/pre-commit's own comment block, right above the one line that now
// invokes this file — kept there, not here, because that is where the
// decision this measurement supports is made and where the next reader who
// wants to know "why one process" will already be looking.

import { pathToFileURL } from 'node:url';

import { main as runLint } from './lint/run-all.mjs';
import { main as runTypes } from './precommit-types.mjs';

export async function main() {
  const lintCode = await runLint();
  if (lintCode !== 0) return lintCode;
  return runTypes();
}

// Entry-point guard — same pattern as verify/lint/run-all.mjs and
// verify/precommit-types.mjs. Load-bearing here in a way it is not in either
// of those: scripts/lane-gate.test.mjs imports THIS module to read its source
// and confirm both stages are wired (the SC-10 reverse control). Without this
// guard, that `import()` would itself run the full commit gate inside the
// test process and then call process.exit() — killing the test runner mid
// suite, not failing one assertion.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => process.exit(code));
}
