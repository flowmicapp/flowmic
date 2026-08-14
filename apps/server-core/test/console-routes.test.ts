// R5-WEB WP-W1 — the saas-only console REST surface (POST /api/logout, POST
// /api/password/{forgot,reset}, GET /api/cloud/{summary,subscription,devices},
// POST /api/cloud/devices/revoke). Runs against a real in-process saas server;
// each test gets a FRESH server so the per-IP throttle + rows never leak. These
// are the contract-test placeholder consumers for every new endpoint until the
// W2 console wires the real UI calls (anti-façade: proven live here first).
//
// *** HUMAN-AUDIT SENSITIVE (password reset rotation + pairing revoke) ***

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 🔴 OSS-DEFAULTS (0.3.0): a STOCK install seeds `builtin-sherpa-local` and NO
// `llm.config` at all, so the assertions below — which are about the console STT-routings editor and not
// about what ships as the default — name the presets they need, exactly the way
// a deployment does in `/etc/flowmic-app/env`. The values are the pre-card
// defaults verbatim, so what these tests measure is unchanged.
const OSS_DEFAULTS_PRESET_ENVS: Record<string, string> = {
  FLOWMIC_DEFAULT_STT_ZH_PRESET: 'lan-funasr-ws',
  FLOWMIC_DEFAULT_STT_WILDCARD_PRESET: 'lan-sensevoice',
  FLOWMIC_DEFAULT_LLM_PRESET: 'lan-vllm-qwen35',
};
const ossDefaultsSaved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(OSS_DEFAULTS_PRESET_ENVS)) {
    ossDefaultsSaved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(OSS_DEFAULTS_PRESET_ENVS)) {
    if (ossDefaultsSaved[k] === undefined) delete process.env[k];
    else process.env[k] = ossDefaultsSaved[k];
  }
});

import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { newToken } from '../src/auth/token';
import { Registry, isRealPc } from '../src/room/registry';
import { planLimits } from '../src/billing/plans';

const SECRET = 'console-routes-secret-32-bytes-min-xxx';
let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];

async function saasServer(now?: () => number): Promise<{ url: string; handle: BootstrapHandle }> {
  // 0.3.0 M5 made saas + mockBilling REFUSE TO SERVE at mount
  // (router.assertMockBillingMountable), so the flag is gone from this helper.
  // Nothing in this suite reads /api/billing/* — the console surface talks to
  // BillingService directly (getPlan/getQuota/effectiveLimits), which exists
  // independent of the mock HTTP gateway.
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config, now ? { now } : {});
  return { url: `http://127.0.0.1:${server.port}`, handle: server };
}
async function standaloneServer(): Promise<string> {
  server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
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
async function registerUser(url: string, email: string): Promise<{ token: string; id: string }> {
  const r = await post(`${url}/api/register`, { email, password: 'longenough1', display_name: 'C' });
  // VERIFY-1 — this suite's subject is the console features BEHIND the
  // verification gate, so every account it mints is verified through the SAME
  // repo the confirm route writes (the gate itself — refuse/admit/grandfather —
  // is proven in test/email-verification.test.ts).
  server!.db.emailVerification.markVerified(r.json.user.id as string, Date.now());
  return { token: r.json.token as string, id: r.json.user.id as string };
}
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
function connectExpectFail(url: string, auth: Record<string, unknown>): Promise<'rejected' | 'connected'> {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve) => {
    socket.on('connect', () => resolve('connected'));
    socket.on('connect_error', () => resolve('rejected'));
    setTimeout(() => resolve('connected'), 2500);
  });
}

describe('console: logout (① acknowledgement, NOT revocation)', () => {
  it('POST /api/logout → 200 {ok:true}, idempotent, no auth required', async () => {
    const { url } = await saasServer();
    const a = await post(`${url}/api/logout`, {});
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ ok: true });
    const b = await post(`${url}/api/logout`, {}); // idempotent
    expect(b.status).toBe(200);
  });

  // The honesty test for the whole surface (owner ruling A5-4 / E4): the route
  // acknowledges receipt and revokes NOTHING, so the very token that was just
  // "logged out" still opens an authenticated read. This is the documented gap
  // written down as an executable fact — if a future change ever does start
  // revoking, this test fails and the copy on three clients has to be revisited
  // in the same breath. Real revocation is W4-4 (jti denylist).
  it('the SAME token still works after logout — nothing is revoked (W4-4 gap)', async () => {
    const { url } = await saasServer();
    const { token } = await registerUser(url, 'still-valid@b.co');
    expect((await get(`${url}/api/me`, bearer(token))).status).toBe(200);
    expect((await post(`${url}/api/logout`, {}, bearer(token))).status).toBe(200);
    const after = await get(`${url}/api/me`, bearer(token));
    expect(after.status).toBe(200);
    expect(after.json.user.email).toBe('still-valid@b.co');
  });

  it('standalone mounts NONE of the console REST (404 — saas-only)', async () => {
    const url = await standaloneServer();
    expect((await post(`${url}/api/logout`, {})).status).toBe(404);
    expect((await post(`${url}/api/password/forgot`, { email: 'x@b.co' })).status).toBe(404);
    expect((await get(`${url}/api/cloud/summary`)).status).toBe(404);
    expect((await get(`${url}/api/cloud/devices`)).status).toBe(404);
  });
});

describe('console: password reset (② forgot + reset rotation)', () => {
  // 0.3.0 M1 — the reset_token echo is DARK by default. The old single echo test
  // is split in two (flag on / flag off), and the flag-off half is the redline:
  // echoing the token to an anonymous caller is a 2-request account takeover of
  // any known email.
  afterEach(() => {
    delete process.env.FLOWMIC_INTERNAL_RESET_TOKEN_ECHO;
  });

  /** The persisted pending reset — the row a future mail channel (card M2) will
   *  read. Fetching it here is the production-shaped way to get a token now that
   *  the wire no longer carries one by default. */
  function mintedReset(handle: BootstrapHandle, userId: string): { reset_token: string; expires_at: string } {
    const row = handle.db.settings.read(userId, 'account.password_reset');
    return (row?.value ?? {}) as { reset_token: string; expires_at: string };
  }

  it('forgot for a KNOWN email with FLOWMIC_INTERNAL_RESET_TOKEN_ECHO=1 → 200 {ok, reset_token, expires_at} (flag-gated internal echo)', async () => {
    process.env.FLOWMIC_INTERNAL_RESET_TOKEN_ECHO = '1';
    const { url } = await saasServer();
    await registerUser(url, 'known@b.co');
    const { status, json } = await post(`${url}/api/password/forgot`, { email: 'known@b.co' });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(typeof json.reset_token).toBe('string');
    expect(json.reset_token.length).toBeGreaterThan(10);
    expect(typeof json.expires_at).toBe('string');
  });

  it('🔴 forgot for a KNOWN email with the flag OFF (default) → BYTE-IDENTICAL to the unknown-email response; token persisted, never on the wire', async () => {
    const { url, handle } = await saasServer();
    const { id } = await registerUser(url, 'dark@b.co');
    // Raw text, not parsed JSON: 「byte-identical」 is the anti-enumeration
    // contract, so the assertion must be on the bytes, not on a re-serialisation.
    const knownRes = await fetch(`${url}/api/password/forgot`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dark@b.co' }),
    });
    const knownBody = await knownRes.text();
    const unknownRes = await fetch(`${url}/api/password/forgot`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@b.co' }),
    });
    const unknownBody = await unknownRes.text();
    expect(knownRes.status).toBe(200);
    expect(unknownRes.status).toBe(200);
    expect(knownBody).toBe(unknownBody);
    expect(knownRes.headers.get('content-type')).toBe(unknownRes.headers.get('content-type'));
    expect(knownBody).toBe(JSON.stringify({ ok: true })); // and no token in it
    // The reset is REAL even though the wire is dark: minted + persisted for the
    // future mail channel (M2), just never handed to the anonymous caller.
    const stored = mintedReset(handle, id);
    expect(typeof stored.reset_token).toBe('string');
    expect(stored.reset_token.length).toBeGreaterThan(10);
    expect(typeof stored.expires_at).toBe('string');
  });

  it('forgot for an UNKNOWN email → 200 {ok:true} with NO token (constant shape)', async () => {
    const { url } = await saasServer();
    const { status, json } = await post(`${url}/api/password/forgot`, { email: 'nobody@b.co' });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect('reset_token' in json).toBe(false);
  });

  it('forgot with a missing email → 400 SETTINGS_SCHEMA_INVALID', async () => {
    const { url } = await saasServer();
    const { status, json } = await post(`${url}/api/password/forgot`, {});
    expect(status).toBe(400);
    expect(json.error).toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('reset rotates the password: OLD dies immediately, NEW logs in (core red line)', async () => {
    const { url, handle } = await saasServer();
    const { id } = await registerUser(url, 'rot@b.co');
    await post(`${url}/api/password/forgot`, { email: 'rot@b.co' });
    // Echo is dark by default — fetch the token the way the mail channel will.
    const { reset_token } = mintedReset(handle, id);
    const reset = await post(`${url}/api/password/reset`, { email: 'rot@b.co', reset_token, new_password: 'brandnewpass1' });
    expect(reset.status).toBe(200);
    expect(reset.json).toEqual({ ok: true });
    // Old password is dead on the very next login (verifyCredentials reads the
    // freshly-written hash).
    const oldLogin = await post(`${url}/api/login`, { email: 'rot@b.co', password: 'longenough1' });
    expect(oldLogin.status).toBe(401);
    expect(oldLogin.json.error).toBe('AUTH_LOGIN_FAILED');
    // New password logs in.
    const newLogin = await post(`${url}/api/login`, { email: 'rot@b.co', password: 'brandnewpass1' });
    expect(newLogin.status).toBe(200);
    expect(typeof newLogin.json.token).toBe('string');
  });

  it('reset with a WRONG token / UNKNOWN email → 401 PASSWORD_RESET_INVALID (no oracle)', async () => {
    const { url } = await saasServer();
    await registerUser(url, 'wt@b.co');
    await post(`${url}/api/password/forgot`, { email: 'wt@b.co' });
    const wrong = await post(`${url}/api/password/reset`, { email: 'wt@b.co', reset_token: 'not-the-token', new_password: 'brandnewpass1' });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error).toBe('PASSWORD_RESET_INVALID');
    const unknown = await post(`${url}/api/password/reset`, { email: 'ghost@b.co', reset_token: 'whatever', new_password: 'brandnewpass1' });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error).toBe('PASSWORD_RESET_INVALID'); // same code — unknown-email == wrong-token
  });

  it('reset is single-use: the token dies after one successful reset', async () => {
    const { url, handle } = await saasServer();
    const { id } = await registerUser(url, 'once@b.co');
    await post(`${url}/api/password/forgot`, { email: 'once@b.co' });
    const { reset_token } = mintedReset(handle, id);
    expect((await post(`${url}/api/password/reset`, { email: 'once@b.co', reset_token, new_password: 'brandnewpass1' })).status).toBe(200);
    const replay = await post(`${url}/api/password/reset`, { email: 'once@b.co', reset_token, new_password: 'anotherpass1' });
    expect(replay.status).toBe(401);
    expect(replay.json.error).toBe('PASSWORD_RESET_INVALID');
  });

  it('reset with a short new_password → 400 SETTINGS_SCHEMA_INVALID', async () => {
    const { url, handle } = await saasServer();
    const { id } = await registerUser(url, 'sp@b.co');
    await post(`${url}/api/password/forgot`, { email: 'sp@b.co' });
    const { reset_token } = mintedReset(handle, id);
    const short = await post(`${url}/api/password/reset`, { email: 'sp@b.co', reset_token, new_password: 'short' });
    expect(short.status).toBe(400);
    expect(short.json.error).toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('reset with an EXPIRED token (past 30-min TTL) → 401 PASSWORD_RESET_INVALID', async () => {
    let simNow = 1_700_000_000_000;
    const { url, handle } = await saasServer(() => simNow);
    const { id } = await registerUser(url, 'exp@b.co');
    await post(`${url}/api/password/forgot`, { email: 'exp@b.co' });
    const { reset_token } = mintedReset(handle, id);
    simNow += 31 * 60 * 1000; // past the 30-min TTL
    const late = await post(`${url}/api/password/reset`, { email: 'exp@b.co', reset_token, new_password: 'brandnewpass1' });
    expect(late.status).toBe(401);
    expect(late.json.error).toBe('PASSWORD_RESET_INVALID');
  });
});

describe('console: cloud summary / subscription (③)', () => {
  it('GET /api/cloud/summary (Bearer) → plan + quota + device counts; no bearer → 401', async () => {
    const { url, handle } = await saasServer();
    const { token } = await registerUser(url, 'sum@b.co');
    const { status, json } = await get(`${url}/api/cloud/summary`, bearer(token));
    expect(status).toBe(200);
    expect(json.plan).toMatchObject({ plan: 'free' });
    expect(typeof json.quota.stt.limit_min).toBe('number');
    expect(Number.isFinite(json.quota.stt.limit_min)).toBe(true);
    // 0.2.49 — the CEILINGS ride with the counts (owner 2026-08-02, PC instances
    // 2/3/10). `pc_limit` is free's 2; `mobile_limit` is free's 2 as well. ∞
    // crosses as `null`, which is why the type is `number | null`.
    expect(json.devices).toEqual({ pc_count: 0, mobile_count: 0, pc_limit: 2, mobile_limit: 2 });
    // v0.2.3 — the virtual F-3140 cloud-instance row is NOT a machine anyone
    // owns, so admitting one must not move this card. owner 2026-07-29 read
    // "devices 5 · PC 2" with exactly one PC, because this counted `pcs.length`
    // while the QUOTA counted `realPcs()`. One question, two answers.
    const before = json.devices;
    const userId = JSON.parse(
      Buffer.from(token.split('.')[1] as string, 'base64url').toString('utf8'),
    ).sub as string;
    new Registry({ pcs: handle.db.pcs, mobiles: handle.db.mobiles, mode: 'saas', limitsOf: () => planLimits('free') })
      .admitCloudInstance(userId);
    // The row EXISTS now — this is not a no-op test.
    expect(handle.db.pcs.listByUser(userId).some((p) => !isRealPc(p))).toBe(true);
    const after = await get(`${url}/api/cloud/summary`, bearer(token));
    expect(after.json.devices).toEqual(before);
    const noAuth = await get(`${url}/api/cloud/summary`);
    expect(noAuth.status).toBe(401);
    expect(noAuth.json.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('GET /api/cloud/subscription (Bearer) → mock plan read-out', async () => {
    const { url } = await saasServer();
    const { token } = await registerUser(url, 'subs@b.co');
    const { status, json } = await get(`${url}/api/cloud/subscription`, bearer(token));
    expect(status).toBe(200);
    expect(json.subscription).toMatchObject({ plan: 'free', state: 'none' });
  });
});

describe('console: device + pairing management (④)', () => {
  // Seed a real PC row + mobile pairing for the acting user, then exercise the
  // list + revoke REST. Seeding via the bootstrap handle's repos keeps the test
  // deterministic (no socket pairing dance for the pure-REST assertions).
  function seedPair(handle: BootstrapHandle, userId: string): { pcId: string; pairingId: string; mobileToken: string } {
    const pcId = `pc-${userId}`;
    const mobileToken = newToken();
    handle.db.pcs.insert({
      id: pcId, user_id: userId, device_name: 'Seed PC',
      device_token: newToken(), room_uuid: `room-${userId}`, short_code: '1234',
    });
    const pairingId = `pair-${userId}`;
    handle.db.mobiles.insert({ id: pairingId, user_id: userId, pc_device_id: pcId, mobile_token: mobileToken, mobile_name: 'Seed Phone' });
    return { pcId, pairingId, mobileToken };
  }

  it('GET /api/cloud/devices lists pc_devices + mobile_pairings, never leaking tokens', async () => {
    const { url, handle } = await saasServer();
    const { token, id } = await registerUser(url, 'dev@b.co');
    const { pcId, pairingId } = seedPair(handle, id);
    const { status, json } = await get(`${url}/api/cloud/devices`, bearer(token));
    expect(status).toBe(200);
    expect(json.pc_devices).toHaveLength(1);
    expect(json.pc_devices[0]).toMatchObject({ pc_id: pcId, device_name: 'Seed PC', is_online: false });
    expect('device_token' in json.pc_devices[0]).toBe(false);
    expect(json.mobile_pairings).toHaveLength(1);
    expect(json.mobile_pairings[0]).toMatchObject({ pairing_id: pairingId, pc_id: pcId, mobile_name: 'Seed Phone' });
    expect('mobile_token' in json.mobile_pairings[0]).toBe(false);
    // summary device counts agree
    const summary = await get(`${url}/api/cloud/summary`, bearer(token));
    expect(summary.json.devices).toEqual({ pc_count: 1, mobile_count: 1, pc_limit: 2, mobile_limit: 2 });
  });

  // 🔴 owner 2026-08-02 (PC instances 2/3/10) — "counts and ceilings must share one source, must not drift"
  // (room/registry.ts:115 `isRealPc`, written after the console and the quota path disagreed
  // about what a PC even is). The console cannot derive the ceiling from the tier
  // NAME: an exempt account resolves to plan 'free' with ∞ machines, so a browser
  // computing "free ⇒ 2" would print a wall owner is not behind. This asserts the
  // route reports the SOLVER's number, with the exemption as the reverse control —
  // same tier label, different enforced number.
  it('🔴 summary carries the ENFORCED pc ceiling, not one derived from the tier name', async () => {
    const { url, handle } = await saasServer();
    const { token, id } = await registerUser(url, 'lim@b.co');
    const plain = await get(`${url}/api/cloud/summary`, bearer(token));
    expect(plain.json.plan).toMatchObject({ plan: 'free' });
    expect((plain.json.devices as { pc_limit: number | null }).pc_limit).toBe(2);

    // Same account, same TIER LABEL, exemption flipped on: the number must move.
    handle.db.users.setPermanentFree(id, true);
    const exempt = await get(`${url}/api/cloud/summary`, bearer(token));
    expect(exempt.json.plan).toMatchObject({ plan: 'free', quota_exempt: true });
    // 2026-08-07 (owner ruling ①): the exemption is capped at MAX's numbers, so
    // `pc_limit` moved from `null` (∞) to 10 — and 10 is still NOT what the tier
    // label would give (free is 2 above), which is what this test is here to show.
    expect((exempt.json.devices as { pc_limit: number | null }).pc_limit).toBe(10);
    // `mobiles` is genuinely ∞ on max, and ∞ still crosses the wire as null —
    // deliberately, see the route's note.
    expect((exempt.json.devices as { mobile_limit: number | null }).mobile_limit).toBeNull();
  });

  it('revoke deletes the pairing (idempotent) and kills its mobile_token', async () => {
    const { url, handle } = await saasServer();
    const { token, id } = await registerUser(url, 'rev@b.co');
    const { pairingId, mobileToken } = seedPair(handle, id);
    // The seeded token connects fine BEFORE revoke (middleware resolves it).
    expect(await connectExpectFail(url, { token: mobileToken })).toBe('connected');
    // Revoke → revoked:true; the row + token are gone.
    const r1 = await post(`${url}/api/cloud/devices/revoke`, { pairing_id: pairingId }, bearer(token));
    expect(r1.status).toBe(200);
    expect(r1.json).toEqual({ ok: true, revoked: true });
    expect(handle.db.mobiles.findByToken(mobileToken)).toBeNull(); // DB revoke truth
    // reconnect-invalid fail-loud: reconnecting with the dead token is REJECTED.
    expect(await connectExpectFail(url, { token: mobileToken })).toBe('rejected');
    // Idempotent: a second revoke of the same (now-missing) pairing → revoked:false.
    const r2 = await post(`${url}/api/cloud/devices/revoke`, { pairing_id: pairingId }, bearer(token));
    expect(r2.status).toBe(200);
    expect(r2.json).toEqual({ ok: true, revoked: false });
  });

  it('cannot revoke ANOTHER user\'s pairing (revoked:false, row survives — no cross-tenant)', async () => {
    const { url, handle } = await saasServer();
    const a = await registerUser(url, 'a-owner@b.co');
    const b = await registerUser(url, 'b-owner@b.co');
    const bPair = seedPair(handle, b.id);
    // User A tries to revoke B's pairing → truthful no-op, B's pairing survives.
    const r = await post(`${url}/api/cloud/devices/revoke`, { pairing_id: bPair.pairingId }, bearer(a.token));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, revoked: false });
    expect(handle.db.mobiles.findByToken(bPair.mobileToken)).not.toBeNull(); // still there
  });

  it('revoke with a missing pairing_id → 400 SETTINGS_SCHEMA_INVALID', async () => {
    const { url } = await saasServer();
    const { token } = await registerUser(url, 'badrev@b.co');
    const r = await post(`${url}/api/cloud/devices/revoke`, {}, bearer(token));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
  });

  it('console reads require a valid Bearer (expired/garbage → 401)', async () => {
    const { url } = await saasServer();
    expect((await get(`${url}/api/cloud/devices`, { authorization: 'Bearer not.a.jwt' })).json.error).toBe('AUTH_TOKEN_INVALID');
    expect((await post(`${url}/api/cloud/devices/revoke`, { pairing_id: 'x' })).status).toBe(401);
  });
});

describe('console: stt-routings BYOK editor face (WP-W1b)', () => {
  it('GET is empty after register (no presets) and requires Bearer; POST round-trips UNREDACTED', async () => {
    const { url } = await saasServer();
    expect((await get(`${url}/api/cloud/stt-routings`)).status).toBe(401);
    const { token } = await registerUser(url, 'byok@b.co');
    // owner 2026-08-14: the console BYOK page starts empty. Managed STT is
    // what a new account transcribes with — not a seeded preset row that
    // looked like the user had configured something. The 2026-07-27 empty
    // array WAS a bug for ENGINE selection; today selection falls through
    // to the managed default when user rows are empty.
    const fresh = await get(`${url}/api/cloud/stt-routings`, bearer(token));
    expect(fresh.json.routings).toEqual([]);
    expect(fresh.json.enabled).toBe(false);
    const routings = [{ language: 'zh-CN', engine_id: 'funasr', endpoint: 'ws://srv:10095', api_key: 'sk-secret' }];
    const w = await post(`${url}/api/cloud/stt-routings`, { routings, enabled: true }, bearer(token));
    expect(w.status).toBe(200);
    expect(w.json).toEqual({ ok: true, routings, enabled: true });
    // The editor must round-trip api_key — Bearer is the account owner, same
    // trust grade as a PC peer in settings:list (04 §3.7), NOT mobile-redacted.
    const reread = await get(`${url}/api/cloud/stt-routings`, bearer(token));
    expect(reread.json.routings[0].api_key).toBe('sk-secret');
    expect(reread.json.enabled).toBe(true);
  });

  it('0.3.0 W1: a forged `provenance:"seed"` marker is re-derived away (real HTTP, real server)', async () => {
    // D3. The server re-derives the marker from the current defaults on every
    // write and never trusts the client's. GET only echoes user-authored rows,
    // so a seed-marked forgery must not come back as `provenance:'seed'`.
    const { url } = await saasServer();
    const { token } = await registerUser(url, 'forge@b.co');
    expect((await get(`${url}/api/cloud/stt-routings`, bearer(token))).json.routings).toEqual([]);

    const forged = [{ language: 'zh', engine_id: 'deepgram', api_key: 'sk-mine', provenance: 'seed' }];
    const w = await post(`${url}/api/cloud/stt-routings`, { routings: forged }, bearer(token));
    expect(w.status).toBe(200);
    // Stored, echoed and re-read all agree, and none of them carries the marker.
    expect(w.json.routings).toEqual([{ language: 'zh', engine_id: 'deepgram', api_key: 'sk-mine' }]);
    const after = (await get(`${url}/api/cloud/stt-routings`, bearer(token))).json.routings;
    expect(after[0].provenance).toBeUndefined();
    expect(after[0].api_key).toBe('sk-mine'); // the enc:v1: round trip still works
  });

  it('POST rejects non-array / oversized / non-object rows (400, no partial write)', async () => {
    const { url } = await saasServer();
    const { token } = await registerUser(url, 'byokbad@b.co');
    for (const bad of ['nope', [{ ok: 1 }, 'str'], [[]], Array.from({ length: 65 }, () => ({}))]) {
      const r = await post(`${url}/api/cloud/stt-routings`, { routings: bad }, bearer(token));
      expect(r.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
      expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
    }
    // No partial write: registration left the editor empty, and it stays empty.
    const after = await get(`${url}/api/cloud/stt-routings`, bearer(token));
    expect(after.json.routings).toEqual([]);
    expect(after.json.enabled).toBe(false);
  });

  it('GET hides platform-seeded rows so a leftover seed cannot look like a user preset', async () => {
    const { url, handle } = await saasServer();
    const { token, id } = await registerUser(url, 'hide-seed@b.co');
    handle.db.settings.write(id, 'stt.routings', [
      { language: 'zh', engine_id: 'funasr', provenance: 'seed' },
      { language: 'en', engine_id: 'deepgram', api_key: 'sk-mine' },
    ]);
    // Register wrote stt.byok_enabled=false. Grandfather is the OLD-account
    // shape: key absent + authored rows. Strip the flag so this GET answers
    // that question, not "what does a brand-new account's switch look like".
    handle.db.settings.remove(id, 'stt.byok_enabled');
    const r = await get(`${url}/api/cloud/stt-routings`, bearer(token));
    expect(r.json.routings).toEqual([{ language: 'en', engine_id: 'deepgram', api_key: 'sk-mine' }]);
    expect(r.json.enabled).toBe(true);
  });

  it('TEST refuses loopback before dialing and requires Bearer', async () => {
    const { url } = await saasServer();
    expect((await post(`${url}/api/cloud/stt-routings/test`, { routing: { language: 'en', engine_id: 'custom-openai-compatible', endpoint: 'https://example.com' } })).status).toBe(401);
    const { token } = await registerUser(url, 'byok-test@b.co');
    const loop = await post(`${url}/api/cloud/stt-routings/test`, {
      routing: { language: 'en', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:9/v1' },
    }, bearer(token));
    expect(loop.status).toBe(400);
    expect(loop.json.error).toBe('SETTINGS_SCHEMA_INVALID');
    expect(String(loop.json.message)).toMatch(/loopback/i);
  });

  it('POST fans out settings:updated to the owning PC socket (save-as-you-edit cross-channel sync)', async () => {
    const { url, handle } = await saasServer();
    const { token, id } = await registerUser(url, 'byokfan@b.co');
    const deviceToken = newToken();
    handle.db.pcs.insert({
      id: `pc-fan-${id}`, user_id: id, device_name: 'Fan PC',
      device_token: deviceToken, room_uuid: `room-fan-${id}`, short_code: '9876',
    });
    const socket = ioClient(url, { transports: ['websocket'], auth: { token: deviceToken }, forceNew: true, reconnection: false });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 3000);
    });
    const updated = new Promise<{ key: string; value: unknown }>((resolve, reject) => {
      socket.once('settings:updated', resolve);
      setTimeout(() => reject(new Error('settings:updated timeout')), 3000);
    });
    const routings = [{ language: 'en', engine_id: 'whisper' }];
    await post(`${url}/api/cloud/stt-routings`, { routings }, bearer(token));
    expect(await updated).toEqual({ key: 'stt.routings', value: routings });
  });
});

// ── GET /api/cloud/history was RETIRED on 2026-07-31 (0.2.27) ─────────────
//
// owner architecture ruling (docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md), asked and
// answered in as many words: "the web console cannot see transcript history — yes". Two describe
// blocks went with the route and the table under it:
//   1. `console: transcript history (GET /api/cloud/history)` — 6 tests over the endpoint
//      (paging, GA-05 per-account scope, entry_type/thumb_b64, the thumbnail
//      budget, saas-only, live device-name resolution).
//   2. `inject:result stamps WHERE the row landed` — 4 tests over
//      `transcript_history.inject_target`. `inject_target` itself is NOT retired:
//      it still rides every inject:result to the phone (relay.handler). What is
//      gone is the server keeping a COPY of it.
// What remains testable here is the retirement itself, and it is worth one case:
// the endpoint must be really gone on saas too, not merely unlinked from the web
// console — an endpoint left serving an empty page would read as "you never said anything".
describe('console: transcript history retired (GET /api/cloud/history)', () => {
  it('is gone on saas, not answering an empty page', async () => {
    const { url } = await saasServer();
    const { token } = await registerUser(url, 'hist-retired@b.co');
    // 404 = no such route (the router's own fall-through), with a VALID bearer:
    // this is not an auth refusal and not an empty list, it is absence.
    const authed = await get(`${url}/api/cloud/history`, bearer(token));
    expect(authed.status).toBe(404);
    expect(authed.json.items).toBeUndefined();
  });

  it('is still gone on standalone', async () => {
    const url = await standaloneServer();
    expect((await get(`${url}/api/cloud/history`)).status).toBe(404);
  });
});
