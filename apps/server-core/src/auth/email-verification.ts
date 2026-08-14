// SPEC-REF:
//   docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md
//     D1 (data), D2 (codes: 6 digits, SHA-256 at rest, 15-min TTL, 60-s resend
//     cooldown, ≤3 sends / 15 min, ≤5 attempts per code), D3 (the gate)
//   src/http/email-verification-routes.ts (the HTTP consumer)
//   src/socket/handlers/grant.handler.ts + timeline.handler.ts (the socket
//     consumers of the gate + EMAIL_NOT_VERIFIED)
//   *** HUMAN-AUDIT SENSITIVE (auth: account verification policy) ***
//
// The email-verification POLICY: what a code is, how it is stored and compared,
// and the ONE conversion from `users.email_verified_at` to a verdict. Kept out
// of the route file so the socket gates and the /api/me projection can consume
// the same definitions without importing an HTTP module.
//
// 🔴 THE CODE IS NEVER STORED — only its SHA-256. A DB read (or a backup, or a
// log that quotes a row) must never hand anyone a working code. The compare is
// constant-time OVER THE HASHES (`timingSafeEqual` on two 32-byte digests):
// hashing the presented code first makes the comparison length-uniform, and the
// digest comparison leaks nothing about WHERE the guess diverged.
// test/email-verification.test.ts pins, from the source tree, that
// `verificationCodeMatches` is the only compare and that it goes through
// `timingSafeEqual` — a `===` on strings would be a per-character early exit.

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/** A code dies 15 minutes after it was sent (decision doc D2). */
export const EMAIL_VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;
/** A resend inside this window is refused by name (VERIFY_COOLDOWN). Judged
 *  from the stored row's `sent_at`, so it survives a relay restart. */
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
/** The send budget: at most this many codes per account per rolling window. */
export const EMAIL_VERIFICATION_MAX_SENDS_PER_WINDOW = 3;
export const EMAIL_VERIFICATION_SEND_WINDOW_MS = 15 * 60 * 1000;
/** A code dies after this many wrong guesses (VERIFY_TOO_MANY_ATTEMPTS — the
 *  user must request a fresh one). 5 guesses against a 6-digit space is a
 *  1-in-200,000 lottery per code, and the send budget caps how many codes an
 *  attacker can even mint. */
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 5;
export const EMAIL_VERIFICATION_CODE_LENGTH = 6;

/**
 * The refusal every verified-email gate answers with — an HTTP-LOCAL /
 * ack-local string on the KEYMETA_* / DIAG_* precedent, NOT a protocol
 * `ErrorCode`.
 *
 * 🔴 Why the SOCKET gates may use it too (grant.handler.ts / timeline.handler.ts
 * carry this same doctrine note at their gate sites): the only client that can
 * ever receive it is the repo-owned web console (kind:'web' sockets exist only
 * for the GRANT-1 preview session), acks are not schema-gated, and minting a
 * protocol code is owner-gated — the day this string needs to reach the PHONE
 * is the day to ask the owner for a real code, not the day to widen this one.
 * test/email-verification.test.ts pins its absence from ERROR_CODES.
 */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

/**
 * 🔴 THE one `users.email_verified_at` → verdict conversion (the same
 * single-conversion-site discipline user.repo.ts `toRecord` states for the two
 * INTEGER flags). NULL = the gate is closed; any timestamp = open. For a
 * grandfathered account the timestamp is the MIGRATION moment, so this function
 * must never be read as 「when did they verify」 — the DDL comment in
 * db/schema.ts owns that argument.
 */
export function isEmailVerified(emailVerifiedAt: number | null): boolean {
  return emailVerifiedAt !== null;
}

/** The slice every gate consumes — implemented by EmailVerificationRepo
 *  (db/repos/email-verification.repo.ts), which reads the users column. */
export interface EmailVerifiedReader {
  emailVerifiedAt(userId: string): number | null;
}

/** Six decimal digits from the CSPRNG (`crypto.randomInt`), zero-padded —
 *  '004217' is a legal code. Never Math.random: a guessable code turns the
 *  whole gate into decoration. */
export function generateVerificationCode(): string {
  return randomInt(0, 10 ** EMAIL_VERIFICATION_CODE_LENGTH)
    .toString()
    .padStart(EMAIL_VERIFICATION_CODE_LENGTH, '0');
}

/** SHA-256 over the code's utf8 bytes, hex — what `email_verifications.code_hash`
 *  stores. Unsalted on purpose and stated rather than discovered: the input
 *  space is 10^6, so ANY offline holder of the hash can enumerate it in
 *  milliseconds, salted or not — the real defences are the 15-minute TTL and
 *  the 5-attempt online cap, and a salt here would only imply a protection the
 *  math cannot deliver. */
export function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Constant-time verdict: does the presented code match the stored hash?
 *
 * Hash-compare-only, through `timingSafeEqual` — never `===` on the raw code
 * (a string compare exits at the first differing character, which hands a
 * network attacker a per-digit oracle). The two digests are always the same
 * length, so the length guard below is unreachable in practice; it exists
 * because `timingSafeEqual` THROWS on unequal lengths and a thrown compare is
 * a crash, not a refusal.
 */
export function verificationCodeMatches(storedHashHex: string, presentedCode: string): boolean {
  const stored = Buffer.from(storedHashHex, 'hex');
  const presented = Buffer.from(hashVerificationCode(presentedCode), 'hex');
  if (stored.length !== presented.length) return false;
  return timingSafeEqual(stored, presented);
}

/**
 * Per-account sliding-window send budget (≤3 / 15 min). In-memory and
 * account-keyed, the GrantRequestRateLimiter shape (the caller is
 * authenticated, so the honest bucket key is the account, not the peer address
 * nginx folds to loopback anyway).
 *
 * check() PEEKS and record() SPENDS, deliberately split (the
 * RegisterRateLimiter shape, not the grant limiter's admit-and-count): a send
 * whose TRANSPORT fails is reported by name and must not also burn a slot of
 * the budget — the user's next retry would otherwise pay for our outage.
 */
export class VerificationSendLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = EMAIL_VERIFICATION_SEND_WINDOW_MS,
    private readonly maxPerWindow: number = EMAIL_VERIFICATION_MAX_SENDS_PER_WINDOW,
  ) {}

  /** True = a send would be within budget. Counts nothing. */
  check(userId: string): boolean {
    const list = this.pruned(userId);
    // Write the pruned list back even on refusal — otherwise stale timestamps
    // accumulate forever and the map only ever grows (grant.handler.ts makes
    // the same move for the same reason).
    this.hits.set(userId, list);
    return list.length < this.maxPerWindow;
  }

  /** Spend one slot — called only after the transport ACCEPTED the message. */
  record(userId: string): void {
    const list = this.pruned(userId);
    list.push(this.now());
    this.hits.set(userId, list);
  }

  private pruned(userId: string): number[] {
    const cutoff = this.now() - this.windowMs;
    return (this.hits.get(userId) ?? []).filter((ts) => ts > cutoff);
  }
}
