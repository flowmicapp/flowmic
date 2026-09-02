#!/usr/bin/env node
// Drill for verify/lint/protocol-whitelist.mjs — until this file existed, this
// gate (the one that keeps a client from emitting an event the server never
// registered, and vice versa) had no test of any kind: AUD-W's read-only pass
// counted it among ~22 of 35 verify/lint rules with no fixture proving the
// regex actually catches anything.
//
// `scanTree(rootsAbs, whitelist)` was extracted from `run()` on 2026-09-02
// (B2-A) specifically so this file could point the walk-and-match half of the
// lint at a disposable fixture tree instead of the real apps/**+packages/**.
// `parseWhitelist` and `EVENT_SHAPE` were already exported (or trivially so)
// and are exercised directly against synthetic source text — no fixture tree
// needed for those.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWhitelist, EVENT_SHAPE, scanTree, langOf, isTestFile } from '../verify/lint/protocol-whitelist.mjs';

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

const T = mkdtempSync(join(tmpdir(), 'fmpw-fixture-'));
const put = (rel, content) => {
  const abs = join(T, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
};

try {
  console.log('=== §1 parseWhitelist reads a clean EVENT_NAMES array (positive control) ===');
  {
    const src = `export const EVENT_NAMES = [\n  'pc:register',\n  'mobile:reconnect',\n  'heartbeat',\n] as const;\n`;
    const set = parseWhitelist(src);
    check(set.size === 3, 'parsed exactly the 3 declared names', `size=${set.size}`);
    check(set.has('pc:register') && set.has('heartbeat'), 'both a colon-form and a bare event are present');
  }

  console.log("=== §2 REVERSE CONTROL: an apostrophe inside the array's own comments corrupts the parse ===");
  {
    // Mirrors the real incident this lint's own header documents: a comment
    // saying "owner's machine" inside the EVENT_NAMES literal re-pairs every
    // single quote after it, turning a chunk of prose into a "whitelist entry".
    const src = [
      'export const EVENT_NAMES = [',
      "  'pc:register',",
      "  // note: this covers owner's machine and everyone else's too",
      "  'mobile:reconnect',",
      '] as const;',
      '',
    ].join('\n');
    const set = parseWhitelist(src);
    const malformed = [...set].filter((n) => !EVENT_SHAPE.test(n));
    check(malformed.length > 0, 'EVENT_SHAPE catches the swallowed-quote corruption', JSON.stringify([...set]));
  }

  console.log('=== §3 scanTree: an unknown event in a fixture .ts file is caught (positive control) ===');
  {
    put('packages/protocol/src/events.ts', "export const EVENT_NAMES = ['pc:register'] as const;\n");
    put('apps/desktop/src/lib/socket.ts', "socket.emit('pc:register', {});\nsocket.on('pc:not-real-event', () => {});\n");
    const whitelist = new Set(['pc:register']);
    const { violations, counts } = await scanTree([T], whitelist);
    check(violations.length === 1, 'exactly one unknown event reported', JSON.stringify(violations));
    check(violations[0]?.includes("'pc:not-real-event'"), 'the violation names the offending event', violations[0]);
    check(counts.ts >= 1, 'the .ts file was actually counted, not skipped', `ts=${counts.ts}`);
  }

  console.log('=== §4 scanTree: an unknown event in a fixture .dart file is caught ===');
  {
    put('apps/mobile/lib/src/x.dart', "socket.emit('mobile:bogus-event', {});\n");
    const { violations } = await scanTree([T], new Set(['pc:register']));
    check(violations.some((v) => v.includes('x.dart') && v.includes('mobile:bogus-event')), 'the dart violation is reported', JSON.stringify(violations));
  }

  console.log('=== §5 scanTree: an unknown event in a fixture .rs file is caught ===');
  {
    put('apps/desktop/src-tauri/src/y.rs', "socket.emit(\"pc:another-bogus\", json!({}));\n");
    const { violations } = await scanTree([T], new Set(['pc:register']));
    check(violations.some((v) => v.includes('y.rs') && v.includes('pc:another-bogus')), 'the rust violation is reported', JSON.stringify(violations));
  }

  console.log('=== §6 REVERSE CONTROL: the SAME fixture tree is clean against a whitelist that knows every event ===');
  {
    const fullWhitelist = new Set(['pc:register', 'pc:not-real-event', 'mobile:bogus-event', 'pc:another-bogus']);
    const { violations } = await scanTree([T], fullWhitelist);
    check(violations.length === 0, 'no violations once every event used above is whitelisted', JSON.stringify(violations));
  }

  console.log('=== §7 negative control: a clean fixture with only whitelisted events passes ===');
  {
    const T2 = mkdtempSync(join(tmpdir(), 'fmpw-clean-'));
    const put2 = (rel, content) => {
      const abs = join(T2, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    };
    put2('apps/desktop/src/lib/socket.ts', "socket.emit('pc:register', {});\n");
    const { violations, counts } = await scanTree([T2], new Set(['pc:register']));
    check(violations.length === 0, 'a fixture using only whitelisted events is clean');
    check(counts.ts === 1, 'exactly one file scanned', `ts=${counts.ts}`);
    rmSync(T2, { recursive: true, force: true });
  }

  console.log('=== §8 KNOWN LIMIT (not tested here): the packages/protocol/ SSOT exclusion ===');
  {
    // scanTree's `relPath.startsWith('packages/protocol/')` guard is computed
    // from `rel(abs)`, which is _util.mjs's `rel()` — hard-coded to the REAL
    // repo ROOT, not to whatever root this drill's fixture lives under. A
    // fixture tree outside ROOT (this one lives under the OS temp dir) can
    // never produce a path that starts with 'packages/protocol/', so this
    // drill structurally cannot exercise that one guard. Documented rather
    // than faked: making `rel()` itself root-relative is a bigger seam change
    // than B2-A's "keep behaviour identical" scope allows, and the real
    // production callers (packages/protocol/** in the actual repo) exercise
    // it every run of `pnpm verify:lint` on the real tree.
    ok('documented as untestable-in-fixture rather than asserted');
  }

  console.log('=== §9 "blind scan" control: a single language with 0 files is labelled "(skip)", not silently passed as scanned ===');
  {
    const T3 = mkdtempSync(join(tmpdir(), 'fmpw-onelang-'));
    const put3 = (rel, content) => {
      const abs = join(T3, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    };
    put3('apps/desktop/src/lib/socket.ts', "socket.emit('pc:register', {});\n");
    const { counts } = await scanTree([T3], new Set(['pc:register']));
    check(counts.ts === 1 && counts.rust === 0 && counts.dart === 0 && counts.vue === 0, 'only ts has files; the other three languages report 0, not "1 clean file per language"', JSON.stringify(counts));
    rmSync(T3, { recursive: true, force: true });
  }

  console.log('=== §10 isTestFile / langOf are the seams run() relies on to exclude test files ===');
  {
    check(isTestFile('apps/mobile/lib/src/x_test.dart'), '_test.dart is recognised as a test file');
    check(!isTestFile('apps/mobile/lib/src/x.dart'), 'a non-test .dart file is not excluded');
    check(langOf('.rs') === 'rust' && langOf('.dart') === 'dart' && langOf('.py') === null, 'langOf maps known extensions and returns null for unknown ones');
  }

  console.log('=== §11 the lint itself runs on this tree and answers ===');
  {
    const mod = await import('../verify/lint/protocol-whitelist.mjs');
    const res = await mod.default();
    check(['PASS', 'SKIP', 'FAIL'].includes(res.status), 'lint returned a known status', res.status);
    console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
  }
} finally {
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '✔' : '✘'} protocol-whitelist drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
