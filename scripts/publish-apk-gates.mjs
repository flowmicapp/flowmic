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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// output is named for the flavour and the build type only
// (`app-direct-release.apk` since ST-1, `app-release.apk` before it) — no
// version anywhere in
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
// Exported under a distinct name (ST-1, 2026-08-19) so the store-channel gate
// asks the SAME locator rather than growing a second one. Two finders would
// eventually disagree about which build-tools version is in use, and the answer
// would differ between the gate that publishes and the gate that refuses.
export function findAaptForGates() {
  return findAapt();
}

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
// ⚠️ It also carries the target-API-level gate — see the 🔴 block at the end of
// this function for why that is here and what has to happen for it to leave.
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
  // The three branches below used to `return null` on the spot. They now set a
  // flag instead, for one reason: the target-API-level gate is asked AFTER
  // them, and publish.mjs's own comment requires that an operator facing more
  // than one defect hears all of them in one run rather than rebuilding,
  // re-running and discovering the next one four minutes later. Every message
  // is VERBATIM what it was before the restructure; only the control flow moved.
  const m = badging.match(/versionName='([^']*)'/);
  let versionOk = false;
  if (!m) {
    fail(`aapt dump badging for ${label} had no versionName= — cannot verify (raw: ${badging.slice(0, 120)})`);
  } else if (m[1] !== expected) {
    fail(
      `${label} self-reports versionName='${m[1]}' but this round is ${expected} — stale APK, ` +
        `refusing to stage it as FlowMic-${expected}-release.apk. Rebuild with ` +
        // Card UP-7: this line used to name the BARE `flutter build apk --release`.
        // A refusal message is a documented command — arguably the most obeyed one
        // in the repo, since it is read at the moment someone is about to act — and
        // that bare form is precisely what silently drops the self-update feature.
        `\`${APK_BUILD_COMMAND}\` after the version bump.`
    );
  } else {
    ok(`${label} self-reports versionName='${m[1]}' via ${aapt.includes('aapt2') ? 'aapt2' : 'aapt'} dump badging (matches ${expected})`);
    versionOk = true;
  }
  // 🔴 THIS FUNCTION ANSWERS ONE QUESTION: IS THIS THE RIGHT BUILD?
  //
  // The target-API-level check briefly lived here, called from inside this
  // function, because the card that wrote it could not edit publish.mjs while
  // another window held it — and an exported gate with no caller is this
  // repo's number-one historical defect class. That call is gone: the fourth
  // gate now sits beside the other three in scripts/publish.mjs, where
  // "may this APK be staged" is decided.
  // Not left to memory either way: scripts/apk-target-sdk-gate.test.mjs counts
  // the production call sites and goes red at zero AND at two — the second
  // direction is the one that matters here, because leaving both callers would
  // dump badging twice and print every target-level verdict twice.
  return versionOk ? m[1] : null;
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

// ── APK target-API-level verification (artefact half of the S7 SDK pin) ─────
//
// ── two questions, and this file answers only the second ────────────────────
//
//   "does apps/mobile/android/app/build.gradle.kts STATE targetSdk N?"
//        → answered by scripts/android-sdk-pin.test.mjs, in every clone, with
//          no SDK and no artefact, on every delivery.
//   "do the bytes we are about to stage REPORT targetSdkVersion N?"
//        → answered HERE, and nowhere else in the repo.
//
// They are different claims and this repo has a standing proof that they can
// disagree: UP-7 published an APK missing an entire feature while every
// source-side gate stayed green. Between the pinned line and the compiled
// manifest sit AGP, the manifest merger, the `--flavor` split,
// manifestPlaceholders, and any `<uses-sdk>` a plugin's own manifest
// contributes — none of which a text read of the build file can see. The pin
// drill's header states that gap and names this file as where the artefact half
// belongs; this is that half, put on the one path where the artefact is
// guaranteed fresh AND guaranteed to be the one that ships.
//
// The cost of getting it wrong is not a red test: Google Play's target-API
// floor rises every year and a package below it is refused at submission, i.e.
// at the most expensive moment available.
//
// ── 🔴 WHERE THE EXPECTED NUMBER COMES FROM, and what was rejected ──────────
//
// CHOSEN: read it from build.gradle.kts at publish time. The build file is the
// SSOT for what this tree intends to ship, so comparing the artefact against it
// asks precisely the seam question above — "did the pin reach the bytes?" — and
// a deliberate bump to 37 needs no edit here at all.
//
// REJECTED: a constant in this file (`const EXPECTED_TARGET_SDK = 36`). Its
// obvious cost is a third copy of a number that already lives in two places.
// Its real cost is worse, and it is a FALSE GREEN — the failure direction this
// whole gate exists to prevent:
//
//   someone raises the pin to 37 and forgets to rebuild (or the merger
//   overrides it, or a plugin's uses-sdk wins). The artefact reports 36. A
//   hard-coded 36 compares 36 to 36 and says PASS, while the tree says 37.
//
// A hard-coded expectation never compares source to artefact; it compares the
// artefact to something someone typed once. It would also go red at release
// time after a legitimate bump — mid-release, with no bypass flag by
// precedent — and the operator's fix would be to edit the constant, which is
// the moment the check quietly stops meaning anything.
//
// The accepted cost of the chosen option is coupling to a source file's
// spelling, and it is handled by failing CLOSED: anything that is not a bare
// integer yields NO expectation and a refusal that says so, never a guess.
//
// ── 🔴 why the pin parser is written twice ──────────────────────────────────
//
// scripts/android-sdk-pin.test.mjs contains a parser for this same line, and
// this file does not import it — deliberately, and not for taste. That file
// registers `node:test` cases at module scope, so importing it would run the
// SDK-pin drill inside publish.mjs in the middle of a release. Two parsers for
// one fact is the shape this repo has been burned by (the hand-kept FACES table
// vs the lint that walks the directory), so the bound on the damage is stated
// rather than hoped for: this copy is strictly narrower (it reads `targetSdk`
// only) and every verdict except `literal` is a REFUSAL, so a drift between the
// two parsers can cost a false red, never a false green.
//
// ── 🔴 blind vs failing: three controls, because they demand opposite actions
//
// "this APK targets the wrong level" and "this scan could not read the level"
// are not the same sentence and do not send anyone to the same place. Same
// discipline as scanApkForSelfUpdate (control marker) and declaredPermissions
// (no-tool vs unreadable, split after that gate got it wrong on its first real
// run). The dump is read through a hierarchy of controls, each one deciding
// what the ABSENCE of the target field means:
//
//   control A  `package: name=`   present in every badging dump. Absent ⇒ this
//                                 is not a badging dump at all (aapt printed
//                                 something else, or the output format
//                                 changed). Verdict 'blind-not-badging'.
//   control B  `sdkVersion:'NN'`  aapt's spelling of minSdk, printed from the
//                                 same <uses-sdk> parse as the target level. A
//                                 present, B absent ⇒ the uses-sdk section is
//                                 not in the dump. AGP always injects one, so
//                                 this is the scanner's problem, not the
//                                 manifest's. Verdict 'blind-no-uses-sdk'.
//   B present, target absent      ⇒ the dump DID print uses-sdk and there is
//                                 genuinely no target level in it. That is a
//                                 real defect (Android then treats minSdk as
//                                 the target and Play refuses the upload), not
//                                 a blind scan. Verdict 'no-target-field'.
//
// ── 🔴 refusal or skip? (an unreadable field is a REFUSAL) ──────────────────
//
// Every non-ok verdict refuses. The alternative — a named skip on the blind
// ones so a formatting change cannot block a release — was weighed and dropped,
// for two reasons:
//   1. a gate that is dark by default is indistinguishable from a gate that is
//      not there, and this one is asked at most a few times a week (only when
//      an APK is staged), so nobody would notice it had gone dark;
//   2. 'blind-no-uses-sdk' and 'no-target-field' are exactly the output shapes a
//      merger regression would produce. Skipping there means skipping in the
//      case the gate was built for.
// What the skip option was protecting against is answered instead by the
// MESSAGE: a blind verdict never says "rebuild", it says "re-measure by hand"
// and prints the first line of the dump it could not read. The operator is
// never sent to the wrong place, which is the actual harm a wrong refusal does.
// No bypass flag, matching this file's other gates: if this ever has to be
// skipped, the honest way is to delete these lines where someone can see it.
//
// ── 🔴 REVERSE CONTROL — on the real staged artefact, both directions ───────
//
// Machine dev-pc-a, 2026-08-19, all [measured]. (`dev-pc-a` is this repo's
// export-safe alias for the primary dev machine, the spelling its neighbours
// already use: the open-source absent-sweep refuses the real hostname in any
// exported file, and this file is exported. Writing the hostname here was
// measured red by scripts/c10-oss-absent-sweep-lint.test.mjs before this line
// was fixed — CLAUDE.md's "a measurement must name its machine" and the export
// rule are both satisfied by the alias, not by dropping the attribution.)
// The artefact is the one this tree had already built —
// apps/mobile/build/app/outputs/flutter-apk/app-direct-release.apk, 75,908,946 B
// — read as-is: NOTHING was rebuilt for this measurement, and no Flutter or
// Gradle command was run. aapt = build-tools/35.0.1/aapt.exe. The `✓`/`✗` are
// the publisher's own ok()/fail() prefixes; each verdict prints as ONE line and
// is re-wrapped here to fit the column, nothing else is changed.
//
// A. the gate green on the real APK against the real build.gradle.kts:
//
//   ✓ app-direct-release.apk reports targetSdkVersion 36 via aapt dump badging
//     — matches the pin in apps/mobile/android/app/build.gradle.kts (minSdk
//     control read from the same dump: sdkVersion:'24')
//
// B. RED — same real APK, expectation moved to 35 (a synthetic build.gradle.kts
//    in a temp dir stating `targetSdk = 35`; the tracked file was NOT touched):
//
//   ✗ app-direct-release.apk reports targetSdkVersion 36, but
//     apps/mobile/android/app/build.gradle.kts pins targetSdk = 35. The staged
//     APK is not what this tree says it ships: either it predates the pin being
//     changed (rebuild with `make -C apps/mobile release (= flutter build apk
//     --release --flavor direct --dart-define=FLOWMIC_SELF_UPDATE=1)`), or the
//     manifest merger overrode the pin — read the merged AndroidManifest.xml
//     under apps/mobile/build/app/intermediates/ before touching the pin.
//     Google Play refuses an upload below its target-API floor at submission
//     time, so this must not be staged.
//
// C. BLIND — a file aapt cannot read, deliberately named `.apk` so nothing else
//    could be blamed for the refusal (19 bytes of text × 8, in a temp dir):
//
//   ✗ cannot read app-direct-release.apk's target API level — aapt failed on
//     the file: 08-19 17:03:20.791 32048 37828 W zipro   : Error opening
//     archive C:\Users\ADMINI~1\AppData\Local\Temp\flowmic-rc-sfYgZM\app-direct-release.apk:
//     Invalid file. This says NOTHING about what the APK targets; the SCAN
//     failed, not the artefact. Check the file is the APK you think it is (an
//     .aab has no AndroidManifest.xml for aapt to dump) before rebuilding
//     anything.
//
//   🔴 B and C are the whole point of the split, and they are worth reading
//   side by side: B names a REBUILD and a merged manifest, C names neither and
//   says NOTHING twice. Same file name in both — so the only thing separating
//   "your APK is wrong" from "I could not look" is the control hierarchy.
//
// D. and the third shape, because it has its own action — same real APK, with
//    the expectation pointed at a synthetic build file that has gone back to
//    inheritance:
//
//   ✗ cannot check app-direct-release.apk's target API level — the expectation
//     could not be sourced from apps/mobile/android/app/build.gradle.kts:
//     targetSdk is 'inherited' (`flutter.targetSdkVersion`) — for the record,
//     these bytes report targetSdkVersion 36. Nothing in this tree states what
//     it SHOULD report, so the comparison cannot be made. This is a SOURCE-side
//     problem, not an artefact one: run `pnpm verify:scripts` —
//     scripts/android-sdk-pin.test.mjs owns that question and refuses this same
//     state with the full diagnosis.
//
// Nothing tracked was edited to obtain B and D: the expectation was moved by
// pointing `opts.gradlePath` at a temp file, so `build.gradle.kts` never left
// its pinned state and no `git` command was involved in restoring anything.
// After each reading the temp dir was removed and A was re-run green.
//
// ── 🔴 WHAT THIS GATE DOES NOT PROVE ────────────────────────────────────────
//
//   · nothing about the AAB. Play receives `app-store-release.aab`, this reads
//     an APK. store-channel-gate.mjs is the file that reads bundles, and it
//     does NOT ask this question today;
//   · nothing about compileSdk or minSdk. minSdk is read only as a CONTROL —
//     its value is printed for the operator, never compared to anything;
//   · nothing about whether 36 is still Play's floor on the day you read this.
//     It asserts source-artefact AGREEMENT, not policy compliance; the floor
//     itself is asserted in scripts/android-sdk-pin.test.mjs;
//   · nothing about any APK that is not staged — a build sitting in
//     apps/mobile/build/ that publish.mjs never picks up is never examined;
//   · and it cannot see WHY a mismatch happened. It distinguishes "the bytes
//     disagree with the pin" from "I could not read", and stops there.

const GRADLE_PIN_REL = 'apps/mobile/android/app/build.gradle.kts';
const GRADLE_PIN_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  ...GRADLE_PIN_REL.split('/'),
);

/**
 * Strip Kotlin comments so the numbers in build.gradle.kts's own PROSE cannot
 * be read as code. This is not hypothetical: that file quotes both the
 * inherited spelling and the Flutter defaults (`targetSdkVersion = 36`) inside
 * its own header, so a regex over raw text finds a pin in a file that has none.
 * Tracks double-quoted strings so a `//` inside a literal is not a comment.
 *
 * Known limit, written down rather than discovered later: raw strings (triple
 * quotes) and char literals are not modelled. Neither appears in the file this
 * reads, and neither could turn a missing pin into a found one — the worst case
 * is hiding a real assignment, which reads as 'missing', which refuses.
 */
export function stripKotlinCommentsForPin(src) {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (inString) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === '"') inString = false;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') { inString = true; out += c; i += 1; continue; }
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The expectation, read from the build file's CODE.
 *
 * Only 'literal' produces a number. 'inherited' is the S7 regression itself
 * (the shipped level goes back to being whatever Flutter is installed);
 * 'expression' can resolve differently per machine, which is the same hazard in
 * a different spelling; 'duplicate' means a later assignment may override the
 * one we found, so finding one proves nothing.
 *
 * @returns {{verdict:'literal'|'inherited'|'expression'|'duplicate'|'missing',
 *            raw:string|null, value:number|null}}
 */
export function readPinnedTargetSdk(gradleSrc) {
  const code = stripKotlinCommentsForPin(gradleSrc);
  // The captured token stops at whitespace, `;`, `}` or end of line: the Kotlin
  // DSL is routinely written `defaultConfig { targetSdk = 36 }`, and capturing
  // to end-of-line would read that as the expression `36 }`.
  const matches = [...code.matchAll(/\btargetSdk\s*=\s*([^\s;}\n]+)/g)];
  if (matches.length === 0) return { verdict: 'missing', raw: null, value: null };
  if (matches.length > 1) {
    return { verdict: 'duplicate', raw: matches.map((m) => m[1].trim()).join(' | '), value: null };
  }
  const raw = matches[0][1].trim().replace(/[;,]$/, '');
  if (/^\d+$/.test(raw)) return { verdict: 'literal', raw, value: Number(raw) };
  if (/^flutter\s*\./.test(raw)) return { verdict: 'inherited', raw, value: null };
  return { verdict: 'expression', raw, value: null };
}

/** Same, from a path, with the file read itself as a sixth outcome. A publish
 *  gate must not throw on a moved or unreadable file — it must say which of its
 *  two inputs it could not obtain. */
export function readPinnedTargetSdkFile(gradlePath) {
  let src;
  try {
    src = readFileSync(gradlePath, 'utf8');
  } catch (e) {
    return { verdict: 'unreadable-file', raw: null, value: null, detail: e.message };
  }
  return readPinnedTargetSdk(src);
}

/**
 * `aapt dump badging`, with the three outcomes kept apart.
 *
 * 'no-tool' and 'unreadable' are separated because store-channel-gate.mjs's
 * declaredPermissions() learned the hard way that collapsing them prints "no
 * aapt on this machine" on a machine where aapt is right there — one value
 * answering two questions, in a gate written to enforce that rule.
 *
 * @returns {{reason:'ok', text:string}|{reason:'no-tool'}|{reason:'unreadable', detail:string}}
 */
export function dumpBadging(apkPath) {
  const aapt = findAapt();
  if (!aapt) return { reason: 'no-tool' };
  try {
    return {
      reason: 'ok',
      text: execFileSync(aapt, ['dump', 'badging', apkPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    return { reason: 'unreadable', detail: String(e.stderr || e.message).trim().split('\n')[0] };
  }
}

/** Control A — every badging dump opens with it, whatever the manifest says. */
const BADGING_CONTROL_PACKAGE = /(^|\n)package: name='/;
/** Control B — aapt's spelling of minSdk, printed from the same <uses-sdk>
 *  parse that produces the target level. Its presence is what makes the
 *  ABSENCE of the target level a statement about the manifest rather than
 *  about the scanner. */
const BADGING_CONTROL_MIN_SDK = /(^|\n)\s*sdkVersion:'(\d+)'/;
const BADGING_TARGET_SDK = /(^|\n)\s*targetSdkVersion:'(\d+)'/;

/**
 * Read the reported target level out of a badging dump, deciding blindness
 * FIRST — a scan that could not see must never be reported as a scan that saw
 * something wrong.
 *
 * @returns {{verdict:'read'|'no-target-field'|'blind-not-badging'|'blind-no-uses-sdk',
 *            value:number|null, minSdk:number|null}}
 */
export function readReportedTargetSdk(badgingText) {
  const target = BADGING_TARGET_SDK.exec(badgingText);
  const min = BADGING_CONTROL_MIN_SDK.exec(badgingText);
  const minSdk = min ? Number(min[2]) : null;
  if (!BADGING_CONTROL_PACKAGE.test(badgingText)) {
    return { verdict: 'blind-not-badging', value: null, minSdk };
  }
  if (target) return { verdict: 'read', value: Number(target[2]), minSdk };
  if (!min) return { verdict: 'blind-no-uses-sdk', value: null, minSdk: null };
  return { verdict: 'no-target-field', value: null, minSdk };
}

/**
 * The whole judgement, from facts already gathered. Pure, so the drill can
 * drive every branch with synthetic fixtures and no Android SDK anywhere.
 *
 * Order: blindness about the ARTEFACT first (nothing can be concluded at all),
 * then an unsourced expectation, then the comparison. The dump is read before
 * the pin on purpose — when the expectation cannot be sourced, the message can
 * still tell the operator what the bytes report, which is the fact they would
 * otherwise go and get by hand.
 *
 * @returns {{verdict:string, reported:number|null, pinned:number|null,
 *            minSdk:number|null, pinVerdict:string, detail:string|null}}
 */
export function targetSdkVerdict({ dump, pin }) {
  const base = { reported: null, pinned: null, minSdk: null, pinVerdict: pin.verdict, detail: null };
  if (dump.reason === 'no-tool') return { ...base, verdict: 'blind-no-tool' };
  if (dump.reason === 'unreadable') {
    return { ...base, verdict: 'blind-unreadable', detail: dump.detail };
  }
  const report = readReportedTargetSdk(dump.text);
  if (report.verdict !== 'read') {
    return {
      ...base,
      verdict: report.verdict,
      minSdk: report.minSdk,
      detail: (dump.text.split(/\r?\n/)[0] ?? '').slice(0, 160),
    };
  }
  const seen = { ...base, reported: report.value, minSdk: report.minSdk };
  if (pin.verdict !== 'literal') {
    return { ...seen, verdict: 'unsourced', detail: pin.raw ?? pin.detail ?? null };
  }
  if (report.value !== pin.value) return { ...seen, verdict: 'mismatch', pinned: pin.value };
  return { ...seen, verdict: 'ok', pinned: pin.value };
}

/** The sentence an operator reads at the moment they are about to act. Each
 *  verdict names a different NEXT STEP; that is the whole reason they are
 *  different verdicts. Separated from the wrapper so the drill can assert the
 *  exact words without an APK. */
export function targetSdkRefusalMessage(label, v) {
  const bytes =
    v.reported === null ? '' : ` — for the record, these bytes report targetSdkVersion ${v.reported}`;
  switch (v.verdict) {
    case 'mismatch':
      return (
        `${label} reports targetSdkVersion ${v.reported}, but ${GRADLE_PIN_REL} pins ` +
        `targetSdk = ${v.pinned}. The staged APK is not what this tree says it ships: either it ` +
        `predates the pin being changed (rebuild with \`${APK_BUILD_COMMAND}\`), or the manifest ` +
        `merger overrode the pin — read the merged AndroidManifest.xml under ` +
        `apps/mobile/build/app/intermediates/ before touching the pin. Google Play refuses an ` +
        `upload below its target-API floor at submission time, so this must not be staged.`
      );
    case 'no-target-field':
      return (
        `${label} declares NO targetSdkVersion at all — its badging dump prints ` +
        `sdkVersion:'${v.minSdk}' (minSdk, from the same <uses-sdk> parse) and no target level. ` +
        `This is NOT a blind scan: the section is there and the number is not, so Android treats ` +
        `minSdk as the target and Play refuses the upload. Do not rebuild blindly — read the ` +
        `merged AndroidManifest.xml and find what removed the pin.`
      );
    case 'blind-no-tool':
      return (
        `cannot read ${label}'s target API level — no aapt/aapt2 found (checked $ANDROID_HOME, ` +
        `$ANDROID_SDK_ROOT, %LOCALAPPDATA%\\Android\\Sdk\\build-tools\\*). This says NOTHING ` +
        `about what the APK targets. Install Android SDK build-tools or point ANDROID_HOME at ` +
        `one, then re-run — do not rebuild the APK, nothing is known to be wrong with it.`
      );
    case 'blind-unreadable':
      return (
        `cannot read ${label}'s target API level — aapt failed on the file: ${v.detail}. This ` +
        `says NOTHING about what the APK targets; the SCAN failed, not the artefact. Check the ` +
        `file is the APK you think it is (an .aab has no AndroidManifest.xml for aapt to dump) ` +
        `before rebuilding anything.`
      );
    case 'blind-not-badging':
      return (
        `the target-level scan of ${label} is BLIND — the dump contains no \`package: name=\` ` +
        `line, so it is not an aapt badging dump. This says NOTHING about what the APK targets. ` +
        `Re-measure by hand before touching the build: \`aapt dump badging <apk>\`. ` +
        `First line seen: "${v.detail}"`
      );
    case 'blind-no-uses-sdk':
      return (
        `the target-level scan of ${label} is BLIND — the dump is a badging dump but carries ` +
        `neither \`targetSdkVersion:\` nor the \`sdkVersion:\` control, i.e. no <uses-sdk> ` +
        `section at all. AGP always injects one, so this is the scanner reading an output shape ` +
        `it does not know, NOT evidence about the APK. Re-measure by hand ` +
        `(\`aapt dump badging <apk>\`) and fix this gate; do not rebuild. ` +
        `First line seen: "${v.detail}"`
      );
    case 'unsourced':
      return (
        `cannot check ${label}'s target API level — the expectation could not be sourced from ` +
        `${GRADLE_PIN_REL}: targetSdk is '${v.pinVerdict}'` +
        (v.detail ? ` (\`${v.detail}\`)` : '') + bytes +
        `. Nothing in this tree states what it SHOULD report, so the comparison cannot be ` +
        `made. This is a SOURCE-side problem, not an artefact one: run ` +
        `\`pnpm verify:scripts\` — scripts/android-sdk-pin.test.mjs owns that question and ` +
        `refuses this same state with the full diagnosis.`
      );
    default:
      return `${label}: unknown target-level verdict '${v.verdict}' — this gate has a bug.`;
  }
}

/**
 * Refuse to stage an APK whose reported target API level is not the one this
 * tree pins. Returns true when the APK may be staged.
 *
 * `opts` is a seam, not a bypass: `gradlePath` lets the drill and the reverse
 * control point the expectation at a synthetic build file, and `readDump` lets
 * the drill drive every branch without an Android SDK on the box. Both default
 * to the real thing — a DI default here is the production implementation, never
 * a friendly no-op (CLAUDE.md anti-facade rule 2).
 */
export function verifyApkTargetSdk(apkPath, fail, ok, opts = {}) {
  const label = apkPath.split(/[\\/]/).pop();
  const readDump = opts.readDump ?? dumpBadging;
  const gradlePath = opts.gradlePath ?? GRADLE_PIN_FILE;
  const v = targetSdkVerdict({ dump: readDump(apkPath), pin: readPinnedTargetSdkFile(gradlePath) });
  if (v.verdict !== 'ok') {
    fail(targetSdkRefusalMessage(label, v));
    return false;
  }
  ok(
    `${label} reports targetSdkVersion ${v.reported} via aapt dump badging — matches the pin in ` +
      `${GRADLE_PIN_REL} (minSdk control read from the same dump: sdkVersion:'${v.minSdk}')`,
  );
  return true;
}
