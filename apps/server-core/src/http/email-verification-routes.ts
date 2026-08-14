// SPEC-REF:
//   docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md
//     D2 (the two routes, their budgets, and the honest-send-failure ruling)
//   http/timeline-keymeta-routes.ts — the route-file pattern this follows
//     (accountFromBearer seam, sendJson, saas-only double-gated mount in
//     router.ts, HTTP-local refusal names)
//   src/auth/email-verification.ts (the policy: TTLs, budgets, hashing, the
//     constant-time compare — this file decides nothing the policy owns)
//   CLAUDE.md human-audit-required sensitive paths (four classes): pairing/auth
//     (account verification) — line-by-line human audit
//   *** HUMAN-AUDIT SENSITIVE (auth: email verification) ***
//
// POST /api/auth/email-verification/send    — mint + mail a 6-digit code.
// POST /api/auth/email-verification/confirm — trade the code for the gate.
//
// 🔴 SEND FAILURES ARE REPORTED HONESTLY (named 502), and that is a DELIBERATE
// departure from the password-reset shape one file over. That route answers the
// same bytes whether the mail went out or not, because its caller is anonymous
// and "mail failed" would mean "this address exists". HERE the caller is
// authenticated and the address is their own — there is nothing to enumerate,
// so the anti-enumeration constant-response shape would be pure silent failure
// (decision doc D2 says this in as many words: copying that shape here would
// violate "no silent failures"). The
// send is therefore AWAITED, and nothing is stored unless the transport
// accepted the message — a stored code nobody was sent would start a cooldown
// against a user who received nothing.
//
// The refusal names below are HTTP-LOCAL strings on the KEYMETA_*/DIAG_*
// precedent — they never cross a socket from here and never render verbatim to
// a user (the web console maps them to its own copy — VERIFY-2); the
// owner-gated protocol ERROR_CODES table does not move, and
// test/email-verification.test.ts pins that absence.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { MailNotConfiguredError, type EmailVerificationMailer } from '../mail';
import { accountFromBearer, accountUserFromBearer, type AccountVerifier } from './account-auth';
import { readJsonBody, sendJson, str } from './console-http';
import type { EmailVerificationRepo } from '../db/repos/email-verification.repo';
import {
  EMAIL_VERIFICATION_CODE_TTL_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  generateVerificationCode,
  hashVerificationCode,
  isEmailVerified,
  verificationCodeMatches,
  type VerificationSendLimiter,
} from '../auth/email-verification';
import { log } from '../log';

/** Exported for the tests — the TIMELINE_KEYMETA_PATH argument: a hand-copied
 *  literal in a test could drift into passing against a route nobody serves. */
export const EMAIL_VERIFICATION_SEND_PATH = '/api/auth/email-verification/send';
export const EMAIL_VERIFICATION_CONFIRM_PATH = '/api/auth/email-verification/confirm';

/** send/confirm on an account whose gate is already open — 409, nothing done.
 *  (For confirm this doubles as the double-click answer; the UI re-reads
 *  /api/me either way.) */
export const VERIFY_ALREADY_VERIFIED = 'VERIFY_ALREADY_VERIFIED';
/** send inside the 60-second resend window — 429 with retry_after_ms. */
export const VERIFY_COOLDOWN = 'VERIFY_COOLDOWN';
/** send past the ≤3/15-min per-account budget — 429. */
export const VERIFY_RATE_LIMITED = 'VERIFY_RATE_LIMITED';
/** the transport refused (or none is configured) — 502, and NOTHING stored. */
export const VERIFY_SEND_FAILED = 'VERIFY_SEND_FAILED';
/** send for an account with no email on file. Unreachable through the product
 *  (saas registration requires an email) but a named refusal beats a 500 the
 *  day some path mints an email-less account. */
export const VERIFY_NO_EMAIL = 'VERIFY_NO_EMAIL';
/** confirm with a wrong code, a missing code field, or no active code — 400. */
export const VERIFY_CODE_INVALID = 'VERIFY_CODE_INVALID';
/** confirm against a code past its 15-minute TTL — 400, row burned. */
export const VERIFY_CODE_EXPIRED = 'VERIFY_CODE_EXPIRED';
/** the 5th wrong guess — 429, row burned, a fresh send is the only way on. */
export const VERIFY_TOO_MANY_ATTEMPTS = 'VERIFY_TOO_MANY_ATTEMPTS';

/** 0.3.0 M1 precedent (`FLOWMIC_INTERNAL_RESET_TOKEN_ECHO`, password-reset-
 *  routes.ts): the flag that makes the send response carry the code itself.
 *
 *  🔴 PRIVATE-LINE / GOLDEN-HARNESS AFFORDANCE ONLY — it must never be set on
 *  a deployment a stranger can reach (with it on, any Bearer holder can verify
 *  without a mailbox, i.e. the gate stops proving anything). It exists because
 *  the golden paths (g11/g17/g18) drive a REAL spawned server that has no mail
 *  channel and no DB handle to reach into, and the alternative — goldens that
 *  skip the gate — would leave the one true-boot harness blind to it. Same
 *  strict '1'/'true' parsing as the reset echo; read per request, not at
 *  module load, so tests can flip it and a server needs no restart to go dark.
 *
 *  ⚠️ With the echo ON the send-failure contract bends, out loud: the code is
 *  stored and echoed even when the transport refused (the response then says
 *  `dispatched:false` — never a silent claim of delivery). With it OFF (the
 *  default, and every production deployment) the honest-502 contract above is
 *  the whole story; test/email-verification.test.ts pins both halves. */
const VERIFICATION_CODE_ECHO_ENV = 'FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO';
function verificationCodeEchoEnabled(): boolean {
  const v = process.env[VERIFICATION_CODE_ECHO_ENV];
  return v === '1' || v === 'true';
}

export interface EmailVerificationRoutesDeps {
  /** The SAME AuthService instance every other Bearer surface verifies with —
   *  a second verifier would be a second answer to "is this token good". */
  auth: AccountVerifier;
  /** The store — same instance the D3 gates read through (bootstrap wires
   *  db.emailVerification to both), so a confirm and the gate it opens can
   *  never disagree. */
  repo: EmailVerificationRepo;
  /** The code channel (mail/email-verification-mailer.ts). Required — an
   *  optional mailer here would mount a send route that stores a code and
   *  delivers nothing (doc 13 §7 F1 ②). */
  mailer: EmailVerificationMailer;
  /** ONE per server (bootstrap) — a per-request limiter limits nothing. */
  sendLimiter: VerificationSendLimiter;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for TTL tests. */
  now?: () => number;
}

/** Handle the two verification routes. Returns true iff it owned the request.
 *  Any other method on the paths falls through to the router's 404. */
export function tryHandleEmailVerificationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EmailVerificationRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;

  // ── POST /api/auth/email-verification/send ────────────────────────────────
  if (url === EMAIL_VERIFICATION_SEND_PATH && method === 'POST') {
    // The row-returning verdict: this is the one route that needs the EMAIL,
    // and it must be the stored one — never a request-supplied string (the
    // password-reset route carries the selector-vs-confirmation argument).
    const who = accountUserFromBearer(req, deps.auth);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    const user = who.user;
    void (async (): Promise<void> => {
      if (isEmailVerified(user.email_verified_at)) {
        return sendJson(res, 409, { error: VERIFY_ALREADY_VERIFIED });
      }
      if (user.email === null) {
        return sendJson(res, 400, { error: VERIFY_NO_EMAIL, message: 'this account has no email address on file' });
      }
      const t = now();
      // Cooldown BEFORE budget: the cooldown names the shorter wait, and its
      // anchor is the durable row (a relay restart must not reset it).
      const existing = deps.repo.getCode(user.id);
      if (existing !== null && t < existing.sent_at + EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) {
        return sendJson(res, 429, {
          error: VERIFY_COOLDOWN,
          retry_after_ms: existing.sent_at + EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - t,
        });
      }
      // check() PEEKS — the slot is spent only after the transport accepts
      // (VerificationSendLimiter's own doc carries the why).
      if (!deps.sendLimiter.check(user.id)) {
        return sendJson(res, 429, { error: VERIFY_RATE_LIMITED });
      }
      const code = generateVerificationCode();
      const expiresAtMs = t + EMAIL_VERIFICATION_CODE_TTL_MS;
      const expiresAtIso = new Date(expiresAtMs).toISOString();
      const echo = verificationCodeEchoEnabled();
      let dispatched = true;
      try {
        // AWAITED, deliberately — see the file header: honesty beats latency
        // here, and there is no enumeration clock to hide (the caller is
        // mailing their own address).
        await deps.mailer.sendVerificationCode({ to: user.email, code, expiresAt: expiresAtIso });
      } catch (err) {
        // Two named reasons in the LOG (operator action differs: env vars vs
        // vendor status) — password-reset's dispatch makes the same split.
        // On the WIRE both are VERIFY_SEND_FAILED: the caller's next move
        // (retry later / tell the operator) is the same either way, and the
        // transport's own words are operator material, not wire material.
        const code2 = err instanceof MailNotConfiguredError ? err.code : 'MAIL_SEND_FAILED';
        log.error('mail: email-verification code NOT delivered', {
          user_id: user.id,
          code: code2,
          transport: deps.mailer.id,
          reason: err instanceof Error ? err.message : String(err),
        });
        if (!echo) {
          // Nothing stored, no budget spent, no cooldown started: the user
          // received nothing, so no state may claim otherwise.
          return sendJson(res, 502, {
            error: VERIFY_SEND_FAILED,
            message: 'the verification email could not be sent; try again later or contact the operator',
          });
        }
        dispatched = false; // echo mode: stored + echoed below, failure named
      }
      deps.sendLimiter.record(user.id);
      deps.repo.putCode(user.id, hashVerificationCode(code), expiresAtMs, t);
      // The code itself is NEVER in the response or a log line — except under
      // the internal echo flag (its doc block above is the whole argument).
      return sendJson(res, 200, {
        ok: true,
        expires_in_ms: EMAIL_VERIFICATION_CODE_TTL_MS,
        resend_cooldown_ms: EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
        ...(echo ? { code, dispatched } : {}),
      });
    })();
    return true;
  }

  // ── POST /api/auth/email-verification/confirm ─────────────────────────────
  if (url === EMAIL_VERIFICATION_CONFIRM_PATH && method === 'POST') {
    const who = accountFromBearer(req, deps.auth);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    const userId = who.userId;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      if (isEmailVerified(deps.repo.emailVerifiedAt(userId))) {
        return sendJson(res, 409, { error: VERIFY_ALREADY_VERIFIED });
      }
      const presented = str(body.code);
      if (presented === '') {
        return sendJson(res, 400, { error: VERIFY_CODE_INVALID, message: 'code required' });
      }
      const row = deps.repo.getCode(userId);
      if (row === null) {
        return sendJson(res, 400, {
          error: VERIFY_CODE_INVALID,
          message: 'no active verification code for this account — request a new one',
        });
      }
      const t = now();
      if (t >= row.expires_at) {
        // Burned on read: an expired code must not keep absorbing guesses,
        // and the next send would replace the row anyway.
        deps.repo.removeCode(userId);
        return sendJson(res, 400, { error: VERIFY_CODE_EXPIRED });
      }
      // 🔴 Hash-compare-only, constant-time — auth/email-verification.ts
      // `verificationCodeMatches` is the ONLY compare (the source-tree pin in
      // test/email-verification.test.ts holds this file to that).
      if (!verificationCodeMatches(row.code_hash, presented)) {
        const attempts = deps.repo.bumpAttempts(userId);
        if (attempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
          // The code dies WITH the refusal that names why — the caller's only
          // way forward is a fresh send, and the message says so.
          deps.repo.removeCode(userId);
          return sendJson(res, 429, {
            error: VERIFY_TOO_MANY_ATTEMPTS,
            message: 'too many wrong guesses — this code is dead, request a new one',
          });
        }
        return sendJson(res, 400, {
          error: VERIFY_CODE_INVALID,
          attempts_remaining: EMAIL_VERIFICATION_MAX_ATTEMPTS - attempts,
        });
      }
      // Success: open the gate, burn the code. markVerified writes only a NULL
      // column (first verification wins — repo contract), so a raced double
      // confirm cannot move the stamp.
      deps.repo.markVerified(userId, t);
      deps.repo.removeCode(userId);
      return sendJson(res, 200, { ok: true, email_verified: true });
    })();
    return true;
  }

  return false;
}
