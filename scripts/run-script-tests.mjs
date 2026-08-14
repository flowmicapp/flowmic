#!/usr/bin/env node
// Runner for the release-tooling tests that live beside the scripts they test
// (`scripts/*.test.mjs`).
//
// WHY THIS EXISTS (measured, 2026-08-05, card IT-07/IT-11 acceptance):
//   Two such test files existed — `s8-release-script-defects.test.mjs` and
//   `it07-it11-publish-flags.test.mjs` — and NOTHING invoked either one.
//   `verify:delivery` is lint + types + clippy + golden; none of those reach a
//   `scripts/*.test.mjs`. So both were green only in the sense that nobody had
//   ever asked them.
//
//   CLAUDE.md names this exact failure: 「测试写了没人叫 = façade 的运行时版：
//   它红着和不存在是一回事」. It was learned from G12, which sat RED for a day
//   because the golden path was not in any gate that actually ran.
//
//   These tests guard the release path specifically — the argument parsing that
//   decides whether `--dry-run` really means dry-run, and the artifact-name
//   predicates the publisher uses. That is the one code path whose failure mode
//   is "we shipped the wrong thing", so it belongs in the pre-delivery gate.
//
// DISCOVERY, NOT A LIST — deliberately. This globs `scripts/*.test.mjs` instead
// of naming files, so a test added next year is picked up on the day it is
// written rather than on the day someone remembers to register it. CLAUDE.md
// records the counter-example in this same repo: `verify:lint` walks the
// directory while `bump-version.mjs`'s FACES table is hand-maintained, so a new
// workspace package is green the day it is added and only goes red at the NEXT
// bump — two mechanisms answering one question, and the hand-kept one drifts.
//
// Each file runs in its own child process: these are standalone scripts that
// call `process.exit()`, so importing them into one process would let the first
// exit swallow the rest.
//
// EXIT CODES a child file may use, and what each means here (card IT-38):
//   0 = PASS  — verified, green.
//   1 = FAIL  — verified, red (also whatever spawnSync reports for a crash).
//   2 = SKIP  — did NOT verify anything, on purpose, for a stated reason (e.g.
//               a gitignored build artifact the test needs was never staged).
//               A skip is not a pass — CLAUDE.md's rule against reporting an
//               unattempted check as done applies here exactly as it does to
//               product status text. This runner keeps SKIP in its own bucket
//               and, below, refuses to call the overall run "OK" if every
//               discovered file skipped — that would verify nothing while
//               reporting success. A skipping file MUST print exactly one
//               line matching `/^SKIP: /m` to stdout; that line is the reason
//               a human reads, quoted verbatim, in the summary. Exit 2 with
//               no such line is treated as a malformed skip and escalated to
//               FAIL — a skip nobody can read the reason for is the same
//               invisible-explanation shape this convention exists to avoid.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const files = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  // Not silently fine. This runner is wired into a gate; if it ever finds
  // nothing, that is far more likely to mean the glob broke than that every
  // release-tooling test was deliberately deleted. Fail loud — an empty pass is
  // exactly the "nothing happened, reported as success" shape IT-11 fixed.
  //
  // NO EXPORT-TREE EXCEPTION IS NEEDED HERE, and that is deliberate (cards
  // IT-22/IT-23). The open-source export drops some of these tests along with
  // the subjects they drill (IT-12: a test and its subject travel together or
  // not at all), so "the exported tree has zero tests" was a real prospect —
  // which would have made this `exit 1` fire on a contributor's first
  // `pnpm verify:delivery`. The fix was to keep at least one test/subject pair
  // whole in the export, not to teach this runner a "legally empty" third
  // state: that state would re-introduce the silent pass this branch exists to
  // prevent, and would only ever be exercised in a tree nobody develops in.
  // The invariant is enforced, not remembered — checkTestSubjectPairs() in
  // scripts/opensource-export.mjs fails the export when the kept set has no
  // surviving `scripts/*.test.mjs`, or when a kept test references a script
  // that was excluded. Rationale:
  // docs/decisions/2026-08-06-script-tests-travel-with-their-subjects.md.
  console.error('✗ no scripts/*.test.mjs found — the discovery glob is broken, or every');
  console.error('  release-tooling test was removed. Either way a human should look.');
  process.exit(1);
}

let failed = 0;
let skipped = 0;
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(HERE, f)], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ms = Date.now() - started;
  if (r.status === 0) {
    // IT-58: a child may print one `ACCOUNTING: sections run X/Y…` line —
    // its per-section tally. Ordinary stdout stays suppressed on success
    // (printing everything trains people to stop reading the gate), but this
    // one line is re-surfaced beside the verdict: it is the operator's only
    // proof of how much a green run actually verified. Children that skip
    // sections never reach this branch (they exit 2 — see
    // scripts/it27-publish-node-pin.test.mjs's exit-code precedence), so an
    // accounting shown here always reads "N/N".
    const acct = (r.stdout ?? '').split('\n').find((l) => l.startsWith('ACCOUNTING:'));
    console.log(`PASS ${f} (${ms}ms)${acct ? ` — ${acct.slice('ACCOUNTING:'.length).trim()}` : ''}`);
  } else if (r.status === 2) {
    // SKIP (card IT-38). The reason MUST reach stdout even though ordinary
    // PASS output above stays suppressed — stdio capture is unconditional up
    // there, only the PRINTING is gated on failure; here printing the reason
    // is the entire point, so it happens regardless of what else this file
    // wrote. See the exit-code note near the top of this file for the
    // `SKIP: <reason>` convention a child must follow.
    const reasonLine = (r.stdout ?? '').split('\n').find((l) => l.startsWith('SKIP:'));
    if (reasonLine) {
      skipped += 1;
      console.log(`SKIP ${f} (${ms}ms) — ${reasonLine.slice('SKIP:'.length).trim()}`);
    } else {
      failed += 1;
      console.error(`FAIL ${f} (${ms}ms, exit 2 but no "SKIP: <reason>" line on stdout — a skip must state why)`);
      if (r.stdout?.trim()) console.error(r.stdout.trimEnd());
      if (r.stderr?.trim()) console.error(r.stderr.trimEnd());
    }
  } else {
    failed += 1;
    console.error(`FAIL ${f} (${ms}ms, exit ${r.status})`);
    // Print the child's output only on failure: a gate that prints everything
    // trains people to stop reading it.
    if (r.stdout?.trim()) console.error(r.stdout.trimEnd());
    if (r.stderr?.trim()) console.error(r.stderr.trimEnd());
  }
}

const passed = files.length - failed - skipped;

// "Every discovered file skipped" is a different fact from "every discovered
// file passed", and reporting it with the same OK/exit-0 shape would collapse
// that difference: the gate would have run, found work, and verified none of
// it, while looking exactly like a gate that verified everything. That is the
// empty-glob guard's failure mode one level down — that guard (above) catches
// "found zero test files"; this catches "found test files, verified zero of
// them for real". So it is escalated the same way: loud, non-zero exit,
// without needing anyone to remember to look. A single skip alongside real
// passes (the common case documented in CONTRIBUTING.md — no Rust means the
// node-pin test alone skips while everything else still runs) is NOT this
// case and is unaffected: this only fires when literally nothing ran.
const allSkipped = failed === 0 && skipped > 0 && skipped === files.length;
if (allSkipped) {
  console.error(`\n✗ all ${files.length} release-script test file(s) skipped — the gate verified nothing, and that does not count as passing.`);
}

const ok = failed === 0 && !allSkipped;
console.log(`\n${ok ? 'OK' : 'FAILED'} ${passed} pass / ${skipped} skip / ${failed} fail — ${files.length} release-script test file(s)`);
process.exit(ok ? 0 : 1);
