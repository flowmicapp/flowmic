// SPEC-REF:
//   src/http/email-verification-routes.ts (the one production caller)
//   docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md
//     D2 (subject + plain text naming the code and the 15-minute expiry)
//   src/mail/password-reset-mailer.ts — the product-level-mailer shape this is
//     a sibling of (one product question per interface, transport injected)
//   src/mail/provider.ts (the transport seam under this)
//
// 「Deliver a verification code to this address」 — the ONE product question the
// verification route asks of the mail channel, and therefore the ONE dependency
// it takes. Same collapse as PasswordResetMailer: the route must not hold a
// bare MailProvider and compose messages itself, or two routes end up with two
// templates answering 「what does a FlowMic mail look like」.
//
// Unlike its sibling there is NO link and NO base URL: the code is typed into a
// console the user already has open, so a URL would only add a phishing-shaped
// element to a mail whose whole job is to carry six digits.

import type { MailMessage, MailProvider } from './provider';

export interface EmailVerificationMailer {
  /**
   * Hand the code to the mail channel.
   *
   * RESOLVES = the transport accepted the message. REJECTS = it did not, and
   * the rejection carries a reason a human can act on. No third answer, no
   * swallowed one (MailProvider.send's contract) — and the CALLER must report
   * the rejection on the wire by name: the password-reset both-ways-200
   * anti-enumeration shape deliberately does NOT apply here (the caller is
   * authenticated and mailing their own address — decision doc D2).
   */
  sendVerificationCode(input: EmailVerificationMailInput): Promise<void>;
  /** Transport id for log lines only (`'resend'` / `'unconfigured'`). */
  readonly id: string;
}

export interface EmailVerificationMailInput {
  /** The account's stored email — always `users.email`, never the string a
   *  request supplied (the password-reset route states the selector-vs-
   *  confirmation argument; here there is no request string at all). */
  to: string;
  /** The six-digit code, plaintext — it exists only in this message and in the
   *  caller's stack frame; at rest there is only its SHA-256. */
  code: string;
  /** ISO-8601 expiry, exactly the instant persisted in
   *  `email_verifications.expires_at` — the mail and the stored row must not
   *  be able to disagree about when the code dies. */
  expiresAt: string;
}

/**
 * The message itself. English only, plain text, no HTML part — both choices
 * are the password-reset template's, made for the same mechanical reasons
 * (its header carries them in full): the account row has no language column,
 * so any 「translation」 would be a guess rendered as a fact; and an HTML mail
 * is the shape every phishing filter is tuned for.
 *
 * No greeting by name: `users.display_name` is not verified, and putting an
 * unverified string into an email is a small self-service phishing kit — the
 * same exclusion the password-reset body makes.
 */
export function buildEmailVerificationEmail(input: EmailVerificationMailInput): MailMessage {
  return {
    to: input.to,
    subject: 'Your FlowMic verification code',
    text: [
      'Someone asked to verify this address for a FlowMic account.',
      '',
      'Your verification code is:',
      input.code,
      '',
      `The code stops working at ${input.expiresAt} (15 minutes after it was sent).`,
      '',
      'If this was not you, ignore this email. Nothing changes without the code.',
      '',
      'FlowMic',
    ].join('\n'),
  };
}

/** Compose the product-level mailer from a transport. */
export function makeEmailVerificationMailer(deps: { provider: MailProvider }): EmailVerificationMailer {
  return {
    id: deps.provider.id,
    async sendVerificationCode(input: EmailVerificationMailInput): Promise<void> {
      await deps.provider.send(buildEmailVerificationEmail(input));
    },
  };
}
