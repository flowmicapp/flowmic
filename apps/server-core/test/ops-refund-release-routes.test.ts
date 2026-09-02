// SPEC-REF:
//   apps/server-core/src/http/ops-refund-release-routes.ts (the surface under test)
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts (the two writes)
//   apps/server-core/src/billing/service-deadlines.ts (what the reason costs)
//
// The way out of a stuck 'refund_requested'.
//
// ⚠️ WHAT THIS FILE DOES **NOT** TEST, for its sibling's reason: that the two
// routes refuse an anonymous and a non-admin caller.
// `console-admin-gate-coverage.test.ts` sweeps EVERY route in its registry
// against a real server with a real anonymous request and a real normal
// account, and both of these are declared 'admin' there. Re-asserting it here
// against a hand-rolled request would be a second, weaker answer to a question
// that already has a strong one — and the weaker one is the one that would go
// on passing after somebody removed the gate from the mounted server.
//
// 🔴 EVERY WRITE HERE GOES THROUGH THE REAL REPO ON A REAL DATABASE with the
// real DDL. The two UPDATEs carry their own `state = 'refund_requested'`
// condition, and a repo double would answer for it — which is exactly the half
// that has to be true.

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BILLING_SQL } from '../src/db/schema-billing';
import {
  makeOneTimePurchaseRepo,
  REFUND_RELEASE_TARGETS,
  type OneTimePurchaseRow,
  type OneTimePurchaseState,
} from '../src/db/repos/one-time-purchase.repo';
import {
  PURCHASE_EXTERNAL_REFERENCE_MAX,
  PURCHASE_REFUND_RELEASE_ACTION,
  PURCHASE_REFUND_RELEASE_NOT_APPLIED_ACTION,
  PURCHASE_REFUND_SETTLE_ACTION,
  PURCHASE_REFUND_SETTLE_NOT_APPLIED_ACTION,
  PURCHASES_REFUND_RELEASE_ROUTE,
  PURCHASES_REFUND_SETTLE_ROUTE,
  tryHandleOpsRefundReleaseRoutes,
  type OpsRefundReleaseRoutesDeps,
} from '../src/http/ops-refund-release-routes';
import {
  PURCHASE_NOTE_MAX,
  PURCHASE_NOT_RECORDED,
  PURCHASE_TARGET_KIND,
  PURCHASE_TRANSITION_INVALID,
  PURCHASE_UNKNOWN,
} from '../src/http/ops-purchase-routes';
import { ADMIN_GATED_ROUTES, MUTATING_ADMIN_GATED_ROUTES } from '../src/http/ops-audit-trail';
import type {
  RefundReleasedMailInput,
  RefundSettledMailInput,
  ServiceMailer,
} from '../src/mail/service-mailer';

const NOW_MS = Date.parse('2026-08-31T12:00:00.000Z');
const NOW_ISO = '2026-08-31T12:00:00.000Z';
const BOUGHT = '2026-08-01T00:00:00.000Z';
const ADMIN_ID = 'admin-1';

type Repo = ReturnType<typeof makeOneTimePurchaseRepo>;

function makeDb(): Repo {
  const db = new DatabaseSync(':memory:');
  db.exec(BILLING_SQL);
  return makeOneTimePurchaseRepo(db);
}

/** Seed a purchase and, unless told otherwise, put it through the REAL claim so
 *  it is stuck in 'refund_requested' exactly the way production gets there. */
function seed(repo: Repo, over: Partial<OneTimePurchaseRow> = {}, claim = true): string {
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
    early_start_consent_at: BOUGHT,
    withdrawal_waiver_ack_at: BOUGHT,
    consent_terms_version: 'gs-5',
    scheduled_at: null,
    started_at: null,
    delivered_at: null,
    refund_requested_at: null,
    refund_provider_id: null,
    refund_status: null,
    refunded_at: null,
    completion_notice_at: null,
    note: null,
    created_at: BOUGHT,
    ...over,
  });
  if (claim) {
    // The real thing: the conditional UPDATE service-refund.ts runs before it
    // calls the provider. `provider_status: null` is what a stuck row looks
    // like — we asked and heard nothing.
    const won = repo.requestOneTimeRefund(
      order_id,
      { requested_at: BOUGHT, provider_id: null, provider_status: null },
      BOUGHT,
    );
    expect(won, 'the fixture did not actually reach refund_requested').toBe('claimed');
  }
  return order_id;
}

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

/** 🔴 The body stream is EXPLICITLY not in objectMode: `Readable.from([string])`
 *  defaults to objectMode and the bounded reader then waits forever for bytes
 *  that never arrive. Copied verbatim from this suite's sibling, where it cost
 *  an hour once. */
function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const stream = Readable.from([Buffer.from(raw, 'utf8')], { objectMode: false });
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { authorization: 'Bearer admin-token' };
  (req as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function adminAuth(): OpsRefundReleaseRoutesDeps['auth'] {
  return {
    verifyToken: () => ({ ok: true as const, sub: ADMIN_ID }),
    getUser: () => ({ id: ADMIN_ID, is_admin: 1 }),
  } as unknown as OpsRefundReleaseRoutesDeps['auth'];
}

interface MailLog {
  settled: RefundSettledMailInput[];
  released: RefundReleasedMailInput[];
}

function mailer(mode: 'ok' | 'throws' = 'ok'): { mailer: ServiceMailer; log: MailLog } {
  const log: MailLog = { settled: [], released: [] };
  return {
    log,
    mailer: {
      id: 'test',
      async sendSetupCompleted(): Promise<void> {},
      async sendWithdrawalReceived(): Promise<void> {},
      async sendRefundSettledByHand(input): Promise<void> {
        if (mode === 'throws') throw new Error('mail server said no');
        log.settled.push(input);
      },
      async sendRefundReleased(input): Promise<void> {
        if (mode === 'throws') throw new Error('mail server said no');
        log.released.push(input);
      },
    },
  };
}

type AuditRow = Parameters<OpsRefundReleaseRoutesDeps['audit']['append']>[0];

function makeDeps(
  repo: Repo,
  over: Partial<OpsRefundReleaseRoutesDeps> = {},
): { deps: OpsRefundReleaseRoutesDeps; rows: AuditRow[]; log: MailLog } {
  const rows: AuditRow[] = [];
  const m = mailer();
  const deps: OpsRefundReleaseRoutesDeps = {
    auth: adminAuth(),
    purchases: repo,
    audit: {
      append: (input) => {
        rows.push(input);
        return rows.length;
      },
    },
    mailer: m.mailer,
    users: { findById: () => ({ id: 'u1', email: 'buyer@example.com' }) } as unknown as OpsRefundReleaseRoutesDeps['users'],
    now: () => NOW_MS,
    ...over,
  };
  return { deps, rows, log: m.log };
}

/** The rows THESE ROUTES wrote, as opposed to the ones `adminGate` wrote — two
 *  kinds in one sink, on purpose (ops-audit-trail.ts). A test that counted the
 *  sink as one number would read the gate's row as evidence that a refund was
 *  resolved. */
const businessRows = (rows: AuditRow[]): AuditRow[] => rows.filter((r) => r.target_kind === PURCHASE_TARGET_KIND);

async function call(
  deps: OpsRefundReleaseRoutesDeps,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ owned: boolean; status: number; body: Record<string, unknown> }> {
  const r = makeRes();
  const owned = tryHandleOpsRefundReleaseRoutes(makeReq(method, url, body), r.res, deps);
  for (let i = 0; i < 200 && r.status() === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { owned, status: r.status(), body: r.body() };
}

const SETTLE = '/api/ops/purchases/refund/settle';
const RELEASE = '/api/ops/purchases/refund/release';

// ─────────────────────────────────────────────────────────────────────────────

describe('§1 settle — the refund happened where we could not see it', () => {
  it('writes refunded + the reference, keeps the provider history, and tells the buyer', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps, rows, log } = makeDeps(repo);
    const res = await call(deps, 'POST', SETTLE, {
      order_id: 'ord_1',
      external_reference: 'BANK-REF-4471',
      note: 'wire confirmed by finance',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, state: 'refunded', refund_external_reference: 'BANK-REF-4471' });

    const row = repo.getOneTimePurchase('ord_1')!;
    expect(row.state).toBe('refunded');
    expect(row.refunded_at).toBe(NOW_ISO);
    expect(row.refund_external_reference).toBe('BANK-REF-4471');
    // 🔴 THE HISTORY OF WHAT WE ASKED SURVIVES. It is the whole reason anybody
    // could read this row later and tell a hand-settled refund from a
    // provider-confirmed one.
    expect(row.refund_requested_at).toBe(BOUGHT);
    // ⚠️ NOT OVERLOADED: the provider never answered, and the column still says
    // so. Writing our own word into it would destroy that distinction on
    // exactly the rows where it matters.
    expect(row.refund_status).toBeNull();

    expect(businessRows(rows)).toHaveLength(1);
    expect(businessRows(rows)[0]).toMatchObject({
      actor_user_id: ADMIN_ID,
      action: PURCHASE_REFUND_SETTLE_ACTION,
      target_id: 'ord_1',
      detail: 'wire confirmed by finance',
    });
    expect(log.settled).toHaveLength(1);
    expect(log.settled[0]).toMatchObject({ to: 'buyer@example.com', externalReference: 'BANK-REF-4471' });
  });

  it('🔴 refuses without an external reference — and the row is untouched', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps, rows } = makeDeps(repo);
    const res = await call(deps, 'POST', SETTLE, { order_id: 'ord_1', note: 'trust me' });
    expect(res.status).toBe(400);
    // The sentence has to say WHY, not just name the field: this is the one
    // route in the product that writes a claim about money on a human's word.
    expect(String(res.body.message)).toContain('external_reference required');
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refund_requested');
    // 🔴 NOTHING WAS AUDITED EITHER. A business row for an action that did not
    // happen is worse than none.
    expect(businessRows(rows)).toHaveLength(0);
  });

  it('refuses a whitespace-only reference and an over-long one', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps } = makeDeps(repo);
    expect((await call(deps, 'POST', SETTLE, { order_id: 'ord_1', external_reference: '   ', note: 'n' })).status).toBe(400);
    const long = 'x'.repeat(PURCHASE_EXTERNAL_REFERENCE_MAX + 1);
    const res = await call(deps, 'POST', SETTLE, { order_id: 'ord_1', external_reference: long, note: 'n' });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain(String(PURCHASE_EXTERNAL_REFERENCE_MAX));
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refund_requested');
  });

  it('requires a note, and caps it', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps } = makeDeps(repo);
    expect((await call(deps, 'POST', SETTLE, { order_id: 'ord_1', external_reference: 'R' })).status).toBe(400);
    const res = await call(deps, 'POST', SETTLE, {
      order_id: 'ord_1',
      external_reference: 'R',
      note: 'n'.repeat(PURCHASE_NOTE_MAX + 1),
    });
    expect(res.status).toBe(400);
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refund_requested');
  });

  it('404s an unknown order', async () => {
    const repo = makeDb();
    const { deps } = makeDeps(repo);
    const res = await call(deps, 'POST', SETTLE, { order_id: 'nope', external_reference: 'R', note: 'n' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(PURCHASE_UNKNOWN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('§2 release — the refund will not happen', () => {
  it('writes the target state and BOTH stamps, keeps the request history, and mails the buyer', async () => {
    const repo = makeDb();
    seed(repo, { scheduled_at: BOUGHT, state: 'scheduled' });
    const { deps, rows, log } = makeDeps(repo);
    const res = await call(deps, 'POST', RELEASE, {
      order_id: 'ord_1',
      to_state: 'scheduled',
      reason: 'provider_declined',
      note: 'creem returned refund_not_allowed',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      state: 'scheduled',
      refund_released_at: NOW_ISO,
      refund_release_reason: 'provider_declined',
    });

    const row = repo.getOneTimePurchase('ord_1')!;
    expect(row.state).toBe('scheduled');
    expect(row.refund_released_at).toBe(NOW_ISO);
    expect(row.refund_release_reason).toBe('provider_declined');
    // History kept: we DID ask, and that is the reason anybody is reading this.
    expect(row.refund_requested_at).toBe(BOUGHT);
    // 🔴 IT NEVER WRITES 'refunded' OR ITS DATE.
    expect(row.refunded_at).toBeNull();
    expect(row.refund_external_reference).toBeNull();

    expect(businessRows(rows)[0]).toMatchObject({
      action: PURCHASE_REFUND_RELEASE_ACTION,
      target_id: 'ord_1',
      detail: 'creem returned refund_not_allowed',
    });
    expect(log.released).toEqual([
      { to: 'buyer@example.com', orderId: 'ord_1', reason: 'provider_declined' },
    ]);
  });

  it('accepts every declared target, and only those', async () => {
    for (const target of REFUND_RELEASE_TARGETS) {
      const repo = makeDb();
      seed(repo);
      const { deps } = makeDeps(repo);
      const res = await call(deps, 'POST', RELEASE, {
        order_id: 'ord_1',
        to_state: target,
        reason: 'buyer_withdrew_request',
        note: 'n',
      });
      expect(res.status, `${target} was refused`).toBe(200);
      expect(repo.getOneTimePurchase('ord_1')!.state).toBe(target);
    }
  });

  it("🔴 refuses 'delivered' BY NAME, saying delivery is its own action", async () => {
    // The refusal that the whole design turns on. A generic
    // 「not one of: paid, scheduled, in_progress」 would leave the operator
    // believing they had misspelled a legal value — and this is the one wrong
    // value they will reach for on purpose, because the session may genuinely
    // have happened.
    const repo = makeDb();
    seed(repo);
    const { deps, rows } = makeDeps(repo);
    const res = await call(deps, 'POST', RELEASE, {
      order_id: 'ord_1',
      to_state: 'delivered',
      reason: 'buyer_withdrew_request',
      note: 'the session went ahead',
    });
    expect(res.status).toBe(400);
    const message = String(res.body.message);
    expect(message).toContain('a release cannot deliver a setup');
    // 🔴 IT NAMES THE ROUTE THAT CAN. A refusal that only says no leaves the
    // operator with a job and no way to do it.
    expect(message).toContain('/api/ops/purchases/advance');
    // …and nothing at all happened.
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refund_requested');
    expect(repo.getOneTimePurchase('ord_1')!.refund_released_at).toBeNull();
    expect(businessRows(rows)).toHaveLength(0);
  });

  it("🔴 refuses 'refunded' BY NAME, pointing at the route that requires a reference", async () => {
    const repo = makeDb();
    seed(repo);
    const { deps } = makeDeps(repo);
    const res = await call(deps, 'POST', RELEASE, {
      order_id: 'ord_1',
      to_state: 'refunded',
      reason: 'provider_declined',
      note: 'n',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('a release never writes refunded');
    expect(String(res.body.message)).toContain(SETTLE);
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refund_requested');
  });

  it("refuses 'refund_requested' BY NAME — a release has to go somewhere", async () => {
    const repo = makeDb();
    seed(repo);
    const { deps } = makeDeps(repo);
    const res = await call(deps, 'POST', RELEASE, {
      order_id: 'ord_1',
      to_state: 'refund_requested',
      reason: 'provider_declined',
      note: 'n',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('already stuck in');
  });

  it('🔴 refuses an unknown reason, and the message says the reason is not a label', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps, rows } = makeDeps(repo);
    for (const reason of [undefined, 'because', 'provider-declined', 'deadline_no_start']) {
      const res = await call(deps, 'POST', RELEASE, {
        order_id: 'ord_1',
        to_state: 'paid',
        ...(reason === undefined ? {} : { reason }),
        note: 'n',
      });
      expect(res.status, `reason=${String(reason)} was accepted`).toBe(400);
      expect(String(res.body.message)).toContain('deadline sweep');
    }
    // 🔴 'deadline_no_start' IS A REAL `RefundOrigin` AND MUST NOT BE ACCEPTED
    // HERE. An origin says why a refund was asked for; a release reason says why
    // one stopped. The two unions never merge.
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refund_requested');
    expect(businessRows(rows)).toHaveLength(0);
  });

  it('404s an unknown order', async () => {
    const repo = makeDb();
    const { deps } = makeDeps(repo);
    const res = await call(deps, 'POST', RELEASE, {
      order_id: 'nope',
      to_state: 'paid',
      reason: 'provider_declined',
      note: 'n',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(PURCHASE_UNKNOWN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('§3 🔴 only a refund that is IN FLIGHT can be resolved here', () => {
  // The 409 both routes share. Note what it protects: 'delivered' and 'paid'
  // rows have no refund to settle, and a 'refunded' row already has one — and
  // settling it again would overwrite a provider-confirmed refund with a
  // human's word about it.
  const OTHER_STATES: OneTimePurchaseState[] = ['paid', 'scheduled', 'in_progress', 'delivered', 'refunded'];

  for (const state of OTHER_STATES) {
    it(`refuses a '${state}' row with 409, on both routes, changing nothing`, async () => {
      for (const [url, body] of [
        [SETTLE, { order_id: 'ord_1', external_reference: 'R', note: 'n' }],
        [RELEASE, { order_id: 'ord_1', to_state: 'paid', reason: 'provider_declined', note: 'n' }],
      ] as const) {
        const repo = makeDb();
        seed(repo, { state, delivered_at: state === 'delivered' ? BOUGHT : null }, false);
        const { deps, rows, log } = makeDeps(repo);
        const res = await call(deps, 'POST', url, body);
        expect(res.status, `${url} on '${state}'`).toBe(409);
        expect(res.body.error).toBe(PURCHASE_TRANSITION_INVALID);
        // The message NAMES the state it found: "it is refunded already" and
        // "you clicked the wrong row" are different days' work.
        expect(String(res.body.message)).toContain(`'${state}'`);
        const row = repo.getOneTimePurchase('ord_1')!;
        expect(row.state).toBe(state);
        expect(row.refund_released_at).toBeNull();
        expect(row.refund_external_reference).toBeNull();
        expect(businessRows(rows)).toHaveLength(0);
        expect(log.settled.length + log.released.length).toBe(0);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describe('§4 the audit row goes in BEFORE the write, fail-closed', () => {
  for (const [url, body, action] of [
    [SETTLE, { order_id: 'ord_1', external_reference: 'R', note: 'n' }, PURCHASE_REFUND_SETTLE_ACTION],
    [RELEASE, { order_id: 'ord_1', to_state: 'paid', reason: 'provider_declined', note: 'n' }, PURCHASE_REFUND_RELEASE_ACTION],
  ] as const) {
    it(`${action}: a throwing sink answers 503 and leaves the purchase alone`, async () => {
      const repo = makeDb();
      seed(repo);
      const { deps, log } = makeDeps(repo, {
        audit: {
          append: (input) => {
            // The GATE's row still has to go in — this test is about the
            // BUSINESS row, and a sink that refused both would prove nothing
            // about which one the route depends on.
            if (input.target_kind === PURCHASE_TARGET_KIND) throw new Error('disk full');
            return 1;
          },
        },
      });
      const res = await call(deps, 'POST', url, body);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe(PURCHASE_NOT_RECORDED);
      const row = repo.getOneTimePurchase('ord_1')!;
      expect(row.state).toBe('refund_requested');
      expect(row.refund_released_at).toBeNull();
      expect(row.refund_external_reference).toBeNull();
      // 🔴 AND NO LETTER WENT OUT. A buyer told their refund was settled by a
      // request that changed nothing would be the worst outcome on this page.
      expect(log.settled.length + log.released.length).toBe(0);
    });
  }

  it('🔴 the append really is BEFORE the write in the source, not merely beside it', async () => {
    // The behavioural test above uses a THROWING sink. It cannot notice a route
    // that appends AFTER a successful write, because with a working sink both
    // orders look identical — and that is the order the whole fail-closed
    // argument rests on. Same structural check `ops-audit-wiring.test.ts` makes
    // of the restriction route.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'http', 'ops-refund-release-routes.ts'),
      'utf8',
    );
    for (const write of ['settleOneTimeRefundByHand(', 'releaseOneTimeRefundRequest(']) {
      const writeAt = src.indexOf('deps.purchases.' + write);
      const auditAt = src.lastIndexOf('auditFirst(res, deps, {', writeAt);
      expect(writeAt, `${write} is not called at all`).toBeGreaterThan(-1);
      expect(
        auditAt,
        `${write} runs with no auditFirst before it — write-then-append is the one state\n`
          + 'ops-audit-trail.ts forbids: a change nobody recorded, reported as success.',
      ).toBeGreaterThan(-1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('§5 mail never gates the write, and never fails silently', () => {
  it('a mail outage leaves the state change standing and says so in the response', async () => {
    const repo = makeDb();
    seed(repo);
    const m = mailer('throws');
    const { deps } = makeDeps(repo, { mailer: m.mailer });
    const res = await call(deps, 'POST', RELEASE, {
      order_id: 'ord_1',
      to_state: 'paid',
      reason: 'buyer_withdrew_request',
      note: 'n',
    });
    expect(res.status).toBe(200);
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('paid');
    // 🔴 REPORTED SEPARATELY FROM `ok`. The operator has to be able to see the
    // second fact fail while the first succeeded — otherwise nobody knows a
    // letter is owed.
    expect(res.body.notice_sent).toBe(false);
    expect(res.body.notice_failed).toBe('send_failed');
  });

  it('a deployment with no mail channel still resolves the refund, and says nobody was told', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps } = makeDeps(repo, { mailer: undefined, users: undefined });
    const res = await call(deps, 'POST', SETTLE, { order_id: 'ord_1', external_reference: 'R', note: 'n' });
    expect(res.status).toBe(200);
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refunded');
    expect(res.body.notice_sent).toBe(false);
    expect(res.body.notice_failed).toBe('no_mail_channel');
  });

  it("an 'unmapped' purchase (no account) is not a crash and not a cheerful notified", async () => {
    const repo = makeDb();
    seed(repo, { user_id: null });
    const { deps } = makeDeps(repo);
    const res = await call(deps, 'POST', RELEASE, {
      order_id: 'ord_1',
      to_state: 'paid',
      reason: 'provider_declined',
      note: 'n',
    });
    expect(res.status).toBe(200);
    expect(res.body.notice_sent).toBe(false);
    expect(res.body.notice_failed).toBe('no_address');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('§6 registration', () => {
  it('both routes are declared admin-gated AND declared mutating', () => {
    // 🔴 THE SECOND HALF IS THE ONE THAT COSTS SOMETHING. An entry in
    // MUTATING_ADMIN_GATED_ROUTES is a CLAIM that the route writes its own
    // business row fail-closed rather than leaning on the gate's
    // serve-but-shout policy — which §4 above is the proof of.
    for (const r of [PURCHASES_REFUND_SETTLE_ROUTE, PURCHASES_REFUND_RELEASE_ROUTE]) {
      expect(ADMIN_GATED_ROUTES).toContain(r);
      expect(MUTATING_ADMIN_GATED_ROUTES).toContain(r);
    }
  });

  it('the handler does not own a path it does not serve', async () => {
    const repo = makeDb();
    const { deps } = makeDeps(repo);
    const r = makeRes();
    expect(tryHandleOpsRefundReleaseRoutes(makeReq('POST', '/api/ops/purchases/advance', {}), r.res, deps)).toBe(false);
    expect((await call(deps, 'GET', SETTLE)).owned).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('§7 🔴 2026-09-02 audit P3 — a race the write LOSES must not leave the trail saying it won', () => {
  // 🔴 THIS IS A DIFFERENT GAP FROM §3. §3 seeds the row already OUT of
  // 'refund_requested' before the request even starts, so `loadRequestedRefund`
  // catches it before `auditFirst` ever runs and zero business rows are
  // written — that path was never broken. The real gap sits BETWEEN
  // `loadRequestedRefund`'s read and the atomic write a few lines later: a row
  // that reads 'refund_requested' at the pre-check can still move before the
  // UPDATE runs. `getOneTimePurchase` is overridden here to move the row via a
  // SEPARATE, REAL call to `releaseOneTimeRefundRequest` at the exact moment
  // `loadRequestedRefund` reads it and still return the pre-check's own
  // reading — the same "mutate from inside the read" technique
  // service-refund-action.test.ts §1 uses to pin an ordering, pointed at the
  // opposite ordering bug.
  function raceInsideThePrecheck(repo: Repo, mutate: () => void): OpsRefundReleaseRoutesDeps['purchases'] {
    let raced = false;
    return {
      getOneTimePurchase: (orderId: string) => {
        const row = repo.getOneTimePurchase(orderId);
        if (!raced && row !== null && row.state === 'refund_requested') {
          raced = true;
          mutate();
        }
        return row;
      },
      settleOneTimeRefundByHand: repo.settleOneTimeRefundByHand,
      releaseOneTimeRefundRequest: repo.releaseOneTimeRefundRequest,
    };
  }

  it('settle: the racer\'s release wins, the settle 409s, and the trail gets a second row saying so', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps, rows } = makeDeps(repo, {
      purchases: raceInsideThePrecheck(repo, () => {
        repo.releaseOneTimeRefundRequest(
          'ord_1',
          { to_state: 'paid', reason: 'provider_declined', released_at: NOW_ISO },
          NOW_ISO,
        );
      }),
    });
    const res = await call(deps, 'POST', SETTLE, { order_id: 'ord_1', external_reference: 'R', note: 'n' });
    expect(res.status).toBe(409);
    // The racer's write stands — this route changed NOTHING of its own.
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('paid');
    expect(repo.getOneTimePurchase('ord_1')!.refund_external_reference).toBeNull();

    const business = businessRows(rows);
    expect(business).toHaveLength(2);
    // 🔴 THE FIRST ROW IS NOT DELETED OR REWRITTEN — it is exactly what
    // `auditFirst` wrote before the race was known about.
    expect(business[0]).toMatchObject({ action: PURCHASE_REFUND_SETTLE_ACTION, target_id: 'ord_1' });
    // 🔴 THE SECOND ROW IS WHAT THIS FIX ADDS: its own action name (never the
    // first row's action with a 'no_change' buried in `detail` — that would be
    // one value answering two questions again), naming the same order.
    expect(business[1]).toMatchObject({
      action: PURCHASE_REFUND_SETTLE_NOT_APPLIED_ACTION,
      target_id: 'ord_1',
    });
    expect(String(business[1]!.detail)).toContain('did not take effect');
  });

  it('release: the racer\'s settle wins, the release 409s, and the trail gets a second row saying so', async () => {
    const repo = makeDb();
    seed(repo);
    const { deps, rows } = makeDeps(repo, {
      purchases: raceInsideThePrecheck(repo, () => {
        repo.settleOneTimeRefundByHand(
          'ord_1',
          { refunded_at: NOW_ISO, external_reference: 'RACER-REF' },
          NOW_ISO,
        );
      }),
    });
    const res = await call(deps, 'POST', RELEASE, {
      order_id: 'ord_1',
      to_state: 'paid',
      reason: 'provider_declined',
      note: 'n',
    });
    expect(res.status).toBe(409);
    // The racer's write stands — the row is 'refunded', not released back.
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refunded');
    expect(repo.getOneTimePurchase('ord_1')!.refund_external_reference).toBe('RACER-REF');
    expect(repo.getOneTimePurchase('ord_1')!.refund_released_at).toBeNull();

    const business = businessRows(rows);
    expect(business).toHaveLength(2);
    expect(business[0]).toMatchObject({ action: PURCHASE_REFUND_RELEASE_ACTION, target_id: 'ord_1' });
    expect(business[1]).toMatchObject({
      action: PURCHASE_REFUND_RELEASE_NOT_APPLIED_ACTION,
      target_id: 'ord_1',
    });
    expect(String(business[1]!.detail)).toContain('did not take effect');
  });
});
