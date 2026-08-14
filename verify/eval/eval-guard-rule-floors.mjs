// verify/eval/eval-guard-rule-floors.mjs
//
// The RULE axis of the compose-guard floor family (card C12 / A2-2, owner-ruled
// 2026-08-12: "B · add a floor to the rules (do not change product code; lowest false-kill risk)").
//
// Split out of eval-guard.mjs the moment that file crossed the 800-line cap. The
// repo's standing answer to that cap is a STRUCTURAL SPLIT, never trimming the
// reasoning that explains why a number is the number it is — eval-guard.mjs is
// itself the product of one such split out of run-eval.mjs. Nothing below changed
// in the move, and eval-guard.mjs re-exports all three symbols, so an existing
// `import … from './eval-guard.mjs'` keeps working.
//
// The FAMILY axis (GUARD_FLOORS / GUARD_MIN_CATCHES / GUARD_KNOWN_UNFLOORED and
// evaluateFloorCoverage) deliberately stays in eval-guard.mjs: it is read next to
// the corpus loop that builds `byFam`. This file is read next to `byRule`, which
// is one line of that same loop.

/**
 * ── A SECOND AXIS: floors on the RULE, not on the family (card C12 / A2-2) ────
 *
 * owner ruling 2026-08-12, docs/decisions/owner-web-rulings/latest.md "quality floor":
 * "B · add a floor to the rules (do not change product code; lowest false-kill risk)". This table is that ruling.
 * Options page: docs/strategy/2026-08-12-c12-floor-family-design-options.md §5-B.
 *
 * 🔴 WHAT IT WATCHES THAT THE FAMILY TABLES CANNOT. The two tables above are keyed
 * by `suite/family`; they answer "did some family lose catches". This one is keyed
 * by the RULE that fired, and answers "did a rule stop firing". Those are
 * different questions, and GUARD-1 is this repo's own measured proof that the
 * difference bites: amplifying DENSE_SHORT_EXPANSION ×1e9 left
 * `translate/short_idiom` — the floor whose comment claimed to be guarding it —
 * completely UNMOVED, and reddened the adjacent `translate/short_fragment`
 * instead (the full account is in the GUARD-1 note in GUARD_MIN_CATCHES above).
 * A family floor can only ever report "somewhere in here, N fewer". The rule axis
 * names the mechanism that changed.
 *
 * 🔴 IT ALSO CLOSES A CONCENTRATION BLIND SPOT. `volume_runaway` alone produces 59
 * of the 73 catches on this corpus — 81%. If that one rule went dark, whether the
 * remaining family floors would add up to a breach is UNPROVEN; nobody has
 * measured it, and this file's own header already records that this gate is
 * "mainly a length gate, not a semantic gate". This table needs no such proof:
 * the rule's own count is floored, so it reddens directly.
 *
 * ⚠️ ORTHOGONAL, NOT A REPLACEMENT. A rule floor cannot see "this family is now
 * being caught by a DIFFERENT rule" — the family axis can, and only it can.
 * Neither table subsumes the other. This is an added axis, not a migration, and
 * nothing above was weakened to make room for it.
 *
 * 🔴 WHY COUNTS AND NOT RATES — do not re-derive a second reason; the one that
 * applies is already written above under "WHY COUNTS AND NOT RATES" in
 * GUARD_MIN_CATCHES. A rate divides by a corpus that is actively growing, so a
 * rate floor goes red for corpus growth with nothing having regressed, and a gate
 * that reddens for reasons unrelated to the commit is a gate people stop reading
 * (CLAUDE.md: G12 sat red for a day). Counts are immune here for the same reason
 * they are on the family axis, and slightly more strongly: every caught case
 * increments exactly ONE rule, so adding cases can only ever raise these numbers.
 *
 * ⚠️ NO HEADROOM, ON PURPOSE — and this is the one place the options page is wrong
 * about this repo's convention. §5-B says "take the measured value and round down per precedent" and
 * illustrates `volume_runaway ≥ 55` against a measured 59. There is no such
 * convention for COUNT floors here. All seven pre-existing GUARD_MIN_CATCHES
 * entries are their measured value EXACTLY (2/12→2, 3/14→3, 1/11→1, 10/12→10,
 * 3/11→3, 10/11→10, 10/13→10), and eval-selftest.mjs states the rule outright for
 * its own count table: "Deliberately NOT rounded down, unlike GUARD_FLOORS in
 * eval-guard.mjs … these are small integer COUNTS whose only meaningful rounding
 * is to zero, which would delete the property being guarded." Rounding DOWN is
 * the RATE convention and it exists to absorb a growing denominator that counts
 * do not have. Slack in a count floor is not a safety margin — it is precisely
 * the size of the regression the floor has agreed not to notice.
 *
 * 🔴 A BREACH HERE HAS TWO POSSIBLE CAUSES, AND BOTH ARE GUARD CHANGES. Either the
 * rule stopped firing, or another rule now claims those cases first — each catch
 * is attributed to exactly one rule, whichever the guard names. The second cause
 * is INVISIBLE to the family axis, because the family total does not move at all.
 * Read the message, then diff the guard; do not assume the first cause.
 *
 * 🔴 THESE NUMBERS WILL FIGHT A LEGITIMATE FUTURE LOOSENING, ON PURPOSE — same as
 * GUARD_MIN_CATCHES, same correct response: re-measure and move them in the SAME
 * commit as the loosening, so the cost is recorded instead of absorbed. Deleting
 * the table is not the correct response.
 *
 * Measured 2026-08-12 on dev-pc-b, tree at 3e50610, via
 * `node verify/eval/run-eval.mjs --mode=guard`: 193 cases, 0 false rejects, 73
 * caught. The six counts below sum to 73, and that identity is worth preserving —
 * it means this table accounts for every catch the family tables count, so a rule
 * cannot be dropped from it without the sum saying so.
 */
export const GUARD_RULE_MIN_CATCHES = {
  volume_runaway: 59,
  assistant_frame: 5,
  invented_latin_tokens: 3,
  target_script_absent: 2,
  untranslated_echo: 2,
  invented_numerals: 2,
};

/**
 * The rule-axis counterpart of GUARD_KNOWN_UNFLOORED: rules permitted to fire with
 * no floor, named explicitly, so a NEW rule cannot arrive unwatched.
 *
 * EMPTY TODAY — a measurement, not an omission. All six rules that fire on this
 * corpus catch >= 2 cases, so every one of them can carry a real floor and none
 * needs acknowledging. The set exists anyway because it is the half of "no silent
 * no-floor" that does the enforcing: a rule listed in neither table reddens the
 * gate. That is what will happen the day the guard grows a new rule, by design —
 * the new rule arrives with a measured floor, or with a written acknowledgement,
 * in the commit that adds it.
 *
 * 🔴 A FLOOR OF 0 IS NOT THE WAY TO USE THIS SET. That is the fake supervision
 * GUARD_FLOORS' own comment refuses: "A floor of 0 would make the mode incapable
 * of failing, which is the same as not having it." On this axis the trap is
 * sharper still — a rule with zero catches has NO KEY in `byRule` at all, so a
 * 0 floor would be a floor on an absent key: permanently, silently satisfied.
 * evaluateRuleCoverage rejects any declared floor below 1 outright rather than
 * leaving that as a rule someone has to remember.
 */
export const GUARD_KNOWN_UNFLOORED_RULES = new Set([]);

/**
 * The rule-coverage decision, as a PURE function for the same reason
 * evaluateFloorCoverage is one: the drift directions have to be provable without
 * a corpus run, because a gate that only ever runs the current happy config never
 * exercises any of them. `byRule` is a Map of rule name → number of golden_bad it
 * caught; the return is the list of failure strings, empty when every rule that
 * fired is either floored or explicitly acknowledged. Tables are injectable so a
 * drill can drive synthetic data instead of mutating this module's constants.
 *
 * ⚠️ `byRule` IS SPARSE, AND THAT CHANGES WHAT "ABSENT" MEANS. It is written only
 * inside `if (!bad.ok)` in guardMode below, so a rule that catches nothing has no
 * key. On the family axis an absent key means "this family is not in the corpus"
 * — an instrument problem, reported as "the floor is watching nothing". Here it
 * means "this rule caught zero" — a real coverage loss. So a declared floor with
 * no key is reported as a BREACH AT 0, not as a missing family.
 *
 * 🔴 THE THIRD DRIFT DIRECTION OF evaluateFloorCoverage DOES NOT TRANSFER
 * LITERALLY, and asserting it anyway would be the worse error. There, a family
 * acknowledged as unflorable that the guard STARTS catching is a failure, and it
 * can be: `byFam` holds an entry for every case whether caught or not, so a
 * 0-catch family is observable and "it started catching" is a detectable moment.
 * Here there is no such moment — an unfloored rule is BY CONSTRUCTION one that is
 * already firing, otherwise it would have no key to be unfloored on. Writing that
 * check would produce an assertion that can never fire, which is the shape of
 * supervision this whole file exists to refuse.
 * What DOES transfer is the mirror image, and it IS implemented below: a rule
 * acknowledged as unfloored that STOPS firing vanishes from the map, and its
 * acknowledgement is then watching nothing.
 */
export function evaluateRuleCoverage(
  byRule,
  { ruleMinCatches = GUARD_RULE_MIN_CATCHES, knownUnflooredRules = GUARD_KNOWN_UNFLOORED_RULES } = {},
) {
  const failures = [];
  for (const [rule, min] of Object.entries(ruleMinCatches)) {
    if (knownUnflooredRules.has(rule)) continue; // the contradiction is reported once, in the last loop
    if (!(min >= 1)) {
      failures.push(
        `${rule}: declared floor of ${min} — a floor below 1 cannot fail, which is the same as not having it,`
        + ` and worse because it LOOKS like supervision. A rule that no longer fires belongs in`
        + ` GUARD_KNOWN_UNFLOORED_RULES with a written reason, not at floor 0.`,
      );
      continue;
    }
    const n = byRule.get(rule) ?? 0;
    if (n < min) {
      failures.push(
        `${rule}: fired on ${n} golden_bad, below the declared minimum of ${min}.`
        + (n === 0 ? ' It fired ZERO times — deleted, renamed, or no longer firing on anything in the corpus.' : '')
        + ' Corpus growth cannot cause this. Either the guard stopped firing this rule, or another rule now'
        + ' claims these cases first (each catch increments exactly one rule) — the second is invisible to the'
        + ' family floors. Diff the guard, then re-measure and move this number in the same commit.',
      );
    }
  }
  for (const [rule, n] of byRule.entries()) {
    if (rule in ruleMinCatches) continue;
    if (!knownUnflooredRules.has(rule)) {
      failures.push(
        `${rule}: fired ${n} time(s) but has no floor and is NOT in GUARD_KNOWN_UNFLOORED_RULES.`
        + ' Add the measured count to GUARD_RULE_MIN_CATCHES, or acknowledge it there with a reason.'
        + ' A rule nothing watches is the FB-5b anti-pattern on the rule axis.',
      );
    }
  }
  for (const rule of knownUnflooredRules) {
    if (rule in ruleMinCatches) {
      failures.push(`${rule}: in GUARD_KNOWN_UNFLOORED_RULES AND GUARD_RULE_MIN_CATCHES — one or the other, or a breach reads two ways.`);
      continue;
    }
    if (!byRule.has(rule)) {
      failures.push(
        `${rule}: acknowledged as unfloored but it fired ZERO times on this corpus — the acknowledgement is watching nothing.`
        + ' Either the rule was deleted or renamed (drop the entry), or it stopped firing — and that is the regression'
        + ' this axis exists to report.',
      );
    }
  }
  return failures;
}
