// NR118-4: SHADOW ONLY. Callers must continue to deliver using v1's verdict.
import { checkMeaningPreserved, closedClassMultiset, CLOSED_CLASS_TERMS, diffChars, type GuardOpts, type GuardResult } from './stt-polish-guard';
import { checkOriginalBounds } from './stt-polish-guard-bounds';
import { CLOSED_CLASS_CATEGORIES } from './stt-polish-guard-terms';
import { HAN_NUMBER, NUMBER_CHAR, LEX_NUM, UNIT_CJK, numericValue } from './stt-polish-guard-numerals';

export interface ShadowResult extends GuardResult { explained: { r1: number; r2: number; r3: number } }
interface Hunk { rawText: string; polText: string; a: number; b: number }

/** Locate the existing diff's hunks in their shared, unchanged context. */
function alignedHunks(raw: string, polished: string): Hunk[] {
  const hunks: Hunk[] = [];
  diffChars(raw, polished, (h, a, b) => hunks.push({ ...h, a, b }));
  return hunks;
}

export function buildStutterTerms(terms: readonly string[]): string[] {
  return [...new Set(terms)]
    .filter(t => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(t)
      && !HAN_NUMBER.test(t) && !CLOSED_CLASS_CATEGORIES.negation.includes(t))
    .sort((a, b) => b.length - a.length);
}

export const STUTTER_TERMS = buildStutterTerms([...CLOSED_CLASS_CATEGORIES.modal, ...CLOSED_CLASS_CATEGORIES.quantifier]);

function collapseStutter(s: string): { text: string; n: number } {
  let n = 0;
  for (const term of STUTTER_TERMS) {
    const re = new RegExp(`${term}(?:${term})+`, 'gu');
    s = s.replace(re, match => { n += match.split(term).length - 2; return term; });
  }
  return { text: s, n };
}

function numeralHunk(h: Hunk, raw: string, polished: string): boolean {
  const { rawText: a, polText: b } = h;
  if (!((HAN_NUMBER.test(a) && /^[0-9]+$/.test(b)) || (HAN_NUMBER.test(b) && /^[0-9]+$/.test(a)))) return false;
  const han = HAN_NUMBER.test(a) ? a : b;
  // AABB / ABAB digit idioms are ambiguous words, not normalized quantities.
  if (/^(.)\1(.)\2$/u.test(han) || /^(.{2})\1$/u.test(han)) return false;
  const beforeA = raw[h.a - 1] ?? '', beforeB = polished[h.b - 1] ?? '';
  const afterA = raw[h.a + a.length] ?? '', afterB = polished[h.b + b.length] ?? '';
  // Whole maximal numeral run on BOTH sides, including mixed forms.
  if ([beforeA, beforeB, afterA, afterB].some(c => NUMBER_CHAR.test(c))) return false;
  if (han === '一') return false;
  if (LEX_NUM.has(han) || LEX_NUM.has(han + (HAN_NUMBER.test(a) ? afterA : afterB))) return false;
  if (numericValue(a) === null || numericValue(b) === null) return false;
  if (afterA === '点' || afterB === '点') return false;
  return han.length >= 2 || (afterA === afterB && (afterA === '' || /[\p{P}\s]/u.test(afterA) || UNIT_CJK.has(afterA)));
}

/** Ordering is intentional: a multiset would let quantities trade their subjects. */
function sameOrderedValues(a: bigint[], b: bigint[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function checkMeaningPreservedV2(rawText: string, polishedText: string, opts: GuardOpts & { language?: string } = {}): ShadowResult {
  const explained = { r1: 0, r2: 0, r3: 0 };
  const live = checkMeaningPreserved(rawText, polishedText, opts);
  if (live.ok) return { ...live, explained }; // monotonicity: no stricter decision than v1
  // No negation count is ever explained away, even an adjacent repeated one.
  const originalClosed = closedClassMultiset(rawText), polishedClosed = closedClassMultiset(polishedText);
  if (CLOSED_CLASS_CATEGORIES.negation.some(t => (originalClosed.get(t) ?? 0) !== (polishedClosed.get(t) ?? 0))) return { ...live, explained };
  const lang = opts.language?.toLowerCase().split(/[-_]/)[0];
  // Only full-width DIGITS are normalized; NFKC of arbitrary text changes words.
  let raw = rawText.replace(/[０-９]/g, c => c.normalize('NFKC'));
  let polished = polishedText.replace(/[０-９]/g, c => c.normalize('NFKC'));
  if (raw !== rawText || polished !== polishedText) {
    const values = (s: string): (bigint | null)[] => (s.match(/[零〇一二两三四五六七八九十百千万亿億幺0-9]+/g) ?? []).map(numericValue);
    const a = values(raw), b = values(polished);
    if (a.some(v => v === null) || b.some(v => v === null) || !sameOrderedValues(a as bigint[], b as bigint[])) return { ...live, explained };
    explained.r1++;
  }
  const a = collapseStutter(raw);
  raw = a.text; explained.r2 = a.n;
  const hunks = alignedHunks(raw, polished);
  const numeralHunks = (lang === 'zh' || lang === 'ja') ? hunks.filter(h => numeralHunk(h, raw, polished)) : [];
  const ordered = sameOrderedValues(numeralHunks.map(h => numericValue(h.rawText)!), numeralHunks.map(h => numericValue(h.polText)!));
  const replacements = new Map<Hunk, 'r1' | 'r3'>();
  if (ordered) for (const h of numeralHunks) replacements.set(h, 'r1');
  for (const h of hunks) {
    if (lang === 'zh' && (h.rawText === '的' || h.rawText === '地') && h.polText === '得'
      && h.a > 0 && h.b > 0 && raw[h.a - 1] === polished[h.b - 1]
      && mannerComplement(raw.slice(0, h.a), raw.slice(h.a + 1))) replacements.set(h, 'r3');
  }
  // Replacing from the right preserves the original offsets. The same non-word
  // placeholder on both sides removes ONLY the explained closed-class difference.
  for (const h of [...hunks].reverse()) {
    const rule = replacements.get(h);
    if (!rule) continue;
    raw = raw.slice(0, h.a) + '¤' + raw.slice(h.a + h.rawText.length);
    polished = polished.slice(0, h.b) + '¤' + polished.slice(h.b + h.polText.length);
    explained[rule]++;
  }
  const rawClosed = closedClassMultiset(raw), polClosed = closedClassMultiset(polished);
  for (const term of CLOSED_CLASS_TERMS) {
    if ((rawClosed.get(term) ?? 0) !== (polClosed.get(term) ?? 0)) return { ok: false, reason: `closed-class-drift:${term}`, explained };
  }
  return { ...checkOriginalBounds(rawText, polishedText, opts), explained };
}

// A conservative surface rule, not a Chinese parser: an allowlisted action verb
// plus a complete manner/degree complement. Pronouns/nouns and a following action
// (e.g. 你的去) do not qualify. Valid unlisted complements remain v1 rejects.
function mannerComplement(before: string, after: string): boolean {
  return /(?:跑|走|跳|唱|说|写|做|吃|睡|笑)$/u.test(before)
    && /^(?:很|真|太|更)?(?:快|慢|好|清楚|认真|漂亮|香|开心|远|高)(?:[，。！？、,.!?]|$)/u.test(after);
}
