#!/usr/bin/env node
// Drill for verify/lint/no-device-uninstall.mjs — the gate born from the
// 2026-10-03 incident where a runbook's flutter-install step uninstalled FlowMic
// (and its data) from the owner's iPad.
//
// The forbidden commands are assembled by concatenation below so that this
// file, which sits inside the scanned scripts/ tree, does not trip the gate
// it tests.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import noDeviceUninstall, { MARKER } from '../verify/lint/no-device-uninstall.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

const FORBIDDEN = {
  flutterInstall: ['flutter', 'install', '-d', 'ipad'].join(' '),
  adbUninstall: ['adb', 'uninstall', 'app.flowmic'].join(' '), // lint-allow: device-uninstall (tokens, joined at runtime)
  pmClear: ['adb shell', 'pm', 'clear', 'app.flowmic'].join(' '),
  pmUninstall: ['pm', 'uninstall', 'app.flowmic'].join(' '),
  uninstallFirst: ['--uninstall', '-first'].join(''),
  devicectl: ['xcrun devicectl device', 'uninstall', 'app'].join(' '),
};

function put(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** A clean fixture with the runbook present (so the blind-scan control passes). */
function baseFixture() {
  const T = mkdtempSync(join(tmpdir(), 'fmndu-fixture-'));
  put(T, 'docs/RELEASE-IRONRULES.md', '# runbook\nadb install -r app.apk\nxcrun devicectl device install app --device X build/Runner.app\n');
  put(T, 'scripts/deploy.sh', '#!/bin/sh\nadb install -r app.apk\n');
  return T;
}

console.log('=== §1 negative control: a fixture using only in-place installs PASSes ===');
{
  const T = baseFixture();
  const res = await noDeviceUninstall(T);
  check(res.status === 'PASS', 'in-place installs pass', JSON.stringify(res));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §2 REVERSE CONTROL: each forbidden command FAILs, in a script and in the runbook ===');
for (const [key, cmd] of Object.entries(FORBIDDEN)) {
  const T = baseFixture();
  put(T, 'scripts/install-ipad.sh', `#!/bin/sh\n${cmd}\n`);
  const res = await noDeviceUninstall(T);
  check(res.status === 'FAIL' && res.detail.includes('scripts/install-ipad.sh:2'), `${key} in a script fails and is located`, res.detail.split('\n')[0]);
  rmSync(T, { recursive: true, force: true });
}
{
  const T = baseFixture();
  put(T, 'docs/RELEASE-IRONRULES.md', `# runbook\n\`\`\`\n${FORBIDDEN.flutterInstall}\n\`\`\`\n`);
  const res = await noDeviceUninstall(T);
  check(res.status === 'FAIL' && res.detail.includes('docs/RELEASE-IRONRULES.md:3'), 'the runbook block is scanned', res.detail.split('\n')[0]);
  rmSync(T, { recursive: true, force: true });
}
{
  const T = baseFixture();
  put(T, 'package.json', `{"scripts":{"dev:ipad":"${FORBIDDEN.flutterInstall}"}}\n`);
  put(T, 'apps/mobile/Makefile', `ipad:\n\t${FORBIDDEN.devicectl}\n`);
  const res = await noDeviceUninstall(T);
  check(res.status === 'FAIL' && res.detail.includes('package.json:1') && res.detail.includes('apps/mobile/Makefile:2'), 'package.json scripts and Makefiles are scanned', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §3 the marker exempts only its own line ===');
{
  const T = baseFixture();
  put(T, 'docs/RELEASE-IRONRULES.md', `# runbook\nNever run ${FORBIDDEN.flutterInstall} <!-- ${MARKER} -->\n`);
  const res = await noDeviceUninstall(T);
  check(res.status === 'PASS', 'a marked line that only mentions the ban passes', JSON.stringify(res));
  put(T, 'docs/RELEASE-IRONRULES.md', `# runbook\nNever run ${FORBIDDEN.flutterInstall} <!-- ${MARKER} -->\n${FORBIDDEN.flutterInstall}\n`);
  const res2 = await noDeviceUninstall(T);
  check(res2.status === 'FAIL' && res2.detail.includes(':3'), 'an unmarked line right after a marked one still fails', res2.detail.split('\n')[0]);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §4 out of scope: history under docs/ may quote the command ===');
{
  const T = baseFixture();
  put(T, 'docs/strategy/2026-09-18-handoff.md', `We used ${FORBIDDEN.flutterInstall} once.\n`);
  const res = await noDeviceUninstall(T);
  check(res.status === 'PASS', 'docs/strategy is not scanned', JSON.stringify(res));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §5 blind-scan control: no runbook in the tree FAILs as blind ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmndu-blind-'));
  put(T, 'scripts/deploy.sh', 'adb install -r app.apk\n');
  const res = await noDeviceUninstall(T);
  check(res.status === 'FAIL' && res.detail.includes('blind'), 'a tree without the runbook fails as blind', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §6 the lint runs on the real tree and answers PASS ===');
{
  const res = await noDeviceUninstall();
  check(res.status === 'PASS', 'the real tree has no device-uninstall commands', res.detail);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ok');
