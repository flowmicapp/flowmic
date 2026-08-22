// 0.3.0 P4 — account deletion + account data export (GDPR hard requirement).
//
// SPEC-REF: src/http/account-lifecycle.ts (the two operations, and every
//             exclusion they make)
//           src/http/console-routes.ts (POST /api/account/delete,
//             GET /api/account/export)
//           src/db/schema.ts (the ON DELETE CASCADE graph this file re-derives)
//           docs/legal/privacy-policy.md 「Your rights」 — the sentences this file
//             exists to keep true: 「export it in a portable format」 and
//             「Deleting your account removes your user record, and the database
//             cascades that deletion to your devices, settings, usage rows, and
//             stored records」
//           *** HUMAN-AUDIT SENSITIVE (auth: irreversible destruction) ***
//
// WHY THIS FILE DRIVES `tryHandleConsoleRoutes` DIRECTLY rather than booting the
// server (the precedent and the argument are billing-events-route.test.ts's):
// the two routes need two repos `ConsoleRoutesDeps` did not carry before this
// card (`users`, `usage`), and bootstrap.ts belongs to another lane this window.
// So the deps are assembled HERE from REAL repos over a REAL SQLite connection
// with FK enforcement on, a REAL AuthService (real HS256 sign+verify), and a real
// node:http server.
//
// 🔴 WHAT IS THEREFORE **NOT** PROVEN HERE, named rather than papered over:
// bootstrap's wiring. Until `console: {…}` in bootstrap.ts carries
// `users: db.users` and `usage: db.usage`, these two routes exist and are
// unreachable in production — `tsc --noEmit` says so at that object literal, and
// that compile error IS the wiring request. Everything below is [unit-test proven];
// [wired] is the orchestrator's two lines.
//
// ⚠️ THE ASSERTION STYLE OF THE CASCADE CASES. Every 「this table is empty
// afterwards」 is preceded by 「this table has N > 0 rows beforehand」, measured
// through the same query. A post-condition of zero, on its own, is equally
// satisfied by a table that was never populated, by a typo in the table name and
// by a query keyed on the wrong user — three ways for the probe to be blind. The
// two retained tables are the positive control for the whole set: the SAME query
// shape, against the SAME user id, finds rows after the delete.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { BillingService } from '../src/billing/billing-service';
import { authMiddleware, type TokenLookup } from '../src/auth/middleware';
import { newToken } from '../src/auth/token';
// The single-user id bootstrap folds a NULL pairing user_id onto. Imported (not
// retyped as 'default') so this test's token lookup cannot drift from the real
// one — the CONSTANT is all that is taken from bootstrap; no server is booted.
import { STANDALONE_USER_ID } from '../src/bootstrap';
import { tryHandleConsoleRoutes, type ConsoleRoutesDeps } from '../src/http/console-routes';
import { unconfiguredPasswordResetMailer } from '../src/mail';
import {
  ACCOUNT_EXPORT_SCHEMA,
  USER_CASCADING_TABLES,
  USER_RETAINED_TABLES,
  buildAccountExport,
  checkDeleteConfirmation,
  deleteAccount,
} from '../src/http/account-lifecycle';

const SECRET = 'account-lifecycle-secret-32-bytes-xxxx';
const NOW = Date.parse('2026-08-04T00:00:00.000Z');

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
    opsAudit: db.opsAudit,
    pcs: db.pcs,
    mobiles: db.mobiles,
    settings: db.settings,
    // The two deps this card adds. Real repos off the same connection — a stub
    // here would let every cascade assertion below pass against a fake delete.
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

beforeEach(async () => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('account-lifecycle-key-32-bytes-or-more') });
  const deps = makeDeps();
  server = createServer((req, res) => {
    if (!tryHandleConsoleRoutes(req, res, deps)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text || 'null') };
}
async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`${url}${path}`, { headers });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text || 'null') };
}

interface Seeded {
  id: string;
  email: string;
  bearer: Record<string, string>;
  pcId: string;
  deviceToken: string;
  pairingId: string;
  mobileToken: string;
  /** A pairing whose `user_id` is NULL — it can only die through the CHAINED
   *  cascade (pc_devices → mobile_pairings), never through its own user FK. */
  orphanPairingId: string;
  apiKey: string;
}

/**
 * One fully-populated account: a PC, two pairings (one of them with a NULL
 * user_id), settings including a BYOK api_key and a live password-reset token,
 * two months of usage, a timeline blob, a blind-store keymeta row (SALT-1),
 * a web-preview grant row (GRANT-1), a paddle subscription, and one
 * billing_events row.
 *
 * Written through the REPOS, not raw SQL, so what is destroyed later is what the
 * product actually creates (the encryption envelope, the FK values, the e2e:v1:
 * prefix guard are all exercised on the way in).
 */
async function seedAccount(email: string): Promise<Seeded> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'Seed' });
  const deviceToken = newToken();
  const mobileToken = newToken();
  const orphanToken = newToken();
  const pcId = `pc-${user.id}`;
  db.pcs.insert({
    id: pcId,
    user_id: user.id,
    device_name: 'Seed PC',
    device_token: deviceToken,
    room_uuid: `room-${user.id}`,
    short_code: '1234',
    machine_uid: 'machine-uid-seed',
  });
  const pairingId = `pair-${user.id}`;
  db.mobiles.insert({ id: pairingId, user_id: user.id, pc_device_id: pcId, mobile_token: mobileToken, mobile_name: 'Seed Phone' });
  const orphanPairingId = `pair-null-${user.id}`;
  db.mobiles.insert({ id: orphanPairingId, user_id: null, pc_device_id: pcId, mobile_token: orphanToken, mobile_name: 'Legacy Phone' });
  const apiKey = `sk-live-${user.id}`;
  db.settings.write(user.id, 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: apiKey }]);
  db.settings.write(user.id, 'account.password_reset', { reset_token: `reset-${user.id}`, expires_at: '2099-01-01T00:00:00.000Z' });
  db.usage.increment(user.id, '2026-07', { stt_minutes: 5, llm_tokens_in: 10, llm_tokens_out: 20 });
  db.usage.increment(user.id, '2026-08', { stt_minutes: 1.5, llm_tokens_in: 2, llm_tokens_out: 3 });
  // A2-5 / REQ-12-08: one per-event usage row — through the repo, like the rest,
  // so the cascade is tested against a row the meter really writes. This is the
  // one leftover a delete census must not miss: a per-utterance record of a
  // person who asked to be erased.
  db.usageEvents.append({ user_id: user.id, occurred_at: NOW, kind: 'stt', stt_ms: 1_200, outcome: 'ok' });
  db.timeline.push(user.id, [{ id: `blob-${user.id}`, ciphertext: 'e2e:v1:opaque', created_at: NOW, schema_ver: 1 }]);
  // SALT-1: the blind-store key metadata row — through the repo, like everything
  // else here, so the 16-byte-salt validation is exercised on the way in.
  db.timelineKeymeta.putFirstWriter(user.id, Buffer.from('0123456789abcdef', 'utf8').toString('base64'), 'e2e:v1:sentinel');
  // GRANT-1: a web-preview grant authorization row — through the repo, so the
  // supersede-then-insert write path is what populates the table here too.
  db.timelineGrants.create({ gid: `grant-${user.id}`, user_id: user.id, origin: 'https://app.flowmic.test', expires_at: NOW + 3_600_000 });
  // VERIFY-1: a pending email-verification code — through the repo, so what the
  // cascade destroys is a row the product actually writes (hash at rest, never
  // the code).
  db.emailVerification.putCode(user.id, 'a'.repeat(64), NOW + 900_000, NOW);
  db.billing.upsertSubscription({
    subscription_id: `sub_${user.id}`,
    user_id: user.id,
    customer_id: 'ctm_1',
    status: 'active',
    tier: 'pro',
    price_id: 'pri_1',
    cycle: 'monthly',
    current_period_end: '2099-01-01T00:00:00.000Z',
    canceled_at: null,
    scheduled_change_action: null,
    scheduled_change_at: null,
    next_billed_at: null,
    contract_concluded_at: null,
    last_event_id: `evt_${user.id}`,
    last_occurred_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  });
  // 0.3.25 B3 — a refund record, so the cascade assertion for this table is
  // measuring a real row rather than an empty table agreeing with itself.
  db.billing.recordRefundRequest({
    id: `rfd_${user.id}`,
    user_id: user.id,
    subscription_id: `sub_${user.id}`,
    transaction_id: 'txn_1',
    kind: 'statutory_withdrawal',
    state: 'submitted',
    amount_minor: 600,
    currency: 'USD',
    paddle_adjustment_id: 'adj_1',
    paddle_status: 'pending_approval',
    detail: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  db.billing.claimEvent({
    event_id: `evt_${user.id}`,
    notification_id: `ntf_${user.id}`,
    event_type: 'subscription.activated',
    occurred_at: '2026-08-01T00:00:00.000Z',
    received_at: '2026-08-01T00:00:00.000Z',
  });
  db.billing.finishEvent(`evt_${user.id}`, { user_id: user.id, subscription_id: `sub_${user.id}`, outcome: 'applied' });
  db.opsAudit.append({ actor_user_id: user.id, action: 'ops.admin.granted', target_kind: 'route', target_id: 'GET /api/cloud/billing/orphans' });
  // site_daily_counts: one platform-wide bucket, so the retained-tables positive
  // control has a row to find. Deliberately carries NOTHING of this account —
  // that is the table's design and exactly why deletion must leave it alone.
  db.siteCounts.bump({ day: '2026-08-15', kind: 'register_ok', dim: '_', dim_value: '_' });
  return {
    id: user.id,
    email,
    bearer: { authorization: `Bearer ${auth.issueToken(user).token}` },
    pcId,
    deviceToken,
    pairingId,
    mobileToken,
    orphanPairingId,
    apiKey,
  };
}

/** Rows this user owns in one table, counted through the column that names them.
 *  ONE query shape for every table, so a table that comes back 0 and a table that
 *  comes back 3 are answering the same question. */
function rowsFor(table: string, column: string, userId: string): number {
  const r = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(userId) as { n: number | bigint };
  return Number(r.n);
}

/** The user-scoped column of every table in the schema. `mobile_pairings` is
 *  counted through its PC, not through its own nullable `user_id` — otherwise the
 *  NULL-user_id row would be invisible to the very assertion that exists for it. */
function countsFor(userId: string, pcId: string): Record<string, number> {
  return {
    users: rowsFor('users', 'id', userId),
    pc_devices: rowsFor('pc_devices', 'user_id', userId),
    mobile_pairings: rowsFor('mobile_pairings', 'pc_device_id', pcId),
    user_settings: rowsFor('user_settings', 'user_id', userId),
    usage_records: rowsFor('usage_records', 'user_id', userId),
    usage_events: rowsFor('usage_events', 'user_id', userId),
    timeline_blobs: rowsFor('timeline_blobs', 'user_id', userId),
    timeline_keymeta: rowsFor('timeline_keymeta', 'user_id', userId),
    timeline_grants: rowsFor('timeline_grants', 'user_id', userId),
    paddle_subscriptions: rowsFor('paddle_subscriptions', 'user_id', userId),
    // 0.3.25 B3 — refund records. Counted per-account because it HAS a user_id
    // and cascades, which is the opposite arrangement from the tombstone table
    // below; both are listed so the contrast stays visible to a reader.
    refund_requests: rowsFor('refund_requests', 'user_id', userId),
    email_verifications: rowsFor('email_verifications', 'user_id', userId),
    billing_events: rowsFor('billing_events', 'user_id', userId),
    ops_audit_log: rowsFor('ops_audit_log', 'actor_user_id', userId),
    // site_daily_counts carries NO account column at all (that is its privacy
    // design), so its 「retained」 probe is table-wide: the whole point is that
    // an account deletion cannot even NAME rows here to sweep.
    site_daily_counts: (db.raw.prepare('SELECT COUNT(*) AS n FROM site_daily_counts').get() as { n: number }).n,
    // 0.3.25 B1 (card D-2). Table-wide like site_daily_counts above, but for the
    // opposite reason: this table has no account column because the account it
    // refers to no longer exists by the time a row is written.
    paddle_subscription_tombstones: (
      db.raw.prepare('SELECT COUNT(*) AS n FROM paddle_subscription_tombstones').get() as { n: number }
    ).n,
  };
}

/** 🔴 The one retained table whose rows the deletion CREATES rather than spares.
 *  Every other entry in USER_RETAINED_TABLES must be non-empty BEFORE the delete
 *  for the 「it survived」 assertion to mean anything; for this one the honest
 *  expectation is the reverse — empty before, non-empty after — so it is
 *  excluded from the before-probe BY NAME and asserted separately below. */
const TOMBSTONES = 'paddle_subscription_tombstones';

function deleteBody(who: Seeded, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { confirm: 'DELETE', confirm_user_id: who.id, ...over };
}

// ── ① The cascade inventory is DERIVED FROM THE LIVE SCHEMA, not from a list ──
describe('cascade inventory — the constant and the DDL are forced to agree', () => {
  it('🔴 every table with an FK to users cascades, and the two that do not are named', () => {
    const tables = (
      db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    // The scanner must actually see the schema — a probe that found no tables
    // would make every assertion below vacuously true.
    expect(tables).toContain('users');
    // Sixteen since refund_requests (0.3.25 B3 §8c); fifteen since
    // paddle_subscription_tombstones (0.3.25 B1, card D-2). The number is pinned
    // rather than derived on purpose — it is what makes ADDING a table a
    // decision that passes through this census instead of past it.
    expect(tables.length).toBe(16);

    const cascading: string[] = [];
    const noUserFk: string[] = [];
    for (const t of tables) {
      if (t === 'users') continue;
      const fks = db.raw.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string; on_delete: string }[];
      const toUsers = fks.filter((f) => f.table === 'users');
      if (toUsers.length === 0) {
        noUserFk.push(t);
        continue;
      }
      // 🔴 An FK that is NOT `ON DELETE CASCADE` would be the worst of the three
      // states: deletion would throw a constraint error at runtime, i.e. the
      // account could not be deleted at all.
      for (const f of toUsers) {
        expect(f.on_delete, `${t}.user_id references users with ON DELETE ${f.on_delete}`).toBe('CASCADE');
      }
      cascading.push(t);
    }
    expect(cascading.sort()).toEqual([...USER_CASCADING_TABLES]);
    expect(noUserFk.sort()).toEqual([...USER_RETAINED_TABLES]);
  });

  it('foreign keys are actually ENFORCED on this connection (cascade is not decoration)', () => {
    // ON DELETE CASCADE in the DDL does nothing at all with `PRAGMA
    // foreign_keys = OFF`, which is SQLite's default per connection. This asserts
    // the connection db/connection.ts opens has them on — without it, every
    // cascade assertion in this file would be measuring the schema's INTENTION.
    const row = db.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(Number(row.foreign_keys)).toBe(1);
  });
});

// ── ② EXPORT ────────────────────────────────────────────────────────────────
describe('GET /api/account/export', () => {
  it('returns the account, devices, pairings, settings and monthly usage', async () => {
    const a = await seedAccount('exp@b.co');
    const { status, json } = await get('/api/account/export', a.bearer);
    expect(status).toBe(200);
    expect(json.schema).toBe(ACCOUNT_EXPORT_SCHEMA);
    expect(json.exported_at).toBe(new Date(NOW).toISOString());
    expect(json.account).toEqual({
      id: a.id,
      email: 'exp@b.co',
      display_name: 'Seed',
      plan: 'free',
      locale: 'zh-CN',
      created_at: expect.any(String),
    });
    // 🔴 The two operational flags are deliberately NOT in the file (see
    // buildAccountExport): they are our classification of the account, the
    // privacy policy's inventory does not list them, and keeping the admin bit
    // out of this module is also what keeps `is_admin` confined to the three
    // files test/console-admin-gate-coverage.test.ts allows. The absence is
    // STATED, not silent.
    expect(Object.keys(json.account)).not.toContain('is_admin');
    expect(Object.keys(json.account)).not.toContain('permanent_free');
    expect(typeof json.omitted.account_flags).toBe('string');
    expect(json.pc_devices).toHaveLength(1);
    expect(json.pc_devices[0]).toMatchObject({ pc_id: a.pcId, device_name: 'Seed PC', machine_uid: 'machine-uid-seed' });
    expect(json.mobile_pairings).toHaveLength(2);
    expect(json.mobile_pairings.map((m: { pairing_id: string }) => m.pairing_id).sort()).toEqual(
      [a.pairingId, a.orphanPairingId].sort(),
    );
    // Monthly usage totals — every month, newest first, unrounded.
    expect(json.usage_records).toEqual([
      { month: '2026-08', stt_minutes: 1.5, llm_tokens_in: 2, llm_tokens_out: 3, updated_at: expect.any(String) },
      { month: '2026-07', stt_minutes: 5, llm_tokens_in: 10, llm_tokens_out: 20, updated_at: expect.any(String) },
    ]);
    // The export says what it left out, so an absent field cannot be read as an
    // absent fact.
    expect(json.omitted.settings_keys).toEqual(['account.password_reset']);
    expect(typeof json.omitted.timeline_blobs).toBe('string');
  });

  it('🔴 NO SECRET is in the file — asserted on the raw bytes, not on field names', async () => {
    const a = await seedAccount('sec@b.co');
    const { text, json } = await get('/api/account/export', a.bearer);
    // The four literal secrets this account owns. Searching the whole serialized
    // body is the assertion that survives a future nested echo: a key-name filter
    // only catches the shapes somebody remembered to name.
    const user = db.users.findById(a.id);
    expect(user?.password_hash).toBeTruthy();
    for (const secret of [a.deviceToken, a.mobileToken, a.apiKey, user?.password_hash as string, `reset-${a.id}`]) {
      expect(text, `a secret leaked into the export: ${secret.slice(0, 12)}…`).not.toContain(secret);
    }
    // …and the POSITIVE control for that negative: the same probe DOES find the
    // non-secret values, so 「not found」 above means absent and not blind.
    expect(text).toContain(a.pcId);
    expect(text).toContain('sec@b.co');
    // The api_key field survives as a REDACTION, not as a deletion: a missing key
    // would say "you never configured this", which is a different fact from "we will not show it to you".
    const routings = json.settings.find((s: { key: string }) => s.key === 'stt.routings');
    expect(routings.value[0].engine_id).toBe('funasr');
    expect(routings.value[0].api_key).toContain('redacted');
    // The live password-reset token's whole ROW is gone, key included.
    expect(json.settings.map((s: { key: string }) => s.key)).not.toContain('account.password_reset');
  });

  it('🔴 exports only the CALLER — another account cannot be reached through it', async () => {
    const a = await seedAccount('mine@b.co');
    const b = await seedAccount('theirs@b.co');
    const { text, json } = await get('/api/account/export', a.bearer);
    expect(json.account.id).toBe(a.id);
    // There is no user_id parameter to forge — so the strong assertion is that
    // B's rows are nowhere in A's file at all.
    expect(text).not.toContain(b.id);
    expect(text).not.toContain(b.pcId);
    expect(text).not.toContain('theirs@b.co');
    // Positive control on the same probe.
    const bExport = await get('/api/account/export', b.bearer);
    expect(bExport.text).toContain(b.pcId);
  });

  it('anonymous → 401 AUTH_TOKEN_INVALID (the existing named shape), garbage bearer likewise', async () => {
    const anon = await get('/api/account/export');
    expect(anon.status).toBe(401);
    expect(anon.json).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    const junk = await get('/api/account/export', { authorization: 'Bearer not.a.jwt' });
    expect(junk.status).toBe(401);
    expect(junk.json.error).toBe('AUTH_TOKEN_INVALID');
  });
});

// ── ③ DELETION: the confirmation shape ──────────────────────────────────────
describe('POST /api/account/delete — the confirmation shape', () => {
  it('🔴 an empty body deletes NOTHING (400) — the account is still there afterwards', async () => {
    const a = await seedAccount('empty@b.co');
    const r = await post('/api/account/delete', {}, a.bearer);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
    expect(db.users.findById(a.id)).not.toBeNull();
  });

  it('a wrong confirm literal / a missing confirm_user_id / another account\'s id → 400, nothing deleted', async () => {
    const a = await seedAccount('shape@b.co');
    const b = await seedAccount('other@b.co');
    for (const body of [
      { confirm: true, confirm_user_id: a.id },
      { confirm: 'delete', confirm_user_id: a.id },
      { confirm: 'DELETE' },
      // 🔴 The mistake this field exists for: a console showing one account while
      // the browser still holds the other one's token.
      { confirm: 'DELETE', confirm_user_id: b.id },
    ]) {
      const r = await post('/api/account/delete', body, a.bearer);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
      expect(typeof r.json.message).toBe('string');
    }
    expect(db.users.findById(a.id)).not.toBeNull();
    expect(db.users.findById(b.id)).not.toBeNull();
  });

  it('anonymous → 401 with no body read at all; a valid body from nobody deletes nothing', async () => {
    const a = await seedAccount('anon@b.co');
    const r = await post('/api/account/delete', deleteBody(a));
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(db.users.findById(a.id)).not.toBeNull();
  });

  it("🔴 another account's Bearer cannot delete this one — the target is the proven subject", async () => {
    const a = await seedAccount('victim@b.co');
    const b = await seedAccount('attacker@b.co');
    // B sends A's id with B's token: refused (there is no route through which a
    // caller can name a victim), and BOTH accounts survive.
    const r = await post('/api/account/delete', deleteBody(a), b.bearer);
    expect(r.status).toBe(400);
    expect(db.users.findById(a.id)).not.toBeNull();
    expect(db.users.findById(b.id)).not.toBeNull();
    // …and when B deletes B properly, A is untouched — including A's children,
    // which share no FK with B's.
    const ok = await post('/api/account/delete', deleteBody(b), b.bearer);
    expect(ok.status).toBe(200);
    expect(db.users.findById(a.id)).not.toBeNull();
    expect(countsFor(a.id, a.pcId).pc_devices).toBe(1);
    expect(countsFor(a.id, a.pcId).mobile_pairings).toBe(2);
  });

  it('🔴 a PLATFORM account (permanent_free / is_admin) needs an extra explicit acknowledgement', async () => {
    const owner = await seedAccount('owner@b.co');
    db.users.setPermanentFree(owner.id, true);
    // The exact body that works for a normal account is REFUSED for this one.
    const refused = await post('/api/account/delete', deleteBody(owner), owner.bearer);
    expect(refused.status).toBe(400);
    expect(refused.json.message).toContain('acknowledge_platform_account');
    expect(db.users.findById(owner.id)).not.toBeNull();
    // A false acknowledgement is not an acknowledgement.
    const refusedFalse = await post('/api/account/delete', deleteBody(owner, { acknowledge_platform_account: false }), owner.bearer);
    expect(refusedFalse.status).toBe(400);
    expect(db.users.findById(owner.id)).not.toBeNull();
    // POSITIVE CONTROL — with the acknowledgement it does go through, so the
    // refusals above are the guard and not a broken route.
    const done = await post('/api/account/delete', deleteBody(owner, { acknowledge_platform_account: true }), owner.bearer);
    expect(done.status).toBe(200);
    expect(db.users.findById(owner.id)).toBeNull();
  });

  it('the is_admin half of the same guard (an admin without permanent_free)', () => {
    const admin = db.users.insert({ id: 'u-admin-guard', email: 'adm@b.co', display_name: 'A', is_admin: true });
    expect(checkDeleteConfirmation({ confirm: 'DELETE', confirm_user_id: admin.id }, admin).ok).toBe(false);
    expect(
      checkDeleteConfirmation({ confirm: 'DELETE', confirm_user_id: admin.id, acknowledge_platform_account: true }, admin).ok,
    ).toBe(true);
    // …and the reverse control: a plain account does NOT need the extra field, so
    // the assertion above is measuring the platform bit and not the literal.
    const plain = db.users.insert({ id: 'u-plain-guard', email: 'plain@b.co', display_name: 'P' });
    expect(checkDeleteConfirmation({ confirm: 'DELETE', confirm_user_id: plain.id }, plain).ok).toBe(true);
  });
});

// ── ④ DELETION: what it actually destroys ───────────────────────────────────
describe('POST /api/account/delete — the cascade, per table', () => {
  it('🔴 every cascading table is NON-EMPTY before and EMPTY after; the two retained ones survive', async () => {
    const a = await seedAccount('cascade@b.co');
    const before = countsFor(a.id, a.pcId);
    // The probe is not blind: every table this account owns has rows in it.
    // (Except the tombstone table — see TOMBSTONES: the delete is its writer.)
    for (const [table, n] of Object.entries(before)) {
      if (table === TOMBSTONES) {
        expect(n, 'a tombstone existed BEFORE the delete that creates it').toBe(0);
        continue;
      }
      expect(n, `${table} was already empty BEFORE the delete — this assertion would prove nothing`).toBeGreaterThan(0);
    }
    expect(before.mobile_pairings).toBe(2); // incl. the NULL-user_id one

    const r = await post('/api/account/delete', deleteBody(a), a.bearer);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      deleted: true,
      user_id: a.id,
      irreversible: true,
      cascaded: [...USER_CASCADING_TABLES],
      retained: [...USER_RETAINED_TABLES],
    });

    const after = countsFor(a.id, a.pcId);
    expect(after.users).toBe(0);
    for (const table of USER_CASCADING_TABLES) {
      expect(after[table], `${table} still holds rows for a deleted account`).toBe(0);
    }
    // 🔴 THE POSITIVE CONTROL for all of the zeros above: the same query shape,
    // the same user id, against the two tables that deliberately do NOT cascade —
    // it still finds rows. So a zero above means 「gone」 and not 「the probe never
    // looked at anything」.
    for (const table of USER_RETAINED_TABLES) {
      expect(after[table], `${table} was swept — it is supposed to survive an account deletion`).toBeGreaterThan(0);
    }
  });

  // ── 🔴 0.3.25 B1 · card D-2 ────────────────────────────────────────────────
  //
  // THE DEFECT: `paddle_subscriptions` cascades away with the account and
  // NOTHING was ever called at Paddle, so closing an account left the card being
  // charged on schedule with our only `sub_xxx` → person mapping deleted. Every
  // later webhook for that subscription lands as `unmapped`, naming nobody, and
  // the delete response reports `paddle_subscriptions` among the tables it
  // cascaded — true, and reads as 「handled」.
  //
  // ⚠️ WHAT THIS TEST DOES NOT CLAIM: that the billing stopped. It did not.
  // Cancelling needs the outbound client (B2). This pins the narrower thing that
  // had to come first — the identifier survives, so the charge stays
  // attributable and the cancellation stays possible.
  it('🔴 D-2: a deleted account leaves a TOMBSTONE for every subscription it owned', async () => {
    const a = await seedAccount('tombstone@b.co');
    const owned = db.billing.listForUser(a.id);
    // Positive control: the account really does own a subscription, so a
    // tombstone found below is a tombstone that was WRITTEN and not one left
    // over from another test.
    expect(owned.length).toBeGreaterThan(0);

    const r = await post('/api/account/delete', deleteBody(a), a.bearer);
    expect(r.status).toBe(200);
    // The cascade really did take the source rows — this is the fact that makes
    // reading them AFTER the delete impossible, i.e. why the write must precede it.
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM paddle_subscriptions WHERE user_id = ?').get(a.id)).toEqual({ n: 0 });

    const stones = db.raw
      .prepare('SELECT * FROM paddle_subscription_tombstones ORDER BY subscription_id')
      .all() as Record<string, unknown>[];
    expect(stones.map((s) => s.subscription_id).sort()).toEqual(owned.map((s) => s.subscription_id).sort());
    const first = stones[0]!;
    expect(first.reason).toBe('account_deleted');
    expect(first.status_at_deletion).toBe(owned[0]!.status);
    // 🔴 NULL, and it means 「never cancelled」 rather than 「unknown」. B2 is what
    // stamps it. A row that arrived here already stamped would mean something
    // claimed to have cancelled at Paddle without an outbound client existing.
    expect(first.cancel_verified_at).toBeNull();
    // 🔴 NO PII. Erasing a person and then keeping their address in the record of
    // that erasure would undo it. Asserted as a property of the whole row, not of
    // the columns we happen to have listed, so a future column carrying an email
    // fails here rather than shipping.
    expect(JSON.stringify(first)).not.toContain('tombstone@b.co');
  });

  it('🔴 D-2: deleting twice does not restamp the first tombstone', async () => {
    const a = await seedAccount('twice@b.co');
    await post('/api/account/delete', deleteBody(a), a.bearer);
    const firstPass = db.raw.prepare('SELECT * FROM paddle_subscription_tombstones').all();
    // Second call: the account is already gone, so it deletes nothing — but the
    // tombstone write runs unconditionally and must be a no-op rather than a
    // rewrite. 「When did we let go of this subscription」 has one true answer and
    // a retry must not move it.
    deleteAccount(a.id, { users: db.users, billingLedger: db.billing });
    expect(db.raw.prepare('SELECT * FROM paddle_subscription_tombstones').all()).toEqual(firstPass);
  });

  it('🔴 the pairing with a NULL user_id dies too — through the CHAINED cascade', async () => {
    // It has no user FK to cascade from (the column is NULL), so the only path
    // that can reach it is pc_devices → mobile_pairings. Asserted on its own
    // because a single COUNT over the table would go to zero either way.
    const a = await seedAccount('chain@b.co');
    expect(db.mobiles.findById(a.orphanPairingId)).not.toBeNull();
    expect(db.mobiles.findById(a.orphanPairingId)?.user_id).toBeNull();
    await post('/api/account/delete', deleteBody(a), a.bearer);
    expect(db.mobiles.findById(a.orphanPairingId)).toBeNull();
  });

  it('🔴 the account cannot be resurrected — every write path now fails the FK, loudly', async () => {
    const a = await seedAccount('ghost@b.co');
    await post('/api/account/delete', deleteBody(a), a.bearer);
    // A socket that was already connected when the account was deleted is not
    // force-disconnected (stated in account-lifecycle.ts). What it cannot do is
    // write a row back: `user_id REFERENCES users(id)` has nothing to point at.
    expect(() =>
      db.pcs.insert({
        id: 'pc-ghost',
        user_id: a.id,
        device_name: 'Ghost',
        device_token: newToken(),
        room_uuid: 'room-ghost',
        short_code: '4321',
      }),
    ).toThrow();
    expect(() => db.settings.write(a.id, 'stt.routings', [])).toThrow();
    expect(() => db.usage.increment(a.id, '2026-08', { stt_minutes: 1 })).toThrow();
  });
});

// ── ⑤ DELETION: the credentials die with it ─────────────────────────────────
describe('POST /api/account/delete — sessions and tokens die with the account', () => {
  /** The production token lookup, mapped exactly the way bootstrap.ts
   *  `tokenLookupOver` maps it (including the `?? STANDALONE_USER_ID` fallback on
   *  a pairing with a NULL user_id — copied rather than approximated, because a
   *  lookup that disagreed with production would make the refusals below prove
   *  something about this test instead of about the middleware). */
  function lookup(): TokenLookup {
    return {
      findPcByToken: (t) => {
        const r = db.pcs.findByToken(t);
        return r ? { id: r.id, user_id: r.user_id } : null;
      },
      findMobileByToken: (t) => {
        const r = db.mobiles.findByToken(t);
        return r ? { id: r.id, user_id: r.user_id ?? STANDALONE_USER_ID, pc_device_id: r.pc_device_id } : null;
      },
    };
  }
  /** Drive the REAL socket middleware and report what it decided. */
  function handshake(token: string): { err: string | null; kind: string | null } {
    const socket = { handshake: { auth: { token } }, data: {} as Record<string, unknown> };
    let err: Error | undefined;
    authMiddleware(lookup())(socket, (e) => {
      err = e;
    });
    const authCtx = socket.data.auth as { kind?: string } | null | undefined;
    return { err: err ? err.message : null, kind: authCtx?.kind ?? null };
  }

  it('🔴 the PC device_token and the mobile_token are REFUSED by the real middleware afterwards', async () => {
    const a = await seedAccount('tok@b.co');
    // POSITIVE CONTROL first — both tokens are admitted while the account lives,
    // so the refusals below are the deletion's doing and not a broken harness.
    expect(handshake(a.deviceToken)).toEqual({ err: null, kind: 'pc' });
    expect(handshake(a.mobileToken)).toEqual({ err: null, kind: 'mobile' });

    const r = await post('/api/account/delete', deleteBody(a), a.bearer);
    expect(r.status).toBe(200);

    expect(handshake(a.deviceToken)).toEqual({ err: 'AUTH_TOKEN_INVALID', kind: null });
    expect(handshake(a.mobileToken)).toEqual({ err: 'AUTH_TOKEN_INVALID', kind: null });
    // The rows the middleware reads are gone, which is WHY it refuses.
    expect(db.pcs.findByToken(a.deviceToken)).toBeNull();
    expect(db.mobiles.findByToken(a.mobileToken)).toBeNull();
  });

  it('🔴 the account JWT stops opening anything, even though it is still validly signed', async () => {
    const a = await seedAccount('jwt@b.co');
    // The token is a real HS256 JWT with a live exp — before the delete it works.
    expect((await get('/api/account/export', a.bearer)).status).toBe(200);
    await post('/api/account/delete', deleteBody(a), a.bearer);
    // The SAME token now fails: account-auth.ts asks 「is the signature good」 AND
    // 「does the account exist」, and only the second one may open a door. This is
    // the honest form of 「sessions die with the account」 in a stateless-JWT
    // system — there is no denylist, and none is needed once the row is gone.
    const after = await get('/api/account/export', a.bearer);
    expect(after.status).toBe(401);
    expect(after.json.error).toBe('AUTH_TOKEN_INVALID');
    // Deleting twice is not possible either, and the refusal names the credential.
    const twice = await post('/api/account/delete', deleteBody(a), a.bearer);
    expect(twice.status).toBe(401);
    expect(twice.json.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('deleteAccount() reports `deleted:false` for an account that is already gone', () => {
    // Unreachable over HTTP (the Bearer dies with the row), so it is pinned at the
    // function: the value must be a truthful false, never a fabricated true.
    const gone = deleteAccount('u-never-existed', { users: db.users, billingLedger: db.billing });
    expect(gone.deleted).toBe(false);
    expect(gone.ok).toBe(true);
  });

  it('🔴 first delete reports the cascade; a repeat delete stays ok but does NOT claim cascade work', async () => {
    // Idempotency: second call is still success (ok:true, deleted:false) — we
    // change what the response CLAIMS about work, not whether it succeeds.
    const a = await seedAccount('idempotent-cascade@b.co');
    const first = deleteAccount(a.id, { users: db.users, billingLedger: db.billing });
    expect(first).toEqual({
      ok: true,
      deleted: true,
      user_id: a.id,
      irreversible: true,
      // POSITIVE CONTROL: a fix that emptied `cascaded` on every path would still
      // pass the repeat-call assertions below. This one fails that wrong fix.
      cascaded: [...USER_CASCADING_TABLES],
      retained: [...USER_RETAINED_TABLES],
    });
    expect(first.cascaded.length).toBeGreaterThan(0);

    const second = deleteAccount(a.id, { users: db.users, billingLedger: db.billing });
    expect(second.ok).toBe(true);
    expect(second.deleted).toBe(false);
    expect(second.user_id).toBe(a.id);
    expect(second.irreversible).toBe(true);
    // Honest claim about THIS call: we emptied nothing. Not an absent field —
    // see AccountDeleteResult.cascaded for the argument.
    expect(second.cascaded).toEqual([]);
    // Policy field stays: retained tables are 「what deletion refuses to touch」,
    // not 「what this call just spared」.
    expect(second.retained).toEqual([...USER_RETAINED_TABLES]);
  });
});

// ── ⑥ The export builder, at the unit level ─────────────────────────────────
describe('buildAccountExport — the redaction mirrors the repo it reads from', () => {
  it('redacts api_key at every depth, including inside arrays', async () => {
    const a = await seedAccount('deep@b.co');
    db.settings.write(a.id, 'llm.config', {
      providers: [{ name: 'x', api_key: 'sk-nested-1' }, { name: 'y', apiKey: 'sk-nested-2' }],
      nested: { deeper: { api_key: 'sk-nested-3' } },
    });
    const user = db.users.findById(a.id);
    if (!user) throw new Error('unreachable');
    const json = JSON.stringify(buildAccountExport(user, { pcs: db.pcs, mobiles: db.mobiles, settings: db.settings, usage: db.usage }, NOW));
    for (const secret of ['sk-nested-1', 'sk-nested-2', 'sk-nested-3']) {
      expect(json).not.toContain(secret);
    }
    // Positive control: the non-secret siblings of those keys did survive, so the
    // walker redacted rather than dropped the whole subtree.
    expect(json).toContain('"name":"x"');
    expect(json).toContain('deeper');
  });
});
