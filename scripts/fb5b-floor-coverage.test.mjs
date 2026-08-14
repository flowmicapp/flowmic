// scripts/fb5b-floor-coverage.test.mjs
//
// FB-5b — "no silent no-floor". Discovered automatically by
// scripts/run-script-tests.mjs (verify:delivery runs it); exit 0 PASS / 1 FAIL
// / 2 SKIP, the scripts/*.test.mjs convention.
//
// 🔴 WHY THIS EXISTS. The guard-eval gate already asserts "the current config
// passes". It does NOT, on its own, prove the FB-5b enforcement is load-bearing —
// that a NEW unfloored family would fail, or that a family declared unflorable
// which the guard STARTS catching would fail. Those are the two drift directions
// the card is about, and a gate that only ever runs the current happy config
// never exercises either. So the coverage decision was pulled out of guardMode
// into the pure `evaluateFloorCoverage`, and this drives it with synthetic
// corpora to prove each failure fires — the same "measure the ruler, not just
// the product" discipline the rest of this corpus obeys.

import { evaluateFloorCoverage, GUARD_FLOORS, GUARD_MIN_CATCHES, GUARD_KNOWN_UNFLOORED } from '../verify/eval/eval-guard.mjs';

let failed = 0;
const check = (name, cond) => {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); failed += 1; }
};
const mk = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, { n: v.n, caught: v.caught, falseReject: 0 }]));

// ── synthetic tables, so the mechanism is tested in isolation from the real corpus ──
const tables = {
  floors: { 'x/rate': 0.5 },
  minCatches: { 'x/count': 2 },
  knownUnfloored: new Set(['x/known']),
};
const base = { 'x/rate': { n: 10, caught: 6 }, 'x/count': { n: 10, caught: 3 }, 'x/known': { n: 10, caught: 0 } };

// A. the coherent baseline: every family floored or acknowledged, at safe values.
check('baseline config produces no failures', evaluateFloorCoverage(mk(base), tables).length === 0);

// B. 🔴 the FB-5b anti-pattern: a NEW unfloored family must FAIL, not join silently.
{
  const f = evaluateFloorCoverage(mk({ ...base, 'x/newfam': { n: 10, caught: 0 } }), tables);
  check('a new unfloored family fails (not in GUARD_KNOWN_UNFLOORED)',
    f.some((s) => s.startsWith('x/newfam:') && s.includes('NOT in GUARD_KNOWN_UNFLOORED')));
}

// C. drift the other way: a family declared unflorable that the guard STARTS catching.
{
  const f = evaluateFloorCoverage(mk({ ...base, 'x/known': { n: 10, caught: 1 } }), tables);
  check('an acknowledged family the guard starts catching fails (move it to a count floor)',
    f.some((s) => s.startsWith('x/known:') && s.includes('now catches')));
}

// D. an ordinary rate-floor breach still fires.
{
  const f = evaluateFloorCoverage(mk({ ...base, 'x/rate': { n: 10, caught: 2 } }), tables);
  check('a rate floor below its threshold fails', f.some((s) => s.startsWith('x/rate:') && s.includes('fell below')));
}

// E. an ordinary count-floor breach still fires.
{
  const f = evaluateFloorCoverage(mk({ ...base, 'x/count': { n: 10, caught: 1 } }), tables);
  check('a count floor below its minimum fails', f.some((s) => s.startsWith('x/count:') && s.includes('below the declared minimum')));
}

// F. a family both floored and acknowledged is a contradiction and fails.
{
  const f = evaluateFloorCoverage(mk(base), { ...tables, knownUnfloored: new Set(['x/known', 'x/rate']) });
  check('a family in both a floor table and GUARD_KNOWN_UNFLOORED fails',
    f.some((s) => s.startsWith('x/rate:') && s.includes('AND a floor table')));
}

// G. the REAL exported config is coherent: with every real family at a safe value,
//    there are no failures — and flipping one real acknowledged family to caught>0
//    fails, tying this test to the production allowlist, not just the synthetic one.
{
  const real = {};
  for (const [fam, floor] of Object.entries(GUARD_FLOORS)) real[fam] = { n: 10, caught: Math.ceil(floor * 10) + 1 };
  for (const [fam, min] of Object.entries(GUARD_MIN_CATCHES)) real[fam] = { n: 100, caught: min };
  for (const fam of GUARD_KNOWN_UNFLOORED) real[fam] = { n: 12, caught: 0 };
  check('the real production config is internally coherent (0 failures at safe values)',
    evaluateFloorCoverage(mk(real)).length === 0);

  const oneKnown = [...GUARD_KNOWN_UNFLOORED][0];
  const drifted = mk({ ...real, [oneKnown]: { n: 12, caught: 1 } });
  check(`flipping real acknowledged family ${oneKnown} to caught>0 fails`,
    evaluateFloorCoverage(drifted).some((s) => s.startsWith(`${oneKnown}:`) && s.includes('now catches')));
}

if (failed) {
  console.error(`\nFB-5b floor-coverage enforcement: ${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nACCOUNTING: FB-5b floor-coverage enforcement — 8/8 checks passed; no-silent-no-floor is load-bearing in both drift directions.');
process.exit(0);
