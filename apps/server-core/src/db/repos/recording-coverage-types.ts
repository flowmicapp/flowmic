// SPEC-REF:
//   docs/strategy/2026-10-10-nr224-billed-once-guard-design.md §2
//   apps/server-core/src/db/repos/recording-coverage.repo.ts (the store and the rule these types describe)
//   *** HUMAN-AUDIT SENSITIVE (billing) ***
//
// NR-224 — the shapes of the per-recording coverage store, on their own so the claim ledger
// (usage-effects.repo.ts) can name them without importing the store that imports it (verify/lint circular).

export type CoverageAttemptKind = 'live' | 'auto_retry' | 'user_retranscribe';

/** The audio one metered session covered: [start_sample, end_sample) of [recording_id], and how it was sent. */
export interface RecordingCoverageRef {
  recording_id: string;
  start_sample: number;
  end_sample: number;
  attempt_kind: CoverageAttemptKind;
}

export interface CoverageSegment { s: number; e: number; ms: number; by: 'l' | 'r' }
export interface CoverageState {
  segments: CoverageSegment[];
  /** Free sessions this recording has had because of coverage: credited first meterings, credited longer replays,
   *  credited live presses, AND every free re-send of a credited operation. One budget, COVERAGE_CREDIT_LIMIT. */
  credits: number;
  /** Operations whose first metering (or longer replay) was credited. Their claim records the whole basis as settled,
   *  so their re-sends are judged free by the claim; this list is how such a re-send is made to spend [credits]. */
  credited_ops: string[];
}
export interface CoverageSettlement {
  /** What to debit: never more than [proposedMs]. */
  charge: number;
  /** proposed − charge: what earlier payment for the same audio covered. */
  credited: number;
  /** The row to write, or null when this session neither draws nor records. */
  next: CoverageState | null;
}

export interface RecordingCoverageRow {
  recording_id: string; segments: CoverageSegment[]; credits: number; credited_ops: string[]; created_at: number; updated_at: number;
}

export interface RecordingCoverageStore {
  /** Apply [settleCoverage] to the stored row and write the result. Runs inside the caller's transaction (the claim's).
   *  [operation_id] is recorded when the session is credited. A data error (an unreadable row, a constraint) is logged
   *  and the session is charged [proposedMs] in full; an error that makes SQLite roll the transaction back itself is
   *  RE-THROWN, so the caller's transaction fails as a whole and no charge lands outside it. */
  settle(user_id: string, ref: RecordingCoverageRef, basisMs: number, proposedMs: number, at: number, operation_id?: string): CoverageSettlement;
  /** A re-send of [operation_id] the claim would charge [claimCharge] (0 for a free re-send). Null ⇒ the operation was
   *  never credited for this recording (the caller keeps its own rule). Otherwise what to charge: [claimCharge] while the
   *  recording's budget lasts (spending one credit), the whole [amount] after it. Same error policy as [settle]. */
  creditedReplay(user_id: string, ref: RecordingCoverageRef, operation_id: string, amount: number, claimCharge: number, at: number): number | null;
  /** Drop rows created more than RECOVERY_CLAIM_RETENTION_MS (90 days) ago, with the claims they sit beside. */
  prune(now?: number): number;
  /** This account's rows, for the account export (http/account-lifecycle.ts). */
  listByUser(user_id: string): RecordingCoverageRow[];
}
