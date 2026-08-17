// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (final pipeline last stage — the
//     opt-in polish's meaning-preservation guard is what keeps it from degrading
//     into a rewrite/summarize feature)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-6 (opt-in LLM polish layer)
//   Ported VERBATIM from legacy apps/server/src/stt/stt-polish-guard.ts
//     (F-3073 track-B safety gate). Carrying code over takes priority over rewriting it: `checkMeaningPreserved` +
//     its closed-class / cardinality machinery is the PROVEN, adversarially-
//     calibrated guard — the closed-class token sets, the EDIT_DISTANCE_FLOOR=8 /
//     RATIO_MIN_LEN=10 calibration, and the openClassTokenDelta GAP-2 fix are the
//     legacy implementation carried byte-for-byte, not a re-derivation.
//     Divergence from legacy: NONE (this is a pure, deterministic function with no
//     transport/settings surface, so the WP-R4-6 contract reversals — which live
//     in stt-polish.ts / the bridge — do not touch it). Header-only edit: the
//     legacy calibration decision doc path is retained below for provenance.
//   docs/decisions/2026-07-20-wp4c-polish-guard-calibration.md (legacy calibration)
//
// This file owns ONLY the §3 meaning-preservation guard: `checkMeaningPreserved`
// is the make-or-break mechanism — a two-part accept/reject verdict that
// `polishFinalText` (stt-polish.ts) must honour before ever letting a polished
// string replace the raw final. Split out to respect the file-size cap.

import { DEFAULT_POLISH_STRENGTH, type PolishStrength } from '@flowmic/protocol';

// ─── §3.2 closed-class token set (K-independent hard gate) ───────────

const ZH_NEGATION = ['不', '没', '没有', '别', '未', '无', '非', '勿', '莫'];
const EN_NEGATION = ['not', "n't", 'no', 'never', 'none', 'neither', 'nor', 'without'];

const ZH_QUANTIFIER = ['都', '全', '只', '仅', '每', '各', '所有'];
const EN_QUANTIFIER = ['all', 'only', 'every', 'each', 'both', 'most', 'some', 'any', 'few', 'none'];
const ZH_NUMERALS = ['一', '二', '两', '三', '四', '五', '六', '七', '八', '九', '十', '百', '千', '万', '亿', '零'];
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const ZH_MODAL = ['能', '会', '要', '得', '必须', '应该', '可能', '也许', '一定', '千万'];
const EN_MODAL = ['must', 'can', 'cannot', 'could', 'should', 'would', 'may', 'might', 'will', 'shall'];

/** Every closed-class term, longest-first so multi-char zh phrases (e.g.
 *  `没有`) are matched as themselves in addition to their component
 *  chars — both are tracked as INDEPENDENT multiset entries per §3.2
 *  ("computes the closed-class multiset... of raw and polished"), so a
 *  drift in either the phrase or a component char is caught.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 PER-LANGUAGE COVERAGE — THIS SET IS NARROWER THAN THE PRODUCT, AND SAYING
 * SO IS THE POINT (card C8, owner 2026-08-17: 「注意不同语种的区别，不光只考虑
 * 中/英文」).
 *
 * The product ships NINE UI locales and dictates in more. This list is built
 * from `ZH_*` and `EN_*` sets only. What that means, per language, measured
 * rather than assumed — see also `closedClassMultiset`, which has exactly two
 * matching strategies (CJK-style substring, and English word-boundary) and no
 * third:
 *
 *   · zh-CN / zh-TW — FULLY GUARDED as designed. Negation, quantifiers,
 *     numerals and modals are all present and matched as substrings, which is
 *     correct for a script with no word boundaries.
 *   · en — FULLY GUARDED as designed, via the word-boundary regex.
 *   · ja — PARTIALLY GUARDED, and better than it looks: Japanese negation is
 *     inflectional (ない / ません), so none of it is here, BUT Japanese written
 *     text uses the same Han numerals as Chinese, and those ARE in the list and
 *     ARE substring-matched. So numbers are pinned; negation and modality are
 *     NOT.
 *   · ko — DIGITS ONLY. Hangul negation (안 / 못 / 없다) and modality are absent,
 *     and Korean is not matched by either strategy in any useful way.
 *   · ru / de / fr / es — DIGITS ONLY, IN EFFECT. These run the English
 *     word-boundary path against an English term list, so the only things that
 *     can match are the digits and the handful of English words that happen to
 *     be spelled identically in that language (German `all`, `most`; French
 *     `none` does not occur). Their real negations — `не`, `nicht`, `ne…pas`,
 *     `no` — are NOT in the list. Note `no` is a genuine gap for Spanish
 *     specifically: `EN_NEGATION` contains `no`, and the word-boundary regex
 *     will match Spanish `no` by coincidence. Coincidence is not coverage, and
 *     it must not be cited as such.
 *
 * ⚠️ SO THE HONEST ONE-LINE SUMMARY IS: **digits are guarded in every language;
 * negation, quantification and modality are guarded in zh and en only.** For
 * ja/ko/ru/de/fr/es the §3.2 gate degrades to a number check, and the §3.1
 * cardinality bounds are doing all the remaining work.
 *
 * 🔴 WHY THIS IS NOT FIXED HERE, DELIBERATELY. Adding `не` / `nicht` / `ne` /
 * `no` naively would be worse than the gap: these are matched by the ENGLISH
 * branch, which is a word-boundary regex, and `\bno\b` against Spanish also
 * matches inside constructions where a smoothing pass legitimately restructures
 * the clause — a guard that rejects correct work gets loosened until it never
 * fires, which is how this guard would lose its Chinese and English coverage
 * too. Extending it needs per-language term sets AND a per-language matching
 * strategy AND a corpus in that language to calibrate against. The corpus is
 * the part that does not exist yet, which is why card C8's eval half adds a
 * `lang` axis first. Sequence: measure, then extend. Not the other way round.
 *
 * ⚠️ CONSEQUENCE FOR `smooth`, STATED SO IT IS NOT DISCOVERED LATER: at smooth
 * strength the §3.1 bounds are wider, and for the six languages above §3.1 is
 * the ONLY thing left. Smooth mode is therefore materially less supervised in
 * ja/ko/ru/de/fr/es than in zh/en. That is a real limitation of this release,
 * not a rounding error, and it belongs in the handback report rather than in a
 * silently optimistic default. */
export const CLOSED_CLASS_TERMS: readonly string[] = [
  ...ZH_NEGATION, ...EN_NEGATION,
  ...ZH_QUANTIFIER, ...EN_QUANTIFIER, ...ZH_NUMERALS, ...DIGITS,
  ...ZH_MODAL, ...EN_MODAL,
].sort((a, b) => b.length - a.length);

const EN_WORD_TERMS = new Set([...EN_NEGATION, ...EN_QUANTIFIER, ...EN_MODAL].filter((t) => t !== "n't"));

/** Count occurrences of every closed-class term in `text`. zh terms +
 *  digits are counted as plain substrings (CJK has no word boundaries);
 *  en terms use a case-insensitive word-boundary regex; `n't` is a
 *  boundary-less suffix substring. */
export function closedClassMultiset(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const lower = text.toLowerCase();
  for (const term of CLOSED_CLASS_TERMS) {
    let count: number;
    if (term === "n't") {
      count = lower.split("n't").length - 1;
    } else if (EN_WORD_TERMS.has(term)) {
      const re = new RegExp(`\\b${term}\\b`, 'gi');
      count = (text.match(re) ?? []).length;
    } else {
      count = text.split(term).length - 1;
    }
    out.set(term, count);
  }
  return out;
}

// ─── §3.1 cardinality bound (necessary, not sufficient) ──────────────

const EDIT_DISTANCE_FLOOR = 8;
const EDIT_DISTANCE_RATIO = 0.15;
const RATIO_MIN_LEN = 10;
const OPEN_CLASS_K = 2;

// ─── card C8: the `smooth` calibration ──────────────────────────────────────
//
// 🔴 WHAT IS *NOT* RELAXED, AND WHY EACH ONE IS LOAD-BEARING AT THIS STRENGTH.
// The card's instruction was that smooth "cannot simply drop
// checkMeaningPreserved", because this guard is also what catches a model that
// obeyed an instruction smuggled into the transcript rather than correcting it.
// So exactly one axis moves, and these stay at their strict values:
//   · §3.2 CLOSED-CLASS MULTISET — untouched, K-independent, still rejects on
//     ANY drift. This is the meaning-inversion gate: negation, quantifiers,
//     numerals, digits, modals. "I did not ship it" -> "I shipped it" is a
//     one-token edit that no distance bound will ever catch, and it is the
//     single most damaging thing a smoothing pass can do. Note this also keeps
//     every DIGIT pinned in every language, which is the one part of the
//     closed-class set that is script-independent (see the per-language note on
//     CLOSED_CLASS_TERMS).
//   · the PROTECTED-TERMS check — untouched. It lives in the caller
//     (stt-polish.ts `protectedTermDrift`) and never consults the strength: a
//     dictionary term is the user's explicit configuration, and "smoother" is
//     not a licence to undo it.
//   · the LENGTH-RATIO UPPER bound (1.5) — untouched. Smoothing REMOVES; a
//     smoothed output that grew by half is adding content, which is the
//     signature of a model that answered the transcript instead of tidying it.
//     Only the LOWER bound moves, and only because deletion is the licensed
//     operation.
//
// 🔴 THE NUMBERS ARE MEASURED, NOT PICKED. Against the `realtime` corpus,
// staged input -> golden_good, read out of [[GuardMetrics]] (dev box
// dev-pc-a, 2026-08-17, n=46 measurable pairs):
//
//     family         n    max distRatio   lengthRatio     max openClass
//     filler        10        0.450       [0.55, 0.843]        9
//     runon         10        0.136       [1.02, 1.095]        2
//     homophone      9        0.154       [0.917, 1.077]       1
//     numeric        7        0.133       [1.016, 1.133]       1
//     code_switch    6        0.044       [1.00, 1.026]        0
//     interrogative  2        0.069       [1.00, 1.034]        0
//     negation       1        0.045       [1.045, 1.045]       0
//     declarative    1        0.033       [1.00, 1.00]         0
//
// Two things fall out of that table and both are load-bearing:
//   1. THE RELAXATION IS TARGETED. Every family except `filler` sits far under
//      even the STRICT bounds, so widening them changes nothing for those cases
//      — the smooth calibration is not a blanket loosening, it is sized to the
//      one operation the owner asked for.
//   2. THE GATE BEING KEPT NEVER FIRED. On the strict bounds this family was
//      admitted 0 of 10 (7 `edit-distance-exceeded`, 3
//      `open-class-delta-exceeded`) and NOT ONE rejection was a closed-class
//      drift. So the axis that stays is the axis that was never the obstacle.
//
// ⚠️ HEADROOM, AND WHERE IT IS DELIBERATELY GENEROUS. The distance and length
// bounds sit just past the observed worst case (0.450 -> 0.5, 0.55 -> 0.4).
// `openClassK` is set to 12 against an observed max of 9, which is more slack
// than the others, and the reason is the sample rather than the statistic: those
// ten cases are Chinese and English only. A filler run tokenizes differently in
// a language whose fillers are not single characters, and `countMixedTokens`
// treats a run of non-Han characters as ONE token — so a Japanese えーと or a
// Russian ну may well count differently from 呃. Under-sizing K would produce
// false rejects in exactly the languages this card is trying to stop assuming
// about, and a guard that refuses correct work is the one that gets loosened
// until it never fires (this file's own history). Revisit when the corpus has
// non-zh/en filler cases; the number to re-read is `openClassDelta`.
//
// ⚠️ WHAT THIS COSTS, STATED PLAINLY: a wider distance bound means a smooth-mode
// rewrite that preserves every closed-class token can travel further before
// being refused. That is the trade the owner asked for, and the honest place to
// say so is the user-facing copy ("no longer word-for-word what was said"), not
// a guard tuned to pretend the trade does not exist.
const SMOOTH_EDIT_DISTANCE_FLOOR = 16;
const SMOOTH_EDIT_DISTANCE_RATIO = 0.5;
const SMOOTH_LENGTH_RATIO_MIN = 0.4;
const SMOOTH_OPEN_CLASS_K = 12;

/** The tunable half of the guard, per strength. The strict column is the
 *  verbatim legacy calibration and must not move: this table exists so that a
 *  new strength is a new ROW, never an edit to the existing one. */
interface GuardBounds {
  editFloor: number;
  editRatio: number;
  lengthRatioMin: number;
  lengthRatioMax: number;
  openClassK: number;
}

const STRICT_BOUNDS: GuardBounds = {
  editFloor: EDIT_DISTANCE_FLOOR,
  editRatio: EDIT_DISTANCE_RATIO,
  lengthRatioMin: 0.5,
  lengthRatioMax: 1.5,
  openClassK: OPEN_CLASS_K,
};

const SMOOTH_BOUNDS: GuardBounds = {
  editFloor: SMOOTH_EDIT_DISTANCE_FLOOR,
  editRatio: SMOOTH_EDIT_DISTANCE_RATIO,
  lengthRatioMin: SMOOTH_LENGTH_RATIO_MIN,
  lengthRatioMax: 1.5,
  openClassK: SMOOTH_OPEN_CLASS_K,
};

function boundsFor(strength: PolishStrength): GuardBounds {
  return strength === 'smooth' ? SMOOTH_BOUNDS : STRICT_BOUNDS;
}
const PUNCT_RE = /[，。,.\s！？!?、；;：:""''「」『』()（）~～…·\-—_]/gu;

interface DiffHunk { rawText: string; polText: string }
interface DiffResult { distance: number; hunks: DiffHunk[] }

/** Classic Levenshtein DP with backtrace, operating on Unicode codepoints
 *  (not UTF-16 code units) so CJK / astral characters diff correctly.
 *  Returns both the scalar edit distance (§3.1 bullet 1) and the
 *  contiguous changed regions ("hunks", fed into `openClassTokenDelta`
 *  below for the §3.1 bullet 4 open-class check — a hunk is a region with
 *  no shared character, NOT a content-word boundary, so it is tokenized
 *  rather than counted directly; see the GAP-2 note on that function). */
function diffChars(a: string, b: string): DiffResult {
  const A = [...a];
  const B = [...b];
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i]![0] = i;
  for (let j = 0; j <= m; j++) dp[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (A[i - 1] === B[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]!;
      else dp[i]![j] = 1 + Math.min(dp[i - 1]![j - 1]!, dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  type Op = { op: 'eq' | 'sub' | 'del' | 'ins'; a?: string; b?: string };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && A[i - 1] === B[j - 1] && dp[i]![j] === dp[i - 1]![j - 1]) {
      ops.push({ op: 'eq', a: A[i - 1], b: B[j - 1] }); i -= 1; j -= 1;
    } else if (i > 0 && j > 0 && dp[i]![j] === dp[i - 1]![j - 1]! + 1) {
      ops.push({ op: 'sub', a: A[i - 1], b: B[j - 1] }); i -= 1; j -= 1;
    } else if (i > 0 && dp[i]![j] === dp[i - 1]![j]! + 1) {
      ops.push({ op: 'del', a: A[i - 1] }); i -= 1;
    } else {
      ops.push({ op: 'ins', b: B[j - 1] }); j -= 1;
    }
  }
  ops.reverse();

  const hunks: DiffHunk[] = [];
  let curRaw = '';
  let curPol = '';
  let inHunk = false;
  for (const o of ops) {
    if (o.op === 'eq') {
      if (inHunk) { hunks.push({ rawText: curRaw, polText: curPol }); curRaw = ''; curPol = ''; inHunk = false; }
      continue;
    }
    inHunk = true;
    if (o.op === 'sub') { curRaw += o.a; curPol += o.b; }
    else if (o.op === 'del') { curRaw += o.a; }
    else { curPol += o.b; }
  }
  if (inHunk) hunks.push({ rawText: curRaw, polText: curPol });

  return { distance: dp[n]![m]!, hunks };
}

function stripClosedClassAndPunct(s: string): string {
  let out = s;
  for (const term of CLOSED_CLASS_TERMS) out = out.split(term).join('');
  return out.replace(PUNCT_RE, '');
}

function countHan(s: string): number {
  let n = 0;
  for (const ch of s) if (/\p{Script=Han}/u.test(ch)) n += 1;
  return n;
}

/** Counts open-class "tokens" in an already closed-class+punctuation-
 *  stripped fragment: every Han character is its OWN token (Chinese has
 *  no whitespace word boundary, so per-character is the same granularity
 *  the §3.2 closed-class gate already uses); a contiguous run of non-Han
 *  characters (a Latin/digit word) counts as a single token. */
function countMixedTokens(s: string): number {
  const chars = [...s];
  let count = 0;
  let i = 0;
  while (i < chars.length) {
    if (/\p{Script=Han}/u.test(chars[i]!)) { count += 1; i += 1; continue; }
    let j = i + 1;
    while (j < chars.length && !/\p{Script=Han}/u.test(chars[j]!)) j += 1;
    count += 1;
    i = j;
  }
  return count;
}

/**
 * §3.1 bullet 2 fix (GAP-2, adversarial review of legacy commit 7f123b5): the
 * open-class bound must count CHANGED open-class TOKENS, not the number of
 * contiguous diff hunks. Counting hunks is a facade — adjacent open-class
 * substitutions with no shared character between them collapse into a single
 * hunk (no `eq` op breaks the run), so a full-phrase multi-word meaning change
 * (`他很高兴`->`她真开心`, i.e. "he was quite happy" -> "she was truly delighted", a
 * meaning-changing edit) was wrongly counted as "1 change" and admitted by `K=2`.
 *
 * A hunk whose stripped raw side is PURELY Han and whose stripped polished side
 * is PURELY non-Han (or vice versa) is this product's dominant open-class case —
 * an ASR homophone corrected to its Latin brand-name spelling (`打开飞麦克`->
 * `打开FlowMic`, i.e. the mis-heard "打开飞麦克" corrected to "打开FlowMic" /
 * "open FlowMic") — and counts as exactly ONE token. Same-script hunks
 * (Han<->Han or Latin<->Latin, the `他很高兴` ["he was quite happy"] shape) get NO such exemption.
 */
function openClassTokenDelta(rawStripped: string, polStripped: string): number {
  const rawLen = [...rawStripped].length;
  const polLen = [...polStripped].length;
  const rawHan = countHan(rawStripped);
  const polHan = countHan(polStripped);
  const rawIsPureHan = rawLen > 0 && rawHan === rawLen;
  const polIsPureHan = polLen > 0 && polHan === polLen;
  const rawIsPureOther = rawLen > 0 && rawHan === 0;
  const polIsPureOther = polLen > 0 && polHan === 0;
  if ((rawIsPureHan && polIsPureOther) || (rawIsPureOther && polIsPureHan)) return 1;
  return Math.max(countMixedTokens(rawStripped), countMixedTokens(polStripped));
}

/**
 * What the §3.1 bounds actually measured on this pair.
 *
 * 🔴 THIS EXISTS BECAUSE "rejected" IS NOT AN ACTIONABLE FACT. The repo's own
 * no-silent-failure rule is not satisfied by recording THAT something failed,
 * only by recording enough to act on it — the same argument that put `budgetMs`
 * and `elapsedMs` on the polish timeout line after a budget that could never fit
 * the job survived a whole release. `edit-distance-exceeded` alone cannot tell
 * you whether the model rewrote the sentence or whether the bound is one
 * character too tight, and those have opposite fixes.
 *
 * It is also how the C8 calibration was set: the smooth bounds are the observed
 * worst case over the corpus's own `filler` family, read out of this field,
 * rather than round numbers chosen for comfort.
 *
 * ⚠️ Diagnostics only. Nothing branches on these — the verdict is `ok`.
 * Populated on accepts as well as rejects, because a distribution of ACCEPTED
 * distances is what tells you how much headroom a bound really has.
 *
 * ⚠️ ABSENT in exactly two cases, both of which are "the §3.1 bounds were never
 * consulted": an identical pair (returns early, nothing was measured) and a
 * §3.2 closed-class rejection (that gate is K-independent and runs before the
 * diff, so computing a distance there would be work done only to fill in a
 * field). Absent means NOT MEASURED — it does not mean zero, and a reader must
 * not render it as one.
 */
export interface GuardMetrics {
  distance: number;
  editBound: number;
  /** polished/raw by codepoint count. Only enforced at/above RATIO_MIN_LEN. */
  lengthRatio: number;
  openClassDelta: number;
  openClassK: number;
}

export interface GuardResult { ok: boolean; reason?: string; metrics?: GuardMetrics }

export interface GuardOpts {
  /** Card C8. Absent ⇒ `strict` ⇒ the verbatim legacy calibration, so every
   *  existing caller and every ported vector is unaffected by the parameter's
   *  existence. */
  strength?: PolishStrength;
}

/**
 * §3 meaning-preservation guard. Accepts only when BOTH the §3.1 cardinality
 * bound AND the §3.2 closed-class invariant hold; §3.2 is checked FIRST and is
 * K-independent — ANY closed-class multiset drift rejects regardless of how small
 * the edit otherwise is. Pure, deterministic, no network/clock dependency.
 *
 * Card C8 adds a STRENGTH parameter. It moves the §3.1 bounds only; §3.2 is
 * identical at every strength. See the calibration block above for which axes
 * move, which do not, and the measurement that set the numbers.
 */
export function checkMeaningPreserved(
  rawText: string,
  polishedText: string,
  opts: GuardOpts = {},
): GuardResult {
  if (rawText === polishedText) return { ok: true };

  const bounds = boundsFor(opts.strength ?? DEFAULT_POLISH_STRENGTH);

  // §3.2 — hard gate, K-independent, and STRENGTH-independent. A smoothing pass
  // may delete a filler; it may not change a negation, a number, or a modal.
  const rawClosed = closedClassMultiset(rawText);
  const polClosed = closedClassMultiset(polishedText);
  for (const term of CLOSED_CLASS_TERMS) {
    if ((rawClosed.get(term) ?? 0) !== (polClosed.get(term) ?? 0)) {
      return { ok: false, reason: `closed-class-drift:${term}` };
    }
  }

  // §3.1 — cardinality bound (necessary, not sufficient).
  const rawLen = [...rawText].length;
  const polLen = [...polishedText].length;
  const { distance, hunks } = diffChars(rawText, polishedText);
  const editBound = Math.max(bounds.editFloor, bounds.editRatio * rawLen);

  // Computed BEFORE the first early return so that every verdict carries the
  // full picture. A rejection that only reports the axis it tripped on cannot
  // answer "was it close on the others too", which is the question calibration
  // actually needs.
  let openClassDelta = 0;
  for (const h of hunks) {
    openClassDelta += openClassTokenDelta(
      stripClosedClassAndPunct(h.rawText),
      stripClosedClassAndPunct(h.polText),
    );
  }
  const metrics: GuardMetrics = {
    distance,
    editBound,
    lengthRatio: polLen / Math.max(1, rawLen),
    openClassDelta,
    openClassK: bounds.openClassK,
  };

  if (distance > editBound) return { ok: false, reason: 'edit-distance-exceeded', metrics };

  if (rawLen >= RATIO_MIN_LEN) {
    if (metrics.lengthRatio > bounds.lengthRatioMax || metrics.lengthRatio < bounds.lengthRatioMin) {
      return { ok: false, reason: 'length-ratio-exceeded', metrics };
    }
  }

  const hanRaw = countHan(rawText);
  const hanPol = countHan(polishedText);
  if (Math.abs(hanRaw - hanPol) > editBound) return { ok: false, reason: 'han-count-exceeded', metrics };

  if (openClassDelta > bounds.openClassK) return { ok: false, reason: 'open-class-delta-exceeded', metrics };

  return { ok: true, metrics };
}
