// 0.3.25 B3 — POST /api/cloud/billing/withdraw, the EU statutory right of withdrawal.
//
// SPEC-REF: docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md
//           §2.1 EU-1/EU-2/EU-4, §3.3, §4 B3
//           Directive 2011/83/EU art. 9 (14 days), art. 11a (the function and the
//             acknowledgement), art. 13 (reimburse), art. 14(4)(a) (bear no cost)
//
// ── 🔴 IT DRIVES THE SHIPPED MOCK, NOT A FAKE WRITTEN IN THIS FILE ──────────
// `createMockPaddleClient` is the same stand-in the dev server runs behind
// FLOWMIC_PADDLE_MOCK. Using it here rather than a local hand-fake closes one
// specific hole: a test double authored next to the assertions agrees with the
// assertions by construction, and can drift from whatever the running process
// actually uses until the two describe different products. One stand-in, two
// consumers, so 「it passed the tests」 and 「I drove it by hand and watched it」
// are statements about the same object.
//
// 🔴 WHAT IT STILL CANNOT PROVE, said first: the mock is OUR READING of Paddle.
// Every rule it enforces — that `immediately` refunds nothing, that adjustments
// land `pending_approval` — is a sentence from their documentation that we typed
// in. Green here is evidence about our code and none at all about theirs. This
// repo has already paid for confusing the two (0.2.48 L9: fifteen green adapter
// tests driving a FakeWs that answered the way we had assumed).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { BillingService } from '../src/billing/billing-service';
import { createMockPaddleClient, type MockPaddleClient } from '../src/billing/paddle/mock-client';
import { WITHDRAWAL_WINDOW_DAYS } from '../src/billing/withdrawal';
import type { SubscriptionMailer, WithdrawalMailInput } from '../src/mail/subscription-mailer';
import { buildWithdrawalEmail } from '../src/mail/subscription-mailer';
import {
  BILLING_WITHDRAWAL_ALREADY_REQUESTED,
  BILLING_WITHDRAWAL_WINDOW_CLOSED,
  BILLING_WITHDRAWAL_WINDOW_UNKNOWN,
  BILLING_WRITE_DISABLED,
  tryHandleBillingRoutes,
  type BillingRoutesDeps,
} from '../src/http/billing-routes';
import { asPaddleSubscriptionWriter } from '../src/billing/paddle/subscription-writer-adapter';

const SECRET = 'billing-withdrawal-secret-32-bytes-min';
const DAY_MS = 24 * 60 * 60 * 1000;
/** The contract was concluded here; every `now` below is expressed as an offset
 *  from it, so the boundary cases read as 「day 13 / day 14 / day 15」. */
const CONCLUDED = '2026-08-01T00:00:00.000Z';
const CONCLUDED_MS = Date.parse(CONCLUDED);
const PERIOD_END = '2026-09-01T00:00:00.000Z';

let db: DbConnection;
let auth: AuthService;
let server: Server;
let url: string;
let paddle: MockPaddleClient;
let acknowledged: WithdrawalMailInput[];
let mailRejects: boolean;

const mailer: SubscriptionMailer = {
  id: 'test',
  sendCancellationConfirmed() {
    // A withdrawal is not a cancellation and must not send the cancellation
    // note: that mail says 「your access continues until X」, which is the
    // opposite of what just happened. Throwing pins that rather than trusting it.
    throw new Error('the cancellation confirmation must not be sent for a withdrawal');
  },
  sendWithdrawalAcknowledged(input) {
    acknowledged.push(input);
    return mailRejects ? Promise.reject(new Error('mail down')) : Promise.resolve();
  },
};

function boot(opts: { nowMs: number; writeEnabled?: boolean; seedSub?: boolean; distinctIds?: boolean }): void {
  paddle = createMockPaddleClient({
    writeEnabled: opts.writeEnabled ?? true,
    now: () => opts.nowMs,
    seed: opts.seedSub === false ? [] : [{ id: 'sub_test', periodEnd: PERIOD_END }],
  });
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => opts.nowMs });
  // `distinctIds`: the fixed 'rfd_fixed' id below is what every OTHER test in
  // this file wants (a stable, assertable id) — but two GENUINELY CONCURRENT
  // withdraw calls minting the SAME id would collide on `refund_requests`'
  // PRIMARY KEY, an artefact of this test harness never seen in production
  // (there `newId` is `randomUUID`-based). The race suites below opt in to a
  // counter instead, so a real double-call is distinguishable from a harness
  // collision.
  let seq = 0;
  const deps: BillingRoutesDeps = {
    auth,
    billing: new BillingService({
      settings: db.settings,
      users: db.users,
      usage: db.usage,
      billing: db.billing,
      unlockAll: false,
      now: () => opts.nowMs,
    }),
    writerFor: (p: string) => (p === 'paddle' ? asPaddleSubscriptionWriter(paddle) : null),
    mailer,
    refunds: db.billing,
    now: () => opts.nowMs,
    newId: opts.distinctIds === true ? () => `rfd_seq_${(seq += 1)}` : () => 'rfd_fixed',
  };
  server = createServer((req, res) => {
    if (!tryHandleBillingRoutes(req, res, deps)) res.writeHead(404).end('{}');
  });
  server.listen(0);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function account(email: string): Promise<Record<string, string>> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'T' });
  subscribe(user.id);
  return { authorization: `Bearer ${auth.issueToken(user).token}` };
}

/** Written through the repo the webhook writes through, so the row under test is
 *  the shape production holds. */
function subscribe(userId: string, over: Record<string, unknown> = {}): void {
  db.billing.upsertSubscription({
    subscription_id: 'sub_test',
    user_id: userId,
    provider: 'paddle',
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
    contract_concluded_at: CONCLUDED,
    last_event_id: 'evt_1',
    last_occurred_at: CONCLUDED,
    created_at: CONCLUDED,
    updated_at: CONCLUDED,
    ...over,
  });
}

async function withdraw(headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/api/cloud/billing/withdraw`, { method: 'POST', headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function ops(): string[] {
  return paddle.calls().map((c) => c.op);
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  acknowledged = [];
  mailRejects = false;
});

afterEach(() => {
  server?.close();
  db?.close();
});

describe('🔴 a withdrawal is TWO operations and the second one is the money', () => {
  it('cancels immediately AND requests the refund, and records both', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    const bearer = await account('a@flowmic.test');

    const out = await withdraw(bearer);

    expect(out.status).toBe(200);
    // 🔴 THE LOAD-BEARING ASSERTION OF THE WHOLE ROUND. Cancelling `immediately`
    // at Paddle refunds nothing, so a withdrawal that only cancels has taken the
    // service away and kept the payment. Both calls, or this is red.
    expect(ops()).toContain('cancelSubscription');
    expect(ops()).toContain('createRefund');
    // ...and the cancel really was immediate. `next_billing_period` here would
    // leave a withdrawn user being served (and, at period end, unrefunded).
    expect(paddle.calls().find((c) => c.op === 'cancelSubscription')?.arg).toBe('sub_test:immediately');
    // ORDER, not just presence: the refund is looked up and requested AFTER the
    // cancel. A refund issued before the service stops leaves a paid-off
    // subscription still running, which Paddle would then bill again.
    expect(ops().indexOf('cancelSubscription')).toBeLessThan(ops().indexOf('createRefund'));
    // And the stand-in agrees the subscription really is gone — asserted on its
    // state, not on our response body, so the claim is about what happened at
    // the far end rather than about what we said.
    expect(paddle.state()[0]!.status).toBe('canceled');
  });

  it('writes a refund_requests row carrying Paddle’s own word, not ours', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    const user = await auth.register({ email: 'b@flowmic.test', password: 'longenough1', display_name: 'T' });
    subscribe(user.id);
    const bearer = { authorization: `Bearer ${auth.issueToken(user).token}` };

    await withdraw(bearer);

    const rows = db.billing.listRefundRequests(user.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'statutory_withdrawal',
      state: 'submitted',
      // 🔴 `pending_approval`, carried verbatim from Paddle. The row must not
      // say anything stronger, because at this instant the money has NOT moved.
      paddle_status: 'pending_approval',
      amount_minor: 600,
      currency: 'USD',
    });
    expect(rows[0]!.paddle_adjustment_id).not.toBeNull();
  });

  it('the response reports the refund’s state separately from the cancellation’s', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    const bearer = await account('c@flowmic.test');
    const out = await withdraw(bearer);
    // One combined 「ok」 would let a failed refund hide behind a successful
    // cancel — which is the exact pair this route exists to keep together.
    expect(out.json.paddle_status).toBe('canceled');
    expect(out.json.refund).toMatchObject({ state: 'submitted', paddle_status: 'pending_approval' });
  });
});

describe('the fourteen days (CRD art. 9)', () => {
  it('day 13 is inside the window', async () => {
    boot({ nowMs: CONCLUDED_MS + 13 * DAY_MS });
    const bearer = await account('d@flowmic.test');
    expect((await withdraw(bearer)).status).toBe(200);
  });

  it('🔴 the last instant of day 14 is still inside — the boundary favours the consumer', async () => {
    boot({ nowMs: CONCLUDED_MS + WITHDRAWAL_WINDOW_DAYS * DAY_MS - 1 });
    const bearer = await account('e@flowmic.test');
    expect((await withdraw(bearer)).status).toBe(200);
  });

  it('the instant the deadline is reached, it is closed — and NOTHING is called', async () => {
    boot({ nowMs: CONCLUDED_MS + WITHDRAWAL_WINDOW_DAYS * DAY_MS });
    const bearer = await account('f@flowmic.test');
    const out = await withdraw(bearer);
    expect(out.status).toBe(409);
    expect(out.json.error).toBe(BILLING_WITHDRAWAL_WINDOW_CLOSED);
    // 🔴 A refused withdrawal must not have cancelled anything on its way to
    // saying no. Without this, a bug that cancels first and checks second would
    // pass every other case in this file.
    expect(ops()).toEqual([]);
  });

  it('🔴 no recorded start date is UNKNOWN, never CLOSED — we do not claim a right expired', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    const user = await auth.register({ email: 'g@flowmic.test', password: 'longenough1', display_name: 'T' });
    // A subscription from before contract_concluded_at existed.
    subscribe(user.id, { contract_concluded_at: null });
    const bearer = { authorization: `Bearer ${auth.issueToken(user).token}` };

    const out = await withdraw(bearer);
    expect(out.status).toBe(409);
    // The distinction IS the assertion: 「your period ended」 is a claim about
    // their rights that we cannot support, while 「we cannot determine it」 is a
    // fact about our records. Collapsing them would bury a person who may still
    // be inside their window.
    expect(out.json.error).toBe(BILLING_WITHDRAWAL_WINDOW_UNKNOWN);
    expect(out.json.error).not.toBe(BILLING_WITHDRAWAL_WINDOW_CLOSED);
    expect(ops()).toEqual([]);
  });
});

describe('the acknowledgement (CRD art. 11a: durable medium, without undue delay)', () => {
  it('is sent, and dates the day we RECEIVED the withdrawal', async () => {
    const now = CONCLUDED_MS + 3 * DAY_MS;
    boot({ nowMs: now });
    const bearer = await account('h@flowmic.test');
    await withdraw(bearer);

    expect(acknowledged).toHaveLength(1);
    // Not 「when this mail went out」: the acknowledgement is the user's proof of
    // the date they exercised the right, so a retry must not move it.
    expect(acknowledged[0]!.receivedAt).toBe(new Date(now).toISOString());
    expect(acknowledged[0]!.to).toBe('h@flowmic.test');
  });

  it('🔴 its words never claim the money has moved', () => {
    const mail = buildWithdrawalEmail({
      to: 'x@flowmic.test',
      receivedAt: '2026-08-04T00:00:00.000Z',
      subscriptionId: 'sub_test',
      refundState: 'submitted',
      amountMinor: 600,
      currency: 'USD',
    });
    // Asserted on the rendered body — the artefact the user keeps and can quote
    // back — rather than on a status field nobody reads. Paddle holds most
    // refunds for approval, so at this instant 「we have refunded」 would be a
    // statement they could check and find false.
    expect(mail.text).toContain('We have requested a refund of USD 6.00');
    expect(mail.text).not.toMatch(/we have refunded|has been refunded|your money has been returned/i);
    expect(mail.text).toContain('2026-08-04');
  });

  it('a mail outage does NOT undo the withdrawal (the subscription is already gone)', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    mailRejects = true;
    const user = await auth.register({ email: 'i@flowmic.test', password: 'longenough1', display_name: 'T' });
    subscribe(user.id);
    const bearer = { authorization: `Bearer ${auth.issueToken(user).token}` };

    const out = await withdraw(bearer);
    // 200: reporting a failure here would tell the user their withdrawal did not
    // work while their subscription is, in fact, cancelled. The duty is logged
    // as outstanding instead — recorded, not swallowed.
    expect(out.status).toBe(200);
    expect(db.billing.listRefundRequests(user.id, 10)).toHaveLength(1);
  });
});

describe('the refund half can fail on its own, and says so', () => {
  it('a subscription that was never charged is none_due, NOT failed', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    const user = await auth.register({ email: 'j@flowmic.test', password: 'longenough1', display_name: 'T' });
    subscribe(user.id);
    const bearer = { authorization: `Bearer ${auth.issueToken(user).token}` };
    // Make the lookup answer 「none」 the way a trial subscription would.
    const original = paddle.findRefundableTransaction.bind(paddle);
    (paddle as { findRefundableTransaction: unknown }).findRefundableTransaction = () =>
      Promise.resolve({ ok: true as const, data: { found: null } });

    const out = await withdraw(bearer);
    void original;

    expect(out.status).toBe(200);
    const row = db.billing.listRefundRequests(user.id, 10)[0]!;
    // Its own value: everything went right and there was nothing to give back.
    // Folding it into 'failed' would raise an alarm about a correct outcome.
    expect(row.state).toBe('none_due');
    expect(acknowledged[0]!.refundState).toBe('none_due');
  });

  it('🔴 a refund Paddle refuses is still a completed withdrawal, recorded as failed', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    const user = await auth.register({ email: 'k@flowmic.test', password: 'longenough1', display_name: 'T' });
    subscribe(user.id);
    const bearer = { authorization: `Bearer ${auth.issueToken(user).token}` };
    (paddle as { createRefund: unknown }).createRefund = () =>
      Promise.resolve({ ok: false as const, code: 'PADDLE_REJECTED' as const, detail: 'http 400 / already_refunded' });

    const out = await withdraw(bearer);

    // The cancellation already happened and cannot be put back, so this is NOT
    // an error response — a 502 here would tell the user their withdrawal failed
    // while their subscription is gone.
    expect(out.status).toBe(200);
    expect(out.json.refund.state).toBe('failed');
    const row = db.billing.listRefundRequests(user.id, 10)[0]!;
    expect(row.state).toBe('failed');
    // 🔴 THE NORMALISED CODE, not the vendor's. The recorded detail is our own
    // sentence, written in the one vocabulary billing-routes.ts is allowed to
    // branch on — see billing/subscription-writer.ts for why a route that knew
    // 'PADDLE_REJECTED' by name would silently mishandle every Creem failure.
    expect(row.detail).toContain('PROVIDER_REJECTED');
    // The user is still told, and the mail does not ask them to do anything.
    expect(acknowledged[0]!.refundState).toBe('failed');
  });
});

describe('the write switch', () => {
  it('off ⇒ named refusal, and nothing was cancelled', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS, writeEnabled: false });
    const bearer = await account('l@flowmic.test');
    const out = await withdraw(bearer);
    expect(out.status).toBe(503);
    expect(out.json.error).toBe(BILLING_WRITE_DISABLED);
    expect(paddle.state()[0]!.status).toBe('active');
    expect(acknowledged).toHaveLength(0);
  });
});

// 2026-09-02 (audit F4) — 🔴 「double click relies on Paddle rejecting」 was the
// finding: nothing local stopped two withdraw requests a moment apart from both
// reading the subscription as 'active' and both calling the provider, and the
// ONLY thing standing between that and a duplicate cancellation/refund was the
// mock's OWN "already canceled" refusal — a courtesy the real Paddle API is not
// guaranteed to give at the exact instant two requests race it. This suite
// removes that courtesy on purpose (a bypassed mock, not a weaker one) so the
// LOCAL claim is what is actually under test, not Paddle's behaviour.
describe('🔴 F4 — the local claim, not Paddle, stops a genuine concurrent double-click', () => {
  /** A real network call takes many event-loop turns; `Promise.resolve()` takes
   *  none. Without an artificial delay here, two `fetch()` calls to a LOCAL
   *  server would never actually interleave — Node runs each request's fully
   *  synchronous prefix (auth → getPlan → window check → the claim itself) to
   *  completion before the next connection's 'request' event is even
   *  dispatched, and the race this suite exists to prove would never occur in
   *  the test even if the fix were absent. The delay is what makes this test
   *  capable of failing at all.
   *
   *  🔴 A FULL REPLACEMENT, NOT A WRAPPER around the mock's real
   *  `cancelSubscription` — that method records into a `calls` array private to
   *  `createMockPaddleClient` (there is no way to delay-then-delegate to it
   *  without ALSO delaying the recording), so this keeps its own count instead
   *  of relying on `ops()` for this one operation. It also never re-checks
   *  「already canceled」 — the exact courtesy this suite is proving must not be
   *  load-bearing. */
  function delayedAlwaysSucceedingCancel(
    calls: string[],
  ): (id: string, ef: string) => Promise<{ ok: true; data: unknown }> {
    return (id: string) => {
      calls.push(id);
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: true, data: { id, status: 'canceled', scheduled_change: null, next_billed_at: null } });
        }, 20);
      });
    };
  }

  it('claims first: the loser is refused with a NAMED code before it ever reaches the provider', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS, distinctIds: true });
    const cancelCalls: string[] = [];
    (paddle as { cancelSubscription: unknown }).cancelSubscription = delayedAlwaysSucceedingCancel(cancelCalls);
    const bearer = await account('m@flowmic.test');

    const [a, b] = await Promise.all([withdraw(bearer), withdraw(bearer)]);
    const statuses = [a.status, b.status].sort();
    // 🔴 EXACTLY one winner, one loser — not "at most one", which a test that
    // tolerated two 200s could still pass by accident.
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.error).toBe(BILLING_WITHDRAWAL_ALREADY_REQUESTED);
    // The load-bearing count: with the mock's own "already canceled" refusal
    // bypassed, ONLY the local claim can be the reason this is 1 and not 2.
    expect(cancelCalls).toHaveLength(1);
  });

  // 🔴 REVERSE CONTROL, seen red: the SAME race, with ONLY the claim disabled
  // (the transaction-level backstop from AUD-2 stays in place, but it acts at
  // step ② — cancelSubscription itself is not what it guards, so the count
  // below isolates the claim's own contribution). Restored immediately after.
  it('🔴 reverse control — with the claim disabled, BOTH requests reach the provider', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS, distinctIds: true });
    const cancelCalls: string[] = [];
    (paddle as { cancelSubscription: unknown }).cancelSubscription = delayedAlwaysSucceedingCancel(cancelCalls);
    const bearer = await account('n@flowmic.test');
    const originalClaim = db.billing.claimWithdrawal.bind(db.billing);
    (db.billing as { claimWithdrawal: unknown }).claimWithdrawal = () => true;

    const [a, b] = await Promise.all([withdraw(bearer), withdraw(bearer)]);

    (db.billing as { claimWithdrawal: unknown }).claimWithdrawal = originalClaim;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(cancelCalls).toHaveLength(2);
  });
});

// 2026-09-02 (AUD-2 addendum to audit F4) — `findRefundableTransaction` names
// the most recently BILLED completed transaction and has no notion of
// "already adjusted" (paddle/client.ts's `readTransactionList`, unlike the
// Creem client's equivalent, does not filter on this). This is the local
// backstop http/billing-routes.ts checks BEFORE calling `createRefund`.
describe('🔴 AUD-2 — a transaction that already has a submitted refund is never asked for one again', () => {
  it('refused locally: no second createRefund call, the EXISTING adjustment is echoed back', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    const user = await auth.register({ email: 'o@flowmic.test', password: 'longenough1', display_name: 'T' });
    subscribe(user.id);
    const bearer = { authorization: `Bearer ${auth.issueToken(user).token}` };
    // The mock derives the transaction id from the subscription id (see
    // findRefundableTransaction in mock-client.ts: `txn_mock_${id.slice(-6)}`)
    // — read from ITS source, not guessed, the same way this file already
    // hardcodes the mock's `amount_minor: 600, currency: 'USD'` above.
    const txnId = `txn_mock_${'sub_test'.slice(-6)}`;
    db.billing.recordRefundRequest({
      id: 'rfd_prior', user_id: user.id, subscription_id: 'sub_test', transaction_id: txnId,
      kind: 'statutory_withdrawal', state: 'submitted', amount_minor: 600, currency: 'USD',
      paddle_adjustment_id: 'adj_prior_real', paddle_status: 'pending_approval', detail: null,
      created_at: CONCLUDED,
    });

    const out = await withdraw(bearer);

    expect(out.status).toBe(200);
    // The cancellation still happens — this backstop is about not asking for
    // money twice, not about refusing to cancel.
    expect(ops()).toContain('cancelSubscription');
    // 🔴 THE ASSERTION THIS TEST EXISTS FOR: Paddle is never asked for a SECOND
    // refund on a transaction that already has one submitted.
    expect(ops()).not.toContain('createRefund');
    expect(out.json.refund).toMatchObject({ state: 'submitted' });
    const rows = db.billing.listRefundRequests(user.id, 10).filter((r) => r.transaction_id === txnId);
    expect(rows).toHaveLength(2);
    // The NEW row (the one this attempt wrote) copies the EXISTING adjustment
    // id verbatim rather than fabricating a fresh one — proof it never asked
    // Paddle again, read from the row `recordRefundRequest` actually wrote,
    // not from the response body (which never carries `paddle_adjustment_id`).
    const refused = rows.find((r) => r.id !== 'rfd_prior');
    expect(refused).toMatchObject({ paddle_adjustment_id: 'adj_prior_real', state: 'submitted' });
    expect(refused?.detail).toContain('refused locally');
  });

  // 🔴 REVERSE CONTROL, seen red: without the check, this SAME setup calls
  // createRefund again (it has no way to know one was already submitted).
  it('🔴 reverse control — without the check, createRefund is called a second time', async () => {
    boot({ nowMs: CONCLUDED_MS + 3 * DAY_MS });
    const user = await auth.register({ email: 'p@flowmic.test', password: 'longenough1', display_name: 'T' });
    subscribe(user.id);
    const bearer = { authorization: `Bearer ${auth.issueToken(user).token}` };
    const txnId = `txn_mock_${'sub_test'.slice(-6)}`;
    db.billing.recordRefundRequest({
      id: 'rfd_prior2', user_id: user.id, subscription_id: 'sub_test', transaction_id: txnId,
      kind: 'statutory_withdrawal', state: 'submitted', amount_minor: 600, currency: 'USD',
      paddle_adjustment_id: 'adj_prior2', paddle_status: 'pending_approval', detail: null,
      created_at: CONCLUDED,
    });
    const original = db.billing.findSubmittedRefundForTransaction.bind(db.billing);
    (db.billing as { findSubmittedRefundForTransaction: unknown }).findSubmittedRefundForTransaction = () => null;

    const out = await withdraw(bearer);

    (db.billing as { findSubmittedRefundForTransaction: unknown }).findSubmittedRefundForTransaction = original;
    expect(out.status).toBe(200);
    expect(ops()).toContain('createRefund');
  });
});
