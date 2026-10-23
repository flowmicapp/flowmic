// Card POL-2 drill for scripts/eval/speech-quality/two-stage-scoring.mjs and
// relay-rows.mjs (the two-stage polish eval, design
// docs/strategy/2026-10-14-two-stage-polish-design.md §9).
//
// WHY: the eval's headline numbers (cut errors at a seam, context-dependent
// words, row settlement) decide whether two-stage polish ships. A scorer that
// calls a mid-sentence cut a sentence end would report every fabricated full
// stop as correct. Each hand-made sample below is a right or a wrong answer
// whose verdict is known in advance, judged once.
//
// Pure: no network, no corpus file, no .local material. Exit 0 = PASS, 1 = FAIL
// (scripts/run-script-tests.mjs convention).

import assert from 'node:assert/strict';
import { RowSettler, joinSegments } from './eval/speech-quality/relay-rows.mjs';
import { isSentenceEnd, plannedCuts, scorePress, seams, tokenize } from './eval/speech-quality/two-stage-scoring.mjs';

const results = [];
const test = (name, fn) => { try { fn(); results.push([name, null]); } catch (e) { results.push([name, e]); } };

const zh = { id: 'zh-t', lang: 'zh', reference: '所以呢本质上安倍经济学是通过出卖金融主权来实现的。下一步我们再看。', cuts: [{ after: '本质上安倍', kind: 'mid' }] };
const en = { id: 'en-t', lang: 'en', reference: 'We moved the whole billing service to the new cluster. Then we tested it again.', cuts: [{ after: 'the whole', kind: 'mid' }] };
const de = { id: 'de-t', lang: 'de', reference: 'Bitte lest das Dokument und schreibt eure Kommentare direkt hinein. Danke euch.', cuts: [{ after: 'schreibt eure', kind: 'mid' }] };

test('zh mid-sentence cut with a fabricated full stop is a cut error', () => {
  const r = seams(zh, ['所以呢本质上安倍。', '经济学是通过出卖金融主权来实现的。下一步我们再看。']);
  assert.equal(r.seams.length, 1);
  assert.equal(r.seams[0].kind, 'mid');
  assert.deepEqual(r.seams[0].errors, ['terminator']);
  assert.equal(r.seams[0].planned, 'mid');
});

test('zh mid-sentence cut left open is not a cut error', () => {
  const r = seams(zh, ['所以呢本质上安倍', '经济学是通过出卖金融主权来实现的。下一步我们再看。']);
  assert.equal(r.seams[0].kind, 'mid');
  assert.deepEqual(r.seams[0].errors, []);
  assert.equal(r.seams[0].lost + r.seams[0].dup, 0);
});

test('en mid-sentence cut: full stop and a capital on the continuation are both errors', () => {
  const r = seams(en, ['We moved the whole.', 'Billing service to the new cluster. Then we tested it again.']);
  assert.equal(r.seams[0].kind, 'mid');
  assert.deepEqual(r.seams[0].errors.sort(), ['capital', 'terminator']);
});

test('en mid-sentence cut left with the engine em dash is a dash error', () => {
  const r = seams(en, ['We moved the whole—', 'billing service to the new cluster. Then we tested it again.']);
  assert.deepEqual(r.seams[0].errors, ['dash']);
});

test('en cut at a sentence end: terminator and capital are correct', () => {
  const r = seams(en, ['We moved the whole billing service to the new cluster.', 'Then we tested it again.']);
  assert.equal(r.seams[0].kind, 'end');
  assert.deepEqual(r.seams[0].errors, []);
});

test('en cut at a sentence end that lost its full stop is reported as lost_terminator', () => {
  const r = seams(en, ['We moved the whole billing service to the new cluster', 'Then we tested it again.']);
  assert.equal(r.seams[0].kind, 'end');
  assert.deepEqual(r.seams[0].errors, ['lost_terminator']);
});

test('de: a capitalised noun after a mid-sentence cut is not a capital error', () => {
  const r = seams(de, ['Bitte lest das Dokument und schreibt eure', 'Kommentare direkt hinein. Danke euch.']);
  assert.equal(r.seams[0].kind, 'mid');
  assert.deepEqual(r.seams[0].errors, []);
});

test('a word repeated across the seam is counted as dup, a dropped one as lost', () => {
  const dup = seams(en, ['We moved the whole billing', 'billing service to the new cluster. Then we tested it again.']).seams[0];
  assert.equal(dup.dup, 1);
  const lost = seams(en, ['We moved the whole', 'service to the new cluster. Then we tested it again.']).seams[0];
  assert.equal(lost.lost, 1);
});

test('abbreviations and decimals are not sentence ends', () => {
  const ref = 'Hi Mr. Okonkwo, the rate is 1.5 percent today.';
  const toks = tokenize('en', ref);
  const iOk = toks.findIndex((t) => t.t === 'okonkwo');
  const i5 = toks.findIndex((t) => t.t === '5');
  assert.equal(isSentenceEnd('en', ref, toks, iOk), false);
  assert.equal(isSentenceEnd('en', ref, toks, i5), false);
});

test('planned cut anchors map to reference token indices', () => {
  assert.deepEqual(plannedCuts(en), [{ kind: 'mid', r: 4 }]);
  assert.deepEqual(plannedCuts(zh), [{ kind: 'mid', r: 8 }]);
});

const xr = {
  id: 'en-x', lang: 'en', reference: 'We run Kubernetes now. Later we deploy it to Kubernetes again.', cuts: [{ after: 'now.', kind: 'end' }],
  cross_refs: [{ right: 'Kubernetes', wrong: ['Cooper'] }], terms: ['Kubernetes'],
  polish_expect: { strict: { must: ['again'], must_not: [] } },
};
test('cross_ref: the later row without the term is wrong, with it is right', () => {
  const bad = scorePress(xr, 'strict', ['We run Kubernetes now.', 'Later we deploy it to Cooper Netties again.']);
  assert.equal(bad.cross_refs[0].in_context, true);
  assert.equal(bad.cross_refs[0].ok, false);
  const good = scorePress(xr, 'strict', ['We run Kubernetes now.', 'Later we deploy it to Kubernetes again.']);
  assert.equal(good.cross_refs[0].ok, true);
  assert.equal(good.error_rate, 0);
  assert.equal(good.expect.ok, true);
  assert.equal(scorePress(xr, 'strict', ['We run kubernetes now.', 'Later we deploy it to Kubernetes again.']).term_inconsistent, 1);
});

test('RowSettler mirrors the phone: empty segment settles nothing, terminal takes the rest', () => {
  const s = new RowSettler();
  assert.equal(s.onFinal({ segment_idx: 0, is_segment: true, text: '' }), null);
  const r1 = s.onFinal({ segment_idx: 1, is_segment: true, text: 'first part', polish: 'applied' });
  assert.deepEqual([r1.from_seg, r1.to_seg, r1.text, r1.terminal], [0, 1, 'first part', false]);
  const r2 = s.onFinal({ segment_idx: 2, is_segment: false, text: 'tail.', polish: 'skipped', polish_reason: 'timeout' });
  assert.deepEqual([r2.from_seg, r2.to_seg, r2.text, r2.terminal, r2.polish_reason], [2, 2, 'tail.', true, 'timeout']);
  assert.equal(s.onFinal({ segment_idx: 3, is_segment: false, text: 'late' }), null);
  assert.equal(joinSegments(new Map([[0, '你好'], [1, 'world'], [2, 'again']])), '你好world again');
});

let failed = 0;
for (const [name, e] of results) {
  if (e) { failed++; console.log(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); } else console.log(`ok   ${name}`);
}
console.log(`pol2-two-stage-scoring: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
