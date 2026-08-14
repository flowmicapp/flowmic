// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (pc_devices), §3.2 (paddle_subscriptions)
//   db/retention.ts (the sibling sweep this file is modeled on, and NOT merged
//     into — see below for why)
//   http/account-lifecycle.ts `USER_CASCADING_TABLES` / `USER_RETAINED_TABLES`
//     (the single source of truth this file must not contradict)
//   CLAUDE.md red line: no silent failure / one value answers only one question / anti-façade
//
// D11 — THE GROWTH HALF OF THE CARD. `pc_devices` and `paddle_subscriptions`
// both accumulate rows that are provably dead weight, and until this file
// nothing ever swept either one (no reaper, no cap, no cleanup method — the
// card's own words).
//
// 🔴 WHY A NEW, SEPARATE FILE INSTEAD OF FOLDING INTO db/retention.ts:
// retention.ts's own header insists on a SINGLE object
// (`timeline_blobs`) and a SINGLE entitlement-derived window
// (`BillingService.effectiveLimits().history_days`), and says so in its own
// words: "this file NEVER derives one [a retention window] — single source". Two more
// tables with two DIFFERENT, NON-entitlement age policies (a device's own
// last-seen clock; a subscription's own supersession rank) do not answer that
// file's question. Folding them in would be the very shape CLAUDE.md's anti-
// façade rule names: one file, two unrelated policies, one grep that can no
// longer tell you which rows a given change affects.
//
// 🔴 WHAT THIS FILE DOES NOT TOUCH, AND WHY — the two RETAINED tables named by
// this card and already fixed by P4's account-deletion design
// (`http/account-lifecycle.ts` `USER_RETAINED_TABLES`), unchanged here:
//   · `billing_events` — `event_id` is the Paddle webhook DEDUP KEY
//     (db/repos/billing.repo.ts). Deleting a row would let a redelivered
//     webhook notification past the idempotency check and apply a second
//     time. RETAINED FOREVER. This file has no import of anything that could
//     delete from that table.
//   · `ops_audit_log` — append-only BY CONVENTION OF THE REPO LAYER
//     (schema.ts's DDL comment; `db/repos/ops-audit.repo.ts` has no
//     update/remove method at all). "An audit record that can be deleted is not an audit record."
//     RETAINED FOREVER. Same: nothing here can reach it.
// Unbounded growth on those two is a CHOSEN cost, argued elsewhere, not a gap
// this file forgot — see the D11 report for the full per-table policy list.
//
// WHAT THIS FILE DOES SWEEP, and the exact rule for each:
//   · `pc_devices` — via `PcRepo.listStaleOffline`: is_online=0 AND unseen for
//     `pcStaleDays`, excluding the F-3140 virtual "cloud instance" row
//     (`CLOUD_INSTANCE_ID`, room/registry.ts — a read-only import of a const,
//     not an edit to that contended file).
//   · `paddle_subscriptions` — via `BillingRepo.listSupersededSubscriptions`:
//     ranked BEHIND the row `latestForUser` would return (same ORDER BY,
//     verbatim), canceled, AND older than `subSupersededDays`.
// Both candidate queries live in the repo layer (billing.repo.ts / pc.repo.ts)
// on purpose, same split as everywhere else in this codebase: the repo STORES
// and RANKS, this file only decides the age cutoff and whether to actually
// delete.
//
// 🔴 DRY RUN, NOT A SUGGESTION. `runOnce({ dryRun: true })` computes and
// returns the EXACT counts a real run would delete, without deleting
// anything; `peek()` returns the exact ROWS. This exists because this
// codebase already has a named prior incident with a "delete by plan/
// retention" sweep (db/retention.ts's own history, and the reason the age
// windows there are entitlement-sourced rather than hand-picked) — any new
// code that deletes rows in bulk is guilty until it can be pointed at a real
// database, in dry-run mode, and shown to be pointed at the RIGHT rows,
// before it is ever armed for real.
//
// Per-row isolation, same discipline as retention.ts's per-user try/catch:
// one row that fails to delete (a lock, a corrupt id) must not cost every
// OTHER row its sweep, and must not be swallowed either — it is logged at
// ERROR and the sweep continues.

import type { PcRecord, PcRepo } from './repos/pc.repo';
import type { BillingRepo, PaddleSubRow } from './repos/billing.repo';
import { CLOUD_INSTANCE_ID } from '../room/registry';
import { log } from '../log';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sweep cadence. Daily, same cadence as retention.ts — neither table grows
 *  fast enough to need anything shorter. */
export const REAPER_SWEEP_INTERVAL_MS = DAY_MS;

/** Age policy, in days. Both are injectable so a test does not have to wait
 *  months of real time to see a row age out. */
export interface GrowthReaperPolicy {
  /**
   * D11 default: 90 days offline with no reconnect. Long enough that a
   * machine left off over a long trip, an out-of-warranty repair, or a
   * seasonal absence is never mistaken for abandoned; short enough that "the
   * user reinstalled Windows twice" (the card's own example) is bounded
   * rather than a permanent lock-out — the row ages out on its own well
   * before that becomes the user's only way off the ceiling (self-service
   * `remove()` is still the FIRST escape route; this is the safety net for
   * a user who never finds the button).
   */
  pcStaleDays: number;
  /**
   * D11 default: 400 days past supersession (a full year of slack past the
   * 365-day mark) — long enough that a subscriber's own billing history
   * (`listEventsForUser`, keyed on `billing_events`, NOT this table) still
   * has its `paddle_subscriptions` row to cross-reference for a full year
   * after cancellation, short enough that a `cancel → resubscribe → cancel →
   * resubscribe` user does not accumulate rows forever either.
   */
  subSupersededDays: number;
}

export const DEFAULT_REAPER_POLICY: GrowthReaperPolicy = {
  pcStaleDays: 90,
  subSupersededDays: 400,
};

export interface GrowthReaperCounts {
  pcDevices: number;
  paddleSubscriptions: number;
}

export interface GrowthReaperPeek {
  pcDevices: PcRecord[];
  paddleSubscriptions: PaddleSubRow[];
}

export interface GrowthReaperDeps {
  pcs: Pick<PcRepo, 'listStaleOffline' | 'remove'>;
  billing: Pick<BillingRepo, 'listSupersededSubscriptions' | 'removeSubscription'>;
  /** Overrides merged onto {@link DEFAULT_REAPER_POLICY}; absent fields keep
   *  the default. */
  policy?: Partial<GrowthReaperPolicy>;
  /** Injectable ms clock (tests advance it instead of waiting months). */
  nowMs?: () => number;
  /** Injectable scheduler (tests drive ticks instead of waiting 24h). */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface GrowthReaper {
  /** Run one sweep synchronously. `dryRun: true` (default false) computes and
   *  returns the counts WITHOUT deleting anything. Never throws — fail-loud
   *  via log.error, same discipline as retention.ts's runOnce. */
  runOnce(opts?: { dryRun?: boolean }): GrowthReaperCounts;
  /** The exact ROWS a real sweep would delete right now, without deleting
   *  anything. Read-only; safe to call from an ops route. */
  peek(): GrowthReaperPeek;
  /** Disarm the interval. MUST be called before the DB closes. Idempotent. */
  stop(): void;
}

function zero(): GrowthReaperCounts {
  return { pcDevices: 0, paddleSubscriptions: 0 };
}

/**
 * Arm the daily growth-reaper sweep.
 *
 * NOTE — no startup sweep, same reasoning as retention.ts: a cold start must
 * reach `listen()` immediately, and neither table's window is tight enough
 * that a day's delay after boot matters.
 */
export function startGrowthReaper(deps: GrowthReaperDeps): GrowthReaper {
  const now = deps.nowMs ?? Date.now;
  const setI = deps.setIntervalFn ?? ((fn, ms): unknown => setInterval(fn, ms));
  const clearI = deps.clearIntervalFn ?? ((h): void => clearInterval(h as ReturnType<typeof setInterval>));
  const policy: GrowthReaperPolicy = { ...DEFAULT_REAPER_POLICY, ...deps.policy };
  let stopped = false;

  function cutoffs(): { pc: string; sub: string } {
    return {
      pc: new Date(now() - policy.pcStaleDays * DAY_MS).toISOString(),
      sub: new Date(now() - policy.subSupersededDays * DAY_MS).toISOString(),
    };
  }

  function peek(): GrowthReaperPeek {
    const { pc, sub } = cutoffs();
    return {
      pcDevices: deps.pcs.listStaleOffline(pc, CLOUD_INSTANCE_ID),
      paddleSubscriptions: deps.billing.listSupersededSubscriptions(sub),
    };
  }

  function sweepPcDevices(rows: PcRecord[], dryRun: boolean): number {
    let n = 0;
    for (const row of rows) {
      try {
        if (!dryRun) deps.pcs.remove(row.id);
        n += 1;
      } catch (err) {
        log.error('reaper: failed to remove a stale pc_devices row', {
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return n;
  }

  function sweepSubscriptions(rows: PaddleSubRow[], dryRun: boolean): number {
    let n = 0;
    for (const row of rows) {
      try {
        if (!dryRun) deps.billing.removeSubscription(row.subscription_id);
        n += 1;
      } catch (err) {
        log.error('reaper: failed to remove a superseded paddle_subscriptions row', {
          subscription_id: row.subscription_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return n;
  }

  function sweep(dryRun: boolean): GrowthReaperCounts {
    const candidates = peek();
    return {
      pcDevices: sweepPcDevices(candidates.pcDevices, dryRun),
      paddleSubscriptions: sweepSubscriptions(candidates.paddleSubscriptions, dryRun),
    };
  }

  function runOnce(opts: { dryRun?: boolean } = {}): GrowthReaperCounts {
    if (stopped) return zero(); // a tick that raced stop() must be inert
    const dryRun = opts.dryRun ?? false;
    try {
      const counts = sweep(dryRun);
      if (counts.pcDevices > 0 || counts.paddleSubscriptions > 0) {
        log.info(dryRun ? 'reaper: dry-run would sweep' : 'reaper: swept', { ...counts, dryRun });
      }
      return counts;
    } catch (err) {
      // fail-loud, never silent (CLAUDE.md red line) — but a failed sweep must NOT
      // kill the daily timer, same argument as retention.ts's runOnce.
      log.error('reaper: sweep aborted', {
        error: err instanceof Error ? err.message : String(err),
        dryRun,
      });
      return zero();
    }
  }

  const handle = setI(() => void runOnce(), REAPER_SWEEP_INTERVAL_MS);
  // A 24h timer must never be the reason a process (or a vitest worker)
  // refuses to exit. Real Node timers unref; an injected fake need not
  // implement it.
  const unref = (handle as { unref?: () => void } | null)?.unref;
  if (typeof unref === 'function') unref.call(handle);

  return {
    runOnce,
    peek,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearI(handle);
    },
  };
}
