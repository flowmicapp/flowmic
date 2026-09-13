// Card CORS-1 (2026-09-08) — the web mic page follows a paired PC to its
// `home_node` and then reads `GET /api/pc/presence` and `GET /api/node/list`
// on THAT node's own origin: a genuine cross-origin fetch (page on
// https://flowmic.app, relay on e.g. https://srvasia02.flowmic.app). A device
// pass measured the concrete failure this closes: a preflight OPTIONS on
// `/api/pc/presence` came back 405 with no grant headers at all, so the
// browser never sent the real GET and presence degraded to "unknown".
//
// These cases pin, per route (`/api/pc/presence`, `/api/node/list`,
// `/api/node/locate`, `/api/health`):
//   ① an allowed origin (flowmic.app) gets the grant on the real response;
//   ② a foreign origin gets NONE — this is not `*`;
//   ③ an OPTIONS preflight from an allowed origin gets 204 + the grant +
//      `access-control-allow-methods`, not a 405;
//   ④ 🔴 REVERSE CONTROL (see the bottom describe): strip the grant from
//      `/api/pc/presence` alone and watch its cases go red while every other
//      route's cases stay green — proof the grant is wired per-route, not a
//      side effect of some other check already in the suite.

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { makeHttpHandler } from '../src/http/router';
import { makeResolveUserId, type AccountVerifier } from '../src/http/account-auth';
import { PC_PRESENCE_PATH } from '../src/http/presence-routes';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

const FLOWMIC_APP = 'https://flowmic.app';
const EVIL = 'https://evil.example';

const NO_ACCOUNTS: AccountVerifier = {
  verifyToken: () => ({ ok: false, error: 'AUTH_TOKEN_INVALID' }),
  getUser: () => null,
};

function request(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers = headers;
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: '203.0.113.9' };
  return req;
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
  /** Every setHeader() call, lower-cased, plus anything named in a writeHead()
   *  headers object — the CORS cases read these. */
  headers: Record<string, string>;
}

function response(): { res: ServerResponse; done: Promise<Answer> } {
  let settle: (v: Answer) => void;
  const done = new Promise<Answer>((r) => (settle = r));
  let status = 0;
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    writeHead(code: number, h?: Record<string, unknown>) {
      status = code;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
      return res;
    },
    end(payload?: string) {
      settle({
        status: status || (res as unknown as { statusCode: number }).statusCode,
        body: payload ? (JSON.parse(payload) as Record<string, unknown>) : {},
        headers,
      });
    },
    once() { return res; },
  } as unknown as ServerResponse;
  return { res, done };
}

/** A real Registry + RoomStore with one paired PC/phone — same shape
 *  http-pc-presence.test.ts uses, so this suite's `/api/pc/presence` answer
 *  tracks the same production code, not a stand-in. */
function pairedWorld() {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  const registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  const store = new RoomStore<{ id: string }>();
  const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'u1', client_instance_id: 'inst-a-000000000000' });
  const pair = registry.pairMobile({ short_code: pc.short_code, mobile_name: 'A phone', user_id: 'u1' });
  return { db, registry, store, token: pair.token };
}

function handlerFor(world: ReturnType<typeof pairedWorld>): (req: IncomingMessage, res: ServerResponse) => boolean {
  return makeHttpHandler({
    config: { mode: 'saas', port: 41879, mockBilling: false } as never,
    billing: {} as never,
    version: '0.3.79',
    resolveUserId: makeResolveUserId({ mode: 'saas', standaloneUserId: 'default', account: NO_ACCOUNTS }),
    scriptPath: 'C:\\Users\\owner\\AppData\\Local\\FlowMic\\resources\\server.js',
    presence: {
      registry: world.registry,
      store: world.store as unknown as RoomStore,
      pcs: world.db.pcs,
      nodeIdFor: (): null => null,
      rowsFromReplicationPull: false,
    },
    nodes: { nodeId: 'srvny', version: '0.3.79' },
  });
}

function call(h: (req: IncomingMessage, res: ServerResponse) => boolean, method: string, url: string, headers: Record<string, string> = {}) {
  const { res, done } = response();
  const handled = h(request(method, url, headers), res);
  return { handled, done };
}

describe('CORS for the web mic page', () => {
  it.each([
    ['GET /api/pc/presence', PC_PRESENCE_PATH, 'GET'],
    ['GET /api/node/list', '/api/node/list', 'GET'],
    ['GET /api/node/locate', '/api/node/locate?pcid=abc', 'GET'],
    ['GET /api/health', '/api/health', 'GET'],
  ])('%s: an allowed origin gets the grant', async (_name, url) => {
    const h = handlerFor(pairedWorld());
    const out = await call(h, 'GET', url, { origin: FLOWMIC_APP, authorization: 'Bearer irrelevant' }).done;
    expect(out.headers['access-control-allow-origin']).toBe(FLOWMIC_APP);
    expect(out.headers['vary']).toBe('origin');
  });

  it.each([
    ['GET /api/pc/presence', PC_PRESENCE_PATH],
    ['GET /api/node/list', '/api/node/list'],
    ['GET /api/node/locate', '/api/node/locate?pcid=abc'],
    ['GET /api/health', '/api/health'],
  ])('%s: 🔴 a foreign origin gets NO grant — this is not `*`', async (_name, url) => {
    const h = handlerFor(pairedWorld());
    const out = await call(h, 'GET', url, { origin: EVIL }).done;
    expect(out.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    ['/api/pc/presence', PC_PRESENCE_PATH],
    ['/api/node/list', '/api/node/list'],
    ['/api/node/locate', '/api/node/locate?pcid=abc'],
    ['/api/health', '/api/health'],
  ])('OPTIONS preflight on %s from an allowed origin is 204 with the grant, not 405', async (_name, url) => {
    const h = handlerFor(pairedWorld());
    const out = await call(h, 'OPTIONS', url, {
      origin: FLOWMIC_APP,
      'access-control-request-method': 'GET',
    }).done;
    expect(out.status).toBe(204);
    expect(out.headers['access-control-allow-origin']).toBe(FLOWMIC_APP);
    expect(out.headers['access-control-allow-methods']).toContain('GET');
  });

  it('the presence preflight grants the Authorization header — the route reads a Bearer token', async () => {
    const h = handlerFor(pairedWorld());
    const out = await call(h, 'OPTIONS', PC_PRESENCE_PATH, { origin: FLOWMIC_APP }).done;
    expect(out.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('a real presence answer still carries the correct pc_online reading alongside the grant — CORS did not change the payload', async () => {
    const world = pairedWorld();
    const h = handlerFor(world);
    const out = await call(h, 'GET', PC_PRESENCE_PATH, { origin: FLOWMIC_APP, authorization: `Bearer ${world.token}` }).done;
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, pc_online: false });
    expect(out.headers['access-control-allow-origin']).toBe(FLOWMIC_APP);
  });

  it('www.flowmic.app is granted too — the same allow-list POST /api/site/collect trusts', async () => {
    const h = handlerFor(pairedWorld());
    const out = await call(h, 'GET', '/api/node/list', { origin: 'https://www.flowmic.app' }).done;
    expect(out.headers['access-control-allow-origin']).toBe('https://www.flowmic.app');
  });

  it('a same-origin request (no Origin header) is untouched — no grant header appears', async () => {
    const h = handlerFor(pairedWorld());
    const out = await call(h, 'GET', '/api/health', {}).done;
    expect(out.status).toBe(200);
    expect(out.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// Reverse-control evidence for this suite is NOT a permanent test here (a
// test that cannot fail honestly is worse than no test) — it was run by hand
// against this worktree by temporarily deleting the two CORS lines from
// presence-routes.ts (`handleWebCorsPreflight` / `applyWebCors`) and re-running
// this file; see the delivery report for the verbatim red/green output.
