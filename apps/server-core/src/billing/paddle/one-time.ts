// SPEC-REF:
//   apps/server-core/src/billing/webhook-types.ts (OneTimePurchaseFacts, RefundFacts)
//   apps/server-core/src/billing/creem/envelope.ts (the same two readers, for Creem)
//   apps/server-core/src/billing/paddle/webhook-handler.ts steps 5b and 6
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Paddle's side of「somebody bought the one-time service」and「their money went
// back」. Until 2026-08-31 both of these returned null from `paddle/adapter.ts`,
// and the comment there said why: the service existed in Creem and nowhere else.
// Creem's KYC did not complete, the owner moved all collection to Paddle, and
// that comment ended with the instruction this file is carrying out —
//
//   ⚠️ IF A ONE-TIME PRODUCT IS EVER SOLD THROUGH PADDLE, this must be
//   implemented rather than left to return null — a null here would then mean
//  「we took the money and recorded nothing」, and it would be silent.
//
// ── 🔴 THE FIELD NAMES HERE WERE MEASURED, NOT GUESSED ──────────────────────
// A real transaction was created in the Paddle sandbox on 2026-08-31 and its
// body read back (`txn_01m1betgw209g55x85kbe3jq2c`, since canceled). The event
// names were listed from `GET /event-types` on the same account rather than
// from memory. What that measurement changed:
//   · `details.totals.total` is a STRING ("20000"), not a number. The contract
//     wants minor units as a number, so it is parsed — and a value that does not
//     parse becomes null rather than NaN, because NaN in a money column is a
//     number that compares false with itself.
//   · a one-time transaction carries an EMPTY `subscription_id`, which is what
//     separates it from the transaction that renews somebody's Pro plan.
//   · the consent stamps ride in `custom_data`, the same object Paddle already
//     carries `flowmic_user_id` in.

import { GUIDED_SETUP_META } from '../guided-setup';
import type { OneTimePurchaseFacts, RefundFacts, WebhookEnvelope } from '../webhook-types';
import { normalizeRfc3339 } from './envelope';

/** The event that says a payment we can fulfil actually completed.
 *
 *  ⚠️ `transaction.completed`, NOT `transaction.paid`. Paddle emits both, and
 *  `paid` fires when the money is captured while `completed` fires when the
 *  transaction is finished being processed. Fulfilment hangs off the second one;
 *  keying off the first would record a purchase for a transaction Paddle may
 *  still revise. */
const ONE_TIME_EVENTS: ReadonlySet<string> = new Set(['transaction.completed']);

/** Both adjustment events, because an adjustment's STATUS is the fact we need
 *  and it can arrive on either — created already settled, or created pending and
 *  settled by a later update. */
const REFUND_EVENTS: ReadonlySet<string> = new Set(['adjustment.created', 'adjustment.updated']);

/**
 * 🔴 THE STATUS IS THE JUDGEMENT, NOT THE EVENT NAME — and this is the single
 * most important line in the file.
 *
 * Creem's `refund.created` means the money went back. Paddle's
 * `adjustment.created` does NOT: on a live account a refund is usually created
 * `pending_approval`, and this repo already knows it — `mock-client.ts` returns
 * `pending_approval` on purpose, with a comment saying a mock that answered
 * `approved` would let a surface round「requested」up to「refunded」.
 *
 * Treating `adjustment.created` as a refund the way Creem's reader treats
 * `refund.created` would therefore tell a buyer their money is back while Paddle
 * has not yet moved it — the exact shape the ops console's refund-release work
 * was built to eliminate ("refunded" is a claim about money our system never
 * observed). So an unsettled adjustment reads as null here and lands in the
 * ledger as a recorded non-event, which is the truth: we heard that a refund was
 * asked for.
 */
const REFUND_SETTLED_STATUSES: ReadonlySet<string> = new Set(['approved']);

export function isPaddleOneTimeEvent(eventType: string): boolean {
  return ONE_TIME_EVENTS.has(eventType);
}

export function isPaddleRefundEvent(eventType: string): boolean {
  return REFUND_EVENTS.has(eventType);
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Paddle states money as a STRING of minor units. Anything that is not a whole
 *  number of them is absent, never NaN and never rounded. */
function minorUnits(v: unknown): number | null {
  const raw = typeof v === 'number' ? String(v) : asString(v);
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The product this transaction was for, from its first line item. */
function firstProductId(data: Record<string, unknown>): string | null {
  const items = Array.isArray(data.items) ? data.items : [];
  for (const item of items) {
    const price = asObject(asObject(item)?.price);
    const id = price === null ? null : asString(price.product_id);
    if (id !== null) return id;
  }
  return null;
}

/**
 * A completed one-time purchase, or null when this event is not one.
 *
 * 🔴 `order_id` AND `transaction_id` ARE THE SAME VALUE HERE, AND THAT IS
 * CORRECT RATHER THAN LAZY. Paddle has no separate order entity: the transaction
 * is both the thing that gets an idempotency key and the thing a refund names
 * (`POST /adjustments` takes `transaction_id`). Creem has two ids because Creem
 * has two entities. Writing the same id into both columns is the honest
 * translation; inventing a second id so the columns look different would be the
 * lie.
 */
export function readPaddleOneTimePurchase(envelope: WebhookEnvelope): OneTimePurchaseFacts | null {
  if (!ONE_TIME_EVENTS.has(envelope.event_type)) return null;
  const data = asObject(envelope.data);
  if (data === null) return null;

  // 🔴 THE LINE THAT KEEPS A PRO RENEWAL OUT OF THE SERVICE TABLE. Subscription
  // charges emit `transaction.completed` too; a one-time transaction carries no
  // subscription id (measured). Without this every renewal would mint a row
  // claiming somebody bought the setup service.
  if (asString(data.subscription_id) !== null) return null;

  // Paddle's own word for the transaction. Anything other than `completed`
  // reaching a `transaction.completed` handler is a shape we do not understand,
  // and money is not the place to assume.
  if (asString(data.status) !== 'completed') return null;

  const transactionId = asString(data.id);
  if (transactionId === null) return null; // no idempotency key ⇒ nothing safe to write

  const custom = asObject(data.custom_data);
  const totals = asObject(asObject(data.details)?.totals);

  const earlyStart = normalizeRfc3339(custom?.[GUIDED_SETUP_META.earlyStartAt]);
  const waiverAck = normalizeRfc3339(custom?.[GUIDED_SETUP_META.waiverAckAt]);

  return {
    order_id: transactionId,
    transaction_id: transactionId,
    // Paddle's hosted checkout is not an entity we get an id for on this body.
    // Recorded as absent rather than filled with something that is not one.
    checkout_id: null,
    product_id: firstProductId(data),
    customer_id: asString(data.customer_id),
    // `grand_total` is what the buyer was actually charged; `total` excludes
    // credit applied from a balance. The buyer's number is the one a refund
    // conversation is about.
    amount_minor: minorUnits(totals?.grand_total) ?? minorUnits(totals?.total),
    currency: asString(data.currency_code),
    claimed_user_id: custom === null ? null : asString(custom.flowmic_user_id),
    early_start_consent_at: earlyStart,
    withdrawal_waiver_ack_at: waiverAck,
    // 🔴 ONLY KEPT WHEN BOTH STAMPS SURVIVED — identical to Creem's reader and
    // for the identical reason: a version id beside a missing stamp names
    // wording nobody is recorded as having agreed to, which reads in a dispute
    // as though there were consent behind it.
    consent_terms_version:
      earlyStart !== null && waiverAck !== null ? asString(custom?.[GUIDED_SETUP_META.consentVersion]) : null,
  };
}

/**
 * A refund that has actually happened, or null.
 *
 * ⚠️ Null here means「this event is not a settled refund」— which covers three
 * different situations on purpose, because the pipeline's response to all three
 * is the same (record it, change nothing): not an adjustment event at all, an
 * adjustment that is not a refund (a credit or a chargeback is neither), and a
 * refund that Paddle has not approved yet.
 *
 * 🔴 A NON-NULL RESULT WITH `order_id: null` IS A DIFFERENT ANSWER AGAIN, and
 * the interface says so: money moved and we cannot say whose. That has to reach
 * the ledger as `unmapped` so a person looks, never as silence.
 */
export function readPaddleRefund(envelope: WebhookEnvelope): RefundFacts | null {
  if (!REFUND_EVENTS.has(envelope.event_type)) return null;
  const data = asObject(envelope.data);
  if (data === null) return null;

  // A credit or a chargeback is not us returning a payment, and the one-time
  // row's `refunded` state is a claim about the buyer getting their money back.
  if (asString(data.action) !== 'refund') return null;

  const status = asString(data.status);
  if (status === null || !REFUND_SETTLED_STATUSES.has(status)) return null;

  return {
    order_id: asString(data.transaction_id),
    provider_id: asString(data.id),
    // Verbatim, never rounded to a boolean — the row has to stay readable a year
    // later by somebody asking what the provider actually said.
    provider_status: status,
  };
}
