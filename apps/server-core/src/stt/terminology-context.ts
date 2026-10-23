// SPEC-REF:
//   docs/archive/strategy/2026-08-07-rt6-soniox-tradeoff-cards.md (the `context` card —
//     ≤10,000 chars, and its warning that this is NOT a one-line reuse of
//     hotwords.ts: same INPUT data, different OUTPUT wire format per engine)
//   https://soniox.com/docs/api-reference/stt/websocket-api (`context`)
//   apps/server-core/src/stt/hotwords.ts (the FunASR sibling — `{term:weight}`)
//
// THE SECOND TERMINOLOGY DESTINATION.
//
// The three terminology sources (scenario-card terms, dictionary packs,
// the retired personal dictionary) have always been resolved for every engine. Only FunASR was
// ever TOLD about them: `withHotwords` handed the payload to `funasr` and
// stripped it for everyone else, which is correct — a `{term:weight}` JSON
// string means nothing to a vendor that does not parse it — but it left the
// production engine (Soniox) receiving no terminology at all. A user's personal
// dictionary could only ever repair a word AFTER it had been misheard.
//
// Soniox takes a `context` string instead: free text describing what is about to
// be said. So the same rules produce a different artefact here, and that is why
// this file exists rather than a second branch inside hotwords.ts — one function
// producing two incompatible wire formats is the shape this repo keeps paying
// for.
//
// 🔴 WHAT THIS CANNOT CLAIM. The RT-6 card is explicit that `context`'s value —
// "the jargon is right AT THE RECOGNITION LAYER instead of repaired afterwards"
// — is only measurable against AUDIO containing those terms, and the resident
// eval corpus is text that is already correctly transcribed. So the acceptance
// for this file is "the field is assembled correctly and reaches the wire",
// which is what its tests assert. Whether recognition improves is 未测量 and
// belongs to the multilingual STT benchmark project, which owns an audio bed.
// Do not let a green test here be read as a quality result.
//
// ⚠️ CORRECTION (card CTX-1, 2026-10-13): the paragraph above is no longer
// current — it has since been measured on audio. scripts/eval/speech-quality
// (EVAL-1 baseline and CTX-1) streamed TTS jargon through the product's Soniox
// adapter with and without this string: English jargon WER 7.4% -> 3.7% with
// the user's terms, and the coding default list's numbers are on
// CODING_DEFAULT_TERMS_CAP (stt/coding-terms.ts). The tests still assert
// assembly only; the measurement lives in the harness, not here. The same
// stale 【未测量】 note in packages/stt-cloud/src/engines/soniox-config-frame.ts
// is left for the owner of that package.

/** Soniox's documented ceiling for `context`. Truncation is by TERM, never
 *  mid-term: half a word is not a hint, and a dangling fragment is the kind of
 *  input a vendor is entitled to interpret however it likes. */
export const SONIOX_CONTEXT_MAX_CHARS = 10_000;

/** The lead-in. It states what the list IS, because `context` is free text and a
 *  bare comma-separated list of nouns is ambiguous between "these words will be
 *  spoken" and "transcribe only these words". */
const CONTEXT_PREFACE = 'Terms and names likely to be spoken:';

/**
 * Assemble the Soniox `context` value from the session's canonical terms.
 *
 * Returns `undefined` for an empty set rather than an empty string: absent and
 * "present but empty" are different frames, and a vendor is free to treat the
 * second as a constraint. The one is honest, the other is a guess.
 *
 * Aliases are deliberately NOT included. `context` biases what the recognizer is
 * listening FOR; an alias is a wrong spelling we want mapped away afterwards, so
 * feeding it here would ask the engine to produce exactly the string the
 * deterministic replacer exists to remove.
 */
export function buildSonioxContext(terms: readonly string[]): string | undefined {
  return assembleSonioxContext(terms).context;
}

/** Card CTX-1 — which list(s) a session's `context` was built from. Logged
 *  (never the terms themselves) so a reader can tell "the user had no
 *  dictionary" from "the default was added" from "nothing was sent". */
export type SonioxContextSource = 'none' | 'user' | 'default:coding' | 'both' | 'dictation';

/**
 * Card ML-2 — dictated punctuation command words, told to the recognizer in a
 * session whose spoken language is the key. Japanese only, because only there
 * did it help: with no context Soniox wrote てん as 天 and 改行 as 開業 (ML-0;
 * the polish cannot turn 開業 back into a line break), and with these six words
 * both ja spoken-punctuation items came back as the command words in two runs
 * out of two while the 17 other Japanese items went from 13 to 11 edits, none
 * worse (.local/eval-speech/ml2-stt-{hints,dictation}-ja{,-r2}.jsonl).
 * Spanish was tried and NOT adopted: "dos puntos" stopped coming back as
 * "2 puntos", but the English word "staging" in the same item became "esta
 * agenda" in two runs of three. Korean was already recognized without it.
 */
const DICTATION_CONTEXT_TERMS: Readonly<Record<string, readonly string[]>> = {
  ja: ['てん', 'まる', '改行', 'はてな', '句点', '読点'],
};

/** The dictation command words for a session language, or none. */
export function dictationContextTerms(language: string | undefined): readonly string[] {
  const base = language?.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
  return DICTATION_CONTEXT_TERMS[base] ?? [];
}

export interface SonioxContextAssembly {
  /** The wire value, or undefined when nothing survived (absent, never ''). */
  context: string | undefined;
  source: SonioxContextSource;
  /** Terms actually written into `context`, per origin. */
  userTerms: number;
  defaultTerms: number;
  /** Card ML-2: dictation command words (dictationContextTerms). */
  dictationTerms: number;
  chars: number;
}

/** A default list appended AFTER the user's own terms. `cap` is the total term
 *  count (user + default) the default may fill up to; it never removes a user
 *  term — those are only ever cut by the vendor's character ceiling. */
export interface SonioxDefaultTerms {
  category: 'coding';
  terms: readonly string[];
  cap: number;
}

/**
 * Assemble the Soniox `context` from the user's terms, optionally followed by a
 * category default list (card CTX-1). Same rules for both: trimmed, deduped
 * across the two lists (a user term the default also carries is counted once,
 * as the user's), truncated by whole term under SONIOX_CONTEXT_MAX_CHARS.
 * With no `defaults` this is byte-identical to the pre-CTX-1 builder.
 */
export function assembleSonioxContext(
  terms: readonly string[],
  defaults?: SonioxDefaultTerms,
  dictation: readonly string[] = [],
): SonioxContextAssembly {
  const seen = new Set<string>();
  const kept: string[] = [];
  let budget = SONIOX_CONTEXT_MAX_CHARS - CONTEXT_PREFACE.length - 1;
  // Returns false once the character ceiling is reached: truncation is by
  // TERM, and nothing after the first term that does not fit is considered.
  const take = (raw: string): boolean => {
    const term = raw.trim();
    if (term.length === 0 || seen.has(term)) return true;
    // +2 for the ', ' that will join it (the first one is over-charged by 2,
    // which keeps the arithmetic obviously safe rather than exactly tight).
    const cost = term.length + 2;
    if (cost > budget) return false;
    seen.add(term);
    kept.push(term);
    budget -= cost;
    return true;
  };
  let full = false;
  for (const raw of terms) if (!take(raw)) { full = true; break; }
  const userTerms = kept.length;
  // Card ML-2: after the user's own terms, before the category default.
  if (!full) for (const raw of dictation) if (!take(raw)) { full = true; break; }
  const dictationTerms = kept.length - userTerms;
  if (defaults !== undefined && !full) {
    for (const raw of defaults.terms) {
      if (kept.length >= defaults.cap) break;
      if (!take(raw)) break;
    }
  }
  const defaultTerms = kept.length - userTerms - dictationTerms;
  // `dictation` is named only when it is the only list; with the others it is
  // counted in `dictationTerms`, so 'user' / 'both' keep their meaning.
  const source: SonioxContextSource = userTerms > 0
    ? (defaultTerms > 0 ? 'both' : 'user')
    : (defaultTerms > 0 ? `default:${defaults!.category}` : dictationTerms > 0 ? 'dictation' : 'none');
  if (kept.length === 0) return { context: undefined, source, userTerms, defaultTerms, dictationTerms, chars: 0 };
  const context = `${CONTEXT_PREFACE} ${kept.join(', ')}`;
  return { context, source, userTerms, defaultTerms, dictationTerms, chars: context.length };
}
