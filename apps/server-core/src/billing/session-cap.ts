// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4 (gap G-8 — the per-tier
//     `continuous_minutes` ceiling was enforced by the CLIENT alone)
//   docs/decisions/ owner 2026-08-29 long-recording rulings (free 10 min per
//     sitting, pro/max 30) · ./plans.ts `PLAN_LIMITS.continuous_minutes`
//   apps/mobile/lib/src/audio/continuous_cap_timer.dart (the phone's own clock,
//     armed from the SAME number this resolves)
//   ../stt/audio/session.ts (`setSessionCapMs` — where this becomes a wall)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Card G-8 — HOW LONG MAY ONE SITTING RUN, as milliseconds, for one payer.
//
// ── 🔴 WHY THIS IS NOT `capped-remaining.ts` ────────────────────────────────
//
// Because it is not the same KIND of number, and merging the two is the one
// thing `billing/plans.ts` names as forbidden for this pair (its
// `continuous_minutes` doc: 「20 min/month against a 10 min cap — i.e. two
// sessions — and the product copy must state both numbers separately; merging
// them into one figure is this repo's #1 defect shape」, and
// `http/console-routes.ts` repeats it on the wire field: 「Collapsing them into
// one number is the one thing this pair must never do」).
//
// `cappedRemainingSttMs` mins three SPEND allowances — the payer's month, the
// demo browser's lifetime grant, an integrator key's cycle. Each of them
// shrinks as it is spent and none of them comes back at the next press. This
// one is a LENGTH: it is identical at the start of every sitting no matter how
// much has been recorded, and it is exhausted by nothing. Feeding it into that
// `Math.min` would make `billing:budget.remaining_ms` answer 「how much money is
// left」 with a session length — a free account with 20 minutes of month left
// would be shown 10, twice in a row, and the gauge would not move across the
// first recording it was supposed to measure.
//
// ⇒ Two questions, two numbers, two ceilings on the ONE timer that
// `AudioSession.nextCeiling` already arms. The timer is where they meet;
// the meter is not.

import type { PlanLimits } from './plans';

/** How long one continuous recording may run, in ms — or `Infinity` for 「this
 *  deployment puts no length ceiling on a sitting」.
 *
 * ⚠️ `Infinity` here is NOT a failure value in disguise, and it has exactly two
 * producers: a deployment with no commercial boundary (standalone — see
 * {@link continuousCapMsFor}'s caller in `quota-guard.ts`), and an override so
 * malformed that no honest number can be read off it. The second is argued
 * below.
 */
export function continuousCapMsFrom(limits: Pick<PlanLimits, 'continuous_minutes'>): number {
  const minutes = limits.continuous_minutes;
  // 🔴 A MALFORMED CELL OPENS THE CEILING RATHER THAN CLOSING IT, and the
  // direction is chosen, not defaulted.
  //
  // `plans.ts` already refuses a non-integer, a negative, and `"unlimited"` for
  // this key at config-load time, so the only way to arrive here with something
  // unusable is `0` — and `0` read as a ceiling would end EVERY recording on
  // this deployment the instant it started, for every account, from a single
  // mistyped character in an environment variable. That failure is total,
  // immediate and indistinguishable from the product being broken.
  //
  // Opening the ceiling instead costs the far end at most one sitting's worth
  // of minutes, and the thing G-8 exists to stop — an unbounded session
  // draining somebody else's month — is still bounded UNDERNEATH by the payer's
  // own remaining budget (`capped-remaining.ts` → the `quota_budget` ceiling on
  // the same timer). So this direction loses a ceiling that has a second
  // ceiling behind it; the other direction loses the product.
  //
  // ⚠️ It is deliberately silent about the 0 case HERE rather than logging:
  // this function is pure and is called once per audio:start, and a per-press
  // log line for a misconfiguration is the alarm that fires every time. The
  // place that can say it once is config load, and `plans.ts` is where a rule
  // against `0` belongs if owner ever wants one — this file must not grow a
  // second, quieter copy of the override validator.
  if (!Number.isFinite(minutes) || minutes <= 0) return Number.POSITIVE_INFINITY;
  return minutes * 60_000;
}
