// SPEC-REF: apps/server-core/src/http/router.ts (`/api/health`)
//
// `/api/health?cb=1` used to 404, because this one route matched on the whole
// URL while every sibling matched on the path. Cache-busting a health check is
// the normal thing for a monitor to do, and the failure it produced was the bad
// kind: a 404 and 「the service is gone」 are the same colour on a dashboard.
//
// Measured 2026-08-31 against production before the fix:
//   /api/health      → 200 (through Cloudflare and at the origin)
//   /api/health?cb=1 → 404 (at the ORIGIN — not an edge artefact)
//
// 🔴 The second case is the whole test. The first is its negative control: if a
// future edit breaks plain /api/health, this file must go red for THAT too, or
// it would be pinning half a route.

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeHttpHandler } from '../src/http/router';

function call(url: string): { status: number; body: any } {
  const handler = makeHttpHandler({
    config: { mode: 'saas' },
    billing: {},
    version: '0.0.0-test',
  } as never);
  let status = 0;
  let body: any = null;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { if (chunk) { try { body = JSON.parse(chunk); } catch { body = chunk; } } },
    setHeader() { /* unused */ },
  } as unknown as ServerResponse;
  handler({ url, method: 'GET', headers: {} } as unknown as IncomingMessage, res);
  return { status, body };
}

describe('GET /api/health matches on the path, not the whole URL', () => {
  it('answers a plain request (negative control for the case below)', () => {
    expect(call('/api/health').status).toBe(200);
  });

  it('🔴 answers a cache-busted request — the shape that used to 404', () => {
    const r = call('/api/health?cb=1');
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
  });

  it('answers with several query parameters too', () => {
    expect(call('/api/health?cb=1&from=monitor').status).toBe(200);
  });

  it('does NOT answer a different path that merely starts the same way', () => {
    // Guards the cheap way to "fix" this — startsWith — which would make
    // /api/healthcheck answer as /api/health.
    expect(call('/api/healthcheck').status).not.toBe(200);
  });
});
