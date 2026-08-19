// Drill for the Android SDK-level pin in
// apps/mobile/android/app/build.gradle.kts (compileSdk / minSdk / targetSdk).
//
// WHAT IT GUARDS. Google Play's target-API floor moves every year, and the
// three numbers used to be `flutter.compileSdkVersion` /
// `flutter.minSdkVersion` / `flutter.targetSdkVersion` — i.e. whatever the
// Flutter SDK on the building machine defaults to. That drifts with NO DIFF IN
// ANY FILE to review: upgrade Flutter, or build on a runner with a different
// Flutter install, and the shipped targetSdk changes by itself. The failure
// arrives at store submission, which is the most expensive moment it could
// pick. The pin makes the number a fact the build file STATES; this drill makes
// removing that statement go red instead of going unnoticed.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 SOURCE OR ARTEFACT — the honest answer, because this repo has been burned
// on exactly this seam.
//
// THIS DRILL ANSWERS THE SOURCE QUESTION:
//   "does build.gradle.kts state these three numbers itself, or is it back to
//    inheriting them from whatever Flutter is installed?"
// That is the question the pin exists to make answerable, and it is the only
// one answerable in EVERY tree — a fresh clone, a CI runner, the open-source
// export — with no Android SDK, no Flutter, no aapt and no 75 MB artefact. It
// runs in milliseconds and it never skips, so it can live in `verify:scripts`
// and be asked on every delivery.
//
// IT DOES NOT ANSWER THE ARTEFACT QUESTION:
//   "does the APK/AAB we are about to upload REPORT targetSdk 36?"
// Between this source line and those bytes sit AGP, the manifest merger, the
// `--flavor` split, `manifestPlaceholders`, and any `<uses-sdk>` a plugin's own
// manifest contributes. A green here means "nobody removed the pin". It does
// NOT mean "the shipped package targets 36". UP-7 is this repo's standing proof
// that the two can disagree: every gate was green while the published APK was
// missing a whole feature, because the gates read intentions and nothing read
// the bytes (scripts/apk-self-update-marker.mjs exists because of that day).
//
// WHY THE ARTEFACT HALF IS NOT ATTEMPTED HERE RATHER THAN ATTEMPTED BADLY.
// A byte-level check needs (a) a staged artefact and (b) an aapt/aapt2 binary.
// Neither exists on a CI runner or in a fresh clone, so the check would report
// "not run" almost every time it was asked — and a gate that is dark by default
// is the runtime version of a facade: it is indistinguishable from a gate that
// is not there. Worse, the artefact lying on disk in a dev tree is whatever was
// built last, which may predate the pin being edited; asserting against it
// would produce red that means "rebuild", not "defect".
//
// WHERE THE ARTEFACT HALF BELONGS, stated so it is a decision and not an
// oversight: scripts/publish-apk-gates.mjs already runs `aapt dump badging` on
// the staged APK and already parses `versionName=` out of that exact output.
// `targetSdkVersion:'NN'` is three lines further down the same dump. Asserting
// it there puts the byte-level answer on the one path where the artefact is
// guaranteed fresh AND guaranteed to be the one that ships. That change is NOT
// made by this card (its write scope was this drill and the gradle file alone);
// it is written down here so the gap is inherited as a known gap.
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 FIRST CHECK YOUR RULER — the one real hazard in a source-text check, and
// it is live in the very file being read. build.gradle.kts CONTAINS, in its own
// comments, both the inherited spelling (`flutter.compileSdkVersion`) and a
// verbatim quote of the Flutter defaults (`compileSdkVersion = 36,
// minSdkVersion = 24, targetSdkVersion = 36`). A regex run over the raw text
// finds those and reports a pin that may not exist — the gate would be reading
// the explanation instead of the code. So readSdkPins() strips comments FIRST,
// and section 2 below is the positive control for it: a file whose only numbers
// live in comments must come back "missing", never "pinned".
//
// MEASUREMENT THIS FILE PINS (2026-08-19, machine dev-pc-a). Two independent
// methods agreeing, neither of them a comment:
//   · ARTEFACT — `aapt dump badging` on the release APK this tree built
//     (apps/mobile/build/app/outputs/flutter-apk/app-direct-release.apk; the
//     store and legacy artefacts beside it printed the same three values):
//       package: name='app.flowmic.android' versionCode='30009' versionName='0.3.9'
//         platformBuildVersionName='16' platformBuildVersionCode='36'
//         compileSdkVersion='36' compileSdkVersionCodename='16'
//       sdkVersion:'24'
//       targetSdkVersion:'36'
//     (`sdkVersion:` in badging output IS minSdk — aapt's spelling, not ours.)
//   · TOOLCHAIN DEFAULT — the Flutter SDK this tree builds with (3.41.8) ships
//     FlutterExtension.kt with compileSdkVersion = 36, minSdkVersion = 24,
//     targetSdkVersion = 36. So the pin equals what inheritance produced: it
//     changes nothing about what ships TODAY, which is the entire point — the
//     pin is about tomorrow.
// Section 3 asserts RECORDED_ARTEFACT against the live source, so a future edit
// that changes a pinned number CANNOT quietly keep this measurement: change the
// number and this file goes red until someone rebuilds, re-dumps and rewrites
// the block above. (Same discipline as up7-apk-self-update-marker.test.mjs's
// recorded-measurement section, for the same reason: evidence must not outlive
// the thing it is evidence for.)
//
// REVERSE CONTROL — done 2026-08-19, verbatim, not paraphrased. With
// `targetSdk = 36` edited to `targetSdk = flutter.targetSdkVersion` in
// build.gradle.kts and nothing else touched,
// `node scripts/android-sdk-pin.test.mjs` printed (the `location:` and `stack:`
// lines of each block are ELIDED here on purpose — they are absolute paths on
// the measuring machine, and a quoted `file.mjs:NNN` coordinate in a comment is
// exactly what verify/lint/coordinate-anchors.mjs refuses; nothing else is
// changed):
//
//   not ok 8 - the live build file pins all three SDK levels as literals
//     error: |-
//       targetSdk is INHERITED (`flutter.targetSdkVersion`), not pinned.
//       A Flutter SDK upgrade can now change the shipped targetSdk with no diff
//       in apps/mobile/android/app/build.gradle.kts to review.
//       + actual - expected
//       + 'inherited'
//       - 'literal'
//     code: 'ERR_ASSERTION'
//   not ok 9 - the pinned values are the measured ones
//     error: |-
//       targetSdk is pinned to null, but the artefact measurement recorded in
//       this drill's header says 36. [...]
//   not ok 10 - targetSdk meets the Play floor, and compileSdk is not below targetSdk
//     error: |-
//       targetSdk null is below the Play floor of 36
//       (required for app updates from 2026-08-31). Play rejects at submission.
//   not ok 11 - no inherited spelling survives in the CODE of the live file
//     error: 'flutter.targetSdkVersion is back in the code of apps/mobile/android/app/build.gradle.kts'
//   # pass 8
//   # fail 4
//
// and the process exited 1. The pin was restored BY HAND (no git command) and
// the file went green again: `# pass 12`, `# fail 0`.
//
// ⚠️ FOUR failures for one removed pin is not four independent proofs — the
// four sections share one input, so they fail together by construction. It is
// recorded as four because each prints a DIFFERENT sentence, and one of them is
// the one that gets read at 2am.
//
// WHAT THIS FILE STILL DOES NOT PROVE, in one line so nobody reads more into a
// green run: that any built package reports these numbers; that `ndkVersion`
// (deliberately still inherited, out of scope) is stable; that 36 is still
// Play's floor on the day you read this.
//
// EXIT CODES (see scripts/run-script-tests.mjs's header): 0 = PASS, 1 = FAIL,
// 2 = SKIP. This file never skips — it reads one tracked source file that
// exists in every clone and in the export tree.
//
// Run: `node scripts/android-sdk-pin.test.mjs`

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRADLE_REL = 'apps/mobile/android/app/build.gradle.kts';
const GRADLE_SRC = readFileSync(join(ROOT, GRADLE_REL), 'utf8');

/**
 * Google Play's target-API floor for app UPDATES, effective 2026-08-31 (store
 * playbook section 2-1, row "targetSdk / AAB / 64 bit"). A floor, not the pin:
 * raising targetSdk above it is fine, dropping below it is a store rejection.
 */
const PLAY_TARGET_SDK_FLOOR = 36;

/**
 * The numbers measured and pinned on 2026-08-19 (header "MEASUREMENT").
 *
 * ⚠️ THIS IS A DELIBERATE SECOND COPY of a fact whose SSOT is the gradle file,
 * and this repo is on record about second copies drifting (bump-version.mjs's
 * hand-kept FACES table vs. the lint that walks the directory). The difference
 * that makes this one safe is the DIRECTION it fails in: the FACES table drifts
 * SILENTLY GREEN, this copy drifts LOUDLY RED. Changing a pinned number is a
 * two-file edit on purpose — one of the files is this one, and editing it means
 * reading the header, which tells you to re-measure the artefact.
 */
const RECORDED_ARTEFACT = { compileSdk: 36, minSdk: 24, targetSdk: 36 };

const KEYS = ['compileSdk', 'minSdk', 'targetSdk'];

/**
 * Remove Kotlin comments so the numbers in build.gradle.kts's own PROSE cannot
 * be mistaken for the code. Tracks double-quoted strings so a `//` inside a
 * string literal is not read as a comment start.
 *
 * ⚠️ Known limit, written down rather than discovered later: it does not model
 * Kotlin raw strings (three double quotes) or char literals. Neither appears in
 * the file this drill reads, and neither could turn a missing pin into a found
 * one — the worst it could do is hide a real assignment, which fails closed (a
 * hidden assignment reads as "missing", i.e. red).
 */
export function stripKotlinComments(src) {
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
 * Classify each SDK-level assignment in a build.gradle.kts.
 *
 * Verdicts, and why each is its own word rather than a boolean:
 *   'literal'    — a bare integer. This is the pinned state.
 *   'inherited'  — `flutter.<something>`. The regression this drill exists for:
 *                  the build still works, the number is still 36 today, and it
 *                  can change tomorrow with no diff to review.
 *   'expression' — anything else on the right-hand side. NOT treated as pinned:
 *                  a variable or a function call can resolve to a different
 *                  number per machine, which is the same hazard wearing a
 *                  different spelling.
 *   'duplicate'  — assigned more than once. A second assignment can override
 *                  the first, so "I found a literal" stops being an answer.
 *   'missing'    — not assigned at all (that is how inheritance used to look,
 *                  and it is also what a wrong file path produces — either way,
 *                  red, never green).
 */
export function readSdkPins(src) {
  const code = stripKotlinComments(src);
  const pins = {};
  for (const key of KEYS) {
    // The captured token stops at whitespace, `;`, `}` or end of line — Kotlin
    // DSL blocks are routinely written `defaultConfig { targetSdk = 36 }`, and
    // capturing to end-of-line would read that as the expression `36 }` and
    // report an unpinned file. Measured: that exact shape failed the first
    // version of this parser.
    const matches = [...code.matchAll(new RegExp(`\\b${key}\\s*=\\s*([^\\s;}\\n]+)`, 'g'))];
    if (matches.length === 0) {
      pins[key] = { verdict: 'missing', raw: null, value: null };
      continue;
    }
    if (matches.length > 1) {
      pins[key] = {
        verdict: 'duplicate',
        raw: matches.map((m) => m[1].trim()).join(' | '),
        value: null,
      };
      continue;
    }
    const raw = matches[0][1].trim().replace(/[;,]$/, '');
    if (/^\d+$/.test(raw)) {
      pins[key] = { verdict: 'literal', raw, value: Number(raw) };
      continue;
    }
    if (/^flutter\s*\./.test(raw)) {
      pins[key] = { verdict: 'inherited', raw, value: null };
      continue;
    }
    pins[key] = { verdict: 'expression', raw, value: null };
  }
  return pins;
}

/** The sentence a human should read when a pin is gone. Names the consequence,
 *  not just the mismatch — "targetSdk is not 36" does not tell anyone why they
 *  should care. */
function pinFailure(key, pin) {
  if (pin.verdict === 'inherited') {
    return `${key} is INHERITED (\`${pin.raw}\`), not pinned.\n`
      + `A Flutter SDK upgrade can now change the shipped ${key} with no diff\n`
      + `in ${GRADLE_REL} to review.`;
  }
  if (pin.verdict === 'missing') {
    return `${key} is not assigned at all in ${GRADLE_REL} — whatever the Flutter\n`
      + 'Gradle plugin defaults to today is what ships.';
  }
  if (pin.verdict === 'duplicate') {
    return `${key} is assigned more than once (${pin.raw}) — a later assignment can\n`
      + 'override the pin, so finding one literal proves nothing.';
  }
  return `${key} is set to an expression (\`${pin.raw}\`), which can resolve to a\n`
    + 'different number on a different machine. Pin an integer.';
}

// ── 1. the parser reads CODE, and reads it correctly ─────────────────────────

test('a pinned file reads as pinned', () => {
  const pins = readSdkPins(
    'android {\n  compileSdk = 36\n  defaultConfig {\n    minSdk = 24\n    targetSdk = 36\n  }\n}\n',
  );
  assert.deepEqual(pins.compileSdk, { verdict: 'literal', raw: '36', value: 36 });
  assert.deepEqual(pins.minSdk, { verdict: 'literal', raw: '24', value: 24 });
  assert.deepEqual(pins.targetSdk, { verdict: 'literal', raw: '36', value: 36 });
});

test('the inherited form is named, not merely "not a literal"', () => {
  const pins = readSdkPins(
    'android {\n  compileSdk = flutter.compileSdkVersion\n  defaultConfig {\n'
    + '    minSdk = flutter.minSdkVersion\n    targetSdk = flutter.targetSdkVersion\n  }\n}\n',
  );
  for (const k of KEYS) assert.equal(pins[k].verdict, 'inherited', k);
  // The states differ in what a human must DO about them, so they must not
  // collapse into one failure word.
  assert.ok(pinFailure('targetSdk', pins.targetSdk).includes('INHERITED'));
});

test('an expression is refused, because it can resolve per machine', () => {
  const pins = readSdkPins(
    'android {\n  compileSdk = sdkLevel\n  defaultConfig {\n    minSdk = 24\n    targetSdk = 36\n  }\n}\n',
  );
  assert.equal(pins.compileSdk.verdict, 'expression');
});

test('a second assignment makes the first one meaningless, and says so', () => {
  const pins = readSdkPins(
    'android {\n  compileSdk = 36\n  defaultConfig {\n    minSdk = 24\n    targetSdk = 36\n  }\n}\n'
    + 'android { defaultConfig { targetSdk = 34 } }\n',
  );
  assert.equal(pins.targetSdk.verdict, 'duplicate');
});

// ── 2. FIRST CHECK YOUR RULER: comments must not be able to fake a pin ───────

test('🔴 numbers that live only in COMMENTS read as missing, never as pinned', () => {
  // This is the exact shape of the real file: its header quotes both the
  // inherited spelling and the Flutter defaults verbatim. A regex over raw text
  // would report a healthy pin for a file that has none — a gate reading the
  // explanation instead of the code.
  const commentOnly = [
    'android {',
    '  // WHY: these used to be flutter.compileSdkVersion / flutter.minSdkVersion',
    '  //   compileSdkVersion = 36, minSdkVersion = 24, targetSdkVersion = 36',
    '  /* targetSdk = 36 was chosen here in a block comment */',
    '  defaultConfig {',
    '  }',
    '}',
  ].join('\n');
  const pins = readSdkPins(commentOnly);
  for (const k of KEYS) assert.equal(pins[k].verdict, 'missing', k);
});

test('and the positive control: a comment beside real code does not hide it', () => {
  // The mirror case. A ruler that solved the case above by refusing everything
  // would pass it and be useless; this is what stops that.
  const pins = readSdkPins(
    'android {\n  // was flutter.compileSdkVersion\n  compileSdk = 36 // pinned\n'
    + '  defaultConfig { minSdk = 24\n targetSdk = 36 }\n}\n',
  );
  assert.equal(pins.compileSdk.verdict, 'literal');
  assert.equal(pins.targetSdk.value, 36);
});

test('an empty or wrong file fails, it does not pass quietly', () => {
  // A wrong path, a truncated read, a renamed file: all land here. "Found
  // nothing" must never be the same answer as "found a pin".
  for (const k of KEYS) assert.equal(readSdkPins('')[k].verdict, 'missing', k);
});

// ── 3. the live build file ───────────────────────────────────────────────────

test('the live build file pins all three SDK levels as literals', () => {
  const pins = readSdkPins(GRADLE_SRC);
  for (const key of KEYS) {
    assert.equal(pins[key].verdict, 'literal', pinFailure(key, pins[key]));
  }
});

test('the pinned values are the measured ones', () => {
  const pins = readSdkPins(GRADLE_SRC);
  for (const key of KEYS) {
    assert.equal(
      pins[key].value,
      RECORDED_ARTEFACT[key],
      `${key} is pinned to ${pins[key].value}, but the artefact measurement recorded in\n`
      + `this drill's header says ${RECORDED_ARTEFACT[key]}. If the pin was changed on\n`
      + 'purpose: rebuild, re-run `aapt dump badging` on the new APK, and rewrite BOTH\n'
      + 'RECORDED_ARTEFACT and the verbatim dump in the header. Do not update one alone.',
    );
  }
});

test('targetSdk meets the Play floor, and compileSdk is not below targetSdk', () => {
  const pins = readSdkPins(GRADLE_SRC);
  assert.ok(
    pins.targetSdk.value >= PLAY_TARGET_SDK_FLOOR,
    `targetSdk ${pins.targetSdk.value} is below the Play floor of ${PLAY_TARGET_SDK_FLOOR}\n`
    + '(required for app updates from 2026-08-31). Play rejects at submission.',
  );
  // Not a store rule — an AGP one, and a cheap way to catch a half-done bump
  // where someone raises targetSdk and forgets compileSdk.
  assert.ok(pins.compileSdk.value >= pins.targetSdk.value);
});

test('no inherited spelling survives in the CODE of the live file', () => {
  // Redundant with the verdicts above by construction, and kept anyway: it
  // names the regression in the words someone would grep for, so the failure
  // output points straight at what to look for.
  const code = stripKotlinComments(GRADLE_SRC);
  for (const spelling of [
    'flutter.compileSdkVersion',
    'flutter.minSdkVersion',
    'flutter.targetSdkVersion',
  ]) {
    assert.ok(!code.includes(spelling), `${spelling} is back in the code of ${GRADLE_REL}`);
  }
  // Positive control for the stripper: it must not have eaten the file. If it
  // returned an empty string the loop above would pass for the wrong reason.
  assert.ok(code.includes('android {'));
  assert.ok(code.includes('applicationId'));
});

// ── 4. the pin and its guard travel together ─────────────────────────────────

test('the gradle file points at this drill, so a reader finds the gate', () => {
  // A pin whose guard is invisible from the pinned line invites someone to
  // "simplify" it back to inheritance and only learn about this file from a red
  // CI run. CLAUDE.md's anti-facade rule 4 in the other direction: an assertion
  // about behaviour elsewhere needs a greppable anchor, so the anchor is
  // asserted rather than hoped for.
  assert.ok(GRADLE_SRC.includes('scripts/android-sdk-pin.test.mjs'));
});
