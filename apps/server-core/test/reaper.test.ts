// D11 — the growth half of the card: `pc_devices` and `paddle_subscriptions`
// both accumulate rows that are provably dead weight, and until src/db/reaper.ts
// nothing ever swept either one.
//
// SPEC-REF: src/db/reaper.ts (the file this pins); src/db/repos/pc.repo.ts
//   `listStaleOffline`/`remove`; src/db/repos/billing.repo.ts
//   `listSupersededSubscriptions`/`removeSubscription`;
//   http/account-lifecycle.ts `USER_RETAINED_TABLES` (billing_events,
//   ops_audit_log — NEITHER is importable from this file, by construction);
//   CLAUDE.md red line: no silent failure / anti-façade
//
// Same discipline as test/retention-cleanup.test.ts (its sibling sweep): a REAL
// in-memory sqlite through the REAL repos, only the ms clock and the interval
// scheduler injected, so age is ADVANCED rather than waited on. Rows are
// deliberately backdated via `db.raw` (the same escape hatch
// test/billing-repo.test.ts and test/account-lifecycle.test.ts already use for
// setup that no repo method exposes a parameter for — `PcRepo.insert` and
// `setOnline` both stamp `created_at`/`last_seen_at` off the real wall clock,
// which a reproducible test cannot depend on).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plan } from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import {
  startGrowthReaper,
  DEFAULT_REAPER_POLICY,
  REAPER_SWEEP_INTERVAL_MS,
  type GrowthReaperDeps,
} from '../src/db/reaper';
import type { PaddleSubRow } from '../src/db/repos/billing.repo';
import { CLOUD_INSTANCE_ID } from '../src/room/registry';
import { log } from '../src/log';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 25, 12, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}
function fakeScheduler(): {
  timers: FakeTimer[];
  setIntervalFn: (fn: () => void, ms: number) => unknown;
  clearIntervalFn: (handle: unknown) => void;
  tick: () => void;
} {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setIntervalFn: (fn, ms): unknown => {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearIntervalFn: (handle): void => {
      (handle as FakeTimer).cleared = true;
    },
    tick: (): void => {
      for (const t of timers) if (!t.cleared) t.fn();
    },
  };
}

let db: DbConnection;

/** Insert a pc_devices row, then stamp the fields no repo method takes a
 *  parameter for (created_at/last_seen_at/is_online), directly, over the SAME
 *  connection the reaper reads. */
function seedPc(
  id: string,
  opts: {
    userId?: string;
    createdAtMs: number;
    lastSeenAtMs?: number | null;
    online?: boolean;
    clientInstanceId?: string | null;
  },
): void {
  db.pcs.insert({
    id,
    user_id: opts.userId ?? 'u1',
    device_name: id,
    device_token: `tok-${id}-${'x'.repeat(32)}`,
    room_uuid: `room-${id}`,
    short_code: '1234',
    client_instance_id: opts.clientInstanceId ?? `inst-${id}`,
  });
  db.raw.prepare('UPDATE pc_devices SET created_at=? WHERE id=?').run(iso(opts.createdAtMs), id);
  db.raw
    .prepare('UPDATE pc_devices SET last_seen_at=?, is_online=? WHERE id=?')
    .run(opts.lastSeenAtMs === null || opts.lastSeenAtMs === undefined ? null : iso(opts.lastSeenAtMs), opts.online ? 1 : 0, id);
}

/** One paddle_subscriptions row via the real repo write path (upsertSubscription
 *  already accepts every timestamp column, so no raw-SQL backdating is needed
 *  here — unlike pc_devices above). */
function seedSub(row: Partial<PaddleSubRow> & { subscription_id: string; user_id: string }): void {
  const base: PaddleSubRow = {
    subscription_id: row.subscription_id,
    user_id: row.user_id,
    customer_id: 'ctm_1',
    status: 'canceled',
    tier: 'pro' as Plan,
    price_id: 'pri_1',
    cycle: 'monthly',
    current_period_end: iso(T0),
    canceled_at: null,
    last_event_id: `evt_${row.subscription_id}`,
    last_occurred_at: iso(T0),
    created_at: iso(T0),
    updated_at: iso(T0),
  };
  db.billing.upsertSubscription({ ...base, ...row });
}

function reaper(deps: Partial<GrowthReaperDeps> = {}, sched = fakeScheduler()): ReturnType<typeof startGrowthReaper> {
  return startGrowthReaper({
    pcs: db.pcs,
    billing: db.billing,
    nowMs: () => T0,
    setIntervalFn: sched.setIntervalFn,
    clearIntervalFn: sched.clearIntervalFn,
    ...deps,
  });
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('reaper-test-secret-32-bytes-long!') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
});
afterEach(() => db.close());

describe('D11 reaper — pc_devices', () => {
  it('offline + unseen past pcStaleDays is swept; a fresher offline row survives', () => {
    seedPc('stale', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    seedPc('fresh', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays - 1) * DAY_MS, online: false });
    const r = reaper();

    const counts = r.runOnce();

    expect(counts.pcDevices).toBe(1);
    expect(db.pcs.findById('stale')).toBeNull();
    expect(db.pcs.findById('fresh')).not.toBeNull();
    r.stop();
  });

  it('a currently-online row is NEVER swept, no matter how ancient created_at is', () => {
    seedPc('ancient-but-online', { createdAtMs: T0 - 5000 * DAY_MS, lastSeenAtMs: T0 - 5000 * DAY_MS, online: true });
    const r = reaper();

    const counts = r.runOnce();

    expect(counts.pcDevices).toBe(0);
    expect(db.pcs.findById('ancient-but-online')).not.toBeNull();
    r.stop();
  });

  it('a row that NEVER connected (last_seen_at NULL) ages out on its OWN created_at', () => {
    seedPc('never-connected-old', { createdAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 30) * DAY_MS, lastSeenAtMs: null, online: false });
    seedPc('never-connected-fresh', { createdAtMs: T0 - 1 * DAY_MS, lastSeenAtMs: null, online: false });
    const r = reaper();

    const counts = r.runOnce();

    expect(counts.pcDevices).toBe(1);
    expect(db.pcs.findById('never-connected-old')).toBeNull();
    expect(db.pcs.findById('never-connected-fresh')).not.toBeNull();
    r.stop();
  });

  it('🔴 the F-3140 virtual cloud-instance row is NEVER swept, even if every other condition matches', () => {
    // Positive control (G13): seed a REAL sweepable row under IDENTICAL
    // staleness conditions, differing ONLY in client_instance_id. A cloud-only
    // negative assertion still passes if listStaleOffline returns [] forever —
    // that hole is exactly what this pair closes.
    const staleMs = T0 - 5000 * DAY_MS;
    seedPc('cloud-row', {
      createdAtMs: staleMs,
      lastSeenAtMs: staleMs,
      online: false,
      clientInstanceId: CLOUD_INSTANCE_ID,
    });
    seedPc('real-stale', {
      createdAtMs: staleMs,
      lastSeenAtMs: staleMs,
      online: false,
      // default client_instance_id = `inst-real-stale` — not the cloud sentinel
    });
    const r = reaper();

    // Identity of candidates, not merely a count: dead sweeper fails here;
    // sweeper that ignores the cloud-instance guard fails on the post-run checks.
    expect(r.peek().pcDevices.map((p) => p.id)).toEqual(['real-stale']);

    const counts = r.runOnce();

    expect(counts.pcDevices).toBe(1);
    expect(db.pcs.findById('real-stale')).toBeNull();
    expect(db.pcs.findById('cloud-row')).not.toBeNull();
    r.stop();
  });

  it('a pre-0.2.4 row with client_instance_id=NULL is still eligible (IS NULL OR != guard)', () => {
    seedPc('legacy-null-instance', {
      createdAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS,
      lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS,
      online: false,
      clientInstanceId: null,
    });
    const r = reaper();

    expect(r.runOnce().pcDevices).toBe(1);
    expect(db.pcs.findById('legacy-null-instance')).toBeNull();
    r.stop();
  });
});

describe('D11 reaper — paddle_subscriptions', () => {
  it('superseded + canceled + old is swept; the CURRENT row (rn=1) is never touched even if ancient', () => {
    // b1 ranks BEHIND b2 for u1 (b2's last_occurred_at is later) — b1 is the
    // superseded row, b2 is what latestForUser(u1) would return.
    seedSub({
      subscription_id: 'sub_old',
      user_id: 'u1',
      canceled_at: iso(T0 - 500 * DAY_MS),
      last_occurred_at: iso(T0 - 500 * DAY_MS),
      updated_at: iso(T0 - (DEFAULT_REAPER_POLICY.subSupersededDays + 1) * DAY_MS),
    });
    seedSub({
      subscription_id: 'sub_current',
      user_id: 'u1',
      canceled_at: null,
      last_occurred_at: iso(T0 - 1 * DAY_MS),
      updated_at: iso(T0 - 1 * DAY_MS),
    });
    expect(db.billing.latestForUser('u1')?.subscription_id).toBe('sub_current');
    const r = reaper();

    const counts = r.runOnce();

    expect(counts.paddleSubscriptions).toBe(1);
    expect(db.billing.getSubscription('sub_old')).toBeNull();
    expect(db.billing.getSubscription('sub_current')).not.toBeNull();
    r.stop();
  });

  it('superseded but NEVER canceled survives (belt-and-braces canceled_at gate)', () => {
    seedSub({
      subscription_id: 'sub_super_uncanceled',
      user_id: 'u1',
      canceled_at: null, // e.g. a plan CHANGE, not a cancellation
      last_occurred_at: iso(T0 - 500 * DAY_MS),
      updated_at: iso(T0 - (DEFAULT_REAPER_POLICY.subSupersededDays + 1) * DAY_MS),
    });
    seedSub({
      subscription_id: 'sub_newer',
      user_id: 'u1',
      canceled_at: null,
      last_occurred_at: iso(T0 - 1 * DAY_MS),
      updated_at: iso(T0 - 1 * DAY_MS),
    });
    const r = reaper();

    expect(r.runOnce().paddleSubscriptions).toBe(0);
    expect(db.billing.getSubscription('sub_super_uncanceled')).not.toBeNull();
    r.stop();
  });

  it('superseded + canceled but NOT old enough survives (age gate, independent of rank)', () => {
    seedSub({
      subscription_id: 'sub_recent_cancel',
      user_id: 'u1',
      canceled_at: iso(T0 - 5 * DAY_MS),
      last_occurred_at: iso(T0 - 5 * DAY_MS),
      updated_at: iso(T0 - 5 * DAY_MS), // well inside subSupersededDays
    });
    seedSub({
      subscription_id: 'sub_newest',
      user_id: 'u1',
      canceled_at: null,
      last_occurred_at: iso(T0 - 1 * DAY_MS),
      updated_at: iso(T0 - 1 * DAY_MS),
    });
    const r = reaper();

    expect(r.runOnce().paddleSubscriptions).toBe(0);
    expect(db.billing.getSubscription('sub_recent_cancel')).not.toBeNull();
    r.stop();
  });

  it('a user with exactly ONE subscription ever (rn=1) is never touched, no matter how old', () => {
    seedSub({
      subscription_id: 'sub_lonely',
      user_id: 'u2',
      canceled_at: iso(T0 - 1000 * DAY_MS),
      last_occurred_at: iso(T0 - 1000 * DAY_MS),
      updated_at: iso(T0 - 1000 * DAY_MS),
    });
    const r = reaper();

    expect(r.runOnce().paddleSubscriptions).toBe(0);
    expect(db.billing.getSubscription('sub_lonely')).not.toBeNull();
    r.stop();
  });

  it('ranking is PER USER — an old superseded row for u1 does not touch u2\'s lone (rn=1) row', () => {
    seedSub({
      subscription_id: 'u1_old',
      user_id: 'u1',
      canceled_at: iso(T0 - 500 * DAY_MS),
      last_occurred_at: iso(T0 - 500 * DAY_MS),
      updated_at: iso(T0 - (DEFAULT_REAPER_POLICY.subSupersededDays + 1) * DAY_MS),
    });
    seedSub({
      subscription_id: 'u1_current',
      user_id: 'u1',
      canceled_at: null,
      last_occurred_at: iso(T0),
      updated_at: iso(T0),
    });
    seedSub({
      subscription_id: 'u2_lonely_old',
      user_id: 'u2',
      canceled_at: iso(T0 - 1000 * DAY_MS),
      last_occurred_at: iso(T0 - 1000 * DAY_MS),
      updated_at: iso(T0 - 1000 * DAY_MS),
    });
    const r = reaper();

    expect(r.runOnce().paddleSubscriptions).toBe(1);
    expect(db.billing.getSubscription('u1_old')).toBeNull();
    expect(db.billing.getSubscription('u2_lonely_old')).not.toBeNull(); // rn=1 for u2
    r.stop();
  });
});

describe('D11 reaper — dry-run, idempotency, per-row isolation, timer wiring', () => {
  it('🔴 dryRun computes the SAME counts as a real run but deletes NOTHING; peek() matches', () => {
    seedPc('stale', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    seedSub({
      subscription_id: 'sub_old',
      user_id: 'u1',
      canceled_at: iso(T0 - 500 * DAY_MS),
      last_occurred_at: iso(T0 - 500 * DAY_MS),
      updated_at: iso(T0 - (DEFAULT_REAPER_POLICY.subSupersededDays + 1) * DAY_MS),
    });
    seedSub({
      subscription_id: 'sub_current',
      user_id: 'u1',
      canceled_at: null,
      last_occurred_at: iso(T0),
      updated_at: iso(T0),
    });
    const r = reaper();

    const peeked = r.peek();
    expect(peeked.pcDevices.map((p) => p.id)).toEqual(['stale']);
    expect(peeked.paddleSubscriptions.map((s) => s.subscription_id)).toEqual(['sub_old']);

    const dry = r.runOnce({ dryRun: true });
    expect(dry).toEqual({ pcDevices: 1, paddleSubscriptions: 1 });

    // NOTHING was actually deleted.
    expect(db.pcs.findById('stale')).not.toBeNull();
    expect(db.billing.getSubscription('sub_old')).not.toBeNull();

    // A REAL run right after reports the identical counts, and NOW deletes.
    const real = r.runOnce();
    expect(real).toEqual({ pcDevices: 1, paddleSubscriptions: 1 });
    expect(db.pcs.findById('stale')).toBeNull();
    expect(db.billing.getSubscription('sub_old')).toBeNull();
    r.stop();
  });

  it('is idempotent: a second consecutive real run deletes 0 and does not throw', () => {
    seedPc('stale', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    const r = reaper();

    expect(r.runOnce()).toEqual({ pcDevices: 1, paddleSubscriptions: 0 });
    expect(r.runOnce()).toEqual({ pcDevices: 0, paddleSubscriptions: 0 });
    r.stop();
  });

  it('one bad row does not abort the sweep for the others (fail-loud, keep going)', () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    seedPc('bad-pc', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    seedPc('good-pc', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    const flakyPcs: GrowthReaperDeps['pcs'] = {
      listStaleOffline: (cutoff, exclude) => db.pcs.listStaleOffline(cutoff, exclude),
      remove(id: string): void {
        if (id === 'bad-pc') throw new Error('row is locked');
        db.pcs.remove(id);
      },
    };
    const r = reaper({ pcs: flakyPcs });

    const counts = r.runOnce();

    expect(counts.pcDevices).toBe(1); // only good-pc counted as removed
    expect(db.pcs.findById('bad-pc')).not.toBeNull(); // the throw left it in place
    expect(db.pcs.findById('good-pc')).toBeNull(); // the other row still went
    expect(errors).toHaveBeenCalledTimes(1);
    const [msg, fields] = errors.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain('failed to remove a stale pc_devices row');
    expect(fields).toMatchObject({ id: 'bad-pc' });
    r.stop();
  });

  it('a sweep that throws entirely is caught, logged, and does not crash — the timer survives it', () => {
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const explodingPcs: GrowthReaperDeps['pcs'] = {
      listStaleOffline(): never {
        throw new Error('disk read failed');
      },
      remove: (id: string) => db.pcs.remove(id),
    };
    const r = reaper({ pcs: explodingPcs });

    expect(() => r.runOnce()).not.toThrow();
    expect(r.runOnce()).toEqual({ pcDevices: 0, paddleSubscriptions: 0 });
    expect(errors).toHaveBeenCalled();
    const [msg] = errors.mock.calls[0] as [string];
    expect(msg).toContain('sweep aborted');
    r.stop();
  });

  it('arms a 24h interval whose tick sweeps, and stop() disarms it for good', () => {
    const sched = fakeScheduler();
    seedPc('stale', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    const r = reaper({}, sched);

    expect(sched.timers).toHaveLength(1);
    expect(sched.timers[0]?.ms).toBe(REAPER_SWEEP_INTERVAL_MS);
    expect(REAPER_SWEEP_INTERVAL_MS).toBe(DAY_MS);

    sched.tick();
    expect(db.pcs.findById('stale')).toBeNull();

    r.stop();
    expect(sched.timers[0]?.cleared).toBe(true);

    // Belt and braces: a tick that raced stop() must be inert.
    seedPc('stale-2', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    sched.timers[0]?.fn();
    expect(db.pcs.findById('stale-2')).not.toBeNull();
  });

  it('no startup sweep: constructing the reaper does not delete anything before the first tick/runOnce', () => {
    seedPc('stale', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    const r = reaper();
    expect(db.pcs.findById('stale')).not.toBeNull();
    r.stop();
  });
});

describe('D11 reaper — the two RETAINED tables are structurally unreachable from this module', () => {
  it('billing_events and ops_audit_log are untouched by a sweep that has candidates in the other two tables', () => {
    db.billing.claimEvent({
      event_id: 'evt_keep',
      notification_id: 'ntf_1',
      event_type: 'subscription.canceled',
      occurred_at: iso(T0 - 1000 * DAY_MS),
      received_at: iso(T0 - 1000 * DAY_MS),
    });
    db.opsAudit.append({ actor_user_id: 'u1', action: 'ops.admin.granted', target_kind: 'route', target_id: 'GET /x' });
    seedPc('stale', { createdAtMs: T0 - 200 * DAY_MS, lastSeenAtMs: T0 - (DEFAULT_REAPER_POLICY.pcStaleDays + 1) * DAY_MS, online: false });
    const r = reaper();

    r.runOnce();

    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM billing_events').get() as { n: number }).n).toBe(1);
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM ops_audit_log').get() as { n: number }).n).toBe(1);
    r.stop();
  });
});
