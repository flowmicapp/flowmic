// SPEC-REF:
//   apps/server-core/src/billing/service-deadlines.ts (`refundDueReason` — the
//     one verdict this and the operator queue both act on)
//   apps/server-core/src/billing/service-refund.ts (the one action)
//   apps/server-core/src/db/reaper.ts (the timer shape this is modelled on,
//     including unref, per-row isolation and the never-throwing tick)
//   owner ruling 2026-08-30: 「默认到期由运营队列中由人按一下，但要实现自动退的
//     功能和开关，只是默认由人来点」
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// THE DEADLINE SWEEP: refunding, unattended, what we promised to refund.
//
// ── 🔴 IT IS OFF BY DEFAULT, AND THAT IS THE RULING, NOT A PRECAUTION ──────
//
// owner's instruction has two halves and they pull in opposite directions on
// purpose: BUILD the automatic refund, and let a HUMAN press it by default. The
// operator queue is the default path; this is the capability that makes the
// promise keepable when nobody is at the desk, and the switch is what keeps the
// person in the loop until somebody decides otherwise.
//
// ⚠️ A CAPABILITY THAT IS SWITCHED OFF IS NOT A FAÇADE, BUT IT IS ONE FAILED
// ASSUMPTION AWAY FROM ONE. Code nobody runs rots silently — this repo has paid
// that bill more than once. So: `runOnce()` is exported and driven directly by
// tests against a real database, the switch gates only the TIMER, and the same
// `requestServiceRefund` the two buttons call is the only thing that moves
// money here. There is no second refund path to drift.
//
// ── 🔴 WHY IT REFUNDS RATHER THAN QUEUES ──────────────────────────────────
//
// A sweep that merely flagged rows would be a second copy of `refund_due`, which
// the queue already computes on every read. The only thing this can add that the
// queue cannot is the ACTION — and the action is exactly the part that must not
// be duplicated. Everything it decides comes from `refundDueReason`; everything
// it does comes from `requestServiceRefund`.
//
// ── ⚠️ WHAT IT DELIBERATELY CANNOT DO ─────────────────────────────────────
//
// · It cannot write 'refunded'. Only the provider's webhook does.
// · It cannot touch a scheduled, in_progress, delivered, refund_requested or
//   refunded purchase — `refundDueReason` returns null for all five, so a row
//   somebody already acted on is never picked up twice, and a setup that has
//   been BOOKED or BEGUN is never refunded by a clock (owner 2026-08-30: the
//   only deadline is the 14 days to start).
// · It cannot refund a purchase whose deadline has not passed. There is no
//   「catch up」 mode and no operator override on this path: the buttons exist
//   for that, with an audit row and a named human behind each.
// · It writes no `ops_audit_log` row, and that absence is argued below.

import type { OneTimePurchaseRepo, OneTimePurchaseRow } from '../db/repos/one-time-purchase.repo';
import type { DeadlinePolicy, RefundDueReason } from './service-deadlines';
import { refundDueReason } from './service-deadlines';
import type { RefundOrigin, ServiceRefundOutcome } from './service-refund';
import { log } from '../log';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Sweep cadence.
 *
 * ⚠️ HOURLY, NOT DAILY LIKE ITS TWO SIBLINGS, and the difference is worth one
 * sentence: retention and the growth reaper delete rows whose age is measured in
 * months, so a day of slack is invisible. This one keeps a promise with a named
 * date in a consumer contract, and a purchase that came due at 00:05 should not
 * be refunded 23 hours late because the tick landed elsewhere. It is still far
 * coarser than the deadline it enforces, so the cost of a missed tick is bounded
 * and small.
 */
export const SERVICE_SWEEP_INTERVAL_MS = HOUR_MS;

/**
 * How many purchases one tick will refund.
 *
 * 🔴 A CAP ON AN UNATTENDED MONEY MOVER, and it is not defensive decoration.
 * The one failure this cannot recover from is refunding a batch it should not
 * have — a clock skewed by a container, a policy typo of `14` for `1` — and the
 * difference between that costing twenty refunds and costing every open purchase
 * is this number. Hitting it is LOGGED at warn, because a sweep that quietly
 * stopped halfway is indistinguishable from one that had nothing left to do.
 */
export const SERVICE_SWEEP_MAX_PER_TICK = 20;

export interface ServiceSweepCounts {
  /** Rows the verdict said were due. */
  due: number;
  /** Rows we successfully ASKED the provider to refund. Never 「refunded」. */
  requested: number;
  /** Rows that were due and could not be asked for. Each one is logged. */
  failed: number;
  /** Rows left untouched because the per-tick cap was hit. */
  deferred: number;
}

export interface ServiceSweepDeps {
  /** 🔴 A ONE-METHOD SLICE. This sweep reads a list and calls the shared refund
   *  action; it must not be able to advance a purchase or record one. */
  purchases: Pick<OneTimePurchaseRepo, 'listAllOneTimePurchases'>;
  /** THE SAME function the customer's withdraw button and the operator's refund
   *  button call. A second construction would be a second place for the
   *  claim-then-call order to drift, on the one path with no human watching. */
  refund: (orderId: string, origin: RefundOrigin) => Promise<ServiceRefundOutcome>;
  policy: DeadlinePolicy;
  /**
   * 🔴 THE SWITCH. `false` (the default at every call site) arms NO timer at all
   * — not a timer that ticks and does nothing, which would look identical in a
   * log and behave differently after one careless edit.
   */
  enabled: boolean;
  /** How many rows to consider per tick. The list read is the operator queue's
   *  own cross-account read, capped the same way. */
  scanLimit?: number;
  nowMs?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface ServiceSweeper {
  /**
   * Run one sweep.
   *
   * 🔴 IT RUNS EVEN WHEN THE SWITCH IS OFF, and that is deliberate: the switch
   * governs whether a TIMER calls this, not whether the code works. A test, and
   * a future operator button, drive it directly — which is what stops an
   * unarmed capability from rotting into one that no longer functions.
   *
   * Never throws. A tick that died would take the interval with it.
   */
  runOnce(): Promise<ServiceSweepCounts>;
  /** The rows a run would act on right now, without acting. Read-only. */
  peek(): { row: OneTimePurchaseRow; reason: RefundDueReason }[];
  /** Disarm. MUST be called before the DB closes. Idempotent. */
  stop(): void;
}

/** The origin recorded for the deadline, so a sweep refund is distinguishable
 *  forever afterwards from a button press in the provider's dashboard and in
 *  our own logs. A table rather than a constant so that a second deadline, if
 *  owner ever restores one, has to be given its own origin here — and so the
 *  compiler, not a reader, notices a `RefundDueReason` this does not name. */
const ORIGIN_FOR: Readonly<Record<RefundDueReason, RefundOrigin>> = {
  no_start: 'deadline_no_start',
};
function originFor(reason: RefundDueReason): RefundOrigin {
  return ORIGIN_FOR[reason];
}

function zero(): ServiceSweepCounts {
  return { due: 0, requested: 0, failed: 0, deferred: 0 };
}

/**
 * Arm (or deliberately do not arm) the deadline refund sweep.
 *
 * NOTE — no sweep at boot, same reasoning as its two siblings: a cold start must
 * reach `listen()` immediately, and this one dials a payment provider. A boot
 * that spent its first second refunding twenty people would be a boot that could
 * fail halfway through doing so.
 */
export function startServiceRefundSweeper(deps: ServiceSweepDeps): ServiceSweeper {
  const now = deps.nowMs ?? Date.now;
  const setI = deps.setIntervalFn ?? ((fn, ms): unknown => setInterval(fn, ms));
  const clearI = deps.clearIntervalFn ?? ((h): void => clearInterval(h as ReturnType<typeof setInterval>));
  const scanLimit = deps.scanLimit ?? 200;
  let stopped = false;
  // ⚠️ A GUARD AGAINST OVERLAPPING TICKS, not a lock. Each refund is an await on
  // a payment provider; an hourly timer whose previous tick is still dialling
  // would put two callers on the same rows. The claim SQL would still make a
  // double refund impossible — this only stops us asking twice and reading a
  // confusing answer.
  let running = false;

  function peek(): { row: OneTimePurchaseRow; reason: RefundDueReason }[] {
    const at = now();
    const out: { row: OneTimePurchaseRow; reason: RefundDueReason }[] = [];
    for (const row of deps.purchases.listAllOneTimePurchases(scanLimit)) {
      const reason = refundDueReason(row, at, deps.policy);
      if (reason !== null) out.push({ row, reason });
    }
    return out;
  }

  async function runOnce(): Promise<ServiceSweepCounts> {
    if (stopped) return zero(); // a tick that raced stop() must be inert
    if (running) {
      log.warn('service sweep: skipped a tick, the previous one is still running');
      return zero();
    }
    running = true;
    const counts = zero();
    try {
      const due = peek();
      counts.due = due.length;
      for (const { row, reason } of due) {
        if (counts.requested + counts.failed >= SERVICE_SWEEP_MAX_PER_TICK) {
          counts.deferred += 1;
          continue;
        }
        try {
          const outcome = await deps.refund(row.order_id, originFor(reason));
          if (outcome.ok) {
            counts.requested += 1;
            // 🔴 `warn`, NOT `info`. An automatic refund is money leaving on
            // nobody's authority but a clock's, and it must be findable in a log
            // full of INFO. It is also the only record of this action: unlike
            // the two buttons there is no `ops_audit_log` row, because that
            // table's `actor_user_id` is NOT NULL and its stated meaning is 「the
            // users.id already PROVEN by the Bearer」. Inventing an actor for a
            // timer would put a fictional person in an audit trail — the precise
            // thing that column exists to prevent. The purchase row itself
            // carries `refund_requested_at` and the provider's id, which is the
            // durable record; this line is how somebody finds it.
            log.warn('service sweep: a deadline refund was requested automatically', {
              order_id: row.order_id,
              reason,
              provider_status: outcome.providerStatus,
              actor: 'sweep',
            });
          } else {
            counts.failed += 1;
            log.error('service sweep: a due refund could not be requested', {
              order_id: row.order_id,
              reason,
              outcome: outcome.reason,
              // Says what a reader has to do about it. `not_refundable` here is
              // usually benign (somebody pressed the button first, between the
              // read and the call); the other two are not.
              remedy:
                outcome.reason === 'not_refundable'
                  ? 'no action: the row was acted on between this scan and this call'
                  : 'no money moved; this purchase needs a human in the operator queue',
            });
          }
        } catch (err) {
          // Per-row isolation, same discipline as the reaper's: one row that
          // throws must not cost every other due row its refund, and must not be
          // swallowed either.
          counts.failed += 1;
          log.error('service sweep: a due refund threw', {
            order_id: row.order_id,
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (counts.deferred > 0) {
        log.warn('service sweep: hit the per-tick cap and left purchases for the next tick', {
          cap: SERVICE_SWEEP_MAX_PER_TICK,
          ...counts,
        });
      } else if (counts.due > 0) {
        log.info('service sweep: finished', { ...counts });
      }
      return counts;
    } catch (err) {
      // fail-loud, never silent — but a failed sweep must NOT kill the timer.
      log.error('service sweep: aborted', {
        error: err instanceof Error ? err.message : String(err),
      });
      return counts;
    } finally {
      running = false;
    }
  }

  if (!deps.enabled) {
    // 🔴 SAID OUT LOUD, ONCE, AT COMPOSITION TIME, and it names both halves: what
    // is off, and what therefore still has to happen by hand. An operator who
    // reads only 「disabled」 does not learn that the promise is now theirs to
    // keep. Same placement argument as mail/index.ts's unconfigured line.
    log.info(
      'service sweep: automatic deadline refunds are OFF (the default) — a purchase past its 14-day ' +
        'start deadline is flagged in the operator queue and refunded when a human presses it; there ' +
        'is no other deadline. Set FLOWMIC_CREEM_AUTO_REFUND_ENABLED=1 to let this run unattended.',
    );
    return {
      runOnce,
      peek,
      stop(): void {
        stopped = true;
      },
    };
  }

  log.warn(
    'service sweep: automatic deadline refunds are ON — this process will refund overdue purchases ' +
      'with no human in the loop.',
    { interval_ms: SERVICE_SWEEP_INTERVAL_MS, max_per_tick: SERVICE_SWEEP_MAX_PER_TICK },
  );
  const handle = setI(() => void runOnce(), SERVICE_SWEEP_INTERVAL_MS);
  // A timer must never be the reason a process (or a vitest worker) refuses to
  // exit. Real Node timers unref; an injected fake need not implement it.
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
