// 2026-09-02 (audit F8) — do the STT-quota check and the STT-usage meter agree
// on WHICH MONTH a minute belongs to?
//
// SPEC-REF: src/billing/quota-guard.ts (`budget`, the read)
//           src/billing/usage-tracker.ts (`recordSttUsage`, the write)
//           src/db/repos/usage.repo.ts `currentMonth` (the bucket key both use)
//
// ── WHAT THE AUDIT FLAGGED, AND WHAT WAS ACTUALLY THERE ─────────────────────
// The finding named two old line numbers ("quota-guard.ts:73 vs usage-
// tracker.ts:423") as a SUSPECTED cross-month bucket mismatch: read the wrong
// month's row and a quota check either refuses someone who has not spent
// anything this month, or lets someone through who already has. Reading BOTH
// files at HEAD: they already import the exact same `currentMonth` function
// from the exact same module and apply it to a `clock` derived the exact same
// way (`config.now ?? Date.now`) — there is no second definition left to
// diverge. This file exists to PIN that agreement with a BEHAVIOURAL test
// (write through the tracker, read through the guard, on an injected clock)
// rather than leave the alignment resting on "they happen to import the same
// symbol today" — a fact a future edit could quietly undo in only one of the
// two files, and nothing here would notice until an account's spend crossed a
// month boundary in production.
//
// 🔴 THE REASON THIS IS A BEHAVIOURAL TEST AND NOT A UNIT TEST OF
// `currentMonth` ITSELF: asserting `currentMonth(clockA) === currentMonth
// (clockB)` for two clocks reading the same instant would only prove the
// function is pure — it says nothing about whether the GUARD and the TRACKER
// actually reach it with the instant they think they are using. Driving both
// through their own public methods (`recordSttUsage` / `ensureQuota` /
// `remainingSttMs`) is what makes a future re-derivation of the bucket key in
// only one of the two files fail here, at the READ, exactly the way it would
// fail in production.

import { describe, expect, it } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import { makeUsageTracker } from '../src/billing/usage-tracker';
import { planLimits } from '../src/billing/plans';

const USER = 'u-month-bucket';
/** 20 STT minutes, well under `planLimits('max').stt_minutes` (3,000) — enough
 *  headroom that a real overrun would still be a large gap, not a rounding one. */
const TWENTY_MIN_MS = 20 * 60_000;

function wire(db: DbConnection, now: () => number) {
  const tracker = makeUsageTracker(db.usage, { mode: 'saas' as const, now });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: () => planLimits('max') }, { mode: 'saas', now });
  return { tracker, guard };
}

describe('🔴 F8 — the guard reads the SAME month the meter just wrote', () => {
  it('usage recorded through the tracker is visible to the guard, same instant', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('month-bucket-secret-32-bytes-xx') });
    db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
    const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15 UTC, safely mid-month
    const { tracker, guard } = wire(db, () => NOW);

    expect(guard.remainingSttMs(USER)).toBe(planLimits('max').stt_minutes * 60_000);
    tracker.recordSttUsage(USER, { is_byok: false }, TWENTY_MIN_MS, { transcript: 0, delivered: 0 });

    // 🔴 THE ASSERTION THIS FILE EXISTS FOR: the guard's remaining budget moved
    // by exactly what the tracker just recorded. If the two computed different
    // bucket KEYS for the identical instant, this would still read the full,
    // untouched limit — the guard would be looking at an empty row for "its"
    // month while the spend sat in a row it never reads.
    expect(guard.remainingSttMs(USER)).toBe(planLimits('max').stt_minutes * 60_000 - TWENTY_MIN_MS);
    expect(() => guard.ensureQuota(USER, 'stt')).not.toThrow();

    db.close();
  });

  // 🔴 THE SHARPEST WAY TWO INDEPENDENT BUCKET COMPUTATIONS CAN DISAGREE IS AT
  // THE BOUNDARY — a UTC-vs-local-time divergence, or an off-by-one in the
  // month arithmetic, is invisible mid-month and only shows up exactly here.
  it('spend recorded in one UTC month does not leak into the next, for either side', () => {
    const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('month-bucket-secret-32-bytes-xx') });
    db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
    // One millisecond before, and one millisecond into, the UTC month boundary.
    const LAST_MS_OF_JUNE = Date.UTC(2026, 5, 30, 23, 59, 59, 999);
    const FIRST_MS_OF_JULY = Date.UTC(2026, 6, 1, 0, 0, 0, 0);
    let nowMs = LAST_MS_OF_JUNE;
    const { tracker, guard } = wire(db, () => nowMs);

    tracker.recordSttUsage(USER, { is_byok: false }, TWENTY_MIN_MS, { transcript: 0, delivered: 0 });
    expect(guard.remainingSttMs(USER)).toBe(planLimits('max').stt_minutes * 60_000 - TWENTY_MIN_MS);

    // The clock ticks into July. A GUARD that still thought in June would
    // report the same drained remainder; a TRACKER whose next write still
    // thought in June would keep draining June's row forever.
    nowMs = FIRST_MS_OF_JULY;
    expect(guard.remainingSttMs(USER)).toBe(planLimits('max').stt_minutes * 60_000);
    tracker.recordSttUsage(USER, { is_byok: false }, TWENTY_MIN_MS, { transcript: 0, delivered: 0 });
    expect(guard.remainingSttMs(USER)).toBe(planLimits('max').stt_minutes * 60_000 - TWENTY_MIN_MS);

    // June's row is untouched by July's write — two rows, not one.
    expect(db.usage.get(USER, '2026-06')?.stt_minutes).toBe(20);
    expect(db.usage.get(USER, '2026-07')?.stt_minutes).toBe(20);

    db.close();
  });
});
