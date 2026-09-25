import assert from 'node:assert/strict';
import { isPlaceholder, isTranslated } from './i18n/translation-coverage.mjs';
for (const value of ['DEV: pending', "'DEV: pending'", '"DEV: pending"', '  dev: pending',
  ["'real first line'", "'DEV: pending second line'"]]) {
  assert.equal(isPlaceholder(value), true);
  assert.equal(isTranslated(value), false, 'a present placeholder cannot count as translated');
}
for (const value of [undefined, null, '', ' ', [], ['']]) assert.equal(isTranslated(value), false);
for (const value of ["'Actual copy'", ["'Actual'", "'continued'"]]) {
  assert.equal(isTranslated(value), true);
  assert.equal(isPlaceholder(value), false);
}
console.log('PASS translation coverage: present placeholders excluded, actual source retained');
