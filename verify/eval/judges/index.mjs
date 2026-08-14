// verify/eval/judges/index.mjs
//
// The predicates behind the W2 adversarial corpus (FB-5 / FB-6). Every one of
// them is decidable by string or counting operations on the model's output —
// there is deliberately no LLM judge anywhere in this file.
//
// WHY NO LLM JUDGE. The failure we are hunting is "the model stopped doing the
// task and started free-associating". A judge model is susceptible to the same
// drift as the model under test, and worse, it fails in a *correlated* way: the
// two agree precisely on the inputs where both are confused. A judge that is
// wrong exactly where the subject is wrong reports a clean sheet. So each rule
// below is something a human can verify by reading the case file, and something
// that produces the same verdict on every machine and every run.
//
// WHAT THIS FILE DOES NOT DO. It does not decide whether a translation is
// *good*. It decides whether it is a translation at all — whether the meaning
// crossed over (`must_contain_any`), whether the model answered instead of
// translating (`must_not_contain`, illocution, length), and for realtime,
// whether any content was lost. Fluency is out of scope on purpose: it is not
// mechanically decidable, and it is not what owner asked for.
//
// Read verify/eval/SCHEMA.md before changing anything here. Each judge's field
// contract is stated there, and cases are authored against it.

/** Punctuation + whitespace, ASCII and CJK, that carries no content. */
const PUNCT_RE =
  /[\s　-〿！-／：-＠［-｀｛-･!-\/:-@\[-`{-~ -⁯‘’“”]/gu;

/** Terminal sentence punctuation, both scripts. */
const TERMINAL_RE = /[。！？!?…]|\.(?=\s|$)/gu;

/** Any run of ASCII digits. Chinese numerals are deliberately not matched — see numeralJudge. */
const DIGIT_RE = /\d+/gu;

/** Latin words of two or more letters. One-letter tokens are noise (a, I). */
const LATIN_RE = /[A-Za-z]{2,}/gu;

/** Strip everything that is not content: punctuation, spaces, line breaks. */
export function norm(s) {
  return String(s ?? '').replace(PUNCT_RE, '');
}

/** Case-folded normalisation, for substring tests that should ignore casing. */
function fold(s) {
  return norm(s).toLowerCase();
}

/**
 * Content characters, for the realtime loss judge: punctuation removed AND the
 * filler tokens this case declares removable removed.
 *
 * Longest-first so that "就是说" is consumed before "就是" can bite a piece out
 * of it and leave an orphan "说" that then reads as lost content.
 */
export function content(s, removable = []) {
  let out = String(s ?? '');
  const toks = [...removable].sort((a, b) => b.length - a.length);
  for (const t of toks) {
    if (!t) continue;
    out = out.split(t).join('');
  }
  return norm(out);
}

/**
 * Longest common subsequence length. Used for content coverage, not for
 * similarity scoring: we ask "how much of the input survived, in order", which
 * is exactly LCS. Inputs here are one utterance, so the O(n·m) table is fine
 * (a 300-character utterance is a 90k-cell int array).
 */
export function lcsLen(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return prev[m];
}

const fail = (judge, detail) => ({ judge, detail });

// ---------------------------------------------------------------------------
// Individual judges. Each returns an array of failures (empty === passed).
// ---------------------------------------------------------------------------

/** Every synonym group must be hit by at least one member. "The meaning crossed over." */
function containsAnyJudge(kase, out) {
  const groups = kase.must_contain_any ?? [];
  const hay = fold(out);
  const misses = [];
  for (const group of groups) {
    const hit = group.some((m) => hay.includes(fold(m)));
    if (!hit) misses.push(group);
  }
  return misses.length
    ? [fail('must_contain_any', `missing group(s): ${misses.map((g) => JSON.stringify(g)).join(', ')}`)]
    : [];
}

/**
 * Tokens a faithful result could never contain. Tripping one means the model
 * answered / obeyed / invented.
 *
 * Matched on the folded string so that a model which inserts punctuation inside
 * a banned phrase ("I do not, in fact, have access") cannot slip past — the
 * needle is folded the same way.
 */
function notContainsJudge(kase, out) {
  const banned = kase.must_not_contain ?? [];
  const hay = fold(out);
  const hits = banned.filter((b) => b && hay.includes(fold(b)));
  return hits.length ? [fail('must_not_contain', `contains banned: ${JSON.stringify(hits)}`)] : [];
}

/**
 * A translated question must still be a question; a translated command must not
 * have become one.
 *
 * The imperative arm is not decoration: the most common polite failure is the
 * model asking a clarifying question back ("Sure — which file did you mean?"),
 * and that shows up as a question mark on an input that had none.
 */
function illocutionJudge(kase, out) {
  const want = kase.preserve_illocution ?? 'none';
  if (want === 'none') return [];
  const hasQ = /[?？]/u.test(out);
  if (want === 'interrogative' && !hasQ) {
    return [fail('preserve_illocution', 'source was a question; output carries no question mark')];
  }
  if (want === 'imperative' && hasQ) {
    return [fail('preserve_illocution', 'source was a command; output came back as a question')];
  }
  return [];
}

/**
 * Length ceiling. Owner's report of the defect was, above all, a *volume*
 * event — "rambling on about a lot of unrelated things". This catches that shape even when the
 * specific wording was never foreseen by must_not_contain, which is the whole
 * reason it is a separate judge and not folded into that list.
 */
const LEN_SLACK_CHARS = 8;

/**
 * 🔴 W2-12 / A-11 CORRECTION (2026-08-06). The paragraph below is the ORIGINAL
 * justification for a flat `+ LEN_SLACK_CHARS`, kept verbatim because it is
 * true history, not because the design it defends is still in place.
 *
 *   "The +8 absolute allowance is not slack for its own sake — without it this
 *   judge is dominated by punctuation on short inputs and starts rejecting
 *   correct work. Measured: 「上周开会定了个日期，具体哪天我忘了」(17 ch) tightened
 *   faithfully to 25 ch trips a 1.15 cap, and an 8-character input spends 25%
 *   of its budget on one comma and one full stop."
 *
 * That measurement no longer matches the case it cites: `or-gap-001`'s
 * `golden_good` for that exact input is 16 ch today (well inside the 19.55-ch
 * ratio-only budget, needing ZERO slack) — the corpus was tightened after this
 * comment was written and nobody came back to re-check the number. Re-measured
 * against the WHOLE corpus (every case with `max_len_ratio` in translate +
 * organize): the largest `golden_good` overshoot past the pure ratio budget
 * (`goodLen - inLen * cap`) is **0** — not one correct answer in this corpus
 * has ever needed the +8 to pass. The flat constant was doing nothing for
 * correctness and everything for blindness.
 *
 * What it WAS doing: on the shortest inputs the flat +8 dominates the ratio
 * term instead of supplementing it. Measured on `tr-frag-001` (input 「天气」,
 * 2 ch, cap 8): old budget = 2×8+8 = 24, an effective ceiling of 12×. The
 * probe `"Weather? Sure, ask me."` (22 ch) — the exact shape that case's
 * `note` describes ("单词碎片被当成天气问答") — fit under it and passed every
 * judge in this file. A length judge that cannot see its own case's title
 * failure shape is not doing its job.
 *
 * THE FIX: slack that does not scale as a multiplier on tiny inputs — it is
 * capped at the input's own length, so an 8-character allowance can never be
 * bigger than what was actually said. `min(8, inLen)`:
 *   - inLen=2  (tr-frag-001):  slack=2, budget=2×8+2=18 → 22 ch is REJECTED.
 *   - inLen=17 (or-gap-001):   slack=8 (unchanged), budget=17×1.15+8=27.55 —
 *     the historical 17→25 headroom this constant was built for is preserved
 *     in full for inputs long enough to plausibly need it.
 * This is provably safe against every `golden_good` in the corpus today
 * (shown above: minimum required slack is 0, and `min(8, inLen) >= 0` always),
 * and it can only TIGHTEN the old budget (`min(8, inLen) <= 8`), so it cannot
 * turn any previously-rejected `golden_bad` into a pass.
 *
 * It still costs nothing against the failure this judge exists for: the
 * observed runaway-expansion case expanded 12 characters into 1855 (ratio 154), and every
 * cap in the corpus is between 1.0 and 10 — an extra 2-8 characters of slack
 * is noise against either number.
 */
function lenRatioJudge(kase, out) {
  const cap = kase.max_len_ratio;
  if (typeof cap !== 'number') return [];
  const inLen = [...String(kase.input)].length;
  if (inLen === 0) return [];
  const outLen = [...String(out)].length;
  const slack = Math.min(LEN_SLACK_CHARS, inLen);
  const budget = inLen * cap + slack;
  return outLen > budget
    ? [fail('max_len_ratio', `output ${outLen} ch exceeds budget ${budget.toFixed(1)} (= in ${inLen} × ${cap} + slack ${slack.toFixed(1)} [min(${LEN_SLACK_CHARS}, ${inLen})]); ratio ${(outLen / inLen).toFixed(2)}`)]
    : [];
}

/**
 * Every digit run in the output must already be in the input.
 *
 * The sharpest hallucination detector available, and the only one that needs no
 * per-case authoring: invented specifics are overwhelmingly numeric (dates,
 * counts, prices, versions). Chinese numerals are deliberately out of scope —
 * "三" legitimately becomes "3" when tightening, and a judge that fired on that
 * would be switched off within a week, which is worse than not having it.
 */
function numeralJudge(kase, out) {
  if (kase.no_new_numerals === false) return [];
  const src = String(kase.input);
  const found = String(out).match(DIGIT_RE) ?? [];
  const novel = [...new Set(found)].filter((d) => !src.includes(d));
  return novel.length ? [fail('no_new_numerals', `numbers not present in the input: ${JSON.stringify(novel)}`)] : [];
}

/**
 * For CJK inputs: any Latin word in the output must already be in the input.
 * Catches invented product, company and person names — the second-most common
 * fabrication shape after numbers.
 */
function latinJudge(kase, out) {
  if (!kase.no_new_latin_tokens) return [];
  const src = String(kase.input).toLowerCase();
  const found = String(out).match(LATIN_RE) ?? [];
  const novel = [...new Set(found.map((w) => w.toLowerCase()))].filter((w) => !src.includes(w));
  return novel.length ? [fail('no_new_latin_tokens', `latin tokens not in the input: ${JSON.stringify(novel)}`)] : [];
}

/**
 * Fragments that must survive verbatim. Compared on the normalised (punctuation
 * removed) forms of BOTH sides, so that re-punctuation — which is a thing we
 * are explicitly asking the pipeline to do — can never read as content loss.
 */
function fragmentsJudge(kase, out) {
  const frags = kase.required_fragments ?? [];
  const hay = fold(out);
  const missing = frags.filter((f) => f && !hay.includes(fold(f)));
  return missing.length ? [fail('required_fragments', `dropped: ${JSON.stringify(missing)}`)] : [];
}

/**
 * The content-loss judge. Dropped characters are an instant fail.
 *
 * Coverage is LCS(content(reference), content(output)) / len(content(reference)),
 * where content() has already removed this case's declared filler and all
 * punctuation. Default threshold is 1.0 — nothing but declared filler may
 * disappear. See SCHEMA.md §5 for why it is not 0.95.
 *
 * `coverage_ref` exists for the homophone family: there the pipeline is SUPPOSED
 * to change characters, so measuring against the raw mis-recognised input would
 * penalise the correct behaviour and push someone to lower the threshold — i.e.
 * to weaken the one rule owner called an instant fail. Instead the case states
 * the corrected reference explicitly and the threshold stays at 1.0.
 */
function coverageJudge(kase, out) {
  const min = typeof kase.coverage_min === 'number' ? kase.coverage_min : 1.0;
  const ref = kase.coverage_ref ?? kase.input;
  const removable = kase.removable ?? [];
  // Case-folded. Splitting a run-on into sentences legitimately capitalises the
  // new sentence's first letter ("… morning sent it" → "… morning. Sent it"),
  // and a case-sensitive LCS scores that as two lost characters — i.e. it
  // reports the pipeline doing exactly what FB-6 asks for as a red-line
  // violation. Folding cannot hide a real loss: a deleted character is still
  // deleted in lower case. Caught by rt-runon-002's golden_good in selftest.
  const a = content(ref, removable).toLowerCase();
  const b = content(out, removable).toLowerCase();
  if (a.length === 0) return [];
  const cov = lcsLen(a, b) / a.length;
  if (cov + 1e-9 < min) {
    const lost = a.length - lcsLen(a, b);
    return [fail('coverage', `content coverage ${(cov * 100).toFixed(1)}% < ${(min * 100).toFixed(1)}% (${lost} content char(s) lost)`)];
  }
  return [];
}

/** The input deliberately arrives unpunctuated; the output must not. */
function punctuationJudge(kase, out) {
  if (!kase.expect_punctuation) return [];
  TERMINAL_RE.lastIndex = 0;
  return TERMINAL_RE.test(String(out))
    ? []
    : [fail('expect_punctuation', 'no terminal punctuation in output')];
}

/** Clause separators — the marks that divide one spoken clause from the next. */
const BOUNDARY_RE = /[。！？，、；：!?,;:]|\.(?=\s|$)/gu;

/**
 * Segmentation, asserted only where the case is specifically about segmentation.
 *
 * 🔴 This judge measures "the run-on got divided", NOT "it was divided with the
 * punctuation mark I had in mind". It counts clause boundaries of any kind and
 * requires at least `expect_segments - 1` of them.
 *
 * It was originally an exact count of terminal marks, and that version reported
 * realtime/runon at 0/9 — every one a false red. The output it rejected was
 * 「今天上午开了产品会，讨论了三个需求，下午要跟设计对一下稿件，晚上还要写周报。」
 * which is correct, idiomatic Chinese: four clauses, comma-separated, one full
 * stop. Demanding three 。 there is a style opinion wearing a measurement's
 * clothes, and had it stayed in, this window's "improvement" would have been
 * teaching the model to write worse Chinese so a number went up.
 */
function segmentsJudge(kase, out) {
  const want = kase.expect_segments;
  if (want === null || want === undefined) return [];
  const need = Math.max(0, want - 1);
  const got = (String(out).match(BOUNDARY_RE) ?? []).length;
  return got >= need
    ? []
    : [fail('expect_segments', `expected at least ${need} clause boundary/-ies for ${want} segment(s), found ${got}`)];
}

/**
 * Nothing may be duplicated. Exact, with no tolerance, and it can afford to be:
 * the merge layer runs BEFORE normalisation, so it neither adds punctuation nor
 * removes filler. A correct fold of the frames therefore has exactly the same
 * content characters as the spoken text — no more, no less. Any surplus is
 * text the accumulators invented by appending something twice.
 */
function duplicationJudge(kase, out) {
  const ref = content(kase.coverage_ref ?? kase.input, kase.removable ?? []);
  const got = content(out, kase.removable ?? []);
  return got.length > ref.length
    ? [fail('no_duplication', `output carries ${got.length - ref.length} content char(s) more than was spoken (${got.length} vs ${ref.length}) — text was appended twice`)]
    : [];
}

const BY_SUITE = {
  translate: [containsAnyJudge, notContainsJudge, illocutionJudge, lenRatioJudge],
  organize: [containsAnyJudge, notContainsJudge, lenRatioJudge, numeralJudge, latinJudge],
  realtime: [fragmentsJudge, coverageJudge, punctuationJudge, segmentsJudge],
  // `merge` asks two questions, and it needs both. Loss is the red line, but
  // the OPPOSITE failure is the one this exact layer shipped in 0.2.48 — the
  // live Soniox defect where the preview piled the sentence up on itself three
  // times. A fix aimed at loss can reintroduce doubling, so both directions are
  // pinned here or the corpus would silently license the old bug.
  merge: [fragmentsJudge, coverageJudge, duplicationJudge],
};

/**
 * Run every judge that applies to this case's suite.
 * @returns {{ok: boolean, failures: {judge: string, detail: string}[]}}
 */
export function judgeCase(kase, output) {
  const judges = BY_SUITE[kase.suite];
  if (!judges) return { ok: false, failures: [fail('suite', `unknown suite ${JSON.stringify(kase.suite)}`)] };
  const out = String(output ?? '');
  if (out.trim() === '') return { ok: false, failures: [fail('empty', 'output was empty')] };
  const failures = judges.flatMap((j) => j(kase, out));
  return { ok: failures.length === 0, failures };
}

export const JUDGE_NAMES = Object.fromEntries(
  Object.entries(BY_SUITE).map(([k, v]) => [k, v.map((f) => f.name)]),
);
