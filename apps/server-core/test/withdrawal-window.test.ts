// 0.3.25 B3 — billing/withdrawal.ts, the ONE decider for 「can this person still
// withdraw, and until when」.
//
// SPEC-REF: Directive 2011/83/EU art. 9 (14 days), art. 14(3)/(4)(a) (what may
//           be retained, and when nothing may be)
//           docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md §2.1
//
// 🔴 WHY THIS FILE EXISTS SEPARATELY FROM billing-withdrawal.test.ts. That one
// drives the route and proves the two halves happen. This one pins the ARITHMETIC
// and the three-valued answer — the part the console also depends on. Both the
// button's visibility and the server's refusal read the same function, and if
// they ever stop doing so, a page offers a legal right the server then denies.
//
// 🔴 2026-09-02 audit F9 — this file used to also import `withdrawalWindow`
// (a two-step convenience wrapper: `windowFromDeadline(withdrawalDeadline(x),
// now)`) and `retainableFraction` (always-0, CRD art. 14(4)(a)'s "no consent
// on record ⇒ no retention"). Both had zero production callers — the route
// calls `windowFromDeadline` directly against `PlanView.withdrawal_deadline`,
// never the two-step form, and issues a full refund unconditionally rather
// than consulting a fraction function — and both were deleted. The tests
// below now drive `windowFromDeadline(withdrawalDeadline(x), now)` directly
// (same arithmetic, no dead wrapper in between); the legal argument
// `retainableFraction` used to pin now lives as prose in withdrawal.ts's and
// billing-routes.ts's comments.

import { describe, expect, it } from 'vitest';
import { WITHDRAWAL_WINDOW_DAYS, windowFromDeadline, withdrawalDeadline } from '../src/billing/withdrawal';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = '2026-08-01T00:00:00.000Z';
const START_MS = Date.parse(START);

/** The verdict for a contract concluded at `contractConcludedAt`, at `nowMs` —
 *  the composition every real caller (billing-routes.ts, via PlanView) goes
 *  through: deadline first, then the window at that deadline. */
function windowSince(contractConcludedAt: string | null, nowMs: number): ReturnType<typeof windowFromDeadline> {
  return windowFromDeadline(withdrawalDeadline(contractConcludedAt), nowMs);
}

describe('the deadline', () => {
  it('is exactly fourteen days after the contract was concluded', () => {
    expect(withdrawalDeadline(START)).toBe(new Date(START_MS + 14 * DAY_MS).toISOString());
    // The constant and the arithmetic are asserted against each other rather
    // than both being written as 14 here: changing one alone should be red.
    expect(WITHDRAWAL_WINDOW_DAYS).toBe(14);
  });

  it('is null when we never recorded a start — never a date derived from NaN', () => {
    expect(withdrawalDeadline(null)).toBeNull();
    expect(withdrawalDeadline('not-a-date')).toBeNull();
  });
});

describe('🔴 three answers, because 「closed」 and 「we cannot tell」 are different facts', () => {
  it('open, right up to the last instant of the fourteenth day', () => {
    expect(windowSince(START, START_MS)).toBe('open');
    expect(windowSince(START, START_MS + 13 * DAY_MS)).toBe('open');
    // The boundary favours the consumer: closing early takes a legal right from
    // someone entitled to it, closing late costs one refund. Those two errors
    // are not equally bad and the code must not pretend they are.
    expect(windowSince(START, START_MS + 14 * DAY_MS - 1)).toBe('open');
  });

  it('closed from the instant the deadline is reached', () => {
    expect(windowSince(START, START_MS + 14 * DAY_MS)).toBe('closed');
    expect(windowSince(START, START_MS + 30 * DAY_MS)).toBe('closed');
  });

  it('🔴 unknown — NOT closed — when there is no start date to compute from', () => {
    // This is the case that must never be folded into 'closed'. It happens for
    // every subscription created before contract_concluded_at existed, and the
    // person may still be inside their window: answering 'closed' would be us
    // asserting a right had expired when we simply cannot see it.
    expect(windowSince(null, START_MS)).toBe('unknown');
    expect(windowSince(null, START_MS + 999 * DAY_MS)).toBe('unknown');
    expect(windowSince('not-a-date', START_MS)).toBe('unknown');
  });

  it('an unparseable STORED deadline is unknown too, not closed', () => {
    expect(windowFromDeadline('garbage', START_MS)).toBe('unknown');
    expect(windowFromDeadline(null, START_MS)).toBe('unknown');
  });
});
