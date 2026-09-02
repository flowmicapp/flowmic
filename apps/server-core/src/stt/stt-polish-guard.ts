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
//     Divergence from legacy: WP8 P1-2 extended the closed-class TABLES
//     (stt-polish-guard-terms.ts) to the spoken set and generalised the
//     word-boundary matcher from ASCII `\b` to a Unicode letter-boundary so
//     Cyrillic and Hangul are visible. Cardinality calibration is untouched.
//   docs/decisions/2026-07-20-wp4c-polish-guard-calibration.md (legacy calibration)
//
// This file owns ONLY the §3 meaning-preservation guard: `checkMeaningPreserved`
// is the make-or-break mechanism — a two-part accept/reject verdict that
// `polishFinalText` (stt-polish.ts) must honour before ever letting a polished
// string replace the raw final. Split out to respect the file-size cap.

import { DEFAULT_POLISH_STRENGTH, type PolishStrength } from '@flowmic/protocol';
import {
  CLOSED_CLASS_TERMS,
  WORD_BOUNDARY_TERMS,
} from './stt-polish-guard-terms';

export {
  CLOSED_CLASS_ADDED,
  CLOSED_CLASS_GUARDED_LANGS,
  CLOSED_CLASS_TERMS,
  WORD_BOUNDARY_TERMS,
  isClosedClassGuarded,
} from './stt-polish-guard-terms';

// ─── §3.2 closed-class matching (K-independent hard gate) ───────────
//
// Term tables live in stt-polish-guard-terms.ts (WP8 P1-2). Two strategies,
// same as the legacy guard: substring (zh/ja/digits/`n't`) and Unicode
// letter-boundary (en/fr/es/de/ko/ru). `\b` was ASCII-only, so it could not
// see Cyrillic or Hangul; the lookaround is the same strategy, not a third.
// English hits are unchanged — pinned by stt-polish-guard-langs.test.ts.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Count occurrences of every closed-class term in `text`. zh/ja terms +
 *  digits are counted as plain substrings (no word boundaries);
 *  space-separated terms use a case-insensitive Unicode letter-boundary;
 *  `n't` is a boundary-less suffix substring. */
export function closedClassMultiset(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const lower = text.toLowerCase();
  for (const term of CLOSED_CLASS_TERMS) {
    let count: number;
    if (term === "n't") {
      count = lower.split("n't").length - 1;
    } else if (WORD_BOUNDARY_TERMS.has(term)) {
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`,
        'giu',
      );
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

/**
 * 🔴 card A8 — this used to strip EVERY closed-class term with a blanket
 * `split(term).join('')`, i.e. a plain substring match with no word boundary
 * at all — even for the WORD_BOUNDARY_TERMS (en/fr/es/de/ko/ru) that
 * `closedClassMultiset` above already knows must be boundary-checked. A term
 * like "not" then matched INSIDE "nothing" (`"nothing".split("not").join('')`
 * → `"hing"`), and "no" matched INSIDE "nowhere" (→ `"where"`) — any word that
 * happens to start or end with a closed-class term's letters lost that
 * fragment, whether or not it was ever a separate word. This silently WIDENS
 * the open-class token-delta gate for exactly the Latin-script languages it
 * exists to protect, because the stripped remainder is what §3.1's cardinality bound
 * counts as "real" content.
 *
 * Fix: the SAME per-term strategy `closedClassMultiset` uses — word-boundary
 * regex for `WORD_BOUNDARY_TERMS`, plain substring for everything else
 * (zh/ja/digits/`n't`, none of which have a script-level word boundary to
 * check). One rule, read from the same table, so the two cannot drift apart a
 * second time.
 */
export function stripClosedClassAndPunct(s: string): string {
  let out = s;
  for (const term of CLOSED_CLASS_TERMS) {
    if (WORD_BOUNDARY_TERMS.has(term)) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'giu');
      out = out.replace(re, '');
    } else {
      out = out.split(term).join('');
    }
  }
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
  /**
   * The terms the USER declared (scenario card + dictionary packs + personal
   * dictionary). An edit that introduces one of these does not count against the
   * §3.1 cardinality budget.
   *
   * 🔴 WHY THIS EXISTS — measured 2026-08-24 against the production DeepSeek
   * line (report: .local/pipeline-probe/polish-context-eval.json). With the
   * scenario block carrying the user's own term list, the model answered
   * 「这批数据都存在洛克斯托里面」 with 「…存在Rockstore里面」 — exactly the
   * correction the whole terminology feature exists to produce — AND THE GUARD
   * THREW IT AWAY as `edit-distance-exceeded`. It had to: four Han characters
   * became nine Latin ones, which IS a large character-level edit. The same run
   * refused 「打开FlowMic…」 as `length-ratio-exceeded`.
   *
   * So the budget was not wrong about the DISTANCE, it was wrong about what the
   * distance MEANT. Substituting a span with a term the user themselves typed
   * into their settings is the intended behaviour; counting it as drift makes
   * the guard refuse the product's differentiator, and refusing correct work is
   * how a guard gets loosened until it never fires (this file's own history).
   *
   * ⚠️ DELIBERATELY NOT A WIDER BOUND. The measured calibration above does not
   * move by a single digit — a blanket loosening would buy this case by paying
   * for every other case too. The allowance is capped by the declared terms'
   * OWN LENGTHS and applies only to terms present in the output and absent from
   * the input, so a model cannot use it to smuggle content: the most it can add
   * for free is the words the user already asked for.
   *
   * ⚠️ §3.2 (closed-class multiset) is NOT touched by this and must never be. A
   * declared term cannot license a negation flip.
   */
  declaredTerms?: readonly string[];
}

/**
 * How many characters of divergence are explained by the user's own vocabulary.
 *
 * A term counts only when it is ABSENT from the input and PRESENT in the output
 * — i.e. the model introduced it. A term that was already in both was never part
 * of the delta, and giving it an allowance would hand out budget for work nobody
 * did.
 */
function declaredTermAllowance(raw: string, polished: string, terms: readonly string[]): number {
  let allowance = 0;
  const seen = new Set<string>();
  for (const raw_term of terms) {
    const term = raw_term.trim();
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    if (!polished.includes(term)) continue;
    if (raw.includes(term)) continue;
    allowance += [...term].length;
  }
  return allowance;
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
  // The user's own vocabulary, discounted from the budget rather than added to
  // the bound — see GuardOpts.declaredTerms. `allowance` is 0 for every caller
  // that passes no terms, so the legacy calibration is bit-for-bit unchanged
  // wherever this feature is not in play.
  const allowance = opts.declaredTerms && opts.declaredTerms.length > 0
    ? declaredTermAllowance(rawText, polishedText, opts.declaredTerms)
    : 0;
  const editBound = Math.max(bounds.editFloor, bounds.editRatio * rawLen) + allowance;

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
    // The same allowance applies here, and for the same reason: 「打开飞麦克…」
    // -> 「打开FlowMic…」 grows the string because the declared term is longer
    // than what was misheard. Measured on the production line 2026-08-24 — that
    // exact pair was refused as `length-ratio-exceeded` while being correct.
    // The ratio is judged against a length that already accounts for the term
    // the user asked for; `lengthRatio` in `metrics` stays the RAW measurement,
    // because a metric that quietly reports an adjusted number would make every
    // future calibration read from a value that is not the thing it names.
    const adjustedPolLen = Math.max(1, polLen - allowance);
    const adjustedRatio = adjustedPolLen / Math.max(1, rawLen);
    if (adjustedRatio > bounds.lengthRatioMax || adjustedRatio < bounds.lengthRatioMin) {
      return { ok: false, reason: 'length-ratio-exceeded', metrics };
    }
  }

  const hanRaw = countHan(rawText);
  const hanPol = countHan(polishedText);
  if (Math.abs(hanRaw - hanPol) > editBound) return { ok: false, reason: 'han-count-exceeded', metrics };

  if (openClassDelta > bounds.openClassK) return { ok: false, reason: 'open-class-delta-exceeded', metrics };

  return { ok: true, metrics };
}
