// SPEC-REF:
//   ./anon-cleanup.ts (the caller this exists for: archive-then-delete has to be
//     one indivisible step or the archive is a promise rather than a record)
//   ./repos/usage-effects.repo.ts · ../node/forward-ledger.ts (the two places
//     that already hand-roll this exact BEGIN/COMMIT/ROLLBACK block)
//
// One synchronous transaction, as a value that can be passed to something that
// must not know what a database is.
//
// ── WHY A RUNNER AND NOT `db.exec('BEGIN')` AT THE CALL SITE ───────────────
// `db/anon-cleanup.ts` is written against repos, never against `DatabaseSync` —
// that is what lets its tests drive it with a stub and what keeps the sweep's
// rules readable in one screen. Handing it a `DatabaseSync` to open a
// transaction on would undo that for one statement. Handing it a function does
// not.
//
// 🔴 THERE IS NO DEFAULT, AND THERE MUST NOT BE. The obvious convenience here
// is `tx = (run) => run()` when no runner is supplied — and it is exactly the
// "friendly empty default" CLAUDE.md's anti-façade rule ② forbids: every caller
// would still compile, every test would still be green, and atomicity — the ONE
// thing this file exists to provide — would be silently absent wherever someone
// forgot to wire it.

import type { DatabaseSync } from 'node:sqlite';

/** Run `body` inside one transaction; commit its value or roll back its throw. */
export type TransactionRunner = <T>(body: () => T) => T;

export function makeTransactionRunner(db: DatabaseSync): TransactionRunner {
  return <T>(body: () => T): T => {
    // IMMEDIATE, like every other transaction in this server: the write lock is
    // taken up front rather than on the first write, so a second writer is
    // refused at the start instead of halfway through.
    //
    // 🔴 SQLITE HAS NO NESTED `BEGIN`. A caller that is already inside a
    // transaction must NOT wrap itself in this one — see usage-effects.repo.ts
    // `claimInCallerTransaction` for the shape that exists to avoid it.
    db.exec('BEGIN IMMEDIATE');
    let out: T;
    try {
      out = body();
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone; the original error is the one that
           matters and rethrowing this one would hide it */
      }
      throw err;
    }
    // Outside the try on purpose: a COMMIT that fails must not be answered with
    // a ROLLBACK of a transaction that may already be closed, and it is not a
    // failure of `body` — it is a failure of the commit, and it propagates as
    // itself.
    db.exec('COMMIT');
    return out;
  };
}
