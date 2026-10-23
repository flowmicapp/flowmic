// ML-2 (2026-10-14): dictated punctuation and layout commands.
//
// A speaker who says "comma", "virgule", "Punkt", "てん", "마침표" or "новая
// строка" as a command wants the symbol or the line break, not the word. Both
// polish prompts now ask for that (stt-polish-prompts.ts RULE_DICTATED_PUNCT).
// This file is the guard's half:
//
//   · a command word replaced by its symbol is NEUTRAL. Its characters and
//     its words are discounted from the §3.1 budget the way number words
//     rewritten as digits are (stt-polish-guard.ts numberAllowance), so Strict's
//     fixed edit budget no longer refuses a correct conversion (ML-1 known
//     costs ml0-fr-21 / de-21 / es-21 / ru-21);
//   · a command word may NEVER disappear without its symbol appearing:
//     "줄바꿈" dropped with no line break in the output is refused
//     (ML-0 ko-pun-01 ref/smooth was accepted that way before this file);
//   · a use of the word that reads as part of the sentence ("the period
//     ended", "le point important", "der Punkt ist", "точка зрения", "이
//     마침표") is content. Losing one of those is refused, whatever symbol
//     appears.
//
// Chinese is out of scope (MAIN 2026-10-13: Chinese speakers rarely dictate
// punctuation and the false-positive risk is high), so 'zh' has no table.
// EVERY session also reads the English table, after its own (MAIN 2026-10-14,
// NR-262; commandLanguages in stt-polish-guard-dictation-words.ts).
// NR-262 R1: a command word is excused from the content check only where the
// output has its symbol at its own place (DictationEdits.excused); anywhere
// else the content check compares it as an ordinary word, so "the end quote"
// dropped from a French or Chinese session is a lost word there. An English
// command word that is an ordinary word of the session language is not read
// there at all (ENGLISH_HOMOGRAPHS: de Quote, es/fr colon, it quote / comma /
// colon), so "Colon" -> "Colón" or "die Quote?" is judged like any other word.
// Cost, stated: one meant as the English command in that session ("Voici la
// liste colon du pain" -> "la liste : du pain") is refused; main accepted it,
// because main's content check blanked every English command word.
//
// What this cannot see: WHERE a symbol landed. A dropped command is balanced
// by any new symbol of its class anywhere in the output. Symbols that sat right
// next to a command in the input (Soniox often writes "fertig, Punkt" or
// "Fragezeichen.") are not counted as already present, because the model
// correctly folds them into the converted one.

import { ENGLISH_HOMOGRAPHS, commandLanguages, commandPiece, normalizeSurface, sessionCommands, type SymClass } from './stt-polish-guard-dictation-words';
import { wordNumbers } from './stt-polish-guard-numwords';
import { baseLanguage } from './stt-polish-guard-lang';

const SYM: Readonly<Record<SymClass, RegExp>> = {
  comma: /[,，、]/gu,
  period: /[.。．]/gu,
  question: /[?？¿]/gu,
  exclaim: /[!！¡]/gu,
  colon: /[:：]/gu,
  semicolon: /[;；]/gu,
  // Every character a desktop types as Enter or a text field reads as a new
  // line: CR LF, a lone CR, LF, U+2028, U+2029, U+0085 (ML-2 review).
  newline: /\r\n|[\r\n\u2028\u2029\u0085]/gu,
  quote: /["“”„«»「」『』]/gu,
  paren_open: /[(（]/gu,
  paren_close: /[)）]/gu,
  dash: /[-‐–—]/gu,
  ellipsis: /…|\.\.\./gu,
};

// The command words themselves, per language, live in
// stt-polish-guard-dictation-words.ts (NR-262: one list for every reader).
// Which tables a session reads (its own, then English) is commandLanguages()
// there, the same answer the content check blanks with.

// A word right before the command that makes it a noun of the sentence:
// "the period", "put a comma", "le point", "der Punkt", "en punto",
// "ключевая точка", "이 마침표", "この句点".
const CONTENT_BEFORE: Readonly<Record<string, RegExp>> = {
  en: /(?:^|[^\p{L}])(?:the|a|an|this|that|these|those|each|every|another|one|no|any|my|your|his|her|its|our|their|which|what|whose|extra|missing|single|put|add|insert|type|place|use|remove|delete|big|small|huge|little|long|short|grace|trial|notice|waiting|billing|cooling|holiday|reporting|time|final|whole|entire|same)\s+$/iu,
  fr: /(?:(?:^|[^\p{L}])(?:le|la|les|un|une|ce|cet|cette|ces|du|des|au|aux|chaque|quel|quelle|mon|ma|ton|ta|son|sa|notre|votre|leur|en|à|de|une)\s+|(?:^|[^\p{L}])l['’]\s*)$/iu,
  de: /(?:^|[^\p{L}])(?:der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines|kein|keine|keinen|keinem|jeder|jedes|jedem|jeden|dieser|dieses|diesem|diesen|mein|meinen|dein|sein|ihr|unser|euer|welcher|welches|zum|zur|beim|am|im|vom|um|bis|auf|ohne)\s+$/iu,
  es: /(?:^|[^\p{L}])(?:el|la|los|las|un|una|unos|unas|este|esta|ese|esa|aquel|aquella|cada|mi|tu|su|del|al|en|a|ningún|ninguna|otro|otra|qué|cuál|poner|pon|añadir|añade|falta)\s+$/iu,
  ru: /(?:(?:^|[^\p{L}])(?:эта|та|эту|каждая|одна|моя|твоя|наша|ваша|его|её|ее|их|какая|такая|ни|без|любая)|\p{L}{2,}(?:ая|яя|ую))\s+$/iu,
  ko: /(?:^|[^\p{L}])(?:이|그|저|이런|그런|저런|어떤|한|두|모든|이번)\s+$/u,
  ja: /(?:この|その|あの|どの|の)$/u,
};

// A word right after that makes it a noun: "точка зрения", "punto de vista",
// "point de vue", "Punkt acht".
const CONTENT_AFTER: Readonly<Record<string, RegExp>> = {
  // ML-2 review: "Grace period ends today", "a question mark over the budget".
  en: /^\s+(?:of|ends|ended|ending|starts|started|begins|lasts|lasted|is|was|will|has|had|over|hangs|remains)(?![\p{L}])/iu,
  fr: /^\s+(?:d['’]avance|d['’]écart|de\s+(?:plus|moins|suite|retard)|de\s+vue|de\s+départ|d['’]accès|commun|fort|faible|important|essentiel|clé)(?![\p{L}])/iu,
  de: /^\s+(?:\d|acht|neun|zehn|elf|zwölf|eins|zwei|drei|vier|fünf|sechs|sieben|Uhr)(?![\p{L}])/iu,
  es: /^\s+(?:más|menos|de\s+(?:ventaja|diferencia)|de\s+vista|de\s+partida|de\s+acceso|clave|fuerte|débil|importante)(?![\p{L}])/iu,
  ru: /^\s+(?:зрения|отсч[её]та|опоры|доступа|роста|кипения|невозврата|пересечения|соприкосновения)(?![\p{L}])/iu,
};

// `surface`: the words as said, folded (normalizeSurface). Input and output are
// compared by surface, not by kind (NR-262 review): "open quote" -> "close
// quote" or "punto final" -> "punto" keeps the kind and changes the words.
interface Hit { kind: SymClass; lang: string; surface: string; at: number; end: number; use: 'command' | 'content' | 'number'; numeric?: boolean; added?: boolean; demoted?: boolean }

interface Matchers { bare: RegExp; cmd: RegExp; kinds: SymClass[]; langs: string[]; numeric: boolean[]; added: boolean[] }

const RE_CACHE = new Map<string, Matchers>();
function matchers(language: string | undefined): Matchers {
  const key = commandLanguages(language).join('+');
  const cached = RE_CACHE.get(key);
  if (cached) return cached;
  const table = sessionCommands(language);
  const build = (form: 'command' | 'bare'): RegExp =>
    new RegExp(table.map((c) => `(${commandPiece(c, form)})`).join('|'), 'giu');
  const built: Matchers = {
    cmd: build('command'),
    bare: build('bare'),
    kinds: table.map((c) => c.kind),
    langs: table.map((c) => c.lang),
    numeric: table.map((c) => c.numeric === true),
    added: table.map((c) => c.added === true),
  };
  RE_CACHE.set(key, built);
  return built;
}

interface Converted { h: Hit; spanAt: number; spanEnd: number }

// NR-262 final decision (MAIN 2026-10-14): an `added` phrase is excused only as
// one half of a converted open / close PAIR — the opening and the matching
// closing command both said, in that order, both converted, and the symbols
// they became enclosing the same words the commands enclosed. "Der Server
// Klammer auf Staging Klammer zu ist bereit" -> "Der Server (Staging) ist
// bereit" passes; "Leg Klammer auf den Tisch" -> "Leg ( den Tisch." has no pair.
const OPEN_SYMBOL: Readonly<Partial<Record<SymClass, RegExp>>> = { quote: /["“„«「『]/u, paren_open: /[(（]/u };
const CLOSE_SYMBOL: Readonly<Partial<Record<SymClass, RegExp>>> = { quote: /["”“»」』]/u, paren_close: /[)）]/u };

/** 'open' / 'close' for a bracket or quote command, by kind or by its words;
 *  a bare de "Anführungszeichen" alternates. */
function role(h: Hit, quotesBefore: number): 'open' | 'close' | null {
  if (h.kind === 'paren_open') return 'open';
  if (h.kind === 'paren_close') return 'close';
  if (h.kind !== 'quote') return null;
  if (/^(?:end|close) quote$|^unquote$|^ferm|^cerr|^cier|^закр|(?:oben|zu)$/u.test(h.surface)) return 'close';
  if (/^(?:begin|open) quote$|^quote$|^ouvr|^abr|^откр|(?:unten|auf)$/u.test(h.surface)) return 'open';
  if (h.surface === 'anfuhrungszeichen') return quotesBefore % 2 === 0 ? 'open' : 'close';
  return null;
}

const wordSeq = (s: string): string => (s.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');

function pairedExcusal(converted: readonly Converted[], raw: string, polished: string): Set<Hit> {
  const out = new Set<Hit>();
  const list = [...converted].sort((a, b) => a.h.at - b.h.at);
  const roles = new Map<Hit, 'open' | 'close' | null>();
  let quotes = 0;
  for (const c of list) {
    roles.set(c.h, role(c.h, quotes));
    if (c.h.kind === 'quote') quotes += 1;
  }
  for (const [i, o] of list.entries()) {
    if (roles.get(o.h) !== 'open') continue;
    const closeKind: SymClass = o.h.kind === 'quote' ? 'quote' : 'paren_close';
    const c = list.slice(i + 1).find((x) => roles.get(x.h) === 'close' && x.h.kind === closeKind);
    if (!c || (o.h.added !== true && c.h.added !== true)) continue;
    const openRe = OPEN_SYMBOL[o.h.kind]!;
    const closeRe = CLOSE_SYMBOL[closeKind]!;
    let oi = -1;
    for (let k = o.spanAt; k < o.spanEnd; k += 1) if (openRe.test(polished[k]!)) { oi = k; break; }
    let ci = -1;
    for (let k = c.spanEnd - 1; k >= c.spanAt; k -= 1) if (closeRe.test(polished[k]!)) { ci = k; break; }
    if (oi < 0 || ci <= oi) continue;
    // The words between the commands, with any other converted command inside
    // cut out, are the words between the symbols.
    let inner = raw.slice(o.h.end, c.h.at);
    for (const x of list) {
      if (x.h.at >= o.h.end && x.h.end <= c.h.at) inner = inner.slice(0, x.h.at - o.h.end) + ' '.repeat(x.h.end - x.h.at) + inner.slice(x.h.end - o.h.end);
    }
    if (wordSeq(inner) !== wordSeq(polished.slice(oi + 1, ci))) continue;
    out.add(o.h);
    out.add(c.h);
  }
  return out;
}

const CLOSING_QUOTE: ReadonlySet<string> = new Set(['end quote', 'close quote', 'unquote']);
const OPENING_QUOTE: ReadonlySet<string> = new Set(['quote', 'open quote', 'begin quote']);

/** A quotation is open, and not yet closed, before here (NR-262 R6): opening
 *  marks and opening quote commands, less closing ones; a straight " toggles. */
function quoteOpened(before: string, earlier: readonly Hit[]): boolean {
  let open = (before.match(/[“„«「『]/gu)?.length ?? 0) - (before.match(/[”»」』]/gu)?.length ?? 0);
  if ((before.match(/"/gu)?.length ?? 0) % 2 === 1) open += 1;
  for (const h of earlier) {
    if (h.kind !== 'quote' || h.use !== 'command') continue;
    if (OPENING_QUOTE.has(h.surface)) open += 1;
    else if (CLOSING_QUOTE.has(h.surface)) open -= 1;
  }
  return open > 0;
}

/** Every occurrence of a command word, each read as a command, a noun of the
 *  sentence, or a decimal mark. */
function hits(text: string, language: string | undefined): Hit[] {
  const m = matchers(language);
  const commandAt = new Set([...text.matchAll(m.cmd)].map((x) => x.index));
  // A comma or point between two numbers is a decimal mark (trois virgule
  // cinq, drei Komma fünf): the numbers gate owns it, this file ignores it.
  const numsByLang = new Map<string, ReturnType<typeof wordNumbers>>();
  const numberAt = (i: number, dir: -1 | 1, lang: string): boolean => {
    let nums = numsByLang.get(lang);
    if (nums === undefined) { nums = wordNumbers(text, lang); numsByLang.set(lang, nums); }
    const side = dir < 0 ? text.slice(0, i).trimEnd() : text.slice(i).trimStart();
    if (dir < 0 ? /\d$/u.test(side) : /^\d/u.test(side)) return true;
    const pos = dir < 0 ? side.length : text.length - side.length;
    return nums.some((n) => (dir < 0 ? n.end === pos : n.at === pos));
  };
  const session = language ?? 'en';
  const homographs = ENGLISH_HOMOGRAPHS[session] ?? [];
  const out: Hit[] = [];
  for (const x of text.matchAll(m.bare)) {
    const g = x.slice(1).findIndex((v) => v !== undefined);
    const kind = m.kinds[g]!;
    const lang = m.langs[g]!;
    const surface = normalizeSurface(x[0]);
    const at = x.index;
    const end = at + x[0].length;
    // An English command that is an ordinary word of the session language is
    // not read at all (ENGLISH_HOMOGRAPHS) — except between two numbers, where
    // only the command makes sense ("à 4 colon 30" is 4:30).
    if (lang === 'en' && homographs.includes(surface) && !(numberAt(at, -1, lang) && numberAt(end, 1, lang))) continue;
    const before = text.slice(0, at);
    const nounMarked = CONTENT_BEFORE[lang]?.test(before) === true;
    let use: Hit['use'] = 'command';
    // Set when one of the NR-262 readings (not main's noun markers) makes a
    // command phrase a word of the sentence.
    let demoted = false;
    if ((kind === 'comma' || kind === 'period') && numberAt(at, -1, lang) && numberAt(end, 1, lang)) use = 'number';
    else if (!commandAt.has(at) || nounMarked || CONTENT_AFTER[lang]?.test(text.slice(end))) use = 'content';
    // en: a closing quote command with no quotation opened before it is the
    // word ("Send end quote by Friday" is the final price; round 2).
    else if (lang === 'en' && kind === 'quote' && CLOSING_QUOTE.has(surface) && !quoteOpened(before, out)) { use = 'content'; demoted = true; }
    out.push({ kind, lang, surface, at, end, use, numeric: m.numeric[g] === true, added: m.added[g] === true, demoted });
  }
  // ML-2 review: "Ganamos por dos puntos", "Le CAC a perdu deux points hier"
  // are numbers. A command that starts with a number word is read as a command
  // only at a clause start or when another command follows it in the same
  // sentence (the dictated list: "Liste des courses deux points du pain
  // virgule ..."). Otherwise it is a noun phrase: its number stays under the
  // numbers gate, and losing it is a lost word.
  return out.map((h, i) => {
    if (h.numeric !== true || h.use !== 'command') return h;
    const lead = text.slice(0, h.at).trimEnd();
    const clauseStart = lead.length === 0 || /[.!?;:\n]$/u.test(lead);
    const stop = text.slice(h.end).search(/[.!?\n]/u);
    const sentenceEnd = stop < 0 ? text.length : h.end + stop;
    const listFollows = out.slice(i + 1).some((o) => o.use === 'command' && o.numeric !== true && o.at < sentenceEnd);
    return clauseStart || listFollows ? h : { ...h, use: 'content' as const };
  });
}

const HALO = /[\s,.;:!?，。、；：！？…¿¡．—–]/u;

/** One changed region of the character diff, in UTF-16 offsets of each side
 *  (stt-polish-guard.ts diffChars). */
export interface SpanHunk { rawStart: number; rawEnd: number; polStart: number; polEnd: number }

/** Where input offset `r` lands in the output. A span's left edge takes in a
 *  changed region that starts at it; its right edge stops before one. */
function toPol(r: number, hunks: readonly SpanHunk[], right: boolean): number {
  let shift = 0;
  for (const h of hunks) {
    if (h.rawStart > r) break;
    if (h.rawStart === h.rawEnd && h.rawStart === r) {
      if (!right) return h.polStart;
      shift = h.polEnd - h.rawEnd;
      continue;
    }
    if (r < h.rawEnd) return right ? (r === h.rawStart ? h.polStart : h.polEnd) : h.polStart;
    shift = h.polEnd - h.rawEnd;
  }
  return r + shift;
}

const count = (re: RegExp, s: string): number => s.match(re)?.length ?? 0;

function wordsIn(s: string): number {
  return (s.match(/\p{Script=Han}/gu)?.length ?? 0) + (s.replace(/\p{Script=Han}/gu, ' ').match(/\p{L}+/gu)?.length ?? 0);
}

// The symbols a converted command may leave at its place. Quotes, brackets and
// dashes are left out of the "foreign symbol" test: they sit next to commands
// for reasons of their own (« Merci, Staging-Umgebung).
const POSITION_CLASSES: readonly SymClass[] = ['comma', 'period', 'question', 'exclaim', 'colon', 'semicolon', 'newline'];

export interface DictationEdits {
  /** A refusal reason suffix (closed-class-drift:<this>), or null. */
  refused: 'dictation' | 'dictation-word' | 'line-break' | null;
  /** Characters of command words the output turned into symbols. */
  chars: number;
  /** Open-class tokens those command words were. */
  words: number;
  /** NR-262 R1: input spans [at, end) of command words (and decimal marks)
   *  whose symbol the output has at their own place. Only these are excused
   *  from the content check (stt-polish-guard-content.ts contentDrift); every
   *  other occurrence of a command word is compared like any other word. */
  excused: [number, number][];
  /** Input spans of every command word read as a command or a decimal mark.
   *  What the content check excuses when this check has refused: the refusal
   *  is this check's, and the content check then judges the rest of the
   *  sentence (stt-polish-guard.ts), so the reason is the one that names the
   *  cause, as on main. */
  commands: [number, number][];
}

// NR-262 R5: an English command is masked from the numbers and clause gates
// only in a Latin-script session (or one of unknown language, which reads
// English). Elsewhere (zh / ja / ko / ru / …) those gates are what read the
// content (Han, kana, Hangul, Cyrillic) until a content check for those
// scripts exists, so they stay as on main. The edit-budget discount for an
// English command is narrower still (final decision): English sessions and
// sessions of unknown language only ("amanhã period Obrigado" -> "depois de
// amanhã." passed Portuguese strict on the discount).
const LATIN_SESSIONS: ReadonlySet<string> = new Set([
  'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'ca', 'gl', 'eu', 'sv', 'da', 'no', 'nb', 'nn', 'is', 'fi', 'et',
  'pl', 'cs', 'sk', 'sl', 'hr', 'bs', 'sr-latn', 'ro', 'hu', 'lt', 'lv', 'sq', 'tr', 'az', 'id', 'ms', 'tl',
  'vi', 'sw', 'af', 'ga', 'cy', 'mt',
]);
const englishMask = (language: string | undefined): boolean => language === undefined || LATIN_SESSIONS.has(language);
const englishCredit = (language: string | undefined): boolean => language === undefined || language === 'en';
const COMMA_DECIMAL: ReadonlySet<string> = new Set(['de', 'fr', 'es', 'it', 'ru', 'pt']);

/**
 * What dictated commands the output converted, and whether it lost one.
 *
 * Judged AT THE COMMAND'S PLACE (MAIN 2026-10-14): the input commands that
 * touch (through spaces and punctuation) form one group; the group's span is
 * carried through the character diff into the output, and there each command
 * is either still a word, or its symbol is there. A symbol of another class
 * that neither a command of the group nor the input's own punctuation around
 * it accounts for ("、てん、" -> "、。") is refused too.
 *
 * `lineBreaks === false` (audio:start delivery 'inject': typed into a PC, where a line
 * break is typed as Enter and Enter sends in a chat box): the output may not
 * have more line breaks than the input, whatever produced them.
 */
export function dictationEdits(
  raw: string,
  polished: string,
  language: string | undefined,
  hunks: readonly SpanHunk[],
  lineBreaks?: boolean,
): DictationEdits {
  const rh = hits(raw, language);
  const commands = rh.filter((h) => h.use !== 'content').map((h): [number, number] => [h.at, h.end]);
  const refuse = (refused: DictationEdits['refused']): DictationEdits => ({ refused, chars: 0, words: 0, excused: [], commands });
  if (lineBreaks === false && count(SYM.newline, polished) > count(SYM.newline, raw)) return refuse('line-break');
  const ph = hits(polished, language);
  // A command phrase may not appear from nowhere ("Il a la ligne fixe" ->
  // "Il à la ligne fixe."): the output has no more of any command's words
  // than the input said.
  // Decimal marks are the numbers gate's.
  const said = (list: readonly Hit[], surface: string): number => list.filter((h) => h.surface === surface && h.use !== 'number').length;
  for (const surface of new Set(ph.map((h) => h.surface))) if (said(ph, surface) > said(rh, surface)) return refuse('dictation-word');
  if (rh.length === 0) return { refused: null, chars: 0, words: 0, excused: [], commands };
  const excused: [number, number][] = [];
  // A decimal mark said as a word (drei Komma fünf) whose symbol, or another
  // spoken decimal mark, the output has where it was, between the same
  // numbers (3,5 / drei Punkt fünf): the numbers gate owns its value.
  for (const h of rh) {
    if (h.use !== 'number') continue;
    let at = h.at;
    let end = h.end;
    while (at > 0 && /\s/u.test(raw[at - 1]!)) at -= 1;
    while (at > 0 && /[\p{L}\p{N}]/u.test(raw[at - 1]!)) at -= 1;
    while (end < raw.length && /\s/u.test(raw[end]!)) end += 1;
    while (end < raw.length && /[\p{L}\p{N}]/u.test(raw[end]!)) end += 1;
    const from = toPol(at, hunks, false);
    const to = toPol(end, hunks, true);
    const where = polished.slice(from, to);
    const marked = count(SYM[h.kind], where) > 0
      // Round 3: where the session's locale writes comma decimals, "dos punto
      // cinco" -> "2,5" and "drei Komma fünf" -> "3.5" are one value written
      // either way (the numbers gate compares the value); not in English.
      // Only the session language's own decimal words: an English "comma" in an
      // Italian session is the legal "comma" (paragraph), "articolo 5 comma 3".
      || (h.lang === language && COMMA_DECIMAL.has(language) && count(SYM.comma, where) + count(SYM.period, where) > 0)
      || ph.some((p) => p.use === 'number' && p.at >= from && p.end <= to);
    if (marked) excused.push([h.at, h.end]);
  }
  // By surface, not kind (NR-262 review): "el punto final" -> "el punto
  // inicial", "the next line" -> "the new line" keep the kind and lose the words.
  for (const surface of new Set(rh.map((h) => h.surface))) {
    const rawWords = rh.filter((h) => h.surface === surface && h.use !== 'number');
    const drop = rawWords.length - ph.filter((h) => h.surface === surface && h.use !== 'number').length;
    // More of the words vanished than were ever said as a command.
    if (drop > rawWords.filter((h) => h.use === 'command').length) return refuse('dictation-word');
  }
  const groups: { at: number; end: number; cmds: Hit[] }[] = [];
  for (const h of rh.filter((x) => x.use === 'command')) {
    let at = h.at;
    let end = h.end;
    while (at > 0 && HALO.test(raw[at - 1]!)) at -= 1;
    while (end < raw.length && HALO.test(raw[end]!)) end += 1;
    const last = groups[groups.length - 1];
    if (last && at <= last.end) { last.end = Math.max(last.end, end); last.cmds.push(h); } else groups.push({ at, end, cmds: [h] });
  }
  const converted: Converted[] = [];
  for (const g of groups) {
    const spanAt = toPol(g.at, hunks, false);
    const spanEnd = toPol(g.end, hunks, true);
    const span = polished.slice(spanAt, spanEnd);
    const kept = hits(span, language);
    const allowed = new Set<SymClass>(g.cmds.map((h) => h.kind));
    // A line break may close the sentence before it ("done—new line, please"
    // -> "done." plus the break): measured on en-pun-01 / en-pun-03.
    // EN-AUDIT (2026-10-14): or end a salutation / sign-off line with a comma
    // ("Best regards new line Tom" -> "Best regards,\nTom"; "Bonjour Marie à
    // la ligne" -> "Bonjour Marie,\n"). The model wrote that comma in 4 of 4
    // live calls and the whole conversion was refused. The break must still
    // be there (the count check below), so a comma never stands in for it.
    if (allowed.has('newline')) { allowed.add('period'); allowed.add('comma'); }
    const halo = raw.slice(g.at, g.end);
    for (const k of POSITION_CLASSES) if (count(SYM[k], withoutWords(halo, g)) > 0) allowed.add(k);
    // A command left as words must be the same words: a command word the
    // input did not say here ("open quote" -> "close quote", "Anführungszeichen
    // auf" -> "zu", "begin quote" -> "quote") is a change, not a conversion.
    const said = new Set(g.cmds.map((h) => h.surface));
    if (kept.some((h) => h.use !== 'number' && !said.has(h.surface))) return refuse('dictation');
    const convertedByKind = new Map<SymClass, number>();
    const convertedHits: Hit[] = [];
    for (const surface of said) {
      const cmds = g.cmds.filter((h) => h.surface === surface);
      const converted = cmds.length - Math.min(cmds.length, kept.filter((h) => h.surface === surface).length);
      if (converted === 0) continue;
      const kind = cmds[0]!.kind;
      convertedByKind.set(kind, (convertedByKind.get(kind) ?? 0) + converted);
      for (const h of cmds.slice(0, converted)) convertedHits.push(h);
    }
    for (const [kind, converted] of convertedByKind) if (count(SYM[kind], span) < converted) return refuse('dictation');
    // Every converted command of this group has its symbol at its place.
    for (const h of convertedHits) converted.push({ h, spanAt, spanEnd });
    // Every command of the group was left as words: a comma or a period added
    // next to it is ordinary polish ("eine hohe Quote" -> "Quote.", "这个 quote
    // 明天给我" -> "这个 quote，明天给我。"; NR-262 review). Nothing else is:
    // "?", "!", ":", ";" there would change what the sentence does (round 2).
    if (convertedByKind.size === 0) {
      allowed.add('comma');
      // A period only where it ends the text: one in the middle splits the
      // sentence ("We will not quote the old price" -> "We will not. Quote the
      // old price.").
      const final = [...span.matchAll(SYM.period)].every((x) => /^[\s\p{P}]*$/u.test(polished.slice(spanAt + x.index + x[0].length)));
      if (final) allowed.add('period');
    }
    for (const k of POSITION_CLASSES) if (!allowed.has(k) && count(SYM[k], span) > 0) return refuse('dictation');
  }
  // Excused: a converted phrase main's content check excused, or an `added`
  // one that is half of a verified pair (pairedExcusal). An unpaired `added`
  // phrase is compared as words by the content check, exactly as on main.
  let chars = 0;
  let words = 0;
  const paired = pairedExcusal(converted, raw, polished);
  for (const c of converted) {
    if (c.h.added === true && !paired.has(c.h)) continue;
    excused.push([c.h.at, c.h.end]);
    // No budget discount for an English command outside an English session.
    if (c.h.lang === 'en' && !englishCredit(language)) continue;
    chars += c.h.end - c.h.at + 1;
    words += wordsIn(raw.slice(c.h.at, c.h.end));
  }
  // A phrase an NR-262 reading made a word of the sentence ("Send end quote by
  // Friday") is never excused, and, kept as words, it may gain only what a kept
  // command may: a comma, or a period that ends the text ("… punto final?"
  // asks a question the speaker did not; main refused it as a kept command).
  for (const h of rh) {
    if (h.demoted !== true || h.use !== 'content') continue;
    let at = h.at;
    let end = h.end;
    while (at > 0 && HALO.test(raw[at - 1]!)) at -= 1;
    while (end < raw.length && HALO.test(raw[end]!)) end += 1;
    const spanAt = toPol(at, hunks, false);
    const span = polished.slice(spanAt, toPol(end, hunks, true));
    if (!hits(span, language).some((k) => k.surface === h.surface)) continue; // its loss is the content check's
    const allowed = new Set<SymClass>(['comma']);
    const halo = raw.slice(at, h.at) + ' '.repeat(h.end - h.at) + raw.slice(h.end, end);
    for (const k of POSITION_CLASSES) if (count(SYM[k], halo) > 0) allowed.add(k);
    if ([...span.matchAll(SYM.period)].every((x) => /^[\s\p{P}]*$/u.test(polished.slice(spanAt + x.index + x[0].length)))) allowed.add('period');
    for (const k of POSITION_CLASSES) if (!allowed.has(k) && count(SYM[k], span) > 0) return refuse('dictation');
  }
  return { refused: null, chars, words, excused, commands };
}

/** A group's input span with its command words cut out: the punctuation the
 *  transcript itself put there. */
function withoutWords(halo: string, g: { at: number; cmds: Hit[] }): string {
  let out = halo;
  for (const h of [...g.cmds].reverse()) out = out.slice(0, h.at - g.at) + ' '.repeat(h.end - h.at) + out.slice(h.end - g.at);
  return out;
}

/** `text` with every word said as a command blanked to spaces (same length,
 *  so offsets hold). The numbers gates read this: "deux points" / "dos
 *  puntos" is a colon, not the number 2. Losing the command itself is still
 *  judged by dictationEdits, which wants a colon in its place. */
export function maskCommands(text: string, language: string | undefined): string {
  // R5: outside a Latin-script session English commands stay visible to the
  // numbers and clause gates, as on main (masking them let "завтра" ->
  // "послезавтра" next to a converted command through under smooth, which
  // main refused as a dropped clause).
  const english = englishMask(language);
  let out = text;
  for (const h of hits(text, language)) {
    if (h.use === 'command' && (english || h.lang !== 'en')) out = out.slice(0, h.at) + ' '.repeat(h.end - h.at) + out.slice(h.end);
  }
  return out;
}

/**
 * Card SEAM-2 (docs/strategy/2026-10-14-soft-seam-root-cause.md §3.1; MAIN 2026-10-14) — the kind of the
 * dictated command at the very end of [text] (nothing but whitespace and punctuation after it), or null.
 * A mark there may be the one the speaker asked for ("send the report period"), so the seam repair
 * (`seam-artifact.ts`) neither strips the vendor's mark after it nor takes away the polish's symbol.
 * Language as the guard reads it (a base tag, `stt-polish-guard.ts`). An `added` phrase counts only as the
 * closing half of a pair opened earlier in [text] (NR-262: an unpaired added phrase is words).
 */
export function trailingDictatedCommand(text: string, language: string | undefined): string | null {
  const all = hits(text, baseLanguage(language)).filter((h) => h.use === 'command');
  const last = all[all.length - 1];
  if (last === undefined || !/^[\s\p{P}]*$/u.test(text.slice(last.end))) return null;
  if (last.added === true) {
    const quotesBefore = all.filter((h) => h !== last && h.kind === 'quote').length;
    if (role(last, quotesBefore) !== 'close') return null;
    let quotes = 0;
    const opened = all.slice(0, -1).some((h) => { const r = role(h, quotes); if (h.kind === 'quote') quotes += 1; return r === 'open' && (h.kind === 'quote') === (last.kind === 'quote'); });
    if (!opened) return null;
  }
  return last.kind;
}

/** Card POL-3 — does the session language have its OWN dictated-command table
 *  (commandLanguages lists its base tag, the reading `trailingDictatedCommand` uses;
 *  no language reads English, like the guard)? The stage-1 prompt mentions dictated
 *  punctuation only then: a zh session reads the English table for the guard, but is
 *  not invited to convert in its own words, which the strip would then remove. */
export function hasDictationTable(language: string | undefined): boolean {
  if (language === undefined) return true;
  const base = baseLanguage(language);
  return base !== undefined && commandLanguages(base).includes(base);
}
