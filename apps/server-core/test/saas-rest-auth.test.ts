// WP-R4-1 ② — the saas-only account REST surface (POST /api/register, POST
// /api/login, GET /api/me). Runs against a real in-process saas server; each
// test gets a FRESH server so the per-IP throttle + user rows never leak across
// tests. Standalone mounts none of these (mode-gating proof at the bottom).

import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
// The owner's number, imported rather than typed: a literal `2` here would be a
// copy that keeps passing after the constant moves (0.2.53's law, applied to a
// budget instead of a string).
import { REGISTER_MAX_PER_DAY } from '../src/auth/register-rate-limit';
import { DEFAULT_TTL_MS } from '../src/auth/jwt';

const SECRET = 'rest-auth-secret-32-bytes-minimum-xxx';
let server: BootstrapHandle | null = null;

async function saasServer(now?: () => number): Promise<string> {
  // 0.3.0 M5: saas + mock billing REFUSES TO MOUNT (router.ts
  // `assertMockBillingMountable`), so the flag had to go. It was pure legacy
  // convenience here, and that is a measured claim rather than a hopeful one:
  // `config.mockBilling` has exactly two readers in src/ — the M5 mount guard
  // and the `/api/billing/*` gateway's 404 — and this file requests no
  // `/api/billing/*` path at all (grep: 0 hits). Every assertion below is about
  // register/login/me, so nothing it measures can depend on the flag.
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] });
  server = await startServer(config, now ? { now } : {});
  return `http://127.0.0.1:${server.port}`;
}
async function standaloneServer(): Promise<string> {
  const config = loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' });
  server = await startServer(config);
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  if (server) await server.close();
  server = null;
});

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe('saas REST auth', () => {
  it('POST /api/register → 201 {token,user}; user has no password_hash', async () => {
    const url = await saasServer();
    const { status, json } = await post(`${url}/api/register`, { email: 'a@b.co', password: 'longenough1', display_name: 'Ann' });
    expect(status).toBe(201);
    expect(typeof json.token).toBe('string');
    // A2-3 — `restricted` joins the register response's user object (it is the
    // same `publicUser` projection). A brand-new account is never restricted.
    expect(json.user).toEqual({ id: expect.any(String), email: 'a@b.co', display_name: 'Ann', plan: 'free', email_verified: false, restricted: false, verify_grace_days_left: expect.any(Number) });
    expect('password_hash' in json.user).toBe(false);
  });

  it('duplicate email → 409 EMAIL_EXISTS (NOCASE)', async () => {
    const url = await saasServer();
    await post(`${url}/api/register`, { email: 'dup@b.co', password: 'longenough1' });
    const { status, json } = await post(`${url}/api/register`, { email: 'DUP@b.co', password: 'longenough1' });
    expect(status).toBe(409);
    expect(json.error).toBe('EMAIL_EXISTS');
  });

  it('short password → 400 SETTINGS_SCHEMA_INVALID', async () => {
    const url = await saasServer();
    const { status, json } = await post(`${url}/api/register`, { email: 'c@b.co', password: 'short' });
    expect(status).toBe(400);
    expect(json.error).toBe('SETTINGS_SCHEMA_INVALID');
  });

  // 🔴 2026-08-27 (owner batch-2 item 4) — THIS TEST USED TO READ 「6th register
  // from one IP inside the window → 429」, i.e. it drove the 5/10-min BURST
  // brake through /api/register. That is no longer observable there, and the
  // reason is a real product consequence of the owner's ruling rather than a
  // test-maintenance chore: the per-IP DAILY account cap moved from 10 to 2, so
  // on /api/register the daily counter now refuses the THIRD attempt and the
  // burst brake's own boundary is never reached.
  //
  // ⚠️ The burst brake is NOT dead — it is shared with /api/login and
  // /api/auth/google, and it still governs both. It is simply no longer the
  // thing that answers first on this route. Splitting the old assertion in two
  // keeps both facts proven and records which one bites where; collapsing them
  // into one would leave a suite that goes green whichever limiter fired.
  it('the DAILY account cap (owner: 2/IP/day) refuses the 3rd mint, and carries retry_after_ms', async () => {
    const url = await saasServer();
    for (let i = 0; i < REGISTER_MAX_PER_DAY; i++) {
      const r = await post(`${url}/api/register`, { email: `u${i}@b.co`, password: 'longenough1' });
      expect(r.status, `mint ${i + 1} of the day`).toBe(201);
    }
    const blocked = await post(`${url}/api/register`, { email: 'u5@b.co', password: 'longenough1' });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toBe('REGISTER_RATE_LIMITED');
    // The one field that tells the two 429s apart on the wire (auth-routes.ts
    // states why they deliberately share a code): the daily branch carries a
    // budget, the burst branch does not. Without this assertion the test would
    // pass just as well if the BURST brake had fired, which is the thing this
    // split exists to distinguish.
    expect(typeof blocked.json.retry_after_ms, 'the daily refusal must say when a slot frees').toBe('number');
  });

  it('the 5/10-min BURST brake is still real — /api/login is where it is now observable', async () => {
    const url = await saasServer();
    // Wrong password on purpose: what is being measured is the ATTEMPT budget,
    // and a successful login would prove nothing about it. Five land as 401s…
    for (let i = 0; i < 5; i++) {
      const r = await post(`${url}/api/login`, { email: 'nobody@b.co', password: 'longenough1' });
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    // …and the sixth meets the brake. No retry_after_ms here — that absence is
    // the burst branch's signature.
    const blocked = await post(`${url}/api/login`, { email: 'nobody@b.co', password: 'longenough1' });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toBe('REGISTER_RATE_LIMITED');
  });

  it('POST /api/login → 200 {token,user} on success; 401 AUTH_LOGIN_FAILED on wrong password', async () => {
    const url = await saasServer();
    await post(`${url}/api/register`, { email: 'log@b.co', password: 'longenough1' });
    const ok = await post(`${url}/api/login`, { email: 'log@b.co', password: 'longenough1' });
    expect(ok.status).toBe(200);
    expect(typeof ok.json.token).toBe('string');
    expect(ok.json.user.email).toBe('log@b.co');
    const bad = await post(`${url}/api/login`, { email: 'log@b.co', password: 'WRONG' });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe('AUTH_LOGIN_FAILED');
  });

  it('GET /api/me (Bearer) round-trips the user; missing/garbage → 401 AUTH_TOKEN_INVALID', async () => {
    const url = await saasServer();
    const reg = await post(`${url}/api/register`, { email: 'me@b.co', password: 'longenough1' });
    const token = reg.json.token as string;
    const me = await get(`${url}/api/me`, { authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
    // A2-3 — GET /api/me is THE carrier the restriction notice is painted from
    // (design §2.2: it re-reads the row on every Bearer call, which is why the
    // state is not in the JWT). This shape assertion is where that field's
    // presence on the wire is pinned.
    expect(me.json.user).toEqual({ id: reg.json.user.id, email: 'me@b.co', display_name: 'User', plan: 'free', email_verified: false, restricted: false, verify_grace_days_left: expect.any(Number) });
    expect((await get(`${url}/api/me`)).status).toBe(401);
    expect((await get(`${url}/api/me`, { authorization: 'Bearer not.a.jwt' })).json.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('GET /api/me with an EXPIRED bearer → 401 AUTH_TOKEN_EXPIRED', async () => {
    let simNow = 1_700_000_000_000;
    const url = await saasServer(() => simNow);
    const reg = await post(`${url}/api/register`, { email: 'exp@b.co', password: 'longenough1' });
    const token = reg.json.token as string;
    // Fast-forward the server clock past the token's OWN TTL, read from the
    // constant rather than re-typed as "8 days". Owner ruling 2026-08-27 §R1
    // moved that constant from 7 days to 100 years; a hand-written number here
    // silently stopped testing expiry at all (it went green as a 200), which is
    // exactly the shape this repo calls "a test that pins yesterday's fact".
    simNow += DEFAULT_TTL_MS + 1000;
    const me = await get(`${url}/api/me`, { authorization: `Bearer ${token}` });
    expect(me.status).toBe(401);
    expect(me.json.error).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('standalone mounts NONE of the account REST (404 — saas-only)', async () => {
    const url = await standaloneServer();
    expect((await post(`${url}/api/register`, { email: 'x@b.co', password: 'longenough1' })).status).toBe(404);
    expect((await post(`${url}/api/login`, { email: 'x@b.co', password: 'longenough1' })).status).toBe(404);
    expect((await get(`${url}/api/me`)).status).toBe(404);
  });
});
