// NR-245 (GUARD-2, 2026-10-13): what is attached to a number is part of it.
//
// QP-1 made the guard compare numbers by VALUE. The value of 十几 and of 十 is
// the same 10, so 来了十几个人 -> 来了十个人 ("a dozen or so" -> "ten") was
// accepted at both strengths; so were 二十多 -> 二十 and 气温是-5度 -> 气温是5度.
// Each number now carries a MARK read from the text touching it:
//   '-'  a sign: -5, 零下5 (masked to −5 by numberSurface), 负5, minus 5;
//   '~'  approximately: 十几 / 几十, 十来个, 三点左右, 大概三个, about / around 5, 5-ish, or so;
//   '>'  at least / more than: 二十多, 三个多小时, 三十余, 以上, over / more than / at least;
//   '<'  at most / under: 将近, 不到, 以下 / 以内, nearly / almost / under / up to.
// The marks are compared in order alongside the values (numberDrift).
//
// Halves (一个半, one and a half) are not marks: 半 / half are counted words
// (stt-polish-guard-closed-words.ts), which also catches a standalone 半小时.
//
// Only text DIRECTLY touching the number is read (Chinese allows a measure
// word in between: 三个多小时, 一百块钱左右). A hedge further away (大概有三个)
// is not a mark; that is a known gap, not a claim.

const HAN_NUM = '零〇一幺二两三四五六七八九十百千万萬亿億';
const MEASURE = '个位天年月周块元次件人岁斤米号点度条张台';

const BEFORE: readonly (readonly [RegExp, string])[] = [
  // A Han character before the sign is fine (气温是-5); a Latin letter or a
  // digit is a hyphen (v-5, 3-5, 2026-10).
  [/(?:^|[^\p{Script=Latin}\p{N}.])[-−]$/u, '-'],
  [/(?:大约|大概|约莫|约|差不多|大致|几)$/u, '~'],
  [/(?:将近|接近|不到|不足|最多|至多)$/u, '<'],
  [/(?:超过|至少|起码)$/u, '>'],
  [/(?<![\p{L}])(?:about|around|roughly|approximately|approx\.?)\s+[$€£¥]?$/iu, '~'],
  [/(?<![\p{L}])(?:nearly|almost|under|less\s+than|fewer\s+than|at\s+most|up\s+to)\s+[$€£¥]?$/iu, '<'],
  [/(?<![\p{L}])(?:over|above|more\s+than|at\s+least)\s+[$€£¥]?$/iu, '>'],
];

const NEAR = `[^\\s，。,.!?！？；;:：0-9${HAN_NUM}]{0,3}?`;
const AFTER: readonly (readonly [RegExp, string])[] = [
  [/^几/u, '~'],
  [new RegExp(`^来(?=[${MEASURE}])`, 'u'), '~'],
  [new RegExp(`^${NEAR}(?:左右|上下(?![班楼车文]))`, 'u'), '~'],
  [new RegExp(`^[${MEASURE}]?多(?![少么])`, 'u'), '>'],
  [/^余/u, '>'],
  [new RegExp(`^${NEAR}以上`, 'u'), '>'],
  [new RegExp(`^${NEAR}(?:以下|以内)`, 'u'), '<'],
  [/^\s*-?ish(?![\p{L}])/iu, '~'],
  // "30 people or so": the approximation may follow the counted noun.
  [/^\s+(?:\p{L}+\s+){0,2}?or\s+so(?![\p{L}])/iu, '~'],
  [/^\s*\+/u, '>'],
  [/^\s+or\s+more(?![\p{L}])/iu, '>'],
  [/^\s+or\s+(?:less|fewer)(?![\p{L}])/iu, '<'],
];

const WINDOW = 16;

/** The marks on the number spanning [start, end) of `surface`, e.g. '-', '~>', or ''. */
export function numberMark(surface: string, start: number, end: number): string {
  // A window, not the whole text: every mark is a few characters long, and
  // slicing to the ends made a long text with many numbers quadratic.
  const before = surface.slice(Math.max(0, start - WINDOW), start);
  const after = surface.slice(end, end + WINDOW);
  let mark = '';
  for (const [re, m] of BEFORE) if (re.test(before)) mark += m;
  for (const [re, m] of AFTER) if (re.test(after)) mark += m;
  return mark;
}

/** Spoken signs as a minus sign the mark reader sees. 零下 must go before the
 *  numeral reader runs, or its 零 is read as a 0. */
export function signSurface(s: string): string {
  return s
    // "5 percent" is 5% (review round); read before the numbers so the
    // percent stays on its value like the written sign does.
    .replace(/(?<=[0-9])\s*per\s?cent(?![\p{L}])/giu, '%')
    .replace(/零下/gu, '¤−')
    .replace(new RegExp(`负(?=[0-9${HAN_NUM}])`, 'gu'), '−')
    .replace(/(?<![\p{L}\p{N}_])minus\s+/giu, '−');
}

/** Where whitespace or commas cut the digits of one written number (by digit
 *  index): 12 3 -> [2], 1,000 -> [1], 409048 -> []. */
export function digitCuts(written: string): number[] {
  const cuts: number[] = [];
  let digits = 0;
  for (const c of written) {
    if (/[0-9]/u.test(c)) digits += 1;
    else if (/[,\s]/u.test(c) && digits > 0 && cuts[cuts.length - 1] !== digits) cuts.push(digits);
  }
  return cuts;
}

/** A regrouping may add cuts or remove cuts (409048G -> 4090 48G, 1,000 ->
 *  1000) but not move one: 12 3 -> 1 23 reads two different numbers. */
export function cutsCompatible(a: readonly number[], b: readonly number[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return a.every((c) => sb.has(c)) || b.every((c) => sa.has(c));
}
