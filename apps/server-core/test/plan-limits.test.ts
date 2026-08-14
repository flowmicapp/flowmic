// window D1 Lane B — the three-tier quota table and its configurability (A1).
//
// Two things are under test and they fail in opposite directions:
//
//   ① the DEFAULTS are owner's table verbatim (2026-08-01). A quota number that
//      drifts from the ruling is money: 60 vs 900 managed STT minutes is the
//      difference between 97% margin and a loss-leader.
//   ② every malformed override FAILS THE BOOT. The tempting implementation —
//      "if the JSON is bad, use the defaults" — produces the exact "configured but
//      not in effect" bug this repo names as its #1 shape: the operator sees their
//      config in the file, the server serves something else, and nothing says so.
//
// Plus the red line: pro and max must be identical on mobiles / history_days.
// That is asserted on the DEFAULTS and enforced on any RESOLVED table, so a
// config override cannot build the capability wall either.
//
// ⚠️ `pcs` LEFT the red line on 2026-08-02 (owner: FREE/PRO/MAX = 2/3/10,
// docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md) and is now policed by a
// DIFFERENT machine check — finite + free ≤ pro ≤ max. Both are pinned below,
// including the direction each one fails in.

import { afterEach, describe, expect, it } from 'vitest';
import {
  PLAN_LIMITS,
  currentPlanLimits,
  installPlanLimits,
  planLimits,
  resetPlanLimits,
  resolvePlanLimits,
} from '../src/billing/plans';

afterEach(() => {
  // A module-level table that a test installs and does not remove would leak
  // into every later test in this file.
  resetPlanLimits();
});

describe('default plan limits = owner 2026-08-02 table', () => {
  it('free: 20 min / 1M token / 2 PC / 2 phone / 30 days', () => {
    expect(PLAN_LIMITS.free).toEqual({
      stt_minutes: 20,
      llm_tokens: 1_000_000,
      pcs: 2,
      mobiles: 2,
      history_days: 30,
    });
  });

  it('pro: 900 min / 20M token / 3 PC / ∞ phone / 365 days', () => {
    expect(PLAN_LIMITS.pro).toEqual({
      stt_minutes: 900,
      llm_tokens: 20_000_000,
      pcs: 3,
      mobiles: Number.POSITIVE_INFINITY,
      history_days: 365,
    });
  });

  it('max: 3,000 min / 100M token / 10 PC / ∞ phone / 365 days', () => {
    expect(PLAN_LIMITS.max).toEqual({
      stt_minutes: 3_000,
      llm_tokens: 100_000_000,
      pcs: 10,
      mobiles: Number.POSITIVE_INFINITY,
      history_days: 365,
    });
  });

  // 🔴 D1 rule: for any plan/permission/quota change, the "name" and "the number that actually takes effect" must be asserted separately.
  // The three cases above assert the compiled-in DEFAULTS table (the "name" half:
  // what ships in the box). This one goes through planLimits() — the function every
  // enforcement site actually calls — so a re-cut that edited PLAN_LIMITS but left
  // the resolution path pointing somewhere stale would fail HERE and not there.
  it('🔴 the EFFECTIVE numbers (planLimits(), not the constant) carry the 2026-08-02 re-cut', () => {
    expect(planLimits('free').stt_minutes).toBe(20);
    expect(planLimits('pro').stt_minutes).toBe(900);
    expect(planLimits('max').stt_minutes).toBe(3_000);
    // Reverse control: install a table that keeps every tier NAME and every other
    // cell identical while moving only the minute numbers. If this suite were
    // asserting labels rather than the enforced values, the next three lines would
    // still read 20/900/3000 and the test would pass on a broken resolution path.
    installPlanLimits(resolvePlanLimits({
      free: { stt_minutes: 1 }, pro: { stt_minutes: 2 }, max: { stt_minutes: 3 },
    }));
    expect(planLimits('free').stt_minutes).toBe(1);
    expect(planLimits('pro').stt_minutes).toBe(2);
    expect(planLimits('max').stt_minutes).toBe(3);
    resetPlanLimits();
    expect(planLimits('pro').stt_minutes).toBe(900);
  });

  // 🔴 D1 rule again, for the number THIS card moved. The three `PLAN_LIMITS.*`
  // cases above are the "name" half — what the constant says. This is the "the number
  // that actually takes effect" half: `planLimits()` is the function room/registry.ts's
  // `deviceLimit` actually calls, so a re-cut that edited the constant and left
  // resolution stale fails HERE and not at the wall.
  it('🔴 the EFFECTIVE pcs ladder (planLimits(), not the constant) is 2/3/10', () => {
    expect(planLimits('free').pcs).toBe(2);
    expect(planLimits('pro').pcs).toBe(3);
    expect(planLimits('max').pcs).toBe(10);
    // Reverse control: install a table whose tier NAMES and every other cell are
    // untouched, moving ONLY the instance counts. A suite that asserted labels
    // instead of enforced values would still read 2/3/10 here and pass on a
    // broken resolution path.
    installPlanLimits(resolvePlanLimits({ free: { pcs: 1 }, pro: { pcs: 4 }, max: { pcs: 40 } }));
    expect(planLimits('free').pcs).toBe(1);
    expect(planLimits('pro').pcs).toBe(4);
    expect(planLimits('max').pcs).toBe(40);
    resetPlanLimits();
    expect(planLimits('max').pcs).toBe(10);
  });

  it('🔴 pro and max stay identical on phones + retention — the cloud sells convenience, never capability', () => {
    for (const key of ['mobiles', 'history_days'] as const) {
      expect(PLAN_LIMITS.max[key]).toBe(PLAN_LIMITS.pro[key]);
    }
    // Positive control: the two tiers ARE different — otherwise the assertion
    // above would also pass on a table where max was accidentally a copy of pro.
    expect(PLAN_LIMITS.max.stt_minutes).not.toBe(PLAN_LIMITS.pro.stt_minutes);
    expect(PLAN_LIMITS.max.llm_tokens).not.toBe(PLAN_LIMITS.pro.llm_tokens);
  });

  // 🔴 The narrowing itself, asserted as a FACT rather than left to the header.
  // owner 2026-08-02 ruled 2/3/10 explicitly; a later refactor that "restored
  // consistency" by making pro.pcs == max.pcs would undo a ruling silently.
  it('🔴 pcs is the ONE paid-tier difference beyond metered spend (owner 2026-08-02)', () => {
    expect(PLAN_LIMITS.pro.pcs).not.toBe(PLAN_LIMITS.max.pcs);
    // …and it is the only device/retention dimension that differs.
    expect(PLAN_LIMITS.pro.mobiles).toBe(PLAN_LIMITS.max.mobiles);
    expect(PLAN_LIMITS.pro.history_days).toBe(PLAN_LIMITS.max.history_days);
  });

  it('🔴 every tier has a FINITE pcs ceiling (an ∞ tier makes 2/3/10 unenforceable)', () => {
    for (const p of ['free', 'pro', 'max'] as const) {
      expect(Number.isFinite(PLAN_LIMITS[p].pcs)).toBe(true);
    }
  });

  it('the paid fair lines stay FINITE (no Infinity escape on metered spend)', () => {
    for (const p of ['free', 'pro', 'max'] as const) {
      expect(Number.isFinite(PLAN_LIMITS[p].stt_minutes)).toBe(true);
      expect(Number.isFinite(PLAN_LIMITS[p].llm_tokens)).toBe(true);
      expect(Number.isFinite(PLAN_LIMITS[p].history_days)).toBe(true);
    }
  });
});

describe('resolvePlanLimits — the happy paths', () => {
  it('no overrides = the defaults, but a fresh copy (callers cannot corrupt the source)', () => {
    const table = resolvePlanLimits();
    expect(table).toEqual(PLAN_LIMITS);
    table.free.stt_minutes = 9999;
    expect(PLAN_LIMITS.free.stt_minutes).toBe(20);
    expect(resolvePlanLimits().free.stt_minutes).toBe(20);
  });

  it('null and undefined both mean "nothing configured"', () => {
    expect(resolvePlanLimits(null)).toEqual(PLAN_LIMITS);
    expect(resolvePlanLimits(undefined)).toEqual(PLAN_LIMITS);
  });

  it('merges cell-by-cell — naming one number does not blank the rest of the tier', () => {
    const table = resolvePlanLimits({ free: { stt_minutes: 25 } });
    expect(table.free.stt_minutes).toBe(25);
    expect(table.free.llm_tokens).toBe(1_000_000); // untouched
    expect(table.free.pcs).toBe(2);
    expect(table.pro).toEqual(PLAN_LIMITS.pro); // untouched tier
  });

  it('"unlimited" is the JSON spelling of Infinity — for `mobiles` only now', () => {
    const table = resolvePlanLimits({ free: { mobiles: 'unlimited' } });
    expect(table.free.mobiles).toBe(Number.POSITIVE_INFINITY);
  });

  it('accepts 0 (a tier with no managed minutes is a real product decision)', () => {
    expect(resolvePlanLimits({ free: { stt_minutes: 0 } }).free.stt_minutes).toBe(0);
  });
});

describe('resolvePlanLimits — every malformed override FAILS THE BOOT', () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ['not an object', 'free=10', /must be a JSON object/],
    ['an array', [{ free: {} }], /must be a JSON object/],
    ['unknown tier name', { enterprise: { stt_minutes: 1 } }, /unknown tier "enterprise"/],
    ['a tier name in the wrong case', { Pro: { stt_minutes: 1 } }, /unknown tier "Pro"/],
    ['a tier mapped to a scalar', { free: 10 }, /must map to an object/],
    ['unknown limit key', { free: { stt_min: 10 } }, /unknown limit "stt_min"/],
    ['a string value', { free: { stt_minutes: '10' } }, /must be a number/],
    ['a null value', { free: { stt_minutes: null } }, /must be a number/],
    ['a negative value', { free: { stt_minutes: -1 } }, /non-negative integer/],
    ['a fractional value', { free: { stt_minutes: 1.5 } }, /non-negative integer/],
    ['NaN', { free: { stt_minutes: Number.NaN } }, /non-negative integer/],
    ['Infinity on a metered dimension', { pro: { stt_minutes: Number.POSITIVE_INFINITY } }, /may not be Infinity/],
    ['"unlimited" on retention', { pro: { history_days: 'unlimited' } }, /may not be "unlimited"/],
    ['"unlimited" on tokens', { pro: { llm_tokens: 'unlimited' } }, /may not be "unlimited"/],
    // 2026-08-02: `pcs` is a FINITE ladder now, so this is refused at the
    // "unlimited" door BY NAME rather than one line later by the ladder check —
    // an operator has to be told which rule they broke, not the nearest one.
    ['"unlimited" on pcs (a finite ladder since 2026-08-02)', { max: { pcs: 'unlimited' } }, /may not be "unlimited"/],
    ['Infinity on pcs', { max: { pcs: Number.POSITIVE_INFINITY } }, /may not be Infinity/],
  ];

  for (const [label, value, pattern] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => resolvePlanLimits(value)).toThrow(pattern);
    });
  }

  it('names the offending tier and key in the message (an operator has to find it)', () => {
    expect(() => resolvePlanLimits({ max: { llm_tokens: 'lots' } })).toThrow(/max\.llm_tokens/);
  });

  it('🔴 refuses an override that would build a capability wall between pro and max', () => {
    expect(() => resolvePlanLimits({ max: { mobiles: 5 } })).toThrow(/capability wall/);
    expect(() => resolvePlanLimits({ pro: { history_days: 90 } })).toThrow(/capability wall/);
    // Positive control: moving BOTH paid tiers together is allowed — the rule is
    // "no wall", not "no change".
    const ok = resolvePlanLimits({ pro: { history_days: 180 }, max: { history_days: 180 } });
    expect(ok.pro.history_days).toBe(180);
    expect(ok.max.history_days).toBe(180);
  });

  // 🔴 The check that took `pcs`'s slot when it left NO_WALL_KEYS. Without it the
  // narrowing would be a hole: `{max:{pcs:5}}` used to be refused BY THE WALL and
  // nothing else was watching that cell.
  it('🔴 pcs must not shrink as tiers get more expensive (the ladder that replaced the wall)', () => {
    expect(() => resolvePlanLimits({ pro: { pcs: 99 } })).toThrow(/must not shrink/);
    expect(() => resolvePlanLimits({ free: { pcs: 5 } })).toThrow(/must not shrink/);
    expect(() => resolvePlanLimits({ max: { pcs: 1 } })).toThrow(/must not shrink/);
    // Positive control: a differently-shaped ladder is fine — the rule is
    // "never downhill", not "these exact three numbers".
    const ok = resolvePlanLimits({ free: { pcs: 1 }, pro: { pcs: 5 }, max: { pcs: 50 } });
    expect(ok.free.pcs).toBe(1);
    expect(ok.pro.pcs).toBe(5);
    expect(ok.max.pcs).toBe(50);
    // Flat is legal too (≤, not <): two tiers may carry the same count.
    expect(() => resolvePlanLimits({ pro: { pcs: 10 } })).not.toThrow();
  });

  it('names the tier in the ladder message (an operator has to find the cell)', () => {
    expect(() => resolvePlanLimits({ max: { pcs: 1 } })).toThrow(/pro\.pcs=3 but max\.pcs=1/);
  });

  it('free may differ from the paid tiers — that gap is the product', () => {
    const table = resolvePlanLimits({ free: { pcs: 1, history_days: 7 } });
    expect(table.free.pcs).toBe(1);
    expect(table.free.history_days).toBe(7);
  });
});

describe('the installed table is what planLimits() answers with', () => {
  it('defaults until something is installed', () => {
    expect(planLimits('pro').stt_minutes).toBe(900);
    expect(currentPlanLimits()).toBe(PLAN_LIMITS);
  });

  it('installPlanLimits changes every downstream reader in one move', () => {
    // This is the whole point of the seam: quota-guard / retention / registry /
    // billing-service all call planLimits(plan) with no config handle.
    installPlanLimits(resolvePlanLimits({ pro: { stt_minutes: 120 }, free: { stt_minutes: 3 } }));
    expect(planLimits('pro').stt_minutes).toBe(120);
    expect(planLimits('free').stt_minutes).toBe(3);
    expect(planLimits('max').stt_minutes).toBe(3_000); // untouched tier still resolves
  });

  it('resetPlanLimits restores the compiled-in defaults', () => {
    installPlanLimits(resolvePlanLimits({ free: { stt_minutes: 3 } }));
    resetPlanLimits();
    expect(planLimits('free').stt_minutes).toBe(20);
  });

  it('an unknown tier at runtime degrades to free rather than crashing a session', () => {
    // users.plan is a TEXT column: a hand-edited row can hold anything, and the
    // repo casts it. Whatever arrives, someone is mid-sentence — degrade, do not
    // throw. (Free is the safe direction: it under-grants, never over-grants.)
    expect(planLimits('enterprise' as never)).toEqual(PLAN_LIMITS.free);
  });
});
