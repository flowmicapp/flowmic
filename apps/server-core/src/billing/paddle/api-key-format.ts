// SPEC-REF:
//   https://developer.paddle.com/api-reference/about/authentication
//   apps/server-core/src/config.ts resolvePaddle() (the one production caller)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Does this string even have the SHAPE of a Paddle API key, and does it belong
// to the environment we think we are talking to?
//
// ── 🔴 WHY THIS EXISTS (2026-08-31, measured, not hypothetical) ─────────────
//
// The sandbox API key stored in `.local/paddle-sandbox.env` AND in production's
// `/etc/flowmic-app/env` had FOUR OF ITS FIVE UNDERSCORES DELETED at some point
// between Paddle showing it once and it being pasted into a file. 65 characters
// instead of 69. Paddle answers such a key with HTTP 403
// `authentication_malformed` — a FORMAT rejection, indistinguishable at the call
// site from any other outbound failure.
//
// 🔴 THE NUMBER THAT WOULD HAVE CAUGHT IT WAS ALREADY BEING PRINTED. `config.ts`
// logs `api_key_len` at every boot and has since the Paddle intake was built. It
// said 65 every time. Nothing compared it to what it should be, so it was a true
// statement nobody could act on — the R11 shape, in the credentials face.
//
// ⚠️ NOT FATAL, DELIBERATELY, and the asymmetry is argued in `config.ts`: a bad
// webhook secret is an OPEN door (we would accept forged events), a bad API key
// is a CLOSED one (every outbound call refuses itself). This reports; it does not
// refuse to boot. What it buys is that the refusal is named at boot instead of
// being discovered on the first real checkout.
//
// 🔴 WHY IT ALSO NAMES `underscores_stripped` SEPARATELY. "This is not a valid
// key" sends an operator to the dashboard to mint a new one. "This is your key
// with the underscores removed" tells them the value is RECOVERABLE and that
// whatever they paste next will be eaten the same way. Those are two different
// actions, so they are two different verdicts — never one.

import { log } from '../../log';

/** The environment a key claims, taken from its own prefix. */
export type PaddleKeyEnv = 'sandbox' | 'live';

/** ⚠️ OUR enum, which is NOT Paddle's vocabulary: we say 'production' where the
 *  key prefix says `live`. Two names for one fact — translated in exactly one
 *  place (`reportPaddleApiKeyShape` below) so neither leaks into the other's
 *  module. Mirrors `PaddleEnv` in config.ts; that file is the definition. */
export type PaddleConfiguredEnv = 'sandbox' | 'production';

export type PaddleApiKeyVerdict =
  /** Shape is right and the prefix matches the configured environment. */
  | { kind: 'ok'; env: PaddleKeyEnv }
  /** Shape is right but it is a key for the OTHER Paddle environment. Every call
   *  will fail, and the operator's fix is a different key, not a repair. */
  | { kind: 'wrong_env'; env: PaddleKeyEnv; configured: PaddleKeyEnv }
  /** 🔴 Recoverable: this is a well-formed key with its underscores removed.
   *  See the header — this is the defect that actually happened, twice. */
  | { kind: 'underscores_stripped'; expectedLength: number; actualLength: number }
  /** None of the above: not a Paddle API key at all (a client-side token, a
   *  notification secret, a truncated paste, an empty string). */
  | { kind: 'malformed'; actualLength: number };

/** Paddle's documented format. Five underscores, 69 characters total. */
const KEY_RE = /^pdl_(live|sdbx)_apikey_[a-z\d]{26}_[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$/;

/** The same key with every underscore removed — what the observed defect
 *  produces. Anchored so a random 65-character string cannot match it. */
const STRIPPED_RE = /^pdl(live|sdbx)apikey[a-z\d]{26}[a-zA-Z\d]{22}[a-zA-Z\d]{3}$/;

/** ⚠️ The defect seen in the wild kept the LAST underscore (the `{22}_{3}`
 *  separator) and lost the other four. Both shapes are treated as the same
 *  recoverable verdict: the operator's action is identical either way. */
const PARTIALLY_STRIPPED_RE = /^pdl(live|sdbx)apikey[a-z\d]{26}[a-zA-Z\d]{22}_[a-zA-Z\d]{3}$/;

const FULL_LENGTH = 69;

function envOfPrefix(token: string): PaddleKeyEnv {
  return token === 'live' ? 'live' : 'sandbox';
}

/**
 * Judge one API key against the environment it is configured for.
 *
 * ⚠️ THIS IS A SHAPE CHECK, NOT AN AUTHENTICATION. A verdict of `ok` means
 * "Paddle will not reject this on format grounds" — it says nothing about the
 * key being active, unexpired, or belonging to us. Do not let a caller print a
 * sentence that claims more than that.
 */
export function paddleApiKeyVerdict(key: string, configuredEnv: PaddleKeyEnv): PaddleApiKeyVerdict {
  const m = KEY_RE.exec(key);
  if (m !== null) {
    const env = envOfPrefix(m[1] as string);
    return env === configuredEnv ? { kind: 'ok', env } : { kind: 'wrong_env', env, configured: configuredEnv };
  }
  if (STRIPPED_RE.test(key) || PARTIALLY_STRIPPED_RE.test(key)) {
    return { kind: 'underscores_stripped', expectedLength: FULL_LENGTH, actualLength: key.length };
  }
  return { kind: 'malformed', actualLength: key.length };
}

/**
 * One operator-facing sentence per verdict.
 *
 * 🔴 NEVER INTERPOLATE THE KEY. Length and shape are everything an operator
 * needs to tell 配错了 from 没配, and everything an attacker gets — the same rule
 * the boot log in `config.ts` already follows.
 */
export function describePaddleApiKeyVerdict(v: PaddleApiKeyVerdict): string {
  switch (v.kind) {
    case 'ok':
      return `FLOWMIC_PADDLE_API_KEY has the documented ${v.env} shape`;
    case 'wrong_env':
      return (
        `FLOWMIC_PADDLE_API_KEY is a ${v.env} key but FLOWMIC_PADDLE_ENV is ${v.configured} — ` +
        'every outbound Paddle call will be rejected; this needs a different key, not a repair'
      );
    case 'underscores_stripped':
      return (
        `FLOWMIC_PADDLE_API_KEY looks like a valid key with its underscores removed ` +
        `(${v.actualLength} chars, expected ${v.expectedLength}) — Paddle will answer 403 ` +
        'authentication_malformed. The value is recoverable: restore the underscores rather ' +
        'than minting a new key, and check whatever pasted it, because the next key will be eaten too'
      );
    case 'malformed':
      return (
        `FLOWMIC_PADDLE_API_KEY does not match Paddle's documented key format ` +
        `(${v.actualLength} chars, expected ${FULL_LENGTH}) — every outbound Paddle call will be ` +
        'rejected with 403 authentication_malformed. Note the dashboard only ever shows a key once; ' +
        'what it displays afterwards is an identifier, not the key'
      );
  }
}

/**
 * Say at boot whether the configured API key can even be used.
 *
 * 🔴 `api_key_len` in `config.ts` has been printed at every boot since this
 * intake was built, and on 2026-08-31 it had been saying 65 (not 69) in
 * production for weeks: a key whose underscores had been eaten between the
 * Paddle dashboard and the env file. Paddle rejects such a key with 403
 * `authentication_malformed`, which at the call site is indistinguishable from
 * "Paddle did not answer". The length was a true statement nobody could act on.
 * This turns it into one.
 *
 * ⚠️ NOT FATAL — the same asymmetry `config.ts` argues for its webhook-secret
 * check: a bad key is a CLOSED door (every call refuses itself by name), not an
 * open one. It reports; it does not refuse to boot.
 *
 * ⚠️ `write_enabled` rides along because it decides whether this is urgent or
 * merely wrong: with writes off, no outbound call is attempted at all, so a
 * broken key has cost nothing yet — and will cost everything the moment writes
 * are turned on, which is exactly what going live does first.
 */
export function reportPaddleApiKeyShape(
  apiKey: string | null,
  configuredEnv: PaddleConfiguredEnv,
  writeEnabled: boolean,
): void {
  if (apiKey === null || apiKey === '') return; // absence is config.ts's question, not ours
  const verdict = paddleApiKeyVerdict(apiKey, configuredEnv === 'production' ? 'live' : 'sandbox');
  if (verdict.kind === 'ok') return;
  log.error(describePaddleApiKeyVerdict(verdict), { verdict: verdict.kind, write_enabled: writeEnabled });
}
