// SPEC-REF:
//   docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md §2.1
//     (EU-1/EU-2/EU-3/EU-4) and §3.3
//   Directive 2011/83/EU (Consumer Rights Directive) art. 9 (the 14 days),
//     art. 11a as inserted by Directive (EU) 2023/2673 (the withdrawal function),
//     art. 13 (reimburse without undue delay), art. 14(3)/(4)(a) (what may be
//     kept, and when nothing may be)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// 🔴 THE ONE PLACE THAT ANSWERS 「can this person still withdraw, and until when」.
//
// The console asks it to decide whether to show the withdrawal function at all;
// the route asks it to decide whether to act. Two deciders would mean a button
// that is visible and a server that refuses it, or worse the other way round —
// and 「the page offers a legal right the server will not honour」 is not a
// cosmetic bug, it is the kind that gets written up.

/** CRD art. 9: fourteen days. Not configurable, and deliberately not an env var:
 *  it is a statutory number, and a deployment that could shorten it would be a
 *  deployment that could break the law by editing a shell profile. */
export const WITHDRAWAL_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Three answers, not two, and the third is the one that matters.
 *
 *   'open'    — the window is running; the function must be offered.
 *   'closed'  — it ran and has passed. A discretionary refund may still be
 *               available, but that is a different thing with a different name.
 *   'unknown' — WE NEVER RECORDED WHEN THE CONTRACT WAS CONCLUDED, so we cannot
 *               compute the deadline at all.
 *
 * 🔴 WHY 'unknown' IS NOT FOLDED INTO 'closed'. They render the same to a user
 * — no button — but they are opposite facts about US. 'closed' means the right
 * expired; 'unknown' means we lost the ability to tell, which for a subscription
 * created before `contract_concluded_at` existed means a person may still hold a
 * right we cannot see. Collapsing them would bury that permanently under a value
 * that reads as 「nothing owed」. The route names it separately so the refusal can
 * say 「we cannot determine your withdrawal period — contact us」 rather than
 * 「your period has ended」, which would be a claim we cannot support.
 */
export type WithdrawalWindow = 'open' | 'closed' | 'unknown';

/** The deadline, or null when there is nothing to compute it from.
 *  A `contract_concluded_at` that does not parse yields null — 「unknown」 — and
 *  never a date derived from NaN. */
export function withdrawalDeadline(contractConcludedAt: string | null): string | null {
  if (contractConcludedAt === null) return null;
  const startMs = Date.parse(contractConcludedAt);
  if (!Number.isFinite(startMs)) return null;
  return new Date(startMs + WITHDRAWAL_WINDOW_DAYS * DAY_MS).toISOString();
}

// 🔴 2026-09-02 audit F9 — `withdrawalWindow(contractConcludedAt, nowMs)` used
// to live here (`windowFromDeadline(withdrawalDeadline(contractConcludedAt),
// nowMs)`, its own dead twin of the function below). Zero production callers:
// `http/billing-routes.ts` calls `windowFromDeadline` directly against
// `PlanView.withdrawal_deadline`, never this two-step form against the raw
// column — see that function's own doc for why THAT is the one the route must
// use. Deleted rather than kept as an always-agreeing alternate path.

/**
 * The window's state at `nowMs`, taken from the deadline the plan view already
 * carries.
 *
 * ⚠️ The boundary is `nowMs < deadline`, i.e. the fourteenth day is INSIDE the
 * window and it closes the instant the deadline is reached. The direction is
 * chosen on purpose: an off-by-one that closes early takes a legal right away
 * from someone entitled to it, while one that closes late costs us one refund.
 * Those two errors are not equally bad and the code should not pretend they are.
 *
 * 🔴 THIS IS THE ONE THE ROUTE USES, and the choice is deliberate. The console
 * decides whether to offer the withdrawal function from `PlanView.
 * withdrawal_deadline`; if the route re-derived its own deadline from the raw
 * column, the button and the server would be running two computations of one
 * legal date, and the day they disagree is the day we either offer a right we
 * then refuse, or refuse one we are offering. Same input, same function, one
 * answer.
 */
export function windowFromDeadline(deadline: string | null, nowMs: number): WithdrawalWindow {
  if (deadline === null) return 'unknown';
  const ms = Date.parse(deadline);
  // A stored deadline that does not parse is 'unknown', never 'closed': we
  // cannot tell, and saying 「your period has ended」 would be asserting
  // something we do not know about someone's rights.
  if (!Number.isFinite(ms)) return 'unknown';
  return nowMs < ms ? 'open' : 'closed';
}

// 🔴 2026-09-02 audit F9 — `retainableFraction(): 0` used to live here (a
// function that always returned 0, documented at length as "the law working,
// not a stub" — CRD art. 14(3)'s pro-rata retention needs a consent record
// this product has never captured, so art. 14(4)(a) makes the retention
// NOTHING). It had zero callers: `http/billing-routes.ts` narrates the same
// legal argument in a comment but its withdrawal handler always issues a
// full refund directly, never through this function. Deleted rather than
// kept as an unreachable placeholder — see billing-routes.ts and
// guided-setup.ts for where the legal argument itself is now written
// (as prose, not as a function nothing calls). When B5 (design §3.1,
// billing_consents) lands and a pro-rata calculation becomes possible, that
// work adds a real function taking the consent record as an argument; it
// does not resurrect this one.
