// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d
//   CLAUDE.md red lines: no silent failure (both directions) / R11 「the layer
//   making the judgement must HOLD the facts it judges on」
//
// Card EMPTY-1 (owner intent, 2026-09-04) — WHY a terminal `stt:final` carries
// no text, said by the only layer that can prove it.
//
// THE ACCOUNT, measured on real devices at 0.3.61:
//   · silence      relay logs `audio intake {"voicedMs":0}` → the phone raises
//                  its own 「No speech detected — move closer to the mic」 banner.
//                  Correct, and unchanged by this module.
//   · Chinese spoken while the spoken-language setting said French, LAN sidecar,
//                  routed to `sherpa-local`:
//                  `audio intake {"gatedMs":3060,"voicedMs":1280}`,
//                  `stt.final.raw chars 0`, no `stt:error` of any kind —
//                  AND THE PHONE SHOWED NOTHING. The 「Transcribing」 row simply
//                  disappeared. A held button, real speech, and silence back:
//                  indistinguishable from a crash from where the user sits.
// The engine did not fail. It finished cleanly and had nothing to say. No
// registered `ErrorCode` answers that honestly — every STT_* code names a fault,
// and there was none — which is why this travels as an ADDITIVE FIELD on the
// final rather than as a code (adding a code is an owner gate in this repo, and
// borrowing one would be the 「a code that names a fault that does not exist」
// shape this repo has repaired four times already).
//
// Pure function, no engine / clock / session — the same reason
// `empty-final-verdicts.ts` and `terminal-final-text.ts` are: the rule can then
// be read and tested on its own.

/** The closed domain the SERVER is allowed to put on `stt:final.empty_reason`.
 *
 *  The wire schema keeps the field a permissive `string` for additive-field
 *  forward-compat (a receiver must never reject a future value); this is where
 *  「what we actually say today」 is pinned, so a typo cannot reach a phone that
 *  would then render a bare token. */
export const EMPTY_FINAL_REASONS = ['no_voice', 'heard_no_words'] as const;
export type EmptyFinalReason = (typeof EMPTY_FINAL_REASONS)[number];

/**
 * The one rule. Returns the reason to stamp on this terminal final, or `null`
 * when the field must be left OFF.
 *
 * ⚠️ THE THREE ARMS ARE THE DESIGN — each one refuses to answer a question that
 * already has an author:
 *
 *  · `text !== ''` → null. There is nothing to explain: the user has words.
 *
 *  · `engineErrorEmitted` → null. 🔴 THIS IS THE LOAD-BEARING ONE. A network
 *    drop, an auth failure, a rate limit, a timeout, a pool with no route, an
 *    engine that cannot do the language — every one of those already left the
 *    server as an `stt:error` carrying a REGISTERED code, and the phone already
 *    renders per-code copy for it. Stamping a second, vaguer answer on the
 *    final behind it would give one question two authors, which is this repo's
 *    #1 defect shape (CLAUDE.md 「一个值答了两个问题」), and the phone's
 *    `namedRefusalHolds` guard would then be picking between two sentences we
 *    ourselves wrote about the same fact. The named refusal wins because it is
 *    strictly more informative — so this module must not manufacture a rival.
 *
 *  · `sessionProducedText` → null. 🔴 THE N1-B2 NARROWING. `text` is the TERMINAL
 *    final's text, and after a rollover that is the LAST SPAN ONLY — while
 *    `voiceBytesCaptured` is recording-wide. Without this arm, a ten-minute
 *    dictation whose speaker let go during a pause would end with a banner saying
 *    we heard no words, on a screen already full of the words we heard. That is
 *    the mirror of the defect this card exists to fix: a false alarm instead of a
 *    silence. The phone makes the same narrowing locally (「nothing settled」), and
 *    it is made HERE as well because the server is the only end that can see the
 *    spans a rolled-over recording no longer carries on its final.
 *
 *  · `voiceBytesCaptured === 0` → `'no_voice'`. The feed gate accepted nothing:
 *    there was no speech to transcribe. This is the case that ALREADY worked,
 *    and the phone maps this value to the sentence it was already showing —
 *    byte-identical copy, on purpose. The value is emitted anyway because 「the
 *    server said so」 and 「the phone inferred it from an empty string」 are
 *    different facts, and only the first one survives a future where an empty
 *    final can mean something else.
 *
 *  · otherwise → `'heard_no_words'`. The gate accepted speech, no engine
 *    complained, and the transcript is empty. That is the measured gap above,
 *    and it is the ONLY thing this card adds to what the user is told.
 *
 * 🔴 WHAT IT MUST NEVER BE EXTENDED TO DO: name the cause of `'heard_no_words'`.
 * The server cannot tell 「the mic was too far away」 from 「the spoken-language
 * setting does not match what was said」 from 「the model knows the language and
 * simply could not make it out」 — nothing it holds distinguishes them (the
 * French/Chinese run above produced a clean, error-free exit with the requested
 * language echoed back). The phone's sentence therefore names BOTH actions the
 * user can take and asserts neither cause. Inventing a diagnosis here would be
 * 「a guess dressed as a diagnosis」, and a user sent to fix the wrong thing
 * learns that the app lies.
 *
 * @param text the transcript this terminal final is about to deliver.
 * @param voiceBytesCaptured bytes the feed gate accepted over the whole run.
 *   🔴 The SAME counter, taken at the same site, that `noEngineReachedError`
 *   judges on — `shouldFeedEngine`. Two spellings of 「does this audio count as
 *   speech」 is how they come to disagree.
 * @param engineErrorEmitted whether an `stt:error` already left the server on
 *   this recording.
 * @param sessionProducedText whether ANY final of this recording carried words.
 */
export function emptyFinalCause(
  text: string,
  voiceBytesCaptured: number,
  engineErrorEmitted: boolean,
  sessionProducedText: boolean,
): EmptyFinalReason | null {
  if (text !== '') return null;
  if (engineErrorEmitted) return null;
  if (sessionProducedText) return null;
  return voiceBytesCaptured === 0 ? 'no_voice' : 'heard_no_words';
}
