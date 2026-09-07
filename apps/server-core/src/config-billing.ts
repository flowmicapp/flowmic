// SPEC-REF:
//   apps/server-core/src/config.ts (the loader; it resolves these from env)
//   apps/server-core/src/billing/paddle/webhook-handler.ts
//   apps/server-core/src/billing/creem/adapter.ts
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// The two merchants of record, as CONFIGURATION SHAPES.
//
// 🔴 WHY THEY MOVED OUT OF config.ts (2026-09-04): that file crossed the repo's
// 800-line cap when the subscription checkout added two Creem settings. The
// precedent is to SPLIT AND KEEP THE EVIDENCE rather than compress the reasoning
// away — schema.ts → schema-billing.ts, bootstrap-http-deps.ts →
// bootstrap-billing-deps.ts. Not one word of the argument below changed.
//
// 🔴 AND THEY ARE TYPES ONLY, deliberately. The resolvers stay in config.ts with
// the loader, so this file imports nothing from it and there is no cycle to
// break later. What lives here is the part an auditor reads to answer 「what can
// a deployment configure about money」 — in one file, with its reasons.

import type { Plan } from '@flowmic/protocol';

export type PaddleEnv = 'sandbox' | 'production';

/** Paddle sandbox/production intake. We are NOT a payment processor: Paddle is
 *  the merchant of record and this block only describes how we authenticate the
 *  webhooks it sends us and how we translate its price ids into our tiers. */
export interface PaddleConfig {
  /** FLOWMIC_PADDLE_ENABLED. saas-only (forced false in standalone). */
  enabled: boolean;
  /** FLOWMIC_PADDLE_ENV. Default 'sandbox' — production must be said out loud. */
  env: PaddleEnv;
  /** FLOWMIC_PADDLE_WEBHOOK_SECRET. 🔴 NEVER logged, never persisted. */
  webhookSecret: string | null;
  /** FLOWMIC_PADDLE_API_KEY. 🔴 Same handling as the webhook secret.
   *
   *  ⚠️ 2026-08-21 CORRECTION (0.3.25 B2). This used to read 「Stored, unused
   *  this round (later reconciliation pulls)」, and it was true for twenty days:
   *  a grep for api.paddle.com across the tree returned nothing. It now has one
   *  consumer, billing/paddle/client.ts, and it is spent on real outbound calls
   *  whenever `writeEnabled` is on. */
  apiKey: string | null;
  /**
   * FLOWMIC_PADDLE_WRITE_ENABLED. 🔴 DEFAULTS OFF, and it is a SEPARATE switch
   * from `enabled` on purpose.
   *
   * `enabled` governs what we ACCEPT from Paddle (webhook intake); this governs
   * what we SEND to it. They are different risks and they must be openable
   * separately: intake is read-only and has been live for weeks, whereas a
   * write can cancel a paying customer or move money. Folding the two into one
   * flag would mean the day we turned intake on we also turned writes on, which
   * is precisely the kind of second consequence a single value should never
   * carry.
   *
   * ⚠️ Off does NOT mean 「pretend it worked」: every method on the client throws
   * a named error while it is off (PaddleWritesDisabledError). Nothing is
   * silently skipped.
   */
  writeEnabled: boolean;
  /** FLOWMIC_PADDLE_TOLERANCE_SEC. Signature timestamp skew window; 5 = the
   *  Paddle SDK default. */
  toleranceSec: number;
  /** FLOWMIC_PADDLE_PRICE_TIERS, JSON {"pri_xxx":"pro"}. The ONLY price_id →
   *  tier mapping; an unmapped price id is an `unmapped` ledger row, never a
   *  guessed tier. */
  priceTiers: Record<string, Plan>;
}

/**
 * Creem intake. The SAME SHAPE as PaddleConfig and deliberately NOT the same
 * object.
 *
 * 🔴 TWO SECRETS, TWO SWITCHES, TWO TIER TABLES — never shared. Sharing the
 * secret would mean a body signed for one provider verifies as the other; and
 * sharing the tier table would map a Creem `prod_xxx` against Paddle `pri_xxx`
 * keys, find nothing, and file a correct-looking 'unmapped' row for a payment
 * that was fine. The tier table is keyed by PRODUCT id here and PRICE id there,
 * which is why the env var has a different name rather than a different value.
 */
export interface CreemConfig {
  /** FLOWMIC_CREEM_ENABLED. saas-only (forced false in standalone). */
  enabled: boolean;
  /** FLOWMIC_CREEM_ENV — 'test' | 'prod'. Default 'test': production must be
   *  said out loud, same rule as Paddle's sandbox default. */
  env: 'test' | 'prod';
  /** FLOWMIC_CREEM_WEBHOOK_SECRET. 🔴 NEVER logged, never persisted. */
  webhookSecret: string | null;
  /** FLOWMIC_CREEM_API_KEY. Same handling. */
  apiKey: string | null;
  /** FLOWMIC_CREEM_WRITE_ENABLED. Defaults OFF and is a SEPARATE switch from
   *  `enabled` for the reason spelled out on PaddleConfig.writeEnabled: intake
   *  is read-only, a write can cancel a paying customer or move money. */
  writeEnabled: boolean;
  /** FLOWMIC_CREEM_PRODUCT_TIERS, JSON {"prod_xxx":"pro"}. The ONLY
   *  product_id → tier mapping. An unmapped product is a ledger row, never a
   *  guessed tier.
   *
   *  ⚠️ THE ONE-TIME SERVICE PRODUCT IS DELIBERATELY ABSENT FROM THIS TABLE and
   *  must never be added: it grants no tier, and a mapping would silently make
   *  a $200 support purchase upgrade somebody's plan. The pipeline recognises
   *  it by the checkout carrying no subscription, not by a list. */
  productTiers: Record<string, Plan>;
  /** FLOWMIC_CREEM_SERVICE_PRODUCT_ID — the paid one-time setup service.
   *
   *  🔴 A SEPARATE SETTING FROM `productTiers`, AND IT MUST NEVER APPEAR IN
   *  THAT TABLE. A product listed there grants a tier; this one grants none, and
   *  a single mapping would silently upgrade the plan of everybody who bought a
   *  support session. Null ⇒ the buy route refuses by name (503) rather than
   *  handing a browser a URL to nothing. */
  serviceProductId: string | null;
  /** FLOWMIC_CREEM_SUCCESS_URL — where the browser lands after paying. Null ⇒
   *  Creem's own default page, which is honest but says nothing about us. */
  serviceSuccessUrl: string | null;
  /** FLOWMIC_CREEM_SUBSCRIBE_SUCCESS_URL — where the browser lands after paying
   *  for a SUBSCRIPTION. Null ⇒ Creem's own page.
   *
   *  🔴 A SECOND URL, NOT A REUSE OF THE ONE ABOVE. They are different screens:
   *  one is the service section, the other the plan card. Sending a new
   *  subscriber to the setup-service page would answer a question they did not
   *  ask, on a page that (since 2026-09-04) withholds itself entirely. */
  subscribeSuccessUrl: string | null;
  /**
   * FLOWMIC_CREEM_SUBSCRIPTIONS_ON_SALE — may this deployment sell Pro/Max?
   *
   * 🔴 A FOURTH SWITCH, AND SEPARATE FROM `productTiers` ON PURPOSE. That table
   * answers 「what did somebody buy」 and has to be populated for the WEBHOOK to
   * grant a tier at all — including for a subscription bought before selling was
   * paused. Deriving 「we are selling」 from it would mean the day we configure
   * the mapping is the day the buy buttons go live, with no separate decision.
   *
   * 🔴 DEFAULT OFF, and the two wrong directions are not symmetric. Off while we
   * could sell costs a sale we would have made; on while we cannot takes a
   * person to a checkout that refuses — or, worse, takes their money before the
   * provider has finished reviewing the account.
   */
  subscriptionsOnSale: boolean;
  /**
   * FLOWMIC_CREEM_AUTO_REFUND_ENABLED — let the deadline sweep refund overdue
   * purchases with nobody watching. Defaults OFF.
   *
   * 🔴 A THIRD SWITCH, SEPARATE FROM BOTH `enabled` AND `writeEnabled`, and the
   * separation is the ruling (owner 2026-08-30: 「默认到期由运营队列中由人按一下，
   * 但要实现自动退的功能和开关，只是默认由人来点」). `writeEnabled` answers 「may
   * this process move money at all」 — the buttons need it. This answers 「may it
   * move money with no human in the loop」. Folding them together would mean
   * turning on the customer's own withdraw button also armed an unattended
   * refunder, which is not a decision anybody would have made on purpose.
   *
   * ⚠️ IT IS A SUBSET, NOT AN OVERRIDE: with `writeEnabled` off the sweep can
   * still tick and every call refuses by name. That combination is logged as
   * such rather than being quietly equivalent to off.
   */
  autoRefundEnabled: boolean;
}
