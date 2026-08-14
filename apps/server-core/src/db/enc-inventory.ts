// SPEC-REF:
//   docs/strategy/2026-08-05-d2-secret-domain-separation-design-cn.md §4 Stage 0
//     ("add a read-only inventory capability: how many enc: fields exist in the
//      database, and what prefixes do they carry")
//   docs/strategy/2026-08-05-d2-stage0-delivery-cn.md (this card's delivery doc —
//     §3 records the real caller and captured output this module is proven by)
//   src/db/repos/settings.repo.ts (isApiKeyField, walkDecrypt — mirrored here,
//     not imported, because that predicate is module-private there; the same
//     mirror-not-import discipline http/account-lifecycle.ts's redactSecrets
//     already applies to the identical predicate)
//   src/auth/crypto.ts (ENVELOPE_PREFIX = 'enc:v1:' — the one recognized prefix
//     today; a value that doesn't start with it is counted, never dropped)
//
// 🔴 THIS MODULE NEVER DECRYPTS AND NEVER WRITES. Stage 0 of the design doc is
// "observation only, not a single cryptographic byte moves" — this file reads
// user_settings.value, JSON.parse's it, and counts api_key/apiKey string leaves
// by their prefix. It does not call auth/crypto.ts's decrypt(). Whether a given
// envelope is ACTUALLY decryptable under the current key is a different
// question, answered by startup-secret-check.ts, which layers exactly one
// decrypt attempt on top of this module's sample.

import type { DatabaseSync } from 'node:sqlite';

/** Mirrors settings.repo.ts's isApiKeyField (module-private there). If that
 *  repo's field list ever grows, this mirror must be updated in the same
 *  change — test/enc-inventory.test.ts pins both sides against a real
 *  SettingsRepo write so the drift cannot go unnoticed. */
function isApiKeyField(name: string): boolean {
  return name === 'api_key' || name === 'apiKey';
}

/** The one envelope prefix production code recognizes today (auth/crypto.ts
 *  ENVELOPE_PREFIX). Kept as a list of one, not a single constant, because
 *  Stage 1+ (out of scope for this card) is exactly "a second prefix joins
 *  this list" — the shape must not have to change, only the contents. */
const KNOWN_PREFIXES = ['enc:v1:'] as const;

/** The bucket key for an api_key value that does not start with any prefix in
 *  KNOWN_PREFIXES. Never silently folded into a "0 problems" total — a string
 *  that isn't empty and isn't a recognized envelope is itself a fact worth
 *  surfacing (e.g. a plaintext key from before encryption existed, or a typo'd
 *  prefix from manual DB surgery). */
const UNRECOGNIZED = 'unrecognized';

export interface EncInventoryReport {
  /** Total api_key/apiKey string leaves found across every row's parsed value
   *  (empty strings excluded — settings.repo.ts's own walkEncrypt never
   *  encrypts an empty string, so an empty leaf is "field present, never
   *  filled", not an envelope of any generation). */
  totalApiKeyFields: number;
  /** Count by envelope prefix actually observed. Keys are prefixes from
   *  KNOWN_PREFIXES plus the literal 'unrecognized' — every counted field
   *  lands in exactly one bucket, so summing the values equals
   *  totalApiKeyFields. */
  byPrefix: Record<string, number>;
  /** One real envelope string, verbatim, carrying a KNOWN prefix — for the
   *  startup self-check to attempt exactly one decrypt against. `null` when no
   *  such envelope exists anywhere (fresh DB, or every account is BYOK-free) —
   *  a DIFFERENT fact from "there is one and it's unreadable", so callers must
   *  not collapse the two. */
  sampleEnvelope: string | null;
  /** Rows whose `value` column was not valid JSON. Counted, not swallowed:
   *  settings.repo.ts's own toRow() would throw on the same row (it has no
   *  try/catch either, §1.2 of the design doc) — this field makes that a
   *  visible number instead of a fact this scan quietly walked past. */
  unparseableRows: number;
}

function prefixOf(value: string): string {
  for (const p of KNOWN_PREFIXES) {
    if (value.startsWith(p)) return p;
  }
  return UNRECOGNIZED;
}

function walk(value: unknown, report: EncInventoryReport): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, report);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isApiKeyField(k) && typeof v === 'string' && v.length > 0) {
        report.totalApiKeyFields += 1;
        const p = prefixOf(v);
        report.byPrefix[p] = (report.byPrefix[p] ?? 0) + 1;
        if (report.sampleEnvelope === null && p !== UNRECOGNIZED) {
          report.sampleEnvelope = v;
        }
      } else {
        walk(v, report);
      }
    }
  }
}

/**
 * Read-only pass over EVERY `user_settings` row: how many api_key/apiKey
 * fields exist, and what envelope prefixes they carry. No decrypt, no write.
 *
 * 🔴 CALLED FROM (production): startup-secret-check.ts, wired into
 * bootstrap.ts's startServer() right after the DB connection is opened. Called
 * FROM (tests): test/enc-inventory.test.ts and
 * test/startup-secret-check.test.ts. If this list is ever true of the test
 * files only, this capability is DEFINED but not USED in production — this
 * repo's #1 historical defect shape — and whoever reads this comment next must
 * correct it rather than trust it.
 */
export function inspectEncInventory(db: DatabaseSync): EncInventoryReport {
  const report: EncInventoryReport = { totalApiKeyFields: 0, byPrefix: {}, sampleEnvelope: null, unparseableRows: 0 };
  const rows = db.prepare('SELECT value FROM user_settings').all() as { value: string }[];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      report.unparseableRows += 1;
      continue;
    }
    walk(parsed, report);
  }
  return report;
}
