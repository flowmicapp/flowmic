// NR-245 (GUARD-2, 2026-10-13): Smooth may resolve an explicit self-correction.
//
// "let's meet at 2, no wait, 3" -> "let's meet at 3" is what the Smooth
// prompt asks for (drop false starts), and the guard refused every such
// output: the dropped "no" / 不 / 2 is, read naively, a negation and a number
// that vanished. Six eval items (en and zh) could never be smoothed.
//
// The guard does not learn to ignore negations or numbers. Instead it builds
// READINGS of the input in which one explicit repair has already been applied
// — the reparandum (the stretch the repair replaces) and the marker removed,
// the repair itself kept — and the caller runs the unchanged guard on each
// reading against the output. So the repair's own numbers, negations, terms
// and content must all survive, by the same rules as everywhere else:
//   "let's meet at 2, no wait, 3" -> "let's meet at 3"  accepted (reading
//       "let's meet at 3" matches);
//   "let's meet at 2, no wait, 3" -> "let's meet at 2"  refused (no reading
//       keeps 2 without 3).
//
// What makes a marker a repair, not a word (the card: only when it is
// clearly a repair):
//   · it is an explicit marker (MARKERS below), set off from what precedes it
//     by punctuation (multi-word English markers may follow a plain space);
//   · Chinese 不对 / 不是 / 哦不 must also be set off AFTER (，不对，), so
//     「这个方案不对，应该改」 (a judgement) is not a repair;
//   · the repair parallels the reparandum: if the repair starts with a number,
//     the reparandum holds a number; if it starts with a content word, the
//     reparandum holds a content word. "I mean it" (pronoun) and 「我是说过的」
//     (particle) are therefore not repairs;
//   · a bare "no" counts only between two numbers, and never after a
//     sentence stop ("We need 4, no, 5 more" yes; "We lost 4. No, 5 renewed" no);
//   · the reparandum is the MINIMAL stretch the repair replaces (see oneRepair);
//   · a marker inside quotes, or sorry / actually after a sentence stop, is not one.
// The reparandum is at most a short stretch inside one clause before the
// marker (MAX_TOKENS), never across other punctuation.
//
// Smooth only (stt-polish-guard.ts): strict keeps both values by contract.
import { isLatinContentWord } from './stt-polish-guard-content';

interface Marker { re: RegExp; weak?: boolean; sepAfter?: boolean; spaceOk?: boolean; noLead?: boolean; cjk?: boolean; retraceOther?: boolean }

const EN_MARKERS: readonly Marker[] = [
  { re: /no,?\s+wait/giu, spaceOk: true },
  { re: /wait,?\s+no/giu, spaceOk: true },
  { re: /no,?\s+(?:I\s+mean|sorry)/giu, spaceOk: true },
  { re: /sorry,?\s+I\s+mean/giu, spaceOk: true },
  { re: /actually,?\s+no/giu, spaceOk: true },
  { re: /scratch\s+that/giu, spaceOk: true },
  { re: /or\s+rather/giu, spaceOk: true },
  { re: /I\s+meant?/giu, spaceOk: true },
  // Single words: no lead is skipped after them, so "sorry, it is fixed"
  // starts its would-be repair at "it" (not a repair).
  { re: /sorry/giu, noLead: true },
  { re: /actually/giu, noLead: true },
  { re: /no/giu, weak: true, noLead: true },
];
const ZH_MARKERS: readonly Marker[] = [
  { re: /不对/gu, sepAfter: true },
  { re: /[哦噢喔]不(?:对|是)?/gu, sepAfter: true },
  { re: /不是/gu, sepAfter: true },
  { re: /我是说/gu },
  { re: /说错了/gu },
];

// ML-1 (2026-10-13): the session language's own markers (ML-0 D6: Smooth
// resolved 6 of 18 self-corrections in fr/es/de/ja/ko/ru). Read only when the
// session language says so. A bare correction word that is also a negation
// (non, no, nein, нет, 아니) must be set off on both sides AND pass the same
// parallel-repair test as every marker (retrace or substitution below), so
// "Je ne sais pas, non, c'est fini" is never a repair. `retraceOther`: these
// languages repeat a preposition at the repair ("à Paul, non, pardon, à
// Pierre"), so a function word may open the repair when the reparandum starts
// with the same word.
const LANG_MARKERS: Readonly<Record<string, readonly Marker[]>> = {
  fr: [
    { re: /non,?\s+(?:pardon|plutôt|je\s+veux\s+dire)/giu, spaceOk: true, retraceOther: true },
    { re: /je\s+veux\s+dire/giu, spaceOk: true, retraceOther: true },
    { re: /pardon/giu, noLead: true, retraceOther: true },
    { re: /non/giu, sepAfter: true, noLead: true, retraceOther: true },
  ],
  es: [
    { re: /no,?\s+(?:perdón|perdon|mejor|digo|quiero\s+decir)/giu, spaceOk: true, retraceOther: true },
    { re: /o\s+sea|quiero\s+decir/giu, spaceOk: true, retraceOther: true },
    { re: /perdón|perdon/giu, noLead: true, retraceOther: true },
    { re: /no/giu, sepAfter: true, noLead: true, retraceOther: true },
  ],
  de: [
    { re: /nein,?\s+(?:ich\s+meine|sorry|Entschuldigung)/giu, spaceOk: true, retraceOther: true },
    { re: /ich\s+meine/giu, spaceOk: true, retraceOther: true },
    { re: /Entschuldigung/giu, noLead: true, retraceOther: true },
    { re: /nein/giu, sepAfter: true, noLead: true, retraceOther: true },
  ],
  ru: [
    { re: /нет,?\s+(?:то\s+есть|вернее|точнее|извините|прости)/giu, spaceOk: true, retraceOther: true },
    { re: /то\s+есть|вернее|точнее/giu, spaceOk: true, retraceOther: true },
    { re: /нет/giu, sepAfter: true, noLead: true, retraceOther: true },
  ],
  ja: [
    { re: /いや|じゃなくて|ではなくて|間違えた/gu, sepAfter: true, cjk: true },
  ],
  ko: [
    { re: /아니(?:요|야)?/gu, sepAfter: true, noLead: true },
  ],
};

const BARE_NEGATION = /^(?:no|non|nein|нет|아니|아니요|아니야|いや)$/iu;
const SEP = /[\s,，、.。;；:：!！?？…—-]/u;
const PUNCT = /[,，、.。;；:：!！?？…—]/u;
// A token that IS punctuation (15,000 contains a comma and is not one).
const PUNCT_TOK = /^[,，、.。;；:：!！?？…—]$/u;
const HAN_NUMERAL = /[零〇一幺二两三四五六七八九十百千万亿]/u;
const EN_NUMBER = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)$/iu;
// Han characters that cannot start a repair or count as its parallel.
const HAN_FUNCTION = new RegExp(`[${'的了过着吗呢吧啊嘛呀我你他她它们这那是在有就都也还和与把被给到对很太又再才'}]`, 'u');
const LEADS = /^(?:it'?s\s+|it\s+is\s+|make\s+it\s+|应该是|就是|是)/iu;
const MAX_TOKENS = 8;
const MAX_READINGS = 24;

type Kind = 'number' | 'content' | 'other';
interface Tok { text: string; start: number; end: number; kind: Kind }

// ML-1: Cyrillic and Hangul words are tokens too (they were one token per
// character, so no Russian or Korean repair could ever parallel its reparandum).
const TOK_RE = /\p{Script=Latin}[\p{Script=Latin}\p{M}'’]*|\p{Script=Cyrillic}+|\p{Script=Hangul}+|[0-9]+(?:[.,:][0-9]+)*|\p{Script=Han}|[^\s]/gu;
const KO_FUNCTION = new Set(['음', '어', '그', '저', '아', '뭐', '네', '예', '좀', '막']);

function kindOf(t: string): Kind {
  if (/^[0-9]/u.test(t) || HAN_NUMERAL.test(t) || EN_NUMBER.test(t)) return 'number';
  if (/^\p{Script=Latin}/u.test(t)) return isLatinContentWord(t.toLowerCase()) ? 'content' : 'other';
  if (/^\p{Script=Han}$/u.test(t)) return HAN_FUNCTION.test(t) ? 'other' : 'content';
  if (/^\p{Script=Cyrillic}/u.test(t)) return [...t].length >= 3 ? 'content' : 'other';
  if (/^\p{Script=Hangul}/u.test(t)) return KO_FUNCTION.has(t) ? 'other' : 'content';
  return 'other';
}

const SENTENCE_STOP = /[.。!！?？]/u;
const ARTICLE = /^(?:the|a|an)\s+/iu;

/** True when an odd number of straight/curly double quotes, or more opening
 *  than closing corner brackets, precede `at`. */
function insideQuote(text: string, at: number): boolean {
  const before = text.slice(0, at);
  const doubles = (before.match(/["“”]/gu) ?? []).length;
  const opens = (before.match(/[「『]/gu) ?? []).length;
  const closes = (before.match(/[」』]/gu) ?? []).length;
  // Single quotes (final review round): ‘ opens, and an ASCII ' opens after a
  // space; ’ or ' closes when a word ends there. An apostrophe (it's, it’s)
  // is neither: it has letters on both sides.
  const singleOpens = (before.match(/‘|(?<=^|\s)'/gu) ?? []).length;
  const singleCloses = (before.match(/(?<=\S)[’'](?=[\s,.;:!?…]|$)/gu) ?? []).length;
  return doubles % 2 === 1 || opens > closes || singleOpens > singleCloses;
}

// A repair that ADDS rather than replaces ("send it to legal too",
// 「发给张伟，两个人都要」) keeps the reparandum in force (final review round).
const ADDITIVE_EN = /(?<![\p{L}])(?:too|also|as\s+well)(?![\p{L}])/iu;
const ADDITIVE_ZH = /[也还都]/u;

/** True when the repair's sentence (from `from` to the next sentence stop)
 *  carries an additive word. */
function additiveRepair(text: string, from: number): boolean {
  const rest = text.slice(from);
  const stop = rest.search(/[.。!！?？]/u);
  const sentence = stop < 0 ? rest : rest.slice(0, stop);
  return ADDITIVE_EN.test(sentence) || ADDITIVE_ZH.test(sentence);
}

/** A number stands for a number; any Latin word or Han content character
 *  stands for a content word ("the server is down, sorry, slow"). */
function canStandFor(head: Tok, repair: Tok): boolean {
  if (repair.kind === 'number') return head.kind === 'number';
  return head.kind === 'content' || (head.kind === 'other' && /^\p{Script=Latin}/u.test(head.text));
}

function toks(s: string): Tok[] {
  return [...s.matchAll(TOK_RE)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length, kind: kindOf(m[0]) }));
}

function isZh(re: RegExp): boolean {
  return ZH_MARKERS.some((m) => m.re === re);
}

/** A reading of the input with a repair applied, and the repair's own
 *  content words that the output must contain. */
export interface RepairReading {
  text: string;
  must: string[];
  /** ML-1 (language markers only): the reparandum's content words. The output
   *  may not keep more of them than the reading does — a resolved repair drops
   *  the replaced value, it does not keep both and lose the marker. */
  gone?: string[];
}

/** Readings of `text` with ONE explicit self-correction applied. */
function oneRepair(text: string, lang?: string): RepairReading[] {
  const out: RepairReading[] = [];
  const all = toks(text);
  for (const marker of [...EN_MARKERS, ...ZH_MARKERS, ...(lang !== undefined ? LANG_MARKERS[lang] ?? [] : [])]) {
    const zh = marker.cjk === true || isZh(marker.re);
    for (const m of text.matchAll(marker.re)) {
      const mStart = m.index;
      let mEnd = mStart + m[0].length;
      if (!zh) {
        // Whole words only.
        if (/\p{L}/u.test(text[mStart - 1] ?? '') || /\p{L}/u.test(text[mEnd] ?? '')) continue;
      }
      // Set off before: punctuation (or, for multi-word English markers, a space).
      let p = mStart;
      while (p > 0 && /\s/u.test(text[p - 1]!)) p -= 1;
      const punctBefore = p > 0 && PUNCT.test(text[p - 1]!);
      if (!punctBefore && !(marker.spaceOk && p < mStart)) continue;
      if (marker.sepAfter && !(SEP.test(text[mEnd] ?? '') || LEADS.test(text.slice(mEnd)))) continue;
      // A marker inside a quotation is quoted speech, not a repair.
      if (insideQuote(text, mStart)) continue;
      // sorry / actually right after a sentence stop open a new sentence
      // ("Revenue grew 10%. Actually, profit grew 20%.").
      // The same holds for a bare "No": "We lost 4. No, 5 customers renewed."
      // is an answer, and nothing in the text tells it from a repair.
      if (marker.noLead && punctBefore && SENTENCE_STOP.test(text[p - 1]!)) continue;
      while (mEnd < text.length && SEP.test(text[mEnd]!)) mEnd += 1;
      const lead = marker.noLead ? null : LEADS.exec(text.slice(mEnd));
      const ends = lead ? [mEnd, mEnd + lead[0].length] : [mEnd];
      // An article may open any repair: "sorry, the production database".
      for (const e of [...ends]) { const art = ARTICLE.exec(text.slice(e)); if (art) ends.push(e + art[0].length); }
      // The reparandum: tokens before the marker, inside one clause.
      let preEnd = p;
      while (preEnd > 0 && SEP.test(text[preEnd - 1]!)) preEnd -= 1;
      const before = all.filter((t) => t.end <= preEnd);
      const clause: Tok[] = [];
      for (let i = before.length - 1; i >= 0 && clause.length < MAX_TOKENS; i--) {
        const t = before[i]!;
        if (PUNCT_TOK.test(t.text)) break;
        if (i < before.length - 1 && PUNCT.test(text.slice(t.end, before[i + 1]!.start))) break;
        clause.unshift(t);
      }
      for (const end of ends) {
        const repair = all.find((t) => t.start >= end && !PUNCT_TOK.test(t.text));
        if (!repair || (repair.kind === 'other' && marker.retraceOther !== true)) continue;
        if (additiveRepair(text, repair.start)) continue;
        // The repair runs to the next punctuation (bounded like the reparandum).
        const from = all.indexOf(repair);
        const repairToks: Tok[] = [];
        for (let i = from; i < all.length && repairToks.length < MAX_TOKENS && !PUNCT_TOK.test(all[i]!.text); i++) repairToks.push(all[i]!);
        for (let k = clause.length - 1; k >= 0; k--) {
          const reparandum = clause.slice(k);
          // Only the MINIMAL stretch the repair replaces: a retrace (it starts
          // with the repair's first word: 「发给李明，不对，发给张伟」) or a
          // substitution (it starts with a token that can stand where the
          // repair's first token stands, and everything after that is repeated
          // in the repair: 「2点，不对，是3点」, "Alice, sorry, Bob"). Anything
          // longer would let the output drop words the repair never replaced.
          const head = reparandum[0]!;
          const echoed = new Set(repairToks.map((t) => t.text.toLowerCase()));
          const retrace = head.text.toLowerCase() === repair.text.toLowerCase();
          const substitution = canStandFor(head, repair) && reparandum.slice(1).every((t) => echoed.has(t.text.toLowerCase()));
          if (!retrace && !substitution) continue;
          if (repair.kind === 'other' && !retrace) continue;
          // A language marker never replaces a bare "no" of its own chain
          // ("Павлу, нет, то есть Петру": the reparandum is Павлу, not нет).
          const langMarker = marker.retraceOther === true || marker.cjk === true || lang === 'ko';
          if (langMarker && reparandum.some((t) => BARE_NEGATION.test(t.text))) continue;
          if (marker.weak && !(repair.kind === 'number' && reparandum[reparandum.length - 1]!.kind === 'number')) continue;
          // What the repair says that the reparandum did not: it must reach
          // the output (张伟 in 「发给李明，不对，发给张伟」). Numbers are left to
          // the numbers gate, which compares the reading's values in order.
          const replaced = new Set(reparandum.map((t) => t.text.toLowerCase()));
          const must = [...new Set(repairToks.filter((t) => t.kind === 'content' && !replaced.has(t.text.toLowerCase())).map((t) => t.text.toLowerCase()))];
          const reading = text.slice(0, reparandum[0]!.start) + text.slice(end);
          const gone = marker.retraceOther === true || marker.cjk === true || lang === 'ko'
            ? [...new Set(reparandum.filter((t) => t.kind !== 'other' && !echoed.has(t.text.toLowerCase())).map((t) => t.text.toLowerCase()))]
            : undefined;
          out.push({ text: reading, must, ...(gone ? { gone } : {}) });
        }
      }
    }
  }
  return out;
}

/** Readings of `text` with one or two explicit self-corrections applied,
 *  for the Smooth guard to try. Empty when the text has no explicit repair. */
export function repairReadings(text: string, lang?: string): RepairReading[] {
  const seen = new Map<string, RepairReading>();
  const add = (r: RepairReading): void => { if (r.text !== text && !seen.has(r.text)) seen.set(r.text, r); };
  for (const r of oneRepair(text, lang)) {
    if (seen.size >= MAX_READINGS) break;
    add(r);
    for (const r2 of oneRepair(r.text, lang)) {
      if (seen.size >= MAX_READINGS) break;
      const gone = [...new Set([...(r.gone ?? []), ...(r2.gone ?? [])])];
      add({ text: r2.text, must: [...new Set([...r.must, ...r2.must])], ...(gone.length ? { gone } : {}) });
    }
  }
  return [...seen.values()];
}

/** True when every word the repair contributed is in the output (a Latin
 *  word as a whole word, a Han character as a character). */
export function repairSurvives(reading: RepairReading, polished: string): boolean {
  const words = new Set(toks(polished).map((t) => t.text.toLowerCase()));
  if (!reading.must.every((w) => words.has(w))) return false;
  const count = (s: string, w: string): number => toks(s).filter((t) => t.text.toLowerCase() === w).length;
  return (reading.gone ?? []).every((w) => count(polished, w) <= count(reading.text, w));
}
