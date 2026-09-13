// SPEC-REF:
//   apps/server-core/src/http/node-routes.ts   (the ONE caller — extracted here
//     for the same reason node-routes-forward-sync.ts was: that file hit the
//     800-line cap, verify/lint/file-size.mjs, this time from CORS-1's grant
//     wiring for /api/node/list and /api/node/locate. This is a STRUCTURAL
//     move only — every line of comment and logic below is unchanged from
//     node-routes.ts's prior `/api/node/resolve-token` block, not a second
//     entry point.)
//   apps/server-core/src/node/token-rows.ts  (`TokenResolution` — the shape
//     `resolveToken` answers with)
//
// ── POST /api/node/resolve-token ────────────────────────────────────────
//
// 「I have a token my copy of the database has never seen. Do you know it?」
// The reads a replica may not answer for itself are now two, and they are
// two for the SAME reason stated in writer-client.ts: a read whose purpose is
// to detect someone else's RECENT write must not be served from a replica.
// `/quota` asks 「did somebody just spend these minutes」; this asks 「did
// somebody just create this pairing」. A stale answer to either is a
// confident, wrong 「no」.
//
// 🔴 THE MISS IS A 404 AND THE OUTAGE IS A 5xx/throw, and the caller acts
// oppositely on them — this is `/mint-code`'s 404 argument applied to a
// credential. 「I do not know this token」 is the writer being authoritative,
// and the replica turns it into today's honest AUTH_TOKEN_INVALID. 「I could
// not ask」 is nothing being known, and it degrades to the SAME refusal — but
// it must never take the 404's shape, because a body that says 「unknown」
// when the truth is 「unreachable」 would be a permanent negative cached from
// a transient failure the moment anyone adds caching here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidTokenShape } from '../auth/token';
import type { TokenResolution } from '../node/token-rows';

/** The three module-private helpers this route needs from node-routes.ts,
 *  passed in rather than exported and re-imported — same reasoning as
 *  `ForwardSyncRouteHelpers` in node-routes-forward-sync.ts. */
export interface ResolveTokenRouteHelpers {
  readJsonBody: (req: IncomingMessage) => Promise<{ token?: unknown }>;
  secretMatches: (expected: string, offered: string) => boolean;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}

/** Only the three fields this route reads off `NodeRoutesDeps` — a structural
 *  subset rather than importing that type, for the same import-cycle reason
 *  `ForwardSyncRouteDeps` states. */
export interface ResolveTokenRouteDeps {
  nodeId: string;
  resolveToken?: (token: string) => TokenResolution | null;
  sharedSecret?: string;
}

export function handleResolveTokenRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ResolveTokenRouteDeps,
  helpers: ResolveTokenRouteHelpers,
): void {
  const { readJsonBody, secretMatches, sendJson } = helpers;
  if (!deps.resolveToken || !deps.sharedSecret) {
    sendJson(res, 501, { ok: false, error: 'resolve_token_not_configured' });
    return;
  }
  const offered = req.headers['x-flowmic-node-secret'];
  if (!secretMatches(deps.sharedSecret, typeof offered === 'string' ? offered : '')) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  void (async (): Promise<void> => {
    try {
      const body = await readJsonBody(req);
      // Shape-checked HERE as well as on the replica, and the duplication is
      // deliberate: this route is reachable by anything holding the secret,
      // so 「the caller already checked」 is an assumption about someone
      // else's code. A malformed token never reaches a prepared statement.
      if (!isValidTokenShape(body.token)) {
        sendJson(res, 400, { ok: false, error: 'token_malformed' });
        return;
      }
      const resolved = deps.resolveToken!(body.token);
      if (!resolved) {
        sendJson(res, 404, { ok: false, error: 'token_unknown', node: deps.nodeId });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        node: deps.nodeId,
        kind: resolved.kind,
        // The owning account row(s), because `pc_devices.user_id` and
        // `mobile_pairings.user_id` both REFERENCE `users(id)` and `users`
        // is replicated by the same 30-second pull. Without them the
        // onboarding case — sign up, pair, hop, all inside that window —
        // cannot land and is refused on a credential that is perfectly good.
        users: resolved.users,
        pc: resolved.pc,
        ...(resolved.kind === 'mobile' ? { mobile: resolved.mobile } : {}),
      });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: 'resolve_token_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}
