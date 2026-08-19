// Drill for verify/lint/gate-covers-workspaces.mjs (lane L5, 2026-08-19) — the
// first lint drill in the repo, aimed at the DISCOVERY failure shape.
//
// WHY THIS LINT, AND WHY DISCOVERY. gate-covers-workspaces is a discovery-type
// lint: it enumerates a set (workspace faces) and then checks the set. Its own
// header records GATE-5 — for months it printed PASS while apps/mobile's 1,871
// tests sat outside every gate, because `packageDirs()` looked for package.json
// and a Flutter package carries pubspec.yaml. The check answered honestly about
// the sample and the sample was wrong: when the enumeration breaks, a discovery
// lint fails TOWARD CONFIDENCE, printing a reassuring PASS about an empty set.
// No gate notices, because the failure IS a green. Only a drill that hands the
// lint a tree where the truth is known can notice.
//
// WHAT THE CASES PIN:
//   §1 a tree with an uncovered pubspec workspace must FAIL **naming it** — the
//      name in the message is what makes this case double as the dartPackageDirs
//      tripwire: discovery losing the pubspec class turns THIS case red (the
//      blind-ruler message appears instead of the workspace's name).
//   §2 a tree with an uncovered node workspace must FAIL naming it.
//   §3 a tree where discovery finds NOTHING must not read as clean (the
//      2026-08-19 blind-ruler guard; before it, this printed "0 workspace
//      face(s) reachable" as a PASS).
//   §4 a fully covered tree must PASS — so §1–§3's reds are about the defects,
//      not a lint that always fails.
//   §5 the real repo — the in-process reading must agree with what
//      `node verify/lint/run-all.mjs` (the thing `pnpm verify:lint` runs)
//      actually prints, so this drill cannot drift from the wired lint.
//
// REVERSE CONTROL (2026-08-19, LAN box, recorded verbatim): with
// `dartPackageDirs` sabotaged to `return [];` — a re-enactment of GATE-5's
// exact blindness — this drill went red in two places at once:
//     FAIL  §1: the uncovered pubspec workspace is named in the failure
//     FAIL  §4: a fully covered tree passes
// (§1 because the blind-ruler message replaced the workspace's name, §4 because
// a pubspec-only covered tree became an empty sample). Restored by hand,
// re-run green. So the day someone breaks dart discovery again, this file is
// the thing that notices.
//
// EXIT CODES (card IT-38 convention): 0 = PASS, 1 = FAIL. Never skips: it
// depends only on repo source and tmpdir fixtures, both present on any clone.
//
// Run: `node scripts/gate-covers-workspaces.test.mjs`
// Also run automatically by `pnpm verify:scripts` (inside verify:delivery).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageReport } from '../verify/lint/gate-covers-workspaces.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}
const section = (t) => console.log(`\n=== ${t} ===`);

/** A minimal synthetic repo under tmpdir. `scripts` is the root package.json
 *  scripts map; `dirs` maps relative paths to file content (null = directory). */
function makeTree(scripts, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'gcw-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-root', scripts }, null, 2));
  for (const [rel, content] of Object.entries(entries)) {
    const abs = join(dir, rel);
    if (content === null) mkdirSync(abs, { recursive: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  return dir;
}

// ── §1 an uncovered pubspec workspace FAILS, by name ─────────────────────────
section('§1 a pubspec workspace outside the chain goes red, and the red names it');
{
  const dir = makeTree(
    { 'verify:delivery': 'pnpm verify:lint', 'verify:lint': 'node x.mjs' },
    {
      'apps/mobapp/pubspec.yaml': 'name: mobapp\n',
      'apps/mobapp/test/a_test.dart': '// a test\n',
    },
  );
  try {
    const r = coverageReport(dir);
    assertTrue(r.status === 'FAIL', 'an uncovered pubspec workspace is a FAIL');
    assertTrue(
      /apps\/mobapp has a test\/ directory that verify:delivery never runs \(flutter test\)/.test(r.detail ?? ''),
      '§1: the uncovered pubspec workspace is named in the failure',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §2 an uncovered node workspace FAILS, by name ────────────────────────────
section('§2 a node workspace face outside the chain goes red, and the red names it');
{
  const dir = makeTree(
    { 'verify:delivery': 'pnpm verify:lint', 'verify:lint': 'node x.mjs' },
    {
      'packages/util/package.json': JSON.stringify({ name: '@fix/util', scripts: { test: 'vitest run' } }),
    },
  );
  try {
    const r = coverageReport(dir);
    assertTrue(r.status === 'FAIL' && /@fix\/util \(packages\/util\) has a `test` script/.test(r.detail ?? ''),
      'the uncovered node face is named in the failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §3 discovery finding NOTHING is not clean ────────────────────────────────
section('§3 an empty sample is a blind ruler, never a green');
{
  const dir = makeTree({ 'verify:delivery': 'pnpm verify:lint', 'verify:lint': 'node x.mjs' }, {
    'packages/.keep': '',
    'apps/.keep': '',
  });
  try {
    const r = coverageReport(dir);
    assertTrue(r.status === 'FAIL', 'zero discovered faces must FAIL (it used to PASS as "0 workspace face(s)")');
    assertTrue(/blind ruler/.test(r.detail ?? ''), 'and the failure says the RULER is blind, not that the repo is dirty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §4 a covered tree passes (the reds above are about the defects) ──────────
section('§4 a fully covered tree passes');
{
  const dir = makeTree(
    {
      'verify:delivery': 'pnpm t:pkg && pnpm t:mob',
      't:pkg': 'pnpm --filter @fix/util --fail-if-no-match test',
      't:mob': 'cd apps/mobapp && flutter test --timeout 90s',
    },
    {
      'packages/util/package.json': JSON.stringify({ name: '@fix/util', scripts: { test: 'vitest run' } }),
      'apps/mobapp/pubspec.yaml': 'name: mobapp\n',
      'apps/mobapp/test/a_test.dart': '// a test\n',
    },
  );
  try {
    const r = coverageReport(dir);
    assertTrue(r.status === 'PASS' && /2 workspace face\(s\)/.test(r.detail ?? ''),
      '§4: a fully covered tree passes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §5 the real repo agrees with what the wired suite prints ─────────────────
section('§5 the real repo, cross-checked against run-all.mjs itself');
{
  const mine = coverageReport(ROOT);
  assertTrue(mine.status === 'PASS', `the real repo reads PASS in-process (got ${mine.status}: ${mine.detail})`);
  // The same code path pnpm verify:lint runs, spawned for real — if the drill's
  // import and the suite's registration ever diverge, this is what notices.
  const out = execFileSync(process.execPath, ['verify/lint/run-all.mjs'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  const line = out.split('\n').find((l) => l.includes(' gate-covers-workspaces '));
  assertTrue(line !== undefined, 'run-all.mjs printed a gate-covers-workspaces line');
  assertTrue(
    line !== undefined && line.startsWith('PASS') && line.includes(mine.detail),
    `the printed line carries the same status and detail as the in-process read (${line?.trim()})`,
  );
}

console.log(`\nACCOUNTING: ${failures} assertion failure(s)`);
if (failures > 0) {
  console.error(`\n✗ gate-covers-workspaces drill FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✓ gate-covers-workspaces drill PASSED');
