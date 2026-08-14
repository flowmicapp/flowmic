// BUILD-1 drill for scripts/preflight-sidecar-resources.mjs and its wiring into
// the root gate chain.
//
// WHAT BUILD-1 IS. Every path in `tauri.conf.json`'s `bundle.resources` is
// gitignored, so a fresh clone (and the open-source export tree) has none of
// them. The first cargo leg carrying `--features app` then dies with
// `resource path \`resources\\node_modules\` doesn't exist` — a sentence that
// names a path and not the command that produces it. This file's job is to
// prove the preflight now names the command, and that it is actually reached.
//
// SAFETY — read before touching this file:
//   - Every negative case runs against a SYNTHETIC tauri dir under
//     node:os tmpdir(), never against the real one. Moving the repo's own
//     staged payload aside would race any concurrent `cargo clippy` in this
//     tree, and a drill that can break someone else's run is not a drill.
//   - The subject is imported, not spawned: it carries an isMainModule guard
//     precisely so that is safe (see its header, and the counter-example in
//     scripts/it27-publish-node-pin.test.mjs).
//   - `package.json` is read as TEXT for the wiring assertions. Nothing in this
//     repo is written.
//
// WHAT A GREEN RUN HERE DOES NOT PROVE, stated so nobody reads more into it:
// that `tauri_build::build()` really refuses a missing resource. That is a
// property of Tauri, measured once (WP3 review §3-1) and not re-measured by a
// fixture-driven test. §6 pins the wiring instead — the preflight is reached
// before cargo — which is the half this repo can actually keep honest.
//
// EXIT CODES (scripts/run-script-tests.mjs header): 0 = PASS, 1 = FAIL,
// 2 = SKIP. This file never skips: it depends only on repo source text and
// synthetic fixtures, both present in a fresh clone and in the export tree.
//
// Run: `node scripts/build1-sidecar-preflight.test.mjs`

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIDECAR_BUILD_COMMAND,
  declaredResources,
  missingResources,
  refusalMessage,
  runPreflight,
} from './preflight-sidecar-resources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PKG = readFileSync(join(ROOT, 'package.json'), 'utf8');
const DESKTOP_PKG = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'));
const REAL_TAURI_DIR = join(ROOT, 'apps', 'desktop', 'src-tauri');

let failures = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 7;
const section = (title) => {
  sectionsRun += 1;
  console.log(`\n=== ${title} ===`);
};
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures += 1; }
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assertTrue(a === e, `${label}${a === e ? '' : `  (got ${a}, want ${e})`}`);
}

/** A synthetic src-tauri dir: base conf + optional macOS overlay + whichever
 *  resources the case wants actually present on disk. */
function makeTauriFixture({ base, macos, present = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'flowmic-build1-'));
  writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify(base));
  if (macos !== undefined) writeFileSync(join(dir, 'tauri.macos.conf.json'), JSON.stringify(macos));
  for (const rel of present) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'x');
  }
  return dir;
}

const WIN_BASE = { bundle: { resources: ['resources/server.js', 'resources/package.json', 'resources/node.exe', 'resources/node_modules'] } };
const MAC_OVERLAY = { bundle: { resources: ['resources/server.js', 'resources/package.json', 'resources/node'] } };

const tempDirs = [];
function fixture(opts) {
  const d = makeTauriFixture(opts);
  tempDirs.push(d);
  return d;
}

try {
  // ── §1 ────────────────────────────────────────────────────────────────────
  section('§1 the command the refusal prints is a REAL script');
  // 🔴 The point of this section: the refusal's value is entirely in the
  // command being runnable. A constant that drifts from apps/desktop's script
  // table would still print confidently and send the reader nowhere.
  assertTrue(
    typeof DESKTOP_PKG.scripts?.['build:sidecar'] === 'string',
    'apps/desktop/package.json actually defines a `build:sidecar` script',
  );
  assertTrue(
    SIDECAR_BUILD_COMMAND.includes('build:sidecar'),
    `SIDECAR_BUILD_COMMAND names it: ${SIDECAR_BUILD_COMMAND}`,
  );
  assertTrue(
    SIDECAR_BUILD_COMMAND.includes(DESKTOP_PKG.name),
    `…and filters by the real package name (${DESKTOP_PKG.name})`,
  );

  // ── §2 ────────────────────────────────────────────────────────────────────
  section('§2 the required list is DERIVED from tauri.conf.json, not retyped');
  const realWin = declaredResources('win32', REAL_TAURI_DIR);
  const realConf = JSON.parse(readFileSync(join(REAL_TAURI_DIR, 'tauri.conf.json'), 'utf8'));
  assertEqual(realWin, realConf.bundle.resources, 'win32 list === the repo conf\'s bundle.resources');

  // ── §3 ────────────────────────────────────────────────────────────────────
  section('§3 the macOS branch is exercisable from a non-macOS box');
  // The overlay REPLACES the array (Tauri does not concatenate), so `node` is
  // in and `node_modules` / `node.exe` are out. Asserting that here is what
  // makes the darwin path measured rather than assumed on this machine.
  const macList = declaredResources('darwin', fixture({ base: WIN_BASE, macos: MAC_OVERLAY }));
  assertEqual(macList, MAC_OVERLAY.bundle.resources, 'darwin takes the overlay list wholesale');
  assertTrue(!macList.includes('resources/node_modules'), 'darwin does NOT require node_modules');
  const winList = declaredResources('win32', fixture({ base: WIN_BASE, macos: MAC_OVERLAY }));
  assertEqual(winList, WIN_BASE.bundle.resources, 'win32 ignores the macOS overlay');

  // ── §4 ────────────────────────────────────────────────────────────────────
  section('§4 missingResources reports exactly what is absent');
  const noneStaged = fixture({ base: WIN_BASE });
  assertEqual(
    missingResources('win32', noneStaged).length, 4,
    'nothing staged ⇒ all four reported',
  );
  const partly = fixture({ base: WIN_BASE, present: ['resources/server.js', 'resources/package.json'] });
  const partlyMissing = missingResources('win32', partly);
  assertEqual(
    partlyMissing,
    ['apps/desktop/src-tauri/resources/node.exe', 'apps/desktop/src-tauri/resources/node_modules'],
    'partly staged ⇒ ONLY the absent ones (tauri names one at a time; this names all)',
  );
  const allStaged = fixture({
    base: WIN_BASE,
    present: ['resources/server.js', 'resources/package.json', 'resources/node.exe', 'resources/node_modules/x'],
  });
  assertEqual(missingResources('win32', allStaged), [], 'fully staged ⇒ empty');

  // POSITIVE CONTROL for the section above. Every assertion so far is a
  // negative ("these are absent"), and a zero can mean the probe is blind — so
  // prove the same mechanism reports GREEN against the repo's own real, staged
  // tree. If this line ever fails, the four above prove nothing.
  assertEqual(
    missingResources(process.platform === 'darwin' ? 'darwin' : 'win32', REAL_TAURI_DIR), [],
    'positive control: the repo\'s own staged tree reports nothing missing',
  );

  // ── §5 ────────────────────────────────────────────────────────────────────
  section('§5 the refusal names the FIX, not just a path');
  const msg = refusalMessage(missingResources('win32', partly));
  assertTrue(msg.includes(SIDECAR_BUILD_COMMAND), 'refusal contains the build:sidecar command');
  assertTrue(msg.includes('resources/node.exe'), 'refusal lists the missing node.exe');
  assertTrue(msg.includes('resources/node_modules'), 'refusal lists the missing node_modules');
  assertTrue(!msg.includes('resources/server.js'), 'refusal does NOT list a resource that IS staged');
  // The exit code is the half that makes a gate a gate.
  const silent = { log() {}, error() {} };
  assertEqual(runPreflight({ platform: 'win32', tauriDir: partly, out: silent }), 1, 'missing ⇒ exit code 1');
  assertEqual(runPreflight({ platform: 'win32', tauriDir: allStaged, out: silent }), 0, 'staged ⇒ exit code 0');

  // ── §6 ────────────────────────────────────────────────────────────────────
  section('§6 the preflight is actually REACHED (a gate nobody invokes is not a gate)');
  const pkg = JSON.parse(ROOT_PKG);
  assertTrue(
    typeof pkg.scripts['verify:sidecar-resources'] === 'string',
    'root package.json defines verify:sidecar-resources',
  );
  // 🔴 Both cargo legs that carry `--features app` are guarded, and ONLY those
  // need to be: apps/desktop/src-tauri/build.rs calls `tauri_build::build()`
  // under `CARGO_FEATURE_APP` alone, so `verify:doctests` (no features) never
  // reads bundle.resources and is deliberately left unguarded.
  for (const stage of ['verify:clippy', 'verify:rust-tests']) {
    assertTrue(
      pkg.scripts[stage].startsWith('pnpm verify:sidecar-resources &&'),
      `${stage} runs the preflight BEFORE cargo`,
    );
  }
  assertTrue(
    pkg.scripts['verify:delivery'].includes('verify:clippy'),
    'verify:delivery reaches it transitively through verify:clippy',
  );

  // ── §7 ────────────────────────────────────────────────────────────────────
  section('§7 an empty resources list is a THROW, never a green');
  // A preflight that verifies zero things and prints a checkmark is worse than
  // no preflight — it teaches the reader to trust it. Both shapes refuse.
  for (const [label, base] of [
    ['bundle.resources: []', { bundle: { resources: [] } }],
    ['no bundle key at all', {}],
  ]) {
    let threw = false;
    try { declaredResources('win32', fixture({ base })); } catch { threw = true; }
    assertTrue(threw, `${label} ⇒ throws rather than reporting "nothing missing"`);
  }
} finally {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${sectionsRun}/${TOTAL_SECTIONS} sections ran, ${failures} failure(s)`);
process.exit(failures === 0 && sectionsRun === TOTAL_SECTIONS ? 0 : 1);
