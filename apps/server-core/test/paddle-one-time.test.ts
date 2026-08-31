// SPEC-REF: apps/server-core/src/billing/paddle/one-time.ts
//
// 🔴 THE TRANSACTION FIXTURE IS A MEASUREMENT, NOT AN IMAGINING.
//
// It is the body Paddle's sandbox returned for a real transaction created on
// 2026-08-31 against the real `FlowMic Setup Help` price
// (`txn_01m1betgw209g55x85kbe3jq2c`, created to read its shape and cancelled
// afterwards). Keeping its oddities is the point of copying it:
//
//   · `details.totals.total` and `grand_total` are STRINGS. A fixture that
//     wrote numbers would have let a reader returning NaN pass.
//   · `subscription_id` is present-but-empty on a one-time transaction, not
//     absent — which is why the guard tests `asString(...) !== null` (empty
//     strings trim to null) rather than `'subscription_id' in data`.
//   · the price nests under `items[].price`, not at the top level.
//
// This repo has been bitten twice by matrices built from values that merely look
// like the real thing (CLAUDE.md, law L-② from 0.3.24). The adjustment fixtures
// below are the weaker half and say so in their own comment.

import { describe, expect, it } from 'vitest';

import {
  isPaddleOneTimeEvent,
  isPaddleRefundEvent,
  readPaddleOneTimePurchase,
  readPaddleRefund,
} from '../src/billing/paddle/one-time';
import type { WebhookEnvelope } from '../src/billing/webhook-types';

const TXN_ID = 'txn_01m1betgw209g55x85kbe3jq2c';
const PRICE_ID = 'pri_01m1b9b76f8grdfffpa8tjrr4t';
const PRODUCT_ID = 'pro_01m1b9b6a3f87q1vcnzwmhpmsa';

function txnData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TXN_ID,
    status: 'completed',
    subscription_id: '',
    customer_id: 'ctm_01m1000000000000000000000',
    currency_code: 'USD',
    origin: 'web',
    custom_data: {
      flowmic_user_id: 'usr_probe_0001',
      fm_consent_v: 'gs-5',
      fm_early_start_at: '2026-08-31T08:00:00Z',
      fm_waiver_ack_at: '2026-08-31T08:00:05Z',
    },
    items: [{ price: { id: PRICE_ID, product_id: PRODUCT_ID } }],
    details: { totals: { subtotal: '20000', tax: '0', total: '20000', grand_total: '20000', currency_code: 'USD' } },
    ...over,
  };
}

function env(event_type: string, data: Record<string, unknown>): WebhookEnvelope {
  return { event_id: 'evt_test', event_type, occurred_at: '2026-08-31T08:00:00.000Z', data } as WebhookEnvelope;
}

describe('readPaddleOneTimePurchase', () => {
  it('reads a completed one-time transaction', () => {
    const out = readPaddleOneTimePurchase(env('transaction.completed', txnData()));
    expect(out).toEqual({
      order_id: TXN_ID,
      transaction_id: TXN_ID,
      checkout_id: null,
      product_id: PRODUCT_ID,
      customer_id: 'ctm_01m1000000000000000000000',
      amount_minor: 20000,
      currency: 'USD',
      claimed_user_id: 'usr_probe_0001',
      early_start_consent_at: '2026-08-31T08:00:00.000Z',
      withdrawal_waiver_ack_at: '2026-08-31T08:00:05.000Z',
      consent_terms_version: 'gs-5',
    });
  });

  it('🔴 the amount survives being a string, and a bad one becomes null rather than NaN', () => {
    // The measured body states money as a string. A NaN here would be a number
    // that compares false with itself, in a column somebody reconciles.
    expect(readPaddleOneTimePurchase(env('transaction.completed', txnData()))!.amount_minor).toBe(20000);
    const broken = txnData({ details: { totals: { total: '2.00', grand_total: 'twenty' } } });
    expect(readPaddleOneTimePurchase(env('transaction.completed', broken))!.amount_minor).toBeNull();
  });

  it('🔴 a SUBSCRIPTION charge is not a one-time purchase, even though it is the same event', () => {
    // Without this, every Pro renewal would mint a row claiming somebody bought
    // the $200 setup service.
    const renewal = txnData({ subscription_id: 'sub_01m1000000000000000000000' });
    expect(readPaddleOneTimePurchase(env('transaction.completed', renewal))).toBeNull();
  });

  it('ignores every other event and every other transaction status', () => {
    expect(readPaddleOneTimePurchase(env('transaction.paid', txnData()))).toBeNull();
    expect(readPaddleOneTimePurchase(env('transaction.created', txnData()))).toBeNull();
    expect(readPaddleOneTimePurchase(env('subscription.created', txnData()))).toBeNull();
    for (const status of ['draft', 'ready', 'billed', 'canceled', 'past_due']) {
      expect(readPaddleOneTimePurchase(env('transaction.completed', txnData({ status })))).toBeNull();
    }
  });

  it('refuses to write anything without an idempotency key', () => {
    expect(readPaddleOneTimePurchase(env('transaction.completed', txnData({ id: '' })))).toBeNull();
  });

  it('a checkout we did not build carries no claim and no consent, and says so', () => {
    const foreign = readPaddleOneTimePurchase(env('transaction.completed', txnData({ custom_data: null })))!;
    expect(foreign.claimed_user_id).toBeNull();
    expect(foreign.early_start_consent_at).toBeNull();
    expect(foreign.consent_terms_version).toBeNull();
    // 🔴 The row is still produced. Money moved; a purchase nobody can attribute
    // has to reach the ledger, not vanish.
    expect(foreign.order_id).toBe(TXN_ID);
  });

  it('🔴 keeps the consent version only when BOTH stamps survived', () => {
    // A version id beside a missing stamp cites wording nobody is recorded as
    // having agreed to — in a dispute that reads as though there were consent.
    const half = txnData({ custom_data: { flowmic_user_id: 'u', fm_consent_v: 'gs-5', fm_early_start_at: '2026-08-31T08:00:00Z' } });
    const out = readPaddleOneTimePurchase(env('transaction.completed', half))!;
    expect(out.withdrawal_waiver_ack_at).toBeNull();
    expect(out.consent_terms_version).toBeNull();
  });
});

describe('readPaddleRefund', () => {
  // ⚠️ WEAKER FIXTURES THAN THE ONE ABOVE, and the file says so rather than
  // letting them look equally solid: an adjustment cannot be created without a
  // completed transaction, which needs a real payment. The field names are the
  // ones this repo ALREADY writes and reads at `POST /adjustments`
  // (paddle/client.ts createRefund + PaddleAdjustmentSnapshot), and the event
  // names came from `GET /event-types` on the live sandbox account.
  const adj = (over: Record<string, unknown> = {}) => ({
    id: 'adj_01m1000000000000000000000',
    action: 'refund',
    status: 'approved',
    transaction_id: TXN_ID,
    ...over,
  });

  it('confirms a refund Paddle has approved', () => {
    expect(readPaddleRefund(env('adjustment.created', adj()))).toEqual({
      order_id: TXN_ID,
      provider_id: 'adj_01m1000000000000000000000',
      provider_status: 'approved',
    });
    expect(readPaddleRefund(env('adjustment.updated', adj()))).not.toBeNull();
  });

  it('🔴 does NOT confirm a refund that is only pending — the whole point of the file', () => {
    // Creem's refund.created means the money went back. Paddle's does not: on a
    // live account a refund is usually created `pending_approval`. Rounding that
    // up would tell a buyer their money is back before Paddle moved it.
    expect(readPaddleRefund(env('adjustment.created', adj({ status: 'pending_approval' })))).toBeNull();
    for (const status of ['rejected', 'reversed', 'pending', '']) {
      expect(readPaddleRefund(env('adjustment.updated', adj({ status })))).toBeNull();
    }
  });

  it('a credit or a chargeback is not us returning a payment', () => {
    for (const action of ['credit', 'chargeback', 'chargeback_warning', 'credit_reverse']) {
      expect(readPaddleRefund(env('adjustment.created', adj({ action })))).toBeNull();
    }
  });

  it('🔴 an approved refund naming no transaction is NOT null — it is unattributable', () => {
    // Null would mean "not a refund event". This says "money moved and we cannot
    // say whose", which the pipeline turns into `unmapped` so a person looks.
    expect(readPaddleRefund(env('adjustment.created', adj({ transaction_id: '' })))).toEqual({
      order_id: null,
      provider_id: 'adj_01m1000000000000000000000',
      provider_status: 'approved',
    });
  });

  it('ignores events that are not adjustments at all', () => {
    expect(readPaddleRefund(env('transaction.completed', txnData()))).toBeNull();
    expect(readPaddleRefund(env('subscription.canceled', adj()))).toBeNull();
  });
});

describe('the event sets', () => {
  it('name exactly what the readers act on', () => {
    expect(isPaddleOneTimeEvent('transaction.completed')).toBe(true);
    // `transaction.paid` fires when money is captured, `completed` when Paddle
    // has finished processing. Fulfilment hangs off the second.
    expect(isPaddleOneTimeEvent('transaction.paid')).toBe(false);
    expect(isPaddleRefundEvent('adjustment.created')).toBe(true);
    expect(isPaddleRefundEvent('adjustment.updated')).toBe(true);
    expect(isPaddleRefundEvent('transaction.completed')).toBe(false);
  });
});
