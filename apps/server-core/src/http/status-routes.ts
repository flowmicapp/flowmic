// SPEC-REF:
//   docs/strategy/2026-08-13-0263-design-task-book.md §9 (REQ-13-03 service-availability
//     status page), §9-2.1 (the page only reads the latest result + a timestamp), §9-2.2 (anti-cache ⇒ unknown),
//     §9-2.3 (v1 only does current state, three tiles), §9-2.5 (no SLA, no percentages anywhere on the page),
//     §9-2.6 (W-5a: HTTP route, zero protocol events, precedent = /api/network's own inline comment)
//   apps/server-core/src/status/status-probes.ts (the store + the staleness rule)
//   apps/server-core/src/http/router.ts `/api/health` (THE public-route precedent
//     this mirrors: no credential, mounted in both modes)
//
// GET /api/status — the machine-readable half of the public status page. The
// page itself is W-5b and lives in the WEB repo; this serves it.
//
// ── 🔴 PUBLIC BY DESIGN, AND DELIBERATELY OUT OF EVERY GATE TABLE ───────────
// No credential. It backs a page whose entire purpose is to be readable by
// someone who cannot reach the product — a status page you must log in to read
// answers the wrong question on exactly the day it matters.
//
// So this file is NOT in `ADMIN_GATED_ROUTES` (http/ops-audit-trail.ts) and NOT
// in `test/console-admin-gate-coverage.test.ts`'s `ROUTE_SOURCES`, and both
// absences are decisions rather than omissions. That fence is a list of LITERALS
// whose job is to make "put a route behind the admin gate" an explicit act; a
// public route added to it would be a lie in the other direction. The precedent
// is exact: `/api/health` and `/api/updates/latest` are public routes served
// from files that list deliberately does not scan. (`presence-routes.ts` was
// once cited here as a third precedent — wrongly: it takes a Bearer credential,
// so its absence from `ROUTE_SOURCES` is a pre-existing GAP in that fence, not
// a precedent for this file. Registered in the WP5 review annex.)
//
// 🔴 THE ONE THING THAT WOULD MAKE THAT WRONG, stated here because the next
// person to edit this file is the only one who can honour it: if this file ever
// grows a route that takes a credential or answers per-account, registering it
// in `ROUTE_SOURCES` is part of shipping it. A route added where the scanner is
// not looking is invisible to the scanner — that suite's own header says so, and
// it has caught the shape twice.
//
// ── 🔴 WHAT IS NOT IN THE BODY, AND WHY ─────────────────────────────────────
// The verdicts carry a `code` and the provider's own `message`. Neither is
// published. `compose/llm-health.ts` types that field "Never shown to a user",
// and a public page is the most user-facing surface there is: the real strings
// are things like `402 organization_balance_exhausted` and `STT_ENGINE_AUTH_FAIL`
// — our billing state and our credential state, handed to anyone who asks. The
// operator's copy is not lost; it is in the log line the probe already writes.
// A public reader is owed "is this line usable right now" and nothing further.
//
// NO PERCENTAGES, NO SLA (§9-2.5). There is no uptime number anywhere in this
// body and there must not be one: v1 stores no history (§9-2.3), so any
// percentage would be computed from nothing.
//
// ⚠️ ZERO PROTOCOL SURFACE: an HTTP route, not a socket event — no whitelist and
// no count-guard involvement, the same standing `/api/network` and
// `/api/pc/presence` have.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerMode } from '@flowmic/protocol';
import { sendJson } from './body';
import type { ProbedTargets } from '../status/status-probes';

export const STATUS_ROUTE_PATH = '/api/status';

export interface StatusRoutesDeps {
  /** The probe store's current view, staleness already applied. Read per
   *  request; NEVER a probe (§9-2.1 — a public page that triggers probing hands
   *  our provider dial-out to arbitrary traffic). */
  snapshot: () => ProbedTargets;
  /** Same value `/api/health` publishes; the download page publishes it too. */
  version: string;
  mode: ServerMode;
  now?: () => number;
}

/**
 * @returns true iff this module handled the request.
 */
export function tryHandleStatusRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: StatusRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  if (url !== STATUS_ROUTE_PATH && !url.startsWith(`${STATUS_ROUTE_PATH}?`)) return false;
  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  const now = (deps.now ?? Date.now)();
  const targets = deps.snapshot();
  sendJson(res, 200, {
    // When THIS answer was assembled — distinct from each target's own
    // `checked_at`, and the difference is the whole point: a reader can see that
    // the page is live while a measurement under it is minutes old.
    checked_at: now,
    targets: {
      // 🔴 The relay's row is NOT probed and must not pretend to be. It is
      // SELF-EVIDENT: this response existing IS the measurement, so its
      // `checked_at` is now and it can never be stale. It also never reads
      // `'down'` — a relay that is down does not answer, which is what the page's
      // own fetch failure means. Giving it a probe would be a process measuring
      // whether it is running.
      relay: { status: 'up', checked_at: now, version: deps.version, mode: deps.mode },
      managed_stt: targets.managed_stt,
      managed_llm: targets.managed_llm,
    },
  });
  return true;
}
