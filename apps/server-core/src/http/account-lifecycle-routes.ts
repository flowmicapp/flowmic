// SPEC-REF:
//   docs/legal/privacy-policy.md 「Your rights」 (see / export / delete)
//   docs/legal/terms-of-service.md 「You may close your account at any time」
//   src/http/account-lifecycle.ts (WHAT an export may contain and what a
//     deletion destroys — the policy lives there, not here)
//   src/http/console-routes.ts (the surface this was split out of; it still
//     MOUNTS these two routes, so the saas-only gating is unchanged)
//   *** HUMAN-AUDIT SENSITIVE (auth + irreversible account deletion) ***
//
// GET /api/account/export + POST /api/account/delete — the two DATA-SUBJECT
// RIGHTS routes.
//
// ── WHY A FILE OF ITS OWN ───────────────────────────────────────────────────
// `console-routes.ts` stood at 784 of the 800-line cap (verify/lint/
// file-size.mjs), so this is the `password-reset-routes.ts` remedy applied a
// second time: the two handler bodies moved VERBATIM, comment for comment, and
// console-routes.ts delegates to `tryHandleAccountLifecycleRoutes` in the exact
// position they used to occupy. Nothing about the trust model, the mounting or
// the response bodies changed.
//
// 🔴 THE ONE PROPERTY THAT MUST SURVIVE THE MOVE, stated because a split is
// exactly when it gets lost: BOTH routes are DELIBERATELY EXEMPT from the
// verified-email gate AND from the A2-3 restriction gate. Those two exemptions
// are pinned by test/email-verification.test.ts and
// test/account-restriction.test.ts respectively, and the second one is owner's
// own wording ("the user may clear their own data and close their account at
// will" — 用户可自行清除数据和注销账号). A future card re-gating either
// must overturn those pins, not drift into them — which is why the argument
// travelled with the code rather than being left behind in the old file.
//
// ⚠️ THIS FILE IS IN `ROUTE_SOURCES` (test/console-admin-gate-coverage.test.ts).
// Adding it there is part of shipping it: a route in a file the scanner is not
// reading is invisible to the one check that catches "a newly-added route
// forgot the gate" (新加的路由忘了闸).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../auth/auth-service';
import {
  buildAccountExport,
  checkDeleteConfirmation,
  deleteAccount,
  type AccountDeleteStores,
  type AccountExportStores,
} from './account-lifecycle';
import { accountUserFromBearer, type AccountUserVerdict } from './account-auth';
import { readJsonBody, sendJson } from './console-http';
import { log } from '../log';
import { errorPayload } from '../errors';

/**
 * What these two routes need — a STRUCTURAL SUBSET of `ConsoleRoutesDeps`, in
 * the `PasswordResetRoutesDeps` shape and for the same reason: console-routes.ts
 * hands its whole deps object over, so there is exactly ONE dependency list and
 * no second copy that could start disagreeing about which repos or which clock
 * the account-lifecycle surface uses.
 *
 * The two store slices come from `account-lifecycle.ts` itself rather than being
 * re-listed here — that module owns 「what an export reads」 and 「what a deletion
 * removes」, and a second hand-written copy of those lists is how one of them
 * forgets a table.
 */
export interface AccountLifecycleRoutesDeps extends AccountExportStores, AccountDeleteStores {
  auth: AuthService;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
}

/** 0.3.0 P4 — the SAME Bearer decision every other console route makes,
 *  returning the whole verified ROW. Moved with its two callers: the export
 *  projects the row (never `password_hash`) and the delete guard asks whether it
 *  carries a platform bit, so both need more than the id. It adds NOTHING to
 *  `accountFromBearer`'s decision — both are `accountUserFromBearer` underneath,
 *  so no surface here can start admitting what another rejects. */
function authUserRow(req: IncomingMessage, deps: AccountLifecycleRoutesDeps): AccountUserVerdict {
  return accountUserFromBearer(req, deps.auth);
}

// ⚠️ THE TWO PATHS BELOW ARE WRITTEN OUT AS LITERALS in their `if` conditions,
// exactly as they were in console-routes.ts. The route-coverage guard
// (test/console-admin-gate-coverage.test.ts) derives the routes THIS FILE SERVES
// by reading this source and pulling `'/api/…'` literals out of the conditions
// it matches on. A path assembled from a constant is INVISIBLE to it.

/** Handle the saas account-lifecycle routes. Returns true iff it owned the
 *  request. */
export function tryHandleAccountLifecycleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AccountLifecycleRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;

  // ── 0.3.0 P4 GET /api/account/export — 「see what we hold」 + 「export it」 ────
  //
  // docs/legal/privacy-policy.md tells every user they can 「export it in a
  // portable format」. Until this route that sentence had no implementation: the
  // FPR export (docs/rebuild vol. 16) is a LOCAL timeline export on the devices, which is a
  // different object entirely — it never carried the account, the devices, the
  // settings or the usage rows this file's other GETs read.
  //
  // 🔴 THE SHAPE, AND EVERY EXCLUSION IN IT, IS ARGUED IN http/account-lifecycle.ts
  // (`buildAccountExport`), not here: what a downloadable file may contain is a
  // policy decision that has to be readable without an HTTP request in hand. This
  // route's whole job is 「prove the Bearer, hand the proven ROW to the builder」.
  //
  // OWN ACCOUNT ONLY, by construction: the builder takes the verified `user` row,
  // and there is no user_id parameter anywhere on this path to forge.
  if (url === '/api/account/export' && method === 'GET') {
    const who = authUserRow(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    // VERIFY-1 D3 — DELIBERATELY NOT GATED (lead ruling on review,
    // 2026-08-11): export/delete are data-subject rights, and the one account
    // that most needs them is exactly the one that cannot verify (mailbox
    // unreachable, mistyped address). A verification gate here would convert
    // "my mailbox can't receive the code" (我的邮箱收不到码) into "I can't even get
  // my own data back, and I can't close my account either"
  // (我连自己的数据都拿不回来、账号也关不掉).
    // Identity is still required (the Bearer above); verification is not.
    // The exemption is pinned by the enforcement-matrix test alongside
    // /api/me — a future card re-gating this must overturn that pin, not
    // drift into it.
    // 🔴 A2-3 — DELIBERATELY NOT GATED EITHER, and here it is the OWNER'S OWN
    // WORDS rather than an inherited precedent: "the user may clear their own
    // data and close their account at will" (用户可自行清除数据和注销账号)
    // (latest.md:71). Export is the "clear data" (清除数据) half's prerequisite — the privacy
    // policy separately promises export to everyone — so a restriction that took
    // it away would turn a moderation decision into a data seizure.
    // 🔴 D2 Stage 0 (2026-08-05) — this used to call buildAccountExport() bare.
    // settings.readAll() decrypts every enc:v1: api_key field inline
    // (db/repos/settings.repo.ts toRow → walkDecrypt → auth/crypto.ts decrypt()),
    // and decrypt() THROWS on a GCM tag mismatch — the exact shape a wrong/rotated
    // deployment secret produces (docs/strategy/2026-08-05-d2-secret-domain-
    // separation-design-cn.md §1.3). Uncaught, that throw used to propagate through
    // this synchronous handler, through http/router.ts's makeHttpHandler (which also
    // has no catch around tryHandleConsoleRoutes), into bootstrap.ts's raw
    // createServer callback, to Node's uncaughtException — taking the whole process
    // down for every connected user over ONE account's undecryptable row. It is now
    // a scoped 500: the requesting caller gets a wire-safe error, the operator gets
    // a loud log line, and the process stays up. This is deliberately NOT a decrypt
    // retry or a re-encrypt — see §8-1/§8-2 of the design doc: a failed decrypt
    // must stay a failure, never silently become an empty value or a rewritten row.
    try {
      sendJson(res, 200, buildAccountExport(who.user, deps, now()));
    } catch (err) {
      log.error('console: GET /api/account/export failed — a settings field could not be decrypted', {
        user_id: who.user.id,
        message: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, errorPayload(err));
    }
    return true;
  }

  // ── 0.3.0 P4 POST /api/account/delete — 「close your account」, irreversibly ──
  //
  // docs/legal/terms-of-service.md:「You may close your account at any time from
  // the console」; the privacy policy states what that destroys. This is that.
  //
  // 🔴 AUTH FIRST, BODY SECOND, and the order is load-bearing rather than
  // stylistic: an anonymous caller must be refused BEFORE anything they sent is
  // parsed, so no branch of this route can ever be reached by someone who proved
  // nothing. The refusal reuses the surface's existing named shape (401 +
  // AUTH_TOKEN_INVALID / AUTH_TOKEN_EXPIRED) — no new error code.
  //
  // 🔴 THE TARGET IS ALWAYS THE PROVEN SUBJECT. There is no `user_id` in the
  // body's contract, so 「delete someone else」 is unrepresentable, not merely
  // rejected. `confirm_user_id` is a CONFIRMATION, never a selector: it must
  // EQUAL the account the Bearer proved, and a mismatch is a 400 that deletes
  // nothing (test/account-lifecycle.test.ts drives that with a second account's
  // token to be sure it is not a selector by accident).
  //
  // The 400 body carries a `message` naming the missing field, because "you're
  // missing a field" (你少给了一个字段) and "you are not allowed to delete"
  // (不许你删) are different answers and a bare code would collapse
  // them. `SETTINGS_SCHEMA_INVALID` is this file's existing malformed-body code
  // (see /password/*, /devices/revoke) — the 61-code table does not move.
  if (url === '/api/account/delete' && method === 'POST') {
    const who = authUserRow(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    // VERIFY-1 D3 — DELIBERATELY NOT GATED, same lead ruling as
    // /api/account/export above: deletion is the escape hatch for the very
    // account that cannot verify. Identity yes, verification no.
    // 🔴 A2-3 — NOT GATED, owner verbatim: "closing the account" (注销账号) stays
    // available under a restriction. A restricted account that cannot close
    // itself is a person
    // held in a product they were just told they may not use.
    const user = who.user;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const confirmed = checkDeleteConfirmation(body, user);
      if (!confirmed.ok) {
        return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: confirmed.message });
      }
      const result = deleteAccount(user.id, deps);
      // 🔴 THE ONLY RECORD THIS EVENT LEAVES. `ops_audit_log` has exactly one
      // production writer by design (the admin gate — test/ops-audit-wiring.test.ts
      // asserts it from the source tree) and a self-service deletion is not an
      // admin action, so this line is the trail. It carries the id and NOT the
      // email: keeping an address in a log file after erasing it from the database
      // would undo the erasure it is reporting.
      log.warn('console: ACCOUNT DELETED at the account holder\'s own request — irreversible', {
        user_id: user.id,
        deleted: result.deleted,
        cascaded: result.cascaded.join(','),
        retained: result.retained.join(','),
      });
      sendJson(res, 200, result);
    })();
    return true;
  }

  // Anything else is NOT claimed here — it falls back to console-routes.ts's
  // remaining routes and then to the router's 404.
  return false;
}
