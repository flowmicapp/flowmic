// ML-1 (2026-10-13): the guard knows the session's spoken language, and refuses
// an output that is no longer in it.
//
// Until ML-1 nothing checked "is the output still the language the user spoke".
// ML-0 (_dispatch/2026-10-13-eval-multilingual-baseline.md §3 D5) measured it:
// 11 adversarial "rewritten into English / Chinese" pairs were refused by the
// realtime guard only by accident (an English modal appeared, an edit distance
// overflowed), and Smooth accepted two of them outright.
//
// The detector is the ML-0 eval one (scripts/eval/speech-quality/ml-scoring.mjs
// `detectDrift`, 0 false positives on 180 references and 133 inputs): script
// shares for ja / ko / ru / zh, a stopword profile for the Latin languages.
//
// 🔴 TWO RULES THAT KEEP IT FROM REFUSING CORRECT WORK:
//   · it is RELATIVE TO THE INPUT. In a sentence the output wrote in language
//     X, only the words the input did not already contain count (review F2):
//     a user who dictated one English clause inside a German or Chinese
//     session keeps it, whether the polish sets it as its own sentence or
//     bullet or deletes the fillers around it. What is measured is the
//     off-language text the polish ADDED, not what is there.
//   · it is SILENT when it cannot say. No language, or a language this
//     detector has no profile for, means no verdict (never a guess). A sentence
//     under four letters or under four Latin words is not classified. English
//     tech terms carry no stopwords, so "GitHub Actions" in a French sentence
//     does not make it English.
// Both strengths: a smoothing pass may delete words, it may not translate.

/** Base language of a spoken-language tag: 'de-DE' -> 'de', 'zh_TW' -> 'zh'.
 *  Unknown, empty or 'auto' -> undefined. */
export function baseLanguage(lang: string | undefined): string | undefined {
  if (lang === undefined) return undefined;
  const base = lang.trim().toLowerCase().replace(/_/gu, '-').split('-')[0] ?? '';
  return /^[a-z]{2,3}$/u.test(base) && base !== 'auto' && base !== 'und' ? base : undefined;
}

// Lists avoid words shared across the four Latin languages (a, de, en, la, que,
// no, es, in, an, was, will, die, on, so). Copied from ml-scoring.mjs STOP.
const STOP: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set('the and is are were to of that this with for it be have has we you they should please before after would can not from at by our your which there been what when if but just my he she its do does did than then them their these those into about also'.split(' ')),
  fr: new Set('le les des du une et est sont qui pour avec dans sur pas ne nous vous je tu il elle ils ce cette au aux mais ou très été être son sa ses leur leurs par c l d j qu n s y on'.split(' ')),
  es: new Set('el los las del y una unos para con por pero muy más está están hay ya lo se su sus al como cuando también este esta esto eso nos usted puedes tiene yo mi sí hemos han'.split(' ')),
  de: new Set('der das und ist sind nicht ein eine einen dem den des mit für auf ich wir sie du zu von bei auch noch wird werden hat haben dass oder aber wenn bitte schon wie nach im vom zum zur uns euch ihr mir dir'.split(' ')),
};
const LATIN_LANGS = ['en', 'fr', 'es', 'de'] as const;

/** Languages the detector can speak for. Anything else: silent. */
export const DRIFT_PROFILED_LANGS: readonly string[] = ['en', 'fr', 'es', 'de', 'ja', 'ko', 'ru', 'zh'];

interface Scripts { latin: number; cyr: number; hangul: number; kana: number; han: number }

const SCRIPT_RE = {
  latin: /\p{Script=Latin}/gu, cyr: /\p{Script=Cyrillic}/gu, hangul: /\p{Script=Hangul}/gu,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu, han: /\p{Script=Han}/gu,
} as const;

function scriptCounts(s: string): Scripts {
  const n = (re: RegExp): number => s.match(re)?.length ?? 0;
  return { latin: n(SCRIPT_RE.latin), cyr: n(SCRIPT_RE.cyr), hangul: n(SCRIPT_RE.hangul), kana: n(SCRIPT_RE.kana), han: n(SCRIPT_RE.han) };
}

function letters(c: Scripts): number {
  return c.latin + c.cyr + c.hangul + c.kana + c.han;
}

/** Which language one sentence is in, or null when it is too short to say. */
export function sentenceLanguage(sentence: string): string | null {
  const c = scriptCounts(sentence);
  const n = letters(c);
  if (n < 4) return null;
  if (c.kana / n >= 0.15) return 'ja';
  if (c.hangul / n >= 0.4) return 'ko';
  if (c.cyr / n >= 0.4) return 'ru';
  if (c.han / n >= 0.4) return 'zh';
  if (c.latin / n >= 0.6) {
    const words = sentence.toLowerCase().replace(/[’']/gu, "' ").split(/[^\p{L}']+/u).map((w) => w.replace(/'$/u, '')).filter(Boolean);
    if (words.length < 4) return null;
    const score = Object.fromEntries(LATIN_LANGS.map((l) => [l, words.filter((w) => STOP[l]!.has(w)).length])) as Record<string, number>;
    const best = LATIN_LANGS.reduce((a, b) => (score[b]! > score[a]! ? b : a));
    const sorted = Object.values(score).sort((x, y) => y - x);
    // Two stopword hits at least: one shared-looking word must not decide.
    if (score[best]! < 2 || sorted[0] === sorted[1]) return null;
    return best;
  }
  return null;
}

// A period after a short capitalised word (Ms., Dr., Nr., OK.) does not end a
// sentence: splitting there left "The meeting with Ms." too short to read.
function sentences(text: string): string[] {
  return text.split(/(?<=[!?。！？]|(?<!(?:^|[\s(])\p{Lu}\p{L}{0,2})\.)\s*|\n+/u).map((s) => s.trim()).filter(Boolean);
}

const TOKEN_RE = /\p{Script=Han}|[\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{M}'’]+/gu;
const tokenLetters = (t: string): number => letters(scriptCounts(t));

/** ML-1 review F2: letters of the output's off-language sentences that the
 *  INPUT did not already say, by detected language. Counting whole sentences
 *  refused correct work: an English clause the user dictated that the polish
 *  set as its own sentence or bullet, a Chinese sentence whose Han share fell
 *  under the threshold once fillers were deleted, articles added to telegraphic
 *  English. Only words the output introduced can be a translation. */
function addedOffLanguage(raw: string, polished: string, lang: string): Map<string, number> {
  const have = new Map<string, number>();
  for (const t of raw.toLowerCase().match(TOKEN_RE) ?? []) have.set(t, (have.get(t) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const s of sentences(polished)) {
    const l = sentenceLanguage(s);
    // A Japanese sentence written all in kanji reads as zh; only a sentence with
    // no kana at all can be Chinese in a Japanese session (ja-13 shape).
    if (l === null || l === lang) continue;
    if (lang === 'ja' && l === 'zh' && scriptCounts(s).kana > 0) continue;
    let novel = 0;
    for (const t of s.toLowerCase().match(TOKEN_RE) ?? []) {
      const n = have.get(t) ?? 0;
      if (n > 0) have.set(t, n - 1);
      else novel += tokenLetters(t);
    }
    out.set(l, (out.get(l) ?? 0) + novel);
  }
  return out;
}

/** Minimum added off-language letters before a verdict (a short interjection
 *  such as "OK, let's go" is not a translation). */
const MIN_ADDED_LETTERS = 8;
/** ... and minimum share of the output's letters they make up. */
const MIN_ADDED_SHARE = 0.25;

/** The language the output drifted INTO, or null. Silent (null) without a
 *  profiled language. */
export function languageDrift(raw: string, polished: string, language: string | undefined): string | null {
  const lang = baseLanguage(language);
  if (lang === undefined || !DRIFT_PROFILED_LANGS.includes(lang)) return null;
  const total = Math.max(1, letters(scriptCounts(polished)));
  for (const [l, added] of addedOffLanguage(raw, polished, lang)) {
    if (added >= MIN_ADDED_LETTERS && added / total >= MIN_ADDED_SHARE) return l;
  }
  return null;
}
