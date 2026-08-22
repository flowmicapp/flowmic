// D1 §6.2 — GET /api/cloud/billing/events, the reconciliation ledger read, and
// the widened GET /api/cloud/subscription payload.
//
// SPEC-REF: docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §6.1 (PlanView),
//           §6.2 (both routes; saas-only, Bearer, only the caller's own rows)
//
// WHY THIS FILE DRIVES `tryHandleConsoleRoutes` DIRECTLY instead of booting a
// server like console-routes.test.ts does: the deps are assembled here, in the
// test, from real repos and a real AuthService — so what is proven is THIS
// route's behaviour and not bootstrap's wiring, which lane C owns and is editing
// in the same window. The Bearer path is the real one (real HS256 sign +
// verify), because the whole point of the reverse control below is that the
// user id comes from a VERIFIED token and from nowhere else.
//
// ⚠️ The bootstrap wiring of `billingLedger` is therefore NOT proven here.
// That is a real gap, named on purpose rather than papered over: until
// bootstrap passes `billingLedger: db.billing` into `console: {…}`, this route
// exists and is unreachable in production. See the handoff note in the round
// report.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { BillingService } from '../src/billing/billing-service';
import { tryHandleConsoleRoutes, type ConsoleRoutesDeps } from '../src/http/console-routes';
import { unconfiguredPasswordResetMailer } from '../src/mail';

const SECRET = 'billing-events-secret-32-bytes-min-xxxx';
const NOW = Date.parse('2026-08-01T00:00:00.000Z');

let db: DbConnection;
let auth: AuthService;
let server: Server;
let url: string;

function makeDeps(): ConsoleRoutesDeps {
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
    billingLedger: db.billing,
    // 0.2.48 — the REAL audit repo off the same connection, not a stub. The admin
    // gate now appends a row per gate outcome, and handing it a no-op would make
    // this file's /billing/orphans cases pass while proving nothing about the
    // append actually working against the real table (the 「a DI default must not be a friendly
    // empty implementation」 rule applies to tests too — a fake here would hide a real INSERT
    // failure behind a green suite).
    opsAudit: db.opsAudit,
    pcs: db.pcs,
    mobiles: db.mobiles,
    settings: db.settings,
    // 0.3.0 P4 — required by ConsoleRoutesDeps since account delete/export
    // landed. Real repos off the same connection (a stub would be a friendly
    // empty), even though nothing in THIS file's cases reaches them.
    users: db.users,
    usage: db.usage,
    passwordLimiter: new RegisterRateLimiter(),
    // VERIFY-1 — this suite's subject is not the verification gate, so its
    // accounts are held verified by a stub reader (the gate itself — refusal,
    // admit, grandfather, real bootstrap wiring — is proven end-to-end in
    // test/email-verification.test.ts against db.emailVerification).
    verifiedEmail: { emailVerifiedAt: () => NOW },
    // MAIL-1 — required by ConsoleRoutesDeps since the password-reset surface got
    // a delivery leg. This suite never drives /api/password/*, so it takes the
    // loudly-failing mailer rather than a fake that would suggest it does: if a
    // case here ever reaches that route, it fails BY NAME instead of quietly
    // passing (src/mail/unconfigured.ts).
    mail: unconfiguredPasswordResetMailer(),
    now: () => NOW,
  };
}

/** Register a real account and mint a real Bearer for it. */
async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'T' });
  return { id: user.id, bearer: { authorization: `Bearer ${auth.issueToken(user).token}` } };
}

/** Same, but with `users.is_admin = 1`. Inserted through the repo (the ONLY
 *  writer of that column) rather than by UPDATE, so the flag under test is the
 *  real one the route reads. */
function adminAccount(email: string): { id: string; bearer: Record<string, string> } {
  const user = db.users.insert({ id: `u_admin_${email}`, email, display_name: 'Admin', is_admin: true });
  return { id: user.id, bearer: { authorization: `Bearer ${auth.issueToken(user).token}` } };
}

/** Write ONE finished `billing_events` row exactly the way lane C's handler will
 *  (claim first, then finish) — no direct SQL, so the ledger's own invariants
 *  are exercised rather than bypassed. */
function ledgerRow(userId: string, eventId: string, receivedAt: string, outcome: 'applied' | 'unmapped'): void {
  db.billing.claimEvent({
    event_id: eventId,
    notification_id: `ntf_${eventId}`,
    event_type: 'subscription.activated',
    occurred_at: receivedAt,
    received_at: receivedAt,
  });
  db.billing.finishEvent(eventId, { user_id: userId, subscription_id: 'sub_x', outcome, detail: 'test row' });
}

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(async () => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  const deps = makeDeps();
  server = createServer((req, res) => {
    if (tryHandleConsoleRoutes(req, res, deps)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('D1 §6.2 — GET /api/cloud/billing/events', () => {
  it('no Bearer → 401, and the body names the reason (no silent empty list)', async () => {
    // 🔴 An unauthenticated caller must NOT get `{events: []}`: an empty list is
    // an ANSWER, and answering 「you have no billing events」 to someone who never proved
    // who they are is both a lie and an oracle.
    const r = await get('/api/cloud/billing/events');
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('an account with no events gets an explicit empty list, not a 404', async () => {
    const a = await account('empty@b.co');
    const r = await get('/api/cloud/billing/events', a.bearer);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ events: [] });
  });

  it('returns this account‘s rows, newest first, with the outcome intact', async () => {
    const a = await account('rows@b.co');
    ledgerRow(a.id, 'evt_old', '2026-07-30T00:00:00.000Z', 'applied');
    ledgerRow(a.id, 'evt_new', '2026-07-31T00:00:00.000Z', 'unmapped');
    const r = await get('/api/cloud/billing/events', a.bearer);
    expect(r.status).toBe(200);
    expect(r.json.events.map((e: { event_id: string }) => e.event_id)).toEqual(['evt_new', 'evt_old']);
    expect(r.json.events[0]).toMatchObject({
      event_id: 'evt_new',
      event_type: 'subscription.activated',
      outcome: 'unmapped',
      user_id: a.id,
    });
  });

  // ── 🔴 REVERSE CONTROL ────────────────────────────────────────────────────
  it("B's token cannot read A's ledger rows — and B's OWN row proves the probe works", async () => {
    const a = await account('victim@b.co');
    const b = await account('attacker@b.co');
    ledgerRow(a.id, 'evt_a1', '2026-07-31T00:00:00.000Z', 'applied');
    ledgerRow(a.id, 'evt_a2', '2026-07-31T01:00:00.000Z', 'applied');
    ledgerRow(b.id, 'evt_b1', '2026-07-31T02:00:00.000Z', 'applied');

    const asB = await get('/api/cloud/billing/events', b.bearer);
    expect(asB.status).toBe(200);
    const ids = asB.json.events.map((e: { event_id: string }) => e.event_id);
    // The negative half: not one of A's rows, and not one of A's ids anywhere in
    // the serialized body (a nested echo would slip past an id-list assertion).
    expect(ids).not.toContain('evt_a1');
    expect(ids).not.toContain('evt_a2');
    expect(JSON.stringify(asB.json)).not.toContain(a.id);
    // The positive half: the probe is not simply blind — B sees B's own row.
    expect(ids).toEqual(['evt_b1']);
    // ...and A still sees both of hers, so nothing was actually deleted.
    const asA = await get('/api/cloud/billing/events', a.bearer);
    expect(asA.json.events).toHaveLength(2);
  });

  it('?limit=N is honoured, and junk / out-of-range fails LOUD instead of defaulting', async () => {
    const a = await account('limits@b.co');
    ledgerRow(a.id, 'evt_1', '2026-07-31T00:00:00.000Z', 'applied');
    ledgerRow(a.id, 'evt_2', '2026-07-31T01:00:00.000Z', 'applied');
    expect((await get('/api/cloud/billing/events?limit=1', a.bearer)).json.events).toHaveLength(1);
    expect((await get('/api/cloud/billing/events?limit=2', a.bearer)).json.events).toHaveLength(2);
    // A caller that asked for `limit=abc` and silently got the default would
    // believe it asked for the default — 「configured but not in effect」 in one request.
    for (const bad of ['abc', '0', '-1', '1.5', '101']) {
      const r = await get(`/api/cloud/billing/events?limit=${bad}`, a.bearer);
      expect(r.status, `limit=${bad}`).toBe(400);
      expect(r.json.error, `limit=${bad}`).toBe('SETTINGS_SCHEMA_INVALID');
    }
  });

  it('a path that merely STARTS with the route is not claimed by it', async () => {
    // Guards the `startsWith` match: `/api/cloud/billing/eventsomething` must
    // fall through to the router's 404, not be answered by this handler.
    const a = await account('prefix@b.co');
    expect((await get('/api/cloud/billing/eventsomething', a.bearer)).status).toBe(404);
  });
});

// ── 0.2.38 — GET /api/cloud/billing/orphans ─────────────────────────────────
//
// WHY THIS ROUTE EXISTS AT ALL: `listEventsForUser` is `WHERE user_id = ?`, and
// `claimEvent` does not write `user_id`. So a row that never reached
// `finishEvent` — the process died mid-handler — carries NULL there and is
// invisible to every per-user surface FOREVER. Same for an event we took money
// for and could not map to an account. `billing.repo.ts` documented a 「reconciliation view」
// that would show exactly those rows; nothing implemented it until now (rule ④).
describe('0.2.38 — GET /api/cloud/billing/orphans (ops surface)', () => {
  /** A row claimed and never finished — the 「the process died mid-handler」 shape. user_id stays
   *  NULL because claimEvent does not write it, which is the whole point. */
  function pendingRow(eventId: string, receivedAt: string): void {
    db.billing.claimEvent({
      event_id: eventId,
      notification_id: `ntf_${eventId}`,
      event_type: 'subscription.activated',
      occurred_at: receivedAt,
      received_at: receivedAt,
    });
  }
  /** A finished row we could NOT map to an account — 「the money arrived, we do not know who to credit」. */
  function unmappedRow(eventId: string, receivedAt: string): void {
    pendingRow(eventId, receivedAt);
    db.billing.finishEvent(eventId, { outcome: 'unmapped', detail: 'price_id pri_unknown not configured' });
  }

  it('no Bearer → 401 by name (an ops read is not public)', async () => {
    const r = await get('/api/cloud/billing/orphans');
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('AUTH_TOKEN_INVALID');
  });

  // ── 🔴 REVERSE CONTROL: 「you do not have permission」 must not be spelled 「there are no such rows」 ──────────
  it('a NON-admin account gets 403 ADMIN_ONLY — never a 200 with an empty list', async () => {
    const normal = await account('normal@b.co');
    pendingRow('evt_orphan_rc', '2026-07-31T00:00:00.000Z');

    const r = await get('/api/cloud/billing/orphans', normal.bearer);
    // The negative half: refused, by name, with a status that says WHY.
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('ADMIN_ONLY');
    // ...and not one ledger field leaked into the refusal body.
    expect(JSON.stringify(r.json)).not.toContain('evt_orphan_rc');
    // 🔴 The POSITIVE half, in the SAME test: an admin asking the SAME question
    // against the SAME db gets the row. Without this, the 403 above could just as
    // well mean 「the route was never mounted」 or 「the table is empty」 — a refusal proves nothing unless
    // something else is proven to succeed.
    const admin = adminAccount('admin-rc@b.co');
    const asAdmin = await get('/api/cloud/billing/orphans', admin.bearer);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.json.orphans.map((e: { event_id: string }) => e.event_id)).toContain('evt_orphan_rc');
  });

  it('an admin sees BOTH orphan shapes: a pending row and an unmapped row', async () => {
    const admin = adminAccount('admin-both@b.co');
    pendingRow('evt_pending', '2026-07-30T00:00:00.000Z');
    unmappedRow('evt_unmapped', '2026-07-31T00:00:00.000Z');
    // A normal, fully-resolved row must NOT be in the list — otherwise 「orphan」
    // would just mean 「every row」 and the view would be useless the day it matters.
    const a = await account('resolved@b.co');
    ledgerRow(a.id, 'evt_applied', '2026-07-31T12:00:00.000Z', 'applied');

    const r = await get('/api/cloud/billing/orphans', admin.bearer);
    expect(r.status).toBe(200);
    const ids = r.json.orphans.map((e: { event_id: string }) => e.event_id);
    // newest first, same ordering contract as /events
    expect(ids).toEqual(['evt_unmapped', 'evt_pending']);
    expect(ids).not.toContain('evt_applied');
    expect(r.json.orphans[0]).toMatchObject({ event_id: 'evt_unmapped', outcome: 'unmapped', user_id: null });
    expect(r.json.orphans[1]).toMatchObject({ event_id: 'evt_pending', outcome: 'pending', user_id: null });
  });

  it("an 'unmapped' row that DID get a user attached still counts as unresolved", async () => {
    // The OR in the WHERE clause is not redundant: this row has a user_id, so
    // `user_id IS NULL` alone would drop it — and it is still money we have not
    // resolved.
    const admin = adminAccount('admin-or@b.co');
    const a = await account('has-user@b.co');
    ledgerRow(a.id, 'evt_unmapped_with_user', '2026-07-31T00:00:00.000Z', 'unmapped');
    const r = await get('/api/cloud/billing/orphans', admin.bearer);
    expect(r.json.orphans.map((e: { event_id: string }) => e.event_id)).toEqual(['evt_unmapped_with_user']);
  });

  it('?limit= shares ONE parser with /events — junk fails loud here too', async () => {
    const admin = adminAccount('admin-limit@b.co');
    pendingRow('evt_l1', '2026-07-31T00:00:00.000Z');
    pendingRow('evt_l2', '2026-07-31T01:00:00.000Z');
    expect((await get('/api/cloud/billing/orphans?limit=1', admin.bearer)).json.orphans).toHaveLength(1);
    expect((await get('/api/cloud/billing/orphans?limit=2', admin.bearer)).json.orphans).toHaveLength(2);
    for (const bad of ['abc', '0', '-1', '1.5', '101']) {
      const r = await get(`/api/cloud/billing/orphans?limit=${bad}`, admin.bearer);
      expect(r.status, `limit=${bad}`).toBe(400);
      expect(r.json.error, `limit=${bad}`).toBe('SETTINGS_SCHEMA_INVALID');
    }
  });

  it('a path that merely STARTS with the route is not claimed by it', async () => {
    const admin = adminAccount('admin-prefix@b.co');
    expect((await get('/api/cloud/billing/orphansomething', admin.bearer)).status).toBe(404);
  });
});

describe('D1 §6.1 — GET /api/cloud/subscription carries the widened PlanView', () => {
  it('a fresh account: plan free, source none, quota_exempt false', async () => {
    const a = await account('fresh@b.co');
    const r = await get('/api/cloud/subscription', a.bearer);
    expect(r.status).toBe(200);
    // 🔴 An OBJECT, and it has always been one. The web console declared this as
    // a string and rendered every account as Free for it (D1 §2).
    expect(typeof r.json.subscription).toBe('object');
    expect(r.json.subscription).toMatchObject({
      plan: 'free',
      source: 'none',
      quota_exempt: false,
      paddle_subscription_id: null,
    });
  });

  it('a permanent_free account reads as free + permanent_free + exempt', async () => {
    const a = await account('exempt@b.co');
    db.users.setPermanentFree(a.id, true);
    const r = await get('/api/cloud/subscription', a.bearer);
    expect(r.json.subscription).toMatchObject({
      plan: 'free',
      source: 'permanent_free',
      quota_exempt: true,
    });
  });

  it('a paddle subscriber reads as its tier + paddle + the sub id', async () => {
    const a = await account('payer@b.co');
    const iso = new Date(NOW).toISOString();
    db.billing.upsertSubscription({
      subscription_id: 'sub_live01',
      user_id: a.id,
      customer_id: 'ctm_1',
      status: 'active',
      tier: 'max',
      price_id: 'pri_max',
      cycle: 'monthly',
      current_period_end: new Date(NOW + 30 * 86_400_000).toISOString(),
      canceled_at: null,
      scheduled_change_action: null,
      scheduled_change_at: null,
      next_billed_at: null,
      contract_concluded_at: null,
      last_event_id: 'evt_live01',
      last_occurred_at: iso,
      created_at: iso,
      updated_at: iso,
    });
    const r = await get('/api/cloud/subscription', a.bearer);
    expect(r.json.subscription).toMatchObject({
      plan: 'max',
      source: 'paddle',
      state: 'active',
      cycle: 'monthly',
      paddle_subscription_id: 'sub_live01',
    });
  });

  it('no Bearer → 401 (the plan read-out is not public either)', async () => {
    expect((await get('/api/cloud/subscription')).status).toBe(401);
  });
});
