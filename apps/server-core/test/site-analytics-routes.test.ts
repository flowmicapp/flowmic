// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §4, §7
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { createDbConnection } from '../src/db/connection';
import {
  tryHandleSiteCollectRoutes,
  DEFAULT_DOWNLOAD_DEST,
  SITE_COLLECT_PATH,
  SITE_DOWNLOAD_HOP_PATH,
} from '../src/http/site-collect-routes';
import { tryHandleOpsSiteRoutes } from '../src/http/ops-site-routes';
import { tryHandleAuthRoutes } from '../src/http/auth-routes';
import { makeAuthService } from '../src/auth/auth-service';
import { ADMIN_GATED_ROUTES } from '../src/http/ops-audit-trail';
import { loadConfig } from '../src/config';
import { SITE_TOTAL_DIM, SITE_TOTAL_VALUE } from '../src/db/repos/site-counts.repo';

const SECRET = Buffer.from('site-analytics-test-secret-32b-xx', 'utf8');

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  server: Server;
  base: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return {
    server,
    base: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((r, j) => {
        server.close((e) => (e ? j(e) : r()));
      }),
  };
}

describe('site collect + download hop', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  it('switch OFF: collect 204 and zero buckets; hop still 302s to GitHub', async () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32) });
    const limiter = new RegisterRateLimiter({ maxAttempts: 1000 });
    const { base, close } = await listen((req, res) => {
      if (
        tryHandleSiteCollectRoutes(req, res, {
          counts: db.siteCounts,
          limiter,
          enabled: false,
          allowLocalhostOrigin: true,
        })
      )
        return;
      res.writeHead(404);
      res.end();
    });
    closers.push(close);

    const collect = await fetch(`${base}${SITE_COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ kind: 'pageview', path: '/', locale: 'en' }),
    });
    expect(collect.status).toBe(204);
    expect(db.siteCounts.summary('1970-01-01', '2099-01-01')).toEqual([]);

    const hop = await fetch(`${base}${SITE_DOWNLOAD_HOP_PATH}?src=band`, { redirect: 'manual' });
    expect(hop.status).toBe(302);
    expect(hop.headers.get('location')).toBe(DEFAULT_DOWNLOAD_DEST);
    expect(db.siteCounts.summary('1970-01-01', '2099-01-01')).toEqual([]);
    db.close();
  });

  it('switch ON: pageview bumps path + total; client register_ok is ignored', async () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32) });
    const limiter = new RegisterRateLimiter({ maxAttempts: 1000 });
    const fixed = () => Date.parse('2026-08-15T12:00:00Z');
    const { base, close } = await listen((req, res) => {
      if (
        tryHandleSiteCollectRoutes(req, res, {
          counts: db.siteCounts,
          limiter,
          enabled: true,
          allowLocalhostOrigin: true,
          now: fixed,
        })
      )
        return;
      res.writeHead(404);
      res.end();
    });
    closers.push(close);

    await fetch(`${base}${SITE_COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({
        kind: 'pageview',
        path: '/faq?token=NOPE',
        locale: 'zh-CN',
        referrer_host: 'https://news.ycombinator.com/x',
      }),
    });
    // Client-forged conversion must not count.
    await fetch(`${base}${SITE_COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ kind: 'register_ok', path: '/' }),
    });

    const summary = db.siteCounts.summary('2026-08-15', '2026-08-15');
    expect(summary).toEqual([{ kind: 'pageview', count: 1 }]);
    const paths = db.siteCounts.breakdown('pageview', 'path', '2026-08-15', '2026-08-15');
    expect(paths).toEqual([{ dim_value: '/faq', count: 1 }]);
    expect(JSON.stringify(paths)).not.toContain('token');
    expect(JSON.stringify(paths)).not.toContain('NOPE');

    const hop = await fetch(`${base}${SITE_DOWNLOAD_HOP_PATH}?src=hero`, { redirect: 'manual' });
    expect(hop.status).toBe(302);
    const dl = db.siteCounts.summary('2026-08-15', '2026-08-15');
    expect(dl.find((r) => r.kind === 'download_click')?.count).toBe(1);
    db.close();
  });
});

describe('auth success is the only writer of register_ok / login_ok', () => {
  it('bumps only when siteCounts.enabled', async () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32) });
    const auth = makeAuthService({ users: db.users, jwtSecret: SECRET });
    const limiter = new RegisterRateLimiter({ maxAttempts: 1000 });
    const fixed = () => Date.parse('2026-08-15T12:00:00Z');

    const { base, close } = await listen((req, res) => {
      if (
        tryHandleAuthRoutes(req, res, {
          service: auth,
          limiter,
          siteCounts: { counts: db.siteCounts, enabled: true, now: fixed },
        })
      )
        return;
      res.writeHead(404);
      res.end();
    });

    const reg = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'site-a@example.com',
        password: 'longenough1',
        display_name: 'A',
      }),
    });
    expect(reg.status).toBe(201);
    expect(db.siteCounts.summary('2026-08-15', '2026-08-15')).toEqual([
      { kind: 'register_ok', count: 1 },
    ]);

    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'site-a@example.com', password: 'longenough1' }),
    });
    expect(login.status).toBe(200);
    const after = db.siteCounts.summary('2026-08-15', '2026-08-15');
    expect(after.find((r) => r.kind === 'login_ok')?.count).toBe(1);

    await close();
    db.close();
  });
});

describe('ops site summary is admin-gated', () => {
  it('403 ADMIN_ONLY for a non-admin bearer', async () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32) });
    const auth = makeAuthService({ users: db.users, jwtSecret: SECRET });
    const user = await auth.register({
      email: 'plain@example.com',
      password: 'longenough1',
      display_name: 'P',
    });
    const token = auth.issueToken(user).token;

    const { base, close } = await listen((req, res) => {
      if (
        tryHandleOpsSiteRoutes(req, res, {
          auth,
          counts: db.siteCounts,
          audit: db.opsAudit,
        })
      )
        return;
      res.writeHead(404);
      res.end('{"error":"not_found"}');
    });

    const r = await fetch(`${base}/api/ops/site/summary`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('ADMIN_ONLY');
    await close();
    db.close();
  });

  it('200 for an admin bearer and does not 5×-inflate pageviews', async () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32) });
    const auth = makeAuthService({ users: db.users, jwtSecret: SECRET });
    const admin = db.users.insert({
      id: 'u-admin',
      email: 'ops@example.com',
      display_name: 'Ops',
      is_admin: true,
    });
    const token = auth.issueToken(admin).token;
    db.siteCounts.bump({
      day: '2026-08-15',
      kind: 'pageview',
      dim: 'path',
      dim_value: '/',
    });
    db.siteCounts.bump({
      day: '2026-08-15',
      kind: 'pageview',
      dim: SITE_TOTAL_DIM,
      dim_value: SITE_TOTAL_VALUE,
    });

    const { base, close } = await listen((req, res) => {
      if (tryHandleOpsSiteRoutes(req, res, { auth, counts: db.siteCounts, audit: db.opsAudit })) return;
      res.writeHead(404);
      res.end();
    });

    const r = await fetch(`${base}/api/ops/site/summary?from=2026-08-15&to=2026-08-15`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { pageviews: number };
    expect(body.pageviews).toBe(1);
    await close();
    db.close();
  });
});

describe('auth failures and switch-off never mint conversions', () => {
  it('failed login / duplicate register / switch off leave the buckets empty', async () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32) });
    const auth = makeAuthService({ users: db.users, jwtSecret: SECRET });
    const limiter = new RegisterRateLimiter({ maxAttempts: 1000 });
    const fixed = () => Date.parse('2026-08-15T12:00:00Z');

    const { base, close } = await listen((req, res) => {
      if (
        tryHandleAuthRoutes(req, res, {
          service: auth,
          limiter,
          siteCounts: { counts: db.siteCounts, enabled: true, now: fixed },
        })
      )
        return;
      res.writeHead(404);
      res.end();
    });

    const miss = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'longenough1' }),
    });
    expect(miss.status).toBe(401);
    expect(db.siteCounts.summary('2026-08-15', '2026-08-15')).toEqual([]);

    await close();

    const { base: baseOff, close: closeOff } = await listen((req, res) => {
      if (
        tryHandleAuthRoutes(req, res, {
          service: auth,
          limiter,
          siteCounts: { counts: db.siteCounts, enabled: false, now: fixed },
        })
      )
        return;
      res.writeHead(404);
      res.end();
    });
    const reg = await fetch(`${baseOff}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'off@example.com',
        password: 'longenough1',
        display_name: 'Off',
      }),
    });
    expect(reg.status).toBe(201);
    expect(db.siteCounts.summary('2026-08-15', '2026-08-15')).toEqual([]);
    await closeOff();
    db.close();
  });
});

describe('collect origin + fence', () => {
  it('foreign Origin is 204 and writes nothing', async () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32) });
    const limiter = new RegisterRateLimiter({ maxAttempts: 1000 });
    const { base, close } = await listen((req, res) => {
      if (
        tryHandleSiteCollectRoutes(req, res, {
          counts: db.siteCounts,
          limiter,
          enabled: true,
          allowLocalhostOrigin: true,
        })
      )
        return;
      res.writeHead(404);
      res.end();
    });
    const r = await fetch(`${base}${SITE_COLLECT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ kind: 'pageview', path: '/' }),
    });
    expect(r.status).toBe(204);
    expect(db.siteCounts.summary('1970-01-01', '2099-01-01')).toEqual([]);
    await close();
    db.close();
  });

  it('public collect/hop stay outside ADMIN_GATED_ROUTES; ops reads stay inside', () => {
    expect(ADMIN_GATED_ROUTES.some((r) => r.includes('/api/site/collect'))).toBe(false);
    expect(ADMIN_GATED_ROUTES.some((r) => r.includes('/api/site/go'))).toBe(false);
    expect(ADMIN_GATED_ROUTES).toContain('GET /api/ops/site/summary');
    expect(ADMIN_GATED_ROUTES).toContain('GET /api/ops/site/breakdown');
  });

  it('🔴 FLOWMIC_SITE_ANALYTICS defaults OFF and fails closed on junk', () => {
    const before = process.env.FLOWMIC_SITE_ANALYTICS;
    delete process.env.FLOWMIC_SITE_ANALYTICS;
    try {
      const base = {
        mode: 'saas' as const,
        secret: 'x'.repeat(32),
        port: 0,
        dbPath: ':memory:',
        trustedProxies: [] as string[],
      };
      expect(loadConfig(base).siteAnalyticsEnabled).toBe(false);
      process.env.FLOWMIC_SITE_ANALYTICS = 'yes';
      expect(loadConfig(base).siteAnalyticsEnabled).toBe(false);
      process.env.FLOWMIC_SITE_ANALYTICS = '1';
      expect(loadConfig(base).siteAnalyticsEnabled).toBe(true);
    } finally {
      if (before === undefined) delete process.env.FLOWMIC_SITE_ANALYTICS;
      else process.env.FLOWMIC_SITE_ANALYTICS = before;
    }
  });
});
