// SPEC-REF:
//   apps/server-core/src/db/schema-recovery.ts (table 15's DDL argues every column)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft §A7-2
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//   apps/server-core/src/socket/handlers/audio-start-operation.ts (its ONE caller)
//
// Card PR-2's operation registry: 「have I seen this request before, and did it
// say the same thing」.
//
// 🔴 THIS TABLE DECIDES NOTHING ABOUT MONEY. It is keyed `(user, operation_id)`
// and that key only stops a request being REGISTERED twice; the key that stops
// an account being METERED twice is `(user, operation_id, kind)` and lives in
// usage-effects.repo.ts. §A7-2 states outright that the two must not be
// conflated, and the practical reason is that one operation legitimately meters
// twice (STT minutes, then polish tokens) — a registry that also gated billing
// would let the second of those be swallowed by the first.

import type { DatabaseSync } from 'node:sqlite';
import { RECOVERY_CLAIM_RETENTION_MS, RECOVERY_RETENTION_MS } from '../schema-recovery';

/** Everything an `audio:start` binds to its `operation_id`, as the frame carried
 *  it. `undefined` means the frame named nothing — never 「zero」, never a
 *  default: the immutability check below compares 「named nothing」 against
 *  「named something else」 and they must stay two answers. */
export interface OperationBinding {
  recording_id?: string | undefined;
  /** NR-138 round 6 (review B6) — the job the phone derived the operation from. */
  job_id?: string | undefined;
  range_start_sample?: number | undefined;
  range_end_sample?: number | undefined;
  attempt_kind?: string | undefined;
  mode: string;
}

export type OperationAdmission =
  /** First time this `(user, operation_id)` has been seen. */
  | { outcome: 'registered' }
  /** Seen before, with the SAME binding. `resends` is the count AFTER this one. */
  | { outcome: 'resend'; resends: number }
  /** Seen before with a DIFFERENT binding. Nothing was written. */
  | { outcome: 'conflict'; stored: OperationBinding };

export interface RecoveryOperationsRepo {
  /**
   * Register this operation, or recognise a re-send of it, or refuse it.
   *
   * 🔴 REFUSAL IS THE ONLY THIRD ANSWER, and it does NOT overwrite (§A7-2:
   * 「重发携带不同绑定 ⇒ 拒收，不是覆盖」). A registry that agreed with whichever
   * request arrived last would answer 「have I seen this」 with 「I have now」,
   * which is not the question.
   */
  admit(user_id: string, operation_id: string, binding: OperationBinding, at?: number): OperationAdmission;
  /** Read one row back, for tests and for an operator answering 「what did this
   *  operation bind to」. Returns null when the id is unknown here. */
  get(user_id: string, operation_id: string): (OperationBinding & { resend_count: number }) | null;
  /** Drop operations whose last sighting is older than the retention window.
   *  Returns how many went. A re-send after this is a NEW operation — registered
   *  again and metered again; see schema-recovery.ts for why that residual is
   *  accepted rather than solved. */
  prune(now?: number): number;
  /** NR-138 round 5 — this account's registered operations, for the account export (http/account-lifecycle.ts). */
  listByUser(user_id: string): RecoveryOperationRow[];
}

/** One registry row as the export hands it out. */
export interface RecoveryOperationRow extends OperationBinding {
  operation_id: string;
  first_seen_at: number;
  last_seen_at: number;
  resend_count: number;
}

/** SQLite hands back `null` for an absent column; the binding type says
 *  `undefined`. Collapsing the two here rather than at each comparison keeps
 *  「the frame named nothing」 as ONE value instead of two that are `!==`. */
function orUndef<T>(v: T | null | undefined): T | undefined {
  return v === null ? undefined : v;
}

function sameBinding(a: OperationBinding, b: OperationBinding): boolean {
  return a.recording_id === b.recording_id
    // Round 6: [a] is the STORED row. One written before `job_id` existed has none and does not compare it; the
    // operation's claim carries its own binding, which is what protects billing for it (usage-effects.repo.ts).
    && (a.job_id === undefined || a.job_id === b.job_id)
    && a.range_start_sample === b.range_start_sample
    && a.range_end_sample === b.range_end_sample
    && a.attempt_kind === b.attempt_kind
    && a.mode === b.mode;
}

export function makeRecoveryOperationsRepo(db: DatabaseSync): RecoveryOperationsRepo {
  const selectStmt = db.prepare(
    `SELECT recording_id, job_id, range_start_sample, range_end_sample, attempt_kind, mode, resend_count
       FROM recovery_operations WHERE user_id = ? AND operation_id = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO recovery_operations
       (user_id, operation_id, recording_id, range_start_sample, range_end_sample,
        attempt_kind, mode, first_seen_at, last_seen_at, resend_count, job_id)
     VALUES (?,?,?,?,?,?,?,?,?,0,?)`,
  );
  const bumpStmt = db.prepare(
    `UPDATE recovery_operations SET last_seen_at = ?, resend_count = resend_count + 1
      WHERE user_id = ? AND operation_id = ?`,
  );
  // *** billing *** NR-138 round 4 (book 22 §4.11 「Recording identity」): an operation that holds a metering claim
  // keeps its registry row — and with it the binding check that refuses a different recording, range, kind or mode
  // under the same id (AUDIO_OP_BINDING_CONFLICT) — for the life of the claim. Only unclaimed rows age out.
  // ⚠️ Round 5 (2026-10-01): and NO row outlives 90 days from `first_seen_at` (RECOVERY_CLAIM_RETENTION_MS), the
  // privacy policy's per-use window — claimed or not.
  const sweepStmt = db.prepare(
    `DELETE FROM recovery_operations
      WHERE first_seen_at < ?
         OR (last_seen_at < ?
             AND NOT EXISTS (SELECT 1 FROM usage_effects e
                              WHERE e.user_id = recovery_operations.user_id
                                AND e.operation_id = recovery_operations.operation_id))`,
  );

  // *** billing *** NR-138 round 6 (book 22 §4.11, review B7): a BOUND claim of this operation — its own copy of the
  // binding, which lives exactly as long as the claim (90 days by `applied_at`), registry row or not.
  const boundClaimStmt = db.prepare(
    `SELECT recording_id, job_id, range_start_sample, range_end_sample FROM usage_effects
      WHERE user_id = ? AND operation_id = ?
        AND recording_id IS NOT NULL AND job_id IS NOT NULL
        AND range_start_sample IS NOT NULL AND range_end_sample IS NOT NULL
      LIMIT 1`,
  );

  const byUserStmt = db.prepare(
    `SELECT operation_id, recording_id, job_id, range_start_sample, range_end_sample, attempt_kind, mode,
            first_seen_at, last_seen_at, resend_count
       FROM recovery_operations WHERE user_id = ? ORDER BY first_seen_at DESC`,
  );

  function read(user_id: string, operation_id: string): (OperationBinding & { resend_count: number }) | null {
    const r = selectStmt.get(user_id, operation_id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      recording_id: orUndef(r['recording_id'] as string | null),
      job_id: orUndef(r['job_id'] as string | null),
      range_start_sample: orUndef(r['range_start_sample'] as number | null),
      range_end_sample: orUndef(r['range_end_sample'] as number | null),
      attempt_kind: orUndef(r['attempt_kind'] as string | null),
      mode: r['mode'] as string,
      resend_count: Number(r['resend_count'] ?? 0),
    };
  }

  return {
    admit(user_id, operation_id, binding, at = Date.now()): OperationAdmission {
      // *** billing *** Round 6 (review B7): a bound claim answers first, so its binding holds for the claim's whole
      // life even after the registry row below has aged out — a different recording, job or range under a claimed
      // id is refused, never registered afresh against the free claim.
      const c = boundClaimStmt.get(user_id, operation_id) as
        { recording_id: string; job_id: string; range_start_sample: number; range_end_sample: number } | undefined;
      if (c !== undefined && (c.recording_id !== binding.recording_id || c.job_id !== binding.job_id
        || Number(c.range_start_sample) !== binding.range_start_sample || Number(c.range_end_sample) !== binding.range_end_sample)) {
        return {
          outcome: 'conflict',
          stored: {
            recording_id: c.recording_id, job_id: c.job_id,
            range_start_sample: Number(c.range_start_sample), range_end_sample: Number(c.range_end_sample),
            mode: binding.mode, // a claim does not store mode; the registry row (when it exists) does
          },
        };
      }
      const existing = read(user_id, operation_id);
      if (existing === null) {
        insertStmt.run(
          user_id, operation_id,
          binding.recording_id ?? null,
          binding.range_start_sample ?? null,
          binding.range_end_sample ?? null,
          binding.attempt_kind ?? null,
          binding.mode, at, at,
          binding.job_id ?? null,
        );
        return { outcome: 'registered' };
      }
      const { resend_count: _drop, ...stored } = existing;
      if (!sameBinding(stored, binding)) return { outcome: 'conflict', stored };
      bumpStmt.run(at, user_id, operation_id);
      return { outcome: 'resend', resends: existing.resend_count + 1 };
    },
    get: read,
    listByUser(user_id): RecoveryOperationRow[] {
      return (byUserStmt.all(user_id) as Record<string, unknown>[]).map((r) => ({
        operation_id: String(r['operation_id']),
        recording_id: orUndef(r['recording_id'] as string | null),
        job_id: orUndef(r['job_id'] as string | null),
        range_start_sample: orUndef(r['range_start_sample'] as number | null),
        range_end_sample: orUndef(r['range_end_sample'] as number | null),
        attempt_kind: orUndef(r['attempt_kind'] as string | null),
        mode: r['mode'] as string,
        first_seen_at: Number(r['first_seen_at']),
        last_seen_at: Number(r['last_seen_at']),
        resend_count: Number(r['resend_count'] ?? 0),
      }));
    },
    prune(now = Date.now()): number {
      const r = sweepStmt.run(now - RECOVERY_CLAIM_RETENTION_MS, now - RECOVERY_RETENTION_MS);
      return Number(r.changes ?? 0);
    },
  };
}
