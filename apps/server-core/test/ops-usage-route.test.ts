// 0.2.48 — O-2 platform usage aggregation HTTP surface (`/api/ops/usage/*`).
//
// SPEC-REF: docs/strategy/2026-08-02-o2-usage-route-contract.md (THE contract)
//           src/http/ops-routes.ts / src/http/ops-audit-trail.ts
//           CLAUDE.md red line: no silent failure / one value answers one question / anti-façade
//
// 🔴 WHY THIS FILE BOOTS A REAL SERVER instead of assembling deps by hand like
// billing-events-route.test.ts does. The thing being closed here is 【not wired】 —
// the aggregates already had 17 green tests and no HTTP exposure. A suite that
// builds `OpsRoutesDeps` itself would prove the handler works and would go green
// against a bootstrap that never mounts it, i.e. it would test everything except
// the defect. `startServer` + `fetch` is the only shape that can tell 「this route
// exists」 from 「this function exists」.
//
// ⚠️ WHAT IT STILL DOES NOT PROVE: that the route works IN PRODUCTION. Nothing
// here has been deployed. The honest grade for everything below is
// 【unit-test proven + not deployed】 — never 「verified」.

import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { signJwt } from '../src/auth/jwt';
import { USAGE_PAGE_DEFAULT, USAGE_PAGE_MAX } from '../src/db/repos/usage.repo';
import { ADMIN_GATE_DENIED, ADMIN_GATE_GRANTED } from '../src/http/ops-audit-trail';

const SECRET = 'ops-usage-route-secret-32-bytes-min-x';
const M1 = '2026-07';
const M2 = '2026-08';

/** A value that exists ONLY inside `users.password_hash`. If it ever shows up in
 *  an HTTP body, M2-7 has landed on this surface. */
const HASH_MARKER = 'pbkdf2$MARKER_HASH_MUST_NEVER_LEAVE_THE_DB';

let server: BootstrapHandle | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

interface Res {
  status: number;
  body: string;
  json: Record<string, unknown>;
}

async function saas(): Promise<{ url: string; handle: BootstrapHandle }> {
  server = await startServer(
    // fix-010: an in-process server has no proxy in front of it — its direct peer
    // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
    loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] }),
  );
  return { url: `http://127.0.0.1:${server.port}`, handle: server };
}

async function get(url: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(`${url}${path}`, { headers });
  const body = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* a non-JSON body is itself a finding — `body` carries it to the assertion */
  }
  return { status: r.status, body, json };
}

function bearer(handle: BootstrapHandle, userId: string, opts: { ttlMs?: number; now?: () => number } = {}): Record<string, string> {
  const user = handle.db.users.findById(userId);
  if (!user) throw new Error(`test setup: no such user ${userId}`);
  const token = signJwt(
    { sub: user.id, plan: user.plan },
    { secret: Buffer.from(SECRET, 'utf8'), ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }), ...(opts.now ? { now: opts.now } : {}) },
  );
  return { authorization: `Bearer ${token}` };
}

/**
 * Seed: one admin, one normal account, and usage rows across two months.
 *
 * 🔴 The admin carries `password_hash` AND a DRIFTED `users.plan` ('pro' with no
 * subscription behind it, so the effective tier is 'free'). Both are the bait for
 * the two M2 mines — see the two reverse-control blocks at the bottom.
 */
function seed(handle: BootstrapHandle): void {
  handle.db.users.insert({
    id: 'u-admin',
    email: 'admin@ops.co',
    display_name: 'Admin',
    is_admin: true,
    password_hash: HASH_MARKER,
    plan: 'pro', // deliberately drifted: nothing has been paid for
  });
  handle.db.users.insert({ id: 'u-normal', email: 'normal@ops.co', display_name: 'Normal' });
  for (const id of ['u-a1', 'u-a2', 'u-a3', 'u-a4', 'u-a5']) {
    handle.db.users.insert({ id, display_name: id });
  }
  // Disjoint magnitudes so a cross-attribution cannot land on a plausible total.
  handle.db.usage.increment('u-a1', M1, { stt_minutes: 1.5, llm_tokens_in: 100, llm_tokens_out: 10 });
  handle.db.usage.increment('u-a2', M1, { stt_minutes: 20, llm_tokens_in: 2000, llm_tokens_out: 200 });
  handle.db.usage.increment('u-a3', M1, { stt_minutes: 300, llm_tokens_in: 30_000, llm_tokens_out: 3000 });
  handle.db.usage.increment('u-a4', M1, { stt_minutes: 4000, llm_tokens_in: 400_000, llm_tokens_out: 40_000 });
  handle.db.usage.increment('u-a5', M1, { stt_minutes: 50_000, llm_tokens_in: 5_000_000, llm_tokens_out: 500_000 });
  // A second month, so every 「this month」 assertion has something to be wrong about.
  handle.db.usage.increment('u-a1', M2, { stt_minutes: 7, llm_tokens_in: 70, llm_tokens_out: 7 });
}

const ROUTES = [
  '/api/ops/usage/months',
  `/api/ops/usage/summary?month=${M1}`,
  `/api/ops/usage/users?month=${M1}`,
] as const;

// ── ① the gate: three answers, not two ─────────────────────────────────────────────────
describe('/api/ops/usage/* — the gate answers 401 / 403 / 200, never an empty 200', () => {
  it('anonymous → 401 AUTH_TOKEN_INVALID on every route', async () => {
    const { url, handle } = await saas();
    seed(handle);
    for (const path of ROUTES) {
      const r = await get(url, path);
      expect(r.status, `${path} admitted an anonymous caller`).toBe(401);
      expect(r.json.error, `${path}'s 401 is not named`).toBe('AUTH_TOKEN_INVALID');
      // 🔴 The negative half: not a single usage number rode along with the
      // refusal. Asserted on the WHOLE body, not on a field name — a nested echo
      // would slip past `expect(r.json.months).toBeUndefined()`.
      expect(r.body).not.toContain('50000');
      expect(r.body).not.toContain('u-a5');
    }
  });

  it('expired admin token → 401 AUTH_TOKEN_EXPIRED (「you have not proved who you are」 ≠ 「you are not an admin」)', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const stale = bearer(handle, 'u-admin', { ttlMs: 1_000, now: () => Date.now() - 60_000 });
    for (const path of ROUTES) {
      const r = await get(url, path, stale);
      // This account IS an admin. The honest reply names the CREDENTIAL, so the
      // client re-logs-in instead of going to ask for a permission it already has.
      expect(r.status).toBe(401);
      expect(r.json.error).toBe('AUTH_TOKEN_EXPIRED');
    }
  });

  it('valid non-admin → 403 ADMIN_ONLY, with nothing of the platform in the body', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const normal = bearer(handle, 'u-normal');
    for (const path of ROUTES) {
      const r = await get(url, path, normal);
      expect(r.status, `${path} did not refuse a non-admin`).toBe(403);
      expect(r.json.error).toBe('ADMIN_ONLY');
      // 🔴 An empty list would answer 「nobody on the platform used it」 to somebody who was actually
      // being turned away — the headline bug shape on the one surface whose job is
      // to tell a human the truth.
      expect(r.body).not.toContain('u-a5');
      expect(r.body).not.toContain('months');
      expect(r.body).not.toContain('stt_minutes');
    }
  });

  it('🔴 POSITIVE CONTROL — an admin asking the SAME question of the SAME server is admitted', async () => {
    // Without this, every 401/403 above could equally mean 「the route was never mounted」.
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    for (const path of ROUTES) {
      const r = await get(url, path, admin);
      expect(r.status, `${path} refused an ADMIN`).toBe(200);
    }
  });

  it('standalone mounts none of them — 404 means 「this deployment has no ops surface」, not 「you do not have permission」', async () => {
    server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
    const url = `http://127.0.0.1:${server.port}`;
    for (const path of ROUTES) {
      const r = await get(url, path);
      // If this ever became 403, a MODE gate would have been silently replaced by
      // an auth gate — a different and weaker thing.
      expect(r.status, `${path} should be unmounted in standalone`).toBe(404);
      expect(r.json.error).toBe('not_found');
    }
  });
});

// ── ② three routes, each answering one question ───────────────────────────────────────────────────
describe('/api/ops/usage/months — 「which months have usage rows」', () => {
  it('newest first, de-duplicated, and empty when the table is empty', async () => {
    const { url, handle } = await saas();
    const admin = (): Record<string, string> => bearer(handle, 'u-admin');
    handle.db.users.insert({ id: 'u-admin', display_name: 'A', is_admin: true });
    expect((await get(url, '/api/ops/usage/months', admin())).json.months).toEqual([]);

    handle.db.users.insert({ id: 'u-x', display_name: 'X' });
    handle.db.usage.increment('u-x', M1, { stt_minutes: 1 });
    handle.db.usage.increment('u-x', M2, { stt_minutes: 1 });
    handle.db.usage.increment('u-x', M1, { stt_minutes: 1 }); // same month twice
    expect((await get(url, '/api/ops/usage/months', admin())).json.months).toEqual([M2, M1]);
  });
});

describe('/api/ops/usage/summary — 「how much the whole platform used this month」', () => {
  it('sums the month and only the month', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');

    const r = await get(url, `/api/ops/usage/summary?month=${M1}`, admin);
    expect(r.status).toBe(200);
    expect(r.json.total).toEqual({
      month: M1,
      users: 5,
      stt_minutes: 54_321.5,
      llm_tokens_in: 5_432_100,
      llm_tokens_out: 543_210,
    });
    // 🔴 The all-months sum must appear in NEITHER month — that is what a dropped
    // `WHERE month=?` produces, and it looks entirely plausible.
    const r2 = await get(url, `/api/ops/usage/summary?month=${M2}`, admin);
    expect(r2.json.total).toEqual({
      month: M2, users: 1, stt_minutes: 7, llm_tokens_in: 70, llm_tokens_out: 7,
    });
    expect((r2.json.total as { stt_minutes: number }).stt_minutes).not.toBe(54_328.5);
  });

  it('a month with no rows is a PROVEN zero — and `users` is what says so', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    const absent = (await get(url, '/api/ops/usage/summary?month=2026-01', admin)).json.total as Record<string, number>;
    expect(absent).toEqual({ month: '2026-01', users: 0, stt_minutes: 0, llm_tokens_in: 0, llm_tokens_out: 0 });
    // Explicitly not null: SUM() over the empty set is NULL in SQL, and the
    // COALESCE is the entire point.
    expect(absent.stt_minutes).not.toBeNull();

    // Real rows whose measured usage happens to be zero: SAME totals, DIFFERENT
    // `users`. If emptiness had been folded into the totals these two states would
    // be indistinguishable — which is why `users` is a sibling field.
    handle.db.usage.increment('u-a1', '2026-02', {});
    handle.db.usage.increment('u-a2', '2026-02', {});
    const present = (await get(url, '/api/ops/usage/summary?month=2026-02', admin)).json.total as Record<string, number>;
    expect(present.stt_minutes).toBe(absent.stt_minutes);
    expect([present.users, absent.users]).toEqual([2, 0]);
  });

  it('does not round stt_minutes, and keeps token counts integral', async () => {
    const { url, handle } = await saas();
    handle.db.users.insert({ id: 'u-admin', display_name: 'A', is_admin: true });
    handle.db.users.insert({ id: 'u-f', display_name: 'F' });
    // What usage-tracker.ts actually writes: duration_ms / 60_000.
    handle.db.usage.increment('u-f', M1, { stt_minutes: 30_000 / 60_000, llm_tokens_in: 3, llm_tokens_out: 5 });
    const t = (await get(url, `/api/ops/usage/summary?month=${M1}`, bearer(handle, 'u-admin'))).json.total as Record<string, number>;
    expect(t.stt_minutes).toBe(0.5); // NOT 1, NOT 0 — rounding is the caller's decision
    expect(Number.isInteger(t.llm_tokens_in)).toBe(true);
    expect(Number.isInteger(t.llm_tokens_out)).toBe(true);
  });

  it('refuses a missing or malformed month by name — never a silent 「current month」', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    for (const q of ['', '?month=', '?month=2026-8', '?month=2026-13', '?month=2026-00', '?month=2026', '?month=abc', '?month=2026-07-01']) {
      const r = await get(url, `/api/ops/usage/summary${q}`, admin);
      expect(r.status, `month=${q} was accepted`).toBe(400);
      expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
      // 🔴 The failure that must NOT happen: answering with SOME month's numbers.
      expect(r.body).not.toContain('stt_minutes');
    }
  });
});

describe('/api/ops/usage/users — 「how much each account used this month」', () => {
  it('rows are per-user, in user_id order, for that month only', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const r = await get(url, `/api/ops/usage/users?month=${M1}`, bearer(handle, 'u-admin'));
    expect(r.status).toBe(200);
    expect(r.json.month).toBe(M1);
    const rows = r.json.rows as { user_id: string; month: string; stt_minutes: number }[];
    expect(rows.map((x) => x.user_id)).toEqual(['u-a1', 'u-a2', 'u-a3', 'u-a4', 'u-a5']);
    expect(rows.every((x) => x.month === M1)).toBe(true);
    // A total can be right while the rows underneath it are shuffled.
    expect(rows.map((x) => x.stt_minutes)).toEqual([1.5, 20, 300, 4000, 50_000]);
    // 🔴 One call, one question: no platform total smuggled into the page.
    expect(r.json).not.toHaveProperty('total');
    expect(r.json).not.toHaveProperty('users');
  });

  it('🔴 an exactly-full last page still reports next_after_user_id = null', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    // 5 rows, limit 5 — the page is exactly full and there is nothing after it.
    // `rows.length < limit` says 「there is another page」 here, forever.
    const full = await get(url, `/api/ops/usage/users?month=${M1}&limit=5`, admin);
    expect((full.json.rows as unknown[]).length).toBe(5);
    expect(full.json.next_after_user_id).toBeNull();
    // …and the page before it correctly says there IS more.
    const p4 = await get(url, `/api/ops/usage/users?month=${M1}&limit=4`, admin);
    expect(p4.json.next_after_user_id).toBe('u-a4');
  });

  it('a cursor walks every row exactly once, then stops', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const q = `month=${M1}&limit=2${cursor === null ? '' : `&after_user_id=${cursor}`}`;
      const page = await get(url, `/api/ops/usage/users?${q}`, admin);
      seen.push(...(page.json.rows as { user_id: string }[]).map((x) => x.user_id));
      cursor = page.json.next_after_user_id as string | null;
      if (cursor === null) break;
    }
    expect(seen).toEqual(['u-a1', 'u-a2', 'u-a3', 'u-a4', 'u-a5']);
    expect(cursor).toBeNull();
  });

  it('a cursor past the end is an empty final page, not a wrap-around', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const r = await get(url, `/api/ops/usage/users?month=${M1}&after_user_id=zzzz`, bearer(handle, 'u-admin'));
    expect(r.status).toBe(200);
    expect(r.json.rows).toEqual([]);
    expect(r.json.next_after_user_id).toBeNull();
  });

  it('refuses a limit it cannot honour instead of silently clamping it', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    for (const bad of ['0', '-1', '2.5', 'abc', '', String(USAGE_PAGE_MAX + 1), '10000']) {
      const r = await get(url, `/api/ops/usage/users?month=${M1}&limit=${bad}`, admin);
      expect(r.status, `limit=${bad} was accepted`).toBe(400);
      expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
      // 🔴 A caller that asked for 10 000 and got 200 rows believes it got 10 000.
      expect(r.body).not.toContain('u-a1');
    }
    // The boundary itself is legal, and the documented default applies when absent.
    expect((await get(url, `/api/ops/usage/users?month=${M1}&limit=${USAGE_PAGE_MAX}`, admin)).status).toBe(200);
    expect(USAGE_PAGE_DEFAULT).toBe(50);
  });

  it('an empty after_user_id is refused — it is neither a cursor nor 「from the start」', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const r = await get(url, `/api/ops/usage/users?month=${M1}&after_user_id=`, bearer(handle, 'u-admin'));
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
  });
});

// ── ③ 🔴 M2-7 / M2-8: reverse controls for the two mines ──────────────────────────────────────
describe('🔴 M2-7 — no response body can carry a password hash', () => {
  it('the hash IS in the database (positive control) and is in NONE of the bodies', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');

    // 🔴 POSITIVE CONTROL FIRST. Without it, 「the marker is absent」 could simply
    // mean the seed never stored one — the probe would be blind and the assertion
    // below would be green for the wrong reason.
    expect(handle.db.users.findById('u-admin')?.password_hash).toBe(HASH_MARKER);
    expect(HASH_MARKER.length).toBeGreaterThan(10);

    for (const path of ROUTES) {
      const r = await get(url, path, admin);
      expect(r.status).toBe(200);
      expect(r.body, `${path} leaked a password hash`).not.toContain(HASH_MARKER);
      // Not just the marker: the COLUMN NAME must not appear either, because a
      // future join that returned `password_hash: null` for some rows would be one
      // schema change away from returning the real thing.
      expect(r.body, `${path} exposes the password_hash field`).not.toContain('password_hash');
      // Nor any other account column that only `UserRepo` can produce.
      expect(r.body).not.toContain('admin@ops.co');
      expect(r.body).not.toContain('is_admin');
    }
  });
});

describe('🔴 M2-8 — a read-only ops route must not rewrite users.plan', () => {
  it('the drift survives all three routes, and the probe CAN see it being erased', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');

    // The bait: `users.plan` says 'pro' while nothing has been paid for, so the
    // effective tier is 'free'. That difference is exactly what a reconciliation
    // page exists to show — and exactly what `getPlan()` silently straightens out
    // (getPlan → resolve → mirrorPlanColumn → users.setPlan).
    expect(handle.db.users.findById('u-admin')?.plan).toBe('pro');

    for (const path of ROUTES) {
      expect((await get(url, path, admin)).status).toBe(200);
    }
    // 🔴 THE NEGATIVE HALF: byte-identical after every route ran.
    expect(handle.db.users.findById('u-admin')?.plan).toBe('pro');

    // 🔴 THE POSITIVE CONTROL, and it is the load-bearing half: prove this probe
    // can SEE the write it is denying. One direct getPlan() and the column is
    // rewritten — so the 'pro' above is the routes behaving, not the probe being
    // blind. (This is also the reason the routes never import BillingService: the
    // mine is unreachable, not merely unused.)
    expect(handle.billing.getPlan('u-admin').plan).toBe('free');
    expect(handle.db.users.findById('u-admin')?.plan).toBe('free');
  });
});

// ── ④ leave a trail: one row per admitted request, a 401 leaves none ─────────────────────────────────
describe('ops_audit_log — the admin gate leaves a trail', () => {
  it('an admitted request writes exactly one granted row naming the route', async () => {
    const { url, handle } = await saas();
    seed(handle);
    expect(handle.db.opsAudit.listRecent(50)).toEqual([]); // clean slate

    await get(url, `/api/ops/usage/summary?month=${M1}`, bearer(handle, 'u-admin'));
    const rows = handle.db.opsAudit.listRecent(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: 'u-admin',
      action: ADMIN_GATE_GRANTED,
      target_kind: 'route',
      target_id: 'GET /api/ops/usage/summary',
    });
    // Stamped by the repo, UTC, fixed width — never by the caller.
    expect(rows[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('a 403 writes a DENIED row naming who was refused', async () => {
    const { url, handle } = await saas();
    seed(handle);
    await get(url, '/api/ops/usage/months', bearer(handle, 'u-normal'));
    const rows = handle.db.opsAudit.listRecent(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: 'u-normal', // proven: this caller authenticated fine
      action: ADMIN_GATE_DENIED,
      target_id: 'GET /api/ops/usage/months',
    });
  });

  it('🔴 a 401 writes NO row — and the positive control proves the table is live', async () => {
    const { url, handle } = await saas();
    seed(handle);

    await get(url, '/api/ops/usage/months'); // anonymous
    await get(url, '/api/ops/usage/months', { authorization: 'Bearer garbage' });
    // NEGATIVE: an unproven caller has no actor, and `actor_user_id` is NOT NULL
    // precisely so nobody invents one. Unauthenticated knocking lives in the WARN
    // log, not here — see ops-audit-trail.ts's header for why that absence must
    // never be read as 「nobody ever knocked」.
    expect(handle.db.opsAudit.listRecent(50)).toEqual([]);

    // 🔴 POSITIVE CONTROL: the very next admitted request DOES write. Without it,
    // the zero above could just as easily mean 「the trail was never wired at all」.
    await get(url, '/api/ops/usage/months', bearer(handle, 'u-admin'));
    expect(handle.db.opsAudit.listRecent(50)).toHaveLength(1);
  });

  it('🔴 not one byte the caller supplied reaches the table', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    const MARKER = 'CALLER_SUPPLIED_ZZZ';
    await get(url, `/api/ops/usage/summary?month=${M1}&junk=${MARKER}`, admin);
    await get(url, `/api/ops/usage/users?month=${M1}&after_user_id=${MARKER}`, admin);

    const rows = handle.db.opsAudit.listRecent(50);
    // POSITIVE CONTROL: both requests really did pass the gate and write rows, so
    // the absence below is about the CONTENT and not about there being no content.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === ADMIN_GATE_GRANTED)).toBe(true);
    // NEGATIVE: every column of every row, serialized whole.
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    // `target_id` is one of our own literals and nothing else.
    expect(rows.map((r) => r.target_id).sort()).toEqual([
      'GET /api/ops/usage/summary',
      'GET /api/ops/usage/users',
    ]);
    // `detail` is unused by the gate — the DDL reserves it for 「a sentence we wrote ourselves」,
    // and a gate row has nothing to add beyond who/what/which route.
    expect(rows.every((r) => r.detail === null)).toBe(true);
  });

  it('the console admin route (/billing/orphans) leaves the same trail', async () => {
    // The gate's trail must cover EVERY admin route, not just the new ones —「some
    // admin actions have a record, some do not」 turns an empty query into two different answers.
    const { url, handle } = await saas();
    seed(handle);
    await get(url, '/api/cloud/billing/orphans', bearer(handle, 'u-admin'));
    expect(handle.db.opsAudit.listRecent(50)[0]).toMatchObject({
      actor_user_id: 'u-admin',
      action: ADMIN_GATE_GRANTED,
      target_id: 'GET /api/cloud/billing/orphans',
    });
  });
});
