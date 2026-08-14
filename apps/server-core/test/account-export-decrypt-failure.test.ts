// D2 Stage 0 — fix GET /api/account/export having no catch: a decrypt failure must be 500, not
// crash the process. Red first, then green: drive the production decrypt chain directly to prove it really does "throw synchronously, uncaught" today (that is
// exactly what §1.3's silent disaster looks like on this HTTP path), then drive the real HTTP route to prove the fix answers 500,
// and that the server is still alive afterwards and still answers normally.
//
// SPEC-REF: src/http/console-routes.ts GET /api/account/export (lines 674-～697
//             after this card's fix; the design doc's approximate "console-
//             routes.ts:680" is the SAME route, pre-drift)
//           src/http/account-lifecycle.ts buildAccountExport (the function whose
//             bare, uncaught call was the bug)
//           src/db/repos/settings.repo.ts toRow/walkDecrypt (still has NO
//             try/catch — unchanged by this card; console-routes.ts's NEW catch
//             is what stops that throw from reaching the HTTP response raw)
//           docs/strategy/2026-08-05-d2-secret-domain-separation-design-cn.md §1.2
//             (this exact crash chain, including the router.ts hop) §1.3
//           test/account-lifecycle.test.ts (the EXISTING happy-path export tests
//             this file does not repeat — this file is only the decrypt-failure
//             branch and its positive controls)

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeSettingsRepo, type SettingsRepo } from '../src/db/repos/settings.repo';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { BillingService } from '../src/billing/billing-service';
import { tryHandleConsoleRoutes, type ConsoleRoutesDeps } from '../src/http/console-routes';
import { unconfiguredPasswordResetMailer } from '../src/mail';
import { buildAccountExport, type AccountExportStores } from '../src/http/account-lifecycle';

const SECRET_A = 'export-decrypt-failure-key-a-32-bytes-xx';
const SECRET_WRONG = 'export-decrypt-failure-DIFFERENT-32-byte';
const NOW = Date.parse('2026-08-05T00:00:00.000Z');

let db: DbConnection;
let auth: AuthService;
let server: Server | null = null;
let url: string;

afterEach(async () => {
  if (server) await new Promise<void>((r) => (server as Server).close(() => r()));
  server = null;
  db?.close();
});

function makeDeps(settingsForRoute: SettingsRepo): ConsoleRoutesDeps {
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET_A, 'utf8'), now: () => NOW });
  return {
    auth,
    billing: new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false, now: () => NOW }),
    billingLedger: db.billing,
    opsAudit: db.opsAudit,
    pcs: db.pcs,
    mobiles: db.mobiles,
    // 🔴 THE SEAM: a SettingsRepo built over the SAME raw connection but with a
    // DIFFERENT key than the one the data was written under — this is exactly
    // §1.3's production scenario ("the DB was restored but the env was not"), reproduced without
    // needing to touch config.ts or identity.ts at all.
    settings: settingsForRoute,
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

async function boot(deps: ConsoleRoutesDeps): Promise<void> {
  server = createServer((req, res) => {
    if (!tryHandleConsoleRoutes(req, res, deps)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });
  await new Promise<void>((r) => (server as Server).listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('🔴 RED — the underlying mechanism really throws, synchronously and uncaught', () => {
  it('buildAccountExport() throws when the settings key does not match the one the data was encrypted under', async () => {
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET_A) });
    auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET_A, 'utf8'), now: () => NOW });
    const user = await auth.register({ email: 'red@b.co', password: 'longenough1', display_name: 'Red' });
    db.settings.write(user.id, 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-live-red' }]);

    const wrongKeyRepo = makeSettingsRepo(db.raw, deriveKey(SECRET_WRONG));
    const stores: AccountExportStores = { pcs: db.pcs, mobiles: db.mobiles, settings: wrongKeyRepo, usage: db.usage };
    const u = db.users.findById(user.id);
    if (!u) throw new Error('unreachable');

    let captured = '';
    let threw = false;
    try {
      buildAccountExport(u, stores, NOW);
    } catch (err) {
      threw = true;
      captured = err instanceof Error ? err.message : String(err);
    }
    // [measured · RED original text, verbatim in the delivery doc §5] this is EXACTLY what console-routes.ts's
    // export route used to let escape uncaught — before this card, this same
    // throw, driven by an HTTP request instead of a direct call, would propagate
    // through http/router.ts's makeHttpHandler (no catch there either) into
    // bootstrap.ts's raw createServer callback, to Node's uncaughtException.
    expect(threw).toBe(true);
    expect(captured.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console -- deliberate capture for the delivery doc
    console.log('【measured·RED original text】buildAccountExport threw:', captured);
  });
});

describe('🟢 GREEN — through the FIXED route: 500, not a crash, and the server survives', () => {
  it('the SAME broken-key scenario over real HTTP returns 500 (SETTINGS_SYNC_FAIL), and the server answers the NEXT request too', async () => {
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET_A) });
    const wrongKeyRepo = makeSettingsRepo(db.raw, deriveKey(SECRET_WRONG));
    await boot(makeDeps(wrongKeyRepo)); // sets the module-level `auth`

    const user = await auth.register({ email: 'green@b.co', password: 'longenough1', display_name: 'Green' });
    db.settings.write(user.id, 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-live-green' }]);

    const bearer = { authorization: `Bearer ${auth.issueToken(user).token}` };
    const res = await fetch(`${url}/api/account/export`, { headers: bearer });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message?: string };
    // errors.ts's generic fallback for a plain (non-ServerError) throw — the
    // existing 61-code whitelist does not move for this card.
    expect(body.error).toBe('SETTINGS_SYNC_FAIL');
    expect(typeof body.message).toBe('string');

    // 🔴 THE POINT OF THIS WHOLE FILE: a crashed process could not answer a
    // second request at all. This one does, deterministically (same broken key,
    // same account → same 500, not a fluke recovery).
    const again = await fetch(`${url}/api/account/export`, { headers: bearer });
    expect(again.status).toBe(500);
  });

  it('🟢 POSITIVE CONTROL — a DIFFERENT account with no undecryptable row, on the SAME (broken-key) deps, still gets 200', async () => {
    // Proves the 500 above is THIS account's bad envelope, not the route (or
    // this deps object) being broken outright — the same discipline
    // account-lifecycle.test.ts's "exports only the CALLER" test already uses.
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET_A) });
    const wrongKeyRepo = makeSettingsRepo(db.raw, deriveKey(SECRET_WRONG));
    await boot(makeDeps(wrongKeyRepo));

    const bad = await auth.register({ email: 'bad@b.co', password: 'longenough1', display_name: 'Bad' });
    db.settings.write(bad.id, 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-live-bad' }]);
    // clean: registered AFTER, never writes a settings row at all.
    const clean = await auth.register({ email: 'clean@b.co', password: 'longenough1', display_name: 'Clean' });

    const badRes = await fetch(`${url}/api/account/export`, { headers: { authorization: `Bearer ${auth.issueToken(bad).token}` } });
    expect(badRes.status).toBe(500);
    const cleanRes = await fetch(`${url}/api/account/export`, { headers: { authorization: `Bearer ${auth.issueToken(clean).token}` } });
    expect(cleanRes.status).toBe(200);
  });

  it('POSITIVE CONTROL — the CORRECT key on the exact same seeded row: 200, not 500', async () => {
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(SECRET_A) });
    await boot(makeDeps(db.settings)); // the REAL repo, same key it was written with

    const user = await auth.register({ email: 'ok@b.co', password: 'longenough1', display_name: 'Ok' });
    db.settings.write(user.id, 'stt.routings', [{ language: 'zh', engine_id: 'funasr', api_key: 'sk-live-ok' }]);

    const res = await fetch(`${url}/api/account/export`, { headers: { authorization: `Bearer ${auth.issueToken(user).token}` } });
    expect(res.status).toBe(200);
  });
});
