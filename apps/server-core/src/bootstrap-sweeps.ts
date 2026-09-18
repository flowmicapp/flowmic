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
// ── 🔴 NR-67 — AND NOT ONE OF THEM IS ARMED ON A READ REPLICA ─────────────
//
// Every timer in this file WRITES: retention and the growth reaper DELETE rows,
// the recovery prune DELETEs rows, the anonymous sweep DELETEs a `users` row and
// ARCHIVES it first, and the deadline sweep MOVES MONEY at a payment provider.
// A replica's database is replaced wholesale every thirty seconds
// (node/replica-puller.ts: `DELETE FROM main.t` + re-INSERT from the writer's
// snapshot, every shared table, one transaction) — so on a replica each of those
// writes is undone before it can matter, and the two that are not merely wasted
// are actively wrong:
//   · the anonymous sweep would DELETE the identity and WRITE the archive rows
//     that owner's 2026-09-17 ruling attached as its condition — and the next
//     pull wipes the archive too. Deleted without a record is the one outcome
//     that ruling exists to forbid; the row itself comes back from the writer,
//     so the only lasting effect of a replica tick is the destruction of the
//     record of the destruction.
//   · the deadline sweep would issue a SECOND refund for a purchase the writer
//     is also sweeping — the call leaves this box, the money moves, and the
//     local row saying so is gone in thirty seconds.
// Observed on srvjp (JP replica) 2026-09-14 and 2026-09-15:
// `anon cleanup {"mode":"dry-run"}` in its journal. Dry-run was the only reason
// that was harmless, and `FLOWMIC_WEB_ANON_CLEANUP_APPLY` is one uncommented
// line in `/etc/flowmic-app/env` away from not being. THIS FILE, not that line,
// is what makes it structural.
//
// ⚠️ `single` COUNTS AS A WRITER, and that is the whole default: every
// deployment that sets no node variables at all — the desktop sidecar, a
// standalone box, today's single-node saas — must keep arming exactly what it
// arms today. The gate reads `role === 'replica'`, never `role === 'writer'`,
// so a missing role never silences a sweep.
//
// ⚠️ THE GATE IS ONE DECISION, NOT FIVE. It swaps the scheduler this file hands
// every sweep, so a sweep ADDED here later inherits it the same way it inherits
// the stop obligation above — which is the property the copies-of-an-`if`
// version does not have (node/writer-only.ts's header argues the same point at
// length). The price is stated rather than discovered: a timer that only READS
// would be silenced here too, and a sweep that did work at CONSTRUCTION time
// rather than on its tick would not be silenced at all. Neither exists today;
// both are reasons to read this paragraph before adding one.
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
import { serviceRefunder } from './bootstrap-billing-deps';
import { startServiceRefundSweeper, type ServiceSweeper } from './billing/service-sweep';
import { PROMISED_DEADLINES } from './billing/guided-setup';
import type { RefundOrigin, ServiceRefundOutcome } from './billing/service-refund';
import { startGrowthReaper, type GrowthReaper } from './db/reaper';
import { FORWARD_LEDGER_PRUNE_INTERVAL_MS, type ForwardLedger } from './node/forward-ledger';
import { RECOVERY_PRUNE_INTERVAL_MS } from './db/schema-recovery';
import { startAnonCleanupSweeper, anonCleanupApplyFromEnv, type AnonCleanupSweeper } from './db/anon-cleanup';
import type { NodeRole } from './node/node-config';
import { log } from './log';


export interface SweepWiring {
  config: ServerConfig;
  db: DbConnection;
  billing: BillingService;
  /** The shared refund action, or undefined when this deployment has no client
   *  to refund with. 🔴 UNDEFINED ARMS NO SWEEP AT ALL rather than a sweep whose
   *  every call fails: a timer that ticks and can never succeed is a timer that
   *  will one day be read as evidence the promise is being kept. */
  refund?: (orderId: string, origin: RefundOrigin) => Promise<ServiceRefundOutcome>;
  /** F6 — the writer's forward-ledger instance (bootstrap.ts constructs it
   *  writer-only, so this and POST /api/node/forward's receiver share one).
   *  Absent on a replica and on every single-node deployment ⇒ no sweep armed,
   *  which is correct: neither ever creates the table this prunes. */
  forwardLedger?: ForwardLedger;
  /** NR-67 — which node this process is (node/node-config.ts, read from
   *  `FLOWMIC_NODE_ROLE` at boot).
   *
   *  🔴 REQUIRED, with no default. A default would have to be `'single'`, and
   *  `'single'` is the permissive value: forgetting to wire this would arm every
   *  destructive sweep on a replica and look exactly like today's bug rather
   *  than like a mistake (book 13 §7 F1 ②). There is one production caller, so
   *  「required」 costs one argument and buys a compile error. */
  nodeRole: NodeRole;
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
  /**
   * P2-6 (2026-09-02) — the D11 growth reaper (db/reaper.ts). Built and its
   * test-only `startGrowthReaper` export marked as covered since the card that
   * wrote it, but NEVER CALLED from anywhere production runs: `pc_devices` and
   * `paddle_subscriptions` grew forever in every real deployment, and
   * `reaper.ts`'s own `listStaleOffline` — the read this whole file exists to
   * feed — never had a writer running against it. Runs in BOTH modes, same
   * reasoning as retention above: a standalone local DB accumulates stale rows
   * exactly the same way.
   */
  growthReaper: GrowthReaper;
  /** F6 — the periodic prune for the writer's forward-ledger dedup table.
   *  ⚠️ ABSENT means the same as `serviceRefunds`'s absence: 「there is no such
   *  timer」, never 「skip stopping it」 — a replica or single-node deployment
   *  never had a `forwardLedger` to sweep in the first place. */
  forwardLedgerPrune?: { stop(): void };
  /** Card PR-2 — one timer sweeping BOTH recovery tables. Not optional: both
   *  tables exist on every deployment (they are in INIT_SQL unconditionally), so
   *  there is no state in which there is nothing to sweep. */
  recoveryPrune: { stop(): void };
  /** Card M4-01 — the anonymous site-demo rows. Not optional, for the same
   *  reason `recoveryPrune` is not: the table exists on every deployment. Its
   *  DELETE, unlike its existence, IS conditional — see db/anon-cleanup.ts. */
  anonCleanup: AnonCleanupSweeper;
}

/** The handle a sweep gets on a replica: nothing was scheduled, and the object
 *  says so to anyone who prints it. Never passed to `clearInterval`. */
const NOT_SCHEDULED = Object.freeze({ scheduled: false, reason: 'node role is replica' });

export function startBackgroundSweeps(w: SweepWiring): BackgroundSweeps {
  const { config, db, billing, now } = w;

  // ── NR-67 — THE ONE PLACE THE REPLICA GATE IS DECIDED (see the file header) ─
  // Everything below takes its timer from these two, including the two sweeps
  // that arm a raw interval rather than going through a `startXxxSweeper`.
  const baseSetI = w.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const baseClearI = w.clearIntervalFn
    ?? ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>));
  const armed = w.nodeRole !== 'replica';
  if (!armed) {
    // ONE NAMED LINE AT BOOT, for the same reason the anon sweep logs one line
    // per tick: 「it is not running」 and 「it is running and finding nothing」
    // are indistinguishable in silence, and on this node the first is the
    // correct state. Listed by name rather than counted — an operator reading
    // this is asking about ONE of them.
    log.info('replica: background sweeps not scheduled', {
      node_role: w.nodeRole,
      not_scheduled: ['retention', 'growthReaper', 'recoveryPrune', 'anonCleanup', 'serviceRefunds'],
      reason: 'every sweep here writes, and this node’s database is replaced by the next writer pull',
    });
  }
  // The sweeps read these names; `armed === false` makes every arming below a
  // no-op without any of them knowing, which is exactly the point.
  const setIntervalFn = armed ? baseSetI : ((): unknown => NOT_SCHEDULED);
  const clearIntervalFn = armed ? baseClearI : ((): void => { /* nothing was scheduled */ });

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
    setIntervalFn,
    clearIntervalFn,
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
          setIntervalFn,
          clearIntervalFn,
        });

  // P2-6 — same cadence and mode-agnostic reasoning as retention above; see
  // db/reaper.ts for the age policy and why it lives in its own file rather
  // than folded into retention.ts.
  const growthReaper = startGrowthReaper({
    pcs: db.pcs,
    billing: db.billing,
    ...(now ? { nowMs: now } : {}),
    setIntervalFn,
    clearIntervalFn,
  });

  // F6 — no `startXxxSweeper` factory exists for this one (forward-ledger.ts is
  // node plumbing, not a product table, and deliberately has no such wrapper
  // of its own — see its file header). The timer is armed here instead, on the
  // SAME setIntervalFn/clearIntervalFn override every other sweep in this file
  // takes, so a test driving `sched.tick()` sees this one too.
  // NR-67 — these are the GATED pair from the top of this function, not the raw
  // globals they used to default to: the two timers armed by hand here (this one
  // and the recovery prune below) must sit behind the same gate as the four that
  // go through a factory, or the gate would cover four of six.
  const setI = setIntervalFn;
  const clearI = clearIntervalFn;
  const forwardLedgerPrune = w.forwardLedger
    ? (() => {
        const ledger = w.forwardLedger as ForwardLedger;
        const handle = setI(() => ledger.prune(now?.() ?? Date.now()), FORWARD_LEDGER_PRUNE_INTERVAL_MS);
        return { stop: () => clearI(handle) };
      })()
    : undefined;

  // Card PR-2 — the recovery domain's two tables, swept on the SAME daily cadence
  // and through the SAME overridable timer as everything else in this file. They
  // are wired off `db` rather than off `SweepWiring` because they are product
  // tables on the shared connection, unlike `forwardLedger` above (node plumbing
  // that only exists on a writer). Retention window and the accepted residual —
  // a re-send after expiry is charged again — are argued in db/schema-recovery.ts.
  const recoveryHandle = setI(() => {
    db.recoveryOps.prune(now?.() ?? Date.now());
    db.usageEffects.prune(now?.() ?? Date.now());
  }, RECOVERY_PRUNE_INTERVAL_MS);
  const recoveryPrune = { stop: () => clearI(recoveryHandle) };

  // Card M4-01 — the anonymous-row sweep. Armed UNCONDITIONALLY, in both modes
  // and whether or not the demo is switched on, and only its DELETE is gated:
  // the `apply` flag comes from the env and defaults to a dry run. A sweep that
  // only existed when the feature was on would mean the day the feature is
  // turned OFF is the day its rows stop being cleaned up — which is exactly the
  // day nobody is watching them.
  const anonCleanup = startAnonCleanupSweeper({
    trials: db.trials,
    users: db.users,
    // owner 2026-09-17 — the two archives (the grant record and the meter) and
    // the transaction all three writes share with the delete. Wired
    // UNCONDITIONALLY, like the sweep itself: they are not a second feature
    // behind a second switch, they are what `apply` now means.
    trialArchive: db.trialArchive,
    usageArchive: db.usageArchive,
    tx: db.transact,
    apply: anonCleanupApplyFromEnv(),
    ...(now ? { nowMs: now } : {}),
    setIntervalFn,
    clearIntervalFn,
  });

  return {
    retention, growthReaper, recoveryPrune, anonCleanup,
    ...(serviceRefunds === undefined ? {} : { serviceRefunds }),
    ...(forwardLedgerPrune === undefined ? {} : { forwardLedgerPrune }),
  };
}

/** Assemble [SweepWiring] from what bootstrap already holds, then start.
 *
 *  🔴 IT EXISTS SO `serviceRefunder` IS CALLED ONCE. The call site in
 *  bootstrap.ts built the refunder to test it for `undefined`, threw that
 *  one away, and built a second one to pass along — two clients where the wiring
 *  promises one. Here the value is named, so there is only ever the one.
 *
 *  It also keeps the optional-property spread (`exactOptionalPropertyTypes`)
 *  beside the interface it has to satisfy, which is why this is not a
 *  three-line convenience in the caller.
 */
export function startSweepsForBootstrap(args: {
  config: ServerConfig;
  db: DbConnection;
  billing: BillingService;
  overrides: Pick<SweepWiring, 'now' | 'setIntervalFn' | 'clearIntervalFn'>;
  /** F6 — threaded straight through to `SweepWiring.forwardLedger`. */
  forwardLedger?: ForwardLedger;
  /** NR-67 — threaded straight through to `SweepWiring.nodeRole`. Comes from the
   *  SAME `nodeRuntime.nodeConfig` the caller already reads to decide whether to
   *  build `forwardLedger`, so 「is this a writer」 has one answer in one place. */
  nodeRole: NodeRole;
}): BackgroundSweeps {
  const { config, db, billing, overrides, forwardLedger, nodeRole } = args;
  const now = overrides.now ? { now: overrides.now } : {};
  const refund = serviceRefunder({ config, db, billing, ...now });
  return startBackgroundSweeps({
    config, db, billing, nodeRole,
    ...(refund === undefined ? {} : { refund }),
    ...(forwardLedger ? { forwardLedger } : {}),
    ...now,
    ...(overrides.setIntervalFn ? { setIntervalFn: overrides.setIntervalFn } : {}),
    ...(overrides.clearIntervalFn ? { clearIntervalFn: overrides.clearIntervalFn } : {}),
  });
}
