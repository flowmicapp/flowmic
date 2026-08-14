// SPEC-REF:
//   src/bootstrap.ts (the one production caller of resolvePasswordResetMailer)
//   src/mail/config.ts / resend.ts / unconfigured.ts / password-reset-mailer.ts
//   docs/rebuild/10-OPS-DEPLOY.md §4.1
//
// COMPOSITION TIME — where the mail channel is chosen, and where an operator is
// told, by name, that there isn't one.

import { log } from '../log';
import { mailConfigFromEnv } from './config';
import { createResendMailProvider } from './resend';
import { makePasswordResetMailer, type PasswordResetMailer } from './password-reset-mailer';
import { makeEmailVerificationMailer, type EmailVerificationMailer } from './email-verification-mailer';
import { MAIL_ENV_KEYS, unconfiguredEmailVerificationMailer, unconfiguredPasswordResetMailer } from './unconfigured';

export type { MailConfig, MailProviderId } from './config';
export type { MailMessage, MailProvider } from './provider';
export { MailNotConfiguredError } from './provider';
export type { PasswordResetMailer, PasswordResetMailInput } from './password-reset-mailer';
export { buildPasswordResetEmail, buildPasswordResetLink, makePasswordResetMailer } from './password-reset-mailer';
export type { EmailVerificationMailer, EmailVerificationMailInput } from './email-verification-mailer';
export { buildEmailVerificationEmail, makeEmailVerificationMailer } from './email-verification-mailer';
export { mailConfigFromEnv } from './config';
export { unconfiguredEmailVerificationMailer, unconfiguredPasswordResetMailer } from './unconfigured';

/**
 * Build the mail channel this process will use. ALWAYS returns a mailer —
 * either a real one or the loudly-failing one — so the dependency it feeds can
 * be REQUIRED (no `?`, no default) at every object literal that constructs the
 * console routes.
 *
 * 🔴 THE UNCONFIGURED PATH SHOUTS HERE, ONCE, AT COMPOSITION TIME, and that
 * placement is the argument: a per-request warning is only read by someone who
 * is already investigating a complaint, whereas this line is in front of the
 * operator who just deployed — the one person who can fix it in a minute. It
 * says WHICH feature is dead and WHICH keys are missing, because 「mail not
 * configured」 is a fact and 「password reset cannot be delivered; set these five
 * variables」 is an action.
 *
 * ⚠️ It is `log.error`, not `warn`. This is not a preference about severity: a
 * saas deployment whose users cannot recover an account has a broken product
 * surface, and grepping ERROR is how an operator finds that in a file with
 * thousands of INFO lines.
 *
 * A misconfigured (as opposed to absent) mail block THROWS out of
 * `mailConfigFromEnv` and takes the boot with it — deliberately, see that file's
 * header: "I didn't configure it" and "I configured it wrong" must not produce
 * the same running server.
 */
export function resolvePasswordResetMailer(env: NodeJS.ProcessEnv = process.env): PasswordResetMailer {
  const config = mailConfigFromEnv(env);
  if (config === null) {
    log.error(
      'mail: NO MAIL CHANNEL IS CONFIGURED — password reset emails cannot be delivered on this deployment. ' +
        'Every attempt will fail by name (MAIL_NOT_CONFIGURED); nothing will silently claim to have sent one.',
      { missing: MAIL_ENV_KEYS.join(','), doc: 'docs/rebuild/10-OPS-DEPLOY.md §4.1' },
    );
    return unconfiguredPasswordResetMailer();
  }
  // 🔴 Presence + LENGTH, never the key itself — the same rule config.ts's
  // paddle block follows, and for the same reason: length is everything an
  // operator needs to tell "configured wrong" from "not configured" and
  // nothing an attacker gets.
  log.info('mail: channel configured', {
    provider: config.provider,
    from: config.from,
    reset_base_url: config.resetBaseUrl,
    endpoint: config.endpoint,
    api_key_len: config.apiKey.length,
  });
  return makePasswordResetMailer({
    provider: createResendMailProvider(config),
    resetBaseUrl: config.resetBaseUrl,
  });
}

/**
 * VERIFY-1 — the verification-code channel, resolved from the SAME
 * FLOWMIC_MAIL_* block as its password-reset sibling (one mail configuration
 * per deployment; the two mailers differ only in the product question they
 * answer). Always returns a mailer, real or loudly failing, for the same
 * required-downstream reason `resolvePasswordResetMailer` states above.
 *
 * The unconfigured line is a SECOND ERROR line on purpose, not a duplicate of
 * the sibling's: each names WHICH product surface is dead, and 「password reset
 * cannot be delivered」 does not tell an operator that new sign-ins are now
 * stuck at a verification card. The configured case logs only the transport id
 * — the full config line (from/endpoint/key length) is the sibling's, printed
 * once per boot, and a second copy of it would just be the same fact twice.
 */
export function resolveEmailVerificationMailer(env: NodeJS.ProcessEnv = process.env): EmailVerificationMailer {
  const config = mailConfigFromEnv(env);
  if (config === null) {
    log.error(
      'mail: NO MAIL CHANNEL IS CONFIGURED — email-verification codes cannot be delivered on this deployment, ' +
        'so a new account cannot pass the console verification gate. Every send will fail by name ' +
        '(VERIFY_SEND_FAILED on the wire, MAIL_NOT_CONFIGURED in the log); nothing will silently claim to have sent one.',
      { missing: MAIL_ENV_KEYS.join(','), doc: 'docs/rebuild/10-OPS-DEPLOY.md §4.1' },
    );
    return unconfiguredEmailVerificationMailer();
  }
  log.info('mail: email-verification channel ready', { provider: config.provider });
  return makeEmailVerificationMailer({ provider: createResendMailProvider(config) });
}
