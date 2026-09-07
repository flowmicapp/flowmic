// SPEC-REF:
//   docs/strategy/2026-08-31-lan-ops-console-third-party-spec.md §2 R3, §4.1, §6 P3
//   apps/server-core/src/node/node-config.ts (FLOWMIC_NODE_SNAPSHOT_SECRET)
//   apps/server-core/src/http/node-routes.ts (GET /api/node/snapshot)
//
// THE READ-ONLY SNAPSHOT CREDENTIAL, AND THE FIVE DOORS IT MUST NOT OPEN.
//
// The LAN ops console pulls the database snapshot on a timer. Until 2026-09-07
// the only credential that could do that was `FLOWMIC_NODE_SHARED_SECRET` —
// which ALSO opens /api/node/forward, /forward-sync, /mint-code, /resolve-token
// and /quota, i.e. a channel that performs writes on the writer and hands back
// whole `users` rows. Handing that string to a third party is the second writer
// R3 of the ops-console contract exists to keep out.
//
// 🔴 WHAT THE NEGATIVE HALF OF THIS SUITE IS ACTUALLY WORTH. The narrowing is
// structural — those five handlers compare against `deps.sharedSecret` by name
// and have never heard of `snapshotSecret` — so today they refuse the reader key
// because the value is not in scope, not because anybody wrote a check. That is
// the STRONG form, and it is also exactly why it needs an outside witness: a
// future edit that 「tidies」 the secret check into one shared helper would widen
// all five at once and nothing in the type system would object.
//
// ⚠️ EVERY NEGATIVE HERE CARRIES ITS POSITIVE CONTROL — the same route, the same
// request, the SHARED secret — because 「403 on all five」 and 「these five routes
// are not mounted in this fixture」 look identical from the outside, and only one
// of them is the thing being asserted.
//
// 🔴 REVERSE CONTROL, RUN AND SEEN RED (2026-09-07, worktree ops-console-support).
// The snapshot route's `bySnapshotSecret` line was pasted into the /forward
// handler so that it, too, accepted the reader key. This suite then failed with
//   AssertionError: the reader key opened POST /api/node/forward
//   expected 200 to be 403
// The line was removed again and the suite is green; node-routes.ts holds no
// reference to `snapshotSecret` outside the snapshot branch.

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';
import { NodeConfigError, readNodeConfig } from '../src/node/node-config';

const SHARED = 'shared-secret-value-aaaaaaaaaaaa';
const READER = 'reader-secret-value-bbbbbbbbbbbb';

/** Everything a writer serves, so a refusal below is never 「not mounted」. */
function writerDeps(over: Partial<NodeRoutesDeps> = {}): NodeRoutesDeps {
  return {
    nodeId: 'srvny',
    version: '0.3.76',
    sharedSecret: SHARED,
    snapshotSecret: READER,
    snapshot: async () => Buffer.from('gzipped-database-bytes', 'utf8'),
    receiveForward: () => ({}),
    forwardSync: () => ({ ok: true as const, result: { done: true } }),
    mintShortCode: () => ({ short_code: '1234', expires_in_ms: null }),
    resolveToken: () => null,
    remainingSttMs: () => 60_000,
    ...over,
  };
}

interface Answer {
  status: number;
  headers: Record<string, unknown>;
  body: unknown;
  raw: string;
}

/** 🔴 NOT objectMode: `Readable.from([string])` defaults to it and the bounded
 *  body reader then waits for bytes that never arrive. Same note the sibling ops
 *  suites carry, for the same hour lost once. */
function makeReq(method: string, url: string, secret: string | null, body?: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const stream = Readable.from([Buffer.from(raw, 'utf8')], { objectMode: false });
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = secret === null ? {} : { 'x-flowmic-node-secret': secret };
  return req;
}

async function call(
  deps: NodeRoutesDeps,
  method: string,
  url: string,
  secret: string | null,
  body?: unknown,
): Promise<Answer> {
  const handler = makeNodeRoutes(deps);
  let status = 0;
  let headers: Record<string, unknown> = {};
  let raw = '';
  const res = {
    writeHead(code: number, h?: Record<string, unknown>) {
      status = code;
      headers = h ?? {};
      return res;
    },
    setHeader() {
      return res;
    },
    end(payload?: string | Buffer) {
      if (typeof payload === 'string') raw += payload;
      else if (payload) raw += payload.toString('utf8');
    },
    write(payload: string) {
      raw += payload;
      return true;
    },
    headersSent: false,
  } as unknown as ServerResponse;
  expect(handler(makeReq(method, url, secret, body), res), `${method} ${url} was not handled at all`).toBe(true);
  // The secret-checked handlers answer inside `void (async () => …)()`.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  let parsed: unknown = null;
  try {
    parsed = raw === '' ? null : JSON.parse(raw);
  } catch {
    parsed = null; // a binary snapshot body — those assertions read `raw`
  }
  return { status, headers, body: parsed, raw };
}

/** The five doors the reader key must not open, each with a request that WOULD
 *  succeed if the secret were accepted. */
const WRITE_CHANNEL: Array<{ route: string; method: string; url: string; body?: unknown }> = [
  { route: 'POST /api/node/forward', method: 'POST', url: '/api/node/forward', body: { records: [] } },
  {
    route: 'POST /api/node/forward-sync',
    method: 'POST',
    url: '/api/node/forward-sync',
    body: { verb: 'ping', payload: {} },
  },
  { route: 'POST /api/node/mint-code', method: 'POST', url: '/api/node/mint-code', body: { pc_id: 'pc-1' } },
  {
    route: 'POST /api/node/resolve-token',
    method: 'POST',
    url: '/api/node/resolve-token',
    body: { token: 'tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  },
  { route: 'GET /api/node/quota', method: 'GET', url: '/api/node/quota?user_id=u1' },
];

describe('GET /api/node/snapshot accepts EITHER credential', () => {
  it('the read-only snapshot secret gets the database', async () => {
    const a = await call(writerDeps(), 'GET', '/api/node/snapshot', READER);
    expect(a.status).toBe(200);
    expect(a.headers['content-encoding']).toBe('gzip');
    expect(a.raw).toBe('gzipped-database-bytes');
  });

  it('the shared secret still gets it — a replica must not have been locked out', async () => {
    const a = await call(writerDeps(), 'GET', '/api/node/snapshot', SHARED);
    expect(a.status).toBe(200);
    expect(a.raw).toBe('gzipped-database-bytes');
  });

  it('neither secret ⇒ 403, and a missing header is not a way in', async () => {
    expect((await call(writerDeps(), 'GET', '/api/node/snapshot', 'wrong-value-cccccccccccccccc')).status).toBe(403);
    expect((await call(writerDeps(), 'GET', '/api/node/snapshot', null)).status).toBe(403);
    // ⚠️ Same LENGTH as READER, so this one is not being turned away by the
    // length comparison `secretMatches` does first — it reaches timingSafeEqual.
    const sameLength = 'reader-secret-value-cccccccccccc';
    expect(sameLength.length).toBe(READER.length);
    expect((await call(writerDeps(), 'GET', '/api/node/snapshot', sameLength)).status).toBe(403);
  });

  it('a deployment with the reader key but no shared secret still serves it', async () => {
    const deps = writerDeps();
    delete (deps as { sharedSecret?: string }).sharedSecret;
    expect((await call(deps, 'GET', '/api/node/snapshot', READER)).status).toBe(200);
  });

  it('🔴 NO credential of either kind configured ⇒ 501, never an open route', async () => {
    const deps = writerDeps();
    delete (deps as { sharedSecret?: string }).sharedSecret;
    delete (deps as { snapshotSecret?: string }).snapshotSecret;
    const a = await call(deps, 'GET', '/api/node/snapshot', READER);
    expect(a.status).toBe(501);
    expect((a.body as { error: string }).error).toBe('snapshot_not_configured');
  });
});

describe('🔴 the snapshot secret opens NOTHING else', () => {
  for (const c of WRITE_CHANNEL) {
    it(`${c.route} refuses the reader key`, async () => {
      const a = await call(writerDeps(), c.method, c.url, READER, c.body);
      expect(a.status, `the reader key opened ${c.route}`).toBe(403);
      expect((a.body as { error: string }).error).toBe('forbidden');
    });

    // 🔴 THE POSITIVE CONTROL. Without it, 「403 on all five」 would be equally
    // consistent with five routes that are simply not mounted in this fixture.
    it(`${c.route} DOES answer the shared secret (control: the route is live)`, async () => {
      const a = await call(writerDeps(), c.method, c.url, SHARED, c.body);
      expect(a.status, `${c.route} refused the shared secret — this fixture proves nothing`).not.toBe(403);
      expect(a.status).not.toBe(501);
    });
  }
});

describe('readNodeConfig — FLOWMIC_NODE_SNAPSHOT_SECRET', () => {
  it('is optional, trimmed, and an empty value is absent (not an empty string)', () => {
    expect(readNodeConfig({}).snapshotSecret).toBe(null);
    expect(readNodeConfig({ FLOWMIC_NODE_SNAPSHOT_SECRET: '   ' }).snapshotSecret).toBe(null);
    expect(readNodeConfig({ FLOWMIC_NODE_SNAPSHOT_SECRET: `  ${READER}  ` }).snapshotSecret).toBe(READER);
  });

  it('rides along on a writer without disturbing anything else', () => {
    const cfg = readNodeConfig({
      FLOWMIC_NODE_ROLE: 'writer',
      FLOWMIC_NODE_ID: 'srvny',
      FLOWMIC_NODE_SHARED_SECRET: SHARED,
      FLOWMIC_NODE_SNAPSHOT_SECRET: READER,
    });
    expect(cfg.role).toBe('writer');
    expect(cfg.sharedSecret).toBe(SHARED);
    expect(cfg.snapshotSecret).toBe(READER);
  });

  it('🔴 REFUSES to boot when the two secrets are the same string', () => {
    // The one way this credential could stop being a narrowing and quietly
    // become a second name for the write channel — while the type, the logs and
    // the contract all went on calling it read-only.
    expect(() =>
      readNodeConfig({
        FLOWMIC_NODE_ROLE: 'writer',
        FLOWMIC_NODE_ID: 'srvny',
        FLOWMIC_NODE_SHARED_SECRET: SHARED,
        FLOWMIC_NODE_SNAPSHOT_SECRET: SHARED,
      }),
    ).toThrow(NodeConfigError);
    // …and on an untouched `single` deployment too, which returns early.
    expect(() =>
      readNodeConfig({ FLOWMIC_NODE_SHARED_SECRET: SHARED, FLOWMIC_NODE_SNAPSHOT_SECRET: SHARED }),
    ).toThrow(NodeConfigError);
    // Control: two DIFFERENT strings are fine, so the two assertions above are
    // not passing on some unrelated configuration error.
    expect(() =>
      readNodeConfig({ FLOWMIC_NODE_SHARED_SECRET: SHARED, FLOWMIC_NODE_SNAPSHOT_SECRET: READER }),
    ).not.toThrow();
  });
});
