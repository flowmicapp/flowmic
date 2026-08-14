// UP-9 drill for scripts/portable-self-update-marker.mjs and its wiring into
// scripts/publish.mjs.
//
// WHAT UP-9 IS. The portable edition's in-place self-updater landed in commit
// 830bbf7 at 07:32 on 2026-08-08. The 0.2.59 portable zip published that day was
// built at 05:23 — about ninety minutes earlier. So the shipped portable edition
// cannot update itself, and NOTHING went red: not publish.mjs's preflight, not
// the packer, not verify:delivery, not the manifest generator. This file's job
// is to prove that packing a stale exe now goes RED.
//
// SAFETY — read before touching this file:
//   - This test NEVER imports and NEVER spawns scripts/publish.mjs, for the same
//     reason scripts/up7-apk-self-update-marker.test.mjs does not: that script
//     has no isMainModule guard, so every top-level statement — starting with
//     Gate 0 (`pnpm verify:delivery`, ~35s, binds golden's real ports) — runs the
//     moment it is imported OR executed, and it ends by uploading to the owner's
//     LAN download center. publish.mjs is read here as TEXT only.
//   - It DOES import scripts/portable-self-update-marker.mjs, which is why that
//     module exists as a separate file: it is pure (no side effects, no I/O at
//     import), so the scanning mechanism can be drilled against real fixtures
//     instead of re-derived in the test — a test that re-implements its subject
//     proves only that the test agrees with itself. It transitively imports
//     scripts/pack-portable.mjs, which DOES have a main-module guard (verified
//     in §6), so importing it runs nothing.
//   - It also imports scripts/publish-portable-archive.mjs and DRIVES
//     `gatePortableArchive` directly (§4). That module's top level is imports
//     and function declarations only, so importing it runs nothing either. §4
//     deliberately calls the GATE half and never `publishPortableArchive`, which
//     would spawn the real packer.
//   - No fixture is a real 38 MB zip. §1–§5 build REAL zip archives in memory
//     with zlib.deflateRawSync and hand-written headers, so the drill depends on
//     no artifact being present. §7 additionally reads the real 0.2.59 zip IF it
//     happens to be staged, and reports unmeasured rather than passing when it is not.
//     Every temp file lives under node:os tmpdir() and is removed in a `finally`.
//     Nothing in this repo is written.
//
// WHAT THIS FILE CANNOT PROVE, stated so nobody reads more into a green run.
// The claim "feature marker present ⇔ the swap code is compiled in" has been
// measured in ONE direction only — the negative one, on the real shipped 0.2.59
// exe (0 hits, control 7 hits). No binary built after 830bbf7 exists on this
// machine, so the POSITIVE direction is argued, not observed; the subject's
// §measurement section states exactly that and pins the obligation. A synthetic
// fixture cannot discharge it: these zips contain the marker because this file
// put it there. §6 therefore pins the markers to the sources that justify them,
// so an edit which changes a marker cannot quietly inherit the old evidence.
//
// EXIT CODES (card IT-38 — see scripts/run-script-tests.mjs's header for the
// convention): 0 = PASS, 1 = FAIL, 2 = SKIP. This file never skips as a whole:
// §1–§6 depend only on repo source text and synthetic buffers, both of which
// exist in a fresh clone. §7 alone can be unmeasured, and it is counted in its
// own bucket — never as a pass (CLAUDE.md §1-bis-5: a direction with zero
// samples is a skip, not a pass).
//
// Run: `node scripts/up9-portable-self-update-marker.test.mjs`
// Also run automatically by `pnpm verify:scripts` (inside verify:delivery),
// which DISCOVERS scripts/*.test.mjs by glob rather than by a hand-kept list.

import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  PORTABLE_BUILD_COMMAND,
  PORTABLE_CONTROL_MARKER,
  PORTABLE_EXE_ENTRY,
  PORTABLE_SELF_UPDATE_MARKER,
  countMarker,
  extractPortableExe,
  portableRefusalMessage,
  scanPortableForSelfUpdate,
} from './portable-self-update-marker.mjs';
import { gatePortableArchive } from './publish-portable-archive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH_SRC = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8'); // text only
const STEP_SRC = readFileSync(join(ROOT, 'scripts', 'publish-portable-archive.mjs'), 'utf8');
const MARKER_SRC = readFileSync(join(ROOT, 'scripts', 'portable-self-update-marker.mjs'), 'utf8');
const REAL_ZIP = join(ROOT, 'publish', 'FlowMic-0.2.59-portable-windows-x64.zip');

let failures = 0;
let unmeasured = 0;
let sectionsRun = 0;
const TOTAL_SECTIONS = 7;
const samples = {};
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
function notMeasured(label, why) {
  unmeasured++;
  console.log(`  unmeasured  ${label}`);
  console.log(`          ${why}`);
}

// ── a REAL zip builder ──────────────────────────────────────────────────────
// Hand-written local headers + central directory + EOCD, payloads through
// zlib.deflateRawSync. Deliberately a real archive rather than a flat buffer:
// the whole point of UP-9's subject is that the portable zip is DEFLATE and a
// raw scan is structurally blind, so a fixture that skipped compression would
// be a faithful model of the one property the subject does NOT have.
function zipEntry(name, data, { store = false } = {}) {
  const nameBuf = Buffer.from(name, 'utf8');
  const body = store ? data : deflateRawSync(data);
  return { nameBuf, body, crc: crc32(data), csize: body.length, usize: data.length, method: store ? 0 : 8 };
}
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(e.method, 8);
    lh.writeUInt16LE(0, 10);          // time
    lh.writeUInt16LE(0x21, 12);       // date (1980-01-01)
    lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.csize, 18);
    lh.writeUInt32LE(e.usize, 22);
    lh.writeUInt16LE(e.nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);          // extra len
    locals.push(lh, e.nameBuf, e.body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0, 8);           // flags
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.csize, 20);
    cd.writeUInt32LE(e.usize, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra
    cd.writeUInt16LE(0, 32);          // comment
    cd.writeUInt16LE(0, 34);          // disk
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0, 38);          // external attrs
    cd.writeUInt32LE(offset, 42);     // local header offset
    centrals.push(cd, e.nameBuf);
    offset += 30 + e.nameBuf.length + e.body.length;
  }
  const localBuf = Buffer.concat(locals);
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

/** A stand-in desktop exe: markers embedded in enough noise that DEFLATE really
 *  has to compress something. `control`/`feature` are hit counts, mirroring the
 *  real exe's shape (7 control hits in the measured 0.2.59 binary). */
function fakeExe({ control = 7, feature = 4 } = {}) {
  const parts = [Buffer.from('MZ\x90\x00fake-pe-header')];
  for (let i = 0; i < Math.max(control, feature, 1); i++) {
    parts.push(Buffer.from(`  .rdata-padding-${i}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  `));
    if (i < control) parts.push(Buffer.from(PORTABLE_CONTROL_MARKER, 'utf8'));
    parts.push(Buffer.from(' \x00 more-noise \x00 '));
    if (i < feature) parts.push(Buffer.from(PORTABLE_SELF_UPDATE_MARKER, 'utf8'));
  }
  return Buffer.concat(parts);
}

/** A full portable-shaped archive, with the sibling entries the real one has. */
function fakePortableZip({ control = 7, feature = 4, exeName = PORTABLE_EXE_ENTRY, store = false } = {}) {
  return buildZip([
    zipEntry('FlowMic-portable/', Buffer.alloc(0), { store: true }),
    zipEntry(exeName, fakeExe({ control, feature }), { store }),
    zipEntry('FlowMic-portable/resources/package.json', Buffer.from('{"type":"module"}\n')),
    zipEntry('FlowMic-portable/使用说明.txt', Buffer.from('一键运行版\n', 'utf8')),
  ]);
}

// ── §1 the zip really is DEFLATE, and that is why a raw scan cannot work ─────
// This is the section that justifies the subject existing at all instead of
// reusing UP-7's raw grep. If it ever goes green with a raw scan too, the
// fixture stopped modelling the real archive.
section('§1 the portable zip is DEFLATE — a raw byte scan is structurally blind');
{
  const zip = fakePortableZip({ control: 7, feature: 4 });
  samples['§1 real DEFLATE archives'] = 1;

  const rawFeature = countMarker(zip, PORTABLE_SELF_UPDATE_MARKER);
  const rawControl = countMarker(zip, PORTABLE_CONTROL_MARKER);
  assertTrue(rawFeature === 0, 'raw scan of the ZIP finds 0 feature hits (the bytes are compressed)');
  assertTrue(rawControl === 0, 'raw scan of the ZIP finds 0 control hits too — i.e. it would report BLIND on every portable zip ever built');

  const { exe, reason, entries } = extractPortableExe(zip);
  assertTrue(exe !== null && reason === null, 'extractPortableExe inflates the entry');
  assertTrue(entries.includes(PORTABLE_EXE_ENTRY), 'the entry list names the exe it found');
  assertTrue(countMarker(exe, PORTABLE_SELF_UPDATE_MARKER) === 4, 'after inflation the feature marker is countable (4 hits)');
  assertTrue(countMarker(exe, PORTABLE_CONTROL_MARKER) === 7, 'after inflation the control marker is countable (7 hits)');
  // Byte-exactness, not just marker presence: an off-by-a-few payload offset
  // (local header extra-length read from the wrong record) would still inflate
  // something marker-shaped in a fixture this small.
  assertTrue(Buffer.compare(exe, fakeExe({ control: 7, feature: 4 })) === 0, 'the inflated bytes are byte-identical to what was packed');

  // A Stored entry must work too — the subject accepts method 0 — so that a
  // future packer change to store the exe does not read as "blind".
  const stored = fakePortableZip({ control: 7, feature: 4, store: true });
  assertTrue(scanPortableForSelfUpdate(stored).verdict === 'ok', 'a STORED (method 0) exe entry is handled, not misread as blind');
}

// ── §2 the four verdicts ────────────────────────────────────────────────────
section('§2 scanPortableForSelfUpdate separates "stale exe" from "cannot see" from "wrong file"');
{
  samples['§2 synthetic verdict cases'] = 6;
  const good = scanPortableForSelfUpdate(fakePortableZip({ control: 7, feature: 4 }));
  assertTrue(good.verdict === 'ok', "feature present → verdict 'ok'");
  assertTrue(good.control === 7 && good.feature === 4 && good.exeBytes > 0, 'ok verdict reports both counts and the exe size as evidence');

  // THE DEFECT: an exe from a tree older than 830bbf7.
  const stale = scanPortableForSelfUpdate(fakePortableZip({ control: 7, feature: 0 }));
  assertTrue(stale.verdict === 'missing-feature', "control present, feature absent → 'missing-feature'");

  // THE RULER FAILING, which must NOT be reported as the defect (G13 rule ②).
  const blind = scanPortableForSelfUpdate(fakePortableZip({ control: 0, feature: 0 }));
  assertTrue(blind.verdict === 'blind', "control absent → 'blind', NOT 'missing-feature'");
  const weird = scanPortableForSelfUpdate(fakePortableZip({ control: 0, feature: 4 }));
  assertTrue(weird.verdict === 'blind', 'control absent wins over feature present (blind is decided first)');

  // THE WRONG FILE — e.g. the macOS portable zip, whose payload is a .app
  // bundle. Nothing is scanned, so nothing may be concluded about any build.
  const mac = scanPortableForSelfUpdate(buildZip([
    zipEntry('FlowMic.app/Contents/MacOS/FlowMic', fakeExe({ control: 7, feature: 4 })),
    zipEntry('FlowMic.app/Contents/Info.plist', Buffer.from('<plist/>')),
  ]));
  assertTrue(mac.verdict === 'no-exe-entry', "an archive without the exe entry → 'no-exe-entry', decided before any counting");
  assertTrue(mac.control === 0 && mac.feature === 0 && mac.reason === 'exe-entry-absent', 'no-exe-entry reports zero counts and names WHY (exe-entry-absent)');
  assertTrue(mac.entries.length === 2, 'it hands back what the archive DOES contain, for the operator to read');

  // Malformed input must produce a verdict, never a stack trace: a release gate
  // that crashes produces a traceback where it owes an answer.
  for (const [label, buf] of [
    ['empty buffer', Buffer.alloc(0)],
    ['random bytes', Buffer.from('this is definitely not a zip file at all')],
    ['truncated zip', fakePortableZip().subarray(0, 200)],
  ]) {
    let v = null;
    try { v = scanPortableForSelfUpdate(buf).verdict; } catch { v = 'THREW'; }
    assertTrue(v === 'no-exe-entry', `${label} → 'no-exe-entry', does not throw`);
  }
  // zip64 must be refused BY NAME rather than misparsed: the 32-bit fields hold
  // sentinels there, and reading them as real offsets yields a confident wrong
  // verdict. Forge the sentinel into a real archive's EOCD.
  const z64 = Buffer.from(fakePortableZip());
  z64.writeUInt32LE(0xffffffff, z64.length - 22 + 16);
  const z64scan = scanPortableForSelfUpdate(z64);
  assertTrue(z64scan.verdict === 'no-exe-entry' && z64scan.reason === 'zip64-not-supported', 'a zip64 sentinel is refused by name, not misparsed into a wrong verdict');
}

// ── §3 the refusal an operator actually reads ───────────────────────────────
section('§3 each refusal names its action, and the three are not interchangeable');
{
  samples['§3 refusal messages'] = 3;
  const label = 'FlowMic-x.y.z-portable-windows-x64.zip';
  const stale = portableRefusalMessage(label, scanPortableForSelfUpdate(fakePortableZip({ control: 7, feature: 0 })));
  assertTrue(stale.includes(PORTABLE_BUILD_COMMAND), 'missing-feature refusal quotes the exact rebuild command');
  assertTrue(/STALE BINARY/.test(stale), 'it names the CAUSE as a stale binary — not a forgotten build flag (that is the APK gate’s cause, not this one)');
  assertTrue(/control marker present: 7 hits/.test(stale), 'it states the control was seen — the evidence its verdict rests on');
  assertTrue(stale.includes('830bbf7'), 'it names the commit the exe predates, so the operator can check the claim');

  const blind = portableRefusalMessage(label, scanPortableForSelfUpdate(fakePortableZip({ control: 0, feature: 0 })));
  assertTrue(blind.includes('BLIND'), 'blind refusal says the scan is blind');
  assertTrue(/do NOT rebuild/i.test(blind), 'blind refusal actively warns AGAINST the other refusal’s action');
  assertTrue(!blind.includes(PORTABLE_BUILD_COMMAND), 'blind refusal does NOT quote the rebuild command — that would be the wrong action');

  const wrong = portableRefusalMessage(label, scanPortableForSelfUpdate(buildZip([zipEntry('FlowMic.app/Contents/MacOS/FlowMic', fakeExe())])));
  assertTrue(/NOT A FLOWMIC WINDOWS PORTABLE BUNDLE/.test(wrong), 'no-exe-entry refusal says what the file is not');
  assertTrue(/macOS/.test(wrong), 'it names the macOS zip explicitly as the expected innocent cause — the known uncovered surface');
  assertTrue(!wrong.includes(PORTABLE_BUILD_COMMAND), 'no-exe-entry refusal does NOT tell anyone to rebuild either');
  assertTrue(/Contents\/MacOS/.test(wrong), 'it lists the entries actually found');

  // The three must not read alike. If two refusals share their action, the
  // verdict split bought nothing.
  assertTrue(new Set([stale, blind, wrong]).size === 3, 'the three refusals are three different texts');
}

// ── §4 wiring: the check is not merely correct, it is CALLED — and it EXITS ──
// A correct mechanism nobody invokes is this repo's headline historical bug
// class. Worse here than usual: this gate sits AFTER publish.mjs's last
// `if (failed) process.exit(1)`, so a bare fail() would print red, set a flag
// nobody reads again, and upload the artifact it had just refused.
//
// So the exit is not asserted by reading source text — gatePortableArchive is
// DRIVEN here, in process, with a fake `exit`, and observed refusing. That is
// why `exit` is a parameter of the real function rather than a bare
// process.exit() call inside it: a function that can only end the process can
// only be exercised by ending the process.
section('§4 publish.mjs calls it, refuses on it, exits, and cannot be bypassed');
{
  samples['§4 driven wiring runs'] = 2;
  // The import list may carry siblings (ENG-1b added stagePortableSherpaAddon);
  // what this pins is that publishPortableArchive comes from THAT module, not
  // that it travels alone.
  assertTrue(
    /import\s*\{[^}]*\bpublishPortableArchive\b[^}]*\}\s*from\s*'\.\/publish-portable-archive\.mjs'/.test(PUBLISH_SRC),
    'publish.mjs imports publishPortableArchive from the extracted step module'
  );
  const callIdx = PUBLISH_SRC.indexOf('publishPortableArchive({ root: ROOT, outDir: OUT, version: VERSION, fail, ok });');
  assertTrue(callIdx !== -1, 'and calls it with publish.mjs’s own fail()/ok() reporters');

  // Ordering: the refusal must precede the upload, or it refuses an artifact
  // that has already left the building. And it must follow the last preflight
  // exit, which is the reason the gate has to exit for itself.
  //
  // 🔴 THE LANDMARK IS THE SPAWN, NOT THE PUBLISHER'S FILENAME (OSS-EXPORT-1,
  // 2026-08-09). This line used to read `.indexOf('publish-download-center' +
  // the .mjs suffix)`, and that was wrong in two independent ways:
  //   · MEASURED, and the reason this is a fix rather than a dodge: that
  //     string's FIRST occurrence in publish.mjs is not the upload at all — it
  //     is the comment paragraph some forty lines earlier telling the operator
  //     they can re-run the publisher by hand. So the assertion was green by
  //     layout luck. Move the real upload above this gate and leave that
  //     comment paragraph where it is, and this stays green while the ordering
  //     it exists to protect is broken. A landmark answering "where is the
  //     first MENTION" cannot answer "where does the upload RUN"; the spawn
  //     pinned below is the upload, so now it answers the question asked.
  //   · scripts/publish-download-center.mjs is EXCLUDEd from the open-source
  //     export (internal LAN site address, publish-key fetch procedure,
  //     network whitelist). Naming it in EXECUTABLE code made this drill read
  //     as an orphaned test/subject pair to checkTestSubjectPairs, which
  //     refused the entire export (IT-12: a test and its subject travel
  //     together or not at all). That rule is intact and unweakened here: this
  //     drill's subject is the portable self-update marker chain — every file
  //     of which ships — and the publisher was never its subject, only a
  //     position marker inside a third file's text. Naming it in a full-line
  //     comment, as this note does, is deliberate and safe: the gate strips
  //     full-line comments precisely because a comment cannot make a test fail
  //     to load.
  // Do NOT "simplify" this back to the filename. It would re-break
  // `node scripts/opensource-export.mjs` AND quietly re-weaken the assertion.
  const uploadIdx = PUBLISH_SRC.indexOf('execFileSync(process.execPath, [downloadCenterScript]');
  assertTrue(uploadIdx !== -1 && callIdx < uploadIdx, 'the step runs BEFORE the download-center upload (landmark: the spawn itself)');
  const lastFailedGate = PUBLISH_SRC.lastIndexOf('if (failed) {');
  assertTrue(lastFailedGate !== -1 && lastFailedGate < callIdx, 'and AFTER publish.mjs’s last `if (failed)` check — hence the gate’s own exit');

  assertTrue(
    !/SKIP_PORTABLE_SELF_UPDATE|--force-portable|FLOWMIC_SKIP_PORTABLE/.test(PUBLISH_SRC + STEP_SRC),
    'no skip flag exists for this gate'
  );
  assertTrue(!/process\.env\./.test(STEP_SRC), 'no env-var bypass anywhere in the step module (matching Gate 0’s no-override precedent)');

  // 🔴 DRIVEN, not read: the real gate, a real on-disk zip, a fake exit.
  const dir = mkdtempSync(join(tmpdir(), 'up9-wire-'));
  try {
    const version = '0.0.0-fixture';
    writeFileSync(join(dir, `FlowMic-${version}-portable-windows-x64.zip`), fakePortableZip({ control: 7, feature: 0 }));
    const errs = [];
    const oks = [];
    let exitCode = null;
    gatePortableArchive({
      outDir: dir,
      version,
      fail: (m) => errs.push(m),
      ok: (m) => oks.push(m),
      err: (m) => errs.push(m),
      exit: (c) => { exitCode = c; },
    });
    assertTrue(exitCode === 1, 'RED PATH: a stale-exe zip makes the real gate call exit(1) — the refusal actually stops the run');
    assertTrue(errs.some((m) => /STALE BINARY/.test(m)), 'and it reported through fail() with the stale-binary refusal');
    assertTrue(errs.some((m) => /must NOT be distributed/.test(m)), 'and told the operator the artifact on disk must not be distributed');
    assertTrue(oks.length === 0, 'and printed no success line');

    // GREEN PATH through the same function: no exit, one ok() carrying counts.
    const v2 = '0.0.1-fixture';
    writeFileSync(join(dir, `FlowMic-${v2}-portable-windows-x64.zip`), fakePortableZip({ control: 7, feature: 4 }));
    let exit2 = null;
    const oks2 = [];
    gatePortableArchive({ outDir: dir, version: v2, fail: () => {}, ok: (m) => oks2.push(m), err: () => {}, exit: (c) => { exit2 = c; } });
    assertTrue(exit2 === null, 'GREEN PATH: a current-exe zip does not exit');
    assertTrue(oks2.length === 1 && /control ×7/.test(oks2[0]), 'and prints the counts, so the evidence lands in the log either way');

    // A missing zip is its own refusal — "the packer said it worked" is not
    // evidence that the file exists.
    let exit3 = null;
    const errs3 = [];
    gatePortableArchive({ outDir: dir, version: '9.9.9-absent', fail: (m) => errs3.push(m), ok: () => {}, err: () => {}, exit: (c) => { exit3 = c; } });
    assertTrue(exit3 === 1 && /is not in \.\/publish/.test(errs3[0] ?? ''), 'a packer that reports success without producing the zip is refused too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §5 red-then-green, end to end through files on disk ─────────────────────
// §2 proved the verdicts on in-memory buffers. This proves the whole path an
// operator hits: a zip on disk → read → central directory → inflate → scan →
// refusal, and the same path going green when the exe is current. A gate that
// has never been seen red is not known to be capable of going red.
section('§5 red then green, through real zip files on disk');
{
  samples['§5 on-disk archives'] = 2;
  const dir = mkdtempSync(join(tmpdir(), 'up9-'));
  try {
    const staleZip = join(dir, 'FlowMic-0.0.0-portable-windows-x64.zip');
    const freshZip = join(dir, 'FlowMic-0.0.1-portable-windows-x64.zip');
    writeFileSync(staleZip, fakePortableZip({ control: 7, feature: 0 }));
    writeFileSync(freshZip, fakePortableZip({ control: 7, feature: 4 }));

    const red = scanPortableForSelfUpdate(readFileSync(staleZip));
    assertTrue(red.verdict === 'missing-feature', 'RED: a zip carrying a pre-830bbf7 exe is refused');
    console.log(`        refusal: ${portableRefusalMessage('FlowMic-0.0.0-portable-windows-x64.zip', red).slice(0, 132)}…`);

    const green = scanPortableForSelfUpdate(readFileSync(freshZip));
    assertTrue(green.verdict === 'ok', 'GREEN: the same path accepts a zip whose exe carries the swap code');

    // The pair matters more than either half: the two archives differ ONLY in
    // the feature marker, so the verdict flip is attributable to that and to
    // nothing else.
    assertTrue(
      red.control === green.control && red.control > 0,
      'the red and green fixtures are identical in their control marker — only the feature marker differs'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── §6 the markers are pinned to the sources that justify them ──────────────
// If someone changes a marker, the recorded measurement no longer describes the
// check — and the dangerous outcome is not a red gate, it is a GREEN one
// standing on evidence gathered about a different string.
section('§6 markers cannot drift away from the evidence for them');
{
  samples['§6 pinned sources'] = 3;
  assertTrue(PORTABLE_SELF_UPDATE_MARKER === '--flowmic-apply-update', "feature marker is still the one that was measured ('--flowmic-apply-update')");
  assertTrue(PORTABLE_CONTROL_MARKER === 'inject:request', "control marker is still the one that was measured ('inject:request')");
  assertTrue(PORTABLE_EXE_ENTRY === 'FlowMic-portable/FlowMic.exe', 'the scanned entry path is still the one the packer writes');

  // The feature marker must still be APPLY_UPDATE_ARG's literal value, or this
  // gate is looking for a string the mover is no longer launched with — it would
  // go red on a perfectly good build and get deleted rather than re-measured.
  const applyArg = readFileSync(join(ROOT, 'apps', 'desktop', 'src-tauri', 'src', 'update', 'apply_arg.rs'), 'utf8');
  assertTrue(
    new RegExp(`APPLY_UPDATE_ARG:\\s*&str\\s*=\\s*"${PORTABLE_SELF_UPDATE_MARKER}"`).test(applyArg),
    'the feature marker is still APPLY_UPDATE_ARG’s literal value in src/update/apply_arg.rs'
  );
  // …and still reachable from main(), which is the whole basis of the (argued,
  // not measured) positive direction. If intercept() stops calling the parser,
  // the linker may drop the constant and this gate starts lying.
  assertTrue(/fn intercept\(\)[\s\S]{0,400}job_path_from_args\(&args\)/.test(applyArg), 'intercept() still routes argv through job_path_from_args — the reachability argument still holds');

  // The control marker must still be a desktop string constant AND a protocol
  // event name. Reading BOTH is the point: the desktop const is what the scan
  // actually finds in the exe, and the protocol entry is why it cannot quietly
  // drift out of the desktop.
  const eventsRs = readFileSync(join(ROOT, 'apps', 'desktop', 'src-tauri', 'src', 'events.rs'), 'utf8');
  assertTrue(eventsRs.includes(`"${PORTABLE_CONTROL_MARKER}"`), 'the control marker is still a &str constant in src-tauri/src/events.rs');
  const eventsTs = readFileSync(join(ROOT, 'packages', 'protocol', 'src', 'events.ts'), 'utf8');
  assertTrue(eventsTs.includes(PORTABLE_CONTROL_MARKER), 'the control marker is still a protocol event name (packages/protocol/src/events.ts)');

  // The measurement, and its honest limits, must stay readable beside the
  // constants they justify.
  assertTrue(/§measurement/.test(MARKER_SRC), 'the helper still carries its §measurement section');
  assertTrue(/15,825,408|5,215,779/.test(MARKER_SRC), 'the recorded real-artifact numbers are still there to be re-checked');
  assertTrue(/NOT MEASURED/.test(MARKER_SRC), 'the helper still states which direction is UNmeasured — the day that line goes missing, an argument starts reading as a reading');
  assertTrue(/KNOWN UNCOVERED SURFACE: macOS/.test(MARKER_SRC), 'the helper still states the macOS gap rather than implying coverage it lacks');

  // pack-portable.mjs is imported for PORTABLE_DIR_NAME; importing it must stay
  // side-effect-free, or this drill (and publish.mjs) would run a packer.
  const packSrc = readFileSync(join(ROOT, 'scripts', 'pack-portable.mjs'), 'utf8');
  assertTrue(/sameEntry\(thisFile, argvEntry\)/.test(packSrc), 'pack-portable.mjs still has its main-module guard, so importing it runs nothing');
  // The step module must stay import-safe too: §4 imports it to drive the gate,
  // and a top-level statement there would spawn the packer during the drill.
  const topLevel = STEP_SRC.split('\n').filter((l) => /^[a-z]/.test(l) && !/^(import|export|const|function)\b/.test(l));
  assertTrue(topLevel.length === 0, 'publish-portable-archive.mjs has no top-level statements — importing it spawns nothing');
}

// ── §7 corroboration from the real shipped artifact ─────────────────────────
// Everything above is synthetic by design. This is the one section that reads
// bytes nobody in this repo wrote, and it is the reason the gate is believed:
// the 0.2.59 zip really does score missing-feature.
section('§7 the real 0.2.59 artifact scores missing-feature (corroboration)');
{
  if (existsSync(REAL_ZIP)) {
    samples['§7 real shipped artifacts'] = 1;
    const scan = scanPortableForSelfUpdate(readFileSync(REAL_ZIP));
    console.log(`        reading: control=${scan.control} feature=${scan.feature} verdict=${scan.verdict} exeBytes=${scan.exeBytes}`);
    assertTrue(scan.verdict === 'missing-feature', 'the shipped 0.2.59 portable zip is REFUSED by this gate');
    assertTrue(scan.control > 0, 'and its control marker is non-zero — the verdict rests on a scan that could see');
    assertTrue(scan.exeBytes === 15825408, 'the inflated exe is the 15,825,408-byte binary recorded in §measurement');
  } else {
    samples['§7 real shipped artifacts'] = 0;
    notMeasured(
      'the shipped 0.2.59 portable zip could not be scanned',
      `publish/FlowMic-0.2.59-portable-windows-x64.zip is absent (./publish is a gitignored ` +
      `product directory, so a fresh clone never has it). This case is counted as UNMEASURED, ` +
      `not as a pass: a direction with zero samples is a skip. The synthetic sections above ` +
      `still ran and still prove the mechanism.`
    );
  }
}

console.log('\nSAMPLES PER CASE:');
for (const [k, v] of Object.entries(samples)) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`\nACCOUNTING: sections run ${sectionsRun}/${TOTAL_SECTIONS}, ${failures} assertion failure(s), ${unmeasured} unmeasured case(s)`);
if (failures > 0) {
  console.error(`\n✗ UP-9 drill FAILED (${failures} assertion(s))`);
  process.exit(1);
}
if (sectionsRun !== TOTAL_SECTIONS) {
  console.error(`\n✗ UP-9 drill ran ${sectionsRun}/${TOTAL_SECTIONS} sections — a partial run is not a pass.`);
  process.exit(1);
}
if (unmeasured > 0) console.log(`\n⚠ ${unmeasured} case(s) unmeasured — green here does NOT include them.`);
console.log('\n✓ UP-9 drill PASSED');
