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
 *  drift in either the phrase or a component char is caught. */
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

export interface GuardResult { ok: boolean; reason?: string }

/**
 * §3 meaning-preservation guard. Accepts only when BOTH the §3.1 cardinality
 * bound AND the §3.2 closed-class invariant hold; §3.2 is checked FIRST and is
 * K-independent — ANY closed-class multiset drift rejects regardless of how small
 * the edit otherwise is. Pure, deterministic, no network/clock dependency.
 */
export function checkMeaningPreserved(rawText: string, polishedText: string): GuardResult {
  if (rawText === polishedText) return { ok: true };

  // §3.2 — hard gate, K-independent.
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
  const editBound = Math.max(EDIT_DISTANCE_FLOOR, EDIT_DISTANCE_RATIO * rawLen);
  if (distance > editBound) return { ok: false, reason: 'edit-distance-exceeded' };

  if (rawLen >= RATIO_MIN_LEN) {
    const ratio = polLen / Math.max(1, rawLen);
    if (ratio > 1.5 || ratio < 0.5) return { ok: false, reason: 'length-ratio-exceeded' };
  }

  const hanRaw = countHan(rawText);
  const hanPol = countHan(polishedText);
  if (Math.abs(hanRaw - hanPol) > editBound) return { ok: false, reason: 'han-count-exceeded' };

  let openClassDelta = 0;
  for (const h of hunks) {
    openClassDelta += openClassTokenDelta(
      stripClosedClassAndPunct(h.rawText),
      stripClosedClassAndPunct(h.polText),
    );
  }
  if (openClassDelta > OPEN_CLASS_K) return { ok: false, reason: 'open-class-delta-exceeded' };

  return { ok: true };
}
