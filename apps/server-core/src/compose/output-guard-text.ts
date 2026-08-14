// 800-line cap (`verify/lint/file-size.mjs` SRC_MAX): the text-measurement
// primitives moved VERBATIM out of `output-guard.ts`, which had reached the cap.
//
// 🔴 NOTHING HERE CHANGED BEHAVIOUR. Every declaration below — body, comment and
// regex — is byte-for-byte what it was in `output-guard.ts`, with exactly ONE
// mechanical edit, listed so the claim stays checkable:
//   (1) each declaration gained the `export` keyword, because a sibling module
//       cannot see file-private symbols. No name, order or body changed.
// **Any diff beyond that one is a bug.**
//
// 🔴 AMENDED (2026-08-08). The paragraph above is kept verbatim because it is
// still true OF THE DECLARATIONS IT WAS WRITTEN ABOUT — but it is no longer true
// of this file as a whole, and leaving it unqualified would make it the repo's
// named "stale truth" shape: a sentence that was true, read later as current.
// Three declarations below were AUTHORED HERE, not moved, and are marked
// "ADDED 2026-08-08" individually: `CJK_SCRIPT_RE`, `sentenceCount`, and
// `properNounShape`. They are measurements, not decisions — see the contract
// note at the end of this header, which they were written to obey.
//
// WHY THIS SET AND NOT SOME OTHER SET: this cut was drawn by the file's own
// section headers, not invented. `output-guard.ts` already separated
// "─── script classification ───" and "─── normalisation helpers ───" from the
// rule blocks below them, and together they answer ONE question — "how do we
// measure a string?" — while every remaining section answers "is THIS output
// deliverable?". Nothing here knows what a ComposeGuardTask is, and nothing here
// may ever decide anything: a rule that lives in this file would be a second
// place to look for the answer to a question `output-guard.ts` owns.
//
// The public surface of the guard is unchanged and still lives in
// `output-guard.ts` (`guardComposeOutput`, `describeGuardRejection`,
// `COMPOSE_OUTPUT_REJECTED_CODE`, `ComposeOutputRejectedError`); no caller,
// test, or `verify/eval/run-eval.mjs` import path moves.

// ─── script classification ──────────────────────────────────────────────────

export const HAN_RE = /\p{Script=Han}/u;
export const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
export const HANGUL_RE = /\p{Script=Hangul}/u;
export const LATIN_RE = /\p{Script=Latin}/u;
export const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

export type ScriptClass = 'han' | 'japanese' | 'hangul' | 'latin' | 'cyrillic';

/**
 * Which script a translation into this language must actually be written in.
 *
 * Only languages whose script is unambiguous are listed. An unlisted or absent
 * target means the script rules DO NOT FIRE — a guard that guesses at a language
 * it does not know would reject correct work, and silence is the safe direction.
 */
export function scriptClassFor(lang: string | undefined): ScriptClass | null {
  if (!lang) return null;
  const l = lang.trim().toLowerCase().replace(/_/g, '-');
  const base = l.split('-')[0] ?? '';
  if (base === 'zh') return 'han';
  if (base === 'ja') return 'japanese';
  if (base === 'ko') return 'hangul';
  if (base === 'ru' || base === 'uk' || base === 'bg' || base === 'sr') return 'cyrillic';
  if (['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'fi', 'pl', 'cs', 'tr', 'id', 'ms', 'vi', 'ro', 'hu'].includes(base)) {
    return 'latin';
  }
  return null;
}

export function hasScript(s: string, cls: ScriptClass): boolean {
  switch (cls) {
    case 'han': return HAN_RE.test(s);
    // Japanese legitimately runs from all-kanji (short nominal phrases) to
    // all-kana, so either satisfies "this was written in Japanese".
    case 'japanese': return HAN_RE.test(s) || KANA_RE.test(s);
    case 'hangul': return HANGUL_RE.test(s);
    case 'latin': return LATIN_RE.test(s);
    case 'cyrillic': return CYRILLIC_RE.test(s);
  }
}

export function countMatching(s: string, re: RegExp): number {
  let n = 0;
  for (const ch of s) if (re.test(ch)) n += 1;
  return n;
}

/** Letters of any of the scripts we can reason about. Digits and punctuation
 *  are excluded on purpose: they carry no evidence about which language a text
 *  is written in. */
export function letterCount(s: string): number {
  return countMatching(s, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Latin}\p{Script=Cyrillic}]/u);
}

// ─── normalisation helpers ──────────────────────────────────────────────────

export const WS_PUNCT_RE = /[\s　-〿＀-￯!-/:-@[-`{-~‘’“”]/gu;

/** Content-only form: punctuation and whitespace removed, case folded. Used for
 *  the echo test, where "the model returned the input" must not be defeated by
 *  a single added full stop. */
export function normalizeForEcho(s: string): string {
  return s.replace(WS_PUNCT_RE, '').toLowerCase();
}

export function cpLen(s: string): number {
  return [...s].length;
}

// ─── ADDED 2026-08-08 (not moved) ───────────────────────────────────────────
//
// The three declarations below were authored in this file rather than in
// `output-guard.ts`, and they obey this file's contract: each answers "how do we
// measure a string?" and none of them decides anything. Every one returns a
// count or a shape verdict about ONE string; which rule consults them, and what
// a given answer licenses, stays in `output-guard.ts`.

/** The CJK scripts, as one character class. Previously written inline at the
 *  `properNounShape` call site; named here because two rules now consult it. */
export const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Sentence-terminal marks, both scripts. A bare `.` counts only before
 *  whitespace or end-of-string, so decimals ("3.5") and abbreviations inside a
 *  word are not miscounted as sentence ends. */
export const SENTENCE_END_RE = /[。！？!?…]|\.(?=\s|$)/gu;

/**
 * How many sentences this text is written as.
 *
 * Deliberately counts TERMINAL marks only — commas and semicolons are not
 * sentence ends, so "A blessing in disguise; what seems bad may turn out to be
 * good." is ONE sentence, which is what a reader would say too.
 */
export function sentenceCount(s: string): number {
  return (String(s).match(SENTENCE_END_RE) ?? []).length;
}

/**
 * Words that may appear uncapitalised INSIDE an English proper-noun phrase
 * ("Bank of America", "The Hague"). Kept tiny on purpose: every addition widens
 * `properNounShape`, and that predicate switches script rules off.
 */
const PROPER_NOUN_PARTICLES: ReadonlySet<string> = new Set([
  'of', 'the', 'and', 'for', 'on', 'in', 'at', 'de', 'du', 'da', 'la', 'le', 'van', 'von', 'der',
]);

/**
 * Does this string have the SHAPE of a proper-noun phrase — a name that may
 * legitimately survive translation unchanged ("FlowMic", "New York Times")?
 *
 * 🔴 WHY THIS IS NOT "contains no whitespace", which is what it used to be.
 * That test was written to stop a whole echoed Chinese SENTENCE from being
 * exempted, and it does — but Chinese is written without spaces, so the
 * whitespace clause was never the thing doing that work; `cjk === 0` was, and it
 * still is. What the whitespace clause actually excluded was every proper noun
 * made of more than one word: "New York Times", "Windows Update", "Visual Studio
 * Code". Measured 2026-08-08 on dev-pc-a — 4 corpus false rejects, on
 * BOTH consuming rules (`target_script_absent` for a non-Latin target,
 * `untranslated_echo` for a Latin one), so fixing one alone left the other live.
 *
 * The replacement asks what a multi-word proper noun actually looks like, and
 * every clause is load-bearing against an echoed SENTENCE:
 *   · no CJK — the original sentence-echo defence, unchanged;
 *   · short (`<= 24` code points) — this alone already excludes every echoed
 *     sentence in the corpus today, the shortest of which is 48 characters;
 *   · at most `MAX_TOKENS` words;
 *   · every word is capitalised (or is a listed particle), and at least one word
 *     really is capitalised. A dictated sentence is not written in title case,
 *     so "tell me a joke" (14 chars, 4 tokens) is rejected on this clause alone.
 */
const PROPER_NOUN_MAX_TOKENS = 4;
const PROPER_NOUN_MAX_CHARS = 24;

export function properNounShape(s: string): boolean {
  const t = s.trim();
  if (t === '' || cpLen(t) > PROPER_NOUN_MAX_CHARS) return false;
  if (CJK_SCRIPT_RE.test(t)) return false;
  const tokens = t.split(/\s+/u).filter((w) => w !== '');
  if (tokens.length === 0 || tokens.length > PROPER_NOUN_MAX_TOKENS) return false;
  // A single token keeps its historical behaviour — no capitalisation demanded.
  // "flowmic" echoed back is the innocent case this exemption was built for, and
  // tightening it here would be an unrelated regression riding along.
  if (tokens.length === 1) return true;
  let sawCapital = false;
  for (const w of tokens) {
    const first = [...w][0] ?? '';
    if (first !== '' && first === first.toUpperCase() && first !== first.toLowerCase()) {
      sawCapital = true;
      continue;
    }
    if (!PROPER_NOUN_PARTICLES.has(w.toLowerCase())) return false;
  }
  return sawCapital;
}
