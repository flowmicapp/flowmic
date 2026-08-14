// ENG-1b drill — the portable bundle carries the sherpa addon, and the gate
// that refuses one that does not really refuses. (ENG-1b = the distribution
// half of ENG-1/fix-028. Deliberately NOT numbered ENG-2 — that card already
// exists and is about engine-code overwrites.)
//
// ── THE INCIDENT THIS PINS ──────────────────────────────────────────────────
// a9884ca (fix-028) staged the addon under src-tauri/resources/node_modules and
// tightened both CONSUMERS (install-local.mjs REQUIRED_FILES, update/swap.rs
// REQUIRED_STAGED_FILES) — but neither DISTRIBUTION producer. publish.mjs kept
// copying exactly three files, so 0.2.62 shipped a portable zip whose first
// utterance dies on `Cannot find module 'sherpa-onnx-node'` (stock seed is
// builtin-sherpa-local for zh AND *), and which the 0.2.62+ in-place updater
// refuses outright (StagedTreeIncomplete). Every gate in the repo stayed green,
// because the one real gate (verify-sherpa-sidecar-addon.mjs) pointed at the
// STAGING dir, two directories upstream of what shipped.
//
// This drill drives the REAL pieces, not lookalikes:
//   · stagePortableSherpaAddon() — the same function publish.mjs calls;
//   · verify-sherpa-sidecar-addon.mjs with --resources/--node — the same
//     invocation publish.mjs makes, running the same staged runtime.
// The reverse control runs FIRST and must be RED: the gate aimed at a
// portable tree in the exact shipped-0.2.62 shape (no node_modules) has to
// exit 1, or a future edit could turn it into a gate that prints and passes.
//
// EXIT CODES (scripts/run-script-tests.mjs convention): 0 = PASS, 1 = FAIL,
// 2 = SKIP (staged build outputs absent — same stance as up1: a test that
// needs a build in place must say "skipped", never quietly pass).
//
// Run: `node scripts/eng1b-portable-sherpa-staging.test.mjs`

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stagePortableSherpaAddon } from './publish-portable-archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_RESOURCES = join(ROOT, 'apps', 'desktop', 'src-tauri', 'resources');
const GATE = join(ROOT, 'apps', 'desktop', 'scripts', 'verify-sherpa-sidecar-addon.mjs');
const NATIVE_PKG = `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

let failures = 0;
const assertTrue = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures += 1; }
};

// ── SKIP when the staged build outputs are absent ───────────────────────────
const prereqs = [
  join(TAURI_RESOURCES, 'server.js'),
  join(TAURI_RESOURCES, 'package.json'),
  join(TAURI_RESOURCES, 'node.exe'),
  join(TAURI_RESOURCES, 'node_modules', 'sherpa-onnx-node', 'package.json'),
  join(TAURI_RESOURCES, 'node_modules', NATIVE_PKG, 'sherpa-onnx.node'),
];
const missing = prereqs.filter((p) => !existsSync(p));
if (missing.length > 0) {
  // `SKIP: ` (colon) is the runner's contract — run-script-tests.mjs escalates
  // exit 2 WITHOUT a /^SKIP: /m stdout line to FAIL (a skip must state why).
  // This line first shipped as `SKIP —` (em-dash), so on every machine without
  // the staged sidecar tree the "skip" read as a gate failure.
  console.log('SKIP: staged sidecar tree incomplete (run `pnpm --filter @flowmic/desktop build:sidecar`):');
  for (const m of missing) console.log(`  · ${m}`);
  process.exit(2);
}

const stagedNode = join(TAURI_RESOURCES, 'node.exe');
const tmp = mkdtempSync(join(tmpdir(), 'eng2-portable-'));
const portableDir = join(tmp, 'FlowMic-portable');
mkdirSync(join(portableDir, 'resources'), { recursive: true });
copyFileSync(join(TAURI_RESOURCES, 'server.js'), join(portableDir, 'resources', 'server.js'));
copyFileSync(join(TAURI_RESOURCES, 'package.json'), join(portableDir, 'resources', 'package.json'));

const runGate = () => spawnSync(process.execPath, [
  GATE, '--resources', join(portableDir, 'resources'), '--node', stagedNode,
], { encoding: 'utf8', timeout: 120_000 });

try {
  // ── 1. reverse control FIRST: the shipped-0.2.62 shape must go RED ────────
  console.log('section 1: gate vs a portable tree WITHOUT node_modules (the shipped 0.2.62 shape)');
  const red = runGate();
  assertTrue(red.status === 1, `gate exits 1 on the addon-less tree (got ${red.status})`);
  assertTrue(
    (red.stdout + red.stderr).includes('NOT beside the staged glue'),
    'refusal names the missing native half (not some incidental failure)',
  );

  // ── 2. the real staging function fills the gap ────────────────────────────
  console.log('section 2: stagePortableSherpaAddon() against the real staged tree');
  const said = { fails: [], oks: [] };
  const staged = stagePortableSherpaAddon({
    tauriResources: TAURI_RESOURCES,
    portableDir,
    fail: (m) => said.fails.push(m),
    ok: (m) => said.oks.push(m),
  });
  assertTrue(staged === true && said.fails.length === 0, 'staging reports success with zero failures');
  const nativeBin = join(portableDir, 'resources', 'node_modules', NATIVE_PKG, 'sherpa-onnx.node');
  const srcBin = join(TAURI_RESOURCES, 'node_modules', NATIVE_PKG, 'sherpa-onnx.node');
  assertTrue(existsSync(nativeBin), `native binary landed at resources/node_modules/${NATIVE_PKG}/sherpa-onnx.node`);
  assertTrue(
    existsSync(nativeBin) && statSync(nativeBin).size === statSync(srcBin).size,
    'staged native binary is byte-for-byte the size of the source (not truncated)',
  );

  // ── 3. the same gate now goes GREEN on the same tree ──────────────────────
  console.log('section 3: gate vs the staged portable tree');
  const green = runGate();
  assertTrue(green.status === 0, `gate exits 0 once the addon is staged (got ${green.status})`);
  assertTrue(
    green.stdout.includes('natively bound'),
    'green run proves a real load (OfflineRecognizer bound), not mere file presence',
  );

  // ── 4. the staging function itself refuses an incomplete SOURCE ───────────
  console.log('section 4: staging refuses when the build-side tree lacks the addon');
  const bareSource = join(tmp, 'bare-resources');
  mkdirSync(bareSource, { recursive: true });
  const refusals = [];
  const refused = stagePortableSherpaAddon({
    tauriResources: bareSource,
    portableDir: join(tmp, 'unused-portable'),
    fail: (m) => refusals.push(m),
    ok: () => {},
  });
  assertTrue(refused === false && refusals.length === 1, 'returns false and fails exactly once');
  assertTrue(
    refusals.every((m) => m.includes('build:sidecar')),
    'refusal tells the operator the step that actually fixes it (build:sidecar, not a dead-end)',
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nFAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASS — portable sherpa staging + gate wiring verified (red first, then green)');
