// EMB-1: real HTTP admission, SQLite rows and the shared pairing governor.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { IntegratorRoomRateLimiter } from '../src/auth/integrator-room-rate-limit';
import { makeBudgetPusher } from '../src/billing/budget-push';
import { makeIntegratorKeyGuard } from '../src/billing/integrator-quota';
import { Registry } from '../src/room/registry';
import { tryHandleWebRoomRoutes, type WebRoomRoutesDeps } from '../src/http/web-room-routes';

const ORIGIN = 'https://embed.example';
const KEY = `fmpk_${'a'.repeat(32)}`;
let db: DbConnection;
let registry: Registry;
let server: Server;
let url: string;
let now: number;
let deps: WebRoomRoutesDeps;

beforeEach(async () => {
  now = Date.now();
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('embed-room-test-secret-at-least-32') });
  db.users.insert({ id: 'owner', display_name: 'Owner', plan: 'free' });
  db.integratorKeys.insert({
    id: 'key', user_id: 'owner', publishable_key: KEY, origins: [ORIGIN],
    quota_minutes: null, label: 'Embed', created_at: now,
  });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles, now: () => now, integratorKeys: db.integratorKeys });
  deps = {
    auth: makeAuthService({ users: db.users, jwtSecret: Buffer.from('embed-room-test-secret-at-least-32') }),
    rooms: registry,
    budget: makeBudgetPusher({ remainingSttMs: () => 60_000, periodEndMs: () => now + 60_000,
      modeFor: () => 'plan', freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Infinity }),
    limiter: new RegisterRateLimiter({ now: () => now, maxAttempts: 5, windowMs: 60_000 }),
    trustedProxies: ['127.0.0.1'],
    integrator: {
      keys: makeIntegratorKeyGuard({ keys: db.integratorKeys, usagePeriodKey: () => '2026-09' }),
      limiter: new IntegratorRoomRateLimiter(() => now),
      mint: (u, k, opts) => registry.mintIntegratorRoom(u, k, opts),
    },
  };
  server = createServer((req, res) => {
    if (!tryHandleWebRoomRoutes(req, res, deps)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function room(ip: string, pairing?: string, key = KEY) {
  const response = await fetch(`${url}/api/web/rooms`, {
    method: 'POST', headers: { origin: ORIGIN, authorization: `Bearer ${key}`,
      'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ auth: { kind: 'publishable_key' }, ...(pairing ? { pairing } : {}) }),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe('EMB-1 room admission', () => {
  it('six distinct IP buckets on one key all get 200 (baseline sixth visitor regression)', async () => {
    for (let i = 1; i <= 6; i++) {
      const r = await room(`192.0.2.${i}`);
      expect(r.status, `visitor ${i}: ${JSON.stringify(r.body)}`).toBe(200);
    }
  });

  it('30 distinct IP buckets on one key all get 200', async () => {
    for (let i = 1; i <= 30; i++) expect((await room(`192.0.2.${i}`)).status).toBe(200);
  });

  it('the same bucket sixth request is 429 with retry_after_ms', async () => {
    for (let i = 0; i < 5; i++) expect((await room('192.0.2.1')).status).toBe(200);
    const refused = await room('192.0.2.1');
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'WEB_ROOM_RATE_LIMITED', retry_after_ms: 60_000 });
    now += 60_000;
    expect((await room('192.0.2.1')).status).toBe(200);
  });

  it('keys under one owner have independent budgets and IPv6 uses a /64 bucket', async () => {
    for (let i = 1; i <= 5; i++) expect((await room(`2001:db8:1:2::${i}`)).status).toBe(200);
    expect((await room('2001:0db8:0001:0002::6')).status).toBe(429);
    expect((await room('2001:db8:1:3::6')).status).toBe(200);
    const otherKey = `fmpk_${'b'.repeat(32)}`;
    db.integratorKeys.insert({ id: 'other-key', user_id: 'owner', publishable_key: otherKey,
      origins: [ORIGIN], quota_minutes: null, label: 'Other', created_at: now });
    expect((await room('2001:db8:1:2::6', undefined, otherKey)).status).toBe(200);
  });

  it('untrusted peers cannot rotate their bucket with forged X-Forwarded-For', async () => {
    deps.trustedProxies = [];
    for (let i = 1; i <= 5; i++) expect((await room(`192.0.2.${i}`)).status).toBe(200);
    expect((await room('192.0.2.6')).status).toBe(429);
  });

  it('explicit phone and legacy requests still receive usable codes; invalid intent is refused', async () => {
    for (const intent of [undefined, 'phone']) {
      const r = await room('192.0.2.1', intent);
      expect(r.status).toBe(200);
      expect(r.body.code).toMatch(/^\d{4}$/);
      expect(registry.pairMobile({ short_code: r.body.code }).pc.device_token).toBe(r.body.room_token);
      expect(r.body.local_mic_token).toBeUndefined();
    }
    expect((await room('192.0.2.1', 'invalid')).status).toBe(400);
  });

  it('the per-key total cap trips at 121 across different buckets', async () => {
    for (let i = 1; i <= 120; i++) expect((await room(`192.0.2.${i}`, 'local')).status).toBe(200);
    const refused = await room('192.0.2.121', 'local');
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'WEB_ROOM_RATE_LIMITED', retry_after_ms: 60_000 });
    now += 60_000;
    expect((await room('192.0.2.121', 'local')).status).toBe(200);
  });

  it('local-path creation adds no code to the code table', async () => {
    const r = await room('192.0.2.1', 'local');
    expect(r.status).toBe(200);
    const pc = db.pcs.findByToken(r.body.room_token)!;
    expect(pc.short_code).toBe('');
    expect(registry.isCodeActive(pc.id)).toBe(false);
    expect(r.body.code).toBeNull();
    expect(r.body.pair_url).toBeNull();
    expect(registry.findPairingByToken(r.body.local_mic_token)?.pc.id).toBe(pc.id);
  });

  it('the global integrator code cap returns 429 while PC pairing still succeeds', async () => {
    db.users.insert({ id: 'second-owner', display_name: 'Second', plan: 'free' });
    db.integratorKeys.insert({ id: 'second-key', user_id: 'second-owner', publishable_key: `fmpk_${'c'.repeat(32)}`,
      origins: [ORIGIN], quota_minutes: null, label: 'Second', created_at: now });
    for (let i = 0; i < 1000; i++) {
      registry.mintIntegratorRoom('owner', 'key');
      registry.mintIntegratorRoom('second-owner', 'second-key');
    }
    const refused = await room('192.0.2.1');
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('WEB_ROOM_RATE_LIMITED');
    expect(refused.body.retry_after_ms).toBeGreaterThan(0);
    const local = await room('192.0.2.2', 'local');
    expect(local.status).toBe(200);
    const localPc = db.pcs.findByToken(local.body.room_token)!;
    expect(() => registry.refreshShortCode(localPc.id)).toThrow('WEB_ROOM_RATE_LIMITED');
    registry.reconnectPc(local.body.room_token, 'embed-local-target');
    expect(() => registry.registerPc({ user_id: 'owner', device_name: 'Embed', client_instance_id: 'embed-local-target' }))
      .toThrow('WEB_ROOM_RATE_LIMITED');
    expect(db.pcs.findByToken(local.body.room_token)?.id).toBe(localPc.id);
    const existing = db.pcs.listByRoomKind('integrator').find((p) => p.short_code !== '')!;
    expect(registry.refreshShortCode(existing.id)).toMatch(/^\d{4}$/);
    const pc = registry.registerPc({ user_id: 'owner', device_name: 'PC' }).pc;
    expect(registry.pairMobile({ short_code: pc.short_code }).pc.id).toBe(pc.id);
    now += refused.body.retry_after_ms;
    expect((await room('192.0.2.3')).status).toBe(200);
  });
});
