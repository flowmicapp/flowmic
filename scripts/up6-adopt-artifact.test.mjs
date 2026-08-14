// Card UP-6 drill — adopting a cross-machine artifact into ./publish, and the
// manifest classifier learning the other two portable platforms.
//
// SUBJECTS (all public, so this test travels with them in the open-source
// export — IT-12):
//   scripts/adopt-artifact.mjs
//   scripts/pack-portable.mjs      (PORTABLE_PLATFORMS, the single platform list)
//   scripts/build-update-manifest.mjs
//
// The centre of gravity is §1 and §2: --sha256 is the ENTIRE mechanism. If it
// can be omitted, mistyped-and-normalised, or satisfied by hashing whatever
// arrived, then adoption launders unattested bytes into a sidecar that claims
// they were vetted — and every other assertion in this file would still pass.
// So those refusals are drilled harder than the happy path.
//
// Fixtures only. Nothing here touches the real ./publish, the network, or a
// credential.
//
// Run: `node scripts/up6-adopt-artifact.test.mjs`

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AdoptError, adoptArtifact, checkVersionAgreement, choosePlatform } from './adopt-artifact.mjs';
import { PORTABLE_PLATFORMS, sidecarLine } from './pack-portable.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADOPT = join(ROOT, 'scripts', 'adopt-artifact.mjs');
const SECTION_NAMES = ['§1 attestation required', '§2 attestation verified', '§3 canonical naming', '§4 byte identity', '§5 version cross-check', '§6 refusals + clobber', '§7 manifest end-to-end'];

let failures = 0;
const section = (t) => console.log(`\n=== ${t} ===`);
function assertTrue(cond, label) {
  if (cond) console.log(`  PASS  ${label}`);
  else { console.log(`  FAIL  ${label}`); failures++; }
}
function assertRefuses(fn, re, label) {
  let msg = null;
  let wasAdoptError = false;
  try { fn(); } catch (e) { msg = e.message; wasAdoptError = e instanceof AdoptError; }
  if (msg === null) { console.log(`  FAIL  ${label} (did NOT refuse — this is the dangerous direction)`); failures++; return; }
  assertTrue(wasAdoptError && re.test(msg), `${label} — "${msg.split('\n')[0].slice(0, 110)}"`);
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// Minimal bytes that begin with the zip magic — adopt-artifact deliberately
// checks only the magic on a foreign artifact (a macOS .app zip has a different
// internal shape than our Windows bundle), so this is a faithful stand-in.
const fakeZip = (payload) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(payload)]);

function fixture(sourceName = 'FlowMic-9.9.9-macos-arm64.zip', payload = 'notarized app bytes from the Mac mini') {
  const root = mkdtempSync(join(tmpdir(), 'up6-'));
  const outDir = join(root, 'publish');
  mkdirSync(outDir, { recursive: true });
  const bytes = fakeZip(payload);
  const sourcePath = join(root, sourceName);
  writeFileSync(sourcePath, bytes);
  return { root, outDir, sourcePath, bytes, hash: sha256(bytes) };
}

// ── §1 the attestation is required, and not normalised ────────────────────
section('§1 --sha256 is REQUIRED and strictly shaped (this is the whole mechanism)');
{
  const f = fixture();
  const base = { sourcePath: f.sourcePath, version: '9.9.9', outDir: f.outDir };

  assertRefuses(() => adoptArtifact({ ...base }), /missing --sha256/, 'omitted entirely ⇒ refused');
  assertRefuses(() => adoptArtifact({ ...base, attestedSha256: '' }), /missing --sha256/, 'empty string ⇒ refused');
  assertRefuses(() => adoptArtifact({ ...base, attestedSha256: f.hash.toUpperCase() }), /upper-case hex/, 'upper-case ⇒ refused BY NAME, not normalised');
  assertRefuses(() => adoptArtifact({ ...base, attestedSha256: f.hash.slice(0, 63) }), /63 hex characters, not 64/, 'truncated ⇒ refused, states the length');
  assertRefuses(() => adoptArtifact({ ...base, attestedSha256: `${f.hash.slice(0, 63)}z` }), /not hexadecimal/, 'non-hex ⇒ refused');
  assertRefuses(() => adoptArtifact({ ...base, attestedSha256: ` ${f.hash} ` }), /not hexadecimal|64/, 'whitespace-padded ⇒ refused, not trimmed');

  // 🔴 The reverse control that matters: nothing was written on ANY refusal.
  // A refusal that still copied the file would defeat every assertion above.
  assertTrue(readdirSync(f.outDir).length === 0, 'REVERSE-CONTROL: after 6 refusals, publish/ is still empty (no bytes ever landed)');
  rmSync(f.root, { recursive: true, force: true });
}

// ── §2 the attestation is actually checked against the bytes ──────────────
section('§2 the attested hash is verified against the bytes (not recomputed and rubber-stamped)');
{
  const f = fixture();
  const wrong = sha256(Buffer.from('some other build entirely'));
  assertRefuses(
    () => adoptArtifact({ sourcePath: f.sourcePath, attestedSha256: wrong, version: '9.9.9', outDir: f.outDir }),
    /NOT the ones the producing machine attested/,
    'a hash that does not match the bytes ⇒ refused',
  );
  assertTrue(readdirSync(f.outDir).length === 0, 'nothing written on the mismatch');

  // POSITIVE CONTROL — without it, every refusal above could be an
  // unconditional throw and this file would still look green.
  const r = adoptArtifact({ sourcePath: f.sourcePath, attestedSha256: f.hash, version: '9.9.9', outDir: f.outDir });
  assertTrue(r.destName === 'FlowMic-9.9.9-portable-macos-arm64.zip', `POSITIVE CONTROL: the correct hash adopts, as ${r.destName}`);
  rmSync(f.root, { recursive: true, force: true });
}

// ── §3 canonical naming, one shape only ───────────────────────────────────
section('§3 canonical naming — inferred when unambiguous, never guessed');
{
  assertTrue(choosePlatform('FlowMic-9.9.9-macos-arm64.zip').platform === 'macos-arm64', 'infers macos-arm64 from the real Mac-mini filename');
  assertTrue(choosePlatform('anything.zip', 'linux-x64').platform === 'linux-x64', '--platform wins when given');
  assertTrue([...PORTABLE_PLATFORMS].sort().join(',') === 'linux-x64,macos-arm64,windows-x64', 'the one platform list holds exactly the three ruled platforms');

  let threw = null;
  try { choosePlatform('FlowMic.app.zip'); } catch (e) { threw = e.message; }
  assertTrue(/no known platform token/.test(threw ?? ''), 'a name with no platform token ⇒ refuses rather than guessing');
  threw = null;
  try { choosePlatform('FlowMic-macos-arm64-vs-windows-x64.zip'); } catch (e) { threw = e.message; }
  assertTrue(/more than one platform/.test(threw ?? ''), 'an ambiguous name ⇒ refuses rather than picking one');
  threw = null;
  try { choosePlatform('x.zip', 'macos-x64'); } catch (e) { threw = e.message; }
  assertTrue(/not a known portable platform/.test(threw ?? ''), 'an unknown --platform ⇒ refused, and names where the list lives');
}

// ── §4 the bytes survive the rename — VERIFIED, not inherited ─────────────
section('§4 byte identity across adoption (the "renaming a notarized zip is safe" claim, measured)');
{
  const f = fixture();
  const r = adoptArtifact({ sourcePath: f.sourcePath, attestedSha256: f.hash, version: '9.9.9', outDir: f.outDir });
  const landed = readFileSync(r.destPath);
  assertTrue(landed.length === f.bytes.length, `size identical (${landed.length} B)`);
  assertTrue(landed.equals(f.bytes), 'adopted bytes are byte-for-byte identical to the source');
  assertTrue(sha256(landed) === f.hash, 'and hash to the attested value');
  assertTrue(readFileSync(r.sidecarPath, 'utf8') === sidecarLine(f.hash, r.destName), 'sidecar is byte-exact `<hash>  <name>\\n`, the format the collector parses');
  rmSync(f.root, { recursive: true, force: true });
}

// ── §5 the version in the new name must not become a lie ──────────────────
section('§5 version cross-check');
{
  const f = fixture('FlowMic-0.0.1-macos-arm64.zip');
  assertRefuses(
    () => adoptArtifact({ sourcePath: f.sourcePath, attestedSha256: f.hash, version: '9.9.9', outDir: f.outDir }),
    /names version 0\.0\.1, but this tree is 9\.9\.9/,
    'a source naming a different version ⇒ refused (the name would lie about its contents)',
  );
  rmSync(f.root, { recursive: true, force: true });

  const g = fixture('FlowMic.app.zip');
  const chk = checkVersionAgreement('FlowMic.app.zip', '9.9.9');
  assertTrue(chk.verified === false && /NOT verified/.test(chk.note), 'a source with no version ⇒ adoption proceeds but reports the version as NOT verified');
  const r = adoptArtifact({ sourcePath: g.sourcePath, attestedSha256: g.hash, version: '9.9.9', outDir: g.outDir, platform: 'macos-arm64' });
  assertTrue(r.versionVerified === false, 'and the result carries that unverified flag for the caller to print');
  rmSync(g.root, { recursive: true, force: true });
}

// ── §6 non-zip and clobber protection ─────────────────────────────────────
section('§6 refusals: non-zip, and never clobbering a different artifact');
{
  const root = mkdtempSync(join(tmpdir(), 'up6-nz-'));
  const outDir = join(root, 'publish');
  mkdirSync(outDir, { recursive: true });
  const notZip = join(root, 'FlowMic-9.9.9-macos-arm64.zip');
  writeFileSync(notZip, Buffer.from('this is not a zip at all'));
  assertRefuses(
    () => adoptArtifact({ sourcePath: notZip, attestedSha256: sha256(readFileSync(notZip)), version: '9.9.9', outDir }),
    /does not begin with the zip magic/,
    'bytes that are not a zip ⇒ refused even though the hash matches',
  );

  // Clobber protection: ./publish is shared between windows.
  const f = fixture();
  const dest = join(f.outDir, 'FlowMic-9.9.9-portable-macos-arm64.zip');
  writeFileSync(dest, fakeZip('somebody else artifact'));
  assertRefuses(
    () => adoptArtifact({ sourcePath: f.sourcePath, attestedSha256: f.hash, version: '9.9.9', outDir: f.outDir }),
    /already exists and holds DIFFERENT bytes/,
    'a destination holding different bytes ⇒ refused, not overwritten',
  );
  assertTrue(readFileSync(dest).equals(fakeZip('somebody else artifact')), 'REVERSE-CONTROL: the other window\'s file is still intact');
  // Idempotent re-adoption of the identical bytes is allowed.
  writeFileSync(dest, f.bytes);
  const again = adoptArtifact({ sourcePath: f.sourcePath, attestedSha256: f.hash, version: '9.9.9', outDir: f.outDir });
  assertTrue(again.destName === 'FlowMic-9.9.9-portable-macos-arm64.zip', 'POSITIVE CONTROL: re-adopting identical bytes succeeds (idempotent)');

  // --dry-run writes nothing.
  const h = fixture();
  const dry = adoptArtifact({ sourcePath: h.sourcePath, attestedSha256: h.hash, version: '9.9.9', outDir: h.outDir, dryRun: true });
  assertTrue(dry.dryRun === true && readdirSync(h.outDir).length === 0, '--dry-run passes every check and writes nothing');

  rmSync(root, { recursive: true, force: true });
  rmSync(f.root, { recursive: true, force: true });
  rmSync(h.root, { recursive: true, force: true });
}

// ── §7 CLI flag hygiene + the adopted artifact reaching the manifest ───────
section('§7 CLI refusals, and the adopted artifact flowing into the manifest');
{
  const run = (args, cwd = ROOT) => spawnSync(process.execPath, [ADOPT, ...args], { cwd, encoding: 'utf8', timeout: 20_000 });

  const noFlag = run(['whatever.zip']);
  assertTrue(noFlag.status !== 0 && /missing --sha256/.test(noFlag.stderr ?? ''), 'CLI: no --sha256 ⇒ non-zero exit naming the requirement');
  const valued = run(['whatever.zip', '--dry-run=1', '--sha256', 'a'.repeat(64)]);
  assertTrue(valued.status !== 0 && /--dry-run=… is not accepted/.test(valued.stderr ?? ''), 'CLI: --dry-run=1 ⇒ rejected by name (IT-07)');
  const bare = run(['whatever.zip', '--sha256']);
  assertTrue(bare.status !== 0 && /--sha256 needs a value/.test(bare.stderr ?? ''), 'CLI: --sha256 with no value ⇒ rejected, never treated as "no attestation"');

  // End to end: adopt into a fixture publish/, then let the REAL manifest
  // generator classify it. This is the join UP-6 exists to make.
  const root = mkdtempSync(join(tmpdir(), 'up6-e2e-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  // verify-remote-artifact.mjs rides along because build-update-manifest.mjs
  // imports it since UP-10 (same note as up1's fixture builder).
  // update-manifest-lib.mjs + module-entrypoint-guard.mjs joined with ruling ①
  // (2026-08-10) — the builder's static imports and this list must move together.
  for (const f of ['build-update-manifest.mjs', 'pack-portable.mjs', 'adopt-artifact.mjs', 'verify-remote-artifact.mjs', 'update-manifest-lib.mjs', 'module-entrypoint-guard.mjs']) {
    writeFileSync(join(root, 'scripts', f), readFileSync(join(ROOT, 'scripts', f)));
  }
  const outDir = join(root, 'publish');
  mkdirSync(outDir, { recursive: true });
  // a locally-built msi so the manifest has a windows platform too
  const msi = Buffer.from('fixture msi');
  writeFileSync(join(outDir, 'FlowMic_9.9.9_x64_zh-CN.msi'), msi);
  writeFileSync(join(outDir, 'FlowMic_9.9.9_x64_zh-CN.msi.sha256'), sidecarLine(sha256(msi), 'FlowMic_9.9.9_x64_zh-CN.msi'));
  // the adopted mac artifact, via the real CLI
  const macBytes = fakeZip('notarized mac payload');
  const macSrc = join(root, 'FlowMic-9.9.9-macos-arm64.zip');
  writeFileSync(macSrc, macBytes);
  // 🔴 Drive the FIXTURE COPY, not the real script. adopt-artifact.mjs derives
  // its root (and therefore the reference version) from its own file location,
  // NOT from cwd — so invoking the repo copy here read the real 0.2.59 and the
  // version guard correctly refused a 9.9.9 artifact. That refusal was right;
  // the test was wrong. Keeping the note because "pass cwd and assume the
  // script follows it" is a mistake that looks like a product bug.
  const adopted = spawnSync(process.execPath, [join(root, 'scripts', 'adopt-artifact.mjs'), macSrc, '--sha256', sha256(macBytes)], { cwd: root, encoding: 'utf8', timeout: 20_000 });
  assertTrue(adopted.status === 0, `CLI adoption succeeds (exit ${adopted.status}) ${adopted.stderr?.slice(0, 200) ?? ''}`);
  assertTrue(existsSync(join(outDir, 'FlowMic-9.9.9-portable-macos-arm64.zip')), 'the adopted file lands under the canonical name');

  // --skip-remote-verify: offline fixture tree; the remote gate has its own
  // drill (up10) — same note as up1's runGen.
  const gen = spawnSync(process.execPath, [join(root, 'scripts', 'build-update-manifest.mjs'), '--check', '--skip-remote-verify'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assertTrue(gen.status === 0, `manifest generator accepts the adopted artifact (exit ${gen.status})`);
  const txt = gen.stdout ?? '';
  const m = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  const mac = m?.platforms?.['macos-arm64']?.artifacts?.[0];
  assertTrue(!!mac, 'the manifest grew a macos-arm64 platform');
  assertTrue(mac?.kind === 'portable-zip', `its kind is "portable-zip" (got ${JSON.stringify(mac?.kind)}) — one kind, platform says how to swap`);
  assertTrue(mac?.sha256 === sha256(macBytes), 'and its sha256 is the attested hash, carried end to end from the producing machine');
  assertTrue(!!m?.platforms?.['windows-x64'], 'the windows platform is unaffected');
  rmSync(root, { recursive: true, force: true });
}

const acct = `sections run ${SECTION_NAMES.length}/${SECTION_NAMES.length}, no sections skipped`;
console.log(`\nACCOUNTING: ${acct}`);
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
