// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §4 (paired-room retention Free 30d / Pro 365d,
//     daily cron; the E2EE timeline carries the SAME policy)
//   docs/strategy/2026-07-23-relaunch-master-plan.md §2.3 (30-day cloud retention
//     is the Free/Pro entitlement boundary)
//   docs/strategy/2026-07-25-full-gap-audit/01-SERVER-PROTOCOL.md GA-06
//   docs/strategy/2026-07-23-mock-billing-design.md §8.4 (PLAN_LIMITS single source)
//   CLAUDE.md red line: no silent failure
//
// GA-06: the production DB was write-only — `transcript_history` and
// `timeline_blobs` grew forever because nothing ever swept them. This is the
// daily sweep.
//
// 0.2.27: the `transcript_history` leg is GONE with the table (owner architecture ruling
// docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md — the server does not
// store transcripts, so there is no 30/365-day window to enforce over them). The
// sweep now has ONE object, `timeline_blobs`, and the plan window still comes
// from the same single source. Retention on the transcripts themselves became
// each END's business the moment each end became their owner (the PC's bounded,
// persisted cutoff shipped in 0.2.26).
//
// Two disciplines pin it:
//
//   ① SINGLE SOURCE — the retention window is a `PlanLimits.history_days`, and
//      this file NEVER derives one. It asks `BillingService.effectiveLimits`,
//      the ONE place that answers "what is this user's quota right now" (D1 §6.1-bis).
//      Changing Free 30 → 60 is still a one-line edit, in billing/plans.ts.
//   ② PER-USER — the window is an entitlement, so the sweep walks users and asks
//      per user (expiry / UNLOCK_ALL / the permanent_free exemption are already
//      resolved by then). `users.plan` is only a mirror; reading it directly
//      would keep a lapsed Pro on a 365-day window.
//
// 🔴 0.2.38 — this file used to take `planOf(userId): Plan` and do
// `planLimits(planOf(u)).history_days` itself. That was the THIRD "look up the table by plan tier"
// site (quota-guard and room/registry were the two D1 §6.1-bis named), and the
// only one that DELETES DATA rather than refusing an action: a `permanent_free`
// account resolves to `plan:'free'` (owner bought nothing — §6.1-bis), so
// re-deriving limits from that tier put owner's own cloud blobs on free's 30-day
// window and swept them. An exemption cannot be expressed as a `Plan`, which is
// precisely why the dep is now the NUMBERS.
//
// `usage_records` is deliberately NEVER touched: monthly metering is a billing
// fact, not user content, and it has no retention policy (a swept usage row
// would silently refund quota). The test asserts this.
//
// 🔴 A2-5 / REQ-12-08 (2026-08-12) — `usage_events` IS swept, and it is the
// exact OPPOSITE case to the sentence above rather than an exception to it.
// The month bucket may not be swept because the quota reads it; the per-event
// log may not be kept forever because it is a COLLECTION surface with a
// published retention promise. Both facts follow from the same rule — a table's
// retention is decided by what reads it — which is why the two sit next to each
// other here instead of in two files.
// Two consequences, stated so neither is discovered later:
//   ① the sweep is what MAKES the reconciliation an inequality
//      (SUM(usage_events) <= usage_records). That gap is designed, and its only
//      cause is this function;
//   ② the window is a FIXED 90 days for every account, NOT `history_days`. It
//      is not an entitlement — a paid tier does not buy a longer record of
//      itself — so it deliberately does not go through `limitsOf`.

import type { TimelineRepo } from './repos/timeline.repo';
import type { UsageEventsRepo } from './repos/usage-events.repo';
import type { PlanLimits } from '../billing/plans';
import { log } from '../log';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sweep cadence. Daily per 05 §4 ("daily cron"). */
export const RETENTION_SWEEP_INTERVAL_MS = DAY_MS;

/**
 * A2-5 — how long a `usage_events` row lives. 90 days, for EVERY account.
 *
 * owner-decided (ledger `2026-08-12-three-lane-work-ledger.md:65`), which is why
 * it is a named constant and not a config knob: the number is a promise made in
 * the privacy text, and a deployment that could quietly run 400 days would make
 * that text false without anybody editing it.
 *
 * 🔴 NOT `PlanLimits.history_days`. That number is an ENTITLEMENT (what the
 * account bought) and this one is a COLLECTION LIMIT (how long we keep a record
 * of the account). Routing this through `limitsOf` would hand `permanent_free`
 * (whose exempt limits lift several fields to Infinity) a NaN cutoff — the exact
 * trap retention-cleanup.test.ts already documents for `history_days` — and,
 * worse, would mean a paying user is watched for longer.
 *
 * ⚠️ THE POLICY TEXT'S OTHER BLANK IS NOT THIS NUMBER. privacy-policy.md's
 * ⟨RETENTION⟩ placeholder is on the SERVER LOGS row (IP / timestamp / endpoint /
 * error codes), a different subject; filling it with 90 would be one number
 * answering two questions, inside a public promise. See the design's §5.4
 * correction block and approval-packet D3.
 */
export const USAGE_EVENTS_RETENTION_DAYS = 90;

export interface RetentionCounts {
  /** timeline_blobs rows hard-deleted (tombstones included). */
  blobs: number;
  /** A2-5 — usage_events rows hard-deleted. Always present, 0 when no
   *  `usageEvents` dep was wired, so a reader never has to tell "wasn't swept" from
   *  "was swept, but nothing had expired" by whether a key exists. */
  usageEvents: number;
  /** users visited without error. */
  users: number;
}

export interface RetentionDeps {
  timeline: TimelineRepo;
  /**
   * A2-5 — the per-event usage log's sweep leg, sliced to the ONE method
   * (`purgeOlderThan`) so this file cannot append or read a usage event.
   *
   * OPTIONAL, and the default is "don't sweep" rather than a friendly empty
   * implementation: absent means a caller (a test harness, an older wiring)
   * did not hand over the repo, and the honest consequence is that no
   * `usage_events` row is deleted — never a silent 0 that looks like "no rows
   * had expired". bootstrap always wires it; `test/usage-events.test.ts` asserts that
   * from the source tree, so "absent in production" cannot happen unnoticed.
   *
   * ⚠️ The sweep is NOT gated on `FLOWMIC_USAGE_EVENTS_ENABLED`. Turning the
   * write switch off must not strand rows that were written while it was on —
   * a retention promise that only holds while a feature is enabled is not a
   * retention promise.
   */
  usageEvents?: Pick<UsageEventsRepo, 'purgeOlderThan'>;
  /** Every account whose rows are subject to a retention window. */
  listUserIds(): string[];
  /** EFFECTIVE limits for a user (billing.effectiveLimits — expiry, unlock-all
   *  and the permanent_free exemption already resolved). 🔴 The NUMBERS, not a
   *  `Plan`: a tier cannot express an exemption, and the one thing this file
   *  does with the answer is delete rows. */
  limitsOf(userId: string): PlanLimits;
  /** Injectable ms clock (tests advance it instead of waiting a month). */
  nowMs?: () => number;
  /** Injectable scheduler (tests drive ticks instead of waiting 24h). */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface RetentionSweeper {
  /** Run one sweep synchronously. Never throws (fail-loud via log.error). */
  runOnce(): RetentionCounts;
  /** Disarm the interval. MUST be called before the DB closes. Idempotent. */
  stop(): void;
}

function zero(): RetentionCounts {
  return { blobs: 0, usageEvents: 0, users: 0 };
}

/**
 * Arm the daily retention sweep.
 *
 * NOTE — no startup sweep. The first pass runs one interval after boot, on
 * purpose: a cold start must reach `listen()` immediately (13 §4 deploy
 * discipline), and a synchronous multi-user range delete on a large DB would
 * sit in front of it. A day's delay on a 30-day window is immaterial.
 */
export function startRetentionSweeper(deps: RetentionDeps): RetentionSweeper {
  const now = deps.nowMs ?? Date.now;
  const setI = deps.setIntervalFn ?? ((fn, ms): unknown => setInterval(fn, ms));
  const clearI =
    deps.clearIntervalFn ?? ((h): void => clearInterval(h as ReturnType<typeof setInterval>));
  let stopped = false;

  function sweep(): RetentionCounts {
    const counts = zero();
    for (const userId of deps.listUserIds()) {
      // Per-user isolation: one account's failure (a corrupt plan row, a locked
      // page) must not cost every LATER account its sweep. Loud, then onward.
      try {
        const days = deps.limitsOf(userId).history_days;
        const cutoff = new Date(now() - days * DAY_MS).toISOString();
        counts.blobs += deps.timeline.purgeOlderThan(userId, cutoff);
        // A2-5 — the second object of the sweep, INSIDE the same per-user try
        // rather than in a loop of its own. Deliberate, and it is the whole
        // reason this is three lines and not a second function: one account's
        // failure must cost that account both legs and no later account either,
        // and a parallel loop would visit every user twice and give "which account's
        // sweep failed" two answers.
        // The cutoff is a FIXED window and an ms NUMBER — this column is
        // INTEGER ms-epoch, unlike timeline_blobs' ISO TEXT one line up.
        if (deps.usageEvents) {
          const eventsCutoff = now() - USAGE_EVENTS_RETENTION_DAYS * DAY_MS;
          counts.usageEvents += deps.usageEvents.purgeOlderThan(userId, eventsCutoff);
        }
        counts.users += 1;
      } catch (err) {
        log.error('retention: sweep failed for user', {
          user: userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return counts;
  }

  function runOnce(): RetentionCounts {
    if (stopped) return zero(); // a tick that raced stop() must be inert
    try {
      const counts = sweep();
      if (counts.blobs > 0 || counts.usageEvents > 0) log.info('retention: swept', { ...counts });
      return counts;
    } catch (err) {
      // fail-loud, never silent (CLAUDE.md red line) — but a failed sweep must NOT
      // kill the timer: swallowing the throw here is what keeps tomorrow's tick
      // scheduled. The error is on the record; the cadence survives it.
      log.error('retention: sweep aborted', {
        error: err instanceof Error ? err.message : String(err),
      });
      return zero();
    }
  }

  const handle = setI(() => void runOnce(), RETENTION_SWEEP_INTERVAL_MS);
  // A 24h timer must never be the reason a process (or a vitest worker) refuses
  // to exit. Real Node timers unref; an injected fake need not implement it.
  const unref = (handle as { unref?: () => void } | null)?.unref;
  if (typeof unref === 'function') unref.call(handle);

  return {
    runOnce,
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearI(handle);
    },
  };
}
