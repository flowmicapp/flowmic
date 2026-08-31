// The paid one-time service's two routes, driven directly (no socket) against a
// REAL database and a stub Creem client.
//
// What each block pins, in order of what it would cost to get wrong:
//   ① 🔴 you cannot buy anonymously (owner ruling 2026-08-29). An unauthenticated
//      purchase arrives attributable to nobody and sits unmapped while a person
//      waits for a service we cannot connect to an account;
//   ② 🔴 BOTH affirmations are required, and a missing field is not read as
//      「false」. They do different legal work (CRD art. 7(3) and 16(a));
//   ③ 🔴 the metadata we send carries the buyer AND our own consent stamps —
//      this is the only channel by which a payment can name either;
//   ④ creating a checkout records NOTHING. A checkout is not a purchase;
//   ⑤ the list serves the promise from the constant, and derives 「what next」
//      from the state rather than from a stored sentence;
//   ⑥ a deployment that cannot sell it refuses BY NAME, and never 200s.

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService } from '../src/auth/auth-service';
import type { CreateCheckoutInput, CreemClient } from '../src/billing/creem/client';
import {
  GUIDED_SETUP_CONSENT_VERSION,
  GUIDED_SETUP_CONTACT_BUSINESS_DAYS,
  GUIDED_SETUP_MAX_SESSION_HOURS,
  GUIDED_SETUP_META,
} from '../src/billing/guided-setup';
import {
  SERVICE_CONSENT_REQUIRED,
  SERVICE_NOT_AVAILABLE,
  SERVICE_NOT_REFUNDABLE,
  SERVICE_REFUND_REFUSED,
  tryHandleServicePurchaseRoutes,
  type ServicePurchaseRoutesDeps,
} from '../src/http/service-purchase-routes';
import { GUIDED_SETUP_AFTERCARE_DAYS } from '../src/billing/guided-setup';
import { requestServiceRefund } from '../src/billing/service-refund';
import { PROMISED_DEADLINES } from '../src/billing/guided-setup';
import type { SubscriptionWriter } from '../src/billing/subscription-writer';
import type { ServiceMailer, ServiceWithdrawalMailInput } from '../src/mail/service-mailer';
import type { IncomingMessage, ServerResponse } from 'node:http';

const NOW_MS = 1_788_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
const PRODUCT = 'prod_5KBFZBDMFyZqpFIpR7i0uR';

function world(over: Partial<ServicePurchaseRoutesDeps> = {}) {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  const auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from('test-jwt-secret-value-long-enough', 'utf8'), now: () => NOW_MS });
  const user = db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free', email: 'buyer@example.com' });
  const token = auth.issueToken(user).token;

  const sent: CreateCheckoutInput[] = [];
  const creem: CreemClient = {
    createCheckout: async (input) => {
      sent.push(input);
      return { ok: true, data: { id: 'ch_1', checkout_url: 'https://creem.io/test/checkout/x' } };
    },
  };

  const deps: ServicePurchaseRoutesDeps = {
    auth,
    purchases: db.billing,
    creem,
    productId: PRODUCT,
    now: () => NOW_MS,
    ...over,
  };
  return { db, deps, token, sent };
}

/** A request/response pair, just enough of each for the route. */
function call(deps: ServicePurchaseRoutesDeps, method: string, url: string, opts: { token?: string; body?: unknown } = {}) {
  const raw = opts.body === undefined ? '' : JSON.stringify(opts.body);
  // ⚠️ Buffers and objectMode:false — `Readable.from` defaults to OBJECT MODE,
  // and `readBounded` concatenates Buffers and waits for 'end'. An object-mode
  // stream of strings makes it wait forever, which shows up as a route that
  // 「never answers」 rather than as a broken fixture.
  const req = Object.assign(Readable.from(raw.length > 0 ? [Buffer.from(raw, 'utf8')] : [], { objectMode: false }), {
    method,
    url,
    headers: opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` },
  }) as unknown as IncomingMessage;

  let status = 0;
  let payload: Record<string, unknown> = {};
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    setHeader() {},
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk);
      if (chunks.length > 0) {
        try {
          payload = JSON.parse(chunks.join('')) as Record<string, unknown>;
        } catch {
          /* non-JSON body is a failure the assertions will surface */
        }
      }
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as ServerResponse;

  const handled = tryHandleServicePurchaseRoutes(req, res, deps);
  return {
    handled,
    // Waits for the response instead of guessing a delay: a fixed setTimeout
    // would make this suite pass or fail on how busy the machine is, which is a
    // test that measures the CI runner rather than the route.
    settled: (async (): Promise<{ status: number; payload: Record<string, unknown> }> => {
      for (let i = 0; i < 200 && status === 0; i++) await new Promise((r) => setTimeout(r, 5));
      return { status, payload };
    })(),
  };
}

const CONSENT = { early_start: true, waiver_ack: true };

describe('① 🔴 buying requires being signed in', () => {
  it('refuses an anonymous purchase with 401', async () => {
    const { deps } = world();
    const r = call(deps, 'POST', '/api/cloud/billing/service-checkout', { body: CONSENT });
    expect(r.handled).toBe(true);
    expect((await r.settled).status).toBe(401);
  });

  it('refuses an anonymous list too', async () => {
    const { deps } = world();
    expect((await call(deps, 'GET', '/api/cloud/billing/services').settled).status).toBe(401);
  });

  it('positive control: the SAME request with a bearer is accepted', async () => {
    const { deps, token } = world();
    const out = await call(deps, 'POST', '/api/cloud/billing/service-checkout', { token, body: CONSENT }).settled;
    expect(out.status).toBe(200);
    expect(out.payload.checkout_url).toBe('https://creem.io/test/checkout/x');
  });
});

describe('② 🔴 both affirmations are required, and absent is not false', () => {
  const cases: Array<[string, unknown]> = [
    ['neither', {}],
    ['only the early-start request', { early_start: true }],
    ['only the acknowledgement', { waiver_ack: true }],
    ['one of them explicitly refused', { early_start: true, waiver_ack: false }],
    ['truthy but not true', { early_start: 'yes', waiver_ack: 'yes' }],
  ];
  for (const [name, body] of cases) {
    it(`refuses when ${name}`, async () => {
      const { deps, token, sent } = world();
      const out = await call(deps, 'POST', '/api/cloud/billing/service-checkout', { token, body }).settled;
      expect(out.status).toBe(400);
      expect(out.payload.error).toBe(SERVICE_CONSENT_REQUIRED);
      // 🔴 AND NOTHING WAS SENT TO THE PROVIDER. A refusal that still issued a
      // checkout would put a payable URL in front of somebody who had not
      // agreed to the terms it is sold under.
      expect(sent).toHaveLength(0);
    });
  }

  it('names the terms version on the refusal, so the client can render the right words', async () => {
    const { deps, token } = world();
    const out = await call(deps, 'POST', '/api/cloud/billing/service-checkout', { token, body: {} }).settled;
    expect(out.payload.terms_version).toBe(GUIDED_SETUP_CONSENT_VERSION);
  });
});

describe('③ 🔴 the metadata carries the buyer and our own consent stamps', () => {
  it('sends user id, both stamps and the terms version', async () => {
    const { deps, token, sent } = world();
    await call(deps, 'POST', '/api/cloud/billing/service-checkout', { token, body: CONSENT }).settled;

    expect(sent).toHaveLength(1);
    const meta = sent[0]!.metadata;
    // The only channel by which a payment can name its buyer.
    expect(meta.flowmic_user_id).toBe('u1');
    // OUR stamps, on OUR clock — not values the buyer supplied.
    expect(meta[GUIDED_SETUP_META.earlyStartAt]).toBe(NOW_ISO);
    expect(meta[GUIDED_SETUP_META.waiverAckAt]).toBe(NOW_ISO);
    expect(meta[GUIDED_SETUP_META.consentVersion]).toBe(GUIDED_SETUP_CONSENT_VERSION);
    expect(sent[0]!.productId).toBe(PRODUCT);
  });
});

describe('④ creating a checkout records nothing', () => {
  it('writes no purchase row — a checkout is not a purchase', async () => {
    // The person may never pay. The row is written by the webhook, from a PAID
    // order, and by nothing else; two writers disagree exactly where the browser
    // was closed after the URL was issued.
    const { db, deps, token } = world();
    await call(deps, 'POST', '/api/cloud/billing/service-checkout', { token, body: CONSENT }).settled;
    expect(db.billing.listOneTimePurchasesForUser('u1', 50)).toEqual([]);
  });
});

describe('⑤ the list serves the promise from the constant', () => {
  it('returns the SLA numbers and a next step derived from the state', async () => {
    const { db, deps, token } = world();
    db.billing.recordOneTimePurchase({
      order_id: 'ord_1',
      provider: 'creem',
      user_id: 'u1',
      product_id: PRODUCT,
      checkout_id: 'ch_1',
      transaction_id: null,
      customer_id: null,
      amount_minor: 20000,
      currency: 'USD',
      state: 'paid',
      early_start_consent_at: NOW_ISO,
      withdrawal_waiver_ack_at: NOW_ISO,
      consent_terms_version: GUIDED_SETUP_CONSENT_VERSION,
      scheduled_at: null,
      started_at: null,
      delivered_at: null,
      refund_requested_at: null,
      refund_provider_id: null,
      refund_status: null,
      refunded_at: null,
      completion_notice_at: null,
      note: null,
      created_at: NOW_ISO,
    });

    const out = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
    expect(out.status).toBe(200);
    // 🔴 From the constant, not a literal here and not a literal in the console:
    // two copies of a promise means changing it changes one of them.
    expect(out.payload.contact_business_days).toBe(GUIDED_SETUP_CONTACT_BUSINESS_DAYS);
    expect(out.payload.max_session_hours).toBe(GUIDED_SETUP_MAX_SESSION_HOURS);

    const list = out.payload.purchases as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]!.state).toBe('paid');
    expect(list[0]!.next_step).toBe('awaiting_contact');
    // The buyer can see what they agreed to and when.
    expect((list[0]!.consent as Record<string, unknown>).terms_version).toBe(GUIDED_SETUP_CONSENT_VERSION);
  });

  it('a delivered purchase says so, and stays in the list', async () => {
    // Somebody paid for it; the record does not disappear once it is done.
    const { db, deps, token } = world();
    db.billing.recordOneTimePurchase({
      order_id: 'ord_2', provider: 'creem', user_id: 'u1', product_id: PRODUCT, checkout_id: null,
      transaction_id: null, customer_id: null, amount_minor: 20000, currency: 'USD', state: 'paid',
      early_start_consent_at: NOW_ISO, withdrawal_waiver_ack_at: NOW_ISO,
      consent_terms_version: GUIDED_SETUP_CONSENT_VERSION, scheduled_at: null, started_at: null, delivered_at: null,
      refund_requested_at: null,
      refund_provider_id: null,
      refund_status: null, refunded_at: null, completion_notice_at: null, note: null, created_at: NOW_ISO,
    });
    db.billing.advanceOneTimePurchase(
      'ord_2',
      { state: 'delivered', scheduled_at: null, started_at: null, delivered_at: NOW_ISO, completion_notice_at: null, refunded_at: null },
      NOW_ISO,
    );

    const out = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
    const list = out.payload.purchases as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    // Delivered just now ⇒ inside the two weeks of support.
    expect(list[0]!.next_step).toBe('support');
  });
});

describe('⑥ 🔴 a deployment that cannot sell it refuses by name', () => {
  it('503 SERVICE_NOT_AVAILABLE when no Creem client is wired', async () => {
    const { deps, token } = world({ creem: undefined });
    const out = await call(deps, 'POST', '/api/cloud/billing/service-checkout', { token, body: CONSENT }).settled;
    expect(out.status).toBe(503);
    expect(out.payload.error).toBe(SERVICE_NOT_AVAILABLE);
  });

  it('503 when the product id is unset — never a URL to nothing', async () => {
    const { deps, token } = world({ productId: '' });
    const out = await call(deps, 'POST', '/api/cloud/billing/service-checkout', { token, body: CONSENT }).settled;
    expect(out.status).toBe(503);
    expect(out.payload.error).toBe(SERVICE_NOT_AVAILABLE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gs-5 — the withdraw button the wording promises, and what the console can see.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seed one purchase for u1, in whatever state the test needs. */
function purchaseFor(
  db: ReturnType<typeof createDbConnection>,
  over: Partial<Parameters<typeof db.billing.recordOneTimePurchase>[0]> = {},
): string {
  const order_id = (over.order_id as string | undefined) ?? 'ord_w';
  db.billing.recordOneTimePurchase({
    order_id,
    provider: 'creem',
    user_id: 'u1',
    product_id: PRODUCT,
    checkout_id: null,
    transaction_id: 'tx_1',
    customer_id: null,
    amount_minor: 20000,
    currency: 'USD',
    state: 'paid',
    early_start_consent_at: NOW_ISO,
    withdrawal_waiver_ack_at: NOW_ISO,
    consent_terms_version: GUIDED_SETUP_CONSENT_VERSION,
    scheduled_at: null,
    started_at: null,
    delivered_at: null,
    refund_requested_at: null,
    refund_provider_id: null,
    refund_status: null,
    refunded_at: null,
    completion_notice_at: null,
    note: null,
    created_at: NOW_ISO,
    ...over,
  });
  return order_id;
}

/** The REAL refund action over the test's own database, with a provider stub
 *  that always accepts — so the withdraw route's 409 in ⑨ comes from the claim
 *  SQL refusing, not from a hand-written `not_refundable` answer. */
function realRefunder(db: ReturnType<typeof createDbConnection>): NonNullable<ServicePurchaseRoutesDeps['refund']> {
  const writer = {
    provider: 'creem',
    createRefund: async () => ({ ok: true as const, data: { id: 'ref_1', status: 'pending' } }),
  } as unknown as SubscriptionWriter;
  return (orderId, origin) =>
    requestServiceRefund({ purchases: db.billing, writer, deadlines: PROMISED_DEADLINES, now: () => NOW_MS }, orderId, origin);
}

function serviceMailer(): {
  mailer: ServiceMailer;
  acks: ServiceWithdrawalMailInput[];
} {
  const acks: ServiceWithdrawalMailInput[] = [];
  return {
    acks,
    mailer: {
      id: 'test',
      async sendSetupCompleted(): Promise<void> {},
      async sendWithdrawalReceived(input: ServiceWithdrawalMailInput): Promise<void> {
        acks.push(input);
      },
      async sendRefundSettledByHand(): Promise<void> {},
      async sendRefundReleased(): Promise<void> {},
    },
  };
}

describe('⑦ 🔴 the withdraw button gs-5 promises', () => {
  it('asks the shared refund action with origin `customer_withdrawal`', async () => {
    const calls: [string, string][] = [];
    const { db, deps, token } = world({
      refund: async (orderId, origin) => {
        calls.push([orderId, origin]);
        return { ok: true, providerStatus: 'pending' };
      },
    });
    const id = purchaseFor(db);
    const out = await call(deps, 'POST', '/api/cloud/billing/service-withdraw', {
      token,
      body: { order_id: id },
    }).settled;
    expect(out.status).toBe(200);
    expect(calls).toEqual([[id, 'customer_withdrawal']]);
    // ⚠️ THE PROVIDER'S OWN WORD, and it is not terminal. The console must
    // render 「we have asked」 off this, never 「refunded」.
    expect(out.payload.provider_status).toBe('pending');
    expect(out.payload.settles_via_webhook).toBe(true);
  });

  it('🔴 asks for NO reason — a withdrawal is exercised, not applied for', async () => {
    // The body carries an order id and nothing else. If a `reason` were ever
    // required, this call would start failing — which is the point.
    const { db, deps, token } = world({
      refund: async () => ({ ok: true, providerStatus: 'pending' }),
    });
    const id = purchaseFor(db);
    const out = await call(deps, 'POST', '/api/cloud/billing/service-withdraw', {
      token,
      body: { order_id: id },
    }).settled;
    expect(out.status).toBe(200);
  });

  it('🔴 refuses to refund somebody else’s purchase, even with a valid id', async () => {
    // The refund action is keyed by order id and knows nothing about who is
    // asking; without the ownership check here, a signed-in stranger could
    // withdraw a purchase by guessing one.
    const calls: string[] = [];
    const { db, deps, token } = world({
      refund: async (orderId) => {
        calls.push(orderId);
        return { ok: true, providerStatus: 'pending' };
      },
    });
    db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free', email: 'other@example.com' });
    purchaseFor(db, { order_id: 'ord_theirs', user_id: 'u2' });
    const out = await call(deps, 'POST', '/api/cloud/billing/service-withdraw', {
      token, // u1's
      body: { order_id: 'ord_theirs' },
    }).settled;
    expect(out.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('anonymous cannot withdraw anything', async () => {
    const { db, deps } = world({ refund: async () => ({ ok: true, providerStatus: 'p' }) });
    const id = purchaseFor(db);
    const out = await call(deps, 'POST', '/api/cloud/billing/service-withdraw', {
      body: { order_id: id },
    }).settled;
    expect(out.status).toBe(401);
  });

  it('a deployment with no outbound client refuses by name', async () => {
    const { db, deps, token } = world(); // no `refund`
    const id = purchaseFor(db);
    const out = await call(deps, 'POST', '/api/cloud/billing/service-withdraw', {
      token,
      body: { order_id: id },
    }).settled;
    expect(out.status).toBe(503);
    expect(out.payload.error).toBe(SERVICE_NOT_AVAILABLE);
  });

  it('and when the provider refuses, it says the money has NOT moved', async () => {
    const { db, deps, token } = world({
      refund: async () => ({ ok: false, reason: 'provider_refused', detail: 'x' }),
    });
    const id = purchaseFor(db);
    const out = await call(deps, 'POST', '/api/cloud/billing/service-withdraw', {
      token,
      body: { order_id: id },
    }).settled;
    expect(out.status).toBe(502);
    expect(out.payload.error).toBe(SERVICE_REFUND_REFUSED);
  });
});

describe('⑧ CRD art. 11a — the withdrawal is acknowledged in writing', () => {
  it('sends the acknowledgement to the ACCOUNT address, dated when we received it', async () => {
    const m = serviceMailer();
    const { db, deps, token } = world({
      refund: async () => ({ ok: true, providerStatus: 'pending' }),
      mailer: m.mailer,
    });
    const id = purchaseFor(db);
    await call(deps, 'POST', '/api/cloud/billing/service-withdraw', {
      token,
      body: { order_id: id },
    }).settled;
    expect(m.acks).toEqual([
      {
        to: 'buyer@example.com',
        orderId: id,
        receivedAt: NOW_ISO,
        amountMinor: 20000,
        currency: 'USD',
      },
    ]);
  });

  it('🔴 a mail failure does NOT undo the withdrawal', async () => {
    // The refund is already asked for by the time this runs. Turning a mail
    // outage into a 502 would tell somebody exercising a statutory right that
    // nothing happened — and send them to do it again, or to their bank.
    const { db, deps, token } = world({
      refund: async () => ({ ok: true, providerStatus: 'pending' }),
      mailer: {
        id: 'test',
        async sendSetupCompleted(): Promise<void> {},
        async sendWithdrawalReceived(): Promise<void> {
          throw new Error('mail server said no');
        },
        async sendRefundSettledByHand(): Promise<void> {},
        async sendRefundReleased(): Promise<void> {},
      },
    });
    const id = purchaseFor(db);
    const out = await call(deps, 'POST', '/api/cloud/billing/service-withdraw', {
      token,
      body: { order_id: id },
    }).settled;
    expect(out.status).toBe(200);
    expect(out.payload.ok).toBe(true);
  });
});

describe('⑨ the console can see whether the button belongs on the screen', () => {
  it('paid, scheduled and in_progress are refundable with no end date', async () => {
    // 🔴 in_progress IS REFUNDABLE (gs-5): a setup that has begun is not
    // complete, and the buyer keeps the button until the operator confirms it.
    for (const state of ['paid', 'scheduled', 'in_progress'] as const) {
      const { db, deps, token } = world();
      purchaseFor(db, { state, scheduled_at: state === 'paid' ? null : NOW_ISO, started_at: state === 'in_progress' ? NOW_ISO : null });
      const out = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
      const row = (out.payload.purchases as Record<string, unknown>[])[0]!;
      expect(row.refund_window, state).toEqual({ open: true, reason: 'not_yet_completed', closes_at: null });
      expect(row.next_step, state).toBe(state === 'paid' ? 'awaiting_contact' : state);
      expect(row.support_until, state).toBeNull();
    }
  });

  it('🔴 a delivered purchase is NOT refundable — whether or not we emailed — and the write agrees', async () => {
    // The gs-5 assertion, both halves: what the page is told AND what the
    // button does. The refunder here is the REAL action over the same database,
    // so the 409 is the claim SQL refusing a 'delivered' row, not a stub.
    for (const notice of [null, new Date(NOW_MS - 1 * DAY_MS).toISOString()]) {
      const { db, deps: base, token } = world();
      const deps = { ...base, refund: realRefunder(db) };
      const deliveredAt = new Date(NOW_MS - 3 * DAY_MS).toISOString();
      const id = purchaseFor(db, { state: 'delivered', delivered_at: deliveredAt, completion_notice_at: notice });
      const out = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
      const row = (out.payload.purchases as Record<string, unknown>[])[0]!;
      expect(row.completion_notice_at, String(notice)).toBe(notice);
      expect(row.refund_window, String(notice)).toEqual({ open: false, reason: 'completed', closes_at: null });
      const withdraw = await call(deps, 'POST', '/api/cloud/billing/service-withdraw', { token, body: { order_id: id } }).settled;
      expect(withdraw.status, String(notice)).toBe(409);
      expect(withdraw.payload.error, String(notice)).toBe(SERVICE_NOT_REFUNDABLE);
      expect(db.billing.getOneTimePurchase(id)!.state).toBe('delivered');
    }
  });

  it('a delivered purchase shows support until delivered_at + 14 days, then closed', async () => {
    const inside = world();
    const deliveredAt = new Date(NOW_MS - 3 * DAY_MS).toISOString();
    purchaseFor(inside.db, { state: 'delivered', delivered_at: deliveredAt });
    const a = await call(inside.deps, 'GET', '/api/cloud/billing/services', { token: inside.token }).settled;
    const rowA = (a.payload.purchases as Record<string, unknown>[])[0]!;
    expect(rowA.next_step).toBe('support');
    expect(rowA.support_until).toBe(new Date(Date.parse(deliveredAt) + GUIDED_SETUP_AFTERCARE_DAYS * DAY_MS).toISOString());
    expect(rowA.delivered_at).toBe(deliveredAt);

    const after = world();
    purchaseFor(after.db, { state: 'delivered', delivered_at: new Date(NOW_MS - 30 * DAY_MS).toISOString() });
    const b = await call(after.deps, 'GET', '/api/cloud/billing/services', { token: after.token }).settled;
    const rowB = (b.payload.purchases as Record<string, unknown>[])[0]!;
    expect(rowB.next_step).toBe('closed');
    // The support date stays on the row after it has passed — it is a fact,
    // not a countdown — and the refund is closed either way.
    expect(typeof rowB.support_until).toBe('string');
    expect((rowB.refund_window as Record<string, unknown>).reason).toBe('completed');
  });

  it('the periods come from the server, so the page cannot make an old promise — and there is no dispute_days', async () => {
    const { db, deps, token } = world();
    purchaseFor(db, { state: 'in_progress', scheduled_at: NOW_ISO, started_at: NOW_ISO });
    const out = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
    expect(out.payload.start_deadline_days).toBe(14);
    expect(out.payload.aftercare_days).toBe(GUIDED_SETUP_AFTERCARE_DAYS);
    expect(out.payload.terms_version).toBe(GUIDED_SETUP_CONSENT_VERSION);
    // gs-5 has no post-completion refund period, so the wire has no number for one.
    expect(out.payload).not.toHaveProperty('dispute_days');
    // And owner 2026-08-30 removed the completion deadline outright, so the
    // wire carries no number for that either — a page that found one would
    // print a promise nobody makes.
    expect(out.payload).not.toHaveProperty('complete_deadline_days');
    const row = (out.payload.purchases as Record<string, unknown>[])[0]!;
    expect(row).toHaveProperty('started_at', NOW_ISO);
    expect(row).toHaveProperty('support_until', null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// owner 2026-08-30 — a box that cannot sell says so, rather than failing.

describe('⑩ 🔴 「not on sale」 is an ANSWER, not a failure', () => {
  it('reports on_sale:false when there is no client, and still serves the read', async () => {
    // 🔴 THE DEFECT THIS CLOSES. `servicePurchaseDeps` used to return `{}` when
    // Creem was off, so these routes 404'd — and a console can read a 404
    // exactly one way. It rendered 「we could not load your purchases」 to
    // somebody whose account was fine, on a deployment that simply is not
    // selling yet. An absence turned into a claim about a failure.
    const { deps, token } = world({ creem: undefined, productId: undefined });
    const out = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
    expect(out.status).toBe(200);
    expect(out.payload.on_sale).toBe(false);
    expect(out.payload.purchases).toEqual([]);
  });

  it('reports on_sale:true when it can actually sell', async () => {
    const { deps, token } = world();
    const out = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
    expect(out.payload.on_sale).toBe(true);
  });

  it('🔴 on_sale FALSE and the buy route REFUSING are the same condition', async () => {
    // The pairing that matters: the console hides its button off `on_sale`, and
    // the server refuses the write off the same two fields. If they could
    // disagree, the page would either offer a checkout that 503s or hide one
    // that would have worked.
    for (const missing of [
      { creem: undefined },
      { productId: undefined },
      { productId: '' },
    ] as const) {
      const { deps, token } = world(missing as never);
      const list = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
      const buy = await call(deps, 'POST', '/api/cloud/billing/service-checkout', {
        token,
        body: CONSENT,
      }).settled;
      expect(list.payload.on_sale, JSON.stringify(missing)).toBe(false);
      expect(buy.status, JSON.stringify(missing)).toBe(503);
      expect(buy.payload.error).toBe(SERVICE_NOT_AVAILABLE);
    }
  });

  it('⚠️ a purchase made while it WAS on sale still comes back when it is not', async () => {
    // Their row is money they paid and an obligation we owe. It does not stop
    // existing because a deployment flag moved, and a console that hid it would
    // be telling somebody their purchase is gone.
    const { db, deps, token } = world({ creem: undefined, productId: undefined });
    db.billing.recordOneTimePurchase({
      order_id: 'ord_before',
      provider: 'creem',
      user_id: 'u1',
      product_id: PRODUCT,
      checkout_id: null,
      transaction_id: null,
      customer_id: null,
      amount_minor: 20000,
      currency: 'USD',
      state: 'paid',
      early_start_consent_at: NOW_ISO,
      withdrawal_waiver_ack_at: NOW_ISO,
      consent_terms_version: GUIDED_SETUP_CONSENT_VERSION,
      scheduled_at: null,
      started_at: null,
      delivered_at: null,
      refund_requested_at: null,
      refund_provider_id: null,
      refund_status: null,
      refunded_at: null,
      completion_notice_at: null,
      note: null,
      created_at: NOW_ISO,
    });
    const out = await call(deps, 'GET', '/api/cloud/billing/services', { token }).settled;
    expect(out.payload.on_sale).toBe(false);
    const list = out.payload.purchases as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]!.order_id).toBe('ord_before');
    // …and its refund window is still computed, so they can still withdraw.
    expect((list[0]!.refund_window as Record<string, unknown>).open).toBe(true);
  });
});
