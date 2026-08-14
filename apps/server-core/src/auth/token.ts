// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §7 (device_token / mobile_token: fm_ + 64 hex,
//     ≥256-bit; no server-side expiry — revoke by deleting the row)
//   Ported verbatim-mechanism from legacy auth/token.ts.

import { randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'fm_';
export const TOKEN_RANDOM_BYTES = 32;
export const TOKEN_HEX_LENGTH = TOKEN_RANDOM_BYTES * 2;
export const TOKEN_TOTAL_LENGTH = TOKEN_PREFIX.length + TOKEN_HEX_LENGTH;

const HEX_RE = /^[0-9a-f]+$/;

/** Fresh opaque connection token: fm_ + 64 lowercase hex (32 random bytes). */
export function newToken(): string {
  return TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString('hex');
}

/** Shape-only validation (does NOT verify DB existence). */
export function isValidTokenShape(token: unknown): token is string {
  if (typeof token !== 'string') return false;
  if (token.length !== TOKEN_TOTAL_LENGTH) return false;
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  return HEX_RE.test(token.slice(TOKEN_PREFIX.length));
}
