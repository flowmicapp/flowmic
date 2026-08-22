// D1 §6.1 / §6.1-bis — the SINGLE point that answers 「what tier is this user, and on what grounds」
// and 「what is their quota right now」.
//
// SPEC-REF: docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §6.1 (PlanView +
//           PlanSource + the four-step priority), §6.1-bis (permanent_free is an exemption,
//           not a tier; effectiveLimits is the sole source of quota)
//           docs/decisions/2026-08-01-owner-three-tier-pricing-usd-monthly.md
//
// What is pinned here, and why each one is not obvious:
//   ① `source` is a REAL second field, not a decoration — every branch is asserted
//      to say where the tier came from. The window's red line is 「the UI shows upgraded but the server did not take effect」
//      and its twin is 「it shows Pro but cannot say on what grounds」.
//   ② permanent_free resolves to plan:'free' + quota_exempt:true — NOT to 'pro'.
//      The first draft of §6.1 mapped it to 'pro', which would have capped owner
//      at pro's 60 STT minutes: the exact opposite of 「do not block me」.
//   ③ a paddle row OUTRANKS FLOWMIC_MOCK_UNLOCK_ALL. That flag says 'pro'
//      unconditionally, so if mock won, a real MAX subscriber on a box with the
//      dev flag left on would be silently downgraded.
//   ④ the exemption reaches the ENFORCEMENT points, proved through the real
//      QuotaGuard rather than by reading effectiveLimits back (a limits table
//      nothing consults is a façade — book 13 §7 F1 ③).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import {
  PLAN_LIMITS,
  PLAN_LIMIT_KEYS,
  installPlanLimits,
  planLimits,
  resetPlanLimits,
  resolvePlanLimits,
} from '../src/billing/plans';
import { currentMonth } from '../src/db/repos/usage.repo';
import { ServerError } from '../src/errors';
import type { PaddleSubRow } from '../src/db/repos/billing.repo';

const USER = 'u1';
const OTHER = 'u2';
const NOW = Date.parse('2026-08-01T00:00:00.000Z');

let db: DbConnection;

function makeBilling(unlockAll = false): BillingService {
  return new BillingService({
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    billing: db.billing,
    unlockAll,
    now: () => NOW,
  });
}

/** A `paddle_subscriptions` row as the webhook handler (lane C) will write it. */
function paddleRow(over: Partial<PaddleSubRow> = {}): PaddleSubRow {
  const iso = new Date(NOW).toISOString();
  return {
    subscription_id: 'sub_test01',
    user_id: USER,
    customer_id: 'ctm_test01',
    status: 'active',
    tier: 'pro',
    price_id: 'pri_pro_monthly',
    cycle: 'monthly',
    current_period_end: new Date(NOW + 30 * 86_400_000).toISOString(),
    canceled_at: null,
    scheduled_change_action: null,
    scheduled_change_at: null,
    next_billed_at: null,
    contract_concluded_at: null,
    last_event_id: 'evt_test01',
    last_occurred_at: iso,
    created_at: iso,
    updated_at: iso,
    ...over,
  };
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: USER, display_name: 'U1', plan: 'free' });
  db.users.insert({ id: OTHER, display_name: 'U2', plan: 'free' });
});
afterEach(() => {
  // Any suite that installs an override table must restore the defaults or it
  // leaks into the next test (plans.ts resetPlanLimits doc).
  resetPlanLimits();
  db.close();
});

describe('D1 §6.1 ④ — nothing at all', () => {
  it('a fresh account is free, and says the source is `none` (not a guess)', () => {
    expect(makeBilling().getPlan(USER)).toEqual({
      plan: 'free',
      source: 'none',
      quota_exempt: false,
      cycle: null,
      state: 'none',
      expires_at: null,
      scheduled_change: null,
      next_billed_at: null,
      withdrawal_deadline: null,
      contract_concluded_at: null,
      paddle_subscription_id: null,
    });
  });
});

describe('D1 §6.1 ② — a paddle subscription', () => {
  it('grants its tier, names the source and echoes the sub id for reconciliation', () => {
    db.billing.upsertSubscription(paddleRow({ tier: 'max', price_id: 'pri_max_monthly' }));
    const view = makeBilling().getPlan(USER);
    expect(view).toMatchObject({
      plan: 'max',
      source: 'paddle',
      quota_exempt: false,
      cycle: 'monthly',
      state: 'active',
      paddle_subscription_id: 'sub_test01',
    });
    expect(makeBilling().getQuota(USER).stt.limit_min).toBe(3_000); // owner's max line
  });

  it('past current_period_end ⇒ plan falls to free but source STAYS paddle', () => {
    db.billing.upsertSubscription(
      paddleRow({ current_period_end: new Date(NOW - 1000).toISOString() }),
    );
    // 「from that subscription, already expired」 — a different, and far more useful, statement than
    // 「there has never been a subscription」. Collapsing them deletes the only clue support has.
    expect(makeBilling().getPlan(USER)).toMatchObject({
      plan: 'free',
      source: 'paddle',
      state: 'expired',
      paddle_subscription_id: 'sub_test01',
    });
  });

  it('canceled / past_due / paused all KEEP the tier until period end (D1 §5)', () => {
    for (const status of ['canceled', 'past_due', 'paused'] as const) {
      db.billing.upsertSubscription(paddleRow({ status }));
      const view = makeBilling().getPlan(USER);
      expect(view.plan, `status=${status}`).toBe('pro');
      expect(view.state, `status=${status}`).toBe(status);
    }
  });

  it('an unknown Paddle status neither grants a lie nor strips a payer', () => {
    // Paddle inventing a sixth status must not silently downgrade someone who is
    // inside their paid period; it must also not be reported as 'active', which
    // would claim we read something we did not.
    db.billing.upsertSubscription(paddleRow({ status: 'some_new_paddle_status' }));
    expect(makeBilling().getPlan(USER)).toMatchObject({ plan: 'pro', state: 'pending', source: 'paddle' });
  });

  it('an unparseable period end is treated as EXPIRED (fail-closed on garbage)', () => {
    db.billing.upsertSubscription(paddleRow({ current_period_end: 'not-a-date' }));
    expect(makeBilling().getPlan(USER)).toMatchObject({ plan: 'free', state: 'expired' });
  });

  it('a tier this build does not know resolves to free, never to a paid one', () => {
    // `paddle_subscriptions.tier` is a free-text column read back with an
    // unchecked cast; re-narrowing by test is the fail-CLOSED direction.
    db.billing.upsertSubscription(paddleRow({ tier: 'platinum' as never }));
    expect(makeBilling().getPlan(USER).plan).toBe('free');
  });

  it('a non-monthly/yearly cycle reads as null, not as a fabricated "monthly"', () => {
    db.billing.upsertSubscription(paddleRow({ cycle: 'weekly' }));
    expect(makeBilling().getPlan(USER).cycle).toBeNull();
  });

  it("another account's subscription does not leak into this one", () => {
    db.billing.upsertSubscription(paddleRow({ user_id: OTHER }));
    expect(makeBilling().getPlan(USER)).toMatchObject({ plan: 'free', source: 'none' });
    expect(makeBilling().getPlan(OTHER)).toMatchObject({ plan: 'pro', source: 'paddle' });
  });
});

// ── 🔴 0.3.25 B1 — the fact `state` could never carry ──────────────────────
//
// A subscription scheduled to cancel at period end is `status:'active'` at
// Paddle, because that is what it is. So `state` alone had ONE word for TWO
// facts, and the console could not tell a user the date their service stops.
// These tests are red against any implementation that folds the scheduled
// change into `state`, and red against one that drops it.
describe('0.3.25 B1 — a scheduled cancellation is a separate fact from the state', () => {
  it('🔴 still active, and says so, while also saying it will not renew', () => {
    db.billing.upsertSubscription(
      paddleRow({
        status: 'active',
        scheduled_change_action: 'cancel',
        scheduled_change_at: '2026-09-01T00:00:00.000Z',
        next_billed_at: null, // Paddle nulls it once a cancel is scheduled
      }),
    );
    const v = makeBilling().getPlan(USER);
    // 🔴 BOTH halves. The tier is still granted and the service is still
    // running — a page that renders 「canceled」 here makes a paying user stop
    // using something they have already paid for.
    expect(v.state).toBe('active');
    expect(v.plan).toBe('pro');
    expect(v.scheduled_change).toEqual({ action: 'cancel', effective_at: '2026-09-01T00:00:00.000Z' });
    // 「how long you have paid for」 survives; 「will money move again」 does not.
    expect(v.expires_at).not.toBeNull();
    expect(v.next_billed_at).toBeNull();
  });

  it('a live subscription with no scheduled change says so, and names its next charge', () => {
    // Positive control for the test above: same shape, nothing scheduled. If
    // `scheduled_change` were hardcoded either way, one of these two fails.
    db.billing.upsertSubscription(paddleRow({ status: 'active', next_billed_at: '2026-09-01T00:00:00.000Z' }));
    const v = makeBilling().getPlan(USER);
    expect(v.scheduled_change).toBeNull();
    expect(v.next_billed_at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a PAUSE is not rounded into a cancel — Paddle’s own word reaches the console', () => {
    db.billing.upsertSubscription(
      paddleRow({ scheduled_change_action: 'pause', scheduled_change_at: '2026-09-01T00:00:00.000Z' }),
    );
    expect(makeBilling().getPlan(USER).scheduled_change?.action).toBe('pause');
  });

  it('an action with no readable date still reports the action — 「we cannot say when」 is not 「nothing」', () => {
    db.billing.upsertSubscription(paddleRow({ scheduled_change_action: 'cancel', scheduled_change_at: null }));
    expect(makeBilling().getPlan(USER).scheduled_change).toEqual({ action: 'cancel', effective_at: null });
  });

  it('🔴 an EXPIRED subscription reports neither — a past date must not render as 「runs until」', () => {
    db.billing.upsertSubscription(
      paddleRow({
        current_period_end: new Date(NOW - 1000).toISOString(),
        scheduled_change_action: 'cancel',
        scheduled_change_at: new Date(NOW - 1000).toISOString(),
        next_billed_at: new Date(NOW - 1000).toISOString(),
      }),
    );
    const v = makeBilling().getPlan(USER);
    expect(v.state).toBe('expired');
    expect(v.scheduled_change).toBeNull();
    expect(v.next_billed_at).toBeNull();
  });
});

describe('D1 §6.1 ③ — the mock branch is honest about being mock', () => {
  it('FLOWMIC_MOCK_UNLOCK_ALL reports source:"mock", never "paddle"', () => {
    expect(makeBilling(true).getPlan(USER)).toMatchObject({ plan: 'pro', source: 'mock', state: 'active' });
  });

  it('🔴 a REAL paddle subscription outranks unlock-all (no silent downgrade)', () => {
    // The ordering bug this pins: mock says 'pro' unconditionally, so if it ran
    // first a paying MAX customer on a box with the dev flag left on would be
    // quietly cut to pro — and the console would show 'pro' with no way to tell.
    db.billing.upsertSubscription(paddleRow({ tier: 'max' }));
    expect(makeBilling(true).getPlan(USER)).toMatchObject({ plan: 'max', source: 'paddle' });
  });
});

describe('D1 §6.1-bis ① — permanent_free is an EXEMPTION, not a tier', () => {
  it('resolves to plan:"free" + source:"permanent_free" + quota_exempt:true', () => {
    db.users.setPermanentFree(USER, true);
    // 🔴 plan STAYS 'free': owner bought nothing, so 'pro'/'max' would be a lie —
    // and (the reason §6.1-bis exists at all) 'pro' would also have CAPPED him at
    // 60 STT minutes. Three fields, three true sentences.
    expect(makeBilling().getPlan(USER)).toEqual({
      plan: 'free',
      source: 'permanent_free',
      quota_exempt: true,
      cycle: null,
      state: 'none',
      expires_at: null,
      scheduled_change: null,
      next_billed_at: null,
      withdrawal_deadline: null,
      contract_concluded_at: null,
      paddle_subscription_id: null,
    });
  });

  it('outranks everything else — a paddle row and unlock-all cannot preempt it', () => {
    db.users.setPermanentFree(USER, true);
    db.billing.upsertSubscription(paddleRow({ tier: 'max' }));
    const view = makeBilling(true).getPlan(USER);
    expect(view.source).toBe('permanent_free');
    expect(view.quota_exempt).toBe(true);
  });

  // ── 🔴 owner 2026-08-07: the exemption resolves to the MONTHLY MAX numbers ──
  // docs/decisions/2026-08-07-owner-permanent-free-becomes-max-and-test-accounts-
  // reset-to-free.md ①. Before the W1 engine switch 「unlimited」 cost our own CPU;
  // after it, the same table meant unlimited spending of a VENDOR's money. MAX is
  // the highest tier we ever sold ⇒ already an 「enough」 bound, and finite.
  it('🔴 effectiveLimits gives an exempt account MAX\'s numbers, cell by cell', () => {
    db.users.setPermanentFree(USER, true);
    const limits = makeBilling().effectiveLimits(USER);
    // Named one at a time, NOT as one deep-equal: a deep-equal against a single
    // expected object passes for the wrong reason the day someone edits both
    // sides together, and it cannot say WHICH cell moved when it fails.
    expect(limits.stt_minutes).toBe(3_000);
    expect(limits.llm_tokens).toBe(100_000_000);
    expect(limits.pcs).toBe(10);
    // ⚠️ Infinity is max's OWN value here (pro and max are identical on `mobiles`
    // under 「the cloud sells convenience, never capability」). It is not a carve-out for the exemption —
    // copying max's numbers is what put it there.
    expect(limits.mobiles).toBe(Number.POSITIVE_INFINITY);
    // Unchanged, and for the pre-existing ARITHMETIC reason, not policy:
    // retention.ts computes `now - days*86400e3`, and an infinite window makes
    // that NaN — which compares false against everything and would silently
    // DISABLE the sweep instead of extending it. 365 is also max's value.
    expect(limits.history_days).toBe(365);

    // 🔴 D1's red line, in its 2026-08-07 form: the LABEL and the NUMBER are
    // asserted SEPARATELY, in the same test, because they now say different
    // things. 「tier free」 + 「source permanent_free」 + 「capped at MAX」 are three
    // true sentences, and a test that checked only the first two would stay green
    // on the day the ceiling silently went back to ∞ (or dropped to free's 20).
    const view = makeBilling().getPlan(USER);
    expect(view.plan).toBe('free');
    expect(view.source).toBe('permanent_free');
    expect(view.quota_exempt).toBe(true);
    // …and the label demonstrably did NOT produce the numbers: free's table is
    // a different set of numbers entirely, and nothing resolved through it.
    expect(planLimits('free').stt_minutes).toBe(20);
    expect(planLimits('free').pcs).toBe(2);
  });

  // 🔴 The DRIFT GUARD, and the reason EXEMPT_LIMITS is written out rather than
  // aliased to PLAN_LIMITS.max. If owner re-prices max, this goes RED — which is
  // the point: 「should the exemption follow max?」 is owner's question, and an
  // alias would have answered it silently. Do not fix this by copying numbers
  // across; go ask.
  it('🔴 drift guard: every exempt cell still equals the MAX tier default', () => {
    db.users.setPermanentFree(USER, true);
    const limits = makeBilling().effectiveLimits(USER);
    for (const key of PLAN_LIMIT_KEYS) {
      expect([key, limits[key]]).toEqual([key, PLAN_LIMITS.max[key]]);
    }
  });

  // 🔴 The other half of that decision, machine-checked instead of asserted in a
  // comment: the ceiling is sourced from the compiled-in DEFAULTS, never from the
  // ACTIVE (FLOWMIC_PLAN_LIMITS-overridable) table. Otherwise an operator
  // re-pricing the SELLABLE max tier would move owner's SPEND CEILING as an
  // invisible side effect — one value answering two questions, and it moves the
  // very ceiling the cap exists to hold.
  it('🔴 a FLOWMIC_PLAN_LIMITS override of `max` does NOT move the exemption', () => {
    db.users.setPermanentFree(USER, true);
    installPlanLimits(resolvePlanLimits({ max: { stt_minutes: 999_999, pcs: 99 } }));
    // positive control: the override really is in force for the tier it names…
    expect(planLimits('max').stt_minutes).toBe(999_999);
    expect(planLimits('max').pcs).toBe(99);
    // …and the exemption is untouched by it.
    const limits = makeBilling().effectiveLimits(USER);
    expect(limits.stt_minutes).toBe(3_000);
    expect(limits.pcs).toBe(10);
  });

  it('positive control: a NON-exempt account still gets the free table', () => {
    // Without this, the four assertions above could pass because effectiveLimits
    // returned ∞ for everybody.
    const limits = makeBilling().effectiveLimits(USER);
    expect(limits.stt_minutes).toBe(20);
    expect(limits.pcs).toBe(2);
  });
});

describe('D1 §6.1-bis — the exemption reaches the REAL QuotaGuard', () => {
  /** The guard wired exactly as bootstrap wires it, over a real saas config. */
  function guard(billing: BillingService) {
    return makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u) }, {
      mode: 'saas',
      now: () => NOW,
    });
  }

  it('🔴 an exempt user who burned the whole free line is NOT refused', () => {
    // Free is 20 STT minutes (owner 2026-08-02). Burn all of them, then ask.
    db.usage.increment(USER, currentMonth(() => NOW), { stt_minutes: 20 });
    db.users.setPermanentFree(USER, true);
    expect(() => guard(makeBilling()).ensureQuota(USER, 'stt')).not.toThrow();
    // 2026-08-07: was `Infinity`. The exemption is now MAX's 3,000 min, so the
    // remaining budget is a NUMBER.
    //
    // 🔴 CORRECTED 2026-08-10 (fix-025, anti-façade ④). This comment used to end
    // 「and stt-factory clamps the per-utterance hard limit with it
    // (AudioSession.clampHardLimitMs only tightens, so this is inert until the
    // last 5 minutes of the month's budget)」. Every clause of that was false, and
    // it is part of why the defect survived: a reader asking 「is the quota ceiling
    // wired?」 found a test saying yes. `stt-factory` never called
    // `clampHardLimitMs` — that method had ZERO production callers — it assigned
    // the budget straight into the ENGINE-session ceiling instead, which made this
    // account's engine session 178,800,000 ms (≈50 hours) long and still labelled
    // `engine_session`, i.e. rolling over rather than stopping.
    //
    // What is true now: `stt-factory` declares this number as the session's QUOTA
    // ceiling (`withQuotaBudget` → `AudioSession.setQuotaBudgetMs`). It is a
    // ceiling in its own right, not a clamp on another one, and it is NOT inert
    // above five minutes — it is enforced across the engine-session rollovers in
    // between and ends the recording when it is reached. Pinned by behaviour in
    // `test/quota-limit-origin.test.ts`, so this sentence has a test behind it
    // rather than a reader's trust.
    expect(guard(makeBilling()).remainingSttMs(USER)).toBe((3_000 - 20) * 60_000);
  });

  // 🔴 THE POINT OF owner's 2026-08-07 RULING, asserted as behaviour and not as a
  // table lookup: the exempt account HAS a ceiling now, and the guard enforces it.
  // Before this the `Number.isFinite` short-circuit in ensureQuota made this
  // branch structurally unreachable for an exempt account.
  it('🔴 an exempt user IS refused once MAX\'s 3,000 STT minutes are gone', () => {
    db.usage.increment(USER, currentMonth(() => NOW), { stt_minutes: 3_000 });
    db.users.setPermanentFree(USER, true);
    let thrown: unknown;
    try {
      guard(makeBilling()).ensureQuota(USER, 'stt');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('QUOTA_EXCEEDED');
    expect(guard(makeBilling()).remainingSttMs(USER)).toBe(0);
    // 🔴 …and he is STILL labelled exempt while being refused. Three sentences,
    // all true at once, and the pair is exactly what D1's red line is about:
    // 「the label moved, the gate did not」 has a twin, 「the gate moved, the label did not」, and this is that twin.
    const view = makeBilling().getPlan(USER);
    expect(view.plan).toBe('free');
    expect(view.source).toBe('permanent_free');
    expect(view.quota_exempt).toBe(true);
  });

  it('🔴 an exempt user IS refused once MAX\'s 100M LLM tokens are gone', () => {
    // `_out`, not `_in`: since owner 2026-08-14 only OUTPUT tokens accrue against
    // the budget (see the pin test below). These fixtures used `llm_tokens_in`
    // until that ruling — under the old sum either column tripped the meter.
    db.usage.increment(USER, currentMonth(() => NOW), { llm_tokens_out: 100_000_000 });
    db.users.setPermanentFree(USER, true);
    expect(() => guard(makeBilling()).ensureQuota(USER, 'llm')).toThrow(ServerError);
    // positive control: one token below the line the SAME account is served, so
    // the throw above is the ceiling and not a broken meter.
    db.usage.increment(USER, currentMonth(() => NOW), { llm_tokens_out: -1 });
    expect(() => guard(makeBilling()).ensureQuota(USER, 'llm')).not.toThrow();
  });

  it('🔴 positive control: the SAME guard refuses a NON-exempt user at 20 minutes', () => {
    // 「was not blocked」 must be shown to mean 「because of the exemption」 and not 「because the gate is broken」
    // (CLAUDE.md: a negative assertion must carry its own positive control).
    db.usage.increment(USER, currentMonth(() => NOW), { stt_minutes: 20 });
    let thrown: unknown;
    try {
      guard(makeBilling()).ensureQuota(USER, 'stt');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ServerError);
    expect((thrown as ServerError).code).toBe('QUOTA_EXCEEDED');
  });

  it('the LLM side is exempt too (both meters ride one solver)', () => {
    db.usage.increment(USER, currentMonth(() => NOW), { llm_tokens_out: 1_000_000 });
    expect(() => guard(makeBilling()).ensureQuota(USER, 'llm')).toThrow(ServerError);
    db.users.setPermanentFree(USER, true);
    expect(() => guard(makeBilling()).ensureQuota(USER, 'llm')).not.toThrow();
  });

  it('🔴 owner 2026-08-14: INPUT tokens alone never consume the LLM budget', () => {
    // 100M input tokens on a plain FREE account (limit 1M). Input is recorded as
    // reference only (docs/decisions/2026-08-14-owner-llm-token-budget-output-
    // only.md); the guard reads llm_tokens_out and must let this through.
    db.usage.increment(USER, currentMonth(() => NOW), { llm_tokens_in: 100_000_000 });
    expect(() => guard(makeBilling()).ensureQuota(USER, 'llm')).not.toThrow();
    // Positive control on the SAME account: the free tier's 1M on the OUTPUT
    // side trips — so the pass above is the ruling, not a dead meter.
    db.usage.increment(USER, currentMonth(() => NOW), { llm_tokens_out: 1_000_000 });
    expect(() => guard(makeBilling()).ensureQuota(USER, 'llm')).toThrow(ServerError);
  });

  it('getQuota: `llm.used` is the ENFORCED number (output) and `llm.used_in` the reference', () => {
    // The two numbers must stay two numbers: folding them back into one sum is
    // the exact shape the 2026-08-14 ruling retired.
    db.usage.increment(USER, currentMonth(() => NOW), { llm_tokens_in: 700, llm_tokens_out: 40 });
    const q = makeBilling().getQuota(USER);
    expect(q.llm.used).toBe(40);
    expect(q.llm.used_in).toBe(700);
  });

  it('getQuota shows an exempt account MAX\'s line, not the free one and not ∞', () => {
    db.users.setPermanentFree(USER, true);
    const q = makeBilling().getQuota(USER);
    expect(q.stt.limit_min).toBe(3_000);
    expect(q.llm.limit).toBe(100_000_000);
    // 2026-08-07: this used to assert `null` on the wire (Infinity serializes to
    // null). It must now SURVIVE serialization as a number — a `null` here would
    // mean we failed to compute the limit, and the two are no longer the same
    // thing for any account.
    expect(JSON.parse(JSON.stringify(q)).stt.limit_min).toBe(3_000);
    // positive control: the exempt line is not merely 「whatever the tier says」.
    expect(planLimits('free').stt_minutes).toBe(20);
  });
});
