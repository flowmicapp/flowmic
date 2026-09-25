// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d (the HANGUP-3
//     block) and §6 G-23; docs/rebuild/04-PROTOCOL-SPEC.md §5 and §3.3-a (c′)
//   the no-silent-failure red line
//
// card HANGUP-3 (implementation first written on card HANGUP-2 and withheld for
// want of a code) — what the server owes the user when the recording ends with
// voice that NO LEG EVER HEARD. Pure, like the neighbouring verdicts in
// `empty-final-verdicts.ts`, so the rule can be read and tested without an
// engine or a clock.
//
// THE FACT IT READS. `unheardVoice` (orchestrator-core.ts; the rule is argued at
// `rewindToFlushBoundary` in orchestrator-rollover.ts) is set when the feed gate
// accepted a chunk and no open leg took it, and cleared only by a live push or by
// a replay that handed everything above the mark to a leg. Asked at the terminal
// final — after the closing path has made its one capped attempt to deliver
// (`settleOwedVoice` in orchestrator-terminal.ts) — it means exactly 「these words
// were captured and are not in the transcript you are about to receive」.
//
// WHY STT_SEGMENT_NOT_TRANSCRIBED. STT_NETWORK_DROP answers 「the connection
// dropped and the session ended」, which is not the user's question (book 15 §6
// G-23 forbids the borrow); STT_NO_ENGINE_REACHED says NOTHING was transcribed,
// false whenever part of the recording was — its own verdict
// (`noEngineReachedError`) still speaks when nothing reached an engine, and this
// one then stays quiet (the caller checks it first).
//
// ⚠️ A DIAL REFUSED FOR A NAMED, PERMANENT REASON (auth, rate limit, no route…)
// keeps its own code — the ladder's rule (`isPermanentEngineError`,
// engine-session.ts) — because 「a stretch was not transcribed」 would then hide
// the one fact the user can act on.
//
// ⚠️ ONE TERMINAL FRAME. If a `retryable:false` frame already went out for this
// recording (the ladder gave up; a flush-phase refusal), the phone already holds a
// terminal stall that names the cause, and a second frame would only overwrite a
// more specific sentence. So this returns null.
//
// 🔴 THE GATE. Only a client that declared `stt.segment_not_transcribed` at
// admission gets ANY answer from this verdict (both branches). An undeclared client
// (every phone up to 0.3.94, the web client) would render the new name raw, so it
// keeps exactly the behaviour it had before this card: the missing stretch is
// absent from the row and nothing says so (book 15 §2.0-d, HANGUP-3 block).

import { CLIENT_CAPABILITY_STT_SEGMENT_NOT_TRANSCRIBED, type ErrorCode } from '@flowmic/protocol';
import { SttEngineError } from './engines/base';

export interface OwedVoiceError {
  readonly code: string;
  readonly message: string;
  readonly retryable: false;
  /** card RC4-S5 — see {@link unheardFromMs}; only on STT_SEGMENT_NOT_TRANSCRIBED, and only when known. */
  readonly unheard_from_ms?: number;
}

/** Typed against the registry, so removing the code there fails the build here. */
export const SEGMENT_NOT_TRANSCRIBED: ErrorCode = 'STT_SEGMENT_NOT_TRANSCRIBED';

export function owedVoiceLostError(
  unheardVoice: boolean,
  terminalErrorSpoken: boolean,
  closingDialError: Error | null,
  clientDeclared: boolean,
  fromMs: number | null = null, // card RC4-S5 — {@link unheardFromMs}
): OwedVoiceError | null {
  if (!clientDeclared || !unheardVoice || terminalErrorSpoken) return null;
  if (closingDialError instanceof SttEngineError && closingDialError.retryable === false) {
    return { code: closingDialError.code, message: closingDialError.message, retryable: false };
  }
  const why = closingDialError ? `the closing dial failed: ${closingDialError.message}` : 'no engine leg was open to take it';
  return {
    code: SEGMENT_NOT_TRANSCRIBED,
    message: `The recording ended with captured voice that no engine received (${why})`,
    retryable: false,
    ...(fromMs !== null ? { unheard_from_ms: fromMs } : {}),
  };
}

/**
 * 🔴 card RC4-S5 — WHERE THE UNHEARD STRETCH BEGINS, on the sender's audio clock (book 04 `stt:error` row).
 * The phone owes its long recording's tail from here (apps/mobile/lib/src/ptt/ptt_unheard_tail.dart), so the
 * words the terminal final carries are not transcribed a second time and the words it lacks are not lost:
 * without it the phone could only owe from what it had seen answered, which lags the vendor's final by the
 * backlog (CR-12-E re-run 4, S5: 183.9 s answered on the wire, 190.8 s in the final).
 *
 * [markSeq] is the highest seq a leg has been handed and ANSWERED — `lastEngineFedSeq`, lowered to a dead
 * leg's unanswered floor (card RC-L). While voice is owed the mark does not move on withheld chunks
 * (`orchestrator-core.ts` pushChunk, card HANGUP-1), so the first chunk above it is never pushed later by
 * silence. It is a START, never a length (book 15 §6 G-23 still forbids the relay to estimate a loss).
 *
 * Null when the ring no longer holds the chunk just above the mark: the relay then does not know the real
 * start, and a later one would lose the words in between. The phone falls back to its own reading.
 */
export function unheardFromMs(ring: readonly { seq: number; ts_ms: number }[], markSeq: number): number | null {
  const first = ring.find((c) => c.seq > markSeq);
  if (first === undefined || first.seq > markSeq + 1) return null;
  return Number.isInteger(first.ts_ms) && first.ts_ms >= 0 ? first.ts_ms : null;
}

/** The ONE reading of a client's `client_caps` for this verdict (docs/rebuild/04
 *  §3.3-a (c′)). Absent or empty ⇒ false ⇒ today's behaviour. Called by
 *  stt-factory.ts, the production writer of `segmentNotTranscribedDeclared`. */
export function declaresSegmentNotTranscribed(clientCaps: readonly string[] | undefined): boolean {
  return clientCaps?.includes(CLIENT_CAPABILITY_STT_SEGMENT_NOT_TRANSCRIBED) === true;
}

/** A dial made while the recording is closing has no ladder to hand its failure
 *  to (the ladder is not re-armed while closing), so the reason is kept for the
 *  one verdict that still needs it. Written by `dialLeg` / `spawnRolloverEngine`
 *  (orchestrator-rollover.ts) and `settleOwedVoice` (orchestrator-terminal.ts). */
export function recordClosingDialFailure(host: { terminated: boolean; closingDialError: Error | null }, err: unknown): void {
  if (!host.terminated) host.closingDialError = err instanceof Error ? err : new Error(String(err));
}
