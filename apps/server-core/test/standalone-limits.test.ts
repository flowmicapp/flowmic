// WP-9 (2026-09-02, findings-crossend-quota.md #1/struct) — GET /api/limits,
// the standalone-only route that lets an instance with no cloud account, no
// plan and no monthly quota still answer its own continuous-recording
// ceiling (`continuous_offer.dart`'s `ceilingUnknown` face otherwise fires
// for every LAN-paired phone forever — nothing on that LAN was ever going to
// answer `/api/cloud/summary`, which is saas-only).

import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { planLimits, resetPlanLimits } from '../src/billing/plans';

const SECRET = 'test-secret-32-bytes-or-more-xxxx';
let server: BootstrapHandle | null = null;

afterEach(async () => {
  if (server) await server.close();
  server = null;
  resetPlanLimits();
});

async function standaloneServer(planLimitsOverride?: Record<string, unknown>): Promise<string> {
  server = await startServer(
    loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:', planLimits: planLimitsOverride }),
  );
  return `http://127.0.0.1:${server.port}`;
}

async function saasServer(): Promise<string> {
  // fix-010: an in-process server has no proxy in front of it — its direct
  // peer IS the client, hence the declared empty trust list (console-
  // routes.test.ts's `saasServer` helper states the same thing).
  server = await startServer(
    loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] }),
  );
  return `http://127.0.0.1:${server.port}`;
}

async function get(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url);
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe('GET /api/limits (standalone)', () => {
  it('answers continuous_minutes with no auth at all — standalone has exactly one local user', async () => {
    const url = await standaloneServer();
    const { status, json } = await get(`${url}/api/limits`);
    expect(status).toBe(200);
    expect(json).toEqual({ continuous_minutes: planLimits('max').continuous_minutes });
  });

  it("🔴 the number is MAX's, not FREE's — standalone must not be capped by the seeded local user's plan:'free' row", () => {
    // Direct check on the solver this route reads, so the assertion above
    // cannot pass by accident if 'free' and 'max' ever converge on the same
    // number: today they provably differ (10 vs 30).
    expect(planLimits('free').continuous_minutes).not.toBe(planLimits('max').continuous_minutes);
  });

  it('honours an operator FLOWMIC_PLAN_LIMITS override on the max tier (one active table, one reader)', async () => {
    const url = await standaloneServer({ max: { continuous_minutes: 45 } });
    const { json } = await get(`${url}/api/limits`);
    expect(json).toEqual({ continuous_minutes: 45 });
  });

  it('is NOT mounted in saas — that mode answers from /api/cloud/summary instead', async () => {
    const url = await saasServer();
    const { status } = await get(`${url}/api/limits`);
    expect(status).toBe(404);
  });
});
