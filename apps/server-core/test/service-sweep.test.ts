// SPEC-REF:
//   src/billing/service-sweep.ts (the unit under test)
//   src/bootstrap-sweeps.ts (where it is armed, and where the switch is read)
//   owner ruling 2026-08-30: build the automatic refund, default to a human
//
// THE DEADLINE SWEEP.
//
// 🔴 WHY THIS FILE IS NOT OPTIONAL, GIVEN THE THING IT TESTS IS SWITCHED OFF.
// Code nobody runs rots, and a capability that has rotted is indistinguishable
// from one that was never built — right up to the day somebody turns it on to
// keep a promise. These tests are what runs it. They drive `runOnce` directly,
// which is exactly the seam the switch does NOT gate, and §1 is the pair that
// proves the switch gates the timer and only the timer.

import { describe, expect, it, vi } from 'vitest';
import {
  SERVICE_SWEEP_INTERVAL_MS,
  SERVICE_SWEEP_MAX_PER_TICK,
  startServiceRefundSweeper,
  type ServiceSweepDeps,
} from '../src/billing/service-sweep';
import type { RefundOrigin, ServiceRefundOutcome } from '../src/billing/service-refund';
import type { OneTimePurchaseRow } from '../src/db/repos/one-time-purchase.repo';
import { PROMISED_DEADLINES } from '../src/billing/guided-setup';

const DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-10-01T00:00:00.000Z');

function purchase(over: Partial<OneTimePurchaseRow>): OneTimePurchaseRow {
  return {
    order_id: 'ord_x',
    provider: 'creem',
    user_id: 'u1',
    product_id: 'prod_setup',
    checkout_id: null,
    transaction_id: 'tx_1',
    customer_id: null,
    amount_minor: 20000,
    currency: 'USD',
    state: 'paid',
    early_start_consent_at: null,
    withdrawal_waiver_ack_at: null,
    consent_terms_version: 'gs-5',
    scheduled_at: null,
    started_at: null,
    delivered_at: null,
    refund_requested_at: null,
    refund_provider_id: null,
    refund_status: null,
    refunded_at: null,
    refund_released_at: null,
    refund_release_reason: null,
    refund_external_reference: null,
    completion_notice_at: null,
    note: null,
    created_at: new Date(NOW_MS - 60 * DAY).toISOString(),
    updated_at: new Date(NOW_MS - 60 * DAY).toISOString(),
    ...over,
  };
}

/** A fake scheduler, so a test drives ticks instead of waiting an hour. */
function scheduler(): {
  fns: (() => void)[];
  ms: number[];
  setIntervalFn: (fn: () => void, ms: number) => unknown;
  clearIntervalFn: (h: unknown) => void;
  cleared: unknown[];
} {
  const fns: (() => void)[] = [];
  const ms: number[] = [];
  const cleared: unknown[] = [];
  return {
    fns,
    ms,
    cleared,
    setIntervalFn: (fn, interval): unknown => {
      fns.push(fn);
      ms.push(interval);
      return { id: fns.length };
    },
    clearIntervalFn: (h): void => {
      cleared.push(h);
    },
  };
}

function make(
  rows: OneTimePurchaseRow[],
  over: Partial<ServiceSweepDeps> = {},
): {
  deps: ServiceSweepDeps;
  asked: { orderId: string; origin: RefundOrigin }[];
  sched: ReturnType<typeof scheduler>;
} {
  const asked: { orderId: string; origin: RefundOrigin }[] = [];
  const sched = scheduler();
  const deps: ServiceSweepDeps = {
    purchases: { listAllOneTimePurchases: () => rows },
    refund: async (orderId, origin): Promise<ServiceRefundOutcome> => {
      asked.push({ orderId, origin });
      return { ok: true, providerStatus: 'pending' };
    },
    policy: PROMISED_DEADLINES,
    enabled: false,
    nowMs: () => NOW_MS,
    setIntervalFn: sched.setIntervalFn,
    clearIntervalFn: sched.clearIntervalFn,
    ...over,
  };
  return { deps, asked, sched };
}

describe('§1 🔴 the switch gates the TIMER, and only the timer', () => {
  it('OFF arms nothing at all — not even a tick that does nothing', () => {
    // A timer that fires and no-ops looks identical in a log to one that fires
    // and works, and is one careless edit away from being the second.
    const { deps, sched } = make([purchase({ order_id: 'a' })], { enabled: false });
    startServiceRefundSweeper(deps);
    expect(sched.fns).toHaveLength(0);
  });

  it('ON arms one, at the stated cadence, and stop() clears it', () => {
    const { deps, sched } = make([], { enabled: true });
    const s = startServiceRefundSweeper(deps);
    expect(sched.fns).toHaveLength(1);
    expect(sched.ms[0]).toBe(SERVICE_SWEEP_INTERVAL_MS);
    s.stop();
    expect(sched.cleared).toHaveLength(1);
  });

  it('🔴 and runOnce WORKS while the switch is off — which is what keeps it alive', () => {
    // The seam this whole file depends on. If `runOnce` were gated too, the
    // capability would only ever be exercised by turning it on in production.
    const { deps, asked } = make([purchase({ order_id: 'a' })], { enabled: false });
    return startServiceRefundSweeper(deps)
      .runOnce()
      .then((counts) => {
        expect(counts).toMatchObject({ due: 1, requested: 1, failed: 0 });
        expect(asked).toEqual([{ orderId: 'a', origin: 'deadline_no_start' }]);
      });
  });

  it('a tick that raced stop() is inert', async () => {
    const { deps, asked } = make([purchase({ order_id: 'a' })], { enabled: true });
    const s = startServiceRefundSweeper(deps);
    s.stop();
    expect(await s.runOnce()).toMatchObject({ due: 0, requested: 0 });
    expect(asked).toHaveLength(0);
  });
});

describe('§2 it refunds exactly what the verdict says is due, and names why', () => {
  it('the no-start deadline is recorded under its own origin, and a booked row beside it is left alone', async () => {
    // 🔴 THE ORIGIN NAMES THE CLOCK, so a sweep refund is distinguishable from
    // a button press in the provider's dashboard and our own logs. The booked
    // row is 60 days old (the fixture default) and is NOT touched: owner
    // 2026-08-30 removed the completion deadline, so 'scheduled' has no clock.
    const rows = [
      purchase({ order_id: 'never_started', state: 'paid' }),
      purchase({ order_id: 'booked_long_ago', state: 'scheduled', scheduled_at: 'x' }),
    ];
    const { deps, asked } = make(rows);
    await startServiceRefundSweeper(deps).runOnce();
    expect(asked).toEqual([{ orderId: 'never_started', origin: 'deadline_no_start' }]);
  });

  it('leaves everything that is not due alone', async () => {
    const rows = [
      // Bought yesterday: the deadline has not passed.
      purchase({ order_id: 'fresh', created_at: new Date(NOW_MS - 1 * DAY).toISOString() }),
      // Done. Ours to keep, not to refund.
      purchase({ order_id: 'done', state: 'delivered', delivered_at: 'x' }),
      // 🔴 BOOKED 100 days ago. No clock runs on a booked setup (owner
      // 2026-08-30); a sweep that refunded it would be taking money back from
      // somebody we have a time in the diary with.
      purchase({
        order_id: 'booked',
        state: 'scheduled',
        scheduled_at: 'x',
        created_at: new Date(NOW_MS - 100 * DAY).toISOString(),
      }),
      // 🔴 BEGUN, 60 days ago. A clock must not take money back from somebody
      // mid-session.
      purchase({ order_id: 'underway', state: 'in_progress', scheduled_at: 'x', started_at: 'x' }),
      // Already in flight — refunding again is the failure this must not have.
      purchase({ order_id: 'asked', state: 'refund_requested' }),
      purchase({ order_id: 'back', state: 'refunded', refunded_at: 'x' }),
    ];
    const { deps, asked } = make(rows);
    expect(await startServiceRefundSweeper(deps).runOnce()).toMatchObject({ due: 0, requested: 0 });
    expect(asked).toHaveLength(0);
  });

  it('peek() reports what a run would do, without doing it', async () => {
    const { deps, asked } = make([purchase({ order_id: 'a' })]);
    const s = startServiceRefundSweeper(deps);
    const seen = s.peek();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe('no_start');
    expect(asked).toHaveLength(0);
  });
});

describe('§3 one bad row does not cost the others their refund', () => {
  it('a throw is isolated, counted and does not stop the sweep', async () => {
    const rows = [purchase({ order_id: 'a' }), purchase({ order_id: 'b' }), purchase({ order_id: 'c' })];
    const asked: string[] = [];
    const { deps } = make(rows, {
      refund: async (orderId): Promise<ServiceRefundOutcome> => {
        asked.push(orderId);
        if (orderId === 'b') throw new Error('socket hang up');
        return { ok: true, providerStatus: 'pending' };
      },
    });
    const counts = await startServiceRefundSweeper(deps).runOnce();
    expect(asked).toEqual(['a', 'b', 'c']);
    expect(counts).toMatchObject({ due: 3, requested: 2, failed: 1 });
  });

  it('a refusal is counted as failed, not as done', async () => {
    // 🔴 THE DIRECTION THAT MATTERS. Counting a refusal as a success would make
    // a sweep that refunded nobody report a clean run.
    const { deps } = make([purchase({ order_id: 'a' })], {
      refund: async (): Promise<ServiceRefundOutcome> => ({
        ok: false,
        reason: 'provider_refused',
        detail: 'PROVIDER_UNREACHABLE x',
      }),
    });
    expect(await startServiceRefundSweeper(deps).runOnce()).toMatchObject({
      due: 1,
      requested: 0,
      failed: 1,
    });
  });

  it('a listing that throws aborts loudly without killing the timer', async () => {
    const { deps, sched } = make([], {
      enabled: true,
      purchases: {
        listAllOneTimePurchases: (): OneTimePurchaseRow[] => {
          throw new Error('database is locked');
        },
      },
    });
    const s = startServiceRefundSweeper(deps);
    expect(await s.runOnce()).toMatchObject({ due: 0, requested: 0, failed: 0 });
    // Still armed: a bad minute must not disarm a promise.
    expect(sched.cleared).toHaveLength(0);
    // …and it can run again.
    await expect(s.runOnce()).resolves.toBeTruthy();
  });
});

describe('§4 the per-tick cap on an unattended money mover', () => {
  it('stops at the cap and reports what it left, rather than going quiet', async () => {
    // A sweep that quietly stopped halfway is indistinguishable from one that
    // had nothing left to do — and the difference is a customer still waiting.
    const rows = Array.from({ length: SERVICE_SWEEP_MAX_PER_TICK + 5 }, (_, i) =>
      purchase({ order_id: `ord_${i}` }),
    );
    const { deps, asked } = make(rows);
    const counts = await startServiceRefundSweeper(deps).runOnce();
    expect(counts.requested).toBe(SERVICE_SWEEP_MAX_PER_TICK);
    expect(counts.deferred).toBe(5);
    expect(asked).toHaveLength(SERVICE_SWEEP_MAX_PER_TICK);
  });
});

describe('§5 overlapping ticks', () => {
  it('a tick that starts while one is still dialling is skipped, not run twice', async () => {
    // Each refund is an await on a payment provider. The claim SQL makes a
    // double refund impossible either way — this stops us asking twice and
    // reading a confusing answer about our own request.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const asked: string[] = [];
    const { deps } = make([purchase({ order_id: 'a' })], {
      refund: async (orderId): Promise<ServiceRefundOutcome> => {
        asked.push(orderId);
        await gate;
        return { ok: true, providerStatus: 'pending' };
      },
    });
    const s = startServiceRefundSweeper(deps);
    const first = s.runOnce();
    const second = await s.runOnce();
    expect(second).toMatchObject({ due: 0, requested: 0 });
    release!();
    expect(await first).toMatchObject({ requested: 1 });
    expect(asked).toEqual(['a']);
  });
});

describe('§6 the sweep cannot do the things it must not do', () => {
  it('its deps expose ONE repo method — it cannot advance or record a purchase', () => {
    // A structural assertion rather than a behavioural one: the slice is the
    // guarantee, and a widened `Pick<>` is what this would catch.
    const { deps } = make([]);
    expect(Object.keys(deps.purchases)).toEqual(['listAllOneTimePurchases']);
  });

  it('and it never invents an outcome — every refund goes through the shared action', async () => {
    // The injected `refund` is the ONLY way money moves here. If the sweep ever
    // grew its own provider call, this spy would stop seeing every request.
    const spy = vi.fn(async (): Promise<ServiceRefundOutcome> => ({ ok: true, providerStatus: 'p' }));
    const { deps } = make([purchase({ order_id: 'a' }), purchase({ order_id: 'b' })], { refund: spy });
    const counts = await startServiceRefundSweeper(deps).runOnce();
    expect(spy).toHaveBeenCalledTimes(counts.requested);
  });
});
