// NR-107 drill for the Linux runtime dependency gate.
// Synthetic ELF64 files (built below, byte by byte) stand in for the real
// payload so the drill runs on every host; the real payload is exercised by the
// Linux release build itself. Every reverse control removes ONE entry from one
// list and must turn the gate red naming that entry; restoring it must turn the
// gate green again.
// Run: node scripts/linux-runtime-deps-gate.test.mjs

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readElf64Section, readElfNeeded } from './elf64.mjs';
import {
  binaryHasCString,
  evaluateLinuxRuntimeDeps,
  extractInstallPackages,
  parseDebDepends,
  runLinuxRuntimeDepsGate,
} from './linux-runtime-deps-gate.mjs';
import { NEEDS_INSTALL, STOCK_UBUNTU_2204_DESKTOP } from './linux-runtime-libs.mjs';
import { parseDebControl } from './linux-deb-package-name.mjs';

let passed = 0;
const pass = (label) => { passed += 1; console.log(`PASS ${label}`); };

/** A minimal ELF64 LE file: sections null, .dynstr, .dynamic (-> .dynstr), .shstrtab,
 *  followed by `extra` bytes (stand-in for .rodata string literals). */
function syntheticElf(needed, extra = '') {
  const dynstrParts = ['\0'];
  const offsets = [];
  let cursor = 1;
  for (const name of needed) {
    offsets.push(cursor);
    dynstrParts.push(`${name}\0`);
    cursor += Buffer.byteLength(name) + 1;
  }
  const dynstr = Buffer.from(dynstrParts.join(''), 'latin1');
  const dynamic = Buffer.alloc((needed.length + 1) * 16);
  offsets.forEach((offset, i) => {
    dynamic.writeBigInt64LE(1n, i * 16); // DT_NEEDED
    dynamic.writeBigUInt64LE(BigInt(offset), i * 16 + 8);
  });
  const shstrtab = Buffer.from('\0.dynstr\0.dynamic\0.shstrtab\0', 'latin1');
  const extraBytes = Buffer.from(extra, 'latin1');
  const dynstrAt = 64;
  const dynamicAt = dynstrAt + dynstr.length;
  const shstrAt = dynamicAt + dynamic.length;
  const extraAt = shstrAt + shstrtab.length;
  const shoff = extraAt + extraBytes.length;
  const header = Buffer.alloc(64);
  header.write('\x7fELF', 0, 'latin1');
  header[4] = 2; // ELFCLASS64
  header[5] = 1; // little endian
  header[6] = 1;
  header.writeBigUInt64LE(BigInt(shoff), 0x28);
  header.writeUInt16LE(64, 0x34);
  header.writeUInt16LE(64, 0x3a);
  header.writeUInt16LE(4, 0x3c);
  header.writeUInt16LE(3, 0x3e);
  const section = (nameOffset, type, offset, size, link = 0) => {
    const s = Buffer.alloc(64);
    s.writeUInt32LE(nameOffset, 0);
    s.writeUInt32LE(type, 4);
    s.writeBigUInt64LE(BigInt(offset), 24);
    s.writeBigUInt64LE(BigInt(size), 32);
    s.writeUInt32LE(link, 40);
    return s;
  };
  return Buffer.concat([
    header, dynstr, dynamic, shstrtab, extraBytes,
    section(0, 0, 0, 0),
    section(1, 3, dynstrAt, dynstr.length),
    section(9, 6, dynamicAt, dynamic.length, 1),
    section(18, 3, shstrAt, shstrtab.length),
  ]);
}

// The 0.3.95 Linux binary's real DT_NEEDED list [measured 2026-09-25, readelf -d].
const APP_NEEDED = [
  'libgdk-3.so.0', 'libgdk_pixbuf-2.0.so.0', 'libcairo.so.2', 'libgobject-2.0.so.0', 'libglib-2.0.so.0',
  'libdbus-1.so.3', 'libwebkit2gtk-4.1.so.0', 'libgtk-3.so.0', 'libsoup-3.0.so.0', 'libgio-2.0.so.0',
  'libjavascriptcoregtk-4.1.so.0', 'libssl.so.3', 'libcrypto.so.3', 'libgcc_s.so.1', 'libm.so.6', 'libc.so.6',
  'ld-linux-x86-64.so.2',
];
const INSTALL = 'sudo apt install libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libsoup-3.0-0 libayatana-appindicator3-1';
const LAUNCHER_STRINGS = [
  'libwebkit2gtk-4.1.so.0', 'libjavascriptcoregtk-4.1.so.0', 'libsoup-3.0.so.0', 'libayatana-appindicator3.so.1',
  INSTALL, '.flowmic-desktop-bin',
];
const launcherBytesWith = (strings) => syntheticElf(['libc.so.6'], `\0${strings.join('\0')}\0`);
const DEPENDS = 'libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1, libjavascriptcoregtk-4.1-0, libsoup-3.0-0';
// NR-114: the control paragraph of the .deb that ships (after the Package rewrite).
const CONTROL = [
  'Package: flowmic', 'Version: 1.2.3', 'Architecture: amd64', 'Maintainer: flowmic', 'Priority: optional',
  `Depends: ${DEPENDS}`, 'Provides: flow-mic', 'Conflicts: flow-mic', 'Replaces: flow-mic',
  'Description: fixture', ' continuation line', '',
].join('\n');
const README = `DEV: install once:\n\n    ${INSTALL}\n\n    sudo apt install ./FlowMic_1.2.3_amd64.deb\n`;

function baseline(overrides = {}) {
  return {
    elfFiles: [
      { label: 'flowmic-desktop', needed: APP_NEEDED, bundled: new Set() },
      { label: 'addon.node', needed: ['libonnxruntime.so', 'libstdc++.so.6'], bundled: new Set(['libonnxruntime.so']) },
    ],
    debDepends: parseDebDepends(DEPENDS),
    debFields: parseDebControl(CONTROL),
    launcherBytes: launcherBytesWith(LAUNCHER_STRINGS),
    launcherNeeded: ['libc.so.6'],
    launcherTarget: '.flowmic-desktop-bin',
    readmeText: README,
    ...overrides,
  };
}
const red = (overrides, pattern, label) => {
  const { problems } = evaluateLinuxRuntimeDeps(baseline(overrides));
  assert.ok(problems.some((p) => pattern.test(p)), `${label}: expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);
  pass(`reverse control: ${label}`);
};

// ── ELF reading ─────────────────────────────────────────────────────────────
const fixture = syntheticElf(['libfoo.so.1', 'libc.so.6'], 'rodata');
assert.deepEqual(readElfNeeded(fixture, 'fixture'), ['libfoo.so.1', 'libc.so.6']);
assert.deepEqual(readElfNeeded(syntheticElf([]), 'static'), []);
assert.throws(() => readElfNeeded(Buffer.from('#!/bin/sh\n'), 'script'), /not a little-endian ELF64/);
pass('readElfNeeded reads DT_NEEDED in file order; empty for none; refuses a non-ELF');

// ── parsers ─────────────────────────────────────────────────────────────────
assert.deepEqual(
  [...parseDebDepends('libc6 (>= 2.34), libwebkit2gtk-4.1-0 | libfoo:amd64, libsoup-3.0-0 (>= 3.0)')],
  ['libc6', 'libwebkit2gtk-4.1-0', 'libfoo', 'libsoup-3.0-0'],
);
assert.deepEqual([...extractInstallPackages(README)].sort(),
  ['libayatana-appindicator3-1', 'libjavascriptcoregtk-4.1-0', 'libsoup-3.0-0', 'libwebkit2gtk-4.1-0']);
assert.equal(binaryHasCString(Buffer.from('\0xlibsoup-3.0.so.0\0'), 'libsoup-3.0.so.0'), false);
assert.equal(binaryHasCString(Buffer.from('\0libsoup-3.0.so.0\0'), 'libsoup-3.0.so.0'), true);
pass('Depends, install-line and C-string parsers');

// ── the registry itself ─────────────────────────────────────────────────────
for (const soname of NEEDS_INSTALL.keys()) assert.ok(!STOCK_UBUNTU_2204_DESKTOP.has(soname), `${soname} in both lists`);
pass('no soname is both stock and needs-install');

// ── green baseline (positive control) ───────────────────────────────────────
{
  const { problems, nonStock } = evaluateLinuxRuntimeDeps(baseline());
  assert.deepEqual(problems, []);
  assert.deepEqual([...nonStock.keys()].sort(),
    ['libjavascriptcoregtk-4.1.so.0', 'libsoup-3.0.so.0', 'libwebkit2gtk-4.1.so.0']);
  pass('positive control: the 0.3.95 NEEDED list is green with complete lists, and names exactly three non-stock libraries');
}

// ── reverse controls: drop ONE entry, see red naming it ─────────────────────
red({ debDepends: parseDebDepends(DEPENDS.replace(', libsoup-3.0-0', '')) },
  /\.deb Depends is missing libsoup-3\.0-0/, 'libsoup-3.0-0 dropped from the .deb Depends');
red({ launcherBytes: launcherBytesWith(LAUNCHER_STRINGS.filter((s) => s !== 'libwebkit2gtk-4.1.so.0')) },
  /launcher does not check libwebkit2gtk-4\.1\.so\.0/, 'libwebkit2gtk-4.1.so.0 dropped from the launcher check list');
red({ launcherBytes: launcherBytesWith(LAUNCHER_STRINGS.map((s) => (s === INSTALL ? INSTALL.replace(' libjavascriptcoregtk-4.1-0', '') : s))) },
  /launcher's install line does not name libjavascriptcoregtk-4\.1-0/, 'libjavascriptcoregtk-4.1-0 dropped from the launcher install line');
red({ readmeText: README.replace(' libsoup-3.0-0', '') },
  /README-LINUX\.txt's install line does not name libsoup-3\.0-0/, 'libsoup-3.0-0 dropped from README-LINUX.txt');
red({ elfFiles: [{ label: 'flowmic-desktop', needed: [...APP_NEEDED, 'libnew-thing.so.7'], bundled: new Set() }] },
  /needs libnew-thing\.so\.7, which is neither stock/, 'a new unclassified NEEDED soname');
red({ launcherNeeded: ['libc.so.6', 'libgtk-3.so.0'] },
  /launcher links libgtk-3\.so\.0/, 'a launcher that links anything beyond libc');
red({ launcherBytes: launcherBytesWith(LAUNCHER_STRINGS.filter((s) => s !== '.flowmic-desktop-bin')) },
  /does not name the real binary/, 'a launcher that does not name the real binary');
// NR-114: the package identity of the .deb.
red({ debFields: parseDebControl(CONTROL.replace('Package: flowmic', 'Package: flow-mic')) },
  /\.deb Package is "flow-mic", expected "flowmic"/, 'the .deb carries the Tauri-derived package name flow-mic');
for (const field of ['Conflicts', 'Replaces', 'Provides']) {
  red({ debFields: parseDebControl(CONTROL.replace(`${field}: flow-mic\n`, '')) },
    new RegExp(`\\.deb ${field} does not name flow-mic`), `${field}: flow-mic dropped from the .deb control`);
}
red({ debFields: undefined }, /\.deb control was not read/, 'no .deb control read at all (fail closed)');
{
  // The stock list is load-bearing too: without libgtk-3 in it, gtk is unclassified.
  const stock = new Map(STOCK_UBUNTU_2204_DESKTOP);
  stock.delete('libgtk-3.so.0');
  const { problems } = evaluateLinuxRuntimeDeps({ ...baseline(), stock });
  assert.ok(problems.some((p) => /needs libgtk-3\.so\.0/.test(p)), JSON.stringify(problems));
  pass('reverse control: libgtk-3.so.0 dropped from the stock list');
}

// ── end to end through the file-reading wrapper ─────────────────────────────
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.local');
mkdirSync(root, { recursive: true });
const temp = mkdtempSync(join(root, 'linux-runtime-deps-gate-'));
try {
  const put = (rel, bytes) => { const p = join(temp, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, bytes); return p; };
  const files = {
    executable: put('release/flowmic-desktop', syntheticElf(APP_NEEDED)),
    node: put('resources/node', syntheticElf(['libstdc++.so.6', 'libc.so.6'])),
    debPath: put('bundle/FlowMic_1.2.3_amd64.deb', 'not read: readDebControl is injected'),
    launcherPath: put('launcher/flowmic-desktop', launcherBytesWith(LAUNCHER_STRINGS)),
    readmePath: put('launcher/README-LINUX.txt', README),
  };
  const resourcesDir = join(temp, 'resources', 'node_modules');
  put('resources/node_modules/addon/sherpa.node', syntheticElf(['libonnxruntime.so', 'libstdc++.so.6']));
  put('resources/node_modules/addon/libonnxruntime.so', syntheticElf(['libdl.so.2']));
  const run = (depends, control = CONTROL) => runLinuxRuntimeDepsGate({
    ...files, resourcesDir, launcherTarget: '.flowmic-desktop-bin',
    readDebControl: () => control.replace(`Depends: ${DEPENDS}`, `Depends: ${depends}`),
  });
  const verdict = run(DEPENDS);
  assert.equal(verdict.nonStock.size, 3);
  pass('end to end: green on complete lists (bundled sibling library is not flagged)');
  assert.throws(() => run(DEPENDS.replace('libwebkit2gtk-4.1-0, ', '')), /gate RED[\s\S]*Depends is missing libwebkit2gtk-4\.1-0/);
  pass('end to end reverse control: libwebkit2gtk-4.1-0 dropped from Depends -> red');
  assert.equal(run(DEPENDS).nonStock.size, 3);
  pass('end to end: restored -> green again');
  assert.throws(() => run(DEPENDS, CONTROL.replace('Package: flowmic', 'Package: flow-mic')),
    /gate RED[\s\S]*\.deb Package is "flow-mic", expected "flowmic"/);
  pass('end to end reverse control (NR-114): Package: flow-mic -> red');
  assert.equal(run(DEPENDS, CONTROL).nonStock.size, 3);
  pass('end to end (NR-114): Package: flowmic restored -> green again');
  put('resources/node_modules/addon/extra.so', syntheticElf(['libvulkan.so.1']));
  assert.throws(() => run(DEPENDS), /extra\.so needs libvulkan\.so\.1/);
  pass('end to end reverse control: a native addon with a new unclassified dependency -> red');
  assert.ok(readElf64Section(files.executable, '.dynamic').length > 0);
  pass('readElf64Section still reads a named section');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`PASS linux-runtime-deps-gate.test.mjs (${passed} checks)`);
