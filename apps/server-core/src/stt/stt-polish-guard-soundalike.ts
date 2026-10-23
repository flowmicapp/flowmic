// R1 (2026-10-14): a dropped content word is excused when the word that took
// its place SOUNDS the same in the session language.
//
// Why: the NR-245 content rule (stt-polish-guard-content.ts) excuses only a
// near SPELLING or a known term, so correct repairs of misheard words were
// refused: "pool request" -> "pull request", "die Looks in Grafana" -> "die
// Logs", "los blocks" -> "los blogs", "Dupin." -> "Du pain." (PRE-0.3.111
// relay A/B of 2026-10-13, follow-up R1).
//
// The key is a consonant skeleton built with ONE language's spelling rules,
// applied to both words (never one word in French and the other in English):
// the first letter is kept as written (so accept / except, import / export,
// include / exclude, increase / decrease, hire / fire stay apart), the
// language's digraphs, soft g and silent letters are folded, and in German and
// Spanish only a final b/d/g is read as p/t/k (both devoice it: Blog ~ Block).
// English and French keep b/d/g voiced: with devoicing, log -> lock, bug ->
// book and page -> pack passed in review.
//
// The skeleton alone is not enough (review, 2026-10-14: love -> leave, hit ->
// hate, take -> took, paid -> put, coupé -> copié, matar -> meter all share
// one). The vowels must agree too, one nucleus for one nucleus: identical, or
// a pair from VOWEL_EQUIV (oo ~ u, oo ~ o in all four languages; in French
// ai / ei ~ i and au / eau ~ o); a silent final e is ignored in en / fr.
//
// The excuse is narrower than "sounds alike" (contentSoundAlike, below):
//   · one language: en / fr / de / es only — an unknown session gets nothing;
//   · same place: the changed stretch holds exactly ONE content word of the
//     input, and the replacement is one word there, or two adjacent words
//     read together (Dupin -> du pain);
//   · the replacement is itself a content word: never a number word, a
//     negation, a modal or a quantifier (those are compared by the closed-class
//     gates, and a sound-alike is no excuse for changing one);
//   · same grammatical number (look -> logs is refused: number is content);
//   · no polar prefix swap with the same consonants: pre/pro/per, inter/intra,
//     ante/anti, de/di/dis, ver/vor (prescribe -> proscribe, defuse -> diffuse);
//   · outside German, no capitalised word mid-sentence on either side: it is a
//     name or a term (cloud -> Claude, Mike -> mic, Logs -> looks), and those
//     go through the known-term rule only;
//   · no name swap at the start of a sentence either (Rhys -> Reese); in
//     German, where every noun is capitalised, a capitalised pair is excused
//     only when both are plural nouns (die Looks -> die Logs; Meier -> Mayer
//     is refused).
//
// Cost, stated (measured on the review sets, 2026-10-14): what this excuse
// still accepts is a word for another with the same consonants AND the same
// vowels under the table above. In English that is the oo ~ u / oo ~ o pairs
// (pool -> pull, but also fool -> full, boot -> but) and exact homophones
// (brakes -> breaks, sale -> sail). German and Spanish add final devoicing
// (Blog ~ Block, Rad ~ Rat). Sound-alike German plural nouns are not told apart
// from repairs. English misheard plurals that only devoicing would explain
// (looks -> logs, blocks -> blogs) are refused, a lost repair.

export const SOUNDALIKE_LANGS: ReadonlySet<string> = new Set(['en', 'fr', 'de', 'es']);

function fold(word: string, lang: string): string {
  let s = word.toLowerCase();
  if (lang === 'fr') s = s.replace(/^(?:qu|[cdjlmnst])['’]/u, '').replace(/ç/gu, 's');
  if (lang === 'de') s = s.replace(/ß/gu, 'ss');
  if (lang === 'es') s = s.replace(/ñ/gu, 'n');
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z]/gu, '');
}

function spell(s: string, lang: string): string {
  switch (lang) {
    case 'fr':
      return s.replace(/ph/gu, 'f').replace(/(?:sc|s)?ch/gu, 'X').replace(/sh/gu, 'X').replace(/qu/gu, 'k')
        .replace(/g(?=[eiy])/gu, 'j').replace(/gu(?=[eiy])/gu, 'g').replace(/c(?=[eiy])/gu, 's').replace(/c/gu, 'k').replace(/x/gu, 'ks')
        .replace(/h/gu, '').replace(/(?<=..)[stdxzp]+$/u, '');
    case 'de':
      return s.replace(/t?sch/gu, 'X').replace(/ch/gu, 'X').replace(/ck/gu, 'k').replace(/ph/gu, 'f')
        .replace(/qu/gu, 'kv').replace(/th/gu, 't').replace(/dt/gu, 't').replace(/v/gu, 'f').replace(/w/gu, 'v')
        .replace(/c/gu, 'k').replace(/(?<=.)h/gu, '');
    case 'es':
      return s.replace(/ll/gu, 'y').replace(/qu/gu, 'k').replace(/c(?=[ei])/gu, 's').replace(/z/gu, 's')
        .replace(/c/gu, 'k').replace(/g(?=[ei])/gu, 'j').replace(/x/gu, 'ks').replace(/v/gu, 'b').replace(/h/gu, '');
    default:
      return s.replace(/^wr/u, 'r').replace(/^kn/u, 'n').replace(/^ps/u, 's').replace(/ph/gu, 'f')
        .replace(/t?ch/gu, 'X').replace(/sh/gu, 'X').replace(/th/gu, '0').replace(/ck/gu, 'k').replace(/d?g(?=[eiy])/gu, 'j')
        .replace(/c(?=[eiy])/gu, 's').replace(/c/gu, 'k').replace(/q/gu, 'k').replace(/x/gu, 'ks')
        .replace(/gh/gu, '').replace(/(?<=.)[hw]/gu, '');
  }
}

/** The consonant skeleton of `word` under `lang`'s spelling rules; `devoice` reads a
 *  final b/d/g as p/t/k (German and Spanish only). */
export function soundKey(word: string, lang: string, devoice = false): string {
  const s = spell(fold(word, lang), lang);
  if (s.length === 0) return '';
  const head = s[0]!;
  const tail = s.slice(1).replace(/[aeiouy]/gu, '');
  const key = (head + tail).replace(/(.)\1+/gu, '$1');
  return devoice && (lang === 'de' || lang === 'es') ? key.replace(/[bdg]$/u, (c) => ({ b: 'p', d: 't', g: 'k' })[c]!) : key;
}

const VOWEL_EQUIV: Readonly<Record<string, readonly string[]>> = {
  en: ['oo|u', 'oo|o'],
  de: ['oo|u', 'oo|o'],
  es: ['oo|u', 'oo|o'],
  fr: ['oo|u', 'oo|o', 'ai|i', 'ei|i', 'ai|ei', 'au|o', 'eau|o', 'au|eau'],
};

/** The vowel nuclei of `word` in order (silent final e dropped in en / fr). */
export function vowelNuclei(word: string, lang: string): string[] {
  let s = fold(word, lang).replace(/qu/gu, 'k');
  if (lang === 'en') s = s.replace(/gh/gu, '').replace(/(?<=[^aeiouy])e$/u, '');
  if (lang === 'fr') s = s.replace(/gu(?=[eiy])/gu, 'g').replace(/(?<=..)[stdxzp]+$/u, '').replace(/(?<=[^aeiouy])e$/u, '');
  if (lang === 'es') s = s.replace(/gu(?=[ei])/gu, 'g');
  return s.match(/[aeiouy]+/gu) ?? [];
}

function vowelsAgree(a: string, b: string, lang: string): boolean {
  const x = vowelNuclei(a, lang);
  const y = vowelNuclei(b, lang);
  const eq = VOWEL_EQUIV[lang] ?? [];
  return x.length === y.length && x.every((v, k) => v === y[k] || eq.includes(`${v}|${y[k]}`) || eq.includes(`${y[k]}|${v}`));
}

// Two words that share a stem and differ only in a polar or negating prefix
// say opposite things however alike they sound or are spelled. Read on the
// part before the longest shared ending: import / export -> im | ex,
// increase / decrease -> in | de, lock / unlock -> '' | un, hire / fire -> h | f.
const POLAR_HEADS: ReadonlySet<string> = new Set([
  'im|ex', 'in|ex', 'in|out', 'in|de', 'en|de', 'en|dis', 'ac|ex', 'af|ef', 'as|des', 'up|down', 'max|min',
  'over|under', 'inter|intra', 'pre|pro', 'pre|post', 'pre|per', 'hyper|hypo', 'ante|anti', 'de|di', 'de|dif',
  'ver|vor', 'ein|aus', 'auf|ab', 'an|ab', 'h|f', 'at|de', 'ac|de', 'in|e', 'e|im', 'em|imm', 'maj|min',
  'zu|auf', 'an|aus',
].flatMap((p) => { const [x, y] = p.split('|'); return [`${x}|${y}`, `${y}|${x}`]; }));
const NEGATING_PREFIXES: ReadonlySet<string> = new Set([
  'un', 'in', 'im', 'il', 'ir', 'dis', 'non', 'de', 'des', 'mis', 'anti', 'miss', 'ent', 'mal', 'me', 'i',
]);
// Prefix families where the shared ending is too short to find (precede /
// proceed, prescribe / proscribe).
const POLAR_PREFIX_GROUPS: readonly (readonly string[])[] = [
  ['pre', 'pro', 'per'], ['inter', 'intra'], ['ante', 'anti'], ['ver', 'vor'], ['hyper', 'hypo'],
];

/** Do `a` and `b` (lowercase) differ by a polar or negating prefix? */
export function polarPair(a0: string, b0: string): boolean {
  const a = a0.normalize('NFD').replace(/\p{M}/gu, '');
  const b = b0.normalize('NFD').replace(/\p{M}/gu, '');
  if (a === b) return false;
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k += 1;
  // Every split of the shared ending, not only the longest: ascend / descend
  // share "scend", but the prefixes are as | des.
  for (let j = 3; j <= k; j++) if (POLAR_HEADS.has(`${a.slice(0, a.length - j)}|${b.slice(0, b.length - j)}`)) return true;
  const ha = a.slice(0, a.length - k);
  const hb = b.slice(0, b.length - k);
  if (k >= 4 && (ha === '' || hb === '') && NEGATING_PREFIXES.has(ha || hb)) return true;
  return POLAR_PREFIX_GROUPS.some((g) => {
    const pa = g.find((p) => a.startsWith(p));
    const pb = g.find((p) => b.startsWith(p));
    return pa !== undefined && pb !== undefined && pa !== pb;
  });
}

const SPLIT_ARTICLES: ReadonlySet<string> = new Set(['a', 'an', 'the', 'du', 'de', 'des', 'le', 'la', 'les', 'un',
  'une', 'au', 'aux', 'der', 'die', 'das', 'den', 'dem', 'ein', 'eine', 'el', 'los', 'las', 'del', 'al', 'una']);

export interface SoundWord {
  /** Lowercased word, as the content rule compares it. */
  text: string;
  /** Written with a capital first letter (Title case or all capitals). */
  title: boolean;
  /** First word of a sentence, where a capital says nothing. */
  sentenceStart: boolean;
}

/**
 * Is `dropped` excused by a sound-alike in `replacements` (the output words of
 * the same changed stretch, in order)? The caller has already established
 * that `dropped` is the only content word of the input in that stretch.
 */
export function contentSoundAlike(
  dropped: SoundWord,
  replacements: readonly SoundWord[],
  lang: string | undefined,
  stem: (w: string) => string,
  isContentWord: (w: string) => boolean,
): boolean {
  if (lang === undefined || !SOUNDALIKE_LANGS.has(lang)) return false;
  const want = soundKey(stem(dropped.text), lang);
  if (want.replace(/^[aeiouy]/u, '').length < 2) return false;
  const plural = (x: string): boolean => stem(x) !== x.replace(/'s$/u, '');
  const candidates = [
    ...replacements.map((r) => [r]),
    ...replacements.slice(1).map((r, k) => [replacements[k]!, r]),
  ];
  return candidates.some((parts) => {
    const words = parts.map((p) => p.text);
    const last = words[words.length - 1]!;
    // A split may add an article (Dupin -> du pain), never a negation:
    // notable -> not able is refused.
    if (!words.some(isContentWord) || !words.every((p) => isContentWord(p) || SPLIT_ARTICLES.has(p))) return false;
    // A name or term mid-sentence, on either side (cloud -> Claude, Mike ->
    // mic). German capitalises nouns, so there only a capital written in for
    // a lowercase word counts.
    const midCap = (p: SoundWord): boolean => p.title && !p.sentenceStart;
    if (lang !== 'de' && (midCap(dropped) || parts.some(midCap))) return false;
    if (parts.some(midCap) && !dropped.title) return false;
    // A name for a name, also at the start of a sentence (Rhys -> Reese).
    // German capitalises every noun: there both must be plural nouns (die
    // Looks -> die Logs); a German name is singular (Meier -> Mayer).
    const nameLike = parts.length === 1 || parts.every((p) => p.title);
    if (dropped.title && nameLike && parts[0]!.title
      && !(lang === 'de' && plural(dropped.text) && plural(last))) return false;
    if (plural(dropped.text) !== plural(last)) return false;
    if (polarPair(fold(dropped.text, lang), fold(words.join(''), lang))) return false;
    const spoken = words.slice(0, -1).join('') + stem(last);
    // Devoicing runs one way: the recogniser writes the voiceless sound it
    // heard (Blocks), the word meant may be spelled voiced (Blogs); a voiced
    // spelling turned voiceless (Bugs -> Bucks) is not a repair.
    const key = soundKey(spoken, lang);
    return (key === want || soundKey(spoken, lang, true) === want) && vowelsAgree(stem(dropped.text), spoken, lang);
  });
}
