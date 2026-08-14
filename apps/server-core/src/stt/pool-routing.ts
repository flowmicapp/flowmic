// SPEC-REF:
//   apps/server-core/src/pool/select-route.ts (A6-3, the algorithm)
//   docs/strategy/2026-08-02-m2-window-handoff-report.md §5 M2-2
//     (🔴 O-5 route-selection algorithm [NOT WIRED] zero production consumer — THIS FILE is the consumer)
//   docs/decisions/2026-08-02-owner-stt-pool-groups-and-ops-phase1-scope.md ③
//   docs/strategy/2026-08-02-h6-soniox-streaming-adapter-card.md §-0e (two-layer parsing)
//
// 🔴 THE PRODUCTION CONSUMER OF `selectRoute`.
//
// `makePoolManagedDefault()` is handed to the engine router as its
// `managedDefault` resolver, so EVERY managed (non-BYOK, non-self-hosted) STT
// session resolves through the pool. Grep chain, top to bottom:
//   engine-factory.ts  makeSttOrchestratorFactory → makePoolManagedDefault(...)
//   pool-routing.ts    resolvePoolRouting        → selectRoute(...)
//   engine-router.ts   selectRoutingWithSource   → managedDefault(language)
//
// ── LAYER 0, and why it is structurally impossible to violate here ───────────
// A6 §3-1 is a TRUST red line: a user who brought their own key must never be
// silently served by the platform's provider. This module cannot break it
// because it is only ever reached through `selectRoutingWithSource`, which
// consults `managedDefault` ONLY after the user's own routings have missed. The
// credential below therefore states `platform-pool` as a FACT about that call
// site, not as a guess — and `selectRoute` still re-checks it first thing.
//
// ── LAYER 1, and what this round deliberately does NOT do ────────────────────
// 🔴 THE CLIENT CANNOT NAME A GROUP THIS ROUND. `requested_group_id` is never
// populated below — there is no code path from any frame to it. owner ruled
// (2026-08-02, group-model ruling) that a client MAY request a group and that the server
// must then check that account's entitlement and REFUSE BY NAME when it has
// none, never silently fall back to the default group. That needs an additive
// protocol field, and the protocol face is an owner gate that this lane was told
// not to pass — so the entry point is ABSENT, not half-built.
// ⚠️ Do NOT "enable" it by reading a group off a frame and passing it here
// without an entitlement check. That is not a smaller version of the feature, it
// is the security requirement deleted: any phone could then address a dev group
// that may point at private machines and may not count quota. The entitlement
// half is the feature.
// `entitled_group_ids` is `[]` for the same reason: there is nothing yet that
// can grant an entitlement, and an empty list is the honest value.

import { log } from '../log';
import {
  selectRoute,
  type ConnectionCredential,
  type PoolRoute,
  type RouteRequest,
  type RouteSelection,
} from '../pool/select-route';
import type { EngineFactory, Routing } from './engine-router';
import { loadPool, type LoadedPool } from './pool-config';
import { makeRouteHealthRegistry, type RouteHealthRegistry } from './pool-health';

export interface PoolRoutingDeps {
  /** Parsed pool. Injected so a caller can supply a fixture without touching
   *  process.env; production passes nothing and gets `loadPool()`. */
  pool?: LoadedPool;
  /** Engine factory the liveness probe builds with. REQUIRED when health
   *  probing is on — there is no benign default (see pool-health.ts). */
  factory?: EngineFactory;
  /** Override the health registry entirely (tests, and the failover drill). */
  health?: RouteHealthRegistry;
  env?: NodeJS.ProcessEnv;
}

export interface PoolManagedDefault {
  /** The `managedDefault` resolver the engine router calls, per audio:start. */
  resolve: (language: string) => Routing | null;
  /** Exposed for the ops/forensic side and for the failover drill. */
  health: RouteHealthRegistry | null;
  pool: LoadedPool;
}

/** Build the credential for a managed session. Every group id `selectRoute` can
 *  return comes out of this object — never off the wire. */
function credentialFor(pool: LoadedPool): ConnectionCredential {
  return {
    participation: { kind: 'platform-pool' },
    default_group_id: pool.defaultGroupId,
    entitled_group_ids: [],
  };
}

/**
 * One resolution. Split out from the closure so the forensic shape is readable
 * in one screen and testable without building a factory.
 */
export function resolvePoolRouting(
  pool: LoadedPool,
  language: string,
  isAvailable?: (route: PoolRoute) => boolean,
): { routing: Routing | null; selection: RouteSelection } {
  const request: RouteRequest = {
    language,
    region: pool.region,
    // requested_group_id: intentionally absent — see the header.
  };
  const selection = selectRoute({
    credential: credentialFor(pool),
    request,
    pool: pool.pool,
    ...(isAvailable ? { isAvailable } : {}),
  });
  if (selection.outcome !== 'selected') return { routing: null, selection };
  return { routing: pool.routingOf(selection.route.id), selection };
}

/**
 * Build the pool-backed managed-default resolver.
 *
 * Returns `null` from `resolve()` in exactly the cases the old
 * `managedDefaultRouting()` returned null (nothing configured), so a deployment
 * with no managed STT behaves identically — including the "no implicit
 * fallback" `SttConfigMissingError` that follows.
 */
export function makePoolManagedDefault(deps: PoolRoutingDeps = {}): PoolManagedDefault {
  const pool = deps.pool ?? loadPool(deps.env ?? process.env);
  // 🔴 Liveness probing is ON only for a REAL configured pool. With the
  // synthesized one-route pool there is nothing to fail over TO, and refusing
  // would swap the provider's true error for "no recognition engine has been
  // configured for this language yet" — a false
  // reason is worse than a late one.
  const probing = pool.source === 'pool-env';
  const health = deps.health ?? (probing && deps.factory
    ? makeRouteHealthRegistry({ factory: deps.factory })
    : null);

  if (pool.source === 'pool-env' && health === null) {
    // Fail LOUD. A configured pool whose health can never be measured is a pool
    // that will never fail over, and it would look identical to a working one.
    throw new Error(
      'FLOWMIC_STT_POOL is configured but no engine factory was supplied to the pool router — '
      + 'liveness could never be measured and failover could never fire. This is a wiring bug, not a config one.',
    );
  }

  const resolve = (language: string): Routing | null => {
    if (pool.pool.length === 0) return null;

    const first = resolvePoolRouting(
      pool,
      language,
      health === null ? undefined : (r: PoolRoute) => health.isAvailable(r),
    );
    let { routing, selection } = first;

    if (selection.outcome === 'refused' && selection.code === 'POOL_ALL_UNAVAILABLE') {
      // Every candidate failed the probe. Re-resolve WITHOUT the probe and use
      // the configured intent, loudly. Rationale: returning null here would
      // surface `STT_CONFIG_MISSING` "no recognition engine has been
      // configured for this language yet", which is false —
      // it IS configured, it is broken — and it would hide the provider's own
      // words. Letting the session run means the user gets the real reason.
      // 🔴 This is not a silent re-route: it lands on the SAME route the
      // configuration intended, and says so at error level.
      log.error('stt.pool every route failed liveness — proceeding with the configured intent so the provider states the real reason', {
        group_id: selection.group_id, detail: selection.detail, language,
      });
      const retry = resolvePoolRouting(pool, language);
      routing = retry.routing;
      selection = retry.selection;
    }

    if (selection.outcome === 'pool-not-consulted') {
      // Unreachable by construction (the credential above is always
      // platform-pool) — but if it ever becomes reachable, saying so beats
      // returning null and letting it read as "not configured".
      log.error('stt.pool was not consulted on the managed path — this should be impossible', { reason: selection.reason });
      return null;
    }
    if (selection.outcome === 'refused') {
      log.error('stt.pool refused to select a route', {
        code: selection.code, group_id: selection.group_id, detail: selection.detail, language,
      });
      return null;
    }
    if (routing === null) {
      // The pool row and the connect config are two halves of one file; a
      // selected id with no routing means they drifted.
      log.error('stt.pool selected a route with no connect config — pool config is inconsistent', {
        route_id: selection.route.id,
      });
      return null;
    }

    // 🔴 THE ANTI-FAÇADE LINE. `candidates` is what makes "smart route
    // selection has been implemented"
    // falsifiable from production data: `candidates === 1` means the pool never
    // actually chose anything (card §-0b). Logged on EVERY selection, at info, so
    // the claim can be checked against the relay's own log rather than against a
    // test fixture.
    log.info('stt.pool selected a route', {
      route_id: selection.route.id,
      provider: selection.route.provider,
      model: selection.route.model,
      group_id: selection.group_id,
      tier: selection.tier,
      candidates: selection.ranked_route_ids.length,
      ranked: selection.ranked_route_ids,
      probed: selection.probed_route_ids,
      language,
      pool_source: pool.source,
    });

    if (selection.failover !== null) {
      // A6 §3-3 red line: a failover is never silent.
      log.error('stt.pool FAILED OVER to a backup route', {
        intended_route_id: selection.failover.intended_route_id,
        intended_provider: selection.failover.intended_provider,
        intended_model: selection.failover.intended_model,
        skipped: selection.failover.skipped_route_ids,
        chosen_route_id: selection.route.id,
        chosen_provider: selection.route.provider,
        language,
      });
    }
    if (selection.downgrade !== null) {
      // 🔴 A capability the user had and no longer has. Separate line, separate
      // question: a failover to an equally capable backup is NOT a downgrade,
      // and reporting it as one would be a false alarm.
      log.error('stt.pool CAPABILITY DOWNGRADE — the chosen route cannot do what the intended one could', {
        capability: selection.downgrade.capability,
        intended_route_id: selection.downgrade.intended_route_id,
        intended: selection.downgrade.intended,
        chosen_route_id: selection.downgrade.chosen_route_id,
        chosen: selection.downgrade.chosen,
      });
    }

    // Kick a background refresh AFTER answering, never before: selection is on
    // the audio:start path and must cost zero extra latency (A6 §4a).
    if (health !== null) {
      for (const route of pool.pool) {
        const r = pool.routingOf(route.id);
        if (r !== null) health.refresh(route, r, language);
      }
    }
    return routing;
  };

  return { resolve, health, pool };
}
