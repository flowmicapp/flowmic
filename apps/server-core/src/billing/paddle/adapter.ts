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

import type { BillingProviderAdapter, SigVerdict, WebhookEnvelope } from '../webhook-types';
import { parsePaddleEnvelope, readSubscriptionFacts } from './envelope';
import { verifyPaddleSignature } from './signature';
import { readPaddleOneTimePurchase, readPaddleRefund } from './one-time';

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
const LEDGER_ONLY_EVENTS: ReadonlySet<string> = new Set(['transaction.payment_failed']);

/**
 * Events that are NOT about a subscription and that we DO act on: the one-time
 * purchase and the refund.
 *
 * 🔴 WHY THIS SET EXISTS INSTEAD OF THREE MORE ENTRIES IN THE ONE ABOVE. The
 * pipeline's admission gate asks `isSubscriptionEvent(t) || isLedgerOnlyEvent(t)`
 * and drops everything else as `ignored`, so an event has to be in one of the two
 * to be seen at all. Piling these into `LEDGER_ONLY_EVENTS` would have worked —
 * and would have made that constant's own documentation false, since its name and
 * its comment both promise「we do not act on these」while `transaction.completed`
 * writes a $200 purchase row. A name that lies about money is the cheapest kind
 * of defect to create and the most expensive to notice.
 *
 * ⚠️ `adjustment.created` MOVED HERE FROM THE SET ABOVE and its behaviour did not
 * change: `readPaddleRefund` returns null for an adjustment Paddle has not
 * approved, so a pending refund still falls through to the same ledger-only
 * conclusion it reached before. What changed is that an APPROVED one no longer
 * does.
 */
const NON_SUBSCRIPTION_ACTED_EVENTS: ReadonlySet<string> = new Set([
  'transaction.completed',
  'adjustment.created',
  'adjustment.updated',
]);

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
  /**
   * ⚠️ THE NAME ASKS THE WRONG QUESTION, AND THE PIPELINE IS WHY. This method is
   * the second half of the admission gate — `isSubscriptionEvent(t) ||
   * isLedgerOnlyEvent(t)`, everything else `ignored` — so what it really answers
   * is「may this event be looked at」, not「do we ignore this event」. Since
   * 2026-08-31 two of the events it admits are acted on. Renaming the method
   * would touch Creem's adapter and the shared interface for a word; naming the
   * two sets apart, here, costs nothing and stops the union from reading as a
   * claim that we do nothing with any of them.
   */
  isLedgerOnlyEvent: (t) => LEDGER_ONLY_EVENTS.has(t) || NON_SUBSCRIPTION_ACTED_EVENTS.has(t),

  /**
   * Wired on 2026-08-31, when the owner moved all collection to Paddle after
   * Creem's KYC did not complete.
   *
   * 🔴 THE COMMENT THAT USED TO BE HERE IS THE REASON THIS IS NOW REAL. It said
   * this must be implemented rather than left returning null the day a one-time
   * product is sold through Paddle, because a null would then mean「we took the
   * money and recorded nothing」— silently. That day is today. The behaviour is
   * in `one-time.ts`; this file stays assembly-only so it cannot develop a second
   * opinion about anything.
   */
  readOneTimePurchase: readPaddleOneTimePurchase,
  readRefund: readPaddleRefund,
};
