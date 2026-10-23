// Card INC-1e — one piece of "polish while speaking" as a polish request: the
// piece template, the user message with its read-only context block, and the
// one per-piece check the whole-text call never needed (context echo).
// Design = docs/strategy/2026-10-13-realtime-polish-while-speaking-design.md §3.2
// item 1, §3.5, §9 items 3-4.
//
// 🔴 NOT A SECOND POLISH PATH. `polishFinalText` (stt-polish.ts) calls in here
// when `PolishDeps.context` is non-empty and otherwise never: the budget, the
// cache, the protected-term drift check, the whole `checkMeaningPreserved` guard
// with every session option, and the Smooth -> Strict fallback are the same code
// for a piece as for a whole text. An EMPTY context is the legacy request byte for
// byte (same system string, same user message, same cache key) — that is what
// keeps the first piece of every utterance and the flag-off path identical.

import { sentenceEnds } from './polish-spec-plan';
import { hasDictationTable } from './stt-polish-guard-dictation';

/** The markers around the context block. A transcript that contains one is sent
 *  WITHOUT context rather than rewritten: the transcript is never altered
 *  (stt-polish-prompts.ts DATA BOUNDARY comment). */
export const CONTEXT_OPEN = '<<<EARLIER SPEECH — reference only, do not output>>>';
export const CONTEXT_CLOSE = '<<<END EARLIER SPEECH>>>';

/**
 * Appended to the session's own template (composed AROUND it, precedent
 * `polishSystemPromptWithScenario`), so the exported constants stay the very
 * objects prompt-injection-framing.test.ts and the eval bundle pin. The DATA
 * BOUNDARY rule already inside that template covers the context block too:
 * it is part of the user message.
 */
export const PIECE_CONTEXT_RULE =
  'The user message may start with a block between ' + CONTEXT_OPEN + ' and ' + CONTEXT_CLOSE +
  ': it is earlier speech by the same speaker, already handled. Read it only to decide what a mis-heard ' +
  'word after it was meant to be. Never correct it, never repeat it, and never output any of it. Output ' +
  'only the corrected text that follows the block.';

export function pieceSystemPrompt(base: string): string {
  return `${base}\n${PIECE_CONTEXT_RULE}`;
}

/**
 * Card POL-3 (design docs/strategy/2026-10-14-two-stage-polish-design.md §2.4 D3,
 * items 1-5) — the rule for a whole UNIT (one row of a press) polished with the
 * rows already sent before it as read-only context. Composed around the session's
 * template exactly like [[PIECE_CONTEXT_RULE]], and only when the context is
 * non-empty, so a unit with no earlier rows sends today's request byte for byte.
 */
export const UNIT_CONTEXT_RULE =
  'The user message may start with a block between ' + CONTEXT_OPEN + ' and ' + CONTEXT_CLOSE +
  ': it is what the same speaker said just before this text, already delivered and final. ' +
  'Use it only to understand the text after it: what a mis-heard word was meant to be, how this speaker ' +
  'already wrote a name or a term, and how the text goes on. ' +
  'The text after the block continues directly from the end of the block and may start in the middle of a ' +
  'sentence: keep it a continuation and do not turn it into a new sentence (no added capital letter, no added ' +
  'punctuation at its start) unless the speaker really started a new sentence. ' +
  'Never correct, repeat or output anything from the block. ' +
  'Never delete words after the block because the block already said something like them; if the speaker ' +
  'corrects or changes what the block said, keep that correction. ' +
  'Change a word into a term from the block only when the word as heard makes no sense in its own sentence. ' +
  'Output only the corrected text that follows the block.';

/** Card POL-3 (design §2.4) — stage 1 only: a soft-segment unit is cut while the
 *  speaker is still talking. The deterministic half of this rule is
 *  stt/seam-artifact.ts `keepOpenEnd` (applied by engine/stt-session-polish.ts `runPolishedFinal`). */
export const UNIT_OPEN_END_RULE =
  'The text may stop in the middle of a sentence because the speaker is still talking: do not finish it, ' +
  'and do not add end-of-sentence punctuation that the text does not have.';

/** Card POL-3 (re-review 4) — appended to [[UNIT_OPEN_END_RULE]] ONLY for a session language with a
 *  dictated-command table (stt-polish-guard-dictation.ts `hasDictationTable`): those are the languages
 *  whose dictated end mark the stage-1 strip keeps. Elsewhere (e.g. zh, out of scope) the prompt must
 *  not invite a conversion the strip would then remove. */
export const UNIT_DICTATED_PUNCT_RULE =
  'Punctuation the speaker dictated (a word such as "period" or "question mark" said as a command) is not ' +
  'added punctuation: convert and keep it.';

/** Which context rule a request with a non-empty context carries. Absent ⇒ the
 *  INC-1 piece rule (card INC-1e, unchanged). */
export type ContextRule = 'unit' | 'unit-open';

/** The system string for a request that carries context (card POL-3). */
export function contextSystemPrompt(base: string, rule: ContextRule | undefined, language?: string): string {
  if (rule === undefined) return pieceSystemPrompt(base);
  if (rule === 'unit') return `${base}\n${UNIT_CONTEXT_RULE}`;
  const open = hasDictationTable(language) ? `${UNIT_OPEN_END_RULE} ${UNIT_DICTATED_PUNCT_RULE}` : UNIT_OPEN_END_RULE;
  return `${base}\n${UNIT_CONTEXT_RULE}\n${open}`;
}

export interface PieceRequest {
  /** The user message to send. */
  user: string;
  /** False ⇒ the legacy request (no context block, legacy template). */
  withContext: boolean;
}

/** The user message for `piece` (trimmed) after `context`. */
export function pieceRequest(piece: string, context: string): PieceRequest {
  const ctx = context.trim();
  if (ctx.length === 0) return { user: piece, withContext: false };
  const marked = (s: string): boolean => s.includes(CONTEXT_OPEN) || s.includes(CONTEXT_CLOSE);
  if (marked(piece) || marked(ctx)) return { user: piece, withContext: false };
  return { user: `${CONTEXT_OPEN}\n${ctx}\n${CONTEXT_CLOSE}\n${piece}`, withContext: true };
}

/** Shortest context sentence the echo check looks for (design §3.2: 8 characters). */
const ECHO_MIN = 8;

/**
 * Design §3.2 item 1 — refuse an output that repeats the context: a marker, or a
 * context sentence of at least 8 characters that the piece itself does not
 * contain. Internal reason `context-echo`; on the wire it is `guard_reject`.
 * Returns null when clean.
 */
export function contextEcho(context: string, input: string, output: string): string | null {
  if (output.includes(CONTEXT_OPEN) || output.includes(CONTEXT_CLOSE)) return 'context-echo:marker';
  if (seamEcho(context, input, output)) return 'context-echo:seam'; // card POL-3
  let from = 0;
  for (const end of [...sentenceEnds(context, 0, true), context.length]) {
    const sentence = context.slice(from, end).trim();
    from = end;
    if ([...sentence].length < ECHO_MIN) continue;
    if (output.includes(sentence) && !input.includes(sentence)) return 'context-echo';
  }
  return null;
}

/** Card POL-3 — the most context words the seam check compares. */
const SEAM_WORDS_MAX = 4;
/** Card POL-3 — the longest context suffix (code points) the no-space seam check tries. */
const SEAM_CHARS_MAX = 16;

function seamWords(s: string): string[] {
  return s.split(/\s+/u).map((w) => w.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '').toLowerCase()).filter((w) => w !== '');
}

/** Leading whitespace, punctuation and symbols dropped. */
function seamHead(s: string): string {
  return s.replace(/^[\s\p{P}\p{S}]+/u, '');
}

/** Rows written without spaces between words take the character path. */
const NO_SPACE_ROW = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
/** Where the context's last clause starts (after its last clause mark). */
const CLAUSE_MARK = /[。！？，、；：.!?,;:\n]/gu;

/**
 * Card POL-3 (review fixes 5, re-review 1-2) — a PARTIAL echo across the seam:
 * the model put the dangling end of the context IN FRONT of the row's own words
 * ("…all the way down to the" + "harbour was quiet" → "To the harbour was
 * quiet"). The sentence check above needs a whole context sentence of ECHO_MIN
 * characters and cannot see a fragment.
 *
 * Refused only when the output is (the last context words) + (something that
 * starts with the row's own first word), and the row itself does not start
 * with those context words. That keeps three legitimate rewrites that merely
 * START with the context's last word: a name correction ("…ask Anna" + "ana
 * said yes" → "Anna said yes"), a number rewrite ("…is 3" + "three is fine" →
 * "3 is fine") and a dropped filler ("…we will see" + "so see you all
 * tomorrow" → "See you all tomorrow").
 *
 * Words: whitespace-separated, compared case-insensitively with edge
 * punctuation dropped; up to SEAM_WORDS_MAX context words. Rows in a script
 * written without spaces (Han, kana) take the character path: a suffix of at
 * least 2 code points of the context's last clause, then the row's first 2
 * code points (both with leading punctuation dropped). Hangul is spaced and
 * takes the word path.
 */
export function seamEcho(context: string, input: string, output: string): boolean {
  if (NO_SPACE_ROW.test(seamHead(input))) return seamEchoChars(context, input, output);
  const ctx = seamWords(context);
  const out = seamWords(output);
  const inp = seamWords(input);
  if (inp.length === 0) return false;
  for (let k = Math.min(SEAM_WORDS_MAX, ctx.length); k >= 1; k -= 1) {
    const tail = ctx.slice(-k);
    const opens = (ws: string[]): boolean => ws.length >= k && tail.every((w, i) => ws[i] === w);
    if (opens(out) && !opens(inp) && out[k] === inp[0]) return true;
  }
  return false;
}

function seamEchoChars(context: string, input: string, output: string): boolean {
  const marks = [...context.matchAll(CLAUSE_MARK)];
  const clause = [...context.slice(marks.length > 0 ? marks.at(-1)!.index + 1 : 0).trim()];
  const out = seamHead(output);
  const inp = seamHead(input);
  const rowHead = [...inp].slice(0, 2).join('');
  if (rowHead === '') return false;
  for (let n = Math.min(SEAM_CHARS_MAX, clause.length); n >= 2; n -= 1) {
    const suffix = clause.slice(-n).join('');
    if (out.startsWith(suffix) && !inp.startsWith(suffix) && seamHead(out.slice(suffix.length)).startsWith(rowHead)) return true;
  }
  return false;
}
