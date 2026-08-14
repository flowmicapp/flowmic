// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §2.0-d
//     (card RT3-B — the terminal final's `text: ''` is an assertion, not a default value)
//   docs/strategy/2026-08-07-rt3-outage-resilience-ledger.md §1.3 (two measured facts) / §5 RT3-B
//   CLAUDE.md red line: no silent failure (both directions) / R11 state must be correct
//
// What a TERMINAL final says when there is no engine left to flush.
//
// Split out of orchestrator-core.ts as a pure function so the rule can be read —
// and tested — without an engine, a clock or a session. The decision is one
// boolean wide; the reasoning is the file.

/**
 * 🔴 card RT3-B — the text for the no-engine terminal final.
 *
 * There is no engine left to flush, but "no silent failure" cuts both ways: returning
 * in silence would leave the phone's FSM in PROCESSING until its 15 s stall net,
 * so a terminal final is still owed. The question is what it should SAY.
 *
 * ⚠️ `text: ''` IS AN ASSERTION — "this segment produced no transcript" — and it
 * is true for exactly one of the two callers that reach the no-engine branch:
 *
 *  · A ROLLOVER took the engine (the terminal fence landed inside
 *    `engine.close()`, which nulls the field before it awaits). Its segment final
 *    ALREADY carried the accumulators out under the previous index. Repeating
 *    that text under THIS index reads as a DISJOINT span on the phone (different
 *    idx ⇒ different slot ⇒ CONCATENATE) and the sentence would appear twice.
 *    ⇒ `''` is right.
 *
 *  · THE RECONNECT LADDER GAVE UP. No rollover ran, no index was spent, and every
 *    final the dead engine confirmed is still sitting in `offlineAccum` having
 *    never left this process. ⇒ `''` throws away a transcript we hold.
 *
 * 🔴 The old code asserted the first case UNCONDITIONALLY, in a comment about
 * another path's behaviour — anti-façade ④: its truth depended on who called, and it
 * could not change when the answer did. The fix is not a better comment, it is to
 * stop inferring and RECORD the fact — that is `accumEmittedByFinal`, and it is
 * this function's first parameter.
 *
 * ⚠️ Provably degrades to the old behaviour on the rollover path: that path emits
 * its segment final (⇒ `emittedByFinal` true) before it ever reaches
 * `closeEngine()`, so it still gets `''` — pinned by
 * `stt-terminal-rollover-collision.test.ts`, not by argument.
 *
 * ⚠️ The text is `foldConfirmedWithDraft(...)`, the SAME expression `flushFinal`
 * hands the engine-present terminal path as its offline fallback. Two spellings
 * of "what this session has confirmed" is how they drift apart, and the phone
 * REPLACES the slot with whatever arrives here — returning `confirmed` alone would
 * DROP the draft tail the phone is currently showing.
 *
 * 🔴 WHAT THIS DOES NOT DO, and must never be extended to do:
 *  · It does not invent text. Only what an engine actually confirmed is returned.
 *    Audio spoken during an outage reached no engine ⇒ produced no interim ⇒ was
 *    never in any accumulator, and no amount of work HERE can recover it. That
 *    half is registered as an open gap (book 15 §6 G-23) and needs a new error code
 *    = owner gate; borrowing `STT_NETWORK_DROP` for it would be one code
 *    answering two questions.
 *  · It does not make the phone's guard dead code. `segment_buffer.dart` `put`
 *    keeps a non-empty prior when a final arrives empty — written for the FLUSH
 *    TIMEOUT fallback, a path this card does not touch.
 *
 * @param emittedByFinal has the text currently in the accumulators already left
 *   this server on some `final`?
 * @param fold the session's own `foldConfirmedWithDraft`, passed in rather than
 *   imported so this function cannot grow a second opinion about the merge.
 */
export function noEngineTerminalText(
  emittedByFinal: boolean,
  confirmed: string,
  draft: string,
  fold: (confirmed: string, draft: string) => string,
): string {
  return emittedByFinal ? '' : fold(confirmed, draft);
}
