// SPEC-REF:
//   docs/strategy/2026-08-02-o3-user-management-final.md §3 R1/R2 (THE contract
//     — change discipline: edit that document first, then this file and the
//     tests)
//   docs/strategy/2026-08-12-req1207-admin-user-management-design.md §2
//     (the read-only half; read that file's CORRECTION HEADER first — owner
//     overturned the ban mechanism, and `suspended_at` is now `restricted_at`)
//   docs/strategy/2026-08-12-a2-3-restricted-use-design.md §8 (what A2-4 inherits
//     unchanged, and the one rename it inherits)
//   src/db/repos/user.repo.ts `toOpsUser` (THE whitelist) and `listPage` (the page)
//   src/http/ops-audit-trail.ts `adminGate` (O-1 gate + audit trail)
//   CLAUDE.md red line: no silent failures / one value answers only one
//     question / anti-façade
//
// GET /api/ops/users + GET /api/ops/users/detail — the cross-account USER LIST,
// read-only.
//
// ── 🔴 THE FIRST ROUTE THAT CAN ONLY BE DEFENDED BY PROJECTION ──────────────
// ops-routes.ts defuses M2-7 STRUCTURALLY: its own header states that it 「NEVER
// IMPORTS UserRepo and has no path to a UserRecord」, so on that surface the mine
// is unreachable rather than merely avoided — 「there is nothing here to project
// FROM」. This file cannot have that property. A user list is made of user rows,
// and every `UserRecord` in this process carries `password_hash`; both reads
// below hand one over. So this is the first route in the repo whose only defence
// against M2-7 is that it PROJECTS, and the projection is therefore not a detail
// of how the response is assembled — it is the whole guard.
//
// Two consequences, both deliberate:
//   · the whitelist is ONE exported function (`toOpsUser`) applied at both
//     response points (响应点), never an object literal written out per route —
//     two literals is how one of them gains a field;
//   · it lives in db/repos/user.repo.ts rather than here, because
//     test/console-admin-gate-coverage.test.ts pins the set of files that may
//     mention `is_admin` to three, and that instrument cannot tell 「a console
//     displays the column」 from 「a second admin gate was born」. A2-3 hit the
//     same wall and made the same call.
// 🔴 AND NEVER IN THE CLIENT. A front-end that dropped the field would leave the
// hash on the wire, visible in devtools and in every proxy log, while deleting
// the one signal that would ever reveal it: an assertion on the response body.
// test/ops-user-routes.test.ts asserts on `JSON.stringify(body)` with a positive
// control that a recognisable hash really is in the database.
//
// ── 🔴 NO TIER ANYWHERE ON THIS SURFACE (M2-8) ──────────────────────────────
// Not in the list, and — unlike O-3's R2 sketch — not in the detail either, and
// the second half of that is a deviation this file has to own rather than
// silently implement. R2 says the detail may carry `plan` PROVIDED it comes from
// an explicitly read-only resolution ("M2-8 disposition (a) `inspect`" —
// M2-8 处置 (a) `inspect`). That function does not exist yet: grep for
// `inspect` in src/billing/ comes back empty, so the
// only way to answer "what tier" (什么档) today is `BillingService.getPlan`, and that WRITES
// (`getPlan → resolve → mirrorPlanColumn → users.setPlan`). Publishing the stored
// `users.plan` column instead is the other wrong answer: it is an eventually-
// consistent MIRROR, so an operator would read a tier nothing enforces on.
// ⇒ this surface answers "which accounts exist, and what state is each in"
// (有哪些账号，各自是什么状态) and does not answer "what tier" (什么档) at all.
// Building `inspect` is a BILLING-face change (line-by-line diff review —
// 逐行 diff 审) and is
// not smuggled into a list card. Stated here so the omission is a decision on the
// record rather than a gap somebody later 「fixes」 with the writing call.
//
// ── 🔴 NO "last login" (上次登录), AND NO PLAUSIBLE STAND-IN FOR IT ────────────
// owner asked for "login info" (登录信息) by name. This repo cannot answer it: there is no
// `last_login_at`, no session table, no denylist and no login record of any kind
// — auth is stateless JWT and a successful sign-in leaves nothing behind. The
// three nearest values each answer a DIFFERENT question:
//   · `pc_devices.last_seen_at`      → "has that PC had any activity recently"
//                                       (那台电脑最近有没有活动)
//   · `mobile_pairings.last_seen_at` → "has that phone had any activity
//                                       recently" (那台手机最近有没有活动)
//   · `usage_records.updated_at`     → "the last moment that month's bucket
//                                       was incremented" (那个月桶最后被加过的时刻)
// A PC that stays connected refreshes the first one daily for an account nobody
// has signed into for months, so rendering any of them as "last login"
// (上次登录) is one value answering two questions (一个值答两个问题) on a screen
// where an operator decides whether to restrict somebody.
// They are not shown under a wrong name, and they are not shown under a right one
// either — this card is the account list, and three device-activity timestamps
// belong to the surface that shows devices. Adding `users.last_login_at` is a
// COLLECTION-surface expansion (privacy policy 「What we collect」) and is an owner
// gate; nothing here may open it by writing a column.
//
// ── PATH SHAPE: WHY THE DETAIL IS A QUERY PARAMETER ─────────────────────────
// O-3's R2 was `GET /api/ops/users/:id`, and `:id` is not expressible in
// ADMIN_GATED_ROUTES — that fence is a list of LITERALS whose job is to make
// 「put `req.url` into the audit table」 fail to COMPILE, and it guards a route
// family that sits beside POST /api/password/reset, whose body carries a
// plaintext password. Widening the fence's type to fit one route would delete
// that guarantee for all of them, so the ROUTE changed shape instead and the
// fence kept its literals. The account id still reaches the handler; it simply
// never reaches the trail.
//
// ── AUDIT POSTURE ───────────────────────────────────────────────────────────
// Both routes are GETs and both rely on `recordGateOutcome`'s serve-but-shout
// policy, which is exactly the case that policy was argued for: an unwritable
// audit table must not become "the ops console won't open" (运营台打不开) on a
// surface whose only power is to
// LOOK. The re-argument A2-3 had to make is not owed here, and this file must not
// grow a write later without making it — see MUTATING_ADMIN_GATED_ROUTES.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserRepo } from '../db/repos/user.repo';
import { OPS_USER_PAGE_DEFAULT, OPS_USER_PAGE_MAX, toOpsUser } from '../db/repos/user.repo';
import type { AccountVerifier } from './account-auth';
import { adminGate, type AdminGatedRoute, type OpsAuditSink } from './ops-audit-trail';
import { sendJson } from './body';

// ⚠️ THE PATHS BELOW ARE WRITTEN OUT AS LITERALS IN THE `if` CONDITIONS, twice
// each, exactly like ops-routes.ts and for its stated reason: the coverage guard
// (test/console-admin-gate-coverage.test.ts) derives what this file serves by
// reading this source for `'/api/…'` literals inside the conditions it matches
// on. A path assembled from a constant is INVISIBLE to the one check that catches
// "a newly-added ops route forgot to add the gate" (新加的运营路由忘了加闸), so a
// tidier constant would buy nothing and cost the
// guard.

/** Longest `q` this surface accepts. REFUSED, never truncated: a silently
 *  shortened search term answers a question the operator did not ask, and the
 *  rows it returns look exactly like the rows they wanted. */
export const OPS_USER_Q_MAX = 200;

/**
 * `user_id` names no account.
 *
 * An HTTP-LOCAL string and not a protocol `ErrorCode`, on the precedent
 * account-restriction-routes.ts spells out in full: the only client that can
 * reach this route is the repo-owned admin console on a VPN-only surface, no
 * phone or end-user browser can dial it at all, and minting protocol codes is
 * owner-gated. test/ops-user-routes.test.ts pins it OUT of `ERROR_CODES` so
 * "adding a code" (加一个码) stays a decision rather than a drift.
 */
export const OPS_USER_UNKNOWN = 'OPS_USER_UNKNOWN';

export interface OpsUserRoutesDeps {
  /** The account verifier for the admin gate — the SAME `AuthService` instance
   *  every other http surface uses, sliced to the two methods the gate needs. */
  auth: AccountVerifier;
  /**
   * 🔴 A TWO-METHOD READ SLICE OF `UserRepo`, and the narrowness is the feature
   * (the shape ops-routes.ts uses for `UsageRepo` and A2-3 uses for this same
   * repo). The full object also carries `remove` (destroys an account and
   * cascades), `setPlan` (moves a tier — owner ruled that ops-side tier changes
   * are "not for now" (运营端改档「先不做」)),
   * `setRestricted`, `setPassword` and `setPermanentFree`. A LIST has no business
   * being able to reach any of them, and a slice makes that a compile error
   * rather than a review comment. bootstrap passes `db.users`; the narrowing is
   * enforced HERE, on the consumer.
   */
  users: Pick<UserRepo, 'listPage' | 'findById'>;
  /**
   * Where the gate's rows go. REQUIRED — no `?`, no default (docs/rebuild vol.
   * 13 §7 F1 ②): an
   * optional sink would mean a bootstrap missing one line serves a fully working,
   * completely untraceable cross-account read, with nothing red and no new symbol
   * to grep.
   */
  audit: OpsAuditSink;
}

/** `{ok:true, …}` or the 400 message — the ops family's parse verdict. Never
 *  substitutes a default for junk. */
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function query(url: string): URLSearchParams {
  // Throwaway base — only the query is ever read, never the origin.
  return new URL(url, 'http://ops.invalid').searchParams;
}

/**
 * `?limit=` — an integer in 1..{@link OPS_USER_PAGE_MAX}, or 400.
 *
 * 🔴 REFUSED rather than CLAMPED, the house rule this family already states
 * twice: `UserRepo.listPage` clamps as defence in depth for any other caller, but
 * a clamp at an HTTP boundary is a silent answer to a different question — a
 * caller that asked for 10 000 and received 200 rows has no way to know it did
 * not receive all of them. A MISSING limit changes how many rows you get; a
 * silently clamped one changes what you think you asked for.
 */
function parseLimit(url: string): Parsed<number> {
  const raw = query(url).get('limit');
  if (raw === null) return { ok: true, value: OPS_USER_PAGE_DEFAULT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > OPS_USER_PAGE_MAX) {
    return { ok: false, message: `limit must be an integer in 1..${OPS_USER_PAGE_MAX}` };
  }
  return { ok: true, value: n };
}

/** `?after_user_id=` — absent (page 1) or a non-empty cursor. `''` is refused
 *  because it cannot mean anything: it is neither 「from the start」 (that is
 *  absence) nor an account id, and SQLite would happily compare against it. */
function parseCursor(url: string): Parsed<string | null> {
  const raw = query(url).get('after_user_id');
  if (raw === null) return { ok: true, value: null };
  if (raw === '') return { ok: false, message: 'after_user_id must be non-empty (omit it for the first page)' };
  return { ok: true, value: raw };
}

/**
 * `?q=` — absent (no filter) or a non-empty search term, trimmed.
 *
 * 🔴 `?q=` AND `?q=%20%20` ARE REFUSED, not treated as 「no filter」, and the
 * distinction is the same one `after_user_id` draws one function up: absence
 * already means 「everything」, so an empty string can only be a caller whose
 * search box did not send what the operator typed. Answering it with the full
 * account list would be "return everything" (返回全部) wearing the face of a successful search.
 */
function parseQuery(url: string): Parsed<string | null> {
  const raw = query(url).get('q');
  if (raw === null) return { ok: true, value: null };
  const q = raw.trim();
  if (q === '') return { ok: false, message: 'q must be non-empty (omit it to list every account)' };
  if (q.length > OPS_USER_Q_MAX) return { ok: false, message: `q must be at most ${OPS_USER_Q_MAX} characters` };
  return { ok: true, value: q };
}

/** `?user_id=` — REQUIRED. There is no 「default to somebody」 for a route whose
 *  whole question is "this one account" (这一个账号). */
function parseUserId(url: string): Parsed<string> {
  const raw = query(url).get('user_id');
  if (raw === null || raw.trim() === '') return { ok: false, message: 'user_id is required' };
  return { ok: true, value: raw.trim() };
}

function refuseBadRequest(res: ServerResponse, message: string): void {
  // `SETTINGS_SCHEMA_INVALID` is an EXISTING protocol code and is already this
  // http family's answer to parameter junk (console-routes.ts, ops-routes.ts).
  // The code table does not move: this card ships zero protocol change.
  // Deliberately NOT echoing the offending value — an error body is the last
  // place to start reflecting caller input.
  sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message });
}

/**
 * The gate, applied uniformly. Returns the proven admin's id, or null after it
 * has already answered the request.
 *
 * Every route below starts with this line and there is no way to skip it — the
 * handlers are the only code in the file and each one's first statement is this
 * call.
 */
function gate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsUserRoutesDeps,
  route: AdminGatedRoute,
): string | null {
  const verdict = adminGate(req, deps.auth, deps.audit, route);
  if (verdict.ok) return verdict.userId;
  // 🔴 NAMED, and carrying its own status: 401 "you haven't proven who you
  // are" (你没证明你是谁) and 403 "I know who you are, but this isn't for you to
  // see" (你是谁我知道了，但这不是给你看的) are two different sentences. Never an
  // empty 200 — an empty user list would read as "the platform has no
  // accounts" (平台上没有账号) to someone being turned away.
  sendJson(res, verdict.status, { error: verdict.error });
  return null;
}

/** Handle the saas ops user-list routes. Returns true iff it owned the request. */
export function tryHandleOpsUserRoutes(req: IncomingMessage, res: ServerResponse, deps: OpsUserRoutesDeps): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // ── ① GET /api/ops/users?limit=&after_user_id=&q= ──────────────────────────
  //
  // "which accounts exist on the platform" (平台上有哪些账号), keyset-paginated
  // by `id ASC`.
  //
  // 🔴 `next_after_user_id === null` is the ONLY truthful "there is no next
  // page" (没有下一页). The repo
  // computes it from a limit+1 probe row rather than `rows.length < limit`, which
  // is wrong precisely when the last page is exactly full — and wrong in the
  // direction that hands out a cursor forever. A client that re-derives the answer
  // by counting rows re-introduces the bug on its own side.
  //
  // Deliberately no `total`: "how many accounts are there in total"
  // (一共有多少账号) is a different question, it needs a
  // COUNT over the same filter, and a page carrying both would be one call
  // answering two. Deliberately no echo of `q` either — the usage routes echo
  // `month` because a dropped month renders the WRONG data under a confident
  // header, whereas a dropped `q` renders MORE rows, which is visible on its face.
  if (method === 'GET' && (url === '/api/ops/users' || url.startsWith('/api/ops/users?'))) {
    if (gate(req, res, deps, 'GET /api/ops/users') === null) return true;
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
    const q = parseQuery(url);
    if (!q.ok) {
      refuseBadRequest(res, q.message);
      return true;
    }
    const page = deps.users.listPage({
      limit: limit.value,
      ...(cursor.value === null ? {} : { after_user_id: cursor.value }),
      ...(q.value === null ? {} : { q: q.value }),
    });
    sendJson(res, 200, {
      // THE projection, at the one point a `UserRecord` becomes a response.
      rows: page.rows.map(toOpsUser),
      next_after_user_id: page.next_after_user_id,
    });
    return true;
  }

  // ── ② GET /api/ops/users/detail?user_id= ───────────────────────────────────
  //
  // "what state is this one account in right now" (这一个账号此刻是什么状态) —
  // and it is a real second question, not a
  // convenience over route ①. The ops surface speaks in account ids: every
  // `ops_audit_log` row about an account carries `target_id = users.id` and
  // nothing else, and the restriction route takes `user_id`. So the operator who
  // most needs this route is holding an id and no name — which route ① cannot
  // turn into a row at all, because `q` matches `email` and `display_name` and
  // paging needs to know where the id already sits.
  //
  // The user is wrapped in `{ user: … }` rather than returned bare so that the
  // siblings O-3's R2 reserves (`plan`, `devices`) can arrive without changing the
  // shape of what is already there — and so that a reader can see at a glance
  // that they are ABSENT rather than merged in. Why each is absent: this file's
  // header (tier = M2-8 with no read-only resolver yet; device counts need a
  // per-user pairing read that mobile.repo.ts does not expose, and that repo is
  // not this card's file).
  if (method === 'GET' && (url === '/api/ops/users/detail' || url.startsWith('/api/ops/users/detail?'))) {
    if (gate(req, res, deps, 'GET /api/ops/users/detail') === null) return true;
    const id = parseUserId(url);
    if (!id.ok) {
      refuseBadRequest(res, id.message);
      return true;
    }
    const user = deps.users.findById(id.value);
    // 🔴 404 AND NOT AN EMPTY 200. The caller is a proven admin who can already
    // enumerate every account through route ① one line up, so answering honestly
    // leaks nothing — while `{user:null}` would let a console draw an empty page
    // that looks exactly like an account with no data in it. Same argument, same
    // shape, as the restriction route's refusal for an unknown target.
    if (!user) {
      sendJson(res, 404, { error: OPS_USER_UNKNOWN, message: 'user_id names no account' });
      return true;
    }
    sendJson(res, 200, { user: toOpsUser(user) });
    return true;
  }

  // Anything else under this prefix is NOT claimed here — it falls through to the
  // router's 404. Deliberately no 405 for a known path with the wrong method: the
  // rest of this http surface answers 404 for an unmatched (method, path) pair,
  // and a 405 would additionally tell an anonymous caller which ops paths exist
  // BEFORE the gate has had a chance to refuse them.
  return false;
}
