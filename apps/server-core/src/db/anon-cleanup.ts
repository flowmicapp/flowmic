// SPEC-REF:
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.4 (「匿名行
//     清理任务（删 users 行＝销毁性）」), §7.1 F-1 (the privacy commitment this
//     sweep is what makes true: an anonymous identity and its IP-bucket hash are
//     kept no longer than 48 hours)
//   docs/strategy/2026-08-12-sensitive-surface-audit-queue.md (owner 2026-08-12:
//     an irreversible action stays behind an owner-only door)
//   ./repos/trial-ledger.repo.ts · ./repos/user.repo.ts `remove`
//   *** HUMAN-AUDIT SENSITIVE (schema + destructive) ***
//
// THE FIRST AUTOMATIC TASK IN THIS SERVER THAT DELETES A `users` ROW.
//
// ── 🔴 IT IS A DRY RUN UNLESS SOMEBODY SETS AN ENVIRONMENT VARIABLE ────────
// `FLOWMIC_WEB_ANON_CLEANUP_APPLY` unset ⇒ it counts what it WOULD delete and
// logs that, and deletes nothing. This is not caution for its own sake: owner's
// 2026-08-12 rule is that a change which cannot be taken back stays behind a
// door only owner opens, and rows are the one thing this repo cannot restore
// from a redeploy. The deployment plan (card X4-01) runs it dry for a day and
// reads the log before the switch is thrown.
//
// ── WHAT IT MAY DELETE, STATED AS A CONJUNCTION ────────────────────────────
// A row must be BOTH `users.anonymous = 1` AND older than the retention window.
// Two predicates, and each is load-bearing in a different direction: without the
// first this would be a sweep over every account on the platform, and without
// the second it would delete a visitor who is speaking right now.
//
// It deletes ONE thing per identity — the `users` row — and the foreign keys do
// the rest (`PRAGMA foreign_keys = ON`, db/schema.ts:65; `trial_ledger`,
// `pc_devices` and its `mobile_pairings` all cascade). That is the same shape
// `UserRepo.remove` already relies on for account deletion, and the reason there
// are deliberately no sibling DELETEs here: a hand-written list of tables is a
// list that the next new table is missing from.
//
// ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
// It never touches a row with `anonymous = 0`, it never deletes `usage_records`
// directly (those are the metering record and go with their user through the
// cascade, or stay if the user stays), and it never runs unbounded: `LIMIT` per
// tick, so one very large day cannot turn a sweep into a stall.
//
// ── 🔴 SINCE owner 2026-09-17 IT ARCHIVES BEFORE IT DELETES ────────────────
// The ruling that armed this sweep
// (docs/decisions/2026-09-17-owner-enables-anon-trial-cleanup-with-archive.md)
// attached one condition: 「要留下记录，以备数据分析」. So an armed tick now does
// THREE writes per identity, IN ONE TRANSACTION and in this order: copy the
// `trial_ledger` row into `trial_ledger_archive`, copy that identity's
// `usage_records` rows into `usage_records_archive`, then delete the `users`
// row.
//
// 🔴 THE SECOND COPY IS NOT A BONUS. The sentence one paragraph above — 「it
// never deletes `usage_records` directly … those go with their user through the
// cascade」 — is exactly why they had to be archived: the cascade destroys them,
// so a sweep that archived only the ledger would have kept a record of what
// every anonymous visitor was OFFERED and destroyed the record of what they
// actually USED. 「以备数据分析」 with the spend missing is an analysis of the
// offer. (This is the shape CLAUDE.md's anti-façade ⑦ warns about: the comment
// that explained the absence was correct and complete, and it still left the
// wrong thing on disk.)
//
// THE ORDER IS NOT A PREFERENCE. The delete cascades the ledger row away, so
// after it there is nothing left to copy — an archive written afterwards could
// only be written from something a caller remembered, which is a different
// claim than 「this is the row that was destroyed」.
//
// THE TRANSACTION IS NOT A PREFERENCE EITHER. Without it, a crash (or a throw,
// or a full disk) between the two writes deletes a row that was never recorded,
// and the failure looks exactly like a successful sweep: the row is gone, which
// is what the sweep is for. With it, the tick either records and deletes or
// does neither.
//
// ── AND IT COUNTS BOTH SIDES, BECAUSE 「IT ARCHIVED」 IS A CLAIM ────────────
// `archived` and `deleted` must come out equal, and a tick where they do not is
// rolled back whole and logged as a failure rather than reported as a sweep.
// The archive count is taken TWICE by two different mechanisms — the `changes`
// each INSERT reports, and the table's own row count before and after — because
// a statement's opinion of itself is not evidence that a row landed in the
// table this sweep claims to be filling.
//
// 🔴 THE METER ARCHIVE GETS ITS OWN THREE NUMBERS, AND THEY CANNOT BE THE SAME
// THREE. An identity has exactly one ledger row, so there 「copied」 could be
// checked against 「deleted」. It may have none, one or several meter rows, so
// the third number there has to come from the SOURCE table: `liveCountForUser`,
// read inside the transaction before the copy. Without it the check would be
// 「the archive says it copied what the archive grew by」 — two witnesses that
// fail together, which is one witness.

import type { TrialArchiveRepo } from './repos/trial-archive.repo';
import type { UsageArchiveRepo } from './repos/usage-archive.repo';
import type { TrialLedgerRepo } from './repos/trial-ledger.repo';
import type { UserRepo } from './repos/user.repo';
import type { TransactionRunner } from './tx';
import { log } from '../log';

/**
 * How long an anonymous identity and its IP-bucket hash are kept — 48 hours, the
 * number written into the privacy policy by card M4-02.
 *
 * 🔴 THE POLICY IS THE SOURCE, NOT THIS CONSTANT. If one of the two moves, the
 * other is wrong: a sweep that keeps rows longer than the policy says makes the
 * policy a false statement, and one that keeps them for less is fine but should
 * say so where a reader looks.
 */
export const ANON_ROW_RETENTION_MS = 48 * 60 * 60 * 1000;

/** The daily cadence every other sweep in this server runs on. */
export const ANON_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** At most this many identities per tick. A bound, not a policy: the leftovers
 *  are swept on the next tick, and a day that produced more than this is a day
 *  the log should be read. */
export const ANON_CLEANUP_BATCH = 500;

export interface AnonCleanupDeps {
  trials: Pick<TrialLedgerRepo, 'listOlderThan'>;
  users: Pick<UserRepo, 'remove'>;
  /** Where a row goes one statement before it is destroyed (owner 2026-09-17). */
  trialArchive: Pick<TrialArchiveRepo, 'archiveByUser' | 'count'>;
  /** Where the identity's METER rows go one statement before the cascade
   *  destroys them (owner 2026-09-17, second half). Same transaction, same
   *  `swept_at` stamp — the two archives are one record in two tables. */
  usageArchive: Pick<UsageArchiveRepo, 'archiveByUser' | 'liveCountForUser' | 'count'>;
  /** The transaction the archive and the delete share.
   *
   *  🔴 REQUIRED, with no default. A default of `(run) => run()` would compile
   *  everywhere, keep every test green, and quietly remove the only thing that
   *  makes the archive a record rather than an intention — db/tx.ts states the
   *  same rule at the other end. */
  tx: TransactionRunner;
  /** `true` only when `FLOWMIC_WEB_ANON_CLEANUP_APPLY` is set. See the header:
   *  the default is a dry run, and it is the default on purpose. */
  apply: boolean;
  retentionMs?: number;
  batch?: number;
}

export interface AnonCleanupReport {
  /** Identities past the retention window at this tick. */
  candidates: number;
  /** Ledger rows copied into `trial_ledger_archive` and COMMITTED. Equal to
   *  `deleted` on every successful tick — that equality is the whole guard — and
   *  0 on a dry run and on a rolled-back tick. */
  archived: number;
  /** `usage_records` rows copied into `usage_records_archive` and COMMITTED.
   *
   *  🔴 NOT COMPARABLE TO `deleted`, and reported separately for exactly that
   *  reason: it counts METER ROWS, not identities, and a tick where every
   *  identity spoke for two calendar months legitimately reports twice
   *  `deleted`. 0 with `deleted > 0` is legitimate too — visitors who opened the
   *  page and never spoke. What it IS checked against is the source table's own
   *  count; see the guard. */
  usageArchived: number;
  /** Rows actually deleted — ALWAYS 0 on a dry run, which is what makes the two
   *  modes distinguishable in the log rather than merely described there. */
  deleted: number;
  apply: boolean;
  /** The tick opened a transaction and threw it away: the archive and the
   *  delete disagreed, or one of them failed. NOTHING was written. Reported
   *  rather than thrown, because this runs on a timer and an exception out of a
   *  timer callback is how a process dies for a reason nobody can read. */
  rolledBack: boolean;
}

/** `FLOWMIC_WEB_ANON_CLEANUP_APPLY` — set to anything non-empty to arm deletion. */
export function anonCleanupApplyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.FLOWMIC_WEB_ANON_CLEANUP_APPLY ?? '').trim() !== '';
}

/**
 * One pass. Pure over its deps and returns what it saw, so a test can drive it
 * without a timer and an operator can read the same numbers out of the log.
 */
export function runAnonCleanup(deps: AnonCleanupDeps, nowMs: number): AnonCleanupReport {
  const retentionMs = deps.retentionMs ?? ANON_ROW_RETENTION_MS;
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();
  // The same clock the cutoff came from, so `swept_at − created_at` on an
  // archived row is a duration two ends of one reader agreed on.
  const sweptAtIso = new Date(nowMs).toISOString();
  let candidates = 0;
  let archived = 0;
  let usageArchived = 0;
  let deleted = 0;
  let rolledBack = false;
  let failure = '';

  if (!deps.apply) {
    candidates = deps.trials.listOlderThan(cutoffIso, deps.batch ?? ANON_CLEANUP_BATCH).length;
  } else {
    try {
      deps.tx(() => {
        // Read INSIDE the transaction: the list is what will be destroyed, and a
        // list read before the write lock was taken is a list that could have
        // changed under it.
        const stale = deps.trials.listOlderThan(cutoffIso, deps.batch ?? ANON_CLEANUP_BATCH);
        candidates = stale.length;
        const before = deps.trialArchive.count();
        const usageBefore = deps.usageArchive.count();
        let copied = 0;
        let usageExpected = 0;
        let usageCopied = 0;
        let gone = 0;
        for (const row of stale) {
          // Archive first — after the delete there is nothing left to copy.
          copied += deps.trialArchive.archiveByUser(row.anon_user_id, sweptAtIso);
          // The source table's own answer to 「how many rows are about to be
          // destroyed」, read BEFORE the copy and inside this transaction. It is
          // the one number in the meter guard that does not come from the
          // archive side.
          usageExpected += deps.usageArchive.liveCountForUser(row.anon_user_id);
          usageCopied += deps.usageArchive.archiveByUser(row.anon_user_id, sweptAtIso);
          // `remove` returns false when the row is already gone. Counted on what
          // actually went, never on what was asked for: a count of intentions in
          // a log line about deletions is how a sweep comes to be believed to be
          // working.
          if (deps.users.remove(row.anon_user_id)) gone += 1;
        }
        // 🔴 THE GUARD, AND IT IS THREE NUMBERS RATHER THAN TWO. `copied` is what
        // the INSERTs said they did; `grew` is what the archive table actually
        // contains more of; `gone` is what was destroyed. All three have to
        // agree, because the first two can disagree (an insert that lands
        // elsewhere, a trigger, a second writer) and the first and third can
        // disagree (a ledger row that was already missing under a `users` row
        // that was not). Any disagreement throws, and the throw is what rolls
        // the tick back — nothing is deleted that was not recorded.
        const grew = deps.trialArchive.count() - before;
        if (copied !== gone || grew !== copied) {
          throw new Error(
            `anon cleanup refused: archived=${copied} archiveGrewBy=${grew} deleted=${gone}`,
          );
        }
        // 🔴 THE METER GUARD, THE SAME SHAPE WITH A DIFFERENT THIRD NUMBER.
        // `usageExpected` is what the SOURCE table held, `usageCopied` is what
        // the INSERTs said they took, `usageGrew` is what the archive table
        // actually contains more of. Its own throw and its own message, rather
        // than one combined condition, because the two failures send an
        // operator to two different tables.
        const usageGrew = deps.usageArchive.count() - usageBefore;
        if (usageCopied !== usageExpected || usageGrew !== usageCopied) {
          throw new Error(
            `anon cleanup refused: usageRowsLive=${usageExpected} ` +
              `usageArchived=${usageCopied} usageArchiveGrewBy=${usageGrew}`,
          );
        }
        archived = copied;
        usageArchived = usageCopied;
        deleted = gone;
      });
    } catch (err) {
      // The transaction is already rolled back by the runner. These two are set
      // back to zero rather than left at whatever the failed pass reached: they
      // describe what is ON DISK, and on disk nothing happened.
      rolledBack = true;
      archived = 0;
      usageArchived = 0;
      deleted = 0;
      failure = err instanceof Error ? err.message : String(err);
      // 🔴 NOT RETHROWN. This runs from a timer callback, and an exception there
      // takes the process down with a stack nobody correlates to a sweep. The
      // next tick tries again; until then the rows are still there, which is the
      // safe direction to fail in for a DELETE.
      log.error('anon cleanup FAILED — nothing was archived and nothing was deleted', {
        reason: failure,
        candidates,
        cutoff: cutoffIso,
      });
    }
  }

  // ONE LINE PER TICK IN BOTH MODES, and the mode is IN the line. A dry run that
  // logged nothing would be indistinguishable from a sweep that is not armed at
  // all — and 「is it running」 is the only question the day before the switch is
  // thrown.
  //
  // `archived` rides in the same line as `deleted` on purpose: the promise owner
  // attached to arming this sweep is that the two are equal, and two numbers in
  // two different log lines is a comparison nobody performs.
  log.info('anon cleanup', {
    mode: deps.apply ? 'apply' : 'dry-run',
    candidates,
    archived,
    usage_archived: usageArchived,
    deleted,
    ...(rolledBack ? { rolled_back: true } : {}),
    cutoff: cutoffIso,
    env: 'FLOWMIC_WEB_ANON_CLEANUP_APPLY',
  });
  return { candidates, archived, usageArchived, deleted, apply: deps.apply, rolledBack };
}

export interface AnonCleanupSweeper {
  /** Run one pass now — the seam a test and an operator share. */
  runOnce(nowMs?: number): AnonCleanupReport;
  stop(): void;
}

/**
 * Arm the daily pass.
 *
 * The first tick lands one interval after boot rather than at boot, the same as
 * `startRetentionSweeper`: a deletion pass racing a still-warming process is a
 * risk bought for nothing, since nothing expires in the first day of uptime that
 * would not still be expired tomorrow.
 */
export function startAnonCleanupSweeper(deps: AnonCleanupDeps & {
  nowMs?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  intervalMs?: number;
}): AnonCleanupSweeper {
  const now = deps.nowMs ?? Date.now;
  const setI = deps.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const clearI = deps.clearIntervalFn ?? ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>));
  const handle = setI(() => { runAnonCleanup(deps, now()); }, deps.intervalMs ?? ANON_CLEANUP_INTERVAL_MS);
  return {
    runOnce: (nowMs) => runAnonCleanup(deps, nowMs ?? now()),
    stop: () => clearI(handle),
  };
}
