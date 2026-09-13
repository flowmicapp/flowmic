#!/usr/bin/env node
// Drill for verify/lint/mobile-web-tokens-mirror.mjs — the gate that keeps the
// browser client's hand-typed `--fm-*` palette equal to the phone's
// `apps/mobile/lib/src/ui/tokens.dart` (card P-1, owner 2026-09-10「样式与手机
// 端的转录界面样式一致」).
//
// ── WHY THE FIXTURE IS DERIVED FROM THE REAL tokens.dart ───────────────────
// The lint compares two files that live in two repositories. A drill that
// needed both would be unrunnable on a machine without the browser client
// checked out — and the machines that most need a drill are exactly the ones
// where a check silently stopped running. So the CSS fixture here is BUILT from
// the real tokens.dart through the lint's own exported `expectations()`, and
// then broken one byte at a time.
//
// 🔴 WHAT THAT DELIBERATELY DOES NOT PROVE: that the real
// `apps/mic/src/styles/tokens.css` agrees with the phone. It cannot — it never
// reads that file except in §9. This drill answers one question, which is
// whether the comparator and the CSS parser can go RED; the agreement question
// is the lint's own line in `pnpm verify:lint`, and §9 prints what it says on
// this machine so the two are never confused for each other.
//
// Exit codes follow scripts/run-script-tests.mjs: 0 PASS, 1 FAIL, 2 SKIP.

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import mirror, { expectations } from '../verify/lint/mobile-web-tokens-mirror.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DART = join(ROOT, 'apps', 'mobile', 'lib', 'src', 'ui', 'tokens.dart');

let failures = 0;
const ok = (name, detail) => console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

const T = mkdtempSync(join(tmpdir(), 'fmtok-'));
const dartRaw = readFileSync(DART, 'utf8');
const built = expectations(dartRaw);
if (built.error) {
  console.log(`  FAIL  expectations() could not read the real tokens.dart  (${built.error.detail})`);
  process.exit(1);
}
const { expected, expectedScalars } = built;

const css = (c) =>
  c.a === 255
    ? `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`
    : `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;

/**
 * A tokens.css that AGREES with tokens.dart, optionally with one substitution.
 * `edit` is `{ scope, var, value }` — scope one of 'light' | 'media' | 'attr'.
 * `dropAttrBlock` omits the explicit-dark selector entirely.
 */
function buildCss({ edit = null, dropAttrBlock = false } = {}) {
  const at = (scope, name, fallback) =>
    edit && edit.scope === scope && edit.var === name ? edit.value : fallback;

  const light = [
    ...expected.map((e) => `  ${e.var}: ${at('light', e.var, css(e.light))};`),
    ...expectedScalars.map((e) => `  ${e.var}: ${at('light', e.var, `${e.value}px`)};`),
  ].join('\n');
  const darkBody = (scope, indent) =>
    expected.map((e) => `${indent}${e.var}: ${at(scope, e.var, css(e.dark))};`).join('\n');

  return (
    `:root {\n${light}\n}\n\n` +
    '@media (prefers-color-scheme: dark) {\n' +
    '  :root:not([data-theme="light"]) {\n' +
    `${darkBody('media', '    ')}\n` +
    '  }\n}\n\n' +
    (dropAttrBlock
      ? ''
      : `:root[data-theme="dark"] {\n${darkBody('attr', '  ')}\n}\n`)
  );
}

function put(name, contents) {
  const abs = join(T, name);
  writeFileSync(abs, contents, 'utf8');
  return abs;
}

// A colour and a scalar that exist in every build of the mapping, picked by
// position rather than by name so a rename upstream fails this drill loudly
// instead of making it quietly drill nothing.
const SAMPLE = expected.find((e) => e.var === '--fm-dock-pri') ?? expected[0];
const SAMPLE_SCALAR = expectedScalars[0];

console.log('=== §1 negative control: a CSS fixture that agrees PASSes ===');
{
  const res = await mirror({ cssFile: put('agree.css', buildCss()) });
  check(res.status === 'PASS', 'an agreeing fixture passes', JSON.stringify(res));
  check(
    res.detail.includes(`${expected.length} colour`),
    'the PASS detail states how many tokens were compared',
    res.detail,
  );
}

console.log('=== §2 REVERSE CONTROL: one wrong LIGHT value FAILs ===');
{
  const res = await mirror({
    cssFile: put('light.css', buildCss({ edit: { scope: 'light', var: SAMPLE.var, value: '#123456' } })),
  });
  check(res.status === 'FAIL', 'a drifted light value fails', res.status);
  check(
    res.detail.includes(SAMPLE.var) && res.detail.includes('#123456') && res.detail.includes('light'),
    'the FAIL names the variable, what the browser says, and which theme',
    res.detail.slice(0, 200),
  );
}

console.log('=== §3 REVERSE CONTROL: a wrong value in the SYSTEM-DARK block FAILs ===');
{
  const res = await mirror({
    cssFile: put('media.css', buildCss({ edit: { scope: 'media', var: SAMPLE.var, value: '#123456' } })),
  });
  check(res.status === 'FAIL', 'a drifted system-dark value fails', res.status);
  check(
    res.detail.includes('prefers-color-scheme: dark'),
    'the FAIL names which of the two dark blocks drifted',
    res.detail.slice(0, 200),
  );
}

console.log('=== §4 REVERSE CONTROL: the two dark blocks are compared SEPARATELY ===');
{
  // 🔴 This is the case the duplication in tokens.css exists to risk: CSS has
  // no way to share a body between two selectors, so the explicit-dark block is
  // a hand-kept copy of the media block. If only one of them were compared, a
  // visitor who chose dark on a light OS would see a palette nobody checked.
  const res = await mirror({
    cssFile: put('attr.css', buildCss({ edit: { scope: 'attr', var: SAMPLE.var, value: '#123456' } })),
  });
  check(res.status === 'FAIL', 'a drift in the explicit-dark block alone fails', res.status);
  check(
    res.detail.includes('[data-theme="dark"]'),
    'the FAIL names the explicit-dark block, not the media one',
    res.detail.slice(0, 200),
  );
}

console.log('=== §5 REVERSE CONTROL: a wrong NUMERIC token FAILs ===');
{
  const res = await mirror({
    cssFile: put(
      'scalar.css',
      buildCss({ edit: { scope: 'light', var: SAMPLE_SCALAR.var, value: '999px' } }),
    ),
  });
  check(res.status === 'FAIL', 'a drifted numeric token fails', res.status);
  check(
    res.detail.includes(SAMPLE_SCALAR.var) && res.detail.includes(String(SAMPLE_SCALAR.value)),
    'the FAIL names the variable and the phone value it should carry',
    res.detail.slice(0, 200),
  );
}

console.log('=== §6 a missing THEME STATE FAILs, and is not read as "equal" ===');
{
  const res = await mirror({ cssFile: put('two-states.css', buildCss({ dropAttrBlock: true })) });
  check(res.status === 'FAIL', 'a file with only two of the three theme states fails', res.status);
  check(
    res.detail.includes(':root[data-theme="dark"]'),
    'the FAIL names the state that has no colours',
    res.detail.slice(0, 200),
  );
}

console.log('=== §7 a missing browser file is SKIP, never PASS ===');
{
  const res = await mirror({ cssFile: join(T, 'does-not-exist.css') });
  check(res.status === 'SKIP', 'an unreachable browser file skips', res.status);
  check(
    res.detail.includes(String(expected.length + expectedScalars.length)),
    'the SKIP says how many tokens went unchecked',
    res.detail.slice(0, 200),
  );
}

console.log('=== §8 a NEW phone token nobody has decided about FAILs ===');
{
  // The point of the mapping-completeness rule: without it the mirror would go
  // on printing a PASS while covering a shrinking share of the palette.
  const injected = dartRaw.replace(
    'class FlowMicDockColors {',
    'class FlowMicDockColors {\n  static Color get inventedToday => const Color(0xFF010203);',
  );
  const res = await mirror({
    dartFile: put('extra.dart', injected),
    cssFile: put('agree2.css', buildCss()),
  });
  check(res.status === 'FAIL', 'an unmapped new token fails', res.status);
  check(
    res.detail.includes('inventedToday') && res.detail.includes('never been told about'),
    'the FAIL names the token and says what to do with it',
    res.detail.slice(0, 220),
  );
}

console.log('=== §9 a mapping entry whose phone token is GONE FAILs (stale, not silent) ===');
{
  const removed = dartRaw.replace(
    /^\s*static Color get doneFlash =>[^;]*;$/m,
    '  // (removed by the drill)',
  );
  const res = await mirror({
    dartFile: put('gone.dart', removed),
    cssFile: put('agree3.css', buildCss()),
  });
  check(res.status === 'FAIL', 'a mapping of a deleted token fails', res.status);
  check(
    res.detail.includes('doneFlash') && res.detail.includes('no longer declared'),
    'the FAIL names the entry that now compares nothing',
    res.detail.slice(0, 220),
  );
}

console.log('=== §10 the lint on this machine, against the real sibling checkout ===');
{
  const res = await mirror();
  check(res.status !== 'FAIL', 'the real comparison is not failing', res.status);
  console.log(`  --  measured on this tree: ${res.status} — ${res.detail}`);
}

rmSync(T, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '✔' : '✘'} mobile-web-tokens-mirror drill — ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
