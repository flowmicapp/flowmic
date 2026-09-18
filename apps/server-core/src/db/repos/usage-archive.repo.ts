// SPEC-REF:
//   docs/decisions/2026-09-17-owner-enables-anon-trial-cleanup-with-archive.md
//     (owner: arm the sweep, but keep a record of what it destroys — and what an
//     anonymous visitor SPENT is destroyed by the same cascade)
//   ../schema-trial.ts USAGE_ARCHIVE_SQL (the DDL, and why there is no foreign
//     key and no primary key)
//   ./trial-archive.repo.ts (its sibling; the two are written in one transaction)
//   ../anon-cleanup.ts (their only writer)
//   *** HUMAN-AUDIT SENSITIVE (schema) ***
//
// The only writer of `usage_records_archive`.
//
// ── 🔴 IT HAS THREE METHODS AND ITS SIBLING HAS TWO ────────────────────────
// `trial_ledger` holds AT MOST ONE row per identity (the user id is its primary
// key), so its archive's guard could compare "rows copied" against "users
// deleted" — one is the other. `usage_records` is keyed by (user_id, month), so
// one identity can have none, one, or several rows, and nothing the sweep
// already knows says how many. `liveCountForUser` is the third number: without
// it "copied" could only ever be checked against itself.

import type { DatabaseSync } from 'node:sqlite';

export interface UsageArchiveRepo {
  /**
   * Copy every live `usage_records` row belonging to one identity into the
   * archive, stamped `sweptAtIso`.
   *
   * Returns how many rows were copied — 0 is ORDINARY here and must not be read
   * as a failure: an anonymous visitor who opened the page and never spoke has
   * a ledger row and no meter row at all. That is exactly why the caller
   * compares this against `liveCountForUser` rather than against 1.
   *
   * 🔴 IT COPIES INSIDE SQLITE, both column lists written out, for the reason
   * its sibling states: it makes "the archive is field-for-field the row that
   * was deleted" a property of the database rather than of a `toRow()` plus a
   * parameter order, and it keeps `SELECT *`'s positional trap (NR-22) out.
   */
  archiveByUser(userId: string, sweptAtIso: string): number;
  /**
   * How many LIVE `usage_records` rows that identity has right now.
   *
   * 🔴 READ BEFORE THE COPY AND INSIDE THE SAME TRANSACTION. It is the source
   * table's own answer to "how many rows are there to save", and it is the only
   * one of the three numbers in the sweep's guard that does not come from the
   * archive side — an INSERT that silently matched nothing would agree with an
   * archive that silently gained nothing, and only this one would disagree.
   */
  liveCountForUser(userId: string): number;
  /** How many rows the archive holds. The sweep reads it before and after its
   *  own inserts: `changes` says what the statements believe they did, this says
   *  what the table actually contains. */
  count(): number;
}

export function makeUsageArchiveRepo(db: DatabaseSync): UsageArchiveRepo {
  // Both column lists spelled out, in the same order, NAME BY NAME (NR-22).
  const copy = db.prepare(
    `INSERT INTO usage_records_archive
       (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at,
        swept_at)
     SELECT user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out,
            updated_at, ?
       FROM usage_records
      WHERE user_id = ?`,
  );
  const live = db.prepare('SELECT COUNT(*) AS n FROM usage_records WHERE user_id = ?');
  const total = db.prepare('SELECT COUNT(*) AS n FROM usage_records_archive');
  const asCount = (row: unknown): number => Number((row as { n?: unknown } | undefined)?.n ?? 0);
  return {
    archiveByUser(userId, sweptAtIso): number {
      return Number(copy.run(sweptAtIso, userId).changes);
    },
    liveCountForUser(userId): number {
      return asCount(live.get(userId));
    },
    count(): number {
      return asCount(total.get());
    },
  };
}
