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

import { parseUtcStamp } from '../db/utc-stamp';
import { randomUUID } from 'node:crypto';
import type { ErrorCode, Plan } from '@flowmic/protocol';
import { isAccountRestricted } from './account-restriction';
import { isEmailVerified } from './email-verification';
import { verificationGrace } from './verification-grace';
import { hashPassword, verifyPassword } from './password';
import { checkPasswordPolicy, passwordPolicyMessage } from './password-policy';
import { signJwt, verifyJwt, JwtError, DEFAULT_TTL_MS } from './jwt';
import { UserConstraintError, type UserRecord, type UserRepo } from '../db/repos/user.repo';
import { log } from '../log';

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
  /**
   * NR-2a — whole days left in the 3-day unverified grace, or `null` when there
   * is no countdown (verified, or no address on file). `0` means the grace has
   * ENDED and managed cloud session starts are being refused.
   *
   * 🔴 IT IS A PAINTBRUSH, NOT A GATE — the same standing this field's two
   * neighbours have. The server refuses at `audio:start` / `compose:start`
   * (auth/verification-grace.ts); a client that ignores this number is not
   * granted anything, it merely surprises its user.
   *
   * 🔴 WHY IT EXISTS AT ALL, given that a refusal already carries its own name:
   * the STT refusal is unreadable in practice. `billing/quota-guard.ts`'s
   * 2026-08-07 correction block measured it — the phone emits `audio:start`
   * fire-and-forget, so nobody reads that ack. This field is how a client can
   * warn a user BEFORE the wall instead of decoding it afterwards. Fixing the
   * ack visibility itself is NOT this card (it lives in the window that owns
   * apps/mobile, and it is registered as open in that correction block).
   *
   * ⚠️ `null` and `0` are different answers; a client that treats null as 0
   * paints 「0 days left」 at a verified account. The conversion that produces
   * both is single-sited on purpose (verification-grace.ts).
   */
  verify_grace_days_left: number | null;
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
  /**
   * LOGIN-1 — record that this account just SIGNED IN (`users.last_login_at`).
   *
   * Owner ruling: docs/decisions/owner-web-rulings/latest.md:59-62 —
   * 「上次登录时间 / 登录流水」→「要记，并同步改隐私政策」(`approve_with_policy`).
   *
   * ── 🔴 WHICH MOMENTS COUNT AS "A LOGIN", AND WHY — THE ENUMERATION ─────────
   * There are FIVE places in this repo that mint a session (`issueToken` call
   * sites; `grep -rn "issueToken" src/`). FOUR of them call this and one
   * deliberately does not:
   *
   *   ✅ `POST /api/login` (http/auth-routes.ts) — an email and a password were
   *      presented and verified. The archetype.
   *   ✅ `mobile:login`, password arm (socket/handlers/auth.handler.ts) — the
   *      SAME credential check over a different transport. Excluding it would
   *      make the column silently wrong for the phone, which is the client most
   *      users actually sign in from: their account would read "never signed in"
   *      while they used the product daily.
   *   ✅ `mobile:login`, QR arm (same file) — a single-use, 60-second grant that
   *      an ALREADY-AUTHENTICATED console minted for this exact account. The
   *      person performed a deliberate sign-in on a new device and typed no
   *      password only because the console vouched for them. Excluding it would
   *      make「signed in by QR」indistinguishable from「never signed in」, and QR
   *      is a first-class path (GA-31), not a shortcut.
   *   ✅ `POST /api/auth/google` (http/google-auth-routes.ts, NR-1) — a
   *      credential was presented and verified; that it was Google's signature
   *      rather than our password hash changes who did the checking, not what
   *      happened. 🔴 IT RECORDS EVEN ON THE REQUEST THAT MINTS THE ACCOUNT,
   *      which looks like it contradicts the ❌ below and does not: there,
   *      registering and signing in are two acts and there WILL be a later
   *      moment to record; here they are one act and there will not be. A
   *      Google-only account that never recorded its first sign-in would read
   *      "never signed in" for as long as the person kept using it.
   *   ❌ `POST /api/register` (http/auth-routes.ts) — DOES NOT COUNT, and this
   *      is the one judgement call in the list. Registration already has a
   *      column that answers it exactly: `users.created_at`. Stamping here would
   *      make `last_login_at` non-NULL for every account from the instant it
   *      exists, which DESTROYS the one distinction an operator wants from this
   *      field — "registered and never came back" vs "has been back". Those two
   *      would render as the same date on the same screen. NULL after
   *      registration is not a gap: it is the true statement "we have not
   *      observed this person sign in", and `created_at` sits beside it saying
   *      when the account appeared.
   *
   * ── 🔴 "LAST LOGIN" vs "LAST ACTIVITY" — THE NAMED CHOICE ─────────────────
   * Auth here is stateless JWT, so a token is verified on nearly every request
   * (`accountFromBearer`, `verifyToken`, the socket handshake middleware). Those
   * verifications are the obvious place to stamp and they are deliberately NOT
   * stamped. A value moved by token verification answers "has this account been
   * active recently" — which is what `pc_devices.last_seen_at` and
   * `mobile_pairings.last_seen_at` ALREADY answer, and answering it a fourth
   * time under the label "last login" is one value answering two questions on
   * the screen where an operator decides whether to restrict somebody.
   * ⇒ CHOSEN: this column moves only when a CREDENTIAL was presented. A user who
   * signs in once and then goes on using that token has ONE login, not one per
   * day — which is exactly what the words say. (Since owner ruling 2026-08-27
   * §R1 the token is long-lived, so "once" can now mean literally once.)
   *
   * ── THE SWITCH ────────────────────────────────────────────────────────────
   * Writes NOTHING unless `FLOWMIC_LOGIN_RECORD_ENABLED=1` (config.ts
   * `loginRecordEnabled`, default OFF). See that field for why the default is
   * the feature.
   *
   * ── NEVER FATAL ───────────────────────────────────────────────────────────
   * A failure to record is logged and swallowed. An OPTIONAL record must never
   * be able to turn a valid sign-in into a 500 — the same direction
   * billing/usage-tracker.ts argues for its own append ("an optional record must
   * not be able to make the mandatory one wrong"), and here the mandatory thing
   * is the user getting into their account.
   */
  recordSignIn(user: UserRecord): void;
}

/** The one line that says whether this process records sign-ins. Exported so a
 *  test can assert on it rather than on a string typed twice (the shape
 *  billing/usage-tracker.ts's `USAGE_EVENTS_SWITCH_LOG` established). */
export const LOGIN_RECORD_SWITCH_LOG = 'login record:';

export interface AuthServiceDeps {
  users: UserRepo;
  /** HS256 signing/verification secret (saas: the explicit config secret). */
  jwtSecret: Buffer;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for tests. */
  now?: () => number;
  /** JWT TTL in ms; defaults to `jwt.ts` DEFAULT_TTL_MS (100 years since owner
   *  ruling 2026-08-27 §R1). ⚠️ No production bootstrap passes this — the
   *  default IS the shipped value, so changing the TTL means changing that
   *  constant, not this seam. */
  ttlMs?: number;
  /**
   * LOGIN-1 — may `recordSignIn` actually write. Absent ⇒ **false** ⇒ not one
   * `users.last_login_at` is ever stamped.
   *
   * 🔴 WHY THIS ONE IS ALLOWED A DEFAULT, when book 13 §7 F1 ② says a DI default
   * must be the real thing or a throw. That rule is aimed at defaults that make
   * a MISSING WIRE LOOK LIKE IT WORKS. This default fails in the opposite
   * direction: a bootstrap that forgot the line collects NOTHING, which is both
   * the safe direction and the production default anyway, and the startup line
   * (`LOGIN_RECORD_SWITCH_LOG`) prints the switch state either way so an
   * operator can SEE that the machine says DISABLED.
   *
   * ⚠️ The failure that default cannot catch by itself is the inverse: an
   * operator sets `FLOWMIC_LOGIN_RECORD_ENABLED=1`, bootstrap never passes it
   * through, and the switch does nothing — a control that changes nothing, which
   * this repo treats as worse than no control. That is why the wiring is pinned
   * by a test that boots the REAL server (test/last-login-record.test.ts, "the
   * production bootstrap really carries the switch"), not by this comment.
   */
  loginRecordEnabled?: boolean;
}

// A deliberately permissive shape check — the authoritative UNIQUE/NOCASE
// invariant lives in the DB; this only rejects the obviously-not-an-email so a
// junk row is never minted. (Mirrors zod's MobileLoginSchema email gate for the
// socket path.)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function makeAuthService(deps: AuthServiceDeps): AuthService {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  // LOGIN-1 — resolved once, `=== true` rather than truthiness so a stray
  // string can never turn collection on.
  const loginRecording = deps.loginRecordEnabled === true;
  // Announced ONCE per construction, in BOTH directions, naming the env var —
  // the shape billing/usage-tracker.ts uses and for its stated reason: a line
  // that only appeared when the feature is ON would make its absence mean either
  // "off" or "this build does not even have this switch", and an operator must
  // be able to answer "is this machine recording sign-ins" from the log alone.
  log.info(`${LOGIN_RECORD_SWITCH_LOG} ${loginRecording ? 'ENABLED' : 'DISABLED'}`, {
    env: 'FLOWMIC_LOGIN_RECORD_ENABLED',
    enabled: loginRecording,
  });

  function publicUser(user: UserRecord): PublicUser {
    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      plan: user.plan,
      // The ONE conversion site (auth/email-verification.ts) — never a second
      // `!== null` here that could drift from the gates' reading.
      email_verified: isEmailVerified(user.email_verified_at),
      // NR-2a — same rule again: `verificationGrace` is the ONE place those
      // three columns become a countdown, and the socket gates call the very
      // same function. A second `now() - created_at` here is how the banner and
      // the wall start disagreeing about which day it is.
      verify_grace_days_left: verificationGrace({
        emailVerifiedAt: user.email_verified_at,
        // parseUtcStamp, never Date.parse: the column is a zone-less UTC stamp
        // (db/utc-stamp.ts) — bare Date.parse read it as local time.
        createdAtMs: parseUtcStamp(user.created_at),
        hasEmail: user.email !== null,
        nowMs: now(),
      }).daysLeft,
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

    recordSignIn(user): void {
      // 🔴 THE SWITCH IS TESTED HERE AND NOWHERE ELSE. Not in the repo (a write
      // method that sometimes does not write is a trap for every future caller)
      // and not at the three call sites (three copies of a privacy decision is
      // how one of them keeps collecting after a ruling changes). One place
      // decides; the repo always writes when asked.
      if (!loginRecording) return;
      try {
        deps.users.stampLastLogin(user.id, now());
      } catch (err) {
        // Swallowed BY DESIGN — see this method's contract in `AuthService`.
        // A sign-in that already succeeded must not be turned into a failure by
        // the bookkeeping about it. Not dropped, only relocated: it goes to the
        // operator log, which is where the switch state was announced too, so
        // "collection is on but nothing is landing" is answerable.
        log.error('login record: failed to stamp last_login_at', {
          user_id: user.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
