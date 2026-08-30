// The shared webhook pipeline, driven with the CREEM adapter, over a REAL
// database — the sibling of paddle-webhook-handler.test.ts and for the same
// reason: three of the properties under test are properties of the STORAGE, and
// a fake repo would agree with whatever the handler did.
//
// What each block pins, in order of what it would cost to get wrong:
//   ① 🔴 a body signed for one provider must NOT verify on the other's route.
//      This is the reason the adapter is a dependency and not a lookup from the
//      payload; if it ever became a lookup, this is the test that goes red.
//   ② a paid one-time purchase is RECORDED — money moved, so a ledger line
//      naming no product is not an acceptable outcome;
//   ③ 🔴 an unattributable paid purchase is recorded ANYWAY, with the outcome
//      still saying a human is needed. Two facts, both kept;
//   ④ a redelivery writes no second purchase row — asserted on the ROW COUNT,
//      with a positive control so 「nothing changed」 cannot be a test that never
//      changed anything;
//   ⑤ 🔴 a one-time purchase grants NO TIER. The failure this exists for is a
//      $200 support purchase silently upgrading somebody's plan;
//   ⑥ an UNPAID checkout is not a purchase;
//   ⑦ scheduled_cancel → the two scheduled_change columns, over the real upsert.

import { describe, expect, it } from 'vitest';
import { creemAdapter } from '../src/billing/creem/adapter';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { handlePaddleWebhook, type PaddleWebhookDeps } from '../src/billing/paddle/webhook-handler';
import { paddleAdapter } from '../src/billing/paddle/adapter';
import { signCreemPayload } from '../src/billing/creem/signature';
import { signPaddlePayload } from '../src/billing/paddle/signature';

const SECRET = 'whsec_creem_TESTONLY_not_a_real_secret';
const NOW_MS = 1_788_000_000_000;
const PROD_PRO = 'prod_lg0zCunKMWSIVKE27KSA9';
const PROD_SETUP = 'prod_5KBFZBDMFyZqpFIpR7i0uR';

function world(over: Partial<PaddleWebhookDeps> = {}) {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  const deps: PaddleWebhookDeps = {
    adapter: creemAdapter,
    repo: db.billing,
    users: db.users,
    secret: SECRET,
    toleranceSec: 0,
    // 🔴 The setup product is NOT in this table, and that is the production
    // shape: it grants no tier and a mapping would make it grant one.
    priceTiers: { [PROD_PRO]: 'pro' },
    now: () => NOW_MS,
    ...over,
  };
  return { db, deps };
}

/** A completed checkout for the one-time service. */
function setupCheckout(over: Record<string, unknown> = {}, orderOver: Record<string, unknown> = {}) {
  return {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    eventType: 'checkout.completed',
    created_at: NOW_MS,
    object: {
      id: 'ch_setup_1',
      object: 'checkout',
      order: {
        id: 'ord_setup_1',
        customer: 'cust_1',
        product: PROD_SETUP,
        amount: 20000,
        currency: 'USD',
        status: 'paid',
        type: 'onetime',
        ...orderOver,
      },
      product: { id: PROD_SETUP },
      customer: { id: 'cust_1', email: 'buyer@example.com' },
      metadata: { flowmic_user_id: 'u1' },
      ...over,
    },
  };
}

const post = (deps: PaddleWebhookDeps, body: unknown, secret = SECRET) => {
  const raw = JSON.stringify(body);
  return handlePaddleWebhook(deps, { rawBody: raw, signature: signCreemPayload(raw, secret) });
};


describe('① 🔴 a body signed for one provider does not verify on the other', () => {
  it('a Paddle-signed body is refused by the Creem pipeline', () => {
    const { deps } = world();
    const raw = JSON.stringify(setupCheckout());
    const out = handlePaddleWebhook(deps, {
      rawBody: raw,
      signature: signPaddlePayload(raw, Math.floor(NOW_MS / 1000), SECRET),
    });
    expect(out.status).toBe(401);
  });

  it('a Creem-signed body is refused by the Paddle pipeline', () => {
    const { deps } = world({ adapter: paddleAdapter, toleranceSec: 5 });
    const raw = JSON.stringify(setupCheckout());
    const out = handlePaddleWebhook(deps, { rawBody: raw, signature: signCreemPayload(raw, SECRET) });
    expect(out.status).toBe(401);
  });

  it('the right pairing IS accepted — the positive control for the two above', () => {
    const { deps } = world();
    expect(post(deps, setupCheckout()).status).toBe(200);
  });
});

describe('② a paid one-time purchase is recorded', () => {
  it('writes the row with the provider, product, amount and buyer', () => {
    const { db, deps } = world();
    const out = post(deps, setupCheckout());
    expect(out.status).toBe(200);

    const row = db.billing.getOneTimePurchase('ord_setup_1');
    expect(row).not.toBeNull();
    expect(row?.provider).toBe('creem');
    expect(row?.user_id).toBe('u1');
    expect(row?.product_id).toBe(PROD_SETUP);
    expect(row?.amount_minor).toBe(20000);
    expect(row?.currency).toBe('USD');
    // The only state a webhook may write: everything after 'paid' is something
    // a person did.
    expect(row?.state).toBe('paid');
  });

  it('leaves both consent stamps null — a webhook is not evidence of consent', () => {
    // 🔴 If these were ever filled in from the event, we would have fabricated
    // the exact record an EU withdrawal dispute turns on. Null is the honest
    // value and it reads as 「the right is intact」, which is the safe direction.
    const { db, deps } = world();
    post(deps, setupCheckout());
    const row = db.billing.getOneTimePurchase('ord_setup_1');
    expect(row?.early_start_consent_at).toBeNull();
    expect(row?.withdrawal_waiver_ack_at).toBeNull();
  });
});

describe('③ 🔴 an unattributable purchase is still recorded', () => {
  it('writes the row with a null user and still reports unmapped', () => {
    // Money has already moved. If this fell through the 「unmapped」 return the
    // way a subscription event does, we would have taken $200 and kept only a
    // ledger line that names no product and no order.
    const { db, deps } = world();
    const body = setupCheckout({ metadata: { flowmic_user_id: 'nobody-by-that-id' } });
    const out = post(deps, body);

    expect(out.status).toBe(200);
    expect(out.body.outcome).toBe('unmapped');
    const row = db.billing.getOneTimePurchase('ord_setup_1');
    expect(row).not.toBeNull();
    expect(row?.user_id).toBeNull();
    expect(row?.amount_minor).toBe(20000);
  });
});

describe('④ a redelivery writes no second row', () => {
  it('same order, different event id ⇒ still exactly one purchase', () => {
    const { db, deps } = world();
    const first = post(deps, setupCheckout());
    expect(first.body.outcome).toBe('applied');

    // A DIFFERENT event id, so the billing_events dedup does not answer this —
    // the purchase table's own primary key has to.
    const second = post(deps, setupCheckout());
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('applied');

    const rows = db.billing.listOneTimePurchasesForUser('u1', 50);
    expect(rows).toHaveLength(1);
  });

  it('positive control: a DIFFERENT order really does write a second row', () => {
    // Without this, the assertion above would pass on a pipeline that never
    // wrote anything at all.
    const { db, deps } = world();
    post(deps, setupCheckout());
    post(deps, setupCheckout({ order: { id: 'ord_setup_2', product: PROD_SETUP, amount: 20000, currency: 'USD', status: 'paid', customer: 'cust_1' } }));
    expect(db.billing.listOneTimePurchasesForUser('u1', 50)).toHaveLength(2);
  });
});

describe('⑤ 🔴 a one-time purchase grants no tier', () => {
  it('writes no subscription row and leaves the account on free', () => {
    const { db, deps } = world();
    post(deps, setupCheckout());
    expect(db.billing.latestForUser('u1')).toBeNull();
    expect(db.users.findById('u1')?.plan).toBe('free');
  });
});

describe('⑥ an unpaid checkout is not a purchase', () => {
  it('records nothing when the order did not reach paid', () => {
    // `checkout.completed` describes a completed SESSION; whether money moved is
    // the separate fact in `order.status`. Writing on the event name alone would
    // show a buyer a purchase they were never charged for.
    const { db, deps } = world();
    const out = post(deps, setupCheckout({}, { status: 'pending' }));
    expect(out.status).toBe(200);
    expect(db.billing.getOneTimePurchase('ord_setup_1')).toBeNull();
  });
});

describe('⑦ a subscription checkout is not a one-time purchase', () => {
  const subscriptionCheckout = {
    id: 'evt_sub_checkout',
    eventType: 'checkout.completed',
    created_at: NOW_MS,
    object: {
      id: 'ch_sub_1',
      object: 'checkout',
      order: { id: 'ord_sub_1', product: PROD_PRO, amount: 600, currency: 'USD', status: 'paid', customer: 'cust_1' },
      subscription: {
        id: 'sub_creem_1',
        product: { id: PROD_PRO, billing_period: 'every-month' },
        customer: { id: 'cust_1' },
        status: 'active',
        current_period_end_date: '2026-09-29T12:08:29.939Z',
        canceled_at: null,
        created_at: '2026-08-29T12:08:32.322Z',
        metadata: { flowmic_user_id: 'u1' },
      },
      metadata: { flowmic_user_id: 'u1' },
    },
  };

  it('writes the subscription and NOT a purchase row', () => {
    // 🔴 Both records for one checkout would be counted twice by anything
    // summing what a person has paid for.
    const { db, deps } = world();
    const out = post(deps, subscriptionCheckout);
    expect(out.status).toBe(200);
    expect(db.billing.getOneTimePurchase('ord_sub_1')).toBeNull();
    expect(db.billing.latestForUser('u1')?.tier).toBe('pro');
  });

  it('scheduled_cancel lands in the two scheduled_change columns', () => {
    const { db, deps } = world();
    post(deps, subscriptionCheckout);
    post(deps, {
      id: 'evt_sched',
      eventType: 'subscription.scheduled_cancel',
      created_at: NOW_MS + 1000,
      object: {
        id: 'sub_creem_1',
        product: { id: PROD_PRO, billing_period: 'every-month' },
        customer: { id: 'cust_1' },
        status: 'scheduled_cancel',
        current_period_end_date: '2026-09-29T12:08:29.939Z',
        canceled_at: null,
        created_at: '2026-08-29T12:08:32.322Z',
        metadata: { flowmic_user_id: 'u1' },
      },
    });
    const row = db.billing.getSubscription('sub_creem_1');
    // Creem's own word is kept...
    expect(row?.status).toBe('scheduled_cancel');
    // ...and the derived answer to 「when does the service stop」 is where the
    // console already reads it.
    expect(row?.scheduled_change_action).toBe('cancel');
    expect(row?.scheduled_change_at).toBe('2026-09-29T12:08:29.939Z');
  });
});
