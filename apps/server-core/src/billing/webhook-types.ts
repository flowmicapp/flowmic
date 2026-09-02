// SPEC-REF:
//   apps/server-core/src/billing/paddle/envelope.ts (where these types lived
//     until 2026-08-29, and which re-exports them so no import had to move)
//   apps/server-core/src/billing/paddle/signature.ts (SigVerdict's first author)
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §3.2 / §5.2 / §5.3
//   docs/strategy/2026-08-29-creem-stage0-findings.md (why a second provider)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// The vocabulary two payment providers share. Types only — no logic, no io.
//
// 🔴 WHY THIS FILE EXISTS AT ALL, because "we might want a second provider one
// day" is NOT the reason and would not have been a good one. owner chose Creem
// on 2026-08-29 for the product-validation phase; Paddle stays in the tree with
// its intake live. Two providers exist TODAY, so the choice is not 「abstract or
// not」 but 「where does the difference between them live」.
//
// ⚠️ WHAT IS DELIBERATELY *NOT* ABSTRACTED HERE. The seven-step webhook order,
// the idempotency ledger, the out-of-order guard, and the price→tier lookup are
// NOT provider concerns and are not repeated per provider — they are the
// pipeline, and a second copy of them is a second place for the ordering rule to
// rot. A provider adapter answers exactly two questions:
//   ① did these bytes come from you   (signature)
//   ② what do these bytes say         (envelope + facts)
// Everything after that is the same code for both, which is the only reason
// adding Creem did not double the size of this directory.
//
// 🔴 AND WHAT THE SHARED TYPE MUST NOT DO: flatten a difference that the two
// providers genuinely have. `status` below is the provider's own word, stored
// verbatim, precisely because Creem and Paddle DISAGREE about what a scheduled
// cancellation is (Creem: a status of its own, `scheduled_cancel`; Paddle:
// `active` plus a `scheduled_change` object). A shared enum here would have to
// pick one of those two vocabularies and lie about the other. The normalization
// that IS safe — 「when does the service stop」 — happens in the adapter, into
// `scheduled_change_action` / `scheduled_change_at`, which are two fields that
// answer that one question in both dialects.

/** Which merchant of record a row, an event, or a client belongs to.
 *
 *  🔴 NOT a boolean and never will be, even while there are exactly two. A
 *  `is_creem` flag would have to be re-read as 「not Paddle」 the day a third
 *  arrives, and every call site that had already been written against it would
 *  keep compiling while meaning something else. */
export type BillingProvider = 'paddle' | 'creem';

/** Why a signature header was refused.
 *
 *  Four values because they are four different operator actions: fix the sender
 *  / fix the header / fix the clock / the bytes or the secret are wrong.
 *
 *  ⚠️ `'expired'` IS NOT REACHABLE FOR EVERY PROVIDER, and that is a fact about
 *  the providers, not a gap here. Paddle signs `${ts}:${body}` and ships the
 *  `ts`, so it has a two-sided time window. Creem signs the body ALONE
 *  (`creem-signature` is a bare hex HMAC-SHA256 — measured against their docs
 *  2026-08-29), so there is no timestamp to be outside of and nothing this
 *  layer could compare a clock to. See CreemSignature's header comment for what
 *  carries the replay defence instead; it is not nothing, but it is not here. */
export type SigFailReason = 'missing_header' | 'malformed' | 'expired' | 'mismatch';

export type SigVerdict =
  | { ok: true; tsSkewSec?: number }
  | { ok: false; reason: SigFailReason; tsSkewSec?: number };

/** The webhook envelope every notification shares, whoever sent it. */
export interface WebhookEnvelope {
  /** 🔴 The dedup key. Paddle `evt_xxx`, Creem `evt_xxx` (both providers happen
   *  to use that prefix; nothing here depends on the shape). */
  event_id: string;
  event_type: string;
  /** ALREADY NORMALIZED to RFC3339 by the adapter — the only form that reaches
   *  the DB, so the out-of-order guard compares two strings that are ordered the
   *  same way the instants are.
   *
   *  ⚠️ The two providers hand this over in different units: Paddle sends an
   *  RFC3339 string, Creem sends `created_at` as MILLISECONDS SINCE EPOCH. The
   *  conversion is the adapter's job and happens exactly once, here at the door
   *  — a downstream `Number.isFinite` check would be a second place that has to
   *  know which provider it is looking at. */
  occurred_at: string;
  /** This DELIVERY ATTEMPT's id, when the provider distinguishes it from the
   *  event. Never a dedup key.
   *
   *  ⚠️ NULL FOR CREEM, ALWAYS, and that is honest rather than missing: Creem's
   *  retries (5 attempts over 24h, per their docs) carry the SAME body with no
   *  per-delivery identifier, so 「how many times was this one sent」 is a
   *  question their webhook cannot answer. `redelivery_count` still counts the
   *  claims we refuse as duplicates, which is our own tally and stays true. */
  notification_id: string | null;
  data: Record<string, unknown>;
}

export type EnvelopeParse =
  | { ok: true; envelope: WebhookEnvelope }
  /** One sentence naming the field, for the 400's log line. 🔴 Never echoes a
   *  VALUE from the payload: the body carries an email and may carry an
   *  address. */
  | { ok: false; reason: string };

/**
 * What an event says about a subscription, in one shape for both providers.
 *
 * Every field is `| null | undefined` on purpose and the two are NOT the same:
 * `undefined` = the event did not mention this at all, `null` = the event said
 * it is empty. The upsert distinguishes them, because 「this event is silent
 * about the cancellation date」 and 「the cancellation was revoked」 are different
 * instructions and collapsing them writes the wrong one.
 */
export interface SubscriptionFacts {
  /** Absent for an event that names no subscription at all. */
  subscription_id: string | null;
  customer_id: string | null | undefined;
  /** 🔴 THE PROVIDER'S OWN STATUS WORD, VERBATIM. Translation is `tier`'s job,
   *  and the two vocabularies are not merged — see this file's header. */
  status: string | null | undefined;
  /** Every price/product id the event mentions, in payload order. The
   *  price → tier mapping is NOT applied here — that is config, and it lives in
   *  the pipeline so there is exactly one place a tier can be decided.
   *
   *  ⚠️ FOR CREEM THESE ARE PRODUCT IDS (`prod_xxx`), for Paddle they are PRICE
   *  ids (`pri_xxx`). The tier table is keyed by whatever the provider's own
   *  identifier is, so the two configs are not interchangeable and are two env
   *  vars for that reason. A shared table would map an id from one provider
   *  against the other's keys, find nothing, and file a correct-looking
   *  `unmapped` row for a payment that was fine. */
  price_ids: string[];
  cycle: string | null | undefined;
  current_period_end: string | null | undefined;
  canceled_at: string | null | undefined;
  /** What we put on the checkout so an event can name its buyer. A CLAIM, not
   *  an identity: the pipeline still has to find that account. */
  claimed_user_id: string | null;
  /** `'cancel' | 'pause' | 'resume'`, or the three-way absent/null.
   *
   *  ⚠️ THE `null` CASE IS LOAD-BEARING AND IS NOT A ROUNDING OF `undefined` —
   *  it is how a REVOKED cancellation clears the columns. Collapsing
   *  absent-into-null would wipe them on every unrelated event; the reverse
   *  collapse would leave 「will not renew」 painted on a subscription the user
   *  just rescued. Both mistakes are silent and both are visible only to the
   *  person being billed. */
  scheduled_change_action: string | null | undefined;
  /** The date the console renders as 「service runs until X」. Read from the same
   *  place as the action above, so the two cannot disagree about which change
   *  they describe. */
  scheduled_change_at: string | null | undefined;
  /** 「you will be charged again on」. A SEPARATE question from
   *  `current_period_end`, which keeps answering 「how long you have paid for」
   *  and does not go away when a cancellation is scheduled. */
  next_billed_at: string | null | undefined;
  /** When this subscription began — our best evidence of when the distance
   *  contract was concluded, and so the start of the EU 14-day withdrawal
   *  window (CRD art. 9). WRITE-ONCE at the repo, from the first event that
   *  states it.
   *
   *  ⚠️ THE FIELD IS `started_at` AND THE COLUMN IS `contract_concluded_at`,
   *  and the two names are not an accident to be tidied up. The field is what
   *  the provider told us (a subscription start); the column is what we use it
   *  for (a legal deadline). Renaming either to match the other would make one
   *  of the two lie about where its value came from. */
  started_at: string | null | undefined;
}

/**
 * The whole of what a provider contributes to webhook intake.
 *
 * 🔴 NO METHOD HERE TOUCHES THE DATABASE, THE CLOCK-AS-STATE, OR THE NETWORK.
 * That is what makes every branch of both adapters reachable from a unit test
 * without a server, which is the only way the refusal reasons can be shown to
 * be different answers rather than one 401 wearing several labels.
 */
export interface BillingProviderAdapter {
  readonly id: BillingProvider;
  /** Lower-case, because Node lower-cases incoming header names. */
  readonly signatureHeader: string;
  /**
   * @param toleranceSec ignored by providers that do not sign a timestamp. It
   *   is on the shared signature rather than in a provider-specific options bag
   *   so the pipeline does not have to know which kind it is holding — and
   *   `CreemSignature` documents, in its own file, that it ignores it and why
   *   that is not a silent drop.
   */
  verifySignature(rawBody: string, header: string | undefined, secret: string, toleranceSec: number, nowMs: number): SigVerdict;
  parseEnvelope(raw: unknown): EnvelopeParse;
  readSubscriptionFacts(envelope: WebhookEnvelope): SubscriptionFacts;
  /** Does this event type describe the subscription itself? Events that do not
   *  are recorded and ignored, never guessed at. */
  isSubscriptionEvent(eventType: string): boolean;
  /**
   * Events we RECOGNISE and deliberately do not act on.
   *
   * 🔴 THE DISTINCTION FROM 「not a subscription event」 IS THE WHOLE POINT OF THE
   * RECONCILIATION VIEW, and it is provider-specific because each provider emits
   * a different set. `ignored` means 「we do not know this event type」 and an
   * operator seeing it should ask whether we are missing something; these ARE
   * known and we chose to do nothing. Folding them together makes 「unknown
   * event」 and 「known no-op」 one value — and the one that gets buried under a
   * permanent stream of the other is the one that needs a human.
   *
   * Paddle: `transaction.payment_failed`, `adjustment.created`.
   * Creem:  `refund.created`, `dispute.created`.
   */
  isLedgerOnlyEvent(eventType: string): boolean;
  /**
   * The one-time (non-subscription) purchase this event completes, or null.
   *
   * 🔴 ONLY EVER NON-NULL FOR A COMPLETED CHECKOUT THAT CARRIES NO SUBSCRIPTION.
   * A checkout that DID create a subscription is not a one-time purchase and
   * must not produce both records — the tier it grants is already the whole
   * story, and a second row saying 「they also bought something」 would be
   * counted twice by anything summing what a person has paid for.
   */
  readOneTimePurchase(envelope: WebhookEnvelope): OneTimePurchaseFacts | null;
  /**
   * A refund this provider is telling us about, or null when the event is not
   * one.
   *
   * 🔴 `order_id: null` INSIDE A NON-NULL RESULT IS A REAL AND DIFFERENT ANSWER
   * from returning null. Null means 「this is not a refund event」; a refund with
   * no readable order means 「a refund happened and we cannot say whose」, which
   * has to reach the ledger as `unmapped` and be looked at by a person. Folding
   * them together would turn money moving back into silence.
   */
  readRefund(envelope: WebhookEnvelope): RefundFacts | null;
}

/** What a refund event tells us. */
export interface RefundFacts {
  /** The order the money is going back for, or null if the event did not say. */
  order_id: string | null;
  /** The provider's id for the refund — a handle for a human. */
  provider_id: string | null;
  /** The provider's own status word, verbatim. Never rounded to a boolean. */
  provider_status: string | null;
}

/**
 * A completed purchase that is NOT a subscription — today, the $200 Guided
 * Setup service.
 *
 * 🔴 WHY THIS IS A SEPARATE SHAPE AND NOT A `SubscriptionFacts` WITH NULLS. A
 * subscription answers 「what is this account entitled to, until when」 and is
 * consumed by the plan resolver. This answers 「what did this person buy, and
 * have we delivered it」 and is consumed by a human. They have different
 * lifecycles, different terminal states, and — the part that actually bites —
 * DIFFERENT WITHDRAWAL LAW: a service bought once loses its 14-day right only
 * once it is fully performed with the buyer's prior express consent, which is
 * not how a subscription's period works at all. One table for both would have
 * to carry a nullable column for every one of those differences and a reader
 * would have to know which kind it was holding before it could read any of them.
 */
export interface OneTimePurchaseFacts {
  /** The provider's order id. 🔴 THE IDEMPOTENCY KEY for the purchase row —
   *  distinct from the event id, because a redelivered `checkout.completed` and
   *  a genuinely repeated purchase must not look the same. */
  order_id: string;
  /** The payment, so a refund has something to name. Null when the body did not
   *  carry one — recorded as absent rather than guessed. */
  transaction_id: string | null;
  checkout_id: string | null;
  product_id: string | null;
  customer_id: string | null;
  /** Minor units, as the provider stated them. Never re-derived from a
   *  formatted string. */
  amount_minor: number | null;
  currency: string | null;
  /** The buyer's claim, resolved by the pipeline exactly as a subscription's is. */
  claimed_user_id: string | null;
  /** What the buyer affirmed at checkout, round-tripped through the provider's
   *  metadata. 🔴 OUR OWN STAMPS, generated server-side when the checkout was
   *  created — not a value the buyer supplied and not one the provider invents.
   *  Null on any purchase whose checkout we did not build. */
  early_start_consent_at: string | null;
  withdrawal_waiver_ack_at: string | null;
  consent_terms_version: string | null;
}
