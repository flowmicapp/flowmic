// R4 ④ / owner ruling A3 (2026-07-31) — WHO IS THE HTTP CALLER.
//
// Until this card `resolveUserId` returned the constant 'default' in BOTH modes:
// in an account system, everyone was the same person. Behind nginx every saas
// request also LOOKS loopback, so the local-only gate was a no-op there and any
// public caller could drive the billing state machine as that constant user.
//
// These tests are written REVERSE-FIRST, because the failure mode of an identity
// test is that it only ever checks the happy path: proving 「a valid token
// resolves to an id」 is worth nothing on its own — the old constant did that
// too. What has to be proven is
//   ① it TELLS PEOPLE APART (two accounts ⇒ two identities, and one's money
//      never lands on the other's row), and
//   ② when it cannot tell, it REFUSES — 401, by name, with nothing of 'default'
//      in the response OR in the side effects.
//
// Most cases run against a REAL in-process server (bootstrap wiring included),
// because the defect being fixed lived in the wiring, not in the algorithm.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { startServer, STANDALONE_USER_ID, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import {
  accountFromBearer,
  bearerToken,
  makeResolveUserId,
  type AccountVerifier,
} from '../src/http/account-auth';
import { log } from '../src/log';

const SECRET = 'user-identity-secret-32-bytes-min-xxx';
/** Every billing route the gateway owns — the refusal must cover ALL of them,
 *  not just the one a happy-path test happened to dial. */
const BILLING_ROUTES: Array<[string, string, unknown]> = [
  ['GET', '/api/billing/plan', undefined],
  ['GET', '/api/billing/quota', undefined],
  ['POST', '/api/billing/checkout', { cycle: 'monthly' }],
  ['POST', '/api/billing/confirm', { sessionId: 'whatever' }],
  ['POST', '/api/billing/cancel', {}],
  ['POST', '/api/billing/renew', {}],
  ['POST', '/api/billing/expire', {}],
  ['POST', '/api/billing/advance-clock', { offsetMs: 999_000 }],
];

let server: BootstrapHandle | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
  vi.restoreAllMocks();
});

async function saasServer(now?: () => number): Promise<string> {
  // M5 (2026-08-04): saas + mockBilling REFUSES TO BOOT (assertMockBillingMountable
  // throws out of makeHttpHandler). The flag is therefore OFF here — which is
  // also the only configuration a real saas deployment can run. Gate 2 (the
  // Bearer verdict) still fires on every /api/billing/* request BEFORE the
  // flag-off 404, so every refusal property this file pins remains stageable.
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] });
  server = await startServer(config, now ? { now } : {});
  return `http://127.0.0.1:${server.port}`;
}
async function standaloneServer(): Promise<string> {
  const config = loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: true });
  server = await startServer(config);
  return `http://127.0.0.1:${server.port}`;
}

interface Reply { status: number; json: any; raw: string }
async function call(url: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  const raw = await res.text();
  return { status: res.status, json: raw ? JSON.parse(raw) : null, raw };
}
const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** Register + log in, returning the account's real JWT and id. */
async function account(url: string, email: string): Promise<{ token: string; id: string }> {
  const reg = await call(url, 'POST', '/api/register', { email, password: 'longenough1' });
  expect(reg.status, `register ${email}`).toBe(201);
  // VERIFY-1 — identity, not the verification gate, is this suite's subject;
  // accounts are held verified through the same repo the confirm route writes
  // (the gate is proven in test/email-verification.test.ts).
  server!.db.emailVerification.markVerified(reg.json.user.id as string, Date.now());
  const login = await call(url, 'POST', '/api/login', { email, password: 'longenough1' });
  expect(login.status, `login ${email}`).toBe(200);
  return { token: login.json.token as string, id: reg.json.user.id as string };
}

// ── ① IT TELLS PEOPLE APART ──────────────────────────────────────────────────
//
// ⚠️ M5 (2026-08-04) REWROTE THIS GROUP. The two tests that lived here
// (「A upgrades via mockCheckout/mockConfirm, B is untouched」 and 「A's token
// cannot cancel B's plan」) drove the MUTATING mock gateway in saas — the exact
// door M5 welds shut: saas + FLOWMIC_MOCK_BILLING now refuses to BOOT, so there
// is no HTTP surface left in saas through which any Bearer can move a plan
// (Paddle's webhook is the only writer, pinned in its own suites). The
// per-Bearer WRITE scoping those tests proved is therefore unstageable over
// HTTP by construction — which is a stronger guarantee than the one they
// asserted. What remains stageable, and is pinned below: the boot refusal
// itself, and that saas still RESOLVES identity per-Bearer on the billing
// prefix (a verified token reaches the flag-off 404; an anonymous one never
// gets past the 401 — two different answers ⇒ the verdict is real).

describe('saas: the mock billing gateway is structurally impossible (M5)', () => {
  it('saas + FLOWMIC_MOCK_BILLING refuses to BOOT, by name — through the REAL bootstrap wiring', async () => {
    // fix-010: declared posture (no proxy in front of an in-process server). It
    // is load-bearing for what this test MEASURES, not a formality: without it
    // loadConfig would refuse first, and the refusal this test exists to pin —
    // M5's MOCK_BILLING_FORBIDDEN_IN_SAAS, raised by startServer below — would
    // be shadowed by an unrelated one raised a line earlier.
    const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: true, trustedProxies: [] });
    await expect(startServer(config)).rejects.toThrow(/MOCK_BILLING_FORBIDDEN_IN_SAAS/);
  });

  it('a VERIFIED Bearer reaches the honest flag-off 404; an anonymous caller never does — identity is still resolved per-request', async () => {
    const url = await saasServer();
    const a = await account(url, 'a@flowmic.test');
    const verified = await call(url, 'GET', '/api/billing/plan', undefined, bearer(a.token));
    // 404 「mock billing gateway disabled」 sits BEHIND gate 2: only a caller who
    // proved who they are can learn the deployment has no gateway.
    expect(verified.status).toBe(404);
    expect(verified.raw).toContain('mock billing gateway disabled');
    const anonymous = await call(url, 'GET', '/api/billing/plan', undefined);
    expect(anonymous.status).toBe(401);
    expect(anonymous.json.error).toBe('AUTH_TOKEN_INVALID');
  });
});

// ── ② WHEN IT CANNOT TELL, IT REFUSES ────────────────────────────────────────

describe('saas: an unidentified caller is refused — never served as somebody', () => {
  it('every billing route without a Bearer → 401 by name, and 「default」 is nowhere in the answer', async () => {
    const url = await saasServer();
    for (const [method, path, body] of BILLING_ROUTES) {
      const r = await call(url, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.json.error, `${method} ${path}`).toBe('AUTH_TOKEN_INVALID');
      expect(typeof r.json.message).toBe('string');
      // The literal the old code would have served as. Asserted on the RAW body
      // so a user id smuggled into any field — plan echo, message, anything —
      // fails this line.
      expect(r.raw, `${method} ${path} must not name a user`).not.toContain(STANDALONE_USER_ID);
    }
  });

  it('an anonymous mutation leaves NO side effect on any row — not the constant user, not a real one', async () => {
    const url = await saasServer();
    const a = await account(url, 'side@flowmic.test');
    for (const [method, path, body] of BILLING_ROUTES) {
      if (method !== 'POST') continue;
      expect((await call(url, method, path, body)).status).toBe(401);
    }
    expect(server!.db.settings.read(STANDALONE_USER_ID, 'account.subscription')).toBeNull();
    expect(server!.db.settings.read(a.id, 'account.subscription')).toBeNull();
    // Nothing was booked in A's name either — read through the saas-legit plan
    // surface (M5: the mock gateway's read face no longer answers in saas; the
    // console subscription read is the same getPlan behind a Bearer).
    const plan = await call(url, 'GET', '/api/cloud/subscription', undefined, bearer(a.token));
    expect(plan.status).toBe(200);
    expect(plan.json.subscription).toMatchObject({ plan: 'free', state: 'none' });
  });

  it('an expired token → 401 AUTH_TOKEN_EXPIRED (re-login, not re-install — the two are told apart)', async () => {
    let nowMs = Date.parse('2026-07-31T00:00:00.000Z');
    const url = await saasServer(() => nowMs);
    const a = await account(url, 'exp@flowmic.test');
    // While the token is live the SAME request reaches the flag-off 404 — i.e.
    // it PASSED gate 2 (M5: 200 is no longer stageable here, the gateway cannot
    // exist in saas; the 404 sits strictly behind a passing verdict).
    expect((await call(url, 'GET', '/api/billing/quota', undefined, bearer(a.token))).status).toBe(404);
    nowMs += 8 * 24 * 60 * 60 * 1000; // past the 7-day JWT TTL
    const r = await call(url, 'GET', '/api/billing/quota', undefined, bearer(a.token));
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('AUTH_TOKEN_EXPIRED');
    expect(r.raw).not.toContain(STANDALONE_USER_ID);
  });

  it('a forged token → 401 AUTH_TOKEN_INVALID (rewriting `sub` cannot make you someone else)', async () => {
    const url = await saasServer();
    const a = await account(url, 'forge-a@flowmic.test');
    const b = await account(url, 'forge-b@flowmic.test');
    const [ha, pa, sa] = a.token.split('.') as [string, string, string];
    const sb = b.token.split('.')[2] as string;
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    const claimsA = JSON.parse(Buffer.from(pa, 'base64url').toString('utf8')) as Record<string, unknown>;

    // NOTE for anyone tempted to 「just flip a character in the signature」: the
    // LAST base64url char of a 32-byte HMAC carries 2 bits that decode() throws
    // away, so half of those flips decode to the identical signature and verify
    // fine. The cases below are the ones that actually matter anyway.
    const forgeries: Array<[string, string]> = [
      ['sub rewritten to the other account, original signature', `${ha}.${enc({ ...claimsA, sub: b.id })}.${sa}`],
      ["another account's signature pasted onto these claims", `${ha}.${pa}.${sb}`],
      ['alg:none header (no algorithm negotiation is offered)', `${enc({ alg: 'none', typ: 'JWT' })}.${pa}.`],
      ['not a JWT at all', 'not-a-jwt'],
      ['two segments', `${ha}.${pa}`],
      ['empty', ''],
    ];
    for (const [label, bad] of forgeries) {
      const r = await call(url, 'GET', '/api/billing/quota', undefined, { authorization: `Bearer ${bad}` });
      expect(r.status, label).toBe(401);
      expect(r.json.error, label).toBe('AUTH_TOKEN_INVALID');
      expect(r.raw, label).not.toContain(STANDALONE_USER_ID);
    }
  });

  it('the refusal is OUT LOUD: one warn line naming the route and the reason', async () => {
    const url = await saasServer();
    const warn = vi.spyOn(log, 'warn');
    expect((await call(url, 'GET', '/api/billing/quota', undefined)).status).toBe(401);
    const refusal = warn.mock.calls.find((c) => String(c[0]).includes('unidentified'));
    expect(refusal, 'a silent 401 is how nobody ever notices the relay being probed').toBeTruthy();
    expect(refusal![1]).toMatchObject({ route: '/api/billing/quota', reason: 'AUTH_TOKEN_INVALID' });
  });

  it('the 401 comes BEFORE the mock-gateway 404: an anonymous caller learns nothing about the deployment', async () => {
    // This used to compare a flag-on and a flag-off saas server and require
    // identical anonymous answers. M5 made the flag-on half UNSTAGEABLE — that
    // server refuses to boot (pinned in the M5 describe above) — so the only
    // deployment left to probe is flag-off, and the ordering property is now
    // asserted directly: an anonymous caller gets the 401, never the 404 that
    // would disclose 「this deployment has no gateway」.
    const url = await saasServer();
    const anon = await call(url, 'GET', '/api/billing/quota', undefined);
    expect(anon.status).toBe(401);
    expect(anon.json.error).toBe('AUTH_TOKEN_INVALID');
    expect(anon.raw).not.toContain('mock billing gateway disabled');
  });
});

// ── ③ STANDALONE: 'default' IS THE TRUE ANSWER, AND THAT IS ON PURPOSE ───────

describe("standalone: the single local user IS 'default' — correct, not a leftover", () => {
  // READ THIS BEFORE 「fixing」 standalone to demand a token. standalone mounts no
  // account REST at all (register/login/me are saas-only), mints no JWT, and
  // seeds exactly one user at boot; the desktop dials its own sidecar over
  // loopback with no credential to offer. Requiring one here would break the
  // owner's local quota/plan face while protecting nobody — there is no second
  // person on that machine to protect it from.
  it('no Authorization header at all → served as the one local user, and the write lands on that row', async () => {
    const url = await standaloneServer();
    const quota = await call(url, 'GET', '/api/billing/quota', undefined);
    expect(quota.status).toBe(200);
    expect(quota.json.stt.limit_min).toBeTypeOf('number');

    const co = await call(url, 'POST', '/api/billing/checkout', { cycle: 'monthly' });
    await call(url, 'POST', '/api/billing/confirm', { sessionId: co.json.sessionId });
    const row = server!.db.settings.read(STANDALONE_USER_ID, 'account.subscription');
    expect(row, "the owner's own plan must land on the owner's own row").not.toBeNull();
    expect((row!.value as { state: string }).state).toBe('active');
  });

  it('a stray Bearer changes nothing: on a single-user box a token cannot make you someone else', async () => {
    const url = await standaloneServer();
    const r = await call(url, 'GET', '/api/billing/plan', undefined, bearer('some-token-from-somewhere'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ plan: 'free', state: 'none' });
  });
});

// ── ④ THE RESOLVER ITSELF (the branches a server cannot easily stage) ────────

describe('makeResolveUserId — the seam, in isolation', () => {
  const req = (headers: Record<string, string> = {}): IncomingMessage =>
    ({ headers } as unknown as IncomingMessage);

  it('saas wiring with NO account verifier THROWS at construction (never a friendly fallback)', () => {
    // booklet 13 §7 F1 ②: a DI default is the real thing or a throw. A comfortable
    // empty here would silently restore 「everyone is 'default'」 in production,
    // and there would be no new symbol to grep for.
    expect(() => makeResolveUserId({ mode: 'saas', standaloneUserId: 'default' }))
      .toThrow(/account verifier/);
  });

  it('a validly-signed token for a since-deleted account → AUTH_TOKEN_INVALID', () => {
    // The signature being good is a different question from the account being
    // real, and only the second one may open a door.
    const ghost: AccountVerifier = {
      verifyToken: () => ({ ok: true, sub: 'vanished-user', plan: 'pro', exp: 9_999_999_999 }),
      getUser: () => null,
    };
    const resolve = makeResolveUserId({ mode: 'saas', standaloneUserId: 'default', account: ghost });
    expect(resolve(req({ authorization: 'Bearer anything' }))).toEqual({ ok: false, error: 'AUTH_TOKEN_INVALID' });
  });

  it('the verdict for a live account carries that account\'s id and nothing else', () => {
    const live: AccountVerifier = {
      verifyToken: () => ({ ok: true, sub: 'u-77', plan: 'free', exp: 9_999_999_999 }),
      getUser: (id) => ({ id, email: null, display_name: 'x', plan: 'free', password_hash: 'scrypt$secret' }) as never,
    };
    const verdict = accountFromBearer(req({ authorization: 'Bearer t' }), live);
    expect(verdict).toEqual({ ok: true, userId: 'u-77' });
    // The id-only face exists so a password_hash can never ride along into a dep
    // type that has no business holding one.
    expect(JSON.stringify(verdict)).not.toContain('scrypt');
  });

  it('the Bearer parser: one definition, shared by /api/me, the console and the gateway', () => {
    expect(bearerToken(req({ authorization: 'Bearer abc' }))).toBe('abc');
    expect(bearerToken(req({ authorization: 'bearer abc' })), 'RFC 7235 scheme is case-insensitive').toBe('abc');
    expect(bearerToken(req({ authorization: '  Bearer   abc  ' }))).toBe('abc');
    for (const h of ['Basic abc', 'Bearer', 'Bearer ', '']) {
      expect(bearerToken(req(h === '' ? {} : { authorization: h })), h || '(absent)').toBeNull();
    }
  });
});

// ── ⑤ THE REGRESSION GUARD: no second 'default' may reappear ─────────────────

describe("census: 'default' survives in exactly one place in the http surface", () => {
  // The defect was a one-line fallback. The cheapest way for it to come back is
  // another one-line fallback, written by someone fixing an unrelated 401 —
  // which every functional test in the repo would keep passing through. Only a
  // census catches that (same discipline as billing-call-sites.test.ts).
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '');
  const read = (rel: string): string => strip(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

  it('no http route module contains the literal at all — identity is resolved, never defaulted', () => {
    for (const f of ['router.ts', 'account-auth.ts', 'auth-routes.ts', 'console-routes.ts', 'inject-routes.ts', 'diag-routes.ts', 'local-only.ts']) {
      expect(read(`../src/http/${f}`), `src/http/${f}`).not.toContain("'default'");
    }
  });

  it('bootstrap declares it ONCE, as the standalone constant', () => {
    const code = read('../src/bootstrap.ts');
    const hits = code.match(/'default'/g) ?? [];
    expect(hits.length, 'a second occurrence is either a duplicate truth or a fallback').toBe(1);
    expect(code).toContain("export const STANDALONE_USER_ID = 'default'");
    // The census can actually fail (it is not matching an empty file).
    expect(code.length).toBeGreaterThan(1000);
  });
});
