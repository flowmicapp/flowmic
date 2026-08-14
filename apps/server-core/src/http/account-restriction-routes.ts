// SPEC-REF:
//   docs/strategy/2026-08-12-a2-3-restricted-use-design.md §3.2 (route shape),
//     §3.3 (C1/C2/C3 guards), §8.1 (the three warnings this route detonates)
//   docs/decisions/owner-web-rulings/latest.md:71 (owner's wording)
//   src/auth/account-restriction.ts (what a restriction IS — read that first)
//   src/http/ops-audit-trail.ts `adminGate` (the gate + its route-level row)
//   src/db/schema.ts `-- 10. ops_audit_log` (why a business row exists at all)
//   CLAUDE.md red line: no silent failure / one value answers only one question / anti-façade
//   *** HUMAN-AUDIT SENSITIVE (auth + DB write + operator accountability) ***
//
// POST /api/ops/users/restrict — 🔴 THE FIRST ADMIN-GATED ROUTE IN THIS REPO
// THAT CHANGES ANYTHING.
//
// ── WHY IT IS ITS OWN FILE, TWICE OVER ──────────────────────────────────────
// NOT in console-routes.ts: that surface answers "my own stuff" and feeds every
// repo the id the Bearer PROVED, so a forged target is not refused there — it is
// unrepresentable. This route takes a `user_id` from the body and acts on
// SOMEBODY ELSE. Those are opposite trust models, and ops-routes.ts's header
// already argues that mixing them changes a reviewer's question from "should
// this route cross accounts" to "does this route look like the one above it".
// NOT in ops-routes.ts either, and this one matters more: that file's header
// states, as a STRUCTURAL property, that it "NEVER IMPORTS `UserRepo` and has no
// path to a `UserRecord`" — that is how M2-7 (listAll returns password_hash) is
// defused there, by unreachability rather than by care. Adding a user-writing
// dep to it would delete that property for every route in it. So the write
// lives here, holding a two-method slice and nothing else.
//
// ── 🔴 THE FAILURE POLICY, RE-ARGUED AS ops-audit-trail.ts DEMANDED ─────────
// That module chose "serve the request, shout about the failed audit write" and
// bounded the choice explicitly: "EVERY ENTRY IS A `GET` TODAY … THE MOMENT AN
// ADMIN-GATED ROUTE MUTATES, THIS POLICY MUST BE RE-ARGUED", because an
// unrecorded *change* is a different animal from an unrecorded *read*. This is
// that moment, and the answer for THIS route is the other one:
//
//   the BUSINESS row is written FIRST, and if it cannot be written the account
//   is NOT touched (503 RESTRICT_NOT_RECORDED).
//
// The gate row keeps its own (b) policy — that decision belongs to the five
// GET routes it also serves and this card does not get to change it by side
// effect — so the composite behaviour is: an unwritable trail still lets
// operators LOOK, and stops them from CHANGING. Both halves are what those two
// files each argued for.
//
// ⚠️ THE RESIDUAL RISK, STATED SO NOBODY DISCOVERS IT: append-then-write means a
// row can exist for an UPDATE that then failed at the SQLite layer. That is the
// safe direction (the trail may over-report a change, never under-report one)
// and the caller is told by a 5xx rather than a 200, so "the row says restricted
// but the column is NULL" is always accompanied by a failed request. The
// alternative — write-then-append — produces the state ops-audit-trail.ts
// forbids: a change nobody recorded, reported to the operator as success.
//
// ── WHAT THIS ROUTE DOES NOT DO ─────────────────────────────────────────────
// It does not disconnect anything. owner ruled `passive_only`, so a restriction
// bites on the next HTTP request (every Bearer call re-reads the row) and NOT on
// sockets that are already up — a phone that is paired and connected keeps
// working until that socket drops for some other reason. There is no upper
// bound on that. Any operator UI built on this route must say so; this route
// cannot say it for them, because it is a fact about the socket layer, not about
// the row it just wrote.
// It also does not delete, downgrade, exempt or promote: the SET list is one
// column (db/repos/user.repo.ts `setRestricted`).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRestrictionReason, RESTRICTION_REASON_KEYS } from '@flowmic/protocol';
import type { UserRepo } from '../db/repos/user.repo';
import { isPlatformAccount } from '../db/repos/user.repo';
import type { AccountVerifier } from './account-auth';
import { adminGate, type OpsAuditSink } from './ops-audit-trail';
import { readJsonBody, sendJson, str } from './console-http';
import { log } from '../log';

/** The one route literal this module serves. Written out here AND inline in the
 *  `if` condition below: the coverage guard (test/console-admin-gate-coverage
 *  .test.ts) derives what this file serves by reading the source for `'/api/…'`
 *  literals inside conditions, so a path assembled from a constant would be
 *  INVISIBLE to the one check that catches "a newly added ops route that forgot
 *  to add the gate". */
export const RESTRICT_ROUTE = 'POST /api/ops/users/restrict';

/** `<domain>.<object>.<verb>` per the DDL. TWO actions, because "restrict" and
 *  "unrestrict" are two different things that happened, and a single
 *  `ops.user.restriction.set` row would make "list all restriction actions"
 *  depend on parsing `detail` — a value answering a second question. */
export const RESTRICT_ACTION = 'ops.user.restrict';
export const UNRESTRICT_ACTION = 'ops.user.unrestrict';
/** `target_kind` for both. The DDL keeps kind and id in TWO columns so that
 *  "list all actions against an account" is an equality match, not a LIKE prefix. */
export const RESTRICT_TARGET_KIND = 'user';

/** Longest `reason` this route will store. REFUSED, never truncated: a
 *  half-stored justification is a worse audit record than a rejected one, and
 *  the operator is the only person who can shorten it correctly. */
export const RESTRICT_REASON_MAX = 500;

// ── HTTP-LOCAL refusal strings ──────────────────────────────────────────────
//
// Same precedent and same boundary as `ACCOUNT_RESTRICTED`
// (auth/account-restriction.ts, which carries the full argument): these are
// HTTP-local strings, NOT protocol `ErrorCode`s, because the only client that
// can ever receive them is the repo-owned ADMIN console — they are operator
// diagnostics on a VPN-only surface and no phone, desktop or end-user browser
// can reach this route at all. Minting protocol codes is owner-gated;
// test/account-restriction.test.ts pins all three out of `ERROR_CODES`.
//
// 🔴 Three strings and not one, because they demand three different operator
// actions: retype the id / go get owner (or a psql prompt) / fix the database.
// A single `RESTRICT_FAILED` would be one value answering three questions.

/** `user_id` is well-formed but names no account. */
export const RESTRICT_TARGET_UNKNOWN = 'RESTRICT_TARGET_UNKNOWN';
/** The target is a PLATFORM account (`is_admin` or `permanent_free`). */
export const RESTRICT_TARGET_PROTECTED = 'RESTRICT_TARGET_PROTECTED';
/** The audit row could not be written, so nothing was changed. */
export const RESTRICT_NOT_RECORDED = 'RESTRICT_NOT_RECORDED';

export interface AccountRestrictionRoutesDeps {
  /** The account verifier for the admin gate — the SAME `AuthService` instance
   *  every other http surface uses, sliced to the two methods the gate needs. */
  auth: AccountVerifier;
  /**
   * 🔴 A TWO-METHOD SLICE OF `UserRepo`, AND THE NARROWNESS IS THE FEATURE
   * (design §8.1-③, the shape ops-routes.ts uses for `UsageRepo`). The full repo
   * also carries `remove` (destroys an account and cascades eight tables) and
   * `setPlan` (moves a tier — owner ruled the ops console changing tiers is "not
   * for now"). Handing the whole
   * object to a moderation route would put both in reach of a body-driven
   * `user_id`, which is a loaded gun with no reason to be in the room.
   * bootstrap passes `db.users`; the slice is enforced HERE, on the consumer.
   */
  users: Pick<UserRepo, 'findById' | 'setRestricted'>;
  /** Where BOTH rows go — the gate's route-level row and this route's business
   *  row. REQUIRED, no `?` and no default (volume-13 §7 F1 ②): an optional sink would
   *  mean a bootstrap missing one line still restricts accounts, untraceably,
   *  with nothing red and no new symbol to grep. */
  audit: OpsAuditSink;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
}

/** A body field as a strict boolean — `'true'`, `1` and `'yes'` are NOT values
 *  to salvage. A coercion here would let `restricted: "false"` (truthy in JS)
 *  restrict an account the operator meant to release: the storage-face bug this
 *  repo has already shipped once (`permanent_free` as TEXT). */
function strictBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function refuseBadRequest(res: ServerResponse, message: string): void {
  // `SETTINGS_SCHEMA_INVALID` is an EXISTING protocol code and is already this
  // http family's malformed-body answer (console-routes.ts /devices/revoke,
  // ops-routes.ts parameter junk). The code table does not move.
  sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message });
}

/** Handle the saas restriction write route. Returns true iff it owned the
 *  request. */
export function tryHandleAccountRestrictionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountRestrictionRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;

  // ── POST /api/ops/users/restrict — set or clear "usage restricted" ─────────
  //
  // ONE route, BOTH directions (`restricted: true|false`). Two routes would give
  // "what state is this account in now" two writers, and two writers is how they disagree.
  //
  // No batch form, deliberately: the blast radius of a mis-typed bulk moderation
  // action is not the same order of magnitude as a single one.
  if (method === 'POST' && url === '/api/ops/users/restrict') {
    // The gate FIRST, before a single byte of the body is parsed: no branch of
    // this route may be reachable by someone who has proved nothing.
    //
    // ⚠️ NO verified-email gate here, and that is the `/api/ops/…` family's
    // existing posture rather than an omission — none of the four routes in
    // ops-routes.ts carries one either (only the `/api/cloud/…` surface does).
    // Adding one to this route alone would make the ops surface answer two
    // different refusals for the same operator on the same afternoon.
    //
    // 🔴 THE ELLIPSES ABOVE ARE NOT A TYPO. Writing `/api/ops/` + a star inside
    // a `//` comment opens a block comment as far as the CRUDE comment stripper
    // in test/console-admin-gate-coverage.test.ts and test/ops-audit-wiring
    // .test.ts is concerned — it removes `/* … */` from the RAW text before it
    // drops `//` lines — so everything from here to the next close marker is
    // deleted from what those guards read, INCLUDING this file's route
    // condition. Measured on this file, 2026-08-12: a star-form comment here
    // swallowed lines 174-249 and made the audit-ordering guard pass on code
    // that violated it. Their shared header claims the stripper "can only ever
    // ADD spurious matches … never delete a real one"; that sentence is false,
    // and `src/http/ops-routes.ts` carries the same live hazard today, in its
    // own file-header title line (reported with this card, not fixed here — it
    // is not this card's file). ⚠️ NAMED BY SYMBOL, NOT BY LINE: a line number
    // here is exactly the citation the coordinate-anchors gate refuses, and it
    // caught this comment's first draft on the way in.
    const who = adminGate(req, deps.auth, deps.audit, RESTRICT_ROUTE);
    if (!who.ok) {
      sendJson(res, who.status, { error: who.error });
      return true;
    }
    const actor = who.userId;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const targetId = str(body.user_id).trim();
      if (targetId === '') return refuseBadRequest(res, 'user_id required');
      const restricted = strictBool(body.restricted);
      if (restricted === null) return refuseBadRequest(res, 'restricted must be a boolean (true = restrict, false = release)');
      // REQUIRED, both directions. "Why was it lifted" matters as much as "why
      // was it imposed" —
      // an unexplained release is the half of the trail an audit actually needs.
      const reason = str(body.reason).trim();
      if (reason === '') return refuseBadRequest(res, 'reason required (it is the only thing the audit row can say about WHY)');
      if (reason.length > RESTRICT_REASON_MAX) {
        return refuseBadRequest(res, `reason must be at most ${RESTRICT_REASON_MAX} characters`);
      }
      // ── Q2: THE SECOND REASON, AND WHY THERE ARE TWO ─────────────────────
      //
      // owner 2026-08-12: "the enumerated reason is shown to the user; the
      // operator's free text goes only into the audit log". The field above is
      // the operator's NOTE — free text, one language, possibly naming another
      // account or an internal ticket. `reason_code` is what the ACCOUNT HOLDER
      // is shown, and it is a key from a closed, four-language, publishable set.
      //
      // 🔴 TWO FIELDS BECAUSE THERE ARE TWO QUESTIONS. The Terms already promise
      // "we will tell you why"; that promise cannot be kept with the note (it is
      // not written for the user and not translated) and it cannot be kept by
      // dropping the note (an audit trail with no free text records nothing an
      // operator actually knew). Merging them would be one value answering both
      // — and the direction it fails in is the worst available: an internal
      // sentence on a stranger's screen.
      //
      // REQUIRED WHEN RESTRICTING, REFUSED WHEN RELEASING. A release has no
      // reason to show anybody — the notice is gone — so accepting one would
      // store a sentence that is never rendered and can only ever go stale.
      const rawCode = str(body.reason_code).trim();
      if (restricted) {
        if (rawCode === '') {
          return refuseBadRequest(
            res,
            `reason_code required when restricting (one of: ${RESTRICTION_REASON_KEYS.join(', ')}) — `
            + 'it is what the account holder is shown; `reason` is the operator note and never reaches them',
          );
        }
        // 🔴 A REAL MEMBERSHIP TEST, not a cast. It is the one place an untrusted
        // string could become a user-visible reason, so it is checked HERE
        // rather than trusted from the console — and refused by name, listing
        // the legal values, because "what you gave isn't in the table" and "you
        // gave nothing" are two
        // different operator mistakes.
        if (!isRestrictionReason(rawCode)) {
          return refuseBadRequest(res, `reason_code must be one of: ${RESTRICTION_REASON_KEYS.join(', ')}`);
        }
      } else if (rawCode !== '') {
        return refuseBadRequest(res, 'reason_code must not be sent when releasing (there is no notice to show)');
      }
      const reasonCode = restricted && isRestrictionReason(rawCode) ? rawCode : null;

      const target = deps.users.findById(targetId);
      // 🔴 404, NOT the 400 above, and NOT an idempotent "ok:true, changed:false".
      // The caller is a proven admin who can already enumerate accounts through
      // /api/ops/usage/users, so answering honestly leaks nothing — while a
      // cheerful 200 for a typo'd id would tell an operator they had restricted
      // somebody when they had restricted nobody. That is the exact "claiming
      // something was done" half of no-silent-failure.
      if (!target) {
        sendJson(res, 404, { error: RESTRICT_TARGET_UNKNOWN, message: 'user_id names no account' });
        return;
      }
      // 🔴 C1+C2 — a platform account (`is_admin` OR `permanent_free`) cannot be
      // restricted from this surface. `isPlatformAccount` is reused rather than
      // reading `is_admin` here; db/repos/user.repo.ts carries the full argument
      // for why a fourth reader of that column would be wrong, and what the OR
      // costs. Note this also subsumes "must not be able to restrict oneself"
      // structurally: only an
      // admin reaches this line, and every admin IS a platform account — so a
      // self-target can never get past it. The design listed C1 and C2 as two
      // guards; here C2 makes C1 unrepresentable, which is the stronger form.
      if (isPlatformAccount(target)) {
        sendJson(res, 409, {
          error: RESTRICT_TARGET_PROTECTED,
          message: 'this is a platform account (admin or permanently exempt); it cannot be restricted from the console',
        });
        return;
      }

      const alreadyRestricted = target.restricted_at !== null;
      // 🔴 IDEMPOTENT, AND THE NO-OP WRITES NEITHER THE COLUMN NOR A ROW.
      // Not the column: overwriting `restricted_at` would erase "when it was
      // first restricted", which is the only thing the timestamp is for.
      // Not a row: this file's business actions are named `ops.user.restrict` /
      // `ops.user.unrestrict`, i.e. each row ASSERTS that the state changed.
      // Appending one for a no-op would put a change in the trail that never
      // happened. The attempt is not lost — `adminGate` already recorded "this
      // admin called this route" one row up, which is exactly the division of
      // labour ops-audit-trail.ts describes (the gate does not know what a route
      // MEANS; a route that wants a business row appends its own).
      if (alreadyRestricted === restricted) {
        sendJson(res, 200, {
          ok: true,
          user_id: target.id,
          restricted,
          restricted_at: target.restricted_at,
          changed: false,
        });
        return;
      }

      const at = restricted ? now() : null;
      // ── the fail-closed half (see this file's header) ──────────────────────
      try {
        deps.audit.append({
          actor_user_id: actor,
          action: restricted ? RESTRICT_ACTION : UNRESTRICT_ACTION,
          target_kind: RESTRICT_TARGET_KIND,
          target_id: target.id,
          // The operator's own sentence, and nothing the request otherwise
          // carried. The DDL's rule — "detail holds only a sentence we wrote
          // ourselves, never the raw request body" — is about not spilling a
          // body into the table; a `reason`
          // field EXISTS to be the recorded justification, so it is the one
          // caller-supplied value that belongs here. Length-capped above so it
          // cannot become a body dump by another name.
          detail: reason,
        });
      } catch (err) {
        // 🔴 The account is NOT touched. This is the (a) branch ops-audit-trail
        // .ts's `recordGateOutcome` deliberately did not take for its GETs, and
        // its own comment says why the argument expires here.
        log.error('ops: REFUSING to change a restriction — the audit row could not be written', {
          route: RESTRICT_ROUTE,
          actor,
          target: target.id,
          intent: restricted ? RESTRICT_ACTION : UNRESTRICT_ACTION,
          reason: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 503, {
          error: RESTRICT_NOT_RECORDED,
          message: 'the operations audit row could not be written, so the account was left unchanged',
        });
        return;
      }
      // Q2 — the timestamp and the shown reason move TOGETHER, in one statement
      // (db/repos/user.repo.ts). A release passes `null` for both, so no stale
      // sentence can survive to be attached to a LATER restriction.
      deps.users.setRestricted(target.id, at, reasonCode);
      // A second, human-readable trace beside the row — the deletion route sets
      // the precedent for logging an irreversible-looking account action at WARN
      // with the id and never the email.
      log.warn('ops: account restriction changed', {
        actor,
        target: target.id,
        restricted,
      });
      sendJson(res, 200, {
        ok: true,
        user_id: target.id,
        restricted,
        restricted_at: at,
        // Q2 — echoed so the operator console can show WHAT THE USER WILL SEE
        // without re-deriving it. 🔴 The free-text `reason` is deliberately NOT
        // echoed: it went into the audit row, and a response that carried it
        // back would put it one copy-paste away from a user-facing surface.
        restriction_reason: reasonCode,
        changed: true,
      });
    })();
    return true;
  }

  // Anything else under this prefix falls through to the router's 404 — the same
  // "no 405 for a known path" posture ops-routes.ts states: a 405 would tell an
  // anonymous caller which ops paths exist before the gate can refuse them.
  return false;
}
