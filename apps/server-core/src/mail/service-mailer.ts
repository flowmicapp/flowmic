// SPEC-REF:
//   src/billing/guided-setup.ts (gs-5 — the wording this mail is the mechanism for)
//   src/http/ops-purchase-routes.ts (the completion notice's one production caller)
//   src/http/service-purchase-routes.ts (the withdrawal acknowledgement's)
//   src/mail/subscription-mailer.ts — the sibling this is shaped after, including
//     its argument for English-only and for no HTML part
//   Directive 2011/83/EU (CRD) art. 11(3) (acknowledging a withdrawal), art. 11a (the withdrawal function itself), art. 16(a)
//   *** HUMAN-AUDIT SENSITIVE (billing / legal) — reviewable in isolation ***
//
// The paid setup service's two letters: 「it is done」 and 「we heard you」.
//
// ── 🔴 WHY THE COMPLETION NOTICE IS NOT A COURTESY ─────────────────────────
//
// gs-5 (owner 2026-08-30) ends the no-reason refund at the instant an operator
// confirms the setup complete. That instant is one only we can see, so the
// buyer agreed to it on the condition that we TELL them — this email is that
// telling, and it also opens the two weeks of support they are owed. It is a
// letter we promised, on a date that matters to them.
//
// ⇒ ⚠️ THIS MESSAGE STARTS NO CLOCK. The refund closed when the operator
// pressed 'delivered', with or without this letter; the support fortnight runs
// from `delivered_at`, not from the send. `one_time_purchases.completion_notice_at`
// is stamped only when the transport ACCEPTS this message, and it is a RECORD
// that we told them — a NULL there is a duty still owed, which the operator
// queue shows, and nothing more. (Under gs-3/gs-4 this stamp started a
// post-completion refund window; that window no longer exists.)
//
// ── ⚠️ WHAT THIS FILE CANNOT DO, AND WHO HAS TO CARE ───────────────────────
//
// 「Accepted by the transport」 is not 「read by a person」. A message can be
// accepted and then bounce, be filed as spam, or arrive at an address the buyer
// abandoned. There is no bounce webhook wired in this repo, so nothing here can
// close that gap, and this comment exists so nobody reads the stamp as proof of
// receipt. What it IS proof of is that we sent it, on a date, to the address on
// the account — the same standard the withdrawal acknowledgement and the
// password reset already run on, and the artefact a dispute turns on.
//
// ── LANGUAGE: ENGLISH ──────────────────────────────────────────────────────
// Same three reasons the subscription mailer states in full (one channel, one
// language; owner's English-first ruling; nine-locale mail templates are a
// surface somebody has to own). ⇒ if this product ever localizes its mail it is
// one card covering all of them, not this file quietly going first.

import type { RefundReleaseReason } from '../db/repos/one-time-purchase.repo';
import type { MailMessage, MailProvider } from './provider';

/**
 * The declaration a buyer makes when they use the withdrawal function.
 *
 * 🔴 IT LIVES HERE AND THE CONSOLE RENDERS ITS OWN TRANSLATION OF IT. CRD art.
 * 11(3) requires the acknowledgement to reproduce the CONTENT of the
 * declaration, so this string and `console.svcWithdrawStatement` in the web repo
 * are two renderings of one sentence — English here because every mail this
 * product sends is English, localized there because that is where the buyer
 * reads it before confirming.
 *
 * ⚠️ IF THE TWO EVER DIVERGE, THE ONE THE BUYER SAW IS THE ONE THAT COUNTS.
 * There is no mechanism binding them today; keeping them in step is a human
 * duty, and this comment is what a reader has instead of a guard.
 */
export const WITHDRAWAL_DECLARATION =
  'I hereby withdraw from my contract for the FlowMic one-time setup service.';

export interface ServiceMailer {
  /**
   * Tell a buyer their setup is recorded as complete, and what that means.
   *
   * RESOLVES = the transport accepted it. REJECTS = it did not.
   *
   * 🔴 THE CALLER MUST NOT TURN A REJECTION INTO A FAILED DELIVERY. The session
   * really did happen; refusing the operator's click because a mail server had a
   * bad minute would leave the work unrecorded. What the caller must do instead
   * is NOT stamp `completion_notice_at` — so the row shows up in the operator
   * queue as a delivered purchase nobody was told about, and somebody sends the
   * letter by hand. The refund is closed either way (gs-5).
   */
  sendSetupCompleted(input: SetupCompletedMailInput): Promise<void>;
  /**
   * Acknowledge a withdrawal from the one-time service.
   *
   * 🔴 REQUIRED, NOT OPTIONAL: CRD art. 11(3) obliges the trader to acknowledge a
   * withdrawal on a durable medium without undue delay. The subscription side
   * has done this since 0.3.25; a one-time purchase that got no acknowledgement
   * while a subscription did would be the same legal duty discharged on one
   * surface and dropped on the other.
   */
  sendWithdrawalReceived(input: ServiceWithdrawalMailInput): Promise<void>;
  /**
   * Tell a buyer a refund we could not observe has been settled by hand.
   *
   * 🔴 IT QUOTES THE REFERENCE THE OPERATOR RECORDED. This is the one message
   * in this file that asserts money MOVED — every other refund sentence we send
   * says "asked" — and the only thing standing behind it is a human's word. The
   * buyer gets the same handle the operator has, so they can check it with their
   * bank instead of taking ours for it.
   */
  sendRefundSettledByHand(input: RefundSettledMailInput): Promise<void>;
  /**
   * Tell a buyer the refund request is over and their purchase is active again.
   *
   * 🔴 IT IS NOT OPTIONAL POLITENESS. Their console said "we have asked for
   * your money back"; without this letter it silently stops saying it, and the
   * buyer is left to discover on their own that a refund they exercised is not
   * coming. A silent revert is the same class of defect as the frozen row this
   * whole path exists to fix.
   */
  sendRefundReleased(input: RefundReleasedMailInput): Promise<void>;
  /** Transport id for log lines only (`'resend'` / `'unconfigured'`). */
  readonly id: string;
}

export interface SetupCompletedMailInput {
  /** The account's stored email — `users.email`, never a string from a request. */
  to: string;
  orderId: string;
  /** How many days of support follow completion (GUIDED_SETUP_AFTERCARE_DAYS).
   *  Help only — the letter says so in words, because the buyer agreed to that
   *  sentence and a reader must not be able to mistake it for a refund period. */
  aftercareDays: number;
}

export interface ServiceWithdrawalMailInput {
  to: string;
  orderId: string;
  /** 🔴 When we RECEIVED the withdrawal, not when this mail went out. It is the
   *  buyer's proof of the date they exercised the right, and a retry an hour
   *  later must not silently move that date. */
  receivedAt: string;
  amountMinor: number | null;
  currency: string | null;
}

export interface RefundSettledMailInput {
  to: string;
  orderId: string;
  /** 🔴 THE OPERATOR'S PROOF, VERBATIM. A bank reference, a provider refund id,
   *  whatever they had. It is quoted into the letter unchanged: paraphrasing a
   *  reference makes it useless to the person who has to look it up. */
  externalReference: string;
  amountMinor: number | null;
  currency: string | null;
}

export interface RefundReleasedMailInput {
  to: string;
  orderId: string;
  /** 🔴 WHICH OF THE TWO THINGS HAPPENED. The letters differ in more than tone:
   *  one has to explain that we could not complete a refund the buyer asked for
   *  (and that they may ask again), the other acknowledges that THEY called it
   *  off. Telling a buyer they changed their mind when they did not is the kind
   *  of sentence that ends up in a complaint. */
  reason: RefundReleaseReason;
}

/** Minor units → a printable amount. Currency CODE rather than a symbol, for the
 *  reason the sibling states: '$' is wrong for several of the currencies this
 *  will settle in and there is no locale here to disambiguate it. */
function money(amountMinor: number | null, currency: string | null): string | null {
  if (amountMinor === null || currency === null || currency === '') return null;
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

/** `2026-09-15T10:04:00.000Z` -> `2026-09-15`. A time of day would imply a
 *  precision the promise does not have, and a locale-formatted date in an
 *  English mail invites the reader to guess which number is the month. */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * `2026-09-15T10:04:00.000Z` -> `2026-09-15 at 10:04 UTC`.
 *
 * 🔴 DATE **AND TIME**, AND ONLY ON THE WITHDRAWAL ACKNOWLEDGEMENT. CRD art.
 * 11(3) requires that acknowledgement to state the date AND TIME the withdrawal
 * was submitted — it is the consumer's proof of exactly when they exercised the
 * right, and a date alone cannot settle a dispute about a deadline that expires
 * at a moment rather than on a day.
 *
 * ⚠️ THE COMPLETION NOTICE KEEPS `day()`. That message names a fortnight of
 * support, not a deadline measured in hours, and a timestamp there would imply
 * a precision the promise does not have. Two functions because they answer two
 * questions.
 *
 * ⚠️ UTC IS NAMED. 「10:04」 with no zone is the same defect as a bare date, one
 * unit down: the reader cannot tell whether a deadline was met.
 */
function stamp(iso: string): string {
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

export function buildSetupCompletedEmail(input: SetupCompletedMailInput): MailMessage {
  const weeks = input.aftercareDays === 14 ? 'two weeks' : `${String(input.aftercareDays)} days`;
  return {
    to: input.to,
    // ⚠️ NOT 「Thanks for your purchase」 or anything else a person deletes
    // unread. The subject has to survive a full inbox, because this is the
    // letter that tells the buyer their refund right has ended.
    subject: 'Your FlowMic setup is complete — and what happens next',
    text: [
      'We have confirmed your FlowMic setup is complete: your phone and your',
      'computer are working together.',
      '',
      `Order: ${input.orderId}`,
      '',
      // 🔴 THREE THINGS, IN THIS ORDER, ONE PARAGRAPH EACH. Support first because
      // it is what most people need; the closed refund second because it is the
      // consequence the buyer agreed to (gs-5 ②) and this is the moment it
      // becomes real for them — a notice that ended a right without naming it
      // would be worse than no notice; the legal-rights carve-out last, because
      // the sentence before it must not be read as shutting those out.
      `For the next ${weeks} we will keep helping you with this setup — just`,
      'reply to this email.',
      '',
      'Now that your setup is confirmed complete, refunds for this service are',
      'closed, and any question about a refund from here on is handled by email',
      '— just reply to this one. This does not affect your legal rights: if the',
      'setup was not provided as described, was not delivered, or does not work,',
      'reply to this email and we will put it right or refund you.',
      '',
      `After those ${weeks} of support the service is closed. You can still email`,
      'us if you need help.',
      '',
      '— FlowMic',
    ].join('\n'),
  };
}

export function buildServiceWithdrawalEmail(input: ServiceWithdrawalMailInput): MailMessage {
  const amount = money(input.amountMinor, input.currency);
  return {
    to: input.to,
    subject: 'We have received your withdrawal from your FlowMic setup service',
    text: [
      // The acknowledgement first, because that is the part the article requires.
      //
      // 🔴 THREE THINGS CRD art. 11(3) WANTS IN THIS MESSAGE, and all three are
      // here rather than only the first: that we received it, the DATE AND TIME
      // it was submitted, and the CONTENT of the declaration. An earlier draft
      // printed the date alone and cited the wrong article for the duty.
      `We received your withdrawal from your FlowMic setup service on ${stamp(input.receivedAt)}.`,
      '',
      `Order: ${input.orderId}`,
      '',
      'You submitted the following declaration:',
      '',
      // ⚠️ QUOTED, AND IN OUR OWN WORDS RATHER THAN A FIELD THE CLIENT SENT. The
      // console shows this exact sentence before the buyer confirms, so the mail
      // and the screen carry the same declaration — which is the point of
      // reproducing it at all.
      `    "${WITHDRAWAL_DECLARATION}"`,
      '',
      // 🔴 「REQUESTED」, NEVER 「REFUNDED」. At the moment this is written the
      // provider has been asked and has usually answered a non-terminal word;
      // the money has not moved. 「We have refunded you」 would be a statement the
      // reader could check and find false, in the one artefact they will keep.
      amount === null
        ? 'We have asked our payment provider to return your payment in full.'
        : `We have asked our payment provider to return your payment of ${amount} in full.`,
      '',
      'It goes back to the payment method you used, and normally takes a few',
      'working days to appear on your statement.',
      '',
      // ⚠️ THE PROMISE gs-3 MAKES ABOUT A CHANNEL THAT CANNOT PAY YOU BACK, kept
      // here too. It is the one sentence in this message that commits us to
      // doing something by hand, and it belongs in the copy the buyer keeps
      // rather than only in the terms they ticked.
      'If the payment channel cannot return it the way you paid, we will contact',
      'you and arrange another way. You do not need to chase us for it.',
      '',
      'Nothing you created has been deleted, and FlowMic continues to work on your',
      'own network.',
      '',
      '— FlowMic',
    ].join('\n'),
  };
}

export function buildRefundSettledEmail(input: RefundSettledMailInput): MailMessage {
  const amount = money(input.amountMinor, input.currency);
  return {
    to: input.to,
    subject: 'Your FlowMic setup service refund is complete',
    text: [
      amount === null
        ? 'Your refund for the FlowMic one-time setup service is complete.'
        : `Your refund of ${amount} for the FlowMic one-time setup service is complete.`,
      '',
      `Order: ${input.orderId}`,
      // 🔴 THE REFERENCE, ON ITS OWN LINE, LABELLED. This refund did not come
      // through the automatic channel — that is the entire reason this letter
      // exists — so the buyer cannot find it by looking at our system. This
      // string is what they take to their bank.
      `Payment reference: ${input.externalReference}`,
      '',
      'If it has not reached your account, reply to this email with that',
      'reference and we will chase it.',
      '',
      'Nothing you created has been deleted, and FlowMic continues to work on your',
      'own network.',
      '',
      '— FlowMic',
    ].join('\n'),
  };
}

export function buildRefundReleasedEmail(input: RefundReleasedMailInput): MailMessage {
  // 🔴 TWO LETTERS, ONE BUILDER, AND NO SHARED MIDDLE SENTENCE. The opening
  // paragraph is the whole difference and it is not cosmetic: one says WE could
  // not do it, the other says YOU asked us not to. A single paragraph fudged to
  // cover both would tell half the recipients something untrue about their own
  // conduct.
  const declined = input.reason === 'provider_declined';
  return {
    to: input.to,
    subject: declined
      ? 'We could not complete your FlowMic refund — your purchase is active again'
      : 'Your FlowMic refund request has been cancelled — your purchase is active again',
    text: [
      ...(declined
        ? [
            'We asked our payment provider to return your payment for the FlowMic',
            'one-time setup service, and it could not be completed through that',
            'channel. No money has moved.',
          ]
        : [
            'As you asked, we have cancelled your refund request for the FlowMic',
            'one-time setup service. No money has moved.',
          ]),
      '',
      `Order: ${input.orderId}`,
      '',
      // ⚠️ THE SAME SECOND PARAGRAPH FOR BOTH, and here that IS right: whichever
      // way the request ended, the purchase is live again and the buyer's rights
      // are identical. Saying it differently would imply a difference that does
      // not exist.
      'Your purchase is active again and your setup session is still yours. You',
      'can ask for a refund again at any time before we confirm the setup is',
      'complete — from your console, or simply by replying to this email.',
      ...(declined
        ? [
            '',
            'If you want the refund, reply to this email and we will arrange it',
            'another way. You do not need to chase us for it.',
          ]
        : []),
      '',
      '— FlowMic',
    ].join('\n'),
  };
}

/**
 * Bind the templates to a transport.
 *
 * There is NO no-op implementation of this, for the reason mail/provider.ts
 * states in full: a mailer that accepts a message and drops it cannot be
 * diagnosed from either end. An unconfigured deployment gets the loudly-failing
 * provider, the completion stamp is never written, and the operator queue keeps
 * showing the delivery as unnotified until somebody sends the letter by hand.
 */
export function makeServiceMailer(provider: MailProvider): ServiceMailer {
  return {
    id: provider.id,
    async sendSetupCompleted(input): Promise<void> {
      await provider.send(buildSetupCompletedEmail(input));
    },
    async sendWithdrawalReceived(input): Promise<void> {
      await provider.send(buildServiceWithdrawalEmail(input));
    },
    async sendRefundSettledByHand(input): Promise<void> {
      await provider.send(buildRefundSettledEmail(input));
    },
    async sendRefundReleased(input): Promise<void> {
      await provider.send(buildRefundReleasedEmail(input));
    },
  };
}
