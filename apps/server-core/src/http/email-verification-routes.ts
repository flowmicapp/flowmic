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
import { clientIpFromRequest } from './trusted-proxy';
import type { EmailVerificationRepo } from '../db/repos/email-verification.repo';
import type { SettingsRepo } from '../db/repos/settings.repo';
import type { RegisterRateLimiter } from '../auth/register-rate-limit';
import {
  EMAIL_VERIFICATION_CODE_TTL_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  isEmailVerified,
  verificationCodeMatches,
  type VerificationSendLimiter,
} from '../auth/email-verification';
import {
  EMAIL_VERIFICATION_LINK_KEY,
  readStoredVerificationLink,
  splitVerificationLinkToken,
  verificationLinkMatches,
  VERIFY_LINK_EXPIRED,
  VERIFY_LINK_INVALID,
} from '../auth/verification-link';
import { mintVerification, sendVerificationMail, storeVerification } from '../auth/verification-issue';
import { log } from '../log';

/** Exported for the tests — the TIMELINE_KEYMETA_PATH argument: a hand-copied
 *  literal in a test could drift into passing against a route nobody serves. */
export const EMAIL_VERIFICATION_SEND_PATH = '/api/auth/email-verification/send';
export const EMAIL_VERIFICATION_CONFIRM_PATH = '/api/auth/email-verification/confirm';
/** NR-2a — the one-click arm. NO Bearer: it is reached from a mail client,
 *  which has no session and cannot be given one. */
export const EMAIL_VERIFICATION_CONFIRM_LINK_PATH = '/api/auth/email-verification/confirm-link';

/** Re-exported so a caller (and a test) has one import for every refusal this
 *  route file can answer with — the link arm's two names live with the link
 *  policy, beside the compare that produces them. */
export { VERIFY_LINK_INVALID, VERIFY_LINK_EXPIRED };

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

/**
 * 🔴 2026-09-02 — `FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO` USED TO LIVE HERE
 * AND IS DELETED. It made the send response carry the code itself, with no
 * mode gate at all: any Bearer holder could verify without a mailbox if it
 * was ever set on a reachable deployment, which is the same account-takeover
 * shape as its sibling `FLOWMIC_INTERNAL_RESET_TOKEN_ECHO` (password-reset-
 * routes.ts) — owner ordered both removed
 * (docs/decisions/2026-09-02-owner-plain-language-lan-ci-and-two-security-
 * questions.md §3, problem 1), not merely defaulted dark.
 *
 * It existed because the golden paths (g11/g17/g18) drive a REAL spawned
 * server with no mail channel and no DB handle to reach into. That capability
 * is now mail/file.ts (FLOWMIC_MAIL_PROVIDER=file): the code is IN the mail
 * `sendVerificationMail` sent, on disk, for a test to read the same way a
 * real recipient reads their inbox — nothing on this wire carries it any
 * more, in any configuration.
 */

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
  /**
   * NR-2a — where the LINK arm's single-use token is kept
   * (`account.email_verification_link`, a `account.*` key so it never fans out
   * to a phone). The SAME instance the send route writes through and the
   * confirm-link route reads through: two stores would be two answers to
   * 「is this link still live」.
   */
  settings: SettingsRepo;
  /**
   * NR-2a — per-IP throttle for `confirm-link`, which is the ONLY route in this
   * file an anonymous caller can reach. Its own bucket, not the shared
   * register/login one, for the reason password-reset-routes.ts states about
   * its own limiter: a burst of link clicks must not spend the budget a
   * legitimate sign-in needs (and vice-versa).
   *
   * ⚠️ It is NOT the thing that makes the token unguessable — 144 bits of
   * CSPRNG is. It bounds the work an anonymous caller can make this process do.
   */
  linkLimiter: RegisterRateLimiter;
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
      // NR-2a — ONE mint for BOTH arms (auth/verification-issue.ts), so a
      // resend cannot produce a mail whose code and link disagree about which
      // send they belong to.
      const minted = mintVerification(user.id, t);
      try {
        // AWAITED, deliberately — see the file header: honesty beats latency
        // here, and there is no enumeration clock to hide (the caller is
        // mailing their own address).
        await sendVerificationMail(deps.mailer, user.email, minted);
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
        // Nothing stored, no budget spent, no cooldown started: the user
        // received nothing, so no state may claim otherwise.
        return sendJson(res, 502, {
          error: VERIFY_SEND_FAILED,
          message: 'the verification email could not be sent; try again later or contact the operator',
        });
      }
      deps.sendLimiter.record(user.id);
      // NR-2a — BOTH rows, written together (verification-issue.ts states why).
      storeVerification(deps.repo, deps.settings, user.id, minted);
      // The code itself is NEVER in the response or a log line — no exception
      // left (2026-09-02: the internal echo that used to carve one out is
      // deleted, not defaulted off — see the file header). A test that needs
      // the code without a real mailbox reads it out of mail/file.ts's written
      // JSON, the same way a real recipient reads their inbox.
      return sendJson(res, 200, {
        ok: true,
        expires_in_ms: EMAIL_VERIFICATION_CODE_TTL_MS,
        resend_cooldown_ms: EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
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
      // NR-2a — and burn the LINK the same mail carried. Both arms open the one
      // gate, so once it is open the other arm is a live single-use credential
      // sitting in a mailbox with nothing left to do. Leaving it would be a
      // credential whose only remaining effect is to be stolen.
      deps.settings.remove(userId, EMAIL_VERIFICATION_LINK_KEY);
      return sendJson(res, 200, { ok: true, email_verified: true });
    })();
    return true;
  }

  // ── POST /api/auth/email-verification/confirm-link (NR-2a) ────────────────
  //
  // 🔴 NO BEARER, ON PURPOSE. The link is opened from a mail client, which has
  // no session — requiring one would rebuild the very step this arm exists to
  // delete. What stands in for the session is the token itself: 144 bits of
  // CSPRNG that we minted, addressed to exactly one account, good once.
  //
  // 🔴 IT IS A POST, WHICH IS WHY MAIL SCANNERS CANNOT SPEND THE LINK. Corporate
  // mail gateways and link previewers GET every URL in a message. If the gate
  // opened on GET, a scanner would verify the address before the human ever
  // clicked — and, worse, would burn the single use so the human's click landed
  // on a named failure. The emailed URL points at a PAGE (`/verify?token=…`);
  // that page's script issues this POST. A GET of the page changes nothing.
  if (url === EMAIL_VERIFICATION_CONFIRM_LINK_PATH && method === 'POST') {
    void (async (): Promise<void> => {
      const ip = clientIpFromRequest(req);
      if (!deps.linkLimiter.check(ip).allowed) return sendJson(res, 429, { error: VERIFY_RATE_LIMITED });
      deps.linkLimiter.record(ip);
      const body = await readJsonBody(req);
      const presented = str(body.token);
      const parts = presented === '' ? null : splitVerificationLinkToken(presented);
      if (parts === null) {
        return sendJson(res, 400, { error: VERIFY_LINK_INVALID, message: 'token required' });
      }
      const stored = readStoredVerificationLink(deps.settings.read(parts.userId, EMAIL_VERIFICATION_LINK_KEY)?.value);
      // ONE refusal for「no such account」,「no pending link」and「wrong secret」.
      // The compare is constant-time and covers the WHOLE token, so a caller
      // cannot learn which half was wrong (auth/verification-link.ts).
      if (stored === null || !verificationLinkMatches(stored.token, presented)) {
        return sendJson(res, 400, { error: VERIFY_LINK_INVALID });
      }
      const t = now();
      if (t >= stored.expiresAtMs) {
        // Burned on read, exactly as an expired CODE is: an expired credential
        // must not keep sitting in the store waiting to be probed.
        deps.settings.remove(parts.userId, EMAIL_VERIFICATION_LINK_KEY);
        return sendJson(res, 400, { error: VERIFY_LINK_EXPIRED });
      }
      // 🔴 SINGLE USE — the row is removed BEFORE the gate is opened, so a
      // second click (or a concurrent one) finds nothing and gets the same
      // refusal a stranger gets. The QrGrantStore.redeem ordering, for the same
      // reason it states: delete first, then act.
      deps.settings.remove(parts.userId, EMAIL_VERIFICATION_LINK_KEY);
      // `markVerified` writes only a NULL column and reports whether a row
      // moved — false means the account was ALREADY verified (a code confirm
      // beat this click, or Google minted it verified). That is not a failure
      // for the person holding the link: the address IS verified. Same 200,
      // and the code row is burned either way.
      deps.repo.markVerified(parts.userId, t);
      deps.repo.removeCode(parts.userId);
      // No user id, no token, no address in the line — `user_id` alone is what
      // the password-reset dispatch line carries and for the same reason. Here
      // even that is enough to answer 「did one-click conversion work」 in
      // aggregate without writing a credential to a file.
      log.info('verification: account verified through the emailed one-click link', {
        user_id: parts.userId,
      });
      return sendJson(res, 200, { ok: true, email_verified: true });
    })();
    return true;
  }

  return false;
}
