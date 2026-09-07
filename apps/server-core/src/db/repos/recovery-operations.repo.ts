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
import { RECOVERY_RETENTION_MS } from '../schema-recovery';

/** Everything an `audio:start` binds to its `operation_id`, as the frame carried
 *  it. `undefined` means the frame named nothing — never 「zero」, never a
 *  default: the immutability check below compares 「named nothing」 against
 *  「named something else」 and they must stay two answers. */
export interface OperationBinding {
  recording_id?: string | undefined;
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
}

/** SQLite hands back `null` for an absent column; the binding type says
 *  `undefined`. Collapsing the two here rather than at each comparison keeps
 *  「the frame named nothing」 as ONE value instead of two that are `!==`. */
function orUndef<T>(v: T | null | undefined): T | undefined {
  return v === null ? undefined : v;
}

function sameBinding(a: OperationBinding, b: OperationBinding): boolean {
  return a.recording_id === b.recording_id
    && a.range_start_sample === b.range_start_sample
    && a.range_end_sample === b.range_end_sample
    && a.attempt_kind === b.attempt_kind
    && a.mode === b.mode;
}

export function makeRecoveryOperationsRepo(db: DatabaseSync): RecoveryOperationsRepo {
  const selectStmt = db.prepare(
    `SELECT recording_id, range_start_sample, range_end_sample, attempt_kind, mode, resend_count
       FROM recovery_operations WHERE user_id = ? AND operation_id = ?`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO recovery_operations
       (user_id, operation_id, recording_id, range_start_sample, range_end_sample,
        attempt_kind, mode, first_seen_at, last_seen_at, resend_count)
     VALUES (?,?,?,?,?,?,?,?,?,0)`,
  );
  const bumpStmt = db.prepare(
    `UPDATE recovery_operations SET last_seen_at = ?, resend_count = resend_count + 1
      WHERE user_id = ? AND operation_id = ?`,
  );
  const sweepStmt = db.prepare('DELETE FROM recovery_operations WHERE last_seen_at < ?');

  function read(user_id: string, operation_id: string): (OperationBinding & { resend_count: number }) | null {
    const r = selectStmt.get(user_id, operation_id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      recording_id: orUndef(r['recording_id'] as string | null),
      range_start_sample: orUndef(r['range_start_sample'] as number | null),
      range_end_sample: orUndef(r['range_end_sample'] as number | null),
      attempt_kind: orUndef(r['attempt_kind'] as string | null),
      mode: r['mode'] as string,
      resend_count: Number(r['resend_count'] ?? 0),
    };
  }

  return {
    admit(user_id, operation_id, binding, at = Date.now()): OperationAdmission {
      const existing = read(user_id, operation_id);
      if (existing === null) {
        insertStmt.run(
          user_id, operation_id,
          binding.recording_id ?? null,
          binding.range_start_sample ?? null,
          binding.range_end_sample ?? null,
          binding.attempt_kind ?? null,
          binding.mode, at, at,
        );
        return { outcome: 'registered' };
      }
      const { resend_count: _drop, ...stored } = existing;
      if (!sameBinding(stored, binding)) return { outcome: 'conflict', stored };
      bumpStmt.run(at, user_id, operation_id);
      return { outcome: 'resend', resends: existing.resend_count + 1 };
    },
    get: read,
    prune(now = Date.now()): number {
      const r = sweepStmt.run(now - RECOVERY_RETENTION_MS);
      return Number(r.changes ?? 0);
    },
  };
}
