// SPEC-REF:
//   src/billing/service-deadlines.ts (the unit under test)
//   src/db/repos/one-time-purchase.repo.ts (`requestOneTimeRefund` — the claim
//     whose WHERE clause §4 pairs this against)
//   src/billing/guided-setup.ts (gs-5 — the wording these periods enforce)
//
// THE TWO DEADLINES, THE SUPPORT PERIOD, AND THE ONE EVENT THAT CLOSES A REFUND.
//
// 🔴 §4 IS THE ONE THAT EARNS ITS KEEP. Everything above it tests a pure
// function; §4 tests that the pure function and the SQL that actually moves
// money make the SAME decision, over a matrix neither was written against. The
// failure it exists to catch is not a crash — it is a console that offers a
// withdraw button the write silently refuses, or (worse) refuses a button on a
// row the write would have accepted. Both are invisible to any test that only
// checks one side.

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  nextDeadlineAt,
  refundDueReason,
  refundWindow,
  supportUntil,
  type DeadlinePolicy,
  type DeadlineSubject,
} from '../src/billing/service-deadlines';
import { GUIDED_SETUP_AFTERCARE_DAYS, PROMISED_DEADLINES } from '../src/billing/guided-setup';
import { BILLING_SQL } from '../src/db/schema-billing';
import {
  makeOneTimePurchaseRepo,
  type OneTimePurchaseRow,
  type OneTimePurchaseState,
} from '../src/db/repos/one-time-purchase.repo';

const DAY = 24 * 60 * 60 * 1000;
const BOUGHT = '2026-08-01T00:00:00.000Z';
const BOUGHT_MS = Date.parse(BOUGHT);

/** Short, round numbers so an arithmetic slip is visible rather than plausible. */
const P: DeadlinePolicy = { startDeadlineDays: 14, completeDeadlineDays: 40 };
const AFTERCARE = 14;

function subject(over: Partial<DeadlineSubject> = {}): DeadlineSubject {
  return {
    state: 'paid',
    created_at: BOUGHT,
    delivered_at: null,
    completion_notice_at: null,
    ...over,
  };
}

describe('§1 which deadline a purchase is running against', () => {
  it('a paid purchase is due at 14 days, not 40 — nobody has even booked a time', () => {
    expect(refundDueReason(subject(), BOUGHT_MS + 13.9 * DAY, P)).toBeNull();
    expect(refundDueReason(subject(), BOUGHT_MS + 14 * DAY, P)).toBe('no_start');
  });

  it('booking a session moves it to the 40-day clock — that is what scheduled MEANS', () => {
    // 🔴 THE POINT OF HAVING TWO. An operator who has spoken to the buyer and
    // put a time in the diary has already moved the row; if 'scheduled' were
    // still on the 14-day clock we would refund people we are actively working
    // with, three weeks before we said we would.
    const s = subject({ state: 'scheduled' });
    expect(refundDueReason(s, BOUGHT_MS + 20 * DAY, P)).toBeNull();
    expect(refundDueReason(s, BOUGHT_MS + 40 * DAY, P)).toBe('not_completed');
  });

  it('🔴 a setup that has BEGUN is never due — not at 40 days, not ever (gs-5)', () => {
    // owner 2026-08-30: the 40-day flag is internal and applies to booked
    // setups only. A clock must not take money back from somebody mid-session.
    const s = subject({ state: 'in_progress' });
    expect(refundDueReason(s, BOUGHT_MS + 40 * DAY, P)).toBeNull();
    expect(refundDueReason(s, BOUGHT_MS + 999 * DAY, P)).toBeNull();
    // And it has no deadline date beside it in the queue.
    expect(nextDeadlineAt(s, P, AFTERCARE)).toBeNull();
  });

  it('the two reasons stay distinct, because the operator does different things about them', () => {
    expect(refundDueReason(subject(), BOUGHT_MS + 50 * DAY, P)).toBe('no_start');
    expect(refundDueReason(subject({ state: 'scheduled' }), BOUGHT_MS + 50 * DAY, P)).toBe(
      'not_completed',
    );
  });

  it('delivered, refund_requested and refunded are NEVER due', () => {
    // Flagging any of these would put a second refund in front of an operator
    // for a purchase that has one, or one for a purchase that is complete.
    for (const state of ['delivered', 'refund_requested', 'refunded'] as const) {
      expect(refundDueReason(subject({ state }), BOUGHT_MS + 999 * DAY, P)).toBeNull();
    }
  });

  it('an unreadable purchase date does nothing rather than inventing a deadline', () => {
    // A NaN would make every comparison false — which happens to be safe here —
    // but the guard is explicit so it stays safe if the comparison is ever
    // written the other way round.
    expect(refundDueReason(subject({ created_at: 'not-a-date' }), BOUGHT_MS, P)).toBeNull();
    expect(nextDeadlineAt(subject({ created_at: 'not-a-date' }), P, AFTERCARE)).toBeNull();
  });

  it('the next deadline is rendered as a date, and it is the one that applies', () => {
    expect(nextDeadlineAt(subject(), P, AFTERCARE)).toBe(new Date(BOUGHT_MS + 14 * DAY).toISOString());
    expect(nextDeadlineAt(subject({ state: 'scheduled' }), P, AFTERCARE)).toBe(
      new Date(BOUGHT_MS + 40 * DAY).toISOString(),
    );
  });
});

describe('§2 the support period runs from the DELIVERY, and is not a refund window', () => {
  const deliveredAt = '2026-08-10T00:00:00.000Z';
  const deliveredMs = Date.parse(deliveredAt);
  const noticeAt = '2026-08-12T00:00:00.000Z';

  it('support_until is delivered_at + 14 days, regardless of when (or whether) we emailed', () => {
    // 🔴 THE EMAIL IS A RECORD, NOT A CLOCK (gs-5). These two moments differ
    // by two days here; the support the buyer is owed starts when the setup
    // is done, and a NULL notice does not move or remove it.
    const told = subject({ state: 'delivered', delivered_at: deliveredAt, completion_notice_at: noticeAt });
    const untold = subject({ state: 'delivered', delivered_at: deliveredAt, completion_notice_at: null });
    const expected = new Date(deliveredMs + 14 * DAY).toISOString();
    expect(supportUntil(told, AFTERCARE)).toBe(expected);
    expect(supportUntil(untold, AFTERCARE)).toBe(expected);
    expect(supportUntil(told, AFTERCARE)).not.toBe(new Date(Date.parse(noticeAt) + 14 * DAY).toISOString());
  });

  it('is null for every state but delivered, and for a delivery we cannot date', () => {
    for (const state of ['paid', 'scheduled', 'in_progress', 'refund_requested', 'refunded'] as const) {
      expect(supportUntil(subject({ state, delivered_at: deliveredAt }), AFTERCARE)).toBeNull();
    }
    expect(supportUntil(subject({ state: 'delivered', delivered_at: null }), AFTERCARE)).toBeNull();
    expect(supportUntil(subject({ state: 'delivered', delivered_at: 'x' }), AFTERCARE)).toBeNull();
  });

  it('🔴 a delivered purchase is CLOSED to refunds at any moment — told, untold, or long ago', () => {
    // The whole of gs-5 in one assertion. Under gs-3/gs-4 the first of these
    // was open and the second was open FOREVER; both are closed now, and the
    // notice stamp changes nothing.
    const told = subject({ state: 'delivered', delivered_at: deliveredAt, completion_notice_at: noticeAt });
    const untold = subject({ state: 'delivered', delivered_at: deliveredAt, completion_notice_at: null });
    for (const s of [told, untold]) {
      for (const at of [deliveredMs, deliveredMs + 1, deliveredMs + 13 * DAY, deliveredMs + 3650 * DAY]) {
        expect(refundWindow(s, at, P)).toEqual({ open: false, reason: 'completed', closes_at: null });
      }
    }
  });

  it('a delivered row reports the end of support as its next deadline, not null', () => {
    // Answering null would tell the operator queue nothing is pending on a row
    // we still owe two weeks of help on.
    const s = subject({ state: 'delivered', delivered_at: deliveredAt });
    expect(nextDeadlineAt(s, P, AFTERCARE)).toBe(new Date(deliveredMs + 14 * DAY).toISOString());
  });
});

describe('§3 the window before completion, and after a refund', () => {
  it('paid, scheduled AND in_progress are refundable, with no end date', () => {
    // 🔴 in_progress IS IN THIS LIST (gs-5). A setup that has started but has
    // not been confirmed complete is not complete, and the buyer keeps the
    // button until it is.
    for (const state of ['paid', 'scheduled', 'in_progress'] as const) {
      const w = refundWindow(subject({ state }), BOUGHT_MS + 500 * DAY, P);
      expect(w).toEqual({ open: true, reason: 'not_yet_completed', closes_at: null });
    }
  });

  it('a refund already in flight is not refundable, and says so distinctly', () => {
    // 🔴 A SECOND CLICK IS NOT AN ERROR, and it is not the same answer as
    // 「completed」 — the console has to be able to say 「we are already on it」
    // rather than 「too late」.
    expect(refundWindow(subject({ state: 'refund_requested' }), BOUGHT_MS, P)).toMatchObject({
      open: false,
      reason: 'refund_in_flight',
    });
    expect(refundWindow(subject({ state: 'refunded' }), BOUGHT_MS, P)).toMatchObject({
      open: false,
      reason: 'refunded',
    });
  });

  it('a state this build does not know is refused, never guessed', () => {
    const s = subject({ state: 'archived' as unknown as OneTimePurchaseState });
    expect(refundWindow(s, BOUGHT_MS, P)).toMatchObject({ open: false, reason: 'unknown_state' });
  });

  it('closes_at is on the wire and always null — the window shuts on an event, not a date', () => {
    for (const state of ['paid', 'scheduled', 'in_progress', 'delivered', 'refund_requested', 'refunded'] as const) {
      expect(refundWindow(subject({ state }), BOUGHT_MS, P)).toHaveProperty('closes_at', null);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('§4 🔴 the verdict and the SQL claim make the SAME decision', () => {
  // A real database, the real DDL, the real prepared statement. The point is
  // that `refundWindow` is a PROJECTION of the claim's WHERE clause and nothing
  // more — if either is edited alone, this matrix goes red.
  function repoWith(row: Partial<OneTimePurchaseRow>): ReturnType<typeof makeOneTimePurchaseRepo> {
    const db = new DatabaseSync(':memory:');
    db.exec(BILLING_SQL);
    const repo = makeOneTimePurchaseRepo(db);
    repo.recordOneTimePurchase({
      order_id: 'ord_1',
      provider: 'creem',
      user_id: 'u1',
      product_id: 'prod_setup',
      checkout_id: null,
      transaction_id: 'tx_1',
      customer_id: null,
      amount_minor: 20000,
      currency: 'USD',
      state: 'paid',
      early_start_consent_at: BOUGHT,
      withdrawal_waiver_ack_at: BOUGHT,
      consent_terms_version: 'gs-5',
      scheduled_at: null,
      started_at: null,
      delivered_at: null,
      refund_requested_at: null,
      refund_provider_id: null,
      refund_status: null,
      refunded_at: null,
      completion_notice_at: null,
      note: null,
      created_at: BOUGHT,
      ...row,
    });
    return repo;
  }

  const NOW_MS = Date.parse('2026-09-01T00:00:00.000Z');
  const NOW_ISO = new Date(NOW_MS).toISOString();

  // Every shape the window function distinguishes, plus the notice-stamp
  // variants that USED to matter (gs-3/gs-4) and must now not.
  const CASES: { name: string; row: Partial<OneTimePurchaseRow> }[] = [
    { name: 'paid', row: { state: 'paid' } },
    { name: 'scheduled', row: { state: 'scheduled', scheduled_at: BOUGHT } },
    { name: 'in_progress', row: { state: 'in_progress', scheduled_at: BOUGHT, started_at: BOUGHT } },
    {
      name: 'delivered, never notified',
      row: { state: 'delivered', delivered_at: BOUGHT, completion_notice_at: null },
    },
    {
      name: 'delivered, notified yesterday',
      row: {
        state: 'delivered',
        delivered_at: BOUGHT,
        completion_notice_at: new Date(NOW_MS - 1 * DAY).toISOString(),
      },
    },
    {
      name: 'delivered, notified 30 days ago',
      row: {
        state: 'delivered',
        delivered_at: BOUGHT,
        completion_notice_at: new Date(NOW_MS - 30 * DAY).toISOString(),
      },
    },
    {
      name: 'delivered a minute ago, not yet notified',
      row: { state: 'delivered', delivered_at: new Date(NOW_MS - 60_000).toISOString(), completion_notice_at: null },
    },
    { name: 'refund already requested', row: { state: 'refund_requested' } },
    { name: 'refunded', row: { state: 'refunded', refunded_at: BOUGHT } },
  ];

  for (const c of CASES) {
    it(`agrees on: ${c.name}`, () => {
      const repo = repoWith(c.row);
      const row = repo.getOneTimePurchase('ord_1')!;

      const verdict = refundWindow(row, NOW_MS, P);
      const claimed = repo.requestOneTimeRefund(
        'ord_1',
        { requested_at: NOW_ISO, provider_id: null, provider_status: null },
        NOW_ISO,
      );

      // 🔴 THE ASSERTION. Not 「both are reasonable」 — identical.
      expect(claimed === 'claimed').toBe(verdict.open);
    });
  }

  it('🔴 the claim accepts in_progress — the SQL, not only the projection', () => {
    // Stated on its own as well as inside the matrix, because it is the one
    // new row in the state list and the matrix would also pass if BOTH sides
    // forgot it.
    const repo = repoWith({ state: 'in_progress', scheduled_at: BOUGHT, started_at: BOUGHT });
    expect(
      repo.requestOneTimeRefund('ord_1', { requested_at: NOW_ISO, provider_id: null, provider_status: null }, NOW_ISO),
    ).toBe('claimed');
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refund_requested');
  });

  it('🔴 the claim refuses delivered whatever the notice stamp says — the SQL, not only the projection', () => {
    // The old failure direction was `state = 'delivered' AND completion_notice_at
    // IS NULL` ⇒ claimable. Both stamp values are refused now; a verdict that
    // agreed with a claim that accepted either would be two wrongs agreeing.
    for (const notice of [null, new Date(NOW_MS - 1 * DAY).toISOString()]) {
      const repo = repoWith({ state: 'delivered', delivered_at: BOUGHT, completion_notice_at: notice });
      expect(
        repo.requestOneTimeRefund('ord_1', { requested_at: NOW_ISO, provider_id: null, provider_status: null }, NOW_ISO),
        `completion_notice_at=${String(notice)}`,
      ).toBe('not_refundable');
      expect(repo.getOneTimePurchase('ord_1')!.state).toBe('delivered');
    }
  });

  it('and the claim really is atomic: the second caller loses', () => {
    // The double-refund defence, on the shape that would actually happen — two
    // tabs, or a sweep racing an operator. Both read a refundable row; only one
    // UPDATE can match.
    const repo = repoWith({ state: 'paid' });
    const args = { requested_at: NOW_ISO, provider_id: null, provider_status: null };
    expect(repo.requestOneTimeRefund('ord_1', args, NOW_ISO)).toBe('claimed');
    expect(repo.requestOneTimeRefund('ord_1', args, NOW_ISO)).toBe('not_refundable');
  });

  it('the notice stamp is written once and a second send keeps the first date', () => {
    // The record says when the buyer was first told; a re-send must not
    // rewrite that.
    const first = '2026-08-20T00:00:00.000Z';
    const second = '2026-08-25T00:00:00.000Z';
    const repo = repoWith({ state: 'delivered', delivered_at: BOUGHT });
    repo.stampCompletionNotice('ord_1', first, first);
    repo.stampCompletionNotice('ord_1', second, second);
    expect(repo.getOneTimePurchase('ord_1')!.completion_notice_at).toBe(first);
  });

  it('and it refuses to stamp a purchase that is not delivered', () => {
    // Stamping a 'paid' row would record a completion letter for a setup that
    // has not happened.
    const repo = repoWith({ state: 'paid' });
    repo.stampCompletionNotice('ord_1', NOW_ISO, NOW_ISO);
    expect(repo.getOneTimePurchase('ord_1')!.completion_notice_at).toBeNull();
  });

  it('started_at round-trips through the row and is assigned, not coalesced, by advance', () => {
    const repo = repoWith({ state: 'in_progress', scheduled_at: BOUGHT, started_at: BOUGHT });
    expect(repo.getOneTimePurchase('ord_1')!.started_at).toBe(BOUGHT);
    // Walked back to scheduled: the claim 「it began」 is retracted.
    repo.advanceOneTimePurchase(
      'ord_1',
      { state: 'scheduled', scheduled_at: BOUGHT, started_at: null, delivered_at: null, completion_notice_at: null, refunded_at: null },
      NOW_ISO,
    );
    expect(repo.getOneTimePurchase('ord_1')!.started_at).toBeNull();
  });
});

describe('§5 the promise the product actually ships with', () => {
  it('is the one gs-5 is written against', () => {
    // ⚠️ A CHANGE HERE IS A CHANGE TO A CONSUMER CONTRACT (the 14) or to an
    // internal ops flag (the 40); this test is the thing that makes moving one
    // of them a deliberate act rather than a tidy-up. There is no third number:
    // `disputeDays` left with gs-5.
    expect(PROMISED_DEADLINES).toEqual({
      startDeadlineDays: 14,
      completeDeadlineDays: 40,
    });
    expect(GUIDED_SETUP_AFTERCARE_DAYS).toBe(14);
  });
});
