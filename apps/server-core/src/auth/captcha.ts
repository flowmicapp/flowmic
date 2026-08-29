// SPEC-REF:
//   docs/decisions/2026-08-27-owner-web-rulings-batch-2.md item 4, third clause
//     (owner, verbatim: 「控制台也需要控制整体的一个策略，如果当天注册用户太多如
//      达到 50 个以上就需要立即做验证码确认」)
//   src/auth/registration-surge.ts — the ONLY consumer: the counter that decides
//     WHEN a challenge is demanded. This module only answers「is this token
//     good」and never decides whether one was needed.
//   src/mail/provider.ts — the seam pattern this file copies clause for clause
//     (one product question, transport injected, a LOUD unconfigured arm and no
//     permissive default anywhere)
//   src/auth/google-id-token.ts — the same doctrine on the same kind of surface
//   *** SENSITIVE SURFACE (auth: the gate that stands in front of account
//       creation during a surge) ***
//
// 「Did a real person solve a challenge for this request」 — one question, one
// interface, and nothing else. No counter, no policy, no HTTP route.
//
// ── WHY CLOUDFLARE TURNSTILE ───────────────────────────────────────────────
// Not a preference. This deployment is already behind Cloudflare (the origin
// move on 2026-08-17: orange-cloud, Full(strict), ufw restricted to CF ranges),
// so the vendor is one we already trust with every byte of this traffic and the
// widget's CDN is already in the CSP-shaped set of hosts the console reaches.
// Adding a SECOND third party to the one route that mints accounts would be a
// new supply-chain surface bought for nothing.
//
// ── 🔴 THERE IS NO PERMISSIVE IMPLEMENTATION OF THIS INTERFACE, ANYWHERE ────
// Book 13 §7 F1 ②, on a surface where the cost of getting it wrong is money: a
// verifier that returned `true` when it could not check would be the whole gate
// removed, wearing the shape of a friendly DI default. The unconfigured case
// has its own named implementation below that answers `false` every time AND
// reports `configured: false`, so the caller can tell 「this deployment cannot
// run a challenge」 apart from 「this person failed one」 — two facts that need
// two different responses (auth/registration-surge.ts makes that split).
//
// ── ENVIRONMENT ────────────────────────────────────────────────────────────
//   FLOWMIC_TURNSTILE_SECRET — the Turnstile SECRET key (server side). UNSET ⇒
//     this deployment cannot verify a challenge at all; see the fail-closed
//     argument in auth/registration-surge.ts for what happens then. It IS a
//     secret and never leaves this process.
//   FLOWMIC_TURNSTILE_VERIFY_URL — optional override of the siteverify
//     endpoint, so a test or a staging box can point at a local server WITHOUT
//     a network stub. The same affordance FLOWMIC_MAIL_ENDPOINT and
//     FLOWMIC_GOOGLE_JWKS_URL give their modules.
//   ⚠️ The SITE key (the widget's public half) is deliberately NOT here. It
//     lives in the web build as VITE_TURNSTILE_SITE_KEY, because it is public
//     by construction and the server has no use for it — putting it beside the
//     secret would invite somebody to serve one from the other.

import { log } from '../log';

/** Cloudflare's server-side verification endpoint. */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * 「Is this challenge token good」 — the ONE question the registration surge
 * gate asks of a captcha provider.
 */
export interface CaptchaVerifier {
  /** For log lines only (`'turnstile'` / `'unconfigured'` / `'fake'`). */
  readonly id: string;
  /**
   * Can this deployment run a challenge AT ALL?
   *
   * 🔴 A SEPARATE FACT FROM `verify()`'s answer, and the split is the point.
   * An unconfigured deployment and a failed solve both produce「no」from
   * `verify`, and they call for opposite responses: one is an operator's
   * problem (nobody can get in — say so loudly, close the door), the other is
   * this one caller's problem (show them the widget again). Collapsing them
   * would make a misconfigured box look exactly like a box under attack.
   */
  readonly configured: boolean;
  /**
   * RESOLVES `true` iff the provider vouched for the token. NEVER throws and
   * never resolves `true` on an error — a verification that could not be
   * performed is not a verification that passed.
   *
   * @param remoteIp the caller's address, passed through to the provider as a
   *   corroborating signal. Optional because it is optional to Turnstile.
   */
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

/** The subset of `fetch` this module uses. Injected so a test can drive the
 *  REAL verifier — the same reason google-id-token.ts injects its JWKS fetch,
 *  rather than replacing the thing under test with a double. */
export type CaptchaFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * What a deployment with no `FLOWMIC_TURNSTILE_SECRET` gets.
 *
 * ⚠️ IT IS NOT A THROW AT CONSTRUCTION. Refusing to boot over a missing captcha
 * secret would take down transcription, pairing and injection for everyone — a
 * strictly larger outage than the one thing that needs it, and one that only
 * matters on days a surge happens. Same trade mail/unconfigured.ts argues.
 */
export function unconfiguredCaptchaVerifier(): CaptchaVerifier {
  return {
    id: 'unconfigured',
    configured: false,
    verify(): Promise<boolean> {
      // No log line here on purpose: this is called only while the gate is
      // already shouting (registration-surge.ts logs the closure by name, once
      // per refusal, with the env var in it). A second line per attempt would
      // turn an attack into a log flood on our side.
      return Promise.resolve(false);
    },
  };
}

/**
 * The real thing: POST the token to Cloudflare and believe only `success:true`.
 *
 * 🔴 EVERY FAILURE ARM RETURNS `false`, and each one is logged by name. A
 * timeout, a 500 from Cloudflare, a body that is not JSON — none of them are
 * evidence that a human solved anything. This is the fail-closed direction and
 * it is chosen deliberately: the gate only runs at all on a day when ≥50
 * accounts have already been created, so the alternative («let them through
 * when we cannot check») hands an attacker a way to disable the gate by
 * degrading one HTTP call.
 *
 * ⚠️ `application/x-www-form-urlencoded`, not JSON — that is what siteverify
 * accepts. `URLSearchParams` builds it, never string concatenation: a secret
 * containing a `+` or `&` hand-joined into a body is a silent authentication
 * failure that looks like a wrong key.
 */
export function makeTurnstileVerifier(deps: {
  secret: string;
  verifyUrl?: string;
  fetchImpl?: CaptchaFetch;
}): CaptchaVerifier {
  const url = deps.verifyUrl ?? TURNSTILE_VERIFY_URL;
  const doFetch: CaptchaFetch = deps.fetchImpl ?? ((u, init) => fetch(u, init) as unknown as ReturnType<CaptchaFetch>);
  return {
    id: 'turnstile',
    configured: true,
    async verify(captchaToken: string, remoteIp?: string): Promise<boolean> {
      if (captchaToken === '') return false;
      const form = new URLSearchParams();
      form.set('secret', deps.secret);
      form.set('response', captchaToken);
      // Corroborating only. Turnstile treats a mismatch as one signal among
      // several, so it is sent when we have it and its absence is not an error.
      if (remoteIp !== undefined && remoteIp !== '') form.set('remoteip', remoteIp);
      let body: unknown;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        if (!res.ok) {
          log.error('captcha: siteverify refused the request (NOT a failed solve)', {
            provider: 'turnstile',
            status: res.status,
          });
          return false;
        }
        body = await res.json();
      } catch (err) {
        log.error('captcha: siteverify unreachable — treating as NOT verified', {
          provider: 'turnstile',
          reason: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      const parsed = body as { success?: unknown; 'error-codes'?: unknown } | null;
      // `=== true`, never truthiness: a body that carries `success: "false"`
      // (a string) or any other shape must not open the gate.
      if (parsed?.success === true) return true;
      // The provider's error codes go to OUR log and never onto the wire — an
      // anonymous caller learning which check failed is being handed a tuning
      // signal for the next attempt (the rule google-auth-routes.ts states).
      log.warn('captcha: token rejected', {
        provider: 'turnstile',
        codes: Array.isArray(parsed?.['error-codes']) ? parsed['error-codes'] : [],
      });
      return false;
    },
  };
}

/**
 * Resolve the process-wide verifier from the environment, announcing the
 * outcome in BOTH directions.
 *
 * The both-ways log line is the mail module's rule: an ABSENCE that could mean
 * 「off」 or 「this build has no switch」 is worse than a line that says so. On
 * the day a surge starts, the operator's first question is 「was the challenge
 * even armed」 and the answer has to already be in the boot log — by then it is
 * far too late to go and look at an env var.
 */
export function resolveCaptchaVerifier(env: NodeJS.ProcessEnv = process.env): CaptchaVerifier {
  const secret = (env.FLOWMIC_TURNSTILE_SECRET ?? '').trim();
  const verifyUrl = (env.FLOWMIC_TURNSTILE_VERIFY_URL ?? '').trim();
  if (secret === '') {
    log.warn(
      'captcha: FLOWMIC_TURNSTILE_SECRET is not set — a registration surge will CLOSE registration rather than challenge it',
      { env: 'FLOWMIC_TURNSTILE_SECRET', provider: 'unconfigured' },
    );
    return unconfiguredCaptchaVerifier();
  }
  log.info('captcha: Turnstile armed for the registration surge gate', {
    provider: 'turnstile',
    ...(verifyUrl !== '' ? { verify_url: verifyUrl } : {}),
  });
  return makeTurnstileVerifier({ secret, ...(verifyUrl !== '' ? { verifyUrl } : {}) });
}
