// Drill for verify/lint/server-core-bundle-stamp.mjs and its wiring into
// verify/lint/run-all.mjs (ledger NR-51, §39).
//
// WHAT NR-51 IS. The production relay is fed apps/server-core/dist/index.js,
// and the deploy script asserted only that the file EXISTS. Same hole the web
// repo closed for its own dist/ in NR-26, and the stt-cloud stamp (ledger P6)
// closed for the VERSION half in this repo. NR-51 stamps the source COMMIT into
// server-core's bundle (and extends the stt-cloud stamp the same way), and the
// web deploy reads it back and refuses a bundle that is not this HEAD, clean.
//
// This file's job: prove the IN-REPO gate can actually go red, and that its
// red verdicts do not collapse into one another. It mirrors
// the drill for the equivalent private-package gate (same failure class, one package
// over) — but the gate here checks only the VERSION segment; the commit is the
// deploy gate's question, so this drill pins that the in-repo gate is honest
// about its own limit too.
//
// SAFETY — read before touching this file:
//   - It imports the gate module, which is pure at import (constants + two pure
//     functions + a default that only reads files). Nothing is spawned.
//   - It never writes inside this repo. Every fixture lives in a temp tree
//     under node:os tmpdir() and is removed in a `finally`.
//   - It does NOT build the real package and does NOT read the real dist/.
//
// EXIT CODES: 0 = PASS, 1 = FAIL. Never skips as a whole (server-core is a
// public package and always present in this tree).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import serverCoreBundleStamp, {
  BUNDLE_BUILD_COMMAND,
  BUNDLE_CONTROL_MARKER,
  BUNDLE_REL,
  STAMP_PREFIX,
  bundleStampDetail,
  classifyBundleStamp,
  stampVersion,
} from '../verify/lint/server-core-bundle-stamp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const LINT_SRC = readFileSync(join(ROOT, 'verify', 'lint', 'server-core-bundle-stamp.mjs'), 'utf8');
const RUN_ALL_SRC = readFileSync(join(ROOT, 'verify', 'lint', 'run-all.mjs'), 'utf8');
const TSUP_SRC = readFileSync(join(ROOT, 'apps', 'server-core', 'tsup.config.ts'), 'utf8');
const STAMP_TS_SRC = readFileSync(join(ROOT, 'apps', 'server-core', 'src', 'build-stamp.ts'), 'utf8');
const INDEX_TS_SRC = readFileSync(join(ROOT, 'apps', 'server-core', 'src', 'index.ts'), 'utf8');

let failures = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 6;
const section = (title) => {
  sectionsRun += 1;
  console.log(`\n=== ${title} ===`);
};
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

/** A 40-hex stand-in for `git rev-parse HEAD`. */
const SHA = 'c6fa87333e39b2f1a1c4d5e6f7a8b9c0d1e2f3a4';

/** A stand-in for the emitted bundle: the control marker appears, and the stamp
 *  appears at most once (both measured on the real dist/index.js — counts in
 *  the gate's header). */
function fakeBundle({ stamps = [`0.3.85+${SHA}`], control = 1 } = {}) {
  const parts = ['"use strict";\n// fake @flowmic/server-core bundle\n'];
  for (let i = 0; i < control; i++) parts.push(`process.stdout.write("${BUNDLE_CONTROL_MARKER} port=1");\n`);
  for (const s of stamps) parts.push(`var SERVER_CORE_BUILD_STAMP = "${STAMP_PREFIX}${s}";\n`);
  parts.push('var fallback = "server-core loaded from TypeScript source — no tsup define ran, so there is no stamp";\n');
  return parts.join('');
}

// ── §1 the five verdicts ────────────────────────────────────────────────────
section('§1 classifyBundleStamp separates "stale" from "unstamped" from "blind"');
{
  const ok = classifyBundleStamp({ text: fakeBundle({ stamps: [`0.3.85+${SHA}`] }), repoVersion: '0.3.85' });
  assertTrue(ok.verdict === 'ok', "stamp version equals repo version → 'ok'");
  assertTrue(ok.control === 1 && ok.stamps.length === 1, 'ok reports both counts as evidence');
  assertTrue(stampVersion(ok.stamps[0]) === '0.3.85', 'the version is extracted from the version+sha stamp');

  assertTrue(stampVersion(`0.3.85+${SHA}.dirty`) === '0.3.85', "'.dirty' is stripped too");
  assertTrue(stampVersion('0.3.85+nogit') === '0.3.85', "'+nogit' is stripped too");
  assertTrue(stampVersion('0.3.85') === '0.3.85', 'the legacy version-only shape still parses');

  const stale = classifyBundleStamp({ text: fakeBundle({ stamps: [`0.3.84+${SHA}`] }), repoVersion: '0.3.85' });
  assertTrue(stale.verdict === 'stale', "older stamp → 'stale'");
  assertTrue(stampVersion(stale.stamps[0]) === '0.3.84', 'stale carries the version it actually found');

  assertTrue(
    classifyBundleStamp({ text: fakeBundle({ stamps: [`0.3.86+${SHA}`] }), repoVersion: '0.3.85' }).verdict === 'stale',
    'a NEWER stamp is refused too — equality, not "at least as new"',
  );

  const unstamped = classifyBundleStamp({ text: fakeBundle({ stamps: [] }), repoVersion: '0.3.85' });
  assertTrue(unstamped.verdict === 'unstamped', "control present, no stamp → 'unstamped'");

  const blind = classifyBundleStamp({ text: fakeBundle({ stamps: [], control: 0 }), repoVersion: '0.3.85' });
  assertTrue(blind.verdict === 'blind', "control absent → 'blind', NOT 'unstamped'");

  const blindButStamped = classifyBundleStamp({ text: fakeBundle({ stamps: [`0.3.85+${SHA}`], control: 0 }), repoVersion: '0.3.85' });
  assertTrue(blindButStamped.verdict === 'blind', 'blind is decided FIRST');

  const ambiguous = classifyBundleStamp({ text: fakeBundle({ stamps: [`0.3.85+${SHA}`, `0.3.84+${SHA}`] }), repoVersion: '0.3.85' });
  assertTrue(ambiguous.verdict === 'ambiguous', 'two different stamps → refuses to pick one');
}

// ── §2 the refusals name different actions ──────────────────────────────────
section('§2 each refusal names ITS action');
{
  const stale = bundleStampDetail(classifyBundleStamp({ text: fakeBundle({ stamps: [`0.3.84+${SHA}`] }), repoVersion: '0.3.85' }), '0.3.85');
  assertTrue(stale.includes(BUNDLE_BUILD_COMMAND), 'stale refusal quotes the exact rebuild command');
  assertTrue(stale.includes('0.3.84') && stale.includes('0.3.85'), 'stale refusal states both versions');

  const unstamped = bundleStampDetail(classifyBundleStamp({ text: fakeBundle({ stamps: [] }), repoVersion: '0.3.85' }), '0.3.85');
  assertTrue(unstamped.includes('tsup.config.ts'), 'unstamped refusal sends you to the config that lost the define');
  assertTrue(/control marker present: 1 hits/.test(unstamped), 'unstamped refusal states the control WAS seen');

  const blind = bundleStampDetail(classifyBundleStamp({ text: fakeBundle({ stamps: [], control: 0 }), repoVersion: '0.3.85' }), '0.3.85');
  assertTrue(blind.includes('BLIND'), 'blind refusal says the scan is blind');
  assertTrue(!blind.includes(BUNDLE_BUILD_COMMAND), 'blind refusal does NOT tell anyone to rebuild');

  const ok = bundleStampDetail(classifyBundleStamp({ text: fakeBundle({ stamps: [`0.3.85+${SHA}`] }), repoVersion: '0.3.85' }), '0.3.85');
  assertTrue(
    ok.includes('This gate checked the VERSION only') && ok.includes('deploy gate'),
    'the PASS line states the limit of what it measured (version here; commit is the deploy gate\'s)',
  );
}

// ── §3 red then green, through the gate's own file-reading path ─────────────
section('§3 the gate on real trees: skips when unbuilt, fails when stale');
{
  const dir = mkdtempSync(join(tmpdir(), 'nr51-server-core-'));
  try {
    const mkTree = (name, { bundle = null, version = '0.3.85' } = {}) => {
      const root = join(dir, name);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'flowmic', version }));
      if (bundle !== null) {
        const parts = BUNDLE_REL.split('/');
        mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
        writeFileSync(join(root, ...parts), bundle);
      }
      return root;
    };

    const fresh = await serverCoreBundleStamp(mkTree('fresh-clone'));
    assertTrue(fresh.status === 'SKIP', 'bundle never built → SKIP, not FAIL');
    assertTrue(/never been built/.test(fresh.detail) && fresh.detail.includes(BUNDLE_BUILD_COMMAND), 'and the skip says so in words, and names the command');

    const stale = await serverCoreBundleStamp(mkTree('stale', { bundle: fakeBundle({ stamps: [`0.3.84+${SHA}`] }) }));
    assertTrue(stale.status === 'FAIL', 'RED: a bundle stamped with an older version is refused');
    console.log(`        refusal: ${stale.detail.slice(0, 110)}…`);

    const green = await serverCoreBundleStamp(mkTree('green', { bundle: fakeBundle({ stamps: [`0.3.85+${SHA}`] }) }));
    assertTrue(green.status === 'PASS', 'GREEN: the same path accepts a bundle stamped with the repo version');

    assertTrue(
      fakeBundle({ stamps: [`0.3.84+${SHA}`] }).replace('0.3.84', '0.3.85') === fakeBundle({ stamps: [`0.3.85+${SHA}`] }),
      'the red and green fixtures differ in the stamped version alone',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §4 wiring: the gate is not merely correct, it is CALLED ─────────────────
section('§4 verify/lint/run-all.mjs imports it and lists it in LINTS');
{
  assertTrue(
    /import serverCoreBundleStamp from '\.\/server-core-bundle-stamp\.mjs';/.test(RUN_ALL_SRC),
    'run-all.mjs imports the module',
  );
  assertTrue(
    /\{ name: 'server-core-bundle-stamp', run: serverCoreBundleStamp \}/.test(RUN_ALL_SRC),
    'run-all.mjs registers it in the LINTS table (import without registration would run nothing)',
  );
  assertTrue(!/process\.env\./.test(LINT_SRC), 'no env override reaches the verdict');
}

// ── §5 the reader is pinned to the injector ────────────────────────────────
// The gate greps for a string another file writes; if they drift, the gate
// reports 'unstamped' forever and gets deleted. Pinned here.
section('§5 the stamp prefix, the define and the reference cannot drift apart');
{
  assertTrue(
    TSUP_SRC.includes(`const STAMP_PREFIX = '${STAMP_PREFIX}';`),
    `tsup.config.ts writes the same prefix the gate reads ('${STAMP_PREFIX}')`,
  );
  assertTrue(
    /define:\s*\{\s*__SERVER_CORE_BUILD_STAMP__:\s*JSON\.stringify\(BUILD_STAMP\)/.test(TSUP_SRC),
    'tsup.config.ts still injects __SERVER_CORE_BUILD_STAMP__',
  );
  assertTrue(
    /const BUILD_STAMP = sourceStamp\(STAMP_PREFIX, pkg\.version, BUILD_INPUTS\);/.test(TSUP_SRC),
    'the injected value is sourceStamp(prefix, this package version, BUILD_INPUTS) — version from package.json, commit from git, dirtiness scoped to build inputs',
  );
  assertTrue(
    /import \{ sourceStamp \} from '\.\.\/\.\.\/scripts\/build-stamp\/source-stamp\.mjs';/.test(TSUP_SRC),
    'tsup.config.ts imports the ONE source-stamp helper',
  );
  assertTrue(
    STAMP_TS_SRC.includes('declare const __SERVER_CORE_BUILD_STAMP__'),
    'src/build-stamp.ts still declares the identifier tsup replaces',
  );
  assertTrue(
    !STAMP_TS_SRC.split('declare const')[1].includes(STAMP_PREFIX),
    'the SOURCE fallback carries no stamp prefix — otherwise "unstamped" and "stale" would blur',
  );
  assertTrue(
    INDEX_TS_SRC.includes("import { SERVER_CORE_BUILD_STAMP } from './build-stamp';"),
    'src/index.ts references the stamp, which is what keeps the constant out of the tree-shaker',
  );
}

// ── §6 the control marker is a real, load-bearing string in this package ────
section('§6 the control marker is still the sidecar handshake');
{
  assertTrue(
    INDEX_TS_SRC.includes(BUNDLE_CONTROL_MARKER),
    `the control marker is still this package's sidecar handshake line (${BUNDLE_CONTROL_MARKER})`,
  );
  assertTrue(STAMP_PREFIX === 'flowmic-server-core-build@', 'the prefix is still the one the gate was written against');
  assertTrue(BUNDLE_REL === 'apps/server-core/dist/index.js', 'the artefact is still the file the relay is fed');
}

console.log(`\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s)`);
if (failures > 0) {
  console.error(`\n✗ server-core-bundle-stamp drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\n✗ server-core-bundle-stamp drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections — a partial run is not a pass.`);
  process.exit(1);
}
console.log('\n✓ server-core-bundle-stamp drill PASSED');
