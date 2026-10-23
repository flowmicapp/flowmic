// QP-1 (2026-10-13): the guard compares NUMBERS, not numeral CHARACTERS.
//
// Why: §3.2 used to count every 一 二 … 千 万 and every ASCII digit as a
// closed-class term. A character is not a number. On the Tokyo relay
// (2026-09-29..10-13) 17 of the 31 realtime polishes our own guard threw away
// were "numeral drift" with a digit delta of 0 — the 一 in 一下 / 一些 / 一直 /
// 一个一个, or the 千万 / 一定 adverbs, removed or reshaped by a correct
// smoothing pass. The fix is to extract the numeric expressions on each side
// and compare their VALUES:
//   · Arabic digits (full-width folded, 1,000 == 1000, 3万 / 1.5万 scaled, %);
//   · Chinese numerals incl. 十百千万亿 compounds and the spoken elision
//     (三万二 == 32000, 两千五 == 2500), 两 == 二, 〇/零;
//   · English number words (fifteen, twenty-one, three hundred and five).
// Lexicalized 一-words (一下, 一些, 一直, …), 千万 used as an adverb, 一点 as
// "a little", and V一V reduplication (看一看) are not numbers. They are masked
// for the number reading, but the ones that carry meaning (一直, 一起, 一些,
// 唯一, 一共, 十分 …) are compared as closed-class WORDS by [[lexicalDrift]]:
// 一直 -> 有时 is a frequency change, not a numeral change (QP-1 review).
// An immediately repeated span is canonicalized, not collapsed: 一个一个 ==
// 一个个, but neither == 一个 (the repetition is meaning, not a stutter).
// When the values differ, a pure regrouping of Arabic digits is still neutral
// (409048G -> 4090 48G, 1,000 -> 1000) — but only whitespace or commas between
// digits may move; decimal points and scale words (万, million, k, %) may not.
//
// Sequence, not multiset — a deliberate departure from the QP-1 card text: the
// NR118 corpus already pins 三个苹果五个梨 -> 5个苹果3个梨 as harmful (the
// values survive, their subjects swap; test/fixtures/polish-guard-v2-pairs.jsonl
// nr118-017), and a multiset cannot see it. The cost is that a reordered
// self-correction (两点不对是三点 -> 三点，不是两点) is refused here; reordering
// is forbidden by the prompt anyway (RULE_NO_REORDER in stt-polish-prompts.ts),
// and the Smooth -> Strict fallback in stt-polish.ts recovers that utterance.
//
// Kept harmful on purpose (pinned by test/stt-polish-guard-qp1.test.ts):
// 三点->两点, 五千->五百, 二十->十二, 15->50, fifteen->fifty, 3万->3千, 1.5->15,
// 三四个->34个, 一个一个->一个, two three days->five days.

import { cutsCompatible, digitCuts, numberMark, signSurface } from './stt-polish-guard-number-marks';
import { localNumberSurface, wordNumbers } from './stt-polish-guard-numwords';

const HAN_DIGIT: Record<string, bigint> = {
  零: 0n, 〇: 0n, 一: 1n, 幺: 1n, 二: 2n, 两: 2n, 三: 3n, 四: 4n, 五: 5n, 六: 6n, 七: 7n, 八: 8n, 九: 9n,
};
const HAN_SMALL_UNIT: Record<string, bigint> = { 十: 10n, 百: 100n, 千: 1000n };
const HAN_BIG_UNIT: readonly (readonly [string, bigint])[] = [['亿', 100000000n], ['億', 100000000n], ['万', 10000n], ['萬', 10000n]];
const HAN_NUM_CLASS = '零〇一幺二两三四五六七八九十百千万萬亿億';
const HAN_RUN_RE = new RegExp(`[${HAN_NUM_CLASS}]+`, 'gu');
const HAN_NUM_CHAR_RE = new RegExp(`[${HAN_NUM_CLASS}]`, 'u');
const NUMBER_BEFORE_RE = new RegExp(`[0-9${HAN_NUM_CLASS}第]$`, 'u');

/** Placeholder for a masked span: not a letter, not a digit, not a numeral. */
const MASK = '¤';
/** Marker for a canonicalized repetition (一个一个 / 一个个 -> 一个⁂). */
const REP = '⁂';

// Words that contain a numeral character but are not a quantity.
// DROPPABLE: masked only — removing them is a smoothing edit (看一下 -> 看看,
// 快一点儿 -> 快点). COUNTED: masked for the number reading AND compared as
// words, because each one carries meaning (frequency, togetherness, scope,
// degree): 一直 -> 有时, 一起 -> 分别, 唯一 -> 主要, 十分 -> 有点 must refuse.
const DROPPABLE_LEXICAL: readonly string[] = ['一下子', '一点儿', '一点点', '一下'];
const COUNTED_LEXICAL: readonly string[] = [
  '一模一样', '一方面', '一口气', '一五一十', '一心一意',
  '一些', '一直', '一起', '一样', '一般', '一切', '一旦', '一边', '一会', '一致', '一定',
  '一向', '一同', '一共', '一时', '一再', '一律', '一概', '一贯', '一齐', '一阵', '一番', '一面',
  '一并', '一味', '一旁', '一道', '一流', '一体', '一路', '统一', '唯一', '万一', '逐一', '专一', '一一',
  '十分', '十足', '万万', '万分', '乱七八糟', '七上八下', '三心二意', '五花八门',
  '零食', '零钱', '零件', '零售', '零星', '零散', '零碎',
  '一生懸命', '一緒', '一応', '一番',
];
// Context in which a listed word is NOT lexical: 三点十分 / 十分钟 are times,
// 一下午 is "a whole afternoon".
const LEXICAL_NOT_BEFORE: Readonly<Record<string, string>> = { 十分: '钟', 一下: '午' };
const LEXICAL_NOT_AFTER: Readonly<Record<string, string>> = { 十分: '点' };

interface LexicalRule { word: string; counted: boolean; re: RegExp }
const LEXICAL_RULES: readonly LexicalRule[] = [
  ...DROPPABLE_LEXICAL.map(word => ({ word, counted: false })),
  ...COUNTED_LEXICAL.map(word => ({ word, counted: true })),
].sort((a, b) => b.word.length - a.word.length).map(({ word, counted }) => {
  // A word that starts with a numeral is only lexical when it does not continue
  // a number: 万一 is "in case", but 三万一千 is 31000. An ASCII digit only
  // blocks a unit-initial word (3万一千); 015一共15页 keeps its 一共.
  const first = word[0]!;
  const blockers = !HAN_NUM_CHAR_RE.test(first) ? '' : first === '一' ? `${HAN_NUM_CLASS}第` : `0-9${HAN_NUM_CLASS}第`;
  const notAfter = LEXICAL_NOT_AFTER[word];
  const notBefore = LEXICAL_NOT_BEFORE[word];
  const behind = (blockers ? `(?<![${blockers}])` : '') + (notAfter ? `(?<!${notAfter})` : '');
  const ahead = notBefore ? `(?!${notBefore})` : '';
  return { word, counted, re: new RegExp(`${behind}${word}${ahead}`, 'gu') };
});

// 千万 is a number after a numeral (三千万) or before a unit/noun of count;
// otherwise it is the adverb "by all means" (千万别 / 千万要 / 千万记得).
const QIANWAN_NUMERIC_AFTER = new RegExp(`^(?:[${'0-9元块人个位次级条张台家美欧日港英用名份件套辆部本字年户'}]|以上|左右|多)`, 'u');
// 一点 as "a little": preceded by an adjective/verb of degree — unless that
// "adjective" ends a time word (今晚一点, 最晚一点 are one o'clock).
const YIDIAN_QUANTITY_BEFORE = new RegExp(`[${'快慢早晚多少好大小高低长短轻重近远稍有再便贵强弱深浅松紧'}]$`, 'u');
const YIDIAN_TIME_WORD_BEFORE = new RegExp(`(?:${['今晚', '最晚', '昨晚', '当晚', '每晚', '傍晚', '最早'].join('|')})$`, 'u');
// 一点 as a time: a time-of-day / date word or a time preposition before it,
// or a time continuation after it ("一点开会" is the owner's own example).
const YIDIAN_TIME_BEFORE = /(?:早上|上午|中午|下午|晚上|凌晨|半夜|夜里|今天|明天|后天|昨天|前天|今晚|明早|[周]|星期|礼拜|到|在|于|约|从|至|改到|改成|推到|定在|提前到)[一二三四五六日天]?$/u;
const YIDIAN_TIME_AFTER = /^(?:钟|半|整|零|一刻|开会|开始|出发|见|前|后|之前|之后|左右|到|[0-9]|[一二三四五六七八九十][0-9一二三四五六七八九十]*分)/u;

const EN_ONES: Record<string, bigint> = {
  zero: 0n, one: 1n, two: 2n, three: 3n, four: 4n, five: 5n, six: 6n, seven: 7n, eight: 8n, nine: 9n,
  ten: 10n, eleven: 11n, twelve: 12n, thirteen: 13n, fourteen: 14n, fifteen: 15n, sixteen: 16n,
  seventeen: 17n, eighteen: 18n, nineteen: 19n,
};
const EN_TENS: Record<string, bigint> = {
  twenty: 20n, thirty: 30n, forty: 40n, fifty: 50n, sixty: 60n, seventy: 70n, eighty: 80n, ninety: 90n,
};
const EN_SCALES: Record<string, bigint> = { hundred: 100n, thousand: 1000n, million: 1000000n, billion: 1000000000n };
const EN_WORD = `(?:${[...Object.keys(EN_ONES), ...Object.keys(EN_TENS), ...Object.keys(EN_SCALES)].join('|')})`;
// A run of number words joined by spaces, hyphens or "and" (three hundred and five).
const EN_RUN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])${EN_WORD}(?:(?:\\s+and\\s+|[\\s-]+)${EN_WORD})*(?![\\p{L}\\p{N}_])`,
  'giu',
);
// "one" as a pronoun (this one, no one) is not a count.
const EN_PRONOUN_ONE_RE = /(?<![\p{L}\p{N}_])(this|that|which|each|every|no|any|some|the|another)\s+one(?![\p{L}\p{N}_])/giu;

const ARABIC_RE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(万|萬|亿|億|千|百)|\s*([kK])(?![\p{L}\p{N}_])|\s+(hundred|thousand|million|billion)(?![\p{L}\p{N}_]))?(\s*%)?/gu;
const ARABIC_SCALE: Record<string, bigint> = {
  万: 10000n, 萬: 10000n, 亿: 100000000n, 億: 100000000n, 千: 1000n, 百: 100n, k: 1000n,
  hundred: 100n, thousand: 1000n, million: 1000000n, billion: 1000000000n,
};
// An Arabic number as written, with its decimal point and scale word / percent
// sign: only the whitespace or commas BETWEEN digits may move in a regrouping.
const ARABIC_SKELETON_RE = /[0-9](?:[0-9.]|[,\s](?=[0-9]))*(?:\s*(?:万|萬|亿|億|千|百|%|[kK](?![\p{L}\p{N}_]))|\s+(?:hundred|thousand|million|billion)(?![\p{L}\p{N}_]))?/gu;

function isNumberish(span: string): boolean {
  return [...span].every(c => /[0-9.,:/\-\s]/u.test(c) || HAN_NUM_CHAR_RE.test(c));
}

/** Canonicalize an immediately repeated span that contains a number:
 *  一个一个 -> 一个⁂ and 一个个 -> 一个⁂, so those two are equal while 一个
 *  (no repetition) is not. Spans made only of digits/numerals stay (11,
 *  三十三十), and English number words are never merged ("room two two" is
 *  two values). */
export function canonicalizeRepeats(s: string): string {
  const spans = s.replace(
    /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}0-9]{2,6}?)\1+/gu,
    (m, span: string) => (isNumberish(span) || !(/[0-9]/u.test(span) || HAN_NUM_CHAR_RE.test(span)) ? m : span + REP),
  );
  // numeral + doubled measure word: 一个个, 一步步, 5个个.
  return spans.replace(new RegExp(`([0-9${HAN_NUM_CLASS}])(\\p{Script=Han})\\2(?!${REP})`, 'gu'), (m, n: string, w: string) => (
    HAN_NUM_CHAR_RE.test(w) ? m : `${n}${w}${REP}`
  ));
}

/** Masks the lexical words; when `counts` is given, records the counted ones. */
function maskLexical(s: string, counts?: Map<string, number>): string {
  let out = s;
  for (const rule of LEXICAL_RULES) {
    out = out.replace(rule.re, () => {
      if (rule.counted && counts) counts.set(rule.word, (counts.get(rule.word) ?? 0) + 1);
      return MASK.repeat([...rule.word].length);
    });
  }
  return out;
}

function maskYidian(s: string, onLittle?: () => void): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const at = s.indexOf('一点', i);
    if (at < 0) { out += s.slice(i); break; }
    const before = s.slice(0, at);
    const after = s.slice(at + 2);
    // 十一点 / 第一点 continue a number and stay numeric.
    const time = NUMBER_BEFORE_RE.test(before) || YIDIAN_TIME_WORD_BEFORE.test(before)
      || (!YIDIAN_QUANTITY_BEFORE.test(before) && (YIDIAN_TIME_BEFORE.test(before) || YIDIAN_TIME_AFTER.test(after)));
    if (!time) onLittle?.();
    out += s.slice(i, at) + (time ? '一点' : MASK + MASK);
    i = at + 2;
  }
  return out;
}

function maskQianwan(s: string): string {
  return s.replace(/千万/gu, (m, offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + 2);
    const numeric = /[0-9零〇一幺二两三四五六七八九十百]$/u.test(before) || QIANWAN_NUMERIC_AFTER.test(after);
    return numeric ? m : MASK + MASK;
  });
}

function foldDigits(text: string): string {
  return text.replace(/[０-９]/gu, c => c.normalize('NFKC')).replace(/％/gu, '%');
}

/** The text the extractor reads: lexical non-numbers masked, repeats canonical.
 *  ML-1: `lang` rewrites that language's number format and spoken times first
 *  (stt-polish-guard-numwords.ts); absent ⇒ unchanged. */
export function numberSurface(text: string, lang?: string): string {
  let s = maskLexical(signSurface(localNumberSurface(foldDigits(text), lang)));
  s = maskYidian(s);
  s = maskQianwan(s);
  // Repeats first: in 一个一个 the 个一个 is not a V一V reduplication.
  s = canonicalizeRepeats(s);
  // V一V reduplication (看一看, 想一想) is "have a go", not a count.
  s = s.replace(/(\p{Script=Han})一\1/gu, (m, v: string) => (HAN_NUM_CHAR_RE.test(v) ? m : `${v}${MASK}${v}`));
  // 百分之五 is 5%: keep the percent attached to the number it scales.
  s = s.replace(new RegExp(`百分之([0-9${HAN_NUM_CLASS}.点]+)`, 'gu'), '$1%').replace(/百分百/gu, '100%');
  // 两点半 / 2点半 is 2:30.
  s = s.replace(/点半/gu, '点30');
  s = s.replace(EN_PRONOUN_ONE_RE, (_m, det: string) => `${det} ${MASK}`);
  return s;
}

/** The meaning-bearing lexical words (一直, 一起, 唯一, 十分 …) on this side. */
export function lexicalWordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  maskLexical(foldDigits(text), counts);
  const little = littleCount(foldDigits(text));
  if (little > 0) counts.set('一点', little);
  return counts;
}

// "A little" may be SHORTENED (快一点儿 -> 快一点 -> 快点) but not deleted:
// 还差一点点就做完了 -> 还差就做完了 and 我有一点儿不舒服 -> 我不舒服 change
// what was said (QP-1 review round 2). Every spelling counts once: 一点儿,
// 一点点, 一点 read as "a little", and a bare 点 right after a degree word.
const LITTLE_BARE_RE = new RegExp(`[${'快慢早晚多少好大小高低长短轻重近远稍有再便贵强弱深浅松紧差'}]点(?![0-9${HAN_NUM_CLASS}儿点钟半子])`, 'gu');
function littleCount(text: string): number {
  let n = 0;
  let s = text.replace(/一点[儿点]/gu, () => { n += 1; return MASK.repeat(3); });
  s = maskYidian(s, () => { n += 1; });
  n += (s.match(LITTLE_BARE_RE) ?? []).length;
  return n;
}

/** First counted lexical word whose count differs, or null. */
export function lexicalDrift(raw: string, polished: string): string | null {
  const a = lexicalWordCounts(raw);
  const b = lexicalWordCounts(polished);
  for (const w of new Set([...a.keys(), ...b.keys()])) if ((a.get(w) ?? 0) !== (b.get(w) ?? 0)) return w;
  return null;
}

function parseSection(s: string): bigint | null {
  // < 10000: digits and 十百千, with the spoken elision 一百二 == 120.
  let total = 0n;
  let pending: bigint | null = null;
  let lastUnit: bigint | null = null;
  let zeroSeen = false;
  for (const [i, c] of [...s].entries()) {
    const d = HAN_DIGIT[c];
    if (d !== undefined) {
      if (d === 0n) { zeroSeen = true; continue; }
      if (pending !== null) return null; // 三四百 is an estimate, not one value
      pending = d;
      continue;
    }
    const u = HAN_SMALL_UNIT[c];
    if (u === undefined) return null;
    if (lastUnit !== null && u >= lastUnit) return null;
    if (pending === null && !(i === 0 && u === 10n)) return null;
    total += (pending ?? 1n) * u;
    lastUnit = u;
    pending = null;
    zeroSeen = false;
  }
  if (pending !== null) {
    total += lastUnit !== null && lastUnit >= 100n && !zeroSeen ? pending * (lastUnit / 10n) : pending;
  }
  return total;
}

/** Value of a maximal Chinese numeral run, or null when it is not one value
 *  (an estimate such as 三四百 / 三四 or a malformed run). */
export function parseHanNumber(s: string): bigint | null {
  if (!/[十百千万萬亿億]/u.test(s)) {
    // Two adjacent numerals with no unit are an estimate (三四个, 一两天, 两三):
    // never read digit-by-digit, or 三四个 -> 34个 would look equal.
    const ds = [...s].map(c => HAN_DIGIT[c]);
    // Any two-numeral run counts (三五个 too), except a zero or 幺, which only
    // appear when digits are read out one by one (二零, 幺三).
    if (ds.length === 2 && !/[零〇幺]/u.test(s)) return null;
    // Digit-by-digit reading: 二零二六 == 2026, 幺三八 == 138.
    let v = 0n;
    for (const d of ds) { if (d === undefined) return null; v = v * 10n + d; }
    return v;
  }
  for (const [unit, value] of HAN_BIG_UNIT) {
    const at = s.indexOf(unit);
    if (at < 0) continue;
    const left = s.slice(0, at);
    const right = s.slice(at + unit.length);
    const lv = left.length === 0 ? 1n : parseHanNumber(left);
    if (lv === null) return null;
    let rv: bigint | null;
    if (right.length === 0) rv = 0n;
    else if ([...right].length === 1 && HAN_DIGIT[right] !== undefined && HAN_DIGIT[right] !== 0n) rv = HAN_DIGIT[right]! * (value / 10n); // 三万二
    else rv = parseHanNumber(right.replace(/^[零〇]+/u, ''));
    if (rv === null) return null;
    return lv * value + rv;
  }
  return parseSection(s);
}

/** Values of a run of English number words. Two words that cannot combine
 *  into one number (two three, two two, twenty twenty) start a new value, so
 *  "two three days" reads [2, 3] — the same as "two or three days". */
function parseEnglishRun(run: string): (bigint | null)[] {
  const words = run.toLowerCase().split(/(?:\s+and\s+|[\s-]+)/u).filter(Boolean);
  const values: (bigint | null)[] = [];
  let total = 0n;
  let current = 0n;
  let any = false;
  let last: 'none' | 'ones' | 'teen' | 'tens' | 'scale' = 'none';
  const flush = (): void => {
    if (any) values.push(total + current);
    total = 0n; current = 0n; any = false; last = 'none';
  };
  for (const w of words) {
    const one = EN_ONES[w];
    const ten = EN_TENS[w];
    const scale = EN_SCALES[w];
    if (one !== undefined) {
      const teen = one >= 10n;
      if (last === 'ones' || last === 'teen' || (last === 'tens' && teen)) flush();
      current += one; any = true; last = teen ? 'teen' : 'ones';
    } else if (ten !== undefined) {
      if (last === 'ones' || last === 'teen' || last === 'tens') flush();
      current += ten; any = true; last = 'tens';
    } else if (w === 'hundred') {
      current = (any ? current : 1n) * 100n; any = true; last = 'scale';
    } else if (scale !== undefined) {
      total += (any ? current : 1n) * scale; current = 0n; any = true; last = 'scale';
    } else {
      values.push(null);
    }
  }
  flush();
  return values;
}

export interface NumberReading {
  /** Every numeric value on this side, in text order, as canonical strings. */
  values: string[];
  /** Arabic numbers as written, with only the whitespace/commas between digits
   *  removed — what a pure regrouping (409048G -> 4090 48G) keeps equal. */
  arabicSkeleton: string[];
  /** NR-245: where whitespace/commas cut each skeleton's digits (digitCuts). */
  cuts: number[][];
  /** Values that came from Han numerals, English words and repetition marks. */
  nonArabic: string[];
  /** NR-245: the non-empty marks (sign / approximate / bound) in text order —
   *  see stt-polish-guard-number-marks.ts. */
  marks: string[];
  /** NR-245: each value's span in `surface`, for the subject-swap check. */
  spans: { at: number; end: number; value: string }[];
  surface: string;
}

interface Found { at: number; end: number; value: string; arabic: boolean; mark: string }

export function readNumbers(text: string, lang?: string): NumberReading {
  const surface = numberSurface(text, lang);
  let s = surface;
  // Read in text order. Matches are blanked with same-length padding so later
  // passes keep the original positions.
  const found: Found[] = [];
  const add = (at: number, end: number, value: string, arabic: boolean, mark = ''): void => { found.push({ at, end, value, arabic, mark }); };
  const blank = (m: string): string => ' '.repeat(m.length);
  const skeletons = [...s.matchAll(ARABIC_SKELETON_RE)].map(m => m[0]);
  const arabicSkeleton = skeletons.map(m => m.replace(/[,\s]/gu, '').toLowerCase());
  s = s.replace(ARABIC_RE, (m: string, int: string, frac: string | undefined, cjkScale: string | undefined,
    kScale: string | undefined, enScale: string | undefined, pct: string | undefined, at: number) => {
    const scaleWord = (cjkScale ?? kScale ?? enScale)?.toLowerCase();
    const whole = int.replace(/,/gu, '');
    const p = pct ? '%' : '';
    const end = at + m.length;
    const mark = numberMark(surface, at, end);
    if (scaleWord !== undefined) {
      const scale = ARABIC_SCALE[scaleWord]!;
      const fracDigits = frac ?? '';
      const denom = 10n ** BigInt(fracDigits.length);
      const scaled = (BigInt(whole) * denom + BigInt(fracDigits || '0')) * scale;
      add(at, end, (scaled % denom === 0n ? (scaled / denom).toString() : `${whole}.${fracDigits}x${scale}`) + p, true, mark);
    } else if (frac !== undefined) {
      // 3.5 reads like 三点五: two values either side of the point.
      add(at, end, BigInt(whole).toString(), true, mark);
      add(at + 0.5, end, BigInt(frac).toString() + p, true);
    } else {
      add(at, end, BigInt(whole).toString() + p, true, mark);
    }
    return blank(m);
  });
  s = s.replace(HAN_RUN_RE, (run: string, at: number, whole: string) => {
    // AABB / ABAB digit idioms (三三两两, 七七八八, 一二一二) are words, not
    // quantities: turning one into 3322 must read as a change (NR118 corpus).
    const idiom = /^(.)\1(.)\2$/u.test(run) || /^(.{2})\1$/u.test(run);
    const v = idiom ? null : parseHanNumber(run);
    const p = whole[at + run.length] === '%' ? '%' : '';
    add(at, at + run.length, (v === null ? `han:${run.replace(/两/gu, '二')}` : v.toString()) + p, false, numberMark(surface, at, at + run.length));
    return blank(run);
  });
  // ML-1: number words of the session language (fr / es / de) and of the
  // scripts only one checked language writes (ru, ko). Before the English
  // reader, which would otherwise read the "six" of "vingt-six" on its own.
  for (const w of wordNumbers(s, lang)) {
    const mark = numberMark(surface, w.at, w.end);
    w.values.forEach((v, k) => add(w.at + k / 100, w.end, v.toString(), false, k === 0 ? mark : ''));
    s = s.slice(0, w.at) + ' '.repeat(w.end - w.at) + s.slice(w.end);
  }
  for (const m of s.matchAll(EN_RUN_RE)) {
    const end = m.index + m[0].length;
    const mark = numberMark(surface, m.index, end);
    parseEnglishRun(m[0]).forEach((v, k) => add(m.index + k / 100, end, v === null ? `en:${m[0].toLowerCase()}` : v.toString(), false, k === 0 ? mark : ''));
  }
  for (const m of s.matchAll(new RegExp(REP, 'gu'))) add(m.index, m.index + 1, 'rep', false);
  found.sort((a, b) => a.at - b.at);
  return {
    values: found.map(f => f.value),
    arabicSkeleton,
    cuts: skeletons.map(digitCuts),
    nonArabic: found.filter(f => !f.arabic).map(f => f.value),
    marks: found.filter(f => f.mark !== '').map(f => f.mark),
    spans: found.map(f => ({ at: Math.floor(f.at), end: f.end, value: f.value })),
    surface,
  };
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** True when the numbers differ between the two texts. `lang`: see numberSurface. */
export function numberDrift(raw: string, polished: string, lang?: string): boolean {
  const a = readNumbers(raw, lang);
  const b = readNumbers(polished, lang);
  // NR-245: 十几 -> 十, 二十多 -> 二十, -5 -> 5 keep the value and lose what
  // was attached to it.
  if (!sameSequence(a.marks, b.marks)) return true;
  if (sameSequence(a.values, b.values)) return false;
  // Same Arabic numbers, only regrouped by whitespace/commas (409048G ->
  // 4090 48G, 1,000 -> 1000), and every non-Arabic number unchanged.
  // NR-245: a cut may appear or disappear, not move (pages 12 3 -> 1 23).
  return !(sameSequence(a.arabicSkeleton, b.arabicSkeleton)
    && a.cuts.every((c, i) => cutsCompatible(c, b.cuts[i] ?? []))
    && sameSequence(a.nonArabic, b.nonArabic));
}
