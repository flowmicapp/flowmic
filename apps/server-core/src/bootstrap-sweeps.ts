// SPEC-REF:
//   apps/server-core/src/bootstrap.ts (its only caller)
//   apps/server-core/src/db/retention.ts (startRetentionSweeper)
//   apps/server-core/src/billing/service-sweep.ts (startServiceRefundSweeper)
//   apps/server-core/src/shutdown.ts (what has to stop, and in what order)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// THE BACKGROUND TIMERS THIS PROCESS ARMS, in one place.
//
// 🔴 WHY IT MOVED OUT OF bootstrap.ts, so nobody re-merges it: that file stood
// at EXACTLY the repo's 800-line cap, so the deadline sweep could not be armed
// there without either splitting it or deleting an argument from it. The
// precedent is to move a coherent family out VERBATIM and keep the reasoning —
// schema.ts → schema-billing.ts, bootstrap-http-deps.ts → bootstrap-billing-deps.ts.
// The retention block below is that file's text, unchanged.
//
// ── ⚠️ WHAT MAKES THESE TWO A FAMILY AND NOT JUST TWO CALLS ───────────────
//
// Each owns an interval, so each has to be STOPPED on the way down or a live
// timer keeps the process (and a vitest worker) alive and can fire against a
// closed database. That is the property `shutdown.ts` is ordered around, and it
// is the reason they are constructed together: a third timer added here inherits
// the stop obligation by being in the returned object, whereas one added inline
// somewhere else inherits nothing.
//
// 🔴 WHAT IS DELIBERATELY NOT HERE: the status-probe timer. It has the same
// stop obligation but is STARTED after `listen()` — its first tick dials
// external providers, and a boot that waited on somebody else's TLS handshake
// before it could answer a request would have made a health check into a startup
// dependency. Its construction stays in bootstrap.ts beside the line that starts
// it, because splitting a two-step arming across two files is how the second step
// gets lost.

import type { ServerConfig } from './config';
import type { DbConnection } from './db/connection';
import type { BillingService } from './billing/billing-service';
import { startRetentionSweeper, type RetentionSweeper } from './db/retention';
import { startServiceRefundSweeper, type ServiceSweeper } from './billing/service-sweep';
import { PROMISED_DEADLINES } from './billing/guided-setup';
import type { RefundOrigin, ServiceRefundOutcome } from './billing/service-refund';


export interface SweepWiring {
  config: ServerConfig;
  db: DbConnection;
  billing: BillingService;
  /** The shared refund action, or undefined when this deployment has no client
   *  to refund with. 🔴 UNDEFINED ARMS NO SWEEP AT ALL rather than a sweep whose
   *  every call fails: a timer that ticks and can never succeed is a timer that
   *  will one day be read as evidence the promise is being kept. */
  refund?: (orderId: string, origin: RefundOrigin) => Promise<ServiceRefundOutcome>;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface BackgroundSweeps {
  retention: RetentionSweeper;
  /** 2026-08-30 — the deadline refund sweep. ⚠️ ABSENT on a deployment that
   *  cannot refund (standalone, Creem off, no client). Absent means 「there is no
   *  such timer」, never 「skip stopping it」 — same contract as the replica
   *  timers in `ShutdownSteps`. */
  serviceRefunds?: ServiceSweeper;
}

export function startBackgroundSweeps(w: SweepWiring): BackgroundSweeps {
  const { config, db, billing, now, setIntervalFn, clearIntervalFn } = w;

  // GA-06: the daily retention sweep (05 §4). Runs in BOTH modes — a standalone
  // local DB grows exactly the same way. Nothing sweeps at boot: the first pass
  // lands one interval after listen() (see startRetentionSweeper).
  //
  // 🔴 0.2.38 — `limitsOf`, not `planOf`. This is the THIRD consumer of the plan
  // table (quota-guard and the registry above are the other two) and the ONE that
  // deletes data: with `planOf: billing.effectivePlan` the sweep re-derived the
  // window from a tier, and a `permanent_free` account resolves to `plan:'free'`
  // (owner bought nothing, D1 §6.1-bis) — so owner's own cloud blobs were on
  // free's 30-day window and were being swept. Same single solver as the guard
  // and the registry, so there is nowhere left that turns a tier into numbers.
  const retention = startRetentionSweeper({
    timeline: db.timeline,
    // A2-5 — the second object of the SAME per-user sweep (90 days, fixed for
    // every account — db/retention.ts USAGE_EVENTS_RETENTION_DAYS). Wired in
    // BOTH modes and NOT behind `config.usageEventsEnabled`: turning collection
    // off must not strand the rows that were written while it was on.
    usageEvents: db.usageEvents,
    siteCounts: db.siteCounts,
    listUserIds: () => db.users.listAll().map((u) => u.id),
    limitsOf: (userId) => billing.effectiveLimits(userId),
    ...(now ? { nowMs: now } : {}),
    ...(setIntervalFn ? { setIntervalFn } : {}),
    ...(clearIntervalFn ? { clearIntervalFn } : {}),
  });

  // 2026-08-30 — the deadline refund sweep (owner: build the capability, leave a
  // human pressing it by default).
  //
  // ⚠️ TWO CONDITIONS, AND THEY ANSWER DIFFERENT QUESTIONS. `refund === undefined`
  // means this deployment CANNOT refund at all — no timer is constructed, and the
  // absence is what `shutdown.ts` reads. `config.creem.autoRefundEnabled` means it
  // MAY NOT do so unattended — the sweeper is still constructed (so `runOnce` is
  // reachable and the OFF state is logged by name at composition time), it simply
  // arms no interval. Collapsing them would make 「we have no payment provider」
  // and 「we chose to keep a person in the loop」 the same silence.
  const serviceRefunds =
    w.refund === undefined
      ? undefined
      : startServiceRefundSweeper({
          purchases: db.billing,
          refund: w.refund,
          policy: PROMISED_DEADLINES,
          enabled: config.creem.autoRefundEnabled,
          ...(now ? { nowMs: now } : {}),
          ...(setIntervalFn ? { setIntervalFn } : {}),
          ...(clearIntervalFn ? { clearIntervalFn } : {}),
        });

  return { retention, ...(serviceRefunds === undefined ? {} : { serviceRefunds }) };
}
