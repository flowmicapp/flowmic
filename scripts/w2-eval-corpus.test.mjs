// scripts/w2-eval-corpus.test.mjs
//
// Resident gate for the W2 adversarial corpus (FB-5 translation/organize precision control,
// FB-6 realtime transcription quality). Discovered automatically by scripts/run-script-tests.mjs,
// which `verify:delivery` runs — no registration list to keep in sync.
//
// It runs two sections, and neither of them calls a vendor:
//
//   1. SELFTEST — the ruler. Every case's `golden_good` must pass all its
//      judges and every case's `golden_bad` must fail at least one. This is
//      what keeps the corpus from rotting into a set of assertions that are
//      all trivially true. The repo has shipped that exact thing more than
//      once: 15 Soniox adapter tests green against a FakeWs whose success
//      frame we wrote ourselves, and a mobile copy-truncation test that
//      asserted `Text.data` while the screen showed three letters.
//
//   2. REPLAY — the `merge` suite, run for real against the production
//      accumulator fold in `apps/server-core/src/stt/text-merge.ts`. This one
//      is not a simulation of the product, it IS the product's function, so it
//      can go red on a real regression. It guards owner's "dropped characters are a veto" line
//      in both directions: content lost, and content duplicated.
//
// WHAT THIS GATE DOES NOT PROVE. It does not prove the LLM behaves. That needs
// a real engine and lives in `--mode=live`, whose numbers are archived in the
// W2 ledger rather than asserted here — a gate that needs DeepSeek to be up is
// a gate that goes red for reasons that have nothing to do with this commit,
// and CLAUDE.md records what happens to those: G12 was red for a day and
// nobody looked.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 🔴 THE BUNDLER IS ASKED FOR BY THE SAME FUNCTION THAT USES IT.
// This file used to carry its OWN copy of a path literal
// (`apps/server-core/node_modules/.bin/esbuild` + '.CMD' on win32) and probe it
// with existsSync. Under pnpm's strict layout that file has never existed here,
// so the probe failed on every run, this suite printed SKIP, exited 2, and
// `verify:scripts` filed it under "skip" -- for the whole life of the gate.
// Sections 2 and 3 (the merge replay against the production fold, and the
// compose output-guard eval) had therefore never executed once, while the
// suite reported a clean skip. Full measurement in the header of
// verify/eval/eval-prod-bundle.mjs.
//
// Importing the resolver is the point, not a tidy-up: one question, one answer.
// A second copy of the lookup is what let a wrong answer stay invisible -- the
// caller decided "cannot run" using a rule the runner never consulted, so the
// two could disagree forever without anything going red.
import { resolveEsbuild } from '../verify/eval/eval-prod-bundle.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RUNNER = join(ROOT, 'verify', 'eval', 'run-eval.mjs');

if (!existsSync(RUNNER)) {
  console.log('SKIP: verify/eval/run-eval.mjs is absent from this tree');
  process.exit(2);
}

const run = (label, args) => {
  const r = spawnSync(process.execPath, ['--no-warnings', RUNNER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { label, status: r.status, out };
};

let ran = 0;
let planned = 3;
const failures = [];
const accounting = [];
const notes = [];

/** W2-14: the runner prints its known-open accounts every run, but this caller
 *  only echoed the runner's output on FAILURE — so on the green path they went
 *  into a buffer nobody read, while the runner's comment said they were
 *  "printed every run, never silently tolerated". Forwarding the one-line form
 *  makes that sentence true instead of quietly false. */
const forwardKnownOpen = (out) => {
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('KNOWN-OPEN: ')) notes.push(line);
  }
};

// ── section 1: the ruler ────────────────────────────────────────────────────
{
  const r = run('selftest', ['--mode=selftest']);
  ran += 1;
  const acct = (r.out.match(/^ACCOUNTING: .*$/m) ?? [])[0];
  if (acct) accounting.push(`selftest: ${acct.replace(/^ACCOUNTING: /, '')}`);
  if (r.status !== 0) {
    failures.push('selftest');
    console.error('✗ corpus selftest failed — the measuring instrument no longer discriminates.');
    console.error(r.out);
  }
}

// A failure in section 1 must be reported as a FAILURE even if section 2 then
// decides to skip. Without this the esbuild-absent branch below reached
// process.exit(2) first, run-script-tests.mjs filed the whole file under "skip",
// and the selftest's error output was never printed -- a broken ruler reported
// as an honest skip. Found by the closeout adversarial review.
if (failures.length) {
  console.error(`\nFAILED sections: ${failures.join(', ')}`);
  process.exit(1);
}

// ── sections 2 and 3: both need the bundler ─────────────────────────────────
//
// Both remaining sections import production TypeScript through the same bundler
// the product's own build uses. Without it neither can run.
//
// 🔴 The skip is taken at the END, not here. The previous shape returned
// process.exit(2) from this branch, which meant a section-1 failure discovered
// earlier could still be filed by run-script-tests.mjs as an honest "skip" —
// a broken ruler reported as untested. That specific bug is fixed above (the
// early failure exit), and re-introducing an exit in the middle of the file
// would bring it back for sections 2 and 3. So: record the skip, run what can
// be run, and decide the exit code once, at the bottom, where every section's
// result is in hand.
let skipped = false;
const esbuild = resolveEsbuild();
if (!esbuild.ok) {
  skipped = true;
  planned -= 2;
  console.log(`SKIP: ${esbuild.reason} — merge replay and guard eval could not run`);
} else {
  // ── section 2: the real merge fold ────────────────────────────────────────
  {
    const r = run('replay', ['--mode=replay']);
    ran += 1;
    const acct = (r.out.match(/^ACCOUNTING: .*$/m) ?? [])[0];
    if (acct) accounting.push(`replay: ${acct.replace(/^ACCOUNTING: /, '')}`);
    forwardKnownOpen(r.out);
    if (r.status !== 0) {
      failures.push('replay');
      console.error('✗ merge replay failed — spoken content was lost or duplicated by the production fold,');
      console.error('  or a known-open account started passing and needs closing.');
      console.error(r.out);
    }
  }

  // ── section 3: the production compose output guard (W2-2) ─────────────────
  //
  // Loads apps/server-core/src/compose/output-guard.ts — the real one, through
  // the same bundle route — and runs it over the translate/organize corpus. Two
  // different assertions, and the first one matters more:
  //
  //   • ZERO false rejects on golden_good. A guard that refuses correct output
  //     is worse than no guard, because the way that gets resolved is by
  //     loosening it until it never fires — and what gets loosened is exactly
  //     owner's hard line.
  //   • A per-family floor on golden_bad, so a regression that blinds the guard
  //     goes red instead of quietly passing everything.
  {
    const r = run('guard', ['--mode=guard']);
    ran += 1;
    const acct = (r.out.match(/^ACCOUNTING: .*$/m) ?? [])[0];
    if (acct) accounting.push(`guard: ${acct.replace(/^ACCOUNTING: /, '')}`);
    if (r.status !== 0) {
      failures.push('guard');
      console.error('✗ compose output guard eval failed — either it rejected output the corpus calls');
      console.error('  correct (a false reject: fix the rule, do NOT loosen it into uselessness), or a');
      console.error('  family catch rate fell below its measured floor.');
      console.error(r.out);
    }
  }
}

if (failures.length) {
  console.error(`\nFAILED sections: ${failures.join(', ')}`);
  process.exit(1);
}

for (const n of notes) console.log(n);
// Name the bundler in the accounting line. Sections 2 and 3 measure PRODUCTION
// source only because esbuild imported it, so "which esbuild" is part of what
// this run means — and the reason those two sections were dark for the gate's
// whole life is that the old shape's answer to that question was never printed
// anywhere. A gate that cannot say what it used cannot be caught using nothing.
if (esbuild.ok) console.log(`BUNDLER: ${esbuild.where} — ${esbuild.via}`);
console.log(`ACCOUNTING: sections run ${ran}/${planned} — ${accounting.join(' | ')}`);
process.exit(skipped ? 2 : 0);
