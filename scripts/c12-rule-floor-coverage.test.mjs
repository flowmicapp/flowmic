// scripts/c12-rule-floor-coverage.test.mjs
//
// C12 option B — floors on the RULE axis — and D2-ii — translate/prompt_injection
// moved off a rate floor onto a count floor. Both are owner rulings, 2026-08-12,
// docs/decisions/owner-web-rulings/latest.md 「质量底线」:
//   「B · 给「规则」加底线（不改产品代码，误杀风险最低）」  (option value `B`)
//   「改成条数底线（至少抓到 4 条）」                        (option value `switch_count`)
//
// Discovered automatically by scripts/run-script-tests.mjs (verify:delivery runs
// it); exit 0 PASS / 1 FAIL / 2 SKIP, the scripts/*.test.mjs convention.
//
// 🔴 WHY THIS EXISTS. `run-eval.mjs --mode=guard` only ever runs the CURRENT
// config, in which every rule sits at or above its floor — so it never exercises
// a single drift direction of the checker it now depends on. A gate that only
// runs the happy config proves the config passes, not that the enforcement is
// load-bearing. So the decision was pulled out as the pure `evaluateRuleCoverage`
// and this file drives it with synthetic data, one case per drift direction.
//
// 🔴 WHY A SIBLING FILE RATHER THAN MORE CASES IN fb5b-floor-coverage.test.mjs.
// run-script-tests.mjs suppresses a passing child's stdout and re-surfaces
// exactly ONE line per file — the one beginning `ACCOUNTING:`. Folding this axis
// into the FB-5b file would merge two accounts into one line, and the rule-axis
// account would then be legible only to someone who already knew to look for it.
// That is the W2-14 shape this corpus has already paid for once. A separate file
// buys a separate account for nothing, discovery is a glob so there is no
// registration step to forget, and the two files test two different functions
// with two different rationales (family axis / rule axis).

import { evaluateFloorCoverage, GUARD_FLOORS, GUARD_MIN_CATCHES } from '../verify/eval/eval-guard.mjs';
import {
  evaluateRuleCoverage,
  GUARD_RULE_MIN_CATCHES,
  GUARD_KNOWN_UNFLOORED_RULES,
} from '../verify/eval/eval-guard-rule-floors.mjs';
import { evaluateRuleCoverage as reExported } from '../verify/eval/eval-guard.mjs';

let failed = 0;
let ran = 0;
// `ran` is COUNTED, not written into the summary by hand. A hand-maintained total
// is a second copy of a fact the code already knows, and it drifts the first time
// someone adds a case without updating it — this file's own first run printed
// "17/17" for 18 checks.
const check = (name, cond) => {
  ran += 1;
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); failed += 1; }
};

/** byRule is a Map of rule name → catch count. Sparse: a rule that caught nothing has no key. */
const mkRule = (obj) => new Map(Object.entries(obj));
/** byFam is the other shape — kept here only for the D2-ii ruler comparison below. */
const mkFam = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, { n: v.n, caught: v.caught, falseReject: 0 }]));

// ── synthetic tables, so the mechanism is tested in isolation from the real corpus ──
const tables = {
  ruleMinCatches: { alpha_rule: 5, beta_rule: 2 },
  knownUnflooredRules: new Set(['gamma_rule']),
};
const base = { alpha_rule: 7, beta_rule: 2, gamma_rule: 1 };

// A. the coherent baseline: every rule that fired is floored or acknowledged.
check('baseline config produces no failures', evaluateRuleCoverage(mkRule(base), tables).length === 0);

// B. 🔴 DRIFT DIRECTION (a) — a floored rule producing FEWER catches than its floor.
{
  const f = evaluateRuleCoverage(mkRule({ ...base, alpha_rule: 4 }), tables);
  check('a rule below its declared minimum fails',
    f.some((s) => s.startsWith('alpha_rule:') && s.includes('below the declared minimum of 5')));
}

// B2. the same direction taken all the way: the rule stops firing entirely, so it
//     VANISHES from the sparse map. Absent must read as a breach at 0, not as a
//     missing-instrument note — on this axis absence is the regression itself.
{
  const gone = mkRule({ beta_rule: 2, gamma_rule: 1 });
  const f = evaluateRuleCoverage(gone, tables);
  check('a floored rule that fired ZERO times (absent from byRule) fails as a breach at 0',
    f.some((s) => s.startsWith('alpha_rule:') && s.includes('fired on 0 golden_bad') && s.includes('ZERO times')));
}

// C. 🔴 DRIFT DIRECTION (b) — a rule that fires but is in NEITHER table.
//    This is the no-silent-no-floor half; it is what will fire the day the guard
//    grows a new rule, and it is the reason GUARD_KNOWN_UNFLOORED_RULES exists
//    while being empty.
{
  const f = evaluateRuleCoverage(mkRule({ ...base, delta_rule: 3 }), tables);
  check('a newly-firing rule with no floor and no acknowledgement fails',
    f.some((s) => s.startsWith('delta_rule:') && s.includes('NOT in GUARD_KNOWN_UNFLOORED_RULES')));
}

// D. 🔴 THE THIRD DIRECTION, IN THE ONLY FORM THAT IS COHERENT ON THIS AXIS.
//    evaluateFloorCoverage fails an acknowledged FAMILY the guard STARTS catching.
//    That does not transfer: `byRule` is written only on a catch, so an unfloored
//    rule is by construction already firing and "it started" has no observable
//    moment. The mirror image does transfer and is what is asserted — an
//    acknowledged rule that STOPS firing leaves its acknowledgement watching
//    nothing. (Full reasoning in evaluateRuleCoverage's doc comment.)
{
  const f = evaluateRuleCoverage(mkRule({ alpha_rule: 7, beta_rule: 2 }), tables);
  check('an acknowledged rule that stopped firing fails (the acknowledgement watches nothing)',
    f.some((s) => s.startsWith('gamma_rule:') && s.includes('watching nothing')));
}

// D2. positive control for D — without it, D would also pass if the check simply
//     reddened on every acknowledged rule. An acknowledged rule that IS firing
//     must produce nothing.
check('an acknowledged rule that IS still firing produces no failure (positive control for D)',
  evaluateRuleCoverage(mkRule(base), tables).length === 0);

// E. a rule in both tables is a contradiction: a breach would read two ways.
{
  const f = evaluateRuleCoverage(mkRule(base), { ...tables, knownUnflooredRules: new Set(['gamma_rule', 'alpha_rule']) });
  check('a rule in both GUARD_RULE_MIN_CATCHES and GUARD_KNOWN_UNFLOORED_RULES fails',
    f.some((s) => s.startsWith('alpha_rule:') && s.includes('one or the other')));
}

// F. 🔴 a floor of 0 is refused STRUCTURALLY, not by remembering the rule.
//    eval-guard.mjs already writes why ("A floor of 0 would make the mode
//    incapable of failing, which is the same as not having it"); on this axis it
//    is worse, because a 0-catch rule has no key at all, so a 0 floor would be a
//    floor on an absent key — permanently and silently satisfied.
{
  const f = evaluateRuleCoverage(mkRule(base), { ...tables, ruleMinCatches: { ...tables.ruleMinCatches, zeroed: 0 } });
  check('a declared floor of 0 fails instead of quietly passing',
    f.some((s) => s.startsWith('zeroed:') && s.includes('cannot fail')));
}

// G. the REAL exported config is coherent, and is really what the gate uses.
//    Ties this drill to the production tables rather than only the synthetic one.
{
  const real = mkRule(Object.fromEntries(Object.entries(GUARD_RULE_MIN_CATCHES).map(([r, n]) => [r, n])));
  for (const r of GUARD_KNOWN_UNFLOORED_RULES) real.set(r, 1);
  check('the real production rule config is internally coherent (0 failures at its declared values)',
    evaluateRuleCoverage(real).length === 0);

  const [firstRule, firstMin] = Object.entries(GUARD_RULE_MIN_CATCHES)[0];
  const drifted = new Map(real);
  drifted.set(firstRule, firstMin - 1);
  check(`dropping real rule ${firstRule} by one catch fails`,
    evaluateRuleCoverage(drifted).some((s) => s.startsWith(`${firstRule}:`) && s.includes('below the declared minimum')));

  check('every real rule floor is >= 1 (no fake supervision in the shipped table)',
    Object.values(GUARD_RULE_MIN_CATCHES).every((n) => Number.isInteger(n) && n >= 1));

  // The split put these symbols in eval-guard-rule-floors.mjs and re-exported them
  // from eval-guard.mjs. Assert the re-export is the same binding, so an importer
  // using the old path cannot silently get a different (or absent) function.
  check('eval-guard.mjs re-exports the same evaluateRuleCoverage binding', reExported === evaluateRuleCoverage);
}

// ── D2-ii: translate/prompt_injection, rate floor → count floor ──────────────
{
  check('translate/prompt_injection has left GUARD_FLOORS (the rate table)',
    !('translate/prompt_injection' in GUARD_FLOORS));
  check("translate/prompt_injection is floored at the owner's literal 4 catches",
    GUARD_MIN_CATCHES['translate/prompt_injection'] === 4);

  // 🔴 THE POINT OF THE MOVE, as a differential on one synthetic reading. 4/14 is
  // "three more hard cases were added to this family and the guard did not
  // change". The old ruler calls that a regression; the new one does not.
  const noOtherTables = { knownUnfloored: new Set() };
  const grown = mkFam({ 'translate/prompt_injection': { n: 14, caught: 4 } });
  const oldRuler = evaluateFloorCoverage(grown, { ...noOtherTables, floors: { 'translate/prompt_injection': 0.3 }, minCatches: {} });
  const newRuler = evaluateFloorCoverage(grown, { ...noOtherTables, floors: {}, minCatches: { 'translate/prompt_injection': 4 } });
  check('the OLD 0.3 rate floor reddens for corpus growth alone (4/14 = 29%, guard unchanged)',
    oldRuler.some((s) => s.startsWith('translate/prompt_injection:') && s.includes('fell below')));
  check('the NEW count floor does not — same catches, bigger corpus, still green',
    newRuler.length === 0);

  // ⚠️ THE COST, ASSERTED RATHER THAN ONLY WRITTEN DOWN. A count floor is blind to
  // dilution: 4/40 is 10% coverage and it stays green. This assertion exists so
  // that trade-off is a measured property of the gate, not a sentence in a comment
  // that nothing checks.
  const diluted = evaluateFloorCoverage(
    mkFam({ 'translate/prompt_injection': { n: 40, caught: 4 } }),
    { ...noOtherTables, floors: {}, minCatches: { 'translate/prompt_injection': 4 } },
  );
  check('COST, asserted not hidden: the count floor CANNOT see coverage diluted to 4/40', diluted.length === 0);

  // and it still reddens for the event it exists to report: the guard catching less.
  const regressed = evaluateFloorCoverage(
    mkFam({ 'translate/prompt_injection': { n: 11, caught: 3 } }),
    { ...noOtherTables, floors: {}, minCatches: { 'translate/prompt_injection': 4 } },
  );
  check('the count floor still reddens when the GUARD catches one fewer (3/11)',
    regressed.some((s) => s.includes('below the declared minimum of 4')));
}

if (failed) {
  console.error(`\nC12 rule-floor enforcement: ${failed} of ${ran} check(s) failed.`);
  process.exit(1);
}
console.log(`\nACCOUNTING: C12 rule-axis floors — ${ran}/${ran} checks passed; the rule axis is load-bearing in all three coherent drift directions, and translate/prompt_injection is pinned at 4 catches (owner 2026-08-12) with its dilution blind spot asserted.`);
process.exit(0);
