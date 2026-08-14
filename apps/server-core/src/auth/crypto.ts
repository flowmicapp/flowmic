// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §2 (enc:v1: credential-envelope: AES-256-GCM,
//     server-decryptable, key = SHA-256(deployment secret); STRICTLY distinct
//     from the server-blind timeline e2e:v1:)
//   Ported verbatim-mechanism from legacy auth/crypto.ts.
//
// AES-256-GCM envelope for user-provided cloud API keys persisted in
// user_settings.value. Wire format:
//     enc:v1:<base64( iv(12) ‖ tag(16) ‖ ciphertext )>
// The 32-byte key derives from the deployment secret via SHA-256 (deriveKey)
// and never leaves memory / never persists.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export const ENVELOPE_PREFIX = 'enc:v1:';
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
const ALGO = 'aes-256-gcm' as const;

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`crypto: key must be a ${KEY_BYTES}-byte Buffer`);
  }
}

export function encrypt(plaintext: string, key: Buffer): string {
  assertKey(key);
  if (typeof plaintext !== 'string') throw new Error('crypto.encrypt: plaintext must be a string');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENVELOPE_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(envelope: string, key: Buffer): string {
  assertKey(key);
  if (typeof envelope !== 'string' || !envelope.startsWith(ENVELOPE_PREFIX)) {
    throw new Error(`crypto.decrypt: envelope must start with '${ENVELOPE_PREFIX}'`);
  }
  const blob = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), 'base64');
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('crypto.decrypt: payload too short');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Derive a 32-byte AES key from the deployment secret string. SHA-256 is
 *  sufficient — this is an at-rest encryption key, not a password hash. */
export function deriveKey(secret: string): Buffer {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('crypto.deriveKey: secret must be a non-empty string');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}
