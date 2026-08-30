// SPEC-REF:
//   apps/server-core/src/http/ops-purchase-routes.ts (the surface under test)
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts (assigned stamps)
//
// The operator side of the paid setup service.
//
// ⚠️ WHAT THIS FILE DOES **NOT** TEST, because another one already does it
// better: that the two routes refuse an anonymous and a non-admin caller.
// `console-admin-gate-coverage.test.ts` sweeps EVERY route in its registry
// against a real server with a real anonymous request and a real normal
// account, and both of these routes are declared 'admin' there. Re-asserting it
// here against a hand-rolled request would be a second, weaker answer to a
// question that already has a strong one — and the weaker one is the one that
// would go on passing after somebody removed the gate from the mounted server.

import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { BILLING_SQL } from '../src/db/schema-billing';
import { makeOneTimePurchaseRepo, type OneTimePurchaseRow } from '../src/db/repos/one-time-purchase.repo';
import {
  deliveryStampsFor,
  OPERATOR_SETTABLE_STATES,
  PURCHASE_DELIVER_ACTION,
  PURCHASE_NOTE_MAX,
  PURCHASE_REOPEN_ACTION,
  PURCHASE_SCHEDULE_ACTION,
  PURCHASE_START_ACTION,
  PURCHASE_TARGET_KIND,
  PURCHASES_ADVANCE_ROUTE,
  PURCHASES_LIST_LIMIT,
  PURCHASES_LIST_ROUTE,
  PURCHASE_NOT_RECORDED,
  PURCHASE_NOT_REFUNDABLE,
  PURCHASE_REFUND_ACTION,
  PURCHASE_REFUND_REFUSED,
  PURCHASE_TRANSITION_INVALID,
  PURCHASE_UNKNOWN,
  PURCHASES_REFUND_ROUTE,
  tryHandleOpsPurchaseRoutes,
  type OpsPurchaseRoutesDeps,
} from '../src/http/ops-purchase-routes';
import type { ServiceMailer, SetupCompletedMailInput } from '../src/mail/service-mailer';
import type { ServiceRefundOutcome } from '../src/billing/service-refund';
import { GUIDED_SETUP_AFTERCARE_DAYS } from '../src/billing/guided-setup';
import { ADMIN_GATED_ROUTES, MUTATING_ADMIN_GATED_ROUTES } from '../src/http/ops-audit-trail';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

const NOW_MS = Date.parse('2026-08-29T12:00:00.000Z');
const NOW_ISO = '2026-08-29T12:00:00.000Z';
const ADMIN_ID = 'admin-1';

function makeDb(): ReturnType<typeof makeOneTimePurchaseRepo> {
  const db = new DatabaseSync(':memory:');
  db.exec(BILLING_SQL);
  return makeOneTimePurchaseRepo(db);
}

function seed(
  repo: ReturnType<typeof makeOneTimePurchaseRepo>,
  over: Partial<Omit<OneTimePurchaseRow, 'updated_at'>> = {},
): string {
  const order_id = over.order_id ?? 'ord_1';
  repo.recordOneTimePurchase({
    order_id,
    provider: 'creem',
    user_id: 'u1',
    product_id: 'prod_setup',
    checkout_id: 'ch_1',
    transaction_id: 'tx_1',
    customer_id: 'cus_1',
    amount_minor: 20000,
    currency: 'USD',
    state: 'paid',
    early_start_consent_at: NOW_ISO,
    withdrawal_waiver_ack_at: NOW_ISO,
    consent_terms_version: 'gs-1',
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

/** A response double that records what the route said. */
function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') raw += chunk;
      return this;
    },
    write(chunk: string) {
      raw += chunk;
      return true;
    },
    headersSent: false,
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    body: () => (raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)),
  };
}

/** A request double. 🔴 The body stream is EXPLICITLY not in objectMode: a
 *  `Readable.from([string])` defaults to objectMode, and the bounded reader then
 *  waits forever for bytes that never arrive. That cost this suite's sibling an
 *  hour once; it is stated here so it costs nobody a second one. */
function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const stream = Readable.from([Buffer.from(raw, 'utf8')], { objectMode: false });
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  // The admin gate reads this. The gate itself is exercised for real by
  // console-admin-gate-coverage.test.ts; here it is satisfied so the route body
  // under test is reachable.
  req.headers = { authorization: 'Bearer admin-token' };
  (req as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1' };
  return req;
}

/** An `AccountVerifier` that says 「yes, an admin」 — see makeReq. */
function adminAuth(): OpsPurchaseRoutesDeps['auth'] {
  return {
    verifyToken: () => ({ ok: true as const, sub: ADMIN_ID }),
    getUser: () => ({ id: ADMIN_ID, is_admin: 1 }),
  } as unknown as OpsPurchaseRoutesDeps['auth'];
}

function makeDeps(
  repo: ReturnType<typeof makeOneTimePurchaseRepo>,
  over: Partial<OpsPurchaseRoutesDeps> = {},
): { deps: OpsPurchaseRoutesDeps; rows: Parameters<OpsPurchaseRoutesDeps['audit']['append']>[0][] } {
  const rows: Parameters<OpsPurchaseRoutesDeps['audit']['append']>[0][] = [];
  const deps: OpsPurchaseRoutesDeps = {
    auth: adminAuth(),
    purchases: repo,
    audit: {
      append: (input) => {
        rows.push(input);
        return rows.length;
      },
    },
    now: () => NOW_MS,
    ...over,
  };
  return { deps, rows };
}

/** The rows THIS ROUTE wrote, as opposed to the ones `adminGate` wrote.
 *
 *  🔴 TWO KINDS IN ONE SINK, ON PURPOSE (ops-audit-trail.ts): the gate records
 *  「this admin called this route」 and knows nothing about what the route MEANS;
 *  a route that wants to say 「a delivery was recorded」 appends its own. Tests
 *  that counted the sink as one number would report the gate's row as evidence
 *  that a purchase moved. */
function businessRows(
  rows: Parameters<OpsPurchaseRoutesDeps['audit']['append']>[0][],
): Parameters<OpsPurchaseRoutesDeps['audit']['append']>[0][] {
  return rows.filter((r) => r.target_kind === PURCHASE_TARGET_KIND);
}

/** The gate's own rows — asserted directly only where their presence or absence
 *  is the point. */
function gateRows(
  rows: Parameters<OpsPurchaseRoutesDeps['audit']['append']>[0][],
): Parameters<OpsPurchaseRoutesDeps['audit']['append']>[0][] {
  return rows.filter((r) => r.target_kind === 'route');
}

/** Drive the route and wait for its async body to finish. The handler returns
 *  synchronously and completes the response in a floating promise, exactly as
 *  its neighbours do, so the test polls the recorded status rather than sleeping
 *  a fixed number of milliseconds — a fixed sleep is a flake generator and this
 *  suite's sibling shipped one. */
async function call(
  deps: OpsPurchaseRoutesDeps,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ owned: boolean; status: number; body: Record<string, unknown> }> {
  const r = makeRes();
  const owned = tryHandleOpsPurchaseRoutes(makeReq(method, url, body), r.res, deps);
  for (let i = 0; i < 200 && r.status() === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { owned, status: r.status(), body: r.body() };
}

describe('the delivery stamps a state implies', () => {
  const row = {
    scheduled_at: '2026-08-01T00:00:00.000Z',
    started_at: '2026-08-01T12:00:00.000Z',
    delivered_at: '2026-08-02T00:00:00.000Z',
    completion_notice_at: '2026-08-02T00:05:00.000Z',
  };
  const EMPTY = { scheduled_at: null, started_at: null, delivered_at: null, completion_notice_at: null };

  it('paid CLEARS all four — the claim being retracted is that anything happened', () => {
    expect(deliveryStampsFor('paid', row, NOW_ISO)).toEqual(EMPTY);
  });

  it('scheduled clears started_at and delivered_at and KEEPS the original booking time', () => {
    // 🔴 THE HALF THAT MATTERS. Re-stamping `scheduled_at` here would rewrite
    // when the session was first booked, which is the only thing that timestamp
    // is for; clearing the later two is what makes walking back a mis-marked
    // delivery actually remove the claim rather than leave the row saying both.
    expect(deliveryStampsFor('scheduled', row, NOW_ISO)).toEqual({
      scheduled_at: row.scheduled_at,
      started_at: null,
      delivered_at: null,
      // THE NOTICE STAMP GOES WITH THE DELIVERY IT WAS ABOUT. Keeping it would
      // record an email about a delivery we have just retracted.
      completion_notice_at: null,
    });
  });

  it('scheduled STAMPS when there was no booking time yet', () => {
    expect(deliveryStampsFor('scheduled', EMPTY, NOW_ISO)).toEqual({ ...EMPTY, scheduled_at: NOW_ISO });
  });

  it('in_progress keeps the booking, stamps the start once, and clears delivery (gs-5)', () => {
    // Forward from scheduled: started_at is minted.
    expect(
      deliveryStampsFor('in_progress', { ...EMPTY, scheduled_at: row.scheduled_at }, NOW_ISO),
    ).toEqual({ scheduled_at: row.scheduled_at, started_at: NOW_ISO, delivered_at: null, completion_notice_at: null });
    // Back from delivered: started_at is PRESERVED (when it began is a fact),
    // delivery and its notice are retracted.
    expect(deliveryStampsFor('in_progress', row, NOW_ISO)).toEqual({
      scheduled_at: row.scheduled_at,
      started_at: row.started_at,
      delivered_at: null,
      completion_notice_at: null,
    });
    // Unbooked start is legal — a session can begin without a diary entry.
    expect(deliveryStampsFor('in_progress', EMPTY, NOW_ISO)).toEqual({ ...EMPTY, started_at: NOW_ISO });
  });

  it('delivered keeps a booking and a start that happened, and stamps delivery once', () => {
    expect(
      deliveryStampsFor(
        'delivered',
        { scheduled_at: row.scheduled_at, started_at: row.started_at, delivered_at: null, completion_notice_at: null },
        NOW_ISO,
      ),
    ).toEqual({ scheduled_at: row.scheduled_at, started_at: row.started_at, delivered_at: NOW_ISO, completion_notice_at: null });
  });

  it('delivered without a booking or a start is legal — a session can happen unbooked', () => {
    expect(deliveryStampsFor('delivered', EMPTY, NOW_ISO)).toEqual({ ...EMPTY, delivered_at: NOW_ISO });
  });

  it('🔴 this function NEVER invents a notice stamp — in either direction', () => {
    // TWO assertions, and the SECOND is the load-bearing one. A first draft of
    // this test asserted only the first and was BLIND to the edit it was written
    // to catch: changing the branch to `?? nowIso` (the shape its siblings
    // legitimately use) leaves an already-stamped row untouched, so assertion
    // one still passes.
    //
    // ① re-marking a delivered row keeps the original stamp — the record of
    //   when the buyer was first told must not move because somebody pressed a
    //   button twice;
    // ② 🔴 a delivery with NO notice comes back with NO notice. `?? nowIso`
    //   here would record a letter nobody sent, and the operator queue would
    //   stop showing a duty that is still owed. The stamp is written by the
    //   ROUTE, after the transport accepts, and by nothing else.
    expect(deliveryStampsFor('delivered', row, NOW_ISO).completion_notice_at).toBe(
      row.completion_notice_at,
    );
    expect(deliveryStampsFor('delivered', EMPTY, NOW_ISO).completion_notice_at).toBeNull();
  });
});

describe('the route fence declares both routes', () => {
  it('both are in ADMIN_GATED_ROUTES, so `adminGate` will compile for them', () => {
    expect(ADMIN_GATED_ROUTES).toContain(PURCHASES_LIST_ROUTE);
    expect(ADMIN_GATED_ROUTES).toContain(PURCHASES_ADVANCE_ROUTE);
  });

  it('🔴 the advance route is DECLARED a mutator — the fail-closed claim', () => {
    // Being on this list is a claim that the route writes its own business row
    // before the write and refuses if it cannot. The test two describes below
    // is what makes the claim true rather than decorative.
    expect(MUTATING_ADMIN_GATED_ROUTES).toContain(PURCHASES_ADVANCE_ROUTE);
    expect(MUTATING_ADMIN_GATED_ROUTES).not.toContain(PURCHASES_LIST_ROUTE);
  });
});

describe('GET /api/ops/purchases — the work queue', () => {
  it('lists across accounts, newest first, and echoes the cap', async () => {
    const repo = makeDb();
    seed(repo, { order_id: 'ord_a', user_id: 'u1', created_at: '2026-08-01T00:00:00.000Z' });
    seed(repo, { order_id: 'ord_b', user_id: 'u2', created_at: '2026-08-05T00:00:00.000Z' });
    const { deps } = makeDeps(repo);
    const out = await call(deps, 'GET', '/api/ops/purchases');
    expect(out.owned).toBe(true);
    expect(out.status).toBe(200);
    const purchases = out.body.purchases as Record<string, unknown>[];
    // Two accounts in one response: this is the read that a customer's own
    // route must never be able to produce.
    expect(purchases.map((p) => p.order_id)).toEqual(['ord_b', 'ord_a']);
    expect(purchases.map((p) => p.user_id)).toEqual(['u2', 'u1']);
    // ⚠️ Without this, a console holding exactly `limit` rows cannot tell 「that
    // is all of them」 from 「that is as many as we send」.
    expect(out.body.limit).toBe(PURCHASES_LIST_LIMIT);
  });

  it('🔴 never carries an email — the account id is the only identity here', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps } = makeDeps(repo);
    const out = await call(deps, 'GET', '/api/ops/purchases');
    // Asserted on the WHOLE serialised body rather than on a field: a leak
    // arrives as a field nobody thought to check, so the assertion has to be
    // one that does not need to know the field's name.
    expect(JSON.stringify(out.body)).not.toContain('@');
  });

  it('surfaces the consent record, because a withdrawal request turns on it', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps } = makeDeps(repo);
    const out = await call(deps, 'GET', '/api/ops/purchases');
    const [p] = out.body.purchases as Record<string, unknown>[];
    expect(p?.consent).toEqual({
      early_start_at: NOW_ISO,
      waiver_ack_at: NOW_ISO,
      terms_version: 'gs-1',
    });
  });

  it('does not own an unrelated path', async () => {
    const repo = makeDb();
    const { deps } = makeDeps(repo);
    const out = await call(deps, 'GET', '/api/ops/users');
    expect(out.owned).toBe(false);
  });
});

describe('POST /api/ops/purchases/advance', () => {
  it('books a paid purchase, stamps it, and writes ONE business row', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'scheduled',
      note: 'booked for Tuesday 10:00 CET',
    });
    expect(out.status).toBe(200);
    expect(out.body.changed).toBe(true);
    expect(out.body.next_step).toBe('scheduled');
    const row = repo.getOneTimePurchase(id);
    expect(row?.state).toBe('scheduled');
    expect(row?.scheduled_at).toBe(NOW_ISO);
    expect(row?.delivered_at).toBeNull();
    expect(businessRows(rows)).toHaveLength(1);
    expect(businessRows(rows)[0]).toMatchObject({
      actor_user_id: ADMIN_ID,
      action: PURCHASE_SCHEDULE_ACTION,
      target_kind: PURCHASE_TARGET_KIND,
      target_id: id,
      detail: 'booked for Tuesday 10:00 CET',
    });
  });

  it('starting a booked session stamps started_at, keeps the booking, and is named its own action (gs-5)', async () => {
    const repo = makeDb();
    const id = seed(repo, { state: 'scheduled', scheduled_at: '2026-08-20T09:00:00.000Z' });
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'in_progress',
      note: 'on the call now',
    });
    expect(out.status).toBe(200);
    expect(out.body.next_step).toBe('in_progress');
    expect(out.body.started_at).toBe(NOW_ISO);
    const row = repo.getOneTimePurchase(id);
    expect(row?.state).toBe('in_progress');
    expect(row?.scheduled_at).toBe('2026-08-20T09:00:00.000Z');
    expect(row?.started_at).toBe(NOW_ISO);
    expect(row?.delivered_at).toBeNull();
    expect(businessRows(rows)[0]?.action).toBe(PURCHASE_START_ACTION);
    // And the queue still offers the refund on it — a setup that has begun is
    // not complete.
    const list = await call(deps, 'GET', '/api/ops/purchases');
    const qrow = (list.body.purchases as Record<string, unknown>[])[0]!;
    expect(qrow.started_at).toBe(NOW_ISO);
    expect(qrow.refund_window).toEqual({ open: true, reason: 'not_yet_completed', closes_at: null });
    expect(qrow.refund_due).toBeNull();
    expect(qrow.next_deadline_at).toBeNull();
  });

  it('delivering keeps the booking and start times and adds the delivery time', async () => {
    const repo = makeDb();
    const id = seed(repo, {
      state: 'in_progress',
      scheduled_at: '2026-08-20T09:00:00.000Z',
      started_at: '2026-08-20T09:05:00.000Z',
    });
    const { deps, rows } = makeDeps(repo);
    await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'session done, 95 minutes',
    });
    const row = repo.getOneTimePurchase(id);
    expect(row?.state).toBe('delivered');
    expect(row?.scheduled_at).toBe('2026-08-20T09:00:00.000Z');
    expect(row?.started_at).toBe('2026-08-20T09:05:00.000Z');
    expect(row?.delivered_at).toBe(NOW_ISO);
    expect(businessRows(rows)[0]?.action).toBe(PURCHASE_DELIVER_ACTION);
  });

  it('🔴 walking a mis-marked delivery back really CLEARS delivered_at', async () => {
    // THE TEST THE ASSIGNED-STAMPS CHANGE EXISTS FOR. Under the repo's original
    // COALESCE semantics this passes its status assertion and fails here: the
    // row would say state='scheduled' and delivered_at='…12:00Z' at the same
    // time — two answers to 「does this customer still have a session coming」,
    // on the surface that answers it to the customer.
    const repo = makeDb();
    const id = seed(repo, {
      state: 'delivered',
      scheduled_at: '2026-08-20T09:00:00.000Z',
      delivered_at: '2026-08-21T09:00:00.000Z',
    });
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'scheduled',
      note: 'clicked the wrong row; this one has not happened yet',
    });
    expect(out.status).toBe(200);
    const row = repo.getOneTimePurchase(id);
    expect(row?.state).toBe('scheduled');
    expect(row?.delivered_at).toBeNull();
    expect(row?.scheduled_at).toBe('2026-08-20T09:00:00.000Z');
    expect(businessRows(rows)[0]?.action).toBe(PURCHASE_SCHEDULE_ACTION);
  });

  it('re-opening to paid clears ALL the stamps and is named its own action', async () => {
    const repo = makeDb();
    const id = seed(repo, {
      state: 'delivered',
      scheduled_at: '2026-08-20T09:00:00.000Z',
      started_at: '2026-08-20T09:05:00.000Z',
      delivered_at: '2026-08-21T09:00:00.000Z',
    });
    const { deps, rows } = makeDeps(repo);
    await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'paid',
      note: 'customer says the session never happened',
    });
    const row = repo.getOneTimePurchase(id);
    expect(row?.scheduled_at).toBeNull();
    expect(row?.started_at).toBeNull();
    expect(row?.delivered_at).toBeNull();
    expect(businessRows(rows)[0]?.action).toBe(PURCHASE_REOPEN_ACTION);
  });

  it('🔴 refuses to record a refund, and says where one comes from', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'refunded',
      note: 'refunded them',
    });
    expect(out.status).toBe(400);
    // The sentence matters more than the status: 「not one of: paid, scheduled,
    // in_progress, delivered」 would leave an operator believing they had
    // misspelled a field.
    expect(String(out.body.message)).toContain('webhook');
    expect(repo.getOneTimePurchase(id)?.state).toBe('paid');
    expect(businessRows(rows)).toHaveLength(0);
    // And it is not merely undocumented — it is not in the settable set at all.
    expect([...OPERATOR_SETTABLE_STATES]).not.toContain('refunded');
    expect([...OPERATOR_SETTABLE_STATES]).toEqual(['paid', 'scheduled', 'in_progress', 'delivered']);
  });

  it('🔴 refuses to touch a refunded purchase — that record is closed', async () => {
    const repo = makeDb();
    const id = seed(repo, { state: 'refunded', refunded_at: '2026-08-25T00:00:00.000Z' });
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'we did the session anyway',
    });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe(PURCHASE_TRANSITION_INVALID);
    expect(repo.getOneTimePurchase(id)?.state).toBe('refunded');
    expect(repo.getOneTimePurchase(id)?.refunded_at).toBe('2026-08-25T00:00:00.000Z');
    expect(businessRows(rows)).toHaveLength(0);
  });

  it('🔴 refuses to touch a purchase whose refund is in flight — delivering it would close a refund already exercised', async () => {
    // Before this guard the route refused only 'refunded'. A buyer who had
    // already pressed withdraw (state 'refund_requested', provider asked)
    // could be moved straight to 'delivered' by an operator, and gs-5 then
    // answers 'completed' for the refund window — their console flips from
    // 「we have asked for your money back」 to 「completed, refunds closed」.
    const repo = makeDb();
    const id = seed(repo, {
      state: 'refund_requested',
      scheduled_at: '2026-08-20T09:00:00.000Z',
      refund_requested_at: '2026-08-26T00:00:00.000Z',
      refund_provider_id: 'ref_1',
      refund_status: 'pending',
    });
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'we did the session anyway',
    });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe(PURCHASE_TRANSITION_INVALID);
    // The row is byte-for-byte what it was: state, the request stamp, and the
    // provider's id all untouched, and no delivery stamp minted.
    const row = repo.getOneTimePurchase(id);
    expect(row?.state).toBe('refund_requested');
    expect(row?.refund_requested_at).toBe('2026-08-26T00:00:00.000Z');
    expect(row?.refund_provider_id).toBe('ref_1');
    expect(row?.refund_status).toBe('pending');
    expect(row?.scheduled_at).toBe('2026-08-20T09:00:00.000Z');
    expect(row?.delivered_at).toBeNull();
    expect(businessRows(rows)).toHaveLength(0);

    // And walking it BACK is refused as well — re-opening 'scheduled' would
    // re-offer the refund button on a charge the provider may be refunding.
    const back = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'scheduled',
      note: 'never mind',
    });
    expect(back.status).toBe(409);
    expect(repo.getOneTimePurchase(id)?.state).toBe('refund_requested');
  });

  it('and the webhook still lands 「refunded」 on that row — its writer is `confirmOneTimeRefund`, not this route', () => {
    // The guard closes the OPERATOR door only. Money coming back is heard on
    // the provider webhook (paddle/webhook-handler.ts step 5c), whose UPDATE
    // keys on order_id alone, so a request in flight resolves the way it
    // always did — and keeps the provider id we stamped when we asked.
    const repo = makeDb();
    const id = seed(repo, {
      state: 'refund_requested',
      refund_requested_at: '2026-08-26T00:00:00.000Z',
      refund_provider_id: 'ref_1',
      refund_status: 'pending',
    });
    const out = repo.confirmOneTimeRefund(
      id,
      { refunded_at: '2026-08-27T00:00:00.000Z', provider_id: null, provider_status: 'succeeded' },
      '2026-08-27T00:00:00.000Z',
    );
    expect(out).toBe('confirmed');
    const row = repo.getOneTimePurchase(id);
    expect(row?.state).toBe('refunded');
    expect(row?.refunded_at).toBe('2026-08-27T00:00:00.000Z');
    expect(row?.refund_provider_id).toBe('ref_1');
    expect(row?.refund_status).toBe('succeeded');
  });

  it('positive control: the guard above does not over-reach — scheduled → in_progress still succeeds', async () => {
    const repo = makeDb();
    const id = seed(repo, { state: 'scheduled', scheduled_at: '2026-08-20T09:00:00.000Z' });
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'in_progress',
      note: 'session started',
    });
    expect(out.status).toBe(200);
    expect(out.body.changed).toBe(true);
    expect(repo.getOneTimePurchase(id)?.state).toBe('in_progress');
    expect(repo.getOneTimePurchase(id)?.started_at).toBe(NOW_ISO);
    expect(businessRows(rows)).toHaveLength(1);
  });

  it('refuses a state this build does not recognise instead of overwriting it', async () => {
    const repo = makeDb();
    const id = seed(repo);
    // Written straight into the column, the way a newer build or a hand-edit
    // would leave it. The repo passes it through as the literal it is.
    const raw = new DatabaseSync(':memory:');
    void raw;
    const { deps } = makeDeps(repo, {
      purchases: {
        listAllOneTimePurchases: () => [],
        getOneTimePurchase: () => ({ ...(repo.getOneTimePurchase(id) as OneTimePurchaseRow), state: 'archived' as never }),
        advanceOneTimePurchase: vi.fn(),
        stampCompletionNotice: vi.fn(),
      },
    });
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'n',
    });
    expect(out.status).toBe(409);
    expect(String(out.body.message)).toContain('archived');
  });

  it('404s an unknown order rather than answering a cheerful ok', async () => {
    const repo = makeDb();
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: 'ord_typo',
      state: 'delivered',
      note: 'n',
    });
    expect(out.status).toBe(404);
    expect(out.body.error).toBe(PURCHASE_UNKNOWN);
    expect(businessRows(rows)).toHaveLength(0);
  });

  it('a no-op writes neither the row nor a business audit entry', async () => {
    const repo = makeDb();
    const id = seed(repo, { state: 'delivered', delivered_at: '2026-08-21T09:00:00.000Z' });
    const { deps, rows } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'again',
    });
    expect(out.status).toBe(200);
    expect(out.body.changed).toBe(false);
    // The stamp is NOT refreshed: each action name asserts the state changed.
    expect(repo.getOneTimePurchase(id)?.delivered_at).toBe('2026-08-21T09:00:00.000Z');
    expect(businessRows(rows)).toHaveLength(0);
  });

  it('requires a note in both directions, and refuses rather than truncating', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const { deps } = makeDeps(repo);
    const missing = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
    });
    expect(missing.status).toBe(400);
    const tooLong = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'x'.repeat(PURCHASE_NOTE_MAX + 1),
    });
    expect(tooLong.status).toBe(400);
    // Not stored half-way: a truncated justification is a worse record than a
    // rejected one.
    expect(repo.getOneTimePurchase(id)?.state).toBe('paid');
  });

  it('🔴 FAIL-CLOSED: an unwritable audit row leaves the purchase untouched', async () => {
    // The claim `MUTATING_ADMIN_GATED_ROUTES` makes about this route, made true.
    const repo = makeDb();
    const id = seed(repo);
    const { deps } = makeDeps(repo, {
      audit: {
        append: () => {
          throw new Error('disk full');
        },
      },
    });
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'session done',
    });
    expect(out.status).toBe(503);
    expect(out.body.error).toBe(PURCHASE_NOT_RECORDED);
    // 🔴 THE HALF THAT IS THE POINT: an unrecorded CHANGE to a delivery
    // obligation must not happen at all. A serve-and-shout here would leave a
    // customer marked delivered with nothing saying who did it.
    expect(repo.getOneTimePurchase(id)?.state).toBe('paid');
    expect(repo.getOneTimePurchase(id)?.delivered_at).toBeNull();
  });

  it('⚠️ a broken sink loses the GATE row too, and still serves — the stated cost', async () => {
    // ops-audit-trail.ts says out loud that a mutating route can lose its
    // route-level gate row while its business row lands, and that this is the
    // cheaper half to lose. This pins the OTHER direction of the same policy:
    // when the sink is broken for both, `recordGateOutcome` still SERVES (it
    // swallows and shouts) rather than 401-ing, so the request reaches the
    // route — which is the only reason the fail-closed 503 above is reachable
    // at all. Without this, someone 「hardening」 the gate to refuse on an
    // unwritable trail would turn that 503 into a 401 and the test above would
    // still be green, for the wrong reason.
    const repo = makeDb();
    const id = seed(repo);
    const { deps, rows } = makeDeps(repo, {
      audit: {
        append: () => {
          throw new Error('disk full');
        },
      },
    });
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'session done',
    });
    expect(out.status).toBe(503);
    // 🔴 NOT 401. The trail is silent, and 「silent」 must never be read as
    // 「the gate refused」 by somebody querying this table later.
    expect(gateRows(rows)).toHaveLength(0);
    expect(businessRows(rows)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gs-5 — the completion notice, and the operator's refund button.

/** A mailer that records what it was asked to send, or refuses. */
function mailer(mode: 'ok' | 'throws' = 'ok'): ServiceMailer & { sent: SetupCompletedMailInput[] } {
  const sent: SetupCompletedMailInput[] = [];
  return {
    id: 'test',
    sent,
    async sendSetupCompleted(input: SetupCompletedMailInput): Promise<void> {
      if (mode === 'throws') throw new Error('mail server said no');
      sent.push(input);
    },
    async sendWithdrawalReceived(): Promise<void> {},
  } as ServiceMailer & { sent: SetupCompletedMailInput[] };
}

const USERS = {
  findById: (): { id: string; email: string } => ({ id: 'u1', email: 'buyer@example.test' }),
};

describe('gs-5 — telling the buyer their setup is done', () => {
  it('marking a setup delivered emails the buyer and stamps WHEN', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const m = mailer();
    const { deps } = makeDeps(repo, { mailer: m, users: USERS as never });
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'session done',
    });
    expect(out.status).toBe(200);
    expect(out.body.notice_sent).toBe(true);
    expect(out.body.next_step).toBe('support');
    // The letter went to the ACCOUNT's address and quoted the period from the
    // constant — not a number typed into a template.
    expect(m.sent).toEqual([
      { to: 'buyer@example.test', orderId: id, aftercareDays: GUIDED_SETUP_AFTERCARE_DAYS },
    ]);
    expect(repo.getOneTimePurchase(id)?.completion_notice_at).toBe(NOW_ISO);
  });

  it('🔴 a mail failure does NOT fail the delivery, and does NOT stamp', async () => {
    // The session really happened; refusing to record it because a mail server
    // had a bad minute would lose the work. What must NOT happen is a stamp,
    // because the stamp is the record that the buyer WAS told.
    const repo = makeDb();
    const id = seed(repo);
    const { deps } = makeDeps(repo, { mailer: mailer('throws'), users: USERS as never });
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'session done',
    });
    expect(out.status).toBe(200);
    expect(out.body.changed).toBe(true);
    expect(repo.getOneTimePurchase(id)?.state).toBe('delivered');
    // 🔴 THE TWO FACTS ARE REPORTED SEPARATELY. An operator has to be able to
    // see the second one fail while the first succeeded.
    expect(out.body.notice_sent).toBe(false);
    expect(out.body.notice_failed).toBe('send_failed');
    expect(repo.getOneTimePurchase(id)?.completion_notice_at).toBeNull();
  });

  it('🔴 and the unnotified delivery is CLOSED to refunds all the same — the null is a duty, not a right (gs-5)', async () => {
    // Under gs-3/gs-4 this row was refundable forever. owner 2026-08-30:
    // completion closes the refund; the email is a record we owe, and our
    // failure to send it is chased by hand, not paid for with reopened money.
    const repo = makeDb();
    const id = seed(repo);
    const { deps } = makeDeps(repo, { mailer: mailer('throws'), users: USERS as never });
    await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'n',
    });
    // Read it back through the queue the way an operator would: the missing
    // letter is visible (completion_notice_at null) and the window is closed.
    const list = await call(deps, 'GET', '/api/ops/purchases');
    const row = (list.body.purchases as Record<string, unknown>[])[0]!;
    expect(row.completion_notice_at).toBeNull();
    expect(row.refund_window).toEqual({ open: false, reason: 'completed', closes_at: null });
    // The support period runs from the delivery, not from the (missing) email.
    expect(row.support_until).toBe(new Date(NOW_MS + GUIDED_SETUP_AFTERCARE_DAYS * 24 * 60 * 60 * 1000).toISOString());
    expect(row.next_deadline_at).toBe(row.support_until);
    expect(row.next_step).toBe('support');
  });

  it('a deployment with no mail channel records the delivery and says it told nobody', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const { deps } = makeDeps(repo); // no mailer, no users
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'n',
    });
    expect(out.status).toBe(200);
    expect(out.body.notice_failed).toBe('no_mail_channel');
    expect(repo.getOneTimePurchase(id)?.completion_notice_at).toBeNull();
  });

  it('a purchase with no account attached has nobody to tell, and says so', async () => {
    // `unmapped` is a real state — the webhook writes it when a checkout carried
    // no user id — and it must not crash or report a cheerful notification.
    const repo = makeDb();
    const id = seed(repo, { user_id: null });
    const { deps } = makeDeps(repo, { mailer: mailer(), users: USERS as never });
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'delivered',
      note: 'n',
    });
    expect(out.body.notice_failed).toBe('no_address');
  });

  it('booking a session sends nothing — a buyer gets no completion notice for that', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const m = mailer();
    const { deps } = makeDeps(repo, { mailer: m, users: USERS as never });
    await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'scheduled',
      note: 'booked friday',
    });
    expect(m.sent).toHaveLength(0);
  });

  it('a re-made delivery notifies again; an idempotent re-click does not', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const m = mailer();
    const { deps } = makeDeps(repo, { mailer: m, users: USERS as never });
    await call(deps, 'POST', '/api/ops/purchases/advance', { order_id: id, state: 'delivered', note: 'n' });
    // Walked back and re-made: a FRESH delivery, so a FRESH letter. That is the
    // design, and it is asserted rather than left ambiguous — it is the reason
    // the notice stamp is cleared on the way back.
    await call(deps, 'POST', '/api/ops/purchases/advance', { order_id: id, state: 'scheduled', note: 'n' });
    await call(deps, 'POST', '/api/ops/purchases/advance', { order_id: id, state: 'delivered', note: 'n' });
    expect(m.sent).toHaveLength(2);
    // …and pressing 「delivered」 again on an already-delivered row is a no-op.
    await call(deps, 'POST', '/api/ops/purchases/advance', { order_id: id, state: 'delivered', note: 'n' });
    expect(m.sent).toHaveLength(2);
  });
});

describe('POST /api/ops/purchases/refund — the operator presses a due refund', () => {
  function refunder(
    answer: ServiceRefundOutcome = { ok: true, providerStatus: 'pending' },
  ): { fn: NonNullable<OpsPurchaseRoutesDeps['refund']>; calls: [string, string][] } {
    const calls: [string, string][] = [];
    return {
      calls,
      fn: async (orderId, origin) => {
        calls.push([orderId, origin]);
        return answer;
      },
    };
  }

  it('is in the fence AND declared a mutator — it moves money', () => {
    expect(ADMIN_GATED_ROUTES).toContain(PURCHASES_REFUND_ROUTE);
    expect(MUTATING_ADMIN_GATED_ROUTES).toContain(PURCHASES_REFUND_ROUTE);
  });

  it('asks the shared action with origin `operator`, and writes ONE business row', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const r = refunder();
    const { deps, rows } = makeDeps(repo, { refund: r.fn });
    const out = await call(deps, 'POST', '/api/ops/purchases/refund', {
      order_id: id,
      note: '40 days, never finished',
    });
    expect(out.status).toBe(200);
    expect(r.calls).toEqual([[id, 'operator']]);
    // 🔴 'refund_requested', NEVER 'refunded' — the webhook owns that word.
    expect(out.body.state).toBe('refund_requested');
    expect(out.body.settles_via_webhook).toBe(true);
    const business = businessRows(rows);
    expect(business).toHaveLength(1);
    expect(business[0]!.action).toBe(PURCHASE_REFUND_ACTION);
    expect(business[0]!.detail).toBe('40 days, never finished');
  });

  it('🔴 FAIL-CLOSED: an unwritable audit row means NO money moves', async () => {
    // Higher stakes than the advance route's version of this: an unrecorded
    // refund is a payment nobody authorised on paper.
    const repo = makeDb();
    const id = seed(repo);
    const r = refunder();
    const { deps } = makeDeps(repo, {
      refund: r.fn,
      audit: {
        append: () => {
          throw new Error('disk full');
        },
      },
    });
    const out = await call(deps, 'POST', '/api/ops/purchases/refund', { order_id: id, note: 'n' });
    expect(out.status).toBe(503);
    expect(out.body.error).toBe(PURCHASE_NOT_RECORDED);
    expect(r.calls).toHaveLength(0);
  });

  it('requires a note, like every other move that has to explain itself', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const r = refunder();
    const { deps } = makeDeps(repo, { refund: r.fn });
    expect((await call(deps, 'POST', '/api/ops/purchases/refund', { order_id: id })).status).toBe(400);
    expect(
      (
        await call(deps, 'POST', '/api/ops/purchases/refund', {
          order_id: id,
          note: 'x'.repeat(PURCHASE_NOTE_MAX + 1),
        })
      ).status,
    ).toBe(400);
    expect(r.calls).toHaveLength(0);
  });

  it('a deployment with no outbound client refuses by name, not with a 500', async () => {
    const repo = makeDb();
    const id = seed(repo); // no refund function on deps
    const { deps } = makeDeps(repo);
    const out = await call(deps, 'POST', '/api/ops/purchases/refund', { order_id: id, note: 'n' });
    expect(out.status).toBe(503);
    expect(out.body.error).toBe(PURCHASE_NOT_REFUNDABLE);
  });

  it('separates not-refundable from the-provider-said-no — different next moves', async () => {
    const repo = makeDb();
    const id = seed(repo);
    const notRefundable = makeDeps(repo, {
      refund: refunder({ ok: false, reason: 'not_refundable' }).fn,
    });
    const out1 = await call(notRefundable.deps, 'POST', '/api/ops/purchases/refund', {
      order_id: id,
      note: 'n',
    });
    expect(out1.status).toBe(409);
    expect(out1.body.error).toBe(PURCHASE_NOT_REFUNDABLE);

    const refused = makeDeps(repo, {
      refund: refunder({ ok: false, reason: 'provider_refused', detail: 'PROVIDER_UNREACHABLE x' }).fn,
    });
    const out2 = await call(refused.deps, 'POST', '/api/ops/purchases/refund', {
      order_id: id,
      note: 'n',
    });
    // 502: the request was fine, our provider was not.
    expect(out2.status).toBe(502);
    expect(out2.body.error).toBe(PURCHASE_REFUND_REFUSED);
  });

  it('and the advance route still refuses to RECORD a refund — two different acts', async () => {
    // This route MAKES a refund; the other must never be able to claim one
    // happened. Both properties asserted together, so nobody unifies them.
    const repo = makeDb();
    const id = seed(repo);
    const { deps } = makeDeps(repo, { refund: refunder().fn });
    const out = await call(deps, 'POST', '/api/ops/purchases/advance', {
      order_id: id,
      state: 'refunded',
      note: 'n',
    });
    expect(out.status).toBe(400);
    expect(String(out.body.message)).toContain('webhook');
  });
});

describe('the queue tells an operator what is DUE and when', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('flags a purchase past its 14-day start deadline, and names the date', async () => {
    const repo = makeDb();
    const bought = new Date(NOW_MS - 20 * DAY_MS).toISOString();
    seed(repo, { created_at: bought });
    const { deps } = makeDeps(repo);
    const out = await call(deps, 'GET', '/api/ops/purchases');
    const row = (out.body.purchases as Record<string, unknown>[])[0]!;
    expect(row.refund_due).toBe('no_start');
    expect(row.next_deadline_at).toBe(new Date(Date.parse(bought) + 14 * DAY_MS).toISOString());
    // The periods are echoed so the console renders them from the server —
    // and there is no `dispute_days` any more (gs-5 has no such period).
    expect(out.body.start_deadline_days).toBe(14);
    expect(out.body.complete_deadline_days).toBe(40);
    expect(out.body.aftercare_days).toBe(GUIDED_SETUP_AFTERCARE_DAYS);
    expect(out.body).not.toHaveProperty('dispute_days');
  });

  it('flags a BOOKED purchase past 40 days as not_completed, but never one that has begun (gs-5)', async () => {
    const repo = makeDb();
    const bought = new Date(NOW_MS - 45 * DAY_MS).toISOString();
    seed(repo, { order_id: 'ord_booked', state: 'scheduled', scheduled_at: bought, created_at: bought });
    seed(repo, { order_id: 'ord_begun', state: 'in_progress', scheduled_at: bought, started_at: bought, created_at: bought });
    const { deps } = makeDeps(repo);
    const out = await call(deps, 'GET', '/api/ops/purchases');
    const byId = new Map((out.body.purchases as Record<string, unknown>[]).map((p) => [p.order_id, p]));
    expect(byId.get('ord_booked')!.refund_due).toBe('not_completed');
    // 🔴 THE ONE THAT MATTERS: a clock must not take money back from somebody
    // mid-session. The 40-day flag is internal and is for booked setups only.
    expect(byId.get('ord_begun')!.refund_due).toBeNull();
    expect(byId.get('ord_begun')!.next_deadline_at).toBeNull();
  });

  it('and says nothing is due on a fresh one', async () => {
    const repo = makeDb();
    seed(repo, { created_at: new Date(NOW_MS - DAY_MS).toISOString() });
    const { deps } = makeDeps(repo);
    const out = await call(deps, 'GET', '/api/ops/purchases');
    expect((out.body.purchases as Record<string, unknown>[])[0]!.refund_due).toBeNull();
  });
});
