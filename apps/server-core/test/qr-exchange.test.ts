// POST /api/auth/qr-exchange — the SECOND door onto the ONE single-use grant
// store, opened for the PC browser sign-in (owner 2026-08-27, the UAT correction
// block at the bottom of
// docs/decisions/2026-08-27-owner-no-password-login-on-clients.md: 「浏览器里
// Gmail 都登录成功了，为什么还要我去复制 Key」).
//
// The desktop signs in through the system browser; the console mints a grant and
// redirects the browser to a loopback listener the desktop opened; the desktop
// exchanges the nonce for a JWT here. So this route is a LOGIN, and these tests
// are about the properties that make that safe rather than about the happy path:
//
//   ① the SAME grant, whichever door it is pushed through — spending it on the
//      socket must leave nothing for REST, and vice versa. This is the one
//      property a second store would silently destroy, so it is asserted in BOTH
//      orders, against a REAL server where both doors share one process;
//   ② unknown / expired / already-used are ONE outcome — no existence oracle;
//   ③ redemption is throttled, because it is a login;
//   ④ the body is byte-compatible with /api/login's, so the desktop stores the
//      token through the path a pasted Cloud Key already takes;
//   ⑤ the refusal name never leaked into the protocol code table;
//   ⑥ standalone mounts nothing.
//
// *** HUMAN-AUDIT SENSITIVE (auth) ***

import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { ERROR_CODES } from '@flowmic/protocol';
import { QR_GRANT_TTL_MS } from '../src/auth/qr-grant';

const SECRET = 'qr-exchange-secret-32-bytes-minimum-x';
const EMAIL = 'pc@example.com';
const PASSWORD = 'longenough12345';

let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (server) await server.close();
  server = null;
});

/** A real saas server. `trustedProxies: []` because an in-process server's
 *  direct peer IS the client (config.ts §trustedProxies, fix-010). */
async function saas(now?: () => number): Promise<string> {
  server = await startServer(
    loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] }),
    now ? { now } : {},
  );
  return `http://127.0.0.1:${server.port}`;
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { __raw: text };
  }
  return { status: r.status, json };
}

async function register(url: string, email = EMAIL): Promise<{ id: string; token: string }> {
  const r = await post(url, '/api/register', { email, password: PASSWORD });
  expect(r.status, `register failed: ${JSON.stringify(r.json)}`).toBe(201);
  return { id: (r.json.user as { id: string }).id, token: r.json.token as string };
}

/** Mint through the route the console really calls — never by reaching into the
 *  store, so a mint that stopped being Bearer-gated would be visible here. */
async function mint(url: string, token: string): Promise<string> {
  const r = await post(url, '/api/auth/qr-grant', {}, { authorization: `Bearer ${token}` });
  expect(r.status, `mint failed: ${JSON.stringify(r.json)}`).toBe(200);
  return r.json.nonce as string;
}

function connect(url: string): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function ackOf(socket: ClientSocket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ack for ${event}`)), 4000);
    socket.emit(event, payload, (r: Record<string, unknown>) => {
      clearTimeout(t);
      resolve(r ?? {});
    });
  });
}

describe('POST /api/auth/qr-exchange', () => {
  it('exchanges a live grant for a session, in /api/login\'s own body shape', async () => {
    const url = await saas();
    const { id, token } = await register(url);
    const nonce = await mint(url, token);

    const r = await post(url, '/api/auth/qr-exchange', { nonce });
    expect(r.status).toBe(200);
    expect(typeof r.json.token).toBe('string');
    // ④ The desktop feeds this straight into the same store-a-Cloud-Key path a
    // paste takes, so the projection has to be the SAME projection — and it must
    // never carry the hash.
    const user = r.json.user as Record<string, unknown>;
    expect(user.id).toBe(id);
    expect(user.email).toBe(EMAIL);
    expect(Object.keys(user)).not.toContain('password_hash');
    expect(JSON.stringify(r.json)).not.toContain('password');
    // The nonce is a credential; the answer must not hand it back.
    expect(JSON.stringify(r.json)).not.toContain(nonce);
  });

  it('🔴 REVERSE CONTROL (ii-a) — a nonce spent on the SOCKET is dead at REST', async () => {
    // The property that a second store would destroy while every test of each
    // store individually stayed green. Both doors are in ONE process here, so
    // this is a statement about the grant, not about a mock.
    const url = await saas();
    const { token } = await register(url);
    const nonce = await mint(url, token);

    const socket = await connect(url);
    const ack = await ackOf(socket, 'mobile:login', { qr_nonce: nonce });
    expect(ack.ok, `socket door refused a live grant: ${JSON.stringify(ack)}`).toBe(true);

    const second = await post(url, '/api/auth/qr-exchange', { nonce });
    expect(second.status).toBe(401);
    expect(second.json).toEqual({ error: 'GRANT_INVALID' });
  });

  it('🔴 REVERSE CONTROL (ii-b) — a nonce spent at REST is dead on the SOCKET', async () => {
    const url = await saas();
    const { token } = await register(url);
    const nonce = await mint(url, token);

    const first = await post(url, '/api/auth/qr-exchange', { nonce });
    expect(first.status).toBe(200);

    const socket = await connect(url);
    const ack = await ackOf(socket, 'mobile:login', { qr_nonce: nonce });
    // The socket arm's own no-oracle answer, unchanged by this route existing.
    expect(ack).toEqual({ error: 'AUTH_LOGIN_FAILED' });
  });

  it('🔴 REVERSE CONTROL (ii-c) — REST twice is dead the second time', async () => {
    const url = await saas();
    const { token } = await register(url);
    const nonce = await mint(url, token);

    expect((await post(url, '/api/auth/qr-exchange', { nonce })).status).toBe(200);
    const replay = await post(url, '/api/auth/qr-exchange', { nonce });
    expect(replay.status).toBe(401);
    expect(replay.json).toEqual({ error: 'GRANT_INVALID' });
  });

  it('② unknown, already-used, expired and malformed are ONE answer', async () => {
    // 🔴 THIS IS WHY THERE IS NO `GRANT_EXPIRED`. auth/qr-grant.ts states 「NO
    // ORACLE … A caller must not be able to learn that a nonce once existed」 and
    // `redeem` makes it structural (it deletes an expired grant before it checks
    // the clock). Two names here would rebuild the oracle that file removed, AND
    // make the two doors onto one store answer the same question differently.
    // The user-facing 「your sign-in window ran out」 sentence lives on the
    // desktop, which owns its own deadline and asks nobody.
    //
    // ⚠️ SEQUENTIAL, AND THE PROBE COUNT IS DELIBERATE. Every attempt here spends
    // the shared login brake (5 / 10 min — the very property ③ asserts), so a
    // batch of six on one server measures the LIMITER and not the oracle. The
    // first draft did exactly that and went red on 429; the fix is a smaller
    // probe set per server, not a wider budget.
    let clock = 1_700_000_000_000;
    const url = await saas(() => clock);
    const { token } = await register(url); // spends 1
    const used = await mint(url, token); // mints are Bearer-gated, not throttled
    const stale = await mint(url, token);
    expect((await post(url, '/api/auth/qr-exchange', { nonce: used })).status).toBe(200); // spends 2
    clock += QR_GRANT_TTL_MS + 1;

    for (const body of [{ nonce: used }, { nonce: stale }, { nonce: 'never-existed' }]) {
      const a = await post(url, '/api/auth/qr-exchange', body); // spends 3, 4, 5
      expect(a.status, `probe ${JSON.stringify(body)} answered differently`).toBe(401);
      expect(a.json).toEqual({ error: 'GRANT_INVALID' });
    }
  });

  it('②b a malformed body reads exactly like a wrong nonce', async () => {
    // A fresh server for its own budget (see the note above). Nothing about the
    // SHAPE of the request may be distinguishable from a bad credential either.
    const url = await saas();
    await register(url); // spends 1
    for (const body of [{ nonce: '' }, {}, { nonce: 42 }]) {
      const a = await post(url, '/api/auth/qr-exchange', body); // spends 2, 3, 4
      expect(a.status, `body ${JSON.stringify(body)} answered differently`).toBe(401);
      expect(a.json).toEqual({ error: 'GRANT_INVALID' });
    }
  });

  it('③ redemption is throttled on the SAME per-IP budget as /api/login', async () => {
    // Not a separate bucket: a nonce endpoint sharing the login brake is what
    // stops it from being an unthrottled guessing surface with its own budget.
    const url = await saas();
    let sawLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await post(url, '/api/auth/qr-exchange', { nonce: `guess-${i}` });
      if (r.status === 429) {
        expect(r.json).toEqual({ error: 'REGISTER_RATE_LIMITED' });
        sawLimit = true;
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(sawLimit, 'guessing was never throttled — the route has no limiter').toBe(true);
  });

  it('③b the throttle is SHARED — exchange attempts spend /api/login\'s budget', async () => {
    // A positive control for the assertion above: if the two routes had their
    // own buckets, /api/login would still have a full budget after this loop.
    const url = await saas();
    for (let i = 0; i < 12; i += 1) {
      const r = await post(url, '/api/auth/qr-exchange', { nonce: `guess-${i}` });
      if (r.status === 429) break;
    }
    const login = await post(url, '/api/login', { email: EMAIL, password: PASSWORD });
    expect(login.status, 'the login route kept its own budget — the brake is not shared').toBe(429);
  });

  it('⑤ GRANT_INVALID is HTTP-local — it never entered the protocol code table', async () => {
    // The google-login.test.ts pin, applied here: minting a protocol code is
    // owner-gated, so the absence is asserted rather than promised in a comment.
    expect(Object.keys(ERROR_CODES)).not.toContain('GRANT_INVALID');
    expect(Object.keys(ERROR_CODES)).not.toContain('GRANT_EXPIRED');
  });

  it('⑥ standalone does not mount it', async () => {
    server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
    const url = `http://127.0.0.1:${server.port}`;
    const r = await post(url, '/api/auth/qr-exchange', { nonce: 'anything' });
    expect(r.status).toBe(404);
  });
});
