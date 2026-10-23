// SPEC-REF:
//   docs/strategy/2026-08-31-lan-ops-console-third-party-spec.md §4.5 (channel A v2 — the contract)
//   docs/strategy/2026-10-11-ops-console-direct-and-slow-pull.md §4-2, §5-1 O2
//   apps/server-core/src/node/ops-snapshot.ts (the producer and its column allowlist)
//   apps/server-core/src/http/node-routes.ts (the ONE caller; split out because
//     that file sits near the 800-line cap, verify/lint/file-size.mjs)
//
// ── GET /api/node/ops-snapshot ──────────────────────────────────────────
//
// The LAN ops console's slim snapshot. Four gates, in this order, and the order
// is part of the contract:
//
//   1. `x-flowmic-client-verify: SUCCESS`, else 404. RESERVED FOR THE 9443 mTLS
//      server block: nginx there sets this header from `$ssl_client_verify`, and
//      the 443 block returns 404 for this path and blanks the header everywhere
//      (spec §4.5.1). 🔴 Live on production since 2026-10-12: nginx does both.
//      The 9443 server block demands a client certificate signed by the private
//      ops CA, pins that certificate's SHA-1 fingerprint, serves only GET/HEAD on
//      this one path (404 for anything else) and sets the header from
//      `$ssl_client_verify`; every 443/80 front door on NY and JP answers 404 for
//      the path and blanks the header. Grep anchors in the web repo:
//      `deploy/nginx.flowmic-ops-mtls.conf` (the 9443 block and the pin) and
//      `deploy/nginx-ops-snapshot-door.test.mjs` (the door's drill). So through
//      nginx the header is a real second factor. Residual: this process still
//      trusts the header as given, so any local process on the NY host that can
//      reach 127.0.0.1 can send it itself; gate 2 (the key) still applies to
//      every caller, and is then the only factor left against such a process.
//      It answers 404, not 403, so a caller on the wrong port learns nothing
//      about whether the route exists.
//   2. The SNAPSHOT-ONLY key (`FLOWMIC_NODE_SNAPSHOT_SECRET`), else 403. The
//      shared node secret is NOT accepted: replicas pull the whole database on
//      `/api/node/snapshot` and have no business here, and accepting it would
//      make the console's credential and the replicas' one interchangeable on
//      a route only one of them should use.
//   3. At most one answer (200 or 304) per [OPS_SNAPSHOT_MIN_INTERVAL_MS], else
//      429 + Retry-After. Checked AFTER auth, so an unauthenticated caller can
//      neither consume the console's slot nor learn when it last pulled. A 429
//      and a failed generation consume nothing.
//   4. Generate, hash, then 304 if `If-None-Match` names the hash, else 200 +
//      gzip body. Both carry ETag and `x-flowmic-data-as-of`.
//
// 501 when this process cannot serve it at all (not the writer, or no
// snapshot-only key issued) — checked after gate 1 so the 443 door stays a
// uniform 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OpsSnapshotOutcome } from '../node/ops-snapshot';

/** The console pulls every 15 minutes (spec §4.5.2); this only stops a
 *  hammered 「pull now」 button or a broken backoff turning into load. */
export const OPS_SNAPSHOT_MIN_INTERVAL_MS = 60_000;

/** The header nginx's 9443 block sets from `$ssl_client_verify`. */
export const CLIENT_VERIFY_HEADER = 'x-flowmic-client-verify';

export interface OpsSnapshotRouteHelpers {
  secretMatches: (expected: string, offered: string) => boolean;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

/** Structural subset of `NodeRoutesDeps`, for the import-cycle reason the
 *  sibling route files state. */
export interface OpsSnapshotRouteDeps {
  snapshotSecret?: string;
  opsSnapshot?: (ifNoneMatch?: string) => Promise<OpsSnapshotOutcome>;
}

export function makeOpsSnapshotRoute(
  deps: OpsSnapshotRouteDeps,
  helpers: OpsSnapshotRouteHelpers,
  now: () => number = Date.now,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { secretMatches, sendJson } = helpers;
  /** When the last answer that counts (200/304) STARTED. Set before generating
   *  so a second request arriving while the first is still being produced is
   *  refused too; rolled back if the generation fails. */
  let lastAnswerAt: number | null = null;

  return (req, res): void => {
    if (req.headers[CLIENT_VERIFY_HEADER] !== 'SUCCESS') {
      sendJson(res, 404, { ok: false, error: 'not_found' });
      return;
    }
    if (!deps.opsSnapshot || !deps.snapshotSecret) {
      sendJson(res, 501, { ok: false, error: 'ops_snapshot_not_configured' });
      return;
    }
    const offered = req.headers['x-flowmic-node-secret'];
    if (!secretMatches(deps.snapshotSecret, typeof offered === 'string' ? offered : '')) {
      sendJson(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    const t = now();
    // `elapsed >= 0`: Date.now() can step BACKWARDS (NTP, VM resume). A negative
    // elapsed would read as 「answered a moment ago」 and refuse every pull, with a
    // Retry-After the size of the step, until the clock caught up. A step back
    // frees the slot instead; the window re-bases on this request below.
    const elapsed = lastAnswerAt === null ? Infinity : t - lastAnswerAt;
    if (elapsed >= 0 && elapsed < OPS_SNAPSHOT_MIN_INTERVAL_MS) {
      const retryAfterS = Math.max(1, Math.ceil((OPS_SNAPSHOT_MIN_INTERVAL_MS - elapsed) / 1000));
      res.setHeader('retry-after', String(retryAfterS));
      sendJson(res, 429, { ok: false, error: 'rate_limited', retry_after_s: retryAfterS });
      return;
    }
    const previous = lastAnswerAt;
    lastAnswerAt = t;
    const inm = req.headers['if-none-match'];
    const produce = deps.opsSnapshot;
    void (async (): Promise<void> => {
      let outcome: OpsSnapshotOutcome;
      try {
        outcome = await produce(typeof inm === 'string' ? inm : undefined);
      } catch (err) {
        lastAnswerAt = previous;
        sendJson(res, 500, {
          ok: false,
          error: 'ops_snapshot_failed',
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const common = {
        etag: outcome.etag,
        'x-flowmic-data-as-of': outcome.dataAsOf,
        // A cached copy at any edge is a console frozen at whatever it kept.
        'cache-control': 'no-store',
      };
      if (outcome.status === 'unchanged') {
        res.writeHead(304, common);
        res.end();
        return;
      }
      res.writeHead(200, {
        ...common,
        'content-type': 'application/octet-stream',
        'content-encoding': 'gzip',
        'content-length': outcome.body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : outcome.body);
    })();
  };
}
