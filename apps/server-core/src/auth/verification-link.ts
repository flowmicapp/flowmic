// SPEC-REF:
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §2
//     ("验证动作降为一次点击" — the emailed link, not "go to the console and
//      retype six digits")
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 3
//   src/http/password-reset-routes.ts — THE PRECEDENT this copies clause for
//     clause (randomBytes(18) base64url, persisted in a `account.*` settings
//     row, TTL judged on read, constant-time compare, single use)
//   src/auth/email-verification.ts — the 6-digit sibling arm; both arms open
//     the SAME gate (`users.email_verified_at`) through the SAME repo
//   *** HUMAN-AUDIT SENSITIVE (auth: account verification policy) ***
//
// The LINK arm of email verification: what a link token is, where it is kept,
// how long it lives, and the one constant-time compare that judges it.
//
// 🔴 WHY A SECOND ARM AT ALL, stated rather than left to look like feature
// creep. The 6-digit arm requires a session: it is Bearer-only, so the person
// must already be signed in to the console. That is exactly the wrong shape for
// the moment it is used — somebody who just registered on a phone, opened the
// mail on the same phone, and now has to switch back to a browser tab and
// retype a number. This arm needs no session at all, because a mail client has
// none.
//
// 🔴 WHY THE TOKEN CARRIES ITS OWN ADDRESS (`<user_id>.<secret>`). The store is
// a per-user KV (`SettingsRepo` is keyed by user_id), so a bare secret would
// have to be found by scanning every account's settings row — a table scan on
// an anonymous, unauthenticated route, which is a denial-of-service handed to
// the internet. The password-reset link solves the same problem by putting the
// EMAIL in the URL; that is not available here (this link is clicked, not
// typed, so there is nothing to prefill and no second field to fill), and an
// email address in a URL is a value that leaks through Referer and browser
// history. The user id is an opaque UUID that identifies nothing off-system.
//
// ⚠️ THE USER ID HALF IS NOT A SECRET AND IS NOT TREATED AS ONE. It is an
// address: it says WHICH row to compare against. All of the entropy — and all
// of the security — is in the second half, and that is the half the
// constant-time compare covers. Anyone holding a user id and no secret gets
// exactly the same refusal as anyone holding neither.

import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The user_settings KV key holding the pending verification link.
 *
 * `account.*` is on the mobile-broadcast deny-list (05 §5), so writing it never
 * fans out to a phone — the same property `account.password_reset` relies on,
 * and the reason this key is in that namespace rather than a new one.
 */
export const EMAIL_VERIFICATION_LINK_KEY = 'account.email_verification_link';

/**
 * How long an emailed verification link stays clickable: 30 MINUTES.
 *
 * 🔴 AN OWNER NUMBER, not ours. docs/decisions/2026-08-27-owner-web-rulings-batch-2.md
 * item 4, verbatim: 「一键链接 30 分钟内有效；验证码是 15 分钟」.
 *
 * ⚠️ THE PREVIOUS COMMENT IS KEPT BELOW BECAUSE IT ARGUED FOR 24 HOURS AND THE
 * OWNER RULED AGAINST IT. Deleting it would leave this file looking as though
 * nobody had ever considered the other direction, and the argument it makes is
 * the one a later reader will make again:
 *
 *     "🔴 A FIRST-RESPONSIBLE NUMBER (this card), recorded so the owner can move
 *      it with one edit, and the reasoning is the trade it sits in:
 *        · the password-reset link is 30 MINUTES because it is minted in
 *          response to a person who is at their keyboard RIGHT NOW, waiting;
 *        · the 6-digit code is 15 MINUTES for the same reason plus a much
 *          smaller search space (10^6, so its defence has to be time);
 *        · this one is minted by REGISTRATION, i.e. handed to somebody who may
 *          not open their mail until the evening. A 15-minute link would be
 *          expired by the time most people clicked it, and an expired link on
 *          the one screen whose job is conversion is worse than a slightly
 *          longer window."
 *
 * The recorded cost of the ruling, stated rather than discovered: somebody who
 * registers and does not open their mail for an hour WILL meet
 * VERIFY_LINK_EXPIRED. That is survivable because it is not a dead end — the
 * 6-digit code arm and the console's own resend button both still exist, and
 * the 3-day grace (auth/verification-grace.ts) means the account keeps working
 * while they sort it out.
 *
 * The window is affordable in the other direction because the token is 144 bits
 * of CSPRNG, single-use, and grants exactly one thing: flipping
 * `email_verified_at` on the account it was minted for. It is not a session and
 * it cannot become one.
 *
 * 🔴 THE MAIL BODY DERIVES ITS 「30 minutes」 FROM THIS CONSTANT
 * (mail/email-verification-mailer.ts) rather than spelling it out, so a later
 * edit here cannot leave the message telling people something else.
 */
export const EMAIL_VERIFICATION_LINK_TTL_MS = 30 * 60 * 1000;

/** Secret entropy. 18 bytes → 24 base64url characters, the same size the
 *  password-reset token has used since 05 §5 — deliberately not a new number. */
const LINK_SECRET_BYTES = 18;

/** confirm-link with a token that is malformed, unknown, already spent, or
 *  simply wrong — ONE name for all four, so the route is not an oracle for
 *  「did this token ever exist」. HTTP-local, on the KEYMETA_ / DIAG_ precedent;
 *  never a protocol `ErrorCode` (test/email-verification-link.test.ts pins its
 *  absence from ERROR_CODES). */
export const VERIFY_LINK_INVALID = 'VERIFY_LINK_INVALID';

/**
 * confirm-link with a token that MATCHED but is past its TTL — 400, row burned.
 *
 * ⚠️ Distinguishing this from VERIFY_LINK_INVALID does NOT create an
 * enumeration oracle, and the reason is worth writing down because the sibling
 * password-reset route deliberately collapses every failure into one code.
 * There, the selector is an EMAIL — a value an attacker can enumerate — so
 * "expired" would leak "this address has an account". Here the selector is the
 * 144-bit secret itself: to learn that a token expired you must already hold
 * that token, which means you already hold everything this route protects.
 * What the split buys is a real product difference: "this link is old, send
 * yourself a new one" is an action, and "that did not work" is not.
 */
export const VERIFY_LINK_EXPIRED = 'VERIFY_LINK_EXPIRED';

/** What one minted link consists of. Both halves travel: the token goes in the
 *  mail, the expiry goes in the stored row AND is quoted verbatim in the mail
 *  body (the two must not be able to disagree — same rule as the code arm). */
export interface VerificationLink {
  token: string;
  expiresAtMs: number;
  expiresAtIso: string;
}

/**
 * Mint a link token for an account. `<user_id>.<24 base64url chars>`.
 *
 * base64url is deliberate (`-`/`_` are in-alphabet, `+`/`/` are not): the token
 * rides in a query string, and a `+` would arrive on the other side as a space.
 */
export function mintVerificationLink(userId: string, nowMs: number): VerificationLink {
  const secret = randomBytes(LINK_SECRET_BYTES).toString('base64url');
  const expiresAtMs = nowMs + EMAIL_VERIFICATION_LINK_TTL_MS;
  return {
    token: `${userId}.${secret}`,
    expiresAtMs,
    expiresAtIso: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Split a presented token into the account it addresses and the secret it
 * claims, or null when it is not even the right shape.
 *
 * `lastIndexOf('.')`, not `split('.')`: a UUID contains no dot today, but a
 * user id format that ever grows one must not silently start addressing the
 * wrong account — taking the LAST dot makes the secret half unambiguous
 * regardless of what the id contains.
 */
export function splitVerificationLinkToken(token: string): { userId: string; secret: string } | null {
  const at = token.lastIndexOf('.');
  if (at <= 0 || at === token.length - 1) return null;
  return { userId: token.slice(0, at), secret: token.slice(at + 1) };
}

/**
 * Constant-time verdict over the WHOLE stored token.
 *
 * Equal-length only; unequal lengths short-circuit false without a timing tell
 * beyond length, and length is public (every minted token is a UUID plus 24
 * base64url characters). Copied from password-reset-routes.ts `safeStrEqual`
 * rather than re-invented — a `===` here would exit at the first differing
 * character and hand a network attacker a per-character oracle.
 */
export function verificationLinkMatches(storedToken: string, presentedToken: string): boolean {
  const a = Buffer.from(storedToken, 'utf8');
  const b = Buffer.from(presentedToken, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The stored row's shape, read defensively — it is JSON in a KV column, so
 *  every field is `unknown` until proven otherwise. */
export interface StoredVerificationLink {
  verify_token?: unknown;
  expires_at?: unknown;
}

/** Read a stored row into the two facts the route judges with, or null when the
 *  row is absent/garbage. NaN expiry is treated as「no usable row」rather than
 *  as「never expires」— the fail-safe direction. */
export function readStoredVerificationLink(
  value: unknown,
): { token: string; expiresAtMs: number } | null {
  const row = (value ?? undefined) as StoredVerificationLink | undefined;
  const token = typeof row?.verify_token === 'string' ? row.verify_token : '';
  const expiresAtMs = typeof row?.expires_at === 'string' ? Date.parse(row.expires_at) : NaN;
  if (token === '' || !Number.isFinite(expiresAtMs)) return null;
  return { token, expiresAtMs };
}
