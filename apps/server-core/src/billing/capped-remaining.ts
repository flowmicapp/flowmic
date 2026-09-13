// SPEC-REF:
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §10-1 step 3
//     (the site demo's per-browser cap) · §10-4 (two ceilings, both real)
//   ./budget-push.ts (the frame a page is shown) · ../engine/stt-factory.ts
//     (the deadline a recording is cut off at) · ./trial-ledger.ts (the grant)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Card MP-6 — HOW MUCH LONGER MAY THIS SESSION SPEAK, when two ceilings apply.
//
// -- WHY A MODULE FOR ONE `Math.min` --------------------------------------
//
// Because three layers ask it and they must not disagree: the budget frame a
// page renders a clock from (`budget-push.view`), the hard stop a recording is
// actually cut off at (`stt-factory`'s `quotaBudgetMs` + its refresher), and the
// admission gate that refuses a press before it starts (`audio.handler`). The
// first shipped alone in the first draft of this card, and the result was a
// countdown that reached zero while the recording carried on — a number on a
// screen that no mechanism was behind, which is the status-truth red line (R11)
// with a plausible number in it.
//
// -- WHY `Math.min` AND NOT A COMPARISON ----------------------------------
//
// 🔴 `Infinity` MEANS 「THIS DEPLOYMENT HAS NO QUOTA CONCEPT」 and it must survive
// this function unharmed — `QuotaGuard.remainingSttMs` is its only author, and
// `budget-push.view` turns it into `remaining_ms: null` (「draw no meter」) rather
// than into a large number that would render a meter that is simply false about
// a standalone install. `Math.min(Infinity, Infinity)` is `Infinity`; any
// hand-written comparison that clamped or defaulted would quietly invent a
// ceiling on a deployment that has none.

/** The one read both ACCOUNT ceilings come from — `QuotaGuard.remainingSttMs`. */
export interface RemainingReader {
  remainingSttMs(userId: string): number;
}

/**
 * A THIRD ceiling that is not an account at all — card MP-1's per-key
 * sub-quota, already resolved to milliseconds by
 * `billing/integrator-quota.ts` `remainingMs`.
 *
 * 🔴 A NUMBER RATHER THAN AN ID, and that is not laziness about symmetry. The
 * other two ceilings are `users` rows and are read with the SAME function; an
 * integrator key is a row in another table with its own cycle counter, so
 * expressing it as an id would have forced `RemainingReader` to answer two
 * different questions through one method — this repo's number-one defect shape,
 * and here it would decide money. It arrives already-read so that the caller
 * that HOLDS the key (the admission) is the one that reads it, and this function
 * stays what it is: the one place two-or-three ceilings become one.
 *
 * ⚠️ `undefined` means 「this session has no key ceiling」 and NEVER 「we could not
 * read one」. The unreadable case is `0` (`integrator-quota.ts` `remainingMs`
 * states why), because the failure direction design §5 asks for is refusal.
 */
export type ExtraCeilingMs = number | undefined;

/**
 * The LOWEST of the payer's remaining budget, the cap identity's, and the
 * integrator key's sub-quota — or just the payer's when neither applies.
 *
 * `capUserId` is produced by exactly one branch of `resolvePayer` (`'demo'`),
 * so 「a session with two ceilings」 is a property of the data rather than of a
 * comment. Null / undefined ⇒ one ceiling, and the answer is byte-identical to
 * the read this function replaced at every call site.
 */
export function cappedRemainingSttMs(
  read: RemainingReader,
  payerUserId: string,
  capUserId?: string | null,
  keyRemainingMs?: ExtraCeilingMs,
): number {
  const ceilings: number[] = [];
  if (capUserId) ceilings.push(read.remainingSttMs(capUserId));
  // card MP-1 — the integrator key's sub-quota, when this session is spending
  // one. Pushed into the SAME `Math.min` rather than compared afterwards: a
  // second comparison somewhere else is how the frame, the deadline and the
  // admission gate would start disagreeing, which is the defect this module was
  // extracted to prevent in the first place.
  if (keyRemainingMs !== undefined) ceilings.push(keyRemainingMs);
  return Math.min(read.remainingSttMs(payerUserId), ...ceilings);
}
