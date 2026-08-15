// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d / §6 G-23
//   docs/decisions/2026-08-10-owner-ruling-requests-from-lan-window.md (#5-c)
//   docs/strategy/2026-08-07-rt3-outage-resilience-ledger.md §1.3
//   CLAUDE.md red line: no silent failure (both directions) / R11 state must be correct
//
// What the server OWES the user when a `final` carries no transcript.
//
// Two verdicts live here because they answer the same question from opposite
// ends — "this segment produced no transcript — should we say something, and what" — and because putting them
// side by side is the only way a reader can see that their conditions cannot
// both hold (proved below, and pinned by a test). Pure functions, exactly as
// terminal-final-text.ts is and for the same reason: the rule can then be read
// and tested without an engine, a clock or a session.
//
// {@link silentEmptyFinalError} was MOVED HERE VERBATIM from
// orchestrator-core.ts (800-line cap, card fix-022). Its behaviour is unchanged
// byte for byte — only the emit moved to the caller. `{@link}` targets in its
// doc that do not resolve in this file (`handleFlushError`) are orchestrator
// methods and still live there.

import type { ErrorCode } from '@flowmic/protocol';

/** The `stt:error` payload shape the orchestrator emits. `code` is the protocol
 *  `ErrorCode` union on purpose: an unregistered code then fails to COMPILE
 *  rather than reaching a phone that renders the bare identifier (CLAUDE.md,
 *  the 62/63/64 account —"deferring is not a neutral act, it closes a gate"). */
export interface SttErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * 🔴 No silent failure, the flush-cap half.
 *
 * A `final` is a PROMISE that this is the transcript. When the flush cap fired
 * AND the text is empty AND we really did push audio into the engine, that
 * promise is false: the engine was handed speech and answered nothing inside
 * its window, and the empty string is OUR fallback, not its answer. Shipping
 * that as a bare `stt:final{text:''}` is "claiming something got done when it didn't".
 *
 * Found by L9 (2026-08-02): the Soniox adapter's end-of-stream frame was the
 * wrong TYPE, so `flush()` never resolved and EVERY utterance landed here —
 * on the wire it looked like an ordinary, error-free session that just
 * happened to produce a short transcript. Nothing anywhere said "the engine
 * never finished".
 *
 * ⚠️ THE THREE CONDITIONS ARE THE DESIGN, not defensiveness — dropping any one
 * of them turns a true statement into a false alarm:
 *  · `timedOut` — an engine that FINISHED and returned nothing is a different
 *    fact (the user was silent, or the vendor heard nothing). Calling that a
 *    timeout would be the repo's #1 shape: one code answering two questions.
 *    This is also why the guard cannot simply test "text is empty".
 *  · `text === ''` — a partial transcript recovered from the interim
 *    accumulator is degraded, not absent; the user has words on screen.
 *  · `engineFedBytes > 0` — a session where nothing was ever fed (VAD gated
 *    everything, or the phone sent no audio) has an empty transcript because
 *    there was nothing to transcribe. Blaming the engine there is a lie in the
 *    other direction.
 *
 * 📌 The code is the EXISTING `STT_ENGINE_TIMEOUT` ("recognition engine response timed out"), which
 * is literally what happened, and the same one {@link handleFlushError} already
 * emits for the neighbouring case. A more precise code would need a new
 * `ERROR_CODES` entry, and that face is an owner gate — so this lane does not
 * add one and does not pretend it did.
 */
export function silentEmptyFinalError(
  engineFedBytes: number,
  text: string,
  timedOut: boolean,
): SttErrorPayload | null {
  if (!timedOut || text !== '' || engineFedBytes === 0) return null;
  return {
    code: 'STT_ENGINE_TIMEOUT',
    message: `STT engine returned no text: ${engineFedBytes} bytes of audio were pushed and flush() did not finish within its cap`,
    retryable: true,
  };
}

/**
 * 🔴 card fix-022 / G-23 — "this recording never reached any recognition engine", said by the only layer that
 * can prove it.
 *
 * THE ACCOUNT. Audio was captured and handed to nobody; the one sentence the
 * user got was `STT_NETWORK_DROP`"network interrupted, recognition session terminated". That answers "the network"
 * while the question is "where did what I said go", so it sends them to check a WiFi
 * connection that is working perfectly. owner granted a dedicated code on
 * 2026-08-10 (ruling group #5-c); card fix-019 registered it; this function is
 * its ONLY producer.
 *
 * ⚠️ `STT_NETWORK_DROP` KEEPS ITS MEANING EXACTLY. Nothing here redefines it and
 * nothing here removes it: the ladder still emits it when the reconnect budget
 * is exhausted (`engine-session.ts` `failTerminal`), and the cold open still
 * emits it when the engine could not be reached at all. This function only adds
 * the sentence that answers the OTHER question, on the recordings where it can
 * be proved. Pinned in both directions by `no-engine-heard.test.ts`.
 *
 * ⚠️ THE THREE CONDITIONS ARE THE DESIGN — they are what makes the registered
 * copy literally true rather than probably true. Read the string first
 * (`packages/protocol/src/error-codes.ts`, `STT_NO_ENGINE_REACHED`):
 * "This recording never reached any recognition engine and was not transcribed. Please say it again.".
 *  · `voiceBytesCaptured > 0` — the phone gave us audio that the feed gate
 *    ACCEPTED. Without it an empty transcript means there was nothing to say,
 *    and claiming the words vanished is a lie in the other direction — the same
 *    argument {@link silentEmptyFinalError}'s third condition already makes.
 *    🔴 The gate is `shouldFeedEngine`, the SAME predicate the engine feed
 *    consults, taken at the same site: two spellings of "whether this audio counts as speech" is
 *    how they come to disagree.
 *  · `sessionFedBytes === 0` — NOT ONE BYTE of this recording ever reached an
 *    engine. 🔴 This is the narrowing, and it is deliberately the SESSION-wide
 *    count rather than the per-leg `engineFedBytes`, which is reset for every
 *    new leg and answers "did this particular engine ever receive audio". A recording that lost only
 *    PART of its span — the ladder-exhaustion shape in `stt-outage-loss.test.ts`
 *    CASE 2, where the first 20 chunks were transcribed and 8 s were not — must
 *    NOT get this code: "was not transcribed" would be false and "please say it again" is the
 *    wrong advice for someone holding half a transcript. That half keeps
 *    `STT_NETWORK_DROP` and stays registered as open (book 15 §6 G-23).
 *  · `terminalText === ''` — the sentence promises "was not transcribed", so it may only
 *    be said when the transcript going out is empty. With the condition above
 *    true this should be unreachable, and that is exactly why it is a GUARD and
 *    not a prediction: if text ever exists without any audio having reached an
 *    engine, something produced it that we do not understand, and our sentence
 *    would be the false half of an R11 pair.
 *
 * 🔴 WHAT THIS MUST NEVER BE EXTENDED TO DO: estimate how much was lost. book 15
 * §6 G-23 —"the server must not 'estimate how many seconds were lost' and make up a sentence about it"— because `lastEngineFedSeq`
 * is also advanced by chunks the VAD gate REFUSED, so any duration derived from
 * it reports silence as lost words. The message below carries BYTES THAT PASSED
 * THE GATE: a count of what we accepted, never a claim about how long the user
 * spoke.
 *
 * ⚠️ `retryable: false` is "this recording session has ended", not "you may not say this sentence again" — the same
 * reading book 15 records for `STT_NETWORK_DROP`. The copy's "please say it again" asks for
 * a NEW recording, and false is what releases the phone's FSM to allow one at
 * once (`ptt_inbound.dart` → `onSttTerminalError`) instead of idling out its
 * 15 s stall net.
 *
 * ⚠️ Cannot collide with {@link silentEmptyFinalError}: that one requires
 * `engineFedBytes > 0`, and per-leg bytes are a subset of session bytes, so
 * `engineFedBytes > 0` ⇒ `sessionFedBytes > 0` ⇒ this returns null. One empty
 * final can therefore never carry two different explanations.
 *
 * @param voiceBytesCaptured bytes accepted by the feed gate over the whole run.
 * @param sessionFedBytes bytes handed to ANY engine over the whole run (live
 *   pushes + replay), never reset per leg.
 * @param terminalText the transcript this recording is about to deliver.
 */
export function noEngineReachedError(
  voiceBytesCaptured: number,
  sessionFedBytes: number,
  terminalText: string,
): SttErrorPayload | null {
  if (voiceBytesCaptured === 0 || sessionFedBytes > 0 || terminalText !== '') return null;
  return {
    code: 'STT_NO_ENGINE_REACHED',
    message: `No STT engine ever received this recording: ${voiceBytesCaptured} bytes passed the feed gate, 0 bytes reached an engine`,
    retryable: false,
  };
}

/**
 * 🔴 Card ENG-4 (2026-08-15, owner report 「云端中继……说的时候连不上 STT」) — the
 * same rule as {@link noEngineReachedError}'s FIRST condition, applied to the
 * code when it arrives from BELOW instead of from here.
 *
 * THE ACCOUNT, measured end to end on a real tablet (0.2.64) against the
 * production relay 〔2026-08-15 15:49 CST, device TB335ZC, machine dev-pc-a〕:
 *   15:49:18  stt.pool selected a route  {provider:"soniox"}
 *   15:49:22  WARN stt.error emitted     {code:"STT_NO_ENGINE_REACHED",
 *                                         message:"[invalid_request] No audio received."}
 *   15:49:24  audio intake               {chunks:27, audioMs:5280, voicedMs:0}
 * A held button in a quiet room. The VAD gate accepted **nothing**, so the
 * session opened and was handed no audio; Soniox answered "No audio received.";
 * `classifyNoAudio` (packages/stt-cloud/.../soniox.ts) re-points that at this
 * code — a real improvement over the `STT_CONFIG_MISSING` it replaced, and still
 * not what happened. The registered sentence is 「这段录音没有到达任何识别引擎，
 * 没有转成文字……如果一直这样，请检查识别引擎设置。」: the recording reached an
 * engine (it answered), nothing was lost (there was nothing), and on the managed
 * cloud route the user has no engine settings to check. Read from the user's
 * side that sentence IS 「连不上 STT」.
 *
 * 🔴 AND IT WINS OVER THE TRUE ONE. The empty final that follows makes the phone
 * raise `SttStallReason.emptyTranscript` = 「没有听到语音，请靠近麦克风再说一次」
 * — the honest sentence, already shipped in nine languages. `chat_notices.dart`'s
 * `namedRefusalHolds` then suppresses it, because within one utterance a NAMED
 * refusal is normally the more informative of the two. That guard is right; what
 * broke it is a named refusal that is less informative than the thing it hides.
 * ⇒ The fix belongs where the claim is MADE, not where it is displayed.
 *
 * ⚠️ THE CONDITION IS THE WHOLE DESIGN, and it is deliberately NOT "the code is
 * STT_NO_ENGINE_REACHED":
 *  · `voiceBytesCaptured === 0` — our own feed gate accepted nothing, so there
 *    was nothing to deliver to anybody. This is the same fact, taken from the
 *    same counter, that already stops {@link noEngineReachedError} from making
 *    the claim from above; below it, the claim was arriving unchecked.
 *  · `voiceBytesCaptured > 0` and the vendor still says "no audio received"
 *    ⇒ **we captured speech and it reached no engine**, which is exactly what
 *    the code was registered for. That one must stay loud, and it does: this
 *    returns false and the error goes out untouched.
 *
 * ⚠️ NOT A SILENT FAILURE — the banned direction. Suppressing this error does not
 * leave the user with nothing: the terminal empty `stt:final` is emitted on the
 * same recording (`emitTerminalFinal`, and `chat_notices.dart` records both
 * arriving on the measured runs), and the phone then says the true sentence it
 * was already going to say. The refusal is still recorded server-side by the
 * caller, so the ops trail keeps the vendor's own words.
 */
export function vendorNoAudioIsOurSilence(code: string, voiceBytesCaptured: number): boolean {
  return code === 'STT_NO_ENGINE_REACHED' && voiceBytesCaptured === 0;
}
