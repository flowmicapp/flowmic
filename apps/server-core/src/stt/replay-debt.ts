// SPEC-REF:
//   apps/server-core/src/stt/audio/ring-buffer.ts (card RT-3 — the RETENTION PIN
//     this predicate arms: a chunk above `fedThroughSeq` has never been handed to
//     any engine, so evicting it on a time window loses content by construction)
//   docs/strategy/2026-08-08-030-unified-plan-and-ledger.md card RT-2 (the
//     silence hang-up / voice redial lifecycle)
//
// ── ONE QUESTION: 「is the ring still owed a replay?」 ────────────────────────
//
// Moved out of `orchestrator-core.ts` VERBATIM, body and reasoning unchanged,
// because that file sits exactly at its size cap (`verify:lint file-size`) and
// this repo's standing answer to that cap is a STRUCTURAL split — take a
// coherent family out whole — never trimming the evidence a comment carries.
// This is a good thing to take: it is PURE, it is the predicate the RT-3
// retention pin is armed from, and it reads four facts the orchestrator can
// hand over as plain booleans instead of reaching back into it.
//
// 🔴 Making it a free function is not only a size move. As a method it read
// `this` and could quietly grow a fifth term; as a signature, every fact it
// depends on has to be named at the call site, which is what makes 「why is
// audio being held?」 answerable by reading one line.

/** The four facts that keep a replay owed. Named rather than positional: three
 *  of them are booleans about the same subsystem and a positional call would be
 *  four bare `true`s at the seam where losing audio is the failure mode. */
export interface ReplayDebtFacts {
  /** An engine leg exists right now. */
  hasEngine: boolean;
  /** A segment rollover is mid-flight (the old leg is closing, the new one is
   *  not open yet) — the gap in which "no engine" is a transient, not an end. */
  rolloverInFlight: boolean;
  /** card RT-2 — a redial is UNDERWAY because a chunk the gate accepted arrived
   *  while the leg was hung up.
   *
   *  🔴 `isDialing`, and NOT `isHungUp`, is the fourth term, and the difference
   *  is the whole card. While the leg is hung up and the user is quiet, nothing
   *  is owed a replay, so the ring must be free to prune that silence — holding
   *  it would grow the buffer for exactly as long as nobody is speaking. The
   *  debt BEGINS the instant an accepted chunk starts a redial, and lasts until
   *  it has been fed. */
  redialInFlight: boolean;
  /** The reconnect ladder has a rung scheduled: the engine is gone but we have
   *  not given up on it, so its audio is still owed to whoever comes back. */
  reconnectPending: boolean;
}

/**
 * True while audio that no engine has heard must be held regardless of its age.
 *
 * Handed to `RingBuffer.prune` as the choice between "retain everything above
 * the fed watermark" and "the window may take it": a false answer here is what
 * lets the ring drop unheard speech, and nothing downstream reports that.
 */
export function replayStillOwed(f: ReplayDebtFacts): boolean {
  return f.hasEngine || f.rolloverInFlight || f.redialInFlight || f.reconnectPending;
}
