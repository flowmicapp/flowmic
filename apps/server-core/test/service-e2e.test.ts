// THE WHOLE ONE-TIME SERVICE CHAIN, END TO END, OVER A REAL BOOTED SERVER.
//
// SPEC-REF: apps/server-core/src/http/service-purchase-routes.ts
//           apps/server-core/src/http/ops-purchase-routes.ts
//           apps/server-core/src/billing/creem/envelope.ts
//
// ── WHY THIS EXISTS ALONGSIDE THE FOUR UNIT SUITES ────────────────────────
//
// Each of those mounts ONE handler on a bare server and proves its logic. That
// is exactly the shape this repo has been burned by (book 13 §7 F1 ③: 「单测
// 全绿对『接线』零证明力」), and it is worth being precise about what was NOT
// covered by any of them before this file:
//
//   · that `servicePurchaseDeps` and the `opsPurchases` block are actually
//     reached by bootstrap under a realistic config — a missing mount gives 404
//     here and green everywhere else;
//   · that the consent stamps written at CHECKOUT survive the round trip
//     through provider metadata and land on the row the customer then reads.
//     The write and the read live in different files and neither test could see
//     the other half;
//   · that the operator's advance and the customer's list are looking at the
//     SAME row — the one place where 「we marked it delivered」 and 「my console
//     still says you will contact me」 could disagree.
//
// 🔴 WHAT IT STILL DOES NOT PROVE. Creem's own HTTP is stubbed here, so a green
// run is evidence about OUR chain and none about theirs. The honest phrase for
// this file's result is 「wired end to end against a stubbed provider」. What IS
// real about the provider was established by live probes and is recorded in
// docs/strategy/2026-08-29-creem-stage0-findings.md §2b.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { signCreemPayload } from '../src/billing/creem/signature';
import { makeAuthService } from '../src/auth/auth-service';
// 🔴 THE CONSTANT, NOT A LITERAL. What these two assertions are FOR is that the
// server names its wording version on the wire so a client showing a stale copy
// can tell — not that the version happens to be any particular string. A literal
// here would fail on every future bump for no reason, and the fix would be to
// edit a number in a test, which teaches nobody anything. The version itself is
// pinned deliberately, once, in guided-setup.test.ts.
import { GUIDED_SETUP_CONSENT_VERSION } from '../src/billing/guided-setup';

const WEBHOOK_SECRET = 'creem-e2e-webhook-secret';
/** 🔴 THE SIGNING KEY, AND IT IS NOT NECESSARILY FLOWMIC_JWT_SECRET.
 *  `identity.ts resolveStandaloneSecret` reads FLOWMIC_SETTINGS_SECRET FIRST and
 *  falls back to FLOWMIC_JWT_SECRET, and `config.secret` is what bootstrap turns
 *  into the JWT key. Setting the two to different values (as this file's first
 *  draft did) makes a hand-minted token verify against the wrong key and answer
 *  AUTH_TOKEN_INVALID — which reads as 「the operator is not an admin」 and sends
 *  you looking at the gate. One value, used for both, so there is nothing to
 *  get wrong. */
const SIGNING_SECRET = 'service-e2e-shared-secret-32-bytes-min';
const SERVICE_PRODUCT = 'prod_setup_e2e';

let handle: BootstrapHandle;
let base: string;
let bearer: Record<string, string>;
let adminBearer: Record<string, string>;
let userId: string;
/** Every outbound request the server made to Creem, so the test can assert on
 *  what we SENT rather than only on what we did with the reply. */
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
async function webhook(payload: unknown): Promise<{ status: number; json: any }> {
  const raw = JSON.stringify(payload);
  const res = await realFetch(`${base}/api/creem/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'creem-signature': signCreemPayload(raw, WEBHOOK_SECRET),
    },
    body: raw,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(async () => {
  realFetch = globalThis.fetch;
  sent = [];
  // Creem's HTTP, stubbed. Requests to our OWN server pass through untouched —
  // otherwise the stub would swallow the very calls this test is making.
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes('creem.io')) return realFetch(url as never, init as never);
    sent.push({ url: u, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
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
  process.env.FLOWMIC_CREEM_SERVICE_PRODUCT_ID = SERVICE_PRODUCT;
  process.env.FLOWMIC_DB_PATH = ':memory:';
  process.env.FLOWMIC_JWT_SECRET = SIGNING_SECRET;
  process.env.FLOWMIC_SETTINGS_SECRET = SIGNING_SECRET;
  process.env.FLOWMIC_PORT = '0';

  handle = await startServer(loadConfig());
  base = `http://127.0.0.1:${handle.port}`;

  const reg = await req('POST', '/api/register', { 'content-type': 'application/json' }, {
    email: 'buyer@flowmic.test',
    password: 'longenough1',
    display_name: 'Buyer',
  });
  expect(reg.status, `register failed: ${JSON.stringify(reg.json)}`).toBe(201);
  bearer = { authorization: `Bearer ${reg.json.token}` };
  userId = reg.json.user.id;

  // 🔴 THE OPERATOR IS INSERTED THROUGH THE REPO WITH `is_admin`, not
  // registered and then patched. `users.insert` is the only writer of that
  // column (there is deliberately no setter), which is the same route
  // billing-events-route.test.ts takes — so the flag the gate reads is the real
  // one rather than something a test invented alongside it.
  const opUser = handle.db.users.insert({
    id: 'u_admin_e2e',
    email: 'operator@flowmic.test',
    display_name: 'Op',
    is_admin: true,
  });
  // ⚠️ A SECOND AuthService over the SAME users repo and the SAME secret — not
  // a second source of truth. `BootstrapHandle` does not expose the server's
  // own, and the token this mints is verified by the server's instance because
  // both read the same signing key and the same row. If the secrets ever drifted
  // the operator assertions would 401, which is a loud failure rather than a
  // quiet pass.
  const issuer = makeAuthService({
    users: handle.db.users,
    jwtSecret: Buffer.from(SIGNING_SECRET, 'utf8'),
  });
  adminBearer = { authorization: `Bearer ${issuer.issueToken(opUser).token}` };
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await handle?.close();
  for (const k of [
    'FLOWMIC_MODE', 'FLOWMIC_TRUSTED_PROXIES', 'FLOWMIC_CREEM_ENABLED', 'FLOWMIC_CREEM_ENV',
    'FLOWMIC_CREEM_WEBHOOK_SECRET', 'FLOWMIC_CREEM_API_KEY', 'FLOWMIC_CREEM_WRITE_ENABLED',
    'FLOWMIC_CREEM_SERVICE_PRODUCT_ID', 'FLOWMIC_DB_PATH', 'FLOWMIC_JWT_SECRET',
    'FLOWMIC_SETTINGS_SECRET', 'FLOWMIC_PORT',
  ]) {
    delete process.env[k];
  }
});

/** A `checkout.completed` carrying a paid one-time order, shaped the way the
 *  live API returns one (findings §2b). `metadata` is what WE set at checkout. */
function checkoutCompleted(metadata: Record<string, string>) {
  return {
    id: 'evt_e2e_1',
    eventType: 'checkout.completed',
    created_at: Date.now(),
    object: {
      id: 'ch_e2e',
      object: 'checkout',
      status: 'completed',
      metadata,
      customer: { id: 'cus_e2e' },
      product: { id: SERVICE_PRODUCT },
      order: {
        id: 'ord_e2e_1',
        object: 'order',
        status: 'paid',
        amount: 20000,
        currency: 'USD',
        transaction: 'tran_e2e_1',
      },
    },
  };
}

describe('the whole chain, over a real server', () => {
  it('🔴 buy → pay → the customer sees it → the operator delivers it', async () => {
    // ── ① the buy route is MOUNTED and takes the consent ──────────────────
    const buy = await req('POST', '/api/cloud/billing/service-checkout', bearer, {
      early_start: true,
      waiver_ack: true,
    });
    expect(buy.status, JSON.stringify(buy.json)).toBe(200);
    expect(buy.json.checkout_url).toBe('https://pay.creem.test/c/e2e');
    expect(buy.json.terms_version).toBe(GUIDED_SETUP_CONSENT_VERSION);

    // What we actually SENT to Creem. 🔴 THE STAMPS ARE OURS, generated
    // server-side — a body field the buyer controls could not be evidence of
    // anything, and this is the assertion that says which it is.
    expect(sent).toHaveLength(1);
    const meta = sent[0]!.body.metadata as Record<string, string>;
    expect(meta.flowmic_user_id).toBe(userId);
    expect(meta.fm_consent_v).toBe(GUIDED_SETUP_CONSENT_VERSION);
    expect(typeof meta.fm_early_start_at).toBe('string');
    expect(typeof meta.fm_waiver_ack_at).toBe('string');

    // ── ② nothing is recorded yet. A checkout is not a purchase ───────────
    const before = await req('GET', '/api/cloud/billing/services', bearer);
    expect(before.status).toBe(200);
    expect(before.json.purchases).toEqual([]);

    // ── ③ the payment arrives, signed ────────────────────────────────────
    const hook = await webhook(checkoutCompleted(meta));
    expect(hook.status, JSON.stringify(hook.json)).toBe(200);

    // ── ④ the customer sees it, WITH the consent that round-tripped ───────
    const mine = await req('GET', '/api/cloud/billing/services', bearer);
    expect(mine.status).toBe(200);
    expect(mine.json.contact_business_days).toBe(3);
    expect(mine.json.max_session_hours).toBe(3);
    expect(mine.json.purchases).toHaveLength(1);
    const p = mine.json.purchases[0];
    expect(p.order_id).toBe('ord_e2e_1');
    expect(p.amount_minor).toBe(20000);
    expect(p.state).toBe('paid');
    expect(p.next_step).toBe('awaiting_contact');
    // 🔴 THE ROUND TRIP, PROVED. Written by one file at checkout, read by
    // another off the webhook, landing on the row a third renders.
    expect(p.consent.terms_version).toBe(GUIDED_SETUP_CONSENT_VERSION);
    expect(p.consent.early_start_at).toBe(meta.fm_early_start_at);
    expect(p.consent.waiver_ack_at).toBe(meta.fm_waiver_ack_at);

    // ── ⑤ the operator queue is mounted and shows it ──────────────────────
    const queue = await req('GET', '/api/ops/purchases', adminBearer);
    expect(queue.status, JSON.stringify(queue.json)).toBe(200);
    expect(queue.json.purchases).toHaveLength(1);
    expect(queue.json.purchases[0].user_id).toBe(userId);
    // The operator surface never carries an email.
    expect(JSON.stringify(queue.json)).not.toContain('@');

    // ── ⑥ the operator books it, then delivers it ────────────────────────
    const booked = await req('POST', '/api/ops/purchases/advance', adminBearer, {
      order_id: 'ord_e2e_1',
      state: 'scheduled',
      note: 'booked for Tuesday 10:00',
    });
    expect(booked.status, JSON.stringify(booked.json)).toBe(200);
    expect(booked.json.changed).toBe(true);

    // 🔴 THE ASSERTION THIS WHOLE FILE EXISTS FOR. The operator marked it; the
    // CUSTOMER'S OWN read must stop saying 「we will contact you」. Before this
    // chain was wired, every purchase sat at 'paid' forever and that sentence
    // was still on the screen a month after the session.
    const after = await req('GET', '/api/cloud/billing/services', bearer);
    expect(after.json.purchases[0].state).toBe('scheduled');
    expect(after.json.purchases[0].next_step).toBe('scheduled');
    expect(after.json.purchases[0].scheduled_at).not.toBeNull();

    // gs-5: the session begins. The buyer's console says so, and the withdraw
    // button is STILL there — a setup that has started is not complete.
    const started = await req('POST', '/api/ops/purchases/advance', adminBearer, {
      order_id: 'ord_e2e_1',
      state: 'in_progress',
      note: 'on the call now',
    });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const underway = await req('GET', '/api/cloud/billing/services', bearer);
    expect(underway.json.purchases[0].state).toBe('in_progress');
    expect(underway.json.purchases[0].next_step).toBe('in_progress');
    expect(underway.json.purchases[0].started_at).not.toBeNull();
    expect(underway.json.purchases[0].refund_window.open).toBe(true);

    const done = await req('POST', '/api/ops/purchases/advance', adminBearer, {
      order_id: 'ord_e2e_1',
      state: 'delivered',
      note: 'session done, 95 minutes',
    });
    expect(done.status).toBe(200);
    const final = await req('GET', '/api/cloud/billing/services', bearer);
    // Just delivered ⇒ inside the two weeks of support, with a date it ends.
    expect(final.json.purchases[0].next_step).toBe('support');
    expect(final.json.purchases[0].support_until).not.toBeNull();
    // 🔴 THE gs-5 ASSERTION OVER THE REAL CHAIN: confirmed completion closes
    // the refund on the customer's own read, and the write behind the button
    // refuses too — both halves, or a console could still offer a button the
    // server would 409.
    expect(final.json.purchases[0].refund_window).toEqual({ open: false, reason: 'completed', closes_at: null });
    const late = await req('POST', '/api/cloud/billing/service-withdraw', bearer, { order_id: 'ord_e2e_1' });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe('SERVICE_NOT_REFUNDABLE');
    // The booking and start times survived the move to delivered — three facts, all kept.
    expect(final.json.purchases[0].scheduled_at).not.toBeNull();
    expect(final.json.purchases[0].started_at).not.toBeNull();
    expect(final.json.purchases[0].delivered_at).not.toBeNull();
    // And the list carries no `dispute_days` any more (gs-5 has no such period).
    expect(final.json).not.toHaveProperty('dispute_days');
    expect(final.json.aftercare_days).toBe(14);
  });

  it('🔴 a redelivered webhook does not double-record or move a delivered row', async () => {
    // Creem retries a completed checkout five times over 24h, so this is the
    // NORMAL path and not an edge case.
    const buy = await req('POST', '/api/cloud/billing/service-checkout', bearer, {
      early_start: true, waiver_ack: true,
    });
    const meta = sent[0]!.body.metadata as Record<string, string>;
    expect(buy.status).toBe(200);
    await webhook(checkoutCompleted(meta));
    await req('POST', '/api/ops/purchases/advance', adminBearer, {
      order_id: 'ord_e2e_1', state: 'delivered', note: 'done',
    });

    // The same event again, byte-identical.
    const again = await webhook(checkoutCompleted(meta));
    expect(again.status).toBe(200);

    const mine = await req('GET', '/api/cloud/billing/services', bearer);
    expect(mine.json.purchases).toHaveLength(1);
    // 🔴 AND IT DID NOT WALK THE DELIVERY BACK. A redelivery that re-wrote the
    // row would reset a delivered session to 'paid' and start the customer's
    // 「we will contact you」 clock again, days after the session happened.
    expect(mine.json.purchases[0].state).toBe('delivered');
  });

  it('🔴 a purchase belongs to ONE account — the list is not cross-account', async () => {
    const buy = await req('POST', '/api/cloud/billing/service-checkout', bearer, {
      early_start: true, waiver_ack: true,
    });
    expect(buy.status).toBe(200);
    await webhook(checkoutCompleted(sent[0]!.body.metadata));

    const other = await req('POST', '/api/register', { 'content-type': 'application/json' }, {
      email: 'stranger@flowmic.test', password: 'longenough1', display_name: 'S',
    });
    const strangerBearer = { authorization: `Bearer ${other.json.token}` };
    const theirs = await req('GET', '/api/cloud/billing/services', strangerBearer);
    expect(theirs.status).toBe(200);
    expect(theirs.json.purchases).toEqual([]);
  });

  it('anonymous cannot buy, and a non-operator cannot see the queue', async () => {
    const anon = await req('POST', '/api/cloud/billing/service-checkout', {}, {
      early_start: true, waiver_ack: true,
    });
    expect(anon.status).toBe(401);
    // Nothing was sent to the provider on an unauthenticated attempt.
    expect(sent).toHaveLength(0);

    // A signed-in ordinary account is refused the operator queue by name.
    const queue = await req('GET', '/api/ops/purchases', bearer);
    expect(queue.status).toBe(403);
    expect(queue.json.error).toBe('ADMIN_ONLY');
  });

  it('half a consent is refused, and nothing reaches the provider', async () => {
    const half = await req('POST', '/api/cloud/billing/service-checkout', bearer, {
      early_start: true,
      waiver_ack: false,
    });
    expect(half.status).toBe(400);
    expect(half.json.error).toBe('SERVICE_CONSENT_REQUIRED');
    // 🔴 The refusal names the wording version, so a client that is showing
    // stale copy can tell.
    expect(half.json.terms_version).toBe(GUIDED_SETUP_CONSENT_VERSION);
    expect(sent).toHaveLength(0);
  });
});
