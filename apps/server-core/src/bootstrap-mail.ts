// SPEC-REF:
//   apps/server-core/src/bootstrap.ts (its only caller)
//   apps/server-core/src/mail/index.ts (each resolver, and why the unconfigured
//     case shouts at composition time instead of returning a quiet no-op)
//
// THE FOUR MAIL CHANNELS THIS PROCESS WILL USE, resolved once per boot.
//
// 🔴 WHY IT MOVED OUT OF bootstrap.ts, so nobody re-merges it: that file crossed
// the repo's 800-line cap when gs-3 added the fourth channel. The precedent is
// to move a coherent family out VERBATIM and keep the reasoning — schema.ts →
// schema-billing.ts, bootstrap-http-deps.ts → bootstrap-billing-deps.ts,
// bootstrap.ts → bootstrap-sweeps.ts. The four blocks below are that file's
// text, unchanged.
//
// ── ⚠️ WHY FOUR RESOLUTIONS OF ONE ENV BLOCK, AND NOT ONE ─────────────────
//
// They all read the same FLOWMIC_MAIL_* configuration, so a single resolver
// would be shorter. It would also print ONE failure line, and the actionable
// half of that message is WHICH product surface just died: 「password reset
// cannot be delivered」 does not tell an operator that new sign-ins are stuck at
// a verification card, or that every completed setup is now refundable
// indefinitely. Four lines, four features, four things a person can go and fix.
//
// ── 🔴 THE TWO RULES EVERY ARM FOLLOWS ────────────────────────────────────
//
// · SAAS-ONLY RESOLUTION, so 「no mail channel is configured」 never fires on a
//   standalone box for a feature it does not mount (no account ⇒ no password to
//   reset). That ERROR line means exactly one thing.
// · THE STANDALONE ARM IS THE LOUDLY-FAILING MAILER AND NOT NULL, because a
//   nullable would force a `!` at the console literal downstream, and 「it cannot
//   be null there, trust me」 is the kind of claim that outlives its truth.
//   Standalone never mounts those routes, so it is never read.
//
// ⚠️ `??` SHORT-CIRCUITS, so an injected test double never triggers an env
// resolution — or its boot log line.

import type { ServerConfig } from './config';
import {
  resolveEmailVerificationMailer,
  resolvePasswordResetMailer,
  resolveServiceMailer,
  resolveSubscriptionMailer,
  unconfiguredEmailVerificationMailer,
  unconfiguredPasswordResetMailer,
  unconfiguredServiceMailer,
  unconfiguredSubscriptionMailer,
  type EmailVerificationMailer,
  type PasswordResetMailer,
  type ServiceMailer,
  type SubscriptionMailer,
} from './mail';

/** Test doubles, one per channel. Optional HERE and required DOWNSTREAM, which
 *  is the right way round: an absent override still yields a real (or loudly
 *  failing) mailer, never nothing. */
export interface MailOverrides {
  mail?: PasswordResetMailer;
  verificationMail?: EmailVerificationMailer;
  subscriptionMail?: SubscriptionMailer;
  serviceMail?: ServiceMailer;
}

export interface ResolvedMailers {
  mail: PasswordResetMailer;
  verificationMail: EmailVerificationMailer;
  subscriptionMail: SubscriptionMailer;
  serviceMail: ServiceMailer;
}

export function resolveMailers(
  config: ServerConfig,
  overrides: MailOverrides,
): ResolvedMailers {
  const saas = config.mode === 'saas';
  return {
    // 🔴 MAIL-1 — the password-reset channel.
    mail: saas
      ? (overrides.mail ?? resolvePasswordResetMailer())
      : (overrides.mail ?? unconfiguredPasswordResetMailer()),
    // VERIFY-1 — the verification-code channel.
    verificationMail: saas
      ? (overrides.verificationMail ?? resolveEmailVerificationMailer())
      : (overrides.verificationMail ?? unconfiguredEmailVerificationMailer()),
    // 0.3.25 B2 — the subscription-confirmation channel. Standalone has no
    // merchant of record and mounts no billing controls.
    subscriptionMail: saas
      ? (overrides.subscriptionMail ?? resolveSubscriptionMailer())
      : (overrides.subscriptionMail ?? unconfiguredSubscriptionMailer()),
    // The setup service's channel. 🔴 IT CARRIES MORE WEIGHT THAN A RECEIPT:
    // its two letters are ones the buyer agreed to receive (gs-5 completion
    // notice; CRD art. 11(3) withdrawal acknowledgement), so a dead channel is
    // a standing duty left undischarged (mail/index.ts has the whole argument,
    // and that is why its unconfigured line is an `error`).
    serviceMail: saas
      ? (overrides.serviceMail ?? resolveServiceMailer())
      : (overrides.serviceMail ?? unconfiguredServiceMailer()),
  };
}
