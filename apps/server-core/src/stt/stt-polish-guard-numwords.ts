// ML-1 (2026-10-13): number WORDS and number FORMATS in fr / es / de / ru / ko.
//
// The numbers gate (stt-polish-guard-numbers.ts) compared values it could read
// — Arabic digits, Chinese numerals, English number words — and nothing else.
// ML-0 measured both faces of that blind spot (§3 D1 / D2 of
// _dispatch/2026-10-13-eval-multilingual-baseline.md):
//   · a changed number word passed both strengths: vingt-cinq -> trente-cinq,
//     halb drei -> halb vier, quince -> cinco, 오천 -> 오만, двадцать пять ->
//     тридцать пять;
//   · a CORRECT word -> digit rewrite was refused (quinientos -> 500, 오백 ->
//     500), and European grouping was misread: "2.400" was 2.4, "25 000" two
//     numbers.
// This file reads those values so the same sequence comparison covers them.
//
// Gating, stated: Latin-script words (fr / es / de) and the European formats
// are read only when the session language says so — "once" is eleven in
// Spanish and a closed-class word in English, "2.400" is 2400 in German and
// 2.4 in English. Hangul and Cyrillic are read whenever they appear: no other
// language this guard checks writes them. Without a language the gate reads
// exactly what it read before ML-1.
//
// Times: "halb drei" is 2:30 and "в половине третьего" is 2:30, so both are
// rewritten to that time before the values are read. "halb drei -> 3:30 Uhr"
// (ML-0 de-03) is then a changed value, and "halb drei -> 2:30" is not.
//
// Known limits: Japanese kana numerals (さん, ふたつ) are not read (the Han
// reader covers kanji); Korean sino digits are read only where a unit or a
// counter makes them a number (이 alone is "this"); oblique Russian forms
// beyond the common genitive / instrumental are not listed.

type Kind = 'unit' | 'teen' | 'tens' | 'hundreds' | 'hundred' | 'thousand' | 'million' | 'billion';
interface Word { kind: Kind; value: bigint }

const W = (kind: Kind, value: number | bigint): Word => ({ kind, value: BigInt(value) });

function table(entries: readonly (readonly [string, Word])[]): Map<string, Word> {
  return new Map(entries);
}

const FR = table([
  ['zéro', W('unit', 0)], ['deux', W('unit', 2)], ['trois', W('unit', 3)], ['quatre', W('unit', 4)],
  ['cinq', W('unit', 5)], ['six', W('unit', 6)], ['sept', W('unit', 7)], ['huit', W('unit', 8)], ['neuf', W('unit', 9)],
  ['dix', W('teen', 10)], ['onze', W('teen', 11)], ['douze', W('teen', 12)], ['treize', W('teen', 13)],
  ['quatorze', W('teen', 14)], ['quinze', W('teen', 15)], ['seize', W('teen', 16)],
  ['vingt', W('tens', 20)], ['vingts', W('tens', 20)], ['trente', W('tens', 30)], ['quarante', W('tens', 40)],
  ['cinquante', W('tens', 50)], ['soixante', W('tens', 60)],
  ['cent', W('hundred', 100)], ['cents', W('hundred', 100)], ['mille', W('thousand', 1000)],
  ['million', W('million', 1000000)], ['millions', W('million', 1000000)],
  ['milliard', W('billion', 1000000000)], ['milliards', W('billion', 1000000000)],
]);
// Articles: a number only inside a run ("vingt et un", "trente et une").
const FR_RUN_ONLY = table([['un', W('unit', 1)], ['une', W('unit', 1)]]);

const ES = table([
  ['cero', W('unit', 0)], ['uno', W('unit', 1)], ['dos', W('unit', 2)], ['tres', W('unit', 3)], ['cuatro', W('unit', 4)],
  ['cinco', W('unit', 5)], ['seis', W('unit', 6)], ['siete', W('unit', 7)], ['ocho', W('unit', 8)], ['nueve', W('unit', 9)],
  ['diez', W('teen', 10)], ['once', W('teen', 11)], ['doce', W('teen', 12)], ['trece', W('teen', 13)], ['catorce', W('teen', 14)],
  ['quince', W('teen', 15)], ['dieciséis', W('teen', 16)], ['dieciseis', W('teen', 16)], ['diecisiete', W('teen', 17)],
  ['dieciocho', W('teen', 18)], ['diecinueve', W('teen', 19)],
  ['veinte', W('tens', 20)], ['veintiuno', W('teen', 21)], ['veintiún', W('teen', 21)], ['veintiuna', W('teen', 21)],
  ['veintidós', W('teen', 22)], ['veintitrés', W('teen', 23)], ['veinticuatro', W('teen', 24)], ['veinticinco', W('teen', 25)],
  ['veintiséis', W('teen', 26)], ['veintisiete', W('teen', 27)], ['veintiocho', W('teen', 28)], ['veintinueve', W('teen', 29)],
  ['treinta', W('tens', 30)], ['cuarenta', W('tens', 40)], ['cincuenta', W('tens', 50)], ['sesenta', W('tens', 60)],
  ['setenta', W('tens', 70)], ['ochenta', W('tens', 80)], ['noventa', W('tens', 90)],
  ['cien', W('hundreds', 100)], ['ciento', W('hundreds', 100)],
  ...([[2, 'dosc'], [3, 'tresc'], [4, 'cuatroc'], [5, 'quin'], [6, 'seisc'], [7, 'setec'], [8, 'ochoc'], [9, 'novec']] as const)
    .flatMap(([n, stem]) => [[`${stem}ientos`, W('hundreds', n * 100)], [`${stem}ientas`, W('hundreds', n * 100)]] as const),
  ['mil', W('thousand', 1000)], ['millón', W('million', 1000000)], ['millones', W('million', 1000000)],
]);
const ES_RUN_ONLY = table([['un', W('unit', 1)], ['una', W('unit', 1)]]);

const RU_BASE: readonly (readonly [string, Word])[] = [
  ['ноль', W('unit', 0)], ['нуль', W('unit', 0)],
  ...['один', 'одна', 'одно', 'одного', 'одной', 'одному', 'одним', 'одну'].map((w) => [w, W('unit', 1)] as const),
  ...['два', 'две', 'двух', 'двум', 'двумя'].map((w) => [w, W('unit', 2)] as const),
  ...['три', 'трех', 'трем', 'тремя'].map((w) => [w, W('unit', 3)] as const),
  ...['четыре', 'четырех', 'четырем', 'четырьмя'].map((w) => [w, W('unit', 4)] as const),
  ['сорок', W('tens', 40)], ['сорока', W('tens', 40)], ['девяносто', W('tens', 90)], ['девяноста', W('tens', 90)],
  ['сто', W('hundreds', 100)], ['ста', W('hundreds', 100)],
  ['двести', W('hundreds', 200)], ['триста', W('hundreds', 300)], ['четыреста', W('hundreds', 400)],
  ['пятьсот', W('hundreds', 500)], ['шестьсот', W('hundreds', 600)], ['семьсот', W('hundreds', 700)],
  ['восемьсот', W('hundreds', 800)], ['девятьсот', W('hundreds', 900)],
  // GUARD-CJK: the colloquial тыща / тыщ is the same thousand (пять тыщ -> пять тысяч).
  ...['тысяча', 'тысячи', 'тысяч', 'тысячу', 'тысячей', 'тыща', 'тыщи', 'тыщ', 'тыщу', 'тыщей'].map((w) => [w, W('thousand', 1000)] as const),
  ...['миллион', 'миллиона', 'миллионов'].map((w) => [w, W('million', 1000000)] as const),
  ...['миллиард', 'миллиарда', 'миллиардов'].map((w) => [w, W('billion', 1000000000)] as const),
];
// Soft-sign numerals: nominative + the genitive/dative/prepositional -и and the
// instrumental -ью (пять, пяти, пятью).
const RU_SOFT: readonly (readonly [string, Kind, number])[] = [
  ['пять', 'unit', 5], ['шесть', 'unit', 6], ['семь', 'unit', 7], ['восемь', 'unit', 8], ['девять', 'unit', 9],
  ['десять', 'teen', 10], ['одиннадцать', 'teen', 11], ['двенадцать', 'teen', 12], ['тринадцать', 'teen', 13],
  ['четырнадцать', 'teen', 14], ['пятнадцать', 'teen', 15], ['шестнадцать', 'teen', 16], ['семнадцать', 'teen', 17],
  ['восемнадцать', 'teen', 18], ['девятнадцать', 'teen', 19], ['двадцать', 'tens', 20], ['тридцать', 'tens', 30],
];
const RU_DECADES: readonly (readonly [string, string, number])[] = [
  ['пятьдесят', 'пятидесяти', 50], ['шестьдесят', 'шестидесяти', 60], ['семьдесят', 'семидесяти', 70], ['восемьдесят', 'восьмидесяти', 80],
];
const RU = table([
  ...RU_BASE,
  ...RU_SOFT.flatMap(([w, k, v]) => [[w, W(k, v)], [`${w.slice(0, -1)}и`, W(k, v)], [`${w}ю`, W(k, v)]] as const),
  ...RU_DECADES.flatMap(([w, obl, v]) => [[w, W('tens', v)], [obl, W('tens', v)]] as const),
]);
// Ordinals in any case ending (пятнадцатого, третьего, первую).
const RU_ORDINAL_STEMS: readonly (readonly [string, Kind, number])[] = [
  ['перв', 'unit', 1], ['втор', 'unit', 2], ['трет', 'unit', 3], ['четверт', 'unit', 4], ['пят', 'unit', 5],
  ['шест', 'unit', 6], ['седьм', 'unit', 7], ['восьм', 'unit', 8], ['девят', 'unit', 9], ['десят', 'teen', 10],
  ['одиннадцат', 'teen', 11], ['двенадцат', 'teen', 12], ['тринадцат', 'teen', 13], ['четырнадцат', 'teen', 14],
  ['пятнадцат', 'teen', 15], ['шестнадцат', 'teen', 16], ['семнадцат', 'teen', 17], ['восемнадцат', 'teen', 18],
  ['девятнадцат', 'teen', 19], ['двадцат', 'tens', 20], ['тридцат', 'tens', 30],
];
const RU_ORDINAL_RE = new RegExp(`^(${RU_ORDINAL_STEMS.map(([s]) => s).sort((a, b) => b.length - a.length).join('|')})(ь?(?:ый|ий|ой|ого|его|ому|ему|ым|им|ом|ем|ая|яя|ую|юю|ое|ее|ые|ие|ых|их|ыми|ими)|ья|ье|ьи|ью)$`, 'u');

function ruWord(w: string): Word | null {
  const t = w.replace(/ё/gu, 'е');
  const hit = RU.get(t);
  if (hit) return hit;
  const m = RU_ORDINAL_RE.exec(t);
  if (!m) return null;
  const stem = RU_ORDINAL_STEMS.find(([s]) => s === m[1])!;
  return W(stem[1], stem[2]);
}

// German: one word holds the whole number (neunundvierzig, zweitausenddreihundert).
const DE_MORPH: readonly (readonly [string, Kind | 'und' | 'zehn', number])[] = ([
  ['null', 'unit', 0], ['eins', 'unit', 1], ['ein', 'unit', 1], ['zwei', 'unit', 2], ['zwo', 'unit', 2], ['drei', 'unit', 3],
  ['vier', 'unit', 4], ['fünf', 'unit', 5], ['sechs', 'unit', 6], ['sech', 'unit', 6], ['sieben', 'unit', 7], ['sieb', 'unit', 7],
  ['acht', 'unit', 8], ['neun', 'unit', 9], ['zehn', 'zehn', 10], ['elf', 'teen', 11], ['zwölf', 'teen', 12],
  ['zwanzig', 'tens', 20], ['dreißig', 'tens', 30], ['dreissig', 'tens', 30], ['vierzig', 'tens', 40], ['fünfzig', 'tens', 50],
  ['sechzig', 'tens', 60], ['siebzig', 'tens', 70], ['achtzig', 'tens', 80], ['neunzig', 'tens', 90],
  ['hundert', 'hundred', 100], ['tausend', 'thousand', 1000], ['und', 'und', 0],
] as const).slice().sort((a, b) => b[0].length - a[0].length);
const DE_ORDINAL_IRREGULAR: Readonly<Record<string, number>> = { erst: 1, dritt: 3, siebt: 7, acht: 8 };
const DE_SCALE = table([
  ['million', W('million', 1000000)], ['millionen', W('million', 1000000)],
  ['milliarde', W('billion', 1000000000)], ['milliarden', W('billion', 1000000000)],
]);

/** Value of a German number word, or null. Articles (ein, eine, einen …) are not numbers. */
function deCompound(word: string): bigint | null {
  if (/^ein(?:e|en|em|er|es)?$/u.test(word)) return null;
  let rest = word;
  let total = 0n;
  let cur = 0n;
  let pending = 0n;
  let seen = false;
  let lastUnd = false;
  while (rest.length > 0) {
    const m = DE_MORPH.find(([s]) => rest.startsWith(s));
    if (!m) return null;
    rest = rest.slice(m[0].length);
    const [, kind, v] = m;
    const value = BigInt(v);
    if (kind === 'und') { if (pending === 0n || lastUnd) return null; lastUnd = true; continue; }
    if (kind === 'unit') {
      if (pending !== 0n) return null;
      pending = value === 0n ? 0n : value;
      if (value === 0n && word !== 'null') return null;
    } else if (kind === 'zehn') { cur += 10n + pending; pending = 0n; }
    else if (kind === 'teen') { if (pending !== 0n) return null; cur += value; }
    else if (kind === 'tens') { cur += value + pending; pending = 0n; }
    else if (kind === 'hundred') { cur += (pending === 0n ? 1n : pending) * 100n; pending = 0n; }
    else if (kind === 'thousand') { total += (cur + pending === 0n ? 1n : cur + pending) * 1000n; cur = 0n; pending = 0n; }
    if (kind !== 'unit' && lastUnd && kind !== 'tens') return null;
    lastUnd = false;
    seen = true;
  }
  if (!seen || lastUnd) return null;
  return total + cur + pending;
}

function deWord(w: string): Word | null {
  const scale = DE_SCALE.get(w);
  if (scale) return scale;
  const v = deCompound(w);
  if (v !== null) return W(v >= 1000n ? 'teen' : v >= 100n ? 'teen' : v >= 20n ? 'teen' : v >= 10n ? 'teen' : 'unit', v);
  // Ordinals: vierzehnten, zwanzigsten, dritte, ersten.
  const m = /^(.+?)(s?t)(e|en|er|em|es)$/u.exec(w);
  if (m) {
    const irregular = DE_ORDINAL_IRREGULAR[m[1]! + m[2]!];
    if (irregular !== undefined) return W('teen', irregular);
    const o = deCompound(m[1]!);
    if (o !== null && o > 0n) return W('teen', o);
  }
  if (/^acht(e|en|er|em|es)$/u.test(w)) return W('teen', 8);
  return null;
}

/** Combine a run of number words into values: "vingt-cinq" [25], "dos tres" [2, 3]. */
function combine(words: readonly Word[], fr: boolean): bigint[] {
  const values: bigint[] = [];
  let total = 0n;
  let cur = 0n;
  let any = false;
  let last: Kind | 'none' = 'none';
  let tensValue = 0n;
  let openDix = false;
  const flush = (): void => {
    if (any) values.push(total + cur);
    total = 0n; cur = 0n; any = false; last = 'none';
  };
  for (const w of words) {
    if (w.kind !== 'unit' && w.kind !== 'teen') openDix = false;
    switch (w.kind) {
      case 'unit':
      case 'teen': {
        // ML-1 review F3: dix-sept, soixante-dix-huit, quatre-vingt-dix-neuf.
        if (fr && openDix && w.kind === 'unit' && w.value >= 7n) { cur += w.value; last = 'unit'; openDix = false; break; }
        const frTeen = fr && w.kind === 'teen' && last === 'tens' && (tensValue === 60n || tensValue === 80n);
        if (last === 'unit' || last === 'teen' || (last === 'tens' && w.kind === 'teen' && !frTeen)) flush();
        cur += w.value; any = true; last = w.kind;
        openDix = fr && w.kind === 'teen' && w.value === 10n;
        break;
      }
      case 'tens':
        // French quatre-vingt is 4 x 20.
        if (fr && last === 'unit' && w.value === 20n && cur % 10n === 4n) { cur = cur - 4n + 80n; last = 'tens'; tensValue = 80n; break; }
        if (last === 'unit' || last === 'teen' || last === 'tens') flush();
        cur += w.value; any = true; last = 'tens'; tensValue = w.value;
        break;
      case 'hundreds':
        if (last === 'unit' || last === 'teen' || last === 'tens' || last === 'hundreds') flush();
        cur += w.value; any = true; last = 'hundreds';
        break;
      case 'hundred':
        cur = (any && cur > 0n ? cur : 1n) * 100n; any = true; last = 'hundreds';
        break;
      default: // thousand / million / billion
        total += (any && cur > 0n ? cur : 1n) * w.value; cur = 0n; any = true; last = w.kind;
    }
  }
  flush();
  return values;
}

export interface WordNumber { at: number; end: number; values: bigint[] }

const LATIN_WORD_RE = /\p{L}+(?:-\p{L}+)*/gu;

/** Number-word runs in a Latin-script language: tokens joined by space,
 *  hyphen, or the language's "and" (et / y). */
function latinRuns(s: string, lookup: (w: string) => Word | null, runOnly: Map<string, Word>, connector: string, fr: boolean): WordNumber[] {
  const toks = [...s.matchAll(LATIN_WORD_RE)].flatMap((m) => {
    // A hyphenated compound is read part by part (vingt-cinq, dix-sept).
    let off = m.index;
    return m[0].split('-').map((part) => { const t = { text: part, at: off }; off += part.length + 1; return t; });
  });
  const out: WordNumber[] = [];
  let i = 0;
  while (i < toks.length) {
    const first = lookup(toks[i]!.text.toLowerCase());
    if (!first) { i += 1; continue; }
    const words: Word[] = [first];
    let j = i + 1;
    while (j < toks.length) {
      const gap = s.slice(toks[j - 1]!.at + toks[j - 1]!.text.length, toks[j]!.at);
      if (!/^[\s-]*$/u.test(gap)) break;
      const t = toks[j]!.text.toLowerCase();
      if (t === connector && j + 1 < toks.length) {
        const next = toks[j + 1]!.text.toLowerCase();
        const w = lookup(next) ?? runOnly.get(next);
        if (w && /^[\s-]*$/u.test(s.slice(toks[j]!.at + toks[j]!.text.length, toks[j + 1]!.at))) { words.push(w); j += 2; continue; }
        break;
      }
      const w = lookup(t);
      if (!w) break;
      words.push(w);
      j += 1;
    }
    const last = toks[j - 1]!;
    out.push({ at: toks[i]!.at, end: last.at + last.text.length, values: combine(words, fr) });
    i = j;
  }
  return out;
}

// ─── Korean ─────────────────────────────────────────────────────────────────
const KO_SINO_DIGIT: Readonly<Record<string, bigint>> = { 영: 0n, 공: 0n, 일: 1n, 이: 2n, 삼: 3n, 사: 4n, 오: 5n, 육: 6n, 륙: 6n, 칠: 7n, 팔: 8n, 구: 9n };
const KO_SINO_SMALL: Readonly<Record<string, bigint>> = { 십: 10n, 백: 100n, 천: 1000n };
const KO_SINO_BIG: Readonly<Record<string, bigint>> = { 만: 10000n, 억: 100000000n };
// Counters that make a lone sino digit a number (삼일, 오월, 이층). 번 is
// left out: 이번 is "this time".
const KO_SINO_COUNTER = /^(?:월|일|년|분|초|층|원|개월|주년|호|인분|퍼센트|프로|시간|위|등|회|차|세|킬로|미터|도)/u;
const KO_NATIVE_TENS: Readonly<Record<string, bigint>> = { 열: 10n, 스물: 20n, 스무: 20n, 서른: 30n, 마흔: 40n, 쉰: 50n, 예순: 60n, 일흔: 70n, 여든: 80n, 아흔: 90n };
const KO_NATIVE_ONES: Readonly<Record<string, bigint>> = {
  하나: 1n, 한: 1n, 둘: 2n, 두: 2n, 셋: 3n, 세: 3n, 넷: 4n, 네: 4n, 다섯: 5n, 여섯: 6n, 일곱: 7n, 여덟: 8n, 아홉: 9n,
};
// Forms that are also everyday words (한국, 네 "yes", 세 "world", 열 "fever"):
// a number only right before a counter.
const KO_NATIVE_AMBIGUOUS = new Set(['한', '두', '세', '네', '열', '스무', '쉰']);
const KO_NATIVE_COUNTER = /^(?:명|시|개|번|살|사람|가지|시간|달|장|권|대|잔|마리|병|분|곳|군데|줄|배|바퀴|벌|켤레|송이|그루|주|쪽|통|건|채|척)/u;
const KO_PARTICLE = /^(?:이|가|은|는|을|를|도|만|의|째|에|과|와|랑|씩|이서|서)?$/u;

function koSino(run: string): { len: number; value: bigint; units: boolean } | null {
  const sy = [...run];
  let total = 0n;
  let section = 0n;
  let pending: bigint | null = null;
  let lastSmall = 100000n;
  let lastBig = 1000000000000n;
  let units = false;
  let k = 0;
  for (; k < sy.length; k++) {
    const c = sy[k]!;
    const d = KO_SINO_DIGIT[c];
    const small = KO_SINO_SMALL[c];
    const big = KO_SINO_BIG[c];
    if (d !== undefined) { if (pending !== null) break; pending = d; continue; }
    if (small !== undefined) { if (small >= lastSmall) break; section += (pending ?? 1n) * small; pending = null; lastSmall = small; units = true; continue; }
    if (big !== undefined) { if (big >= lastBig) break; total += (section + (pending ?? 0n) || 1n) * big; section = 0n; pending = null; lastSmall = 100000n; lastBig = big; units = true; continue; }
    break;
  }
  if (k === 0) return null;
  return { len: k, value: total + section + (pending ?? 0n), units };
}

function koEojeol(word: string, next: string): bigint | null {
  if (/^시월/u.test(word)) return 10n;
  if (/^유월/u.test(word)) return 6n;
  // Native: [tens][ones] then a particle or a counter.
  let rest = word;
  let value = 0n;
  let parts = '';
  const tens = Object.keys(KO_NATIVE_TENS).sort((a, b) => b.length - a.length).find((t) => rest.startsWith(t));
  if (tens) { value += KO_NATIVE_TENS[tens]!; rest = rest.slice(tens.length); parts += tens; }
  const ones = Object.keys(KO_NATIVE_ONES).sort((a, b) => b.length - a.length).find((o) => rest.startsWith(o));
  if (ones) { value += KO_NATIVE_ONES[ones]!; rest = rest.slice(ones.length); parts += ones; }
  if (parts.length > 0) {
    const counterNext = KO_NATIVE_COUNTER.test(rest) || (rest === '' && KO_NATIVE_COUNTER.test(next));
    const ambiguous = KO_NATIVE_AMBIGUOUS.has(parts);
    if (counterNext || (!ambiguous && KO_PARTICLE.test(rest))) return value;
  }
  const sino = koSino(word);
  if (sino === null) return null;
  const after = [...word].slice(sino.len).join('');
  if (sino.units && (sino.len >= 2 || after === '' || KO_PARTICLE.test(after))) {
    if (sino.len >= 2 || KO_SINO_COUNTER.test(after) || (after === '' && /^(?:원|명|개)/u.test(next))) return sino.value;
  }
  if (!sino.units && sino.len === 1 && KO_SINO_COUNTER.test(after)) return sino.value;
  return null;
}

function koRuns(s: string): WordNumber[] {
  const words = [...s.matchAll(/\p{Script=Hangul}+/gu)];
  const out: WordNumber[] = [];
  words.forEach((m, k) => {
    const next = words[k + 1];
    const gapOk = next !== undefined && /^\s+$/u.test(s.slice(m.index + m[0].length, next.index));
    const v = koEojeol(m[0], gapOk ? next![0] : '');
    if (v !== null) out.push({ at: m.index, end: m.index + m[0].length, values: [v] });
  });
  return out;
}

// ─── public ─────────────────────────────────────────────────────────────────

/** Languages whose number words and number format this file reads. */
const LATIN_LANGS = new Set(['fr', 'es', 'de']);
/** Languages that write a decimal comma and group thousands with '.' or a space. */
const DECIMAL_COMMA = new Set(['fr', 'es', 'de', 'ru']);

function lookupFor(lang: string): ((w: string) => Word | null) | null {
  if (lang === 'fr') return (w) => FR.get(w) ?? null;
  if (lang === 'es') return (w) => ES.get(w) ?? null;
  if (lang === 'de') return deWord;
  return null;
}

/** Rewrite the language's number format and spoken times into what the
 *  Arabic reader understands: 2.400 -> 2400, 25 000 -> 25000, 49,90 -> 49.90,
 *  halb drei -> 2:30, в половине третьего -> 2:30. Pure. */
export function localNumberSurface(text: string, lang: string | undefined): string {
  let s = text;
  if (lang !== undefined && DECIMAL_COMMA.has(lang)) {
    s = s.replace(/(?<![\d.,])\d{1,3}(?:[   ]\d{3})+(?![\d])/gu, (m) => m.replace(/[   ]/gu, ''));
    if (lang !== 'fr' && lang !== 'ru') s = s.replace(/(?<![\d.,])\d{1,3}(?:\.\d{3})+(?![\d.])/gu, (m) => m.replace(/\./gu, ''));
    s = s.replace(/(?<=\d),(?=\d)/gu, '.');
  }
  if (lang === 'de') {
    s = s.replace(/(?<![\p{L}])halb\s+(\p{L}+|\d{1,2})(?![\p{L}\d])/giu, (m, h: string) => {
      const n = /^\d+$/u.test(h) ? BigInt(h) : deCompound(h.toLowerCase());
      return n !== null && n >= 1n && n <= 12n ? `${n === 1n ? 12n : n - 1n}:30` : m;
    });
  }
  // Korean 두 시 반 / Japanese 二時半 are N:30 (the Chinese 点半 rule's twins).
  if (lang === 'ko') s = s.replace(/시\s*반(?![\p{L}])|시\s*반(?=에|이|까지|부터)/gu, '시 30분');
  if (lang === 'ja') s = s.replace(/時半/gu, '時30分');
  s = s.replace(/(?<![\p{L}])в\s+половин[еуы]\s+(\p{L}+)(?![\p{L}])/giu, (m, h: string) => {
    const w = ruWord(h.toLowerCase());
    return w !== null && w.value >= 1n && w.value <= 12n ? `в ${w.value === 1n ? 12n : w.value - 1n}:30` : m;
  });
  return s;
}

/** Number-word runs in `s` (already blanked where other readers matched). */
export function wordNumbers(s: string, lang: string | undefined): WordNumber[] {
  const out: WordNumber[] = [];
  const lookup = lang !== undefined && LATIN_LANGS.has(lang) ? lookupFor(lang) : null;
  if (lookup) {
    const runOnly = lang === 'fr' ? FR_RUN_ONLY : lang === 'es' ? ES_RUN_ONLY : new Map<string, Word>();
    out.push(...latinRuns(s, lookup, runOnly, lang === 'fr' ? 'et' : lang === 'es' ? 'y' : 'und', lang === 'fr'));
  }
  if (/\p{Script=Cyrillic}/u.test(s)) {
    const cyr = s.replace(/[^\p{Script=Cyrillic}\s-]/gu, (c) => ' '.repeat(c.length));
    out.push(...latinRuns(cyr, ruWord, new Map(), 'и', false));
  }
  if (/\p{Script=Hangul}/u.test(s)) out.push(...koRuns(s));
  return out.sort((a, b) => a.at - b.at);
}

/** Code units of `text` spelled as number words this file reads — what a
 *  value-checked rewrite to digits may remove without it counting as an edit. */
export function numberWordChars(text: string, lang: string | undefined): number {
  return wordNumbers(localNumberSurface(text, lang), lang).reduce((n, w) => n + (w.end - w.at), 0);
}

/** Words of `text` spelled as number words this file reads (двадцать пять = 2). */
export function numberWordCount(text: string, lang: string | undefined): number {
  const s = localNumberSurface(text, lang);
  return wordNumbers(s, lang).reduce((n, w) => n + (s.slice(w.at, w.end).match(/\p{L}+/gu)?.length ?? 0), 0);
}

/** True when `w` (lowercased) is a number word in a Latin-script language this
 *  file reads — so the content-word check leaves it to the numbers gate. */
export function isLatinNumberWord(w: string): boolean {
  return FR.has(w) || ES.has(w) || deWord(w) !== null;
}
