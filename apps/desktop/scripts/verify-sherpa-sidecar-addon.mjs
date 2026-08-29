// ENG-1 / card fix-028 — the staged sidecar must be able to OPEN the engine the
// stock seed points at.
//
// SPEC-REF:
//   docs/strategy/2026-08-11-eng-local-stt-cards.md §ENG-1
//   docs/strategy/2026-08-10-device-line-brief-p0-lan-empty-transcript.md
//   apps/server-core/src/settings/defaults.ts (DEFAULT_STT_*_PRESET)
//   apps/server-core/src/stt/engines/sherpa-local.ts (the runtime require)
//
// ── THE INCIDENT ────────────────────────────────────────────────────────────
// Stock 0.2.61 seeds `builtin-sherpa-local` for `zh` and `*`, and the desktop
// spawns the sidecar without any `FLOWMIC_DEFAULT_STT_*` override — so a fresh
// install's LAN transcription routes to sherpa-onnx. The shipped resources tree
// contained `server.js`, `{"type":"module"}` and the Node runtime, and nothing
// else, so the first `audio:start` died on `Cannot find module
// 'sherpa-onnx-node'`. The user was not told that. They were told 「没有听到语音」
// — the room blamed for a module that was never shipped.
//
// ── WHY THIS RUNS INSTEAD OF STATS ──────────────────────────────────────────
// `existsSync` on a directory proves a directory. It does not prove that Node
// can resolve the specifier from `server.js`'s position, that the platform's
// native half is the one present, or that the `.node` binary can actually be
// loaded by the runtime we ship. A truncated, wrong-arch or wrong-platform copy
// exists exactly as hard as a good one — the argument `verify-bundle.mjs` block
// 1c already makes about the bundled Node, applied to the addon beside it.
//
// So this gate loads it: it launches THE STAGED RUNTIME (not the build's Node),
// resolves the specifier through a `createRequire` anchored at the staged
// `server.js` — the same anchor `sherpa-local.ts` uses — and asserts the module
// really exposes `OfflineRecognizer`, which only exists once the native binding
// is bound.
//
// ── THE CONTROL, AND WHY IT IS NOT DECORATION ───────────────────────────────
// UP-7's APK marker gate pairs its subject string with a control string so that
// 「the scanner is blind」 and 「the feature is missing」 cannot produce the same
// red. The same hazard is here: if the staged runtime is broken, missing, or too
// old, EVERY require fails — including sherpa's — and a gate without a control
// would report 「addon not staged」 and send someone to re-run build:sidecar for
// a runtime problem. `node:sqlite` is the control: a builtin that the pinned
// runtime must have (it is the floor `stageNodeRuntime()` enforces). Control
// fails ⇒ the probe is blind, and it says so in those words.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_NODE, hostPlatformKey } from '../../../scripts/vendor/bundled-node.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO_ROOT = join(ROOT, '..', '..');

// Declared before the argument handling below because `--app`'s refusals use
// them: a `const` arrow referenced above its own line is a TDZ crash, and the
// crash would land on the one path whose entire job is to print a clear reason.
let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };
const ok = (msg) => console.log(`✓ ${msg}`);

// ── SECOND CALLER (card ENG-1b) ─────────────────────────────────────────────
// Default (no args): the build-staging tree, run at the end of tauri:build.
// `--resources <dir>` points the same probe at a DISTRIBUTION tree — publish.mjs
// aims it at publish/FlowMic-portable/resources, because a green run on the
// staging dir says nothing about what a copy step two directories later shipped
// (0.2.62 shipped a portable zip with NO addon while this gate was green).
// `--node <exe>` runs the probe with THAT artifact's own runtime instead of the
// staged pin — for the portable tree that is the node.exe inside the bundle,
// i.e. the runtime the user's machine will actually load the addon with.
//
// ── THIRD CALLER (owner ruling 2026-08-27 ①) ────────────────────────────────
// `--app <FlowMic.app>` aims the SAME probe at a produced macOS bundle. It is
// not a fourth gate: it is `--resources` + `--node` with the two paths derived
// from the .app layout, so there is exactly one ruler and one control for
// 「can this artefact open the engine」 on every platform.
//
// 🔴 WHY IT HAD TO EXIST. `tauri.macos.conf.json` froze its
// `bundle.resources` list on 2026-08-12; `resources/node_modules` joined the
// WINDOWS list on 08-13 (ENG-1b) and Tauri REPLACES the array rather than
// merging it, so no mac .app ever carried the native addon — 0.3.5 / 0.3.7 /
// 0.3.8 measured at zero `.node` files, and 0.3.39 died at runtime on
// `Cannot find module 'sherpa-onnx-node'` with the model downloaded, verified
// and unusable. THIS GATE WAS GREEN THROUGHOUT, because without `--app` it
// only ever measured the STAGING TREE, which is always complete. 「能装载」 is
// not 「装进包了」 — the same distinction ENG-1b already paid for once on the
// portable zip, re-learned on a platform nobody pointed the gate at.
const cliArg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : null;
};

const APP = cliArg('--app');
let RESOURCES;
let NODE_OVERRIDE;
if (APP === null) {
  RESOURCES = cliArg('--resources') ?? join(ROOT, 'src-tauri', 'resources');
  NODE_OVERRIDE = cliArg('--node');
} else {
  // 🔴 REFUSES LOUDLY OFF macOS RATHER THAN SKIPPING. A skip prints a friendly
  // line and leaves the caller believing something was checked; this mode's
  // whole subject is a Mach-O `.node` that only a darwin runtime can dlopen,
  // so a Windows/Linux box cannot answer the question even wrongly. CLAUDE.md's
  // standing rule (Windows gates have zero probative force for macOS) applies
  // to the GATE as much as to the code — and a gate that quietly passes when it
  // cannot measure is the shape 「一开始就红的门第二天就会被无视」 inverts into.
  if (process.platform !== 'darwin') {
    fail(
      `--app is a macOS-only mode and this host is '${process.platform}'.\n` +
        '    A .app bundle carries a Mach-O sherpa-onnx.node; only a darwin runtime can dlopen it,\n' +
        '    so this host cannot answer the question at all — and it will not pretend to by skipping.\n' +
        '    Run this on the build Mac (the mac release recipe calls it post-build), or drop --app to\n' +
        '    measure this host\'s own staged/portable tree instead.',
    );
    process.exit(1);
  }
  // Both Tauri bundle layouts of the same payload have the resources under
  // Contents/Resources/. Accepting `--app` pointed at either the .app or at the
  // Contents/Resources dir itself would be convenience that hides a typo, so
  // the shape is checked and named.
  const inside = join(APP, 'Contents', 'Resources', 'resources');
  if (!existsSync(inside)) {
    fail(
      `${APP} has no Contents/Resources/resources.\n` +
        '    Either --app was not pointed at a FlowMic .app bundle, or the bundle shipped with NO\n' +
        '    sidecar payload at all — which is the failure this mode was written for. `ls` the path\n' +
        '    before deciding which: an empty Contents/Resources means the bundle.resources list is wrong.',
    );
    process.exit(1);
  }
  RESOURCES = inside;
  NODE_OVERRIDE = join(inside, 'node');
}

// The vendor renames win32 → `win` in their own addon.js ("Package name
// triggered spam for sherpa-onnx-win32-x64"). Mirrored, not re-invented: a
// second naming convention here would drift from the one that does the loading.
const NATIVE_PKG = `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

// ── 0. preconditions ────────────────────────────────────────────────────────
const serverJs = join(RESOURCES, 'server.js');
if (!existsSync(serverJs)) {
  fail(`no ${serverJs} — run \`pnpm --filter @flowmic/desktop build:sidecar\` first`);
  process.exit(1);
}

let stagedNode;
if (NODE_OVERRIDE) {
  stagedNode = NODE_OVERRIDE;
  if (!existsSync(stagedNode)) {
    fail(`--node ${stagedNode} does not exist — the artifact under test ships no runtime, so nothing can load its addon`);
    process.exit(1);
  }
} else {
  const nodePin = BUNDLED_NODE[hostPlatformKey()];
  if (!nodePin) {
    fail(`no bundled-Node pin declared for ${hostPlatformKey()} — cannot know which runtime ships here`);
    process.exit(1);
  }
  stagedNode = join(REPO_ROOT, ...nodePin.stagedPath.split('/'));
  if (!existsSync(stagedNode)) {
    fail(`staged runtime ${nodePin.stagedPath} missing — run build:sidecar (this gate must run the runtime that SHIPS, not the one building)`);
    process.exit(1);
  }
}

// ── 1. the probe, executed by the staged runtime ────────────────────────────
//
// Written as a string and handed to `-e` rather than kept as a file, so nothing
// resolvable-by-accident sits inside `resources/` where it could be mistaken for
// part of the payload. argv[1] is the resources dir.
//
// It reproduces production's load path rather than an idealised one:
//   · the `createRequire` anchor is the staged `server.js`, exactly as
//     `sherpa-local.ts` anchors on its own module URL inside that bundle;
//   · the Windows DLL-dir prepend mirrors `prependNativeDllDir()` — including
//     HOW it finds the dir (direct resolve, else sibling of the glue), so a
//     layout this gate accepts is a layout that function can also find;
//   · on non-Windows NOTHING is added to the loader path, because production
//     adds nothing there either (that function returns early off win32). If the
//     load fails for that reason, this gate must show it, not paper over it.
const probe = `
const { createRequire } = require('node:module');
const { existsSync } = require('node:fs');
const { dirname, join } = require('node:path');
const out = { control: null, controlErr: null, nativeDir: null, subject: null, subjectErr: null };
try { require('node:sqlite'); out.control = 'ok'; }
catch (e) { out.control = 'fail'; out.controlErr = String(e && e.message || e); }
const resources = process.argv[1];
const req = createRequire(join(resources, 'server.js'));
const tryResolve = (s) => { try { return dirname(req.resolve(s)); } catch { return null; } };
try {
  const direct = tryResolve('${NATIVE_PKG}/package.json');
  let binDir = direct;
  if (!binDir) {
    for (const a of [tryResolve('sherpa-onnx-node/package.json'), tryResolve('sherpa-onnx-node')]) {
      if (!a) continue;
      const sib = join(a, '..', '${NATIVE_PKG}');
      if (existsSync(sib)) { binDir = sib; break; }
    }
  }
  out.nativeDir = binDir;
  if (process.platform === 'win32' && binDir) process.env.PATH = binDir + ';' + (process.env.PATH || '');
  const mod = req('sherpa-onnx-node');
  out.subject = typeof mod.OfflineRecognizer === 'function' ? 'bound' : 'loaded-but-unbound';
} catch (e) { out.subject = 'fail'; out.subjectErr = String(e && e.message || e); }
process.stdout.write(JSON.stringify(out));
`;

let report;
try {
  const raw = execFileSync(stagedNode, ['-e', probe, RESOURCES], { encoding: 'utf8', timeout: 60_000 });
  report = JSON.parse(raw);
} catch (e) {
  fail(`the staged runtime could not run the probe at all (${e.code ?? e.message}) — this is a RUNTIME problem, not an addon problem`);
  process.exit(1);
}

// ── 2. control first: a blind probe must never read as a missing addon ──────
if (report.control === 'ok') {
  ok(`control: the staged runtime resolves a builtin (node:sqlite) — the probe can see`);
} else {
  fail(
    `CONTROL FAILED — the staged runtime cannot even load node:sqlite (${report.controlErr}).\n` +
      '    The probe is BLIND, so it can say nothing about the sherpa addon. Fix the staged\n' +
      '    runtime first (verify-bundle.mjs block 1c); do NOT read this run as "addon missing".',
  );
  process.exit(1);
}

// ── 3. subject ──────────────────────────────────────────────────────────────
if (report.subject === 'bound') {
  const bytes = report.nativeDir && existsSync(report.nativeDir) ? dirBytes(report.nativeDir) : 0;
  ok(`sherpa-onnx-node loads from the staged tree and is natively bound (OfflineRecognizer present)`);
  ok(`native half ${NATIVE_PKG} found where production looks: ${rel(report.nativeDir)} (${fmt(bytes)})`);
} else if (report.subject === 'loaded-but-unbound') {
  fail(
    `sherpa-onnx-node RESOLVED but has no OfflineRecognizer — the JS glue is staged and its native\n` +
      `    half (${NATIVE_PKG}) did not bind. This is the half-staged shape: it "exists" and cannot transcribe.`,
  );
} else if (!report.nativeDir) {
  fail(
    `${NATIVE_PKG} is NOT beside the staged glue. production's findWinBinDir()/addon.js sibling probe\n` +
      `    would return null here too, so the engine cannot open. Re-run build:sidecar — stageSherpaAddon()\n` +
      '    stages BOTH packages flat under resources/node_modules/ for exactly this reason.',
  );
} else {
  const msg = String(report.subjectErr ?? '');
  const libPathIssue = /DYLD_LIBRARY_PATH|LD_LIBRARY_PATH|dlopen|libsherpa|libonnxruntime/i.test(msg);
  fail(
    `sherpa-onnx-node did not load: ${msg}\n` +
      (libPathIssue
        ? `    🔴 This is the LOADER-PATH gap, not a staging gap: ${rel(report.nativeDir)} IS present.\n` +
          '    `sherpa-local.ts` prependNativeDllDir() returns early on non-Windows, so nothing puts the\n' +
          '    native dir on the loader path there. Staging alone does NOT make mac/Linux work — that is a\n' +
          '    separate, named gap (see the platform note below); do not close it by editing this gate.'
        : '    Re-run build:sidecar; if it persists the staged copy is wrong-arch or truncated.'),
  );
}

// ── 3b. COUNTED EVIDENCE, WITH A BLIND-SCAN CONTROL ─────────────────────────
//
// Section 3 answers 「did it load」 with a word. This one prints the QUANTITY
// behind that word, because the mac incident's whole shape was a number nobody
// had: three shipped .app bundles contained zero `.node` files and every gate
// in the pipeline was green, so the question 「how many native binaries are in
// this artefact」 had no answer anywhere until somebody unzipped one by hand.
//
// 🔴 THE CONTROL, AND HOW ITS FAILURE DIRECTION WAS VALIDATED (iron rule §1-20:
// a new gate's control probe is itself unvalidated code, and its failure lands
// just before the expensive step). The subject count is `*.node`; the control
// count is `*.js` — the vendor's JS glue, which is present in EVERY layout that
// could possibly work, including the broken ones. So:
//
//   subject > 0                 ⇒ the native half shipped;
//   subject 0, control > 0      ⇒ the scan SAW the tree and the natives are
//                                 genuinely absent — the mac bug, verbatim;
//   subject 0, control 0        ⇒ the scan is BLIND (wrong directory, unreadable
//                                 bundle) and says so in those words rather than
//                                 reporting the mac bug at an innocent build.
//
// VALIDATED ON A KNOWN-GOOD TREE FIRST, not written and trusted. Readings taken
// 2026-08-27 on machine dev-pc-a against
// `apps/desktop/src-tauri/resources/node_modules` — a staging tree that had just
// passed section 3 — using the same walk this function does:
//
//     { .node: 1, .js: 18, bytes: 23000229 }
//
// i.e. the subject discriminates (1, not 18 or 0) and the control is non-zero on
// a good tree, which is the only way to know that a future 0 means 「missing」
// rather than 「I looked in the wrong place」. 0.3.39's mac run burned a false red
// one step before code-signing precisely because its control string had never
// been measured on a good artefact; this one was, before it was wired.
//
// AND THEN ALL THREE ARMS WERE RUN, not just the green one — same date, same
// machine, via `--resources` aimed at hand-built trees (verbatim, ✓/✗ as
// printed; exit codes read separately because a pipe swallows them):
//
//   good      apps/desktop/src-tauri/resources
//             ✓ payload: 1 native addon file(s) (*.node), 18 glue file(s)
//               (*.js), 21.93 MiB …                                    exit 0
//   glue-only a dir holding server.js + node_modules/sherpa-onnx-node/index.js
//             ✗ payload: ZERO *.node files … and the scan is NOT blind
//               (1 *.js glue file(s) were counted there)                exit 1
//   blind     a dir holding server.js + an EMPTY node_modules/
//             ✗ payload: the scan is BLIND — zero *.node AND zero *.js  exit 1
//
// The middle and the last are the two readings that must never be confused, and
// they were confirmed to print different sentences before this shipped.
//
// ⚠️ It counts `.node`, not `.dylib`: the dylibs beside the addon are real and
// necessary on darwin, but the file the loader actually opens is the `.node`,
// and a count that mixed them would report a healthy-looking figure for a tree
// with libraries and no addon.
const payloadDir = join(RESOURCES, 'node_modules');
if (existsSync(payloadDir)) {
  const p = countPayload(payloadDir);
  if (p.node > 0) {
    ok(
      `payload: ${p.node} native addon file(s) (*.node), ${p.js} glue file(s) (*.js), ` +
        `${fmt(p.bytes)} under ${rel(payloadDir)}`,
    );
  } else if (p.js > 0) {
    fail(
      `payload: ZERO *.node files under ${rel(payloadDir)} — and the scan is NOT blind (${p.js} *.js glue\n` +
        '    file(s) were counted there). This artefact carries the JavaScript half of the engine and\n' +
        '    none of the native half. That is the exact 2026-08-27 macOS shape: bundle.resources shipped\n' +
        '    a tree that resolves and cannot transcribe.',
    );
  } else {
    fail(
      `payload: the scan is BLIND — zero *.node AND zero *.js under ${rel(payloadDir)}.\n` +
        '    Do NOT read this as 「the addon is missing」: a directory with neither half is a directory\n' +
        '    this gate could not read or was aimed at wrongly. Check the path before touching the build.',
    );
  }
} else {
  fail(
    `payload: ${rel(payloadDir)} does not exist.\n` +
      "    Nothing was staged beside server.js at all. On a produced .app this means the platform's\n" +
      '    bundle.resources list omits `resources/node_modules` — Tauri REPLACES that array per\n' +
      '    platform, it does not merge it (scripts/preflight-sidecar-resources.mjs header).',
  );
}

// ── 4. platform honesty — what this run did and did NOT prove ───────────────
//
// 2026-08-05 owner ruling ① puts portable artifacts on Windows / macOS / Linux.
// A green run here is a statement about THIS host only. Saying so is the whole
// difference between a gate and a reassurance: CLAUDE.md's standing rule is that
// Windows gates have zero probative force for code that does not compile or run
// there, and the same applies to a native addon that is a different binary per
// platform.
//
// 🔴 AND IT REPORTS COVERAGE OFF THE VERDICT, not off the host. The first run of
// this gate printed 「PROVEN for win32-x64」 on a run that had just FAILED (reverse
// control A) — a coverage line that is true only when nobody reads it in anger.
// A diagnostic that overstates on the failure path is worse than none: it is
// read by whoever is already confused.
console.log('');
if (failed) {
  console.log(`platform coverage: NOTHING PROVEN — this run FAILED on ${hostPlatformKey()}.`);
} else {
  console.log(`platform coverage: PROVEN for ${hostPlatformKey()} (${NATIVE_PKG}) by this run.`);
}
console.log('                   NOT PROVEN for any other platform — each ships a different native');
console.log('                   binary and must run this same gate on its own build host.');
if (process.platform === 'win32') {
  console.log('                   🔴 OPEN (named, not silently passed): sherpa-local.ts prependNativeDllDir()');
  console.log('                   is a no-op off win32, and sherpa-onnx-node\'s addon.js asks for');
  console.log('                   DYLD_LIBRARY_PATH / LD_LIBRARY_PATH on darwin/linux. Staging is necessary');
  console.log('                   there and may not be sufficient. Device line owns that measurement.');
}

if (failed) {
  console.error('\nSHERPA ADDON VERIFICATION FAILED — the stock seed points at an engine this build cannot open.');
  process.exit(1);
}
console.log('\nsherpa sidecar addon verified.');

// ── helpers ────────────────────────────────────────────────────────────────
function rel(p) {
  return p ? p.replace(REPO_ROOT, '').replace(/^[\\/]/, '') : '(none)';
}
function fmt(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}
/** The 3b quantity: how many native addon files, how much glue, how many bytes.
 *  One walk, three counters — see 3b's header for why the `.js` count is a
 *  control and not decoration. */
function countPayload(dir) {
  let node = 0;
  let js = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    bytes += statSync(join(e.parentPath ?? e.path, e.name)).size;
    if (e.name.endsWith('.node')) node += 1;
    else if (e.name.endsWith('.js')) js += 1;
  }
  return { node, js, bytes };
}

function dirBytes(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += statSync(join(e.parentPath ?? e.path, e.name)).size;
  }
  return total;
}
