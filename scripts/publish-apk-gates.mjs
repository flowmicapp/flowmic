// The APK content gates of scripts/publish.mjs: version self-report (card PUB),
// self-update feature marker (card UP-7), and LAN-TLS disclosure-copy marker
// (card W8-6).
//
// ── why this is its own file ────────────────────────────────────────────────
//
// Not a preference. scripts/publish.mjs was already against verify:lint's
// 800-line cap; adding the W8-6 gate inline pushed it to 816. The repo's rule
// for that situation is explicit: 「按仓里成例做结构拆分而不是删证据」
// (CLAUDE.md; same precedent as scripts/publish-portable-archive.mjs for UP-9).
// Every comment moved here is VERBATIM from publish.mjs; nothing was shortened
// to buy room.
//
// The three questions belong together: each is asked of the same APK bytes
// before stage(), each refuses rather than guessing, and none may short-circuit
// the others (an operator who faces a stale version AND a missing feature AND
// stale disclosure copy should hear all three in one run).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  APK_BUILD_COMMAND,
  APK_SELF_UPDATE_MARKER,
  scanApkForSelfUpdate,
  selfUpdateRefusalMessage,
} from './apk-self-update-marker.mjs';
import {
  scanApkForDisclosureCopy,
  disclosureCopyRefusalMessage,
} from './apk-disclosure-copy-marker.mjs';

// ── APK self-verification (card PUB) ──────────────────────────────────────────
// The MSI branch above is already safe because it filters candidates by
// filename (`f.includes(VERSION)`). The APK branch was NOT: the flutter build
// output is unconditionally named `app-release.apk` — no version anywhere in
// the name — and this script used to rename it to `FlowMic-${VERSION}-release.apk`
// on trust alone. Forget to rebuild after a version bump and the artifact's
// name would actively lie about what is inside it, which is the exact failure
// the per-round version bump exists to end (13 册 D5).
//
// A filename (old or new) is not evidence — it is exactly the thing this bug
// showed you cannot trust. Neither is pubspec.yaml or a mtime: both describe
// intent, not the built artifact. The only measurement that is as hard as the
// thing it is protecting is asking the APK itself, the same way Android does
// at install time: `aapt dump badging` reads versionName out of the compiled
// manifest inside the archive. That is the row that survives compression,
// signing, and a careless rename — so it is what gets compared to VERSION.
function cmpVersionDirs(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Locates an aapt/aapt2 binary without ever assuming one exists — this is a
// dev-machine tool (Android SDK build-tools), not a package dependency, so a
// clean CI box or a fresh checkout may legitimately not have it.
function findAapt() {
  const sdkRoots = [];
  for (const envVar of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    if (process.env[envVar]) sdkRoots.push(process.env[envVar]);
  }
  if (process.env.LOCALAPPDATA) sdkRoots.push(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  for (const sdkRoot of sdkRoots) {
    const buildTools = join(sdkRoot, 'build-tools');
    if (!existsSync(buildTools)) continue;
    let versions;
    try {
      versions = readdirSync(buildTools);
    } catch {
      continue;
    }
    versions.sort(cmpVersionDirs).reverse();
    for (const v of versions) {
      for (const bin of ['aapt.exe', 'aapt2.exe']) {
        const p = join(buildTools, v, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

// Reads back what the APK itself declares — not what we hope it declares —
// and fails the publish (does not silently stage) on any of: tool missing,
// tool errored, badging output unparsable, or a real mismatch. Returns the
// declared versionName on success so the caller can log it, or null on any
// failure (fail() has already been called by then).
export function verifyApkVersion(apkPath, expected, fail, ok) {
  const label = apkPath.split(/[\\/]/).pop();
  const aapt = findAapt();
  if (!aapt) {
    // No silent pass: an APK's filename lied before (that is this whole bug),
    // so "looks fine, didn't check" is not an acceptable outcome for a shipped
    // artifact. Refuse rather than guess.
    fail(
      `cannot verify ${label}'s real version — no aapt/aapt2 found ` +
        `(checked $ANDROID_HOME, $ANDROID_SDK_ROOT, %LOCALAPPDATA%\\Android\\Sdk\\build-tools\\*). ` +
        `Refusing to stage an APK whose version was read from its filename instead of the ` +
        `artifact itself — install Android SDK build-tools or point ANDROID_HOME at one, then re-run.`
    );
    return null;
  }
  let badging;
  try {
    badging = execFileSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' });
  } catch (e) {
    fail(`aapt could not read ${label}: ${e.message}`);
    return null;
  }
  const m = badging.match(/versionName='([^']*)'/);
  if (!m) {
    fail(`aapt dump badging for ${label} had no versionName= — cannot verify (raw: ${badging.slice(0, 120)})`);
    return null;
  }
  if (m[1] !== expected) {
    fail(
      `${label} self-reports versionName='${m[1]}' but this round is ${expected} — stale APK, ` +
        `refusing to stage it as FlowMic-${expected}-release.apk. Rebuild with ` +
        // Card UP-7: this line used to name the BARE `flutter build apk --release`.
        // A refusal message is a documented command — arguably the most obeyed one
        // in the repo, since it is read at the moment someone is about to act — and
        // that bare form is precisely what silently drops the self-update feature.
        `\`${APK_BUILD_COMMAND}\` after the version bump.`
    );
    return null;
  }
  ok(`${label} self-reports versionName='${m[1]}' via ${aapt.includes('aapt2') ? 'aapt2' : 'aapt'} dump badging (matches ${expected})`);
  return m[1];
}

// ── APK feature-content verification (card UP-7) ────────────────────────────
//
// verifyApkVersion() above answers "is this the RIGHT BUILD?". It cannot answer
// "does this build CONTAIN the feature?" — versionName is stamped from
// pubspec.yaml and is identical whether or not the self-update define was
// passed. Those two APKs differ by 376,752 bytes and by nothing a filename, a
// manifest, or a mtime can see.
//
// So this asks the payload, the same way the exe/sidecar marker block below
// does. The full both-directions measurement, the control-marker rationale, and
// the deliberate absence of a bypass flag live in the helper's header:
// scripts/apk-self-update-marker.mjs. Returns true when the APK may be staged.
export function verifyApkCarriesSelfUpdate(apkPath, fail, ok) {
  const label = apkPath.split(/[\\/]/).pop();
  const scan = scanApkForSelfUpdate(readFileSync(apkPath));
  if (scan.verdict !== 'ok') {
    fail(selfUpdateRefusalMessage(label, scan));
    return false;
  }
  ok(
    `${label} carries the self-update feature ('${APK_SELF_UPDATE_MARKER}' ×${scan.feature}, ` +
      `one per ABI; control ×${scan.control})`
  );
  return true;
}

// ── APK disclosure-copy verification (card W8-6) ────────────────────────────
//
// verifyApkVersion() answers "right build?". verifyApkCarriesSelfUpdate()
// answers "self-update present?". Neither can answer "is the LAN-TLS
// disclosure the rewrite, or the pre-rewrite text that said encryption was
// still unfinished?". 0.2.60 shipped encryption with the old sentence still
// in libapp.so — every other gate green. Same content-marker pattern as UP-7;
// helper header carries the both-directions measurement and the UTF-16LE trap:
// scripts/apk-disclosure-copy-marker.mjs. Returns true when the APK may be staged.
// scanner-blind is also a refuse — "I don't know" must not pass as "fine".
export function verifyApkDisclosureCopy(apkPath, fail, ok) {
  const label = apkPath.split(/[\\/]/).pop();
  const scan = scanApkForDisclosureCopy(readFileSync(apkPath));
  if (scan.verdict !== 'ok') {
    fail(disclosureCopyRefusalMessage(label, scan));
    return false;
  }
  ok(
    `${label} carries current LAN-TLS disclosure copy ` +
      `(new markers present, old markers absent; utf16le controls ok)`
  );
  return true;
}
