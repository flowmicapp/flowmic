// NR-245 (GUARD-2, 2026-10-13): closed-class WORDS the §3.2 term table cannot
// express, compared by count on each side.
//
// The term table (stt-polish-guard-terms.ts) matches a term as a plain
// substring (zh) or a whole word (en …). Some meaning-bearing words need a
// context rule — 有时 is "sometimes" but 有时间 is "have time"; 和 is "and" but
// 和平 is "peace" — so they live here as regexes, one count per word.
//
// Each family below was an accepted meaning change at BOTH strengths before
// this file (pinned in test/fixtures/polish-guard-adversarial.jsonl):
//   · modality:    我们可以下周发 -> 我们下周发 (a permission became a plan);
//   · frequency:   We usually deploy -> We always deploy;
//   · multiplier:  it failed twice -> it failed once;
//   · ordinal:     take the first exit -> take the second exit;
//   · halves:      开了一个半小时 -> 开了一个小时, one and a half hours -> one hour;
//   · conjuncts:   把合同发给张伟和李明 -> 把合同发给张伟 (a recipient vanished).
//
// Cost, stated: a correct rewrite that swaps one of these words for a synonym
// (可以 -> 能, twice -> two times) is refused. Under smooth that falls back to
// one strict attempt (stt-polish.ts), which keeps words as they are.
//
// 半 after 点 is not counted: 两点半 is a time and the numbers gate reads it as
// 2:30 (stt-polish-guard-numbers.ts `点半`), so 两点半 -> 2:30 stays neutral.

interface CountedWord { word: string; re: RegExp }

const ZH: readonly (readonly [string, string])[] = [
  // modality
  ['可以', '可以'], ['务必', '务必'], ['应当', '应当'],
  // frequency (有时间 is "have time")
  ['总是', '总是'], ['经常', '经常'], ['通常', '通常'], ['往往', '往往'], ['常常', '常常'],
  ['偶尔', '偶尔'], ['有时', '有时(?!间)'], ['从来', '从来'], ['永远', '永远'], ['很少', '很少'],
  // halves
  ['半', '(?<!点)半'],
  // conjuncts: a dropped 和 / 与 / 以及 drops a whole coordinated item. One
  // CLASS: 以及 -> 和 is the same word in another register (review round).
  ['和', '(?<![暖总温缓柔随附讲])和(?![平谐蔼解睦])|(?<![参给赋授])与(?![会])|以及'],
];

const EN: readonly string[] = [
  // frequency
  'always', 'usually', 'often', 'sometimes', 'rarely', 'seldom', 'occasionally', 'frequently', 'normally',
  // multipliers
  'once', 'twice', 'thrice',
  // ordinals ('second' is handled below: "a second" is a time)
  'first', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  // halves
  'half',
];

// Counted by CLASS, the same classes the number marks use
// (stt-polish-guard-number-marks.ts BEFORE: '~' and '<'): nearly -> almost is
// neutral, nearly -> roughly or a dropped "nearly" is not (review round).
const EN_CLASSES: readonly (readonly [string, readonly string[]])[] = [
  ['approx~', ['approximately', 'roughly']],
  ['approx<', ['nearly', 'almost']],
];

const wholeWord = (w: string): string => `(?<![\\p{L}\\p{N}_])${w}(?![\\p{L}\\p{N}_])`;

const WORDS: readonly CountedWord[] = [
  ...ZH.map(([word, src]) => ({ word, re: new RegExp(src, 'gu') })),
  ...EN.map((word) => ({ word, re: new RegExp(wholeWord(word), 'giu') })),
  ...EN_CLASSES.map(([word, ws]) => ({ word, re: new RegExp(ws.map(wholeWord).join('|'), 'giu') })),
  // The ordinal, not the time unit: "a second", "one second", "per second", "5 second".
  { word: 'second', re: new RegExp(`(?<!(?:^|[^\\p{L}])(?:a|one|per|each|[0-9]+)\\s+)${wholeWord('second')}`, 'giu') },
];

function countWords(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const { word, re } of WORDS) out.set(word, (text.match(re) ?? []).length);
  return out;
}

/** First counted closed-class word whose count differs between the two texts, or null. */
export function closedWordDrift(raw: string, polished: string): string | null {
  const a = countWords(raw);
  const b = countWords(polished);
  for (const { word } of WORDS) if ((a.get(word) ?? 0) !== (b.get(word) ?? 0)) return word;
  return null;
}

// ─── negation scope ─────────────────────────────────────────────────────────
//
// 这个不是很好 -> 这个很不好 keeps one 不 and one 很, so every count above and
// in the §3.2 table is equal, yet "not very good" became "very bad". Not all
// files were deleted -> All files were not deleted is the English twin. What
// moved is the ORDER of a negation and the degree / quantity word next to it,
// so each side records which of the two comes first wherever they touch, and
// the two records are compared by count.
//
// Deliberately narrow: only a negation directly before or after one of the
// listed words (Chinese allows a 是 in between: 不是很). A negation that moves
// anywhere else is either a count change (refused by §3.2) or not caught here.
// `really` is left out: "I don't really think" -> "I don't think" is the
// filler removal smooth exists for.
const ZH_NEG = '(?:不是|没有|不|没|别|未)';
const ZH_DEGREE = '(?:非常|特别|十分|那么|这么|完全|一定|总是|一直|绝对|必须|很|太|都|全)';
const ZH_NEG_FIRST = new RegExp(`${ZH_NEG}(${ZH_DEGREE})`, 'gu');
const ZH_DEGREE_FIRST = new RegExp(`(${ZH_DEGREE})(?:是)?${ZH_NEG}`, 'gu');
const EN_DEGREE = '(?:all|every|everyone|everything|always|very|quite|too|necessarily|both|many|much)';
const EN_NEG_FIRST = new RegExp(`(?<![\\p{L}\\p{N}_])(?:not|never|\\p{L}+n['’]t)\\s+(${EN_DEGREE})(?![\\p{L}\\p{N}_])`, 'giu');

function scopeCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string): void => { out.set(k, (out.get(k) ?? 0) + 1); };
  for (const m of text.matchAll(ZH_NEG_FIRST)) add(`neg>${m[1]}`);
  for (const m of text.matchAll(ZH_DEGREE_FIRST)) add(`${m[1]}>neg`);
  for (const m of text.matchAll(EN_NEG_FIRST)) add(`neg>${m[1]!.toLowerCase()}`);
  return out;
}

/** The first negation-scope pattern whose count differs, or null. */
export function negationScopeDrift(raw: string, polished: string): string | null {
  const a = scopeCounts(raw);
  const b = scopeCounts(polished);
  for (const k of new Set([...a.keys(), ...b.keys()])) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) return k;
  return null;
}
