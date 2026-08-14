// A6-3 pool selection — algorithm tests against an in-memory fake pool.
//
// SPEC-REF: docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md
//   §-0d (B17 Q1/Q2/Q4), §-0e (two-layer resolution), §-0f tail (filter vs
//   rank), §-0b (🔴 the acceptance that matters — see REVERSE CONTROL below).
//
// 🔴 SCOPE HONESTY: every assertion below proves the ALGORITHM against a fake
// pool. Not one of them proves that any real route works, that any provider is
// reachable, that the DB carries these columns, or that anything calls this
// module. Those are all [unproven].
//
// ⚠️ Fixture providers are deliberately NON-VENDOR names. They stand for the
// pair card §-0b names (a cloud streaming multi-language route and a local
// Chinese-strong route) without binding a test — or a grep — to a vendor.

import { describe, it, expect, vi } from 'vitest';
import {
  selectRoute,
  resolveGroup,
  auditRoleConsistency,
  LANGUAGE_ANY,
  REGION_ANY,
  type PoolRoute,
  type ConnectionCredential,
  type RouteSelection,
} from '../src/pool/select-route';

const PROD = 'production-primary';
const DEV = 'dev-lab';

function route(over: Partial<PoolRoute> & { id: string }): PoolRoute {
  return {
    group_id: PROD,
    provider: 'provider-x',
    model: 'model-x',
    api: 'wss://example.invalid/v1',
    region: REGION_ANY,
    languages: [LANGUAGE_ANY],
    role: 'backup',
    enabled: true,
    priority: 100,
    unit_price: 1,
    health: 'healthy',
    capacity: 10,
    streaming: true,
    ...over,
  };
}

const prodCredential: ConnectionCredential = {
  participation: { kind: 'platform-pool' },
  default_group_id: PROD,
  entitled_group_ids: [],
};

/** A pool that throws on ANY property access — the structural proof that the
 *  pool was not consulted at all, rather than "the spy was not called". */
function boobyTrappedPool(): readonly PoolRoute[] {
  return new Proxy([] as PoolRoute[], {
    get(_t, prop) {
      throw new Error(`pool was consulted (read '${String(prop)}')`);
    },
  });
}

function selected(r: RouteSelection) {
  if (r.outcome !== 'selected') throw new Error(`expected 'selected', got '${r.outcome}'`);
  return r;
}

/* ── The two genuinely different members used by the reverse control ──────── */
// Cloud-ish: streaming, multi-language, costs money, configured as the primary.
const CLOUD = route({
  id: 'cloud-rt-1',
  provider: 'cloud-rt',
  model: 'rt-v5',
  languages: ['zh', 'en', 'ja'],
  streaming: true,
  priority: 10,
  unit_price: 0.4,
  role: 'primary',
});
// Local-ish: streaming, Chinese only, zero marginal cost, configured backup.
const LOCAL = route({
  id: 'local-onnx-1',
  provider: 'local-onnx',
  model: 'sense-v1',
  languages: ['zh'],
  streaming: true,
  priority: 20,
  unit_price: 0,
  role: 'backup',
});
// Same local engine but batch-only — used to prove capability downgrade.
const LOCAL_BATCH = route({ ...LOCAL, id: 'local-batch-1', streaming: false });

const zhCn = { language: 'zh', region: 'cn' } as const;

describe('layer 0 — BYOK / self-hosted: the platform pool must not participate', () => {
  it('BYOK returns pool-not-consulted and never touches the pool', () => {
    const r = selectRoute({
      credential: { ...prodCredential, participation: { kind: 'byok' } },
      request: zhCn,
      pool: boobyTrappedPool(),
      isAvailable: () => {
        throw new Error('probe was called');
      },
    });
    // Proves: a third outcome exists. A caller physically cannot confuse
    // "the user brought their own key" with "the pool failed" — and cannot
    // silently substitute the platform's provider, which is a trust incident.
    expect(r).toEqual({ outcome: 'pool-not-consulted', reason: 'byok' });
  });

  it('self-hosted is the same early exit with its own reason', () => {
    const r = selectRoute({
      credential: { ...prodCredential, participation: { kind: 'self-hosted' } },
      request: zhCn,
      pool: boobyTrappedPool(),
    });
    expect(r).toEqual({ outcome: 'pool-not-consulted', reason: 'self-hosted' });
  });
});

describe('layer 1 — the group comes from the credential, never from the client', () => {
  it('an unentitled group request is REFUSED BY NAME, not downgraded', () => {
    const pool = [CLOUD, route({ id: 'dev-1', group_id: DEV, priority: 1 })];
    const r = selectRoute({ credential: prodCredential, request: { ...zhCn, requested_group_id: DEV }, pool });
    // The refusal itself…
    expect(r.outcome).toBe('refused');
    if (r.outcome !== 'refused') throw new Error('unreachable');
    expect(r.code).toBe('POOL_GROUP_NOT_ENTITLED');
    expect(r.detail).toContain(DEV);
    // …AND the half that actually matters: nothing was served. A silent
    // downgrade to the production group would still look like success here,
    // which is exactly the crosstalk failure this law was written for.
    expect(r).not.toHaveProperty('route');
  });

  it('a nonexistent group asked for by an unentitled client reports NOT_ENTITLED, not UNKNOWN', () => {
    // No group-name enumeration oracle for a principal with no entitlement.
    const r = selectRoute({
      credential: prodCredential,
      request: { ...zhCn, requested_group_id: 'no-such-group' },
      pool: [CLOUD],
    });
    if (r.outcome !== 'refused') throw new Error('expected refusal');
    expect(r.code).toBe('POOL_GROUP_NOT_ENTITLED');
  });

  it('an entitled group request is honoured and really leaves the production group', () => {
    const devRoute = route({ id: 'dev-1', group_id: DEV, provider: 'dev-box', languages: ['zh'] });
    const r = selected(
      selectRoute({
        credential: { ...prodCredential, entitled_group_ids: [DEV] },
        request: { ...zhCn, requested_group_id: DEV },
        pool: [CLOUD, devRoute],
      }),
    );
    expect(r.group_id).toBe(DEV);
    expect(r.route.id).toBe('dev-1');
    // The production route was not even a candidate.
    expect(r.ranked_route_ids).not.toContain(CLOUD.id);
  });

  it('a production client sends nothing and lands on its default group', () => {
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [CLOUD] }));
    expect(r.group_id).toBe(PROD);
  });

  it('resolveGroup returns a string owned by the credential, not the request', () => {
    const requested = String(DEV); // fresh instance, not the same reference
    const cred: ConnectionCredential = { ...prodCredential, entitled_group_ids: [DEV] };
    const g = resolveGroup(cred, { ...zhCn, requested_group_id: requested });
    if (!g.ok) throw new Error('expected ok');
    expect(g.group_id).toBe(cred.entitled_group_ids[0]);
  });
});

describe('🔴 REVERSE CONTROL — the pool really chooses (§-0b)', () => {
  it('primary probe fails ⇒ selection lands on the SECOND member and says so', () => {
    const probe = vi.fn((r: PoolRoute) => r.id !== CLOUD.id); // primary is down
    const r = selected(
      selectRoute({ credential: prodCredential, request: zhCn, pool: [CLOUD, LOCAL], isAvailable: probe }),
    );

    // (a) The candidate set was genuinely NOT a singleton. Without this the
    //     whole feature can pass while never having chosen anything.
    expect(r.ranked_route_ids).toEqual([CLOUD.id, LOCAL.id]);
    expect(r.ranked_route_ids.length).toBeGreaterThan(1);
    // (b) It really landed on the other member, not on the configured intent.
    expect(r.route.id).toBe(LOCAL.id);
    expect(r.route.provider).toBe('local-onnx');
    // (c) The probe was actually consulted, in order, and rejected the primary.
    expect(r.probed_route_ids).toEqual([CLOUD.id, LOCAL.id]);
    expect(probe).toHaveBeenCalledTimes(2);
    // (d) The move is STATED, with what was intended.
    expect(r.failover).toEqual({
      intended_route_id: CLOUD.id,
      intended_provider: 'cloud-rt',
      intended_model: 'rt-v5',
      skipped_route_ids: [CLOUD.id],
    });
    // (e) …and no FALSE downgrade alarm: the backup streams too, so capability
    //     was preserved. Reporting a downgrade here would be its own failure.
    expect(r.downgrade).toBeNull();
  });

  it('failing over to a non-streaming backup reports a CAPABILITY DOWNGRADE', () => {
    const r = selected(
      selectRoute({
        credential: prodCredential,
        request: zhCn,
        pool: [CLOUD, LOCAL_BATCH],
        isAvailable: (x) => x.id !== CLOUD.id,
      }),
    );
    expect(r.route.id).toBe(LOCAL_BATCH.id);
    // Machine-checkable, both sides stated so a log line cannot be misread.
    expect(r.downgrade).toEqual({
      capability: 'streaming',
      intended_route_id: CLOUD.id,
      chosen_route_id: LOCAL_BATCH.id,
      intended: true,
      chosen: false,
    });
    // Failover and downgrade are separate facts and both are present here.
    expect(r.failover?.intended_route_id).toBe(CLOUD.id);
  });

  it('with everything healthy the intent wins and nothing is reported', () => {
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [CLOUD, LOCAL] }));
    expect(r.route.id).toBe(CLOUD.id);
    expect(r.failover).toBeNull();
    expect(r.downgrade).toBeNull();
    // Still records that a real choice existed.
    expect(r.ranked_route_ids).toEqual([CLOUD.id, LOCAL.id]);
  });

  it('a single-member pool is visible AS a single-member pool', () => {
    // This is the state in which "smart selection" is a façade. The result
    // makes it falsifiable from production forensic, not just from a fixture.
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [CLOUD] }));
    expect(r.ranked_route_ids).toEqual([CLOUD.id]);
  });
});

describe('the universal token is the one this subsystem already uses', () => {
  it("spells the wildcard '*', matching engine-router.ts:88 and engine-presets", () => {
    // 🔴 Automated on purpose. A comment asking the next person not to rename
    // this back to 'all' (to match the owner's "all") is a discipline someone
    // has to remember; this is the same discipline the compiler enforces.
    // Divergence here is silent — both spellings "work", they just never match.
    expect(LANGUAGE_ANY).toBe('*');
    expect(REGION_ANY).toBe('*');
  });
});

describe("🔴 Q4 — an exact language match beats the '*' wildcard, unconditionally", () => {
  // The wildcard is configured to win on EVERY ranking key: better priority,
  // lower price, same health. It must still lose.
  const wildcard = route({ id: 'wild-1', languages: [LANGUAGE_ANY], priority: 1, unit_price: 0 });
  const exactJa = route({ id: 'exact-ja', languages: ['ja'], priority: 99, unit_price: 9 });

  it('exact wins even with the worst priority and the highest price', () => {
    const r = selected(
      selectRoute({ credential: prodCredential, request: { language: 'ja', region: 'cn' }, pool: [wildcard, exactJa] }),
    );
    expect(r.route.id).toBe('exact-ja');
    expect(r.tier).toBe('language-exact/region-any');
    // Proof that this is stratification, not a ranking bonus: the wildcard is
    // still in the candidate list, just in a later stratum.
    expect(r.ranked_route_ids).toEqual(['exact-ja', 'wild-1']);
  });

  it("the '*' route still serves as the fallback when no exact match exists", () => {
    const r = selected(
      selectRoute({ credential: prodCredential, request: { language: 'ko', region: 'cn' }, pool: [wildcard, exactJa] }),
    );
    expect(r.route.id).toBe('wild-1');
    expect(r.tier).toBe('language-any/region-any');
  });

  it('the wildcard stratum is reached when the exact stratum is exhausted', () => {
    const r = selected(
      selectRoute({
        credential: prodCredential,
        request: { language: 'ja', region: 'cn' },
        pool: [wildcard, exactJa],
        isAvailable: (x) => x.id !== 'exact-ja',
      }),
    );
    expect(r.route.id).toBe('wild-1');
    expect(r.tier).toBe('language-any/region-any');
    expect(r.failover?.intended_route_id).toBe('exact-ja');
  });
});

// ⚠️ What these tests pin is the SETTLED half only: `region` filters the
// candidate set and never ranks (§-0f tail). B17 Q2 — what `region` MEANS —
// is still unruled by the owner, and none of these assertions depends on the
// answer: a filter behaves identically under either reading.
describe('Q2 — region FILTERS the candidate set and never ranks', () => {
  it('a route that serves neither this region nor the wildcard is excluded, not demoted', () => {
    const eu = route({ id: 'eu-1', region: 'eu', languages: ['zh'], priority: 1 });
    const cn = route({ id: 'cn-1', region: 'cn', languages: ['zh'], priority: 50 });
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [eu, cn] }));
    expect(r.route.id).toBe('cn-1');
    expect(r.ranked_route_ids).not.toContain('eu-1'); // never even probed
    expect(r.probed_route_ids).not.toContain('eu-1');
  });

  it('an out-of-region-only group refuses with NO_CANDIDATE', () => {
    const eu = route({ id: 'eu-1', region: 'eu', languages: ['zh'] });
    const r = selectRoute({ credential: prodCredential, request: zhCn, pool: [eu] });
    if (r.outcome !== 'refused') throw new Error('expected refusal');
    expect(r.code).toBe('POOL_NO_CANDIDATE');
  });

  it('an exact region beats the region wildcard at the same language stratum', () => {
    const anyRegion = route({ id: 'any-1', region: REGION_ANY, languages: ['zh'], priority: 1 });
    const cnRegion = route({ id: 'cn-1', region: 'cn', languages: ['zh'], priority: 90 });
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [anyRegion, cnRegion] }));
    expect(r.route.id).toBe('cn-1');
    expect(r.tier).toBe('language-exact/region-exact');
  });

  it('language specificity dominates region specificity', () => {
    // exact language + any region  BEATS  wildcard language + exact region.
    const langExactRegionAny = route({ id: 'lang-1', region: REGION_ANY, languages: ['zh'], priority: 90 });
    const langAnyRegionExact = route({ id: 'reg-1', region: 'cn', languages: [LANGUAGE_ANY], priority: 1 });
    const r = selected(
      selectRoute({ credential: prodCredential, request: zhCn, pool: [langExactRegionAny, langAnyRegionExact] }),
    );
    expect(r.route.id).toBe('lang-1');
    expect(r.tier).toBe('language-exact/region-any');
  });
});

describe('Q1 — priority is the only ordering truth source; role is a label', () => {
  it('flipping both role labels changes nothing about the outcome', () => {
    const base = selectRoute({ credential: prodCredential, request: zhCn, pool: [CLOUD, LOCAL] });
    const flipped = selectRoute({
      credential: prodCredential,
      request: zhCn,
      pool: [
        { ...CLOUD, role: 'backup' },
        { ...LOCAL, role: 'primary' },
      ],
    });
    expect(selected(flipped).route.id).toBe(selected(base).route.id);
    expect(selected(flipped).ranked_route_ids).toEqual(selected(base).ranked_route_ids);
  });

  it('auditRoleConsistency surfaces a stored role that disagrees with the ordering', () => {
    const conflicts = auditRoleConsistency([
      { ...CLOUD, role: 'backup' }, // priority 10 ⇒ derived primary
      { ...LOCAL, role: 'primary' }, // priority 20 ⇒ derived backup
    ]);
    expect(conflicts).toEqual([
      { group_id: PROD, route_id: CLOUD.id, stored_role: 'backup', derived_role: 'primary' },
      { group_id: PROD, route_id: LOCAL.id, stored_role: 'primary', derived_role: 'backup' },
    ]);
  });

  it('a consistent table produces no conflicts, and groups are audited independently', () => {
    expect(
      auditRoleConsistency([CLOUD, LOCAL, route({ id: 'dev-1', group_id: DEV, role: 'primary', priority: 5 })]),
    ).toEqual([]);
  });
});

describe('unit_price orders only within an equivalent tier', () => {
  it('never outranks priority on its own — the free route loses', () => {
    const cheapButLater = route({ id: 'cheap-1', languages: ['zh'], priority: 50, unit_price: 0 });
    const dearButFirst = route({ id: 'dear-1', languages: ['zh'], priority: 10, unit_price: 5 });
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [cheapButLater, dearButFirst] }));
    expect(r.route.id).toBe('dear-1');
  });

  it('breaks a priority tie', () => {
    const a = route({ id: 'a-1', languages: ['zh'], priority: 10, unit_price: 5 });
    const b = route({ id: 'b-1', languages: ['zh'], priority: 10, unit_price: 1 });
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [a, b] }));
    expect(r.route.id).toBe('b-1');
  });
});

describe('health', () => {
  it("'down' routes are excluded from the candidate set entirely", () => {
    const down = route({ id: 'down-1', languages: ['zh'], priority: 1, health: 'down' });
    const up = route({ id: 'up-1', languages: ['zh'], priority: 50 });
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [down, up] }));
    expect(r.route.id).toBe('up-1');
    expect(r.ranked_route_ids).not.toContain('down-1');
    // Not a failover: 'down' was never the intent.
    expect(r.failover).toBeNull();
  });

  it("'degraded' ranks behind 'healthy' even with a better priority", () => {
    // lead position, not an owner ruling — see RouteHealth's doc comment.
    const degradedFirst = route({ id: 'deg-1', languages: ['zh'], priority: 1, health: 'degraded' });
    const healthyLater = route({ id: 'ok-1', languages: ['zh'], priority: 99, health: 'healthy' });
    const r = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [degradedFirst, healthyLater] }));
    expect(r.route.id).toBe('ok-1');
  });
});

describe('refusal taxonomy — four codes because four different operator actions', () => {
  it('POOL_GROUP_UNKNOWN: nothing in the pool carries the default group', () => {
    const r = selectRoute({
      credential: prodCredential,
      request: zhCn,
      pool: [route({ id: 'x', group_id: 'some-other-group' })],
    });
    if (r.outcome !== 'refused') throw new Error('expected refusal');
    expect(r.code).toBe('POOL_GROUP_UNKNOWN');
    expect(r.group_id).toBe(PROD);
  });

  it('POOL_GROUP_EMPTY: the group exists but everything is disabled or down', () => {
    const r = selectRoute({
      credential: prodCredential,
      request: zhCn,
      pool: [route({ id: 'a', languages: ['zh'], enabled: false }), route({ id: 'b', languages: ['zh'], health: 'down' })],
    });
    if (r.outcome !== 'refused') throw new Error('expected refusal');
    expect(r.code).toBe('POOL_GROUP_EMPTY');
  });

  it('POOL_ALL_UNAVAILABLE: candidates existed, every probe failed', () => {
    const r = selectRoute({
      credential: prodCredential,
      request: zhCn,
      pool: [CLOUD, LOCAL],
      isAvailable: () => false,
    });
    if (r.outcome !== 'refused') throw new Error('expected refusal');
    // Distinct from NO_CANDIDATE: "your providers are down" vs "fix your config".
    expect(r.code).toBe('POOL_ALL_UNAVAILABLE');
    expect(r.detail).toContain('2 candidate');
  });
});

describe('determinism', () => {
  it('is order-independent — a shuffled pool selects the same route', () => {
    const pool = [CLOUD, LOCAL, route({ id: 'tie-1', languages: ['zh'], priority: 10, unit_price: 0.4 })];
    const a = selected(selectRoute({ credential: prodCredential, request: zhCn, pool }));
    const b = selected(selectRoute({ credential: prodCredential, request: zhCn, pool: [...pool].reverse() }));
    expect(b.route.id).toBe(a.route.id);
    expect(b.ranked_route_ids).toEqual(a.ranked_route_ids);
  });

  it('repeats exactly for the same input (no clock, no randomness)', () => {
    const args = { credential: prodCredential, request: zhCn, pool: [CLOUD, LOCAL] };
    expect(selectRoute(args)).toEqual(selectRoute(args));
  });
});
