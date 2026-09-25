// Runs the production lint against this checkout, then exercises both sides of
// the coverage boundary. Discovered by scripts/run-script-tests.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import run, { validateCoverage } from '../verify/lint/i18n-web-error-coverage.mjs';

const live = await run();
assert.equal(live.status, 'PASS', live.detail);
console.log(`PASS real-tree coverage: ${live.detail}`);
const subset = (...keys) => ({ groups: [{ id: 'notes', keys }] });
for (const code of ['INJECT_TARGET_NOT_READY', 'INJECT_WAYLAND_UNSUPPORTED', 'INJECT_SUBMISSION_UNCERTAIN', 'INJECT_FUTURE_REFUSAL']) {
  const key = `injectVerdictNote_${code}`;
  assert.equal(validateCoverage([code], subset(key)).status, 'PASS', code);
  const missing = validateCoverage([code], subset());
  assert.equal(missing.status, 'FAIL', code);
  assert.ok(missing.detail.includes(code), missing.detail);
}
assert.equal(validateCoverage(['INJECT_REAL'], subset('injectVerdictNote_INJECT_RETIRED')).status, 'FAIL');
assert.equal(validateCoverage(['INJECT_REAL'], subset('injectVerdictNote_INJECT_REAL', 'deliveryRefusalNote_INJECT_REAL')).status, 'FAIL');
assert.equal(validateCoverage(['INJECT_NOT_PRIMARY'], subset()).status, 'PASS');
assert.equal(validateCoverage(['INJECT_NOT_PRIMARY'], subset('pcAdmissionRefusalNote_INJECT_NOT_PRIMARY')).status, 'FAIL');
assert.equal(validateCoverage([], subset()).status, 'FAIL');
assert.equal(validateCoverage(['INJECT_REAL'], {}).status, 'FAIL');
const runner = readFileSync(new URL('../verify/lint/run-all.mjs', import.meta.url), 'utf8');
assert.match(runner, /import i18nWebErrorCoverage from '\.\/i18n-web-error-coverage\.mjs'/);
assert.match(runner, /name: 'i18n-web-error-coverage', run: i18nWebErrorCoverage/);
console.log('PASS registry coverage, removed mappings, platform additions, stale mappings, malformed input, and production registration');
