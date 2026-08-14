// WP-R4-1 ③⑤⑥ — the saas socket account path end-to-end over a real in-process
// server + socket.io-client: mobile:login matrix (standalone byte-compat / saas
// verify), cloud-instance admission (idempotent find-or-create, unauthenticated
// + standalone fail-loud), the cloud-session plaintext-history gate, and the
// auth:expired watchdog (F-2093, injected scheduler for determinism).

import { afterEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle, type BootstrapOverrides } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { signJwt, verifyJwt } from '../src/auth/jwt';

const SECRET = 'cloud-admission-secret-32-bytes-min-xx';
const SECRET_BUF = Buffer.from(SECRET, 'utf8');

let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];

async function saas(overrides: BootstrapOverrides = {}): Promise<string> {
  // 0.3.0 M5: saas + mock billing REFUSES TO MOUNT (router.ts
  // `assertMockBillingMountable`). The flag was legacy convenience here —
  // measured, not assumed: `config.mockBilling` has exactly two readers in src/
  // (the M5 mount guard and the `/api/billing/*` gateway's 404) and this file
  // requests no `/api/billing/*` path (grep: 0 hits). It tests mobile:login,
  // cloud-instance admission, the plaintext-history gate and auth:expired —
  // none of which the flag can reach.
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] });
  server = await startServer(config, overrides);
  return `http://127.0.0.1:${server.port}`;
}
async function standalone(): Promise<string> {
  server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (server) await server.close();
  server = null;
});

function connect(url: string, auth: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}
function ack<T = any>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 3000);
    socket.emit(event, payload, (r: T) => { clearTimeout(t); resolve(r); });
  });
}
function once(socket: ClientSocket, event: string, ms = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), ms);
    socket.once(event, (d: unknown) => { clearTimeout(t); resolve(d); });
  });
}
async function registerUser(url: string, email: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`${url}/api/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'longenough1' }),
  });
  const json = await res.json() as { token: string; user: { id: string } };
  return { id: json.user.id, token: json.token };
}

describe('mobile:login matrix', () => {
  it('standalone acks {ok:true, mode:"standalone"} (byte-compat, no token)', async () => {
    const url = await standalone();
    const c = await connect(url);
    const login = await ack(c, 'mobile:login', { email: 'a@b.co', password: 'whatever' });
    expect(login).toEqual({ ok: true, mode: 'standalone' });
    const logout = await ack(c, 'mobile:logout', {});
    expect(logout).toEqual({ ok: true, mode: 'standalone' });
  });

  it('saas wrong password → {error:"AUTH_LOGIN_FAILED"}', async () => {
    const url = await saas();
    await registerUser(url, 'wrong@b.co');
    const c = await connect(url);
    const login = await ack(c, 'mobile:login', { email: 'wrong@b.co', password: 'NOT-IT' });
    expect(login.error).toBe('AUTH_LOGIN_FAILED');
    expect(login.token).toBeUndefined();
  });

  it('saas success → {ok:true, token:<verifiable JWT>, user, mode:"saas"}', async () => {
    const url = await saas();
    const { id } = await registerUser(url, 'ok@b.co');
    const c = await connect(url);
    const login = await ack(c, 'mobile:login', { email: 'ok@b.co', password: 'longenough1' });
    expect(login.ok).toBe(true);
    expect(login.mode).toBe('saas');
    // A2-3 — `restricted` is part of `publicUser`, so it rides the SOCKET login
    // ack too. Listed here rather than relaxed to `toMatchObject`: this is the
    // one assertion that proves the phone's account-login path carries the flag,
    // and it went red when the field landed.
    expect(login.user).toEqual({ id, email: 'ok@b.co', display_name: 'User', plan: 'free', email_verified: false, restricted: false });
    expect(verifyJwt(login.token, { secret: SECRET_BUF }).sub).toBe(id);
  });

  it('socket mobile:login shares the REST per-IP throttle (6th attempt → REGISTER_RATE_LIMITED)', async () => {
    // Human-audit finding (WP-R4-1): the socket credential channel must not be an
    // unthrottled password oracle. 5 attempts/window from one IP, then blocked —
    // and blocked BEFORE the credential verify (distinct code, not AUTH_LOGIN_FAILED).
    const url = await saas();
    const c = await connect(url);
    for (let i = 0; i < 5; i++) {
      const r = await ack(c, 'mobile:login', { email: 'ghost@b.co', password: 'whatever8' });
      expect(r.error).toBe('AUTH_LOGIN_FAILED'); // no such user, no oracle
    }
    const blocked = await ack(c, 'mobile:login', { email: 'ghost@b.co', password: 'whatever8' });
    expect(blocked.error).toBe('REGISTER_RATE_LIMITED');
  });
});

describe('cloud-instance admission', () => {
  it('handshake-JWT socket → cloud ack shape (FlowMic Cloud, pc_online:false, role:active)', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'cloud@b.co');
    const c = await connect(url, { jwt: token });
    const pair = await ack(c, 'mobile:pair', { cloud_instance: true });
    expect(pair.pc_instance_id).toBe('flowmic-cloud-instance');
    expect(pair.pc_name).toBe('FlowMic Cloud');
    expect(pair.pc_online).toBe(false);
    expect(pair.role).toBe('active');
    expect(pair.mobile_token).toMatch(/^fm_[0-9a-f]{64}$/);
    expect(typeof pair.pairing_id).toBe('string');
    expect(typeof pair.room_uuid).toBe('string');
  });

  it('re-admission is idempotent: two pairs → one PC row, one pairing row, same ids', async () => {
    const url = await saas();
    const { id, token } = await registerUser(url, 'idem@b.co');
    const c1 = await connect(url, { jwt: token });
    const p1 = await ack(c1, 'mobile:pair', { cloud_instance: true });
    const c2 = await connect(url, { jwt: token });
    const p2 = await ack(c2, 'mobile:pair', { cloud_instance: true });
    expect(p2.pc_id).toBe(p1.pc_id);
    expect(p2.pairing_id).toBe(p1.pairing_id);
    expect(p2.mobile_token).toBe(p1.mobile_token);
    // DB truth: exactly one virtual PC row + one pairing row for the user.
    const pcs = server!.db.pcs.listByUser(id);
    expect(pcs.length).toBe(1);
    expect(server!.db.mobiles.listByPc(pcs[0]!.id).length).toBe(1);
  });

  it('in-session mobile:login (no handshake JWT) also admits the cloud instance', async () => {
    const url = await saas();
    await registerUser(url, 'insession@b.co');
    const c = await connect(url); // no handshake jwt
    const login = await ack(c, 'mobile:login', { email: 'insession@b.co', password: 'longenough1' });
    expect(login.ok).toBe(true);
    const pair = await ack(c, 'mobile:pair', { cloud_instance: true });
    expect(pair.pc_instance_id).toBe('flowmic-cloud-instance');
    expect(pair.role).toBe('active');
  });

  it('unauthenticated saas socket → {error:"AUTH_TOKEN_INVALID"}', async () => {
    const url = await saas();
    const c = await connect(url); // no jwt, no login
    const pair = await ack(c, 'mobile:pair', { cloud_instance: true });
    expect(pair.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('EXPIRED handshake JWT → {error:"AUTH_TOKEN_EXPIRED"}', async () => {
    const url = await saas();
    const expired = signJwt({ sub: 'anyone', plan: 'free' }, { secret: SECRET_BUF, ttlMs: -1000 });
    const c = await connect(url, { jwt: expired });
    const pair = await ack(c, 'mobile:pair', { cloud_instance: true });
    expect(pair.error).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('standalone cloud pair → {error:"PAIR_INVALID_PAYLOAD"} (fail-loud, needs saas)', async () => {
    const url = await standalone();
    const c = await connect(url);
    const pair = await ack(c, 'mobile:pair', { cloud_instance: true });
    expect(pair.error).toBe('PAIR_INVALID_PAYLOAD');
  });
});

// ⑥ used to be the CLOUD-SESSION-ONLY plaintext-history gate: a cloud-instance
// solo session was refused server-side history while a paired session was allowed
// it. 0.2.27 widened the refusal to EVERY session (owner architecture ruling
// docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md), so the gate this case
// guarded is now the whole door — and its code changed with it, deliberately:
// CLOUD_SESSION_NO_HISTORY names the session type as the reason, which is no
// longer the reason. Kept here (rather than only in history-retired.test.ts)
// because this is the one place the refusal is exercised over a REAL socket
// against a REAL saas server — the path a cloud phone actually walks.
describe('cloud-session plaintext-history gate (⑥ — now the universal retirement)', () => {
  it('history:create on a cloud-instance session → {error:"HISTORY_SYNC_RETIRED"}', async () => {
    const url = await saas();
    const { token } = await registerUser(url, 'nohist@b.co');
    const c = await connect(url, { jwt: token });
    await ack(c, 'mobile:pair', { cloud_instance: true });
    const created = await ack(c, 'history:create', {
      item: {
        id: 'entry-cloud-1', pc_device_id: 'x', mobile_id: null, mode: 'realtime',
        source_text: 'hello', source_lang: null, output_text: 'hello', output_lang: null,
        duration_ms: null, segments_count: 0, status: 'injected',
      },
    });
    expect(created.error).toBe('HISTORY_SYNC_RETIRED');
    // Not the old code, and above all not SETTINGS_SYNC_FAIL — the phone turns
    // that one into a local row DELETE (see history-retired.test.ts).
    expect(created.error).not.toBe('CLOUD_SESSION_NO_HISTORY');
    expect(created.error).not.toBe('SETTINGS_SYNC_FAIL');
  });
});

describe('auth:expired watchdog (F-2093)', () => {
  it('fires auth:expired + disconnects a JWT socket at exp (injected scheduler)', async () => {
    const timers: Array<() => void> = [];
    const fakeSetTimeout = ((cb: () => void) => { timers.push(cb); return timers.length as unknown as NodeJS.Timeout; }) as unknown as typeof setTimeout;
    const fakeClearTimeout = (() => {}) as unknown as typeof clearTimeout;
    const url = await saas({ setTimeoutFn: fakeSetTimeout, clearTimeoutFn: fakeClearTimeout });
    const { token } = await registerUser(url, 'watchdog@b.co');
    const c = await connect(url, { jwt: token });
    // Let the connection handler arm the watchdog for this account socket.
    await new Promise((r) => setTimeout(r, 60));
    expect(timers.length).toBe(1);
    const expiredP = once(c, 'auth:expired');
    const goneP = new Promise<void>((resolve) => c.once('disconnect', () => resolve()));
    timers[0]!(); // simulate exp reached
    await expiredP;
    await goneP;
  });
});
