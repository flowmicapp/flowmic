// SPEC-REF:
//   src/http/billing-routes.ts (the one production caller)
//   docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md §3.6
//   src/mail/email-verification-mailer.ts — the product-level-mailer shape this
//     is a sibling of (one product question per interface, transport injected)
//   src/mail/provider.ts (the transport seam under this)
//
// 「Tell this person what just happened to their subscription」 — the one product
// question the billing routes ask of the mail channel.
//
// ── 🔴 WHY THIS MAIL IS NOT DECORATION ─────────────────────────────────────
// It is the cheapest chargeback prevention there is. A cancellation the user has
// no record of is one they will doubt in three weeks, and the move they make
// then is to call their bank — which costs us the amount plus a fee, charged to
// Paddle and deducted from our balance. A dated confirmation naming the end of
// service is the artefact that stops that conversation happening.
//
// ── LANGUAGE: ENGLISH, LIKE EVERY OTHER MAIL THIS REPO SENDS ───────────────
// ⚠️ AND NOT FOR THE REASON THE SIBLING FILE GIVES. `email-verification-mailer.ts`
// argues English-only from 「the account row has no language column, so any
// translation would be a guess rendered as a fact」. That was true once and is
// not now: `users.locale` exists (db/schema.ts) and `UserRecord.locale` carries
// it. Left uncorrected it would be cited as a reason by the next person, so it
// is corrected here rather than repeated — anti-façade ④, a claim about another
// part of the system whose truth changed while the sentence did not.
//
// The REAL reasons, which do hold:
//   · every mail this product sends today is English, and one localized message
//     in an otherwise English channel is not 「better」, it is two answers to
//     「what language does FlowMic write to me in」;
//   · owner's English-first ruling (2026-08-15) points the same way for anything
//     outward-facing;
//   · nine-locale mail templates are a real surface with a real maintenance
//     cost, and adding one on the way past — as a side effect of a cancellation
//     route — is how a surface arrives that nobody decided to own.
// ⇒ if this product ever does localize its mail, it is one card covering all of
//   them, not this file quietly going first.
//
// No HTML part and no greeting by name, both copied from the siblings and for
// their mechanical reasons: an HTML mail is the shape phishing filters are tuned
// for, and `users.display_name` is unverified, so putting it in a message is a
// small self-service phishing kit.

import type { MailMessage, MailProvider } from './provider';

export interface SubscriptionMailer {
  /**
   * Confirm that a cancellation has been scheduled.
   *
   * RESOLVES = the transport accepted the message. REJECTS = it did not.
   * 🔴 THE CALLER MUST NOT TURN A REJECTION INTO A FAILED CANCELLATION: by the
   * time this is called the subscription is already cancelled at Paddle, and
   * reporting 502 because the mail server had a bad minute would tell the user
   * their cancellation did not work — sending them to do it again, or to their
   * bank. billing-routes.ts logs the rejection by name and still answers 200.
   */
  sendCancellationConfirmed(input: CancellationMailInput): Promise<void>;
  /**
   * 0.3.25 B3 — acknowledge a statutory withdrawal.
   *
   * 🔴 THIS ONE IS NOT A COURTESY. CRD art. 11a requires the trader to
   * acknowledge receipt of a withdrawal on a DURABLE MEDIUM without undue delay,
   * and an email is how we discharge that. The message is the user's evidence
   * that they exercised the right and when — which is exactly why it must state
   * the date we received it rather than the date it was sent.
   *
   * ⚠️ Its failure is still not allowed to undo the withdrawal (the subscription
   * is already cancelled by the time this is called), but unlike the
   * cancellation mail above, a rejection here leaves a legal duty OUTSTANDING.
   * The caller logs it at error level and names it as something a human has to
   * finish by hand.
   */
  sendWithdrawalAcknowledged(input: WithdrawalMailInput): Promise<void>;
  /** Transport id for log lines only (`'resend'` / `'unconfigured'`). */
  readonly id: string;
}

export interface CancellationMailInput {
  /** The account's stored email — `users.email`, never a string from a request. */
  to: string;
  /**
   * When the service actually stops, ISO-8601, or null if we could not
   * establish it.
   *
   * 🔴 NULL IS RENDERED AS A DIFFERENT SENTENCE, not as a blank in the same one.
   * 「Your access continues until 2026-09-15」 with an empty date is worse than
   * useless — it is the exact 「a status word with nothing behind it」 shape R11
   * exists to stop, in an artefact the user keeps. When we do not know, the mail
   * says the renewal is stopped and points at the console for the date.
   */
  endsAt: string | null;
}

export interface WithdrawalMailInput {
  to: string;
  /** 🔴 When we RECEIVED the withdrawal, not when this mail went out. The
   *  acknowledgement is the user's proof of the date they exercised the right,
   *  and a retry an hour later must not silently move that date. */
  receivedAt: string;
  subscriptionId: string;
  /** What we did about the money. All three are stated in plain words, and
   *  'submitted' is deliberately NOT written as 「refunded」 — see below. */
  refundState: 'submitted' | 'failed' | 'none_due';
  amountMinor: number | null;
  currency: string | null;
}

/** Minor units → a printable amount. 600 / 'USD' → 'USD 6.00'. Currency code
 *  rather than a symbol: '$' would be wrong for four of the currencies Paddle
 *  settles in and there is no locale here to disambiguate it. */
function money(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor === null || currency === null || currency === '') return null;
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

export function buildWithdrawalEmail(input: WithdrawalMailInput): MailMessage {
  const amount = money(input.amountMinor, input.currency);
  // 🔴 THREE OUTCOMES, THREE SENTENCES, AND NONE OF THEM SAYS 「REFUNDED」.
  // Paddle holds most refunds for approval, so at the moment this mail is written
  // the money has NOT moved. 「We have requested」 is what is true; 「we have
  // refunded」 would be a statement the user could check and find false, in the
  // one artefact they will keep and quote back.
  const refundLines =
    input.refundState === 'submitted'
      ? [
          amount === null
            ? 'We have requested a refund of your most recent payment.'
            : `We have requested a refund of ${amount}, your most recent payment.`,
          '',
          'Refunds are issued by Paddle, who processed the payment, and are returned',
          'to the payment method you used. This normally takes a few working days to',
          'appear on your statement.',
        ]
      : input.refundState === 'none_due'
        ? [
            'There is no payment to return: this subscription was never charged.',
          ]
        : [
            // The honest version of a failure, and it does not ask the user to do
            // anything about it. They exercised a right; the obligation to
            // complete it is ours.
            'We were not able to submit the refund automatically. We have recorded',
            'your withdrawal and will complete the refund by hand — you do not need',
            'to do anything, and you will not be charged again.',
          ];
  return {
    to: input.to,
    subject: 'We have received your withdrawal from your FlowMic contract',
    text: [
      // The acknowledgement itself, and it comes first because it is the part
      // the article requires.
      `We received your withdrawal from your FlowMic subscription contract on ${day(input.receivedAt)}.`,
      '',
      `Subscription: ${input.subscriptionId}`,
      '',
      'Your subscription has been cancelled and the service has stopped. You will',
      'not be charged again.',
      '',
      ...refundLines,
      '',
      'Nothing you created has been deleted, and FlowMic continues to work on your',
      'own network without a subscription.',
      '',
      '— FlowMic',
    ].join('\n'),
  };
}

/** `2026-09-15T00:00:00.000Z` → `2026-09-15`. A time-of-day would imply a
 *  precision the billing period does not have, and a locale-formatted date in an
 *  English mail invites the reader to guess which of the two numbers is the
 *  month. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

export function buildCancellationEmail(input: CancellationMailInput): MailMessage {
  const ending =
    input.endsAt === null
      ? [
          'Your subscription will not renew.',
          '',
          'You can see the exact date your access ends on the Billing page in your',
          'FlowMic console.',
        ]
      : [
          `Your subscription will not renew, and your access continues until ${day(input.endsAt)}.`,
          '',
          'Nothing is being taken away before then, and nothing you have created is',
          'deleted or locked at any point.',
        ];
  return {
    to: input.to,
    subject: 'Your FlowMic subscription will not renew',
    text: [
      'We have scheduled the cancellation of your FlowMic subscription.',
      '',
      ...ending,
      '',
      // 🔴 The undo is named. A user who cancelled by mistake and cannot find the
      // way back cancels through their bank instead, which costs strictly more
      // than the subscription did. It is one sentence and it belongs here, in
      // the artefact they kept, not only on a page they have already left.
      'If you did not mean to do this, you can restart the subscription from the',
      'Billing page any time before that date, at no extra cost.',
      '',
      'You will not be charged again.',
      '',
      '— FlowMic',
    ].join('\n'),
  };
}

/**
 * Bind the template to a transport.
 *
 * There is NO no-op implementation of this, anywhere, for the reason
 * mail/provider.ts states in full: a mailer that accepts a message and drops it
 * cannot be diagnosed from either end. An unconfigured deployment gets the
 * loudly-failing provider, and the caller above is written to survive its
 * rejection without lying about the cancellation.
 */
export function makeSubscriptionMailer(provider: MailProvider): SubscriptionMailer {
  return {
    id: provider.id,
    async sendCancellationConfirmed(input): Promise<void> {
      await provider.send(buildCancellationEmail(input));
    },
    async sendWithdrawalAcknowledged(input): Promise<void> {
      await provider.send(buildWithdrawalEmail(input));
    },
  };
}
