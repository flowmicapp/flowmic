// Cards MP-12 / MP-13 — the integrator's own key surface, driven through the
// console router the way the site repo's console will call it.
//
// SPEC-REF:
//   src/http/console-integrator-routes.ts (the routes, and why the key string is
//     returned in full)
//   src/billing/usage-period.ts (the cycle `refused_count` is scoped to)
//   docs/decisions/2026-09-10-owner-web-client-identity-qr-demo-and-polish.md §11
//   *** HUMAN-AUDIT SENSITIVE (billing + a paid dimension) ***
//
// ⚠️ THROUGH `tryHandleConsoleRoutes`, NOT the delegated file directly. The
// delegation is real wiring (console-routes.ts hands its whole deps object
// over), and a test that called the inner function would stay green on the day
// the mount was removed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { BillingService } from '../src/billing/billing-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { RoomStore } from '../src/room/store';
import { tryHandleConsoleRoutes, type ConsoleRoutesDeps } from '../src/http/console-routes';
import { unconfiguredPasswordResetMailer } from '../src/mail';
import { INTEGRATOR_ROOM_PC_NAME, integratorRoomName } from '../src/room/integrator-room';
import { PC_NAME_MAX } from '../src/socket/handlers/settings.handler';
import { parseUtcStamp } from '../src/db/utc-stamp';

const SECRET = 'integrator-console-secret-32-bytes-xxx';
const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const ORIGIN = 'https://host.example';

let dir: string;
let db: DbConnection;
let auth: AuthService;
let server: Server;
let url: string;
let deps: ConsoleRoutesDeps;

function makeDeps(over: Partial<ConsoleRoutesDeps> = {}): ConsoleRoutesDeps {
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
    integratorKeys: db.integratorKeys,
    // card MP-12 — the REAL log off the same connection. A stub counter here
    // would prove the route can render a number, which is not the question: the
    // question is whether the number comes from the rows the admission writes.
    usageEvents: db.usageEvents,
    store: new RoomStore(),
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    passwordLimiter: new RegisterRateLimiter(),
    verifiedEmail: { emailVerifiedAt: () => NOW },
    mail: unconfiguredPasswordResetMailer(),
    now: () => NOW,
    ...over,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'flowmic-mp12-'));
  db = createDbConnection({ dbPath: join(dir, 'test.db'), encryptionKey: deriveKey('mp12-console-test-secret') });
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => NOW });
  deps = makeDeps();
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
  rmSync(dir, { recursive: true, force: true });
});

/** How far before the injected `NOW` a fixture account was registered. Any
 *  positive span works; three days keeps the cycle start a whole day before
 *  `NOW`, so `period.startMs`, `NOW` and `period.startMs - 1` are three
 *  distinguishable instants. */
const REGISTERED_BEFORE_NOW_MS = 3 * 24 * 60 * 60 * 1000;

/** SQLite's own spelling of an instant: `YYYY-MM-DD HH:MM:SS`, UTC, no zone —
 *  what `DEFAULT (datetime('now'))` puts in `users.created_at` (db/schema.ts). */
function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Move a fixture account's registration stamp onto the INJECTED clock.
 *
 * 🔴 WITHOUT THIS THE FILE MEASURES THE WALL CLOCK. The metering cycle is
 * anchored to `users.created_at` (billing-service.ts `usagePeriod`), and that
 * column is stamped by SQLite with the REAL time — while every assertion below
 * is written against `NOW`. `usagePeriodAt` clamps a window start to the anchor
 * day, so on any real date after `NOW` the cycle begins AFTER `NOW` and a row
 * written at `NOW` falls outside it: this file was green when it was written
 * and went red on 2026-09-12 by nothing but the date, reporting
 * `refused_count: 1` for two rows it had just written.
 *
 * The stamp is written in the DATABASE's format and then read back through
 * `parseUtcStamp` — the same function `usagePeriod` calls on this column — so
 * the format is proven by the real reader rather than eyeballed.
 *
 * REVERSE CONTROL (executed 2026-09-12, this worktree): delete the
 * `anchorRegistrationTo` call in `account()`. OBSERVED: 1 failed | 15 passed —
 * 「counts this key's refusals inside T's OWN metering cycle」, 「expected
 * { refused_count: 1 } to match object { refused_count: 2 }」. Restored from a
 * byte copy; no marker string was inserted.
 */
function anchorRegistrationTo(userId: string, atMs: number): void {
  const stamp = sqliteStamp(atMs);
  const readBack = parseUtcStamp(stamp);
  if (readBack !== Math.floor(atMs / 1000) * 1000) {
    throw new Error(`the stamp ${stamp} is not what the column's reader makes of ${atMs} (got ${readBack})`);
  }
  const { changes } = db.raw.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(stamp, userId);
  if (Number(changes) !== 1) throw new Error(`expected to re-anchor exactly one row, moved ${changes}`);
}

async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'T' });
  anchorRegistrationTo(user.id, NOW - REGISTERED_BEFORE_NOW_MS);
  return { id: user.id, bearer: { authorization: `Bearer ${auth.issueToken(user).token}` } };
}

function post(path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function createKey(
  bearer: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await post('/api/cloud/integrator/keys', { origins: [ORIGIN], label: 'Acme Docs', ...body }, bearer);
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function listKeys(bearer: Record<string, string>): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${url}/api/cloud/integrator/keys`, { headers: bearer });
  return ((await r.json()) as { keys: Record<string, unknown>[] }).keys;
}

/** The account's one key, with 「it is there」 asserted on the way past — see the
 *  same helper's note in test/integrator-refusal-row.test.ts. */
async function onlyKey(bearer: Record<string, string>): Promise<Record<string, unknown>> {
  const [first] = await listKeys(bearer);
  if (first === undefined) throw new Error('the account has no keys — every assertion below would be vacuous');
  return first;
}

/** ONE refusal row, written the way `recordQuotaRefusal` writes one: every count
 *  at 0, `outcome:'quota_refused'`, and the key named. Through the repo rather
 *  than by SQL, so the columns this asserts are the columns production fills. */
function refusalRow(userId: string, keyId: string | null, occurredAt: number): void {
  db.usageEvents.append({
    user_id: userId,
    occurred_at: occurredAt,
    kind: 'stt',
    is_byok: false,
    outcome: 'quota_refused',
    refused_user_id: userId,
    payer_reason: 'host',
    speaker_ref: 'wb-1111222233334444',
    ...(keyId === null ? {} : { integrator_key_id: keyId }),
  });
}

describe('MP-12: refused_count on the key list', () => {
  it("counts this key's refusals inside T's OWN metering cycle", async () => {
    const t = await account('t-count@integrator.test');
    const created = await createKey(t.bearer);
    const key = created.json.key as { id: string };
    // A brand-new key has refused nothing, and the create answer says so as a
    // number rather than by omission.
    expect(created.json.key).toMatchObject({ refused_count: 0 });

    const period = deps.billing.usagePeriod(t.id, NOW);
    refusalRow(t.id, key.id, period.startMs);
    refusalRow(t.id, key.id, NOW);
    expect(await onlyKey(t.bearer)).toMatchObject({ refused_count: 2 });

    // 🔴 THE WINDOW IS THE CYCLE, NOT ALL OF HISTORY. A row one millisecond
    // before this cycle began belongs to the previous one — the same boundary
    // `used_ms` beside it rolls over on, which is the whole reason the period
    // comes from `BillingService.usagePeriod` and not from a local look-back.
    refusalRow(t.id, key.id, period.startMs - 1);
    expect(await onlyKey(t.bearer)).toMatchObject({ refused_count: 2 });
  });

  it('counts only rows that name a key, and only refusals', async () => {
    const t = await account('t-scope@integrator.test');
    const key = (await createKey(t.bearer)).json.key as { id: string };
    // T's own phone running out of minutes is a refusal on the same account and
    // is NOT this key's business…
    refusalRow(t.id, null, NOW);
    // …and an ordinary metered recording through the key is not a refusal.
    db.usageEvents.append({
      user_id: t.id,
      occurred_at: NOW,
      kind: 'stt',
      is_byok: false,
      outcome: 'ok',
      stt_ms: 5_000,
      integrator_key_id: key.id,
    });
    expect(await onlyKey(t.bearer)).toMatchObject({ refused_count: 0 });
  });

  it("one account's refusals never land on another's key", async () => {
    const t = await account('t-a@integrator.test');
    const other = await account('t-b@integrator.test');
    const key = (await createKey(t.bearer)).json.key as { id: string };
    // Another account's row naming T's key id — impossible through the handler,
    // asserted because the query is what enforces it.
    refusalRow(other.id, key.id, NOW);
    expect(await onlyKey(t.bearer)).toMatchObject({ refused_count: 0 });
  });

  it('a deployment that does not count OMITS the field — 0 would be a measurement it did not make', async () => {
    const t = await account('t-uncounted@integrator.test');
    const key = (await createKey(t.bearer)).json.key as { id: string };
    refusalRow(t.id, key.id, NOW);
    deps = makeDeps({ usageEvents: undefined });
    const listed = await onlyKey(t.bearer);
    expect('refused_count' in listed).toBe(false);
    // …and the rest of the view is untouched, so an absent counter costs an
    // integrator nothing else.
    expect(listed).toMatchObject({ id: key.id, label: 'Acme Docs' });
  });
});

describe("MP-13: a site key must carry the site's name", () => {
  /** Every way to get it wrong, and what each one is. The four share ONE 400
   *  body on purpose — see the route's comment — so this table exists to prove
   *  all four actually reach it rather than three of them being stored. */
  const refused: Array<[string, unknown]> = [
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   \t  '],
    ['not a string', 42],
    ['65 characters', 'x'.repeat(65)],
    ['a newline inside', 'Acme\nDocs'],
    ['a NUL inside', 'Acme\u0000Docs'],
  ];
  for (const [what, value] of refused) {
    it(`refuses a label that is ${what}`, async () => {
      const t = await account(`t-label-${what.replace(/[^a-z]/gi, '')}@integrator.test`);
      const r = await createKey(t.bearer, { label: value });
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ error: 'SETTINGS_SCHEMA_INVALID' });
      // The console card maps on the code; the message names the rules so a
      // developer reading the raw response can see which one they broke.
      expect(String(r.json.message)).toContain('label is required');
      // 🔴 AND NOTHING WAS STORED. Without this the suite would pass against a
      // route that answered 400 AFTER inserting — the answer would be right and
      // the account would be holding a nameless key.
      expect(await listKeys(t.bearer)).toHaveLength(0);
    });
  }

  // REVERSE CONTROL (executed 2026-09-11, this worktree): replace `readLabel`'s
  // `if (name.length === 0 || name.length > MAX_LABEL_CHARS)` with `if (false)`.
  // OBSERVED: 3 failed | 13 passed — 「refuses a label that is empty」,
  // 「… whitespace only」 and 「… 65 characters」, all with 「expected 200 to be
  // 400」. The five that stayed green are the arms that other checks still
  // catch, which is what tells this apart from a suite that stopped running.
  // Restored from a byte copy; no marker string was inserted.
  it('accepts a name at the cap, trimmed, and stores what it accepted', async () => {
    const t = await account('t-label-ok@integrator.test');
    const name = 'A'.repeat(64);
    const r = await createKey(t.bearer, { label: `  ${name}  ` });
    expect(r.status).toBe(200);
    // Trimmed, not rejected for the spaces and not stored with them: what the
    // integrator meant is the name without the accident.
    expect(await onlyKey(t.bearer)).toMatchObject({ label: name });
  });

  it('a key created BEFORE this rule keeps working, empty label and all', async () => {
    // Validation is on create only (the route's own note). Written through the
    // repo — the same way MP-1 wrote one — because that is what a production row
    // from last week looks like, and the point is that the LIST still serves it.
    const t = await account('t-label-legacy@integrator.test');
    db.integratorKeys.insert({
      id: 'ik_legacy', user_id: t.id, publishable_key: 'fmpk_' + '0'.repeat(32),
      origins: [ORIGIN], quota_minutes: null, label: null, created_at: NOW,
    });
    expect(await onlyKey(t.bearer)).toMatchObject({ id: 'ik_legacy', label: null });
  });

  it('the cap sits inside what a PC name is already allowed to be — so nothing truncates', () => {
    // 🔴 THE ANCHOR FOR `integratorRoomName`'s 「IT DOES NOT TRUNCATE」. That claim
    // is true only while this holds, and it is the kind of claim that goes
    // silently false when somebody raises one of the two numbers. Asserted here
    // rather than imported across `room/` → `socket/handlers/` for one integer.
    const longest = 'x'.repeat(64);
    expect(longest.length).toBeLessThanOrEqual(PC_NAME_MAX);
    expect(integratorRoomName(longest)).toBe(longest);
  });

  it('the room name is the label — and the fallback is only for a key that has none', () => {
    expect(integratorRoomName('Acme Docs')).toBe('Acme Docs');
    expect(integratorRoomName(null)).toBe(INTEGRATOR_ROOM_PC_NAME);
    expect(integratorRoomName('   ')).toBe(INTEGRATOR_ROOM_PC_NAME);
    // A legacy label written before the validation existed: repaired here rather
    // than put on somebody's phone verbatim.
    expect(integratorRoomName('Acme\nDocs')).toBe('Acme Docs');
  });
});
