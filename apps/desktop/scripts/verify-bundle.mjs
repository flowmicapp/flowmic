// Post-build bundle verification — born of a real incident (2026-07-26).
//
// The wave-F MSI shipped with the PREVIOUS build's exe AND a stale staged
// server.js because the build was launched as bare `tauri build` instead of
// `pnpm tauri:build` (which stages the sidecar and passes `--features app`).
// The owner installed it, saw the old UI, and reported half a day of ghosts.
//
// This script makes that class of mistake FAIL LOUDLY at build time instead of
// at the owner's desk: it re-derives what the bundle MUST contain and refuses
// the build when it doesn't.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLED_NODE, hostPlatformKey } from '../../../scripts/vendor/bundled-node.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const REPO_ROOT = join(ROOT, '..', '..');

let failed = false;
const fail = (msg) => { console.error(`✗ ${msg}`); failed = true; };
const ok = (msg) => console.log(`✓ ${msg}`);

// 1. The staged sidecar must carry the CURRENT protocol/server markers.
//    NOT a hash-compare against server-core's dist: build-sidecar.mjs produces a
//    DIFFERENT artifact by design (esbuild, socket.io inlined — see its header),
//    so the honest check is content markers, same as the exe below. (The first
//    run of this guard failed on exactly that wrong comparison.)
//    ⚠️ A marker has to satisfy BOTH halves or this guard quietly stops guarding:
//    it must be present in TODAY's server AND absent from the sidecar this round
//    replaces. `updateOutputMachine` was the third marker and it was RETIRED in
//    0.2.28 with `history.repo.ts` (the server stores no transcripts) — so the
//    guard failed on a correct build, refusing to ship the right artifact. That is
//    the third verification surface this round that was asserting a flow which no
//    longer exists (golden G10 and deploy/cloud-chain.mjs were the other two).
//    ⇒ Replaced with `HISTORY_SYNC_RETIRED`, which is NEW in the same round: a
//    pre-0.2.28 sidecar cannot contain it, so the staleness detection is not
//    weakened — the assertion was re-pointed, not deleted. Deleting it would have
//    been the easy move and it would have cost the guard its whole purpose.
//    RULE: when you retire a flow, ask 「还有哪些东西在断言它」 — not just
//    「哪些测试会红」.
const staged = readFileSync(join(ROOT, 'src-tauri', 'resources', 'server.js'));
for (const marker of ['stt:refined', 'PC_BUSY', 'HISTORY_SYNC_RETIRED']) {
  if (staged.includes(Buffer.from(marker))) ok(`staged server.js carries ${marker}`);
  else fail(`staged server.js LACKS ${marker} — stale sidecar (build-sidecar.mjs not run?)`);
}

// 1b. …and it must ship with the `{"type":"module"}` marker beside it. Without
//     that file the bundle is ESM in a `.js`, which only boots on a host Node new
//     enough to guess module syntax (≥ 22.7). That is not a theory: on 2026-08-03
//     a second machine showed exactly 「child exited (code 1)」 and
//     `node --no-experimental-detect-module server.js` reproduces the same exit
//     code byte for byte. It is asserted HERE rather than trusted from
//     build-sidecar.mjs for the same reason marker #1 is: the resources dir is a
//     staging area anyone can half-clean.
const pkgPath = join(ROOT, 'src-tauri', 'resources', 'package.json');
try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.type === 'module') ok('staged resources/package.json declares type=module');
  else fail(`resources/package.json exists but type is ${JSON.stringify(pkg.type)} — the sidecar will load as CJS on an older host Node`);
} catch {
  fail('no resources/package.json — the ESM sidecar will not boot on a host Node older than 22.7 (run build:sidecar)');
}

// 1c. The private Node runtime the MSI now carries (owner 2026-08-03). Asserted
//     by RUNNING it, not by `existsSync`: a truncated or wrong-arch copy exists
//     just as hard as a good one, and the failure it produces on the user's
//     machine is the same unactionable 「本地服务启动失败」 this whole change
//     exists to end. It is also version-checked, because bundling a Node too old
//     for `node:sqlite` would be worse than bundling none — `resolve_node_exe`
//     prefers the bundled copy on purpose, so a bad one shadows a good host Node.
const nodePin = BUNDLED_NODE[hostPlatformKey()];
const stagedNode = nodePin
  ? join(REPO_ROOT, ...nodePin.stagedPath.split('/'))
  : join(ROOT, 'src-tauri', 'resources', 'node.exe');
// MAC-03: report the runtime by the name it actually carries on this platform.
// Every line below used to say the literal `node.exe`, which on macOS names a
// file that does not exist — a diagnostic that sends the reader to the wrong
// path is worse than one that says nothing. `null` pin ⇒ the unpinned-platform
// branch below fails with its own message, so the placeholder is never printed
// as if it were a real filename.
const stagedName = nodePin ? nodePin.stagedPath.split('/').pop() : 'the staged Node runtime';
try {
  const { execFileSync } = await import('node:child_process');
  const v = execFileSync(stagedNode, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
  const [maj, min] = v.split('.').map(Number);
  const usable = maj > 23 || (maj === 23 && min >= 4) || (maj === 22 && min >= 13);
  if (usable) ok(`staged ${stagedName} runs and reports v${v}`);
  else fail(`staged ${stagedName} is v${v} — too old for node:sqlite (needs 22.13 / 23.4)`);

  // 1d. …and it must be THE runtime scripts/vendor/bundled-node.mjs declares —
  //     the half that catches 「we shipped a runtime the NOTICE does not
  //     describe」. The check above only asks 「new enough to work」; the
  //     committed ./NOTICE makes a legal statement naming a version, a size and
  //     a sha256, and until 2026-08-05 nothing verified it, because the NOTICE
  //     was GENERATED by executing this same binary — so it agreed with itself
  //     by construction on whatever machine ran it, and disagreed with the other
  //     machine's committed copy (86,969,160 B / v22.22.3 here vs 91,694,408 B /
  //     v24.15.0 there; docs/strategy/2026-08-05-local-crosscheck-of-remote-window.md
  //     §4). Now the declaration is the SSOT and this is where it gets enforced.
  //     Hashed rather than trusted-by-version because a differently-built copy
  //     answers `-v` just as confidently as the pinned one (the reverse control
  //     for this block appended one byte to the staged binary: `-v` still said
  //     v22.22.3, only the hash moved), and `resolve_node_exe`
  //     (src-tauri/src/sidecar/node_runtime.rs:175) prefers the bundled copy
  //     on purpose and does NOT version-probe it — so a bad bundled runtime
  //     shadows a working host Node. Read+hash of the 83 MiB binary measured at
  //     60 ms here (2026-08-05), paid once per release build.
  if (!nodePin) {
    fail(`no pinned Node runtime declared for ${hostPlatformKey()} in scripts/vendor/bundled-node.mjs — add one (measured, not copied off a download page) before building on this platform`);
  } else {
    const bytes = readFileSync(stagedNode);
    const size = statSync(stagedNode).size;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const problems = [];
    if (`v${v}` !== nodePin.version) problems.push(`version staged=v${v} declared=${nodePin.version}`);
    if (size !== nodePin.bytes) problems.push(`size staged=${size} declared=${nodePin.bytes}`);
    if (sha256 !== nodePin.sha256) problems.push(`sha256 staged=${sha256} declared=${nodePin.sha256}`);
    if (problems.length === 0) {
      ok(`staged ${stagedName} IS the pinned ${hostPlatformKey()} runtime (${nodePin.version}, sha256 ${sha256.slice(0, 8)}…)`);
    } else {
      fail(
        `staged ${stagedName} is NOT the runtime scripts/vendor/bundled-node.mjs declares — ${problems.join('; ')}.\n` +
          `    ./NOTICE tells users we ship ${nodePin.version}; shipping anything else makes that a false statement.\n` +
          `    build-sidecar.mjs stages whatever Node runs it (process.execPath), so this usually means the build\n` +
          `    machine's Node is not the pinned one. Fix by building with ${nodePin.version}, or — if the pin is\n` +
          `    meant to move — update scripts/vendor/bundled-node.mjs AND re-run \`node scripts/generate-notice.mjs\`.`,
      );
    }
  }
} catch (e) {
  fail(`staged ${stagedName} missing or not runnable (${e.code ?? e.message}) — run build:sidecar`);
}

// 2. The bundled exe must contain a marker string from the CURRENT frontend
//    (the vite asset name is content-hashed, so a stale embed cannot match) and
//    a current Rust-side constant.
// MAC-03: the built executable's path is per-platform. On macOS the thing that
// SHIPS is the one inside the `.app` (`Contents/MacOS/flowmic-desktop`), so that
// is what gets checked — reading `target/release/flowmic-desktop` instead would
// verify a binary that is not the one in the bundle, which is the same class of
// mistake as verifying a runtime nobody ends up running.
const releaseDir = join(ROOT, 'src-tauri', 'target', 'release');
const exePath =
  process.platform === 'darwin'
    ? join(releaseDir, 'bundle', 'macos', 'FlowMic.app', 'Contents', 'MacOS', 'flowmic-desktop')
    : join(releaseDir, 'flowmic-desktop.exe');
let exe;
try {
  exe = readFileSync(exePath);
} catch (e) {
  fail(`no built executable at ${exePath} (${e.code ?? e.message}) — run the tauri build first`);
  exe = Buffer.alloc(0);
}
const assetDir = join(ROOT, 'dist', 'assets');
const { readdirSync } = await import('node:fs');
const mainAsset = readdirSync(assetDir).find((f) => f.startsWith('main-') && f.endsWith('.js'));
if (!mainAsset) fail('no dist/assets/main-*.js — frontend not built');
else if (exe.includes(Buffer.from(mainAsset))) ok(`exe embeds the current frontend (${mainAsset})`);
else fail(`exe does NOT embed the current frontend asset ${mainAsset} — stale binary (bare \`tauri build\`?)`);
if (exe.includes(Buffer.from('INJECT_NOT_PRIMARY'))) ok('exe carries the current Rust build (INJECT_NOT_PRIMARY present)');
else fail('exe lacks current Rust markers — built without the right sources or features');

// 3. Card L4 (third-party license notices): dist/NOTICE is a plain Vite
//    public/ passthrough of the committed root NOTICE (staged into
//    apps/desktop/public/NOTICE by build-sidecar.mjs's stageNotice()). If it's
//    missing, either build-sidecar.mjs never ran (bare `tauri build` — the
//    exact class of mistake this whole script exists to catch) or root
//    NOTICE didn't exist when it ran. If present but byte-different from the
//    repo root NOTICE, the staged copy is stale relative to whatever
//    generate-notice.mjs would produce today.
const noticeDistPath = join(ROOT, 'dist', 'NOTICE');
try {
  const distNotice = readFileSync(noticeDistPath);
  const rootNotice = readFileSync(join(REPO_ROOT, 'NOTICE'));
  if (Buffer.compare(distNotice, rootNotice) === 0) ok(`dist/NOTICE matches the repo root NOTICE (${distNotice.length} bytes)`);
  else fail('dist/NOTICE exists but does NOT match the repo root NOTICE — stale copy (re-run build-sidecar.mjs, or regenerate with `node scripts/generate-notice.mjs`)');
} catch {
  fail('no dist/NOTICE — third-party license notices missing from the frontend bundle (bare `tauri build`? run `pnpm tauri:build` instead)');
}

if (failed) {
  console.error('\nBUNDLE VERIFICATION FAILED — do not ship these artifacts.');
  process.exit(1);
}
console.log('\nbundle verified.');
