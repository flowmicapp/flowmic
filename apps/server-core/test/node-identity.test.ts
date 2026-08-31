// SPEC-REF:
//   apps/server-core/src/node/node-identity.ts
//   docs/strategy/2026-08-31-multinode-regression-rca-and-geo-strategy.md §13/§14
//
// One process, more than one name. The Hong Kong door in front of the Tokyo
// relay measured 212 ms from a mainland tablet against 1242 ms through the
// CF-fronted name — the whole point of publishing it as a node is that a client
// can tell the two apart and choose. It can only do that if the process says
// which door answered.
//
// 🔴 THE ASSERTION THAT MATTERS MOST IS THE NEGATIVE ONE. Every deployment on
// earth today has no mapping, and every one of them must keep answering exactly
// what it answered before this module existed. An alias that took effect by
// accident would rewrite `pc_devices.home_node` and send phones to a door their
// PC is not behind — silently, because both doors work.

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { nodeIdForHost, parseNodeHostMap, requestHost } from '../src/node/node-identity';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';

function request(url: string, headers: Record<string, unknown> = {}): IncomingMessage {
  return { url, method: 'GET', headers } as unknown as IncomingMessage;
}

function response(): { res: ServerResponse; read: () => { status: number; body: any } } {
  let status = 0;
  let body: any = null;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { if (chunk) { try { body = JSON.parse(chunk); } catch { body = chunk; } } },
    setHeader() { /* unused */ },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

describe('parseNodeHostMap', () => {
  it('parses pairs, lower-cases the host and strips the port', () => {
    const m = parseNodeHostMap('SrvAsia02.flowmic.app:443=srvasia02');
    expect(m.get('srvasia02.flowmic.app')).toBe('srvasia02');
  });

  it('accepts several entries separated by commas or whitespace', () => {
    const m = parseNodeHostMap('a.example=one, b.example=two\nc.example=three');
    expect([...m.entries()].sort()).toEqual([
      ['a.example', 'one'], ['b.example', 'two'], ['c.example', 'three'],
    ]);
  });

  it('drops junk instead of throwing — a typo must cost the alias, not the relay', () => {
    // An operator's env file on a machine that also serves other people's
    // production. Every one of these is a plausible slip.
    const m = parseNodeHostMap('noequals, =nohost, host=, ,,   ');
    expect(m.size).toBe(0);
  });

  it('is empty for absent / blank configuration', () => {
    expect(parseNodeHostMap(undefined).size).toBe(0);
    expect(parseNodeHostMap('').size).toBe(0);
    expect(parseNodeHostMap('   ').size).toBe(0);
  });
});

describe('nodeIdForHost', () => {
  const map = parseNodeHostMap('srvasia02.flowmic.app=srvasia02');

  it('returns the door id for a mapped host', () => {
    expect(nodeIdForHost('srvasia02.flowmic.app', map, 'srvjp')).toBe('srvasia02');
    expect(nodeIdForHost('SRVASIA02.flowmic.app:443', map, 'srvjp')).toBe('srvasia02');
  });

  it('🔴 falls back for every host it was not told about', () => {
    expect(nodeIdForHost('srvjp.flowmic.app', map, 'srvjp')).toBe('srvjp');
    expect(nodeIdForHost('', map, 'srvjp')).toBe('srvjp');
    expect(nodeIdForHost(undefined, map, 'srvjp')).toBe('srvjp');
  });

  it('🔴 an empty mapping is inert — this is the state of every deployment today', () => {
    const none = parseNodeHostMap(undefined);
    expect(nodeIdForHost('srvasia02.flowmic.app', none, 'srvjp')).toBe('srvjp');
  });
});

describe('requestHost', () => {
  it('prefers the forwarded host and takes only its first element', () => {
    expect(requestHost({ 'x-forwarded-host': 'a.example, b.example', host: 'c.example' }))
      .toBe('a.example');
  });
  it('falls back to Host when the forwarded one is absent or empty', () => {
    expect(requestHost({ host: 'c.example' })).toBe('c.example');
    expect(requestHost({ 'x-forwarded-host': '  ', host: 'c.example' })).toBe('c.example');
  });
  it('is undefined when neither is a string', () => {
    expect(requestHost({})).toBeUndefined();
    expect(requestHost({ host: 42 })).toBeUndefined();
  });
});

describe('GET /api/node/{ping,list} name the door that answered', () => {
  const deps = (): NodeRoutesDeps => ({
    nodeId: 'srvjp',
    version: '0.0.0-test',
    nodeHosts: parseNodeHostMap('srvasia02.flowmic.app=srvasia02'),
  });

  it('answers as the front door when the request arrived under its name', () => {
    const routes = makeNodeRoutes(deps());
    const { res, read } = response();
    expect(routes(request('/api/node/ping', { host: 'srvasia02.flowmic.app' }), res)).toBe(true);
    expect(read().body.node).toBe('srvasia02');
  });

  it('🔴 negative control: the same process under its own name is still srvjp', () => {
    const routes = makeNodeRoutes(deps());
    const { res, read } = response();
    expect(routes(request('/api/node/ping', { host: 'srvjp.flowmic.app' }), res)).toBe(true);
    expect(read().body.node).toBe('srvjp');
  });

  it('🔴 negative control: with NO mapping configured, the door name changes nothing', () => {
    const routes = makeNodeRoutes({ nodeId: 'srvjp', version: '0.0.0-test' });
    const { res, read } = response();
    expect(routes(request('/api/node/ping', { host: 'srvasia02.flowmic.app' }), res)).toBe(true);
    expect(read().body.node).toBe('srvjp');
  });

  it('/api/node/list names the door too — it is the same question', () => {
    const routes = makeNodeRoutes(deps());
    const { res, read } = response();
    expect(routes(request('/api/node/list', { host: 'srvasia02.flowmic.app' }), res)).toBe(true);
    expect(read().body.node).toBe('srvasia02');
  });

  it('honours x-forwarded-host, which is what a reverse proxy actually sets', () => {
    const routes = makeNodeRoutes(deps());
    const { res, read } = response();
    expect(routes(
      request('/api/node/ping', { host: 'srvjp.flowmic.app', 'x-forwarded-host': 'srvasia02.flowmic.app' }),
      res,
    )).toBe(true);
    expect(read().body.node).toBe('srvasia02');
  });
});
