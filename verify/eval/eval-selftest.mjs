// verify/eval/eval-selftest.mjs
//
// --mode=selftest: validates THE RULER. Extracted VERBATIM from run-eval.mjs in
// the 800-line split. See run-eval.mjs's header for why the resident gate runs
// this mode and not the live one.

import { judgeCase, JUDGE_NAMES } from './judges/index.mjs';
import { SUITES } from './eval-paths.mjs';
import { schemaProblems } from './eval-corpus.mjs';
// ---------------------------------------------------------------------------
// selftest
// ---------------------------------------------------------------------------

/**
 * SOLE-REJECTER FLOORS — the property that says a judge discriminates anything.
 *
 * A judge's SOLE-REJECTER COUNT is the number of `golden_bad` cases where it is
 * the ONLY judge that rejects. It is exactly equivalent to "delete this judge
 * and that many golden_bad cases start passing", because a case whose only
 * rejecter is removed has no rejecter left. A judge whose count is 0 can be
 * deleted outright with the selftest still fully green — it is decorative, and
 * nothing in this repo would notice.
 *
 * 🔴 WHY THE `judge coverage` TABLE CANNOT ANSWER THIS. That table counts TOTAL
 * rejections, and total rejections is precisely the view that made
 * `must_contain_any` look healthy at 102 while its sole-rejecter count was 0 —
 * every one of those 102 cases was also caught by something else. A big number
 * in a column that cannot go to zero is not supervision. Both columns are
 * printed below, side by side, so the difference is legible rather than
 * inferable.
 *
 * 🔴 AND WHY THE SELFTEST ITSELF CANNOT. When a judge becomes decorative the
 * selftest stays GREEN: the case is still rejected — by somebody else. That is
 * the whole reason this needs its own floor. The rot is invisible to the very
 * check it degrades.
 *
 * MEASURED 2026-08-07 on dev-pc-a. The run is deterministic (no clock, no
 * network, no randomness) and was repeated three times with identical output.
 *
 * ⚠️ THE CORPUS MOVED WHILE THIS WAS BEING MEASURED, REPEATEDLY — another lane
 * was adding cases to verify/eval/cases/*.jsonl throughout this window (realtime
 * 57 → 70; total 262 → 275 → 276, and it may well have moved again by the time
 * you read this). Each number below is therefore the MINIMUM across every state
 * observed, not the reading from whichever run happened to be last. That is the
 * conservative direction and it is safe in a specific, checkable way: ADDING
 * cases can only
 * raise a sole-rejecter count, never lower it, so a floor that held on the
 * smaller corpus holds on the larger one too. It also means this table cannot go
 * red because of somebody else's in-flight work — only an EDIT or DELETION of an
 * existing case, or a real weakening of a judge, can breach it. The two readings
 * differed in exactly two places: `coverage` 2 → 3 and `expect_punctuation`
 * 1 → 2; both are recorded here at the lower value.
 *
 * ⚠️ Deliberately NOT rounded down, unlike GUARD_FLOORS in eval-guard.mjs. That
 * table holds RATES over a corpus that grows, so rounding absorbs churn; these
 * are small integer COUNTS whose only meaningful rounding is to zero, which
 * would delete the property being guarded.
 *
 * 🔴 A CORRECTION TO THE LEDGER, MEASURED RATHER THAN QUOTED. Both
 * `docs/strategy/2026-08-06-w2-transcription-quality-ledger.md` §7 (W2-11, "7 of
 * 11 judges have a sole-rejecter count of 0") and
 * `2026-08-06-w25-closing-the-two-red-lines-ledger.md` §8 (which re-counted and
 * corrected it to 8, adding `expect_punctuation`) report a large number of
 * decorative judges. TODAY THAT IS FALSE: all 11 declared judges have a
 * sole-rejecter count of at least 1. Both ledger numbers were true when written.
 * Re-measured across this corpus's own history, same method, same machine:
 *
 *   6a72a3f 250 cases → 8 decorative   (expect_punctuation, expect_segments,
 *   3e2e70e 250 cases → 8               max_len_ratio, must_contain_any,
 *   3bafc96 250 cases → 8               no_new_latin_tokens, no_new_numerals,
 *   33ff014 250 cases → 8               preserve_illocution, required_fragments)
 *   8001bff 258 cases → 0  ← "fix(eval): close four ruler accounts"
 *   8418894 262 cases → 0
 *   a980e23 + uncommitted lane work, 2026-08-07: 275 and then 276 cases → 0
 *           (written as a dated reading, not as "HEAD": HEAD is a moving
 *            target and this line would otherwise be stale within the hour —
 *            which is the very failure this whole block is documenting)
 *
 * The account was closed by the very next commit after the measurement, and the
 * ledger never got the update — this repo's own "stale truth" shape, where a
 * sentence that was true stays on the page long enough to be quoted as current.
 * THE POINT OF THIS TABLE IS THAT THE CLOSURE IS NOW MECHANISED: those eight
 * judges are one edited case away from becoming decorative again, and seven of
 * the twelve entries below sit at exactly 1 — the thinnest possible margin.
 */
const SOLE_REJECTER_FLOORS = {
  must_not_contain: 46,
  no_duplication: 4,
  coverage: 2,
  max_len_ratio: 1,
  must_contain_any: 1,
  preserve_illocution: 1,
  required_fragments: 1,
  no_new_numerals: 1,
  no_new_latin_tokens: 1,
  expect_punctuation: 1,
  expect_segments: 1,
  // Not a BY_SUITE judge: `empty` is judgeCase's own early return for blank
  // output. Floored anyway because it rots identically — `mg-ctrl-005`'s
  // golden_bad is the empty string, and if that one case were edited to be
  // non-empty the whole empty-output path would stop being exercised with
  // nothing to say so. Excluded from the count guard below for the same reason
  // it is listed here: it is real, but it is not in JUDGE_NAMES.
  empty: 1,
};

/**
 * A judge that never fires at all has a sole-rejecter count of 0 and would be
 * caught by its floor — but only if it HAS a floor. A judge added to
 * judges/index.mjs and never added here would be unwatched from birth.
 *
 * So: count guard, the same shape as the protocol's event-count guard. The judge
 * list is DISCOVERED (`JUDGE_NAMES`, built from `BY_SUITE` by the judges module
 * itself) and compared against this hand-kept table. CLAUDE.md records the
 * counter-example this mirrors: `verify:lint` walks the directory while
 * `bump-version.mjs`'s FACES table is hand-maintained, so a new workspace
 * package is green the day it is added and only goes red at the NEXT bump.
 * Comparing a discovered mechanism against a hand-kept one is what stops that
 * drift here.
 *
 * Names are deliberately NOT mapped between the two sides. `JUDGE_NAMES` holds
 * FUNCTION names (`containsAnyJudge`) and failures carry RULE names
 * (`must_contain_any`); a mapping table here would be a second copy of a fact
 * that lives in judges/index.mjs, and it would drift. The COUNT is the part that
 * can be compared without duplicating anything.
 */
const DECLARED_JUDGE_FNS = new Set(Object.values(JUDGE_NAMES).flat());

function selftest(loaded) {
  const all = loaded.flatMap((l) => l.cases);
  const problems = [];
  for (const l of loaded) if (l.error) problems.push(`${l.suite}: ${l.error}`);
  problems.push(...schemaProblems(all));

  let goodFails = 0;
  let badPasses = 0;
  const detail = [];
  const byJudge = new Map();
  const soleByJudge = new Map();
  const soleCases = new Map();

  for (const k of all) {
    const g = judgeCase(k, k.golden_good);
    if (!g.ok) {
      goodFails += 1;
      detail.push(`  ✗ ${k.id} [${k.family}] golden_good REJECTED by ${g.failures.map((f) => f.judge).join('+')}`);
      for (const f of g.failures) detail.push(`      ${f.judge}: ${f.detail}`);
    }
    const b = judgeCase(k, k.golden_bad);
    if (b.ok) {
      badPasses += 1;
      detail.push(`  ✗ ${k.id} [${k.family}] golden_bad ACCEPTED — this case cannot detect its own failure mode`);
    } else {
      // De-duplicated per judge: a judge that returned two failures for one case
      // is still ONE judge rejecting it, and the sole-rejecter test below asks
      // how many DISTINCT judges rejected. Measured 2026-08-07: no judge in
      // judges/index.mjs returns more than one failure today, so this changes
      // none of the totals — it stops the two columns from disagreeing if one
      // ever does.
      const names = [...new Set(b.failures.map((f) => f.judge))];
      for (const n of names) byJudge.set(n, (byJudge.get(n) ?? 0) + 1);
      if (names.length === 1) {
        soleByJudge.set(names[0], (soleByJudge.get(names[0]) ?? 0) + 1);
        if (!soleCases.has(names[0])) soleCases.set(names[0], []);
        soleCases.get(names[0]).push(k.id);
      }
    }
  }

  // ── the sole-rejecter gate ────────────────────────────────────────────────
  const soleFailures = [];
  const decorative = [];
  for (const [judge, floor] of Object.entries(SOLE_REJECTER_FLOORS)) {
    const got = soleByJudge.get(judge) ?? 0;
    if (got === 0) {
      decorative.push(judge);
      soleFailures.push(
        `${judge}: sole-rejecter count 0 (floor ${floor}) — DECORATIVE. Deleting this judge`
        + ` entirely would leave this selftest fully green, so nothing proves it discriminates`
        + ` anything. Either a case that depended on it alone was edited or removed, or the`
        + ` judge stopped firing. Do NOT resolve this by lowering the floor.`,
      );
    } else if (got < floor) {
      soleFailures.push(
        `${judge}: sole-rejecter count fell ${floor} → ${got}. A case that used to depend on`
        + ` this judge alone no longer does. That is either a real weakening or a deliberate`
        + ` corpus edit; if deliberate, re-measure and move the floor in the SAME commit.`,
      );
    }
  }
  // A judge that fires but has no floor is unwatched, and would stay unwatched.
  for (const judge of soleByJudge.keys()) {
    if (!(judge in SOLE_REJECTER_FLOORS)) {
      soleFailures.push(`${judge}: rejects cases but has no declared floor in SOLE_REJECTER_FLOORS — measure it and write the number down`);
    }
  }
  // Count guard against the DISCOVERED judge list — see DECLARED_JUDGE_FNS.
  const flooredJudges = Object.keys(SOLE_REJECTER_FLOORS).filter((j) => j !== 'empty');
  if (DECLARED_JUDGE_FNS.size !== flooredJudges.length) {
    soleFailures.push(
      `judges/index.mjs declares ${DECLARED_JUDGE_FNS.size} judge(s) but SOLE_REJECTER_FLOORS`
      + ` covers ${flooredJudges.length} (excluding the judgeCase-level 'empty' guard) — a judge`
      + ` was added or removed without its sole-rejecter count being measured and declared`,
    );
  }

  const perSuite = SUITES.map((s) => `${s}=${all.filter((k) => k.suite === s).length}`).join(' ');
  const families = new Set(all.map((k) => `${k.suite}/${k.family}`));

  console.log(`corpus: ${all.length} cases (${perSuite}), ${families.size} adversarial families`);
  console.log(`judge coverage on golden_bad — SOLE = cases where this judge is the ONLY rejecter`);
  console.log(`(sole 0 ⇒ the judge can be deleted with this selftest still green; total cannot show that)`);
  console.log(`    sole  total  floor  judge`);
  const judgeRows = [...new Set([...byJudge.keys(), ...Object.keys(SOLE_REJECTER_FLOORS)])];
  for (const j of judgeRows.sort((a, b) => (byJudge.get(b) ?? 0) - (byJudge.get(a) ?? 0))) {
    const sole = soleByJudge.get(j) ?? 0;
    const floor = SOLE_REJECTER_FLOORS[j];
    const mark = sole === 0 || (floor !== undefined && sole < floor) ? '  🔴' : '';
    console.log(`    ${String(sole).padStart(4)}  ${String(byJudge.get(j) ?? 0).padStart(5)}  ${String(floor ?? '—').padStart(5)}  ${j}${mark}`);
  }
  console.log(
    decorative.length === 0
      ? `    ⇒ 0 decorative judge(s): every judge is the last line of defence on at least one case.`
      : `    ⇒ 🔴 ${decorative.length} DECORATIVE judge(s): ${decorative.join(', ')}`,
  );

  if (soleFailures.length) {
    console.log(`\n🔴 ${soleFailures.length} sole-rejecter floor breach(es) — a judge stopped discriminating:`);
    for (const f of soleFailures) console.log(`  ✗ ${f}`);
    // The ids are the audit trail: which case each judge is carrying alone, so a
    // reader can go and look instead of taking the count on faith.
    for (const [j, ids] of [...soleCases.entries()].sort()) {
      console.log(`      ${j} is the sole rejecter of: ${ids.slice(0, 8).join(' ')}${ids.length > 8 ? ` … +${ids.length - 8}` : ''}`);
    }
  }

  if (problems.length) {
    console.log(`\nschema problems (${problems.length}):`);
    for (const p of problems.slice(0, 40)) console.log(`  ✗ ${p}`);
    if (problems.length > 40) console.log(`  … ${problems.length - 40} more`);
  }
  if (detail.length) {
    console.log(`\ndiscrimination failures (${goodFails} good rejected, ${badPasses} bad accepted):`);
    for (const d of detail.slice(0, 120)) console.log(d);
    if (detail.length > 120) console.log(`  … ${detail.length - 120} more lines`);
  }

  const ok = problems.length === 0 && goodFails === 0 && badPasses === 0 && soleFailures.length === 0;
  // 🔴 The sole-rejecter result rides the ACCOUNTING line deliberately, not just
  // the block above. scripts/run-script-tests.mjs suppresses a passing child's
  // stdout entirely and re-surfaces exactly one line — the one starting
  // `ACCOUNTING:` — so anything printed elsewhere is invisible on the green path,
  // which is every normal run. That is the W2-14 shape (a block whose comment
  // said "printed every run" while the caller echoed it only on failure), and
  // repeating it inside the gate built to catch façades would be a joke at our
  // own expense. If this summary is ever moved off this line, it goes dark.
  const nFloors = Object.keys(SOLE_REJECTER_FLOORS).length;
  const soleSummary = soleFailures.length
    ? `🔴 ${soleFailures.length} sole-rejecter breach(es)`
    : `sole-rejecter floors ${nFloors}/${nFloors} met, 0 decorative judge(s)`;
  console.log(`\nACCOUNTING: sections run ${all.length}/${all.length} cases; ${goodFails} golden_good rejected, ${badPasses} golden_bad accepted; ${soleSummary}`);
  return ok;
}
export { selftest };
