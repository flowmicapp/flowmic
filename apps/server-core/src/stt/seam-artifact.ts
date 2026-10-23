// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2.2 (card SEAM-2 block under the SEG-3 terminator rule) and
//     §5 (card SEAM-2 block: the normalizer's dash and the segment-polish terminal guard)
//   docs/strategy/2026-10-14-soft-seam-root-cause.md §1 (evidence) and §3.1 (this card's design)
//
// Card SEAM-2 — the marks a row cut leaves behind when WE end the vendor's stream mid-phrase.
//
// WHERE THEY COME FROM (measured, root-cause doc §1.1): Soniox gives its final only when the
// stream ends (`packages/stt-cloud/src/engines/soniox.ts` `finalsOnlyAtFlush`), so every row cut
// is an end-of-stream, and its answer to one closes the dangling phrase with a mark of its own —
// 「—」 / 「——」 / 「...」 for an unfinished phrase (a separate zero-duration token, EVAL-1 en-con-01)
// or a 「.」 glued onto a comma. The next row is a NEW connection, so its first word comes back
// capitalised as a sentence start. Our own text stages add none of it; we just hand it on.
//
// WHAT THIS FILE DOES. Three pure functions and the one holder of the 「the last row ended open」 fact:
//   - {@link stripOpenSeam}: drop that mark from a row before it leaves (whitespace untouched);
//   - {@link lowerContinuationHead}: lower-case the next row's first word, CLOSED word lists only
//     (MAIN 2026-10-14: precision over coverage — a name, noun or verb is never touched). Applied by the bridge
//     (`engine/stt-session-seam.ts`), which alone knows what the previous row finally said (re-review R3);
//   - {@link stripAddedTerminal}: the polish may not put a terminal mark back on a row we opened
//     ({@link keepOpenEnd} is its call: only a row this cut stripped, never after a dictated command).
// 🔴 MAIN 2026-10-14: a mark the SPEAKER dictated is never ours to take. Where the row ends on a dictated
// command word ("…send the report period", "…the plan dash"), neither strip fires (`trailingDictatedCommand`,
// stt-polish-guard-dictation.ts — the guard's own reading of which words were said as commands).
// No joining or spacing between rows is decided here (that is the PC's `delivery_spacing.rs`).
// 🔴 But a strip must not CREATE a seam the shipped joiners glue (review C1, MAIN 2026-10-14): the phone
// (`apps/mobile/lib/src/stt/segment_buffer.dart` `_joinerBetween`, `article_paragraphs.dart`) and the
// desktop capsule (`apps/desktop/src/capsule/utterance-view.ts` `joinerBetween`) put a space between rows
// only after an ASCII character. (Card POL-3, book 08 §3 correction: all row joiners now follow the PC's
// `delivery_spacing.rs`, which also spaces after accented Latin, Cyrillic, Greek and Hangul; this check
// stays as written — it is only more conservative than it needs to be.) So a row is stripped only when the character left at its end is ASCII or a
// script written without spaces ({@link joinSafeEnd}); 「мы—」「Fuß—」 and Hangul keep today's text exactly.
// Scope: only engines whose final is produced by the end-of-stream (`finalsOnlyAtFlush`), only
// at 'pause' / 'word_gap' row cuts. 'sentence', 'overdue', the 'leg' rotation (seamText's own rule)
// and the hang-up leg seam (`leg-seam-join.ts`) are unchanged, and so is the long recording's silence row
// cut (RC-E, review P5: not measured yet — it is logged, not repaired). The terminal final of such an engine
// loses a trailing dash run so the normalizer closes it ({@link dropTerminalDash}, design §3.1 rule 4).

import { seamText, type SegmentCutReason } from './segment-boundary';
import { trailingDictatedCommand } from './stt-polish-guard-dictation';
import { baseLanguage } from './stt-polish-guard-lang';

/** A run of 「not finished」 marks at the very end: em dashes, ellipsis characters, or 3+ dots. */
const OPEN_MARK_RUN = /(?:—+|…+|\.{3,})$/u;
/** A full stop glued onto a pause mark (「immer,.」): never a sentence end. Group 1 is kept. */
const PAUSE_THEN_STOP = /([,，、;；:：])\s*[.。]$/u;

/**
 * Remove the vendor's 「not finished」 mark from the end of a row cut mid-phrase.
 * A lone 「.」 / 「。」 is NOT removed: real sentence-end cuts carry one (96/97 in baseline A).
 * Only the visible tail is examined; every whitespace byte comes back untouched (the same rule
 * as `seamText`, which once ate the space joining two English rows). A row that would be left
 * with no visible character is returned as it was and is not open.
 */
export function stripOpenSeam(text: string): { text: string; open: boolean } {
  const end = text.trimEnd().length;
  const body = text.slice(0, end);
  const tail = text.slice(end);
  let stripped: string | null = null;
  const run = OPEN_MARK_RUN.exec(body);
  if (run !== null) stripped = body.slice(0, run.index);
  else {
    const stop = PAUSE_THEN_STOP.exec(body);
    if (stop !== null) stripped = body.slice(0, stop.index) + stop[1];
  }
  if (stripped === null || stripped.trim() === '') return { text, open: false };
  return { text: stripped + tail, open: true };
}

// Closed function-word lists, keyed by primary language subtag. Lower-case forms; ’ is read as '.
// ⚠️ Deliberately absent: English I / I'm / I'll / I've / I'd (always capital), May and Will
// (a month and a name), Per (a name); German Sie / Ihr / Ihnen (formal address, capital by rule)
// and aus / etwas / nichts / alles (each has a homographic noun: das Aus, das Etwas …).
const CONTINUATION_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set([
    // articles and determiners
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'some', 'any', 'each', 'every', 'all', 'no',
    // conjunctions
    'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though', 'if', 'when', 'while',
    'as', 'than', 'whether', 'unless', 'until', 'since', 'once', 'where', 'which', 'who', 'whom', 'whose', 'what',
    // prepositions
    'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'about', 'into', 'onto', 'over', 'under',
    'through', 'between', 'among', 'around', 'against', 'during', 'without', 'within', 'along', 'across',
    'behind', 'beyond', 'near', 'off', 'out', 'up', 'down', 'upon', 'toward', 'towards', 'after', 'before', 'like',
    // pronouns (not I)
    'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its',
    'our', 'their', 'there', 'here', "it's", "we're", "they're", "you're", "he's", "she's", "that's", "there's",
    // auxiliaries and modals (not May / Will)
    'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
    'would', 'shall', 'should', 'can', 'could', 'might', 'must',
    "won't", "can't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
    // common adverbs
    'then', 'also', 'just', 'still', 'even', 'really', 'not', 'too', 'very', 'only', 'already', 'now',
    'again', 'maybe', 'probably', 'actually',
  ]),
  de: new Set([
    // articles
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
    // conjunctions
    'und', 'oder', 'aber', 'denn', 'sondern', 'dass', 'weil', 'wenn', 'als', 'ob',
    // prepositions (not aus)
    'für', 'mit', 'von', 'zu', 'zum', 'zur', 'bei', 'nach', 'auf', 'an', 'in', 'im', 'am', 'um',
    'über', 'vor', 'durch', 'gegen', 'ohne', 'bis',
    // pronouns (not Sie / Ihr / Ihnen)
    'ich', 'du', 'er', 'es', 'wir', 'man',
    // adverbs
    'dann', 'also', 'so', 'auch', 'noch', 'schon', 'nur',
  ]),
};

/** The first word: an initial capital, the rest lower case, an optional contraction; then a boundary. */
const HEAD_WORD = /^(\s*)(\p{Lu}\p{Ll}*(?:['’]\p{Ll}+)?)(?=$|[\s,.;:!?…—])/u;

/**
 * Lower-case the first word of a row that continues a phrase the previous row left open —
 * only when it is on the session language's closed list above. Anything else (a name, a noun,
 * a verb, a word never seen, mixed case like 「GitHub」 or 「API」) is returned unchanged, and so
 * is every language without a list. Only the first letter changes.
 */
export function lowerContinuationHead(text: string, language: string): string {
  const words = CONTINUATION_WORDS[language.trim().toLowerCase().split(/[-_]/u)[0] ?? ''];
  if (words === undefined) return text;
  const m = HEAD_WORD.exec(text);
  if (m === null) return text;
  const word = m[2]!;
  if (!words.has(word.toLowerCase().replace('’', "'"))) return text;
  return m[1]! + word[0]!.toLowerCase() + word.slice(1) + text.slice(m[0].length);
}

// Card POL-3 merge: this IS the stage-1 strip now — `engine/stt-session-units.ts` passes openEnd = true
// to `runPolishedFinal` for every context-mode soft-segment row; there is no second copy.
const TERMINAL_RUN = /[。！？.!?…．؟।۔]+$/u;
// `final-text-normalizer.ts` `CLOSERS`, same set.
const CLOSERS = new Set(['"', "'", '”', '’', ')', '）', ']', '】', '}', '》', '」', '』']);

function peelClosers(s: string): { body: string; suffix: string } {
  let body = s;
  let suffix = '';
  while (body.length > 0 && CLOSERS.has(body[body.length - 1]!)) {
    suffix = body[body.length - 1]! + suffix;
    body = body.slice(0, -1);
  }
  return { body, suffix };
}

// Abbreviations whose dot is part of the word (the set of `polish-spec-plan.ts` ABBREV, plus a few).
// Re-review R3: no 「no」 (「I said no.」 ends a sentence).
const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'fig', 'approx', 'inc', 'ltd', 'jr', 'sr', 'co', 'dept', 'bzw', 'usw', 'ca', 'nr']);

/** Review P3: the 「.」 at the end of [body] belongs to a word — after a single letter, inside a dotted
 *  abbreviation (「p.m.」「U.S.」「e.g.」), after a number (an ordinal 「am 3.」), or a listed abbreviation. */
function dotBelongsToWord(body: string, language: string | undefined): boolean {
  const token = (/(\S*)\.$/u.exec(body)?.[1] ?? '').replace(/^[("'“‘]+/u, '');
  if (token === '') return false;
  if ([...token].length === 1 && /\p{L}/u.test(token)) return true;
  if (token.includes('.')) return true;
  // Re-review R3: a number's dot is an ordinal in German only (「am 3.」); elsewhere 「about 5.」 ends the sentence.
  if (/\p{N}$/u.test(token)) return baseLanguage(language) === 'de';
  return ABBREV.has(token.toLowerCase());
}

/**
 * The polish may not close a row the input left open: the input does not end with a terminal mark and
 * the accepted output ends with ONE 「.」 or 「。」 the polish added ⇒ remove that one mark (closing quotes
 * and brackets kept, trailing whitespace kept). Review P3: never 「?」「!」「…」 (the model wrote a real
 * question or exclamation), never 「..」, never a dot that belongs to a word ({@link dotBelongsToWord}).
 * Input that ended with a mark keeps the output untouched.
 */
export function stripAddedTerminal(input: string, output: string, language?: string): string {
  if (TERMINAL_RUN.test(peelClosers(input.trimEnd()).body)) return output;
  const trimmed = output.trimEnd();
  const { body, suffix } = peelClosers(trimmed);
  if (!/(?:^|[^.。])[.。]$/u.test(body)) return output;
  if (body.endsWith('.') && dotBelongsToWord(body, language)) return output;
  const stripped = body.slice(0, -1);
  if (stripped.trim() === '') return output;
  return stripped + suffix + output.slice(trimmed.length);
}

/** The cut reasons at which the speaker is still talking and the rule applies. */
function isMidSpeechRowCut(reason: SegmentCutReason): boolean {
  return reason === 'pause' || reason === 'word_gap';
}

/**
 * The segment polish's exit for a row ([openEnd] = this row's cut stripped an open mark, the `seam_open`
 * the orchestrator put on its final): the polish's added terminal mark is taken back off — unless the row
 * ends on a dictated command, where that mark is the symbol the speaker asked for. Any other row: as written.
 */
export function keepOpenEnd(input: string, output: string, openEnd: boolean, language: string | undefined): string {
  if (!openEnd || trailingDictatedCommand(input, language) !== null) return output;
  return stripAddedTerminal(input, output, language);
}

/**
 * The `stt.cut` field for a row cut (card SEAM-2): `{ seam_open }` when the rule applies to this
 * cut, `{}` otherwise (absent, never false — the question was not asked). Pure: the hang-up row
 * cut logs before it emits, so it asks with the same text the emit will repair.
 */
export function seamOpenLogField(text: string, reason: SegmentCutReason, flushCloses: boolean, language: string): { seam_open?: boolean } {
  if (!flushCloses || !isMidSpeechRowCut(reason)) return {};
  return { seam_open: repairRowEnd(seamText(text, reason), language).open };
}

/** Scripts written without spaces (Han, kana), CJK punctuation (U+3000–303F) and full-width forms
 *  (U+FF00–FFEF): no space is wanted between two rows there, which is what the shipped joiners give. */
// Re-review nit: full-width forms WITHOUT full-width Latin (FF21–FF3A, FF41–FF5A) and half-width Hangul
// (FFA0–FFDC) — both are spaced scripts. Narrower than lane/POL-3's `delivery_spacing.rs` no-space set, which
// takes FF01–FF9F whole; aligned on Han / kana / CJK punctuation.
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF01-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\uFFE0-\uFFEE]/u;

/** Review C1: the last visible character a strip would leave is one the shipped joiners handle — ASCII
 *  (they add the space) or a no-space script (none is wanted). Anything else would be glued to the next row. */
export function joinSafeEnd(text: string): boolean {
  const last = [...text.trimEnd()].pop();
  return last !== undefined && (last.charCodeAt(0) < 0x80 || NO_SPACE_SCRIPT.test(last));
}

/**
 * What a mid-speech row cut does with the row's end. `open`: the vendor's 「not finished」 mark is there
 * and is not after a dictated command — the cut landed mid-phrase (what `stt.cut` logs). `stripped`: the
 * mark was taken off, which also needs {@link joinSafeEnd}. `text`: the row as it leaves.
 */
export function repairRowEnd(text: string, language: string): { text: string; open: boolean; stripped: boolean } {
  const r = stripOpenSeam(text);
  if (!r.open || trailingDictatedCommand(text, language) !== null) return { text, open: false, stripped: false };
  return joinSafeEnd(r.text) ? { text: r.text, open: true, stripped: true } : { text, open: true, stripped: false };
}

/** A trailing dash run on the terminal final of an engine whose final is written by our end-of-stream: Soniox's
 *  zero-length closing token (EVAL-1 en-con-01 「…until it is」+「—」, a finished sentence). Dropped, so the
 *  normalizer closes the sentence as on any terminal final (「until it is.」). Kept after a dictated command and
 *  on every other engine. */
export function dropTerminalDash(text: string, flushCloses: boolean, language: string): string {
  if (!flushCloses) return text;
  const end = text.trimEnd().length;
  const run = /—+$/u.exec(text.slice(0, end));
  if (run === null || text.slice(0, run.index).trim() === '' || trailingDictatedCommand(text, language) !== null) return text;
  return text.slice(0, run.index) + text.slice(end);
}

/**
 * The ONE holder of 「the last row this recording delivered ended open」 (D-12: one writer, one
 * reader). Written at each row cut ({@link cutRow}); read and cleared by the next final that
 * carries words ({@link head}) — a segment final or the terminal one. Lives on the orchestrator.
 */
export class OpenSeamCarry {
  /** The segment index of the last row whose open mark was stripped, until a final with words continues it. */
  private openIdx: number | null = null;
  /** What the last {@link cutRow} decided, for its `stt.cut` line: null when the rule did not apply. */
  private lastCutOpen: boolean | null = null;
  /** Whether the last {@link cutRow} took the mark off (its row's internal `seam_open`). */
  private lastCutStripped = false;

  /** A row's text as it leaves at a row cut: `seamText`, then (flush-closing engines, mid-speech
   *  cuts) the open-mark strip; remembers whether the next row continues an open phrase. */
  cutRow(text: string, reason: SegmentCutReason, flushCloses: boolean, language: string, segmentIdx: number): string {
    const seamed = seamText(text, reason);
    if (!flushCloses || !isMidSpeechRowCut(reason)) { this.openIdx = null; this.lastCutOpen = null; this.lastCutStripped = false; return seamed; }
    const r = repairRowEnd(seamed, language);
    this.lastCutOpen = r.open; this.lastCutStripped = r.stripped;
    if (seamed.trim() !== '') this.openIdx = r.stripped ? segmentIdx : null; // an empty row leaves an open phrase open; a kept mark is not continued
    return r.text;
  }

  /** Review P5 / F2 — a row SEAM-2 leaves alone (a long recording, a recovery leg): today's `seamText`, and an
   *  open phrase before it is not carried past it. Review F1: the cut is still MEASURED — `logField` says whether
   *  it landed mid-phrase, exactly as {@link cutRow} would, with nothing stripped. */
  untouchedRow(text: string, reason: SegmentCutReason, flushCloses: boolean, language: string): string {
    const seamed = seamText(text, reason);
    if (text.trim() !== '') this.openIdx = null;
    this.lastCutOpen = flushCloses && isMidSpeechRowCut(reason) ? repairRowEnd(seamed, language).open : null;
    this.lastCutStripped = false;
    return seamed;
  }

  /** The internal field on the next final with words: `seam_from` = the stripped row it continues. The bridge
   *  lower-cases (`engine/stt-session-seam.ts`) only once it has DELIVERED that row and the delivered text does
   *  not end a sentence. An empty final does not consume the fact. Read BEFORE {@link cutRow} on the same row. */
  continuation(text: string): { seam_from?: number } {
    if (this.openIdx === null || text.trim() === '') return {};
    const from = this.openIdx;
    this.openIdx = null;
    return { seam_from: from };
  }

  /** `stt.cut` field for the row cut that just emitted (see {@link seamOpenLogField}). */
  logField(): { seam_open?: boolean } {
    return this.lastCutOpen === null ? {} : { seam_open: this.lastCutOpen };
  }

  /** The internal field on that row's `final` for the bridge's polish exit ({@link keepOpenEnd}): present
   *  only when the cut stripped. The bridge builds its wire frame field by field; this never goes out. */
  finalField(): { seam_open?: true } {
    return this.lastCutStripped ? { seam_open: true } : {};
  }
}
