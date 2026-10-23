// SPEC-REF:
//   apps/server-core/src/http/node-routes.ts     (the ONE caller — split out for
//     the same 800-line cap reason as node-routes-forward-sync.ts)
//   apps/server-core/src/node/revocation-hint.ts (what is being waited on)
//   docs/strategy/2026-10-11-replication-tiering-design.md §11-3
//   *** HUMAN-AUDIT SENSITIVE (auth: revocation reach across nodes) ***
//
// GET /api/node/revocation-hint?boot=&gen=&wait_ms= — REVOKE-PUSH's long-poll.
//
// Answers `{ok, boot, gen}` as soon as the writer's pair differs from the one
// the caller brought (at once if it already does), or after at most
// REVOCATION_HINT_MAX_WAIT_MS with the current pair. The body carries no ids
// and no rows: what changed is learned by pulling the snapshot, the route that
// is already the authority.
//
// 🔴 THE SHARED SECRET ONLY. The ops console's read-only snapshot key does not
// open this (it is compared by name against `sharedSecret`, the same structural
// narrowing node-routes.ts documents for every route but /snapshot). A GET, so
// it needed no POST_PATHS entry — nothing secret rides the query string: a
// boot id and a counter.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RevocationHintState } from '../node/revocation-hint';

export interface RevocationHintRouteHelpers {
  secretMatches: (expected: string, offered: string) => boolean;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

/** Structural subset of `NodeRoutesDeps`, for the import-cycle reason
 *  node-routes-forward-sync.ts gives. */
export interface RevocationHintRouteDeps {
  sharedSecret?: string;
  revocationHint?: {
    waitForChange(
      seen: Partial<RevocationHintState>,
      waitMs: number,
    ): { promise: Promise<RevocationHintState>; cancel(): void };
  };
}

export function handleRevocationHintRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  deps: RevocationHintRouteDeps,
  helpers: RevocationHintRouteHelpers,
): void {
  const { secretMatches, sendJson } = helpers;
  if (!deps.revocationHint || !deps.sharedSecret) {
    sendJson(res, 501, { ok: false, error: 'revocation_hint_not_configured' });
    return;
  }
  const offered = req.headers['x-flowmic-node-secret'];
  if (!secretMatches(deps.sharedSecret, typeof offered === 'string' ? offered : '')) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  const q = new URL(url, 'http://x').searchParams;
  const boot = q.get('boot');
  const genRaw = q.get('gen');
  const waitRaw = Number(q.get('wait_ms'));
  const seen: Partial<RevocationHintState> = {
    ...(boot ? { boot } : {}),
    ...(genRaw !== null && /^\d{1,15}$/.test(genRaw) ? { gen: Number(genRaw) } : {}),
  };
  const wait = deps.revocationHint.waitForChange(seen, Number.isFinite(waitRaw) ? waitRaw : 0);
  // The replica went away (or the proxy cut it): stop holding a waiter for it.
  // `close` also fires after a normal end, and `cancel` after a settle is a no-op.
  (res as { on?: (ev: string, fn: () => void) => unknown }).on?.('close', wait.cancel);
  void wait.promise.then((state) => {
    const r = res as { writableEnded?: boolean; destroyed?: boolean };
    if (r.writableEnded || r.destroyed) return;
    sendJson(res, 200, { ok: true, boot: state.boot, gen: state.gen });
  });
}
