// THE WHOLE SUBSCRIPTION LIFECYCLE, END TO END, OVER A REAL BOOTED SERVER.
//
// SPEC-REF: apps/server-core/src/http/subscription-checkout-routes.ts (buy)
//           apps/server-core/src/http/billing-routes.ts (cancel / resume)
//           apps/server-core/src/billing/creem/envelope.ts (what an event means)
//           apps/server-core/test/service-e2e.test.ts (the sibling; same rig)
//
// ── WHY THIS EXISTS ALONGSIDE THE UNIT SUITES ─────────────────────────────
//
// Each of those mounts ONE handler on a bare server and proves its logic. This
// repo has been burned by exactly that gap (book 13 §7 F1 ③: 「单测全绿对『接线』
// 零证明力」), and on this chain the untested seam was expensive: the 2026-08-30
// P0 had the Creem webhook silently unmounted in the one deployment shape we
// intended to run, with 2,891 unit tests green.
//
// What only this file can answer:
//   · that `subscriptionCheckoutDeps` is REACHED by bootstrap under a realistic
//     config — a missing mount is 404 here and green everywhere else;
//   · that a payment which arrives as a signed webhook actually MOVES THE TIER
//     the console reads. The route that sells and the route that reports are
//     different files, and neither unit suite can see the other half;
//   · that a cancellation is still SERVICE UNTIL THE PERIOD ENDS, and becomes
//     free only when the subscription really ends. Those are two different
//     moments and the console says two different things about them;
//   · that the guard against a SECOND subscription holds over the wired stack,
//     not just against a hand-made PlanView.
//
// 🔴 WHAT IT STILL DOES NOT PROVE. Creem's own HTTP is stubbed, so a green run
// is evidence about OUR chain and none about theirs. The honest phrase is
// 「wired end to end against a stubbed provider」. What IS real about the vendor
// was measured live and recorded in docs/strategy/2026-08-29-creem-stage0-
// findings.md §2b — and this file's payload shapes are copied from those
// measurements rather than from documentation.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { signCreemPayload } from '../src/billing/creem/signature';
import { CREEM_USER_ID_KEY } from '../src/billing/creem/envelope';
import { SUB_ALREADY_ACTIVE } from '../src/http/subscription-checkout-routes';

const WEBHOOK_SECRET = 'creem-sub-e2e-webhook-secret';
/** One value for both JWT and settings secrets — `resolveStandaloneSecret` reads
 *  SETTINGS first, and two different values make a hand-minted token verify
 *  against the wrong key (the service-e2e rig paid for that lesson). */
const SIGNING_SECRET = 'subscription-e2e-shared-secret-32-bytes';
const PRO = 'prod_55Ds7ccVOs7sRzZU9R1FJV';
const MAX = 'prod_6fQJmJc5GxqjjbStbkn23u';
const SUB_ID = 'sub_e2e_live';
const CUSTOMER = 'cust_e2e';
/** Real dates against the real clock: the server uses `Date.now()` and the whole
 *  point of the last act is that a period end in the PAST stops granting. */
const PERIOD_END_FUTURE = '2026-12-01T00:00:00.000Z';
const PAST = '2026-08-04T00:00:00.000Z';

let handle: BootstrapHandle;
let base: string;
let bearer: Record<string, string>;
let userId: string;
/** Every outbound request the server made to Creem — the only way to assert
 *  what we SENT, which no response body reveals. */
let sent: { url: string; body: any }[];
let realFetch: typeof globalThis.fetch;

async function req(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Deliver a signed Creem webhook the way Creem would. */
async function webhook(payload: unknown, opts: { signature?: string } = {}): Promise<{ status: number; json: any }> {
  const raw = JSON.stringify(payload);
  const res = await realFetch(`${base}/api/creem/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'creem-signature': opts.signature ?? signCreemPayload(raw, WEBHOOK_SECRET),
    },
    body: raw,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The subscription object as the live API returns one (findings §2b). */
function subscriptionObject(over: Record<string, unknown> = {}) {
  return {
    id: SUB_ID,
    status: 'active',
    product: { id: PRO, billing_period: 'every-month' },
    customer: { id: CUSTOMER },
    current_period_end_date: PERIOD_END_FUTURE,
    next_transaction_date: PERIOD_END_FUTURE,
    created_at: PAST,
    canceled_at: null,
    // 🔴 OUR value, copied back by Creem. It is the only thing that connects
    // this money to an account.
    metadata: { [CREEM_USER_ID_KEY]: userId },
    ...over,
  };
}

let eventSeq = 0;
function subscriptionEvent(eventType: string, over: Record<string, unknown> = {}) {
  eventSeq += 1;
  return {
    id: `evt_sub_e2e_${eventSeq}`,
    eventType,
    // Milliseconds, and monotonic across the act: `created_at` is the
    // out-of-order guard's only ruler, so a later event must carry a later stamp
    // or the row keeps the earlier state and the test would be asserting the
    // guard rather than the lifecycle.
    created_at: Date.parse('2026-09-04T00:00:00.000Z') + eventSeq * 1000,
    object: subscriptionObject(over),
  };
}

/** Backdate the account's registration. The cycle anchor is the LATEST of
 *  registration and the subscription boundaries (usage-period.ts), so a fixture
 *  whose subscription started or ended BEFORE the account existed would anchor
 *  to registration and prove nothing about the subscription's effect. Written
 *  in SQLite's own `YYYY-MM-DD HH:MM:SS` UTC form — the form production rows
 *  hold, and the form that once parsed as local time (see parseUtcStamp). */
function backdateRegistration(userId: string, utcDay: string): void {
  handle.db.raw.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(`${utcDay} 00:00:00`, userId);
}

async function plan(): Promise<any> {
  const r = await req('GET', '/api/cloud/subscription', bearer);
  expect(r.status, `subscription read failed: ${JSON.stringify(r.json)}`).toBe(200);
  return r.json.subscription;
}

beforeEach(async () => {
  realFetch = globalThis.fetch;
  sent = [];
  eventSeq = 0;
  // Creem's HTTP, stubbed per endpoint. Calls to our OWN server pass through —
  // otherwise the stub would swallow the requests this test is making.
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes('creem.io')) return realFetch(url as never, init as never);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url: u, body });
    if (u.includes('/upgrade')) {
      // Measured 2026-08-29: same subscription id back, new product, status
      // still active, and a proration transaction created at once.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...subscriptionObject(), product: { id: body?.product_id, billing_period: 'every-month' } }),
      } as unknown as Response;
    }
    if (u.includes('/cancel')) {
      // What the live API answers: no `scheduled_change` field — a booked
      // cancellation is a STATUS. The client projects it; this stub must not do
      // that projection for it, or the projection would go untested.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...subscriptionObject(), status: 'scheduled_cancel' }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'ch_e2e', checkout_url: 'https://pay.creem.test/c/e2e' }),
    } as unknown as Response;
  }) as typeof fetch;

  process.env.FLOWMIC_MODE = 'saas';
  process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1,::1';
  process.env.FLOWMIC_CREEM_ENABLED = '1';
  process.env.FLOWMIC_CREEM_ENV = 'test';
  process.env.FLOWMIC_CREEM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.FLOWMIC_CREEM_API_KEY = 'creem_test_e2e';
  process.env.FLOWMIC_CREEM_WRITE_ENABLED = '1';
  // 🔴 THE PRODUCTION SHAPE: Creem on, Paddle OFF. That combination is the one
  // the 2026-08-30 P0 lived in, and it is the only one worth booting here.
  process.env.FLOWMIC_CREEM_PRODUCT_TIERS = JSON.stringify({ [PRO]: 'pro', [MAX]: 'max' });
  // 🔴 THE SELLING SWITCH, SET EXPLICITLY — it defaults to OFF, and the case at
  // the bottom of this file is the one that proves the default. Configuring the
  // tier table is NOT the same decision as deciding to sell: the table has to be
  // populated for the webhook to grant a tier at all, including for somebody who
  // bought before selling was paused.
  process.env.FLOWMIC_CREEM_SUBSCRIPTIONS_ON_SALE = '1';
  process.env.FLOWMIC_CREEM_SUBSCRIBE_SUCCESS_URL = 'https://flowmic.app/console/billing';
  process.env.FLOWMIC_DB_PATH = ':memory:';
  process.env.FLOWMIC_JWT_SECRET = SIGNING_SECRET;
  process.env.FLOWMIC_SETTINGS_SECRET = SIGNING_SECRET;
  process.env.FLOWMIC_PORT = '0';

  handle = await startServer(loadConfig());
  base = `http://127.0.0.1:${handle.port}`;

  const reg = await req('POST', '/api/register', { 'content-type': 'application/json' }, {
    email: 'subscriber@flowmic.test',
    password: 'longenough1',
    display_name: 'Subscriber',
  });
  expect(reg.status, `register failed: ${JSON.stringify(reg.json)}`).toBe(201);
  bearer = { authorization: `Bearer ${reg.json.token}` };
  userId = reg.json.user.id;
  // The quota read (/api/cloud/summary) sits behind the email-verification
  // gate; the subscription read does not. Verified here so the cycle acts can
  // read the quota the way a real customer does.
  handle.db.emailVerification.markVerified(userId, Date.now());
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await handle?.close();
  for (const k of [
    'FLOWMIC_MODE', 'FLOWMIC_TRUSTED_PROXIES', 'FLOWMIC_CREEM_ENABLED', 'FLOWMIC_CREEM_ENV',
    'FLOWMIC_CREEM_WEBHOOK_SECRET', 'FLOWMIC_CREEM_API_KEY', 'FLOWMIC_CREEM_WRITE_ENABLED',
    'FLOWMIC_CREEM_PRODUCT_TIERS', 'FLOWMIC_CREEM_SUBSCRIPTIONS_ON_SALE',
    'FLOWMIC_CREEM_SUBSCRIBE_SUCCESS_URL', 'FLOWMIC_DB_PATH',
    'FLOWMIC_JWT_SECRET', 'FLOWMIC_SETTINGS_SECRET', 'FLOWMIC_PORT',
  ]) {
    delete process.env[k];
  }
});

describe('subscribe → paid → cancel → ended, over the wired stack', () => {
  it('runs the whole way, and each act is a different sentence to the customer', async () => {
    // ── ① before anything: free, and nothing is scheduled ──────────────────
    // Registered on 2026-06-01, so every subscription boundary below (starting
    // and ending on the 4th) is later than registration and is what the cycle
    // follows.
    backdateRegistration(userId, '2026-06-01');
    const before = await plan();
    expect(before.plan).toBe('free');
    expect(before.state).toBe('none');

    // ── ② buy ──────────────────────────────────────────────────────────────
    const buy = await req('POST', '/api/cloud/billing/subscribe', bearer, { tier: 'pro' });
    expect(buy.status, `subscribe failed: ${JSON.stringify(buy.json)}`).toBe(200);
    expect(buy.json.checkout_url).toBe('https://pay.creem.test/c/e2e');
    const checkoutCall = sent.find((s) => s.url.includes('/v1/checkouts'));
    expect(checkoutCall, 'no checkout was created at the provider').toBeTruthy();
    expect(checkoutCall!.body.product_id).toBe(PRO);
    // 🔴 The buyer's id rode along. Without it the payment below would land
    // `unmapped` and this account would stay free while the card was charged.
    expect(checkoutCall!.body.metadata[CREEM_USER_ID_KEY]).toBe(userId);

    // ⚠️ AND NOTHING WAS RECORDED YET. A checkout is not a subscription.
    expect((await plan()).plan).toBe('free');

    // ── ③ the money arrives, as a signed webhook ───────────────────────────
    const paid = await webhook(subscriptionEvent('subscription.active'));
    expect(paid.status, `webhook rejected: ${JSON.stringify(paid.json)}`).toBe(200);

    const active = await plan();
    expect(active.plan).toBe('pro');
    expect(active.state).toBe('active');
    expect(active.expires_at).toBe(PERIOD_END_FUTURE);
    expect(active.scheduled_change).toBeNull();
    // The row names the provider that holds it — what tells the cancel route
    // which client to speak to.
    expect(active.billing_provider).toBe('creem');

    // ── ④ 🔴 a second subscription is refused over the WIRED stack ─────────
    // The unit suite proves the rule; this proves the rule is actually reached
    // by a request arriving at the real server with a real plan behind it.
    const again = await req('POST', '/api/cloud/billing/subscribe', bearer, { tier: 'max' });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe(SUB_ALREADY_ACTIVE);
    expect(sent.filter((s) => s.url.includes('/v1/checkouts'))).toHaveLength(1);

    // ── ④b Pro → Max, in place ─────────────────────────────────────────────
    // A switch is one call to the provider, then the provider's own statement
    // of the new product arrives over the webhook. The route must not write.
    const up = await req('POST', '/api/cloud/billing/change-plan', bearer, { tier: 'max' });
    expect(up.status, `change-plan failed: ${JSON.stringify(up.json)}`).toBe(200);
    const upCall = sent.find((s) => s.url.includes(`/v1/subscriptions/${SUB_ID}/upgrade`));
    expect(upCall, 'the plan change never reached the provider').toBeTruthy();
    expect(upCall!.body.product_id).toBe(MAX);
    expect(upCall!.body.update_behavior).toBe('proration-charge-immediately');
    // Still pro locally until the provider says otherwise…
    expect((await plan()).plan).toBe('pro');
    // …and then it does.
    const moved = await webhook(subscriptionEvent('subscription.update', { product: { id: MAX, billing_period: 'every-month' } }));
    expect(moved.status).toBe(200);
    const onMax = await plan();
    expect(onMax.plan).toBe('max');
    expect(onMax.state).toBe('active');

    // ── ⑤ the customer cancels, themselves, from the console ───────────────
    const cancel = await req('POST', '/api/cloud/billing/cancel', bearer);
    expect(cancel.status, `cancel failed: ${JSON.stringify(cancel.json)}`).toBe(200);
    const cancelCall = sent.find((s) => s.url.includes(`/v1/subscriptions/${SUB_ID}/cancel`));
    expect(cancelCall, 'the cancellation never reached the provider').toBeTruthy();
    // 🔴 NEVER 「immediately」 from this route: the period is paid for and the
    // customer keeps it. Cancelling immediately would take the service away and
    // keep the money.
    expect(cancelCall!.body.mode).not.toBe('immediately');

    // ── ⑥ scheduled ≠ over. THE R11 CASE THIS WHOLE FIELD EXISTS FOR ───────
    // Creem reports a booked cancellation as its own STATUS. The service is
    // still running and still paid for; a console that renders 「cancelled」 here
    // makes a paying customer stop using what they bought.
    const sched = await webhook(subscriptionEvent('subscription.scheduled_cancel', { status: 'scheduled_cancel' }));
    expect(sched.status).toBe(200);
    const scheduled = await plan();
    expect(scheduled.plan).toBe('pro');
    expect(scheduled.state).toBe('active');
    expect(scheduled.scheduled_change).toEqual({ action: 'cancel', effective_at: PERIOD_END_FUTURE });

    // ── ⑦ and it really does end ───────────────────────────────────────────
    // A terminal status whose period has passed stops granting. This is the
    // 2026-09-02 P0-2 direction: without it a cancelled subscription keeps its
    // paid tier forever.
    const ended = await webhook(
      subscriptionEvent('subscription.canceled', {
        status: 'canceled',
        current_period_end_date: PAST,
        canceled_at: PAST,
      }),
    );
    expect(ended.status).toBe(200);
    const over = await plan();
    expect(over.plan).toBe('free');
    expect(over.state).toBe('expired');
    // 🔴 Still 'creem' after the end — 「came from that subscription, now over」
    // is what somebody reconciling against the provider's dashboard needs.
    expect(over.billing_provider).toBe('creem');

    // ── ⑦b 🔴 the Free cycle after a paid one starts the day the paid one ended
    // (owner 2026-09-05, option 乙). The motivating defect: a Pro month's spend
    // used to follow the person into Free and lock them out until the 1st.
    // Here the paid period ended at PAST (2026-08-04): the cycle key is that day
    // (or a later anniversary of it), never the calendar month, and the bucket
    // the paid cycle wrote to is not the bucket Free reads from.
    {
      const q = await req('GET', '/api/cloud/summary', bearer);
      expect(q.status).toBe(200);
      const period = q.json.quota.period as { start: string; end: string };
      expect(period.start.slice(8)).toBe('04'); // an anniversary of the 4th, not the 1st
      expect(period.start >= PAST.slice(0, 10)).toBe(true);
      // Seed the PAID cycle's bucket (keyed by the subscription's start, 2026-08-04
      // ... its anniversaries) with spend, then read the current quota: it must
      // NOT count, because the current cycle is a different bucket.
      handle.db.usage.increment(userId, '2026-01-01', { stt_minutes: 500 });
      const again = await req('GET', '/api/cloud/summary', bearer);
      expect(again.json.quota.stt.used_min).toBe(0);
      expect(again.json.quota.month).toBe(period.start);
    }

    // ── ⑧ and buying again is allowed: this is the way back ────────────────
    const back = await req('POST', '/api/cloud/billing/subscribe', bearer, { tier: 'pro' });
    expect(back.status, `re-subscribe refused: ${JSON.stringify(back.json)}`).toBe(200);
  });

  it('🔴 REVERSE CONTROL — an unsigned event changes nothing, and says so', async () => {
    // Without this the whole act above would prove only that our own code can
    // move a tier when we ask it to. What must be true is that ONLY Creem can.
    const bad = await webhook(subscriptionEvent('subscription.active'), { signature: 'deadbeef' });
    expect(bad.status).toBe(401);
    expect((await plan()).plan).toBe('free');
  });

  it('🔴 a payment that names nobody does NOT grant a tier to anybody', async () => {
    // The failure mode this pins is the one that costs a customer money in
    // silence: metadata missing, event verifies, row lands unmapped. What must
    // never happen is a tier appearing on some other account instead.
    const orphan = await webhook(subscriptionEvent('subscription.active', { metadata: {} }));
    expect(orphan.status).toBe(200);
    expect((await plan()).plan).toBe('free');
  });

  it('an unknown product is recorded but grants nothing — the tier table is the only authority', async () => {
    // A product we did not configure is not a licence to guess. The row exists
    // (money did move) and the tier does not (we cannot say which one).
    const unknown = await webhook(
      subscriptionEvent('subscription.active', { product: { id: 'prod_not_configured', billing_period: 'every-month' } }),
    );
    expect(unknown.status).toBe(200);
    expect((await plan()).plan).toBe('free');
  });
});

describe('the metering cycle follows the account (owner 2026-09-05, option 乙)', () => {
  it('🔴 a subscription re-anchors the cycle to its own start — no second allowance on the 1st', async () => {
    // Before anything: the cycle is anchored to registration — backdated to the
    // 1st of a month long ago, so its anniversaries fall on the 1st.
    backdateRegistration(userId, '2026-03-01');
    const before = await req('GET', '/api/cloud/summary', bearer);
    expect(before.status).toBe(200);
    const regPeriod = before.json.quota.period as { start: string; end: string };
    expect(regPeriod.start.slice(8)).toBe('01');

    // A subscription that STARTED on the 25th of last month, still active.
    const now = new Date();
    const started = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 25)).toISOString();
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 25)).toISOString();
    const paid = await webhook(
      subscriptionEvent('subscription.active', { created_at: started, current_period_end_date: periodEnd, next_transaction_date: periodEnd }),
    );
    expect(paid.status).toBe(200);

    const after = await req('GET', '/api/cloud/summary', bearer);
    const subPeriod = after.json.quota.period as { start: string; end: string };
    // Anchored to the 25th now — the provider's billing anniversary — and the
    // registration-day cycle is gone. On the 1st nothing resets.
    expect(subPeriod.start.slice(8)).toBe('25');
    expect(subPeriod.start).not.toBe(regPeriod.start);
    expect(after.json.quota.month).toBe(subPeriod.start);
  });
});

describe('the selling switch', () => {
  it('🔴 DEFAULTS TO OFF — a configured tier table is not a decision to sell', async () => {
    // Rebooted without the switch, everything else identical: Creem on, writes
    // on, both products mapped. This is the state a deployment lands in when
    // somebody configures the mapping (which the WEBHOOK needs) and nobody has
    // yet decided to open the doors.
    await handle.close();
    delete process.env.FLOWMIC_CREEM_SUBSCRIPTIONS_ON_SALE;
    handle = await startServer(loadConfig());
    base = `http://127.0.0.1:${handle.port}`;
    const reg = await req('POST', '/api/register', { 'content-type': 'application/json' }, {
      email: 'closed@flowmic.test',
      password: 'longenough1',
      display_name: 'Closed',
    });
    expect(reg.status).toBe(201);
    const b = { authorization: `Bearer ${reg.json.token}` };

    const offer = await req('GET', '/api/cloud/billing/subscribe', b);
    expect(offer.status).toBe(200);
    expect(offer.json.purchasable).toEqual([]);

    const buy = await req('POST', '/api/cloud/billing/subscribe', b, { tier: 'pro' });
    expect(buy.status).toBe(503);
    expect(buy.json.error).toBe('SUBSCRIPTION_NOT_AVAILABLE');
    // 🔴 AND NOTHING WAS ASKED OF THE PROVIDER. A switch that refuses only after
    // creating the checkout has still handed out a URL that charges people.
    expect(sent.filter((s) => s.url.includes('/v1/checkouts'))).toHaveLength(0);
  });

  it('⚠️ …while the WEBHOOK still grants a tier — the two are different questions', async () => {
    // Somebody who bought while selling was open must not lose their plan the
    // day we pause new sales. Same reboot as above, then a payment arrives.
    await handle.close();
    delete process.env.FLOWMIC_CREEM_SUBSCRIPTIONS_ON_SALE;
    handle = await startServer(loadConfig());
    base = `http://127.0.0.1:${handle.port}`;
    const reg = await req('POST', '/api/register', { 'content-type': 'application/json' }, {
      email: 'existing@flowmic.test',
      password: 'longenough1',
      display_name: 'Existing',
    });
    expect(reg.status).toBe(201);
    bearer = { authorization: `Bearer ${reg.json.token}` };
    userId = reg.json.user.id;

    const paid = await webhook(subscriptionEvent('subscription.active'));
    expect(paid.status).toBe(200);
    expect((await plan()).plan).toBe('pro');
  });
});
