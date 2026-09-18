// SPEC-REF:
//   docs/decisions/2026-09-17-owner-enables-anon-trial-cleanup-with-archive.md
//     (owner: arm the sweep, but keep a record of every row it destroys)
//   ../schema-trial.ts TRIAL_ARCHIVE_SQL (the DDL, and why there is no foreign
//     key, no primary key and no `ms_used`)
//   ../anon-cleanup.ts (its only writer — inside the sweep's transaction)
//   *** HUMAN-AUDIT SENSITIVE (schema) ***
//
// The only writer of `trial_ledger_archive`. It has exactly one write and one
// read, because it has exactly one caller.

import type { DatabaseSync } from 'node:sqlite';

export interface TrialArchiveRepo {
  /**
   * Copy one live `trial_ledger` row into the archive, stamped `sweptAtIso`.
   *
   * Returns how many rows were copied — 1 normally, 0 when that identity has no
   * ledger row. 🔴 THE CALLER MUST READ IT. A 0 here with a successful DELETE
   * beside it is the difference between "swept and recorded" and "swept", and
   * `db/anon-cleanup.ts` rolls the whole tick back on exactly that mismatch.
   *
   * 🔴 IT COPIES INSIDE SQLITE, FROM THE LIVE TABLE, rather than binding the
   * fields of a row object the caller already read. Two reasons, and the second
   * is the load-bearing one: a JS round-trip would make "the archive is
   * field-for-field the row that was deleted" a property of `toRow()` plus this
   * file's parameter ORDER, whereas `INSERT … SELECT` with both column lists
   * written out makes it a property of the database. And per NR-22, both lists
   * ARE written out: `SELECT *` between two tables is a positional copy, which
   * is correct until the day one side grows a column and then is silently wrong.
   */
  archiveByUser(anonUserId: string, sweptAtIso: string): number;
  /** How many rows the archive holds. The sweep reads it before and after its
   *  own inserts: `changes` says what the statement believes it did, this says
   *  what the table actually contains, and a guard that trusts only the first
   *  cannot see an insert that lands somewhere else. */
  count(): number;
}

export function makeTrialArchiveRepo(db: DatabaseSync): TrialArchiveRepo {
  // Both column lists spelled out, in the same order, NAME BY NAME (NR-22).
  const copy = db.prepare(
    `INSERT INTO trial_ledger_archive
       (anon_user_id, ip_bucket, day, grants_used, ms_granted, anon_token,
        token_expires_at, created_at, device_uid, swept_at)
     SELECT anon_user_id, ip_bucket, day, grants_used, ms_granted, anon_token,
            token_expires_at, created_at, device_uid, ?
       FROM trial_ledger
      WHERE anon_user_id = ?`,
  );
  const total = db.prepare('SELECT COUNT(*) AS n FROM trial_ledger_archive');
  return {
    archiveByUser(anonUserId, sweptAtIso): number {
      return Number(copy.run(sweptAtIso, anonUserId).changes);
    },
    count(): number {
      return Number((total.get() as { n?: unknown })?.n ?? 0);
    },
  };
}
