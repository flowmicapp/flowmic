// Closed-class term tables for `checkMeaningPreserved` §3.2.
//
// DATA ONLY. Matching lives in stt-polish-guard.ts. This file exists so
// extending coverage is appending a typed array, not growing the 40-line
// comment that used to be the only record of which languages were actually
// checked (card C8 → WP8 P1-2).
//
// Two matching strategies, same as the legacy guard, no third:
//   · substring — CJK scripts with no word boundaries (zh, ja) plus digits
//     and the English suffix `n't`.
//   · word-boundary — space-separated languages. The matcher is Unicode
//     letter-boundary, not JS `\b`: `\b` is ASCII-only (`[A-Za-z0-9_]`), so
//     `\bне\b` against Russian and `\b안\b` against Hangul are silent no-ops.
//     Latin-script English/French/Spanish/German keep the same hits they had
//     under `\b` (pinned by stt-polish-guard-langs.test.ts). Korean uses
//     spaces, so it rides this path and `안` inside `안녕` is NOT a hit —
//     substring would have been the false-positive.
//
// Japanese stays on substring: ません is glued to surrounding kana, so a
// word-boundary around it never fires. Bare ない is included (it is THE
// spoken negation) with the same collision cost Chinese 不 already accepts
// inside compounds; みんないい is the known extra collision and is named
// in the langs test so it cannot become an unnoticed false reject later.
//
// French `ne` is deliberately absent: spoken French drops it and a polish
// that restores literary `ne…pas` is correct work. `pas` / `jamais` /
// `rien` are the load-bearing spoken markers.
//
// 🔴 THIS IS A COVERAGE STATEMENT, NOT A LANGUAGE WHITELIST. Every language
// still gets polished and still gets the §3.1 cardinality bound. Nothing is
// refused on the strength of CLOSED_CLASS_GUARDED_LANGS.
//
// zh-TW is one spoken language with zh, one routing row — not a missing
// entry (owner 2026-08-27). `isClosedClassGuarded('zh-TW')` is true via the
// base-language match, same as before this file existed.
//
// Kept honest by stt-polish-guard-coverage.test.ts (membership predicts
// whether a real negation is seen) and stt-polish-guard-langs.test.ts
// (each new language: a realistic violation rejects, a clean polish does
// not).

const ZH_NEGATION = ['不', '没', '没有', '别', '未', '无', '非', '勿', '莫'];
const EN_NEGATION = ['not', "n't", 'no', 'never', 'none', 'neither', 'nor', 'without'];
const FR_NEGATION = ['pas', 'jamais', 'rien', 'aucun', 'aucune', 'sans', 'ni'];
const ES_NEGATION = ['no', 'nunca', 'nada', 'ningún', 'ninguna', 'ninguno', 'ni', 'sin', 'jamás'];
const DE_NEGATION = ['nicht', 'kein', 'keine', 'keiner', 'nie', 'niemals', 'nichts', 'ohne', 'nirgends'];
const JA_NEGATION = ['ませんでした', 'ません', 'なかった', 'なくて', 'じゃない', 'ではない', 'ない', 'ず'];
const KO_NEGATION = ['없다', '없어', '않다', '않아', '아닌', '아니', '말고', '안', '못'];
const RU_NEGATION = ['не', 'нет', 'ни', 'никогда', 'ничего', 'нельзя', 'без'];

const ZH_QUANTIFIER = ['都', '全', '只', '仅', '每', '各', '所有'];
const EN_QUANTIFIER = ['all', 'only', 'every', 'each', 'both', 'most', 'some', 'any', 'few', 'none'];
const FR_QUANTIFIER = ['tous', 'toutes', 'tout', 'toute', 'chaque', 'plusieurs', 'quelques', 'seul', 'seule', 'seulement'];
const ES_QUANTIFIER = ['todo', 'todos', 'toda', 'todas', 'cada', 'ambos', 'mucho', 'poco', 'algunos', 'solo', 'sólo'];
const DE_QUANTIFIER = ['alle', 'alles', 'jeder', 'jede', 'jedes', 'beide', 'einige', 'wenige', 'nur'];
const JA_QUANTIFIER = ['すべての', 'すべて', '全て', '全部', 'だけ', 'のみ'];
const KO_QUANTIFIER = ['모든', '전부', '마다', '몇'];
const RU_QUANTIFIER = ['все', 'весь', 'вся', 'каждый', 'только', 'несколько', 'мало', 'оба'];

const ZH_NUMERALS = ['一', '二', '两', '三', '四', '五', '六', '七', '八', '九', '十', '百', '千', '万', '亿', '零'];
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const ZH_MODAL = ['能', '会', '要', '得', '必须', '应该', '可能', '也许', '一定', '千万'];
const EN_MODAL = ['must', 'can', 'cannot', 'could', 'should', 'would', 'may', 'might', 'will', 'shall'];
const FR_MODAL = ['doit', 'doivent', 'dois', 'peut', 'peuvent', 'peux', 'pourrait', 'devrait', 'faut', 'voudrait'];
const ES_MODAL = ['debe', 'deben', 'puede', 'pueden', 'podría', 'debería', 'quiero', 'quiere'];
const DE_MODAL = ['muss', 'müssen', 'kann', 'können', 'soll', 'sollen', 'darf', 'dürfen', 'möchte'];
const JA_MODAL = ['なければならない', 'かもしれない', 'できない', 'できる', 'べき', 'だろう', 'でしょう', 'たい'];
const KO_MODAL = ['해야', '된다', '되면', '싶다', '겠다'];
const RU_MODAL = ['должен', 'должна', 'можно', 'нужно', 'надо', 'может', 'могут', 'хочет'];

/** Languages whose negation / quantification / modality this gate actually
 *  checks. Base-language match (zh-CN / zh-TW / en-US all resolve). An
 *  unknown tag is not a claim of coverage. */
export const CLOSED_CLASS_GUARDED_LANGS: readonly string[] = [
  'zh', 'en', 'fr', 'es', 'de', 'ja', 'ko', 'ru',
];

/** Space-separated closed-class terms. Matched with a Unicode letter-boundary
 *  so Cyrillic and Hangul get the same strategy English always had. Japanese
 *  and Chinese terms are absent on purpose — they have no word boundaries
 *  and ride the substring path. `n't` is a suffix, not a word. */
export const WORD_BOUNDARY_TERMS: ReadonlySet<string> = new Set([
  ...EN_NEGATION, ...EN_QUANTIFIER, ...EN_MODAL,
  ...FR_NEGATION, ...FR_QUANTIFIER, ...FR_MODAL,
  ...ES_NEGATION, ...ES_QUANTIFIER, ...ES_MODAL,
  ...DE_NEGATION, ...DE_QUANTIFIER, ...DE_MODAL,
  ...KO_NEGATION, ...KO_QUANTIFIER, ...KO_MODAL,
  ...RU_NEGATION, ...RU_QUANTIFIER, ...RU_MODAL,
].filter((t) => t !== "n't"));

/** Every closed-class term, longest-first so multi-char phrases (没有,
 *  なければならない) match as themselves in addition to component chars. */
export const CLOSED_CLASS_TERMS: readonly string[] = [...new Set([
  ...ZH_NEGATION, ...EN_NEGATION, ...FR_NEGATION, ...ES_NEGATION, ...DE_NEGATION, ...JA_NEGATION, ...KO_NEGATION, ...RU_NEGATION,
  ...ZH_QUANTIFIER, ...EN_QUANTIFIER, ...FR_QUANTIFIER, ...ES_QUANTIFIER, ...DE_QUANTIFIER, ...JA_QUANTIFIER, ...KO_QUANTIFIER, ...RU_QUANTIFIER,
  ...ZH_NUMERALS, ...DIGITS,
  ...ZH_MODAL, ...EN_MODAL, ...FR_MODAL, ...ES_MODAL, ...DE_MODAL, ...JA_MODAL, ...KO_MODAL, ...RU_MODAL,
])].sort((a, b) => b.length - a.length);

/** True when [CLOSED_CLASS_GUARDED_LANGS] covers this spoken tag. */
export function isClosedClassGuarded(lang: string | undefined): boolean {
  if (lang === undefined) return false;
  const base = lang.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';
  return (CLOSED_CLASS_GUARDED_LANGS as readonly string[]).includes(base);
}

// Re-exported so the langs test can quote what was added, verbatim, without
// duplicating the arrays. Not a public API.
export const CLOSED_CLASS_ADDED = {
  fr: { negation: FR_NEGATION, quantifier: FR_QUANTIFIER, modal: FR_MODAL },
  es: { negation: ES_NEGATION, quantifier: ES_QUANTIFIER, modal: ES_MODAL },
  de: { negation: DE_NEGATION, quantifier: DE_QUANTIFIER, modal: DE_MODAL },
  ja: { negation: JA_NEGATION, quantifier: JA_QUANTIFIER, modal: JA_MODAL },
  ko: { negation: KO_NEGATION, quantifier: KO_QUANTIFIER, modal: KO_MODAL },
  ru: { negation: RU_NEGATION, quantifier: RU_QUANTIFIER, modal: RU_MODAL },
} as const;
