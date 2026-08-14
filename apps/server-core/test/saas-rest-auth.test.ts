// WP-R4-1 ② — the saas-only account REST surface (POST /api/register, POST
// /api/login, GET /api/me). Runs against a real in-process saas server; each
// test gets a FRESH server so the per-IP throttle + user rows never leak across
// tests. Standalone mounts none of these (mode-gating proof at the bottom).

import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

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
    expect(json.user).toEqual({ id: expect.any(String), email: 'a@b.co', display_name: 'Ann', plan: 'free', email_verified: false, restricted: false });
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

  it('6th register from one IP inside the window → 429 REGISTER_RATE_LIMITED', async () => {
    const url = await saasServer();
    for (let i = 0; i < 5; i++) {
      const r = await post(`${url}/api/register`, { email: `u${i}@b.co`, password: 'longenough1' });
      expect(r.status).toBe(201);
    }
    const blocked = await post(`${url}/api/register`, { email: 'u5@b.co', password: 'longenough1' });
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
    expect(me.json.user).toEqual({ id: reg.json.user.id, email: 'me@b.co', display_name: 'User', plan: 'free', email_verified: false, restricted: false });
    expect((await get(`${url}/api/me`)).status).toBe(401);
    expect((await get(`${url}/api/me`, { authorization: 'Bearer not.a.jwt' })).json.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('GET /api/me with an EXPIRED bearer → 401 AUTH_TOKEN_EXPIRED', async () => {
    let simNow = 1_700_000_000_000;
    const url = await saasServer(() => simNow);
    const reg = await post(`${url}/api/register`, { email: 'exp@b.co', password: 'longenough1' });
    const token = reg.json.token as string;
    // Fast-forward the server clock past the 7-day token TTL.
    simNow += 8 * 24 * 60 * 60 * 1000;
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
