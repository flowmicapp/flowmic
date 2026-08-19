// UP-7 drill for scripts/apk-self-update-marker.mjs and its wiring into
// scripts/publish.mjs.
//
// WHAT UP-7 IS. `flutter build apk --release` — the bare command — produces an
// APK without the phone's self-update feature, silently, exit 0, every gate
// green. The define defaults to off on purpose (a forgotten define must cost us
// the feature, never ship a Play-policy-violating build) and the AOT compiler
// then tree-shakes the entire update module out. 0.2.59 was published exactly
// that way. This file's job is to prove that forgetting now goes RED.
//
// SAFETY — read before touching this file:
//   - This test NEVER imports and NEVER spawns scripts/publish.mjs, for the same
//     reason scripts/it27-publish-node-pin.test.mjs does not: that script has no
//     isMainModule guard, so every top-level statement — starting with Gate 0
//     (`pnpm verify:delivery`, ~35s, binds golden's real ports) — runs the
//     moment it is imported OR executed, and it ends by uploading to the owner's
//     LAN download center. publish.mjs is read here as TEXT only.
//   - It DOES import scripts/apk-self-update-marker.mjs, which is why that
//     module exists as a separate file: it is pure (no side effects, no I/O at
//     import), so the scanning mechanism can be drilled against real fixtures
//     instead of re-derived in the test — a test that re-implements its subject
//     proves only that the test agrees with itself.
//   - No fixture is a real 70 MB APK. §1–§4 use synthetic buffers; §5 (the
//     red-then-green demonstration) uses a fixture built from the same marker
//     constants the subject uses. Every temp file lives under node:os tmpdir()
//     and is removed in a `finally`. Nothing in this repo is written.
//
// WHAT THIS FILE CANNOT PROVE, stated so nobody reads more into a green run.
// The claim "marker present ⇔ define was on" rests on a measurement of Dart's
// AOT tree-shaking that only two real release builds can make. That measurement
// was taken (both directions, machine dev-pc-a, 2026-08-08 — the numbers
// are recorded in the subject's header §measurement) and it is not, and cannot
// be, re-taken by a fixture-driven unit test. §6 therefore pins the recorded
// measurement in place so that a future edit which changes the marker cannot
// quietly inherit the old evidence: change the marker, and you must re-measure.
//
// EXIT CODES (card IT-38 — see scripts/run-script-tests.mjs's header for the
// convention): 0 = PASS, 1 = FAIL, 2 = SKIP. This file never skips: every
// section depends only on repo source text and synthetic buffers, both of which
// exist in a fresh clone and in the open-source export tree. An exit 0 here
// therefore always means all 6/6 sections actually ran.
//
// Run: `node scripts/up7-apk-self-update-marker.test.mjs`

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APK_BUILD_COMMAND,
  APK_CONTROL_MARKER,
  APK_SELF_UPDATE_MARKER,
  countMarker,
  scanApkForSelfUpdate,
  selfUpdateRefusalMessage,
} from './apk-self-update-marker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_SRC = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8'); // text only
const MARKER_SRC = readFileSync(join(ROOT, 'scripts', 'apk-self-update-marker.mjs'), 'utf8');

let failures = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 6;
const section = (title) => {
  sectionsRun += 1;
  console.log(`\n=== ${title} ===`);
};
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

// Builds a stand-in for an APK's bytes. Real APKs store lib/<abi>/libapp.so
// UNCOMPRESSED (measured: `unzip -v` says "Stored", 0%), which is the only
// reason a raw byte scan reaches Dart string constants at all — so a flat
// buffer with the markers embedded in noise is a faithful model of the one
// property the subject depends on.
function fakeApk({ control = 3, feature = 3 } = {}) {
  const parts = [Buffer.from('PK\x03\x04fake-apk-header')];
  for (let i = 0; i < Math.max(control, feature); i++) {
    parts.push(Buffer.from(`\x00\x00padding-abi-${i}\x00\x00`));
    if (i < control) parts.push(Buffer.from(APK_CONTROL_MARKER, 'utf8'));
    parts.push(Buffer.from('\x00more-noise\x00'));
    if (i < feature) parts.push(Buffer.from(APK_SELF_UPDATE_MARKER, 'utf8'));
  }
  return Buffer.concat(parts);
}

// ── §1 counting ─────────────────────────────────────────────────────────────
section('§1 countMarker counts occurrences, not presence');
{
  assertTrue(countMarker(fakeApk({ control: 3, feature: 3 }), APK_CONTROL_MARKER) === 3, 'three ABIs → 3 control hits');
  assertTrue(countMarker(fakeApk({ control: 3, feature: 0 }), APK_SELF_UPDATE_MARKER) === 0, 'feature absent → 0 hits');
  assertTrue(countMarker(Buffer.alloc(0), APK_CONTROL_MARKER) === 0, 'empty buffer → 0, does not throw');
  // Overlapping-match guard: a naive `indexOf(needle, at + needle.length)` walk
  // and this one agree on non-overlapping markers, but the step of +1 is what
  // keeps the count honest for any marker chosen later. Asserted so a future
  // "optimisation" to +needle.length has to argue with a test.
  const doubled = Buffer.from('aaaa');
  assertTrue(countMarker(doubled, 'aa') === 3, 'overlapping occurrences are all counted (aa in aaaa → 3)');
}

// ── §2 the three verdicts ───────────────────────────────────────────────────
section('§2 scanApkForSelfUpdate separates "forgot the define" from "scan is blind"');
{
  const good = scanApkForSelfUpdate(fakeApk({ control: 3, feature: 3 }));
  assertTrue(good.verdict === 'ok', "feature present → verdict 'ok'");
  assertTrue(good.control === 3 && good.feature === 3, 'ok verdict reports both counts as evidence');

  // THE DEFECT: a bare `flutter build apk --release`.
  const bare = scanApkForSelfUpdate(fakeApk({ control: 3, feature: 0 }));
  assertTrue(bare.verdict === 'missing-feature', "control present, feature absent → 'missing-feature'");

  // THE RULER FAILING, which must NOT be reported as the defect. If the scan
  // cannot see this APK's Dart strings at all, then "the feature is absent" is
  // a confident answer to a question the scan never managed to ask. CLAUDE.md
  // G13 rule ②: a negative assertion needs its own positive control, or a zero
  // may mean the probe went blind rather than the implementation being right.
  const blind = scanApkForSelfUpdate(fakeApk({ control: 0, feature: 0 }));
  assertTrue(blind.verdict === 'blind', "control absent → 'blind', NOT 'missing-feature'");

  // Precedence: blind is decided FIRST. A buffer with no control but a stray
  // feature hit is still blind — the scan has not proven it can read this file.
  const weird = scanApkForSelfUpdate(fakeApk({ control: 0, feature: 3 }));
  assertTrue(weird.verdict === 'blind', 'control absent wins over feature present (blind is decided first)');
}

// ── §3 the refusal an operator actually reads ───────────────────────────────
section('§3 each refusal names the action, and the two are not interchangeable');
{
  const bare = selfUpdateRefusalMessage('FlowMic-x.y.z-release.apk', scanApkForSelfUpdate(fakeApk({ control: 3, feature: 0 })));
  assertTrue(bare.includes(APK_BUILD_COMMAND), 'missing-feature refusal quotes the exact rebuild command');
  assertTrue(bare.includes('--dart-define=FLOWMIC_SELF_UPDATE=1'), 'that command carries the define (the whole point)');
  assertTrue(/control marker present: 3 hits/.test(bare), 'missing-feature refusal states the control was seen — the evidence its verdict rests on');

  const blind = selfUpdateRefusalMessage('FlowMic-x.y.z-release.apk', scanApkForSelfUpdate(fakeApk({ control: 0, feature: 0 })));
  assertTrue(blind.includes('BLIND'), 'blind refusal says the scan is blind');
  assertTrue(blind.includes('Stored'), 'blind refusal names the thing to re-measure (libapp.so still Stored?)');
  // The two must not send an operator down the same road: one means "rebuild
  // the APK", the other means "the check is broken, do not touch the build".
  assertTrue(!blind.includes(APK_BUILD_COMMAND), 'blind refusal does NOT tell anyone to rebuild — that would be the wrong action');
}

// ── §4 wiring: the check is not merely correct, it is CALLED ────────────────
// A correct mechanism nobody invokes is this repo's headline historical bug
// class (anti-façade). The subject cannot be spawned here (see the header), so
// the wiring is proven from publish.mjs's source text.
section('§4 publish.mjs actually calls it, before staging, with no bypass');
{
  // W8-6 extracted the APK gates into publish-apk-gates.mjs (800-line cap).
  // The scanner import and verifyApkCarriesSelfUpdate body live there; publish
  // must still CALL the gate before stage() — that is the wiring this section
  // proves. Matching UP-9's publish-portable-archive.mjs precedent.
  const GATES_SRC = readFileSync(join(ROOT, 'scripts', 'publish-apk-gates.mjs'), 'utf8');
  assertTrue(
    /import\s*\{[^}]*verifyApkCarriesSelfUpdate[^}]*\}\s*from\s*'\.\/publish-apk-gates\.mjs'/s.test(PUBLISH_SRC),
    'publish.mjs imports verifyApkCarriesSelfUpdate from publish-apk-gates.mjs'
  );
  assertTrue(
    /import\s*\{[^}]*scanApkForSelfUpdate[^}]*\}\s*from\s*'\.\/apk-self-update-marker\.mjs'/s.test(GATES_SRC),
    'publish-apk-gates.mjs imports the scanner from the helper module'
  );
  assertTrue(/export function verifyApkCarriesSelfUpdate\(/.test(GATES_SRC), 'publish-apk-gates.mjs defines verifyApkCarriesSelfUpdate()');
  assertTrue(
    /const featureOk = verifyApkCarriesSelfUpdate\(apk, fail, ok\)/.test(PUBLISH_SRC),
    'it is called on the APK candidate'
  );
  // The staging condition is asserted as a WHOLE, not just "featureOk is in
  // there somewhere". A conjunct can be neutralised without being deleted —
  // `featureOk || true` reads almost the same — so the shape is pinned, and a
  // fourth gate arriving is meant to land here as a visible edit rather than
  // slipping past a loose match. Conjuncts so far, each its own card:
  // version (UP-7's neighbour) + feature (UP-7) + disclosure copy (W8-6) +
  // target API level (the 2026-08-19 store card, scripts/apk-target-sdk-gate.test.mjs).
  assertTrue(
    /if \(versionOk && featureOk && disclosureOk && targetOk\) stage\(apk, OUT/.test(PUBLISH_SRC),
    'staging is gated on version + feature + disclosure-copy + target-SDK'
  );
  // Not short-circuited: both questions get answered in one run.
  const callIdx = PUBLISH_SRC.indexOf('const featureOk = verifyApkCarriesSelfUpdate(apk, fail, ok)');
  const stageIdx = PUBLISH_SRC.indexOf('stage(apk, OUT');
  assertTrue(callIdx !== -1 && stageIdx !== -1 && callIdx < stageIdx, 'the check runs BEFORE stage() copies anything into publish/');
  assertTrue(
    !/verifyApkCarriesSelfUpdate[\s\S]{0,400}?process\.env\./.test(
      GATES_SRC.slice(GATES_SRC.indexOf('export function verifyApkCarriesSelfUpdate('))
    ),
    'no env-var bypass around the feature check (matching Gate 0’s no-override precedent)'
  );
  assertTrue(
    !/SKIP_SELF_UPDATE|--force-apk|FLOWMIC_SKIP_APK/.test(PUBLISH_SRC) &&
      !/SKIP_SELF_UPDATE|--force-apk|FLOWMIC_SKIP_APK/.test(GATES_SRC),
    'no skip flag exists for this gate'
  );
  // The refusal message that used to name the BARE command must not come back.
  assertTrue(
    !/Rebuild with `flutter build apk --release` after/.test(PUBLISH_SRC) &&
      !/Rebuild with `flutter build apk --release` after/.test(GATES_SRC),
    'the stale-APK refusal no longer documents the bare build command'
  );
}

// ── §5 red-then-green, end to end through a file on disk ────────────────────
// §2 proved the verdicts on buffers. This proves the whole path an operator
// hits: bytes on disk → read → scan → refusal, and the same path going green
// when the define is restored. A gate that has never been seen red is not
// known to be capable of going red, which is the exact shape this window has
// spent the day cataloguing.
section('§5 red then green, through real files on disk');
{
  const dir = mkdtempSync(join(tmpdir(), 'up7-'));
  try {
    const bare = join(dir, 'bare-build.apk');
    const withDefine = join(dir, 'with-define.apk');
    writeFileSync(bare, fakeApk({ control: 3, feature: 0 }));
    writeFileSync(withDefine, fakeApk({ control: 3, feature: 3 }));

    const red = scanApkForSelfUpdate(readFileSync(bare));
    assertTrue(red.verdict === 'missing-feature', 'RED: an APK built the bare way is refused');
    console.log(`        refusal: ${selfUpdateRefusalMessage('bare-build.apk', red).slice(0, 118)}…`);

    const green = scanApkForSelfUpdate(readFileSync(withDefine));
    assertTrue(green.verdict === 'ok', 'GREEN: the same path accepts an APK built with the define');

    // The pair matters more than either half: the two files differ ONLY in the
    // feature marker, so the verdict flip is attributable to that and to
    // nothing else.
    assertTrue(
      countMarker(readFileSync(bare), APK_CONTROL_MARKER) === countMarker(readFileSync(withDefine), APK_CONTROL_MARKER),
      'the red and green fixtures are identical in their control marker — only the feature marker differs'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §6 the markers are pinned to the measurement that justified them ────────
// The claim "feature marker absent ⇔ define was off" is TRUE OF THESE STRINGS,
// because two real release APKs were built and grepped. It is not true of
// strings in general. If someone changes a marker, the recorded measurement no
// longer describes the check — and the dangerous outcome is not a red gate, it
// is a green one standing on evidence gathered about a different string.
section('§6 markers cannot drift away from the evidence for them');
{
  assertTrue(APK_SELF_UPDATE_MARKER === '/api/updates/latest', "feature marker is still the one that was measured ('/api/updates/latest')");
  assertTrue(APK_CONTROL_MARKER === 'mobile:reconnect', "control marker is still the one that was measured ('mobile:reconnect')");
  // Both markers must still exist in the mobile source, or the check is
  // measuring a string the app no longer contains — which would go red on a
  // perfectly good build and get the gate deleted rather than re-measured.
  const updateCheck = readFileSync(join(ROOT, 'apps', 'mobile', 'lib', 'src', 'update', 'update_check.dart'), 'utf8');
  assertTrue(updateCheck.includes(APK_SELF_UPDATE_MARKER), 'the feature marker is still a literal in apps/mobile/.../update_check.dart');
  // ⚠️ Read the control marker's SOURCE OF TRUTH, not the generated Dart.
  // apps/mobile/lib/generated/flowmic_events.g.dart is the obvious file to read
  // and it is the WRONG one: `*.g.dart` is gitignored (.gitignore:7) and only
  // appears after `make gen`. Reading it would make this test throw ENOENT on a
  // fresh clone and in the open-source export tree — a crash, not a skip, in a
  // file wired into verify:delivery. packages/protocol/src/events.ts is tracked,
  // is not excluded from the export, and is what the generator generates FROM,
  // so asserting here is both safer and closer to the actual guarantee: the
  // control marker is a protocol event name and therefore cannot quietly drift
  // out of the mobile app while the protocol still carries it.
  const events = readFileSync(join(ROOT, 'packages', 'protocol', 'src', 'events.ts'), 'utf8');
  assertTrue(events.includes(APK_CONTROL_MARKER), 'the control marker is still a protocol event name (packages/protocol/src/events.ts)');
  // The measurement itself must stay readable beside the constants it justifies.
  assertTrue(/§measurement/.test(MARKER_SRC), 'the helper still carries its §measurement section');
  assertTrue(/72,232,275|2141467/.test(MARKER_SRC), 'the recorded both-directions numbers are still there to be re-checked');
}

console.log(`\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s)`);
if (failures > 0) {
  console.error(`\n✗ UP-7 drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\n✗ UP-7 drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections — a partial run is not a pass.`);
  process.exit(1);
}
console.log('\n✓ UP-7 drill PASSED');
