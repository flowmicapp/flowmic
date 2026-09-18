// FlowMic release publisher (owner 2026-07-27).
//
// Assembles ./publish from artifacts that are ALREADY BUILT — it never builds, so
// it can never paper over a stale binary. Run it after `pnpm tauri:build`; the
// bundle guard (apps/desktop/scripts/verify-bundle.mjs) has already refused a
// stale exe by then, and this script re-checks the same markers on what it copies
// because ./publish is where every install/distribution starts from
// (13 §4 lesson: always take installers from the publish directory, never a build/ tree).
//
// ⚠️ ./publish IS A PRODUCT DIRECTORY, NOT A RUN DIRECTORY (RV-73, owner
// 2026-07-31 — docs/decisions/2026-07-31-owner-b2-outbox-rulings.md §Options 4).
// It used to be both, and one directory answering two questions cost a
// deterministic `EBUSY: resource busy or locked, copyfile … FlowMic.exe` on EVERY
// round: Windows write-locks the image of a running exe, and the owner's running
// FlowMic was that exe. The run copy now lives elsewhere and gets there by an
// explicit action — `node scripts/install-local.mjs` — never as a side effect of
// publishing. This script writes ONLY under ./publish and must stay that way.
//
// Three products land here:
//   1. the two MSI installers (en-US / zh-CN),
//   2. the Android APK (copied through if a built one exists),
//   3. FlowMic-portable/ — the ONE-CLICK bundle the owner asked for: the desktop
//      exe, the sidecar server, and a private node runtime in one directory.
//      Distribute it (or hand it to install-local.mjs); do not launch it in place.
//
// The portable bundle deliberately has NO .cmd/.bat launcher. A batch file opens
// a console window, which is precisely what「运行时不要出现SERVER的黑窗口」rules
// out. FlowMic.exe is the entry point: it is a /SUBSYSTEM:WINDOWS binary (see
// src-tauri/src/main.rs) and it spawns the sidecar with CREATE_NO_WINDOW (see
// sidecar/io.rs), so nothing in the chain owns a console.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUNDLED_NODE, hostPlatformKey } from './vendor/bundled-node.mjs';
import {
  verifyApkVersion,
  verifyApkTargetSdk,
  verifyApkCarriesSelfUpdate,
  verifyApkDisclosureCopy,
} from './publish-apk-gates.mjs';
import { verifyArtifactsCarryNoLanIp } from './publish-lan-ip-gate.mjs';
import { verifyCopyAudited } from './copy-scent-receipt.mjs';
import { verifyNoticeCurrent } from './publish-notice-gate.mjs';
import { verifyDiskHeadroom } from './publish-disk-space-gate.mjs';
import { removeAllExcept, verifyAdoptedArtifactsSurvive } from './publish-adopted-artifact-gate.mjs';
import { publishPortableArchive, stagePortableSherpaAddon } from './publish-portable-archive.mjs';
import { readValidReceipt, reuseBanner } from './gate-receipt.mjs';
import {
  APK_CONTROL_MARKER,
  DESKTOP_BUILD_COMMAND,
  EXE_CONTROL_MARKER,
  MOBILE_BUILD_COMMAND,
  resolveGatedSha,
  verifyArtifactBuildSha,
} from './build-stamp/artifact-sha-gate.mjs';
import { portableReadmeText, releaseFolderReadmeText } from './publish-portable-readme.mjs';
import { FREEZE_FLAG, freezeNotice, freezeRefusal } from './publish-freeze-round.mjs';
import { DEFERRED_FLAG, deferralRefusal, deferredNotice } from './publish-manifest-deferred.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'apps', 'desktop');
const TAURI = join(DESKTOP, 'src-tauri');
const RELEASE = join(TAURI, 'target', 'release');
const BUNDLE = join(RELEASE, 'bundle', 'msi');
const OUT = join(ROOT, 'publish');
const PORTABLE = join(OUT, 'FlowMic-portable');

/** The reference version — the same root package.json version-sync compares
 *  every other face against. Artifact NAMES derive from it so a filename can
 *  never disagree with what is inside it. */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

let failed = false;
const fail = (m) => { console.error(`✗ ${m}`); failed = true; };
const ok = (m) => console.log(`✓ ${m}`);
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);

// ── S7 (0.3.0): manifest-before-artifacts, enforced not remembered ──────────
//
// scripts/build-update-manifest.mjs reads ./publish and writes
// update-manifest.json with URLs that point into the LAN download center
// (DOWNLOAD_BASE) — so the manifest only tells the truth once those bytes are
// actually ON the download center, not merely once they are staged locally in
// ./publish. `--skip-lan` means THIS run never uploads anything anywhere, so
// pairing it with `--with-manifest` would write a manifest whose URLs
// dereference to nothing until a human separately remembers to (a) run the
// upload and (b) run the manifest step, in that order, by hand — which is
// exactly the "先产物后清单 is an oral rule" hole this card exists to close.
//
// Checked FIRST, before any artifact/build-output work below, so the refusal
// is reachable (and provable) independent of whether a real MSI/APK/exe has
// been built on this machine — it is a flag-combination fact, not a build-state
// fact.
const WITH_MANIFEST = process.argv.includes('--with-manifest');

// ── freeze round (owner 2026-09-09) ────────────────────────────────────────
// Checked HERE, beside the other flag-combination fact, for the same reason:
// it is a fact about the arguments, not about the build, so the refusal is
// reachable before a single byte is written. What the flag does — and the
// three things it deliberately does NOT do — is in publish-freeze-round.mjs.
const FREEZE_ROUND = process.argv.includes(FREEZE_FLAG);
{
  const refusal = freezeRefusal(process.argv.slice(2));
  if (refusal) { console.error(refusal); process.exit(1); }
}

// ── manifest deferred (orchestrated round) ─────────────────────────────────
// Same spot, same reason again: a fact about the arguments and the environment,
// so the refusal is reachable before a byte is written. This flag does NOT skip
// ruling ①'s gate — it moves the assertion to the step of the same `pnpm ship`
// run that can answer it honestly, and it is refused outside such a run. All of
// the reasoning is in publish-manifest-deferred.mjs.
const MANIFEST_DEFERRED = process.argv.includes(DEFERRED_FLAG);
{
  const refusal = deferralRefusal(process.argv.slice(2));
  if (refusal) { console.error(refusal); process.exit(1); }
}

if (WITH_MANIFEST && process.argv.includes('--skip-lan')) {
  console.error(
    '✗ --with-manifest with --skip-lan refused: the manifest would point at artifacts ' +
    'nothing has uploaded anywhere yet (先产物后清单铁律). Either drop --skip-lan so this ' +
    'run uploads to the LAN download center before the manifest is built, or omit ' +
    '--with-manifest and run `node scripts/build-update-manifest.mjs` by hand once you have ' +
    'uploaded the artifacts yourself.'
  );
  process.exit(1);
}

// ── GATE 0-pre: two facts about the disk, read before anything is written ───
// docs/RELEASE-IRONRULES.md's 「磁盘」 and 「跨机产物」 rules, promoted out of its
// human-only §1 into §2 by this wiring (cited by NAME: that list renumbered
// twice on the day this was written). Both are pure reads, so they precede
// Gate 0's minutes — and the disk one precedes the first byte this process
// writes. Measurements, thresholds and refusal texts live in the two modules.
if (!verifyDiskHeadroom(ROOT, fail, ok)) process.exit(1);
const adoptedPre = verifyAdoptedArtifactsSurvive({ outDir: OUT, version: VERSION });
if (adoptedPre.refusal) { fail(adoptedPre.refusal); process.exit(1); }
ok(adoptedPre.notice);

// ── GATE 0: `pnpm verify:delivery`, red means stop (B7, owner 2026-08-02) ────
//
// THE FIRST THING THIS SCRIPT DOES, before it even looks at the binaries.
//
// Why it is automated instead of written down: 「红着没人知道」 has now happened
// TWICE on the same gate. G12 was red from 0.2.4 onward and nobody saw it for a
// day; G17 was red for a whole round because the pricing doc it quotes had been
// half-superseded. Both times the gate existed, was correct, and simply was not
// run — because the only thing that ran it was a human remembering to. The repo's
// own rule about that is explicit: 「要靠人记住的纪律，已经被漏掉两次，就该自动化。」
// This is the third time, so it does not get to depend on memory again.
//
// Why HERE and NOT in pre-commit: owner's B7 ruling. The golden paths start a real
// server and a real socket (~35s+), which cannot live in a per-commit hook — that
// is exactly how a gate becomes something everyone disables. pre-commit keeps its
// second-scale lint+types gate and is deliberately NOT touched by this change.
// Publishing, by contrast, happens a handful of times a round and is the last
// moment before an artifact reaches the owner, so it can afford the full run.
//
// There is deliberately NO bypass flag and NO env override. An env var is
// invisible to the next reader; a flag becomes the thing everyone types. If this
// gate has to be skipped, the honest way is to delete these lines in a commit —
// then the bypass is a diff somebody can see, which is the whole point.
//
// ── C10-4: a RECENT PROOF OF THE SAME TREE MAY STAND IN FOR A RERUN ─────────
// Measured on 0.3.6: this gate and deploy/delivery_gate.py each ran the full
// chain, twice on a tree that had not changed a byte since the previous green
// run — six to ten minutes per round re-deriving a proof that already existed.
//
// 🔴 THE RULE, AND IT IS NOT A CACHE. A receipt stands in ONLY when HEAD sha,
// the working-tree fingerprint, the toolchain readings AND the age window all
// match (scripts/gate-receipt.mjs owns every one of those judgements). When it
// does, that fact is ANNOUNCED at the same volume as the gate's own heading,
// naming the minute the proof was made — a silent skip would make a reused
// proof and a fresh one look identical in this log, which is the precise defect
// this repo keeps paying for. When any condition fails, the reason is printed
// and the full chain runs; there is no path where "reused" is quiet and no flag
// that forges a receipt (the only writer is the last link of the chain itself).
{
  const proof = readValidReceipt();
  if (proof.ok) {
    console.log(reuseBanner(proof));
  } else {
  console.log('── verify:delivery (lint + types + clippy + golden) ─────────────');
  console.log(`   (no reusable gate proof: ${proof.reason})`);
  const t0 = Date.now();
  const gate = spawnSync('pnpm', ['verify:delivery'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (gate.error) {
    console.error(`✗ could not run \`pnpm verify:delivery\`: ${gate.error.message}`);
    console.error('  A gate that cannot run is a FAILED gate, not a skipped one.');
    process.exit(1);
  }
  if (gate.status !== 0) {
    console.error(`✗ verify:delivery FAILED (exit ${gate.status}) — refusing to publish.`);
    console.error('  Fix it. Do not publish around it: an artifact built on a red gate is');
    console.error('  exactly the state the owner cannot tell apart from a green one.');
    process.exit(1);
  }
  ok(`verify:delivery green (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

// GATE 0b (NOTICE current, card L4) lives in scripts/publish-notice-gate.mjs —
// extracted VERBATIM, reasoning and all, to pay for GATE 0e below (same
// precedent as publish-apk-gates.mjs). It exits the process on failure.
verifyNoticeCurrent(ROOT, ok);

// APK content gates (version / self-update / disclosure copy) live in
// scripts/publish-apk-gates.mjs — extracted so this file stays under the
// 800-line cap (same precedent as publish-portable-archive.mjs for UP-9).

function stage(src, destDir, destName = null) {
  const name = destName ?? src.split(/[\\/]/).pop();
  const dest = join(destDir, name);
  copyFileSync(src, dest);
  const hash = sha256(dest);
  writeFileSync(`${dest}.sha256`, `${hash}  ${name}\n`);
  ok(`${name}  (${mb(dest)} MB)  ${hash.slice(0, 8)}…`);
  return { name, hash, dest };
}

// ── preflight: refuse to publish a stale or incomplete build ────────────────
const exePath = join(RELEASE, 'flowmic-desktop.exe');
const serverJs = join(TAURI, 'resources', 'server.js');
const serverPkg = join(TAURI, 'resources', 'package.json');
const stagedNode = join(TAURI, 'resources', 'node.exe');
if (!existsSync(exePath)) fail(`no ${exePath} — run \`pnpm --filter @flowmic/desktop tauri:build\` first`);
if (!existsSync(serverJs)) fail(`no ${serverJs} — run \`pnpm --filter @flowmic/desktop build:sidecar\` first`);
if (!existsSync(serverPkg)) fail(`no ${serverPkg} ({"type":"module"}) — run \`pnpm --filter @flowmic/desktop build:sidecar\` first`);
if (!existsSync(stagedNode)) fail(`no ${stagedNode} — run \`pnpm --filter @flowmic/desktop build:sidecar\` first`);
const noticeSrc = join(ROOT, 'NOTICE');
if (!existsSync(noticeSrc)) fail(`no ${noticeSrc} — run \`node scripts/generate-notice.mjs\` first (Gate 0b above should have already caught this)`);
if (failed) process.exit(1);

// ── GATE 0c: staged node.exe IS the pinned runtime (card IT-27) ────────────
//
// apps/desktop/scripts/verify-bundle.mjs already enforces this at BUILD time
// (`pnpm --filter @flowmic/desktop tauri:build`): it reads scripts/vendor/
// bundled-node.mjs (the SSOT declaring version + byte count + sha256 for the
// Node runtime this platform ships) and hashes the staged binary against it —
// not `existsSync`, because a truncated or wrong-architecture file "exists"
// just as confidently as a correct one, and not version-only, because a
// differently-built copy answers `-v` identically (appending one byte to the
// staged binary leaves `node -v` saying the same thing; only the hash moves).
//
// That build-time gate only runs on whatever machine ran tauri:build. This
// repo already has two developer machines whose staged node.exe disagree
// (v22.22.3 / 86,969,160 B here vs v24.15.0 / 91,694,408 B there — see
// docs/strategy/2026-08-05-local-crosscheck-of-remote-window.md §4), and
// nothing stopped a ./publish run from staging a node.exe that build gate
// never re-examined — a leftover from an older checkout, a half-finished
// re-stage, anything that leaves the right FILENAME in place with the wrong
// BYTES. Re-verified here for the same reason the frontend/server.js content
// markers just below are re-verified here: "a publish step that trusts an
// earlier step is how a stale binary reaches the owner" (the 2026-07-26
// incident this whole preflight section exists to end).
//
// Deliberately reads the SAME declaration verify-bundle.mjs reads (imported
// above), rather than re-deriving what the pin "should" be — one answer to
// "what Node do we ship", asked twice, not two answers that could drift
// apart. Not a subprocess call to verify-bundle.mjs: that script also asserts
// dist/NOTICE and the exe/sidecar content markers, which are their own
// build-time concerns with their own preconditions (a staged dist/NOTICE
// this script never requires) — invoking it wholesale here would make
// publish depend on state this card was never asked to gate. The runtime's
// version-usability floor (node:sqlite needs ≥ 22.13) is likewise a build-
// time question, already enforced there; what belongs at the publish
// boundary is the same question every other Gate 0 check asks: is what is
// ABOUT TO SHIP actually the thing the repo declares it to be.
{
  const platformKey = hostPlatformKey();
  const pin = BUNDLED_NODE[platformKey];
  if (!pin) {
    fail(`no pinned Node runtime declared for ${platformKey} in scripts/vendor/bundled-node.mjs — cannot verify what is about to be published`);
  } else {
    const stagedBytes = readFileSync(stagedNode);
    const actualBytes = statSync(stagedNode).size;
    const actualSha256 = createHash('sha256').update(stagedBytes).digest('hex');
    const problems = [];
    if (actualBytes !== pin.bytes) problems.push(`bytes: staged=${actualBytes} declared=${pin.bytes}`);
    if (actualSha256 !== pin.sha256) problems.push(`sha256: staged=${actualSha256} declared=${pin.sha256}`);
    if (problems.length > 0) {
      fail(
        `${stagedNode} is NOT the runtime scripts/vendor/bundled-node.mjs declares for ${platformKey} (${pin.version}) — ${problems.join('; ')}.\n` +
          `    ./NOTICE tells users we ship ${pin.version}; publishing a different binary makes that a false statement.\n` +
          `    Re-run \`pnpm --filter @flowmic/desktop tauri:build\` (its verify-bundle.mjs gate exists to catch exactly this)\n` +
          `    before publishing again. If the pin is meant to move, update scripts/vendor/bundled-node.mjs and re-run\n` +
          `    \`node scripts/generate-notice.mjs\` first.`,
      );
    } else {
      ok(`staged node.exe IS the pinned ${platformKey} runtime (${pin.version}, sha256 ${actualSha256.slice(0, 8)}…)`);
    }
  }
}
if (failed) process.exit(1);

// The same content markers verify-bundle.mjs asserts, re-checked on the artifact
// actually being published — a publish step that trusts an earlier step is how a
// stale binary reaches the owner (the 2026-07-26 incident).
const exeBuf = readFileSync(exePath);
const assetDir = join(DESKTOP, 'dist', 'assets');
const mainAsset = existsSync(assetDir) ? readdirSync(assetDir).find((f) => f.startsWith('main-') && f.endsWith('.js')) : null;
if (!mainAsset) fail('no dist/assets/main-*.js — frontend not built');
else if (!exeBuf.includes(Buffer.from(mainAsset))) fail(`exe does not embed the current frontend (${mainAsset}) — stale binary`);
else ok(`exe embeds the current frontend (${mainAsset})`);
for (const marker of ['stt:refined', 'PC_BUSY']) {
  if (readFileSync(serverJs).includes(Buffer.from(marker))) ok(`sidecar carries ${marker}`);
  else fail(`sidecar LACKS ${marker} — stale server.js`);
}
if (failed) process.exit(1);

// ── GATE 0f: the artifacts were built from the commit the gate proved (SC-5) ─
//
// The blocks above ask "are these the right bytes for THIS build?" — the right
// frontend, the pinned runtime, a current sidecar. None of them can answer the
// question the parallel ship chain creates: WHICH COMMIT are these bytes from?
// Gate 0 proves a TREE and writes a receipt naming its sha; the builds now run
// in parallel with that gate, on warm worktrees with a warm `target/`, so "the
// exe is one commit behind the receipt" is a state that occurs and that looks
// exactly like a correct round. Risk R1 of the 2026-09-17 ship-chain design.
//
// The reference sha and the three-way verdict (ok / unstamped / mismatch, with
// BLIND decided first off a control marker) live in
// scripts/build-stamp/artifact-sha-gate.mjs; the stamp itself is put into the
// exe by apps/desktop/src-tauri/build.rs and into the APK by the
// `--dart-define` in apps/mobile/Makefile, both fed by ONE rule
// (scripts/build-stamp/require-clean-sha.mjs).
//
// No bypass flag, matching Gate 0's precedent verbatim.
const gated = resolveGatedSha({ root: ROOT });
console.log(`\n── build provenance (GATE 0f) — reference: ${gated.source} ──`);
if (!verifyArtifactBuildSha({
  label: 'desktop exe',
  buf: exeBuf,
  controlMarker: EXE_CONTROL_MARKER,
  expectedSha: gated.sha,
  buildCommand: DESKTOP_BUILD_COMMAND,
  fail,
  ok,
})) process.exit(1);

// ── GATE 0d: no UNDECLARED LAN address in the bytes about to ship (OSS-DEFAULTS)
//
// The block above asks "are these the RIGHT bytes?". This asks "what is IN
// them?" — and it is asked here, before the clean/stage section below, because
// after that point server.js has already been copied into publish/ and the
// portable bundle, i.e. the leak has already been staged for distribution.
//
// Closes the open account scripts/scan-artifact-lan-ip.mjs was left holding
// ("an unrun scanner is worth exactly as much as an unrun test"). The accounting
// that keeps this gate green on a correct tree — and the argument for why the
// preset catalogue is DECLARED rather than waived away — lives in the helper:
// scripts/publish-lan-ip-gate.mjs. Same shape as the APK content gates above:
// import the scanner's functions, refuse rather than guess, no bypass flag.
//
// Deliberately scans the SOURCE artifacts, not publish/: at this moment publish/
// still holds last round's output, and refusing this round over last round's
// bytes measures the wrong build (W6R 「否则我量的是别人」).
if (!verifyArtifactsCarryNoLanIp(fail, ok)) process.exit(1);

// ── GATE 0e: the outward copy in this build has been through the AI-scent audit
//
// The gate above asks what is IN the bytes. This asks who WROTE them — whether
// the strings a stranger is about to read have been looked at by the reviewer
// that docs/rebuild/21-OUTWARD-COPY-VOICE-CONTRACT.md §M4 always said this half
// of the contract needed, and that nothing implemented until 2026-09-01.
//
// It reads a RECEIPT rather than calling the model: a release that depended on
// one LAN host being up would acquire a skip flag the first afternoon that host
// was down. The audit happens at acceptance time, when there is a person to
// argue with; publish only asks whether the copy has moved since.
//
// ⚠️ TODAY IT WARNS, and the arming switch is not a date but the stock sweep's
// own completion (`$stockSweep` in verify/copy-scent/baseline.json). 13,349
// units across nine locales have never been read by the auditor; a refusal
// landing before that sweep would be red on day one for a reason nobody could
// clear in one sitting, which is how gates die here. The module says all of
// this out loud on every run rather than passing silently.
if (!(await verifyCopyAudited(fail, ok))) process.exit(1);

// ── clean + recreate ────────────────────────────────────────────────────────
// A best-effort clean, NOT a precondition. On Windows a shell whose cwd is inside
// publish/, an editor watching it, or an antivirus scanning a fresh MSI all hold
// the directory and rmdir fails EBUSY. Refusing to publish over that would block
// staging for a reason that has nothing to do with the artifacts, which is worse
// than a stale leftover: every file below is overwritten by name anyway, and the
// SHA256 sidecars make "which build is this" answerable regardless. So: try to
// clean, say so if we could not, and carry on.
//
// Post-RV-73 there is ONE holder this branch should no longer ever see: a FlowMic
// running out of publish/. That was the every-round EBUSY, and the run copy now
// lives outside this tree — so if it happens anyway, say what to do about it
// instead of quietly absorbing it (this is the only place that state is visible).
//
// The cross-machine gate is asked AGAIN here, next to the removal it governs:
// publish/ is shared between windows (up6 measured another window staging an
// artifact there mid-card) and Gate 0 takes minutes, so the earlier answer is a
// claim about a directory that has since moved on.
const adoptedNow = verifyAdoptedArtifactsSurvive({ outDir: OUT, version: VERSION });
if (adoptedNow.refusal) { fail(adoptedNow.refusal); process.exit(1); }
try {
  if (adoptedNow.keep.length > 0) removeAllExcept(OUT, adoptedNow.keep, (m) => console.log(m));
  else rmSync(OUT, { recursive: true, force: true });
} catch (e) {
  console.log(`· could not clear ${OUT} (${e.code}) — overwriting in place`);
  console.log('  (if the holder is a FlowMic launched from publish/: the run directory has already been split out,');
  console.log('   use `node scripts/install-local.mjs` to update the run copy, do not launch from here again — RV-73)');
  // Whatever survived, an artifact from ANOTHER version must not linger beside
  // this one: two MSIs a digit apart in one directory is precisely the「装了哪
  // 一版」confusion the per-round bump exists to end. Drop them by name.
  for (const f of readdirSync(OUT)) {
    // `zip` joined this list with card UP-1: the portable bundle is now shipped
    // as FlowMic-<VERSION>-portable-<platform>.zip, so a leftover from an older
    // round is the same 「装了哪一版」 confusion two MSIs side by side would be.
    if (!/\.(msi|apk|zip)(\.sha256)?$/i.test(f) || f.includes(VERSION)) continue;
    try {
      rmSync(join(OUT, f), { force: true });
      console.log(`· dropped stale ${f}`);
    } catch { /* locked too — the SHA sidecars still disambiguate */ }
  }
}
mkdirSync(join(PORTABLE, 'resources'), { recursive: true });

console.log('\n── license notice (card L4) ──');
// Third-party attribution owed under Apache-2.0 §4(d) + the bundled MIT
// dependencies' own terms — belongs beside BOTH distribution forms, not just
// the one Vite embeds into the exe's webview (apps/desktop/public/NOTICE):
// the portable bundle and the MSI's install directory are both places a user
// or reviewer might look for it without ever opening the app.
stage(noticeSrc, OUT);
stage(noticeSrc, PORTABLE);

console.log('\n── installers ──');
// Only THIS version's installers. The Tauri bundle dir accumulates every MSI it
// has ever produced, so an unfiltered copy puts two versions side by side in
// publish/ — and the owner installs from publish/, so that is a coin-flip about
// which build lands on their machine. Filter by the reference version.
const msis = existsSync(BUNDLE)
  ? readdirSync(BUNDLE).filter((f) => f.endsWith('.msi') && f.includes(VERSION))
  : [];
if (msis.length === 0) fail(`no ${VERSION} MSI in target/release/bundle/msi (stale bundle? run tauri:build)`);
const staged = msis.map((f) => stage(join(BUNDLE, f), OUT));

console.log('\n── android ──');
// ST-1 (2026-08-19): the phone now builds two channels, and only ONE of them is
// ours to publish. `app-direct-release.apk` is the flavour that carries the
// self-updater; the store flavour deliberately does not, so a user who got it
// from our site would be stranded on that version forever with no way to hear
// about the next one.
//
// 🔴 The pre-flavour name is kept as a candidate and is NOT a fallback for
// convenience: an `app-release.apk` on disk today is a leftover from a build
// made before the split, and the gates below (version + self-update marker)
// are what decide whether it may ship — the same three questions asked of any
// candidate. What must never happen is the STORE artifact being staged as the
// public download, and that cannot happen by path: its bundle is an `.aab`
// under build/app/outputs/bundle/, which no candidate here names.
const apkCandidates = [
  join(ROOT, 'apps', 'mobile', 'build', 'app', 'outputs', 'flutter-apk', 'app-direct-release.apk'),
  join(ROOT, 'apps', 'mobile', 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk'),
  join(ROOT, '.local', 'dist', `FlowMic-${VERSION}-release.apk`),
];
const apk = apkCandidates.find(existsSync);
// The name carries the version, read from the SAME root package.json the
// version-sync lint treats as the reference. It used to be the hard-coded string
// 'FlowMic-0.1.0-release.apk', which meant that the moment the patch digit
// started moving (owner 2026-07-27) the filename actively LIED about which build
// it was — the exact confusion the per-round bump exists to end.
//
// That fixed the STRING but not the underlying trust problem: the first
// candidate (flutter's raw output) never had a version in its name to begin
// with, so nothing stopped a stale build from being renamed straight into a
// filename that now claims to be current. verifyApkVersion() reads the
// version the APK actually declares (via aapt) before it is staged — see card
// PUB — instead of trusting the candidate path or the string we are about to
// write.
//
// Card UP-7 adds a SECOND question about the same file; card W8-6 a THIRD
// (current LAN-TLS disclosure copy vs the pre-rewrite text). All checks are
// RUN before any verdict is combined — that is why each call is made on its
// own line into a local, rather than folded into one `&&` expression, which
// would skip later checks whenever an earlier one already failed. When an APK
// fails more than one of these, an operator should be told all of them in one
// run rather than rebuild, re-run, and discover the next one four minutes
// later. (Each call reports its own line via fail()/ok() as a side effect, so
// "was it called" and "what does the operator see" are the same question here.)
if (apk) {
  const versionOk = Boolean(verifyApkVersion(apk, VERSION, fail, ok));
  const featureOk = verifyApkCarriesSelfUpdate(apk, fail, ok);
  const disclosureOk = verifyApkDisclosureCopy(apk, fail, ok);
  // Its own gate, not a clause in the version check: "right build?" and "did
  // the pin reach the bytes?" are two questions. (File is AT the 800 cap.)
  const targetOk = verifyApkTargetSdk(apk, fail, ok);
  // GATE 0f's mobile half (SC-5): the same provenance question the exe answered
  // above. Asked here because this is where the APK bytes are in hand, and on
  // the same terms — its own gate, its own verdict, no clause folded into
  // another check.
  const shaOk = verifyArtifactBuildSha({
    label: `APK ${apk.split(/[\\/]/).pop()}`,
    buf: readFileSync(apk),
    controlMarker: APK_CONTROL_MARKER,
    expectedSha: gated.sha,
    buildCommand: MOBILE_BUILD_COMMAND,
    fail,
    ok,
  });
  if (versionOk && featureOk && disclosureOk && targetOk && shaOk) stage(apk, OUT, `FlowMic-${VERSION}-release.apk`);
} else {
  console.log('· no APK found — skipped (mobile unchanged this round)');
}

// ── the one-click portable bundle ───────────────────────────────────────────
console.log('\n── portable (one-click, server bound in) ──');
stage(exePath, PORTABLE, 'FlowMic.exe');
copyFileSync(serverJs, join(PORTABLE, 'resources', 'server.js'));
ok(`resources/server.js  (${mb(join(PORTABLE, 'resources', 'server.js'))} MB)`);
// `{"type":"module"}` — the bundle is ESM in a `.js`, so without this beside it
// Node falls back to guessing module syntax, which only happens by default from
// 22.7. The portable bundle carries its own node.exe and would survive either
// way; it is copied anyway so the two shapes stay byte-comparable and nobody
// later concludes the file is MSI-only trivia.
copyFileSync(serverPkg, join(PORTABLE, 'resources', 'package.json'));
ok('resources/package.json  ({"type":"module"})');

// The private Node runtime. resolve_node_exe() (sidecar/node_runtime.rs) checks
// for an exe-sibling node.exe FIRST, so this copy is what the bundle runs against
// — never whatever Node the host may or may not have. Without it the bundle would
// only "work" on machines that already have Node, which is not portable at all.
//
// Copied from the STAGED runtime rather than from `process.execPath`, even though
// build-sidecar.mjs stages it out of process.execPath in the first place: since
// owner's 2026-08-03 ruling the MSI carries this runtime too, and the two
// artifacts have to be able to answer 「哪个 Node」 with one answer. Reading the
// same file both installers were built from is that one answer; reading
// process.execPath again would be a second source that merely happens to agree
// today.
copyFileSync(stagedNode, join(PORTABLE, 'node.exe'));
ok(`node.exe  (${mb(join(PORTABLE, 'node.exe'))} MB)  from ${stagedNode}`);
let nodeVersion = 'unknown';
try {
  nodeVersion = execFileSync(join(PORTABLE, 'node.exe'), ['-v'], { encoding: 'utf8' }).trim();
  ok(`bundled runtime answers: node ${nodeVersion}`);
} catch (e) {
  fail(`bundled node.exe did not run: ${e.message}`);
}

// The sherpa addon — the half of fix-028 the distribution side never got
// (card ENG-1b; the why/shape live on the function itself). Then the SAME gate
// tauri:build ends with, aimed at THIS tree and running THIS bundle's node.exe
// — a green gate on the staging dir was exactly how 0.2.62 shipped a portable
// zip whose first utterance could not open the stock engine.
if (stagePortableSherpaAddon({ tauriResources: join(TAURI, 'resources'), portableDir: PORTABLE, fail, ok })) {
  const sherpaGate = spawnSync(process.execPath, [
    join(DESKTOP, 'scripts', 'verify-sherpa-sidecar-addon.mjs'),
    '--resources', join(PORTABLE, 'resources'),
    '--node', join(PORTABLE, 'node.exe'),
  ], { stdio: 'inherit' });
  if (sherpaGate.status !== 0) fail('the portable tree cannot load the sherpa addon (gate output above)');
  else ok('portable tree loads sherpa with its own runtime');
}

writeFileSync(join(PORTABLE, 'README.txt'), portableReadmeText(VERSION));
ok('README.txt (portable)');

// ── the manifest owner-facing README ──────────────────────────────────────
const filesBlock = staged.map((s) => `#   ${s.name}\n#     SHA256 ${s.hash}`).join('\n');
let head = '';
try {
  head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch { /* not fatal — the hashes below are the real identity */ }

writeFileSync(join(OUT, 'README.txt'), releaseFolderReadmeText({ version: VERSION, head, mainAsset, nodeVersion, filesBlock }));
ok('README.txt (release folder)');
// The two text files above are the only user-facing prose this script emits, and
// they carried a hard-coded `0.1.0` for four minor versions — shipped in every
// bundle, telling the owner 「版本号恒为 0.1.0」 long after the per-round bump had
// made that false. Filenames were templated; prose was not, and nothing checked.
// 13 册 D5 is 「看版本号分不出新旧」; this is the same lesson leaking through the
// one surface no lint was watching.
for (const [label, file] of [['README.txt (portable)', join(PORTABLE, 'README.txt')], ['README.txt (release folder)', join(OUT, 'README.txt')]]) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(VERSION)) fail(`${label} does not mention ${VERSION} — a shipped file that lies about its own version`);
  const stale = [...text.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]).filter((v) => v !== VERSION && v !== nodeVersion.replace(/^v/, ''));
  if (stale.length > 0) fail(`${label} still carries stale version literal(s): ${[...new Set(stale)].join(', ')}`);
}
ok(`shipped text mentions ${VERSION} and nothing staler`);


if (failed) {
  console.error('\n✗ publish FAILED');
  process.exit(1);
}

// The portable bundle as a distributable FILE (card UP-1), then the gate that
// refuses it when the exe inside lacks the in-place self-updater (card UP-9).
//
// Both halves live in scripts/publish-portable-archive.mjs, comments verbatim —
// not for tidiness: this file stood at 798 lines against verify:lint's 800-line
// cap, so the UP-9 gate physically could not be added inline, and 「按仓里成例
// 做结构拆分而不是删证据」is the repo's rule for exactly that situation.
//
// The CALL SITE stays here, in this position — after every preflight above,
// before the download-center step below — because that ordering is the whole
// wiring: it makes "the portable ships too, and only if it is not stale" a
// call-order fact in this file rather than a step someone has to remember.
//
// 🔴 It EXITS on refusal rather than setting `failed`: this runs AFTER the last
// `if (failed) process.exit(1)` above, so a flag nobody reads again would let a
// refused artifact upload anyway.
publishPortableArchive({ root: ROOT, outDir: OUT, version: VERSION, fail, ok });

console.log(`\n✓ published → ${OUT}`);

// ── LAN download center (owner 2026-07-31) ──────────────────────────────────
// A release = two halves: ./publish (local artifact area) + the LAN download
// center (team distribution face). Doing only the first half and not saying
// the second half was skipped is silent failure at the process layer — so they
// are chained by default; skipping must be an explicit --skip-lan (for offline
// rounds). On failure the local staging is still intact; re-run
// `node scripts/publish-download-center.mjs` alone to catch up, no need to
// re-walk the whole publish.
if (!process.argv.includes('--skip-lan')) {
  console.log('\n── LAN download center ──');
  // Card IT-33. scripts/publish-download-center.mjs is the internal LAN
  // publisher (site address, how the publish key is fetched, network
  // whitelist) and is DELIBERATELY excluded from the open-source export
  // (docs/strategy/2026-08-02-opensource-content-list-and-history-audit.md
  // §4-③, §5 last row). A tree built from that export will never have this
  // file — that is the tree's permanent shape, not a transient fault.
  //
  // Routing this through the same catch block as a real upload failure
  // (below) was considered and rejected: that message tells the operator to
  // re-run `node scripts/publish-download-center.mjs`, which is actively
  // wrong advice for a file that will never exist here — it reads as "this
  // failed, try again", not "this capability was never shipped to you".
  // Skipping it silently was rejected too, for the reason written into the
  // comment above this block: "只做前半而不说后半没做，就是流程层的静默
  // 失败" — a silent skip here would recreate exactly that shape, in the one
  // tree where nobody has a real LAN download center to notice the gap
  // against. So: named, loud, and — deliberately — NOT fatal. Treating
  // "this capability is absent by design" as a hard failure would mean
  // publish.mjs cannot succeed even once on an open-source checkout unless
  // every invocation remembers an undocumented-to-them flag; that is a worse
  // outcome than a very visible non-fatal notice, for a tree where this was
  // never going to work regardless of what today's run does differently.
  const downloadCenterScript = join(ROOT, 'scripts', 'publish-download-center.mjs');
  if (!existsSync(downloadCenterScript)) {
    console.log('⚠ scripts/publish-download-center.mjs is ABSENT from this tree.');
    console.log('  This is the open-source export, which does not ship the internal LAN');
    console.log('  publisher (site address, publish-key fetch procedure, network whitelist).');
    console.log('  Nothing was uploaded anywhere. ./publish/ above is already complete and');
    console.log('  correct on its own — to distribute it yourself, host those files however');
    console.log('  fits your infrastructure, or run `node scripts/install-local.mjs` for a');
    console.log('  local run copy.');
    if (WITH_MANIFEST) {
      console.log('  · --with-manifest also skipped: it writes URLs into the same LAN download');
      console.log('    center this tree has no way to publish to.');
    }
  } else {
    try {
      execFileSync(process.execPath, [downloadCenterScript], { stdio: 'inherit' });
    } catch {
      console.error('\n✗ 内网下载中心发布 FAILED（本地 ./publish 已完成且可用；修复后单独重跑 node scripts/publish-download-center.mjs）');
      process.exit(1);
    }
    // S7: wired in HERE — after the upload above has already returned success —
    // and nowhere earlier, so "artifacts first, then manifest" is a call-order
    // fact in this file instead of a rule someone has to remember to follow by
    // hand. Opt-in via --with-manifest: build-update-manifest.mjs remains a
    // fully standalone, independently-runnable script (unchanged by this) for
    // anyone who wants to publish and update the manifest as two separate,
    // deliberate acts instead.
    if (WITH_MANIFEST) {
      console.log('\n── update manifest (--with-manifest) ──');
      try {
        execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-update-manifest.mjs')], { stdio: 'inherit' });
      } catch {
        console.error('\n✗ update-manifest generation FAILED (artifacts and LAN download center are both ready; after the fix, re-run node scripts/build-update-manifest.mjs alone)');
        process.exit(1);
      }
    }

    // ── ruling ① companion gate (owner 2026-08-10): the LIVE face must agree ──
    //
    // Measured on 0.2.61's release evening (device-line handoff §8-1): relay
    // health, three APK byte gates, download-center /latest and artifact sha256
    // were ALL green while the public /api/updates/latest still advertised
    // 0.2.59 — every gate measured "is the package right", none measured "will
    // the update service tell anyone it exists". This gate asks exactly that,
    // at the only moment it can be asked honestly: after the artifacts are on
    // the download center. It runs on every LAN-publishing run — with or
    // without --with-manifest, because the live face can be stale either way
    // (skipping the manifest step entirely is precisely how 0.2.61 shipped).
    //
    // It fails HARD on mismatch so a publish run cannot end green while clients
    // are still being told the previous version is the latest. That means a
    // normal first run ends RED here until the manifest is deployed — that is
    // the ruling's stated shape («不让你以为做完了», not «帮你生成»), not a
    // defect: this script deploys nothing (production deploys belong to the
    // device line — docs/FLEET.md), so "done" is simply not this script's to
    // declare until the public endpoint says so. The message below names what
    // remains; the gate re-runs standalone until green.
    // 🔴 The freeze exit replaces the gate; it never makes the gate pass. Same
    // stopping point, same sentence ("the live manifest was not updated, and
    // here is what it still points at"), different exit code — because in a
    // freeze round that state is where the round was always going to end. The
    // flag is the only thing separating it from a round that forgot.
    if (FREEZE_ROUND) {
      console.log(await freezeNotice({ version: VERSION }));
    } else if (MANIFEST_DEFERRED) {
      console.log(await deferredNotice({ version: VERSION }));
    } else {
    console.log('\n── live update-manifest check (ruling ① 2026-08-10 companion gate) ──');
    try {
      execFileSync(process.execPath, [join(ROOT, 'scripts', 'verify-live-update-manifest.mjs')], { stdio: 'inherit' });
    } catch {
      console.error('\n✗ live /api/updates/latest has not yet announced this round\'s version —— 发布还没有做完。');
      console.error('  The artifact and LAN-download-center halves are fine; what is missing is the 「更新服务告诉客户端有新版」 half-step:');
      console.error('    1. node scripts/build-update-manifest.mjs   (if this round did not use --with-manifest)');
      console.error('    2. deploy publish/update-manifest.json as live /etc/flowmic-app/updates.json');
      console.error('       (production deploys belong to the device line — docs/FLEET.md)');
      console.error('    3. node scripts/verify-live-update-manifest.mjs   (re-run this gate until green)');
      process.exit(1);
    }
    }
  }
} else {
  console.log('\n· --skip-lan：跳过内网下载中心（本轮产物只在 ./publish，团队拿不到 —— 补发跑 node scripts/publish-download-center.mjs）');
  if (FREEZE_ROUND) {
    console.log(`  · ${FREEZE_FLAG} had nothing to do this round: the manifest gate only runs after a download-centre upload, and this run uploaded nothing.`);
  }
}

// ./publish is a PRODUCT directory (RV-73). Nothing above launched anything and
// nothing above wrote outside it — so the last word here is the one action that
// takes a build from "staged" to "the copy I actually run", named out loud.
console.log('\n下一步（发布不会替你做，这是 RV-73 的整个要点）：');
console.log('  · update the local run copy:  node scripts/install-local.mjs');
console.log('  · install on the phone:       node scripts/serve-apk.mjs  then open the printed URL on the phone');
console.log('  ⚠ do not launch FlowMic from publish/ — these files will be overwritten next round.');
if (!WITH_MANIFEST) {
  console.log('  · update manifest: not generated this round (off by default). Add --with-manifest to generate');
  console.log('    update-manifest.json automatically after a successful LAN download-center publish; or run node scripts/build-update-manifest.mjs later on its own.');
}

