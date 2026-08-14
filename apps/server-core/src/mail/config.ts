// SPEC-REF:
//   docs/rebuild/10-OPS-DEPLOY.md §4.1 (the FLOWMIC_MAIL_* block an operator sets)
//   src/stt/managed-default.ts (the house shape this file is modelled on)
//
// The FLOWMIC_MAIL_* env block → a MailConfig, or null when the deployment has
// deliberately not configured mail.
//
// SHAPE COPIED FROM `stt/managed-default.ts` ON PURPOSE, clause for clause:
//   · one STRICT '1'/'true' ENABLED gate — anything else (unset, '0', 'TRUE',
//     'yes') is OFF, so a fat-fingered env line fails toward the safe side;
//   · a `VALID_*` Set the provider id must be a member of;
//   · ENABLED-but-misconfigured is FAIL-LOUD (throws at boot), never a silent
//     skip back to disabled. That asymmetry is the whole point of the pattern:
//     "I didn't configure it" and "I configured it wrong" must not produce the same running server, because
//     the second one is an operator who believes mail works.
//
// 🔴 WHY EVERY FIELD BELOW IS REQUIRED WHEN ENABLED. Each one, if missing, turns
// a delivered email into a useless one — and it would be delivered, so nothing
// would look broken:
//   · no API key  → every send is rejected by the vendor (loud, at least);
//   · no FROM     → the vendor rejects it, or worse, sends from a default the
//                   recipient's provider marks as spam;
//   · no reset base URL → the mail arrives with a link to nowhere. THAT is the
//     silent one: the user gets an email, clicks, and lands on a 404 with a
//     token in the query string. Refusing to boot beats sending that.

/** Every mail transport this repo can build. `resend` is the only one today;
 *  the Set exists so an unknown value is a NAMED boot failure rather than a
 *  provider that silently resolves to nothing (same argument as
 *  `managed-default.ts` VALID_ENGINES). */
export const VALID_MAIL_PROVIDERS = new Set(['resend']);
export type MailProviderId = 'resend';

export interface MailConfig {
  provider: MailProviderId;
  /** The vendor API key. NEVER logged, never echoed, never put in an error
   *  message — the boot log prints its LENGTH, which is everything an operator
   *  needs to tell "configured wrong" from "not configured" and nothing an attacker can use. */
  apiKey: string;
  /** RFC-5322 sender, e.g. `FlowMic <noreply@flowmic.app>`. Passed through
   *  verbatim: validating addresses here would be a second, worse copy of the
   *  vendor's own validation, and the vendor's rejection is already named. */
  from: string;
  /** Where the reset link points, e.g. `https://flowmic.app/reset-password`.
   *  The token and the email ride as query parameters appended by
   *  mail/password-reset-mailer.ts. */
  resetBaseUrl: string;
  /** The transport endpoint. Defaults to the vendor's; overridable so a test or
   *  a staging box can point at a local server WITHOUT anyone having to reach
   *  for a network stub. Mirrors FLOWMIC_MANAGED_STT_ENDPOINT. */
  endpoint: string;
}

/** Resend's transactional send endpoint. A constant rather than a literal at the
 *  call site so the override in `MailConfig.endpoint` has something to override
 *  and a reader can see what the default actually is. */
export const DEFAULT_RESEND_ENDPOINT = 'https://api.resend.com/emails';

function requireNonEmpty(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(`config: FLOWMIC_MAIL_ENABLED is set but ${name} is missing or empty`);
  }
  return v.trim();
}

/**
 * Resolve the mail config from the environment, or null when mail is off.
 *
 * `null` means "this deployment deliberately has no mail channel" — a real,
 * supported state (standalone, a dev box, CI). It does NOT mean "fall back to
 * something": the caller (mail/index.ts) turns null into a LOUD, named,
 * always-failing channel, never into a quiet one.
 */
export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const enabled = env.FLOWMIC_MAIL_ENABLED;
  if (enabled !== '1' && enabled !== 'true') return null;

  const provider = env.FLOWMIC_MAIL_PROVIDER;
  if (!provider || !VALID_MAIL_PROVIDERS.has(provider)) {
    throw new Error(
      `config: FLOWMIC_MAIL_ENABLED is set but FLOWMIC_MAIL_PROVIDER is invalid: ${JSON.stringify(provider)} ` +
        `(supported: ${[...VALID_MAIL_PROVIDERS].join(', ')})`,
    );
  }

  const resetBaseUrl = requireNonEmpty(env, 'FLOWMIC_MAIL_RESET_BASE_URL');
  // Parsed, not pattern-matched: `new URL` is the same thing that will build the
  // link later, so a value that survives here cannot fail there. http is allowed
  // for a LAN/staging console; anything that is not http(s) (mailto:, file:, a
  // bare hostname) would produce a link no mail client will open.
  let parsed: URL;
  try {
    parsed = new URL(resetBaseUrl);
  } catch {
    throw new Error(`config: FLOWMIC_MAIL_RESET_BASE_URL is not a URL: ${JSON.stringify(resetBaseUrl)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `config: FLOWMIC_MAIL_RESET_BASE_URL must be http(s) (got ${JSON.stringify(parsed.protocol)})`,
    );
  }

  const endpointRaw = env.FLOWMIC_MAIL_ENDPOINT;
  return {
    provider: provider as MailProviderId,
    apiKey: requireNonEmpty(env, 'FLOWMIC_MAIL_API_KEY'),
    from: requireNonEmpty(env, 'FLOWMIC_MAIL_FROM'),
    resetBaseUrl,
    endpoint: endpointRaw && endpointRaw.trim() !== '' ? endpointRaw.trim() : DEFAULT_RESEND_ENDPOINT,
  };
}
