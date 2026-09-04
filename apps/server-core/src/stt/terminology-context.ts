// SPEC-REF:
//   docs/strategy/2026-08-07-rt6-soniox-tradeoff-cards.md (the `context` card —
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
  const seen = new Set<string>();
  const kept: string[] = [];
  let budget = SONIOX_CONTEXT_MAX_CHARS - CONTEXT_PREFACE.length - 1;
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length === 0 || seen.has(term)) continue;
    // +2 for the ', ' that will join it (the first one is over-charged by 2,
    // which keeps the arithmetic obviously safe rather than exactly tight).
    const cost = term.length + 2;
    if (cost > budget) break;
    seen.add(term);
    kept.push(term);
    budget -= cost;
  }
  if (kept.length === 0) return undefined;
  return `${CONTEXT_PREFACE} ${kept.join(', ')}`;
}
