// SPEC-REF:
//   src/http/router.ts (the caller — this file is a VERBATIM extraction from it)
//   src/http/ops-audit-trail.ts `ADMIN_GATED_ROUTES` (what these six serve)
//   verify/lint/file-size.mjs (the 800-line cap that forced the split)
//
// THE saas-ONLY OPERATOR MOUNTS.
//
// router.ts stood at EXACTLY 800 lines on 2026-09-07 and the REQ-002 pair could
// not be added without crossing the cap, so this block moved out whole — the
// same forced split that produced ops-refund-release-routes.ts and
// node-routes-forward-sync.ts. Nothing about the behaviour changed: the order,
// the conditions and every comment came across verbatim, and `config.mode` is
// now the `mode` parameter.
//
// 🔴 WHY THE MODE CHECK IS HERE AND NOT ONLY IN bootstrap. Each of these deps is
// already built saas-only, and the re-check looks redundant until you ask what a
// mis-wire would DO: standalone has no account layer at all (one local owner, no
// JWT, `is_admin` never set), so an admin-gated cross-account WRITE mounted there
// would sit behind a gate that can never say no. `test/account-restriction.test.ts`
// wires exactly that mistake on purpose. The check is cheap; the failure is not.
//
// ⚠️ ORDER IS PRESERVED AND IS NOT LOAD-BEARING: the six path sets are disjoint,
// and they read in the order they were built. A future addition goes at the end
// for the same reason.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from '../config';
import { tryHandleAccountRestrictionRoutes } from './account-restriction-routes';
import { tryHandleOpsUserRoutes } from './ops-user-routes';
import { tryHandleOpsUsageEventsRoutes } from './ops-usage-events-routes';
import { tryHandleOpsPurchaseRoutes } from './ops-purchase-routes';
import { tryHandleOpsRefundReleaseRoutes } from './ops-refund-release-routes';
import { tryHandleOpsSubscriptionRoutes } from './ops-subscription-routes';
import type { HttpDeps } from './router-deps';

/** Exactly the six deps this file may touch — a slice of `RouterDeps`, so the
 *  extraction cannot quietly grow into a second router. */
export type SaasOpsFamilyDeps = Pick<
  HttpDeps,
  'restriction' | 'opsUsers' | 'opsUsageEvents' | 'opsPurchases' | 'opsRefundRelease' | 'opsSubscriptions'
>;

/** Returns true iff one of the six owned the request. */
export function tryHandleSaasOpsFamily(
  req: IncomingMessage,
  res: ServerResponse,
  mode: ServerConfig['mode'],
  deps: SaasOpsFamilyDeps,
): boolean {
    // A2-3 — saas-only `POST /api/ops/users/restrict` ("restrict usage" write).
    //
    // TWO conditions, the keymeta/timelineGrants shape rather than `ops`'s one:
    // bootstrap builds the dep saas-only, AND the mode is re-checked here — and
    // for this route that second condition is worth more than it is for a read.
    // standalone has no account layer (one local owner, no JWT, `is_admin` never
    // set), so a mis-wired dep would expose a cross-account WRITE on somebody's
    // LAN box behind a gate that can never say no. `test/account-restriction
    // .test.ts` wires exactly that mistake on purpose.
    if (mode === 'saas' && deps.restriction
      && tryHandleAccountRestrictionRoutes(req, res, deps.restriction)) return true;

    // A2-4 — saas-only `GET /api/ops/users{,/detail}` (the read-only account
    // list). Same TWO conditions as the restriction mount right above, and for a
    // reason that survives being a read: standalone has no account layer at all
    // (one local owner, no JWT, `is_admin` never set), so a mis-wired dep would
    // publish every account row on somebody's LAN box behind a gate that can
    // never say yes to anyone — i.e. the paths would exist and refuse everybody,
    // which is a worse answer than the honest "this deployment has no ops surface" 404.
    // Ordered AFTER the restriction mount purely so the three ops blocks read in
    // the order they were built; the three path sets are disjoint.
    if (mode === 'saas' && deps.opsUsers
      && tryHandleOpsUserRoutes(req, res, deps.opsUsers)) return true;

    // A2-5 / REQ-12-08 — saas-only `GET /api/ops/usage/events?user_id=` (one
    // account's usage detail, for operators). Same TWO conditions as the two
    // mounts above and for the same reason: standalone has no account layer, so
    // a mis-wired dep would publish per-event usage on somebody's LAN box behind
    // a gate that can never say yes to anyone. Ordered after `opsUsers` purely
    // so the four ops blocks read in the order they were built; the path sets
    // are disjoint.
    if (mode === 'saas' && deps.opsUsageEvents
      && tryHandleOpsUsageEventsRoutes(req, res, deps.opsUsageEvents)) return true;

    // 2026-08-29 — saas-only operator surface for the paid setup service. Two
    // conditions like its four neighbours: absent deps fall to the router's 404
    // ("this deployment has no such surface") rather than to a gate that could
    // never say yes.
    if (mode === 'saas' && deps.opsPurchases
      && tryHandleOpsPurchaseRoutes(req, res, deps.opsPurchases)) return true;

    // 2026-08-31 — the way out of a stuck 'refund_requested'. Same two
    // conditions and the same reason as the mount above it.
    if (mode === 'saas' && deps.opsRefundRelease
      && tryHandleOpsRefundReleaseRoutes(req, res, deps.opsRefundRelease)) return true;

    // 2026-09-07 (REQ-002) — the operator's 「stop this account's renewals」 pair.
    // Same TWO conditions as every ops mount above it, and the second one earns
    // its keep here for the reason the restriction mount states: standalone has
    // no account layer (one local owner, no JWT, `is_admin` never set), so a
    // mis-wired dep would put a cross-account BILLING write on somebody's LAN
    // box behind a gate that can never say no.
    if (mode === 'saas' && deps.opsSubscriptions
      && tryHandleOpsSubscriptionRoutes(req, res, deps.opsSubscriptions)) return true;

  return false;
}
