// SPEC-REF:
//   src/mail/provider.ts ("there is no no-op implementation, anywhere")
//   CLAUDE.md anti-façade / book 13 §7 F1 ② (a DI default is the real thing or a throw)
//
// What a deployment with no mail configuration gets — and it is NOT a mailer
// that does nothing quietly.
//
// 🔴 THIS FILE IS THE WHOLE POINT OF THE CARD. The tempting shape here is an
// object whose `sendPasswordReset` resolves immediately, so that a box without
// mail 「still works」. That object would make `POST /api/password/forgot` log
// 「dispatched」 on a server that has no way to send anything, and the failure
// would surface only as a user who never got an email — days later, to somebody
// with no way to trace it. Every path out of this object is a REJECTION carrying
// the name of what is missing.
//
// ⚠️ It is also not a `throw` at construction time. Refusing to BOOT would mean
// a mail misconfiguration takes down transcription, pairing and injection for
// everyone — a strictly larger outage than the one feature that actually needs
// mail. So: construct loudly (mail/index.ts logs at ERROR, by name, once, at
// composition time), serve everything else, and fail this one operation by name
// every time it is attempted. That is the same trade `http/ops-audit-trail.ts`
// recordGateOutcome argues, made in the same direction and for the same reason.

import { MailNotConfiguredError } from './provider';
import type { PasswordResetMailer } from './password-reset-mailer';
import type { EmailVerificationMailer } from './email-verification-mailer';
import type { SubscriptionMailer } from './subscription-mailer';
import type { ServiceMailer } from './service-mailer';

/** The env keys an operator has to set, named IN the failure so the error itself
 *  is the runbook. Kept beside the thrower rather than in the log line: the
 *  person reading a stack trace at 2am is not the person who read the boot log. */
export const MAIL_ENV_KEYS = [
  'FLOWMIC_MAIL_ENABLED',
  'FLOWMIC_MAIL_PROVIDER',
  'FLOWMIC_MAIL_API_KEY',
  'FLOWMIC_MAIL_FROM',
  'FLOWMIC_MAIL_RESET_BASE_URL',
] as const;

export function unconfiguredPasswordResetMailer(): PasswordResetMailer {
  return {
    id: 'unconfigured',
    sendPasswordReset(): Promise<void> {
      return Promise.reject(
        new MailNotConfiguredError(
          'no mail channel is configured on this deployment — a password reset cannot be delivered. ' +
            `Set ${MAIL_ENV_KEYS.join(', ')} (see docs/rebuild/10-OPS-DEPLOY.md §4.1)`,
        ),
      );
    },
  };
}

/** 0.3.25 B2 — the subscription-confirmation sibling, under the same doctrine.
 *
 *  🔴 ITS CALLER IS THE ONE THAT MUST NOT TREAT THIS REJECTION AS A FAILED
 *  OPERATION, and that is not a softening of this file's rule — it is the rule
 *  applied to a case the other two do not have. By the time this is called the
 *  subscription is ALREADY cancelled at Paddle. A rejection here means 「the
 *  cancellation happened and the receipt did not」; reporting it as 「your
 *  cancellation failed」 would be the lie this whole module exists to prevent,
 *  just pointed the other way. http/billing-routes.ts logs it by name and still
 *  answers 200 — recorded, not swallowed. */
export function unconfiguredSubscriptionMailer(): SubscriptionMailer {
  return {
    id: 'unconfigured',
    sendCancellationConfirmed(): Promise<void> {
      return Promise.reject(
        new MailNotConfiguredError(
          'no mail channel is configured on this deployment — a cancellation confirmation cannot be delivered. ' +
            `Set ${MAIL_ENV_KEYS.join(', ')} (see docs/rebuild/10-OPS-DEPLOY.md §4.1)`,
        ),
      );
    },
    /** 0.3.25 B3. Rejects like its sibling, and the message names the stake:
     *  this acknowledgement is not a receipt we would like to send, it is how
     *  CRD art. 11(3) is discharged. On a deployment with no mail channel the duty
     *  is left outstanding on EVERY withdrawal, and an operator should read that
     *  in the words rather than infer it from an email that never arrived. */
    sendWithdrawalAcknowledged(): Promise<void> {
      return Promise.reject(
        new MailNotConfiguredError(
          'no mail channel is configured on this deployment — a WITHDRAWAL ACKNOWLEDGEMENT cannot be delivered. ' +
            'This one is a legal duty (CRD art. 11(3): acknowledge receipt on a durable medium without delay), ' +
            'so every withdrawal on this box leaves it unfulfilled and someone has to send it by hand. ' +
            `Set ${MAIL_ENV_KEYS.join(', ')} (see docs/rebuild/10-OPS-DEPLOY.md §4.1)`,
        ),
      );
    },
  };
}

/**
 * The paid setup service's sibling, under the same doctrine.
 *
 * ⚠️ WHAT A DEAD CHANNEL COSTS HERE (gs-5): the buyer is never told their setup
 * is complete and never told that two weeks of support started. It does NOT
 * change what they can do with their money — the refund closes at 'delivered'
 * whether or not the email went out — so the exposure is a broken promise to
 * write, not an open window. `completion_notice_at` stays NULL and the
 * operator queue shows the row as delivered-but-unnotified, which is the duty
 * somebody has to discharge by hand.
 *
 * 🔴 2026-08-31 — AND WHAT IT COSTS ON THE TWO REFUND-RESOLUTION LETTERS IS
 * WORSE, so it is stated separately rather than folded into the paragraph
 * above. The buyer's console has been saying "we have asked for your money
 * back"; when an operator ends that request the sentence simply stops
 * appearing. Without the letter the buyer is never told whether the money is
 * coming, and nothing on their screen distinguishes "settled by hand" from "we
 * could not do it". The routes still make the state change — the decision is
 * audited and must not be lost to a mail outage — and report
 * `notice_sent: false` so the letter is a visible duty rather than an
 * assumption.
 */
export function unconfiguredServiceMailer(): ServiceMailer {
  return {
    id: 'unconfigured',
    sendSetupCompleted(): Promise<void> {
      return Promise.reject(
        new MailNotConfiguredError(
          'no mail channel is configured on this deployment — a SETUP COMPLETION NOTICE cannot be delivered. ' +
            'The buyer agreed (gs-5) to be emailed when their setup is confirmed complete and their two weeks ' +
            'of support begin; on this box nobody is told, and the row stays flagged as unnotified. ' +
            `Set ${MAIL_ENV_KEYS.join(', ')} (see docs/rebuild/10-OPS-DEPLOY.md §4.1)`,
        ),
      );
    },
    sendRefundSettledByHand(): Promise<void> {
      return Promise.reject(
        new MailNotConfiguredError(
          'no mail channel is configured on this deployment — a REFUND SETTLEMENT NOTICE cannot be delivered. ' +
            'An operator has recorded that this refund was paid outside our provider; the buyer is not being ' +
            'told, and they are not being given the payment reference they would need to trace it. ' +
            `Set ${MAIL_ENV_KEYS.join(', ')} (see docs/rebuild/10-OPS-DEPLOY.md §4.1)`,
        ),
      );
    },
    sendRefundReleased(): Promise<void> {
      return Promise.reject(
        new MailNotConfiguredError(
          'no mail channel is configured on this deployment — a REFUND RELEASE NOTICE cannot be delivered. ' +
            'A refund this buyer asked for has ended without the money moving, and their console will simply ' +
            'stop saying it was requested. Nobody is telling them; someone has to, by hand. ' +
            `Set ${MAIL_ENV_KEYS.join(', ')} (see docs/rebuild/10-OPS-DEPLOY.md §4.1)`,
        ),
      );
    },
    sendWithdrawalReceived(): Promise<void> {
      return Promise.reject(
        new MailNotConfiguredError(
          'no mail channel is configured on this deployment — a WITHDRAWAL ACKNOWLEDGEMENT cannot be delivered. ' +
            'This one is a legal duty (CRD art. 11(3): acknowledge receipt on a durable medium without delay), ' +
            'so every withdrawal on this box leaves it unfulfilled and someone has to send it by hand. ' +
            `Set ${MAIL_ENV_KEYS.join(', ')} (see docs/rebuild/10-OPS-DEPLOY.md §4.1)`,
        ),
      );
    },
  };
}

/** VERIFY-1 — the verification-code sibling, under the exact same doctrine as
 *  the mailer above (this file's header IS the argument; nothing here quietly
 *  succeeds). The route turns this rejection into a NAMED 5xx on the wire —
 *  unlike password reset there is no anti-enumeration reason to hide it. */
export function unconfiguredEmailVerificationMailer(): EmailVerificationMailer {
  return {
    id: 'unconfigured',
    sendVerificationCode(): Promise<void> {
      return Promise.reject(
        new MailNotConfiguredError(
          'no mail channel is configured on this deployment — an email-verification code cannot be delivered. ' +
            `Set ${MAIL_ENV_KEYS.join(', ')} (see docs/rebuild/10-OPS-DEPLOY.md §4.1)`,
        ),
      );
    },
  };
}
