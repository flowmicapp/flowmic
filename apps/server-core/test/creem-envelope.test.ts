// SPEC-REF:
//   apps/server-core/src/billing/creem/envelope.ts
//   apps/server-core/src/billing/webhook-types.ts (absent vs null, stated once)
//   https://docs.creem.io/code/webhooks (the sample bodies below are trimmed
//     copies of Creem's published ones, read 2026-08-29)
//   docs/strategy/2026-08-29-creem-stage0-findings.md §2b
//
// 🔴 THE TWO TESTS THAT MATTER MOST HERE ARE THE NESTING ONE AND THE RESUME ONE.
// Both are failures that produce a CORRECT-LOOKING row: the first reads real ids
// from the wrong level of the payload, the second leaves 「will not renew」
// painted on a subscription the user just rescued. Neither throws, neither logs,
// and both are visible only to the person being billed.

import { describe, expect, it } from 'vitest';
import { isCreemSubscriptionEvent, parseCreemEnvelope, readCreemSubscriptionFacts } from '../src/billing/creem/envelope';
import type { WebhookEnvelope } from '../src/billing/webhook-types';

const SUB_CREATED = '2026-08-29T12:08:32.322Z';
const PERIOD_END = '2026-09-29T12:08:29.939Z';

/** A `subscription.*` body: the object IS the subscription. */
function subscriptionBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_creem_1',
    eventType: 'subscription.paid',
    created_at: 1788005312626,
    object: {
      id: 'sub_6wPTfcveINRbEoXsB6Kg52',
      object: 'subscription',
      product: { id: 'prod_lg0zCunKMWSIVKE27KSA9', billing_period: 'every-month', price: 600, currency: 'USD' },
      customer: { id: 'cust_2QJvdyuRQ3MNUGtvRgMeJF', email: 'buyer@example.com' },
      status: 'active',
      current_period_start_date: '2026-08-29T12:08:29.939Z',
      current_period_end_date: PERIOD_END,
      next_transaction_date: PERIOD_END,
      canceled_at: null,
      created_at: SUB_CREATED,
      metadata: { flowmic_user_id: 'usr_abc123' },
      ...over,
    },
  };
}

function envelopeOf(body: Record<string, unknown>): WebhookEnvelope {
  const parsed = parseCreemEnvelope(body);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.reason}`);
  return parsed.envelope;
}

describe('creem envelope — the three shape differences from Paddle', () => {
  it('reads camelCase eventType and converts ms-epoch created_at to RFC3339', () => {
    const env = envelopeOf(subscriptionBody());
    expect(env.event_id).toBe('evt_creem_1');
    expect(env.event_type).toBe('subscription.paid');
    // 🔴 The out-of-order guard compares these as TEXT, so width and zone must
    // be the ones every other stamp in the database uses.
    expect(env.occurred_at).toBe('2026-08-29T12:08:32.626Z');
    expect(env.occurred_at).toHaveLength(24);
  });

  it('always reports notification_id as null', () => {
    // Honest, not missing: Creem's retries carry the same body with no
    // per-delivery id, so nothing may read null here as 「delivered once」.
    expect(envelopeOf(subscriptionBody()).notification_id).toBeNull();
  });
});

describe('creem envelope — refusals name the field, and never echo a value', () => {
  const cases: Array<[string, unknown, string]> = [
    ['not an object', 'nope', 'body is not a JSON object'],
    ['no id', { eventType: 'x', created_at: 1, object: {} }, 'id is missing or blank'],
    ['no eventType', { id: 'evt_1', created_at: 1, object: {} }, 'eventType is missing or blank'],
    ['created_at not a number', { id: 'evt_1', eventType: 'x', created_at: '2026-01-01', object: {} }, 'created_at'],
    ['no object', { id: 'evt_1', eventType: 'x', created_at: 1 }, 'object is missing'],
  ];
  for (const [name, body, expected] of cases) {
    it(name, () => {
      const parsed = parseCreemEnvelope(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toContain(expected);
        // The body carries an email and may carry an address.
        expect(parsed.reason).not.toContain('buyer@example.com');
      }
    });
  }

  it('a missing created_at is a refusal, NOT a defaulted stamp', () => {
    // Fail-closed: the guard's only ruler is this stamp, and a guard with no
    // ruler does not degrade — it compares against undefined and lets every
    // stale event through.
    expect(parseCreemEnvelope({ id: 'e', eventType: 't', object: {} }).ok).toBe(false);
  });
});

describe('creem facts — a subscription event', () => {
  it('reads ids, status verbatim, product id, cycle, and the metadata claim', () => {
    const f = readCreemSubscriptionFacts(envelopeOf(subscriptionBody()));
    expect(f.subscription_id).toBe('sub_6wPTfcveINRbEoXsB6Kg52');
    expect(f.customer_id).toBe('cust_2QJvdyuRQ3MNUGtvRgMeJF');
    expect(f.status).toBe('active');
    // PRODUCT ids for Creem — the tier table is keyed by these, and is a
    // different env var from Paddle's for exactly that reason.
    expect(f.price_ids).toEqual(['prod_lg0zCunKMWSIVKE27KSA9']);
    expect(f.cycle).toBe('monthly');
    expect(f.current_period_end).toBe(PERIOD_END);
    expect(f.claimed_user_id).toBe('usr_abc123');
    expect(f.started_at).toBe(SUB_CREATED);
  });

  it('started_at is the SUBSCRIPTION’s created_at, not the envelope’s', () => {
    // The withdrawal clock. Reading the envelope's `created_at` — which is one
    // level up and looks just as plausible — would restart a legal deadline on
    // whichever event happened to arrive.
    const f = readCreemSubscriptionFacts(envelopeOf(subscriptionBody()));
    expect(f.started_at).toBe(SUB_CREATED);
    expect(f.started_at).not.toBe('2026-08-29T12:08:32.626Z');
  });

  it('passes an unsold billing period through verbatim rather than nulling it', () => {
    const f = readCreemSubscriptionFacts(
      envelopeOf(subscriptionBody({ product: { id: 'prod_x', billing_period: 'every-three-months' } })),
    );
    expect(f.cycle).toBe('every-three-months');
  });
});

describe('creem facts — 🔴 checkout.completed nests the subscription one level down', () => {
  const checkout = {
    id: 'evt_creem_checkout',
    eventType: 'checkout.completed',
    created_at: 1788005312626,
    object: {
      id: 'ch_4h1sHmNpYnex8aWD7AcQNT',
      object: 'checkout',
      // The OUTER product/customer are present and look usable. They are the
      // trap: `order.product` is a bare id string at a different nesting level.
      order: { id: 'ord_1', customer: 'cust_OUTER', product: 'prod_OUTER', amount: 600, status: 'paid' },
      product: { id: 'prod_OUTER', billing_period: 'every-month' },
      customer: { id: 'cust_OUTER', email: 'buyer@example.com' },
      subscription: {
        id: 'sub_INNER',
        product: { id: 'prod_INNER', billing_period: 'every-month' },
        customer: { id: 'cust_INNER' },
        status: 'active',
        current_period_end_date: PERIOD_END,
        canceled_at: null,
        created_at: SUB_CREATED,
        metadata: { flowmic_user_id: 'usr_inner' },
      },
      metadata: { flowmic_user_id: 'usr_outer' },
    },
  };

  it('reads the SUBSCRIPTION, not the checkout’s own product and customer', () => {
    const f = readCreemSubscriptionFacts(envelopeOf(checkout));
    expect(f.subscription_id).toBe('sub_INNER');
    expect(f.customer_id).toBe('cust_INNER');
    expect(f.price_ids).toEqual(['prod_INNER']);
    // If this ever reads OUTER, the row it writes is built from real ids at the
    // wrong nesting level — correct-looking and wrong.
    expect(f.price_ids).not.toContain('prod_OUTER');
  });

  it('falls back to the checkout metadata when the subscription carries none', () => {
    const noSubMeta = structuredClone(checkout);
    delete (noSubMeta.object.subscription as Record<string, unknown>).metadata;
    expect(readCreemSubscriptionFacts(envelopeOf(noSubMeta)).claimed_user_id).toBe('usr_outer');
  });

  it('a one-time checkout has NO subscription and does not pretend to', () => {
    // The $200 Guided Setup produces exactly this body. Inventing a
    // subscription_id here would create a subscription row for a purchase that
    // is not one.
    const oneTime = structuredClone(checkout);
    delete (oneTime.object as Record<string, unknown>).subscription;
    const f = readCreemSubscriptionFacts(envelopeOf(oneTime));
    expect(f.subscription_id).toBeNull();
    expect(f.status).toBeUndefined();
    expect(f.price_ids).toEqual([]);
    // The buyer is still named, so the purchase is attributable even though it
    // is not a subscription.
    expect(f.claimed_user_id).toBe('usr_outer');
  });
});

describe('creem facts — 🔴 scheduled_cancel is a STATUS here, not an object', () => {
  it('projects it onto the two scheduled_change columns', () => {
    const f = readCreemSubscriptionFacts(
      envelopeOf(subscriptionBody({ status: 'scheduled_cancel' })),
    );
    // The provider's word is still stored verbatim...
    expect(f.status).toBe('scheduled_cancel');
    // ...and the derived answer to 「when does the service stop」 lands where the
    // console already reads it.
    expect(f.scheduled_change_action).toBe('cancel');
    expect(f.scheduled_change_at).toBe(PERIOD_END);
  });

  it('a resume CLEARS them with null, not undefined', () => {
    // 🔴 THE LOAD-BEARING ARM. `undefined` means 「the event did not mention
    // this」 and the upsert keeps what it has — so an active subscription would
    // stay marked 「will not renew」 after the user rescued it. Only `null`
    // instructs the row to clear.
    const f = readCreemSubscriptionFacts(envelopeOf(subscriptionBody({ status: 'active' })));
    expect(f.scheduled_change_action).toBeNull();
    expect(f.scheduled_change_at).toBeNull();
    expect(f.scheduled_change_action).not.toBeUndefined();
  });

  it('an event with no status at all says undefined, and clears nothing', () => {
    const noStatus = subscriptionBody();
    delete (noStatus.object as Record<string, unknown>).status;
    const f = readCreemSubscriptionFacts(envelopeOf(noStatus));
    expect(f.status).toBeUndefined();
    expect(f.scheduled_change_action).toBeUndefined();
    expect(f.scheduled_change_at).toBeUndefined();
  });

  it('canceled_at: null clears, absent keeps', () => {
    expect(readCreemSubscriptionFacts(envelopeOf(subscriptionBody())).canceled_at).toBeNull();
    const absent = subscriptionBody();
    delete (absent.object as Record<string, unknown>).canceled_at;
    expect(readCreemSubscriptionFacts(envelopeOf(absent)).canceled_at).toBeUndefined();
  });
});

describe('creem facts — which events reach the subscription path', () => {
  it('includes checkout.completed, because it carries the buyer’s id', () => {
    expect(isCreemSubscriptionEvent('checkout.completed')).toBe(true);
  });

  it('covers every subscription lifecycle event Creem publishes', () => {
    for (const t of [
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
    ]) {
      expect(isCreemSubscriptionEvent(t)).toBe(true);
    }
  });

  it('excludes payment-level events, which describe a payment and not a subscription', () => {
    expect(isCreemSubscriptionEvent('refund.created')).toBe(false);
    expect(isCreemSubscriptionEvent('dispute.created')).toBe(false);
    expect(isCreemSubscriptionEvent('subscription.invented')).toBe(false);
  });
});
