// SPEC-REF:
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts (the row this
//     projects, and why the delivery stamps are assigned rather than coalesced)
//   apps/server-core/src/billing/service-deadlines.ts (refundDueReason,
//     nextDeadlineAt, refundWindow, refundRelease, supportUntil — every
//     deadline this projection echoes is computed there, never stored)
//   apps/server-core/src/http/ops-purchase-routes.ts (the only caller; the
//     GET /api/ops/purchases queue renders one of these per row)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// 2026-09-02 — split out of ops-purchase-routes.ts VERBATIM (moved, not
// rewritten) when the atomic-advance fix (audit P1) pushed that file's line
// count past the 800-line cap. `toOperatorRow` has no dependency on the route
// handler's request/response state — it is a pure projection of a row, the
// clock, and the deadline policy — so it is a coherent family on its own, the
// same split precedent as schema.ts -> schema-billing.ts and
// bootstrap.ts -> bootstrap-http-deps.ts. Nothing about what it computes
// changed in this move.

import type { OneTimePurchaseRow } from '../db/repos/one-time-purchase.repo';
import { purchaseNextStep } from '../billing/creem/client';
import { GUIDED_SETUP_AFTERCARE_DAYS } from '../billing/guided-setup';
import type { DeadlinePolicy } from '../billing/service-deadlines';
import { nextDeadlineAt, refundDueReason, refundRelease, refundWindow, supportUntil } from '../billing/service-deadlines';

/** What the operator console renders per row — the customer console's
 *  projection plus the two fields only an operator needs. */
export function toOperatorRow(
  p: OneTimePurchaseRow,
  nowMs: number,
  policy: DeadlinePolicy,
): Record<string, unknown> {
  return {
    order_id: p.order_id,
    provider: p.provider,
    // 🔴 THE ACCOUNT ID, NEVER THE EMAIL. An operator who needs the address has
    // the account list; putting it here would spread a contact detail onto a
    // second surface for the convenience of not clicking through.
    user_id: p.user_id,
    product_id: p.product_id,
    amount_minor: p.amount_minor,
    currency: p.currency,
    state: p.state,
    // Derived on every read, never a sentence stored on the row.
    next_step: purchaseNextStep(p, nowMs, GUIDED_SETUP_AFTERCARE_DAYS),
    // ⚠️ SURFACED because an operator handling a withdrawal request has to see
    // what the buyer agreed to and when, without a database prompt.
    consent: {
      early_start_at: p.early_start_consent_at,
      waiver_ack_at: p.withdrawal_waiver_ack_at,
      terms_version: p.consent_terms_version,
    },
    purchased_at: p.created_at,
    scheduled_at: p.scheduled_at,
    started_at: p.started_at,
    delivered_at: p.delivered_at,
    // The end of the buyer's two weeks of help (gs-5), from `delivered_at`;
    // null unless delivered.
    support_until: supportUntil(p, GUIDED_SETUP_AFTERCARE_DAYS),
    refund_requested_at: p.refund_requested_at,
    refund_provider_id: p.refund_provider_id,
    // 🔴 THE PROVIDER'S WORD, VERBATIM, AND `null` IS MEANINGFUL HERE: it means
    // we asked and have not heard back. That is the row an operator has to look
    // at, and it is distinguishable from 「the provider answered 'pending'」 only
    // because this is not flattened.
    refund_status: p.refund_status,
    refunded_at: p.refunded_at,
    // When the buyer was actually told their setup was done.
    //
    // 🔴 `null` ON A DELIVERED ROW IS THE ONE AN OPERATOR MUST ACT ON: it means
    // we recorded the work and never told them, and that letter is owed. It is
    // surfaced beside the state rather than folded into it because it is a
    // different question — 「did we finish」 and 「did we say so」 — and the
    // second one is ours to fix. ⚠️ It changes nothing about the refund (gs-5):
    // the console must not read a null here as 「still refundable」.
    completion_notice_at: p.completion_notice_at,
    // Computed on every read from the row and the clock — never stored, so it
    // cannot go on saying 「due」 after somebody acted.
    refund_due: refundDueReason(p, nowMs, policy),
    next_deadline_at: nextDeadlineAt(p, policy, GUIDED_SETUP_AFTERCARE_DAYS),
    // 🔴 THE SAME FUNCTION THE CUSTOMER'S CONSOLE RENDERS ITS BUTTON FROM, and a
    // projection of the same condition the claim SQL enforces. An operator who
    // could see 「refundable」 where the write would refuse (or the reverse) would
    // be looking at a second opinion about somebody's money.
    refund_window: refundWindow(p, nowMs, policy),
    // 🔴 WHETHER A HUMAN ALREADY RESOLVED A STUCK REFUND ON THIS ROW, and how.
    // An operator looking at a purchase back in 'paid' cannot otherwise tell it
    // from one that was never refunded at all — and the difference decides
    // whether the no-start sweep will pick it up (see service-deadlines.ts).
    refund_release: refundRelease(p),
    // 🔴 THE OPERATOR'S OWN PROOF, WHERE THEY CAN READ IT. A 'refunded' row with
    // this set was settled by a person, not confirmed by the provider — and this
    // string is the only handle anybody has for checking it.
    refund_external_reference: p.refund_external_reference,
    note: p.note,
    updated_at: p.updated_at,
  };
}
