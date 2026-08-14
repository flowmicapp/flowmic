// SPEC-REF:
//   docs/strategy/2026-08-12-req1208-usage-log-storage-audit-and-design.md §5.5
//     (the two read APIs, and the three idioms they must copy verbatim)
//   src/db/repos/usage-events.repo.ts (the store this exposes)
//   src/http/ops-routes.ts (the `limit` REFUSE-not-CLAMP + keyset idioms)
//   src/http/console-routes.ts (the `/api/cloud/*` trust model this joins)
//   CLAUDE.md red line: no silent failure / one value answers only one question / anti-façade
//
// GET /api/cloud/usage/events — "my USAGE detail". Card A2-5 / REQ-12-08.
//
// ── WHY A FILE OF ITS OWN ───────────────────────────────────────────────────
// It belongs to the `/api/cloud/*` family (my own things, scoped by the Bearer)
// and would read naturally inside console-routes.ts — but that file stands at
// 784 of the 800-line cap (verify/lint/file-size.mjs), so this is the
// password-reset-routes.ts / account-restriction-routes.ts remedy applied
// again. Nothing about the trust model differs; `test/console-admin-gate-
// coverage.test.ts` scans this file exactly as it scans the other four, so a
// route added here is as visible to the gate census as one added there.
//
// ── 🔴 THE SCOPE IS THE BEARER, AND THERE IS NO PARAMETER TO FORGE ──────────
// This route takes NO `user_id`. Not "it validates one" — there is nowhere to
// put one. That is the `/api/cloud/*` trust model as ops-routes.ts's header
// states it from the other side: every route there reads ACROSS accounts and is
// admin-gated; every route here feeds the repo the id the Bearer PROVED, so a
// forged `?user_id=` is not refused, it does not exist. A query parameter that
// merely gets ignored would still be the wrong shape — the next person to add a
// filter would find it sitting there looking supported.
//
// ── WHAT THIS ROUTE CANNOT SAY, STATED SO NOBODY INFERS IT ─────────────────
// An empty page means "no record for this period" and NOT "you never used it". Two ways to get
// one that have nothing to do with usage:
//   · retention swept the window (90 days — db/retention.ts), and
//   · collection was OFF for that period (`FLOWMIC_USAGE_EVENTS_ENABLED`).
// The response therefore carries `retention_days` so a caller can draw the
// horizon instead of painting a blank as a zero (design §5.6). It does NOT
// carry the switch state: that is a deployment fact an end user is not owed,
// and it is already in the startup log for the operator who is.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UsageEventsRepo } from '../db/repos/usage-events.repo';
import { USAGE_EVENTS_PAGE_DEFAULT, USAGE_EVENTS_PAGE_MAX } from '../db/repos/usage-events.repo';
import { USAGE_EVENTS_RETENTION_DAYS } from '../db/retention';
import { EMAIL_NOT_VERIFIED, isEmailVerified, type EmailVerifiedReader } from '../auth/email-verification';
import { accountFromBearer, type AccountVerifier } from './account-auth';
import { sendJson } from './body';

export interface UsageEventsRoutesDeps {
  /** The SAME AuthService every other account surface verifies with — a second
   *  verifier is how one ingress starts admitting what another rejects. */
  auth: AccountVerifier;
  /**
   * The event log, sliced to the ONE read. `append` and `purgeOlderThan` are
   * deliberately out of reach: a read surface holding the method that WRITES a
   * usage row (or the one that deletes 90 days of them) is a loaded gun with no
   * reason to be in the room — the same slicing argument `OpsRoutesDeps.usage`
   * makes about `increment`.
   */
  events: Pick<UsageEventsRepo, 'listForUser'>;
  /** VERIFY-1 D3 — the verified-email gate's reader. This is a console FEATURE
   *  surface, so it is gated exactly like `/api/cloud/summary` next door. */
  verifiedEmail: EmailVerifiedReader;
}

// ⚠️ THE PATH BELOW IS WRITTEN OUT AS A LITERAL in the `if` condition, twice
// (`=== '/x'` and `startsWith('/x?')`), exactly like console-routes.ts and
// ops-routes.ts — deliberately. The route-coverage guard
// (test/console-admin-gate-coverage.test.ts) derives the routes THIS FILE SERVES
// by reading this source and pulling `'/api/…'` literals out of the conditions
// it matches on. A path assembled from a constant is INVISIBLE to it, i.e.
// silently exempt from the one check that catches "a newly added route that
// forgot to add the gate".

/** `{ok:true, …}` or the 400 message. Never substitutes a default for junk. */
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function query(url: string): URLSearchParams {
  // Throwaway base — only the query is ever read, never the origin.
  return new URL(url, 'http://console.invalid').searchParams;
}

/**
 * `?from=` / `?to=` — ms since epoch, BOTH REQUIRED.
 *
 * 🔴 Required for `parseMonth`'s reason, which transfers exactly: a missing
 * `limit` changes HOW MANY ROWS you get, a missing time window changes WHICH
 * DATA YOU ARE LOOKING AT. A page whose window silently defaulted to 「last 30
 * days」 would render under a header the caller chose, confidently, with no
 * tell. Requiring both means every caller states, every time, what it is
 * showing.
 *
 * Half-open [from, to): two adjacent windows stitch without double-counting the
 * boundary millisecond, and `to === from` is legal and honestly empty.
 */
function parseMs(url: string, name: 'from' | 'to'): Parsed<number> {
  const raw = query(url).get(name);
  if (raw === null) return { ok: false, message: `${name} is required (ms since epoch)` };
  const n = Number(raw);
  // `Number.isSafeInteger` and not `isInteger`: past 2^53 a ms epoch stops
  // round-tripping through JSON, and a bound that changes value between the
  // request and the SQL is worse than a refused one. Negative is refused too —
  // there is no usage before 1970 and a `-1` sentinel must not be inventable.
  if (!Number.isSafeInteger(n) || n < 0) {
    return { ok: false, message: `${name} must be a non-negative integer (ms since epoch)` };
  }
  return { ok: true, value: n };
}

/**
 * `?limit=` — an integer in 1..{@link USAGE_EVENTS_PAGE_MAX}, or 400.
 *
 * 🔴 REFUSED, never CLAMPED. The repo clamps as defence in depth for any other
 * caller, but a clamp at an HTTP boundary silently answers a different question:
 * a caller that asked for 10 000 and got 500 rows has no way to know it did not
 * receive all of them. Same refusal, same wording shape as ops-routes.ts.
 */
function parseLimit(url: string): Parsed<number> {
  const raw = query(url).get('limit');
  if (raw === null) return { ok: true, value: USAGE_EVENTS_PAGE_DEFAULT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > USAGE_EVENTS_PAGE_MAX) {
    return { ok: false, message: `limit must be an integer in 1..${USAGE_EVENTS_PAGE_MAX}` };
  }
  return { ok: true, value: n };
}

/** `?after_id=` — absent (page 1) or a positive integer cursor. `0` and `''`
 *  are refused because neither can mean anything: 「from the start」 is ABSENCE,
 *  and SQLite would happily compare `id > 0` and look like it worked. */
function parseCursor(url: string): Parsed<number | null> {
  const raw = query(url).get('after_id');
  if (raw === null) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { ok: false, message: 'after_id must be a positive integer (omit it for the first page)' };
  }
  return { ok: true, value: n };
}

function refuseBadRequest(res: ServerResponse, message: string): void {
  // `SETTINGS_SCHEMA_INVALID` is an EXISTING protocol code — console-routes.ts
  // and ops-routes.ts already answer parameter junk with it. Zero protocol
  // change this card: the error-code table does not move.
  sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message });
}

/** Handle the saas per-event usage read. Returns true iff it owned the request. */
export function tryHandleUsageEventsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UsageEventsRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // ── GET /api/cloud/usage/events?from=&to=&limit=&after_id= ────────────────
  if (method === 'GET' && (url === '/api/cloud/usage/events' || url.startsWith('/api/cloud/usage/events?'))) {
    // ① WHO. The proven subject is the ONLY scope this route has.
    const who = accountFromBearer(req, deps.auth);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    // ② VERIFY-1 D3 — a console feature, gated like its neighbours. 403 and not
    // 401: identity was proven; what is missing is a verified mailbox, and the
    // UI's move on this name is "paint the verification card".
    if (!isEmailVerified(deps.verifiedEmail.emailVerifiedAt(who.userId))) {
      sendJson(res, 403, { error: EMAIL_NOT_VERIFIED });
      return true;
    }
    // ⚠️ A2-3's `ACCOUNT_RESTRICTED` gate is deliberately NOT applied here, and
    // the omission is a decision rather than an oversight: owner exempted
    // GET /api/account/export and POST /api/account/delete from restriction
    // ("a user can clear their own data and delete their account regardless"),
    // and reading one's OWN usage record is
    // the same family — a restricted user must still be able to see what was
    // collected about them. 🔴 If the lead reads it the other way, the change is
    // one call to `refuseRestricted`'s equivalent, placed BEFORE the block
    // above (console-routes.ts argues that ordering: "go collect the
    // verification code" is an errand
    // the user can run, "you are restricted" is not).
    const from = parseMs(url, 'from');
    if (!from.ok) {
      refuseBadRequest(res, from.message);
      return true;
    }
    const to = parseMs(url, 'to');
    if (!to.ok) {
      refuseBadRequest(res, to.message);
      return true;
    }
    if (to.value < from.value) {
      // Refused rather than swapped. Swapping would answer a question the caller
      // did not ask and hide the bug that produced the inversion.
      refuseBadRequest(res, 'to must be greater than or equal to from');
      return true;
    }
    const limit = parseLimit(url);
    if (!limit.ok) {
      refuseBadRequest(res, limit.message);
      return true;
    }
    const cursor = parseCursor(url);
    if (!cursor.ok) {
      refuseBadRequest(res, cursor.message);
      return true;
    }

    const page = deps.events.listForUser(who.userId, {
      from: from.value,
      to: to.value,
      limit: limit.value,
      ...(cursor.value === null ? {} : { after_id: cursor.value }),
    });
    // 🔴 `next_after_id === null` is the ONLY truthful "no next page", and the repo
    // computes it from a limit+1 probe row rather than `rows.length < limit` —
    // which is wrong exactly when the last page is exactly full, and wrong in
    // the direction that hands out a cursor forever. A client that re-derives
    // it by counting rows re-introduces the bug on its own side.
    //
    // The window is echoed so a caller can check the page is about the window it
    // asked for. `retention_days` is the horizon, so an empty tail is readable
    // as "expired" rather than as "never used" — the design's §5.6 requirement that
    // the surface SAY the limit out loud.
    //
    // The rows are returned verbatim from the repo. There is no projection step
    // and there deliberately is nothing to project: the table has no column that
    // could hold content (db/schema.ts's whitelist argument), so unlike the ops
    // surfaces there is no `password_hash`-shaped mine to defuse by remembering.
    sendJson(res, 200, {
      from: from.value,
      to: to.value,
      rows: page.rows,
      next_after_id: page.next_after_id,
      retention_days: USAGE_EVENTS_RETENTION_DAYS,
    });
    return true;
  }

  // Anything else is NOT claimed here — it falls through to the router's 404.
  // Deliberately no 405 for a known path with the wrong method: the rest of this
  // repo's http surface answers 404 for an unmatched (method, path) pair.
  return false;
}
