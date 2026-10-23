// ML-1 (2026-10-13): structure the multiset comparisons cannot see, in fr / es
// / de / ja / ko / ru. Both strengths.
//
// ML-0 (_dispatch/2026-10-13-eval-multilingual-baseline.md §3 D4) measured
// three meaning changes that keep every closed-class count equal and fit the
// Smooth distance bounds:
//   · a negation that MOVED to another clause ("I did not say we postpone" ->
//     "I said we do not postpone"): fr-08, de-09, es-09, ja-08, ko-10, ru-08;
//   · a whole clause DROPPED in a language the Latin content-word check
//     (stt-polish-guard-content.ts) cannot read: ja-11, ko-13;
//   · the REGISTER flipped (tu/vous, du/Sie, tú/usted, ты/вы, です・ます vs
//     plain, 요/습니다 vs 반말): fr-09/10, de-10/11, es-10/11, ja-09/10,
//     ko-11/12, ru-09/10.
//
// Clauses are cut at punctuation and before the subordinating / coordinating
// words of each language (que, dass, что, 고 …). A clause is known by its
// content tokens (Latin and Cyrillic words, the first two syllables of a Korean
// word, each kanji / katakana character), and a negation belongs to its clause.
//
// Cost, stated: a correct rewrite that moves a clause boundary AND changes the
// words around a negation can be refused; a smoothing that drops a clause the
// filler lists do not know is refused. Under smooth both fall back to one
// strict attempt (stt-polish.ts).
import { CLOSED_CLASS_ADDED } from './stt-polish-guard-terms';
import { foldYo, lemmaClasses, lemmaCount } from './stt-polish-guard-lemmas';
import { isLatinContentWord } from './stt-polish-guard-content';
import { wordNumbers } from './stt-polish-guard-numwords';
import { sentenceEndCommandSource } from './stt-polish-guard-dictation-words';

const STRUCTURE_LANGS = new Set(['fr', 'es', 'de', 'ja', 'ko', 'ru']);

const SPLIT_BEFORE: Readonly<Record<string, string>> = {
  fr: 'que|qui|quand|mais|car|parce',
  es: 'que|cuando|pero|porque|aunque',
  de: 'dass|weil|ob|wenn|aber|obwohl|damit',
  ru: 'что|чтобы|когда|если|но|потому|который|которая|которое|которые',
};
// Korean connective endings close a clause (보내지 말고 | 김 대리님께 보내 주세요).
const KO_CLAUSE_END = /(?:고|며|지만|는데|면서|니까|어서|아서|으면|면|도록)$/u;

function clauses(text: string, lang: string): string[] {
  const parts = foldYo(text).split(/[,;:.!?…、，。；：！？\n]+/u);
  const out: string[] = [];
  for (const p of parts) {
    if (lang === 'ko') {
      let cur: string[] = [];
      for (const w of p.split(/\s+/u).filter(Boolean)) {
        cur.push(w);
        if (KO_CLAUSE_END.test(w)) { out.push(cur.join(' ')); cur = []; }
      }
      if (cur.length) out.push(cur.join(' '));
      continue;
    }
    const before = SPLIT_BEFORE[lang];
    // ML-1 review F5: French elided qu' (qu'il, qu'on) opens a clause too; the
    // letter after the apostrophe belongs to the next word.
    const elided = lang === 'fr' ? "|qu['’]" : '';
    if (before) out.push(...p.split(new RegExp(`(?<![\\p{L}])(?=(?:${before})(?![\\p{L}])${elided})`, 'iu')));
    else out.push(p);
  }
  return out.map((c) => c.trim()).filter((c) => c.length > 0);
}

const RU_STOP = new Set(`это этот эта эти этого того тому тот так как вот ну значит короче вообще просто наверное кстати типа
слушай смотри тоже также очень уже еще ещё есть было будет быть который которая которые когда если потому чтобы где куда
меня тебя тебе него нему нее неё них нами вами нас вам они она оно мы вы ты он я свой своя свои мой моя мои наш ваш их`
  .split(/\s+/u).map(foldYo));
// Korean words that are fillers, or auxiliaries that follow the content verb.
const KO_FILLER = new Set(['음', '어', '그', '저', '아', '뭐', '그냥', '이제', '약간', '진짜', '사실', '그러니까', '그래서', '네', '예', '막', '좀', '저기', '있잖아']);
const KO_AUX_START = /^(?:주|하|해|했|합|있|없|되|돼|것|수|거|게|때|더|잘|다)/u;

/** The content tokens of a clause. */
function content(clause: string, lang: string): Set<string> {
  const out = new Set<string>();
  if (lang === 'ja') {
    for (const c of clause) if (/[\p{Script=Han}\p{Script=Katakana}]/u.test(c) && c !== 'ー') out.add(c);
    return out;
  }
  // Elisions split off (n'est -> n, est): the article is not content.
  for (const w of clause.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (/\p{Script=Hangul}/u.test(w)) {
      if (KO_FILLER.has(w) || KO_AUX_START.test(w)) continue;
      out.add([...w].slice(0, 2).join(''));
    } else if (/\p{Script=Cyrillic}/u.test(w)) {
      // ML-1 review F4: a number word is compared by value by the numbers
      // gate (двадцать пять -> 25 is not a dropped clause).
      if ([...w].length >= 4 && !RU_STOP.has(w) && wordNumbers(w, 'ru').length === 0) out.add([...w].slice(0, 5).join(''));
    } else if (isLatinContentWord(w)) {
      out.add(w.slice(0, 6));
    }
  }
  return out;
}

const JA_NEGATION = CLOSED_CLASS_ADDED.ja.negation;
function negations(clause: string, lang: string): number {
  if (lang === 'ja') {
    // Longest first, consumed, so ませんでした counts once.
    let s = clause;
    let n = 0;
    for (const t of [...JA_NEGATION].sort((a, b) => b.length - a.length)) {
      const k = s.split(t).length - 1;
      n += k;
      s = s.split(t).join('¤');
    }
    return n;
  }
  return lemmaClasses(lang).filter((c) => c.cat === 'negation').reduce((n, c) => n + lemmaCount(c, clause), 0);
}

interface Clause { neg: number; words: Set<string> }

function read(text: string, lang: string): Clause[] {
  return clauses(text, lang).map((c) => ({ neg: negations(c, lang), words: content(c, lang) }));
}

/** A clause of `from` whose negations are not in the `to` clause it best
 *  matches by content. */
function negationLeft(from: readonly Clause[], to: readonly Clause[]): boolean {
  for (const c of from) {
    if (c.neg === 0 || c.words.size === 0) continue;
    let best = 0;
    let bestNeg = -1;
    for (const d of to) {
      let shared = 0;
      for (const w of c.words) if (d.words.has(w)) shared += 1;
      if (shared > best || (shared === best && shared > 0 && d.neg > bestNeg)) { best = shared; bestNeg = d.neg; }
    }
    if (best > 0 && bestNeg < c.neg) return true;
  }
  return false;
}

/** ML-0 D4: a negation moved to another clause. */
export function negationClauseDrift(raw: string, polished: string, lang: string | undefined): boolean {
  if (lang === undefined || !STRUCTURE_LANGS.has(lang)) return false;
  const a = read(raw, lang);
  const b = read(polished, lang);
  return negationLeft(a, b) || negationLeft(b, a);
}

/** ML-0 D4: a clause whose content is gone from the output (ja / ko / ru —
 *  the Latin languages have the per-word content check). */
export function droppedClause(raw: string, polished: string, lang: string | undefined): boolean {
  if (lang !== 'ja' && lang !== 'ko' && lang !== 'ru') return false;
  const kept = content(foldYo(polished), lang);
  for (const c of read(raw, lang)) {
    if (c.words.size < 2) continue;
    let missing = 0;
    for (const w of c.words) if (!kept.has(w)) missing += 1;
    if (missing >= 2 && missing / c.words.size >= 0.6) return true;
  }
  return false;
}

// ─── register ───────────────────────────────────────────────────────────────
const T_V: Readonly<Record<string, readonly [RegExp, RegExp]>> = {
  fr: [/(?<![\p{L}])(?:tu|toi|te|ton|ta|tes)(?![\p{L}])|(?<![\p{L}])t['’](?=\p{L})/giu, /(?<![\p{L}])(?:vous|votre|vos)(?![\p{L}])/giu],
  es: [/(?<![\p{L}])(?:tú|ti|te|contigo|tu|tus|vos|vosotros|vosotras)(?![\p{L}])/giu, /(?<![\p{L}])(?:usted|ustedes|ud|uds|vd|vds)(?![\p{L}])/giu],
  de: [/(?<![\p{L}])(?:du|dich|dir|dein|deine|deinen|deinem|deiner|deines|euch|euer|eure|euren|eurem|eurer|eures)(?![\p{L}])/giu, /(?<![\p{L}])(?:Sie|Ihnen|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?![\p{L}])/gu],
  ru: [/(?<![\p{L}])(?:ты|тебя|тебе|тобой|тобою|тво[йяеи]\p{L}*)(?![\p{L}])|\p{L}{2,}(?:ешь|ишь)(?![\p{L}])/giu,
    /(?<![\p{L}])(?:вы|вас|вам|вами|ваш\p{L}*|можете|хотите|сможете|будете|знаете|скажите|подскажите|посмотрите|пришлите|напишите|перезвоните|дайте)(?![\p{L}])|\p{L}{2,}(?:ьте|йте)(?![\p{L}])/giu],
};

/** German Sie / Ihr at a sentence start may be "she" / "her": only mid-sentence counts. */
function count(re: RegExp, text: string, lang: string, formal: boolean): number {
  let n = 0;
  for (const m of foldYo(text).matchAll(re)) {
    if (lang === 'de' && formal) {
      const before = text.slice(0, m.index).trimEnd();
      if (before.length === 0 || /[.!?:;"„«»]$/u.test(before)) continue;
    }
    n += 1;
  }
  return n;
}

const JA_POLITE = /(?:です|ます|ました|ません|ましょう|でした|ください|下さい|ございます|でしょう|ますか|ですか|でしたか|ませんか)[。．.!！?？」』）)]*$/u;
const JA_PLAIN = /(?:る|た|だ|よ|ね|の|かな|じゃん|ない|ないで|て|てね|てよ|くれる|くれ|ろ|け)[。．.!！?？」』）)]*$/u;
const KO_POLITE = /(?:요|니다|니까|시오|세요|십시오)[.?!…]*$/u;
const KO_PLAIN = /(?:어|아|야|지|래|니|냐|다|자|게|네|구나|군|걸|거든|까)[.?!…]*$/u;

/** Which registers a ja / ko text uses, by sentence ending. */
function endings(text: string, lang: string): { polite: boolean; plain: boolean } {
  const out = { polite: false, plain: false };
  // A dictated punctuation command (まる, 마침표) is not a sentence ending.
  // NR-262: the words come from the one command table
  // (stt-polish-guard-dictation-words.ts); this reading keeps its own right
  // boundary.
  const cmd = new RegExp(lang === 'ja'
    ? `\\s*(?:${sentenceEndCommandSource('ja')!})\\s*(?=[\\s。、.!?！？]|$)`
    : `\\s*(?:${sentenceEndCommandSource('ko')!})(?![\\p{L}])`, 'gu');
  for (const s of text.replace(cmd, '。').split(/(?<=[.!?。！？\n])/u).map((x) => x.replace(/[\p{P}\s]+$/u, '').trim())) {
    const letters = [...s].filter((c) => /\p{L}/u.test(c)).length;
    if (letters < 3) continue;
    if ((lang === 'ja' ? JA_POLITE : KO_POLITE).test(s)) out.polite = true;
    else if ((lang === 'ja' ? JA_PLAIN : KO_PLAIN).test(s)) out.plain = true;
  }
  return out;
}

/** ML-0 D4: the form of address or the politeness level changed. */
export function registerDrift(raw: string, polished: string, lang: string | undefined): boolean {
  if (lang === undefined) return false;
  if (lang === 'ja' || lang === 'ko') {
    const a = endings(raw, lang);
    const b = endings(polished, lang);
    return a.polite !== b.polite || a.plain !== b.plain;
  }
  const tv = T_V[lang];
  if (!tv) return false;
  const has = (text: string, k: 0 | 1): boolean => count(tv[k], text, lang, k === 1) > 0;
  return has(raw, 0) !== has(polished, 0) || has(raw, 1) !== has(polished, 1);
}
