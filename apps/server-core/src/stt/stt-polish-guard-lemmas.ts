// ML-1 (2026-10-13): negation / modality / quantifier words compared by LEMMA
// CLASS in fr / es / de / ru / ko, not by surface form.
//
// The §3.2 term table (stt-polish-guard-terms.ts) lists whole words, and the
// matcher counts each one exactly. In these languages the same word takes many
// forms, so ML-0 (_dispatch/2026-10-13-eval-multilingual-baseline.md §3 D3)
// measured both failures of that:
//   · an inflected form the table does not list is invisible: keinen -> einen,
//     personne ne -> quelqu'un, ne répond plus -> répond, Nadie -> Alguien,
//     tampoco -> también, Никто -> Кто-то, Всё -> Почти, 쓰지 않았습니다 ->
//     썼습니다, 없습니다 -> 있습니다 were accepted;
//   · a listed form that changes person is "a modal that vanished": on devrait
//     -> nous devrions was refused, and the user got their filler back.
// With the session language known, that language's table terms are replaced by
// the classes below: every form of a lemma counts as one class, and the class
// counts are compared. Mood stays apart where it changes meaning: devrait
// (should) is not doit (must), sollten is not könnten, debería is not debe.
//
// Japanese keeps the table (its terms are already substrings); it only gains
// 午前 / 午後, which ML-0 ja-05 showed flipping unseen.
//
// Cost, stated: a correct rewrite that swaps a member of one class for a
// synonym in another (on doit -> il faut, нужно -> надо is fine: one class) is
// refused; under smooth that falls back to one strict attempt.
import { CLOSED_CLASS_ADDED } from './stt-polish-guard-terms';

export type LemmaCategory = 'negation' | 'modal' | 'quantifier' | 'time';
export interface LemmaClass { key: string; cat: LemmaCategory; re: RegExp }

const B = (src: string): string => `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
const word = (key: string, cat: LemmaCategory, src: string): LemmaClass => ({ key, cat, re: new RegExp(B(src), 'giu') });
const sub = (key: string, cat: LemmaCategory, src: string): LemmaClass => ({ key, cat, re: new RegExp(src, 'gu') });

// ML-1 review F1: a modal is keyed by lemma, mood AND person / number:
// puedo -> puede, ich muss -> wir müssen, ihr könnt -> Sie können change who
// can or must. A form two persons share (dois: 1sg and 2sg; müssen: 1pl and
// 3pl) is one class keyed by both, so only a change of form counts. French
// "on" takes a third-person form and means "we": on devrait counts as 1pl, so
// on devrait -> nous devrions stays one modal (ML-0 fr-fil-01).
const ON = "(?:^|[^\\p{L}])on\\s+(?:ne\\s+|n['’])?";
function modal(key: string, persons: Readonly<Record<string, readonly string[]>>, after = ''): LemmaClass[] {
  const tags = new Map<string, string[]>();
  for (const [p, forms] of Object.entries(persons)) for (const f of forms) tags.set(f, [...(tags.get(f) ?? []), p]);
  const groups = new Map<string, string[]>();
  for (const [f, ps] of tags) { const t = [...ps].sort().join('|'); groups.set(t, [...(groups.get(t) ?? []), f]); }
  const fr = key.startsWith('fr:');
  const third = [...groups].filter(([t]) => t.split('|').includes('3sg')).flatMap(([, fs]) => fs);
  return [...groups].map(([t, forms]) => {
    let src = `${B(forms.join('|'))}${after}`;
    if (fr && t.split('|').includes('3sg')) src = `(?<!${ON})${src}`;
    if (fr && t.split('|').includes('1pl') && third.length > 0) src = `${src}|(?<=${ON})${B(third.join('|'))}${after}`;
    return { key: `${key}:${t}`, cat: 'modal' as const, re: new RegExp(src, 'giu') };
  });
}

const FR: readonly LemmaClass[] = [
  word('fr:pas', 'negation', 'pas'), word('fr:jamais', 'negation', 'jamais'), word('fr:rien', 'negation', 'rien'),
  word('fr:aucun', 'negation', 'aucune?s?'), word('fr:sans', 'negation', 'sans'), word('fr:ni', 'negation', 'ni'),
  word('fr:guère', 'negation', 'guère'), word('fr:nulle-part', 'negation', 'nulle\\s+part'),
  // personne as "nobody", not "a person": no determiner right before it.
  { key: 'fr:personne', cat: 'negation', re: /(?<!(?:^|[^\p{L}])(?:une|la|cette|chaque|des|les|en|seule|bonne|autre|quelle)\s+)(?<![\p{L}\p{N}_])personne(?![\p{L}\p{N}_])/giu },
  // ne … plus ("no longer"): plus within two words after ne / n'.
  { key: 'fr:ne-plus', cat: 'negation', re: /(?<![\p{L}])n(?:e\s+|['’])(?:[\p{L}'’-]+\s+){0,2}?plus(?![\p{L}])/giu },
  ...modal('fr:devoir', { '1sg': ['dois', 'devais', 'devrai'], '2sg': ['dois', 'devais', 'devras'], '3sg': ['doit', 'devait', 'devra', 'dû'], '1pl': ['devons', 'devions', 'devrons'], '2pl': ['devez', 'deviez', 'devrez'], '3pl': ['doivent', 'devaient', 'devront'] }),
  ...modal('fr:devoir-cond', { '1sg': ['devrais'], '2sg': ['devrais'], '3sg': ['devrait'], '1pl': ['devrions'], '2pl': ['devriez'], '3pl': ['devraient'] }),
  ...modal('fr:pouvoir', { '1sg': ['peux', 'pouvais', 'pourrai'], '2sg': ['peux', 'pouvais', 'pourras'], '3sg': ['peut', 'pouvait', 'pourra'], '1pl': ['pouvons', 'pouvions', 'pourrons'], '2pl': ['pouvez', 'pouviez', 'pourrez'], '3pl': ['peuvent', 'pouvaient', 'pourront'] }),
  ...modal('fr:pouvoir-cond', { '1sg': ['pourrais'], '2sg': ['pourrais'], '3sg': ['pourrait'], '1pl': ['pourrions'], '2pl': ['pourriez'], '3pl': ['pourraient'] }),
  ...modal('fr:vouloir', { '1sg': ['veux', 'voulais', 'voudrai'], '2sg': ['veux', 'voulais', 'voudras'], '3sg': ['veut', 'voulait', 'voudra'], '1pl': ['voulons', 'voulions', 'voudrons'], '2pl': ['voulez', 'vouliez', 'voudrez'], '3pl': ['veulent', 'voulaient', 'voudront'] }),
  ...modal('fr:vouloir-cond', { '1sg': ['voudrais'], '2sg': ['voudrais'], '3sg': ['voudrait'], '1pl': ['voudrions'], '2pl': ['voudriez'], '3pl': ['voudraient'] }),
  word('fr:falloir', 'modal', 'faut|fallait|faudra|fallu'), word('fr:falloir-cond', 'modal', 'faudrait'),
  word('fr:tout', 'quantifier', 'tout|tous|toute|toutes'), word('fr:chaque', 'quantifier', 'chaque'),
  word('fr:plusieurs', 'quantifier', 'plusieurs'), word('fr:quelques', 'quantifier', 'quelques?'),
  word('fr:seul', 'quantifier', 'seule?s?|seulement'), word('fr:certains', 'quantifier', 'certaine?s'),
  word('fr:plupart', 'quantifier', 'plupart'),
];

const ES: readonly LemmaClass[] = [
  word('es:no', 'negation', 'no'), word('es:nunca', 'negation', 'nunca|jamás'), word('es:nada', 'negation', 'nada'),
  word('es:nadie', 'negation', 'nadie'), word('es:ninguno', 'negation', 'ningún|ningun[oa]s?'), word('es:ni', 'negation', 'ni'),
  word('es:sin', 'negation', 'sin'), word('es:tampoco', 'negation', 'tampoco'),
  ...modal('es:deber', { '1sg': ['debo', 'debía', 'deberé'], '2sg': ['debes', 'debías', 'deberás'], '3sg': ['debe', 'debía', 'deberá'], '1pl': ['debemos', 'debíamos', 'deberemos'], '2pl': ['debéis', 'debíais', 'deberéis'], '3pl': ['deben', 'debían', 'deberán'], inf: ['deber', 'debido'] }),
  ...modal('es:deber-cond', { '1sg': ['debería'], '2sg': ['deberías'], '3sg': ['debería'], '1pl': ['deberíamos'], '2pl': ['deberíais'], '3pl': ['deberían'] }),
  ...modal('es:poder', { '1sg': ['puedo', 'podía', 'podré', 'pude'], '2sg': ['puedes', 'podías', 'podrás'], '3sg': ['puede', 'podía', 'podrá', 'pudo'], '1pl': ['podemos', 'podíamos', 'podremos'], '2pl': ['podéis', 'podíais', 'podréis'], '3pl': ['pueden', 'podían', 'podrán'], inf: ['poder', 'podido'] }),
  ...modal('es:poder-cond', { '1sg': ['podría'], '2sg': ['podrías'], '3sg': ['podría'], '1pl': ['podríamos'], '2pl': ['podríais'], '3pl': ['podrían'] }),
  ...modal('es:querer', { '1sg': ['quiero', 'quería', 'querré'], '2sg': ['quieres', 'querías', 'querrás'], '3sg': ['quiere', 'quería', 'querrá'], '1pl': ['queremos', 'queríamos', 'querremos'], '2pl': ['queréis', 'queríais', 'querréis'], '3pl': ['quieren', 'querían', 'querrán'], inf: ['querer'] }),
  ...modal('es:querer-cond', { '1sg': ['querría', 'quisiera'], '2sg': ['querrías', 'quisieras'], '3sg': ['querría', 'quisiera'], '1pl': ['querríamos', 'quisiéramos'], '2pl': ['querríais', 'quisierais'], '3pl': ['querrían', 'quisieran'] }),
  ...modal('es:tener-que', { '1sg': ['tengo', 'tenía', 'tendré', 'tuve'], '2sg': ['tienes', 'tenías', 'tendrás'], '3sg': ['tiene', 'tenía', 'tendrá', 'tuvo'], '1pl': ['tenemos', 'teníamos', 'tendremos'], '2pl': ['tenéis', 'teníais', 'tendréis'], '3pl': ['tienen', 'tenían', 'tendrán'] }, '\\s+que(?![\\p{L}])'),
  { key: 'es:hay-que', cat: 'modal', re: new RegExp(`${B('hay|había|habrá')}\\s+que(?![\\p{L}])`, 'giu') },
  word('es:todo', 'quantifier', 'tod[oa]s?'), word('es:cada', 'quantifier', 'cada'), word('es:ambos', 'quantifier', 'amb[oa]s'),
  word('es:mucho', 'quantifier', 'much[oa]s?'), word('es:poco', 'quantifier', 'poc[oa]s?'),
  word('es:alguno', 'quantifier', 'algún|algun[oa]s?'), word('es:solo', 'quantifier', 'solo|sólo|solamente'),
  word('es:varios', 'quantifier', 'vari[oa]s'),
];

const DE: readonly LemmaClass[] = [
  word('de:nicht', 'negation', 'nicht'), word('de:kein', 'negation', 'kein(?:e|en|em|er|es)?'), word('de:nie', 'negation', 'nie'),
  word('de:niemals', 'negation', 'niemals'), word('de:nichts', 'negation', 'nichts'), word('de:niemand', 'negation', 'niemand(?:en|em|es)?'),
  word('de:nirgends', 'negation', 'nirgends|nirgendwo'), word('de:ohne', 'negation', 'ohne'), word('de:weder', 'negation', 'weder'),
  ...modal('de:müssen', { '1sg': ['muss', 'muß', 'musste'], '2sg': ['musst', 'mußt', 'musstest'], '3sg': ['muss', 'muß', 'musste'], '1pl': ['müssen', 'mussten'], '2pl': ['müsst', 'müßt', 'musstet'], '3pl': ['müssen', 'mussten'] }),
  ...modal('de:müssen-k2', { '1sg': ['müsste', 'müßte'], '2sg': ['müsstest'], '3sg': ['müsste', 'müßte'], '1pl': ['müssten', 'müßten'], '2pl': ['müsstet'], '3pl': ['müssten', 'müßten'] }),
  ...modal('de:sollen', { '1sg': ['soll'], '2sg': ['sollst'], '3sg': ['soll'], '1pl': ['sollen'], '2pl': ['sollt'], '3pl': ['sollen'] }),
  ...modal('de:sollen-k2', { '1sg': ['sollte'], '2sg': ['solltest'], '3sg': ['sollte'], '1pl': ['sollten'], '2pl': ['solltet'], '3pl': ['sollten'] }),
  ...modal('de:können', { '1sg': ['kann', 'konnte'], '2sg': ['kannst', 'konntest'], '3sg': ['kann', 'konnte'], '1pl': ['können', 'konnten'], '2pl': ['könnt', 'konntet'], '3pl': ['können', 'konnten'] }),
  ...modal('de:können-k2', { '1sg': ['könnte'], '2sg': ['könntest'], '3sg': ['könnte'], '1pl': ['könnten'], '2pl': ['könntet'], '3pl': ['könnten'] }),
  ...modal('de:dürfen', { '1sg': ['darf', 'durfte'], '2sg': ['darfst', 'durftest'], '3sg': ['darf', 'durfte'], '1pl': ['dürfen', 'durften'], '2pl': ['dürft', 'durftet'], '3pl': ['dürfen', 'durften'] }),
  ...modal('de:dürfen-k2', { '1sg': ['dürfte'], '2sg': ['dürftest'], '3sg': ['dürfte'], '1pl': ['dürften'], '2pl': ['dürftet'], '3pl': ['dürften'] }),
  ...modal('de:wollen', { '1sg': ['will', 'wollte'], '2sg': ['willst', 'wolltest'], '3sg': ['will', 'wollte'], '1pl': ['wollen', 'wollten'], '2pl': ['wollt', 'wolltet'], '3pl': ['wollen', 'wollten'] }),
  ...modal('de:mögen', { '1sg': ['mag', 'mochte'], '2sg': ['magst', 'mochtest'], '3sg': ['mag', 'mochte'], '1pl': ['mögen', 'mochten'], '2pl': ['mögt', 'mochtet'], '3pl': ['mögen', 'mochten'] }),
  ...modal('de:möchten', { '1sg': ['möchte'], '2sg': ['möchtest'], '3sg': ['möchte'], '1pl': ['möchten'], '2pl': ['möchtet'], '3pl': ['möchten'] }),
  word('de:all', 'quantifier', 'all(?:e|es|en|er|em)'), word('de:jed', 'quantifier', 'jed(?:er|e|es|en|em)'),
  word('de:beide', 'quantifier', 'beide[nrs]?'), word('de:einig', 'quantifier', 'einig(?:e|en|er|es|em)'),
  word('de:wenig', 'quantifier', 'wenig(?:e|en|er|es|em)?'), word('de:nur', 'quantifier', 'nur'),
  word('de:manch', 'quantifier', 'manch(?:e|en|er|es|em)'), word('de:mehrere', 'quantifier', 'mehrere[n]?'),
  word('de:viel', 'quantifier', 'viel(?:e|en|er|es|em)?'),
];

// Russian is matched on text with ё folded to е (see foldYo).
const RU: readonly LemmaClass[] = [
  word('ru:не', 'negation', 'не'), word('ru:нет', 'negation', 'нет'), word('ru:ни', 'negation', 'ни'),
  word('ru:никогда', 'negation', 'никогда'), word('ru:нельзя', 'negation', 'нельзя'), word('ru:без', 'negation', 'без'),
  word('ru:никто', 'negation', 'никто|никого|никому|никем|ником'), word('ru:ничто', 'negation', 'ничто|ничего|ничему|ничем'),
  word('ru:нигде', 'negation', 'нигде|никуда|ниоткуда'), word('ru:никакой', 'negation', 'никак(?:ой|ая|ое|ие|ого|ую|их|им|ими|ом|ому)?'),
  ...modal('ru:должен', { sg: ['должен', 'должна', 'должно'], pl: ['должны'] }),
  word('ru:можно', 'modal', 'можно'),
  ...modal('ru:мочь', { '1sg': ['могу', 'смогу'], '2sg': ['можешь', 'сможешь'], '3sg': ['может', 'сможет'], '1pl': ['можем', 'сможем'], '2pl': ['можете', 'сможете'], '3pl': ['могут', 'смогут'], psg: ['мог', 'могла', 'могло', 'смог', 'смогла', 'смогло'], ppl: ['могли', 'смогли'] }),
  ...modal('ru:хотеть', { '1sg': ['хочу'], '2sg': ['хочешь'], '3sg': ['хочет'], '1pl': ['хотим'], '2pl': ['хотите'], '3pl': ['хотят'], psg: ['хотел', 'хотела', 'хотело'], ppl: ['хотели'] }),
  word('ru:нужно', 'modal', 'нужно|надо|нужен|нужна|нужны'),
  word('ru:стоит', 'modal', 'стоит|стоило'), word('ru:прийтись', 'modal', 'придется|приходится|пришлось'),
  word('ru:следует', 'modal', 'следует|следовало'), word('ru:бы', 'modal', 'бы|б'),
  word('ru:весь', 'quantifier', 'все|весь|вся|всех|всем|всеми|всего|всей|всему|всю|всею'),
  word('ru:каждый', 'quantifier', 'кажд(?:ый|ая|ое|ого|ому|ым|ом|ую|ой|ые|ых)'), word('ru:только', 'quantifier', 'только'),
  word('ru:несколько', 'quantifier', 'нескольк\\p{L}+'), word('ru:мало', 'quantifier', 'мало'),
  word('ru:оба', 'quantifier', 'оба|обе|обоих|обеих'), word('ru:некоторые', 'quantifier', 'некотор\\p{L}+'),
  word('ru:почти', 'quantifier', 'почти'), word('ru:много', 'quantifier', 'много|многие|многих|многим'),
  word('ru:всегда', 'quantifier', 'всегда'), word('ru:иногда', 'quantifier', 'иногда'), word('ru:часто', 'quantifier', 'часто'),
  word('ru:редко', 'quantifier', 'редко'), word('ru:обычно', 'quantifier', 'обычно'),
];

// Korean negation and modality live in endings: matched inside the word.
const KO: readonly LemmaClass[] = [
  word('ko:안', 'negation', '안'),
  sub('ko:못', 'negation', '(?<![\\p{L}])못(?![\\p{L}])|못(?=하|했|합|해|한|할)'),
  sub('ko:않', 'negation', '않'), sub('ko:없', 'negation', '없'),
  sub('ko:아니', 'negation', '아니|아닌|아닙|아닐|아냐|아뇨|아님'),
  sub('ko:말', 'negation', '지\\s*(?:마|말)'),
  sub('ko:must', 'modal', '야\\s*(?:하|합|해|했|한|할|돼|됩|된|될)|야지(?![\\p{L}])'),
  sub('ko:can', 'modal', '수\\s*(?:있|없)'), sub('ko:want', 'modal', '고\\s*싶'),
  word('ko:모든', 'quantifier', '모든'), sub('ko:모두', 'quantifier', '모두'), sub('ko:전부', 'quantifier', '전부'),
  sub('ko:마다', 'quantifier', '마다'), word('ko:몇', 'quantifier', '몇'), sub('ko:일부', 'quantifier', '일부'),
  sub('ko:only', 'quantifier', '뿐|밖에'),
  sub('ko:오전', 'time', '오전'), sub('ko:오후', 'time', '오후'),
];

const JA: readonly LemmaClass[] = [sub('ja:午前', 'time', '午前'), sub('ja:午後', 'time', '午後')];

const CLASSES: Readonly<Record<string, readonly LemmaClass[]>> = { fr: FR, es: ES, de: DE, ru: RU, ko: KO, ja: JA };

// The §3.2 table terms each language's classes replace. Japanese: none.
const KO_REPLACED = ['없다', '없어', '않다', '않아', '아닌', '아니', '말고', '안', '못', '모든', '전부', '마다', '몇', '해야', '싶다'];
const REPLACED: Readonly<Record<string, ReadonlySet<string>>> = {
  ...Object.fromEntries((['fr', 'es', 'de', 'ru'] as const).map((l) => {
    const t = CLOSED_CLASS_ADDED[l];
    return [l, new Set<string>([...t.negation, ...t.quantifier, ...t.modal])] as const;
  })),
  ko: new Set(KO_REPLACED),
};

/** The lemma classes for a base language tag, or none. */
export function lemmaClasses(lang: string | undefined): readonly LemmaClass[] {
  return lang === undefined ? [] : CLASSES[lang] ?? [];
}

/** True when `term` (a §3.2 table term) is compared by class in `lang`. */
export function replacedByLemma(term: string, lang: string | undefined): boolean {
  return lang !== undefined && (REPLACED[lang]?.has(term) ?? false);
}

export function foldYo(s: string): string {
  return s.replace(/ё/gu, 'е').replace(/Ё/gu, 'Е');
}

/** True when the single word `w` is a member of one of `lang`'s classes. */
export function isLemmaWord(w: string, lang: string): boolean {
  return lemmaClasses(lang).some((c) => lemmaCount(c, w) === 1 && (foldYo(w).match(c.re)?.[0]?.length ?? 0) === w.length);
}

/** Count of `cls` in `text` (Russian folded). */
export function lemmaCount(cls: LemmaClass, text: string): number {
  return (foldYo(text).match(cls.re) ?? []).length;
}

/** The first lemma class whose count differs, or null. */
export function lemmaDrift(raw: string, polished: string, lang: string | undefined): string | null {
  for (const cls of lemmaClasses(lang)) if (lemmaCount(cls, raw) !== lemmaCount(cls, polished)) return cls.key;
  return null;
}
