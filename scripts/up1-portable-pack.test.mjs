// Card UP-1 drill — the portable bundle's archive/sidecar contract and the
// manifest classifier that consumes it.
//
// SUBJECTS (both public, so this test travels with them in the open-source
// export — IT-12: a test and its subject travel together or not at all):
//   scripts/pack-portable.mjs
//   scripts/build-update-manifest.mjs
//
// Everything here runs against tiny FIXTURE trees, never the real ~100 MB
// publish/FlowMic-portable/ bundle: a test that needs a 100 MB build output in
// place is a test that quietly stops running.
//
// EXIT CODES (scripts/run-script-tests.mjs convention): 0 = PASS, 1 = FAIL,
// 2 = SKIP. Precedence, matching it27-publish-node-pin.test.mjs: any failed
// assertion → 1 regardless of skips; else any skipped section → 2 plus a
// `SKIP: <reason>` line; else 0. §3 is the only archiver-dependent section —
// a machine with no libarchive can still verify every other section, and
// saying so beats both a false green and a false red.
//
// Run: `node scripts/up1-portable-pack.test.mjs`

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORTABLE_PLATFORM,
  PORTABLE_DIR_NAME,
  describeStaleManifest,
  isPortableZipName,
  packPortable,
  parsePortableZipName,
  portableZipName,
  readZipEntries,
  resolveArchiver,
  sidecarLine,
  verifyPortableArchive,
} from './pack-portable.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECTION_NAMES = ['§1 names', '§2 sidecar contract', '§3 pack + round-trip', '§4 verifier reverse controls', '§5 manifest classifier'];

let failures = 0;
const skippedSections = [];
const section = (t) => console.log(`\n=== ${t} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures++; }
}
function skipSection(name, reason) {
  skippedSections.push({ name, reason });
  console.log(`  SKIP  ${name} — ${reason}`);
}
/** Asserts the call throws AND that the message names the right thing — a bare
 *  "it threw" would pass for a typo in the test itself. */
function assertThrows(fn, re, label) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  if (msg === null) { console.log(`  FAIL  ${label} (did not throw)`); failures++; return; }
  assertTrue(re.test(msg), `${label} — message: ${msg.split('\n')[0].slice(0, 120)}`);
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ── §1 the naming contract ─────────────────────────────────────────────────
section('§1 naming contract — one owner produces AND recognises the name');
{
  assertTrue(portableZipName('0.2.59') === 'FlowMic-0.2.59-portable-windows-x64.zip', 'portableZipName("0.2.59") uses the platform-qualified shape');
  assertTrue(DEFAULT_PORTABLE_PLATFORM === 'windows-x64', 'default platform token is spelled exactly as the manifest platform key');
  assertTrue(PORTABLE_DIR_NAME === 'FlowMic-portable', 'staged directory name matches publish.mjs');

  const round = parsePortableZipName(portableZipName('0.2.59'));
  assertTrue(round?.version === '0.2.59' && round?.platform === 'windows-x64', 'produced name parses back to the same version + platform');

  assertTrue(isPortableZipName('FlowMic-0.2.59-portable-windows-x64.zip') === true, 'accepts the real portable zip');
  // Additive platforms (owner ruling 2026-08-05 ①) must parse without a code
  // change here — the ALLOWLIST that decides which ones are servable lives in
  // build-update-manifest.mjs, deliberately, so the name parser staying open is
  // correct and is not the same question.
  assertTrue(parsePortableZipName('FlowMic-0.2.59-portable-macos-arm64.zip')?.platform === 'macos-arm64', 'parses a future macOS portable name additively');

  // 🔴 The regression that matters most on this machine: ./publish is a SHARED
  // artifact directory. Measured 2026-08-08, while this card was being written,
  // another window dropped FlowMic-0.2.59-macos-arm64.zip into it. A loose
  // `\.zip$` predicate would have swept that up and uploaded another window's
  // unfinished artifact.
  assertTrue(isPortableZipName('FlowMic-0.2.59-macos-arm64.zip') === false, 'REJECTS a non-portable .zip sharing publish/ (no -portable- segment)');
  assertTrue(isPortableZipName('FlowMic-0.2.59-release.apk') === false, 'rejects the apk');
  assertTrue(isPortableZipName('FlowMic_0.2.59_x64_zh-CN.msi') === false, 'rejects an msi');
  assertTrue(isPortableZipName('FlowMic-portable') === false, 'rejects the bare directory name');
  assertTrue(isPortableZipName('FlowMic-0.2.59-portable-WINDOWS-X64.zip') === false, 'rejects an upper-case platform token (one spelling only)');
}

// ── §2 the sidecar format is a contract shared with publish.mjs ────────────
section('§2 sidecar byte format — same contract publish.mjs stage() writes');
{
  const line = sidecarLine('a'.repeat(64), 'X.zip');
  assertTrue(line === `${'a'.repeat(64)}  X.zip\n`, 'sidecarLine is `<hash><two spaces><name>\\n`');
  assertTrue(line.split('  ').length === 2, 'exactly two spaces as the separator (three parsers split on /\\s+/ and take [0])');

  // Two mechanisms answering one question: this asserts the OTHER producer of
  // the same format still writes it the same way. If publish.mjs's stage() is
  // ever reformatted, this goes red here rather than at a release.
  const publishSrc = readFileSync(join(ROOT, 'scripts', 'publish.mjs'), 'utf8');
  assertTrue(publishSrc.includes('`${hash}  ${name}\\n`'), 'scripts/publish.mjs stage() still writes the identical two-space format');
}

// ── §3 pack a fixture tree and verify the archive against its source ───────
section('§3 pack + round-trip (fixture tree, not the real bundle)');
let archiver = null;
try {
  archiver = resolveArchiver();
  console.log(`  · archiver ${archiver.path} (${archiver.identity})`);
} catch (e) {
  skipSection('§3 pack + round-trip', `no libarchive archiver on this machine: ${e.message.split('\n')[0]}`);
}
if (archiver) {
  const root = mkdtempSync(join(tmpdir(), 'up1-pack-'));
  try {
    const outDir = join(root, 'publish');
    const bundle = join(outDir, PORTABLE_DIR_NAME);
    mkdirSync(join(bundle, 'resources'), { recursive: true });
    writeFileSync(join(bundle, 'FlowMic.exe'), Buffer.from('fixture exe bytes, not a real binary'));
    writeFileSync(join(bundle, 'resources', 'server.js'), Buffer.from('fixture sidecar server'));
    // The one non-ASCII name the real bundle carries. It is in the fixture on
    // purpose: without --options zip:hdrcharset=UTF-8 this entry is stored as
    // GBK bytes with the UTF-8 flag clear and extracts as mojibake anywhere
    // else. That is measured on this machine, so it gets a test.
    writeFileSync(join(bundle, '使用说明.txt'), Buffer.from('fixture readme'));

    // --check must touch nothing.
    const before = readdirSync(outDir).sort();
    const plan = packPortable({ outDir, version: '9.9.9', check: true });
    assertTrue(plan.check === true && plan.zipName === 'FlowMic-9.9.9-portable-windows-x64.zip', '--check reports the name it would write');
    assertTrue(JSON.stringify(readdirSync(outDir).sort()) === JSON.stringify(before), '--check wrote nothing at all');

    const r = packPortable({ outDir, version: '9.9.9' });
    const zipPath = join(outDir, r.zipName);
    assertTrue(existsSync(zipPath), 'zip written under the contract name');
    assertTrue(existsSync(`${zipPath}.sha256`), 'sidecar written beside it');

    const zipBytes = readFileSync(zipPath);
    assertTrue(zipBytes.subarray(0, 4).toString('hex') === '504b0304', 'produced file really is a zip (PK\\3\\4), not a tar wearing a .zip name');
    assertTrue(sha256(zipBytes) === r.hash, 'returned hash is a hash of the bytes on disk');
    assertTrue(readFileSync(`${zipPath}.sha256`, 'utf8') === sidecarLine(r.hash, r.zipName), 'sidecar content is byte-exact `<hash>  <name>\\n`');

    const entries = readZipEntries(zipBytes);
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    assertTrue(tops.size === 1 && tops.has(PORTABLE_DIR_NAME), `exactly one top-level entry (${JSON.stringify([...tops])})`);

    // 🔴 The producing-side pin (ruled 2026-08-08). The line above is
    // SELF-REFERENTIAL: rename the constant and both sides move together, the
    // assertion stays green, and the SHIPPED archive's shape has silently
    // changed underneath every consumer. So the literal value is pinned too —
    // this is the assertion that actually costs something to break.
    assertTrue(PORTABLE_DIR_NAME === 'FlowMic-portable', 'the top-level directory name is pinned to the literal "FlowMic-portable", not merely to whatever the constant says');
    assertTrue([...tops][0] === 'FlowMic-portable', 'and a freshly packed archive really contains that literal as its single top-level entry');

    // ⚠️ What this does NOT license anyone to assume. `kind: "portable-zip"`
    // covers more than this bundle: the macOS artifact is the same kind and its
    // top level is DIFFERENT. Measured 2026-08-08 on dev-pc-a against the
    // real 0.2.59 archives:
    //     FlowMic-0.2.59-portable-windows-x64.zip  → top-level ["FlowMic-portable"]
    //     FlowMic-0.2.59-portable-macos-arm64.zip  → top-level ["FlowMic.app"]
    // The updater (card UP-3) must VERIFY the top-level entry it extracted, never
    // assume this constant applies to every portable-zip. That is the consuming
    // half; this test is the producing half, and the two are only allowed to
    // drift loudly.

    const files = entries.filter((e) => !e.isDir).map((e) => e.name).sort();
    assertTrue(
      JSON.stringify(files) === JSON.stringify([
        'FlowMic-portable/FlowMic.exe',
        'FlowMic-portable/resources/server.js',
        'FlowMic-portable/使用说明.txt',
      ]),
      `all 3 source files present under the prefix, none extra — got ${JSON.stringify(files)}`,
    );

    const cjk = entries.find((e) => e.name.endsWith('使用说明.txt'));
    assertTrue(!!cjk, 'the non-ASCII entry name round-tripped as UTF-8 (not mojibake)');
    assertTrue(cjk?.utf8Flag === true, 'the non-ASCII entry carries the zip UTF-8 flag (bit 11) — otherwise it extracts garbled off this machine');

    assertTrue(readdirSync(outDir).every((f) => !f.startsWith('.pack-portable-')), 'no temp archive left behind');

    // 🔴 The packer is not reproducible (it embeds the clock — measured: same
    // second ⇒ identical, >2s apart ⇒ differs by a timestamp byte, content CRCs
    // never move). So a re-pack after a manifest exists silently invalidates
    // that manifest's hash pin, and the failure only ever shows up on a user's
    // machine. This asserts the warning fires, and — the half that matters more —
    // that it does NOT fire when the manifest still agrees.
    const manifestPath = join(outDir, 'update-manifest.json');
    const manifestWith = (sha) => JSON.stringify({
      manifest_version: 1,
      generated_at: new Date().toISOString(),
      platforms: { 'windows-x64': { version: '9.9.9', notes_url: null, artifacts: [{ kind: 'portable-zip', locale: null, filename: r.zipName, url: 'http://example.invalid/x.zip', sha256: sha, size: 1 }] } },
    });
    writeFileSync(manifestPath, manifestWith('0'.repeat(64)));
    assertTrue(/still pins sha256/.test(describeStaleManifest(outDir, r.zipName, r.hash) ?? ''), 'a manifest pinning a different sha256 is reported by name');
    writeFileSync(manifestPath, manifestWith(r.hash));
    assertTrue(describeStaleManifest(outDir, r.zipName, r.hash) === null, 'POSITIVE CONTROL: an agreeing manifest is silent (so the warning above is not unconditional)');
    rmSync(manifestPath, { force: true });
    assertTrue(describeStaleManifest(outDir, r.zipName, r.hash) === null, 'no manifest at all ⇒ silent');

    // 🔴 The measured trap this whole design exists for: GNU tar handed a .zip
    // filename writes a TAR and exits 0. Reproduce the artifact (a tar wearing
    // .zip) and prove the verifier refuses it — judging on exit code alone
    // could not have.
    const tarNamedZip = join(root, 'decoy.zip');
    const decoy = spawnSync(archiver.path, ['-c', '--format', 'ustar', '-f', tarNamedZip, '-C', outDir, PORTABLE_DIR_NAME], { encoding: 'utf8' });
    if (decoy.status === 0 && existsSync(tarNamedZip)) {
      assertThrows(() => readZipEntries(readFileSync(tarNamedZip)), /not a zip/i, 'a TAR named .zip is refused by the byte-level check');
    } else {
      console.log('  ·     (decoy tar could not be produced; skipping that one assertion)');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── §4 the verifier's comparison is not vacuous, in BOTH directions ────────
section('§4 verifier reverse controls (pure — no archiver needed)');
{
  // A hand-built minimal zip is not needed: verifyPortableArchive's comparison
  // is driven by readZipEntries' output plus the source list, so the cheapest
  // honest reverse control is to feed a real archive's entries against a source
  // list that deliberately disagrees. Build the buffer only if we can.
  assertThrows(() => readZipEntries(Buffer.from('this is definitely not a zip file at all, not even close')), /not a zip/i, 'refuses a non-zip buffer');
  assertThrows(() => readZipEntries(Buffer.alloc(4)), /shorter than/i, 'refuses a truncated buffer');

  if (archiver) {
    const root = mkdtempSync(join(tmpdir(), 'up1-rev-'));
    try {
      const outDir = join(root, 'publish');
      const bundle = join(outDir, PORTABLE_DIR_NAME);
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, 'only.txt'), Buffer.from('x'));
      const r = packPortable({ outDir, version: '9.9.9' });
      const buf = readFileSync(join(outDir, r.zipName));

      // Direction 1: source has a file the archive does not.
      assertThrows(
        () => verifyPortableArchive(buf, [{ rel: 'only.txt', size: 1 }, { rel: 'ghost.txt', size: 7 }]),
        /missing from the archive/,
        'REVERSE-CONTROL a source file absent from the zip is caught',
      );
      // Direction 2: archive has a file the source does not.
      assertThrows(
        () => verifyPortableArchive(buf, []),
        /not in the source tree/,
        'REVERSE-CONTROL an archive entry absent from the source is caught',
      );
      // Direction 3: same names, wrong size (truncation).
      assertThrows(
        () => verifyPortableArchive(buf, [{ rel: 'only.txt', size: 999 }]),
        /size mismatch/,
        'REVERSE-CONTROL a size disagreement is caught',
      );
      // Positive control: without it, all three above could be passing because
      // the verifier throws unconditionally.
      let okThrew = false;
      try { verifyPortableArchive(buf, [{ rel: 'only.txt', size: 1 }]); } catch { okThrew = true; }
      assertTrue(!okThrew, 'POSITIVE CONTROL: the truthful source list verifies cleanly (so the three refusals above mean something)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// ── §5 the manifest classifier, end to end on a fixture publish/ ──────────
section('§5 manifest classifier — build-update-manifest.mjs on a fixture tree');
{
  // Same technique as s8-release-script-defects.test.mjs: copy the scripts into
  // a disposable root so they compute their own ROOT from there. No archiver
  // needed — classify() reads filenames, and the hash gate reads bytes; neither
  // opens the zip.
  const buildFixture = (extraFiles = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'up1-manifest-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    // verify-remote-artifact.mjs rides along because build-update-manifest.mjs
    // imports it since UP-10 — a fixture tree missing a static import dies with
    // ERR_MODULE_NOT_FOUND before any section runs (2026-08-09, seen live).
    // update-manifest-lib.mjs + module-entrypoint-guard.mjs joined for the same
    // reason with ruling ① (2026-08-10) — and failed exactly as predicted first.
    for (const f of ['build-update-manifest.mjs', 'pack-portable.mjs', 'verify-remote-artifact.mjs', 'update-manifest-lib.mjs', 'module-entrypoint-guard.mjs']) {
      writeFileSync(join(root, 'scripts', f), readFileSync(join(ROOT, 'scripts', f)));
    }
    const out = join(root, 'publish');
    mkdirSync(out, { recursive: true });
    const put = (name, body, withSidecar = true) => {
      const bytes = Buffer.from(body);
      writeFileSync(join(out, name), bytes);
      if (withSidecar) writeFileSync(join(out, `${name}.sha256`), sidecarLine(sha256(bytes), name));
    };
    put('FlowMic_9.9.9_x64_zh-CN.msi', 'fixture msi');
    put('FlowMic-9.9.9-portable-windows-x64.zip', 'fixture portable zip bytes');
    // The neighbour that must be ignored — another window's artifact, measured
    // in the real publish/ on 2026-08-08.
    put('FlowMic-9.9.9-macos-arm64.zip', 'another window\'s artifact');
    for (const [name, spec] of Object.entries(extraFiles)) put(name, spec.body, spec.sidecar !== false);
    return { root, out };
  };
  // --skip-remote-verify: this fixture tree is offline by construction and this
  // drill tests the CLASSIFIER; the remote gate (UP-10) has its own drill that
  // drives it against a real loopback server. Without the flag, --check would
  // honestly try the network (its header forbids a silent --check exception).
  const runGen = (root) => spawnSync(process.execPath, [join(root, 'scripts', 'build-update-manifest.mjs'), '--check', '--skip-remote-verify'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const parseManifest = (stdout) => {
    const a = stdout.indexOf('{');
    const b = stdout.lastIndexOf('}');
    return a >= 0 && b > a ? JSON.parse(stdout.slice(a, b + 1)) : null;
  };

  // (a) happy path
  {
    const { root } = buildFixture();
    const r = runGen(root);
    assertTrue(r.status === 0, `generator exits 0 on a well-formed fixture (got ${r.status}) ${r.stderr?.slice(0, 200) ?? ''}`);
    const m = parseManifest(r.stdout ?? '');
    const win = m?.platforms?.['windows-x64']?.artifacts ?? [];
    const portable = win.find((a) => a.filename === 'FlowMic-9.9.9-portable-windows-x64.zip');
    assertTrue(!!portable, 'the portable zip appears in the manifest');
    assertTrue(portable?.kind === 'portable-zip', `its kind is "portable-zip" (got ${JSON.stringify(portable?.kind)})`);
    assertTrue(portable?.locale === null, 'its locale is null (the bundle is not language-specific)');
    assertTrue(portable?.url?.endsWith('FlowMic-9.9.9-portable-windows-x64.zip'), 'its url is the named-file link, not the moving stable link');
    assertTrue(/^[0-9a-f]{64}$/.test(portable?.sha256 ?? ''), 'its sha256 is 64 lower-case hex (the endpoint refuses anything else)');
    assertTrue(win.some((a) => a.kind === 'msi'), 'the msi is still classified alongside it (no regression)');

    const everyFilename = Object.values(m?.platforms ?? {}).flatMap((p) => p.artifacts.map((a) => a.filename));
    assertTrue(!everyFilename.includes('FlowMic-9.9.9-macos-arm64.zip'), 'REGRESSION: a non-portable .zip sharing publish/ is NOT pulled into the manifest');
    assertTrue(!Object.keys(m?.platforms ?? {}).includes('macos-arm64'), 'and it did not invent a macos-arm64 platform key');
    rmSync(root, { recursive: true, force: true });
  }

  // (b) an unknown portable platform is refused LOUDLY, whole-manifest
  {
    const { root } = buildFixture({ 'FlowMic-9.9.9-portable-freebsd-x64.zip': { body: 'unknown platform' } });
    const r = runGen(root);
    assertTrue(r.status !== 0, 'an unrecognised portable platform refuses the whole manifest');
    assertTrue(/认不出平台|清单未生成/.test((r.stdout ?? '') + (r.stderr ?? '')), 'and it names the file rather than silently inventing a platform key');
    rmSync(root, { recursive: true, force: true });
  }

  // (c) gate ① still holds for the new artifact: no sidecar ⇒ NOTHING is written
  {
    const { root } = buildFixture();
    rmSync(join(root, 'publish', 'FlowMic-9.9.9-portable-windows-x64.zip.sha256'), { force: true });
    const r = runGen(root);
    assertTrue(r.status !== 0, 'a portable zip with no .sha256 sidecar refuses the manifest');
    assertTrue(/缺 \.sha256 侧车/.test((r.stdout ?? '') + (r.stderr ?? '')), 'and says the sidecar is missing');
    assertTrue(!/"manifest_version"/.test(r.stdout ?? ''), 'REVERSE-CONTROL: the WHOLE manifest is withheld, not just that one entry');
    rmSync(root, { recursive: true, force: true });
  }

  // (d) gate ① part b: sidecar disagreeing with the bytes ⇒ whole manifest withheld
  {
    const { root } = buildFixture();
    const sc = join(root, 'publish', 'FlowMic-9.9.9-portable-windows-x64.zip.sha256');
    writeFileSync(sc, sidecarLine('0'.repeat(64), 'FlowMic-9.9.9-portable-windows-x64.zip'));
    const r = runGen(root);
    assertTrue(r.status !== 0, 'a sidecar that disagrees with the bytes refuses the manifest');
    assertTrue(/与侧车哈希不符/.test((r.stdout ?? '') + (r.stderr ?? '')), 'and names the mismatch');
    assertTrue(!/"manifest_version"/.test(r.stdout ?? ''), 'REVERSE-CONTROL: whole manifest withheld, not one entry dropped');
    rmSync(root, { recursive: true, force: true });
  }
}

// ── accounting + exit-code precedence ─────────────────────────────────────
const sectionsRun = SECTION_NAMES.length - skippedSections.length;
const acct =
  `sections run ${sectionsRun}/${SECTION_NAMES.length}` +
  (skippedSections.length > 0
    ? `, skipped: ${skippedSections.map((s) => `${s.name} (${s.reason})`).join('; ')}`
    : ', no sections skipped');
console.log(`\nACCOUNTING: ${acct}`);
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);

if (failures > 0) {
  process.exit(1);
} else if (skippedSections.length > 0) {
  console.log(`SKIP: ${acct}.`);
  process.exit(2);
} else {
  process.exit(0);
}
