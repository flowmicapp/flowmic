// Mock billing golden path (mock-billing §2/§3/§8.3): free → checkout → confirm
// → quota changes → expire → back to free. MUST run with unlockAll=false —
// "running acceptance in the unlocked state is the same as not running it" (§8.3). Also proves the finite-Pro fair line (900,
// not Infinity) and the cycle model.
//
// 0.2.40 — the fair-line numbers below moved AGAIN with owner's 2026-08-02
// upward re-cut (free 10→20 min, pro 60→900 min, max 300→3,000; see
// docs/decisions/2026-08-02-b12-plan-minute-quota-resizing-options.md, which
// found the 60-min pro tier carried the capacity of a rival's FREE tier). They are
// still written as LITERALS on purpose: reading them back out of PLAN_LIMITS
// would make this assertion tautological — it would then prove only that
// getQuota calls planLimits(), not that a paying user gets the minutes owner
// sold them.

import { beforeEach, describe, expect, it } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';

const USER = 'u1';
const DAY = 24 * 60 * 60 * 1000;

function makeBilling(unlockAll: boolean): { db: DbConnection; billing: BillingService } {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
  const billing = new BillingService({
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    // D1 §6.1 step ② — required dep. Empty here (no webhook has ever run in this
    // suite), which is exactly the state that must let the MOCK machine below
    // still be reachable: a paddle row would outrank it, and that priority is
    // pinned in plan-view-resolution.test.ts rather than assumed here.
    billing: db.billing,
    unlockAll,
    now: () => Date.parse('2026-07-23T00:00:00Z'),
  });
  return { db, billing };
}

describe('mock billing golden path (unlockAll=false)', () => {
  let db: DbConnection;
  let billing: BillingService;
  beforeEach(() => {
    ({ db, billing } = makeBilling(false));
  });

  it('starts free with the 10-min fair line', () => {
    expect(billing.getPlan(USER)).toMatchObject({ plan: 'free', state: 'none' });
    expect(billing.getQuota(USER).stt.limit_min).toBe(20);
  });

  it('checkout → pending (still free), confirm → active pro with 900-min line', () => {
    const { sessionId, state } = billing.mockCheckout(USER, 'yearly');
    expect(state).toBe('pending');
    expect(billing.getPlan(USER).plan).toBe('free'); // not active until confirmed
    const view = billing.mockConfirm(USER, sessionId);
    expect(view).toMatchObject({ plan: 'pro', cycle: 'yearly', state: 'active' });
    expect(billing.getQuota(USER).stt.limit_min).toBe(900);
    expect(db.users.findById(USER)?.plan).toBe('pro');
  });

  it('advancing the clock past expiry falls back to free (fail-loud, lazy eval)', () => {
    const { sessionId } = billing.mockCheckout(USER, 'monthly');
    billing.mockConfirm(USER, sessionId);
    expect(billing.getPlan(USER).plan).toBe('pro');
    billing.advanceClock(31 * DAY); // monthly = 30d
    const view = billing.getPlan(USER);
    expect(view).toMatchObject({ plan: 'free', state: 'expired' });
    expect(billing.getQuota(USER).stt.limit_min).toBe(20);
    expect(db.users.findById(USER)?.plan).toBe('free');
  });

  it('mockExpire forces expiry immediately', () => {
    const { sessionId } = billing.mockCheckout(USER, 'yearly');
    billing.mockConfirm(USER, sessionId);
    const view = billing.mockExpire(USER);
    expect(view).toMatchObject({ plan: 'free', state: 'expired' });
  });

  it('cancel keeps pro benefits until expiry, then renew re-activates', () => {
    const { sessionId } = billing.mockCheckout(USER, 'yearly');
    billing.mockConfirm(USER, sessionId);
    expect(billing.mockCancel(USER)).toMatchObject({ plan: 'pro', state: 'canceled' });
    expect(billing.mockRenew(USER)).toMatchObject({ plan: 'pro', state: 'active' });
  });
});

describe('unlockAll=true bypasses at getPlan only', () => {
  it('returns pro for everyone without a checkout, mutating no stored state', () => {
    const { db, billing } = makeBilling(true);
    // 🔴 D1 §6.1 — and it says WHY it is pro. A console that shows 「you are Pro」 and
    // cannot name the source is this window's headline failure.
    expect(billing.getPlan(USER)).toMatchObject({ plan: 'pro', state: 'active', source: 'mock' });
    expect(billing.getQuota(USER).stt.limit_min).toBe(900);
    // Stored subscription untouched (no account.subscription row written).
    expect(db.settings.read(USER, 'account.subscription')).toBeNull();
  });
});
