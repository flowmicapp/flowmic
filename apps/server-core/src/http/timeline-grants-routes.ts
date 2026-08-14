// SPEC-REF:
//   docs/strategy/2026-08-11-design-e-grant-web-preview.md §3.4 (REST list +
//     revoke, volume-09 verbatim; revocation = the server refuses the next pull,
//     the web zeroizes on TIMELINE_GRANT_REQUIRED — no push event, no new
//     event name)
//   docs/rebuild/09-WEB-SPEC.md §4 (GET/DELETE /api/timeline/grants, Bearer,
//     IDOR scoped by jwt.sub)
//   http/timeline-keymeta-routes.ts — the SALT-1 route-file pattern this
//     follows (accountFromBearer seam, sendJson, saas-only double-gated mount
//     in router.ts, HTTP-local refusal names)
//   CLAUDE.md four human-reviewed sensitive-path classes: pairing/auth
//     (authorization mgmt) — line-by-line human review
//   *** HUMAN-AUDIT SENSITIVE (auth: web-preview authorization) ***
//
// GET    /api/timeline/grants      — "who did I authorize, until when".
// DELETE /api/timeline/grants/:gid — revoke ONE of the caller's own grants.
//
// SCOPE IS THE PROVEN SUBJECT, ALWAYS: every repo call carries the Bearer's
// verified user id, and the DELETE's IDOR boundary is in the repo's SQL
// (WHERE gid AND user_id), not in a route-level filter someone can forget.
// A foreign gid and a nonexistent gid are ONE indistinguishable 404 — the
// caller must not be able to learn that someone else's gid exists.
//
// The refusal names below are HTTP-LOCAL strings on the KEYMETA_*/DIAG_*
// precedent — they never cross a socket and never render verbatim to a user,
// so the owner-gated protocol code table does not move for them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { accountFromBearer, type AccountVerifier } from './account-auth';
import { EMAIL_NOT_VERIFIED, isEmailVerified, type EmailVerifiedReader } from '../auth/email-verification';
import { sendJson } from './console-http';
import type { TimelineGrantsRepo } from '../db/repos/timeline-grants.repo';

/** The collection path (GET); DELETE addresses `${path}/<gid>`. Exported for
 *  the tests — same argument as TIMELINE_KEYMETA_PATH: a hand-copied literal
 *  in a test could drift into passing against a route nobody serves. */
export const TIMELINE_GRANTS_PATH = '/api/timeline/grants';

/** DELETE for a gid that is not one of the CALLER's grants — unknown and
 *  foreign collapse into this one name (no cross-account existence oracle). */
export const GRANT_NOT_FOUND = 'GRANT_NOT_FOUND';

export interface TimelineGrantsRoutesDeps {
  /** The SAME AuthService instance every other Bearer surface verifies with. */
  auth: AccountVerifier;
  repo: Pick<TimelineGrantsRepo, 'listFor' | 'revoke'>;
  /** VERIFY-1 D3 — the verified-email gate's reader. REQUIRED (volume-13 §7 F1 ②:
   *  an optional reader would serve grant management to unverified accounts
   *  with nothing red to notice). This surface is named in the decision doc's
   *  gated census — it is a web-console feature, not a device surface. */
  verifiedEmail: EmailVerifiedReader;
}

/** VERIFY-1 D3 — the same refusal shape console-routes.ts's `refuseUnverified`
 *  writes (403 + EMAIL_NOT_VERIFIED, after the identity verdict so the gate is
 *  never probeable anonymously). Grandfathered accounts pass by construction
 *  (migration stamp — db/schema.ts). */
function refuseUnverified(res: ServerResponse, deps: TimelineGrantsRoutesDeps, userId: string): boolean {
  if (isEmailVerified(deps.verifiedEmail.emailVerifiedAt(userId))) return false;
  sendJson(res, 403, { error: EMAIL_NOT_VERIFIED });
  return true;
}

/** Handle the two grant-management routes. Returns true iff it owned the
 *  request; any other (path, method) pair falls to the router's 404. */
export function tryHandleTimelineGrantsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TimelineGrantsRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // ── GET /api/timeline/grants ──────────────────────────────────────────────
  if (url === TIMELINE_GRANTS_PATH && method === 'GET') {
    const who = accountFromBearer(req, deps.auth);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseUnverified(res, deps, who.userId)) return true; // VERIFY-1 D3
    // The row projection is already public-shaped (gid/origin/expires_at/
    // created_at/revoked — the repo type carries nothing else; above all it
    // CANNOT carry a wrap, which was never stored). Revoked/expired rows are
    // included on purpose: this list is the account's authorization HISTORY,
    // and 「what did I authorize last week」 is a question the owner is
    // entitled to ask; liveness is the reader's derivation from expires_at/
    // revoked, not a second server verdict to drift from the pull gate's.
    sendJson(res, 200, { grants: deps.repo.listFor(who.userId) });
    return true;
  }

  // ── DELETE /api/timeline/grants/:gid ──────────────────────────────────────
  if (url.startsWith(`${TIMELINE_GRANTS_PATH}/`) && method === 'DELETE') {
    const who = accountFromBearer(req, deps.auth);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseUnverified(res, deps, who.userId)) return true; // VERIFY-1 D3
    const rawGid = url.slice(TIMELINE_GRANTS_PATH.length + 1);
    let gid: string;
    try {
      gid = decodeURIComponent(rawGid);
    } catch {
      gid = rawGid; // malformed escape → treated as the literal it is; it will
      // simply match no row of the caller's (the same 404 as any unknown gid)
    }
    if (gid === '' || gid.includes('/')) {
      // No sub-resources exist under a gid; a nested path is not a gid.
      sendJson(res, 404, { ok: false, error: GRANT_NOT_FOUND });
      return true;
    }
    // The repo revokes ONLY a live row owned by this user (WHERE user_id AND
    // revoked=0). `false` therefore folds three cases; the two the caller may
    // distinguish are separated below through their OWN list — which they can
    // read anyway, so this is a convenience, not an oracle.
    if (deps.repo.revoke(gid, who.userId)) {
      // Effective immediately: the next web pull asks liveGrantFor, finds
      // nothing, answers TIMELINE_GRANT_REQUIRED, and the web zeroizes
      // (design §3.4 — fail-closed needs no push).
      sendJson(res, 200, { ok: true, gid, revoked: true });
      return true;
    }
    const own = deps.repo.listFor(who.userId).find((g) => g.gid === gid);
    if (own !== undefined) {
      // The caller's own, already-revoked (or expired-and-revoked) row: the
      // desired end state already holds, so a repeat DELETE is idempotent —
      // 200, not 404 (the keymeta 'identical' replay shape).
      sendJson(res, 200, { ok: true, gid, revoked: true, already_revoked: true });
      return true;
    }
    sendJson(res, 404, { ok: false, error: GRANT_NOT_FOUND });
    return true;
  }

  return false;
}
