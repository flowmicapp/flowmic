// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §7 (Cloud KEY = account JWT: HS256, claims
//     {sub, plan}, 7-day TTL; minted by REST /api/login|register, verified on
//     the relay handshake + Console/web socket)
//   docs/strategy/R4-PRIVATE-TASK-CARDS.md WP-R4-1 ① (JWT sign/verify HS256
//     {sub, plan} TTL 7d, secret = the saas explicit secret from config)
//   Ported verbatim-mechanism from legacy apps/server/src/auth/jwt.ts
//   (@flowmic/shared Plan → @flowmic/protocol Plan; behavior unchanged).
//   *** HUMAN-AUDIT SENSITIVE (auth/crypto) — reviewable in isolation ***
//
// Hand-rolled HS256 JSON Web Token signer + verifier over node:crypto's HMAC
// (no external deps). Format follows RFC 7519 / RFC 7515:
//     base64url(headerJson) + '.' + base64url(payloadJson) + '.'
//       + base64url(HMAC-SHA256(secret, "<header>.<payload>"))
// Header is fixed {"alg":"HS256","typ":"JWT"} — no algorithm negotiation.
// Payload claims are exactly { sub: string, plan: Plan, iat, exp }
// (iat/exp seconds-since-epoch, RFC 7519 §4.1.4/§4.1.6). Default TTL 7 days.
//
// 0.2.38 — the two plan guards below used to spell out `'free' | 'pro'` by hand,
// which is why adding a third tier had to touch this crypto file at all. They
// now call isPlan(), the single membership test derived from PLANS. Adding a
// fourth tier must never require a fourth literal: a widening of the tier set
// that one of two hand-written guards missed would mint tokens the verifier
// rejects (or, worse, the reverse).
//
// ⚠️ WIDENING IS BACKWARD-COMPATIBLE BY CONSTRUCTION: 'free' and 'pro' are still
// members of PLANS, so every JWT signed before this change still verifies —
// there is a test for exactly that, because "we widened an accept-list" is the
// kind of claim that is only true until someone reorders it.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { isPlan, PLANS, type Plan } from '@flowmic/protocol';

export interface JwtClaims {
  sub: string;
  plan: Plan;
  iat: number;
  exp: number;
}

export interface SignOpts {
  secret: Buffer;
  /** Token time-to-live in milliseconds. Defaults to 7 days. */
  ttlMs?: number;
  /** Injectable clock for tests. Returns ms-since-epoch. */
  now?: () => number;
}

export interface VerifyOpts {
  secret: Buffer;
  /** Injectable clock for tests. Returns ms-since-epoch. */
  now?: () => number;
}

/** 7 days, per 05 §7: "Cloud KEY JWT 7-day expiry". */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const HEADER_JSON = JSON.stringify({ alg: 'HS256', typ: 'JWT' });

export type JwtErrorCode = 'JWT_MALFORMED' | 'JWT_BAD_SIGNATURE' | 'JWT_EXPIRED' | 'JWT_BAD_CLAIMS' | 'JWT_BAD_ALG';

export class JwtError extends Error {
  constructor(
    public readonly code: JwtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

function assertSecret(secret: unknown): asserts secret is Buffer {
  if (!Buffer.isBuffer(secret) || secret.length === 0) {
    throw new Error('jwt: secret must be a non-empty Buffer');
  }
}

/** RFC 4648 §5: base64url, no padding. */
function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmacSha256(secret: Buffer, signingInput: string): Buffer {
  return createHmac('sha256', secret).update(signingInput, 'utf8').digest();
}

/** Sign a fresh JWT. Caller supplies sub + plan; iat/exp are computed from
 *  `now` (default Date.now) and `ttlMs` (default 7 days). */
export function signJwt(claims: Omit<JwtClaims, 'iat' | 'exp'>, opts: SignOpts): string {
  assertSecret(opts.secret);
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('jwt.sign: claims.sub must be a non-empty string');
  }
  if (!isPlan(claims.plan)) {
    throw new Error(`jwt.sign: claims.plan must be one of ${PLANS.join(' | ')} (got ${String(claims.plan)})`);
  }
  const nowMs = (opts.now ?? Date.now)();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.floor((nowMs + ttlMs) / 1000);
  const payload: JwtClaims = { sub: claims.sub, plan: claims.plan, iat, exp };
  const headerB64 = b64url(HEADER_JSON);
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = b64url(hmacSha256(opts.secret, signingInput));
  return `${signingInput}.${sig}`;
}

/** Verify and parse a JWT. Throws JwtError on any structural or cryptographic
 *  failure, or if the token is past its `exp`. Successful return contains the
 *  decoded claims exactly as signed. */
export function verifyJwt(token: string, opts: VerifyOpts): JwtClaims {
  assertSecret(opts.secret);
  if (typeof token !== 'string') {
    throw new JwtError('JWT_MALFORMED', 'jwt.verify: token must be a string');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] === '' || parts[1] === '' || parts[2] === '') {
    throw new JwtError('JWT_MALFORMED', 'jwt.verify: token must have 3 non-empty parts');
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  // Header — must be the fixed HS256/JWT shape.
  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8')) as typeof header;
  } catch {
    throw new JwtError('JWT_MALFORMED', 'jwt.verify: header is not valid JSON');
  }
  if (header.alg !== 'HS256') {
    throw new JwtError('JWT_BAD_ALG', `jwt.verify: only HS256 supported (got ${String(header.alg)})`);
  }

  // Signature — constant-time compare.
  const expectedSig = hmacSha256(opts.secret, `${headerB64}.${payloadB64}`);
  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    throw new JwtError('JWT_BAD_SIGNATURE', 'jwt.verify: signature is not base64url');
  }
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    throw new JwtError('JWT_BAD_SIGNATURE', 'jwt.verify: signature mismatch');
  }

  // Payload — must contain all 4 claims with correct types.
  let payload: { sub?: unknown; plan?: unknown; iat?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as typeof payload;
  } catch {
    throw new JwtError('JWT_MALFORMED', 'jwt.verify: payload is not valid JSON');
  }
  if (
    typeof payload.sub !== 'string' || payload.sub.length === 0 ||
    !isPlan(payload.plan) ||
    typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) ||
    typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
  ) {
    throw new JwtError('JWT_BAD_CLAIMS', 'jwt.verify: payload missing required claims');
  }
  const plan: Plan = payload.plan;

  const nowSec = Math.floor(((opts.now ?? Date.now)()) / 1000);
  if (nowSec >= payload.exp) {
    throw new JwtError('JWT_EXPIRED', `jwt.verify: token expired at ${payload.exp}, now=${nowSec}`);
  }

  return { sub: payload.sub, plan, iat: payload.iat, exp: payload.exp };
}
