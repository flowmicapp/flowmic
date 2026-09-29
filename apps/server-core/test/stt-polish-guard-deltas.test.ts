import { expect, it } from 'vitest';
import { closedClassDeltas } from '../src/stt/stt-polish-guard-deltas';
it('counts every category after the first violation, without returning any term', () => {
  expect(closedClassDeltas('三个人都不能去2次', '人去')).toMatchObject({ d_numeral: 1, d_digit: 1, d_modal: 1, d_negation: 1, d_quantifier: 1 });
  expect(closedClassDeltas('nothing nowhere', 'nothing nowhere!')).toMatchObject({ first_category: null, d_negation: 0 });
  expect(closedClassDeltas('did not ship', 'did ship').d_negation).toBe(1);
});

import { readFileSync } from 'node:fs';
it('live verdict function and original cardinality checks are verbatim base', () => {
  const base = readFileSync(new URL('./fixtures/polish-guard-v1-base.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const live = readFileSync(new URL('../src/stt/stt-polish-guard.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  expect(live.slice(live.indexOf('export function checkMeaningPreserved'))).toBe(base.slice(base.indexOf('export function checkMeaningPreserved')));
  const bounds = readFileSync(new URL('../src/stt/stt-polish-guard-bounds.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const marker = '  // §3.1 — cardinality bound (necessary, not sufficient).';
  expect(bounds.slice(bounds.indexOf(marker))).toBe(base.slice(base.indexOf(marker)));
});
