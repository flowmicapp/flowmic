// 0.2.37 — `Plan` becomes three-valued (free | pro | max), owner 2026-08-01
// (docs/decisions/2026-08-01-owner-three-tier-pricing-usd-monthly.md).
//
// Why this file exists at all: `isPlan` is a HAND-WRITTEN TYPE PREDICATE, and
// this repo has already been burned by one (book 13 §7 F1 ⑤ — `asPairingInfo`
// asserted `c is string` while testing `typeof c === 'object'`, so a real array
// was empty on every machine for weeks and eleven green tests never noticed).
// The compiler does not check the body of a `v is T` function; only a test does.
//
// So: every accepted value, and three shapes of rejection that a naive
// implementation would let through — a non-string (`includes` on an object),
// wrong case (`'Pro'`, which a `.toLowerCase()`-happy implementation would
// accept and thereby mint a second spelling of one tier), and the empty string
// (which a truthiness-based implementation would reject for the WRONG reason
// and a `PLANS.join().includes(v)` implementation would ACCEPT).

import { describe, it, expect } from 'vitest';
import { PLANS, isPlan, type Plan } from '../src/types';

describe('Plan tiers', () => {
  it('PLANS is exactly the three owner-ruled tiers, in price order', () => {
    expect(PLANS).toEqual(['free', 'pro', 'max']);
  });

  it('isPlan accepts every member of PLANS', () => {
    for (const p of PLANS) expect(isPlan(p)).toBe(true);
  });

  it('isPlan rejects an object (a bare `includes` on a non-string must not throw)', () => {
    expect(isPlan({ plan: 'pro' })).toBe(false);
    expect(isPlan(['pro'])).toBe(false);
    expect(isPlan(null)).toBe(false);
    expect(isPlan(undefined)).toBe(false);
    expect(isPlan(0)).toBe(false);
  });

  it('isPlan rejects wrong case — one tier must have exactly one spelling', () => {
    expect(isPlan('Pro')).toBe(false);
    expect(isPlan('PRO')).toBe(false);
    expect(isPlan('Free')).toBe(false);
    expect(isPlan('MAX')).toBe(false);
  });

  it('isPlan rejects the empty string and near-misses', () => {
    expect(isPlan('')).toBe(false);
    expect(isPlan(' pro')).toBe(false);
    expect(isPlan('pro ')).toBe(false);
    expect(isPlan('maximum')).toBe(false);
    expect(isPlan('premium')).toBe(false);
  });

  it('narrows for the compiler (the predicate is load-bearing, not decorative)', () => {
    const v: unknown = 'max';
    if (!isPlan(v)) throw new Error('unreachable');
    const p: Plan = v; // ← compile-time proof the predicate narrows to Plan
    expect(p).toBe('max');
  });
});
