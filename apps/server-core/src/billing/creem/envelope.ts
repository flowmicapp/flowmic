// SPEC-REF:
//   apps/server-core/src/billing/webhook-types.ts (the shapes produced here)
//   apps/server-core/src/billing/paddle/envelope.ts (the sibling; `normalizeRfc3339`
//     is imported from it rather than re-written — one normalizer, one ordering)
//   https://docs.creem.io/code/webhooks — every field path below was read off
//     the published sample bodies on 2026-08-29
//   docs/strategy/2026-08-29-creem-stage0-findings.md §2b (the live objects these
//     paths were checked against)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Creem's webhook body → the shared `WebhookEnvelope` / `SubscriptionFacts`.
// Pure: bytes-as-parsed-JSON in, plain data out. No clock, no io, no config.
//
// ── THE ENVELOPE ───────────────────────────────────────────────────────────
//   { id: 'evt_…', eventType: 'subscription.paid', created_at: 1728734327355,
//     object: { … } }
//
// Three ways this differs from Paddle's, all of which are handled HERE so that
// nothing downstream has to know which provider it is looking at:
//   ① `eventType` is camelCase, not `event_type`.
//   ② `created_at` is MILLISECONDS SINCE EPOCH, not an RFC3339 string. It is
//      converted once, at the door.
//   ③ There is no per-delivery identifier at all ⇒ `notification_id: null`,
//      always. See WebhookEnvelope's comment for why that is honest rather than
//      missing.
//
// ── THE OBJECT COMES IN TWO SHAPES AND THAT IS THE WHOLE DIFFICULTY ────────
//
// For `subscription.*` the object IS the subscription. For `checkout.completed`
// the object is a CHECKOUT, and the subscription hangs off it at
// `object.subscription` — with the product and customer duplicated at the outer
// level in a DIFFERENT form (`order.product` is a bare id string, while
// `object.product` is a full object). Reading the outer one for a checkout event
// would give a correct-looking answer built from the wrong nesting level, which
// is the failure that leaves no trace: the ids are real, they are just not the
// subscription's.
//
// ⇒ `subjectOf()` below picks the subscription object ONCE, and every field is
// read from what it returns. There is no second path.

import { GUIDED_SETUP_META } from '../guided-setup';
import type { EnvelopeParse, OneTimePurchaseFacts, SubscriptionFacts, WebhookEnvelope } from '../webhook-types';
import { normalizeRfc3339 } from '../paddle/envelope';

/** Events that describe THE SUBSCRIPTION ITSELF.
 *
 * 🔴 `checkout.completed` IS IN THIS SET, and its Paddle counterpart is not —
 * because at Creem it is the event that carries the metadata we put on the
 * checkout, i.e. the ONLY one that can name the buyer on a brand-new
 * subscription. Leaving it out would mean the first event we could map is the
 * one AFTER the money moved.
 *
 * ⚠️ `subscription.active` is here too even though Creem's own docs say 「use
 * only for synchronization, we encourage using `subscription.paid` for
 * activating access」. That advice is about GRANTING ACCESS, which this pipeline
 * does not do from the event — it stores facts, and the tier is resolved from
 * the stored row. Storing an `active` we were told about is not the same as
 * granting on it.
 *
 * ⚠️ NOT IN THIS SET, deliberately: `refund.created` and `dispute.created`.
 * They are real events and they are recorded in the ledger as `ignored` with
 * their type — but they describe a PAYMENT, not the subscription, and routing
 * them through the subscription upsert would write a subscription row from a
 * body that never stated a subscription status. When they get a consumer it
 * will be their own path, not this one. */
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'checkout.completed',
  'subscription.active',
  'subscription.paid',
  'subscription.trialing',
  'subscription.update',
  'subscription.scheduled_cancel',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.unpaid',
  'subscription.expired',
  'subscription.paused',
]);

export function isCreemSubscriptionEvent(eventType: string): boolean {
  return SUBSCRIPTION_EVENTS.has(eventType);
}

/** Events we RECOGNISE and deliberately do not act on — see
 *  `BillingProviderAdapter.isLedgerOnlyEvent` for why this is not the same as
 *  「not a subscription event」.
 *
 *  ⚠️ `refund.created` IS IN HERE RATHER THAN DRIVING ANYTHING, and that is a
 *  statement about today, not a design opinion. A refund we issued is already
 *  recorded by the code that issued it; a refund issued from Creem's own
 *  dashboard is not, and this event is the only way we would hear about it.
 *  Acting on it needs a decision about what a dashboard-issued refund should do
 *  to a tier — which is a product question nobody has answered — so the honest
 *  state today is 「recorded, and visible in the reconciliation view as a known
 *  no-op」 rather than a guess wearing an implementation. */
const LEDGER_ONLY_EVENTS: ReadonlySet<string> = new Set(['refund.created', 'dispute.created']);

/** The refund events. 🔴 SUBTRACTED from the ledger-only set below rather than
 *  added beside it: they used to be recorded and ignored, and 「ignored」 was the
 *  bug — a refund issued from Creem's dashboard left our row saying the money
 *  was still ours and the customer's console still offering to withdraw it. */
const REFUND_EVENTS: ReadonlySet<string> = new Set(['refund.created']);

export function isCreemRefundEvent(eventType: string): boolean {
  return REFUND_EVENTS.has(eventType);
}

/**
 * Which ORDER a refund event is about, or null.
 *
 * ⚠️ THE FIELD NAMES ARE READ, NOT INVENTED. A live Creem transaction carries
 * `order`, `subscription` and `customer` as bare id strings (measured
 * 2026-08-29 on a real refunded transaction), so those are the names looked for
 * here — on the refund object itself and on a transaction nested under it.
 *
 * 🔴 AND IT RETURNS null RATHER THAN GUESSING when it cannot find one. A refund
 * we cannot attribute must land in the ledger as `unmapped`, loudly, so a
 * person goes and looks — never as a silent no-op on a row that then keeps
 * telling a customer their money is still with us.
 */
export function readCreemRefundOrderId(envelope: WebhookEnvelope): string | null {
  const o = asObject(envelope.data);
  if (o === null) return null;
  for (const holder of [o, asObject(o.transaction), asObject(o.order)]) {
    if (holder === null) continue;
    const direct = asString(holder.order) ?? asString(holder.order_id);
    if (direct !== null) return direct;
    const nested = asObject(holder.order);
    const nestedId = nested === null ? null : asString(nested.id);
    if (nestedId !== null) return nestedId;
  }
  // A refund object whose own id names the order is not a shape we have seen;
  // `o.id` is the REFUND's id and must never be read as an order's.
  return null;
}

/** The provider's own refund id and status word, for the row. Both may be
 *  absent; neither is invented, and `refund_status` is stored verbatim. */
export function readCreemRefundFacts(
  envelope: WebhookEnvelope,
): { provider_id: string | null; provider_status: string | null } {
  const o = asObject(envelope.data);
  return {
    provider_id: o === null ? null : asString(o.id),
    provider_status: o === null ? null : asString(o.status),
  };
}

export function isCreemLedgerOnlyEvent(eventType: string): boolean {
  return LEDGER_ONLY_EVENTS.has(eventType);
}

/** The metadata key we put on every checkout so its events can name their buyer.
 *
 *  🔴 THE SAME NAME AS PADDLE'S `custom_data.flowmic_user_id`, on purpose: it is
 *  our key in our namespace, and using two spellings for one fact across two
 *  providers is how a search for 「where does the user id come from」 ends up
 *  finding one of them. */
export const CREEM_USER_ID_KEY = 'flowmic_user_id';

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** `{id: 'x'}` or `'x'` → `'x'`. Creem gives ids both ways depending on nesting
 *  depth (`object.customer` is an object, `order.customer` is a string), and a
 *  reader that handled only one would return `undefined` for half the events. */
function idOf(v: unknown): string | null {
  const direct = asString(v);
  if (direct !== null) return direct;
  const obj = asObject(v);
  return obj ? asString(obj.id) : null;
}

/** ms-epoch → RFC3339, via the SAME normalizer Paddle's stamps go through, so
 *  the out-of-order guard is comparing strings built by one function.
 *
 *  ⚠️ Rejects non-finite and out-of-range values rather than clamping: a stamp
 *  we cannot order is worse than a refused envelope, because it silently wins
 *  or loses every comparison it is in. */
function rfc3339FromMs(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const d = new Date(v);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return normalizeRfc3339(d.toISOString());
}

export function parseCreemEnvelope(raw: unknown): EnvelopeParse {
  const root = asObject(raw);
  if (root === null) return { ok: false, reason: 'body is not a JSON object' };

  const eventId = asString(root.id);
  if (eventId === null) return { ok: false, reason: 'id is missing or blank' };

  const eventType = asString(root.eventType);
  if (eventType === null) return { ok: false, reason: 'eventType is missing or blank' };

  // `created_at` is required. It is the out-of-order guard's only ruler, and a
  // guard with no ruler does not degrade — it compares against `undefined` and
  // lets every stale event through. Refusing here (400, no DB write) is the
  // fail-closed direction.
  const occurredAt = rfc3339FromMs(root.created_at);
  if (occurredAt === null) return { ok: false, reason: 'created_at is missing or not a finite ms timestamp' };

  const data = asObject(root.object);
  if (data === null) return { ok: false, reason: 'object is missing or not a JSON object' };

  return {
    ok: true,
    envelope: { event_id: eventId, event_type: eventType, occurred_at: occurredAt, notification_id: null, data },
  };
}

/** The subscription this event is about, whichever shape it arrived in.
 *  Returns null when the event names none — which is a real outcome, not an
 *  error: a `checkout.completed` for the one-time Guided Setup product has no
 *  subscription and must not be made to look like it does. */
function subjectOf(envelope: WebhookEnvelope): Record<string, unknown> | null {
  if (envelope.event_type === 'checkout.completed') {
    return asObject(envelope.data.subscription);
  }
  return envelope.data;
}

/**
 * The one-time purchase this event completes, or null.
 *
 * 🔴 THE GUARD IS 「THIS CHECKOUT CREATED NO SUBSCRIPTION」, NOT 「the product
 * looks one-time」. Reading `order.type === 'onetime'` or checking the product id
 * against a configured list would both be a SECOND opinion about something the
 * payload already states outright, and the day the two disagreed we would write
 * a purchase row for a subscription (counted twice by anything summing what a
 * person paid) or drop a real purchase on the floor. There is one question here
 * — did this checkout produce a subscription — and `object.subscription` is its
 * answer.
 *
 * ⚠️ AN UNPAID CHECKOUT IS NOT A PURCHASE. `checkout.completed` is emitted for a
 * completed CHECKOUT SESSION, and `order.status` is the separate fact of whether
 * money moved. Recording a row on the strength of the event NAME would show the
 * buyer a purchase they were never charged for — 「no silent failure」 has a
 * mirror image, and this is it: no silent success either.
 */
export function readCreemOneTimePurchase(envelope: WebhookEnvelope): OneTimePurchaseFacts | null {
  if (envelope.event_type !== 'checkout.completed') return null;
  if (asObject(envelope.data.subscription) !== null) return null;

  const order = asObject(envelope.data.order);
  if (order === null) return null;
  if (asString(order.status) !== 'paid') return null;

  const orderId = asString(order.id);
  if (orderId === null) return null; // no idempotency key ⇒ nothing safe to write

  const meta = asObject(envelope.data.metadata);
  const amount = typeof order.amount === 'number' && Number.isFinite(order.amount) ? order.amount : null;

  return {
    order_id: orderId,
    // ⚠️ NOT PRESENT on a `checkout.completed` body as Creem publishes it today.
    // Recorded as null rather than reaching for the order id, which is a
    // DIFFERENT identifier and would be rejected by `POST /v1/refunds`. The
    // refund path resolves the transaction by asking, and its own code says so.
    transaction_id: asString(order.transaction),
    checkout_id: asString(envelope.data.id),
    product_id: idOf(order.product) ?? idOf(envelope.data.product),
    customer_id: idOf(order.customer) ?? idOf(envelope.data.customer),
    amount_minor: amount,
    currency: asString(order.currency),
    claimed_user_id: asString(meta?.[CREEM_USER_ID_KEY]),
    // What the buyer affirmed, round-tripped through metadata we set ourselves
    // when we built the checkout. Absent ⇒ null ⇒ 「no consent on record」, which
    // is the conservative reading: the withdrawal right is intact.
    early_start_consent_at: normalizeRfc3339(meta?.[GUIDED_SETUP_META.earlyStartAt]),
    withdrawal_waiver_ack_at: normalizeRfc3339(meta?.[GUIDED_SETUP_META.waiverAckAt]),
    // 🔴 ONLY KEPT WHEN BOTH STAMPS SURVIVED. A version id beside a missing stamp
    // would name wording nobody is recorded as having agreed to — a citation with
    // no consent behind it, which reads in a dispute as though there were one.
    consent_terms_version:
      normalizeRfc3339(meta?.[GUIDED_SETUP_META.earlyStartAt]) !== null &&
      normalizeRfc3339(meta?.[GUIDED_SETUP_META.waiverAckAt]) !== null
        ? asString(meta?.[GUIDED_SETUP_META.consentVersion])
        : null,
  };
}

/** Creem's `billing_period` → the `cycle` column.
 *
 *  ⚠️ Anything other than the two we sell is passed through VERBATIM rather
 *  than folded to null. Null means 「the event did not say」, and quarterly is
 *  not that — it is a cycle we can read and do not currently sell, and writing
 *  null would turn a fact we hold into a gap. (Same rule as `status`: the
 *  provider's word, unless we have a translation that is exact.) */
function cycleOf(billingPeriod: string | null): string | null {
  if (billingPeriod === 'every-month') return 'monthly';
  if (billingPeriod === 'every-year') return 'yearly';
  return billingPeriod;
}

export function readCreemSubscriptionFacts(envelope: WebhookEnvelope): SubscriptionFacts {
  const sub = subjectOf(envelope);
  const checkoutMeta = envelope.event_type === 'checkout.completed' ? asObject(envelope.data.metadata) : null;
  const subMeta = sub ? asObject(sub.metadata) : null;

  // The buyer's claim, from the subscription's own metadata first and the
  // checkout's second. Both are OUR value, copied by Creem from what we sent;
  // reading the subscription's first means a renewal (which has no checkout
  // around it) resolves by the same rule as the first payment.
  const claimed = asString(subMeta?.[CREEM_USER_ID_KEY]) ?? asString(checkoutMeta?.[CREEM_USER_ID_KEY]);

  if (sub === null) {
    return {
      subscription_id: null,
      customer_id: idOf(envelope.data.customer) ?? undefined,
      status: undefined,
      price_ids: [],
      cycle: undefined,
      current_period_end: undefined,
      canceled_at: undefined,
      claimed_user_id: claimed,
      scheduled_change_action: undefined,
      scheduled_change_at: undefined,
      next_billed_at: undefined,
      started_at: undefined,
    };
  }

  const status = asString(sub.status);
  const productId = idOf(sub.product);
  const periodEnd = normalizeRfc3339(sub.current_period_end_date);

  // ── 🔴 THE ONE REAL TRANSLATION IN THIS FILE ───────────────────────────────
  //
  // CREEM AND PADDLE DISAGREE ABOUT WHAT A SCHEDULED CANCELLATION *IS*. Paddle
  // says `status: 'active'` plus a `scheduled_change` object; Creem says
  // `status: 'scheduled_cancel'` and has no such object. Our columns were built
  // to Paddle's shape — for a good reason recorded in schema-billing.ts: before
  // they existed the console had ONE word for TWO facts.
  //
  // So the columns keep their meaning and Creem's status is projected onto
  // them. `status` itself still stores Creem's word verbatim; these two are the
  // derived answer to 「when does the service stop」, which is the question the
  // console actually asks.
  //
  // ⚠️ THE `null` ARM IS THE LOAD-BEARING HALF, and it is what makes a RESUME
  // work. Creem's resume moves the status back to `active`; if that produced
  // `undefined` here the upsert would leave the old 「will not renew」 painted on
  // a subscription the user just rescued — which is precisely the failure
  // SubscriptionFacts' own comment warns about, arriving through a different
  // door. `undefined` is reserved for the one case where it is true: an event
  // that carried no status at all.
  const scheduledCancel = status === 'scheduled_cancel';
  const scheduledChangeAction = status === null ? undefined : scheduledCancel ? 'cancel' : null;
  const scheduledChangeAt = status === null ? undefined : scheduledCancel ? periodEnd : null;

  return {
    subscription_id: asString(sub.id),
    customer_id: idOf(sub.customer) ?? undefined,
    status: status ?? undefined,
    // 🔴 PRODUCT ids, not price ids — see SubscriptionFacts.price_ids. The tier
    // table for Creem is keyed by `prod_xxx` and is a different env var from
    // Paddle's for exactly this reason.
    price_ids: productId === null ? [] : [productId],
    cycle: cycleOf(asString(asObject(sub.product)?.billing_period)) ?? undefined,
    current_period_end: periodEnd ?? undefined,
    // `in` rather than `?? undefined`: Creem sends `canceled_at: null` on a live
    // subscription, and that null is the instruction 「there is no cancellation」.
    // Folding it to `undefined` would make a resume unable to clear a stamp the
    // previous cancel wrote.
    canceled_at: 'canceled_at' in sub ? normalizeRfc3339(sub.canceled_at) : undefined,
    claimed_user_id: claimed,
    scheduled_change_action: scheduledChangeAction,
    scheduled_change_at: scheduledChangeAt,
    next_billed_at: normalizeRfc3339(sub.next_transaction_date) ?? undefined,
    // The subscription's own creation stamp. WRITE-ONCE at the repo (into
    // `contract_concluded_at`), so the earliest event that states it wins and no
    // later one can move a deadline that is already running.
    //
    // ⚠️ Creem has no separate `started_at`; `created_at` on the subscription IS
    // when it began. Reading the ENVELOPE's `created_at` instead — which is
    // right there one level up and is the event's own stamp — would restart the
    // withdrawal clock on whichever event happened to arrive first.
    started_at: normalizeRfc3339(sub.created_at) ?? undefined,
  };
}
