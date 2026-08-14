// SPEC-REF:
//   docs/strategy/2026-08-11-design-e-multidevice-salt.md §3.1 (HTTP surface:
//     GET/PUT /api/timeline/keymeta, Bearer account JWT, saas-only mount,
//     first-writer-wins PUT), §2 (why serving the sentinel discloses nothing new)
//   CLAUDE.md human-audit four sensitive paths: the cryptography surface
//     (key-metadata storage) — line-by-line review by the first-responsible party
//   *** HUMAN-AUDIT SENSITIVE (crypto-adjacent: key metadata) ***
//
// GET /api/timeline/keymeta — 「this account's blind-store salt + sentinel」.
// PUT /api/timeline/keymeta — first enrolment writes them; replays are
// idempotent; a DIFFERING write is refused by name (409), because overwriting
// an account's salt orphans every ciphertext the old key sealed.
//
// WHY HTTP AND NOT A SOCKET EVENT (design §3.1): this is account-level STATIC
// metadata, not an in-session event — zero new event names, the 54-event owner
// gate does not move.
//
// WHY SAAS-ONLY: standalone has no account layer and no blind store to unlock
// (the cloud blind store IS the saas relay's table); the router mounts this the
// way it mounts the image inject route in reverse — there the door exists only
// in standalone, here only in saas, and in the other mode the path answers the
// router's plain 404 (「this deployment does not have this surface」).
//
// AUTH: `accountFromBearer` — the SAME one-definition seam /api/me, the console
// family and the billing gateway verify with (http/account-auth.ts's whole
// argument). No hand-rolled JWT parsing here; a named 401 when identity cannot
// be established, exactly the console-routes response shape.
//
// The refusal names below are HTTP-LOCAL strings, deliberately not protocol
// `ErrorCode`s — the same choice DIAG_* and PRESENCE_AUTH_REQUIRED made:
// protocol codes are the cross-boundary vocabulary carrying bilingual
// user-facing copy behind an owner-gated count, and these strings never cross
// a socket nor get rendered verbatim to a user (the phone's provisioner acts
// on the status code and renders its own copy — SALT-2). The ERROR_CODES table
// does not move for this card; test/timeline-keymeta.test.ts pins that.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { accountFromBearer, type AccountVerifier } from './account-auth';
import { readJsonBody, sendJson, str } from './console-http';
import { keymetaInvalidReason, type TimelineKeymetaRepo } from '../db/repos/timeline-keymeta.repo';

/** The one path both verbs share. Exported for the tests (same argument as
 *  PC_PRESENCE_PATH: a hand-copied literal in a test could drift into passing
 *  against a route nobody serves). */
export const TIMELINE_KEYMETA_PATH = '/api/timeline/keymeta';

/** GET with no row. NOT an error condition for the caller — "you haven't
 *  enrolled yet" (你还没登记) is the
 *  answer that sends a first device into enrolment (design §3.2 step 3). */
export const KEYMETA_NOT_FOUND = 'KEYMETA_NOT_FOUND';
/** PUT that would overwrite a differing row. See the 409 branch for the why. */
export const KEYMETA_CONFLICT = 'KEYMETA_CONFLICT';
/** PUT whose body fails validation (bad/wrong-length salt, unprefixed sentinel). */
export const KEYMETA_INVALID = 'KEYMETA_INVALID';

export interface TimelineKeymetaRoutesDeps {
  /** The SAME AuthService instance every other Bearer surface verifies with —
   *  a second verifier would be a second answer to 「is this token good」. */
  auth: AccountVerifier;
  repo: TimelineKeymetaRepo;
}

/** Handle the two keymeta routes. Returns true iff it owned the request.
 *  Any other method on the path falls through to the router's 404, the same
 *  shape every route family here uses for an unknown (path, method) pair. */
export function tryHandleTimelineKeymetaRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TimelineKeymetaRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // ── GET /api/timeline/keymeta ─────────────────────────────────────────────
  if (url === TIMELINE_KEYMETA_PATH && method === 'GET') {
    const who = accountFromBearer(req, deps.auth);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    const row = deps.repo.get(who.userId);
    if (!row) {
      sendJson(res, 404, { ok: false, error: KEYMETA_NOT_FOUND });
      return true;
    }
    // The stored bytes verbatim, plus schema_ver so a future format bump is
    // readable. created_at deliberately stays server-side: no caller needs it,
    // and an unread field on the wire is a field somebody will start guessing
    // meanings for.
    sendJson(res, 200, { salt_b64: row.salt_b64, sentinel: row.sentinel, schema_ver: row.schema_ver });
    return true;
  }

  // ── PUT /api/timeline/keymeta ─────────────────────────────────────────────
  if (url === TIMELINE_KEYMETA_PATH && method === 'PUT') {
    const who = accountFromBearer(req, deps.auth);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    void (async (): Promise<void> => {
      // Shared bounded reader (console-http.ts BODY_CAP): an over-cap body is
      // truncated, fails to parse, arrives here as {} and dies on the named
      // 400 below — never a hung request, never an unbounded buffer.
      const body = await readJsonBody(req);
      const salt_b64 = str(body.salt_b64);
      const sentinel = str(body.sentinel);
      const reason = keymetaInvalidReason(salt_b64, sentinel);
      if (reason !== null) {
        // Named 400 BEFORE the repo is touched: invalid input must never
        // reach storage, and the row-absence assertion in the tests holds the
        // route to that.
        sendJson(res, 400, { ok: false, error: KEYMETA_INVALID, message: reason });
        return;
      }
      const outcome = deps.repo.putFirstWriter(who.userId, salt_b64, sentinel);
      if (outcome === 'created') {
        sendJson(res, 201, { ok: true, outcome });
        return;
      }
      if (outcome === 'identical') {
        // Idempotent replay — the retry/two-devices-same-bytes case. 200, not
        // 201: nothing was created, and the caller may treat both as 「confirmed」.
        sendJson(res, 200, { ok: true, outcome });
        return;
      }
      // 🔴 conflict → 409, BY NAME, and the row is untouched. Overwriting this
      // account's salt would orphan every ciphertext sealed under the old key
      // on the device that wrote it first. The losing device discards its
      // freshly minted material and re-enters via the stored row (design §3.2
      // step 3a); changing a registered salt is a later, explicit migration
      // card — it re-seals every blob, which a PUT cannot honestly claim to do.
      sendJson(res, 409, {
        ok: false,
        error: KEYMETA_CONFLICT,
        message: 'key metadata already registered for this account with different content; '
          + 'overwriting the salt would orphan the first writer\'s ciphertexts — '
          + 'adopt the stored material instead (GET), or run an explicit migration',
      });
    })();
    return true;
  }

  return false;
}
