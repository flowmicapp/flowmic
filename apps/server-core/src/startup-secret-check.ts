// SPEC-REF:
//   docs/strategy/2026-08-05-d2-secret-domain-separation-design-cn.md §3.4
//     (startup self-check — "turn a silent failure into a loud failure", the design doc's own "the single
//     highest-value line of this design") + §1.3 (the silent-disaster mechanism this check exists to make
//     audible) + §7 decision 3 (refuse-to-boot vs. warn-only — OWNER HAS NOT RULED)
//   docs/strategy/2026-08-05-d2-stage0-delivery-cn.md (this card's delivery doc
//     — §4/§5 carry the red-before-green proof this file is required to pass)
//   src/db/enc-inventory.ts (the read-only count this check layers exactly one
//     decrypt attempt on top of)
//   src/auth/crypto.ts (decrypt() — throws on a GCM tag mismatch, the exact
//     failure mode a wrong or partially-restored deployment secret produces)
//
// 🔴 §7 DECISION 3 OF THE DESIGN DOC IS AN OPEN OWNER DECISION, NOT DECIDED HERE:
// refuse-to-boot vs. warn-only. The design doc's author recommends refuse-to-
// boot (§3.4 "my recommendation is refuse-to-boot"). The primary owner's explicit ruling for THIS round: implement
// WARN ONLY. This file does not contain an unused refuse-to-boot switch —
// wiring one in now, unused, would itself be this repo's #1 historical defect
// shape (a capability defined and never called). Converting this to refuse-to-
// boot later is a SINGLE-POINT change: see the call site comment in
// bootstrap.ts `startServer()`, immediately after `encryptionKey`/`db` are
// constructed, for the exact line that would change.
//
// This function never throws and never blocks boot, by construction: every
// branch returns a plain result object, and the one call that CAN throw
// (auth/crypto.ts decrypt()) is wrapped in try/catch here specifically so that
// property holds.

import type { DatabaseSync } from 'node:sqlite';
import { decrypt } from './auth/crypto';
import { inspectEncInventory } from './db/enc-inventory';

export interface SecretCheckResult {
  ok: boolean;
  totalApiKeyFields: number;
  byPrefix: Record<string, number>;
  /** Rows whose `value` column was not valid JSON. 🔴 Primary owner 2026-08-05 acceptance:
   *  enc-inventory.ts computes this and its own doc comment promises it "makes
   *  that a visible number instead of a fact this scan quietly walked past" —
   *  but the first version of this result object dropped it here, so it reached
   *  no boot log and the promise was only true up to the module boundary.
   *  Propagated, so the claim is true where it is made. */
  unparseableRows: number;
  /** Present iff `ok` is false — decrypt()'s caught error message, verbatim
   *  (never rewritten into a paraphrase a reader would have to trust). */
  reason?: string;
  /** Human-readable context for the log line — always present, on both
   *  branches, because "ok:true, nothing to verify" and "ok:true, verified
   *  against a real envelope" are different facts and a caller must not have
   *  to guess which one it got. */
  detail: string;
}

/**
 * Attempt exactly one decrypt of a real stored envelope with the key this boot
 * is about to use for every settings read from here on.
 *
 * Called from bootstrap.ts's `startServer()` right after `encryptionKey` and
 * `db` are constructed (§3.4) — see that call site for what happens with the
 * result: today, a loud `log.error`/`log.info` line and nothing else. This
 * function itself makes no logging decision and holds no opinion about
 * refuse-vs-warn; that decision lives entirely at the call site, which is
 * exactly what makes it a single-point change later.
 */
export function checkSettingsSecretAtBoot(db: DatabaseSync, encryptionKey: Buffer): SecretCheckResult {
  const inventory = inspectEncInventory(db);
  const base = { totalApiKeyFields: inventory.totalApiKeyFields, byPrefix: inventory.byPrefix, unparseableRows: inventory.unparseableRows };
  if (inventory.sampleEnvelope === null) {
    // Nothing to verify — a fresh DB, or an install where no account has ever
    // saved a BYOK api_key. `ok: true` here means "no evidence of a problem",
    // NOT "the key was proven correct" — a real, load-bearing distinction the
    // `detail` string states rather than leaves for a caller to assume.
    return { ok: true, ...base, detail: 'no enc:-prefixed api_key field exists yet — nothing to verify against' };
  }
  try {
    decrypt(inventory.sampleEnvelope, encryptionKey);
    return { ok: true, ...base, detail: 'a real stored envelope was decrypted successfully with the active key' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      ...base,
      reason,
      detail:
        'a real stored envelope FAILED to decrypt with the active key — this almost always means the database ' +
        'was restored but the deployment secret env var was not (docs/strategy/2026-08-05-d2-secret-domain-' +
        'separation-design-cn.md §1.3)',
    };
  }
}
