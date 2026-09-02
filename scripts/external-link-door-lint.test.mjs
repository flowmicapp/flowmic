#!/usr/bin/env node
// Drill for verify/lint/external-link-door.mjs — the gate that keeps a dead
// `target="_blank"`/`window.open()` (both open NOTHING in the desktop
// WebView2 shell — see the lint's own header for the measured crate behaviour)
// from shipping again. Until this file existed it had no fixture test, even
// though it is the gate written specifically because every existing test that
// touched this surface was itself wrong in the SAME direction (asserting the
// dead string was present).
//
// `externalLinkDoor(face = FACE)` gained an explicit `face` parameter on
// 2026-09-02 (B2-A) so this drill can point it at a disposable fixture
// directory instead of the real apps/desktop/src. Because the gate's own
// ALLOW list names two fixed relative filenames (each of which legitimately
// needs to WRITE the forbidden string, to explain or assert it), a fixture
// exercising the allowlist-staleness check has to either include or omit
// those exact two names on purpose — both are drilled below.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import externalLinkDoor from '../verify/lint/external-link-door.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

function put(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** A fixture whose ALLOW-named files exist (so the staleness check itself
 *  passes) and which mentions openExternalUrl (so the blind-scan control
 *  passes), letting each section below add exactly the case it drills. */
function baseFixture() {
  const T = mkdtempSync(join(tmpdir(), 'fmeld-fixture-'));
  put(T, 'lib/bridge-os.ts', "// the door itself: openExternalUrl(url) replaces target=_blank/window.open\nexport function openExternalUrl(url: string) {}\n");
  put(T, 'main-window/data-flow-disclosure.test.ts', "// asserts these strings are ABSENT: target=\"_blank\" / window.open(\n");
  return T;
}

console.log('=== §1 negative control: a clean fixture (no dead links) PASSes ===');
{
  const T = baseFixture();
  put(T, 'main-window/PrivacyPage.vue', '<template><a @click="openExternalUrl(url)">privacy</a></template>\n');
  const res = await externalLinkDoor(T);
  check(res.status === 'PASS', 'a clean fixture using openExternalUrl passes', JSON.stringify(res));
  check(res.detail.includes('0 target'), 'the PASS detail states zero dead-link patterns', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §2 REVERSE CONTROL: a fixture with target="_blank" FAILs (positive control) ===');
{
  const T = baseFixture();
  put(T, 'main-window/UpdateCard.vue', '<template><a target="_blank" href="https://example.test">download</a></template>\n');
  const res = await externalLinkDoor(T);
  check(res.status === 'FAIL', 'a live target="_blank" fails', JSON.stringify(res));
  check(res.detail.includes('UpdateCard.vue') && res.detail.includes('target="_blank"'), 'the FAIL detail names the file and the pattern', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §3 REVERSE CONTROL: a fixture with window.open( FAILs the same way ===');
{
  const T = baseFixture();
  put(T, 'main-window/PairingModal.vue', "<script>function getApp() { window.open('https://example.test'); }</script>\n");
  const res = await externalLinkDoor(T);
  check(res.status === 'FAIL', 'a live window.open( call fails', JSON.stringify(res));
  check(res.detail.includes('window.open('), 'the FAIL detail names the pattern', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §4 "blind scan" control: a fixture with NO openExternalUrl caller anywhere FAILs as blind, not clean ===');
{
  // Before this control existed, a scan that saw the door zero times would
  // read exactly like "no dead links" while actually scanning the wrong tree.
  // The two ALLOW-named files are present (so the staleness check upstream of
  // this one does not fire first) but neither mentions openExternalUrl and
  // neither carries a dead-link pattern, isolating the blind-scan case.
  const T = mkdtempSync(join(tmpdir(), 'fmeld-blind-'));
  put(T, 'lib/bridge-os.ts', '// the door — but this fixture forgot to mention its own name\n');
  put(T, 'main-window/data-flow-disclosure.test.ts', '// asserts nothing in this fixture\n');
  put(T, 'main-window/SomePage.vue', '<template><div>nothing here</div></template>\n');
  const res = await externalLinkDoor(T);
  check(res.status === 'FAIL', 'a fixture that never mentions openExternalUrl fails as a blind scan', JSON.stringify(res));
  check(res.detail.includes('blind'), 'the FAIL detail names the blind-scan reason', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §5 allowlist-staleness control: a fixture MISSING an ALLOW-named file FAILs ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmeld-stale-'));
  // Only the door file, not the disclosure test — the allowlist names both.
  put(T, 'lib/bridge-os.ts', 'export function openExternalUrl(url: string) {}\n');
  const res = await externalLinkDoor(T);
  check(res.status === 'FAIL', 'a fixture missing an allowlisted file fails on staleness, not on scan content', JSON.stringify(res));
  check(res.detail.includes('do not exist'), 'the FAIL detail explains the allowlist is stale for this fixture', res.detail);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §6 negative control: the ALLOW-named files themselves may carry the forbidden strings ===');
{
  const T = baseFixture(); // the disclosure test file literally writes target="_blank" in a comment
  const res = await externalLinkDoor(T);
  check(res.status === 'PASS', 'the allowlisted files carrying the pattern do not fail the gate', JSON.stringify(res));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §7 the lint itself runs on the real desktop webview tree and answers ===');
{
  const res = await externalLinkDoor();
  check(res.status === 'PASS', 'the real desktop tree has no dead external links', JSON.stringify(res));
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
}

console.log(`\n${failures === 0 ? '✔' : '✘'} external-link-door drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
