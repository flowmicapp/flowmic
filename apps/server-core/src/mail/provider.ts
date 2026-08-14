// SPEC-REF:
//   docs/rebuild/10-OPS-DEPLOY.md §4.1 (FLOWMIC_MAIL_* env block)
//   CLAUDE.md red line: no silent failure (BOTH directions) / anti-façade ①②
//
// The transport seam: "hand this message to a mail service", and nothing else.
//
// 🔴 THERE IS NO NO-OP IMPLEMENTATION OF THIS INTERFACE, ANYWHERE, ON PURPOSE.
// A mailer that accepts a message and quietly drops it is the exact shape book 13
// §7 F1 ② forbids for a DI default ("either a real implementation or a throw"), and it is worse than
// the hole it papers over: an undeliverable password reset that LOOKS delivered
// cannot be diagnosed from either end — the user waits for an email, the
// operator's logs say the request succeeded, and nothing anywhere is red.
// The unconfigured case has its own named, LOUD implementation
// (mail/unconfigured.ts) that rejects every call by name.
//
// ⚠️ `docs/rebuild/10-OPS-DEPLOY.md` line 130 describes the LEGACY line's
// behaviour as "RESEND_API_KEY+FLOWMIC_FROM_EMAIL (defaults to a no-op mailer)". That
// sentence is a description of a stack that was retired in 2026-07 (§4's own
// correction block says so of the whole section, and §4.0 row #16 measured those
// two env vars as appearing NOWHERE in today's code). It is NOT a design this
// repo inherits, and MAIL-1 deliberately did not reproduce it.

/** One outbound message. Plain text only — see mail/password-reset-mailer.ts for
 *  why there is no HTML part. */
export interface MailMessage {
  /** A single recipient address. Not an array: every message this repo sends
   *  today goes to exactly one person, and a list-shaped field invites a future
   *  caller to BCC two accounts into one password-reset thread. */
  to: string;
  subject: string;
  text: string;
}

export interface MailProvider {
  /**
   * Deliver the message, or REJECT.
   *
   * The contract is deliberately "resolve means the provider accepted it" and
   * nothing stronger: no mail API can promise the mailbox received it. A caller
   * that turns a resolve into the words "email sent" is making a claim this
   * interface never made — which is why the one production caller logs
   * "dispatched" (we handed it over) rather than "sent"/"delivered".
   */
  send(message: MailMessage): Promise<void>;

  /** Which transport this is, for log lines only (`'resend'`, `'unconfigured'`).
   *  Never rendered to a user, never on the wire. */
  readonly id: string;
}

/** Raised when something asks the mail channel to deliver and the deployment has
 *  no mail channel configured.
 *
 * A DISTINCT type rather than a generic Error because the two failure directions
 * need different actions from different people: this one is "an operator has to
 * put five env vars on the box", whereas a transport failure is "the mail API
 * had a bad minute, look at its status". Collapsing them into one message is the
 * "one value answers two questions" shape.
 *
 * ⚠️ `code` here is an INTERNAL diagnostic identifier for log lines and tests. It
 * is NOT a protocol error code: it never crosses a socket or an HTTP body, it is
 * not in `packages/protocol` `ERROR_CODES`, and the code table did not move for
 * MAIL-1. `test/mail-password-reset.test.ts` asserts that absence rather than
 * leaving it as a promise in a comment. */
export class MailNotConfiguredError extends Error {
  readonly code = 'MAIL_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'MailNotConfiguredError';
  }
}
