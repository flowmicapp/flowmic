// SPEC-REF:
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts (the four UPDATEs
//     this file pins — requestOneTimeRefund, settleOneTimeRefundByHand,
//     releaseOneTimeRefundRequest, advanceOneTimePurchase)
//   apps/server-core/src/billing/service-refund.ts (the claim-first caller that
//     depends on requestOneTimeRefund's atomicity — its own header names this
//     file as where that dependency is pinned at the SQL layer)
//   apps/server-core/src/http/ops-refund-release-routes.ts (the caller that
//     depends on the middle two — its 409-on-race path assumes exactly one of
//     two racing operator tabs can ever win the write)
//   apps/server-core/src/http/ops-purchase-routes.ts (the caller that depends
//     on advanceOneTimePurchase — same assumption, added 2026-09-02 audit P1)
//
// 2026-09-02 audit P2 — double-refund protection was argued from the SERVICE
// layer (service-refund-action.test.ts §1: "so a second caller never reaches
// the provider at all") and from prose in every one of these methods'
// interface comments ("THE STATE TEST IS INSIDE THE UPDATE... which is why
// this returns whether it won"), but the repo's own SQL had never been read as
// part of that audit, and nothing pinned the property directly at the layer
// where it actually lives.
//
// 🔴 WHAT "ATOMIC" MEANS HERE, PRECISELY. `node:sqlite`'s `DatabaseSync` is
// synchronous and single-threaded — there is no OS thread race to construct in
// this test, and pretending to build one with `Promise.all` would prove
// nothing (the two calls would still run strictly in sequence). What IS real,
// and what this file actually pins, is that each of these four methods
// compiles to a SINGLE UPDATE whose WHERE clause carries the entire state
// test: `db.prepare` runs once at module load, `.run()` executes it whole, and
// there is no "read the row, decide in JS, write" step for a second caller's
// write to land between. Calling a method a second time against the same row
// is therefore the CORRECT simulation of "a second caller's write, submitted
// after the first was already committed" — which is exactly the shape SQLite
// serialises concurrent writers into. If any of these four were ever
// rewritten as a read in application code followed by a plain UPDATE, this
// file would still pass (JS is single-threaded too) — that is a known limit of
// testing atomicity from inside one process, not a claim this file makes.
//
// ✅ 2026-09-02 audit P1, CORRECTING THE PARAGRAPH THIS REPLACES —
// `advanceOneTimePurchase` IS now covered here (§4 below). It used to have no
// state precondition at all (`WHERE order_id = ?` only), which was a real,
// structurally different gap from a refund claim: it is a delivery-state
// transition that can legally start from several states, not one fixed
// literal, so its precondition is a caller-supplied `expected_state` rather
// than a value baked into the SQL the way 'refund_requested' is for the other
// three. The fix and the caller-side half (ops-purchase-routes.ts's own audit
// row on a lost race) are this same branch's other two commits.

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { BILLING_SQL } from '../src/db/schema-billing';
import { makeOneTimePurchaseRepo, type OneTimePurchaseRepo } from '../src/db/repos/one-time-purchase.repo';

const BOUGHT = '2026-08-20T00:00:00.000Z';
const LATER = '2026-08-21T00:00:00.000Z';

function repoWithPaidOrder(): OneTimePurchaseRepo {
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
    customer_id: 'cus_1',
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
  });
  return repo;
}

describe('one-time-purchase repo: the claim/settle/release UPDATEs are single conditional statements', () => {
  it('requestOneTimeRefund — two claims against one paid row: exactly one wins', () => {
    const repo = repoWithPaidOrder();
    const first = repo.requestOneTimeRefund(
      'ord_1',
      { requested_at: BOUGHT, provider_id: null, provider_status: null },
      BOUGHT,
    );
    const second = repo.requestOneTimeRefund(
      'ord_1',
      { requested_at: LATER, provider_id: null, provider_status: null },
      LATER,
    );
    expect(first).toBe('claimed');
    expect(second).toBe('not_refundable');
    // The loser's write did not partially land either — the row carries the
    // WINNER's timestamp, not the loser's. A mixed write would be worse than a
    // rejected one: it would look like it worked.
    const row = repo.getOneTimePurchase('ord_1')!;
    expect(row.state).toBe('refund_requested');
    expect(row.refund_requested_at).toBe(BOUGHT);
  });

  it('settleOneTimeRefundByHand — two hand-settles against one claimed row: exactly one wins', () => {
    const repo = repoWithPaidOrder();
    expect(
      repo.requestOneTimeRefund(
        'ord_1',
        { requested_at: BOUGHT, provider_id: null, provider_status: null },
        BOUGHT,
      ),
    ).toBe('claimed');
    const first = repo.settleOneTimeRefundByHand(
      'ord_1',
      { refunded_at: LATER, external_reference: 'wire-1' },
      LATER,
    );
    const second = repo.settleOneTimeRefundByHand(
      'ord_1',
      { refunded_at: LATER, external_reference: 'wire-2' },
      LATER,
    );
    expect(first).toBe('settled');
    expect(second).toBe('not_requested');
    // The second operator's reference never lands — two different external
    // references both claiming to be THE record of the same money moving once
    // would be unreadable a year later.
    const row = repo.getOneTimePurchase('ord_1')!;
    expect(row.state).toBe('refunded');
    expect(row.refund_external_reference).toBe('wire-1');
  });

  it('releaseOneTimeRefundRequest — two releases against one claimed row: exactly one wins', () => {
    const repo = repoWithPaidOrder();
    expect(
      repo.requestOneTimeRefund(
        'ord_1',
        { requested_at: BOUGHT, provider_id: null, provider_status: null },
        BOUGHT,
      ),
    ).toBe('claimed');
    const first = repo.releaseOneTimeRefundRequest(
      'ord_1',
      { to_state: 'paid', reason: 'provider_declined', released_at: LATER },
      LATER,
    );
    const second = repo.releaseOneTimeRefundRequest(
      'ord_1',
      { to_state: 'scheduled', reason: 'buyer_withdrew_request', released_at: LATER },
      LATER,
    );
    expect(first).toBe('released');
    expect(second).toBe('not_requested');
    // The second operator's target and reason never land — the deadline sweep
    // has to read the FIRST operator's decision, not a coin flip between two
    // people's answers typed a moment apart.
    const row = repo.getOneTimePurchase('ord_1')!;
    expect(row.state).toBe('paid');
    expect(row.refund_release_reason).toBe('provider_declined');
  });
});

describe('§4 🔴 2026-09-02 audit P1 — advanceOneTimePurchase is now conditional too', () => {
  it('two advances against one scheduled row: exactly one wins', () => {
    const repo = repoWithPaidOrder();
    expect(
      repo.advanceOneTimePurchase(
        'ord_1',
        {
          expected_state: 'paid',
          state: 'scheduled',
          scheduled_at: BOUGHT,
          started_at: null,
          delivered_at: null,
          completion_notice_at: null,
          refunded_at: null,
        },
        BOUGHT,
      ),
    ).toBe('advanced');
    // Two operator tabs, both having read 'scheduled' a moment apart, both
    // move it to 'in_progress' — the shape a double-click or two open tabs
    // produces. Both pass `expected_state: 'scheduled'`, exactly what each
    // tab's own read told it was true.
    const first = repo.advanceOneTimePurchase(
      'ord_1',
      {
        expected_state: 'scheduled',
        state: 'in_progress',
        scheduled_at: BOUGHT,
        started_at: LATER,
        delivered_at: null,
        completion_notice_at: null,
        refunded_at: null,
        note: 'tab A',
      },
      LATER,
    );
    const second = repo.advanceOneTimePurchase(
      'ord_1',
      {
        expected_state: 'scheduled',
        state: 'in_progress',
        scheduled_at: BOUGHT,
        started_at: LATER,
        delivered_at: null,
        completion_notice_at: null,
        refunded_at: null,
        note: 'tab B',
      },
      LATER,
    );
    expect(first).toBe('advanced');
    // 🔴 THIS IS THE LINE THAT WAS WRONG BEFORE THE FIX: with no state
    // precondition in the SQL, the second call also reported success and its
    // note silently overwrote the first tab's, with nothing anywhere saying
    // two operators had just raced on the same order.
    expect(second).toBe('not_applied');
    const row = repo.getOneTimePurchase('ord_1')!;
    expect(row.state).toBe('in_progress');
    // The second tab's note never lands — same "the loser's write does not
    // partially land" property the other three methods pin above.
    expect(row.note).toBe('tab A');
  });

  it('a stale expected_state refuses even when the target state itself is legal', () => {
    // The row actually left 'paid' for 'delivered' a moment ago (a webhook,
    // or another tab). A caller still holding a 'paid' read tries to schedule
    // it — the target ('scheduled') is a state this repo can reach, but not
    // from where the row NOW is, and the precondition is what catches that a
    // plain `WHERE order_id = ?` cannot.
    const repo = repoWithPaidOrder();
    expect(
      repo.advanceOneTimePurchase(
        'ord_1',
        {
          expected_state: 'paid',
          state: 'delivered',
          scheduled_at: null,
          started_at: null,
          delivered_at: BOUGHT,
          completion_notice_at: null,
          refunded_at: null,
        },
        BOUGHT,
      ),
    ).toBe('advanced');
    const outcome = repo.advanceOneTimePurchase(
      'ord_1',
      {
        expected_state: 'paid',
        state: 'scheduled',
        scheduled_at: LATER,
        started_at: null,
        delivered_at: null,
        completion_notice_at: null,
        refunded_at: null,
      },
      LATER,
    );
    expect(outcome).toBe('not_applied');
    // The delivery stands untouched — a stale precondition must not clear
    // stamps that already recorded a real event.
    const row = repo.getOneTimePurchase('ord_1')!;
    expect(row.state).toBe('delivered');
    expect(row.delivered_at).toBe(BOUGHT);
  });
});
