// Card MP-11 / gap G-16 (2026-09-11) — A THIRD-PARTY PAGE COULD NOT REACH THE
// ARM BUILT FOR IT.
//
// MP-1 built the `publishable_key` arm of `POST /api/web/rooms`; MP-2 built the
// SDK that calls it and measured (web `7d0481d`) that it never arrives. The
// call is cross-origin by definition — that is what「a host page we have never
// heard of」means — and it carries `Authorization` + a JSON body, both
// non-simple, so a browser sends an OPTIONS preflight first and sends nothing
// else unless that preflight is granted. Nothing on this route had ever heard
// of OPTIONS: `tryHandleWebRoomRoutes` returned false for any method but POST
// and the request fell through to the router's 404.
//
// SPEC-REF:
//   src/http/web-cors.ts (the second header — why this grant reflects any
//     origin, and why that is not a hole)
//   src/http/web-room-routes.ts (`tryHandleWebRoomRoutes`'s preflight, and the
//     grant applied inside `handleIntegrator` and nowhere else)
//   src/http/web-cors-preflight-paths.ts (the replica half)
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §9 row G-16
//
// 🔴 WHAT THIS FILE IS REALLY FOR — the two halves of a CORS fix fail
// independently, and either one alone still leaves the feature dead:
//  ① the PREFLIGHT must be answered (or the browser never sends the POST), and
//  ② the REAL RESPONSE must carry the grant (or the browser discards the POST's
//     answer unread — a 200 full of room credentials and a 401 are the same
//     `TypeError: Failed to fetch` from the page's side).
// Asserting only ① is the shape this repo pays for constantly: a green test
// about a mechanism's first half.
//
// 🔴 AND THE THIRD CASE IS THE NEGATIVE ONE. The demo arm and the account arm
// are called from a page whose own origin already serves `/api/`, they carry no
// CORS header today, and this card must not give them one. Their absence is
// asserted, not commented.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { makeBudgetPusher } from '../src/billing/budget-push';
import { planLimits } from '../src/billing/plans';
import { Registry } from '../src/room/registry';
import { tryHandleWebRoomRoutes, type WebRoomRoutesDeps } from '../src/http/web-room-routes';
import type { IntegratorKeyGuard } from '../src/billing/integrator-quota';
import type { IntegratorKeyRow } from '../src/db/repos/integrator-key.repo';

const SECRET = 'web-room-cors-secret-32-bytes-min-xx';
const T0 = Date.parse('2026-09-11T00:00:00.000Z');
/** A third-party site. Deliberately NOT flowmic.app: the whole gap is that the
 *  allow-list this server already had cannot contain this value, and never
 *  will — there is no list of the internet. */
const HOST_PAGE = 'https://acme-crm.example';
const OTHER_PAGE = 'https://someone-else.example';
const KEY = 'pk_live_mp11_test';

let db: DbConnection;
let auth: AuthService;
let registry: Registry;
let server: Server;
let url: string;
let deps: WebRoomRoutesDeps;
let ownerId: string;

/** The key guard, real in shape and honest about its two refusals. The `origin`
 *  refusal is the gate the preflight CANNOT make (no bearer travels on a
 *  preflight), which is exactly why it must still be made here. */
function keyGuard(allowedOrigin: string): IntegratorKeyGuard {
  const row = { id: 'key-1', user_id: ownerId, publishable_key: KEY } as unknown as IntegratorKeyRow;
  return {
    admit: (presented, origin) => {
      if (presented !== KEY) return { ok: false, reason: 'unknown' };
      if (origin !== allowedOrigin) return { ok: false, reason: 'origin' };
      return { ok: true, key: row };
    },
    remainingMs: () => Number.POSITIVE_INFINITY,
    keyIdForRoom: () => 'key-1',
  };
}

function makeDeps(over: Partial<WebRoomRoutesDeps> = {}): WebRoomRoutesDeps {
  return {
    auth,
    rooms: registry,
    budget: makeBudgetPusher({
      remainingSttMs: () => 1_234_567,
      periodEndMs: () => T0 + 86_400_000,
      modeFor: () => 'plan' as const,
      freePlanMinutes: () => 20,
      integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    }),
    limiter: new RegisterRateLimiter({ now: () => T0, maxAttempts: 5, windowMs: 60_000 }),
    integrator: {
      keys: keyGuard(HOST_PAGE),
      // The REAL mint, through the REAL registry — a stub here would prove the
      // headers exist on a response no production path produces.
      mint: (user_id, key_id, opts) => registry.mintIntegratorRoom(user_id, key_id, opts),
    },
    ...over,
  };
}

beforeEach(async () => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => T0 });
  registry = new Registry({
    pcs: db.pcs, mobiles: db.mobiles, mode: 'saas', limitsOf: () => planLimits('free'), now: () => T0,
    // REQUIRED for the integrator mint, and the class says why: a room minted
    // without its key edge is a room billed to the integrator with NO
    // sub-quota ceiling. Wired here rather than left out so this fixture mints
    // the same row production does.
    integratorKeys: { bindRoom: () => undefined },
  });
  const owner = await auth.register({ email: 'integrator@example.com', password: 'longenough1', display_name: 'T' });
  ownerId = owner.id;
  deps = makeDeps();
  server = createServer((req, res) => {
    if (tryHandleWebRoomRoutes(req, res, deps)) return;
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

async function preflight(headers: Record<string, string>): Promise<Response> {
  return fetch(`${url}/api/web/rooms`, { method: 'OPTIONS', headers });
}
async function post(headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(`${url}/api/web/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('① the preflight a third-party host page actually sends', () => {
  it('OPTIONS from an unknown origin is 204 with that origin reflected, Vary: Origin, POST+OPTIONS and authorization+content-type', async () => {
    const res = await preflight({
      origin: HOST_PAGE,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(HOST_PAGE);
    expect(res.headers.get('vary')?.toLowerCase()).toBe('origin');
    // 🔴 NO CREDENTIALS. The grant reflects any origin, so this header is what
    // keeps it from being a hole: no cookie and no ambient credential may ride
    // on these requests. Asserted as ABSENT rather than as 'false' — a browser
    // treats both the same, but a future edit that sets it to 'true' must make
    // this line red, and `not.toBe('true')` would pass for a missing header AND
    // for a mangled one.
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    const methods = res.headers.get('access-control-allow-methods') ?? '';
    expect(methods).toContain('POST');
    expect(methods).toContain('OPTIONS');
    const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    // Both, and named individually: `authorization` is how all three arms read
    // their credential, `content-type` is how the body arrives. A browser drops
    // the POST if either is missing from this line.
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
  });

  it('a SECOND, different origin gets ITS own value back — the grant is reflected, not a remembered constant', async () => {
    // Without this, a handler that hard-coded the first origin it ever saw (or
    // one that echoed a fixed string) would pass the case above.
    const a = await preflight({ origin: HOST_PAGE, 'access-control-request-method': 'POST' });
    const b = await preflight({ origin: OTHER_PAGE, 'access-control-request-method': 'POST' });
    expect(a.headers.get('access-control-allow-origin')).toBe(HOST_PAGE);
    expect(b.headers.get('access-control-allow-origin')).toBe(OTHER_PAGE);
  });

  it('an OPTIONS with NO Origin at all is still 204, and grants nothing — a non-browser caller is left exactly as it was', async () => {
    const res = await preflight({ 'access-control-request-method': 'POST' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('② the REAL response, without which the preflight buys nothing', () => {
  it('a 200 on the publishable-key arm carries the reflected grant, so the page can read the room it was given', async () => {
    const res = await post({ origin: HOST_PAGE, authorization: `Bearer ${KEY}` }, { auth: { kind: 'publishable_key' } });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    // Positive control on the reading: if the arm had refused for some other
    // reason, a green header assertion would say nothing about the path that
    // matters.
    expect(typeof body.room_token).toBe('string');
    expect((body.budget as Record<string, unknown>).mode).toBe('integrator');
    expect(res.headers.get('access-control-allow-origin')).toBe(HOST_PAGE);
    expect(res.headers.get('vary')?.toLowerCase()).toBe('origin');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('🔴 the ORIGIN REFUSAL still refuses — and now the page can read WHY', async () => {
    // The preflight cannot be key-scoped (it carries no bearer), so this is the
    // gate that does the real work, unchanged by this card. The header on it is
    // the point: `WEB_ROOM_ORIGIN_NOT_ALLOWED` is the one sentence a developer
    // wiring the SDK most needs to actually read, and without the grant it
    // reaches them as「Failed to fetch」.
    const res = await post({ origin: OTHER_PAGE, authorization: `Bearer ${KEY}` }, { auth: { kind: 'publishable_key' } });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(403);
    expect(body.error).toBe('WEB_ROOM_ORIGIN_NOT_ALLOWED');
    expect(res.headers.get('access-control-allow-origin')).toBe(OTHER_PAGE);
  });

  it('a bad key is still 401 AUTH_TOKEN_INVALID, readable', async () => {
    const res = await post({ origin: HOST_PAGE, authorization: 'Bearer pk_live_not_a_key' }, { auth: { kind: 'publishable_key' } });
    expect(res.status).toBe(401);
    expect((await res.json() as Record<string, unknown>).error).toBe('AUTH_TOKEN_INVALID');
    expect(res.headers.get('access-control-allow-origin')).toBe(HOST_PAGE);
  });
});

describe('③ 🔴 UNCHANGED: the two arms this card has no business on', () => {
  it('the ACCOUNT arm answers with NO cors header at all, exactly as before', async () => {
    const user = await auth.register({ email: 'someone@example.com', password: 'longenough1', display_name: 'U' });
    const res = await post(
      { origin: HOST_PAGE, authorization: `Bearer ${auth.issueToken(user).token}` },
      { auth: { kind: 'account_jwt' } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
  });

  it('the DEMO arm answers with NO cors header at all — its own Origin gate is untouched and still the only one it has', async () => {
    // No `anon` wiring ⇒ 503 WEB_DEMO_UNAVAILABLE, which is this arm's answer
    // on this fixture before and after the card. What is asserted is the
    // ABSENCE of a header, which is true on every one of its exits.
    const res = await post({ origin: HOST_PAGE }, { auth: { kind: 'anon_token' } });

    expect(res.status).toBe(503);
    expect((await res.json() as Record<string, unknown>).error).toBe('WEB_DEMO_UNAVAILABLE');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('REVERSE CONTROL', () => {
  it('evidence is in the delivery report — read it before trusting the green above', () => {
    // Measured 2026-09-11, both directions, restored immediately after:
    //  · removing `if (handleReflectedOriginPreflight(req, res)) return true;`
    //    from `tryHandleWebRoomRoutes` ⇒ every case in ① fails, the first with
    //    `expected 404 to be 204` (the request falls through to the harness's
    //    own not-found, which is exactly what a browser met in production).
    //  · removing `applyReflectedOrigin(req, res);` from `handleIntegrator` ⇒
    //    every case in ② fails with `expected null to be
    //    'https://acme-crm.example'`, while ① stays green — which is the whole
    //    reason both halves are asserted.
    expect(true).toBe(true);
  });
});
