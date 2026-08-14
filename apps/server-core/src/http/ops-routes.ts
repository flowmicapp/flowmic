// SPEC-REF:
//   docs/strategy/2026-08-02-o2-usage-route-contract.md (THE contract — change discipline:
//     change that document first, then change this file and its tests)
//   src/db/repos/usage.repo.ts (the three aggregate methods this exposes)
//   src/http/ops-audit-trail.ts `adminGate` (O-1 gate + leaves a trace)
//   docs/decisions/2026-08-02-owner-stt-pool-groups-and-ops-phase1-scope.md
//     (owner: ops side stays read-only + reconciliation, changing tiers is "not doing that for now")
//   CLAUDE.md red line: no silent failure / one value answers only one question / anti-façade
//
// /api/ops/* — THE CROSS-ACCOUNT OPERATIONS SURFACE. 0.2.48.
//
// O-2's platform rollup shipped in 0.2.47 with 17 green tests and ZERO HTTP
// exposure — [NOT WIRED UP], this repo's #1 shape. This file is the exposure.
//
// ── WHY A NEW PREFIX INSTEAD OF MORE /api/cloud/ ────────────────────────────
// `/api/cloud/*` answers "my own stuff" (my usage, my devices, my billing events)
// and every route there feeds the repo the id the Bearer PROVED, so a forged
// `?user_id=` is not refused — it does not exist. Everything here reads ACROSS
// accounts by design. Those are opposite trust models, and mixing them in one
// file is how a route ends up in the wrong half: the reviewer's question changes
// from "should this route cross accounts" to "does this route look like the one above it". Separate prefix,
// separate file, one gate on every route in it.
//
// ── MODE ────────────────────────────────────────────────────────────────────
// saas only. bootstrap builds `ops: {…}` exactly like `console: {…}`, so in
// standalone these paths fall to the router's 404. That 404 means "this deployment has no
// ops surface" — NOT "you have no permission". standalone has no account layer at all (one local
// owner, no JWT, `is_admin` never set), so an admin gate there would be guarding
// a door in a field.
//
// ── 🔴 TWO M2 MINES, DEFUSED STRUCTURALLY RATHER THAN CAREFULLY ─────────────
//
// M2-7 — `UserRepo.listAll()` returns rows containing `password_hash`, so any ops
//   list route that forgets to project leaks every account's hash. This file
//   NEVER IMPORTS `UserRepo` and has no path to a `UserRecord`. The mine is not
//   avoided by remembering to project; there is nothing here to project FROM.
//   ⇒ When L4's user-list route arrives it must do the projection itself, in its
//     own file. Do NOT "casually" join account names onto the rows below.
//
// M2-8 — a read-only reconciliation view that loops `getPlan()` WRITES TO THE
//   DATABASE: `getPlan → resolve → mirrorPlanColumn → users.setPlan()` rewrites
//   `users.plan` to the computed effective tier, i.e. the view erases the very
//   drift it was opened to show. This file NEVER IMPORTS `BillingService`. Same
//   technique: unreachable, not merely unused.
//   ⚠️ Worth knowing WHY that erasure is so easy to miss: other code paths already
//     perform that mirror (db/retention.ts sweeps via `effectiveLimits`, the
//     Paddle webhook via `effectivePlan`), so a drifted column gets straightened
//     out eventually anyway — which is exactly what makes a reconciliation page
//     that ALSO straightens it look like it is working.
//   `test/ops-usage-route.test.ts` pins both with reverse controls: a stored
//   `password_hash` that never appears in any response body, and a deliberately
//   drifted `users.plan` that is byte-identical after every route runs — each
//   with a positive control proving the probe can see the thing it is denying.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UsageRepo } from '../db/repos/usage.repo';
import { USAGE_PAGE_DEFAULT, USAGE_PAGE_MAX } from '../db/repos/usage.repo';
import type { OpsAuditRepo } from '../db/repos/ops-audit.repo';
import type { AccountVerifier } from './account-auth';
import { adminGate, type AdminGatedRoute, type OpsAuditSink } from './ops-audit-trail';
import { sendJson } from './body';

/** D11 — `?limit=` default/ceiling for `GET /api/ops/audit/recent`. A
 *  SEPARATE pair from `USAGE_PAGE_DEFAULT`/`USAGE_PAGE_MAX`: those bound a
 *  per-user, per-month page; this bounds a cross-account trail read, and the
 *  two questions having the same numeric answer today is coincidence, not a
 *  reason to share one constant. */
export const AUDIT_RECENT_DEFAULT = 50;
export const AUDIT_RECENT_MAX = 500;

// ⚠️ THE PATHS BELOW ARE WRITTEN OUT AS LITERALS IN THE `if` CONDITIONS, twice
// each (`=== '/x'` and `startsWith('/x?')`), exactly like console-routes.ts —
// deliberately, and NOT because a `const P_SUMMARY` would be worse to read. The
// route-coverage guard (test/console-admin-gate-coverage.test.ts) derives the
// list of routes THIS FILE SERVES by reading this source and pulling `'/api/…'`
// literals out of the conditions it matches on. Routes assembled from constants
// or template literals are INVISIBLE to it, so a file written that way would be
// silently exempt from the one check that catches "a newly added ops route that forgot to add the gate". A
// constant would be tidier and would cost the guard — which is the wrong trade on
// the only surface that reads across every account.

/** UTC `YYYY-MM`, strictly. `2026-8`, `2026-13`, `2026-00` and `2026` are all
 *  refused: a loose parser here would let a caller believe it asked about a month
 *  that has no rows when it actually asked about nothing. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface OpsRoutesDeps {
  /** The account verifier — the same `AuthService` instance every other http
   *  surface uses, sliced to the two methods the gate needs. */
  auth: AccountVerifier;
  /**
   * O-2's aggregates. A SLICE of UsageRepo on purpose: `get`/`increment` are the
   * single-account metering path (billing writes through them), and an ops read
   * surface holding the method that BUMPS a user's usage is a loaded gun with no
   * reason to be in the room.
   */
  usage: Pick<UsageRepo, 'listUsersForMonth' | 'totalForMonth' | 'listMonths'>;
  /**
   * Where gate rows go. REQUIRED — no `?`, no default.
   *
   * book 13 §7 F1 ②: a DI default is either the real thing or a throw, never a
   * comfortable empty. An optional sink would mean a bootstrap that forgot one
   * line produces a fully working, completely untraceable ops surface, with no
   * new symbol to grep and nothing red anywhere. Making it required moves that
   * mistake to compile time.
   */
  audit: OpsAuditSink;
  /**
   * D11 — the READ side of `ops_audit_log`, sliced to `listRecent` only.
   *
   * A SEPARATE dep from `audit` above on purpose, even though both are
   * satisfied by the SAME `OpsAuditRepo` instance in bootstrap: `audit` is
   * typed as `OpsAuditSink` (append-only — ops-audit-trail.ts's own header
   * explains why the gate must never be able to READ its own trail), and
   * widening THAT type to add `listRecent` would hand every future admin-gate
   * caller the read as a side effect of asking for the write. Two slices of
   * one repo, one per capability, same 「slice interfaces」 shape as
   * `presence-routes.ts`'s `Registry` slice.
   *
   * REQUIRED — no `?`, no default, same argument as `audit`'s own doc comment:
   * a bootstrap that forgot this line must fail to COMPILE, not quietly ship a
   * 500 the first time someone calls the route.
   */
  auditLog: Pick<OpsAuditRepo, 'listRecent'>;
}

/** `{ok:true, …}` or the 400 message. Never substitutes a default for junk: a
 *  caller that asked for `month=abc` and got August would believe it asked for
 *  August (the argument console-routes.ts's `parseLimit` already makes). */
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function query(url: string): URLSearchParams {
  // Throwaway base — only the query is ever read, never the origin.
  return new URL(url, 'http://ops.invalid').searchParams;
}

/**
 * `?month=` — REQUIRED, with no 「default to the current month」.
 *
 * 🔴 The asymmetry with `?limit=` (which does default) is deliberate and is the
 * whole reason this is spelled out: a missing `limit` changes HOW MANY ROWS you
 * get, a missing `month` changes WHICH DATA YOU ARE LOOKING AT. A dashboard whose
 * month parameter got dropped by a front-end bug would render last month's
 * numbers under a header that says this month, confidently, with no tell.
 * Requiring it means every caller states, every time, which month it is showing.
 */
function parseMonth(url: string): Parsed<string> {
  const raw = query(url).get('month');
  if (raw === null) return { ok: false, message: 'month is required (UTC YYYY-MM, e.g. 2026-08)' };
  if (!MONTH_RE.test(raw)) return { ok: false, message: 'month must be a UTC YYYY-MM bucket (e.g. 2026-08)' };
  // Deliberately NOT echoed back in the message: this string came from the
  // caller, and an error body is the last place to start reflecting input.
  return { ok: true, value: raw };
}

/**
 * `?limit=` — an integer in 1..{@link USAGE_PAGE_MAX}, or 400.
 *
 * 🔴 REFUSED rather than CLAMPED. `UsageRepo.listUsersForMonth` clamps an
 * oversized limit (defence in depth for any other caller), but a clamp on an HTTP
 * boundary is a silent answer to a different question: a caller that asked for
 * 10 000 and received 200 rows has no way to know it did not receive all of them.
 * Same shape, same refusal as console-routes.ts's `parseLimit`; only the ceiling
 * differs, because it belongs to a different surface.
 */
function parseLimit(url: string): Parsed<number> {
  const raw = query(url).get('limit');
  if (raw === null) return { ok: true, value: USAGE_PAGE_DEFAULT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > USAGE_PAGE_MAX) {
    return { ok: false, message: `limit must be an integer in 1..${USAGE_PAGE_MAX}` };
  }
  return { ok: true, value: n };
}

/** `?after_user_id=` — absent (page 1) or a non-empty cursor. `''` is refused
 *  because it cannot mean anything: it is neither 「from the start」 (that is
 *  absence) nor a user id, and SQLite would happily compare against it. */
function parseCursor(url: string): Parsed<string | null> {
  const raw = query(url).get('after_user_id');
  if (raw === null) return { ok: true, value: null };
  if (raw === '') return { ok: false, message: 'after_user_id must be non-empty (omit it for the first page)' };
  return { ok: true, value: raw };
}

/**
 * D11 — `?limit=` for `GET /api/ops/audit/recent`. Same REFUSE-not-CLAMP
 * argument as `parseLimit` above (a caller that asked for 10 000 rows and got
 * {@link AUDIT_RECENT_MAX} back has no way to know it did not get all of
 * them), kept as its own function rather than reusing `parseLimit` because
 * the two bound DIFFERENT questions (see the constants' own doc comment).
 */
function parseAuditLimit(url: string): Parsed<number> {
  const raw = query(url).get('limit');
  if (raw === null) return { ok: true, value: AUDIT_RECENT_DEFAULT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > AUDIT_RECENT_MAX) {
    return { ok: false, message: `limit must be an integer in 1..${AUDIT_RECENT_MAX}` };
  }
  return { ok: true, value: n };
}

function refuseBadRequest(res: ServerResponse, message: string): void {
  // `SETTINGS_SCHEMA_INVALID` is an EXISTING protocol code — console-routes.ts
  // already answers parameter junk with it. The 59-code table does not move: this
  // lane ships zero protocol change.
  sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message });
}

/**
 * The gate, applied uniformly. Returns the proven admin's id, or null after it
 * has already answered the request.
 *
 * Every route below starts with this line and there is no way to skip it — the
 * handlers are the only code in the file and each one's first statement is
 * this call. `test/console-admin-gate-coverage.test.ts` derives the route list
 * from this source and would go red on a route that forgot.
 */
function gate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsRoutesDeps,
  route: AdminGatedRoute,
): string | null {
  const verdict = adminGate(req, deps.auth, deps.audit, route);
  if (verdict.ok) return verdict.userId;
  // 🔴 The refusal is NAMED and carries its own status: 401 "you haven't proven who you are" and
  // 403 "I know who you are, but this isn't for you to see" are two different sentences and must
  // stay two. Never an empty 200 — an empty rollup would read as "nobody uses the platform" to
  // someone who was actually being turned away.
  sendJson(res, verdict.status, { error: verdict.error });
  return null;
}

/** Handle the saas ops REST routes. Returns true iff it owned the request. */
export function tryHandleOpsRoutes(req: IncomingMessage, res: ServerResponse, deps: OpsRoutesDeps): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // ── ① GET /api/ops/usage/months — "which months have usage rows" ─────────────────────
  //
  // It exists so a zero can be told from a typo. `summary` answers an unknown
  // month with an honest all-zero rollup (see usage.repo.ts: an empty month is a
  // PROVEN zero, because usage_records is never swept — db/retention.ts:42), and
  // "nobody spoke this month" and "you typed the wrong month" are numerically identical. This route is
  // the difference between them.
  if (method === 'GET' && url === '/api/ops/usage/months') {
    if (gate(req, res, deps, 'GET /api/ops/usage/months') === null) return true;
    sendJson(res, 200, { months: deps.usage.listMonths() });
    return true;
  }

  // ── ② GET /api/ops/usage/summary?month= — "how much did the whole platform use this month" ──────────
  //
  // 🔴 `total.users` is HOW MANY ACCOUNTS HAVE A ROW THIS MONTH — not how many
  // accounts exist. 42 registered accounts and `users: 3` is a perfectly healthy
  // reading (39 of them did not speak this month). It is also the ONLY field that
  // distinguishes "this month has no rows at all" (users 0, totals 0) from "all 41
  // accounts left a row, they're just all 0" (users 41, totals 0) — the totals are identical in both. Which is
  // why it is a sibling field and not folded into the numbers.
  //
  // The rollup is returned UNROUNDED. Rounding is a presentation decision, and a
  // server that makes it turns this field from "how much was actually used" into "what the UI shows".
  if (method === 'GET' && (url === '/api/ops/usage/summary' || url.startsWith('/api/ops/usage/summary?'))) {
    if (gate(req, res, deps, 'GET /api/ops/usage/summary') === null) return true;
    const month = parseMonth(url);
    if (!month.ok) {
      refuseBadRequest(res, month.message);
      return true;
    }
    sendJson(res, 200, { total: deps.usage.totalForMonth(month.value) });
    return true;
  }

  // ── ③ GET /api/ops/usage/users?month=&limit=&after_user_id= ────────────────
  //
  // "how much each account used this month, individually", keyset-paginated by `user_id ASC`.
  //
  // 🔴 `next_after_user_id === null` is the ONLY truthful "no next page". The repo
  // computes it with a limit+1 probe row rather than `rows.length < limit`, which
  // is wrong precisely when the last page is exactly full — and wrong in the
  // direction that hands out a cursor forever. A client that re-derives the answer
  // by counting rows re-introduces the bug on its own side, which is why the
  // contract doc spells this out for L4.
  //
  // `month` is echoed back so a caller can check the page is about the month it
  // asked for. Deliberately no `total` in this body: the platform sum is route ②'s
  // question, and a page carrying both would be one call answering two.
  if (method === 'GET' && (url === '/api/ops/usage/users' || url.startsWith('/api/ops/usage/users?'))) {
    if (gate(req, res, deps, 'GET /api/ops/usage/users') === null) return true;
    const month = parseMonth(url);
    if (!month.ok) {
      refuseBadRequest(res, month.message);
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
    const page = deps.usage.listUsersForMonth(
      month.value,
      cursor.value === null ? { limit: limit.value } : { limit: limit.value, after_user_id: cursor.value },
    );
    sendJson(res, 200, {
      month: month.value,
      rows: page.rows,
      next_after_user_id: page.next_after_user_id,
    });
    return true;
  }

  // ── ④ GET /api/ops/audit/recent?limit= — "what happened recently" — ops actions ───────────
  //
  // D11 — closes the "write-only audit trail" defect named by this card:
  // `OpsAuditRepo.listRecent` shipped in 0.2.48 with zero HTTP exposure (its
  // own doc comment says so — [NOT WIRED UP]). This is that route.
  //
  // 🔴 It reads ACROSS actors by construction (every admin's granted/denied
  // gate rows, not just the caller's own) — same argument as
  // `/api/cloud/billing/orphans` and `BillingRepo.listOrphanEvents` — so it is
  // admin-gated exactly like its three siblings above, refusing a non-admin
  // BY NAME (403 ADMIN_ONLY) rather than an empty list.
  //
  // Note the read-your-own-gate wrinkle, spelled out so nobody mistakes it for
  // a bug: THIS request's own `adminGate` call appends a row (granted or
  // denied) BEFORE `deps.auditLog.listRecent` runs, so a 200 here always
  // includes at least the row this very call just wrote. That is correct —
  // the trail recording its own read is not a leak, it is the trail working.
  if (method === 'GET' && (url === '/api/ops/audit/recent' || url.startsWith('/api/ops/audit/recent?'))) {
    if (gate(req, res, deps, 'GET /api/ops/audit/recent') === null) return true;
    const limit = parseAuditLimit(url);
    if (!limit.ok) {
      refuseBadRequest(res, limit.message);
      return true;
    }
    sendJson(res, 200, { entries: deps.auditLog.listRecent(limit.value) });
    return true;
  }

  // Anything else under /api/ops/ is NOT claimed here — it falls through to the
  // router's 404. Deliberately no 405 for a known path with the wrong method: the
  // rest of this repo's http surface answers 404 for an unmatched (method, path)
  // pair, and a 405 here would additionally tell an anonymous caller which ops
  // paths exist BEFORE the gate has had a chance to refuse them.
  return false;
}
