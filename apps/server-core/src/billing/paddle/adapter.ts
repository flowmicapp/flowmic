// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §5.2 / §5.3 (the event
//     table below is verbatim from there)
//   apps/server-core/src/billing/webhook-types.ts (BillingProviderAdapter)
//   apps/server-core/src/billing/paddle/webhook-handler.ts (the two event sets
//     lived there until 2026-08-29; they moved HERE, not to the shared pipeline,
//     because they are the one part of that file that was never provider-neutral)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Paddle, as the pipeline sees it.
//
// ⚠️ THE TWO ARGUMENT SHIMS BELOW ARE THE ONLY BEHAVIOUR IN THIS FILE, and they
// are shims rather than rewrites on purpose: `verifyPaddleSignature` and
// `readSubscriptionFacts` keep the signatures their own tests already drive, so
// this refactor could not quietly change what either of them does. If a future
// change makes one of these do more than reorder its arguments, it belongs in
// the module it is calling, not here.

import type { BillingProviderAdapter, OneTimePurchaseFacts, RefundFacts, SigVerdict, WebhookEnvelope } from '../webhook-types';
import { parsePaddleEnvelope, readSubscriptionFacts } from './envelope';
import { verifyPaddleSignature } from './signature';

/**
 * Events that describe THE SUBSCRIPTION ITSELF (D1 §5.3 table, all eight).
 *
 * They share ONE code path on purpose. The table's per-event prose —
 * "canceled ⇒ the tier is kept until current_period_end", "past_due ⇒ no
 * downgrade this round", "paused ⇒ the tier expires at current_period_end" —
 * describes CONSEQUENCES, not different algorithms: all three fall out of
 * storing Paddle's `status` verbatim, carrying the tier over from the price
 * mapping, and leaving the expiry decision to the single solver in
 * BillingService (D1 §6.1). Writing a per-event branch that "downgrades" or
 * "keeps" a tier would put a SECOND place in the repo deciding "what tier is
 * this user on", which is that window's headline red line — "shows upgraded but
 * the server side never took effect" — with the sides swapped.
 */
const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'subscription.resumed',
  'subscription.imported',
  'subscription.canceled',
  'subscription.past_due',
  'subscription.paused',
]);

/** Events we RECOGNISE and deliberately do not act on (D1 §5.3 table: "record
 *  only, do not change the tier"). Recorded as `applied` with a detail that says
 *  so — see `LEDGER_ONLY_DETAIL` in the pipeline for why not `ignored`. */
const LEDGER_ONLY_EVENTS: ReadonlySet<string> = new Set(['transaction.payment_failed', 'adjustment.created']);

export const paddleAdapter: BillingProviderAdapter = {
  id: 'paddle',
  /** Node lower-cases incoming header names; Paddle sends `Paddle-Signature`. */
  signatureHeader: 'paddle-signature',

  verifySignature(rawBody: string, header: string | undefined, secret: string, toleranceSec: number, nowMs: number): SigVerdict {
    return verifyPaddleSignature(rawBody, header, secret, { nowMs, toleranceSec });
  },

  parseEnvelope: parsePaddleEnvelope,

  readSubscriptionFacts(envelope: WebhookEnvelope) {
    return readSubscriptionFacts(envelope.event_type, envelope.data);
  },

  isSubscriptionEvent: (t) => SUBSCRIPTION_EVENTS.has(t),
  isLedgerOnlyEvent: (t) => LEDGER_ONLY_EVENTS.has(t),

  /**
   * 🔴 ALWAYS NULL, AND THAT IS A STATEMENT ABOUT WHAT WE SELL, NOT A STUB.
   *
   * The only one-time product FlowMic sells — the $200 Guided Setup service —
   * exists in Creem and nowhere else. Paddle's live surface is subscriptions
   * only. Returning null is therefore the true answer for every Paddle event
   * that will ever reach this function.
   *
   * ⚠️ IF A ONE-TIME PRODUCT IS EVER SOLD THROUGH PADDLE, this must be
   * implemented rather than left to return null — a null here would then mean
   * 「we took the money and recorded nothing」, and it would be silent. It is
   * written as a named constant returning null, not as an omitted method, so
   * that the omission cannot be mistaken for the interface not requiring it.
   */
  readOneTimePurchase: (): OneTimePurchaseFacts | null => null,
  // ⚠️ Paddle HAS refund events; they are deliberately not wired. The one-time
  // service is sold through Creem only, so a Paddle refund reader would be a
  // method that can never name a purchase. It lands the day Paddle sells one,
  // together with the surface that would read it.
  readRefund: (): RefundFacts | null => null,
};
