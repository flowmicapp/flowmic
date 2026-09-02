// SPEC-REF:
//   apps/server-core/src/billing/subscription-writer.ts (createRefund)
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts
//     (requestOneTimeRefund — the claim, and why the state test is in the SQL)
//   apps/server-core/src/billing/service-deadlines.ts (who is due)
//   test/one-time-purchase-repo-atomicity.test.ts (2026-09-02 audit P2 — pins
//     THE CLAIM'S ATOMICITY this header's whole "exactly one caller can win it"
//     sentence rests on, one layer BELOW this file: it calls
//     `requestOneTimeRefund` twice against one row directly, with no service
//     or provider in between, and asserts the second call is 'not_refundable'.
//     service-refund-action.test.ts §1 already proved the property through
//     THIS file's own caller ("so a second caller never reaches the provider
//     at all"); the repo-level test is the same property pinned at the SQL
//     statement that actually decides it, so a future rewrite of the UPDATE
//     into a read-then-write cannot pass by accident just because nothing
//     above it changed.)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// 🔴 ASKING FOR A REFUND, IN ONE PLACE, FOR ALL THREE CALLERS.
//
// The customer presses withdraw in their console; an operator presses refund on
// a purchase the queue has flagged; a sweep does it unattended when that switch
// is on. Those are three different authorities and the same action, and the
// thing that must not vary between them is what happens to the money and what
// gets written down. Three copies of this would be three places for the order
// of 「claim the row」 and 「call the provider」 to differ — and that order is the
// whole of the double-refund defence.
//
// ── 🔴 THE ORDER, AND WHY IT IS THIS ONE ──────────────────────────────────
//
// CLAIM THE ROW FIRST, then call the provider. Two tabs, or a sweep racing an
// operator, would otherwise both read 'scheduled', both call Creem, and refund
// one charge twice — and a duplicate refund is money we cannot get back by
// apologising. The claim is a conditional UPDATE (`WHERE state IN
// ('paid','scheduled','in_progress')`), so exactly one caller can win it — and
// a delivered purchase never matches it, which is how gs-5's 「completion
// closes the refund」 is enforced at the write rather than only at the button.
//
// ⚠️ THE COST OF THAT ORDER, STATED RATHER THAN DISCOVERED: if the provider call
// then fails, the row sits in 'refund_requested' with no refund behind it. That
// is the direction to fail in — it is visible, it is in the operator queue, and
// nobody has lost money. The other order loses money silently. The failure
// carries `provider_status: null`, which is the signal that we asked and did
// not get an answer.
//
// ⚠️ THERE IS STILL NO AUTOMATIC WAY BACK OUT OF THAT STATE — no timer and no
// retry moves a claimed row, and none should: only a person can know which of
// the two things below actually happened.
//
// ✅ 2026-08-31 — THE RELEASE PATH IS BUILT, and this paragraph is replaced
// rather than softened because the sentence it used to end with ("Building the
// release path is a card, not a claim to make here") is now false, and a
// comment that goes on describing a gap somebody has closed is this repo's
// most expensive shape. An earlier draft of this same header named a
// `releaseUnclaimedRefund` that never existed; the correction is not to write
// nothing here, it is to write what a reader can grep.
//
// The two ways out, each its own admin-gated route with its own audit action
// (http/ops-refund-release-routes.ts):
//   · POST /api/ops/purchases/refund/settle  — the money DID go back somewhere
//     we cannot see. -> 'refunded', and an external reference is REQUIRED,
//     because that word is a claim about money our system never observed.
//     Repo: `settleOneTimeRefundByHand`.
//   · POST /api/ops/purchases/refund/release — it will not happen. -> back to
//     paid / scheduled / in_progress, with a reason of `provider_declined` or
//     `buyer_withdrew_request`. Repo: `releaseOneTimeRefundRequest`.
//
// 🔴 NEITHER CAN REACH 'delivered', and `advanceOneTimePurchase` still refuses
// a 'refund_requested' row outright. Both refusals stand.
//
// 🔴 AND THE REASON IS NOT A LABEL: `provider_declined` takes the row off the
// unattended no-start sweep for ever (asking a provider that already refused
// THIS row is a loop), while `buyer_withdrew_request` leaves it on. The
// argument is at the top of service-deadlines.ts, where it is spent.
//
// ⚠️ WHAT STILL DISTINGUISHES A STUCK ROW IN THE QUEUE IS `refund_status: null`
// — 「we asked and heard nothing」 as against 「the provider answered」. That is
// unchanged, and it is what an operator looks at before pressing either button.

import type { SubscriptionWriter } from './subscription-writer';
import type { OneTimePurchaseRepo, OneTimePurchaseRow } from '../db/repos/one-time-purchase.repo';
import type { DeadlinePolicy } from './service-deadlines';
import { log } from '../log';

/** Why this refund is being asked for. Stored on the audit trail and used
 *  NOWHERE to decide anything — the decision is the caller's, and a reason that
 *  could change behaviour would be a second decider. */
export type RefundOrigin = 'customer_withdrawal' | 'operator' | 'deadline_no_start';

/**
 * Every `RefundOrigin`, as a runtime table.
 *
 * 🔴 EXISTS SO A TEST CAN COUNT THEM. The union is what the compiler checks;
 * this is what a test can hold up against it. It is typed as a
 * `Record<RefundOrigin, true>` rather than an array so that BOTH a missing
 * member and an extra one are compile errors — a list would let the union grow
 * while the table stayed stale. owner 2026-08-30 removed the fourth member — a
 * completion-deadline origin — with the deadline itself: a refund after
 * completion is a conversation by email, never a clock.
 */
const REFUND_ORIGIN_TABLE: Readonly<Record<RefundOrigin, true>> = {
  customer_withdrawal: true,
  operator: true,
  deadline_no_start: true,
};
export const REFUND_ORIGINS: readonly RefundOrigin[] = Object.keys(REFUND_ORIGIN_TABLE) as RefundOrigin[];

export type ServiceRefundOutcome =
  /** The provider accepted the request. `providerStatus` is its own word and is
   *  usually NON-terminal — the money is not back until the webhook says so. */
  | { ok: true; providerStatus: string | null }
  /** The row was not in a refundable state: already delivered, already
   *  refunded, already requested, or gone. NOT an error — it is the normal
   *  answer to a second click. */
  | { ok: false; reason: 'not_refundable' }
  /** We claimed the row and the provider did not accept. See the header for why
   *  the row is left claimed rather than silently released. */
  | { ok: false; reason: 'provider_refused'; detail: string }
  /** There is no charge on the row to refund against. */
  | { ok: false; reason: 'no_transaction' };

export interface ServiceRefundDeps {
  purchases: Pick<
    OneTimePurchaseRepo,
    'getOneTimePurchase' | 'requestOneTimeRefund' | 'stampRefundProviderFacts'
  >;
  /** Resolved for the purchase's OWN provider by the caller. A fixed client
   *  here would send a Creem order id to Paddle. */
  writer: SubscriptionWriter;
  /** The promised deadlines. ⚠️ UNREAD BY THIS ACTION since gs-5 — the claim is
   *  a state list and needs no date — but kept on the deps so the three
   *  callers keep passing the one policy object, and so a future rule that
   *  does need a period has a place to read it from rather than a second copy.
   *  🔴 REQUIRED, with no default: a default here would be a second copy of a
   *  legal period, and the copy that goes stale is always the one nobody is
   *  looking at. */
  deadlines: DeadlinePolicy;
  now: () => number;
}

/**
 * Ask the provider to refund a one-time purchase, and record that we asked.
 *
 * 🔴 IT NEVER WRITES 'refunded'. That word means the money went back, only the
 * provider can say it, and the webhook is its single writer.
 */
export async function requestServiceRefund(
  deps: ServiceRefundDeps,
  orderId: string,
  origin: RefundOrigin,
): Promise<ServiceRefundOutcome> {
  const row: OneTimePurchaseRow | null = deps.purchases.getOneTimePurchase(orderId);
  if (row === null) return { ok: false, reason: 'not_refundable' };
  if (row.transaction_id === null) {
    // A purchase with no charge recorded against it cannot be refunded through
    // the API — Creem's `POST /v1/refunds` takes a transaction id and nothing
    // else. Its own answer, so an operator is told to go and look rather than
    // being shown a generic failure.
    log.warn('service refund: purchase has no transaction to refund', { order_id: orderId, origin });
    return { ok: false, reason: 'no_transaction' };
  }

  const at = new Date(deps.now()).toISOString();
  // ── the claim, BEFORE the provider call. See the header. ─────────────────
  const claim = deps.purchases.requestOneTimeRefund(
    orderId,
    {
      requested_at: at,
      provider_id: null,
      provider_status: null,
      // ⚠️ NOTHING DATE-SHAPED IS HANDED TO THE SQL (gs-5). The claim is a
      // state list — paid, scheduled, in_progress — and `refundWindow` is its
      // transcription, so the button, the queue badge and the write make one
      // decision with no arithmetic anywhere for them to disagree over.
    },
    at,
  );
  if (claim === 'not_refundable') return { ok: false, reason: 'not_refundable' };

  // 🔴 `reason` IS OURS, from a closed set, and never anything a user typed:
  // it lands in a vendor's dashboard, and a free-text box is how a customer's
  // own words end up somewhere they never agreed to send them.
  const out = await deps.writer.createRefund({ transaction_id: row.transaction_id, reason: origin });
  if (!out.ok) {
    log.error('service refund: the row is claimed but the provider did not accept', {
      order_id: orderId,
      origin,
      code: out.code,
      detail: out.detail,
      // Says out loud what a reader of this line has to do next: the money has
      // NOT moved, and the row will show as requested until somebody acts.
      remedy: 'no money moved; the purchase shows refund_requested and needs a human',
    });
    return { ok: false, reason: 'provider_refused', detail: `${out.code} ${out.detail}` };
  }

  // 🔴 THE PROVIDER'S ID IS RECORDED HERE AND NOT LEFT TO THE WEBHOOK. An
  // earlier draft of this file argued the opposite and was wrong: the claim
  // above is conditional on the state, so it cannot carry these fields back,
  // and relying on the webhook would lose the refund id entirely whenever the
  // webhook did not arrive — on a provider with no way to look one up (Creem
  // has no GET /v1/refunds; probed 404). `stampRefundProviderFacts` writes the
  // two fields and no state, and only onto a row this system already claimed.
  deps.purchases.stampRefundProviderFacts(
    orderId,
    { provider_id: out.data.id, provider_status: out.data.status },
    new Date(deps.now()).toISOString(),
  );
  log.info('service refund requested', {
    order_id: orderId,
    origin,
    provider: deps.writer.provider,
    provider_refund_id: out.data.id,
    // 🔴 VERBATIM, and usually NON-terminal. Nothing downstream may round it up.
    provider_status: out.data.status,
  });
  return { ok: true, providerStatus: out.data.status };
}
