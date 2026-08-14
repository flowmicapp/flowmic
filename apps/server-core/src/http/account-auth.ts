// SPEC-REF:
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-1 ④ (`resolveUserId` made
//     real: HTTP Bearer→sub; standalone stays 'default' unchanged)
//   docs/decisions/2026-07-31-owner-nine-rulings-batch.md A3 (owner: do it
//     immediately, as Paddle's first card)
//   docs/rebuild/05-DATA-MODEL.md §7 (Cloud KEY = account JWT, HS256 {sub, plan})
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §5.5 (standalone = one local owner)
//   CLAUDE.md human-audit four sensitive paths: pairing/auth; red line: no
//     silent failures
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// WHO IS THE HTTP CALLER? — one definition, for the whole http surface.
//
// What was here before: `resolveUserId: () => STANDALONE_USER_ID` in bootstrap,
// in BOTH modes. In an account system that is 「everyone is the same person」:
// every saas request drove the billing state machine as the constant user
// 'default'. The local-only gate (local-only.ts) does not help there, because
// behind nginx every public request arrives on loopback — a mode gate is not an
// auth gate, and neither is a peer address.
//
// THE ONE RULE THAT MATTERS HERE — FAIL CLOSED, OUT LOUD.
// When identity cannot be established the answer is a named 401, never a
// fallback user. Falling back to 'default' would be WORSE than the bug it
// replaces: an anonymous internet caller's actions would be booked onto a REAL
// account (and, once Paddle is wired, so would its money). So this module can
// only ever return 「who you are」 or 「I refuse」 — there is no third value, and
// the return type is a union precisely so no caller can forget to branch.
//
// STANDALONE RETURNS 'default' AND THAT IS CORRECT, NOT A LEFTOVER.
// standalone is a single-user server on the owner's own machine: it mounts no
// account REST at all (auth-routes/console-routes are saas-only), mints no JWT,
// and every row in its DB belongs to the one local user seeded at boot. There is
// no second person to tell apart, so 'default' is the true answer, not a
// placeholder for one. DO NOT 「fix」 it — removing it would break every local
// billing/quota read for the owner while protecting nobody.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerMode } from '@flowmic/protocol';
import type { AuthService } from '../auth/auth-service';
import type { UserRecord } from '../db/repos/user.repo';
import { log } from '../log';
import { sendJson } from './body';
import { peerAddress } from './local-only';

/** The two 401 reasons the account contract already defines (04 §3.1). Reused
 *  verbatim from GET /api/me — no new error code, the 55-code table stays 55. */
export type AccountAuthError = 'AUTH_TOKEN_INVALID' | 'AUTH_TOKEN_EXPIRED';

/** Either WHO, or WHY NOT. Deliberately a discriminated union rather than
 *  `string | null`: a nullable id invites `?? 'default'` at the call site, which
 *  is the exact defect this module exists to remove. */
export type UserIdVerdict =
  | { ok: true; userId: string }
  | { ok: false; error: AccountAuthError };

/**
 * "Are you an admin" (是管理员), or the reason it is not, as THREE distinct answers rather than two.
 *
 * `{ok:false, status:401}` = "you haven't proven who you are" (你没证明你是谁);
 * `{ok:false, status:403}` = "I know who you are, but this isn't for you to
 * see" (你是谁我知道了，但这不是给你看的). The status is carried IN the verdict so a caller cannot
 * flatten the two into one refusal — the union is the enforcement, not a comment.
 *
 * 🔴 0.2.48 — ONLY THE 403 BRANCH CARRIES `userId`, and the asymmetry is the
 * point. A 403 caller authenticated successfully and is therefore a PROVEN
 * `users.id`; a 401 caller proved nothing, and there is no honest value to put
 * there. Making that a type difference (rather than `userId: string | null`) means
 * `http/ops-audit-trail.ts` cannot even ASK for an actor on the 401 path — which
 * is exactly the value `ops_audit_log.actor_user_id NOT NULL` refuses to accept.
 * A nullable field here would have made "just write 'anonymous'" (写个
 * 'anonymous' 吧) a one-line temptation.
 */
export type AdminVerdict =
  | { ok: true; userId: string }
  | { ok: false; status: 401; error: AccountAuthError }
  | { ok: false; status: 403; error: 'ADMIN_ONLY'; userId: string };

/** The same verdict carrying the whole row, for the one route that projects it
 *  (GET /api/me). The row NEVER travels further than that: `resolveUserId` hands
 *  out an id and nothing else, so a password_hash cannot reach a dep type that
 *  has no business holding one. */
export type AccountUserVerdict =
  | { ok: true; user: UserRecord }
  | { ok: false; error: AccountAuthError };

/** The slice of AuthService this module needs — typed off the real service so
 *  there is no second interface to drift from it (same discipline as
 *  pairing-auth.ts's PairingRegistry). */
export type AccountVerifier = Pick<AuthService, 'verifyToken' | 'getUser'>;

/** `Authorization: Bearer <token>` → the token, or null. Case-insensitive on the
 *  scheme and tolerant of surrounding whitespace, matching the parser
 *  /api/me has used since WP-R4-1 — a SECOND parser that disagreed about
 *  `bearer ` or a trailing space is how one surface starts admitting what the
 *  other rejects. */
export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? (m[1] as string) : null;
}

/**
 * Bearer → the verified account's user id, or a named 401 reason.
 *
 * Three refusals, all of them explicit:
 *   • no header / not a Bearer  → AUTH_TOKEN_INVALID (an absent credential is a
 *     refusal, never 「no check needed」);
 *   • bad signature / malformed → AUTH_TOKEN_INVALID;
 *   • past `exp`                → AUTH_TOKEN_EXPIRED (distinct so a client knows
 *     to re-login rather than to re-install);
 *   • validly signed for a user that no longer exists → AUTH_TOKEN_INVALID. The
 *     signature being good is not the same question as the account being real,
 *     and only the second one may open a door.
 */
export function accountUserFromBearer(req: IncomingMessage, verifier: AccountVerifier): AccountUserVerdict {
  const token = bearerToken(req);
  if (token === null) return { ok: false, error: 'AUTH_TOKEN_INVALID' };
  const verdict = verifier.verifyToken(token);
  if (!verdict.ok) return { ok: false, error: verdict.error };
  const user = verifier.getUser(verdict.sub);
  if (!user) return { ok: false, error: 'AUTH_TOKEN_INVALID' };
  return { ok: true, user };
}

/** The id-only face of the same decision — what every route except /api/me
 *  needs. Same body, so the two can never disagree about who is admitted. */
export function accountFromBearer(req: IncomingMessage, verifier: AccountVerifier): UserIdVerdict {
  const verdict = accountUserFromBearer(req, verifier);
  return verdict.ok ? { ok: true, userId: verdict.user.id } : verdict;
}

/**
 * 0.2.38 → 0.2.47 — Bearer → "are you an admin" (是管理员吗). THE admin gate for
 * the whole http surface.
 *
 * It moved here from `console-routes.ts` (where 0.2.38 first wrote it) for the
 * reason this whole module exists, stated in its header: 「WHO IS THE HTTP CALLER?
 * — one definition, for the whole http surface」. An ops surface that grows a
 * second route in another file would otherwise have to re-derive "are you an
 * admin" (是管理员), and three copies of 「is this Bearer good」 is exactly how
 * one of them ends up
 * admitting what the others reject — the argument `bearerToken` and
 * `accountFromBearer` already make one function up. `console-routes.ts` keeps a
 * one-line delegate (`authAdmin`) purely so the call sites read the same as
 * `authUser` next to it; it is a name, not a second decision.
 *
 * 🔴 WHY THE 403 MAY NEVER COLLAPSE INTO AN EMPTY 200. An admin-gated route
 * reads ACROSS accounts by design, so "you don't have permission" (你没权限)
 * and "there is no such row" (没有这种行) are two different answers. Returning
 * an empty list to someone who was actually turned away would let an operator
 * on the wrong account read "the books are clean" (对账干净) off a permission
 * denial — this repo's headline bug shape (one value answers two questions —
 * 一个值答两个问题) landing on the one surface whose whole job is to tell a human
 * the truth about money.
 * `test/console-admin-gate-coverage.test.ts` pins that both ways: a non-admin
 * gets 403 with no ledger field in the body, and an admin against the SAME
 * database gets the row.
 *
 * `ADMIN_ONLY` is an EXISTING protocol code (error-codes.ts, 「仅管理员可执行此操
 * 作。」 "Only an admin may perform this action."). The 59-code table does not move.
 *
 * ⚠️ WHERE DOES `is_admin` COME FROM? Not from anywhere in-product: the only
 * WRITER is `UserRepo.insert({is_admin})` and `AuthService.register` never
 * passes it, so every account created through the product is `is_admin = 0`.
 * That is deliberate — an in-product path to grant yourself cross-account read
 * would defeat the gate it opens. The bit is set out-of-band by whoever has the
 * VPS (`UPDATE users SET is_admin=1 WHERE email=…`).
 */
export function adminFromBearer(req: IncomingMessage, verifier: AccountVerifier): AdminVerdict {
  const verdict = accountUserFromBearer(req, verifier);
  // 401 first, and it is NOT interchangeable with the 403 below: an anonymous
  // caller has not been judged non-admin, they have not been judged at all.
  if (!verdict.ok) return { ok: false, status: 401, error: verdict.error };
  // 0.2.48: the refusal carries WHO was refused. It is the same id the `ok` branch
  // returns — this account is real and verified, it just is not an admin — and it
  // is the only actor `ops_audit_log` will ever accept for a denied attempt.
  if (!verdict.user.is_admin) return { ok: false, status: 403, error: 'ADMIN_ONLY', userId: verdict.user.id };
  return { ok: true, userId: verdict.user.id };
}

// ⚠️ 0.2.48 — ROUTES MUST NOT CALL THIS DIRECTLY; call `http/ops-audit-trail.ts`
// `adminGate`, which returns this exact verdict AND leaves a row in
// `ops_audit_log`. A route wired to the bare decision is correctly gated and
// completely untraceable, which is worse than an ungated one because it looks
// right. `test/ops-audit-wiring.test.ts` asserts, from the source tree, that
// ops-audit-trail.ts is this function's only caller in src/.

export interface UserIdResolverDeps {
  mode: ServerMode;
  /** The standalone single-user id (bootstrap's STANDALONE_USER_ID). Passed in
   *  rather than imported so this module never depends on the wiring root. */
  standaloneUserId: string;
  /** saas only: the account service that verifies the Bearer JWT. REQUIRED in
   *  saas — see the throw below. */
  account?: AccountVerifier;
}

/**
 * Build the http `resolveUserId`.
 *
 * saas → the verified Bearer subject. standalone → the single local user (see
 * the file header for why that is the truth and not a stub).
 *
 * A saas wiring with no verifier THROWS AT BOOT rather than defaulting: a
 * friendly fallback here would be a silent「everyone is 'default'」in production,
 * i.e. the very defect being fixed, re-introduced by a missing constructor
 * argument that has no new symbol to grep for (docs/rebuild vol. 13 §7 F1 ②: a
 * DI default may be the real thing or a throw, never a comfortable empty).
 */
export function makeResolveUserId(deps: UserIdResolverDeps): (req: IncomingMessage) => UserIdVerdict {
  if (deps.mode === 'saas' && !deps.account) {
    throw new Error('http: saas resolveUserId requires an account verifier (refusing to fall back to a single shared user)');
  }
  const account = deps.account;
  return (req): UserIdVerdict => {
    if (deps.mode !== 'saas') return { ok: true, userId: deps.standaloneUserId };
    // Non-null by the boot-time guard above; re-checked because a runtime that
    // reached here without one must refuse, not resolve.
    if (!account) return { ok: false, error: 'AUTH_TOKEN_INVALID' };
    return accountFromBearer(req, account);
  };
}

/**
 * Refuse an unidentified caller, BY NAME AND OUT LOUD (CLAUDE.md red line: no
 * silent failures). 401 + the contract's own error code, plus one log line — the log is the
 * only reason anyone ever notices that the public relay is being probed, and it
 * is the half that a silent `return` would have thrown away.
 *
 * Deliberately no user id anywhere in the response: the caller proved nothing,
 * so there is nothing about an account to tell them.
 */
export function refuseUnidentified(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  error: AccountAuthError,
): void {
  log.warn('http: refused an unidentified caller', {
    route,
    reason: error,
    peer: peerAddress(req) || 'unknown',
  });
  sendJson(res, 401, {
    ok: false,
    error,
    message: `${route} requires an account token (Authorization: Bearer <token>)`,
  });
}
