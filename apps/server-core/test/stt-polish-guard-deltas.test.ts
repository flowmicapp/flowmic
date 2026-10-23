import { expect, it } from 'vitest';
import { closedClassDeltas } from '../src/stt/stt-polish-guard-deltas';
it('counts every category after the first violation, without returning any term', () => {
  expect(closedClassDeltas('三个人都不能去2次', '人去')).toMatchObject({ d_numeral: 1, d_digit: 1, d_modal: 1, d_negation: 1, d_quantifier: 1 });
  expect(closedClassDeltas('nothing nowhere', 'nothing nowhere!')).toMatchObject({ first_category: null, d_negation: 0 });
  expect(closedClassDeltas('did not ship', 'did ship').d_negation).toBe(1);
});

// QP-1 (2026-10-13): the NR118 pin "live verdict function and original
// cardinality checks are verbatim base" was retired here on purpose — the live
// guard moved (numbers by value, word-level modal/negation, scaled smooth K).
// The frozen v1 source stays in fixtures/polish-guard-v1-base.txt and is still
// exercised against the corpus by stt-polish-guard-v2.test.ts.
it('names a numeral first category only when the number VALUES moved', () => {
  expect(closedClassDeltas('我一直觉得', '我觉得')).toMatchObject({ first_category: null, d_numeral: 1 });
  expect(closedClassDeltas('三点开会', '两点开会').first_category).toBe('numeral');
});
