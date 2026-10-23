// NR-245 (GUARD-2, 2026-10-13): Latin-script words must survive the polish.
//
// The §3.1 open-class budget counts a run of non-Han characters as ONE token
// (countMixedTokens in stt-polish-guard.ts), so a whole dropped English clause
// cost about as much as one changed Chinese character. Measured holes, both
// accepted under smooth:
//   · "... update the auth flow and also the billing webhook before Friday"
//     -> "... update the auth flow before Friday" (a task vanished);
//   · "把这个PR merge到main分支，然后deploy到staging" -> "把这个PR merge到main分支".
//
// Rule: every CONTENT word of the input (a Latin-script word of 3+ letters
// that is not a function word or a filler, see STOP) must still be in the
// output. A missing one is excused only when it was
//   (a) corrected in place: the same changed stretch of the output holds a
//       near spelling (meat -> meet) or another form of the word (deploy ->
//       deployed);
//   (b) joined or split (web hook -> webhook);
//   (c) replaced by a KNOWN term the input did not contain — the user's
//       declared terms plus the coding default list (coding-terms.ts, card
//       CTX-1) — e.g. "cube control" -> kubectl. This is also what lets
//       strict repair misheard jargon without this rule refusing it;
//   (d) inside a self-correction's reparandum: that exemption is not here, it
//       is the self-correction reading in stt-polish-guard.ts, which removes
//       the reparandum from the input before this rule ever sees it;
//   (e) R1: replaced in place by a word that sounds the same in the session
//       language (pool -> pull, Looks -> Logs, Dupin -> du pain), with the
//       limits listed in stt-polish-guard-soundalike.ts.
// Neither (a) nor (e) excuses a polar or negating prefix (import -> export,
// increase -> decrease, hire -> fire, legal -> illegal; polarPair): before R1
// those passed (a) as near spellings.
//
// Plural/singular (Delete the files -> Delete the file) is the same check with
// the word's form kept: a content word that only changed number is refused,
// unless the new form agrees with the determiner right before it (two file ->
// two files, a files -> a file), which is a grammar correction.
//
// Cost, stated: a correct smoothing that drops a content word the STOP list
// does not know is refused (under smooth it then falls back to one strict
// attempt). The lists cover English plus the French, Spanish and German
// function words; other Latin-script languages get the rule without a list.

import { dictationCommandRegExp } from './stt-polish-guard-dictation-words';
import { isLatinNumberWord } from './stt-polish-guard-numwords';
import { isLemmaWord } from './stt-polish-guard-lemmas';
import { contentSoundAlike, polarPair } from './stt-polish-guard-soundalike';

const NUMBER_WORD_LANGS: ReadonlySet<string> = new Set(['fr', 'es', 'de']);

const STOP_EN = `a an the this that these those there here then than thus so such and but or nor if else
because cause cuz since though although while whether also too either yet still just even ever again already
now really actually basically literally totally honestly seriously simply probably maybe perhaps like um uh umm
uhh erm hmm mm mhm ah oh okay ok yeah yep yes well right alright anyway anyways kind sort kinda sorta guess
think thinking mean know gonna wanna gotta going get got gets getting let lets thing things stuff something
anything everything nothing someone anyone everyone everybody somebody way lot lots bit pretty quite very much
many more less most least other another same own what which who whom whose when where why how whatever whenever
me my mine myself you your yours yourself he him his she her hers it its itself we us our ours ourselves they them
their theirs themselves is are was were be been being am have has had having do does did doing done will would
shall should can could may might must for from with without into onto over under about above below around
through throughout after before between among out off upon via per until till toward towards across along within
against during at by in of on to up down as all some any each every both few several not no never please one`;

const STOP_FR = `les des une est que qui quoi pour avec dans sur par mais donc alors euh heu hum bon ben voilà enfin bah nous vous
ils elles leur leurs son ses mes tes ces cette cet aux été être avoir fait comme très aussi puis ensuite c'est
j'ai il elle on pas ont sont était`;
const STOP_ES = `los las una unos unas que por para con pero pues bueno este esta eso esto entonces como muy también del sus
nos les está están son ser estar hay vale sea digamos tipo nada`;
const STOP_DE = `der die das den dem des ein eine einen einem einer und aber also halt eben mal doch ähm ist sind war
wir ihr sie ich mit für auf von zum zur dass wenn dann noch auch sehr schon irgendwie sozusagen nicht`;

// Words compared elsewhere: numbers (stt-polish-guard-numbers.ts) and the
// counted closed-class words (stt-polish-guard-closed-words.ts).
const COMPARED_ELSEWHERE = `zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen
fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred
thousand million billion always usually often sometimes rarely seldom occasionally frequently normally once twice
thrice first second third fourth fifth sixth seventh eighth ninth tenth half approximately roughly nearly almost`;

// A word the output wrote as a symbol was rewritten, not lost (review round):
// 5 euros -> €5, minus 5 -> -5, 30 degrees -> 30°, 5 percent -> 5%.
const WRITTEN_AS: Readonly<Record<string, string>> = {
  dollar: '$', euro: '€', pound: '£', percent: '%', degree: '°', minus: '-−', plus: '+',
  point: '.', at: '@', dot: '.', hashtag: '#',
};

function writtenAsSymbol(w: string, raw: string, polished: string): boolean {
  const symbols = WRITTEN_AS[w] ?? WRITTEN_AS[stem(w)];
  if (symbols === undefined) return false;
  const count = (s: string): number => [...s].filter((c) => symbols.includes(c)).length;
  return count(polished) > count(raw);
}

const STOP: ReadonlySet<string> = new Set(
  [STOP_EN, STOP_FR, STOP_ES, STOP_DE, COMPARED_ELSEWHERE].join(' ').split(/\s+/u).filter(Boolean),
);

const SINGULAR_DET = new Set(['a', 'an', 'one', '1', 'each', 'every', 'this', 'that', 'another', 'single']);
const PLURAL_DET = new Set(['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'these',
  'those', 'many', 'several', 'few', 'multiple', 'both', 'all', 'some', 'various', 'numerous', 'most']);

const TOKEN_RE = /\p{Script=Latin}[\p{Script=Latin}\p{M}'’]*|[0-9]+|[^\s\p{P}\p{S}]/gu;

interface Token {
  text: string;
  latin: boolean;
  /** R1: capital first letter / first word of a sentence
   *  (stt-polish-guard-soundalike.ts reads a capital as a name or a term). */
  title: boolean;
  sentenceStart: boolean;
}

// Dictated punctuation is a command, not content — but only where the output
// shows it was one (NR-262 R1): contentDrift blanks, in the input only, the
// command words stt-polish-guard-dictation.ts found converted to their symbol
// at their own place (DictationEdits.excused). Every other occurrence of a
// command word ("el punto final de la reunión", "Delete the new line", a
// "comma" dropped with no symbol) is compared like any other word. Before
// NR-262 this file blanked every match of its own hand-kept lists, so a noun
// swapped for another, or a command dropped, went unseen here.
// pluralDrift has no session language and still blanks every English match
// (SPOKEN_PUNCT_RE), as on main.
const SPOKEN_PUNCT_RE = dictationCommandRegExp('en')!;

function tokens(s: string, blankEnglish = true): Token[] {
  const blanked = blankEnglish ? s.replace(SPOKEN_PUNCT_RE, ' ') : s;
  return [...blanked.matchAll(TOKEN_RE)].map((m) => {
    const text = m[0].toLowerCase().replace(/’/gu, "'");
    const sentenceStart = /(?:^|[.!?:;。！？\n«»“"])[\s\p{Pi}\p{Ps}]*$/u.test(blanked.slice(0, m.index));
    return { text, latin: /^\p{Script=Latin}/u.test(text), title: /^\p{Lu}/u.test(m[0]), sentenceStart };
  });
}

/** The word a content check compares: possessive dropped, plural folded. */
function stem(w: string): string {
  const base = w.replace(/'s$/u, '');
  if (/ies$/u.test(base) && base.length > 4) return `${base.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/u.test(base) && base.length > 4) return base.slice(0, -2);
  if (/[^s]s$/u.test(base) && base.length > 3) return base.slice(0, -1);
  return base;
}

/** A Latin-script content word (lowercased input): 3+ letters, not a function
 *  word, filler, contraction or a word compared elsewhere. */
export function isLatinContentWord(w: string): boolean {
  return isContent(w);
}

function isContent(w: string): boolean {
  if (/'(?:t|re|ve|ll|d|m)$/u.test(w)) return false;
  const base = w.replace(/'s$/u, '');
  if ([...base].length < 3) return false;
  return !STOP.has(base) && !STOP.has(stem(base));
}

function editDistance(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[B.length]!;
}

function sameWordFamily(a: string, b: string): boolean {
  const longest = Math.max([...a].length, [...b].length);
  if (editDistance(a, b) <= Math.max(1, Math.floor(longest / 3))) return true;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  return p >= 4 && p >= 0.6 * Math.min(a.length, b.length);
}

interface Hunk { raw: number[]; pol: number[] }

/** Word-level LCS: the stretches of tokens that changed, as index lists. */
function hunks(a: readonly Token[], b: readonly Token[]): { hunks: Hunk[]; rawHunk: Map<number, Hunk> } {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i]!.text === b[j]!.text ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Hunk[] = [];
  const rawHunk = new Map<number, Hunk>();
  let cur: Hunk | null = null;
  let i = 0;
  let j = 0;
  const open = (): Hunk => { cur ??= { raw: [], pol: [] }; return cur; };
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.text === b[j]!.text) {
      if (cur) { out.push(cur); cur = null; }
      i += 1; j += 1;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      open().pol.push(j); j += 1;
    } else {
      const h = open(); h.raw.push(i); rawHunk.set(i, h); i += 1;
    }
  }
  if (cur) out.push(cur);
  return { hunks: out, rawHunk };
}

function introducedTerms(raw: string, polished: string, terms: readonly string[]): string[] {
  const r = raw.toLowerCase();
  const p = polished.toLowerCase();
  const out: string[] = [];
  for (const t of terms) {
    const term = t.trim().toLowerCase();
    if (term.length === 0 || r.includes(term) || !p.includes(term)) continue;
    out.push(term);
  }
  return out;
}

function counts(ts: readonly Token[], key: (w: string) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of ts) if (t.latin && isContent(t.text)) out.set(key(t.text), (out.get(key(t.text)) ?? 0) + 1);
  return out;
}

/** A content word that changed only in grammatical number, or null. */
export function pluralDrift(raw: string, polished: string): string | null {
  const a = tokens(raw);
  const b = tokens(polished);
  const ra = counts(a, (w) => w);
  const rb = counts(b, (w) => w);
  for (const [form, n] of ra) {
    if ((rb.get(form) ?? 0) >= n) continue;
    for (const [other, k] of rb) {
      if (other === form || stem(other) !== stem(form) || (ra.get(other) ?? 0) >= k) continue;
      // The new form agrees with the determiner just before it: a grammar fix.
      const at = b.findIndex((t) => t.text === other);
      const det = at > 0 ? b[at - 1]!.text : '';
      const plural = stem(other) !== other;
      const agrees = plural ? (PLURAL_DET.has(det) || (/^[0-9]+$/u.test(det) && det !== '1')) : SINGULAR_DET.has(det);
      if (!agrees) return form;
    }
  }
  return null;
}

/** The first content word of `raw` missing from `polished` without an excuse, or null. */
export function contentDrift(
  rawIn: string,
  polishedIn: string,
  terms: readonly string[],
  lang?: string,
  excused: readonly (readonly [number, number])[] = [],
): string | null {
  let raw = rawIn;
  for (const [at, end] of excused) raw = raw.slice(0, at) + ' '.repeat(end - at) + raw.slice(end);
  const polished = polishedIn;
  // ML-1: in a French / Spanish / German session a number word is compared by
  // value by the numbers gate (quinientos -> 500 is a rewrite, not a lost word).
  // "halb drei" is read as the time 2:30 (stt-polish-guard-numwords.ts).
  // A negation / modal / quantifier of the session language is compared by
  // lemma class (stt-polish-guard-lemmas.ts): on devrait -> nous devrions is
  // one modal in another person, not a lost word.
  const numberWord = (w: string): boolean => lang !== undefined && NUMBER_WORD_LANGS.has(lang)
    && (isLatinNumberWord(w) || (lang === 'de' && w === 'halb') || isLemmaWord(w, lang));
  const a = tokens(raw, false);
  const b = tokens(polished, false);
  const ra = counts(a, stem);
  const rb = counts(b, stem);
  const deficit = new Map<string, number>();
  for (const [w, n] of ra) if (n > (rb.get(w) ?? 0)) deficit.set(w, n - (rb.get(w) ?? 0));
  if (deficit.size === 0) return null;

  const { rawHunk } = hunks(a, b);
  const introduced = introducedTerms(raw, polished, terms);
  const unexcused = new Map<string, number>();
  for (const [i, h] of rawHunk) {
    const w = a[i]!.text;
    if (!a[i]!.latin || !isContent(w) || !deficit.has(stem(w)) || numberWord(w)) continue;
    const polWords = h.pol.map((j) => b[j]!.text);
    const rawWords = h.raw.map((k) => a[k]!.text);
    const at = h.raw.indexOf(i);
    // R1: a near spelling that flips polarity is not a correction (import ->
    // export, include -> exclude, hire -> fire, legal -> illegal).
    const corrected = polWords.some((u) => /^\p{Script=Latin}/u.test(u) && sameWordFamily(stem(w), stem(u))
      && !polarPair(w, u));
    const joined = (at + 1 < rawWords.length && polWords.includes(w + rawWords[at + 1]))
      || (at > 0 && polWords.includes(rawWords[at - 1] + w))
      || polWords.some((u, k) => k + 1 < polWords.length && u + polWords[k + 1] === w);
    const polText = polWords.join(' ');
    const rawLetters = rawWords.join('').length;
    // The term must look like what it replaced (cube control -> kubectl,
    // lock store -> Rockstore): a coding term is not a licence to swap
    // "billing" for "Docker". 0.4, not 0.6 (review round): at 0.6, 34 of 35
    // real words passed for a term (cloud -> Claude, angle -> Angular).
    const rawSpelling = rawWords.filter((x) => /^\p{Script=Latin}/u.test(x)).join('');
    const byTerm = introduced.some((t) => {
      const spelling = t.replace(/[^\p{L}\p{N}]/gu, '');
      return (polText.includes(t) || polWords.join('').includes(spelling))
        && rawLetters <= 3 * t.length + 3
        && editDistance(rawSpelling, spelling) <= Math.ceil(0.4 * Math.max(rawSpelling.length, spelling.length));
    });
    // A misheard Han word transcribed as one Latin word (Jung -> 用): the
    // output replaced it with a few Han characters in the same place.
    const polHan = h.pol.filter((j) => /^\p{Script=Han}$/u.test(b[j]!.text)).length;
    const rawContent = h.raw.filter((k) => a[k]!.latin && isContent(a[k]!.text)).length;
    const crossScript = rawContent === 1 && polHan > 0 && polHan <= 3;
    const symbol = writtenAsSymbol(w, raw, polished);
    // R1: a misheard word replaced in place by one that sounds the same in the
    // session language (pool -> pull, Looks -> Logs, Dupin -> du pain). Only
    // when it is the stretch's one content word; the guards that keep
    // antonyms, names, numbers and negations out are in the module.
    const soundAlike = rawContent === 1 && contentSoundAlike(
      a[i]!,
      h.pol.filter((j) => b[j]!.latin).map((j) => b[j]!),
      lang,
      stem,
      (x) => isContent(x) && !numberWord(x) && !isLatinNumberWord(x),
    );
    if (corrected || joined || byTerm || crossScript || symbol || soundAlike) continue;
    unexcused.set(stem(w), (unexcused.get(stem(w)) ?? 0) + 1);
  }
  for (const [w, n] of deficit) if (Math.min(n, unexcused.get(w) ?? 0) > 0) return w;
  return null;
}

/** Where, in `polished`, each known term the output introduced sits (UTF-16
 *  offsets, case-insensitive). Used by the §3.1 open-class count. */
export function introducedTermSpans(raw: string, polished: string, terms: readonly string[]): [number, number][] {
  const p = polished.toLowerCase();
  const spans: [number, number][] = [];
  for (const term of introducedTerms(raw, polished, terms)) {
    for (let at = p.indexOf(term); at >= 0; at = p.indexOf(term, at + term.length)) spans.push([at, at + term.length]);
  }
  return spans;
}
