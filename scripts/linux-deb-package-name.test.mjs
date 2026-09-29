// NR-114 drill for scripts/linux-deb-package-name.mjs.
// The pure parts run on every host. On Linux (with dpkg-deb) it also builds a
// small real .deb named `flow-mic`, rewrites it, and reads the result back with
// dpkg-deb: Package changed, every other control field and the payload unchanged.
// Run: node scripts/linux-deb-package-name.test.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEB_PACKAGE_NAME,
  LEGACY_DEB_PACKAGE_NAME,
  debIdentityProblems,
  parseDebControl,
  readDebControlWithDpkg,
  relationPackages,
  renameDebPackage,
  setDebControlPackage,
} from './linux-deb-package-name.mjs';

let passed = 0;
const pass = (label) => { passed += 1; console.log(`PASS ${label}`); };

const TAURI_CONTROL = [
  'Package: flow-mic', 'Version: 1.2.3', 'Architecture: amd64', 'Installed-Size: 12', 'Maintainer: flowmic',
  'Priority: optional', 'Depends: libgtk-3-0, libsoup-3.0-0', 'Provides: flow-mic', 'Conflicts: flow-mic',
  'Replaces: flow-mic', 'Description: Speak on your phone, type on your PC.', ' FlowMic long description.', '',
].join('\n');

assert.equal(DEB_PACKAGE_NAME, 'flowmic');
assert.equal(LEGACY_DEB_PACKAGE_NAME, 'flow-mic');
pass('the package name is flowmic; the legacy name is the Tauri-derived flow-mic');

{
  const fields = parseDebControl(TAURI_CONTROL);
  assert.equal(fields.Package, 'flow-mic');
  assert.equal(fields.Description, 'Speak on your phone, type on your PC.\n FlowMic long description.');
  assert.deepEqual([...relationPackages('a (>= 1), b | c:amd64')], ['a', 'b', 'c']);
  pass('control and relationship parsers');
}

{
  const renamed = setDebControlPackage(TAURI_CONTROL);
  assert.equal(parseDebControl(renamed).Package, 'flowmic');
  assert.equal(renamed.replace('Package: flowmic', 'Package: flow-mic'), TAURI_CONTROL);
  assert.throws(() => setDebControlPackage(TAURI_CONTROL.replace('Package: flow-mic\n', '')), /0 Package: lines/);
  assert.throws(() => setDebControlPackage(`Package: a\n${TAURI_CONTROL}`), /2 Package: lines/);
  pass('setDebControlPackage changes only the Package line and refuses zero or two of them');
}

{
  assert.deepEqual(debIdentityProblems(parseDebControl(setDebControlPackage(TAURI_CONTROL))), []);
  pass('positive control: Package flowmic with Conflicts/Replaces/Provides flow-mic is green');
  const tauriAsIs = debIdentityProblems(parseDebControl(TAURI_CONTROL));
  assert.ok(tauriAsIs.some((p) => /Package is "flow-mic", expected "flowmic"/.test(p)), JSON.stringify(tauriAsIs));
  pass('reverse control: the Tauri output as-is (Package flow-mic) is red');
  for (const field of ['Conflicts', 'Replaces', 'Provides']) {
    const control = setDebControlPackage(TAURI_CONTROL).replace(`${field}: flow-mic\n`, '');
    const problems = debIdentityProblems(parseDebControl(control));
    assert.ok(problems.some((p) => p.startsWith(`.deb ${field} does not name flow-mic`)), JSON.stringify(problems));
  }
  pass('reverse control: dropping any one of Conflicts/Replaces/Provides flow-mic is red');
}

const hasDpkgDeb = process.platform === 'linux' && spawnSync('dpkg-deb', ['--version']).status === 0;
if (hasDpkgDeb) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.local');
  mkdirSync(root, { recursive: true });
  const temp = mkdtempSync(join(root, 'linux-deb-package-name-test-'));
  try {
    const tree = join(temp, 'tree');
    mkdirSync(join(tree, 'DEBIAN'), { recursive: true, mode: 0o755 });
    mkdirSync(join(tree, 'usr', 'bin'), { recursive: true });
    writeFileSync(join(tree, 'DEBIAN', 'control'), TAURI_CONTROL, { mode: 0o644 });
    writeFileSync(join(tree, 'usr', 'bin', 'flowmic-desktop'), 'payload-bytes', { mode: 0o755 });
    const tauriDeb = join(temp, 'FlowMic_1.2.3_amd64.deb');
    execFileSync('dpkg-deb', ['--root-owner-group', '--nocheck', '-b', tree, tauriDeb], { encoding: 'utf8' });
    const outPath = join(temp, 'named', 'FlowMic_1.2.3_amd64.deb');
    mkdirSync(dirname(outPath), { recursive: true });
    renameDebPackage({ debPath: tauriDeb, outPath, scratchRoot: temp });
    const before = parseDebControl(readDebControlWithDpkg(tauriDeb));
    const after = parseDebControl(readDebControlWithDpkg(outPath));
    assert.equal(before.Package, 'flow-mic');
    assert.equal(after.Package, 'flowmic');
    assert.deepEqual({ ...after, Package: 'flow-mic' }, before);
    pass('real dpkg-deb: the rewritten .deb says Package flowmic; every other control field unchanged');
    const contents = (deb) => execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' });
    assert.equal(contents(outPath), contents(tauriDeb));
    const extracted = join(temp, 'x');
    execFileSync('dpkg-deb', ['-x', outPath, extracted]);
    assert.equal(readFileSync(join(extracted, 'usr', 'bin', 'flowmic-desktop'), 'utf8'), 'payload-bytes');
    pass('real dpkg-deb: payload listing (paths, modes, owners) and bytes unchanged');
    assert.throws(() => renameDebPackage({ debPath: tauriDeb, outPath, scratchRoot: temp }), /refusing to overwrite/);
    pass('the rewrite refuses to overwrite an existing file');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  console.log(`(real dpkg-deb round trip not run on ${process.platform}: it needs Linux with dpkg-deb)`);
}

console.log(`PASS linux-deb-package-name.test.mjs (${passed} checks)`);
