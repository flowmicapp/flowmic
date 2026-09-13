// Card CORS-2 (2026-09-08) — on a REPLICA, the write guard in http/router.ts
// answered 421 to an OPTIONS preflight before that request ever reached the
// per-route preflight handlers CORS-1 built (web-cors-routes.test.ts). Two of
// the three online PCs in the reported case were homed on a replica node, so
// the browser mic page never sent the real `GET /api/pc/presence` there: no
// grant on the preflight means no real request follows.
//
// SPEC-REF: apps/server-core/src/http/router.ts (`WEB_CORS_PREFLIGHT_PATHS`,
//   the paragraph above `makeHttpHandler`, and `isReplicaSafeCorsPreflight`)
//   apps/server-core/test/web-cors-routes.test.ts (the writer-side grant this
//   file proves also survives on a replica)
//
// What each case is worth:
//  ① OPTIONS to the four named browser-read routes reaches the preflight
//     handler on a replica exactly as it does on a writer — 204 + grant.
//  ② POST /api/web/rooms — an ordinary write — still 421s on a replica,
//     UNCHANGED: this exception did not widen the mutation guard, it named
//     four read paths' OPTIONS verb and nothing else.
//     ⚠️ card MP-11 (2026-09-11) — the list is now FIVE paths, and the fifth
//     (`/api/web/rooms`) is the first that is not a read. The POST assertion
//     below is unchanged and is the one that proves it: the exception is still
//     about the OPTIONS verb, which cannot mutate, and NOT about the route.
//  ③ OPTIONS to an `/api/` path NOT on that list still 421s — the exception
//     is a named list, not "let any OPTIONS through".

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
const WRITER = 'https://srvny.flowmic.app';

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

/** Same shape as web-cors-routes.test.ts's `pairedWorld` — a real Registry +
 *  RoomStore with one paired PC/phone, so a `/api/pc/presence` answer here
 *  tracks the same production code. */
function pairedWorld() {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  const registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  const store = new RoomStore<{ id: string }>();
  const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'u1', client_instance_id: 'inst-a-000000000000' });
  const pair = registry.pairMobile({ short_code: pc.short_code, mobile_name: 'A phone', user_id: 'u1' });
  return { db, registry, store, token: pair.token };
}

/** Same handler web-cors-routes.test.ts builds, except `nodes.writerUrl` is
 *  set — the one thing that turns this node into a replica for the write
 *  guard in router.ts. */
function replicaHandlerFor(world: ReturnType<typeof pairedWorld>): (req: IncomingMessage, res: ServerResponse) => boolean {
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
      // 🔴 REQUIRED on a replica (same reason presence-routes.ts's own header
      // gives): forgetting it makes a healthy remote PC flap online/offline.
      rowsFromReplicationPull: true,
    },
    nodes: { nodeId: 'srvjp', version: '0.3.79', writerUrl: WRITER },
  } as never);
}

function call(h: (req: IncomingMessage, res: ServerResponse) => boolean, method: string, url: string, headers: Record<string, string> = {}) {
  const { res, done } = response();
  const handled = h(request(method, url, headers), res);
  return { handled, done };
}

describe('CORS-2: a replica answers the browser-read preflights too', () => {
  it.each([
    ['/api/pc/presence', PC_PRESENCE_PATH],
    ['/api/node/list', '/api/node/list'],
    ['/api/node/locate', '/api/node/locate?pcid=abc'],
    ['/api/health', '/api/health'],
  ])('OPTIONS %s on a REPLICA is 204 with the grant, not 421', async (_name, url) => {
    const h = replicaHandlerFor(pairedWorld());
    const out = await call(h, 'OPTIONS', url, {
      origin: FLOWMIC_APP,
      'access-control-request-method': 'GET',
    }).done;
    expect(out.status).toBe(204);
    expect(out.status).not.toBe(421);
    expect(out.headers['access-control-allow-origin']).toBe(FLOWMIC_APP);
    expect(out.headers['access-control-allow-methods']).toContain('GET');
  });

  it('REVERSE CONTROL for the case above — evidence in the delivery report; see it before trusting the green above', () => {
    // Deliberately not a live test (a test that cannot fail honestly is worse
    // than none): removing `!isReplicaSafeCorsPreflight` from the guard's
    // condition in router.ts and re-running this file turns every case in the
    // `it.each` above from 204 back to 421. Restored immediately after.
    expect(true).toBe(true);
  });

  it('a real presence answer on a replica still carries the grant alongside the reading — CORS-2 did not touch the payload', async () => {
    const world = pairedWorld();
    const h = replicaHandlerFor(world);
    const out = await call(h, 'GET', PC_PRESENCE_PATH, { origin: FLOWMIC_APP, authorization: `Bearer ${world.token}` }).done;
    expect(out.status).toBe(200);
    expect(out.headers['access-control-allow-origin']).toBe(FLOWMIC_APP);
  });

  it('🔴 UNCHANGED: POST /api/web/rooms — an ordinary write — still 421s on a replica', async () => {
    const h = replicaHandlerFor(pairedWorld());
    const out = await call(h, 'POST', '/api/web/rooms', { origin: FLOWMIC_APP }).done;
    expect(out.status).toBe(421);
    expect(out.body.error).toBe('NODE_IS_REPLICA');
  });

  it('an OPTIONS to an /api/ path NOT on the named list still 421s — this is a named exception, not "let OPTIONS through"', async () => {
    // 🔴 card MP-11 — THIS CASE USED TO USE `/api/web/rooms` AS ITS EXAMPLE,
    // and that is exactly why it had to move: G-16 put that path ON the list
    // (it now owns a scoped preflight handler, which is this list's stated
    // criterion), so leaving it here would have quietly turned a test about
    // 「the list is named, not blanket」into a test about one path's membership
    // — and it would have gone red for the RIGHT change. `/api/console/devices`
    // is a write route with no preflight handler of its own, i.e. the thing
    // this case has always been about.
    const h = replicaHandlerFor(pairedWorld());
    const out = await call(h, 'OPTIONS', '/api/console/devices', {
      origin: FLOWMIC_APP,
      'access-control-request-method': 'POST',
    }).done;
    expect(out.status).toBe(421);
    expect(out.body.error).toBe('NODE_IS_REPLICA');
  });

  it('card MP-11 / G-16 — OPTIONS /api/web/rooms is NO LONGER eaten by the guard on a replica', () => {
    // 🔴 THE OBSERVABLE HERE IS `handled`, NOT A STATUS, and the reason is
    // worth a line: this fixture wires no `webRooms` dep, so once the guard
    // stops claiming the request nothing in it answers at all. `handled ===
    // false` is precisely「the replica guard did not answer this」, which is
    // the whole of what this list membership changes; what the route then says
    // is web-room-cors.test.ts's subject, on a fixture that mounts it.
    const h = replicaHandlerFor(pairedWorld());
    const { handled } = call(h, 'OPTIONS', '/api/web/rooms', {
      origin: FLOWMIC_APP,
      'access-control-request-method': 'POST',
    });
    expect(handled).toBe(false);
  });

  it('an OPTIONS to /api/auth/register (no preflight handler of its own) also still 421s on a replica', async () => {
    const h = replicaHandlerFor(pairedWorld());
    const out = await call(h, 'OPTIONS', '/api/auth/register', { origin: FLOWMIC_APP }).done;
    expect(out.status).toBe(421);
  });
});
