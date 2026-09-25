// Drill for verify/delivery-checks/i18n-dev-placeholders.mjs (NR-83).
// Discovered by scripts/run-script-tests.mjs.
//
// Runs the production scan against this checkout, then against a scratch tree
// that plants every placeholder spelling the scan has always caught, so a
// weakened pattern cannot pass. Finally pins WHERE it runs: the delivery gates,
// never the per-commit lint.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import run, { SURFACES, scanPlaceholders } from '../verify/delivery-checks/i18n-dev-placeholders.mjs';

const live = await run();
assert.equal(live.status, 'PASS', live.detail);
console.log(`PASS real tree: ${live.detail}`);

const root = mkdtempSync(path.join(tmpdir(), 'flowmic-dev-placeholders-'));
try {
  for (const surface of SURFACES) mkdirSync(path.join(root, 'i18n', surface), { recursive: true });
  const write = (rel, value) => writeFileSync(path.join(root, 'i18n', rel), JSON.stringify(value));
  write('mobile/en.json', { plain: 'DEV: plain', nested: { deeper: { key: '  dev: lower case, padded' } } });
  write('mobile/ru.json', { quoted: '"DEV: quoted' });
  write('desktop/zh-CN.json', { single: "'DEV: single quote" });
  write('desktop-rust/ko.json', { ok: 'A real sentence that mentions DEV: later is fine' });
  write('desktop-rust/de.json', { ok: 'Echter Satz' });
  // Not one of the nine locale files: never scanned, same as before the move.
  write('mobile/coverage.json', { note: 'DEV: not a locale file' });
  const found = (await scanPlaceholders(root)).sort();
  assert.deepEqual(found, [
    'desktop/zh-CN.json:.single',
    'mobile/en.json:.nested.deeper.key',
    'mobile/en.json:.plain',
    'mobile/ru.json:.quoted',
  ]);
  console.log('PASS every placeholder spelling is caught; prose that merely contains DEV: is not');
} finally {
  rmSync(root, { recursive: true, force: true });
}

const repo = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const pkg = JSON.parse(repo('package.json'));
assert.equal(pkg.scripts['verify:i18n-dev-placeholders'], 'node verify/delivery-checks/i18n-dev-placeholders.mjs');
assert.ok(pkg.scripts['verify:delivery'].split('&&').map((c) => c.trim()).includes('pnpm verify:i18n-dev-placeholders'),
  'the sequential release chain runs the scan');
assert.match(repo('verify/run-delivery-fast.mjs'), /pnpm\('verify:i18n-dev-placeholders'\)/);
assert.doesNotMatch(repo('verify/lint/i18n-error-keys.mjs'), /readdir|DEV placeholders remain/,
  'the per-commit lint no longer scans the locale catalogues');
assert.doesNotMatch(repo('verify/lint/run-all.mjs'), /i18n-dev-placeholders/);
console.log('PASS registered in both delivery gates and absent from verify:lint');
