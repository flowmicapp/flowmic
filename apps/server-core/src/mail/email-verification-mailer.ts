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
// 🔴 2026-08-27 (card NR-2a) — THIS FILE'S HEADER USED TO END:
//     "Unlike its sibling there is NO link and NO base URL: the code is typed
//      into a console the user already has open, so a URL would only add a
//      phishing-shaped element to a mail whose whole job is to carry six digits."
// Kept verbatim because it was true when it was written, and false now. Its
// premise — "a console the user already has open" — held while the ONLY way to
// reach the send route was to be signed in to that console. Registration now
// mails a verification unprompted (http/auth-routes.ts), and a person who just
// created an account on a phone has no console open anywhere. The mail
// therefore carries a LINK first and the code as the fallback for anyone whose
// mail client will not open one.
//
// ⚠️ The phishing argument the old sentence made is not dismissed, it is
// answered: the body is still plain text with no HTML part, so the destination
// of the link is visible as characters rather than hidden behind markup, and it
// is the ONLY link in the message.

import { EMAIL_VERIFICATION_CODE_TTL_MS } from '../auth/email-verification';
import { EMAIL_VERIFICATION_LINK_TTL_MS } from '../auth/verification-link';
import type { MailMessage, MailProvider } from './provider';

/**
 * 🔴 THE TWO VALIDITY SENTENCES ARE DERIVED, NEVER TYPED.
 *
 * Until 2026-08-27 the code line read 「(15 minutes after it was sent)」 as a
 * literal, i.e. a claim about `EMAIL_VERIFICATION_CODE_TTL_MS` written where
 * nothing would ever check it against that constant — a comment's failure mode
 * (an assertion about elsewhere whose truth changes when elsewhere does)
 * shipped to users as product copy. The owner's link ruling (24h → 30 min) is
 * exactly the edit that would have made the OTHER line lie, so both are now
 * computed from the constants they describe.
 *
 * `Math.round` on minutes: every TTL in this module is a whole number of
 * minutes, and a fractional value in a sentence would be a bug the reader has
 * to interpret rather than a duration.
 */
function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

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
  /** NR-2a — the one-click arm's single-use token (`<user_id>.<secret>`,
   *  auth/verification-link.ts). Optional so every pre-NR-2a call site and test
   *  still type-checks; when it is absent the body carries the code alone,
   *  which is exactly what this mail was before the link existed. */
  linkToken?: string;
  /** ISO-8601, exactly the instant persisted in the
   *  `account.email_verification_link` row — same no-disagreement rule as
   *  `expiresAt`. Only meaningful beside `linkToken`. */
  linkExpiresAt?: string;
}

/**
 * The verification link.
 *
 * Built with `URL`/`searchParams`, never string concatenation — the same rule
 * `buildPasswordResetLink` states: the token is base64url with a UUID prefix,
 * and hand-joining query strings is how a `+` becomes a space on the far side.
 *
 * ONE parameter, `token`, because `POST /api/auth/email-verification/confirm-link`
 * needs exactly one thing. The reset link carries the email as well because its
 * route requires the address too; adding one here would put a user's email into
 * browser history and `Referer` headers to no purpose.
 */
export function buildEmailVerificationLink(baseUrl: string, linkToken: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('token', linkToken);
  return url.toString();
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
export function buildEmailVerificationEmail(
  input: EmailVerificationMailInput,
  verifyBaseUrl?: string,
): MailMessage {
  // The link block exists only when BOTH halves are present. A base URL with no
  // token (or the reverse) would render a link to a page that cannot do
  // anything — the failure mail/config.ts's header calls out as the silent one.
  const link =
    verifyBaseUrl !== undefined && verifyBaseUrl !== '' && input.linkToken !== undefined && input.linkToken !== ''
      ? buildEmailVerificationLink(verifyBaseUrl, input.linkToken)
      : null;
  const linkExpiry = input.linkExpiresAt ?? '';
  return {
    to: input.to,
    // Unchanged even when a link rides along: the subject is what the recipient
    // scans an inbox for, and 「verification code」 is what they were told to
    // expect by the console's own copy.
    subject: 'Your FlowMic verification code',
    text: [
      'Someone asked to verify this address for a FlowMic account.',
      '',
      // 🔴 THE LINK GOES FIRST. It is the one-click path and the reason this
      // card exists; a code printed above it is a code most people will type
      // before they notice there was a faster way.
      ...(link !== null
        ? [
            'Open this link to verify the address — nothing else is needed:',
            link,
            // BOTH facts, and they are not the same fact: the instant is what
            // the stored row says, the duration is what the person needs to
            // decide whether to act now. Somebody reading this on a phone
            // cannot subtract an ISO timestamp from "now" in their head.
            ...(linkExpiry !== ''
              ? ['', `The link works once, and stops working at ${linkExpiry} (${minutes(EMAIL_VERIFICATION_LINK_TTL_MS)} minutes after it was sent).`]
              : ['', `The link works once, for ${minutes(EMAIL_VERIFICATION_LINK_TTL_MS)} minutes.`]),
            '',
            'If the link will not open, use this code in the FlowMic console instead:',
          ]
        : ['Your verification code is:']),
      input.code,
      '',
      `The code stops working at ${input.expiresAt} (${minutes(EMAIL_VERIFICATION_CODE_TTL_MS)} minutes after it was sent).`,
      '',
      // Covers BOTH arms in one sentence — 「nothing changes without the code」
      // stopped being the whole truth the moment a link could also open the gate.
      'If this was not you, ignore this email. Nothing changes unless the link is opened or the code is used.',
      '',
      'FlowMic',
    ].join('\n'),
  };
}

/**
 * Compose the product-level mailer from a transport and (optionally) the link
 * base.
 *
 * `verifyBaseUrl` is optional at THIS seam and not at mail/config.ts's: a
 * deployment always has one when mail is configured (config.ts derives it when
 * the operator did not set it), but the unit tests that predate NR-2a build
 * this mailer with a fake provider and no URL, and they must keep proving what
 * they were written to prove.
 */
export function makeEmailVerificationMailer(deps: {
  provider: MailProvider;
  verifyBaseUrl?: string;
}): EmailVerificationMailer {
  return {
    id: deps.provider.id,
    async sendVerificationCode(input: EmailVerificationMailInput): Promise<void> {
      await deps.provider.send(buildEmailVerificationEmail(input, deps.verifyBaseUrl));
    },
  };
}
