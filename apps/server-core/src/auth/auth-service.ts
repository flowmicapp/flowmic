// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (users table: email UNIQUE NOCASE,
//     password_hash, plan default 'free'), §7 (Cloud KEY JWT, scrypt password)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-1 ① (verifyCredentials +
//     register; email unique NOCASE, password>=8, hash ported from legacy;
//     JWT sign/verify HS256 {sub, plan} TTL 7d)
//   *** HUMAN-AUDIT SENSITIVE (auth/credentials) — reviewable in isolation ***
//
// The account credential service: register (unique email, hashed password),
// verifyCredentials (timing-safe scrypt compare, no email-existence oracle),
// and account-JWT mint/verify. The PUBLIC user projection NEVER carries
// password_hash — acks and REST bodies expose only {id,email,display_name,plan}.
// Passwords/hashes never touch a log line here (nothing is logged in this file).

import { randomUUID } from 'node:crypto';
import type { ErrorCode, Plan } from '@flowmic/protocol';
import { isAccountRestricted } from './account-restriction';
import { isEmailVerified } from './email-verification';
import { hashPassword, verifyPassword } from './password';
import { checkPasswordPolicy, passwordPolicyMessage } from './password-policy';
import { signJwt, verifyJwt, JwtError, DEFAULT_TTL_MS } from './jwt';
import { UserConstraintError, type UserRecord, type UserRepo } from '../db/repos/user.repo';

// A4-3 (2026-08-12): `MIN_PASSWORD_LENGTH = 8` used to be declared HERE, and
// http/password-reset-routes.ts hand-wrote its own `8` beside it. The policy now
// lives in ./password-policy.ts — the one file the reset route, this service,
// verify/lint/password-policy-mirror.mjs and @flowmic/web all point at. Import
// the constant from there; it is deliberately NOT re-exported through this file,
// so there is exactly one import path and no alias that could outlive it.

/** The only user shape that ever crosses the wire — never password_hash. */
export interface PublicUser {
  id: string;
  email: string | null;
  display_name: string;
  plan: Plan;
  /** VERIFY-1 (decision doc D2: "GET /api/me adds back email_verified") — the flag
   *  the console UI paints the gate from. On the PROJECTION rather than forked
   *  into /api/me's response body so register/login/me/socket-login all carry
   *  the same answer from the same derivation (a second /api/me-only assembly
   *  would be a copy that drifts). ADDITIVE on every surface that carries a
   *  user object; no protocol schema names this shape, so the owner-gated
   *  tables do not move. */
  email_verified: boolean;
  /** A2-3 "restricted use" (owner: "the user can still log in, but only sees the restricted-use notice") — the flag
   *  the console/desktop shells paint the restriction notice from. On the
   *  PROJECTION, beside `email_verified`, so register/login/me/socket-login all
   *  carry the same answer from the same derivation; a /api/me-only field would
   *  be a second assembly that drifts.
   *
   *  🔴 IT IS A PAINTBRUSH, NOT A GATE. The server refuses each capability
   *  itself (http/console-routes.ts `refuseRestricted`); a client that ignores
   *  this field draws the product and then collects a wall of named 403s —
   *  ugly, never permissive. Inverting that (client field = the gate) is the
   *  failure this repo has shipped five times.
   *
   *  ⚠️ NON-OPTIONAL HERE, OPTIONAL ON THE CLIENT — and the asymmetry is copied
   *  from `email_verified`, not invented. The server ALWAYS computes it, so a
   *  `?` here would let a future projection silently omit it. A CLIENT type must
   *  declare it optional and read `undefined` as NOT restricted, exactly as the
   *  web console does for `email_verified` (its `src/lib/session.ts`): a session
   *  persisted by an older build has no such key, and "field missing" must never be
   *  rendered as "you are restricted". (The design doc sketched `restricted?: boolean` on
   *  this interface; that optionality belongs to the client shape it was arguing
   *  about — pinned by test/auth-jwt.test.ts's exact-shape assertion here.)
   *
   *  ADDITIVE on every surface that carries a user object; no protocol schema
   *  names this shape, so the owner-gated code/event tables do not move. */
  restricted: boolean;
  /**
   * Q2 (owner 2026-08-12) — WHICH reason the notice should say, as a key from
   * `RESTRICTION_REASONS` (@flowmic/protocol). Absent when the account is not
   * restricted, and absent when it was restricted before this field existed.
   *
   * 🔴 OPTIONAL HERE WHILE `restricted` IS NOT, and the asymmetry is the design
   * rather than an oversight. `restricted` is always computable; a REASON is a
   * thing that may genuinely not have been recorded, and there is no honest
   * default for it. So its absence means "we did not record a reason" — and a client MUST
   * render the notice without a reason line rather than substituting a generic
   * one, because a substituted reason is a sentence we never actually decided
   * about a specific person.
   *
   * 🔴 A KEY, NEVER A SENTENCE, and never the operator's free text. The server
   * does not choose the reader's language ("UI does not follow OS locale"), and the
   * operator's note is an internal artefact that goes to `ops_audit_log` and
   * stops there — the two are separated at the column level (db/schema.ts
   * `users.restriction_reason`).
   *
   * ADDITIVE: no protocol schema names this shape, so the owner-gated code and
   * event tables do not move.
   */
  restricted_reason?: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  display_name?: string;
}

/** A malformed register payload (bad email / short password) — distinct from a
 *  UserConstraintError (duplicate email → 409). REST maps this to 400.
 *
 *  fix-023 (ledger row REG-V): `code` carries the protocol-whitelisted refusal
 *  this actually is (mirrors ServerError's `.code` contract, errors.ts), so a
 *  caller that inspects the error — not just `.field`/`.message` — can tell
 *  WHICH question was refused. It defaults to `SETTINGS_SCHEMA_INVALID`, the one
 *  code every instance of this class has answered with on the wire so far
 *  (auth-routes.ts's catch block still hard-codes that string for every
 *  RegisterValidationError regardless of `.field` or `.code` — see the note at
 *  the email-shape throw below). Only the malformed-EMAIL call site overrides
 *  it: that refusal is an auth-face question ("is this address well-formed")
 *  wearing a settings-face code, per owner ruling group #5-d
 *  (docs/decisions/2026-08-10-owner-ruling-requests-from-lan-window.md).
 *  Password-length deliberately keeps the default — recoding it is a separate,
 *  unruled-on question (fix-023's own scope note). */
export class RegisterValidationError extends Error {
  readonly code: ErrorCode;
  constructor(public readonly field: 'email' | 'password', message: string, code: ErrorCode = 'SETTINGS_SCHEMA_INVALID') {
    super(message);
    this.name = 'RegisterValidationError';
    this.code = code;
  }
}

export interface IssuedToken {
  token: string;
  /** Token expiry, seconds-since-epoch (for the auth:expired watchdog). */
  exp: number;
  plan: Plan;
}

export type TokenVerdict =
  | { ok: true; sub: string; plan: Plan; exp: number }
  | { ok: false; error: 'AUTH_TOKEN_INVALID' | 'AUTH_TOKEN_EXPIRED' };

export interface AuthService {
  register(input: RegisterInput): Promise<UserRecord>;
  verifyCredentials(email: string, password: string): Promise<UserRecord | null>;
  issueToken(user: UserRecord): IssuedToken;
  verifyToken(token: string): TokenVerdict;
  /** Fetch the user row for a verified token sub (GET /api/me). */
  getUser(id: string): UserRecord | null;
  /** Look up by email (R5-WEB WP-W1 password-reset forgot/reset). NOCASE via the
   *  repo. Returns null for an unknown address — the caller keeps the response
   *  shape constant so this is never an enumeration oracle on its own. */
  findByEmail(email: string): UserRecord | null;
  /** Reset a user's password (R5-WEB WP-W1). Hashing stays inside this audited
   *  credential module — the console route never touches scrypt directly. The
   *  old password dies on the next verifyCredentials read. Returns null if the
   *  user vanished between reset-token check and write. */
  setPassword(id: string, newPassword: string): Promise<UserRecord | null>;
  publicUser(user: UserRecord): PublicUser;
}

export interface AuthServiceDeps {
  users: UserRepo;
  /** HS256 signing/verification secret (saas: the explicit config secret). */
  jwtSecret: Buffer;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
  /** JWT TTL in ms; defaults to 7 days. */
  ttlMs?: number;
}

// A deliberately permissive shape check — the authoritative UNIQUE/NOCASE
// invariant lives in the DB; this only rejects the obviously-not-an-email so a
// junk row is never minted. (Mirrors zod's MobileLoginSchema email gate for the
// socket path.)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function makeAuthService(deps: AuthServiceDeps): AuthService {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  function publicUser(user: UserRecord): PublicUser {
    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      plan: user.plan,
      // The ONE conversion site (auth/email-verification.ts) — never a second
      // `!== null` here that could drift from the gates' reading.
      email_verified: isEmailVerified(user.email_verified_at),
      // A2-3 — same rule, same reason: the conversion lives in
      // auth/account-restriction.ts and the gates call the SAME function, so
      // the notice the client paints and the refusal the server issues cannot
      // disagree about what `restricted_at` means.
      restricted: isAccountRestricted(user.restricted_at),
      // Q2 — the reason rides ONLY when the account is actually restricted AND a
      // reason was recorded. 🔴 The `restricted &&` half is not redundant: a
      // released account keeps nothing (the write clears both columns together),
      // but if that ever changed, a stale reason arriving beside
      // `restricted:false` would be a sentence about a person that is no longer
      // true. Spread-or-nothing, so "no reason recorded" is an ABSENT key rather than an
      // empty string a client could render as a blank line.
      ...(isAccountRestricted(user.restricted_at) && user.restriction_reason !== null
        ? { restricted_reason: user.restriction_reason }
        : {}),
    };
  }

  return {
    async register(input): Promise<UserRecord> {
      if (typeof input.email !== 'string' || !EMAIL_RE.test(input.email.trim())) {
        // ⚠️ OPEN SEAM, REPORTED RATHER THAN CLOSED HERE (fix-023 scope): the
        // route boundary (http/auth-routes.ts's POST /api/register catch) does
        // not read `.code` yet — it hard-codes `SETTINGS_SCHEMA_INVALID` for
        // every RegisterValidationError, so this refusal does not reach the wire
        // as REGISTER_EMAIL_INVALID until that file is updated too. That file is
        // owned by a different, concurrently in-flight card (fix-011); this card
        // is scoped to auth-service.ts only, so the route-side read of `.code`
        // (falling back to SETTINGS_SCHEMA_INVALID for every other field) is left
        // as the reported next step rather than done here.
        throw new RegisterValidationError('email', 'email is not a valid address', 'REGISTER_EMAIL_INVALID');
      }
      const passwordVerdict = checkPasswordPolicy(input.password);
      if (!passwordVerdict.ok) {
        throw new RegisterValidationError('password', passwordPolicyMessage('password', passwordVerdict));
      }
      const password_hash = await hashPassword(input.password);
      // insert() normalizes the email (trim+lowercase) and raises
      // UserConstraintError('email') on the UNIQUE NOCASE collision.
      return deps.users.insert({
        id: randomUUID(),
        email: input.email,
        password_hash,
        plan: 'free',
        ...(input.display_name && input.display_name.trim().length > 0
          ? { display_name: input.display_name.trim() }
          : {}),
      });
    },

    async verifyCredentials(email, password): Promise<UserRecord | null> {
      if (typeof email !== 'string' || typeof password !== 'string') return null;
      const user = deps.users.findByEmail(email);
      // No email-existence oracle: a missing user still performs a verify against
      // a throwaway hash so the wrong-email and wrong-password paths cost alike.
      if (!user || user.password_hash == null) {
        await verifyPassword(password, 'scrypt$N=16384$r=8$p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==');
        return null;
      }
      const ok = await verifyPassword(password, user.password_hash);
      return ok ? user : null;
    },

    issueToken(user): IssuedToken {
      const nowMs = now();
      const token = signJwt({ sub: user.id, plan: user.plan }, { secret: deps.jwtSecret, ttlMs, now: () => nowMs });
      const exp = Math.floor((nowMs + ttlMs) / 1000);
      return { token, exp, plan: user.plan };
    },

    verifyToken(token): TokenVerdict {
      try {
        const claims = verifyJwt(token, { secret: deps.jwtSecret, now });
        return { ok: true, sub: claims.sub, plan: claims.plan, exp: claims.exp };
      } catch (err) {
        if (err instanceof JwtError && err.code === 'JWT_EXPIRED') return { ok: false, error: 'AUTH_TOKEN_EXPIRED' };
        return { ok: false, error: 'AUTH_TOKEN_INVALID' };
      }
    },

    getUser(id): UserRecord | null {
      return deps.users.findById(id);
    },

    findByEmail(email): UserRecord | null {
      if (typeof email !== 'string' || email.trim() === '') return null;
      return deps.users.findByEmail(email);
    },

    async setPassword(id, newPassword): Promise<UserRecord | null> {
      // The last-line guard, so a bad caller can never store a weak hash.
      //
      // 🔴 A4-3: the sentence that used to sit here — 「Length is re-validated at
      // the route (400 before we ever get here)」 — was an assertion about ANOTHER
      // file's behaviour, and it went stale the moment that file stopped agreeing
      // (anti-façade ④). The route re-validated a HARD-CODED 8 while this guard read
      // MIN_PASSWORD_LENGTH, so 「before we ever get here」 held only for as long as
      // the two numbers happened to be equal. It is now true by construction
      // rather than by coincidence: password-reset-routes.ts calls
      // checkPasswordPolicy — the same function called below — and
      // test/password-policy.test.ts drives the real route to prove a password
      // between the old and new minimum is refused there, not here.
      const verdict = checkPasswordPolicy(newPassword);
      if (!verdict.ok) {
        throw new RegisterValidationError('password', passwordPolicyMessage('password', verdict));
      }
      const password_hash = await hashPassword(newPassword);
      return deps.users.setPassword(id, password_hash);
    },

    publicUser,
  };
}
