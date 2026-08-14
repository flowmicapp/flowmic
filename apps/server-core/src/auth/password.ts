// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §7 (password hash: scrypt N=16384,r=8,p=1,
//     self-describing envelope, timing-safe verify)
//   Ported verbatim-mechanism from legacy auth/password.ts.
//
// Stored format: scrypt$N=16384$r=8$p=1$<base64(salt)>$<base64(hash)>

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
export const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024;

const ENVELOPE_RE = /^scrypt\$N=(\d+)\$r=(\d+)\$p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('password.hash: plaintext must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAXMEM });
  return ['scrypt', `N=${SCRYPT_N}`, `r=${SCRYPT_R}`, `p=${SCRYPT_P}`, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  if (typeof plaintext !== 'string' || typeof stored !== 'string') return false;
  const m = ENVELOPE_RE.exec(stored);
  if (!m) return false;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  const salt = Buffer.from(m[4] as string, 'base64');
  const expected = Buffer.from(m[5] as string, 'base64');
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = await scrypt(plaintext, salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
