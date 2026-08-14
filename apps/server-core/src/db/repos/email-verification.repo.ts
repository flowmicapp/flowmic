// SPEC-REF:
//   docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md
//     D1 (email_verifications DDL + users.email_verified_at)
//   src/db/schema.ts `-- 13. email_verifications` (the DDL's own argument:
//     PK user_id = one active code, hash-only at rest, FK CASCADE)
//   src/auth/email-verification.ts (the policy over these rows)
//   *** HUMAN-AUDIT SENSITIVE (auth: verification state) ***
//
// The verification store: the pending-code row AND the one `users` column the
// whole feature exists to set. Spanning two tables in one repo is deliberate,
// not an accident of convenience: every method here answers a single product
// question — 「is / does this account become verified」 — and splitting the
// column half into UserRepo would put the gate's read and the confirm's write
// in different modules that then have to be trusted to agree.
//
// `emailVerifiedAt` returns the RAW column (number | null); the ONE conversion
// to a verdict is auth/email-verification.ts `isEmailVerified` (the same
// single-conversion-site discipline user.repo.ts `toRecord` states for its two
// INTEGER flags). Every gate consumes this repo through the narrow
// `EmailVerifiedReader` slice, so no surface can reach the write methods as a
// side effect of being able to ask the question.

import type { DatabaseSync } from 'node:sqlite';

export interface EmailVerificationCodeRow {
  user_id: string;
  /** SHA-256 hex of the code — the code itself is never at rest (schema.ts). */
  code_hash: string;
  /** ms-since-epoch; expiry is judged on read, there is no sweeper. */
  expires_at: number;
  /** Wrong confirm guesses against THIS code (fresh row = 0). */
  attempts: number;
  /** ms-since-epoch of the send that minted this code — the resend-cooldown
   *  anchor, durable so a relay restart cannot reset the cooldown. */
  sent_at: number;
}

export interface EmailVerificationRepo {
  /** `users.email_verified_at`, raw. null = the gate is closed. (For a
   *  grandfathered row the number is the migration stamp — see schema.ts.) */
  emailVerifiedAt(userId: string): number | null;
  /** Open the gate. Writes ONLY a NULL column (first verification wins): a
   *  grandfather stamp or an earlier confirm is never moved, so the value can
   *  never answer two different 「when」s. Returns whether a row changed —
   *  false = unknown user OR already verified, both honest no-ops. */
  markVerified(userId: string, atMs: number): boolean;
  /** The account's active code row, or null. Expiry is NOT judged here — the
   *  route owns that verdict (it needs `now` and answers by name). */
  getCode(userId: string): EmailVerificationCodeRow | null;
  /** Store a fresh code, REPLACING any existing row (PK user_id — the 「one
   *  active code per account」 rule; a resend resets attempts to 0 because it
   *  is a new code with its own guess budget). */
  putCode(userId: string, codeHash: string, expiresAtMs: number, sentAtMs: number): void;
  /** Count one wrong guess. Returns the NEW total (0 if no row — the caller
   *  never bumps a row it did not just read, so 0 is unreachable in practice
   *  and honest if reached). */
  bumpAttempts(userId: string): number;
  /** Burn the row — on success, on expiry, and on the attempt cap alike. */
  removeCode(userId: string): void;
}

export function makeEmailVerificationRepo(db: DatabaseSync): EmailVerificationRepo {
  const readVerified = db.prepare('SELECT email_verified_at FROM users WHERE id=?');
  // `AND email_verified_at IS NULL` is the 「first verification wins」 half of
  // markVerified's contract, enforced in SQL rather than by a read-then-write
  // pair that two concurrent confirms could interleave.
  const writeVerified = db.prepare('UPDATE users SET email_verified_at=? WHERE id=? AND email_verified_at IS NULL');
  const readCode = db.prepare('SELECT user_id, code_hash, expires_at, attempts, sent_at FROM email_verifications WHERE user_id=?');
  const writeCode = db.prepare(
    'INSERT OR REPLACE INTO email_verifications (user_id, code_hash, expires_at, attempts, sent_at) VALUES (?,?,?,0,?)',
  );
  const bump = db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id=?');
  const readAttempts = db.prepare('SELECT attempts FROM email_verifications WHERE user_id=?');
  const del = db.prepare('DELETE FROM email_verifications WHERE user_id=?');

  return {
    emailVerifiedAt(userId): number | null {
      const r = readVerified.get(userId) as { email_verified_at: number | null } | undefined;
      return r?.email_verified_at ?? null;
    },
    markVerified(userId, atMs): boolean {
      return Number(writeVerified.run(atMs, userId).changes) > 0;
    },
    getCode(userId): EmailVerificationCodeRow | null {
      const r = readCode.get(userId) as EmailVerificationCodeRow | undefined;
      return r ?? null;
    },
    putCode(userId, codeHash, expiresAtMs, sentAtMs): void {
      writeCode.run(userId, codeHash, expiresAtMs, sentAtMs);
    },
    bumpAttempts(userId): number {
      bump.run(userId);
      const r = readAttempts.get(userId) as { attempts: number } | undefined;
      return r?.attempts ?? 0;
    },
    removeCode(userId): void {
      del.run(userId);
    },
  };
}
