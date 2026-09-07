// POST /api/cloud/billing/subscribe — the one route that can START a recurring
// charge, driven over a real http server with real repos, a real BillingService
// and a real Bearer. Only the Creem client is a stub.
//
// SPEC-REF: apps/server-core/src/http/subscription-checkout-routes.ts
//
// 🔴 WHAT THIS FILE CANNOT PROVE, said first so nobody reads its green as more
// than it is. The Creem client here is a fake of a boundary WE DO NOT OWN, so
// these cases are exactly as true as our reading of Creem's API — the 0.2.48 L9
// lesson (fifteen adapter tests, all green, all driving a FakeWs that answered
// the way we had assumed, while the real vendor did not). What IS real about
// the provider was measured live and is recorded in
// docs/strategy/2026-08-29-creem-stage0-findings.md §2b. What these cases prove
// is the half that is ours: who is admitted, what we refuse and why, what we
// send, and — the one that costs actual money — WHEN WE DO NOT CALL AT ALL.
//
// ── 🔴 THE ASSERTION THAT MATTERS MOST IS A NEGATIVE ONE ──────────────────
//
// `sent` stays empty on every refusal. A route that answers 409 AFTER creating a
// checkout has still handed a browser a URL that will charge somebody, and the
// response body would look identical. Nothing but 「we never asked」 catches it,
// and every refusal case below asserts it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { BillingService } from '../src/billing/billing-service';
import { CreemWritesDisabledError, type CreateCheckoutInput, type CreemClient } from '../src/billing/creem/client';
import { CREEM_USER_ID_KEY } from '../src/billing/creem/envelope';
import type { SubscriptionSnapshot, SubscriptionWriter } from '../src/billing/subscription-writer';
import {
  CHANGE_PLAN_PATH,
  SUBSCRIBE_PATH,
  SWITCH_BLOCKED,
  SWITCH_NO_SUBSCRIPTION,
  SWITCH_REFUSED,
  SWITCH_SAME_TIER,
  SWITCH_UNAVAILABLE,
  SWITCH_UNCONFIRMED,
  SUB_ALREADY_ACTIVE,
  SUB_BODY_UNREADABLE,
  SUB_CHECKOUT_FAILED,
  SUB_NOT_AVAILABLE,
  SUB_NOT_NEEDED,
  SUB_TIER_UNKNOWN,
  subscriptionProducts,
  tryHandleSubscriptionCheckoutRoutes,
  type SubscriptionCheckoutDeps,
} from '../src/http/subscription-checkout-routes';

const SECRET = 'subscription-checkout-secret-32-bytes';
const NOW = Date.parse('2026-09-04T00:00:00.000Z');
const FUTURE = '2026-10-04T00:00:00.000Z';
const PAST = '2026-08-04T00:00:00.000Z';
/** The real live ids, so a copy-paste of this table into an env var is a working
 *  one and so a reader can match them against the cutover ledger. */
const PRO = 'prod_55Ds7ccVOs7sRzZU9R1FJV';
const MAX = 'prod_6fQJmJc5GxqjjbStbkn23u';
const SUCCESS_URL = 'https://flowmic.app/console/billing';

let db: DbConnection;
let auth: AuthService;
let server: Server;
let url: string;
/** Every checkout we asked Creem to create. The negative assertions live here. */
let sent: CreateCheckoutInput[];
/** Every plan change we asked a provider for. Same negative-assertion role as
 *  `sent`: a refusal that still called the provider has already moved money. */
let switched: { subscriptionId: string; productId: string }[];

type ClientBehaviour = 'ok' | 'writes-disabled' | 'rejected' | 'unreachable';

/** A Creem-shaped writer: it CAN change plan. The Paddle-shaped one below
 *  cannot, and that absence is what the route must answer by name. */
function fakeWriter(behaviour: ClientBehaviour): SubscriptionWriter {
  const snap: SubscriptionSnapshot = { status: 'active', scheduled_change: null };
  const fail = (): never => {
    throw new Error('not exercised by this suite');
  };
  return {
    provider: 'creem',
    cancelSubscription: async () => fail(),
    clearScheduledChange: async () => fail(),
    findRefundableTransaction: async () => fail(),
    createRefund: async () => fail(),
    getSubscription: async () => ({ ok: true, data: snap }),
    changePlan: async (subscriptionId, productId) => {
      if (behaviour === 'writes-disabled') throw new CreemWritesDisabledError('changePlan');
      switched.push({ subscriptionId, productId });
      if (behaviour === 'rejected') return { ok: false, code: 'PROVIDER_REJECTED', detail: 'no' };
      if (behaviour === 'unreachable') return { ok: false, code: 'PROVIDER_UNREACHABLE', detail: 'timeout' };
      return { ok: true, data: snap };
    },
  };
}

/** Paddle's writer has no `changePlan` — nobody has wired one. */
function paddleShapedWriter(): SubscriptionWriter {
  const w = fakeWriter('ok');
  const { changePlan: _omitted, ...rest } = w;
  return { ...rest, provider: 'paddle' };
}

function fakeCreem(behaviour: ClientBehaviour): CreemClient {
  return {
    createCheckout: async (input) => {
      // 🔴 RECORDED BEFORE THE BEHAVIOUR BRANCH — except for `writes-disabled`,
      // which throws before anything leaves the process and must NOT count as a
      // call. That distinction is the point of the switch being tested at all.
      if (behaviour === 'writes-disabled') throw new CreemWritesDisabledError('createCheckout');
      sent.push(input);
      if (behaviour === 'rejected') return { ok: false, code: 'CREEM_REJECTED', detail: 'product not found' };
      if (behaviour === 'unreachable') return { ok: false, code: 'CREEM_UNREACHABLE', detail: 'timeout' };
      return { ok: true, data: { id: 'ch_test', checkout_url: 'https://creem.io/checkout/test' } };
    },
  };
}

function makeDeps(over: Partial<SubscriptionCheckoutDeps> = {}, behaviour: ClientBehaviour = 'ok'): SubscriptionCheckoutDeps {
  return {
    auth,
    billing: new BillingService({
      settings: db.settings,
      users: db.users,
      usage: db.usage,
      billing: db.billing,
      unlockAll: false,
      now: () => NOW,
    }),
    creem: fakeCreem(behaviour),
    products: { pro: PRO, max: MAX },
    successUrl: SUCCESS_URL,
    writerFor: (provider: string) =>
      provider === 'creem' ? fakeWriter(behaviour) : provider === 'paddle' ? paddleShapedWriter() : null,
    ...over,
  };
}

function boot(over: Partial<SubscriptionCheckoutDeps> = {}, behaviour: ClientBehaviour = 'ok'): void {
  const deps = makeDeps(over, behaviour);
  server = createServer((req, res) => {
    if (!tryHandleSubscriptionCheckoutRoutes(req, res, deps)) {
      res.writeHead(404).end('{}');
    }
  });
  server.listen(0);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'T' });
  return { id: user.id, bearer: { authorization: `Bearer ${auth.issueToken(user).token}` } };
}

/** A real provider row, written through the repo the webhook writes through —
 *  not by direct SQL, so what is under test is the shape production holds. */
function subscribe(userId: string, over: Record<string, unknown> = {}): void {
  db.billing.upsertSubscription({
    subscription_id: 'sub_existing',
    user_id: userId,
    provider: 'creem',
    customer_id: 'cust_x',
    status: 'active',
    tier: 'pro',
    price_id: PRO,
    cycle: 'monthly',
    current_period_end: FUTURE,
    canceled_at: null,
    scheduled_change_action: null,
    scheduled_change_at: null,
    next_billed_at: FUTURE,
    contract_concluded_at: '2026-09-01T00:00:00.000Z',
    last_event_id: 'evt_1',
    last_occurred_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  });
}

async function subscribeCall(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${SUBSCRIBE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET) });
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => NOW });
  sent = [];
  switched = [];
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

describe('who may start a subscription', () => {
  it('🔴 nobody anonymous — and we do not ask Creem for a URL first', async () => {
    // A checkout we build for nobody carries no `flowmic_user_id`, so the money
    // arrives attributable to no account and lands in the ledger as `unmapped`
    // while a real card has been charged.
    boot();
    const r = await subscribeCall({ tier: 'pro' });
    expect(r.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('a garbage bearer is refused the same way', async () => {
    boot();
    const r = await subscribeCall({ tier: 'pro' }, { authorization: 'Bearer not-a-token' });
    expect(r.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('an UNVERIFIED email may still buy — being anonymous is what is refused', async () => {
    // Refusing an unverified address takes money off the table for an account
    // state that is recoverable, and the sibling one-time route already made
    // this call. The two must not drift apart.
    boot();
    const a = await account('unverified@sub.test');
    expect(db.users.findById(a.id)?.email_verified_at ?? null).toBeNull();
    const r = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(200);
  });
});

describe('which tier', () => {
  it('the happy path sends the PRO product, our success URL, and the buyer id', async () => {
    boot();
    const a = await account('pro@sub.test');
    const r = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(200);
    expect(r.json.checkout_url).toBe('https://creem.io/checkout/test');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.productId).toBe(PRO);
    expect(sent[0]!.successUrl).toBe(SUCCESS_URL);
    // 🔴 THE ONLY CHANNEL BY WHICH THIS PAYMENT CAN EVER NAME ITS BUYER. A
    // missing or misspelled key still produces a paid customer — on the free
    // tier, with nothing red anywhere.
    expect(sent[0]!.metadata[CREEM_USER_ID_KEY]).toBe(a.id);
  });

  it('max sends the MAX product — the tier is read, not defaulted to the first entry', async () => {
    boot();
    const a = await account('max@sub.test');
    const r = await subscribeCall({ tier: 'max' }, a.bearer);
    expect(r.status).toBe(200);
    expect(sent[0]!.productId).toBe(MAX);
  });

  it('🔴 an unrecognised tier is refused, never defaulted', async () => {
    // 「subscribe me to something」 has no safe default when the something costs
    // money every month.
    boot();
    const a = await account('tier@sub.test');
    for (const body of [{}, { tier: 'free' }, { tier: 'gold' }, { tier: 5 }, { tier: null }]) {
      const r = await subscribeCall(body, a.bearer);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe(SUB_TIER_UNKNOWN);
    }
    expect(sent).toHaveLength(0);
  });

  it('an unparseable body is its own answer', async () => {
    boot();
    const a = await account('body@sub.test');
    const r = await subscribeCall('{not json', a.bearer);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(SUB_BODY_UNREADABLE);
    expect(sent).toHaveLength(0);
  });
});

describe('🔴 never a second live subscription', () => {
  // The failure this whole block exists to prevent: a Pro subscriber clicks Max,
  // gets a second checkout, and is billed twice — with both subscriptions
  // looking perfectly correct at the provider. Creem HAS an upgrade endpoint
  // (probed live 2026-08-29) and we have not wired it; until we do, refusing is
  // the only honest answer.
  for (const [label, over] of [
    ['active', {}],
    ['past_due — the provider is still retrying the charge', { status: 'past_due' }],
    ['paused — it can start charging again', { status: 'paused' }],
  ] as const) {
    it(`refuses while a subscription is ${label}, and asks Creem for nothing`, async () => {
      boot();
      const a = await account(`${String(label).slice(0, 6)}@dup.test`);
      subscribe(a.id, over);
      const r = await subscribeCall({ tier: 'max' }, a.bearer);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe(SUB_ALREADY_ACTIVE);
      expect(sent).toHaveLength(0);
    });
  }

  it('a cancellation ALREADY SCHEDULED is still a live subscription, and the refusal says so', async () => {
    // Creem reports a scheduled cancel as `active`, so this person is inside the
    // block above — and the right control for them is 「resume」. The console
    // cannot say that without knowing WHICH refusal this is, so the body carries
    // the scheduled change rather than making it ask again (a second round trip
    // could answer differently than the one this refusal was based on).
    boot();
    const a = await account('sched@dup.test');
    subscribe(a.id, { scheduled_change_action: 'cancel', scheduled_change_at: FUTURE });
    const r = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe(SUB_ALREADY_ACTIVE);
    expect(r.json.state).toBe('active');
    expect(r.json.scheduled_change).toEqual({ action: 'cancel', effective_at: FUTURE });
    expect(sent).toHaveLength(0);
  });

  it('⚠️ REVERSE CONTROL — a finished subscription does NOT block: buying is the way back', async () => {
    // If this went the other way the block above would be a wall rather than a
    // guard, and a former customer would be told we do not want their money.
    boot();
    const a = await account('back@dup.test');
    subscribe(a.id, { status: 'canceled', current_period_end: PAST, canceled_at: PAST });
    const r = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('🔴 an exempt account is refused with its OWN code — and it is money we decline', async () => {
    // A permanent-free account already has MAX's limits. Letting it buy charges
    // somebody every month for what they already have, and the first thing we
    // would do on noticing is refund it. 「you already have this for free」 and
    // 「you already have a subscription」 are two different sentences.
    boot();
    const a = await account('exempt@sub.test');
    db.users.setPermanentFree(a.id, true);
    const r = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe(SUB_NOT_NEEDED);
    expect(r.json.error).not.toBe(SUB_ALREADY_ACTIVE);
    expect(sent).toHaveLength(0);
  });
});

describe('when this deployment cannot sell', () => {
  it('no client ⇒ refuses BY NAME, not 404 and not 500', async () => {
    boot({ creem: undefined });
    const a = await account('noclient@sub.test');
    const r = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe(SUB_NOT_AVAILABLE);
  });

  it('a tier with no product refuses for THAT TIER while the other one still sells', async () => {
    // A deployment selling Pro but not Max is a strange state, not a broken one.
    boot({ products: { pro: PRO } });
    const a = await account('halftier@sub.test');
    const bad = await subscribeCall({ tier: 'max' }, a.bearer);
    expect(bad.status).toBe(503);
    expect(bad.json.error).toBe(SUB_NOT_AVAILABLE);
    expect(bad.json.tier).toBe('max');
    expect(sent).toHaveLength(0);

    const good = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(good.status).toBe(200);
  });

  it('🔴 outbound writes switched OFF is a 503 about US, not a failed checkout', async () => {
    // The client throws by name. Letting that fall into the generic catch would
    // report one of our own deployment switches as 「the checkout failed」 and
    // send an operator to Creem's status page to look for a setting on our box.
    boot({}, 'writes-disabled');
    const a = await account('writesoff@sub.test');
    const r = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe(SUB_NOT_AVAILABLE);
    expect(r.json.error).not.toBe(SUB_CHECKOUT_FAILED);
  });

  for (const behaviour of ['rejected', 'unreachable'] as const) {
    it(`the provider answering ${behaviour} is a 502 — and we never claim a URL we do not have`, async () => {
      boot({}, behaviour);
      const a = await account(`${behaviour}@sub.test`);
      const r = await subscribeCall({ tier: 'pro' }, a.bearer);
      expect(r.status).toBe(502);
      expect(r.json.error).toBe(SUB_CHECKOUT_FAILED);
      expect(r.json.checkout_url).toBeUndefined();
    });
  }
});

describe('GET — what the console is allowed to offer', () => {
  async function read(headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}${SUBSCRIBE_PATH}`, { method: 'GET', headers });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  it('names both tiers when this deployment can sell them', async () => {
    boot();
    const a = await account('read@sub.test');
    const r = await read(a.bearer);
    expect(r.status).toBe(200);
    expect(r.json.purchasable).toEqual(['pro', 'max']);
  });

  it('🔴 answers EMPTY on exactly the condition the write refuses on', async () => {
    // The pair that must never disagree: a button shown for a tier the POST
    // would refuse is a checkout that 503s under somebody's finger. Both read
    // `deps.products`, so this asserts they are one value and not two opinions.
    boot({ products: {} });
    const a = await account('closed@sub.test');
    expect((await read(a.bearer)).json.purchasable).toEqual([]);
    const post = await subscribeCall({ tier: 'pro' }, a.bearer);
    expect(post.status).toBe(503);
    expect(post.json.error).toBe(SUB_NOT_AVAILABLE);
  });

  it('no client ⇒ nothing is offered, whatever the table says', async () => {
    boot({ creem: undefined });
    const a = await account('noclientread@sub.test');
    expect((await read(a.bearer)).json.purchasable).toEqual([]);
  });

  it('a half-configured deployment offers only the tier it can actually sell', async () => {
    boot({ products: { max: MAX } });
    const a = await account('halfread@sub.test');
    expect((await read(a.bearer)).json.purchasable).toEqual(['max']);
  });

  it('anonymous cannot read it either — one door, one rule', async () => {
    boot();
    expect((await read()).status).toBe(401);
  });
});

describe('subscriptionProducts — reversing the one table', () => {
  it('reads the same JSON the webhook reads, in the other direction', () => {
    expect(subscriptionProducts({ [PRO]: 'pro', [MAX]: 'max' })).toEqual({ pro: PRO, max: MAX });
  });

  it('🔴 an ambiguous tier is DROPPED, never picked from', () => {
    // Two products for one tier means 「subscribe to Pro」 has two answers, and
    // taking the first would let JSON key order decide a price. Dropping it makes
    // the route refuse by name — a sentence somebody can act on.
    const out = subscriptionProducts({ prod_a: 'pro', prod_b: 'pro', [MAX]: 'max' });
    expect(out.pro).toBeUndefined();
    expect(out.max).toBe(MAX);
  });

  it('a product mapped to free is skipped — a paid checkout for the free tier is a contradiction', () => {
    expect(subscriptionProducts({ prod_free: 'free', [PRO]: 'pro' })).toEqual({ pro: PRO });
  });

  it('an empty table yields an empty map, which is what the route refuses on', () => {
    expect(subscriptionProducts({})).toEqual({});
  });
});

describe('changing plan — Pro ⇄ Max on a live subscription', () => {
  async function change(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res = await fetch(`${url}${CHANGE_PLAN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  it('🔴 anonymous cannot re-price anybody', async () => {
    boot();
    expect((await change({ tier: 'max' })).status).toBe(401);
    expect(switched).toHaveLength(0);
  });

  it('the happy path asks the ROW\'S provider to move THIS subscription to the MAX product', async () => {
    boot();
    const a = await account('up@switch.test');
    subscribe(a.id);
    const r = await change({ tier: 'max' }, a.bearer);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.to).toBe('max');
    // The receipt says the local row is NOT yet updated — the webhook does that.
    expect(r.json.settles_via_webhook).toBe(true);
    expect(switched).toEqual([{ subscriptionId: 'sub_existing', productId: MAX }]);
    // 🔴 AND NOTHING WAS WRITTEN LOCALLY. One author for the row.
    expect(db.billing.getSubscription('sub_existing')?.tier).toBe('pro');
  });

  it('downgrade is the same call with the other product', async () => {
    boot();
    const a = await account('down@switch.test');
    subscribe(a.id, { tier: 'max', price_id: MAX });
    const r = await change({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(200);
    expect(switched[0]!.productId).toBe(PRO);
  });

  it('🔴 no live subscription ⇒ refused by name, and buying is the answer', async () => {
    boot();
    const a = await account('none@switch.test');
    for (const [label, seed] of [
      ['never subscribed', null],
      ['expired', { status: 'canceled', current_period_end: PAST, canceled_at: PAST }],
    ] as const) {
      if (seed) subscribe(a.id, seed);
      const r = await change({ tier: 'max' }, a.bearer);
      expect(r.status, label).toBe(409);
      expect(r.json.error, label).toBe(SWITCH_NO_SUBSCRIPTION);
    }
    expect(switched).toHaveLength(0);
  });

  it('the tier already held ⇒ nothing is charged and nothing is asked', async () => {
    boot();
    const a = await account('same@switch.test');
    subscribe(a.id);
    const r = await change({ tier: 'pro' }, a.bearer);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe(SWITCH_SAME_TIER);
    expect(switched).toHaveLength(0);
  });

  for (const [label, over] of [
    ['a cancellation is scheduled — resume first', { scheduled_change_action: 'cancel', scheduled_change_at: FUTURE }],
    ['past_due — the provider is chasing money already', { status: 'past_due' }],
    ['paused', { status: 'paused' }],
  ] as const) {
    it(`🔴 refuses to re-price while ${label}, and asks nothing`, async () => {
      boot();
      // ⚠️ Not derived from the label: the first one starts with 「a c…」 and a
      // space is not a valid address, which fails the fixture, not the route.
      const a = await account(`${String(over.status ?? 'sched')}@blocked.test`);
      subscribe(a.id, over);
      const r = await change({ tier: 'max' }, a.bearer);
      expect(r.status).toBe(409);
      expect(r.json.error).toBe(SWITCH_BLOCKED);
      expect(switched).toHaveLength(0);
    });
  }

  it('🔴 a subscription held by a provider with no change-plan call is refused BY NAME, not sent somewhere else', async () => {
    // The row says paddle; Paddle's writer has no changePlan. Falling back to
    // the Creem client would send a Paddle id to Creem and answer 「subscription
    // does not exist」 to a paying customer.
    boot();
    const a = await account('paddle@switch.test');
    subscribe(a.id, { provider: 'paddle', subscription_id: 'sub_paddle', price_id: 'pri_x' });
    const r = await change({ tier: 'max' }, a.bearer);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe(SWITCH_UNAVAILABLE);
    expect(switched).toHaveLength(0);
  });

  it('a tier not for sale here is refused the same way — a switch IS a sale', async () => {
    boot({ products: {} });
    const a = await account('closed@switch.test');
    subscribe(a.id);
    const r = await change({ tier: 'max' }, a.bearer);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe(SWITCH_UNAVAILABLE);
    expect(switched).toHaveLength(0);
  });

  it('🔴 a timeout is 「not confirmed」, never 「refused」 — the charge may already have happened', async () => {
    boot({}, 'unreachable');
    const a = await account('timeout@switch.test');
    subscribe(a.id);
    const r = await change({ tier: 'max' }, a.bearer);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe(SWITCH_UNCONFIRMED);
    expect(r.json.error).not.toBe(SWITCH_REFUSED);
  });

  it('the provider saying no is 「refused」 — nothing changed', async () => {
    boot({}, 'rejected');
    const a = await account('no@switch.test');
    subscribe(a.id);
    const r = await change({ tier: 'max' }, a.bearer);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe(SWITCH_REFUSED);
  });

  it('outbound writes off is a 503 about us', async () => {
    boot({}, 'writes-disabled');
    const a = await account('off@switch.test');
    subscribe(a.id);
    const r = await change({ tier: 'max' }, a.bearer);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe(SWITCH_UNAVAILABLE);
    expect(switched).toHaveLength(0);
  });
});
