// SPEC-REF:
//   docs/strategy/2026-08-11-design-e-multidevice-salt.md §3.1 (timeline_keymeta
//     + first-writer-wins PUT semantics), §2 (why the sentinel may live server-side)
//   docs/rebuild/05-DATA-MODEL.md §1.1 (table row added in the same batch)
//   docs/rebuild/13-LESSONS-LEARNED.md §3 D1 (no silent failure)
//
// Per-account blind-store KEY METADATA: the 16-byte Argon2id KDF salt (base64)
// and the passphrase-verification sentinel (an e2e:v1: ciphertext). Stored IN
// THE CLEAR on purpose — a second device must be able to read this row BEFORE
// it has any key, so the row cannot ride the envelope it exists to unlock.
//
// SECURITY ARGUMENT (design §2), restated where the storage happens: a stored
// sentinel is an offline passphrase-guessing oracle — and the server ALREADY
// holds an equivalent oracle in every e2e:v1: blob in timeline_blobs. Testing
// one passphrase against either costs exactly one Argon2id(passphrase, salt)
// plus one AES-GCM tag check, so persisting the sentinel hands an attacker
// ZERO new capability. The real defence is the Argon2id price of a single
// guess and the passphrase's strength, both unchanged by this table.
//
// 🔴 FIRST WRITER WINS. `putFirstWriter` never updates an existing row: a
// differing write answers 'conflict' (HTTP layer turns that into 409).
// Overwriting an account's salt orphans every ciphertext sealed under the old
// key; changing it is a later, explicit migration card — never a PUT.

import type { DatabaseSync } from 'node:sqlite';
import { TIMELINE_E2E_PREFIX } from '@flowmic/protocol';

/** Doc 05 §2: the Argon2id salt is exactly 16 bytes (mobile kBlindStoreSaltBytes
 *  mirrors the same number; the phone enforces it at key derivation). */
const KEYMETA_SALT_BYTES = 16;

export type KeymetaPutOutcome = 'created' | 'identical' | 'conflict';

export interface TimelineKeymetaRow {
  salt_b64: string;
  sentinel: string;
  schema_ver: number;
  created_at: number;
}

export interface TimelineKeymetaRepo {
  get(user_id: string): TimelineKeymetaRow | null;
  /**
   * First-writer-wins write (design §3.1):
   *   · no row                          → INSERT, 'created'
   *   · row exists, BOTH fields
   *     byte-identical to the input     → no-op, 'identical' (idempotent replay)
   *   · row exists, anything differs    → no write, 'conflict'
   * Throws on input that fails `keymetaInvalidReason` — see that function for
   * why the throw is a plain Error rather than a ServerError.
   */
  putFirstWriter(user_id: string, salt_b64: string, sentinel: string): KeymetaPutOutcome;
}

/**
 * THE single definition of a valid keymeta payload, used by BOTH the HTTP
 * route (to answer a named 400 before touching storage) and `putFirstWriter`
 * (as the write-path backstop, same discipline as timeline.repo.ts
 * `assertE2ePrefix` — a future non-HTTP caller must not be able to persist
 * junk just because it skipped the route).
 *
 * Returns the human-readable reason the payload is invalid, or null when it
 * is valid. The reason string is developer/diagnostic context (it rides the
 * 400 body's `message`), never user-facing copy.
 *
 * · `salt_b64` must be CANONICAL standard base64 (the round-trip check below)
 *   decoding to exactly 16 bytes. Node's Buffer.from(s,'base64') is lenient —
 *   it silently skips invalid characters and tolerates missing padding — so
 *   decode-then-re-encode is the strictness: any non-canonical input fails the
 *   byte-for-byte comparison. base64url is REJECTED on purpose: a client that
 *   encodes differently should learn at its first PUT (a named 400), not after
 *   its salt round-trips differently on another device.
 * · `sentinel` must carry the e2e:v1: family prefix (imported constant, never
 *   the restated literal — single-declaration discipline). The server is blind
 *   and judges nothing beyond the marker: the sentinel IS a ciphertext, and
 *   whether it opens is exclusively the phone's question (design §2).
 */
export function keymetaInvalidReason(salt_b64: string, sentinel: string): string | null {
  if (salt_b64 === '') return 'salt_b64 required';
  if (sentinel === '') return 'sentinel required';
  let decoded: Buffer;
  try {
    decoded = Buffer.from(salt_b64, 'base64');
  } catch {
    return 'salt_b64 is not valid base64';
  }
  if (decoded.toString('base64') !== salt_b64) {
    return 'salt_b64 is not canonical standard base64 (padded, non-url alphabet)';
  }
  if (decoded.length !== KEYMETA_SALT_BYTES) {
    return `salt_b64 must decode to exactly ${KEYMETA_SALT_BYTES} bytes (got ${decoded.length})`;
  }
  if (!sentinel.startsWith(TIMELINE_E2E_PREFIX)) {
    return `sentinel must be ${TIMELINE_E2E_PREFIX}-prefixed (it is a blind-store ciphertext)`;
  }
  return null;
}

export function makeTimelineKeymetaRepo(db: DatabaseSync, now: () => number = Date.now): TimelineKeymetaRepo {
  const getStmt = db.prepare(
    'SELECT salt_b64, sentinel, schema_ver, created_at FROM timeline_keymeta WHERE user_id=?',
  );
  // schema_ver is NOT in the column list: the DDL's DEFAULT 1 is the single
  // answer to 「what version does a fresh row get」, and a second literal here
  // would be a copy that can drift from it.
  const ins = db.prepare(
    'INSERT INTO timeline_keymeta (user_id, salt_b64, sentinel, created_at) VALUES (?,?,?,?)',
  );

  return {
    get(user_id): TimelineKeymetaRow | null {
      const r = getStmt.get(user_id) as Record<string, unknown> | undefined;
      if (!r) return null;
      return {
        salt_b64: r.salt_b64 as string,
        sentinel: r.sentinel as string,
        schema_ver: Number(r.schema_ver),
        created_at: Number(r.created_at),
      };
    },
    putFirstWriter(user_id, salt_b64, sentinel): KeymetaPutOutcome {
      // Write-path backstop. A plain Error, NOT a ServerError: ServerError's
      // code is typed to the protocol ERROR_CODES table, adding to which is
      // owner-gated, and no existing code honestly answers "your key metadata
      // is malformed" (TIMELINE_BLOB_REJECTED answers a different question — a
      // pushed timeline blob). The HTTP route pre-validates with the same
      // function and answers a named 400, so in production this throw is
      // unreachable through the route; it exists so no OTHER caller can ever
      // persist junk silently.
      const reason = keymetaInvalidReason(salt_b64, sentinel);
      if (reason !== null) throw new Error(`timeline_keymeta write rejected: ${reason}`);
      const existing = getStmt.get(user_id) as Record<string, unknown> | undefined;
      if (!existing) {
        // Single-process, synchronous node:sqlite: nothing can interleave
        // between the SELECT above and this INSERT. Even if a second process
        // ever shared the file, user_id is the PRIMARY KEY, so a losing
        // concurrent INSERT throws — it can never silently overwrite.
        ins.run(user_id, salt_b64, sentinel, now());
        return 'created';
      }
      if ((existing.salt_b64 as string) === salt_b64 && (existing.sentinel as string) === sentinel) {
        return 'identical'; // pure echo — idempotent replay, no write
      }
      return 'conflict'; // never overwrite — see the file header
    },
  };
}
