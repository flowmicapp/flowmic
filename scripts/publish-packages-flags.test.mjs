#!/usr/bin/env node
// Argument-parsing and plan drill for scripts/publish-packages.mjs (card S1-04).
//
// WHAT IT PINS, and why each case is here rather than trusted:
//   §1 no mode, two modes, and the valued-boolean spellings (`--dry-run=0`) are
//      REFUSED. This is IT-07's lesson applied to a second publisher: the whole
//      failure shape is a flag that looks like it disables something and does
//      not. `--dry-run=0` reaching a real publish is not a hypothetical — it is
//      why publish-github-release.mjs grew the same refusal.
//   §2 an unknown or missing `--package` is refused, and the message NAMES the
//      packages it does know. A refusal that does not say what would have worked
//      sends the next person to read the source.
//   §3 `--print-plan` reports the scope rename and the version, and says in so
//      many words that nothing was built or published.
//   §4 `--keep-scope` turns the rename off — the flag exists for the day the
//      registry constraint goes away, and a flag nothing tests is a flag that
//      has never worked.
//   §5 a package whose version disagrees with root is refused BEFORE any build.
//      Driven against a real temporary copy of the repo's manifests rather than
//      by reading the source, because "the code contains this check" and "the
//      check fires" are two different claims.
//
// SAFETY: every invocation here is `--print-plan` or a parse-time refusal. None
// of them builds, packs, reads a token, or contacts a registry.
//
// REVERSE CONTROL [measured 2026-09-07, machine dev-pc-a]: with the
// version-agreement refusal in publish-packages.mjs replaced by a no-op, §5 went
// red — `FAIL  a package off the product version line is refused`. Restored, and
// the file is green again. Recorded because a drill nobody has watched fail is a
// drill that has proved nothing.
//
// EXIT CODES (card IT-38 convention): 0 = PASS, 1 = FAIL. Never skips.
// Run: `node scripts/publish-packages-flags.test.mjs`
// Also run automatically by `pnpm verify:scripts` (inside verify:delivery).

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'publish-packages.mjs');

let failures = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function ok(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures += 1;
  }
}

function invoke(args, cwd = ROOT, script = SCRIPT) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

// ── §1 modes ────────────────────────────────────────────────────────────────
section('§1 mode flags');
for (const args of [[], ['--all'], ['--all', '--dry-run', '--publish'], ['--all', '--print-plan', '--dry-run']]) {
  const r = invoke(args);
  ok(r.status !== 0, `refused: ${args.join(' ') || '(no arguments)'}`);
}
for (const valued of ['--dry-run=0', '--publish=1', '--print-plan=true', '--all=1']) {
  const r = invoke(['--all', valued]);
  ok(r.status !== 0 && /bare flags/.test(r.stderr), `refused valued boolean: ${valued}`);
}

// ── §2 package selection ────────────────────────────────────────────────────
section('§2 package selection');
{
  const r = invoke(['--print-plan']);
  ok(r.status !== 0 && /--package/.test(r.stderr), 'no --all and no --package is refused');
  ok(/@flowmic\/protocol/.test(r.stderr), 'the refusal names the packages it knows');
}
{
  const r = invoke(['--package', '@flowmic/nope', '--print-plan']);
  ok(r.status !== 0 && /unknown package/.test(r.stderr), 'an unknown package is refused by name');
}
{
  const r = invoke(['--package', '--print-plan']);
  ok(r.status !== 0, '`--package --print-plan` does not read the next flag as a package name');
}

// ── §3 print-plan ───────────────────────────────────────────────────────────
section('§3 --print-plan');
const rootVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
{
  const r = invoke(['--all', '--print-plan']);
  ok(r.status === 0, `--all --print-plan succeeds (exit ${r.status})`);
  ok(/@flowmic\/protocol\s+->\s+@flowmicapp\/protocol@/.test(r.stdout), 'protocol is reported with its renamed scope');
  ok(/@flowmic\/i18n-web\s+->\s+@flowmicapp\/i18n-web@/.test(r.stdout), 'i18n-web is reported with its renamed scope');
  ok(r.stdout.includes(`@${rootVersion}`), `the plan carries the product version (${rootVersion})`);
  ok(/nothing was built, packed, or published/.test(r.stdout), 'it says what it did NOT do');
  ok(!/token:/.test(r.stdout), 'print-plan never reaches the token');
}

// ── §4 --keep-scope ─────────────────────────────────────────────────────────
section('§4 --keep-scope');
{
  const r = invoke(['--all', '--print-plan', '--keep-scope']);
  ok(r.status === 0 && !/@flowmicapp\//.test(r.stdout), '--keep-scope publishes under the workspace scope');
  ok(/keep-scope/.test(r.stdout), 'the mode line says the rename is off');
}

// ── §5 the version-line refusal, driven ─────────────────────────────────────
section('§5 version agreement');
{
  // A minimal tree: the script only reads package.json manifests before the
  // plan is printed, so this is enough to drive the refusal without copying a
  // build or a git history.
  // `.local/` is gitignored, so a fresh checkout (the public tree's CI runner,
  // for one) does not have it and mkdtemp dies with ENOENT before a single
  // assertion runs. It stays under ROOT on purpose — the owner's 2026-08-18
  // ruling keeps working trees off the system volume.
  mkdirSync(join(ROOT, '.local'), { recursive: true });
  const tmp = mkdtempSync(join(ROOT, '.local', 'publish-drill-'));
  try {
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    mkdirSync(join(tmp, 'packages', 'protocol'), { recursive: true });
    mkdirSync(join(tmp, 'packages', 'i18n-web'), { recursive: true });
    cpSync(SCRIPT, join(tmp, 'scripts', 'publish-packages.mjs'));
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'flowmic', version: '9.9.9' }));
    writeFileSync(
      join(tmp, 'packages', 'protocol', 'package.json'),
      JSON.stringify({ name: '@flowmic/protocol', version: '0.2.0' }),
    );
    writeFileSync(
      join(tmp, 'packages', 'i18n-web', 'package.json'),
      JSON.stringify({ name: '@flowmic/i18n-web', version: '9.9.9' }),
    );
    const script = join(tmp, 'scripts', 'publish-packages.mjs');
    const bad = invoke(['--package', '@flowmic/protocol', '--print-plan'], tmp, script);
    ok(
      bad.status !== 0 && /0\.2\.0 while the product is at 9\.9\.9/.test(bad.stderr),
      'a package off the product version line is refused',
    );
    ok(/bump-version/.test(bad.stderr), 'the refusal names the tool that fixes it');
    const good = invoke(['--package', '@flowmic/i18n-web', '--print-plan'], tmp, script);
    ok(good.status === 0, 'a package ON the line is accepted (so §5 is about the version, not the fixture)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? '\nOK' : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
