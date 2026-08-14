// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §5 (final pipeline stage 2 —
//     final-text-normalizer F-2249: trim + strip CJK spoken-language filler
//     words + CJK whitespace normalization + only the utterance-closing final
//     gets terminal punctuation added; no LLM)
//   Ported VERBATIM from legacy apps/server/src/stt/final-text-normalizer.ts
//     (mechanism unchanged from the legacy line, F-2249). Porting takes priority
//     over rewriting: this is the proven grooming — the
//     rules, regexes and the terminal-punctuation heuristics are the legacy
//     implementation, not a re-derivation. Divergence from the 06 summary: NONE
//     (legacy IS the contract; 06 §5 is its summary).
//
// Pure text grooming for FINAL transcript spans. Sits AFTER the deterministic
// dictionary pass (stage 1) and BEFORE wire fan-out / history persisted to the DB (stage 3).
// No LLM, no I/O, no clock — a bounded set of regex passes. Terminal punctuation
// is added ONLY for the utterance-closing final (`ensureTerminalPunctuation`);
// soft-segment finals get trim + disfluency + whitespace grooming but are NEVER
// force-closed with a sentence terminator (06 §2.2 soft segmentation).

export interface FinalTextNormalizeOptions {
  language?: string;
  /** True only for the terminal utterance final (`is_segment=false`). */
  ensureTerminalPunctuation?: boolean;
}

const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// NOTE (faithful port): HAN ⊆ HAS_CJK, so the `|| HAN.test(out)` gate below is a
// provable no-op today. Kept verbatim from the legacy source rather than
// "improved" — porting takes priority over rewriting.
const HAN = /\p{Script=Han}/u;
const TERMINAL_PUNCT = /[。！？.!?…]$/u;
const PAUSE_PUNCT = /[，,、；;：:]$/u;
const CLOSERS = new Set(['"', "'", '”', '’', ')', '）', ']', '】', '}', '》', '」', '』']);

function hasCjk(text: string): boolean {
  return HAS_CJK.test(text);
}

function prefersCjkPunctuation(text: string, language?: string): boolean {
  if (hasCjk(text)) return true;
  if (/[A-Za-z]/.test(text)) return false;
  return language?.toLowerCase().startsWith('zh') === true;
}

function compactWhitespace(text: string): string {
  let out = text.replace(/　/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
  out = out.replace(/\s*([，。！？、；：])\s*/gu, '$1');
  out = out.replace(/(\p{Script=Han})\s+(\p{Script=Han})/gu, '$1$2');
  out = out.replace(/(\p{Script=Han})\s+([，。！？、；：])/gu, '$1$2');
  out = out.replace(/([，。！？、；：])\s+(\p{Script=Han})/gu, '$1$2');
  return out;
}

function stripDisfluencies(text: string): string {
  let out = text;
  out = out.replace(/^(?:[，,、\s]*(?:呃+|嗯+|额+|啊+))+[，,、\s]*/u, '');
  out = out.replace(/(?:[，,、]\s*)?(?:呃+|嗯+|额+|啊+)(?:\s*[，,、])?/gu, '');
  out = out.replace(/第([一二三四五六七八九十\d]+)个的话呢就是/gu, '第$1个，');
  out = out.replace(/(接下来|然后)(?:的话)?呢?就是/gu, '$1');
  out = out.replace(/的话呢/gu, '');
  out = out.replace(/呢就是/gu, '');
  out = out.replace(/([，。！？、；：]){2,}/gu, '$1');
  return out;
}

// ---------------------------------------------------------------------------
// English question detection (W4S ④).
//
// WHAT WAS HERE BEFORE, and why it was wrong:
//
//   /\b(who|what|when|where|why|how|is|are|can|could|should|would|do|does|did)\b/i
//
// An unanchored alternation: it fired on the mere PRESENCE of an auxiliary
// anywhere in the sentence. Measured over the W2 realtime corpus on
// dev-pc-a, 4 of the 11 English cases came back as questions that are
// not questions — "the server is excepting connections again?", "do not auto
// inject deferred messages?", "don't merge until the golden path is green?".
// Every English utterance-closing final goes through here and lands in the
// user's editor with no LLM after it (final-text-pipeline.ts: "realtime default
// is passthrough"; stt.polish is opt-in and defaults OFF).
//
// THE LINGUISTICS. English marks an interrogative POSITIONALLY, not lexically:
//   • wh-question     — a wh-word FRONTED to the start of the clause
//                       ("what time does it close" vs "I know what it costs")
//   • yes/no question — subject-auxiliary INVERSION at the start of the clause
//                       ("did you send it" vs "the invoice did arrive")
// An imperative is a bare verb in first position, which is why anchoring to the
// start is necessary but NOT sufficient: "do not forget the keys" and "have a
// look at the log" both begin with a word that is also an auxiliary. What
// separates them from a question is that inversion puts a SUBJECT immediately
// after the auxiliary, whereas an imperative puts the verb (or its negation).
//
// The CJK branch below is the reference shape (吗|嘛|么 anchored to $, question
// words limited to the last 6 characters) and is deliberately NOT touched.
//
// WHAT THIS STILL GETS WRONG, stated rather than hidden. Three shapes, all
// carried as `known_open` cases in verify/eval/cases/realtime.jsonl with a
// written reason each, and all pinned by
// test/final-text-terminal-punctuation-corpus.test.ts so they cannot rot into
// claims nobody re-checks:
//   • rt-q-007 declarative questions ("you already pushed the branch") — word
//     order identical to a statement, carried by intonation the engine does not
//     give us. Not fixable by a text-only rule at all.
//   • rt-q-008 tag questions ("…, right?") — the cue is sentence-FINAL, and
//     this rule is built entirely on the head of the clause.
//   • rt-decl-003 wh-exclamatives ("what a mess this migration is") — the only
//     FALSE POSITIVE left, and therefore the one worth watching: it rewrites a
//     statement into a question, where the other two merely omit a mark.
// Plus one deliberate trade, not a surprise: see EN_AUX_ALSO_IMPERATIVE below.
// ---------------------------------------------------------------------------

/** Discourse markers and fillers that speech opens with. They sit BEFORE the
 *  clause, so skipping them is what lets "so what do we do" still read as
 *  inverted. Deliberately excludes `now`/`then`/`also`/`right`: those front
 *  genuine statements with inversion after them ("now is the time to ship"),
 *  so treating them as skippable would invent questions. */
const EN_LEADERS = new Set([
  'so', 'and', 'but', 'ok', 'okay', 'well', 'hey', 'oh', 'um', 'uh', 'er', 'erm', 'hmm', 'yeah',
]);

/** Fronted wh-words. `how` included; `that`/`whether` deliberately not — they
 *  introduce complement clauses, never a direct question. */
const EN_WH = new Set(['who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how', 'which']);

/** Auxiliaries that can inverted with a subject. `be`/`been`/`being` are absent
 *  on purpose: they never invert ("be you ready" is not English) while "be
 *  careful with the migration" is a common imperative. */
const EN_AUX = new Set([
  'is', 'are', 'was', 'were', 'am',
  'do', 'does', 'did',
  'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  "isn't", "aren't", "wasn't", "weren't", "ain't",
  "doesn't", "don't", "didn't",
  "haven't", "hasn't", "hadn't",
  "can't", "couldn't", "won't", "wouldn't", "shouldn't", "shan't", "mustn't",
]);

/** The auxiliaries above that are ALSO bare-verb imperatives: "do the full
 *  rebuild", "have a look at the log". For these a determiner after the verb
 *  proves nothing, so only a pronoun subject counts as inversion.
 *
 *  🔴 THE COST, stated instead of hidden: "do the tests pass" and "have the
 *  tests passed" are real questions and this narrowing calls them statements.
 *  That trade is deliberate — in a voice-to-editor product the imperative
 *  reading of "do X" / "have X" is the far more common utterance, and the
 *  auxiliaries with no imperative form (does/did/has/had) keep the determiner
 *  path, so "does the token expire" and "has the build finished" still work. */
const EN_AUX_ALSO_IMPERATIVE = new Set(['do', "don't", 'have']);

/** Pronouns (and existential `there`) that can be the inverted subject. */
const EN_PRONOUN_SUBJECT = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'there',
  'this', 'that', 'these', 'those', 'one',
  'anyone', 'anybody', 'someone', 'somebody', 'everyone', 'everybody',
  'nobody', 'anything', 'something', 'everything', 'nothing',
]);

/** Determiners that open a noun-phrase subject ("is THE meeting still on"). */
const EN_DETERMINER_SUBJECT = new Set([
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'any', 'some', 'every', 'each', 'all', 'both', 'no', 'another', 'other',
  'this', 'that', 'these', 'those',
]);

/** Lowercase word tokens, keeping contractions whole ("don't" stays one token).
 *  Digits are skipped: they are never the head of a clause and a version string
 *  like "0.2.58" must not fragment the token stream. */
function englishTokens(body: string): string[] {
  return body.toLowerCase().replace(/’/gu, "'").match(/[a-z]+(?:'[a-z]+)?/gu) ?? [];
}

/**
 * True when `body` reads as a direct English question — decided by POSITION
 * (fronted wh-word, or subject-auxiliary inversion), never by the presence of
 * a keyword somewhere in the middle.
 */
function isEnglishQuestion(body: string): boolean {
  const toks = englishTokens(body);
  let i = 0;
  while (i < toks.length && EN_LEADERS.has(toks[i]!)) i += 1;
  const head = toks[i];
  if (head === undefined) return false;

  if (EN_WH.has(head)) return true; // fronted wh-word
  if (!EN_AUX.has(head)) return false; // no auxiliary in first position ⇒ no inversion

  // Inversion requires a SUBJECT after the auxiliary. A negator may sit between
  // them in a question ("did not you…" is archaic but "don't you think" is not),
  // so step over it before looking — that step is also what keeps the imperative
  // "do not auto inject…" from finding `not` and calling it a subject.
  let j = i + 1;
  if (toks[j] === 'not' || toks[j] === 'never') j += 1;
  const subject = toks[j];
  if (subject === undefined) return false;

  if (EN_PRONOUN_SUBJECT.has(subject)) return true;
  // "do"/"have" are imperatives too, so a determiner cannot settle it.
  if (EN_AUX_ALSO_IMPERATIVE.has(head)) return false;
  return EN_DETERMINER_SUBJECT.has(subject);
}

function chooseTerminal(body: string, cjk: boolean): string {
  if (cjk) {
    if (/(吗|嘛|么)$/u.test(body)) return '？';
    if (/(什么|为什么|怎么|如何|哪里|哪儿|谁|是否|能不能|可不可以|有没有)[^。！？]{0,6}$/u.test(body)) {
      return '？';
    }
    return '。';
  }
  return isEnglishQuestion(body) ? '?' : '.';
}

function withTerminalPunctuation(text: string, language?: string): string {
  if (text.length === 0) return text;

  let body = text;
  let suffix = '';
  while (body.length > 0 && CLOSERS.has(body[body.length - 1]!)) {
    suffix = `${body[body.length - 1]!}${suffix}`;
    body = body.slice(0, -1);
  }
  if (body.length === 0 || TERMINAL_PUNCT.test(body)) return `${body}${suffix}`;

  const cjk = prefersCjkPunctuation(body, language);
  const mark = chooseTerminal(body, cjk);
  if (PAUSE_PUNCT.test(body)) body = body.replace(PAUSE_PUNCT, mark);
  else body = `${body}${mark}`;
  return `${body}${suffix}`;
}

/**
 * Groom a FINAL transcript span (F-2249). Order: compact whitespace → strip CJK
 * disfluencies (only when the span carries Han) → compact again → (terminal only)
 * ensure a sentence terminator. Empty / non-string input is returned unchanged.
 */
export function normalizeFinalText(
  text: string,
  opts: FinalTextNormalizeOptions = {},
): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = compactWhitespace(text);
  if (hasCjk(out) || HAN.test(out)) out = stripDisfluencies(out);
  out = compactWhitespace(out);
  if (opts.ensureTerminalPunctuation === true) {
    out = withTerminalPunctuation(out, opts.language);
  }
  return out;
}
