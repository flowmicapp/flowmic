// W8-6 drill for scripts/apk-disclosure-copy-marker.mjs and its wiring into
// scripts/publish.mjs.
//
// WHAT W8-6 IS. 0.2.60 shipped LAN TLS encryption while the APK's disclosure
// still said encryption was unfinished. The rewrite commit landed after the
// release pin. Every gate green; only a content scan of the shipped bytes
// can see it. Same shape as UP-7 / N1-B4.
//
// SAFETY — read before touching this file:
//   - This test NEVER imports and NEVER spawns scripts/publish.mjs (same reason
//     as up7-apk-self-update-marker.test.mjs / it27-publish-node-pin.test.mjs):
//     that script has no isMainModule guard and ends by uploading to the LAN
//     download center. publish.mjs is read here as TEXT only.
//   - It DOES import scripts/apk-disclosure-copy-marker.mjs, which is pure
//     (no side effects, no I/O at import).
//   - No fixture is a real 70 MB APK. §§1–5 use synthetic buffers that embed
//     markers in the encodings the subject depends on (Chinese = utf16le,
//     ASCII = utf8). Every temp file lives under node:os tmpdir() and is
//     removed in a `finally`. Nothing in this repo is written.
//
// WHAT THIS FILE CANNOT PROVE. The claim "marker present ⇔ copy rewrite is in
// the AOT snapshot" rests on a measurement of real release APKs. That
// measurement is recorded in the subject's header §measurement and pinned in
// §6 so a future marker edit cannot quietly inherit old evidence.
//
// EXIT CODES (card IT-38): 0 = PASS, 1 = FAIL, 2 = SKIP. This file never
// skips. Exit 0 always means all sections actually ran.
//
// Run: `node scripts/w86-disclosure-copy-marker.test.mjs`

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APK_DISCLOSURE_CONTROL_UTF16LE,
  APK_DISCLOSURE_CONTROL_UTF8,
  APK_DISCLOSURE_NEW_MARKERS,
  APK_DISCLOSURE_OLD_MARKERS,
  APK_DISCLOSURE_REPORTED_UTF8,
  countMarkerEncoded,
  disclosureCopyRefusalMessage,
  scanApkForDisclosureCopy,
} from './apk-disclosure-copy-marker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_SRC = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8');
const MARKER_SRC = readFileSync(join(ROOT, 'scripts', 'apk-disclosure-copy-marker.mjs'), 'utf8');

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

/** Flat buffer that models Stored libapp.so: Chinese as utf16le, ASCII as utf8. */
function fakeApk({
  controls = true,
  newCopy = true,
  oldCopy = false,
  includeReported = true,
} = {}) {
  const parts = [Buffer.from('PK\x03\x04fake-apk-header')];
  const pushUtf16 = (s) => parts.push(Buffer.from(s, 'utf16le'));
  const pushUtf8 = (s) => parts.push(Buffer.from(s, 'utf8'));
  // Three ABI-shaped repetitions, matching the measured 3-hit shape.
  for (let i = 0; i < 3; i++) {
    parts.push(Buffer.from(`\x00\x00padding-abi-${i}\x00\x00`));
    if (controls) {
      for (const s of APK_DISCLOSURE_CONTROL_UTF16LE) pushUtf16(s);
      for (const s of APK_DISCLOSURE_CONTROL_UTF8) pushUtf8(s);
    }
    if (includeReported) {
      for (const s of APK_DISCLOSURE_REPORTED_UTF8) pushUtf8(s);
    }
    if (newCopy) {
      for (const s of APK_DISCLOSURE_NEW_MARKERS) pushUtf16(s);
    }
    if (oldCopy) {
      for (const s of APK_DISCLOSURE_OLD_MARKERS) pushUtf16(s);
    }
    parts.push(Buffer.from('\x00more-noise\x00'));
  }
  return Buffer.concat(parts);
}

// ── §1 counting / encoding ──────────────────────────────────────────────────
section('§1 countMarkerEncoded respects encoding; Chinese is utf16le');
{
  const buf = fakeApk();
  const sample = APK_DISCLOSURE_NEW_MARKERS[0];
  assertTrue(countMarkerEncoded(buf, sample, 'utf16le') === 3, 'new marker ×3 as utf16le');
  assertTrue(
    countMarkerEncoded(buf, sample, 'utf8') === 0,
    'same Chinese marker as utf8 → 0 (the trap this gate exists to document)'
  );
  assertTrue(
    countMarkerEncoded(buf, APK_DISCLOSURE_CONTROL_UTF8[0], 'utf8') === 3,
    'ASCII control ×3 as utf8'
  );
  assertTrue(countMarkerEncoded(Buffer.alloc(0), sample, 'utf16le') === 0, 'empty buffer → 0');
  const doubled = Buffer.from('aaaa');
  assertTrue(countMarkerEncoded(doubled, 'aa', 'utf8') === 3, 'overlapping utf8 counts stay honest');
}

// ── §2 the three verdicts ───────────────────────────────────────────────────
section('§2 scanApkForDisclosureCopy separates copy-stale from scanner-blind');
{
  const good = scanApkForDisclosureCopy(fakeApk({ controls: true, newCopy: true, oldCopy: false }));
  assertTrue(good.verdict === 'ok', "current copy → verdict 'ok'");
  assertTrue(
    Object.values(good.newHits).every((n) => n === 3) &&
      Object.values(good.oldHits).every((n) => n === 0),
    'ok verdict reports new×3 and old×0 as evidence'
  );

  // THE DEFECT: pre-rewrite disclosure still in the AOT snapshot.
  const stale = scanApkForDisclosureCopy(fakeApk({ controls: true, newCopy: false, oldCopy: true }));
  assertTrue(stale.verdict === 'copy-stale', "controls present, new absent → 'copy-stale'");

  // Mixed: new present but old not fully removed — still refuse.
  const mixed = scanApkForDisclosureCopy(fakeApk({ controls: true, newCopy: true, oldCopy: true }));
  assertTrue(mixed.verdict === 'copy-stale', 'old markers remaining → copy-stale even if new is present');

  // THE RULER FAILING — must NOT be reported as the defect.
  const blind = scanApkForDisclosureCopy(fakeApk({ controls: false, newCopy: false, oldCopy: false }));
  assertTrue(blind.verdict === 'scanner-blind', "controls absent → 'scanner-blind', NOT 'copy-stale'");

  // Precedence: blind first. Stray new hits without controls are still blind.
  const weird = scanApkForDisclosureCopy(fakeApk({ controls: false, newCopy: true, oldCopy: false }));
  assertTrue(weird.verdict === 'scanner-blind', 'controls absent wins over new present (blind decided first)');
}

// ── §3 the refusal an operator actually reads ───────────────────────────────
section('§3 each refusal names the action, and the two are not interchangeable');
{
  const stale = disclosureCopyRefusalMessage(
    'FlowMic-x.y.z-release.apk',
    scanApkForDisclosureCopy(fakeApk({ controls: true, newCopy: false, oldCopy: true }))
  );
  assertTrue(stale.includes('copy-stale'), 'stale refusal names copy-stale');
  assertTrue(stale.includes('disclosure_strings.dart'), 'stale refusal points at the source file to rebuild from');
  assertTrue(/utf16le controls present/.test(stale), 'stale refusal states the Chinese controls were seen');

  const blind = disclosureCopyRefusalMessage(
    'FlowMic-x.y.z-release.apk',
    scanApkForDisclosureCopy(fakeApk({ controls: false, newCopy: false, oldCopy: false }))
  );
  assertTrue(blind.includes('scanner-blind') || blind.includes('BLIND'), 'blind refusal says the scan is blind');
  assertTrue(blind.includes('UTF-16LE'), 'blind refusal names the encoding trap');
  assertTrue(!blind.includes('disclosure_strings.dart'), 'blind refusal does NOT tell anyone to rebuild the copy');
}

// ── §4 wiring: the check is not merely correct, it is CALLED ────────────────
section('§4 publish.mjs actually calls it, before staging, with no bypass');
{
  // Gates body lives in publish-apk-gates.mjs (800-line cap split, UP-9
  // precedent). Wiring proof = import + call-before-stage in publish.mjs,
  // plus the scanner import and function body in the gates module.
  const GATES_SRC = readFileSync(join(ROOT, 'scripts', 'publish-apk-gates.mjs'), 'utf8');
  assertTrue(
    /import\s*\{[^}]*verifyApkDisclosureCopy[^}]*\}\s*from\s*'\.\/publish-apk-gates\.mjs'/s.test(PUBLISH_SRC),
    'publish.mjs imports verifyApkDisclosureCopy from publish-apk-gates.mjs'
  );
  assertTrue(
    /import\s*\{[^}]*scanApkForDisclosureCopy[^}]*\}\s*from\s*'\.\/apk-disclosure-copy-marker\.mjs'/s.test(
      GATES_SRC
    ),
    'publish-apk-gates.mjs imports the scanner from the helper module'
  );
  assertTrue(
    /export function verifyApkDisclosureCopy\(/.test(GATES_SRC),
    'publish-apk-gates.mjs defines verifyApkDisclosureCopy()'
  );
  assertTrue(
    /const disclosureOk = verifyApkDisclosureCopy\(apk, fail, ok\)/.test(PUBLISH_SRC),
    'it is called on the APK candidate'
  );
  assertTrue(
    /if \(versionOk && featureOk && disclosureOk\) stage\(apk, OUT/.test(PUBLISH_SRC),
    'staging is gated on version + self-update + disclosure-copy'
  );
  const callIdx = PUBLISH_SRC.indexOf('const disclosureOk = verifyApkDisclosureCopy(apk, fail, ok)');
  const stageIdx = PUBLISH_SRC.indexOf('stage(apk, OUT');
  assertTrue(
    callIdx !== -1 && stageIdx !== -1 && callIdx < stageIdx,
    'the check runs BEFORE stage() copies anything into publish/'
  );
  assertTrue(
    !/verifyApkDisclosureCopy[\s\S]{0,400}?process\.env\./.test(
      GATES_SRC.slice(GATES_SRC.indexOf('export function verifyApkDisclosureCopy('))
    ),
    'no env-var bypass around the disclosure check'
  );
  assertTrue(
    !/SKIP_DISCLOSURE|--force-apk-disclosure|FLOWMIC_SKIP_DISCLOSURE/.test(PUBLISH_SRC) &&
      !/SKIP_DISCLOSURE|--force-apk-disclosure|FLOWMIC_SKIP_DISCLOSURE/.test(GATES_SRC),
    'no skip flag exists for this gate'
  );
}

// ── §5 red-then-green, through real files on disk ───────────────────────────
section('§5 red then green, through real files on disk');
{
  const dir = mkdtempSync(join(tmpdir(), 'w86-'));
  try {
    const stalePath = join(dir, 'stale-copy.apk');
    const currentPath = join(dir, 'current-copy.apk');
    writeFileSync(stalePath, fakeApk({ controls: true, newCopy: false, oldCopy: true }));
    writeFileSync(currentPath, fakeApk({ controls: true, newCopy: true, oldCopy: false }));

    const red = scanApkForDisclosureCopy(readFileSync(stalePath));
    assertTrue(red.verdict === 'copy-stale', 'RED: an APK with pre-rewrite disclosure is refused');
    console.log(`        refusal: ${disclosureCopyRefusalMessage('stale-copy.apk', red).slice(0, 118)}…`);

    const green = scanApkForDisclosureCopy(readFileSync(currentPath));
    assertTrue(green.verdict === 'ok', 'GREEN: the same path accepts an APK with the rewrite');

    assertTrue(
      countMarkerEncoded(readFileSync(stalePath), APK_DISCLOSURE_CONTROL_UTF16LE[0], 'utf16le') ===
        countMarkerEncoded(readFileSync(currentPath), APK_DISCLOSURE_CONTROL_UTF16LE[0], 'utf16le'),
      'red/green fixtures share the same utf16le control — only the copy markers differ'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §6 markers pinned to the measurement that justified them ────────────────
section('§6 markers cannot drift away from the evidence for them');
{
  // 🔴 REPINNED 2026-08-14 — and this assertion doing its job is why the change
  // is visible at all. The 0.2.67 disclosure compression removed two of the
  // original three phrases from the shipped copy, so the gate went red twice:
  // once on the missing markers, and once HERE, refusing to let anyone repoint
  // the canaries without saying so out loud. That second red is the valuable
  // one. The claims were verified to survive the rewrite before the new phrases
  // were chosen (see the reasoning at APK_DISCLOSURE_NEW_MARKERS); all three now
  // come from `discStep4LanPlain`, the one string whose truth depends on how
  // this pairing was made and which must never revert to the pre-W8-6 copy.
  assertTrue(
    APK_DISCLOSURE_NEW_MARKERS.join('|') ===
      '要看这条配对是怎么建的|此前建的配对仍然是明文|每一次连接都核对',
    'new markers are still the three measured phrases'
  );
  assertTrue(
    APK_DISCLOSURE_OLD_MARKERS.join('|') === '加密还在做|目前没有加密|做好之前这句话不会消失',
    'old markers are still the three measured phrases'
  );
  assertTrue(
    APK_DISCLOSURE_CONTROL_UTF16LE.join('|') === '这一页说清|局域网',
    'utf16le controls are still the ones measured on both APKs'
  );
  assertTrue(APK_DISCLOSURE_CONTROL_UTF8[0] === 'mobile:reconnect', 'utf8 control is still mobile:reconnect');
  assertTrue(
    APK_DISCLOSURE_REPORTED_UTF8[0] === '/api/updates/latest',
    'reported (non-blind-gate) utf8 marker is still /api/updates/latest'
  );

  // 🔴 0.2.67 — THE COPY MOVED, THE CHECK FOLLOWED IT. Until the P1 locale
  // migration these phrases were literals inside disclosure_strings.dart. That
  // shard now holds logic and reasoning only; the Chinese copy lives in
  // i18n/mobile/zh-CN.json, from which lib/src/settings/l10n/*.g.dart is
  // generated (architecture doc §4.1) and the AOT snapshot built.
  //
  // Reading the DATA file and not the generated Dart is deliberate: the .g.dart
  // is gitignored, so on a clean checkout it does not exist, and a check that
  // silently finds nothing to read is the failure this drill exists to prevent.
  // The two are kept in step by verify:lint's i18n-generated-fresh gate.
  const disclosure = readFileSync(join(ROOT, 'i18n', 'mobile', 'zh-CN.json'), 'utf8');
  for (const s of APK_DISCLOSURE_NEW_MARKERS) {
    assertTrue(disclosure.includes(s), `new marker still in the zh-CN catalogue: ${s}`);
  }
  for (const s of APK_DISCLOSURE_OLD_MARKERS) {
    assertTrue(!disclosure.includes(s), `old marker must NOT remain in the zh-CN catalogue: ${s}`);
  }
  assertTrue(disclosure.includes('这一页说清'), 'utf16le control still in the zh-CN catalogue');

  const events = readFileSync(join(ROOT, 'packages', 'protocol', 'src', 'events.ts'), 'utf8');
  assertTrue(events.includes('mobile:reconnect'), 'utf8 control still a protocol event name');

  assertTrue(/§measurement/.test(MARKER_SRC), 'the helper still carries its §measurement section');
  assertTrue(/UTF-16LE/.test(MARKER_SRC), 'the encoding trap is still documented in the helper');
  assertTrue(
    /not a blind-gate control|NOT used for the blind/.test(MARKER_SRC),
    'the /api/updates/latest blind-gate exclusion is still documented'
  );
}

console.log(`\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s)`);
if (failures > 0) {
  console.error(`\n✗ W8-6 drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\n✗ W8-6 drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections — a partial run is not a pass.`);
  process.exit(1);
}
console.log('\n✓ W8-6 drill PASSED');
