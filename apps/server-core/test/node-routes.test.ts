// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §2-2, §4-3
//   apps/server-core/src/http/node-routes.ts
//
// The two assertions here that are worth more than the rest:
//
//  1. /ping MUST be uncacheable. Not "should be" — a cached /ping reports the
//     CDN edge, which is the exact reading the route was built to avoid, and it
//     would do so while looking perfectly healthy. Pinned as a header check
//     because nothing else in the stack would ever go red for it.
//
//  2. A REPLICA that does not know a PC must answer with the writer's address,
//     NOT with "unknown". Replication makes rows arrive late; it never invents
//     them. So a local miss is a maybe, and answering it as a no would tell a
//     phone that just paired on the other side of the world that its PC is
//     offline — true of this node's copy, false of the product.
//
// Each of those has a negative control: a variant of the same call that must
// produce the opposite answer, so a future edit that collapses the distinction
// cannot leave the suite green.

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeNodeRoutes, parseNodeList, type NodeRoutesDeps } from '../src/http/node-routes';
import { makeHttpHandler } from '../src/http/router';

function request(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: {} } as unknown as IncomingMessage;
}

function response(): {
  res: ServerResponse;
  read: () => { status: number; headers: Record<string, unknown>; body: any };
} {
  let status = 0;
  let headers: Record<string, unknown> = {};
  let body: any = null;
  const res = {
    writeHead(code: number, h?: Record<string, unknown>) {
      status = code;
      headers = h ?? {};
      return res;
    },
    end(payload?: string) {
      body = payload ? JSON.parse(payload) : null;
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, headers, body }) };
}

function call(deps: NodeRoutesDeps, url: string, method = 'GET') {
  const handler = makeNodeRoutes(deps);
  const { res, read } = response();
  const handled = handler(request(url, method), res);
  return { handled, ...read() };
}

const WRITER: NodeRoutesDeps = { nodeId: 'srvny', version: '0.3.45' };
const REPLICA: NodeRoutesDeps = {
  nodeId: 'srvjp',
  version: '0.3.45',
  writerUrl: 'https://srvny.flowmic.app',
};

describe('node-routes: /api/node/ping', () => {
  it('is answered by the origin process and names the node', () => {
    const r = call(WRITER, '/api/node/ping');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body.node).toBe('srvny');
    expect(r.body.version).toBe('0.3.45');
    expect(typeof r.body.t).toBe('number');
  });

  it('🔴 forbids caching — the whole point of the route', () => {
    const r = call(WRITER, '/api/node/ping');
    const cc = String(r.headers['cache-control'] ?? '');
    expect(cc).toContain('no-store');
    expect(cc).toContain('max-age=0');
  });

  it('negative control: the header is not merely present on every route by accident', () => {
    // If `no-store` came from a blanket default rather than from this module's
    // intent, this assertion could never fail and assertion #2 would be
    // decoration. It is set in ONE place (JSON_HEADERS) and reaches /ping and
    // /list alike — so the control here is that the value is the SAME object's
    // value on a different route, i.e. it is a module-level decision that a
    // future author must consciously edit.
    const ping = call(WRITER, '/api/node/ping');
    const list = call(WRITER, '/api/node/list');
    expect(list.headers['cache-control']).toBe(ping.headers['cache-control']);
  });

  it('two nodes report different ids, so a client can tell them apart', () => {
    expect(call(WRITER, '/api/node/ping').body.node).not.toBe(
      call(REPLICA, '/api/node/ping').body.node,
    );
  });
});

describe('node-routes: /api/node/list', () => {
  it('names the answering node even with no list configured', () => {
    const r = call(WRITER, '/api/node/list');
    expect(r.body.nodes).toEqual([]);
    // An empty list must still say WHERE you are, so that "[]" reads as
    // 「single-node deployment」 and not 「the file could not be read」.
    expect(r.body.node).toBe('srvny');
  });

  it('a replica publishes the writer; the writer publishes no writer', () => {
    expect(call(REPLICA, '/api/node/list').body.writer).toBe('https://srvny.flowmic.app');
    expect(call(WRITER, '/api/node/list').body.writer).toBeUndefined();
  });
});

describe('node-routes: parseNodeList tolerates a hand-edited file', () => {
  it('accepts both shapes and normalises the url', () => {
    expect(parseNodeList('[{"id":"srvny","url":"https://srvny.flowmic.app/"}]')).toEqual([
      { id: 'srvny', url: 'https://srvny.flowmic.app' },
    ]);
    expect(parseNodeList('{"nodes":[{"id":"srvjp","url":"https://srvjp.flowmic.app"}]}')).toEqual([
      { id: 'srvjp', url: 'https://srvjp.flowmic.app' },
    ]);
  });

  it('🔴 drops a non-https entry rather than offering it', () => {
    // An operator typo that downgrades a node to http would silently move every
    // client onto a plaintext socket. Dropping the entry degrades to "fewer
    // nodes"; accepting it degrades to "no transport security".
    expect(parseNodeList('[{"id":"bad","url":"http://srvjp.flowmic.app"}]')).toEqual([]);
  });

  it('drops entries with no id, and keeps the good ones beside them', () => {
    const out = parseNodeList('[{"url":"https://a.x"},{"id":"srvny","url":"https://b.x"}]');
    expect(out).toEqual([{ id: 'srvny', url: 'https://b.x' }]);
  });

  it('preserves selectable:false so a node can be drained without losing its id', () => {
    const out = parseNodeList('[{"id":"srvjp","url":"https://b.x","selectable":false}]');
    expect(out[0]?.selectable).toBe(false);
  });
});

describe('node-routes: /api/node/locate — the authoritative-read rule', () => {
  const known = (node: string | null): NodeRoutesDeps['locatePc'] => () => ({ node, known: true });
  const unknown: NodeRoutesDeps['locatePc'] = () => ({ node: null, known: false });

  it('a local hit is answered directly', () => {
    const r = call({ ...REPLICA, locatePc: known('srvjp') }, '/api/node/locate?pcid=123456789');
    expect(r.body.node).toBe('srvjp');
  });

  it('🔴 a replica MISS points at the writer instead of answering "unknown"', () => {
    const r = call({ ...REPLICA, locatePc: unknown }, '/api/node/locate?pcid=123456789');
    expect(r.body.authoritative).toBe(false);
    expect(r.body.authority).toBe('https://srvny.flowmic.app');
  });

  it('🔴 negative control: the WRITER answering the same miss must NOT point anywhere', () => {
    // Without this control, a change that made every miss carry `authority`
    // would still satisfy the test above — and the client would bounce forever
    // between two nodes that both disclaim the answer.
    const r = call({ ...WRITER, locatePc: unknown }, '/api/node/locate?pcid=123456789');
    expect(r.body.authoritative).toBe(true);
    expect(r.body.authority).toBeUndefined();
    expect(r.body.node).toBeNull();
  });

  it('a hit on the writer is marked authoritative; the same hit on a replica is not', () => {
    expect(call({ ...WRITER, locatePc: known('srvny') }, '/api/node/locate?pcid=1').body
      .authoritative).toBe(true);
    expect(call({ ...REPLICA, locatePc: known('srvny') }, '/api/node/locate?pcid=1').body
      .authoritative).toBe(false);
  });

  it('refuses an empty pcid rather than looking one up', () => {
    expect(call({ ...WRITER, locatePc: known('srvny') }, '/api/node/locate?pcid=').status).toBe(400);
  });

  it('says so when locate is not wired, instead of pretending the PC is unknown', () => {
    // 501 and "unknown PC" are different facts and the client acts differently
    // on them: one is 「this deployment has no directory」, the other is
    // 「that PC does not exist」. Collapsing them is the repo's #1 bug shape.
    expect(call(REPLICA, '/api/node/locate?pcid=1').status).toBe(501);
  });
});

describe('node-routes: routing hygiene', () => {
  it('claims only its own prefix', () => {
    expect(call(WRITER, '/api/health').handled).toBe(false);
    expect(call(WRITER, '/socket.io/?EIO=4').handled).toBe(false);
  });

  it('answers an unknown sub-route rather than falling through to another module', () => {
    const r = call(WRITER, '/api/node/nope');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(404);
  });

  it('refuses a write method', () => {
    expect(call(WRITER, '/api/node/ping', 'POST').status).toBe(405);
  });
});

describe('a replica refuses HTTP writes', () => {
  // 🔴 The failure this prevents: a POST that succeeds, returns 200, and is gone
  // at the next replication pull. A registration that never happened; a password
  // change the user watched succeed.
  const replicaHandler = () => makeHttpHandler({
    config: { mode: 'saas' },
    billing: {},
    version: '0.0.0',
    nodes: { nodeId: 'srvjp', version: '0.0.0', writerUrl: 'https://srvny.flowmic.app' },
  } as never);

  const call = (method: string, url: string): { status: number; body: string } => {
    const h = replicaHandler();
    let status = 0;
    let body = '';
    const res = {
      writeHead: (s: number) => { status = s; return res; },
      end: (b?: string) => { body = b ?? ''; },
      setHeader: () => {},
    };
    h({ url, method, headers: {} } as never, res as never);
    return { status, body };
  };

  it('🔴 refuses a POST to /api/ by NAME, and says where the writer is', () => {
    const r = call('POST', '/api/auth/register');
    expect(r.status).toBe(421);
    expect(JSON.parse(r.body).error).toBe('NODE_IS_REPLICA');
    // A bare 403 would be true and useless. This one the caller can act on.
    expect(JSON.parse(r.body).writer).toBe('https://srvny.flowmic.app');
  });

  it('refuses every mutating method, not just POST', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(call(m, '/api/account/password').status).toBe(421);
    }
  });

  it('🔴 still SERVES reads — they are the reason this node exists', () => {
    // The guard must not become "a replica answers nothing". Its staleness is
    // bounded by the pull interval; a vanished write is not bounded by anything.
    expect(call('GET', '/api/node/ping').status).toBe(200);
    expect(call('GET', '/api/health').status).toBe(200);
  });

  it('🔴 negative control: the SAME handler without writerUrl allows the POST through', () => {
    // Without this, a guard that refused every POST on every node would pass
    // every assertion above — and would take down every single-node deployment
    // in production, which is all of them.
    const h = makeHttpHandler({
      config: { mode: 'saas' }, billing: {}, version: '0.0.0',
      nodes: { nodeId: 'srvny', version: '0.0.0' },
    } as never);
    let status = 0;
    const res = { writeHead: (s: number) => { status = s; return res; }, end: () => {}, setHeader: () => {} };
    h({ url: '/api/auth/register', method: 'POST', headers: {} } as never, res as never);
    expect(status).not.toBe(421);
  });
});

describe('the node list names the writer', () => {
  // 🔴 Raised by the mobile lane, which could not route pairing without it and
  // correctly refused to guess. The phone's first contact lands on the PC's node
  // (it learns the PC from a QR or short code, not from an account), and that
  // node may be a replica — where replication lag makes "register then
  // immediately pair" fail. So pairing has to reach the writer, and the phone
  // needs to be told which one that is.
  it('🔴 carries role:writer, because ASKING the writer yields no marker otherwise', () => {
    // A replica reports `writer: <url>` beside the list, so a client that asked a
    // replica could work it out. A client that asked the WRITER gets nothing —
    // and "absent because you are talking to the writer" and "absent because this
    // deployment has no writer" would be the same bytes.
    const nodes = parseNodeList(JSON.stringify({
      nodes: [
        { id: 'srvny', url: 'https://srvny.flowmic.app', role: 'writer' },
        { id: 'srvjp', url: 'https://srvjp.flowmic.app' },
      ],
    }));
    expect(nodes[0]?.role).toBe('writer');
    expect(nodes[1]?.role).toBeUndefined();
  });

  it('🔴 an unrecognised role is DROPPED, not carried', () => {
    // Exact match, never "any non-empty role". A typo must not be able to
    // promote a replica to first contact; under-matching leaves the client on
    // the endpoint it already had, which is the safe failure.
    const nodes = parseNodeList(JSON.stringify({
      nodes: [{ id: 'a', url: 'https://a.flowmic.app', role: 'Writer' }],
    }));
    expect(nodes[0]?.role).toBeUndefined();
  });

  it('a single-node list marks nothing, and that must keep meaning single-node', () => {
    const nodes = parseNodeList(JSON.stringify({
      nodes: [{ id: 'solo', url: 'https://solo.example.com' }],
    }));
    expect(nodes.every((n) => n.role === undefined)).toBe(true);
  });
});
