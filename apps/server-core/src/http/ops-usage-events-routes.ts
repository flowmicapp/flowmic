// SPEC-REF:
//   docs/strategy/2026-08-12-req1208-usage-log-storage-audit-and-design.md §5.5
//     (the TWO read APIs — this is the ops-side twin), §2.2 ("what operations cannot
//     answer today: this one account's usage-over-time curve")
//   src/http/usage-events-routes.ts (the ACCOUNT-side twin — read it beside this)
//   src/http/ops-user-routes.ts (the admin-gated read family this joins)
//   src/http/ops-audit-trail.ts `adminGate` + `ADMIN_GATED_ROUTES`
//   CLAUDE.md red line: no silent failure / one value answers one question only / anti-façade
//   *** HUMAN-AUDIT SENSITIVE (auth: a cross-account read) ***
//
// GET /api/ops/usage/events?user_id=&from=&to= — "this one account's usage detail", for
// operators. Card A2-5 / REQ-12-08, the half that was still missing.
//
// ── 🔴 WHY THIS FILE EXISTS AT ALL, STATED PRECISELY ────────────────────────
// The close-handoff carried this as "the `GET /api/ops/usage/events` literal is
// missing from ADMIN_GATED_ROUTES", i.e. as a one-line fix. It was not one: the
// literal was missing because THE ROUTE WAS MISSING, and adding the literal
// alone would have turned `test/console-admin-gate-coverage.test.ts` red on its
// own terms — that suite forces ADMIN_GATED_ROUTES and a source-derived route
// scan to agree exactly, so a fence entry for a route nobody serves dies there
// ("REGISTRY declares routes no route source serves any more"). The two lists
// are maintained by different means precisely so that "just add a literal and you're done" cannot be
// true. Recorded here because the next person reading the handoff will believe
// the same sentence.
//
// ── 🔴 THE TRUST MODEL IS THE OPPOSITE OF ITS TWIN'S ────────────────────────
// `usage-events-routes.ts` serves `/api/cloud/usage/events` and takes NO
// `user_id` — the scope is the Bearer and a forged target is unrepresentable.
// This route takes `?user_id=` and reads SOMEBODY ELSE'S rows. Those are
// opposite postures, which is why they are two files and not one handler with a
// branch: a single module would leave a reviewer asking "does this route look
// like the one above" instead of "should this route cross accounts at all" (ops-routes.ts's own argument).
//
// ── PATH SHAPE: `?user_id=` AND NOT `/:id` ─────────────────────────────────
// The design (§5.5) already made this call and ops-user-routes.ts already paid
// for it: `ADMIN_GATED_ROUTES` is a list of LITERALS whose job is to make "put
// a caller-supplied byte into the audit table" fail to COMPILE. `:id` is not a
// literal. Widening the fence's type for one route would delete that guarantee
// for every route in the family — including the ones sitting beside
// POST /api/password/reset, whose body is a plaintext password. So the route
// takes a query parameter; the account id reaches the handler and never reaches
// the trail.
//
// ── AUDIT POSTURE ──────────────────────────────────────────────────────────
// A GET, so it relies on `recordGateOutcome`'s serve-but-shout policy — the case
// that policy was argued for. It must NOT grow a write later without re-arguing
// it (see MUTATING_ADMIN_GATED_ROUTES).
//
// ── WHAT THIS ROUTE CANNOT SAY ─────────────────────────────────────────────
// Identical to its twin, and it matters more here because an operator draws
// conclusions about a person from it: an empty page means "no records for this period" and
// NOT "this account has never been used". Two causes have nothing to do with usage — retention
// swept the window, and collection may have been OFF for that period
// (`FLOWMIC_USAGE_EVENTS_ENABLED` defaults off). `retention_days` rides on the
// response so the horizon is drawable; the switch state deliberately does not,
// because it is in the startup log for exactly the operator who can read this.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UsageEventsRepo } from '../db/repos/usage-events.repo';
import { USAGE_EVENTS_PAGE_DEFAULT, USAGE_EVENTS_PAGE_MAX } from '../db/repos/usage-events.repo';
import { USAGE_EVENTS_RETENTION_DAYS } from '../db/retention';
import type { AccountVerifier } from './account-auth';
import { adminGate, type AdminGatedRoute, type OpsAuditSink } from './ops-audit-trail';
import { sendJson } from './body';

/** The one route literal this module serves, written out here AND inline in the
 *  `if` condition below — the coverage guard derives what this file serves by
 *  reading the source for `'/api/…'` literals inside conditions, so a path
 *  assembled from a constant would be invisible to the one check that catches
 *  "a newly added ops route forgot to add the gate". */
export const OPS_USAGE_EVENTS_ROUTE: AdminGatedRoute = 'GET /api/ops/usage/events';

export interface OpsUsageEventsRoutesDeps {
  /** The account verifier for the admin gate — the SAME `AuthService` instance
   *  every other http surface uses. A second verifier is how one ingress starts
   *  admitting what another rejects. */
  auth: AccountVerifier;
  /**
   * The event log, sliced to the ONE read — the same narrowing the account-side
   * twin applies, and for the same reason: a read surface holding `append` (the
   * meter's job) or `purgeOlderThan` (the sweep's, 90 days at a stroke) is a
   * loaded gun with no reason to be in the room.
   */
  events: Pick<UsageEventsRepo, 'listForUser'>;
  /** Where the gate's rows go. REQUIRED — no `?`, no default (book 13 §7 F1 ②):
   *  an optional sink would mean a bootstrap missing one line serves a fully
   *  working, completely untraceable cross-account read, with nothing red and no
   *  new symbol to grep. */
  audit: OpsAuditSink;
}

/** `{ok:true, …}` or the 400 message — this family's parse verdict. Never
 *  substitutes a default for junk. */
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function query(url: string): URLSearchParams {
  // Throwaway base — only the query is ever read, never the origin.
  return new URL(url, 'http://ops.invalid').searchParams;
}

/** `?user_id=` — REQUIRED. There is no "default to somebody" on a route whose
 *  whole question is "this one account", and a default would be the worst possible
 *  one: it would answer about an account the operator did not name. */
function parseUserId(url: string): Parsed<string> {
  const raw = query(url).get('user_id');
  if (raw === null || raw.trim() === '') return { ok: false, message: 'user_id is required' };
  return { ok: true, value: raw.trim() };
}

/**
 * `?from=` / `?to=` — ms since epoch, BOTH REQUIRED, half-open [from, to).
 *
 * 🔴 Copied from the account-side twin deliberately, including the requirement:
 * a missing `limit` changes HOW MANY ROWS you get, a missing time window changes
 * WHICH DATA YOU ARE LOOKING AT. On an operator surface that is the difference
 * between "he spiked hard last week" and a default window nobody chose.
 */
function parseMs(url: string, name: 'from' | 'to'): Parsed<number> {
  const raw = query(url).get(name);
  if (raw === null) return { ok: false, message: `${name} is required (ms since epoch)` };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    return { ok: false, message: `${name} must be a non-negative integer (ms since epoch)` };
  }
  return { ok: true, value: n };
}

/** `?limit=` — an integer in 1..{@link USAGE_EVENTS_PAGE_MAX}, or 400. REFUSED,
 *  never CLAMPED: a caller that asked for 10 000 and got 500 rows has no way to
 *  know it did not receive all of them. Same rule, same wording shape, as every
 *  other route in this family. */
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
 *  are refused: "from the start" is ABSENCE, and SQLite would compare `id > 0`
 *  and look like it worked. */
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
  // `SETTINGS_SCHEMA_INVALID` is an EXISTING protocol code and is already this
  // family's answer to parameter junk. Zero protocol change this card.
  // Deliberately NOT echoing the offending value — an error body is the last
  // place to start reflecting caller input.
  sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message });
}

/** Handle the saas ops usage-events read. Returns true iff it owned the
 *  request. */
export function tryHandleOpsUsageEventsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsUsageEventsRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // ── GET /api/ops/usage/events?user_id=&from=&to=&limit=&after_id= ─────────
  if (method === 'GET' && (url === '/api/ops/usage/events' || url.startsWith('/api/ops/usage/events?'))) {
    // The gate FIRST, before a single parameter is parsed: no branch of a
    // cross-account read may be reachable by someone who has proved nothing, and
    // a 400 about `user_id` would already tell an anonymous caller that this
    // route exists and what it takes.
    //
    // ⚠️ NO verified-email gate, and that is this family's existing posture
    // rather than an omission — none of the `/api/ops/` routes carries one
    // (only the `/api/cloud/` surface does). Adding one here alone would make
    // the ops surface answer two different refusals to the same operator on the
    // same afternoon.
    const verdict = adminGate(req, deps.auth, deps.audit, OPS_USAGE_EVENTS_ROUTE);
    if (!verdict.ok) {
      // 🔴 NAMED, carrying its own status: 401 "you haven't proven who you are" and 403 "I know who
      // you are, but this isn't for you to see" are two sentences. Never an empty 200 — an
      // empty event list would read as "this account has never been used" to someone being turned
      // away, which is both a lie and an oracle.
      sendJson(res, verdict.status, { error: verdict.error });
      return true;
    }
    const target = parseUserId(url);
    if (!target.ok) {
      refuseBadRequest(res, target.message);
      return true;
    }
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
      // Refused rather than swapped: swapping answers a question the caller did
      // not ask and hides the bug that produced the inversion.
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

    // 🔴 AN UNKNOWN `user_id` IS AN HONEST EMPTY PAGE, NOT A 404, and that is the
    // opposite of what `POST /api/ops/users/restrict` does one file over. The
    // difference is what the answer would be USED for: there, a cheerful 200 for
    // a typo'd id tells an operator they restricted somebody when they restricted
    // nobody — a false report of an action. Here nothing is acted on, and this
    // route genuinely cannot tell "this account doesn't exist" from "this account has no records for this period"
    // without asking a repo it deliberately does not hold (`UserRepo` is NOT a
    // dep — see this file's deps). Inventing a 404 from an empty page would be a
    // guess; `GET /api/ops/users/detail` is the route that answers "whether this
    // account exists", and it answers it properly.
    const page = deps.events.listForUser(target.value, {
      from: from.value,
      to: to.value,
      limit: limit.value,
      ...(cursor.value === null ? {} : { after_id: cursor.value }),
    });
    // The rows are returned verbatim from the repo, exactly as on the account
    // side. There is no projection step and deliberately nothing to project: the
    // table has no column that could hold content (db/schema.ts's whitelist
    // argument), so unlike `/api/ops/users` there is no `password_hash`-shaped
    // mine here to defuse by remembering. `user_id` is echoed so a paged UI can
    // prove each page is about the account it thinks it is.
    sendJson(res, 200, {
      user_id: target.value,
      from: from.value,
      to: to.value,
      rows: page.rows,
      next_after_id: page.next_after_id,
      retention_days: USAGE_EVENTS_RETENTION_DAYS,
    });
    return true;
  }

  // Anything else falls through to the router's 404 — the same "no 405 for a
  // known path" posture ops-routes.ts states: a 405 would tell an anonymous
  // caller which ops paths exist before the gate can refuse them.
  return false;
}
