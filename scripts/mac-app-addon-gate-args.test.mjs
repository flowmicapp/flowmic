// Drill for `verify-sherpa-sidecar-addon.mjs --app` — the PRODUCED-BUNDLE mode
// added under owner ruling 2026-08-27 ①
// (docs/decisions/2026-08-27-owner-mac-local-stt-and-language-selector.md).
//
// ── WHAT THIS DRILL CAN AND CANNOT SAY ──────────────────────────────────────
// It cannot say the mac bundle is good. Nobody on a Windows or Linux box can:
// the subject is a Mach-O `sherpa-onnx.node` and only a darwin runtime can
// dlopen it. The real run happens on the build Mac, post-build, from the mac
// release recipe. THAT IS WHY THIS FILE EXISTS AT ALL — the gate's macOS arm
// will be executed on a machine no CI here can reach, so the parts that are
// plain argument handling are pinned where they CAN be run, and the parts that
// are not are named as not covered rather than left to look covered.
//
// So it pins exactly three things, all of them platform-independent:
//   ① `--app` on a non-darwin host REFUSES and exits 1. Not skips. A gate that
//      prints a friendly line and exits 0 when it cannot measure is worse than
//      no gate — the caller reads「passed」and ships. This is the assertion the
//      file is really for, because the failure it prevents is invisible: a
//      silent skip looks identical to a successful check in a build log.
//   ② the refusal NAMES the reason (the host platform and why it disqualifies
//      the host), so whoever reads it in a build log knows to move machines
//      rather than to go looking at the bundle.
//   ③ the pre-existing `--resources` / `--node` modes still work off this
//      host's own staged tree — i.e. adding a third caller did not break the
//      first two. One ruler, still one ruler.
//
// 🔴 NOT COVERED, SAID OUT LOUD: the darwin branch of ① — that `--app` on a Mac
// locates Contents/Resources/resources, runs the bundle's own node, and loads
// the addon. `SHERPA_APP_GATE_DRILL_APP=<path/to/FlowMic.app>` makes this drill
// exercise it when it is run on the Mac; with the variable unset (every run on
// this repo's CI) that leg is reported as UNCOVERED in the output rather than
// omitted, because a test list that silently contains one fewer case on one
// platform is how a coverage claim goes stale.
//
// EXIT CODES (scripts/run-script-tests.mjs convention): 0 = PASS, 1 = FAIL,
// 2 = SKIP.
//
// Run: `node scripts/mac-app-addon-gate-args.test.mjs`

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'apps', 'desktop', 'scripts', 'verify-sherpa-sidecar-addon.mjs');
const TAURI_RESOURCES = join(ROOT, 'apps', 'desktop', 'src-tauri', 'resources');

let failures = 0;
const assertTrue = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures += 1; }
};

function runGate(args) {
  const r = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

console.log('mac .app addon gate — argument handling');

// ── ①/② the non-darwin refusal ──────────────────────────────────────────────
if (process.platform === 'darwin') {
  console.log('  — refusal leg not applicable on darwin (that is the host it is FOR)');
} else {
  // The path deliberately does not exist. It must never get as far as caring:
  // the platform check has to come first, or a Windows run of a real bundle
  // path would produce a confusing "no Contents/Resources" instead of "wrong
  // machine".
  const r = runGate(['--app', join(ROOT, 'no-such-FlowMic.app')]);
  assertTrue(r.code === 1, `--app on ${process.platform} exits 1 (got ${r.code}) — refuses, never skips`);
  assertTrue(
    r.out.includes('macOS-only') && r.out.includes(process.platform),
    'the refusal names macOS-only AND this host platform, so the reader knows to change machines',
  );
  // The bundle-shape complaint must NOT be what a wrong-host run prints: two
  // different problems, two different next moves.
  assertTrue(
    !r.out.includes('Contents/Resources/resources'),
    'the wrong-host refusal does not masquerade as a malformed-bundle refusal',
  );
}

// ── the darwin leg, run only where it can be run ─────────────────────────────
const DRILL_APP = process.env.SHERPA_APP_GATE_DRILL_APP ?? '';
if (process.platform === 'darwin' && DRILL_APP !== '') {
  const r = runGate(['--app', DRILL_APP]);
  assertTrue(r.code === 0, `--app ${DRILL_APP} passes (got ${r.code})`);
  assertTrue(r.out.includes('native addon file(s)'), 'the produced bundle reports a counted native payload');
} else {
  console.log('  ⚠ UNCOVERED here: --app against a real FlowMic.app (needs macOS + SHERPA_APP_GATE_DRILL_APP)');
}

// ── ③ the two older modes still answer ───────────────────────────────────────
const staged = [
  join(TAURI_RESOURCES, 'server.js'),
  join(TAURI_RESOURCES, 'node_modules'),
];
if (staged.some((p) => !existsSync(p))) {
  console.log('SKIP: staged sidecar resources absent — run `pnpm --filter @flowmic/desktop build:sidecar`');
  process.exit(2);
}
const legacy = runGate(['--resources', TAURI_RESOURCES]);
assertTrue(legacy.code === 0, `--resources against this host's staged tree still passes (got ${legacy.code})`);
assertTrue(
  /payload: \d+ native addon file\(s\)/.test(legacy.out),
  'the counted-payload evidence prints on the ordinary path too, so the probe is exercised every build',
);

if (failures > 0) {
  console.error(`FAIL: ${failures} assertion(s)`);
  process.exit(1);
}
console.log('PASS');
