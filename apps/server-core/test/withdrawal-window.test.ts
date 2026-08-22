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

import { describe, expect, it } from 'vitest';
import {
  WITHDRAWAL_WINDOW_DAYS,
  retainableFraction,
  windowFromDeadline,
  withdrawalDeadline,
  withdrawalWindow,
} from '../src/billing/withdrawal';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = '2026-08-01T00:00:00.000Z';
const START_MS = Date.parse(START);

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
    expect(withdrawalWindow(START, START_MS)).toBe('open');
    expect(withdrawalWindow(START, START_MS + 13 * DAY_MS)).toBe('open');
    // The boundary favours the consumer: closing early takes a legal right from
    // someone entitled to it, closing late costs one refund. Those two errors
    // are not equally bad and the code must not pretend they are.
    expect(withdrawalWindow(START, START_MS + 14 * DAY_MS - 1)).toBe('open');
  });

  it('closed from the instant the deadline is reached', () => {
    expect(withdrawalWindow(START, START_MS + 14 * DAY_MS)).toBe('closed');
    expect(withdrawalWindow(START, START_MS + 30 * DAY_MS)).toBe('closed');
  });

  it('🔴 unknown — NOT closed — when there is no start date to compute from', () => {
    // This is the case that must never be folded into 'closed'. It happens for
    // every subscription created before contract_concluded_at existed, and the
    // person may still be inside their window: answering 'closed' would be us
    // asserting a right had expired when we simply cannot see it.
    expect(withdrawalWindow(null, START_MS)).toBe('unknown');
    expect(withdrawalWindow(null, START_MS + 999 * DAY_MS)).toBe('unknown');
    expect(withdrawalWindow('not-a-date', START_MS)).toBe('unknown');
  });

  it('an unparseable STORED deadline is unknown too, not closed', () => {
    expect(windowFromDeadline('garbage', START_MS)).toBe('unknown');
    expect(windowFromDeadline(null, START_MS)).toBe('unknown');
  });

  it('both entry points agree — the console and the route cannot diverge', () => {
    // The route reads windowFromDeadline(PlanView.withdrawal_deadline); the
    // console reads the same field. This pins that the deadline-based path and
    // the raw-column path are the same verdict at every interesting instant.
    for (const offset of [0, 13 * DAY_MS, 14 * DAY_MS - 1, 14 * DAY_MS, 40 * DAY_MS]) {
      expect(windowFromDeadline(withdrawalDeadline(START), START_MS + offset)).toBe(
        withdrawalWindow(START, START_MS + offset),
      );
    }
  });
});

describe('🔴 what may be kept: nothing, and that is the law working, not a stub', () => {
  it('retains zero', () => {
    // CRD art. 14(3) would let us keep a pro-rata share for service already
    // supplied — but only where the consumer expressly asked for performance to
    // begin during the withdrawal period AND was told they would owe it. There
    // is no checkout in this product yet, so that consent has never been asked
    // for, and art. 14(4)(a) then says the consumer bears NO cost.
    //
    // ⚠️ If this test is ever changed to expect a fraction, the thing that must
    // have landed first is the CONSENT RECORD (B5), not a calculation.
    expect(retainableFraction()).toBe(0);
  });
});
