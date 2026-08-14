// SPEC-REF:
//   src/http/password-reset-routes.ts (the one production caller)
//   docs/rebuild/05-DATA-MODEL.md §5 (reset token + 30-minute TTL)
//   src/mail/provider.ts (the transport seam under this)
//
// "Deliver a password reset to this address" — the ONE product question the
// server asks of the mail channel, and therefore the ONE dependency the route
// takes.
//
// WHY THE ROUTE DOES NOT DEPEND ON `MailProvider` DIRECTLY. Sending the reset
// needs two facts: a transport, and where the link points. Handing the route
// both would make it hold two values that must agree — and when mail is off
// there is no base URL at all, so the pair has an incoherent state (one fact
// split into two values, this repo's #1 shape one level up). This interface is
// that pair collapsed into the single thing the route actually wants.

import type { MailMessage, MailProvider } from './provider';

export interface PasswordResetMailer {
  /**
   * Hand the reset link to the mail channel.
   *
   * RESOLVES = the transport accepted the message. REJECTS = it did not, and the
   * rejection carries a reason a human can act on. There is no third answer and
   * no swallowed one: every implementation of this either resolves or throws,
   * and the caller must not describe a resolve as 「email sent」 (see
   * MailProvider.send).
   */
  sendPasswordReset(input: PasswordResetMailInput): Promise<void>;
  /** Transport id for log lines only (`'resend'` / `'unconfigured'`). */
  readonly id: string;
}

export interface PasswordResetMailInput {
  /** The account's email — the recipient AND the value the reset route requires
   *  alongside the token, so it rides in the link too. */
  to: string;
  resetToken: string;
  /** ISO-8601, exactly the string persisted in `account.password_reset`. Shown
   *  verbatim rather than reformatted: the mail and the stored row must not be
   *  able to disagree about when the link dies. */
  expiresAt: string;
}

/**
 * The reset link.
 *
 * Both parameters are REQUIRED by `POST /api/password/reset` (it 400s without
 * either), so both are in the link — a link carrying only the token would take
 * the user to a page that has to ask them to retype the address they just used,
 * and half of them would type a different one.
 *
 * Built with `URL`/`searchParams`, never string concatenation: a token is
 * base64url (`-` and `_` are in-alphabet, `+`/`/` are not) but the EMAIL is
 * arbitrary user input, and `a+b@x.co` concatenated raw becomes `a b@x.co` on
 * the other side.
 */
export function buildPasswordResetLink(baseUrl: string, to: string, resetToken: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('email', to);
  url.searchParams.set('token', resetToken);
  return url.toString();
}

/**
 * The message itself. English only, plain text, no HTML part.
 *
 * ⚠️ THE FOUR-LANGUAGE i18n DISCIPLINE DOES NOT REACH HERE, and the reason is
 * mechanical rather than a preference: `AppStrings` / `error-codes.ts` are
 * translated because the reader's language is KNOWN (the phone and the console
 * each have a locale). At this point we have an email address and nothing else
 * — the account row carries no language column — so any 「translation」 would be
 * a guess rendered as a fact. English is stated as the deliberate choice rather
 * than smuggled in as a default; when an account grows a language preference,
 * this function is the one place that has to change.
 *
 * No HTML part on purpose: a password-reset mail with markup is the shape every
 * phishing filter is tuned for, and a plain-text body renders identically
 * everywhere with no way for a client to hide where the link goes.
 */
export function buildPasswordResetEmail(baseUrl: string, input: PasswordResetMailInput): MailMessage {
  const link = buildPasswordResetLink(baseUrl, input.to, input.resetToken);
  return {
    to: input.to,
    subject: 'Reset your FlowMic password',
    // No greeting by name: `users.display_name` is not verified, and putting an
    // unverified string into an email is a small self-service phishing kit.
    text: [
      'Someone asked to reset the FlowMic password for this address.',
      '',
      'Open this link to choose a new password:',
      link,
      '',
      `The link stops working at ${input.expiresAt} (30 minutes after it was requested).`,
      '',
      'If this was not you, ignore this email. Your password has not changed.',
      '',
      'FlowMic',
    ].join('\n'),
  };
}

/** Compose the product-level mailer from a transport + the link base. */
export function makePasswordResetMailer(deps: { provider: MailProvider; resetBaseUrl: string }): PasswordResetMailer {
  return {
    id: deps.provider.id,
    async sendPasswordReset(input: PasswordResetMailInput): Promise<void> {
      await deps.provider.send(buildPasswordResetEmail(deps.resetBaseUrl, input));
    },
  };
}
