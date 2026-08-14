// The expansion/compression budget for the compose output guard.
//
// 800-line cap (`verify/lint/file-size.mjs` SRC_MAX): `output-guard.ts` was at
// 795 lines, so the section it already titled 「─── volume thresholds ───」 moved
// out whole. Same method as the earlier `output-guard-text.ts` split — the cut
// follows a section header the file had drawn itself, not one invented for the
// occasion.
//
// 🔴 WHAT MOVED VERBATIM AND WHAT DID NOT — stated per declaration rather than
// as one blanket claim, because a blanket claim is the thing that rots:
//   · `VOLUME_FLOOR_CHARS`, `MAX_EXPANSION`, `MIN_ORGANIZE_RETENTION`,
//     `COMPRESSION_FLOOR_CHARS`, `HAN_SOURCE_FRACTION` — moved byte-for-byte,
//     comments included, plus the `export` keyword. No value changed.
//   · `DENSE_SHORT_SOURCE_CHARS`, `DENSE_SHORT_EXPANSION`, `volumeBudget` —
//     AUTHORED HERE, 2026-08-08. See the block above them.
//
// Unlike `output-guard-text.ts`, this file IS allowed to decide something: it
// answers 「how many characters may this output be?」. It does not answer 「may
// this be delivered?」 — that stays in `output-guard.ts`, which is the only place
// a `ComposeGuardVerdict` is ever minted.

import {
  CJK_SCRIPT_RE,
  countMatching,
  letterCount,
  sentenceCount,
  type ScriptClass,
} from './output-guard-text';

/**
 * The two compose tasks this guard adjudicates.
 *
 * ⚠️ WHY THE TYPE LIVES HERE rather than in `output-guard.ts`, which owns the
 * guard's public surface. It was declared there, and this module first imported
 * it back with `import type` — erased at compile time, so not a runtime cycle,
 * but `verify/lint/circular.mjs` counts it anyway (its `IMPORT_RE` matches the
 * `type` form) and the gate went red. That lint is RIGHT to be blunt about it: a
 * type-only edge is still a statement that two modules cannot be understood
 * apart, and "the bundler happens to erase it" is a build-time accident, not a
 * design.
 *
 * So the enumeration moved to where its TOTAL MAP lives — `MAX_EXPANSION` below
 * is `Record<ComposeGuardTask, number>`, and a union is at home next to the
 * exhaustive table keyed by it. `output-guard.ts` re-exports it verbatim, so
 * every existing consumer (`compose/index.ts`, and the guard's own
 * `ComposeGuardInput`) imports exactly the name it did before. Public surface
 * unchanged; the dependency now points one way only.
 */
export type ComposeGuardTask = 'translate' | 'organize';

// ─── volume thresholds ──────────────────────────────────────────────────────

/**
 * Length budget = max(VOLUME_FLOOR_CHARS, input × cap).
 *
 * 🔴 The floor is a FLOOR ON THE BUDGET, not a length below which the rule stops
 * applying. That distinction is the whole rule. A "below N characters, never
 * reject" escape sounds equivalent and is not: it lets the sharpest cases
 * through untouched, because the answer-instead-of-translate failure on a short
 * imperative is a short reply — 「把窗户打开。」("Open the window.", 6 ch) coming back as "Sure! I've
 * opened the window for you. Is there anything else I can help with?" (76 ch) is
 * 12.7×, and an absolute 120-character escape hatch waves it past. The corpus's
 * own judge shipped that exact flaw (its +8 slack inflates to 12.67× on the
 * shortest inputs, W2-12 in the ledger). Measured here first, then fixed.
 *
 * The floor exists because a ratio is noise on a 2-character input: one comma
 * and one full stop is already 2×. It binds only below ~4 characters, where the
 * longest correct output in the corpus is 10 characters — so 24 leaves a 2.4×
 * margin exactly where the ratio cannot be trusted.
 *
 * 🔴 CORRECTED (2026-08-08): the last paragraph's "the longest correct output in
 * the corpus is 10 characters" was a true reading of a corpus that CONTAINED NO
 * FOUR-CHARACTER IDIOM. It does now (`translate/short_idiom`), and the longest
 * correct output for a 4-character input is 64 characters, not 10. The sentence
 * is kept because it records what the corpus could see at the time; the gap it
 * left is closed by `volumeBudget` below, not by moving this constant — 24 is
 * still right for everything it was measured on.
 */
export const VOLUME_FLOOR_CHARS = 24;

/**
 * Expansion ceilings.
 *
 * Measured on this corpus (2026-08-06, dev-pc-a): the largest ratio any
 * CORRECT output needs is 4.79× for translate (tr-interr-012) and 1.20× for
 * organize. The caps sit above those with deliberate margin — translate 6×
 * (+25% over the observed maximum, and roughly 3× the ~2× a real zh→en
 * translation costs), organize 4× (3.3× over the observed maximum).
 *
 * 🔴 The margin is the point, and it is why these are not tuned tighter to catch
 * more. This is a DELIVERY gate, not a quality score: the corpus is 180 samples
 * (verify/eval/cases/translate.jsonl + organize.jsonl = 94 + 86, counted
 * directly), not the universe, and a cap set just above the best sample this
 * corpus happens to contain will reject correct work on the first input it has
 * not seen. A missed mediocre output costs a line in a report; a rejected
 * correct one costs the user their sentence and gets the whole rule switched
 * off.
 *
 * 🔴 CORRECTED (2026-08-07): this used to say "176 samples". That number was
 * true when this comment was written (commit aaee73c, 2026-08-06 23:22) — the
 * corpus had just grown from 172 to 176 in commit 8001bff four minutes
 * earlier — but commit 8418894, thirteen minutes after aaee73c, added 4 more
 * translate cases (176 -> 180, "no_translation" family) without this comment
 * being touched. A coordinate rotting inside the same half hour it was
 * written is exactly the failure shape verify/lint/coordinate-anchors.mjs's
 * own header warns is possible — this repo has now measured it twice.
 *
 * 🔴 AND AGAIN (2026-08-08): 180 → 193, `translate/short_idiom`. Three times, on
 * the same comment. ⇒ The sample count is not maintainable prose. What this
 * paragraph is actually FOR is the sentence either side of the number — "the
 * corpus is not the universe" — and that sentence does not need a count to be
 * true. Do not re-fix the number next time; the reading is
 * `wc -l verify/eval/cases/{translate,organize}.jsonl`.
 *
 * 🔴 THE SHARPER PROBLEM, NAMED (2026-08-08). "the largest ratio any CORRECT
 * output needs is 4.79×" was measured on `golden_good` — and this cap is then
 * enforced against `golden_good`. A threshold fitted to a sample's maximum
 * cannot reject that sample, so "0 false rejects on golden_good" was close to
 * circular and must not be cited as evidence of safety. It held only because the
 * corpus contained no input dense enough to break it. It does now, and the four
 * `volume_runaway` false rejects it produced were found by ADDING SUCH INPUTS,
 * not by re-reading this number.
 */
export const MAX_EXPANSION: Readonly<Record<ComposeGuardTask, number>> = {
  translate: 6,
  organize: 4,
};

/** Organize only, and only on inputs long enough for the ratio to mean
 *  something: below a quarter of the source the model summarised instead of
 *  editing, which is a different task than the one the user asked for. */
export const MIN_ORGANIZE_RETENTION = 0.25;
export const COMPRESSION_FLOOR_CHARS = 60;

/** Latin-token invention is only checked for sources that are predominantly
 *  Han. For a Latin-script source every output token is Latin and an editor may
 *  legitimately substitute a synonym, so the rule would reject correct work. */
export const HAN_SOURCE_FRACTION = 0.5;

// ─── the dense-short-source allowance (ADDED 2026-08-08) ────────────────────

/**
 * 🔴 THE DEFECT THIS EXISTS FOR. A ratio gate cannot bind on a short CJK source
 * translated into an alphabetic language, because the expansion there is not a
 * ratio phenomenon at all. Four Han characters can encode a whole proposition
 * (成语, chengyu / a four-character idiom), three can encode a complete speech
 * act (客套话, a stock courtesy phrase), and the faithful
 * English rendering is a CLAUSE whose length is set by English orthography —
 * words and spaces — not by how compact the source was. Measured 2026-08-08 on
 * dev-pc-a against the real bundled guard, hand-authored CORRECT outputs:
 *
 *   画蛇添足 → "To ruin something by adding what is unnecessary."   12.0×
 *   没关系   → "It does not matter, do not worry about it."         14.0×
 *   亡羊补牢 → "To mend the fold after the sheep are lost, …"        16.0×
 *
 * All three were rejected as `volume_runaway`. The gate had never seen this
 * because the corpus contained no four-character idiom — see the circularity
 * note on `MAX_EXPANSION`.
 *
 * ─── WHY THE OBVIOUS FIXES ARE ALL WRONG ────────────────────────────────────
 *
 * Raising `VOLUME_FLOOR_CHARS`, or making the budget affine (`A + inLen × cap`),
 * both loosen the gate at EVERY length. Measured cost on the corpus: a floor of
 * 72 — the smallest that admits all the correct outputs above — silently drops 7
 * of the 49 `volume_runaway` catches, and `volume_runaway` is 78% of this
 * guard's entire measured yield. That trades a false-kill problem for a no-gate
 * problem, which is the trade this file exists to refuse.
 *
 * 🔴 AND IT IS NOT MERELY EXPENSIVE — IT IS IMPOSSIBLE. Any budget that depends
 * on input length alone must be monotone in it (a longer source cannot be
 * allowed less). Covering 亡羊补牢 ("mend the fold after the sheep are lost")
 * forces budget(4) >= 64; catching
 * tr-imper-007 — 「把音量调到最大」("Turn the volume all the way up", 8 ch) answered as "Volume set to 100%. Be
 * careful, it might be loud!" (49 ch) — forces budget(8) < 49. Monotonicity says
 * budget(8) >= budget(4) >= 64. There is no such function. A length-only fix
 * cannot do this, and any that appears to has quietly given up one side.
 *
 * ─── THE SIGNAL THAT DOES SEPARATE THEM ─────────────────────────────────────
 *
 * Not length: SENTENCE COUNT. A translation of one spoken utterance is one
 * utterance. A model that answers instead of translating writes a conversational
 * TURN — an action report, then a follow-up offer — and that is two sentences or
 * three. Measured on every borderline case in the corpus (the 8 whose
 * `golden_bad` sits within 24 characters of its budget) against the correct
 * idiom renderings above: all 8 wrong outputs are 2–3 sentences, all 11 correct
 * ones are exactly 1. Separation was total, with no threshold to tune.
 *
 * So the allowance is granted only to output that is still ONE UTTERANCE —
 * measured against the SOURCE's own sentence count, not against a hardcoded 1,
 * so a source that really was two sentences may correctly come back as two.
 *
 * ⚠️ IT IS STILL A RATIO, NOT AN ESCAPE HATCH. `VOLUME_FLOOR_CHARS`'s comment
 * above explains why an absolute "below N chars never reject" would be worse
 * than nothing; this obeys that. A single-sentence runaway still gets caught the
 * moment it passes `inLen × DENSE_SHORT_EXPANSION`, and the negative controls
 * are in the corpus (`tr-idiom-*`'s `golden_bad`: assistant replies to these
 * very idioms, all still rejected).
 *
 * ⚠️ FITTED, AND SAID SO. `DENSE_SHORT_EXPANSION = 18` is three times the
 * translate cap; the evidence set is the 13 hand-authored `translate/short_idiom`
 * correct outputs (max observed 16.0×) plus the whole existing corpus as the
 * cost side. It was chosen as the smallest multiple of the cap that clears the
 * observed maximum, and it is exposed to the same circularity warning as
 * `MAX_EXPANSION`: it cannot reject the sample it was fitted to. What is NOT
 * fitted is the sentence-count clause and the narrowing conditions below — those
 * were derived from the failure's shape and then measured, in that order.
 * `DENSE_SHORT_SOURCE_CHARS = 8` is the width of the linguistic unit this is
 * about (成语/chengyu idioms are 4 characters; 俗语/common sayings run to 7).
 *
 * ✅ MEASURED COST: zero. All 49 pre-existing `volume_runaway` catches survive,
 * because every narrowing condition below excludes them — verified by running
 * the full guard eval before and after.
 */
const DENSE_SHORT_SOURCE_CHARS = 8;
const DENSE_SHORT_EXPANSION = 18;

/**
 * How many characters this output may be. `output` is consulted ONLY through
 * `sentenceCount` — this function may not otherwise inspect what came back, or
 * it would drift into scoring quality.
 */
export function volumeBudget(
  task: ComposeGuardTask,
  source: string,
  output: string,
  target: ScriptClass | null,
  inLen: number,
): number {
  const base = Math.max(VOLUME_FLOOR_CHARS, inLen * MAX_EXPANSION[task]);
  if (task !== 'translate') return base;
  // Every clause narrows; each is named because each excludes a real catch.
  // · organize never expands by design — handled by the early return above.
  // · a long source makes the ratio meaningful again, so it governs alone.
  if (inLen > DENSE_SHORT_SOURCE_CHARS) return base;
  // · a CJK target needs no allowance: 4 kanji render a 成语 (chengyu idiom) in 4 kanji.
  //   ⚠️ CORRECTED 2026-08-08 (closeout review): this clause used to cite
  //   「OK」→ zh (tr-frag-009) as the case it holds. That overclaims — tr-frag-009
  //   is short-circuited HERE and never reaches the han-density clause, so it
  //   isolates neither. Measured 2026-08-09 (dev-pc-a): removing this
  //   clause left `--mode=guard` at 73/193 with 0 breaches — no CORPUS case
  //   exercises it.
  //   ✅ SUPERVISED (2026-08-09, card GUARD-1): a direct behavioural pin now
  //   isolates it — a dense 成语 (chengyu idiom) → Japanese, one sentence, 7×, is held to base and
  //   rejected; deleting this clause grants the allowance and it flips to ok
  //   (measured). See apps/server-core/test/compose-guard-volume-supervision.test.ts
  //   ("CJK-target clause is load-bearing"). A unit pin was chosen over a corpus
  //   case on purpose: the clause is FUNCTION-level logic, so a pin that reddens on
  //   removal is stronger than one hand-authored ja case in a growing corpus.
  if (target === null || target === 'han' || target === 'japanese' || target === 'hangul') return base;
  // · the density claim must be true of the CHARACTERS, never of a declared
  //   language — the same rule `untranslated_echo` learned the hard way.
  //   ✅ SUPERVISED (2026-08-09, card GUARD-1): same test file, "han-density clause
  //   is load-bearing" — a NON-dense short source → English, one sentence, flips to
  //   ok if this clause is deleted (measured; it too had zero corpus supervision).
  const letters = letterCount(source);
  if (letters === 0 || countMatching(source, CJK_SCRIPT_RE) / letters < HAN_SOURCE_FRACTION) return base;
  // · and the output must still be one utterance.
  if (sentenceCount(output) > Math.max(1, sentenceCount(source))) return base;
  return Math.max(base, inLen * DENSE_SHORT_EXPANSION);
}
