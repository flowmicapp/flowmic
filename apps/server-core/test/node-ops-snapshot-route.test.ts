// SPEC-REF:
//   docs/strategy/2026-08-31-lan-ops-console-third-party-spec.md §4.5.1/§4.5.2
//   apps/server-core/src/http/node-routes-ops-snapshot.ts (the four gates)
//
// GET /api/node/ops-snapshot — WHO GETS IN, AND HOW OFTEN.
//
// ⚠️ EVERY REFUSAL HERE CARRIES ITS POSITIVE CONTROL: the same request with the
// one missing ingredient restored must get a 200 from the same deps, or 「404」
// and 「this route is not mounted」 would read the same.
//
// The last block boots the REAL server as a writer, so a green also says
// bootstrap → node-runtime → node-routes wired the producer; a hand-assembled
// deps test cannot say that.
//
// 🔴 REVERSE CONTROLS, RUN AND SEEN RED (2026-10-11, lane/ops-snapshot), each by
// editing src/http/node-routes-ops-snapshot.ts, running only this file, then
// restoring (failure lines are in the audit queue row for this change):
//   · the client-verify check removed ⇒ the 404 tests are red;
//   · the shared secret accepted as well ⇒ the shared-secret 403 test is red;
//   · the rate limit removed ⇒ the 429 tests are red.

import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';
import {
  CLIENT_VERIFY_HEADER,
  OPS_SNAPSHOT_MIN_INTERVAL_MS,
  makeOpsSnapshotRoute,
} from '../src/http/node-routes-ops-snapshot';
import type { OpsSnapshotOutcome } from '../src/node/ops-snapshot';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';

const SHARED = 'shared-secret-value-aaaaaaaaaaaa';
const READER = 'reader-secret-value-bbbbbbbbbbbb';
const ETAG = '"sha256-abc"';
const AS_OF = '2026-10-11T03:04:05.000Z';
const PATH = '/api/node/ops-snapshot';

function producer(): (inm?: string) => Promise<OpsSnapshotOutcome> {
  return async (inm) => (inm === ETAG
    ? { status: 'unchanged', etag: ETAG, dataAsOf: AS_OF }
    : { status: 'fresh', etag: ETAG, dataAsOf: AS_OF, body: gzipSync(Buffer.from('slim-db', 'utf8')) });
}

function writerDeps(over: Partial<NodeRoutesDeps> = {}): NodeRoutesDeps {
  return {
    nodeId: 'srvny',
    version: '0.3.108',
    sharedSecret: SHARED,
    snapshotSecret: READER,
    snapshot: async () => Buffer.from('whole-db', 'utf8'),
    opsSnapshot: producer(),
    ...over,
  };
}

interface Answer { status: number; headers: Record<string, unknown>; body: unknown; raw: Buffer }

function makeReq(method: string, url: string, headers: Record<string, string>): IncomingMessage {
  const req = Readable.from([Buffer.alloc(0)], { objectMode: false }) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

async function hit(handler: Handler, headers: Record<string, string>, method = 'GET', url = PATH): Promise<Answer> {
  let status = 0;
  let head: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number, h?: Record<string, unknown>) {
      status = code;
      head = { ...extra, ...(h ?? {}) };
      return res;
    },
    setHeader(k: string, v: unknown) {
      extra[k.toLowerCase()] = v;
      return res;
    },
    end(payload?: string | Buffer) {
      if (payload !== undefined) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8'));
    },
    headersSent: false,
  } as unknown as ServerResponse;
  handler(makeReq(method, url, headers), res);
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
  const raw = Buffer.concat(chunks);
  let body: unknown = null;
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
  } catch {
    body = null;
  }
  return { status, headers: head, body, raw };
}

const viaRouter = (deps: NodeRoutesDeps): Handler => makeNodeRoutes(deps);
const good = { [CLIENT_VERIFY_HEADER]: 'SUCCESS', 'x-flowmic-node-secret': READER };

describe('ops-snapshot — gate 1: the client-verify header reserved for 9443', () => {
  it('🔴 the right key WITHOUT the header ⇒ 404 (control: with it ⇒ 200)', async () => {
    const noHeader = await hit(viaRouter(writerDeps()), { 'x-flowmic-node-secret': READER });
    expect(noHeader.status).toBe(404);
    expect(noHeader.body).toEqual({ ok: false, error: 'not_found' });
    expect((await hit(viaRouter(writerDeps()), good)).status).toBe(200);
  });

  it('🔴 any value other than SUCCESS ⇒ 404 (nginx writes FAILED:… / NONE)', async () => {
    for (const v of ['FAILED:certificate has expired', 'NONE', 'success', '']) {
      const a = await hit(viaRouter(writerDeps()), { [CLIENT_VERIFY_HEADER]: v, 'x-flowmic-node-secret': READER });
      expect(a.status, `header value ${JSON.stringify(v)}`).toBe(404);
    }
  });

  it('the 404 comes before the configuration check, so the 443 door is uniform', async () => {
    expect((await hit(viaRouter(writerDeps({ opsSnapshot: undefined })), { 'x-flowmic-node-secret': READER })).status)
      .toBe(404);
  });
});

describe('ops-snapshot — gate 2: the snapshot-only key and nothing else', () => {
  it('🔴 the SHARED node secret ⇒ 403 (control: the snapshot key ⇒ 200)', async () => {
    const a = await hit(viaRouter(writerDeps()), { [CLIENT_VERIFY_HEADER]: 'SUCCESS', 'x-flowmic-node-secret': SHARED });
    expect(a.status).toBe(403);
    expect(a.body).toEqual({ ok: false, error: 'forbidden' });
    expect((await hit(viaRouter(writerDeps()), good)).status).toBe(200);
  });

  it('🔴 no key, a wrong key, and a wrong key of the same length ⇒ 403', async () => {
    const sameLength = 'reader-secret-value-cccccccccccc';
    expect(sameLength.length).toBe(READER.length);
    for (const k of [null, 'nope', sameLength]) {
      const h: Record<string, string> = { [CLIENT_VERIFY_HEADER]: 'SUCCESS' };
      if (k !== null) h['x-flowmic-node-secret'] = k;
      expect((await hit(viaRouter(writerDeps()), h)).status, `key ${String(k)}`).toBe(403);
    }
  });

  it('🔴 no snapshot-only key issued ⇒ 501 even for the shared secret — never an open route', async () => {
    const deps = writerDeps({ snapshotSecret: undefined });
    const a = await hit(viaRouter(deps), { [CLIENT_VERIFY_HEADER]: 'SUCCESS', 'x-flowmic-node-secret': SHARED });
    expect(a.status).toBe(501);
    expect(a.body).toEqual({ ok: false, error: 'ops_snapshot_not_configured' });
  });

  it('no producer (a replica) ⇒ 501', async () => {
    expect((await hit(viaRouter(writerDeps({ opsSnapshot: undefined })), good)).status).toBe(501);
  });

  it('the snapshot-only key does not open the old route any wider than before (v1 unchanged)', async () => {
    const a = await hit(viaRouter(writerDeps()), { 'x-flowmic-node-secret': READER }, 'GET', '/api/node/snapshot');
    expect(a.status).toBe(200);
    expect(a.raw.toString('utf8')).toBe('whole-db');
  });
});

describe('ops-snapshot — 200 / 304', () => {
  it('200 carries the gzip body, ETag, data-as-of and no-store', async () => {
    const a = await hit(viaRouter(writerDeps()), good);
    expect(a.status).toBe(200);
    expect(gunzipSync(a.raw).toString('utf8')).toBe('slim-db');
    expect(a.headers).toMatchObject({
      etag: ETAG,
      'x-flowmic-data-as-of': AS_OF,
      'cache-control': 'no-store',
      'content-encoding': 'gzip',
      'content-type': 'application/octet-stream',
    });
  });

  it('304 for a matching If-None-Match: no body, same ETag and data-as-of', async () => {
    const a = await hit(viaRouter(writerDeps()), { ...good, 'if-none-match': ETAG });
    expect(a.status).toBe(304);
    expect(a.raw.length).toBe(0);
    expect(a.headers).toMatchObject({ etag: ETAG, 'x-flowmic-data-as-of': AS_OF });
  });

  it('a failed generation ⇒ 500 ops_snapshot_failed', async () => {
    const a = await hit(viaRouter(writerDeps({ opsSnapshot: async () => { throw new Error('disk full'); } })), good);
    expect(a.status).toBe(500);
    expect(a.body).toEqual({ ok: false, error: 'ops_snapshot_failed', detail: 'disk full' });
  });
});

describe('ops-snapshot — gate 3: one answer per 60 s', () => {
  const helpers = {
    secretMatches: (a: string, b: string) => a === b,
    sendJson: (res: ServerResponse, status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(text);
    },
  };

  it('🔴 a second answer inside 60 s ⇒ 429 + Retry-After; a 304 counts; after 60 s it is allowed again', async () => {
    let t = 1_000_000;
    const route = makeOpsSnapshotRoute(writerDeps(), helpers, () => t);
    expect((await hit(route, { ...good, 'if-none-match': ETAG })).status).toBe(304);
    t += 15_000;
    const limited = await hit(route, good);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('45');
    expect(limited.body).toEqual({ ok: false, error: 'rate_limited', retry_after_s: 45 });
    t += 45_000 - 1;
    expect((await hit(route, good)).status).toBe(429);
    t += 1;
    expect((await hit(route, good)).status).toBe(200);
    expect(OPS_SNAPSHOT_MIN_INTERVAL_MS).toBe(60_000);
  });

  it('🔴 refused callers do not use up the slot: 404, 403 and 429 leave the next real pull at 200', async () => {
    let t = 5_000_000;
    const route = makeOpsSnapshotRoute(writerDeps(), helpers, () => t);
    expect((await hit(route, { 'x-flowmic-node-secret': READER })).status).toBe(404);
    expect((await hit(route, { [CLIENT_VERIFY_HEADER]: 'SUCCESS', 'x-flowmic-node-secret': 'x' })).status).toBe(403);
    expect((await hit(route, good)).status).toBe(200);
    t += 30_000;
    expect((await hit(route, good)).status).toBe(429);
    t += 30_000;
    expect((await hit(route, good)).status, 'the 429 must not have restarted the window').toBe(200);
  });

  it('🔴 a wall clock stepped BACKWARDS does not lock the console out for the size of the step', async () => {
    // Date.now() is not monotonic (NTP step, VM resume). Before the clamp a ten
    // minute step back read as 「answered -10 min ago」, which is < 60 s, so every
    // pull got 429 with retry_after_s = 660 until the clock caught up. Control:
    // the same instant a step forward later is allowed again as usual.
    let t = 7_000_000;
    const route = makeOpsSnapshotRoute(writerDeps(), helpers, () => t);
    expect((await hit(route, good)).status).toBe(200);
    t -= 600_000;
    const stepped = await hit(route, good);
    expect(stepped.status, 'a clock step back must not be read as 「just answered」').toBe(200);
    t += 30_000;
    expect((await hit(route, good)).status, 'the window still applies from the re-based instant').toBe(429);
  });

  it('a failed generation does not use up the slot', async () => {
    let fail = true;
    const deps = writerDeps({
      opsSnapshot: async () => {
        if (fail) throw new Error('boom');
        return { status: 'unchanged', etag: ETAG, dataAsOf: AS_OF };
      },
    });
    const route = makeOpsSnapshotRoute(deps, helpers, () => 9_000_000);
    expect((await hit(route, good)).status).toBe(500);
    fail = false;
    expect((await hit(route, good)).status).toBe(304);
  });
});

describe('ops-snapshot — the REAL writer boot wires it', () => {
  const ENV = {
    FLOWMIC_NODE_ROLE: 'writer',
    FLOWMIC_NODE_ID: 'srvny',
    FLOWMIC_NODE_SHARED_SECRET: SHARED,
    FLOWMIC_NODE_SNAPSHOT_SECRET: READER,
  };
  const saved: Record<string, string | undefined> = {};
  let server: BootstrapHandle | null = null;

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('bootstrap → node-runtime → node-routes: 404 without the header, 403 for the shared secret, 200 then 429 with the key', async () => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    server = await startServer(loadConfig({ mode: 'saas', secret: 's'.repeat(40), port: 0, dbPath: ':memory:', trustedProxies: [] }));
    const url = `http://127.0.0.1:${server.port}${PATH}`;
    expect((await fetch(url, { headers: { 'x-flowmic-node-secret': READER } })).status).toBe(404);
    expect((await fetch(url, { headers: { [CLIENT_VERIFY_HEADER]: 'SUCCESS', 'x-flowmic-node-secret': SHARED } })).status)
      .toBe(403);
    const ok = await fetch(url, { headers: good });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).toMatch(/^"sha256-[0-9a-f]{64}"$/);
    expect(ok.headers.get('x-flowmic-data-as-of')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // fetch decodes content-encoding: gzip itself; the result is a SQLite file.
    const bytes = Buffer.from(await ok.arrayBuffer());
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
    expect((await fetch(url, { headers: { ...good, 'if-none-match': ok.headers.get('etag') ?? '' } })).status).toBe(429);
  });
});
