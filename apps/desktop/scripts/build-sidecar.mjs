// WP-R2-4 deliverable A — build the self-hosted sidecar payload embedded in the
// MSI: a SINGLE bundled `server.js` (server-core + protocol + zod + socket.io all
// inlined) that boots with only a host `node` on PATH — no node_modules, no copied
// migration asset.
//
// SPEC-REF:
//   docs/rebuild/07-DESKTOP-SPEC.md §5 (sidecar spawns `node server.js`), §11
//     (resources embed the server bundle)
//   docs/rebuild/13-LESSONS-LEARNED.md §4 (a lost migration file → crash loop:
//     the migration SQL is INLINED as a TS constant `INIT_SQL` in
//     apps/server-core/src/db/schema.ts, so it is bundled INTO server.js — there
//     is deliberately NO separate 001-init.sql asset to lose; see DEVIATION note
//     in the WP-R2-4 handback).
//   apps/server-core/scripts/_esbuild-resolve.mjs (esbuild resolution across pnpm
//     layouts) + apps/server-core/Dockerfile (the tsup build fact this mirrors,
//     except socket.io is bundled IN here rather than npm-installed at runtime).
//
// Difference from the Docker image: the image keeps socket.io EXTERNAL and
// `npm install`s it into the runtime layer. The sidecar has no runtime install
// step, so socket.io is bundled IN. Only Node BUILTINS and the two OPTIONAL native
// `ws` accelerators (bufferutil / utf-8-validate — loaded via try/catch in ws) are
// external; `node:sqlite` and `sherpa-onnx-node` are already loaded through
// variable-specifier `createRequire` calls that esbuild cannot see, so they are
// never pulled into the bundle.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// MAC-03 — the staged runtime's per-platform filename comes from the pin
// declaration, so this script and verify-bundle.mjs cannot disagree about it.
import { BUNDLED_NODE, stagedNodeFileName, hostPlatformKey } from '../../../scripts/vendor/bundled-node.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SERVER_DIR = path.join(REPO_ROOT, 'apps', 'server-core');
const PROTOCOL_DIST = path.join(REPO_ROOT, 'packages', 'protocol', 'dist', 'index.js');
const ENTRY = path.join(SERVER_DIR, 'src', 'index.ts');
const OUT_DIR = path.join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'resources');
const OUT_FILE = path.join(OUT_DIR, 'server.js');
// The output is ESM (`format: 'esm'` below) written to a `.js` file. Node only
// treats such a file as ESM when it either finds `"type": "module"` in the
// nearest package.json, or guesses from the syntax — and that guess
// (`--experimental-detect-module`) is only on by default from Node 22.7. On an
// older host Node the MSI's sidecar died with `SyntaxError: Cannot use import
// statement outside a module` → exit 1, surfacing as an unactionable
// 「本地服务启动失败 / child exited (code 1)」 on the device page (2026-08-03,
// owner reported it on a second machine; reproduced locally with
// `node --no-experimental-detect-module server.js` → EXIT=1, byte-identical
// symptom). This marker file removes the guess: the extension stops mattering.
const OUT_PKG = path.join(OUT_DIR, 'package.json');
const OUT_PKG_BODY = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;
// The private Node runtime, staged so the MSI can carry it too (owner 2026-08-03).
// Until that ruling only the PORTABLE bundle shipped a node.exe, so an installed
// copy ran against whatever Node the host happened to have — and the host's Node
// has to satisfy two requirements nobody ever told it about (the `type: module`
// note above, plus a top-level `require('node:sqlite')` that was flag-gated until
// v22.13.0). That is a prerequisite the user never agreed to, presented as our
// crash. Shipping the runtime removes the question instead of documenting it.
// MAC-03: the staged runtime's FILENAME is per-platform, and it comes from the
// pin declaration rather than being spelled here. Before this card the name was
// the literal `node.exe` on every platform, so the macOS build staged a Mach-O
// executable called `node.exe`. That ran — which is precisely why it survived —
// but it made the filename a statement about the wrong operating system, and the
// Rust-side lookup that has to FIND this file gets its name from the same
// declaration. Two places spelling one name is how you ship 107 MB of Node and
// then walk past it.
//
// An undeclared platform stops the build here instead of inventing a name: the
// pin is also what verify-bundle.mjs checks the bytes against, so a platform with
// no pin has nothing to be verified against either.
const stagedNodeName = stagedNodeFileName();
if (!stagedNodeName) {
  throw new Error(
    `no bundled-Node pin declared for ${hostPlatformKey()} in scripts/vendor/bundled-node.mjs — ` +
      'add one (measured on that platform, not copied off a download page) before building here.',
  );
}
const OUT_NODE = path.join(OUT_DIR, stagedNodeName);
/** Below this the staged runtime cannot load `node:sqlite` — see MIN_NODE in
 *  src-tauri/src/sidecar/node_runtime.rs, which enforces the same floor at run
 *  time. Two enforcement points for one rule, because they fail at different
 *  moments: this one refuses to BUILD a broken installer, that one explains a
 *  host runtime we did not choose. */
const MIN_NODE = [22, 13];
// Card L4 (third-party license notices): the aggregate NOTICE is generated by
// scripts/generate-notice.mjs (root + apps/desktop/public/NOTICE, kept in sync
// by that script's own --check mode, wired into scripts/publish.mjs Gate 0b).
// This build script's job is narrower: fail loud if the committed root NOTICE
// is missing or stale, then stage the copy so Vite's default `public/`
// behavior carries it into `dist/NOTICE` → embedded in the webview bundle.
// (Regenerating it here instead of just copying was rejected: this script
// runs on every sidecar build, generate-notice.mjs shells out to `pnpm list`
// across the workspace, which is slow and the wrong layer to redo on every
// incremental build — `--check` catches drift instead of silently rewriting.)
const NOTICE_SRC = path.join(REPO_ROOT, 'NOTICE');
const NOTICE_DEST = path.join(REPO_ROOT, 'apps', 'desktop', 'public', 'NOTICE');

async function resolveBuild() {
  try {
    const m = await import('esbuild');
    if (typeof m.build === 'function') return m.build;
  } catch {
    /* fall through to the pnpm store glob */
  }
  const store = path.join(REPO_ROOT, 'node_modules', '.pnpm');
  if (fs.existsSync(store)) {
    const dirs = fs.readdirSync(store).filter((d) => /^esbuild@/.test(d)).sort().reverse();
    for (const d of dirs) {
      const main = path.join(store, d, 'node_modules', 'esbuild', 'lib', 'main.js');
      if (fs.existsSync(main)) {
        const m = await import(pathToFileURL(main).href);
        if (typeof m.build === 'function') return m.build;
      }
    }
  }
  throw new Error('esbuild not found (bare import + pnpm store glob both failed)');
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/** Stage the Node running THIS script as the runtime we ship. Refuses rather than
 *  ships a runtime that cannot run the sidecar: an installer that carries its own
 *  broken Node would be strictly worse than one that borrows a working host Node,
 *  because `resolve_node_exe` prefers the bundled copy on purpose. */
function stageNodeRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const okFor23 = major === 23 ? minor >= 4 : true;
  if (!okFor23 || major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new Error(
      `refusing to bundle Node v${process.versions.node}: the sidecar needs >= ${MIN_NODE.join('.')} ` +
        '(node:sqlite unflagged in 22.13 / 23.4). Build with a newer Node.',
    );
  }
  // 🔴 AND IT MUST BE **THE** DECLARED RUNTIME, not merely a new enough one.
  //
  // Measured 2026-08-08 (first responsible party): CI's runner had Node v22.23.2,
  // this line copied it, and `it27-publish-node-pin` went red on the bytes —
  // 86,997,320 staged against 86,969,160 declared. The floor above passed it
  // happily, because a floor answers 「够不够新」 and the question here is
  // 「是不是那一份」.
  //
  // Why that matters beyond a red gate: the owner pinned the bundled runtime to a
  // specific build (2026-08-05, item 2) and `scripts/vendor/bundled-node.mjs` is
  // its SSOT — version + sha256 + byte count — and the vendored LICENSE text in
  // NOTICE is reproduced verbatim FOR THAT BUILD. Staging whatever Node happens to
  // be installed makes NOTICE describe a runtime we do not ship, which CLAUDE.md
  // already names for what it is: a false compliance statement, not a stale string.
  // It is also the out-bound twin of the MSI defect (2026-08-03), where the local
  // service depended on 「宿主机碰巧装了什么 Node」 — same shape, now on the
  // producing side, and invisible on this machine because this machine happens to
  // have the declared build installed.
  const declared = BUNDLED_NODE[hostPlatformKey()];
  if (declared && `v${process.versions.node}` !== declared.version) {
    throw new Error(
      `refusing to bundle Node v${process.versions.node}: the declared bundled runtime is ` +
        `${declared.version} (scripts/vendor/bundled-node.mjs, owner ruling 2026-08-05). ` +
        'Build with that exact version, or change the declaration first — the declaration ' +
        'is what NOTICE\'s vendored LICENSE text is reproduced for, so they move together.',
    );
  }
  // Skip the ~83 MB copy when the staged bytes are already this exact runtime.
  // Compared by size + mtime rather than by hashing 83 MB on every build; a
  // same-size same-mtime mismatch would mean somebody hand-swapped the file,
  // which is not a case worth paying for on every build.
  const src = fs.statSync(process.execPath);
  if (fs.existsSync(OUT_NODE)) {
    const cur = fs.statSync(OUT_NODE);
    if (cur.size === src.size && Math.abs(cur.mtimeMs - src.mtimeMs) < 1000) {
      console.log(`[build-sidecar] ${stagedNodeName} already staged (v${process.versions.node}) — skipped`);
      return;
    }
  }
  fs.copyFileSync(process.execPath, OUT_NODE);
  // Carry the mtime across so the skip above can recognise it next time.
  fs.utimesSync(OUT_NODE, src.atime, src.mtime);
  console.log(
    `[build-sidecar] staged ${stagedNodeName} — v${process.versions.node}, ${fmtBytes(src.size)}, from ${process.execPath}`,
  );
}

/** Copy the committed root NOTICE into apps/desktop/public/, where Vite's
 *  default `public/` handling carries it verbatim into `dist/NOTICE` and then
 *  into the webview bundle embedded in the exe — no tauri.conf.json / Rust /
 *  capability changes needed, just `fetch('/NOTICE')` from any Vue component.
 *  Refuses rather than ships a build with no third-party attribution: a
 *  missing NOTICE here means either nobody ran `generate-notice.mjs` yet, or
 *  it drifted from what generate-notice.mjs would currently produce — either
 *  way this is the same "refuse rather than ship broken" posture as
 *  stageNodeRuntime()'s version floor above. */
function stageNotice() {
  if (!fs.existsSync(NOTICE_SRC)) {
    throw new Error(
      `refusing to build: ${path.relative(REPO_ROOT, NOTICE_SRC)} is missing. ` +
        'Run `node scripts/generate-notice.mjs` at the repo root first (card L4 — ' +
        'third-party license notices).',
    );
  }
  fs.mkdirSync(path.dirname(NOTICE_DEST), { recursive: true });
  fs.copyFileSync(NOTICE_SRC, NOTICE_DEST);
  console.log(`[build-sidecar] staged NOTICE → ${path.relative(REPO_ROOT, NOTICE_DEST)}`);
}

// ── ENG-1 / card fix-028 ────────────────────────────────────────────────────
//
// 🔴 THE ENGINE THE STOCK SEED POINTS AT MUST BE ABLE TO OPEN.
//
// `apps/server-core/src/settings/defaults.ts` seeds `builtin-sherpa-local` for
// BOTH `zh` and `*`, and the desktop spawns the sidecar with five env vars
// (`src-tauri/src/sidecar/io.rs`) — none of them `FLOWMIC_DEFAULT_STT_*`. So a
// stock install's LAN transcription routes to sherpa-onnx. Until this function
// existed, the payload staged beside it was `server.js` + `{"type":"module"}` +
// the Node runtime and NOTHING ELSE, so the very first `audio:start` died on
//     sherpa-local open failed: Cannot find module 'sherpa-onnx-node'
// (device line, dev-pc-a, 2026-08-11 — proven by copying the two
// packages in BY HAND, after which the same install returned a real transcript).
//
// ⚠️ THE HALF THAT SHIPPED WAS THE 「don't bundle it」 HALF. This file's own
// header already says sherpa-onnx-node is loaded through a variable-specifier
// `createRequire` so esbuild never pulls it into the graph — that is correct and
// unchanged. What was missing is the other half of that decision: something has
// to PUT it next to the bundle. Keeping a module out of a bundler's graph is not
// a plan for shipping it; it is only half of one.
//
// LAYOUT — flat siblings under `resources/node_modules/`, and both consumers
// need exactly that shape:
//   · Node resolves `require('sherpa-onnx-node')` from `resources/server.js` by
//     walking up, so `resources/node_modules/sherpa-onnx-node` is the first hit;
//   · the glue's own `addon.js` finds its native half via
//     `../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`, i.e. a SIBLING;
//   · `stt/engines/sherpa-local.ts` `findWinBinDir()` probes the same sibling to
//     prepend the DLL dir to PATH.
//
// REFUSES rather than half-stages: shipping the JS glue without the native
// package would produce a DIFFERENT unactionable failure at the user's desk
// instead of at this line — the same argument `stageNodeRuntime()` above makes
// about a bundled runtime that cannot run.
const SHERPA_GLUE = 'sherpa-onnx-node';

/** The native package name for the host, in the vendor's own spelling. Their
 *  `addon.js` renames win32 → `win` ("Package name triggered spam"), so this
 *  mirrors that file rather than inventing a second convention. */
function sherpaNativePkg() {
  const platform = os.platform() === 'win32' ? 'win' : os.platform();
  return `sherpa-onnx-${platform}-${os.arch()}`;
}

function stageSherpaAddon() {
  const req = createRequire(path.join(SERVER_DIR, 'package.json'));
  const nativePkg = sherpaNativePkg();

  let glueDir;
  try {
    glueDir = path.dirname(req.resolve(`${SHERPA_GLUE}/package.json`));
  } catch {
    throw new Error(
      `refusing to build: ${SHERPA_GLUE} is not installed for @flowmic/server-core, but ` +
        '`settings/defaults.ts` seeds `builtin-sherpa-local` as the stock STT routing. ' +
        'Run `pnpm install` at the repo root first.',
    );
  }

  // 🔴 RESOLVED THE WAY PRODUCTION RESOLVES, not the way that reads best.
  // The first draft of this function asked server-core's require for
  // `<native>/package.json` and refused the build when that failed — which it
  // does, on every pnpm install: the native package is an OPTIONAL dependency of
  // the GLUE, so pnpm links it into the glue's private `node_modules`, not into
  // server-core's. `sherpa-local.ts` findWinBinDir() already documents this in
  // as many words ("direct dep (rare — win-x64 is nested under sherpa-onnx-node
  // with pnpm)") and falls back to the sibling. Mirroring its order is what makes
  // a layout this function accepts a layout that function can also find.
  const fromGlue = createRequire(path.join(glueDir, 'package.json'));
  const nativeDir = [
    () => path.dirname(req.resolve(`${nativePkg}/package.json`)),          // direct dep
    () => path.dirname(fromGlue.resolve(`${nativePkg}/package.json`)),     // optional dep of the glue
    () => {                                                               // plain sibling on disk
      const sib = path.join(glueDir, '..', nativePkg);
      if (!fs.existsSync(sib)) throw new Error('no sibling');
      return sib;
    },
  ].reduce((found, attempt) => {
    if (found) return found;
    try { return attempt(); } catch { return null; }
  }, null);

  if (!nativeDir) {
    throw new Error(
      `refusing to build: ${SHERPA_GLUE} is installed but its native half ${nativePkg} is not.\n` +
        `    ${SHERPA_GLUE} declares every platform as an OPTIONAL dependency, so a lockfile ` +
        'install on a platform whose binary was skipped leaves the glue resolvable and the\n' +
        '    engine unable to open — which is the exact defect card fix-028 exists to close, ' +
        'one layer further in.\n' +
        `    Install ${nativePkg} for this platform, or build the desktop artifact on a platform that has it.`,
    );
  }

  const outModules = path.join(OUT_DIR, 'node_modules');
  let copied = 0;
  for (const [name, src] of [[SHERPA_GLUE, glueDir], [nativePkg, nativeDir]]) {
    const dest = path.join(outModules, name);
    // Same skip rule as stageNodeRuntime(): compare the marker file's size+mtime
    // rather than re-hashing ~22 MB of DLLs on every incremental build.
    const marker = path.join(src, 'package.json');
    const destMarker = path.join(dest, 'package.json');
    if (fs.existsSync(destMarker)) {
      const a = fs.statSync(marker);
      const b = fs.statSync(destMarker);
      if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000) continue;
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true, dereference: true });
    const m = fs.statSync(marker);
    fs.utimesSync(destMarker, m.atime, m.mtime);
    copied += 1;
  }

  const bytes = dirSize(outModules);
  if (copied === 0) {
    console.log(`[build-sidecar] sherpa addon already staged (${nativePkg}, ${fmtBytes(bytes)}) — skipped`);
  } else {
    console.log(
      `[build-sidecar] staged sherpa addon → resources/node_modules/{${SHERPA_GLUE},${nativePkg}} — ${fmtBytes(bytes)}`,
    );
  }
  // 🔴 SIZE, SAID OUT LOUD. CLAUDE.md keeps a standing account of the download
  // centre's steady state, and this line is ~22 MB per artifact × every artifact
  // in a round. Printing it here is cheaper than discovering it when a disk fills.
  console.log(
    `[build-sidecar] ⚠️ sherpa addon adds ${fmtBytes(bytes)} per artifact — update the size ledger when this moves.`,
  );
}

/** Recursive byte total — only used for the size line above. */
function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  }
  return total;
}

async function main() {
  if (!fs.existsSync(ENTRY)) throw new Error(`server-core entry not found: ${ENTRY}`);
  // @flowmic/protocol is bundled IN (noExternal); esbuild resolves it via its
  // package `exports` → dist/index.js, so that must be built first.
  if (!fs.existsSync(PROTOCOL_DIST)) {
    throw new Error(
      `@flowmic/protocol is not built (${PROTOCOL_DIST} missing) — run \`pnpm -F @flowmic/protocol build\` first`,
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const build = await resolveBuild();
  const t0 = Date.now();
  const result = await build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: 'node',
    format: 'esm', // import.meta.url must survive (config/identity + db/connection)
    target: 'node22',
    // Node builtins are auto-external on platform:node. The only NON-builtin
    // externals are ws's OPTIONAL native accelerators (absent by default; ws
    // try/catches them) — everything else, socket.io included, is bundled IN.
    external: ['bufferutil', 'utf-8-validate'],
    // ESM-output workaround: bundled CJS deps (socket.io/engine.io) call
    // `require('http')` etc. esbuild rewrites those to its `__require` shim, which
    // in ESM throws ("Dynamic require of X is not supported") UNLESS a real
    // `require` is in scope — its shim delegates to the global `require` when one
    // exists. Provide it via createRequire, plus __filename/__dirname for any CJS
    // dep that reads them. (db/connection.ts + sherpa-local.ts already build their
    // OWN createRequire for the node:sqlite / sherpa variable-specifier loads;
    // this banner one is a distinct local binding and does not collide.)
    banner: {
      js: [
        "import { createRequire as ___createRequire } from 'node:module';",
        "import { fileURLToPath as ___fileURLToPath } from 'node:url';",
        "import { dirname as ___dirname } from 'node:path';",
        'const require = ___createRequire(import.meta.url);',
        'const __filename = ___fileURLToPath(import.meta.url);',
        'const __dirname = ___dirname(__filename);',
      ].join('\n'),
    },
    // Was 'none' (actively stripped MIT banner comments from socket.io/
    // engine.io/ws/zod — the actual defect this build flagged for card L4).
    // 'eof' is defense-in-depth, not the compliance mechanism: an empirical
    // scratch test (esbuild on this same entry point) showed it only recovers
    // pre-existing source banner comments — partial for socket.io/ws, and
    // ZERO for zod (which carries no banner comment at all, just a LICENSE
    // file). The actual mechanism is scripts/generate-notice.mjs's aggregate
    // NOTICE (staged by stageNotice() below); this flag costs nothing and
    // recovers whatever banners do exist, so both are kept.
    legalComments: 'eof',
    sourcemap: false,
    minify: false, // keep the sidecar stack-trace-readable (forensics, 07 §10)
    logLevel: 'warning',
    metafile: false,
  });
  const ms = Date.now() - t0;
  for (const w of result.warnings ?? []) {
    console.warn(`[build-sidecar] warn: ${w.text}`);
  }
  fs.writeFileSync(OUT_PKG, OUT_PKG_BODY);
  stageNodeRuntime();
  stageSherpaAddon(); // ENG-1 / fix-028 — the stock seed's engine must be able to open.
  stageNotice();
  const size = fs.statSync(OUT_FILE).size;
  console.log(`[build-sidecar] wrote ${path.relative(REPO_ROOT, OUT_FILE)} — ${fmtBytes(size)} (${size} bytes) in ${ms}ms`);
  console.log(`[build-sidecar] wrote ${path.relative(REPO_ROOT, OUT_PKG)} ({"type":"module"}) — ships BESIDE server.js or an older host Node reads it as CJS.`);
  console.log('[build-sidecar] migration SQL is inlined (schema.ts INIT_SQL) — no separate 001-init.sql asset.');
}

main().catch((err) => {
  console.error(`[build-sidecar] FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
