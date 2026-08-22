// 0.3.25 — END TO END over a REAL BOOTED SERVER, with the Paddle stand-in.
//
// SPEC-REF: docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md §5
//
// ── WHY THIS EXISTS ALONGSIDE THE ROUTE TESTS ───────────────────────────────
// billing-routes.test.ts and billing-withdrawal.test.ts each mount ONE handler
// on a bare http server. That proves the handler, and it is exactly the shape
// this repo has been burned by: 「单测全绿对『接线』零证明力」 (book 13 §7 F1 ③).
// The wiring between config, bootstrap, the router's mount conditions, the auth
// middleware and the repos is not exercised by either of them — and every defect
// this round fixed lived in wiring, not in logic.
//
// So this file boots `startServer` the way production does, over a real socket,
// and drives the console's own HTTP surface. What it adds over the route tests:
//   · the routes are actually MOUNTED (a `billingControls` block missing from
//     bootstrap-http-deps would give 404 here and green everywhere else);
//   · the Bearer goes through the real auth path;
//   · `GET /api/cloud/subscription` and the write routes read the same solver,
//     so 「what the console shows」 and 「what the server acts on」 are compared
//     rather than assumed.
//
// 🔴 AND WHAT IT STILL DOES NOT PROVE. `FLOWMIC_PADDLE_MOCK` is our reading of
// Paddle, typed in by us. Every rule it enforces — `immediately` refunds
// nothing, adjustments land `pending_approval`, a scheduled cancel leaves the
// status `active` — comes from their documentation and not from their servers.
// A green run here is evidence about OUR code and none about theirs. Nothing
// below may be reported as 「verified against Paddle」; the honest phrase is
// 「mock-verified end to end, real link unproven」.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

const CONCLUDED = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const PERIOD_END = new Date(Date.now() + 27 * 24 * 60 * 60 * 1000).toISOString();

let handle: BootstrapHandle;
let base: string;
let bearer: Record<string, string>;
let userId: string;

async function post(path: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function get(path: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** The plan read-out the console renders from. */
async function planView(): Promise<any> {
  const r = await get('/api/cloud/subscription', bearer);
  expect(r.status).toBe(200);
  return r.json.subscription;
}

beforeEach(async () => {
  // The two switches this round added, set the way a developer would to drive
  // the feature locally. `sandbox` matters: the mock REFUSES to stand in for
  // production, and that refusal is asserted at the bottom of this file.
  process.env.FLOWMIC_MODE = 'saas';
  // Booting saas for real turned up a gate the handler-level tests never see:
  // the process REFUSES to start without a declared proxy posture, because every
  // per-IP limiter would otherwise share one bucket behind nginx. It will not
  // take an empty value either — a string that parses to no IPs lands in the
  // same refusal, deliberately, so 「I set the variable」 cannot substitute for
  // 「I said what is in front of me」. This test server is reached directly, and
  // loopback is the truthful declaration.
  process.env.FLOWMIC_TRUSTED_PROXIES = '127.0.0.1,::1';
  process.env.FLOWMIC_PADDLE_MOCK = '1';
  process.env.FLOWMIC_PADDLE_WRITE_ENABLED = '1';
  process.env.FLOWMIC_PADDLE_ENV = 'sandbox';
  process.env.FLOWMIC_DB_PATH = ':memory:';
  process.env.FLOWMIC_JWT_SECRET = 'e2e-mock-paddle-secret-32-bytes-min-xx';
  process.env.FLOWMIC_SETTINGS_SECRET = 'e2e-mock-paddle-settings-secret-32-bytes';
  // 🔴 FLOWMIC_PORT, not PORT. The first draft set PORT, the server ignored it
  // and bound its default 3210, and the SECOND boot in this file then collided
  // with the first — which surfaced as 「fetch failed」 three tests later rather
  // than as 「your port setting did nothing」. Ephemeral (0) so parallel runs and
  // a developer's own server cannot fight over one number.
  process.env.FLOWMIC_PORT = '0';

  handle = await startServer(loadConfig());
  base = `http://127.0.0.1:${handle.port}`;

  const reg = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'e2e@flowmic.test', password: 'longenough1', display_name: 'E2E' }),
  });
  // Asserted rather than assumed: a registration that quietly fails would make
  // every case below die on `undefined.id`, which names the symptom and not the
  // cause. This says which request went wrong and what the server answered.
  const body = (await reg.json()) as { token: string; user: { id: string } };
  expect(reg.status, `register failed: ${JSON.stringify(body)}`).toBe(201);
  bearer = { authorization: `Bearer ${body.token}` };
  userId = body.user.id;

  // A subscription written the way the webhook writes one — the same repo call
  // handlePaddleWebhook makes, so the row under test is the shape production
  // holds rather than one assembled for the test.
  handle.db.billing.upsertSubscription({
    subscription_id: 'sub_e2e01',
    user_id: userId,
    customer_id: 'ctm_e2e01',
    status: 'active',
    tier: 'pro',
    price_id: 'pri_pro_monthly',
    cycle: 'monthly',
    current_period_end: PERIOD_END,
    canceled_at: null,
    scheduled_change_action: null,
    scheduled_change_at: null,
    next_billed_at: PERIOD_END,
    contract_concluded_at: CONCLUDED,
    last_event_id: 'evt_e2e01',
    last_occurred_at: CONCLUDED,
    created_at: CONCLUDED,
    updated_at: CONCLUDED,
  });
});

afterEach(async () => {
  await handle?.close();
  for (const k of [
    'FLOWMIC_MODE', 'FLOWMIC_PADDLE_MOCK', 'FLOWMIC_PADDLE_WRITE_ENABLED', 'FLOWMIC_PADDLE_ENV',
    'FLOWMIC_DB_PATH', 'FLOWMIC_JWT_SECRET', 'FLOWMIC_SETTINGS_SECRET', 'FLOWMIC_PORT', 'FLOWMIC_TRUSTED_PROXIES',
  ]) {
    delete process.env[k];
  }
});

describe('the console can read what it needs to render the page', () => {
  it('the plan read-out carries the four facts 0.3.25 added', async () => {
    const v = await planView();
    expect(v).toMatchObject({ plan: 'pro', source: 'paddle', state: 'active' });
    // 🔴 These four are what the console branches on. Before this round none of
    // them existed on the wire, and the page could not say when the next charge
    // was, whether the subscription would renew, or whether a legal right was
    // still exercisable.
    expect(v.next_billed_at).toBe(PERIOD_END);
    expect(v.scheduled_change).toBeNull();
    expect(v.contract_concluded_at).toBe(CONCLUDED);
    expect(typeof v.withdrawal_deadline).toBe('string');
  });
});

describe('cancel → resume, over the mounted routes', () => {
  it('🔴 a scheduled cancellation leaves the subscription ACTIVE and names the date', async () => {
    const out = await post('/api/cloud/billing/cancel', bearer);
    expect(out.status).toBe(200);
    // Paddle's answer, echoed as a receipt. `active` is not a bug: a
    // subscription scheduled to cancel at period end IS active until then, and
    // this is the fact the whole B1 store exists to carry.
    expect(out.json.paddle_status).toBe('active');
    expect(out.json.scheduled_change).toMatchObject({ action: 'cancel' });
    // And the response says the local row has not caught up yet, so a console
    // that refetches and sees the old state knows it is a race and not a failure.
    expect(out.json.settles_via_webhook).toBe(true);
  });

  it('resume clears it, and the two are reachable in sequence', async () => {
    await post('/api/cloud/billing/cancel', bearer);
    const out = await post('/api/cloud/billing/resume', bearer);
    expect(out.status).toBe(200);
    expect(out.json.scheduled_change).toBeNull();
  });
});

describe('🔴 withdrawal, end to end', () => {
  it('does both halves and reports them separately', async () => {
    const before = await planView();
    expect(before.withdrawal_deadline).not.toBeNull();

    const out = await post('/api/cloud/billing/withdraw', bearer);

    expect(out.status).toBe(200);
    // The service stopped...
    expect(out.json.paddle_status).toBe('canceled');
    // ...AND the money was asked for. One without the other is the failure this
    // round is built around: cancelling `immediately` at Paddle refunds nothing.
    expect(out.json.refund).toMatchObject({ state: 'submitted', paddle_status: 'pending_approval' });

    // The record exists, through the real repo, on the real database.
    const rows = handle.db.billing.listRefundRequests(userId, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'statutory_withdrawal', state: 'submitted' });
  });

  it('a second withdrawal finds the subscription already gone and says so, honestly', async () => {
    await post('/api/cloud/billing/withdraw', bearer);
    const again = await post('/api/cloud/billing/withdraw', bearer);
    // 🔴 NOT a silent 200. The subscription is cancelled at Paddle, so the
    // second cancel is refused there and we report a refusal rather than
    // pretending to do it twice — and, importantly, no SECOND refund is
    // requested, which would be us asking to return money twice.
    expect(again.status).toBe(502);
    expect(handle.db.billing.listRefundRequests(userId, 10)).toHaveLength(1);
  });
});

describe('the gate exemptions are real on a booted server, not just in a unit', () => {
  it('an account with an unverified email can still reach the stop-charging button', async () => {
    // Registration does not verify the mailbox, so this account IS unverified —
    // the state every other /api/cloud/* route refuses with 403 EMAIL_NOT_VERIFIED.
    const gated = await get('/api/cloud/summary', bearer);
    expect(gated.status).toBe(403);
    expect(gated.json.error).toBe('EMAIL_NOT_VERIFIED');

    // 🔴 The same Bearer, on the exit. ROSCA §8403(3) requires a simple mechanism
    // to stop recurring charges; an account whose mailbox stopped working is
    // still being charged every month. This is the assertion that the exemption
    // survives the real router rather than only the unit's hand-built one.
    const exit = await post('/api/cloud/billing/cancel', bearer);
    expect(exit.status).toBe(200);
  });
});

describe('🔴 the stand-in refuses to stand in for production', () => {
  it('mock + production env is a boot failure, not a quiet substitution', async () => {
    await handle.close();
    process.env.FLOWMIC_PADDLE_ENV = 'production';
    // A mock that silently replaced the real API on a production box would
    // report every cancellation as successful while cancelling nothing and every
    // refund as requested while refunding nothing — the worst failure of this
    // whole round, produced by the tool built to prevent it.
    await expect(startServer(loadConfig())).rejects.toThrow(/FLOWMIC_PADDLE_MOCK/);
    // Re-boot something for afterEach to close.
    process.env.FLOWMIC_PADDLE_ENV = 'sandbox';
    handle = await startServer(loadConfig());
  });
});
