// Drill for the APK target-API-level gate in scripts/publish-apk-gates.mjs
// (`verifyApkTargetSdk` and the pure functions under it).
//
// WHAT THE GATE GUARDS. Google Play's target-API floor rises every year and a
// package below it is refused at submission — the most expensive moment a
// defect can pick. `apps/mobile/android/app/build.gradle.kts` pins
// `targetSdk = 36` and scripts/android-sdk-pin.test.mjs keeps that pin from
// being removed, but that drill reads the SOURCE. Between the pinned line and
// the compiled manifest sit AGP, the manifest merger, the `--flavor` split and
// any `<uses-sdk>` a plugin contributes. The gate this file drills asks the
// other half — what the staged bytes REPORT — on the publish path, where the
// artefact is guaranteed fresh and guaranteed to be the one that ships.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS DRILL PROVES, AND WHAT ONLY A REAL PUBLISH CAN PROVE.
//
// Every fixture here is SYNTHETIC: hand-written badging text and hand-written
// build.gradle.kts files in a temp dir. It shells out to nothing, needs no
// Android SDK, no Flutter and no 75 MB artefact, so it runs in milliseconds in
// a fresh clone and in the open-source export, and it NEVER skips.
//
// The price of that is exact, and stating it is the point: this drill proves
// the gate's RULE — which inputs it refuses, which it passes, and what it says
// while doing it. It proves nothing whatsoever about any real APK. The
// both-directions measurement on real bytes lives in the gate's own header
// (section "REVERSE CONTROL"), taken on the artefact this tree had built.
//
// It also does not prove that the fixtures LOOK LIKE aapt output. That is why
// §2 pins a verbatim slice of a real dump (recorded below) instead of inventing
// a shape: a drill whose fixtures drifted from the tool's real output would go
// on passing while the gate went blind in production — the ruler answering a
// different question from the one being asked.
//
// MEASUREMENT THIS FILE PINS (2026-08-19, machine dev-pc-a,
// build-tools/35.0.1). First three lines of
// `aapt dump badging apps/mobile/build/app/outputs/flutter-apk/app-direct-release.apk`,
// verbatim, wrapped only where marked:
//
//   package: name='app.flowmic.android' versionCode='30009' versionName='0.3.9'
//     platformBuildVersionName='16' platformBuildVersionCode='36'
//     compileSdkVersion='36' compileSdkVersionCodename='16'      ← ONE line
//   sdkVersion:'24'
//   targetSdkVersion:'36'
//
// (`sdkVersion:` in badging output IS minSdk — aapt's spelling, not ours. The
// gate uses it as a control: it is printed from the same <uses-sdk> parse as
// the target level, so its presence is what turns a missing target level from
// "the scan is blind" into "the manifest really has none".)
//
// REVERSE CONTROL ON THIS DRILL — 2026-08-19, verbatim, same machine. §6 is the
// only section that reads the live tree, so it is the only one that can rot into
// a check that cannot fail; both directions were made to go red BY HAND (no git
// command), and the file was restored by hand afterwards. `location:` and
// `stack:` lines are elided — they are absolute paths on the measuring machine.
//
//   with `const targetOk = verifyApkTargetSdk(apkPath, fail, ok);` in
//   publish-apk-gates.mjs replaced by `const targetOk = true;`:
//     not ok 30 - 🔴 the gate has exactly one production call site
//       error: verifyApkTargetSdk has 0 production call site(s) [], expected exactly 1.
//     # pass 30 / # fail 1
//
//   with that call restored AND a second, duplicate call added beside it:
//     error: verifyApkTargetSdk has 2 production call site(s)
//            [scripts/publish-apk-gates.mjs ×2], expected exactly 1.
//     # pass 30 / # fail 1
//
//   restored: # pass 31 / # fail 0, and `grep -c REVERSE-CONTROL` = 0.
//
// ⚠️ One test going red for two opposite defects is not two proofs; it is one
// assertion with two inputs. It is recorded as two because the two states need
// opposite repairs, and the message is what tells them apart.
//
// EXIT CODES (see scripts/run-script-tests.mjs's header): 0 = PASS, 1 = FAIL,
// 2 = SKIP. This file never skips.
//
// Run: `node scripts/apk-target-sdk-gate.test.mjs`

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stripJsComments } from '../verify/lint/_util.mjs';
import {
  dumpBadging,
  readPinnedTargetSdk,
  readPinnedTargetSdkFile,
  readReportedTargetSdk,
  targetSdkRefusalMessage,
  targetSdkVerdict,
  verifyApkTargetSdk,
} from './publish-apk-gates.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The recorded real dump, verbatim (header "MEASUREMENT"). Everything §2 and
 *  §3 assert about a well-formed dump is asserted against THIS, so the
 *  fixtures cannot drift into a shape aapt never produces. */
const REAL_BADGING_HEAD =
  "package: name='app.flowmic.android' versionCode='30009' versionName='0.3.9'"
  + " platformBuildVersionName='16' platformBuildVersionCode='36'"
  + " compileSdkVersion='36' compileSdkVersionCodename='16'\n"
  + "sdkVersion:'24'\n"
  + "targetSdkVersion:'36'\n"
  + "uses-permission: name='android.permission.RECORD_AUDIO'\n"
  + "application-label:'FlowMic'\n";

/** Run `fn` with a fresh temp dir, and remove it whatever happens. Temp dirs
 *  only — this drill writes nothing into the repo, and per CLAUDE.md's
 *  2026-08-18 ruling a few KB of fixture text is exactly what a scratch dir is
 *  for (what may not go there is a TREE: a worktree, a build or a checkout). */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'flowmic-target-sdk-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A build.gradle.kts on disk stating `targetSdk = <spelling>`. */
function gradleFixture(dir, spelling) {
  const p = join(dir, 'build.gradle.kts');
  writeFileSync(
    p,
    'android {\n  compileSdk = 36\n  defaultConfig {\n    minSdk = 24\n'
    + `    targetSdk = ${spelling}\n  }\n}\n`,
  );
  return p;
}

/**
 * Source with comments removed, for counting call sites.
 *
 * 🔴 CHECK YOUR RULER — this is TWO strippers on purpose, and the second one
 * exists because the first was measured wrong on the very file being counted.
 *
 * `stripJsComments` (verify/lint/_util.mjs) is the repo's shared stripper, used
 * by the module-reachability lint for exactly this job. It does not model REGEX
 * LITERALS, so a regex containing an odd number of quote characters
 * desynchronises its state machine and every comment after it survives
 * stripping verbatim. Minimal reproduction, [measured 2026-08-19,
 * dev-pc-a, node v22.22.3]:
 *
 *   stripJsComments("const m = badging.match(/versionName='([^']*)'/);\n// callMe(1)\ncallMe(2);")
 *     → "const m = badging.match(/versionName='([^']*)'/);\n// callMe(1)\ncallMe(2);"
 *
 *   with the regex replaced by `1`, the same input strips correctly:
 *     → "const m = 1;\n            \ncallMe(2);"
 *
 * That regex is real code in scripts/publish-apk-gates.mjs (it is how the
 * version gate reads `versionName=`), and the illustrative call in the comment
 * a few lines below it therefore counted as a live call site — a FALSE READING
 * in the direction that matters, since the count is what this test asserts on.
 * ⚠️ The same blind spot is live in the module-reachability lint, where the
 * consequence is a commented-out import counting as a real edge (false green);
 * that is reported, not fixed here — this drill's write scope is this file.
 *
 * So the shared stripper runs FIRST (it handles strings and templates, which a
 * line-level rule cannot), and then whole-line comments are dropped as well.
 * Stated limit: a call written on the same line AFTER code plus `//` would be
 * missed by the second pass — it cannot happen here, and the direction is the
 * safe one: over-counting is red, and red is read.
 */
function codeLinesOnly(src) {
  return stripJsComments(src)
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Collects what an operator would have seen, so a test can assert on the
 *  words and on how many lines were printed. */
function recorder() {
  const fails = [];
  const oks = [];
  return { fails, oks, fail: (m) => fails.push(m), ok: (m) => oks.push(m) };
}

// ── 1. the expectation half: reading the pin out of build.gradle.kts ─────────

test('a pinned build file yields the expectation', () => {
  const pin = readPinnedTargetSdk('android {\n  defaultConfig { targetSdk = 36 }\n}\n');
  assert.deepEqual(pin, { verdict: 'literal', raw: '36', value: 36 });
});

test('inheritance is named, not merely "not a literal"', () => {
  // The regression the pin exists for: still builds, still 36 today, and can
  // change tomorrow with no diff to review.
  const pin = readPinnedTargetSdk('android { defaultConfig { targetSdk = flutter.targetSdkVersion } }');
  assert.equal(pin.verdict, 'inherited');
  assert.equal(pin.value, null, 'an inherited pin must not hand out a number');
});

test('an expression yields no expectation, because it can resolve per machine', () => {
  const pin = readPinnedTargetSdk('android { defaultConfig { targetSdk = sdkLevel } }');
  assert.equal(pin.verdict, 'expression');
  assert.equal(pin.value, null);
});

test('a second assignment makes the first meaningless, and says so', () => {
  const pin = readPinnedTargetSdk(
    'android { defaultConfig { targetSdk = 36 } }\nandroid { defaultConfig { targetSdk = 34 } }\n',
  );
  assert.equal(pin.verdict, 'duplicate');
  assert.equal(pin.value, null);
});

test('🔴 FIRST CHECK YOUR RULER: a number that lives only in a COMMENT is not a pin', () => {
  // Not hypothetical. The real build.gradle.kts quotes the Flutter defaults
  // ("targetSdkVersion = 36") and the inherited spelling in its own header, so
  // a regex over raw text finds a pin in a file that has none — the gate would
  // read the explanation instead of the code and publish on it.
  const commentOnly = [
    'android {',
    '  // WHY: this used to be flutter.targetSdkVersion',
    '  //   compileSdkVersion = 36, minSdkVersion = 24, targetSdkVersion = 36',
    '  /* targetSdk = 36 was chosen here, in a block comment */',
    '  defaultConfig {',
    '  }',
    '}',
  ].join('\n');
  assert.equal(readPinnedTargetSdk(commentOnly).verdict, 'missing');
});

test('and the positive control: a comment beside real code does not hide it', () => {
  // A stripper that solved the case above by eating everything would pass it
  // and be useless. This is what stops that.
  const pin = readPinnedTargetSdk(
    'android {\n  // was flutter.targetSdkVersion\n  defaultConfig { targetSdk = 36 } // pinned\n}\n',
  );
  assert.deepEqual(pin, { verdict: 'literal', raw: '36', value: 36 });
});

test('a missing or unreadable build file is its own answer, and does not throw', () => {
  // A publish gate that throws takes the release down with a stack trace
  // instead of a sentence. Both shapes must come back as data.
  assert.equal(readPinnedTargetSdk('').verdict, 'missing');
  withTempDir((dir) => {
    const pin = readPinnedTargetSdkFile(join(dir, 'does-not-exist.kts'));
    assert.equal(pin.verdict, 'unreadable-file');
    assert.equal(pin.value, null);
    assert.ok(pin.detail, 'the reason must survive to the message');
  });
});

test('the live build file really does yield an expectation today', () => {
  // Deliberately asserts only that the number is SOURCEABLE, not what it is:
  // "is the pin 36 and does it meet the Play floor" belongs to
  // scripts/android-sdk-pin.test.mjs and must not be answered twice. What this
  // one guards is that the publish gate is not silently 'unsourced' in this
  // tree — a gate that can never compare anything is a gate that is not there.
  const pin = readPinnedTargetSdkFile(join(ROOT, 'apps/mobile/android/app/build.gradle.kts'));
  assert.equal(pin.verdict, 'literal', `targetSdk is '${pin.verdict}' (${pin.raw}) in the live build file`);
  assert.equal(typeof pin.value, 'number');
});

// ── 2. the artefact half: reading the level out of a badging dump ────────────

test('the recorded real dump reads as 36, with minSdk 24 as its control', () => {
  assert.deepEqual(readReportedTargetSdk(REAL_BADGING_HEAD), {
    verdict: 'read',
    value: 36,
    minSdk: 24,
  });
});

test('🔴 BLIND #1: output that is not a badging dump at all', () => {
  // aapt printed something else, or its output shape changed. Says nothing
  // about the APK.
  for (const notADump of ['', 'ERROR: dump failed because no AndroidManifest.xml found\n', 'x\n']) {
    assert.equal(readReportedTargetSdk(notADump).verdict, 'blind-not-badging');
  }
});

test('🔴 BLIND #2: a real dump with no <uses-sdk> section at all', () => {
  // Control A present, control B absent. AGP always injects uses-sdk, so this
  // is the scanner reading a shape it does not know — NOT evidence about the
  // manifest.
  const noUsesSdk = REAL_BADGING_HEAD.split('\n')
    .filter((l) => !l.startsWith('sdkVersion:') && !l.startsWith('targetSdkVersion:'))
    .join('\n');
  const r = readReportedTargetSdk(noUsesSdk);
  assert.equal(r.verdict, 'blind-no-uses-sdk');
  assert.equal(r.value, null);
});

test('🔴 NOT BLIND: uses-sdk printed, target level genuinely absent, is a DEFECT', () => {
  // This is the one that separates the two failure families. The control is
  // there, so the scan demonstrably saw the section — and there is no target
  // level in it. Android then treats minSdk as the target and Play refuses the
  // upload. Reporting this as "blind" would skip in exactly the case the gate
  // was built for.
  const noTarget = REAL_BADGING_HEAD.split('\n')
    .filter((l) => !l.startsWith('targetSdkVersion:'))
    .join('\n');
  const r = readReportedTargetSdk(noTarget);
  assert.equal(r.verdict, 'no-target-field');
  assert.equal(r.minSdk, 24, 'the control value must survive into the message');
});

test('the reader tolerates indentation and CRLF, since it parses another tool\'s output', () => {
  const crlf = REAL_BADGING_HEAD.replace(/\n/g, '\r\n').replace("sdkVersion:'24'", "  sdkVersion:'24'");
  assert.equal(readReportedTargetSdk(crlf).value, 36);
});

// ── 3. the judgement ────────────────────────────────────────────────────────

const OK_DUMP = { reason: 'ok', text: REAL_BADGING_HEAD };
const PIN_36 = { verdict: 'literal', raw: '36', value: 36 };

test('agreement passes', () => {
  const v = targetSdkVerdict({ dump: OK_DUMP, pin: PIN_36 });
  assert.equal(v.verdict, 'ok');
  assert.equal(v.reported, 36);
  assert.equal(v.pinned, 36);
});

test('🔴 disagreement is a mismatch — the whole reason the gate exists', () => {
  const v = targetSdkVerdict({ dump: OK_DUMP, pin: { verdict: 'literal', raw: '37', value: 37 } });
  assert.equal(v.verdict, 'mismatch');
  assert.equal(v.reported, 36);
  assert.equal(v.pinned, 37);
});

test('🔴 the two tool failures stay apart', () => {
  // Collapsing them is a measured defect in this repo: store-channel-gate's
  // first version printed "no aapt on this machine" on a machine where aapt was
  // right there. One value, two questions, two different places to send someone.
  assert.equal(targetSdkVerdict({ dump: { reason: 'no-tool' }, pin: PIN_36 }).verdict, 'blind-no-tool');
  const v = targetSdkVerdict({ dump: { reason: 'unreadable', detail: 'Invalid file' }, pin: PIN_36 });
  assert.equal(v.verdict, 'blind-unreadable');
  assert.equal(v.detail, 'Invalid file');
});

test('🔴 blindness is decided BEFORE the expectation is consulted', () => {
  // A run that could not read the artefact must not be reported as a problem
  // with the build file, even when the build file is also broken. Two broken
  // inputs, and the one that makes every other answer impossible wins.
  const v = targetSdkVerdict({
    dump: { reason: 'no-tool' },
    pin: { verdict: 'inherited', raw: 'flutter.targetSdkVersion', value: null },
  });
  assert.equal(v.verdict, 'blind-no-tool');
});

test('an unsourced expectation is its own verdict, and still reports the bytes', () => {
  for (const bad of ['inherited', 'expression', 'duplicate', 'missing', 'unreadable-file']) {
    const v = targetSdkVerdict({ dump: OK_DUMP, pin: { verdict: bad, raw: null, value: null } });
    assert.equal(v.verdict, 'unsourced', bad);
    assert.equal(v.reported, 36, 'what the artefact says is known and must not be withheld');
    assert.equal(v.pinned, null, 'nothing may be presented as the expectation');
  }
});

test('🔴 a null expectation can never pass by comparing equal to a null reading', () => {
  // The failure this pins: `report.value !== pin.value` is true-by-accident
  // safe only because 'unsourced' is decided first. If that order were ever
  // rearranged, null === null would read as agreement and publish.
  const v = targetSdkVerdict({
    dump: { reason: 'ok', text: REAL_BADGING_HEAD.replace("targetSdkVersion:'36'\n", '') },
    pin: { verdict: 'missing', raw: null, value: null },
  });
  assert.notEqual(v.verdict, 'ok');
});

// ── 4. the words, because the message IS the gate's output ──────────────────

test('🔴 a blind verdict never tells anyone to rebuild', () => {
  // The actual harm of confusing the two families is not a wrong exit code, it
  // is sending someone to rebuild an artefact that was already correct.
  for (const verdict of ['blind-no-tool', 'blind-unreadable', 'blind-not-badging', 'blind-no-uses-sdk']) {
    const msg = targetSdkRefusalMessage('app-direct-release.apk', {
      verdict, reported: null, pinned: null, minSdk: null, pinVerdict: 'literal', detail: 'x',
    });
    assert.ok(/NOTHING|BLIND/.test(msg), `${verdict} must name its own blindness: ${msg}`);
    // 🔴 FIRST CHECK YOUR RULER — the first version of this assertion was
    // `!/rebuild the apk/i`, and it FAILED on a correct message, because every
    // blind message contains the words "do not rebuild the APK". The ruler
    // matched the instruction it was looking for inside its own negation. The
    // token that actually distinguishes "go rebuild" from "do not rebuild" is
    // the build COMMAND, which only a mismatch prints.
    assert.ok(
      !msg.includes('make -C apps/mobile release'),
      `${verdict} must not hand out the rebuild command: ${msg}`,
    );
    assert.ok(
      /do not rebuild|Re-measure|before rebuilding anything/i.test(msg),
      `${verdict} must name a non-rebuild action: ${msg}`,
    );
  }
});

test('a mismatch DOES name the rebuild command, and the other suspect', () => {
  const msg = targetSdkRefusalMessage('app-direct-release.apk', {
    verdict: 'mismatch', reported: 36, pinned: 37, minSdk: 24, pinVerdict: 'literal', detail: null,
  });
  assert.ok(msg.includes('make -C apps/mobile release'), msg);
  assert.ok(msg.includes('AndroidManifest.xml'), 'a stale build is not the only cause');
  assert.ok(msg.includes('36') && msg.includes('37'), 'both numbers, or the reader must go and look');
});

test('the defect verdict says it is NOT blind, in those words', () => {
  const msg = targetSdkRefusalMessage('app-direct-release.apk', {
    verdict: 'no-target-field', reported: null, pinned: null, minSdk: 24, pinVerdict: 'literal', detail: '',
  });
  assert.ok(msg.includes('NOT a blind scan'), msg);
  assert.ok(msg.includes("sdkVersion:'24'"), 'the control reading is the evidence for that claim');
});

test('the unsourced message sends the reader to the source-side gate, not to a rebuild', () => {
  const msg = targetSdkRefusalMessage('app-direct-release.apk', {
    verdict: 'unsourced', reported: 36, pinned: null, minSdk: 24,
    pinVerdict: 'inherited', detail: 'flutter.targetSdkVersion',
  });
  assert.ok(msg.includes('scripts/android-sdk-pin.test.mjs'), msg);
  assert.ok(msg.includes('verify:scripts'), msg);
  assert.ok(msg.includes('SOURCE-side'), msg);
});

test('an unknown verdict is loud, not silent', () => {
  // The default branch of a switch is where a future verdict goes to die
  // quietly. It must read as a bug in the gate, not as a pass.
  const msg = targetSdkRefusalMessage('x.apk', { verdict: 'brand-new', reported: null, pinned: null });
  assert.ok(msg.includes('this gate has a bug'), msg);
});

// ── 5. the wrapper, end to end, on synthetic inputs ─────────────────────────

test('GREEN: agreement passes and reports both numbers to the operator', () => {
  withTempDir((dir) => {
    const rec = recorder();
    const passed = verifyApkTargetSdk('/fake/app-direct-release.apk', rec.fail, rec.ok, {
      gradlePath: gradleFixture(dir, '36'),
      readDump: () => OK_DUMP,
    });
    assert.equal(passed, true);
    assert.deepEqual(rec.fails, []);
    assert.equal(rec.oks.length, 1);
    assert.ok(rec.oks[0].includes('targetSdkVersion 36'), rec.oks[0]);
    assert.ok(rec.oks[0].includes("sdkVersion:'24'"), 'the control belongs in the green line too');
  });
});

test('🔴 RED: the same artefact against a different pin is refused', () => {
  // The reverse control, in miniature: nothing about the "artefact" changed
  // between this test and the one above — only the expectation moved.
  withTempDir((dir) => {
    const rec = recorder();
    const passed = verifyApkTargetSdk('/fake/app-direct-release.apk', rec.fail, rec.ok, {
      gradlePath: gradleFixture(dir, '35'),
      readDump: () => OK_DUMP,
    });
    assert.equal(passed, false);
    assert.deepEqual(rec.oks, [], 'a refused artefact must not also print a green line');
    assert.equal(rec.fails.length, 1);
    assert.ok(rec.fails[0].includes('pins targetSdk = 35'), rec.fails[0]);
  });
});

test('🔴 BLIND through the wrapper is refused too, with the blind sentence', () => {
  // "I don't know" must not pass as "fine" — same ruling as
  // verifyApkDisclosureCopy. It refuses, and the message is the thing that
  // differs from a mismatch.
  withTempDir((dir) => {
    const rec = recorder();
    const passed = verifyApkTargetSdk('/fake/app-direct-release.apk', rec.fail, rec.ok, {
      gradlePath: gradleFixture(dir, '36'),
      readDump: () => ({ reason: 'no-tool' }),
    });
    assert.equal(passed, false);
    assert.ok(rec.fails[0].includes('NOTHING'), rec.fails[0]);
    assert.ok(rec.fails[0].includes('do not rebuild'), rec.fails[0]);
  });
});

test('the wrapper never throws, whatever it is handed', () => {
  // It runs mid-release. A thrown exception here is a release stopped by a
  // stack trace instead of by a sentence naming an action.
  withTempDir((dir) => {
    const rec = recorder();
    assert.doesNotThrow(() => {
      verifyApkTargetSdk('/fake/x.apk', rec.fail, rec.ok, {
        gradlePath: join(dir, 'missing.kts'),
        readDump: () => ({ reason: 'ok', text: 'garbage that is not a dump' }),
      });
    });
    assert.equal(rec.fails.length, 1);
  });
});

test('the default seam is the real implementation, not a friendly no-op', () => {
  // CLAUDE.md anti-facade rule 2: a DI default must be the real thing or throw.
  // A default that quietly returned "fine" would make this gate a facade on
  // every production call, and nothing else here would notice.
  assert.equal(typeof dumpBadging, 'function');
  const gates = readFileSync(join(ROOT, 'scripts/publish-apk-gates.mjs'), 'utf8');
  assert.ok(/opts\.readDump \?\? dumpBadging/.test(gates), 'readDump must default to the real dump');
  assert.ok(/opts\.gradlePath \?\? GRADLE_PIN_FILE/.test(gates), 'gradlePath must default to the tracked file');
});

// ── 6. wiring: the gate must be called exactly once in production ───────────

test('🔴 the gate has exactly one production call site', () => {
  // Anti-facade in both directions, and it is not decoration. The gate WAS
  // temporarily called from inside verifyApkVersion, because the card that
  // added it could not write in publish.mjs while another window held that
  // file; the main session landed the proper line and deleted the nested call
  // in the same edit, and this test is what made that safe to do. Two failure
  // modes remain, and neither can be left to memory:
  //   0 calls — the publish.mjs line was removed (or the whole conjunction
  //             refactored), and the gate now protects nothing while looking
  //             present;
  //   2 calls — the nested call came back beside the publish.mjs one, and every
  //             target-level verdict prints twice off two aapt dumps of the
  //             same file.
  // Comments are stripped first with the repo's shared stripper: this file and
  // publish-apk-gates.mjs both WRITE the call in prose (including the exact
  // replacement line), and a retired or illustrative call in a comment counting
  // as a live edge is a measured false green in this repo (ADM-P0-1, the
  // module-reachability lint).
  const sources = ['scripts/publish-apk-gates.mjs', 'scripts/publish.mjs'];
  let calls = 0;
  const seen = [];
  for (const rel of sources) {
    // publish.mjs is read as TEXT on purpose. It has no isMainModule guard and
    // ends by uploading; importing it from a test would run a release.
    const code = codeLinesOnly(readFileSync(join(ROOT, rel), 'utf8'));
    const total = (code.match(/verifyApkTargetSdk\s*\(/g) || []).length;
    const defs = (code.match(/function\s+verifyApkTargetSdk\s*\(/g) || []).length;
    if (total - defs > 0) seen.push(`${rel} ×${total - defs}`);
    calls += total - defs;
  }
  assert.equal(
    calls,
    1,
    `verifyApkTargetSdk has ${calls} production call site(s) [${seen.join(', ')}], expected exactly 1.\n`
    + 'Either it is wired nowhere (a gate that cannot run), or it is wired twice\n'
    + '(publish.mjs got its own line and the nested call inside verifyApkVersion was\n'
    + 'not deleted — see the 🔴 block at the end of that function).',
  );
});

test('🔴 the call site is in publish.mjs, beside the gates it is decided with', () => {
  // WHERE the single call lives is part of the contract, not a detail. The test
  // above only counts to one; a lone call left nested inside verifyApkVersion
  // would satisfy it while making one function answer two questions — this
  // repo's number-one bug shape, and the reason that arrangement was temporary.
  const publish = codeLinesOnly(readFileSync(join(ROOT, 'scripts/publish.mjs'), 'utf8'));
  assert.ok(
    publish.includes('const targetOk = verifyApkTargetSdk(apk, fail, ok);'),
    'publish.mjs must call the gate directly, beside verifyApkVersion / '
    + 'verifyApkCarriesSelfUpdate / verifyApkDisclosureCopy',
  );
  assert.ok(
    /versionOk && featureOk && disclosureOk && targetOk/.test(publish),
    'and its verdict must gate staging — a gate whose answer is computed and '
    + 'then ignored is worse than no gate, because the line reads like protection',
  );
  const gates = readFileSync(join(ROOT, 'scripts/publish-apk-gates.mjs'), 'utf8');
  assert.ok(gates.includes('scripts/apk-target-sdk-gate.test.mjs'),
    'publish-apk-gates.mjs must name this drill, so whoever edits the wiring '
    + 'knows what will catch them');
});
