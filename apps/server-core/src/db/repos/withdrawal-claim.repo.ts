// SPEC-REF:
//   apps/server-core/src/db/schema-billing.ts paddle_subscriptions.withdrawal_claimed_at
//   apps/server-core/src/http/billing-routes.ts handleWithdraw (the only caller)
//   apps/server-core/src/billing/service-refund.ts (the pattern this copies —
//     "claim the row, THEN call the provider")
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// One method, in its own file rather than folded into billing.repo.ts, because
// that file sits at the 800-line cap (the one-time-purchase repo split for the
// same reason — see that file's own header). `BillingRepo extends
// WithdrawalClaimRepo` and `makeBillingRepo` spreads this factory, so callers
// still hold ONE repo and there is still one answer per question.
//
// ── 🔴 THE DEFECT THIS CLOSES (2026-09-02 audit F4) ─────────────────────────
// `http/billing-routes.ts`'s withdrawal handler used to read `PlanView` (which
// says 'active'), then call the provider's `cancelSubscription` — with NOTHING
// in between stopping a second, near-simultaneous request from reading the same
// 'active' view and doing the same thing. Paddle's OWN record of the
// cancellation reaches `paddle_subscriptions` only LATER, via the webhook, so
// the local row cannot answer "is a withdrawal already in flight for this
// subscription" — until this column exists to hold that answer.
//
// ── WHY A CONDITIONAL UPDATE, not a SELECT-then-UPDATE ─────────────────────
// A SELECT-then-UPDATE has the exact race in the middle: two requests could
// both see the column NULL, then both write it. `changes > 0` from a single
// `UPDATE ... WHERE withdrawal_claimed_at IS NULL` is atomic under sqlite's own
// serialisation — the SAME defence `requestOneTimeRefund` uses, argued at
// length in `service-refund.ts`'s header.
//
// ── WHEN `releaseWithdrawalClaim` MAY BE CALLED ─────────────────────────────
// Only by `handleWithdraw`, and only when `cancelSubscription` did NOT succeed
// — nothing changed at Paddle, so a genuine retry must not be blocked forever
// by a claim that never became a real cancellation. Once `cancelSubscription`
// SUCCEEDS the claim is never released — matching `service-refund.ts`'s own
// rule ("no timer and no retry moves a claimed row, and none should: only a
// person can know which of the two things actually happened"), because past
// that point the subscription truly is gone and there is nothing to retry.

import type { DatabaseSync } from 'node:sqlite';

export interface WithdrawalClaimRepo {
  /**
   * Claim a withdrawal for `subscription_id`, BEFORE calling the provider.
   * Returns `true` only for the caller that won the claim; `false` covers
   * "already claimed" and "no such subscription" alike — both mean "do not
   * call the provider from here".
   */
  claimWithdrawal(subscription_id: string, atIso: string): boolean;
  /**
   * Undo a claim that never became a real cancellation — see the file header's
   * "WHY THERE IS NO release METHOD" for when this may and may not be called.
   * Unconditional (no `WHERE ... IS NOT NULL` guard needed): clearing an
   * already-clear column is a no-op, and the caller only ever reaches this
   * after losing the race or after the provider refused outright — never after
   * a successful cancellation.
   */
  releaseWithdrawalClaim(subscription_id: string): void;
}

export function makeWithdrawalClaimRepo(db: DatabaseSync): WithdrawalClaimRepo {
  const claimStmt = db.prepare(
    `UPDATE paddle_subscriptions SET withdrawal_claimed_at = ?
     WHERE subscription_id = ? AND withdrawal_claimed_at IS NULL`,
  );
  const releaseStmt = db.prepare(
    'UPDATE paddle_subscriptions SET withdrawal_claimed_at = NULL WHERE subscription_id = ?',
  );
  return {
    claimWithdrawal(subscription_id, atIso): boolean {
      return claimStmt.run(atIso, subscription_id).changes > 0;
    },
    releaseWithdrawalClaim(subscription_id): void {
      releaseStmt.run(subscription_id);
    },
  };
}
