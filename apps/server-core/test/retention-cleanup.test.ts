// GA-06 — the daily retention sweep (the production DB was write-only).
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §4 (Free 30d / Pro 365d, daily cron);
//           docs/strategy/2026-07-23-relaunch-master-plan.md §2.3;
//           docs/strategy/2026-07-25-full-gap-audit/01-SERVER-PROTOCOL.md GA-06
//
// Everything runs against a REAL in-memory sqlite through the REAL repos — the
// point of this card is what actually leaves the tables. Only two things are
// injected: the ms clock and the interval scheduler, so time is ADVANCED rather
// than waited on (a 24h timer is not a test dependency).
//
// 0.2.27: the sweep's `transcript_history` leg went with the table (owner architecture ruling
// docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md). Every case that used
// to seed a transcript row now seeds a `timeline_blobs` row instead — the SAME
// per-user plan window, over the store this server still has. The properties under
// test are unchanged (per-plan window, clock-driven expiry, idempotency, per-user
// isolation, usage_records never swept, bootstrap wiring).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Plan } from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { startRetentionSweeper, RETENTION_SWEEP_INTERVAL_MS, USAGE_EVENTS_RETENTION_DAYS } from '../src/db/retention';
import { startServer, STANDALONE_USER_ID, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { planLimits } from '../src/billing/plans';
import { BillingService } from '../src/billing/billing-service';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 25, 12, 0, 0); // fixed "now" for every case

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

function seedUser(db: DbConnection, id: string, plan: Plan): void {
  db.users.insert({ id, display_name: id, plan });
  db.pcs.insert({
    id: `pc-${id}`,
    user_id: id,
    device_name: 'PC',
    device_token: `tok-${id}-${'x'.repeat(32)}`,
    room_uuid: `room-${id}`,
    short_code: '1234',
  });
}

/** One e2e:v1: blob for [userId], created at [createdMs]. The repo stamps
 *  created_at as ISO (see timeline.repo), which is what the sweep compares. */
function seedBlob(db: DbConnection, userId: string, id: string, createdMs: number): void {
  db.timeline.push(userId, [
    { id, ciphertext: `e2e:v1:${id}`, created_at: createdMs, schema_ver: 1 },
  ]);
}

/** Present iff [id] is still in [userId]'s blob store. */
function blobAlive(db: DbConnection, userId: string, id: string): boolean {
  return db.timeline.pull(userId, 0, 100).blobs.some((b) => b.id === id);
}

describe('GA-06 retention sweep', () => {
  let db: DbConnection;
  let now = T0;

  beforeEach(() => {
    now = T0;
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('retention-test-secret-32-bytes!!') });
    seedUser(db, 'free-user', 'free');
    seedUser(db, 'pro-user', 'pro');
  });
  afterEach(() => db.close());

  /** bootstrap wires `limitsOf: billing.effectiveLimits`. The cases in THIS block
   *  pin the per-PLAN window, so they hand the sweep the table for the row's tier
   *  directly — the exemption block below goes through a real BillingService,
   *  because `permanent_free` exists on no other path. */
  function sweeper(sched = fakeScheduler()): ReturnType<typeof startRetentionSweeper> {
    return startRetentionSweeper({
      timeline: db.timeline,
      listUserIds: () => db.users.listAll().map((u) => u.id),
      limitsOf: (userId) => planLimits(db.users.findById(userId)?.plan ?? 'free'),
      nowMs: () => now,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
  }

  it('Free = 30d: a blob past the window is hard-deleted, inside it survives', () => {
    seedBlob(db, 'free-user', 'h-old', T0 - 31 * DAY_MS);
    seedBlob(db, 'free-user', 'h-fresh', T0 - 29 * DAY_MS);
    const s = sweeper();

    const counts = s.runOnce();

    expect(counts.blobs).toBe(1);
    expect(blobAlive(db, 'free-user', 'h-old')).toBe(false);
    expect(blobAlive(db, 'free-user', 'h-fresh')).toBe(true);
    s.stop();
  });

  it('Pro = 365d: the SAME 31-day-old row survives, only past 365d goes', () => {
    seedBlob(db, 'pro-user', 'p-31d', T0 - 31 * DAY_MS);
    seedBlob(db, 'pro-user', 'p-366d', T0 - 366 * DAY_MS);
    seedBlob(db, 'free-user', 'f-31d', T0 - 31 * DAY_MS);
    const s = sweeper();

    s.runOnce();

    expect(blobAlive(db, 'pro-user', 'p-31d')).toBe(true); // Pro window
    expect(blobAlive(db, 'pro-user', 'p-366d')).toBe(false);
    expect(blobAlive(db, 'free-user', 'f-31d')).toBe(false); // Free window, same DB, same age
    s.stop();
  });

  it('advancing the clock across the TTL is what expires a row (nothing else changed)', () => {
    seedBlob(db, 'free-user', 'h-1', T0 - 10 * DAY_MS);
    const s = sweeper();

    expect(s.runOnce().blobs).toBe(0);
    expect(blobAlive(db, 'free-user', 'h-1')).toBe(true);

    now = T0 + 25 * DAY_MS; // the row is now 35 days old

    expect(s.runOnce().blobs).toBe(1);
    expect(blobAlive(db, 'free-user', 'h-1')).toBe(false);
    s.stop();
  });

  it('timeline_blobs: live blobs AND tombstones expire on the same TTL', () => {
    db.timeline.push('free-user', [
      { id: 'b-old', ciphertext: 'e2e:v1:old', created_at: T0 - 31 * DAY_MS, schema_ver: 1 },
      { id: 'b-fresh', ciphertext: 'e2e:v1:fresh', created_at: T0 - 1 * DAY_MS, schema_ver: 1 },
      { id: 'b-tomb', ciphertext: 'e2e:v1:tomb', created_at: T0 - 40 * DAY_MS, schema_ver: 1 },
    ]);
    db.timeline.tombstone('free-user', ['b-tomb']);
    const before = db.timeline.pull('free-user', 0, 100).blobs;
    expect(before.find((b) => b.id === 'b-tomb')?.deleted).toBe(true);
    const s = sweeper();

    const counts = s.runOnce();

    expect(counts.blobs).toBe(2); // b-old + the expired tombstone
    const left = db.timeline.pull('free-user', 0, 100).blobs.map((b) => b.id);
    expect(left).toEqual(['b-fresh']);
    s.stop();
  });

  it('usage_records is NEVER swept (monthly metering is not user content)', () => {
    db.usage.increment('free-user', '2025-01', { stt_minutes: 12, llm_tokens_in: 300 });
    seedBlob(db, 'free-user', 'h-old', T0 - 400 * DAY_MS);
    const s = sweeper();

    s.runOnce();

    expect(blobAlive(db, 'free-user', 'h-old')).toBe(false); // the sweep DID run
    const rec = db.usage.get('free-user', '2025-01'); // ...and left a year-old bucket alone
    expect(rec?.stt_minutes).toBe(12);
    expect(rec?.llm_tokens_in).toBe(300);
    s.stop();
  });

  it('is idempotent: the second consecutive sweep deletes 0 and does not throw', () => {
    seedBlob(db, 'free-user', 'b-old-2', T0 - 90 * DAY_MS);
    db.timeline.push('free-user', [{ id: 'b-old', ciphertext: 'e2e:v1:x', created_at: T0 - 90 * DAY_MS, schema_ver: 1 }]);
    const s = sweeper();

    const first = s.runOnce();
    const second = s.runOnce();

    // A2-5 — `usageEvents` joined RetentionCounts. It is always present (0 here:
    // this sweeper has no usageEvents dep) rather than appearing only when the
    // leg ran, so a reader never has to tell "did not sweep" from "swept, nothing expired" by
    // whether a key exists.
    expect(first).toEqual({ blobs: 2, usageEvents: 0, users: 2, siteCounts: 0 });
    expect(second).toEqual({ blobs: 0, usageEvents: 0, users: 2, siteCounts: 0 });
    s.stop();
  });

  it('arms a 24h interval whose tick sweeps, and stop() disarms it for good', () => {
    const sched = fakeScheduler();
    const s = sweeper(sched);
    seedBlob(db, 'free-user', 'h-old', T0 - 60 * DAY_MS);

    expect(sched.timers).toHaveLength(1);
    expect(sched.timers[0]?.ms).toBe(RETENTION_SWEEP_INTERVAL_MS);
    expect(RETENTION_SWEEP_INTERVAL_MS).toBe(DAY_MS);

    sched.tick();
    expect(blobAlive(db, 'free-user', 'h-old')).toBe(false);

    s.stop();
    expect(sched.timers[0]?.cleared).toBe(true);

    // Belt and braces: even a tick that raced stop() must be inert.
    seedBlob(db, 'free-user', 'h-old-2', T0 - 60 * DAY_MS);
    sched.timers[0]?.fn();
    expect(blobAlive(db, 'free-user', 'h-old-2')).toBe(true);
    expect(s.runOnce()).toEqual({ blobs: 0, usageEvents: 0, users: 0, siteCounts: 0 });
  });

  it('one bad user does not abort the sweep for the others (fail-loud, keep going)', () => {
    seedBlob(db, 'free-user', 'h-old', T0 - 60 * DAY_MS);
    const sched = fakeScheduler();
    const s = startRetentionSweeper({
      timeline: db.timeline,
      listUserIds: () => ['boom', 'free-user'],
      limitsOf: (userId) => {
        if (userId === 'boom') throw new Error('limits lookup exploded');
        return planLimits('free' satisfies Plan);
      },
      nowMs: () => now,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });

    const counts = s.runOnce();

    expect(counts.users).toBe(1); // 'boom' logged and skipped
    expect(counts.blobs).toBe(1); // the later user still got swept
    expect(blobAlive(db, 'free-user', 'h-old')).toBe(false);
    s.stop();
  });
});

// ── A2-5 / REQ-12-08 — the usage_events leg (DB-SENSITIVE + billing human-review) ────
//
// The design's §5.4 says this table's retention is the OPPOSITE of
// `usage_records`': one is never swept because the quota reads it, the other
// must be swept because it is a collection surface with a published promise.
// Both rules live in one function, so both are asserted against one sweep.
describe('A2-5 — usage_events is swept at 90 days, and usage_records still is not', () => {
  let db: DbConnection;
  let now = T0;

  beforeEach(() => {
    now = T0;
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('retention-test-secret-32-bytes!!') });
    seedUser(db, 'free-user', 'free');
    seedUser(db, 'pro-user', 'pro');
  });
  afterEach(() => db.close());

  /** Wired exactly as bootstrap wires it, including the usageEvents leg. */
  function sweeper(): ReturnType<typeof startRetentionSweeper> {
    const sched = fakeScheduler();
    return startRetentionSweeper({
      timeline: db.timeline,
      usageEvents: db.usageEvents,
      listUserIds: () => db.users.listAll().map((u) => u.id),
      limitsOf: (userId) => planLimits(db.users.findById(userId)?.plan ?? 'free'),
      nowMs: () => now,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
  }

  /** One event for [userId] at [atMs]. Written through the REAL repo so the
   *  column shapes under test are the ones production writes. */
  function seedEvent(userId: string, atMs: number): number {
    return db.usageEvents.append({ user_id: userId, occurred_at: atMs, kind: 'stt', stt_ms: 1000, outcome: 'ok' });
  }

  function eventIds(userId: string): number[] {
    return db.usageEvents
      .listForUser(userId, { from: 0, to: Number.MAX_SAFE_INTEGER, limit: 500 })
      .rows.map((r) => r.id);
  }

  it('🔴 90 days: an older event goes, a younger one stays — and the window is the SAME for every tier', () => {
    // The tier asymmetry is the point of the second pair: `history_days` is 30
    // for free and 365 for pro, and if this leg had been routed through
    // `limitsOf` the pro row below would survive. It must not: how long we KEEP
    // A RECORD OF a user is not something a subscription buys.
    const freeOld = seedEvent('free-user', T0 - 91 * DAY_MS);
    const freeNew = seedEvent('free-user', T0 - 89 * DAY_MS);
    const proOld = seedEvent('pro-user', T0 - 91 * DAY_MS);
    const proNew = seedEvent('pro-user', T0 - 89 * DAY_MS);
    const s = sweeper();

    const counts = s.runOnce();

    expect(counts.usageEvents).toBe(2);
    expect(eventIds('free-user')).toEqual([freeNew]);
    expect(eventIds('pro-user')).toEqual([proNew]);
    expect(eventIds('free-user')).not.toContain(freeOld);
    expect(eventIds('pro-user')).not.toContain(proOld);
    // The constant is the promise. Asserted here rather than only in the code so
    // a silent change to 400 fails a test that names the number.
    expect(USAGE_EVENTS_RETENTION_DAYS).toBe(90);
    s.stop();
  });

  it('🔴 usage_records is BYTE-IDENTICAL after the sweep, and the sweep provably ran', () => {
    // The exemption that must survive this card: a swept usage row would
    // silently refund quota (db/retention.ts). The negative assertion carries
    // TWO positive controls — an event row that really disappears and a blob
    // that really disappears — so "the month bucket did not change" cannot mean "the sweep never ran".
    db.usage.increment('free-user', '2025-01', { stt_minutes: 12, llm_tokens_in: 300 });
    db.usage.increment('pro-user', '2024-06', { stt_minutes: 7.5, llm_tokens_out: 42 });
    const before = db.raw.prepare('SELECT * FROM usage_records ORDER BY user_id, month').all();

    seedEvent('free-user', T0 - 400 * DAY_MS);
    seedBlob(db, 'free-user', 'h-old', T0 - 400 * DAY_MS);
    const s = sweeper();

    const counts = s.runOnce();

    expect(counts.usageEvents).toBe(1); // positive control ①
    expect(blobAlive(db, 'free-user', 'h-old')).toBe(false); // positive control ②
    // Byte-identical: the whole table, every column, same order.
    expect(db.raw.prepare('SELECT * FROM usage_records ORDER BY user_id, month').all()).toEqual(before);
    s.stop();
  });

  it('the sweep is a NO-OP when nothing is old enough (idempotent, and it does not touch fresh rows)', () => {
    const keep = seedEvent('free-user', T0 - 1 * DAY_MS);
    const s = sweeper();

    expect(s.runOnce().usageEvents).toBe(0);
    expect(s.runOnce().usageEvents).toBe(0);
    expect(eventIds('free-user')).toEqual([keep]);

    // …and advancing the clock across the window is what expires it. Nothing
    // else changed, which is the same shape as the blob case above.
    now = T0 + 91 * DAY_MS;
    expect(s.runOnce().usageEvents).toBe(1);
    expect(eventIds('free-user')).toEqual([]);
    s.stop();
  });

  it('one account whose sweep explodes does not cost a LATER account its usage_events sweep', () => {
    // Per-user isolation, on the new leg. It rides the SAME try/catch as the
    // blob leg (one loop, not two), and this is the assertion that fails if
    // somebody splits it into a second loop that runs before or after.
    seedEvent('free-user', T0 - 100 * DAY_MS);
    const sched = fakeScheduler();
    const s = startRetentionSweeper({
      timeline: db.timeline,
      usageEvents: db.usageEvents,
      listUserIds: () => ['boom', 'free-user'],
      limitsOf: (userId) => {
        if (userId === 'boom') throw new Error('limits lookup exploded');
        return planLimits('free' satisfies Plan);
      },
      nowMs: () => now,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });

    const counts = s.runOnce();

    expect(counts.users).toBe(1);
    expect(counts.usageEvents).toBe(1);
    expect(eventIds('free-user')).toEqual([]);
    s.stop();
  });

  it('a sweeper with NO usageEvents dep deletes nothing and says so (0, not a missing key)', () => {
    // The optional dep's honest degradation: absent ⇒ no deletion, and the count
    // is a real 0 rather than an absent field. Bootstrap always wires it —
    // test/usage-events.test.ts asserts that from the source tree — so this is
    // the harness case, pinned so nobody "simplifies" the field away.
    seedEvent('free-user', T0 - 400 * DAY_MS);
    const sched = fakeScheduler();
    const s = startRetentionSweeper({
      timeline: db.timeline,
      listUserIds: () => db.users.listAll().map((u) => u.id),
      limitsOf: () => planLimits('free' satisfies Plan),
      nowMs: () => now,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });

    expect(s.runOnce().usageEvents).toBe(0);
    expect(eventIds('free-user')).toHaveLength(1);
    s.stop();
  });
});

// 🔴 0.2.38 — the THIRD "look up by plan tier" site, and the only one that deletes data.
//
// D1 §6.1-bis named two consumers to move off `planOf` (quota-guard, room/registry)
// and missed this one. `permanent_free` resolves to `plan:'free'` on purpose (owner
// bought nothing), so a sweep that re-derived the window from that tier put owner's
// own cloud blobs on FREE's 30 days and hard-deleted them. The other two sites
// refuse an action; this one is irreversible.
//
// Everything below goes through a REAL BillingService, wired exactly as bootstrap
// wires it. Reading `effectiveLimits` back directly would only prove the exemption
// table exists — the question is whether the SWEEP consults it (book 13 §7 F1 ③).
describe('D1 §6.1-bis — a permanent_free account is not swept on the FREE window', () => {
  let db: DbConnection;
  const now = T0;

  beforeEach(() => {
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('retention-test-secret-32-bytes!!') });
    seedUser(db, 'exempt-user', 'free'); // 🔴 users.plan STAYS 'free' — the exemption is a separate column
    seedUser(db, 'plain-free-user', 'free');
    db.users.setPermanentFree('exempt-user', true);
  });
  afterEach(() => db.close());

  function realSweeper(): ReturnType<typeof startRetentionSweeper> {
    const billing = new BillingService({
      settings: db.settings,
      users: db.users,
      usage: db.usage,
      billing: db.billing,
      unlockAll: false,
      now: () => now,
    });
    const sched = fakeScheduler();
    return startRetentionSweeper({
      timeline: db.timeline,
      listUserIds: () => db.users.listAll().map((u) => u.id),
      limitsOf: (userId) => billing.effectiveLimits(userId), // ← bootstrap's exact lambda
      nowMs: () => now,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
  }

  it('🔴 keeps a 200-day-old blob, and the positive control loses the SAME row', () => {
    // 200 days: past free's 30-day window, inside the exemption's 365. One sweep,
    // one DB, two accounts, identical rows — so "was not deleted" can only mean "because of the exemption"
    // and not "because the sweep never ran" (CLAUDE.md: a negative assertion must carry its own positive control).
    seedBlob(db, 'exempt-user', 'x-200d', T0 - 200 * DAY_MS);
    seedBlob(db, 'plain-free-user', 'f-200d', T0 - 200 * DAY_MS);
    const s = realSweeper();

    const counts = s.runOnce();

    expect(blobAlive(db, 'exempt-user', 'x-200d')).toBe(true);
    expect(blobAlive(db, 'plain-free-user', 'f-200d')).toBe(false); // the sweep DID run
    expect(counts.blobs).toBe(1);
    s.stop();
  });

  it('the exemption is 365 days, NOT forever — a 400-day-old blob still goes', () => {
    // Written down because it is the tempting misreading: EXEMPT_LIMITS lifts
    // STT/LLM/devices to Infinity but pins history_days at 365 on purpose —
    // `now - Infinity*86400e3` is NaN, and a NaN cutoff compares false against
    // every row, which would SILENTLY DISABLE the sweep instead of extending it.
    // 365 is the largest window any paid tier grants.
    seedBlob(db, 'exempt-user', 'x-400d', T0 - 400 * DAY_MS);
    seedBlob(db, 'exempt-user', 'x-364d', T0 - 364 * DAY_MS);
    const s = realSweeper();

    s.runOnce();

    expect(blobAlive(db, 'exempt-user', 'x-400d')).toBe(false);
    expect(blobAlive(db, 'exempt-user', 'x-364d')).toBe(true);
    s.stop();
  });
});

describe('GA-06 bootstrap wiring', () => {
  let server: BootstrapHandle | null = null;
  const sched = fakeScheduler();

  afterEach(async () => {
    // close() is called by the test itself (that IS the assertion); this only
    // catches a mid-test failure so the port/db never leak into the next file.
    if (server) {
      await server.close().catch(() => undefined);
      server = null;
    }
  });

  it('bootstrap arms the sweep and close() clears it', async () => {
    const config = loadConfig({ port: 0, dbPath: ':memory:', secret: 'retention-boot-secret-32-bytes-long' });
    const boot = await startServer(config, {
      now: () => T0,
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
    server = boot;

    // The interval is the sweep's, at the daily cadence, and boot did NOT sweep.
    expect(sched.timers).toHaveLength(1);
    expect(sched.timers[0]?.ms).toBe(RETENTION_SWEEP_INTERVAL_MS);

    boot.db.pcs.insert({
      id: `pc-${STANDALONE_USER_ID}`,
      user_id: STANDALONE_USER_ID,
      device_name: 'PC',
      device_token: `tok-boot-${'x'.repeat(32)}`,
      room_uuid: 'room-boot',
      short_code: '4321',
    });
    seedBlob(boot.db, STANDALONE_USER_ID, 'boot-old', T0 - 45 * DAY_MS);
    seedBlob(boot.db, STANDALONE_USER_ID, 'boot-fresh', T0 - 5 * DAY_MS);

    sched.tick();

    expect(blobAlive(boot.db, STANDALONE_USER_ID, 'boot-old')).toBe(false);
    expect(blobAlive(boot.db, STANDALONE_USER_ID, 'boot-fresh')).toBe(true);

    server = null; // close() below is the assertion; skip the afterEach safety net
    await boot.close();
    expect(sched.timers[0]?.cleared).toBe(true);
  });
});
