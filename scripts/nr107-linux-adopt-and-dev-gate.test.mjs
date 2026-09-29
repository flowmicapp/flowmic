// NR-107 follow-up drill: the Linux .deb travels the cross-machine path
// (adopt-artifact → publish.mjs --keep-adopted → download center / GitHub
// Release), and no `DEV:` placeholder ships in a Linux portable zip.
//
// Fixtures only (a hand-built stored zip, a hand-built ar archive); nothing here
// touches the real ./publish, the network, or a credential. Every refusal is a
// reverse control: the same fixture minus the offending bytes is adopted.
// Run: node scripts/nr107-linux-adopt-and-dev-gate.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

import { AdoptError, adoptArtifact, looksLikeDeb } from './adopt-artifact.mjs';
import {
  assertLinuxZipHasNoDevCopy,
  findDevPlaceholders,
  verifyLinuxZipsHaveNoDevCopy,
} from './linux-dev-copy-gate.mjs';
import { isLinuxDebName, linuxDebName, parseLinuxDebName } from './pack-portable.mjs';
import { classifyEntry } from './publish-adopted-artifact-gate.mjs';

let passed = 0;
const pass = (label) => { passed += 1; console.log(`PASS ${label}`); };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** A classic stored (method 0) zip; enough for listZipEntries/extractZipEntry. */
function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** A minimal Debian-shaped ar archive (magic + `debian-binary` first member). */
function fakeDeb(payload = 'control and data') {
  const header = Buffer.alloc(60, 0x20);
  header.write('debian-binary', 0, 'latin1');
  header.write('4', 48, 'latin1');
  header.write('`\n', 58, 'latin1');
  return Buffer.concat([Buffer.from('!<arch>\n', 'latin1'), header, Buffer.from('2.0\n'), Buffer.from(payload)]);
}

const launcherFinal = Buffer.from('\x7fELF\0FlowMic cannot start\0sudo apt install libwebkit2gtk-4.1-0\0');
const launcherDev = Buffer.from('\x7fELF\0DEV: FlowMic cannot start\0sudo apt install libwebkit2gtk-4.1-0\0');
const linuxZip = ({ launcher = launcherFinal, readme = 'FlowMic for Linux (portable)\n', dropReadme = false } = {}) =>
  storedZip([
    ['FlowMic-linux-x64/flowmic-desktop', launcher],
    ['FlowMic-linux-x64/.flowmic-desktop-bin', 'real binary'],
    ...(dropReadme ? [] : [['FlowMic-linux-x64/README-LINUX.txt', readme]]),
  ]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.local');
mkdirSync(root, { recursive: true });
const temp = mkdtempSync(join(root, 'nr107-adopt-'));
const refuses = (fn, pattern, label) => {
  let message = null;
  let adoptError = false;
  try { fn(); } catch (e) { message = e.message; adoptError = e instanceof AdoptError; }
  assert.ok(message !== null, `${label}: did NOT refuse`);
  assert.ok(pattern.test(message), `${label}: message ${JSON.stringify(message.split('\n')[0])} does not match ${pattern}`);
  return adoptError;
};

try {
  // ── names ────────────────────────────────────────────────────────────────
  assert.equal(linuxDebName('1.2.3'), 'FlowMic_1.2.3_amd64.deb');
  assert.deepEqual(parseLinuxDebName('FlowMic_1.2.3_amd64.deb'), { version: '1.2.3', platform: 'linux-x64' });
  for (const bad of ['flow-mic_1.2.3_amd64.deb', 'FlowMic_1.2.3_arm64.deb', 'FlowMic_1.2.3_amd64.deb.sha256', 'x.deb']) {
    assert.equal(isLinuxDebName(bad), false, bad);
  }
  pass('the .deb name has one narrow spelling');

  // ── DEV: scan ────────────────────────────────────────────────────────────
  assert.deepEqual(findDevPlaceholders(launcherDev), ['DEV: FlowMic cannot start']);
  assert.deepEqual(findDevPlaceholders(launcherFinal), []);
  pass('findDevPlaceholders reports the C string around the marker, and nothing on final copy');

  assert.deepEqual(assertLinuxZipHasNoDevCopy(linuxZip(), 'final.zip'),
    ['FlowMic-linux-x64/flowmic-desktop', 'FlowMic-linux-x64/README-LINUX.txt']);
  pass('positive control: a Linux zip with final copy passes, and both user-text files were read');
  refuses(() => assertLinuxZipHasNoDevCopy(linuxZip({ launcher: launcherDev }), 'dev.zip'),
    /flowmic-desktop: DEV: FlowMic cannot start/, 'launcher DEV');
  pass('reverse control: a DEV: string in the launcher is refused, naming file and sentence');
  refuses(() => assertLinuxZipHasNoDevCopy(linuxZip({ readme: 'DEV: FlowMic for Linux (portable)\n' }), 'dev.zip'),
    /README-LINUX\.txt: DEV: FlowMic for Linux/, 'README DEV');
  pass('reverse control: a DEV: sentence in README-LINUX.txt is refused');
  refuses(() => assertLinuxZipHasNoDevCopy(linuxZip({ dropReadme: true }), 'old.zip'),
    /no top-level README-LINUX\.txt/, 'pre-NR-107 zip');
  pass('reverse control: a Linux zip without the NR-107 launcher/README is refused');

  // ── publish.mjs / GitHub Release directory check ─────────────────────────
  const dir = join(temp, 'publish-dir');
  mkdirSync(dir);
  writeFileSync(join(dir, 'FlowMic-1.2.3-portable-linux-x64.zip'), linuxZip());
  writeFileSync(join(dir, 'FlowMic-1.2.3-portable-windows-x64.zip'), storedZip([['FlowMic-portable/README.txt', 'DEV: not linux']]));
  assert.deepEqual(verifyLinuxZipsHaveNoDevCopy(dir, ['FlowMic-1.2.3-portable-linux-x64.zip', 'FlowMic-1.2.3-portable-windows-x64.zip', 'FlowMic_1.2.3_amd64.deb']),
    ['FlowMic-1.2.3-portable-linux-x64.zip']);
  pass('the directory check reads only linux-x64 portable zips');
  writeFileSync(join(dir, 'FlowMic-1.2.3-portable-linux-x64.zip'), linuxZip({ launcher: launcherDev }));
  refuses(() => verifyLinuxZipsHaveNoDevCopy(dir, ['FlowMic-1.2.3-portable-linux-x64.zip']), /DEV: FlowMic cannot start/, 'dir DEV');
  pass('reverse control: the directory check refuses a DEV: Linux zip');

  // ── adopt: the .deb ──────────────────────────────────────────────────────
  const out = join(temp, 'publish');
  mkdirSync(out);
  const debBytes = fakeDeb();
  assert.ok(looksLikeDeb(debBytes));
  const debSource = join(temp, 'FlowMic_1.2.3_amd64.deb');
  writeFileSync(debSource, debBytes);
  const adopted = adoptArtifact({ sourcePath: debSource, attestedSha256: sha256(debBytes), version: '1.2.3', outDir: out });
  assert.equal(adopted.destName, 'FlowMic_1.2.3_amd64.deb');
  assert.equal(adopted.platform, 'linux-x64');
  assert.equal(readFileSync(join(out, 'FlowMic_1.2.3_amd64.deb.sha256'), 'utf8'), `${sha256(debBytes)}  FlowMic_1.2.3_amd64.deb\n`);
  pass('adopt: the .deb lands under Tauri\'s name with an attested sidecar');
  assert.ok(refuses(() => adoptArtifact({ sourcePath: debSource, attestedSha256: '0'.repeat(64), version: '1.2.3', outDir: join(temp, 'o1') }),
    /NOT the ones the producing machine attested/, 'deb wrong hash'));
  pass('reverse control: a .deb whose hash disagrees with the attested one is refused');
  assert.ok(refuses(() => adoptArtifact({ sourcePath: debSource, attestedSha256: undefined, version: '1.2.3', outDir: join(temp, 'o1') }),
    /missing --sha256/, 'deb no hash'));
  pass('reverse control: a .deb without --sha256 is refused');
  assert.ok(refuses(() => adoptArtifact({ sourcePath: debSource, attestedSha256: sha256(debBytes), version: '1.2.4', outDir: join(temp, 'o1') }),
    /names version 1\.2\.3, but this tree is 1\.2\.4/, 'deb version'));
  pass('reverse control: a .deb from another version is refused');
  assert.ok(refuses(() => adoptArtifact({ sourcePath: debSource, attestedSha256: sha256(debBytes), version: '1.2.3', outDir: join(temp, 'o1'), platform: 'macos-arm64' }),
    /can only be linux-x64/, 'deb platform'));
  pass('reverse control: a .deb claimed for another platform is refused');
  const notDeb = join(temp, 'FlowMic_1.2.3_amd64.deb.fake');
  mkdirSync(notDeb);
  const notDebFile = join(notDeb, 'FlowMic_1.2.3_amd64.deb');
  const zipBytes = linuxZip();
  writeFileSync(notDebFile, zipBytes);
  assert.ok(refuses(() => adoptArtifact({ sourcePath: notDebFile, attestedSha256: sha256(zipBytes), version: '1.2.3', outDir: join(temp, 'o1') }),
    /is not a Debian package/, 'deb magic'));
  pass('reverse control: a zip renamed to .deb is refused by the ar/debian-binary check');
  const changed = fakeDeb('different build');
  const changedSource = join(temp, 'changed', 'FlowMic_1.2.3_amd64.deb');
  mkdirSync(dirname(changedSource));
  writeFileSync(changedSource, changed);
  assert.ok(refuses(() => adoptArtifact({ sourcePath: changedSource, attestedSha256: sha256(changed), version: '1.2.3', outDir: out }),
    /already exists and holds DIFFERENT bytes/, 'deb clobber'));
  pass('reverse control: adopting different .deb bytes over an adopted one is refused');

  // ── adopt: the Linux zip and the DEV: rule ───────────────────────────────
  const zipSource = join(temp, 'FlowMic-1.2.3-portable-linux-x64.zip');
  const devZip = linuxZip({ readme: 'DEV: FlowMic for Linux (portable)\n' });
  writeFileSync(zipSource, devZip);
  assert.ok(refuses(() => adoptArtifact({ sourcePath: zipSource, attestedSha256: sha256(devZip), version: '1.2.3', outDir: join(temp, 'o2') }),
    /DEV:` placeholder/, 'adopt DEV zip'));
  assert.ok(!existsSync(join(temp, 'o2', 'FlowMic-1.2.3-portable-linux-x64.zip')));
  pass('reverse control: adopt refuses a Linux zip that still carries DEV: copy, and writes nothing');
  const goodZip = linuxZip();
  writeFileSync(zipSource, goodZip);
  mkdirSync(join(temp, 'o2'), { recursive: true });
  assert.equal(adoptArtifact({ sourcePath: zipSource, attestedSha256: sha256(goodZip), version: '1.2.3', outDir: join(temp, 'o2') }).destName,
    'FlowMic-1.2.3-portable-linux-x64.zip');
  pass('restored: the same Linux zip with final copy is adopted');

  // ── the clean step keeps an adopted .deb ─────────────────────────────────
  assert.deepEqual(classifyEntry('FlowMic_1.2.3_amd64.deb', { version: '1.2.3' }),
    { name: 'FlowMic_1.2.3_amd64.deb', platforms: ['linux-x64'], version: '1.2.3', atRisk: true });
  assert.equal(classifyEntry('FlowMic_1.2.2_amd64.deb', { version: '1.2.3' }).atRisk, false);
  assert.equal(classifyEntry('FlowMic_1.2.3_amd64.deb', { version: '1.2.3', roundPlatform: 'linux-x64' }), null);
  assert.equal(classifyEntry('FlowMic_1.2.3_amd64.deb.sha256', { version: '1.2.3' }), null);
  pass('publish.mjs sees an adopted current-version .deb as cross-machine (kept with --keep-adopted), an old one as stale');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`PASS nr107-linux-adopt-and-dev-gate.test.mjs (${passed} checks)`);
