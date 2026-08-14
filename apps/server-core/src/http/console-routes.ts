// SPEC-REF:
//   docs/strategy/R5-WEB-TASK-CARDS.md WP-W1 ①-⑤ (server-core console support surface:
//     logout / password reset / cloud summary+subscription / device+pairing mgmt)
//   docs/rebuild/05-DATA-MODEL.md §5 (account.password_reset {reset_token,
//     expires_at} 30-min TTL; account.* broadcast deny-list — these keys never
//     fan out to a mobile), §1 (pc_devices / mobile_pairings)
//   docs/strategy/2026-07-23-mock-billing-design.md §3/§4 (getPlan/getQuota reads)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (no silent failure — explicit codes)
//   0.3.0 P4: docs/legal/privacy-policy.md 「Your rights」 (export / delete) —
//     the two routes at the bottom of this file, with their whole argument in
//     http/account-lifecycle.ts
//   *** HUMAN-AUDIT SENSITIVE (auth: password reset + device/pairing revoke +
//       irreversible account deletion) — reviewable in isolation ***
//
// The saas-only console REST surface, mounted from http/router.ts only when the
// `console` dep is present (standalone leaves these paths unhandled → 404, same
// mode-gating as auth-routes.ts). Every response body carries an explicit code —
// no silent failure. Bearer auth reuses the account AuthService verbatim; the
// public shapes NEVER expose a secret (password_hash, device_token, mobile_token,
// reset_token — except the FLAG-GATED internal forgot echo below, OFF by
// default).
//
// 0.3.0 M1 — the redline below is CLOSED BY DEFAULT. Echoing reset_token to an
// anonymous caller is a 2-request account takeover of any KNOWN email, so the
// echo is now dark unless `FLOWMIC_INTERNAL_RESET_TOKEN_ECHO` is set to a
// strict '1'/'true' (anything else, including unset, means OFF — a fat-fingered
// value fails toward safety). With the flag off the forgot handler still MINTS
// and PERSISTS the token (a future mail channel reads it from the same
// user_settings row) but the response is byte-identical to the unknown-email
// response, which also restores full anti-enumeration on this route.
//   ┌─────────────────────────────────────────────────────────────────────────┐
//   │ STILL OPEN (card M2, not this file's fix): there is NO mail transport in │
//   │ this repo, so with the echo dark a password reset is UNDELIVERABLE — the │
//   │ token exists only in user_settings and nobody carries it to the user.    │
//   │ M1 closes the takeover hole; it does NOT make reset usable. The handler  │
//   │ logs that loudly per request and never claims an email was sent.         │
//   │ (legacy apps/server/src/api/mailer.ts is the transport blueprint.)       │
//   └─────────────────────────────────────────────────────────────────────────┘
//
// 🔴 THE TWO PASSWORD ROUTES NO LONGER LIVE HERE (card MAIL-1, 2026-08-09).
// `POST /api/password/{forgot,reset}` moved VERBATIM to
// `http/password-reset-routes.ts`; this file still MOUNTS them (see the
// `tryHandlePasswordResetRoutes` delegation below), so nothing about the
// saas-only gating or the 404-in-standalone answer changed. The box above is
// kept for the record and is answered THERE — that file's header carries the
// current status of the mail channel, and the redline paragraph two paragraphs
// up (the echo flag) is still enforced by that file.

import { isRealPc } from '../room/registry';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../auth/auth-service';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import type { BillingService } from '../billing/billing-service';
import type { BillingRepo } from '../db/repos/billing.repo';
import type { PcRepo } from '../db/repos/pc.repo';
import type { MobileRepo } from '../db/repos/mobile.repo';
import type { SettingsRepo } from '../db/repos/settings.repo';
import type { UsageRepo } from '../db/repos/usage.repo';
import type { UserRepo } from '../db/repos/user.repo';
import {
  accountFromBearer,
  type AdminVerdict,
  type UserIdVerdict,
} from './account-auth';
import { tryHandleAccountLifecycleRoutes } from './account-lifecycle-routes';
import { tryHandleAccountPasswordRoutes } from './account-password-routes';
import { tryHandleByokRoutes } from './byok-routes';
import { adminGate, type AdminGatedRoute, type OpsAuditSink } from './ops-audit-trail';
import { restrictionRefusalBody, restrictionVerdict } from '../auth/account-restriction';
import { EMAIL_NOT_VERIFIED, isEmailVerified, type EmailVerifiedReader } from '../auth/email-verification';
import type { PasswordResetMailer } from '../mail';
import { readJsonBody, sendJson, str } from './console-http';
import { tryHandlePasswordResetRoutes } from './password-reset-routes';

/** Default / ceiling for `?limit=` on BOTH ledger reads (`/billing/events` and
 *  0.2.38's `/billing/orphans`). The cap is not paranoia: the ledger grows one
 *  row per webhook delivery forever, and an unbounded `limit` is a
 *  self-inflicted DoS on a Bearer-authenticated route. */
const EVENTS_DEFAULT_LIMIT = 20;
const EVENTS_MAX_LIMIT = 100;

export interface ConsoleRoutesDeps {
  auth: AuthService;
  billing: BillingService;
  /** D1 §6.2 — the `billing_events` ledger behind GET /api/cloud/billing/events.
   *
   *  A SEPARATE dep from `billing` above even though both are "billing": that one
   *  is the SERVICE that decides "what tier is this user on", this one is the STORE that
   *  remembers "which webhooks we've received". Folding the read into BillingService
   *  would put a second responsibility on the file whose whole point is to answer
   *  exactly one question. Required, not optional — an absent ledger would make
   *  the reconciliation page render "no events yet" for an account that has plenty,
   *  which is a lie the compiler can prevent. */
  billingLedger: BillingRepo;
  /**
   * 0.2.48 — where the admin gate's trail goes (`ops_audit_log`).
   *
   * REQUIRED, with no `?` and no default, and that is the whole point: book 13 §7
   * F1 ② (a DI default is the real thing or a throw, never a friendly empty). An
   * optional sink would mean a bootstrap missing one line still serves
   * /billing/orphans perfectly — just with nobody able to say who read it — and
   * there would be no new symbol to grep and nothing red to notice. Making it
   * required turns that omission into a compile error.
   *
   * Typed as the WRITE slice (`OpsAuditSink`), not the repo: nothing in this file
   * has any business reading the trail back.
   */
  opsAudit: OpsAuditSink;
  pcs: PcRepo;
  mobiles: MobileRepo;
  settings: SettingsRepo;
  /**
   * 0.3.0 P4 — the account row itself, for the ONE route that destroys it
   * (POST /api/account/delete → `users.remove`).
   *
   * REQUIRED, with no `?` and no default (book 13 §7 F1 ②). An optional repo would
   * mean a bootstrap missing one line still MOUNTS the deletion route, which
   * would then throw per request — a GDPR obligation that answers 500 while the
   * console shows a button. Making it required turns that omission into a compile
   * error at the one object literal that has to change.
   */
  users: UserRepo;
  /** 0.3.0 P4 — the account's monthly usage rows for GET /api/account/export
   *  (`usage.listByUser`). The privacy policy names 「monthly usage totals」 among
   *  the things a user may have back; `billing.getQuota` answers only "this month",
   *  which is a different question and a shorter answer. Required for the same
   *  reason as `users` above. */
  usage: UsageRepo;
  /** Per-IP throttle for the password reset surface — same discipline as the
   *  register/login limiter (5 / 10-min), a SEPARATE bucket so a legitimate
   *  reset never starves the login budget (and vice-versa). */
  passwordLimiter: RegisterRateLimiter;
  /**
   * 🔴 MAIL-1 — the channel that carries a reset token to the human.
   *
   * REQUIRED, with no `?` and no default, for the reason `opsAudit` above is:
   * an optional mailer would let a bootstrap missing one line still mount
   * `/api/password/forgot`, which would mint a token, persist it, answer 200 and
   * deliver nothing — with no new symbol to grep and nothing red to notice.
   *
   * Declared here (and not only on `PasswordResetRoutesDeps`) because this file
   * hands its whole deps object to `tryHandlePasswordResetRoutes`: the subset
   * interface is what the routes READ, this is where the composition root has to
   * SUPPLY it. See http/password-reset-routes.ts for the full argument, and
   * mail/unconfigured.ts for what a deployment without mail env actually gets.
   */
  mail: PasswordResetMailer;
  /**
   * VERIFY-1 D3 — the verified-email gate's reader (owner 2026-08-11: the first
   * console sign-in offers nothing but verification; the SERVER holds the door,
   * the UI only paints it).
   *
   * REQUIRED, with no `?` and no default (book 13 §7 F1 ② — the same argument as
   * `opsAudit`/`mail` above): an optional reader would let a bootstrap missing
   * one line serve every console feature to unverified accounts, with no new
   * symbol to grep and nothing red to notice. bootstrap wires
   * `db.emailVerification` — the SAME instance the confirm route writes
   * through, so the gate cannot disagree with the confirm that opens it.
   */
  verifiedEmail: EmailVerifiedReader;
  /** WP-W1b: fan a console REST settings write out to the user's online sockets
   *  (bootstrap wires this to settings.handler broadcastUpdated with no origin
   *  socket) — keeps save-on-change peer sync semantics identical across channels.
   *  Absent (unit tests) → no fan-out, write still lands. */
  broadcastSettingsUpdated?: (userId: string, payload: { key: string; value: unknown }) => void;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for TTL tests. */
  now?: () => number;
}

/** Bearer → verified user row, or a 401 verdict (AUTH_TOKEN_INVALID /
 *  AUTH_TOKEN_EXPIRED, same contract as GET /api/me). A validly-signed token for
 *  a since-deleted user is treated as invalid — never a silent pass.
 *
 *  2026-07-31 (R4 ④): this used to be its own copy of parse-verify-load. It is
 *  now the SHARED definition (http/account-auth.ts) that /api/me and the billing
 *  gateway also use — three copies of 「is this Bearer good」 is how one of them
 *  ends up accepting what the others reject. Behaviour is unchanged. */
function authUser(req: IncomingMessage, deps: ConsoleRoutesDeps): UserIdVerdict {
  return accountFromBearer(req, deps.auth);
}

// 🔴 `authUserRow` — the row-returning Bearer delegate — MOVED with its two
// callers to http/account-lifecycle-routes.ts, and it is NOT kept here as a
// convenience. A delegate with no call site is exactly the façade shape this
// repo greps for; and `accountUserFromBearer` remains the ONE definition both
// files reach for, so the split cannot make one surface start admitting what
// the other rejects.

/**
 * 0.2.38 — Bearer → "is an admin", or the reason it is not, as THREE distinct
 * answers rather than two.
 *
 * `{ok:false, status:401}` = "you haven't proven who you are"; `{ok:false, status:403}` = "I know
 * who you are, but this isn't for you to see". Collapsing the second into an empty 200 would make
 * "you have no permission" and "no such row exists" the same response — this repo's headline bug shape
 * (one value answering two questions), and on an operations surface the specific harm is that an
 * operator with the wrong account would read "reconciliation is clean" off a permission denial.
 *
 * `ADMIN_ONLY` is an EXISTING code (protocol error-codes.ts, "Only an admin may perform this
 * action."). It had zero producers in this repo until 0.2.38; that route is its first.
 * The 59-code table does not move.
 *
 * 0.2.47 — THE DECISION ITSELF MOVED to http/account-auth.ts `adminFromBearer`,
 * the module that already owns 「who is this http caller」 for the whole surface
 * (its header is the argument). What is left here is a one-line delegate, for the
 * same reason `authUser` above is one: so the call sites in this file read alike.
 * It adds NOTHING. If it ever grows a second condition, this file has quietly
 * become a SECOND admin gate — and the 「exactly one `is_admin` decision site」
 * assertion in test/console-admin-gate-coverage.test.ts is what will say so.
 *
 * 0.2.48 — it now delegates to `http/ops-audit-trail.ts` `adminGate`, which
 * returns `adminFromBearer`'s verdict VERBATIM and additionally appends one
 * `ops_audit_log` row (granted / denied). Still not a second decision — the
 * `is_admin` assertion above still holds, because neither this file nor that one
 * reads the column. What changed is that /billing/orphans, the surface whose whole
 * job is to tell a human the truth about money, no longer gets read by an operator
 * without leaving a trace of who read it.
 *
 * ⚠️ `route` is a PARAMETER, not a constant baked in here, even though this file
 * has exactly one admin route today. A hardcoded literal would keep compiling —
 * and keep writing "someone read the orphan view" — on the day somebody adds a second admin
 * route and reuses this helper. The audit row would then be confidently wrong,
 * which is worse than absent.
 */
function authAdmin(req: IncomingMessage, deps: ConsoleRoutesDeps, route: AdminGatedRoute): AdminVerdict {
  return adminGate(req, deps.auth, deps.opsAudit, route);
}

/**
 * VERIFY-1 D3 — refuse a FEATURE route for an unverified account. Returns true
 * iff it wrote the refusal (the caller then returns; mirrors the `!who.ok`
 * shape beside every use).
 *
 * 403, not 401: the caller IS authenticated — what is missing is not identity
 * but a verified mailbox, and the UI's move on this name is 「paint the
 * verification card", not "re-login" (decision doc D3: hitting the gate unverified ⇒ named
 * EMAIL_NOT_VERIFIED, the UI routes straight back to the verification gate upon receiving it).
 *
 * Applied AFTER the identity verdict on every gated route, so the gate can
 * never be probed anonymously; NOT applied to ① /api/logout (an
 * acknowledgement — demanding a verified mailbox to sign OUT would trap the
 * user this gate creates), ② the password-reset family (recovery must work for
 * exactly the accounts that cannot receive product features), which are the
 * two non-feature surfaces this file owns. The full exemption census
 * (register/login/me, the verification routes themselves, Paddle webhook,
 * health/presence/updates, every device surface) lives where each of those is
 * mounted; test/email-verification.test.ts pins the whole matrix.
 *
 * ⚠️ Grandfathered accounts pass by construction: their `email_verified_at`
 * carries the migration stamp (db/schema.ts), and this gate asks only
 * NULL-or-not through the ONE conversion site (auth/email-verification.ts).
 */
function refuseUnverified(res: ServerResponse, deps: ConsoleRoutesDeps, userId: string): boolean {
  if (isEmailVerified(deps.verifiedEmail.emailVerifiedAt(userId))) return false;
  sendJson(res, 403, { error: EMAIL_NOT_VERIFIED });
  return true;
}

/**
 * A2-3 — refuse a FEATURE route for a RESTRICTED account. Same shape, same
 * contract and same call position as `refuseUnverified` above, deliberately:
 * the design's first recommendation is 「don't invent a second gate shape, copy
 * the one that is one day old」.
 *
 * 🔴 CALLED BEFORE `refuseUnverified`, and the order is a decision. Both can be
 * true of one account and only one can be the answer: "go get the verification code" is something
 * the user CAN do, "you are restricted" is not, and there is no appeal channel (owner
 * ⑤) — so verification-first would hand them an errand that changes nothing, a
 * true sentence used as a false next action. Pinned with an account that is
 * both (test/account-restriction.test.ts).
 *
 * 403, not 401: identity was proven. The reader is `deps.auth` — the SAME
 * AuthService the Bearer was verified with, one real `users` read per call, so
 * a restriction lifted a second ago is gone on the next request
 * (auth/account-restriction.ts explains why the JWT could not carry this).
 *
 * NOT applied to ① POST /api/logout, ② the password-reset family (both for the
 * reasons `refuseUnverified` already gives — a state you cannot sign out of or
 * recover from is a trap), ③ 🔴 GET /api/account/export and POST
 * /api/account/delete, which is the OWNER'S RULING and not an inherited
 * precedent: "the user may clear their own data and delete their account at will". Re-gating those two must overturn
 * the pin in test/account-restriction.test.ts, not drift into it.
 *
 * ⚠️ CENSUS, STATED RATHER THAN IMPLIED: this gate covers the routes in THIS
 * FILE and nothing else. timeline-grants REST, the `kind:'web'` socket gates
 * and every phone path are NOT covered — open holes reported with the card.
 */
function refuseRestricted(res: ServerResponse, deps: ConsoleRoutesDeps, userId: string): boolean {
  // Q2 — ONE read that answers both "is it restricted" and "which sentence to say", and ONE builder
  // for the body. This file does not assemble the refusal itself, which is what
  // makes "the operator's free text ending up on the user's screen" impossible here rather than merely
  // avoided: the operator's note is in `ops_audit_log` and nothing in this
  // module can reach it.
  const verdict = restrictionVerdict(deps.auth, userId);
  if (verdict === null) return false;
  sendJson(res, 403, restrictionRefusalBody(verdict.reason));
  return true;
}

/**
 * `?limit=` for the two ledger reads — ONE parser, so /events and /orphans can
 * never disagree about what a legal limit is (two copies is how one surface
 * starts accepting what the other rejects — the same argument account-auth.ts
 * makes for `bearerToken`).
 *
 * fail-loud on junk rather than silently substituting the default: a caller that
 * asked for `limit=abc` and got 20 rows would believe it asked for 20.
 */
function parseLimit(url: string): { ok: true; limit: number } | { ok: false; message: string } {
  // The base is a throwaway: only the query is read, never the origin.
  const raw = new URL(url, 'http://console.invalid').searchParams.get('limit');
  if (raw === null) return { ok: true, limit: EVENTS_DEFAULT_LIMIT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > EVENTS_MAX_LIMIT) {
    return { ok: false, message: `limit must be an integer in 1..${EVENTS_MAX_LIMIT}` };
  }
  return { ok: true, limit: n };
}

/** Handle the saas console REST routes. Returns true iff it owned the request. */
export function tryHandleConsoleRoutes(req: IncomingMessage, res: ServerResponse, deps: ConsoleRoutesDeps): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;

  // ── ① POST /api/logout — an ACKNOWLEDGEMENT, never a revocation ───────────
  // What this route DOES: answer 200 {ok:true} so the caller knows the server
  // RECEIVED the sign-out. That is the whole of it, and `{ok:true}` may only
  // ever be read as "received".
  // What it does NOT do, and must never be worded as: invalidate anything. The
  // account JWT is stateless (HS256, 7-day TTL — auth/jwt.ts DEFAULT_TTL_MS; no
  // session table, no jti denylist), so the very token the caller just "logged out"
  // KEEPS WORKING until its own exp; the only thing that ends is the client's
  // copy of it. console-routes.test.ts proves that survival against a live
  // token rather than leaving it as prose.
  // Real revocation is W4-4 (jti denylist + short-lived tokens), deferred by
  // owner ruling A5-4 (docs/decisions/2026-07-30-a5-owner-rulings.md ④: fix the
  // honesty now, decide revocation after the H5 security assessment). Nothing
  // here is named revoke/invalidate on purpose — a revocation-shaped name is how
  // a NOOP starts getting believed.
  // No auth required: signing out with an already-dead/absent token is a valid
  // no-op, and demanding a valid one would make an expired session impossible
  // to sign out of.
  if (url === '/api/logout' && method === 'POST') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  // ── ② POST /api/password/{forgot,reset} — DELEGATED (card MAIL-1) ─────────
  //
  // The bodies moved VERBATIM to http/password-reset-routes.ts (its header says
  // why); this line is what keeps them mounted, on the same saas-only path and
  // in the same order as before. `deps` is passed WHOLE rather than re-projected
  // into a fresh literal: `PasswordResetRoutesDeps` is a structural subset of
  // this file's own deps, so there is exactly one dependency list and no second
  // copy of it that could start disagreeing about which limiter or which clock
  // the reset surface uses.
  if (tryHandlePasswordResetRoutes(req, res, deps)) return true;

  // ── ③ GET /api/cloud/summary — usage / quota / device counts ──────────────
  if (url === '/api/cloud/summary' && method === 'GET') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true; // A2-3 (outranks the gate below)
    if (refuseUnverified(res, deps, who.userId)) return true; // VERIFY-1 D3 (feature gate)
    // v0.2.3 — the SAME 「what is a real PC」 the quota uses (registry.isRealPc).
    // This used to be the raw list, so the virtual cloud-instance row counted as
    // a machine and the card read "PC 2" for a user with one PC. Mobiles are
    // counted THROUGH their owning PC, so excluding the virtual row here also
    // excludes its auto-pairing — which is what the quota already does, and the
    // two numbers must not be able to disagree.
    const pcs = deps.pcs.listByUser(who.userId).filter(isRealPc);
    const mobileCount = pcs.reduce((n, pc) => n + deps.mobiles.listByPc(pc.id).length, 0);
    // 🔴 0.2.49 (owner 2026-08-02, PC instance limit 2/3/10): the LIMITS ride along with the
    // COUNTS, out of the SAME solver room/registry.ts enforces with
    // (`billing.effectiveLimits`). registry.ts:82 already logs the rule this
    // obeys — "the count and the limit must share one source, no drifting allowed" — and it was written after the console
    // and the quota path disagreed about what a PC even is.
    //
    // ⚠️ Why the console must be TOLD rather than left to look it up: the tier
    // name does NOT determine the number for an exempt account (`permanent_free`
    // resolves to plan 'free' while getting the MAX tier's 10 machines — owner
    // 2026-08-07, see BillingService.EXEMPT_LIMITS), so a browser deriving
    // 「free ⇒ 2」 would print a ceiling owner is not subject to. That is the D1
    // §6.1-bis hole in a different window.
    // ⚠️ 2026-08-07: this said 「with ∞ machines」 until owner capped the exemption
    // at max. The ARGUMENT is unchanged and if anything sharper — the number is
    // now 10 rather than ∞, i.e. a plausible-looking figure that a browser
    // deriving it from the tier name would still get wrong.
    //
    // ⚠️ ∞ crosses the wire as `null`, not `Infinity`: JSON.stringify turns
    // Infinity into `null` ANYWAY, so writing it any other way would just mean the
    // client sees a value the server never intended. Named here so the web side
    // can read `null` as "unlimited" on purpose rather than as "the field went missing".
    //
    // ONE call, not a loop (M2-8: `effectiveLimits`/`getPlan` mirror into
    // users.plan on the way through — fine per request, a defect per row).
    const limits = deps.billing.effectiveLimits(who.userId);
    const finiteOrNull = (n: number): number | null => (Number.isFinite(n) ? n : null);
    sendJson(res, 200, {
      plan: deps.billing.getPlan(who.userId),
      quota: deps.billing.getQuota(who.userId),
      devices: {
        pc_count: pcs.length,
        mobile_count: mobileCount,
        pc_limit: finiteOrNull(limits.pcs),
        mobile_limit: finiteOrNull(limits.mobiles),
      },
    });
    return true;
  }

  // ── ③ GET /api/cloud/subscription — the plan read-out ─────────────────────
  // Shape UNCHANGED (`{ subscription: PlanView }`); D1 §6.1 only widened PlanView
  // additively (source / quota_exempt / paddle_subscription_id). The body has
  // always been an OBJECT — the web console declared it as a string and rendered
  // every account as Free for it (D1 §2); that is fixed on the console side, and
  // this route is deliberately NOT bent into a string to accommodate the bug.
  if (url === '/api/cloud/subscription' && method === 'GET') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true; // A2-3 (outranks the gate below)
    if (refuseUnverified(res, deps, who.userId)) return true; // VERIFY-1 D3 (feature gate)
    sendJson(res, 200, { subscription: deps.billing.getPlan(who.userId) });
    return true;
  }

  // ── ③ GET /api/cloud/billing/events?limit=20 — the reconciliation ledger ──
  //
  // "which Paddle events this account has recently received, and what happened
  // to each one" (D1 §6.2). This is the
  // surface that makes "shows upgraded but the server side never took effect" diagnosable instead of a
  // mystery: an `unmapped` row names the price_id nobody configured, a `stale`
  // row says a delivery arrived out of order, a row stuck at `pending` says a
  // process died mid-handler.
  //
  // 🔴 OWN ROWS ONLY. The user id fed to the repo is the one the Bearer PROVED
  // (accountFromBearer → verified `sub`), never anything the caller supplied —
  // there is no user_id query parameter to forge, by construction. The ledger
  // holds who paid what and when; leaking another account's rows would be a real
  // breach, so the reverse-control test in console-routes.test.ts pins it.
  // Matched on the exact path (with or without a query), NOT `startsWith` alone —
  // a bare prefix test would also claim `/api/cloud/billing/eventsomething`.
  if (method === 'GET' && (url === '/api/cloud/billing/events' || url.startsWith('/api/cloud/billing/events?'))) {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true; // A2-3 (outranks the gate below)
    if (refuseUnverified(res, deps, who.userId)) return true; // VERIFY-1 D3 (feature gate)
    const parsed = parseLimit(url);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: parsed.message });
      return true;
    }
    sendJson(res, 200, { events: deps.billingLedger.listEventsForUser(who.userId, parsed.limit) });
    return true;
  }

  // ── 0.2.38 GET /api/cloud/billing/orphans?limit=20 — ops surface: orphan events ────────
  //
  // "whether there's any webhook we accepted but never finished resolving, or
  // didn't know who to credit it to". This is the reader
  // that makes `OUTCOME_PENDING`'s documented promise true (see the rule-④ note at
  // that constant): those rows carry `user_id IS NULL`, so /billing/events —
  // whose whole contract is "only ever returns your own rows" — can never show one, no matter which
  // account asks. Without this route the two most alarming ledger states existed
  // only inside SQLite.
  //
  // 🔴 ADMIN ONLY, AND THE REFUSAL IS NAMED. It reads ACROSS accounts by design,
  // so a normal Bearer gets 403 ADMIN_ONLY — never a 200 with an empty list. An
  // empty list would answer "reconciliation is clean" to someone who was actually being turned
  // away, which is the same defect as answering "you have no billing events" to an
  // anonymous caller (pinned two routes up).
  //
  // ⚠️ The rows can name OTHER users' subscription/user ids, which is exactly why
  // is_admin gates it: this is the one console read where "only ever returns your own rows" would
  // defeat the purpose instead of protecting anyone.
  //
  // ⚠️ WHERE DOES is_admin COME FROM? (The decision itself lives in
  // http/account-auth.ts `adminFromBearer` since 0.2.47 — this is the one route
  // that uses it.) Nowhere in this codebase — grep it: the only
  // WRITER is `UserRepo.insert({is_admin})`, and `AuthService.register` never
  // passes it, so EVERY account created through the product is `is_admin = 0` and
  // this route answers 403 to all of them today. That is deliberate, not an
  // oversight to be "fixed" with a self-service grant: the bit is meant to be set
  // out-of-band by whoever has the VPS (`UPDATE users SET is_admin=1 WHERE
  // email=…`), because an in-product path to grant yourself cross-account read
  // would defeat the gate it opens. Stated here because the honest status of this
  // route is "wired up + proven by unit tests + in production nobody can pass through it yet" — anyone expecting to open
  // it after a deploy needs to know why it refuses them.
  if (method === 'GET' && (url === '/api/cloud/billing/orphans' || url.startsWith('/api/cloud/billing/orphans?'))) {
    const who = authAdmin(req, deps, 'GET /api/cloud/billing/orphans');
    if (!who.ok) {
      sendJson(res, who.status, { error: who.error });
      return true;
    }
    // VERIFY-1 D3 — after the admin verdict on purpose: an anonymous caller
    // still gets the 401 above, a non-admin the 403 ADMIN_ONLY, and only a
    // real admin can even learn this surface carries the verification gate.
    // (In practice an admin is grandfathered or long verified; uniformity is
    // cheaper than an exemption nobody argued for.)
    // A2-3 — same position, same uniformity argument. UNREACHABLE today (the
    // restriction route refuses to restrict a platform account at all), written
    // anyway: that is a fact about ANOTHER file, and a route left ungated
    // because of one is one ruling away from being wrong.
    if (refuseRestricted(res, deps, who.userId)) return true;
    if (refuseUnverified(res, deps, who.userId)) return true;
    const parsed = parseLimit(url);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: parsed.message });
      return true;
    }
    sendJson(res, 200, { orphans: deps.billingLedger.listOrphanEvents(parsed.limit) });
    return true;
  }

  // ── ④ GET /api/cloud/devices — list pc_devices + mobile_pairings ──────────
  // Public projection only — device_token / mobile_token NEVER cross the wire.
  // The virtual "cloud-instance" PC row (client_instance_id: 'flowmic-cloud-instance')
  // is listed honestly like any other; the console tells it apart by that id.
  // is_online is the DB-persisted flag (real-time socket presence is open item #3,
  // deferred to a later read-only socket subscription).
  if (url === '/api/cloud/devices' && method === 'GET') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true; // A2-3 (outranks the gate below)
    if (refuseUnverified(res, deps, who.userId)) return true; // VERIFY-1 D3 (feature gate)
    const pcs = deps.pcs.listByUser(who.userId);
    const pc_devices = pcs.map((pc) => ({
      pc_id: pc.id,
      device_name: pc.device_name,
      client_instance_id: pc.client_instance_id,
      // v0.2.4 — the machine, not the connection slot. The console lists rows
      // from every channel side by side, so it is the one surface where "these two
      // rows are the same machine" is otherwise impossible to see.
      machine_uid: pc.machine_uid,
      is_online: pc.is_online === 1,
      last_seen_at: pc.last_seen_at,
      created_at: pc.created_at,
    }));
    const mobile_pairings = pcs.flatMap((pc) =>
      deps.mobiles.listByPc(pc.id).map((m) => ({
        pairing_id: m.id,
        pc_id: m.pc_device_id,
        mobile_name: m.mobile_name,
        device_uid: m.device_uid,
        paired_at: m.paired_at,
        last_seen_at: m.last_seen_at,
      })),
    );
    sendJson(res, 200, { pc_devices, mobile_pairings });
    return true;
  }

  // ── WP-W1b BYOK editor + TEST — delegated ────────────────────────────────
  // Bodies live in http/byok-routes.ts (empty-on-register, enable switch,
  // server-side probe). Mounted here so saas-only gating and the two feature
  // gates stay in the same call order as every other console feature route.
  if (tryHandleByokRoutes(req, res, deps)) return true;

  // ── GET /api/cloud/history was DELETED on 2026-07-31 (0.2.27) ─────────────
  //
  // owner architecture ruling (docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md), asked
  // and answered explicitly: "the web console cannot see transcript history — yes". The route read
  // `transcript_history`, which is dropped; its data source no longer exists.
  //
  // Removed rather than left answering an empty page: an empty transcript-history page reads
  // as "you never said anything", which would be a lie about rows that were deleted by policy.
  // Unknown paths fall through to this router's 404 — a response, not a silence —
  // and the console page itself goes down in the SAME round (card A3), so no shipped
  // surface points here. When MCP-shaped read access is designed (owner's point 5-①),
  // it reads the lightweight-record e2e store with an explicit grant; it does not resurrect
  // this route.

  // ── ④ POST /api/cloud/devices/revoke — revoke a single mobile pairing ─────
  // IDEMPOTENT: revoking a missing pairing (already gone / never existed / not
  // owned by the caller) returns ok:true, revoked:false — a truthful "nothing of
  // yours was revoked", NOT a silent failure, and NOT an existence oracle (a
  // pairing you don't own is indistinguishable from one that doesn't exist).
  // After a real revoke the mobile_pairings row is deleted, so that mobile_token
  // fails the middleware lookup on its next connect and every mobile:reconnect →
  // AUTH_TOKEN_INVALID (fail-loud). Revoking the cloud-instance pairing is safe:
  // the next admitCloudInstance find-or-creates it again — admission is intact.
  if (url === '/api/cloud/devices/revoke' && method === 'POST') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true; // A2-3 (outranks the gate below)
    if (refuseUnverified(res, deps, who.userId)) return true; // VERIFY-1 D3 (feature gate)
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const pairingId = str(body.pairing_id);
      if (pairingId === '') return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: 'pairing_id required' });
      const mobile = deps.mobiles.findById(pairingId);
      const pc = mobile ? deps.pcs.findById(mobile.pc_device_id) : null;
      const owned = !!mobile && !!pc && pc.user_id === who.userId;
      if (owned) deps.mobiles.remove(pairingId);
      sendJson(res, 200, { ok: true, revoked: owned });
    })();
    return true;
  }

  // ── 0.3.0 P4 GET /api/account/export + POST /api/account/delete — DELEGATED ─
  //
  // The bodies moved VERBATIM to http/account-lifecycle-routes.ts (its header
  // says why — this file stood at 784 of the 800-line cap); this line is what
  // keeps them mounted, on the same saas-only path and in the same position as
  // before. `deps` is passed WHOLE rather than re-projected into a fresh
  // literal, for the reason the password-reset delegation two hundred lines up
  // gives: `AccountLifecycleRoutesDeps` is a structural subset of this file's
  // own deps, so there is exactly one dependency list and no second copy that
  // could start disagreeing about which repos or which clock those two routes
  // use.
  //
  // 🔴 LAST, and the position is the one thing about this delegation that is not
  // cosmetic: both routes are exempt from `refuseUnverified` AND from
  // `refuseRestricted`, so putting them ahead of the gated routes above would
  // change nothing today and would be the natural place for a future reader to
  // 「tidy」 a gate into. They sit where they sat.
  if (tryHandleAccountLifecycleRoutes(req, res, deps)) return true;
  // Signed-in password change. Same LAST-position reason as export/delete:
  // exempt from refuseUnverified / refuseRestricted. A future reader who
  // 「tidies」 a gate onto this call is re-gating a credential-hygiene route.
  if (tryHandleAccountPasswordRoutes(req, res, deps)) return true;

  return false;
}
