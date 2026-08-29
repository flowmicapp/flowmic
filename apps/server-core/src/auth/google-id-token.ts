// SPEC-REF:
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §1
//     (card NR-1: Google Identity Services on the console, ID token verified
//     server-side against Google's JWKS — no OAuth code flow, no refresh token)
//   docs/decisions/2026-08-27-owner-web-rulings-nr-ledger.md item 2 (activation)
//   docs/decisions/2026-08-11-owner-email-verification-gate-and-gmail-login.md ④
//     (the original "record only" entry, and its warning that OAuth is a new
//     admission surface rather than a convenient extra route)
//   src/mail/provider.ts — the seam pattern this file copies clause for clause
//   *** SENSITIVE SURFACE (auth: a new way to become a signed-in account) ***
//
// " Is this string a Google ID token that Google minted for OUR client, and who
// does it say the person is " — and nothing else. No database, no session, no
// account: this module answers one question and http/google-auth-routes.ts
// decides what to do with the answer.
//
// 🔴 THERE IS NO PERMISSIVE IMPLEMENTATION OF THIS INTERFACE, ANYWHERE, ON
// PURPOSE — the rule mail/provider.ts states for its own seam, on a surface
// where the cost is higher. A verifier that accepted a token it could not check
// would be an authentication bypass wearing the shape of a DI default (book 13
// §7 F1 ②: either a real implementation or a throw). The unconfigured case has
// its own named, LOUD implementation (`unconfiguredGoogleIdTokenVerifier`) that
// rejects every call by name, so "this deployment has no Google client id" and
// "this token is fine" can never produce the same outcome.
//
// 🔴 WHY node:crypto AND NOT A LIBRARY. A JWT verifier is a small amount of
// code and a large amount of judgement, and the judgement is all in the four
// checks below (algorithm, issuer, audience, expiry) — none of which a
// dependency would make more true. What a dependency WOULD add is a supply-chain
// surface on the one route that mints sessions from a stranger's input. The
// primitives here are Node's own: `createPublicKey({format:'jwk'})` and
// `verify('RSA-SHA256', …)`.
//
// ── ENVIRONMENT ────────────────────────────────────────────────────────────
//   FLOWMIC_GOOGLE_CLIENT_ID — the OAuth 2.0 Web client id issued in the Google
//     Cloud console (it looks like `<digits>-<hash>.apps.googleusercontent.com`).
//     UNSET ⇒ Google sign-in is OFF: the route stays mounted and answers a named
//     503 rather than disappearing, because "we do not offer this" and " we are
//     misconfigured " are different sentences and only one of them is actionable
//     by the operator reading the log.
//     ⚠️ A client ID is PUBLIC — it ships in the console's own JavaScript. It is
//     an audience, never a secret. There is deliberately no
//     FLOWMIC_GOOGLE_CLIENT_SECRET here: the ID-token flow this card chose does
//     not use one, and adding an unused secret env var would invite a later
//     reader to put a real secret in a place nothing guards.
//   FLOWMIC_GOOGLE_JWKS_URL — override for the key endpoint. Exists so a test or
//     a staging box can point at a local server WITHOUT a network stub, the same
//     affordance FLOWMIC_MAIL_ENDPOINT gives the mail transport. Defaults to
//     {@link GOOGLE_JWKS_URL}.

import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { log } from '../log';

/** Google's published signing keys. The set rotates; see {@link JwksFetch}. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * The two spellings Google uses for the `iss` claim.
 *
 * BOTH are legitimate and Google's own documentation says so, which is why this
 * is a Set and not a string comparison: a verifier that accepted only the URL
 * form would reject perfectly good tokens intermittently, and the symptom
 * ("Google sign-in works for some people") is the hardest kind to diagnose.
 */
export const GOOGLE_ISSUERS: ReadonlySet<string> = new Set([
  'https://accounts.google.com',
  'accounts.google.com',
]);

/** Fallback key cache lifetime when the endpoint does not say (Google's does). */
export const GOOGLE_JWKS_DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * The floor between two key fetches triggered by an UNKNOWN `kid`.
 *
 * 🔴 THIS IS A RATE LIMIT, NOT A CACHE TUNING KNOB. Without it, a token with a
 * random `kid` forces a fetch of Google's key endpoint, and an anonymous route
 * would hand any caller an outbound-request amplifier pointed at a third party.
 * With it, an unknown kid costs one fetch a minute at most and every subsequent
 * one is refused from cache.
 */
export const GOOGLE_JWKS_MIN_REFETCH_MS = 60 * 1000;

/** Who Google says this is. Deliberately not a `UserRecord`-shaped thing: this
 *  module knows nothing about accounts. */
export interface GoogleIdentity {
  /** Google's `sub` — the stable identifier, and the ONLY one this product
   *  binds an account to (db/schema.ts `users.google_sub` argues why). */
  sub: string;
  /** The address on the Google account, or null when the token carries none
   *  (possible: `email` requires the `email` scope, which GIS asks for but a
   *  token minted another way need not have). */
  email: string | null;
  /** Google's own verdict on that address. `false` and ABSENT are the same
   *  answer here — "Google is not vouching for it" — so the field is a plain
   *  boolean and the route treats it as a permission to skip our own gate, never
   *  as a reason to open anything else. */
  emailVerified: boolean;
  /** The display name, when the token carries one. */
  name: string | null;
}

/** The two ways a credential can be refused. HTTP-LOCAL names on the
 *  KEYMETA_ / VERIFY_ precedent — they are not in `packages/protocol`
 *  `ERROR_CODES`, they never cross a socket, and the code table did not move for
 *  NR-1. `test/google-login.test.ts` pins that absence rather than leaving it as
 *  a promise in a comment. */
export type GoogleTokenRefusal = 'GOOGLE_TOKEN_INVALID' | 'GOOGLE_TOKEN_EXPIRED';

/**
 * The credential did not survive verification.
 *
 * 🔴 TWO CODES AND NOT ONE, because the two demand opposite things of the
 * client. `GOOGLE_TOKEN_EXPIRED` means " ask Google for a fresh one and try
 * again " — an ordinary thing that happens to an honest user who left the tab
 * open. `GOOGLE_TOKEN_INVALID` means "nothing you retry will help". Collapsing
 * them would put a console into a retry loop on a token that can never work, or
 * stop it retrying one that would.
 *
 * ⚠️ THE ORDER OF THE CHECKS IS WHAT KEEPS THEM HONEST: expiry is judged only
 * AFTER the signature verifies, so a forged expired token is INVALID (we have no
 * business reading its claims) and only a genuinely-Google-signed stale token is
 * EXPIRED. `message` is for the operator log; the route never echoes it.
 */
export class GoogleTokenError extends Error {
  constructor(readonly code: GoogleTokenRefusal, message: string) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

/**
 * Something asked the verifier to verify and this deployment has no Google
 * client id.
 *
 * A DISTINCT type rather than a `GoogleTokenError`, for the reason
 * `MailNotConfiguredError` is distinct from a transport failure: the two need
 * different actions from different people. This one is " an operator has to put
 * one env var on the box "; the other is "that credential is no good". Answering
 * a misconfiguration with "your token is invalid" sends the user to debug their
 * own Google account forever.
 */
export class GoogleLoginNotConfiguredError extends Error {
  readonly code = 'GOOGLE_LOGIN_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'GoogleLoginNotConfiguredError';
  }
}

export interface GoogleIdTokenVerifier {
  /**
   * Verify the credential, or THROW.
   *
   * The contract is deliberately "resolve means Google signed this, for us, and
   * it has not expired" and nothing stronger. In particular it does NOT mean
   * "this person owns the email in it" — that is what {@link
   * GoogleIdentity.emailVerified} is for, and it is Google's claim, not ours.
   */
  verify(credential: string): Promise<GoogleIdentity>;
  /** Which implementation this is, for log lines only (`'google-jwks'`,
   *  `'unconfigured'`). Never rendered to a user, never on the wire. */
  readonly id: string;
}

/** One key-set fetch. Returns the keys and, when the endpoint said so, how long
 *  they may be cached. Injectable so tests drive the REAL verifier over keys
 *  they generated — a fake at the verifier level would leave every check in
 *  this file untested, which is the mistake mail/'s own tests avoid by faking
 *  the transport instead of the mailer. */
export type JwksFetch = () => Promise<{ keys: JsonWebKey[]; ttlMs?: number }>;

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
}

interface GoogleClaims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

function decodeJsonSegment(segment: string, what: string): Record<string, unknown> {
  let text: string;
  try {
    text = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', `${what} is not base64url`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', `${what} is not JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', `${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Read the client id from the environment, or null when Google sign-in is off.
 *
 *  `null` means "this deployment deliberately does not offer Google sign-in" — a
 *  real, supported state (standalone, a dev box, CI). It does NOT mean "fall
 *  back to something": the caller turns null into a LOUD, named,
 *  always-failing verifier, never into a quiet one. Same contract, same words,
 *  as mail/config.ts `mailConfigFromEnv`. */
export function googleClientIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.FLOWMIC_GOOGLE_CLIENT_ID;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

/** The channel for a deployment that has no Google client id: it accepts the
 *  call and refuses it BY NAME. Never a no-op, never a permissive default. */
export function unconfiguredGoogleIdTokenVerifier(): GoogleIdTokenVerifier {
  return {
    id: 'unconfigured',
    verify(): Promise<GoogleIdentity> {
      return Promise.reject(
        new GoogleLoginNotConfiguredError(
          'Google sign-in is not configured on this deployment (FLOWMIC_GOOGLE_CLIENT_ID is unset)',
        ),
      );
    },
  };
}

/** The real network fetch of Google's key set, honouring the endpoint's own
 *  `cache-control: max-age` when it publishes one. */
function httpJwksFetch(url: string): JwksFetch {
  return async () => {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`google jwks: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error('google jwks: body has no `keys` array');
    const cc = res.headers.get('cache-control') ?? '';
    const m = /max-age=(\d+)/i.exec(cc);
    return {
      keys: body.keys as JsonWebKey[],
      ...(m?.[1] ? { ttlMs: Number(m[1]) * 1000 } : {}),
    };
  };
}

/**
 * The real verifier.
 *
 * FOUR CHECKS, and every one of them is load-bearing — none is decoration:
 *  · **signature**, against a key Google published under the token's own `kid`.
 *    Without it every other check is reading a string the caller wrote;
 *  · **issuer**, so a validly-signed token from some other identity provider
 *    cannot walk in;
 *  · **audience** — `aud` must be OUR client id. 🔴 THIS IS THE ONE MOST EASILY
 *    MISTAKEN FOR REDUNDANT. Google signs ID tokens for every application on the
 *    platform with the same keys, so without this check ANY Google-issued token
 *    for ANY app verifies here, and a token obtained by any other site's login
 *    button becomes a session on this one. `test/google-login.test.ts` drives
 *    exactly that token;
 *  · **expiry**, judged after the signature so the two refusals stay honest.
 */
export function makeGoogleIdTokenVerifier(opts: {
  clientId: string;
  /** Defaults to the real HTTPS fetch of {@link GOOGLE_JWKS_URL} (or
   *  FLOWMIC_GOOGLE_JWKS_URL). */
  fetchJwks?: JwksFetch;
  /** ms-since-epoch clock; defaults to Date.now. Injectable for expiry tests. */
  now?: () => number;
}): GoogleIdTokenVerifier {
  const now = opts.now ?? Date.now;
  const fetchJwks =
    opts.fetchJwks ?? httpJwksFetch(process.env.FLOWMIC_GOOGLE_JWKS_URL?.trim() || GOOGLE_JWKS_URL);

  let cachedKeys: JsonWebKey[] = [];
  let cacheExpiresAt = 0;
  let lastFetchAt = 0;

  async function refresh(): Promise<void> {
    const at = now();
    const { keys, ttlMs } = await fetchJwks();
    cachedKeys = keys;
    cacheExpiresAt = at + (typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : GOOGLE_JWKS_DEFAULT_TTL_MS);
    lastFetchAt = at;
  }

  async function keyFor(kid: string): Promise<JsonWebKey> {
    if (cachedKeys.length === 0 || now() >= cacheExpiresAt) await refresh();
    let jwk = cachedKeys.find((k) => (k as { kid?: string }).kid === kid);
    // Key rotation: an unknown kid is the ONE legitimate reason to go back to
    // Google before the cache expires. Bounded by GOOGLE_JWKS_MIN_REFETCH_MS so
    // that a caller feeding random kids cannot use this route to hammer a third
    // party's endpoint — see that constant's own note.
    if (!jwk && now() - lastFetchAt >= GOOGLE_JWKS_MIN_REFETCH_MS) {
      await refresh();
      jwk = cachedKeys.find((k) => (k as { kid?: string }).kid === kid);
    }
    if (!jwk) throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', `no Google signing key for kid ${kid}`);
    return jwk;
  }

  return {
    id: 'google-jwks',
    async verify(credential): Promise<GoogleIdentity> {
      if (typeof credential !== 'string' || credential.trim() === '') {
        throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', 'no credential');
      }
      const parts = credential.split('.');
      if (parts.length !== 3) {
        throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', `expected 3 JWT segments, got ${parts.length}`);
      }
      const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

      const header = decodeJsonSegment(headerB64, 'JWT header') as JwtHeader;
      // RS256 ONLY. 🔴 An `alg` the caller chose is the classic JWT hole: `none`
      // asks us to skip verification, and an HMAC alg asks us to verify with a
      // key that is PUBLIC — either turns "Google signed this" into " the caller
      // said so ". The whitelist is one algorithm because Google mints one.
      if (header.alg !== 'RS256') {
        throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', `unsupported alg ${String(header.alg)}`);
      }
      const kid = stringOrNull(header.kid);
      if (!kid) throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', 'JWT header has no kid');

      let jwk: JsonWebKey;
      try {
        jwk = await keyFor(kid);
      } catch (err) {
        if (err instanceof GoogleTokenError) throw err;
        // The key endpoint was unreachable or answered nonsense. That is OUR
        // failure, not the caller's, and it must not be reported as an invalid
        // credential — see the route's 502 arm.
        throw err;
      }

      let signatureOk = false;
      try {
        const key = createPublicKey({ key: jwk, format: 'jwk' });
        signatureOk = cryptoVerify(
          'RSA-SHA256',
          Buffer.from(`${headerB64}.${payloadB64}`, 'ascii'),
          key,
          Buffer.from(signatureB64, 'base64url'),
        );
      } catch (err) {
        throw new GoogleTokenError(
          'GOOGLE_TOKEN_INVALID',
          `signature check could not run: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!signatureOk) throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', 'signature does not verify');

      // Only now are the claims worth reading.
      const claims = decodeJsonSegment(payloadB64, 'JWT payload') as GoogleClaims;

      const iss = stringOrNull(claims.iss);
      if (!iss || !GOOGLE_ISSUERS.has(iss)) {
        throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', `unexpected iss ${String(claims.iss)}`);
      }

      // 🔴 THE AUDIENCE CHECK. Google signs every application's ID tokens with
      // the same key set, so this line — and only this line — is what makes a
      // verified signature mean "minted for FlowMic". Deleting it turns any
      // other site's Google login into a session here.
      // `aud` may be an array in the JWT spec; Google sends a string for ID
      // tokens, and both shapes are handled rather than assumed.
      const aud = claims.aud;
      const audOk = Array.isArray(aud)
        ? aud.some((a) => a === opts.clientId)
        : aud === opts.clientId;
      if (!audOk) {
        throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', "aud is not this deployment's Google client id");
      }

      const exp = claims.exp;
      if (typeof exp !== 'number' || !Number.isFinite(exp)) {
        throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', 'exp is missing or not a number');
      }
      // Seconds on the wire, milliseconds in this process. No leeway: a clock
      // tolerance here is a window in which a dead credential still works, and
      // the client can always ask Google for a fresh token — which is exactly
      // what the EXPIRED code tells it to do.
      if (exp * 1000 <= now()) {
        throw new GoogleTokenError('GOOGLE_TOKEN_EXPIRED', 'exp is in the past');
      }

      const sub = stringOrNull(claims.sub);
      if (!sub) throw new GoogleTokenError('GOOGLE_TOKEN_INVALID', 'sub is missing');

      return {
        sub,
        email: stringOrNull(claims.email),
        // `=== true` and not truthiness: Google has historically sent this claim
        // as the STRING "true" as well as the boolean, and every other value —
        // including the string "false" — must read as "not vouched for".
        emailVerified: claims.email_verified === true || claims.email_verified === 'true',
        name: stringOrNull(claims.name),
      };
    },
  };
}

/** Announced ONCE per construction, in BOTH directions, naming the env var —
 *  the shape auth-service.ts's login-record switch uses and for its stated
 *  reason: a line that appeared only when the feature is ON would make its
 *  absence mean either "off" or "this build does not have the feature", and an
 *  operator must be able to answer "does this machine offer Google sign-in" from
 *  the log alone. */
export const GOOGLE_LOGIN_SWITCH_LOG = 'google login:';

/**
 * Build the verifier this process will use, from the environment.
 *
 * Mirrors mail/index.ts `resolveEmailVerificationMailer`: resolution happens in
 * ONE place, an unconfigured deployment gets the loud channel rather than a
 * null, and the boot log says which one it got.
 */
export function resolveGoogleIdTokenVerifier(env: NodeJS.ProcessEnv = process.env): GoogleIdTokenVerifier {
  const clientId = googleClientIdFromEnv(env);
  if (clientId === null) {
    log.info(`${GOOGLE_LOGIN_SWITCH_LOG} DISABLED`, { env: 'FLOWMIC_GOOGLE_CLIENT_ID', configured: false });
    return unconfiguredGoogleIdTokenVerifier();
  }
  // The client id is PUBLIC (it ships in the console's own JavaScript), so
  // logging it whole is not a leak — and it is the one value an operator needs
  // to compare against the Google Cloud console when sign-in refuses everybody.
  log.info(`${GOOGLE_LOGIN_SWITCH_LOG} ENABLED`, { env: 'FLOWMIC_GOOGLE_CLIENT_ID', client_id: clientId });
  return makeGoogleIdTokenVerifier({ clientId });
}
