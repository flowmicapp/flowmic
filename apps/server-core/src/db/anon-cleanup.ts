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

import type { TrialLedgerRepo } from './repos/trial-ledger.repo';
import type { UserRepo } from './repos/user.repo';
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
  /** `true` only when `FLOWMIC_WEB_ANON_CLEANUP_APPLY` is set. See the header:
   *  the default is a dry run, and it is the default on purpose. */
  apply: boolean;
  retentionMs?: number;
  batch?: number;
}

export interface AnonCleanupReport {
  /** Identities past the retention window at this tick. */
  candidates: number;
  /** Rows actually deleted — ALWAYS 0 on a dry run, which is what makes the two
   *  modes distinguishable in the log rather than merely described there. */
  deleted: number;
  apply: boolean;
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
  const stale = deps.trials.listOlderThan(cutoffIso, deps.batch ?? ANON_CLEANUP_BATCH);
  let deleted = 0;
  if (deps.apply) {
    for (const row of stale) {
      // `remove` returns false when the row is already gone — a concurrent
      // deletion, not an error. Counted on what actually went, never on what was
      // asked for: a count of intentions in a log line about deletions is how a
      // sweep comes to be believed to be working.
      if (deps.users.remove(row.anon_user_id)) deleted += 1;
    }
  }
  // ONE LINE PER TICK IN BOTH MODES, and the mode is IN the line. A dry run that
  // logged nothing would be indistinguishable from a sweep that is not armed at
  // all — and 「is it running」 is the only question the day before the switch is
  // thrown.
  log.info('anon cleanup', {
    mode: deps.apply ? 'apply' : 'dry-run',
    candidates: stale.length,
    deleted,
    cutoff: cutoffIso,
    env: 'FLOWMIC_WEB_ANON_CLEANUP_APPLY',
  });
  return { candidates: stale.length, deleted, apply: deps.apply };
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
