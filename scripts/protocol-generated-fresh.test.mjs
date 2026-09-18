#!/usr/bin/env node
// Drill for verify/lint/protocol-generated-fresh.mjs and the `--check` mode it
// calls (apps/mobile/tool/gen_protocol.mjs), card H-15 (2026-09-15).
//
// WHY A DRILL AND NOT JUST THE LINT: on a tree where `make gen` has just run,
// this lint is green no matter what it does — including nothing at all. A gate
// whose only evidence is a green run on a clean machine proves the machine, not
// the gate. So this file MAKES the artefact stale in the shape a real mistake
// takes (someone "fixing" a value in the generated file instead of in its
// source), requires the check to say so, restores it, and PROVES the restore by
// re-reading the bytes. That is the reverse control the card asks for, run by
// the suite instead of by a person who remembered.
//
// 🔴 IT MUTATES A GITIGNORED FILE, WHICH IS WHY THE RESTORE IS BELT AND BRACES.
// `apps/mobile/lib/generated/*.g.dart` is gitignored, so `git checkout` cannot
// undo a half-finished drill and `git status` would not even show the damage.
// Therefore: the generator is run FIRST so the snapshot is of a fresh file (a
// snapshot taken before a regenerate could restore a STALE file and call it a
// repair), the bytes are restored in a `finally`, and §4 re-reads them rather
// than trusting the write. All three are load-bearing.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import protocolGeneratedFresh, { GENERATORS, classifyExit } from '../verify/lint/protocol-generated-fresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN = path.join(ROOT, 'apps/mobile/lib/generated/flowmic_protocol.g.dart');
const SCRIPT = path.join(ROOT, 'apps/mobile/tool/gen_protocol.mjs');
const MARKER = 'hand-edited by the H-15 drill';

let failures = 0;
let sections = 0;
const ok = (name) => console.log(`  ok  ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

function runCheck(extra = []) {
  const res = spawnSync(process.execPath, [SCRIPT, '--check', ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

console.log('=== §1 the generator exposes a --check mode, and the lint calls it ===');
sections += 1;
{
  const src = readFileSync(SCRIPT, 'utf8');
  check(src.includes("argv.includes('--check')"), 'gen_protocol.mjs branches on --check');
  check(src.includes("argv.includes('--skip-missing')"), 'gen_protocol.mjs branches on --skip-missing');
  // A `--check` nobody calls is the façade this card exists to remove, so the
  // wiring is asserted rather than assumed.
  const g = GENERATORS.find((x) => x.script === 'apps/mobile/tool/gen_protocol.mjs');
  check(Boolean(g), 'the lint names apps/mobile/tool/gen_protocol.mjs');
  check(g?.args.includes('--check'), 'the lint passes --check', JSON.stringify(g?.args));
  check(
    g?.args.includes('--skip-missing'),
    'the lint passes --skip-missing, because *.g.dart is gitignored and a fresh clone has none',
    JSON.stringify(g?.args),
  );
  check(
    typeof g?.repair === 'string' && g.repair.includes('gen'),
    'the lint carries a repair command, so a failure says what to run',
    g?.repair,
  );
  // Absence must NOT be what makes a run green when the flag is off. Read out of
  // the script rather than rehearsed by deleting the artefact: deleting it is
  // the one mutation this drill could not safely undo if it died mid-way.
  check(
    src.includes('if (missing.length > 0 && !skipMissing)'),
    'absence is stale unless --skip-missing is passed',
  );
}

console.log('=== §2 a freshly generated tree is reported fresh (positive control) ===');
sections += 1;
const regen = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
if (regen.status !== 0 || !existsSync(GEN)) {
  console.log(`  --  the generator could not run here: exit ${regen.status}`);
  console.log(`      ${`${regen.stdout ?? ''}${regen.stderr ?? ''}`.trim().split('\n').slice(-1)[0]}`);
  console.log('=== SKIP: nothing after §1 is answerable without a generated tree ===');
  // Reported as SKIP, never PASS: a check that claims to have measured what it
  // could not reach is the thing this whole file is about.
  process.exit(failures === 0 ? 2 : 1);
}
{
  const r = runCheck();
  check(r.code === 0, '--check exits 0 right after a generate', `exit ${r.code}: ${r.out.trim()}`);
  const m = r.out.match(/(\d+) generated artefact\(s\) match their source data/);
  check(Boolean(m), '--check says how many artefacts it actually compared', r.out.trim());
  // A count of zero would satisfy the sentence above while proving nothing.
  check(Number(m?.[1] ?? 0) >= 2, 'it compared more than zero artefacts (scanner awake)', m?.[1]);
}

// Snapshot AFTER the regenerate, so the restore below puts back a fresh file.
const ORIGINAL = readFileSync(GEN);

try {
  console.log('=== §3 REVERSE CONTROL: a hand-edited generated file must be caught ===');
  sections += 1;
  {
    const before = ORIGINAL.toString('utf8');
    const mutated = before.replace(
      'static const int schemaVersion =',
      `static const int schemaVersion = 99; // ${MARKER} //`,
    );
    check(mutated !== before, 'the mutation actually changed the file (check your ruler first)');
    writeFileSync(GEN, mutated, 'utf8');

    const r = runCheck();
    check(r.code === 1, '--check exits non-zero on the hand-edited file', `exit ${r.code}: ${r.out.trim()}`);
    check(r.out.includes('flowmic_protocol.g.dart'), 'the failure names the artefact that drifted', r.out.trim());
    check(r.out.includes('make -C apps/mobile gen'), 'the failure says what to run to repair it', r.out.trim());

    const lint = await protocolGeneratedFresh();
    check(lint.status === 'FAIL', 'the LINT goes red too, not just the script', `${lint.status}: ${lint.detail}`);
    check(
      lint.detail.includes('make -C apps/mobile gen'),
      'the lint surfaces the repair command rather than swallowing it',
      lint.detail,
    );
  }
} finally {
  writeFileSync(GEN, ORIGINAL);
}

console.log('=== §4 the restore is proved, not assumed ===');
sections += 1;
{
  const now = readFileSync(GEN);
  check(now.equals(ORIGINAL), 'the generated file is byte-identical to its pre-drill state');
  check(!now.toString('utf8').includes(MARKER), 'the drill marker is gone from the tree (grep back to zero)');
  const r = runCheck();
  check(r.code === 0, '--check is green again after the restore', `exit ${r.code}: ${r.out.trim()}`);
  const lint = await protocolGeneratedFresh();
  check(lint.status === 'PASS', 'the lint is green again', `${lint.status}: ${lint.detail}`);
  check(
    lint.detail.includes('DOES NOT say'),
    'the PASS still states what it does not cover (the events hop)',
    lint.detail,
  );
}

console.log('=== §5 "nothing comparable" is a SKIP, never a PASS ===');
sections += 1;
{
  // The interesting case only happens on a tree where `make gen` has NEVER run,
  // and this machine is not that tree. Rehearsing it by deleting the artefacts
  // is the one mutation this drill could not safely undo if it died mid-way —
  // so the verdict lives in a pure function and is fed the inputs directly,
  // exactly the way worktree-location's drill feeds it a C: worktree this
  // machine does not have.
  check(classifyExit(0, 'x: 3 generated artefact(s) match').kind === 'fresh', 'exit 0 -> fresh');
  check(classifyExit(1, 'x: 1 problem(s)').kind === 'stale', 'exit 1 -> stale');
  check(
    classifyExit(2, 'x: nothing compared').kind === 'nothing-comparable',
    'exit 2 -> nothing-comparable, its own kind',
  );
  check(classifyExit(-1, 'ENOENT').kind === 'not-runnable', 'spawn failure -> not-runnable, not stale');
  // And the generator really does return 2 for that case, rather than the lint
  // classifying a code nothing ever emits.
  const src = readFileSync(SCRIPT, 'utf8');
  check(
    src.includes('if (compared === 0)') && /return 2;/.test(src),
    'gen_protocol.mjs returns 2 when it compared nothing',
  );
  check(
    readFileSync(path.join(ROOT, 'verify/lint/protocol-generated-fresh.mjs'), 'utf8')
      .includes("return { status: 'SKIP'"),
    'the lint has a SKIP branch for it (run-all.mjs counts SKIP separately)',
  );
}

console.log(
  `\n${failures === 0 ? '✔' : '✗'} protocol-generated-fresh — sections run ${sections}/5, ` +
    `${failures} assertion failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
