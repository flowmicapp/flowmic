// 0.3.25 B2 — POST /api/cloud/billing/{cancel,resume}, the subscription controls.
//
// SPEC-REF: docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md
//           §2.2 US-3/US-4 (ROSCA: a simple mechanism to stop recurring charges),
//           §3.3 (the gate ruling), §4 B2
//
// It drives `tryHandleBillingRoutes` directly over a real http server, with real
// repos, a real AuthService and a real Bearer — the shape billing-events-route
// uses and for its reason: what is proven is THESE routes' behaviour.
//
// 🔴 WHAT THIS FILE CANNOT PROVE, SAID FIRST SO NOBODY READS ITS GREEN AS MORE
// THAN IT IS. Every case below drives a FAKE Paddle client. That fake is a fake
// of a boundary WE DO NOT OWN, so these tests are exactly as true as our reading
// of Paddle's documentation — and this repo has paid for that mistake already
// (0.2.48 L9: fifteen adapter tests, all green, all driving a FakeWs that
// answered the way we had assumed, while the real vendor did not). A sandbox run
// against the real API is SEPARATE evidence and nothing here substitutes for it.
// What these cases do prove is the half that is ours: which gates apply, what we
// send, and what we say when the answer is not a success.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { BillingService } from '../src/billing/billing-service';
import {
  PaddleWritesDisabledError,
  type PaddleClient,
  type PaddleSubscriptionSnapshot,
  type PaddleWriteResult,
} from '../src/billing/paddle/client';
import type { CancellationMailInput, SubscriptionMailer } from '../src/mail/subscription-mailer';
import { tryHandleBillingRoutes, type BillingRoutesDeps } from '../src/http/billing-routes';

const SECRET = 'billing-routes-secret-32-bytes-min-xx';
const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const PERIOD_END = '2026-09-01T00:00:00.000Z';

let db: DbConnection;
let auth: AuthService;
let server: Server;
let url: string;

/** What the fake client was asked to do — the ONLY way to assert 「we sent
 *  `next_billing_period` and never `immediately`」, which is not observable from
 *  the response body. */
let calls: { op: string; id: string; arg?: string }[];
let mailed: CancellationMailInput[];
let mailRejects: boolean;

function snapshot(over: Partial<PaddleSubscriptionSnapshot> = {}): PaddleSubscriptionSnapshot {
  return {
    id: 'sub_test',
    status: 'active',
    scheduled_change: { action: 'cancel', effective_at: PERIOD_END },
    next_billed_at: null,
    ...over,
  };
}

type ClientBehaviour = 'ok' | 'disabled' | 'unreachable' | 'rejected';

function fakeClient(behaviour: ClientBehaviour): PaddleClient {
  const answer = (op: string, id: string, arg?: string): Promise<PaddleWriteResult<PaddleSubscriptionSnapshot>> => {
    calls.push(arg === undefined ? { op, id } : { op, id, arg });
    if (behaviour === 'disabled') throw new PaddleWritesDisabledError(op);
    if (behaviour === 'unreachable') {
      return Promise.resolve({ ok: false, code: 'PADDLE_UNREACHABLE', detail: 'TimeoutError' });
    }
    if (behaviour === 'rejected') {
      return Promise.resolve({ ok: false, code: 'PADDLE_REJECTED', detail: 'http 400 / subscription_locked' });
    }
    return Promise.resolve({
      ok: true,
      data: op === 'clearScheduledChange' ? snapshot({ scheduled_change: null, next_billed_at: PERIOD_END }) : snapshot(),
    });
  };
  return {
    cancelSubscription: (id, effectiveFrom) => answer('cancelSubscription', id, effectiveFrom),
    clearScheduledChange: (id) => answer('clearScheduledChange', id),
    getSubscription: (id) => answer('getSubscription', id),
    // B2's routes never refund. Present because the interface requires it, and
    // it THROWS rather than resolving: if a future edit to /cancel or /resume
    // ever reaches for a refund, this test file fails loudly instead of quietly
    // agreeing. A friendly stub here would be the 13 §7 F1 ② shape in a fixture.
    createRefund: () => {
      throw new Error('createRefund must not be reachable from the B2 cancel/resume routes');
    },
    findRefundableTransaction: () => {
      throw new Error('findRefundableTransaction must not be reachable from the B2 cancel/resume routes');
    },
  };
}

/** Records what it was asked to send. Rejects on demand — the case that proves a
 *  mail outage does not become a failed cancellation. */
const mailer: SubscriptionMailer = {
  id: 'test',
  sendCancellationConfirmed(input) {
    mailed.push(input);
    return mailRejects ? Promise.reject(new Error('mail down')) : Promise.resolve();
  },
  // B2 must never send this one. It throws rather than recording, so a future
  // edit that reaches for the withdrawal acknowledgement from /cancel fails
  // loudly here instead of quietly passing.
  sendWithdrawalAcknowledged() {
    throw new Error('sendWithdrawalAcknowledged must not be reachable from the B2 cancel/resume routes');
  },
};

function makeDeps(behaviour: ClientBehaviour): BillingRoutesDeps {
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => NOW });
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
    paddle: fakeClient(behaviour),
    mailer,
    refunds: db.billing,
  };
}

async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'T' });
  return { id: user.id, bearer: { authorization: `Bearer ${auth.issueToken(user).token}` } };
}

/** A real `paddle_subscriptions` row, written through the repo the webhook uses
 *  — not by direct SQL, so the row under test is the shape production holds. */
function subscribe(userId: string, over: Record<string, unknown> = {}): void {
  db.billing.upsertSubscription({
    subscription_id: 'sub_test',
    user_id: userId,
    customer_id: 'ctm_test',
    status: 'active',
    tier: 'pro',
    price_id: 'pri_pro_monthly',
    cycle: 'monthly',
    current_period_end: PERIOD_END,
    canceled_at: null,
    scheduled_change_action: null,
    scheduled_change_at: null,
    next_billed_at: PERIOD_END,
    contract_concluded_at: '2026-07-25T00:00:00.000Z',
    last_event_id: 'evt_1',
    last_occurred_at: '2026-07-25T00:00:00.000Z',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
    ...over,
  });
}

async function post(path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function boot(behaviour: ClientBehaviour): void {
  const deps = makeDeps(behaviour);
  server = createServer((req, res) => {
    if (!tryHandleBillingRoutes(req, res, deps)) {
      res.writeHead(404).end('{}');
    }
  });
  server.listen(0);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  calls = [];
  mailed = [];
  mailRejects = false;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

describe('POST /api/cloud/billing/cancel', () => {
  it('schedules the cancellation, confirms by mail, and says it settles via webhook', async () => {
    boot('ok');
    const a = await account('cancel@b.co');
    subscribe(a.id);

    const r = await post('/api/cloud/billing/cancel', a.bearer);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      paddle_status: 'active',
      scheduled_change: { action: 'cancel', effective_at: PERIOD_END },
      // 🔴 The console will refetch immediately and see the OLD local row,
      // because the webhook has not arrived yet. Without this field that reads
      // as 「it did not work」 and the user cancels again, or calls their bank.
      settles_via_webhook: true,
    });
    expect(mailed).toEqual([{ to: 'cancel@b.co', endsAt: PERIOD_END }]);
  });

  // 🔴 THE ONE THAT COSTS MONEY IF IT REGRESSES. Cancelling `immediately` at
  // Paddle does NOT refund the unused part of the period, so a cancel that used
  // it would take the service away and keep the money — from a user who has
  // already paid to the end of the month. The immediate path exists only in the
  // statutory-withdrawal flow (B3), paired with a refund.
  it('🔴 always cancels at the END of the period, never immediately', async () => {
    boot('ok');
    const a = await account('period@b.co');
    subscribe(a.id);
    await post('/api/cloud/billing/cancel', a.bearer);
    expect(calls).toEqual([{ op: 'cancelSubscription', id: 'sub_test', arg: 'next_billing_period' }]);
  });

  // 🔴🔴 THE GATE EXEMPTION, MEASURED — the reason this file exists.
  //
  // ROSCA §8403(3) requires a simple mechanism to stop recurring charges. An
  // account that is restricted, or whose mailbox has stopped working, is STILL
  // BEING CHARGED every month; if either gate applied here, the exit would be
  // unreachable for exactly the people most likely to want it. Every other
  // /api/cloud/* route refuses both of these accounts.
  //
  // ⚠️ It is asserted through the ROUTE, not by reading the source for an absent
  // call: 「the gate is not called」 and 「a gated account gets through」 are
  // different claims, and only the second one is the product behaviour.
  it('🔴 a RESTRICTED account with an UNVERIFIED email can still stop the charges', async () => {
    boot('ok');
    const a = await account('restricted@b.co');
    subscribe(a.id);
    // Restriction goes through the repo method the ops route uses — the ONLY
    // writer of that column — rather than by UPDATE, so the flag under test is
    // the real one.
    db.users.setRestricted(a.id, NOW, 'abuse');

    // 🔴 POSITIVE CONTROL, and this test is worthless without it: prove the
    // account really IS in both gated states before asserting it got through.
    // Otherwise a green here could just mean 「neither gate was ever armed」.
    expect(db.users.findById(a.id)?.restricted_at).toBe(NOW);
    expect(db.emailVerification.emailVerifiedAt(a.id)).toBeNull();

    const r = await post('/api/cloud/billing/cancel', a.bearer);
    expect(r.status).toBe(200);
    expect(calls[0]?.op).toBe('cancelSubscription');
  });

  it('anonymous is refused by name, and nothing is sent to Paddle', async () => {
    boot('ok');
    const r = await post('/api/cloud/billing/cancel');
    expect(r.status).toBe(401);
    // The positive half: identity is NOT exempt, only the two product gates are.
    expect(calls).toEqual([]);
  });

  it('an account with no subscription gets a named 409, not a 404', async () => {
    boot('ok');
    const a = await account('nosub@b.co');
    const r = await post('/api/cloud/billing/cancel', a.bearer);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('BILLING_NO_SUBSCRIPTION');
    expect(calls).toEqual([]);
  });

  // 🔴 The cancellation HAPPENED. Turning a mail outage into a 502 would tell
  // the user it did not, and send them to do it again or to their bank.
  it('🔴 a mail failure does NOT become a failed cancellation', async () => {
    boot('ok');
    mailRejects = true;
    const a = await account('nomail@b.co');
    subscribe(a.id);
    const r = await post('/api/cloud/billing/cancel', a.bearer);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(mailed).toHaveLength(1); // it was attempted, and the failure is logged by name
  });
});

describe('the two failure directions are not the same answer', () => {
  it('🔴 writes switched off → 503 by its own name, never a fake success', async () => {
    boot('disabled');
    const a = await account('off@b.co');
    subscribe(a.id);
    const r = await post('/api/cloud/billing/cancel', a.bearer);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('BILLING_WRITE_DISABLED');
    // 🔴 And no confirmation email. A receipt for a cancellation that did not
    // happen is worse than no receipt: the user stops watching their statement.
    expect(mailed).toEqual([]);
  });

  it('🔴 could not reach Paddle → 502 UNREACHABLE, a DIFFERENT code from a refusal', async () => {
    boot('unreachable');
    const a = await account('down@b.co');
    subscribe(a.id);
    const r = await post('/api/cloud/billing/cancel', a.bearer);
    expect(r.status).toBe(502);
    // The distinction is the whole point: a timeout may have landed AFTER Paddle
    // committed, so this one means 「we do not know」 and the console must not
    // render it as 「nothing happened」. A rejection means Paddle decided.
    expect(r.json.error).toBe('BILLING_PADDLE_UNREACHABLE');
    expect(mailed).toEqual([]);
  });

  it('Paddle refused → 502 REJECTED, carrying its code and not its prose', async () => {
    boot('rejected');
    const a = await account('refused@b.co');
    subscribe(a.id);
    const r = await post('/api/cloud/billing/cancel', a.bearer);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe('BILLING_PADDLE_REJECTED');
    expect(r.json.detail).toContain('subscription_locked');
  });
});

describe('POST /api/cloud/billing/resume', () => {
  it('clears a scheduled cancellation', async () => {
    boot('ok');
    const a = await account('resume@b.co');
    subscribe(a.id, { scheduled_change_action: 'cancel', scheduled_change_at: PERIOD_END, next_billed_at: null });
    const r = await post('/api/cloud/billing/resume', a.bearer);
    expect(r.status).toBe(200);
    expect(r.json.scheduled_change).toBeNull();
    expect(calls).toEqual([{ op: 'clearScheduledChange', id: 'sub_test' }]);
  });

  // ── 🔴 2026-08-21 — THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS WRONG ─
  //
  // It read: 「refuses when nothing is scheduled, instead of reporting a
  // restoration」, and pinned a 409 BILLING_NOTHING_SCHEDULED with zero calls to
  // Paddle. The reasoning in its comment was sound — a PATCH clearing a
  // scheduled_change that is not there is a no-op at Paddle, so sending it
  // anyway could let the console claim a restoration that never happened.
  //
  // The reasoning was sound and the VALUE IT READ WAS WRONG. That guard asked
  // OUR row, which is written by the webhook, which lands seconds after the
  // cancel — this very route's success body says so in `settles_via_webhook`.
  // So it fired precisely in the window it must not: cancel, notice the mistake,
  // click undo, refused. A user who cannot undo a cancellation calls their bank,
  // and a chargeback costs more than the subscription.
  //
  // 🔴 0.2.52's law, third instance in this repo: 「反向对照选错了方向，比没有反
  // 向对照更坏 —— 它不是漏掉一个缺陷，是把缺陷写成了验收标准」. This assertion
  // WAS the specification, and it would have gone red on the day someone fixed
  // the defect. What caught it was booting a real server and doing the two
  // things in sequence (test/billing-e2e-mock-paddle.test.ts) — no unit test
  // could, because each one asserts against a row its own fixture wrote.
  //
  // The 「success message for work that did not happen」 risk is real and is
  // answered where it belongs: in what we REPORT. The response carries Paddle's
  // own post-state, so the console renders a fact rather than an assumption.
  it('🔴 resume goes through even when OUR row has not caught up yet', async () => {
    boot('ok');
    const a = await account('nothing@b.co');
    subscribe(a.id); // live, no scheduled change recorded locally — the race
    const r = await post('/api/cloud/billing/resume', a.bearer);
    expect(r.status).toBe(200);
    // 🔴 It reached Paddle. A local precondition would show up here as an empty
    // call list, which is exactly what the old version of this test demanded.
    expect(calls.map((c) => c.op)).toContain('clearScheduledChange');
    // And what comes back is Paddle's post-state, not our guess about it.
    expect(r.json.scheduled_change).toBeNull();
  });
});
