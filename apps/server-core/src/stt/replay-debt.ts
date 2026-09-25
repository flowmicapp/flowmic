// SPEC-REF:
//   apps/server-core/src/stt/audio/ring-buffer.ts (card RT-3 — the RETENTION PIN
//     this predicate arms: a chunk above `fedThroughSeq` has never been handed to
//     any engine, so evicting it on a time window loses content by construction)
//   docs/archive/strategy/2026-08-08-030-unified-plan-and-ledger.md card RT-2 (the
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

import { DEFAULT_REPLAY_WINDOW_MS } from './orchestrator-types';
import { PCM_BYTES_PER_MS } from './tuning-env';

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

/**
 * 🔴 card RC-A (CR-12-E rerun root cause §4.2, 2026-09-24) — THE FIFTH FACT: a
 * retiring flush is in flight. It is not a fifth term of {@link replayStillOwed},
 * because the answer it changes is not 「is a replay owed」 but 「FROM WHERE」.
 *
 * During a retiring flush (leg rotation, row cut, silence hang-up) the old leg
 * stays open and keeps being handed audio (F-2152 / HANGUP-1), so the mark
 * (`lastEngineFedSeq`) runs ahead to the live edge and every chunk below it counts
 * as 「fed」 — which the ring keeps only for its 5 s window. When the flush returns,
 * the mark is rewound to the boundary taken before the flush and the next leg is
 * replayed from there; a round trip longer than the window has by then pruned the
 * head of that range. Before card RC-2 a network flush was capped at 3 s and never
 * outlasted the window; RC-2 lets it run backlog + 3 s, and the device lost whole
 * sentences (RO ~15 s, R100 ~16 s, R8b ~6 s) with no line anywhere saying so.
 *
 * So while a retiring flush is in flight the ring is pinned at its BOUNDARY, not at
 * the mark. `retiringFloorSeq` is that boundary (null when no retiring flush owes a
 * replay); it is set where the boundary is taken (`orchestrator-rollover.ts`) and
 * released by the replay that hands everything above it to a leg
 * (`orchestrator-replay.ts` `replayIntoLeg`), or at the rewind when nothing above
 * it was voice. Pinned by test/stt-long-flush-seam.test.ts.
 */
export function retentionFloorSeq(f: ReplayDebtFacts, lastEngineFedSeq: number, retiringFloorSeq: number | null): number {
  const owed = replayStillOwed(f) ? lastEngineFedSeq : Number.POSITIVE_INFINITY;
  return retiringFloorSeq === null ? owed : Math.min(owed, retiringFloorSeq);
}

/**
 * 🔴 card RC-L (CR-12-E rerun-3 root cause §1.2 / §4.1, 2026-09-24) — THE SIXTH FACT: audio a leg was
 * HANDED but has not ANSWERED. The pin above treats 「handed to some leg」 as 「heard」: a chunk at or
 * below the mark is kept only for the 5 s window. A leg that dies (the ladder takes over), or whose
 * retiring flush ends without the vendor's end-of-stream final (the leg died in the flush, or the cap
 * fired while the vendor was still working), has answered only up to its processed position — 1–2 s
 * behind what it was handed, up to 20 s while the vendor catches up a backlog. That stretch was in no
 * leg's text, was never replayed, and the phone did not owe it (S4 「都记下」, S5 the whole 11th sentence).
 *
 * So the ring is also pinned at the smaller of: what the LIVE leg has answered
 * (`leg-facts.ts` `answeredThroughSeq`, null for an engine that reports no processed position, which
 * therefore keeps exactly today's behaviour), and the floor a DEAD leg left behind
 * (`orchestrator-core.ts` `unansweredFloorSeq`, spent by the replay that hands everything above it to a
 * new leg, `orchestrator-replay.ts` `replayIntoLeg`). A dead leg's floor is dropped once nothing will
 * ever replay again — the ladder has given up ([replayWillHappen] false).
 */
export function answeredFloorSeq(liveLegAnsweredSeq: number | null, deadLegFloorSeq: number | null, replayWillHappen: boolean): number {
  const live = liveLegAnsweredSeq ?? Number.POSITIVE_INFINITY;
  return replayWillHappen && deadLegFloorSeq !== null ? Math.min(live, deadLegFloorSeq) : live;
}

/**
 * 🔴 card RC-L, MAIN ruling 6 (rerun-3 root cause §11-6) — a LONG RECORDING
 * (`audio:start.continuous === true`) holds audio no engine has answered for 180 s, not for the
 * ladder's worst case: an engine outage up to that long is replayed by the relay in place and leaves
 * the phone owing nothing (the phone's recovery places what it re-transcribes early — NR-101 — so the
 * fewer outages reach it the better). THE ONE NUMBER, chosen by MAIN, not derived from the schedule;
 * what it costs is derived from it and pinned by test/stt-dead-leg-unanswered.test.ts
 * ({@link CONTINUOUS_RING_MAX_BYTES}). Push-to-talk keeps the ladder's own worst case (RT-3).
 */
export const CONTINUOUS_UNFED_GRACE_MS = 180_000;

/** The most a long recording's ring can hold: the 5 s window plus the grace, at 16 kHz s16le mono
 *  (32 bytes per ms) — ≈ 5.9 MB per session, held only while an outage or a backlog pins it. */
export const CONTINUOUS_RING_MAX_BYTES = (DEFAULT_REPLAY_WINDOW_MS + CONTINUOUS_UNFED_GRACE_MS) * PCM_BYTES_PER_MS;

/** The retention grace for audio no engine has answered: the ladder's worst case, or for a long
 *  recording the larger of that and {@link CONTINUOUS_UNFED_GRACE_MS}. */
export function unfedGraceMsFor(continuous: boolean, ladderWorstCaseMs: number): number {
  return continuous ? Math.max(ladderWorstCaseMs, CONTINUOUS_UNFED_GRACE_MS) : ladderWorstCaseMs;
}
