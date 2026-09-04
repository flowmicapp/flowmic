#!/usr/bin/env node
// Drill for verify/lint/settings-key-drift.mjs — the anti-façade guard that
// requires every settings key the UI writes to be read somewhere on the
// server, and vice versa. Until this file existed it had no fixture test.
//
// `collect(rootsAbs, re)` and `mentions(rootsAbs, needle)` were refactored on
// 2026-09-02 (B2-A) to take ABSOLUTE roots directly instead of joining them
// against ROOT internally — the join moved up to `run()`'s call site, so a
// drill can hand them a disposable fixture tree. Behaviour identical for the
// real callers.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collect, mentions, SET_RE, GET_RE } from '../verify/lint/settings-key-drift.mjs';
import settingsKeyDrift from '../verify/lint/settings-key-drift.mjs';

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

// 2026-09-03 (WP-B2): these two patterns used to be HAND COPIES of the lint's,
// so this drill could pass green against a regex the lint no longer used - the
// same two-answers-to-one-question shape the repo keeps paying for. They are
// imported now, which also means every case below exercises the PRODUCTION
// pattern rather than a lookalike.

console.log('=== §1 collect: a setSetting call in a fixture file is found (positive control) ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-ui-'));
  put(T, 'settings_page.ts', "setSetting('audio.gain', 0.8);\n");
  const { keys, fileCount } = await collect([T], SET_RE);
  check(keys.has('audio.gain'), 'the key is collected', JSON.stringify([...keys.keys()]));
  check(fileCount === 1, 'exactly one file was scanned', `fileCount=${fileCount}`);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §2 collect: a getSetting call in a different fixture file is found ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-server-'));
  put(T, 'audio_engine.ts', "const gain = getSetting('audio.gain');\n");
  const { keys } = await collect([T], GET_RE);
  check(keys.has('audio.gain'), 'the get-side key is collected', JSON.stringify([...keys.keys()]));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §3 mentions: a constant name referenced anywhere under the roots is found (positive control) ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-mentions-'));
  put(T, 'somewhere/deep/consumer.ts', "render(SETTINGS_KEY_CAPABILITY_LLM);\n");
  const where = await mentions([T], 'SETTINGS_KEY_CAPABILITY_LLM');
  check(where !== null, 'the constant is found under a nested path', where);
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §4 negative control: mentions returns null when the constant is nowhere in the tree ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-nomention-'));
  put(T, 'unrelated.ts', "export const OTHER = 1;\n");
  const where = await mentions([T], 'SETTINGS_KEY_CAPABILITY_LLM');
  check(where === null, 'an absent constant reports null, not a false match', String(where));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §5 REVERSE CONTROL (full run): a UI-set key with no server reader is an orphan ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-full-'));
  put(T, 'apps/desktop/src/settings_page.ts', "setSetting('ui.only.orphan', true);\n");
  put(T, 'apps/server-core/src/nothing.ts', "// no readSetting calls here\n");
  // Simulate what run() does, using the real collect() against the fixture.
  const set = await collect([join(T, 'apps/desktop')], SET_RE);
  const get = await collect([join(T, 'apps/server-core')], GET_RE);
  const orphans = [...set.keys.keys()].filter((k) => !get.keys.has(k));
  check(orphans.includes('ui.only.orphan'), 'a set-only key is identified as an orphan', JSON.stringify(orphans));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §6 REVERSE CONTROL (full run): a server-get key with no UI writer is an orphan the other direction ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-full2-'));
  put(T, 'apps/desktop/src/settings_page.ts', "// no setSetting calls here\n");
  put(T, 'apps/server-core/src/reader.ts', "const v = getSetting('server.only.orphan');\n");
  const set = await collect([join(T, 'apps/desktop')], SET_RE);
  const get = await collect([join(T, 'apps/server-core')], GET_RE);
  const orphans = [...get.keys.keys()].filter((k) => !set.keys.has(k));
  check(orphans.includes('server.only.orphan'), 'a get-only key is identified as an orphan', JSON.stringify(orphans));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §7 negative control: a key both set and read is not an orphan ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-paired-'));
  put(T, 'apps/desktop/src/settings_page.ts', "setSetting('audio.gain', 0.8);\n");
  put(T, 'apps/server-core/src/reader.ts', "const v = getSetting('audio.gain');\n");
  const set = await collect([join(T, 'apps/desktop')], SET_RE);
  const get = await collect([join(T, 'apps/server-core')], GET_RE);
  const orphans = [...set.keys.keys()].filter((k) => !get.keys.has(k));
  check(orphans.length === 0, 'a paired key is not reported', JSON.stringify(orphans));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §8 the phone-owned bundle form is a SET anchor (WP-B2, 2026-09-03) ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-carry-'));
  // The shape apps/mobile/lib/src/settings/phone_prefs_payload.dart writes: the
  // key rides the transcription request, not a settings:update. This rule is
  // what keeps the mobile's four anchors visible after the push was deleted.
  put(T, 'phone_prefs_payload.dart', "b.carrySetting('scenario.inference', row);\n");
  const { keys } = await collect([T], SET_RE);
  check(keys.has('scenario.inference'), 'carrySetting is collected as a SET anchor', JSON.stringify([...keys.keys()]));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §9 negative control: a lookalike verb or a variable key plants NOTHING ===');
{
  const T = mkdtempSync(join(tmpdir(), 'fmskd-carry-neg-'));
  put(T, 'other.dart', "carryThing('scenario.inference', row);\ncarrySetting(someKey, row);\n");
  const { keys } = await collect([T], SET_RE);
  check(keys.size === 0, 'no key is invented from a lookalike verb or a variable key', JSON.stringify([...keys.keys()]));
  rmSync(T, { recursive: true, force: true });
}

console.log('=== §10 the lint itself runs on the real repo and answers ===');
{
  const res = await settingsKeyDrift();
  check(res.status === 'PASS', 'the real repo has no drift', JSON.stringify(res));
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
}

console.log(`\n${failures === 0 ? '✔' : '✘'} settings-key-drift drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
