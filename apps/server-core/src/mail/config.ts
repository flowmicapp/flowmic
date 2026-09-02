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

/**
 * Every mail transport this repo can build. The Set exists so an unknown
 * value is a NAMED boot failure rather than a provider that silently resolves
 * to nothing (same argument as `managed-default.ts` VALID_ENGINES).
 *
 * 🔴 `'file'` (2026-09-02) IS A TEST FIXTURE, NOT A SECOND PRODUCTION
 * TRANSPORT — see mail/file.ts's header. It exists to retire
 * FLOWMIC_INTERNAL_RESET_TOKEN_ECHO / FLOWMIC_INTERNAL_VERIFICATION_CODE_ECHO
 * (owner-ordered deletion, docs/decisions/…-two-security-questions.md §3
 * problem 1): those two flags echoed a live secret onto the wire with no mode
 * gate, so a fat-fingered production env line was a two-request account
 * takeover of any known email.
 *
 * 🔴 2026-09-02 CORRECTION: the line this replaces read "nothing in this repo
 * sets `FLOWMIC_MAIL_PROVIDER=file` outside a test harness — grep it", as a
 * promise resting on nobody ever copying a test `.env` into production. That
 * is exactly the failure class the deleted echo flags were removed for one
 * paragraph above, and a comment is not a gate. `mailConfigFromEnv` below now
 * REFUSES `provider:'file'` at boot unless the process also sets
 * `FLOWMIC_TEST_BENCH=1` — a second, independent flag a copied mail block does
 * not carry by accident. This is NOT a re-creation of the deleted echo
 * switches: a bench declaration only permits the ON-DISK mailbox (mail/file.ts
 * writes one JSON file per message to a directory this same process chose);
 * it never echoes a secret onto the wire, gates no HTTP response, and reaches
 * no caller who did not already have filesystem access to this box.
 */
export const VALID_MAIL_PROVIDERS = new Set(['resend', 'file']);
export type MailProviderId = 'resend' | 'file';

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
  /**
   * NR-2a — where the one-click VERIFICATION link points, e.g.
   * `https://flowmic.app/verify`. The token rides as a query parameter appended
   * by mail/email-verification-mailer.ts.
   *
   * 🔴 IT IS DERIVED, NOT REQUIRED, and that is a deliberate departure from the
   * every-field-is-required rule this file's header argues for. The reason the
   * others are required is that a missing one produces a DELIVERED-BUT-USELESS
   * mail with nothing to notice. That failure is not available here: the console
   * that serves `/reset-password` is the same origin that serves `/verify`, so
   * the honest default is computable from a value the operator already had to
   * set correctly — and a value computed from a known-good one cannot be wrong
   * in a way an extra env var would have caught.
   *
   * `FLOWMIC_MAIL_VERIFY_BASE_URL` overrides it, for the one shape the
   * derivation cannot know about: a console served from a different host than
   * the reset page. Set explicitly, it is validated exactly like the reset base
   * (parsed with `URL`, http(s) only) — a bad override is a NAMED boot failure,
   * never a quiet fallback to the derived value, because "I configured it wrong"
   * and "I did not configure it" must not produce the same running server.
   */
  verifyBaseUrl: string;
  /** The transport endpoint. Defaults to the vendor's; overridable so a test or
   *  a staging box can point at a local server WITHOUT anyone having to reach
   *  for a network stub. Mirrors FLOWMIC_MANAGED_STT_ENDPOINT. Unused (`''`)
   *  when `provider === 'file'` — that transport has no endpoint, only a
   *  directory. */
  endpoint: string;
  /**
   * 2026-09-02 — FLOWMIC_MAIL_FILE_DIR. Non-null if and only if
   * `provider === 'file'`: where each outbound message is written as JSON
   * (mail/file.ts), for a test harness to read a reset token or verification
   * code back from instead of a wire echo. `null` for every other provider —
   * a resend deployment has no such directory, and defaulting this to
   * anything would invite a reader to check `fileDir !== null` instead of
   * `provider === 'file'`, which is the actual fact this field is a
   * consequence of, not a second copy of it.
   */
  fileDir: string | null;
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
  const parsed = requireHttpUrl(resetBaseUrl, 'FLOWMIC_MAIL_RESET_BASE_URL');

  // NR-2a. Explicit override wins and is validated identically; otherwise the
  // verification page is the console's `/verify` on the SAME ORIGIN as the reset
  // page — the one thing this deployment has already told us about its console.
  const verifyOverride = env.FLOWMIC_MAIL_VERIFY_BASE_URL;
  const verifyBaseUrl =
    verifyOverride !== undefined && verifyOverride.trim() !== ''
      ? requireHttpUrl(verifyOverride.trim(), 'FLOWMIC_MAIL_VERIFY_BASE_URL').toString()
      : new URL(VERIFY_PATH, parsed.origin).toString();

  // 🔴 2026-09-02 — the `file` fixture branches OFF entirely before the
  // resend-only fields below are required. `from` is still required: it is
  // read by the mailer that builds each message's text (buildPasswordResetEmail
  // etc.), not by any transport, so a file-provider test still exercises the
  // real "does this message read like the one an operator configured" path.
  // `apiKey`/`endpoint` have no meaning for a directory write and are left
  // '' rather than defaulted to something resend-shaped, per the field's own
  // doc comment.
  //
  // 🔴 THE BENCH GATE. A copied `.env` that happens to carry
  // `FLOWMIC_MAIL_PROVIDER=file` must not silently turn a live deployment's
  // reset tokens and verification codes into files on disk — that is the
  // exact "I didn't notice this was a test config" failure this whole file's
  // header argues against for every other field. `FLOWMIC_TEST_BENCH=1` is a
  // SECOND, unrelated flag: a harness that intentionally builds a mail-file
  // fixture sets it beside the mail block (verify/golden/harness.mjs
  // `mailFileEnv`, test/mail-config.test.ts `fileEnv`), so an accidental copy
  // of just the mail lines does not carry it. Fail-loud, named, at boot — the
  // same "misconfigured must not look like configured" rule as every other
  // throw in this function, never a quiet fall-through to `resend`.
  if (provider === 'file' && env.FLOWMIC_TEST_BENCH !== '1') {
    throw new Error(
      'config: FLOWMIC_MAIL_PROVIDER=file requires FLOWMIC_TEST_BENCH=1 — this transport writes reset tokens '
        + 'and verification codes to disk instead of sending them, and is a test fixture only (mail/file.ts). '
        + 'If this is a real deployment, set FLOWMIC_MAIL_PROVIDER=resend instead.',
    );
  }
  if (provider === 'file') {
    return {
      provider: 'file',
      apiKey: '',
      from: requireNonEmpty(env, 'FLOWMIC_MAIL_FROM'),
      resetBaseUrl,
      verifyBaseUrl,
      endpoint: '',
      fileDir: requireNonEmpty(env, 'FLOWMIC_MAIL_FILE_DIR'),
    };
  }

  const endpointRaw = env.FLOWMIC_MAIL_ENDPOINT;
  return {
    provider: 'resend',
    apiKey: requireNonEmpty(env, 'FLOWMIC_MAIL_API_KEY'),
    from: requireNonEmpty(env, 'FLOWMIC_MAIL_FROM'),
    resetBaseUrl,
    verifyBaseUrl,
    endpoint: endpointRaw && endpointRaw.trim() !== '' ? endpointRaw.trim() : DEFAULT_RESEND_ENDPOINT,
    fileDir: null,
  };
}

/** The console route that consumes a verification link. A constant rather than
 *  a literal in the derivation, so the one place that has to match the web
 *  console's router (its `/verify` route) is greppable from both sides. */
export const VERIFY_PATH = '/verify';

/** Parse + protocol-check one base URL, or throw naming the env var it came
 *  from. Shared by the reset base and the NR-2a verify override so the two
 *  cannot drift into two different definitions of「a usable link base」. */
function requireHttpUrl(value: string, envName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`config: ${envName} is not a URL: ${JSON.stringify(value)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`config: ${envName} must be http(s) (got ${JSON.stringify(parsed.protocol)})`);
  }
  return parsed;
}
