// SPEC-REF:
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §2
//     ("注册成功即自动发验证邮件" + the emailed one-click link)
//   src/http/email-verification-routes.ts — caller #1 (the Bearer send route)
//   src/http/auth-routes.ts             — caller #2 (POST /api/register)
//   src/auth/email-verification.ts      — the code arm's policy
//   src/auth/verification-link.ts       — the link arm's policy
//   *** HUMAN-AUDIT SENSITIVE (auth: account verification) ***
//
// ONE verification mail, THREE steps, split so the two callers can compose them
// differently without either owning a second definition of what a verification
// mail is.
//
// 🔴 WHY IT IS THREE FUNCTIONS AND NOT ONE. The two callers genuinely differ,
// and collapsing them would force one of them to lie:
//   · the SEND route awaits the transport and answers a named 502 when it
//     refuses, storing NOTHING (a stored code nobody was sent would start a
//     60-second cooldown against a user who received nothing) — except under the
//     internal echo flag, where it stores anyway and says `dispatched:false`;
//   · REGISTRATION cannot await anything: a mail outage must not turn account
//     creation into a 500. It fires the dispatch, keeps the 201, and the named
//     truth goes to the operator's log — the password-reset `dispatchResetMail`
//     shape, for a related-but-different reason (there it is anti-enumeration,
//     here it is "registration succeeded and mail is a separate event").
// Both still mint the same pair, mail the same body, and write the same two
// rows, because those three things live here.
//
// ⚠️ THE ORDER IS MINT → SEND → STORE, NOT MINT → STORE → SEND, and that is the
// half a later refactor would get wrong. Storing first means a failed transport
// leaves an account holding a code and a link that were never delivered — and
// the code row is what the resend cooldown is anchored to.

import type { EmailVerificationRepo } from '../db/repos/email-verification.repo';
import type { SettingsRepo } from '../db/repos/settings.repo';
import type { EmailVerificationMailer } from '../mail';
import {
  EMAIL_VERIFICATION_CODE_TTL_MS,
  generateVerificationCode,
  hashVerificationCode,
} from './email-verification';
import {
  EMAIL_VERIFICATION_LINK_KEY,
  mintVerificationLink,
  type VerificationLink,
} from './verification-link';

/** Everything one verification mail consists of, before anything is persisted. */
export interface MintedVerification {
  /** Plaintext, in memory only — at rest there is only its SHA-256. */
  code: string;
  codeHash: string;
  codeExpiresAtMs: number;
  codeExpiresAtIso: string;
  link: VerificationLink;
  /** The instant this was minted: the code row's `sent_at`, i.e. the durable
   *  anchor of the 60-second resend cooldown. */
  sentAtMs: number;
}

/** Mint both arms. Pure apart from the CSPRNG — no I/O, nothing persisted. */
export function mintVerification(userId: string, nowMs: number): MintedVerification {
  const code = generateVerificationCode();
  const codeExpiresAtMs = nowMs + EMAIL_VERIFICATION_CODE_TTL_MS;
  return {
    code,
    codeHash: hashVerificationCode(code),
    codeExpiresAtMs,
    codeExpiresAtIso: new Date(codeExpiresAtMs).toISOString(),
    link: mintVerificationLink(userId, nowMs),
    sentAtMs: nowMs,
  };
}

/**
 * Hand the pair to the mail channel. RESOLVES = the transport accepted it;
 * REJECTS = it did not, with a reason a human can act on (MailProvider.send's
 * contract). Never swallows — every caller decides what to do with a rejection.
 */
export async function sendVerificationMail(
  mailer: EmailVerificationMailer,
  to: string,
  minted: MintedVerification,
): Promise<void> {
  await mailer.sendVerificationCode({
    to,
    code: minted.code,
    expiresAt: minted.codeExpiresAtIso,
    linkToken: minted.link.token,
    linkExpiresAt: minted.link.expiresAtIso,
  });
}

/**
 * Persist both arms: the hashed code (one active row per account, PK user_id —
 * a re-send REPLACES) and the link token (a `account.*` settings row, so it
 * never fans out to a phone).
 *
 * Both are written together on purpose. A mail carries both arms, so an account
 * holding only one of them would have a mail whose other half does not work —
 * and the user cannot tell which half we failed to store.
 */
export function storeVerification(
  repo: EmailVerificationRepo,
  settings: SettingsRepo,
  userId: string,
  minted: MintedVerification,
): void {
  repo.putCode(userId, minted.codeHash, minted.codeExpiresAtMs, minted.sentAtMs);
  settings.write(userId, EMAIL_VERIFICATION_LINK_KEY, {
    verify_token: minted.link.token,
    expires_at: minted.link.expiresAtIso,
  });
}
