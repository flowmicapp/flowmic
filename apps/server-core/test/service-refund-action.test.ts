// SPEC-REF:
//   src/billing/service-refund.ts (the unit under test)
//   src/billing/subscription-writer.ts (the outbound contract it calls)
//   src/db/repos/one-time-purchase.repo.ts (the claim it makes first)
//
// ASKING FOR A REFUND: the order, and the four ways it ends.
//
// 🔴 THE ORDER IS THE WHOLE SUBJECT. Claim the row, THEN call the provider. Get
// it backwards and two clicks refund one charge twice, which is money we cannot
// get back by apologising. §1 is the test that would go red on that inversion,
// and it does it by watching WHAT THE ROW LOOKED LIKE at the moment the provider
// was called — not by watching the calls in order, which a reordering could
// still satisfy.

import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  REFUND_ORIGINS,
  requestServiceRefund,
  type RefundOrigin,
  type ServiceRefundDeps,
} from '../src/billing/service-refund';
import type { SubscriptionWriter } from '../src/billing/subscription-writer';
import { BILLING_SQL } from '../src/db/schema-billing';
import {
  makeOneTimePurchaseRepo,
  REFUND_RELEASE_REASONS,
  REFUND_RELEASE_TARGETS,
  type OneTimePurchaseRepo,
  type OneTimePurchaseRow,
  type RefundReleaseReason,
  type RefundReleaseTarget,
} from '../src/db/repos/one-time-purchase.repo';
import { PROMISED_DEADLINES } from '../src/billing/guided-setup';

const NOW_MS = Date.parse('2026-09-01T00:00:00.000Z');
const BOUGHT = '2026-08-20T00:00:00.000Z';

function repoWith(over: Partial<OneTimePurchaseRow> = {}): OneTimePurchaseRepo {
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
    ...over,
  });
  return repo;
}

/** A writer that answers however the test says, and records what it was asked. */
function writer(
  answer: Awaited<ReturnType<SubscriptionWriter['createRefund']>>,
  onCall?: () => void,
): SubscriptionWriter & { calls: { transaction_id: string; reason: string }[] } {
  const calls: { transaction_id: string; reason: string }[] = [];
  return {
    provider: 'creem',
    calls,
    createRefund: vi.fn(async (input: { transaction_id: string; reason: string }) => {
      calls.push(input);
      onCall?.();
      return answer;
    }),
  } as unknown as SubscriptionWriter & { calls: { transaction_id: string; reason: string }[] };
}

const OK = { ok: true as const, data: { id: 'ref_1', status: 'pending' } };

function deps(repo: OneTimePurchaseRepo, w: SubscriptionWriter): ServiceRefundDeps {
  return { purchases: repo, writer: w, deadlines: PROMISED_DEADLINES, now: () => NOW_MS };
}

describe('§1 🔴 the row is claimed BEFORE the provider is called', () => {
  it('the provider is called with the row already in refund_requested', () => {
    // The assertion that survives a reordering: we read the row FROM INSIDE the
    // provider call. If the claim moved after the call, this reads 'paid'.
    const repo = repoWith();
    let stateAtCallTime: string | null = null;
    const w = writer(OK, () => {
      stateAtCallTime = repo.getOneTimePurchase('ord_1')?.state ?? null;
    });
    return requestServiceRefund(deps(repo, w), 'ord_1', 'customer_withdrawal').then((out) => {
      expect(out).toEqual({ ok: true, providerStatus: 'pending' });
      expect(stateAtCallTime).toBe('refund_requested');
    });
  });

  it('so a second caller never reaches the provider at all', async () => {
    // Two tabs. The claim is a conditional UPDATE, so exactly one wins — and the
    // loser must not spend a network call finding that out, because a provider
    // that accepted it would have refunded the same charge twice.
    const repo = repoWith();
    const w = writer(OK);
    await requestServiceRefund(deps(repo, w), 'ord_1', 'customer_withdrawal');
    const second = await requestServiceRefund(deps(repo, w), 'ord_1', 'operator');
    expect(second).toEqual({ ok: false, reason: 'not_refundable' });
    expect(w.calls).toHaveLength(1);
  });
});

describe('§2 what it records, and what it refuses to record', () => {
  it('stamps the provider id and its word VERBATIM, and never writes refunded', () => {
    const repo = repoWith();
    const w = writer({ ok: true, data: { id: 'ref_xyz', status: 'pending' } });
    return requestServiceRefund(deps(repo, w), 'ord_1', 'operator').then(() => {
      const row = repo.getOneTimePurchase('ord_1')!;
      expect(row.state).toBe('refund_requested');
      expect(row.refund_provider_id).toBe('ref_xyz');
      // 🔴 'pending' IS NOT ROUNDED UP. Creem answers it even for a refund its
      // own transaction already shows as refunded, so treating it as
      // confirmation would tell a consumer their money is back when nobody said
      // so. The webhook owns 'refunded'.
      expect(row.refund_status).toBe('pending');
      expect(row.refunded_at).toBeNull();
      expect(row.state).not.toBe('refunded');
    });
  });

  it('🔴 the reason sent to the provider is OURS, from the closed origin set', async () => {
    // It lands in a vendor's dashboard. A free-text box here is how a customer's
    // own words end up somewhere they never agreed to send them.
    const repo = repoWith();
    const w = writer(OK);
    await requestServiceRefund(deps(repo, w), 'ord_1', 'deadline_no_start');
    expect(w.calls[0]).toEqual({ transaction_id: 'tx_1', reason: 'deadline_no_start' });
  });

  it('refuses a purchase with no charge on it, by its own name', async () => {
    // `POST /v1/refunds` takes a transaction id and nothing else, so this is not
    // a generic failure — it is 「go and look」, and it says so distinctly.
    const repo = repoWith({ transaction_id: null });
    const w = writer(OK);
    expect(await requestServiceRefund(deps(repo, w), 'ord_1', 'operator')).toEqual({
      ok: false,
      reason: 'no_transaction',
    });
    expect(w.calls).toHaveLength(0);
    // And it did NOT claim the row on the way past.
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('paid');
  });

  it('an unknown order is not_refundable rather than a crash', async () => {
    const repo = repoWith();
    const w = writer(OK);
    expect(await requestServiceRefund(deps(repo, w), 'ord_missing', 'operator')).toEqual({
      ok: false,
      reason: 'not_refundable',
    });
    expect(w.calls).toHaveLength(0);
  });
});

describe('§3 ⚠️ when the provider refuses, the row STAYS claimed', () => {
  it('and that is the stated cost of the ordering, not an oversight', async () => {
    // The alternative — releasing the claim — reopens the double-refund window
    // at exactly the moment we are least sure what the provider did with the
    // first request. So it fails VISIBLY instead: the purchase sits in the
    // operator queue as refund_requested with a null provider status, which is
    // 「we asked and heard nothing」 and is distinguishable from 「it answered」.
    const repo = repoWith();
    const w = writer({ ok: false, code: 'PROVIDER_UNREACHABLE', detail: 'socket hang up' });
    const out = await requestServiceRefund(deps(repo, w), 'ord_1', 'customer_withdrawal');
    expect(out).toMatchObject({ ok: false, reason: 'provider_refused' });
    const row = repo.getOneTimePurchase('ord_1')!;
    expect(row.state).toBe('refund_requested');
    expect(row.refund_requested_at).not.toBeNull();
    expect(row.refund_status).toBeNull();
    expect(row.refund_provider_id).toBeNull();
  });

  it('and it carries the provider code so the two failures stay distinguishable', async () => {
    // 「we could not reach it」 and 「it said no」 are different problems with
    // different next moves, and flattening them is how one gets retried forever.
    const repo = repoWith();
    const w = writer({ ok: false, code: 'PROVIDER_REJECTED', detail: 'already refunded' });
    const out = await requestServiceRefund(deps(repo, w), 'ord_1', 'operator');
    expect(out).toMatchObject({ reason: 'provider_refused' });
    if (out.ok === false && out.reason === 'provider_refused') {
      expect(out.detail).toContain('PROVIDER_REJECTED');
    }
  });
});

describe('§4 gs-5: completion closes the refund, and starting does not', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('🔴 a setup that has BEGUN is still refundable — in_progress reaches the claim', async () => {
    // owner 2026-08-30: a full refund is available while state ∈ {paid,
    // scheduled, in_progress}. A setup that has started is not complete.
    const repo = repoWith({ state: 'in_progress', scheduled_at: BOUGHT, started_at: BOUGHT });
    const w = writer(OK);
    expect(await requestServiceRefund(deps(repo, w), 'ord_1', 'customer_withdrawal')).toMatchObject({
      ok: true,
    });
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refund_requested');
  });

  it('🔴 a delivered purchase is NOT refundable — even one we told about only yesterday', async () => {
    // Under gs-3/gs-4 this row was inside a fortnight and the claim matched.
    // gs-5 closes the refund at confirmed completion; the notice date is a
    // record and moves nothing.
    const repo = repoWith({
      state: 'delivered',
      delivered_at: BOUGHT,
      completion_notice_at: new Date(NOW_MS - 1 * DAY).toISOString(),
    });
    const w = writer(OK);
    expect(await requestServiceRefund(deps(repo, w), 'ord_1', 'customer_withdrawal')).toEqual({
      ok: false,
      reason: 'not_refundable',
    });
    expect(w.calls).toHaveLength(0);
  });

  it('🔴 and NOT refundable when we never sent the email either — the null is a duty, not a right', async () => {
    // The gs-3 failure direction (NULL ⇒ open forever) is gone on purpose: a
    // mail outage is ours to chase by hand, not a reason to reopen money.
    const repo = repoWith({
      state: 'delivered',
      delivered_at: BOUGHT,
      completion_notice_at: null,
    });
    const w = writer(OK);
    expect(await requestServiceRefund(deps(repo, w), 'ord_1', 'customer_withdrawal')).toEqual({
      ok: false,
      reason: 'not_refundable',
    });
    expect(w.calls).toHaveLength(0);
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('delivered');
  });
});

describe('§5 the origins a refund can carry are exactly three', () => {
  it('🔴 customer, operator, no-start deadline — and nothing for a completion deadline', () => {
    // owner 2026-08-30 (evening) removed the completion deadline from the
    // product, and with it the origin a sweep used to stamp on that refund.
    // The table is a `Record<RefundOrigin, true>`, so the union and this list
    // cannot drift apart without a compile error; this test is what makes a
    // fourth member a deliberate act rather than a tidy-up.
    expect([...REFUND_ORIGINS].sort()).toEqual(
      (['customer_withdrawal', 'deadline_no_start', 'operator'] as const satisfies readonly RefundOrigin[]).slice(),
    );
    expect(REFUND_ORIGINS).toHaveLength(3);
    expect(REFUND_ORIGINS).not.toContain('deadline_not_completed');
  });

  it('🔴 a RELEASE REASON is not a fourth origin, and the two unions never meet', () => {
    // 2026-08-31. An ORIGIN says why a refund was ASKED for and is handed to the
    // payment provider; a RELEASE REASON says why one stopped being asked for
    // and is read by the deadline sweep. Merging them would give the provider
    // call a word it must never carry, and would give an unattended timer a
    // value chosen for a vendor dashboard.
    for (const r of REFUND_RELEASE_REASONS) {
      expect(REFUND_ORIGINS as readonly string[]).not.toContain(r);
    }
    for (const o of REFUND_ORIGINS) {
      expect(REFUND_RELEASE_REASONS as readonly string[]).not.toContain(o);
    }
  });
});

describe('§6 the release reasons and targets are exactly these', () => {
  it('🔴 two reasons, and each one means a different thing to the sweep', () => {
    // Same instrument as §5 and for the same reason: the table is a
    // `Record<RefundReleaseReason, true>`, so the union and the list cannot
    // drift apart without a compile error, and this is what makes a THIRD
    // member a deliberate act rather than a tidy-up.
    //
    // 🔴 WHOEVER ADDS ONE OWES AN ANSWER TO ONE QUESTION: does the unattended
    // 14-day no-start sweep still run on a row released for that reason?
    // §6 of test/service-deadlines.test.ts is where that answer has to be
    // written down, and the two existing members answer it in opposite
    // directions — which is the whole reason this is a union and not a boolean.
    expect([...REFUND_RELEASE_REASONS].sort()).toEqual(
      (['buyer_withdrew_request', 'provider_declined'] as const satisfies readonly RefundReleaseReason[]).slice(),
    );
    expect(REFUND_RELEASE_REASONS).toHaveLength(2);
  });

  it("🔴 'delivered' and 'refunded' are not release targets", () => {
    expect([...REFUND_RELEASE_TARGETS].sort()).toEqual(
      (['in_progress', 'paid', 'scheduled'] as const satisfies readonly RefundReleaseTarget[]).slice(),
    );
    // The two absences the design turns on, asserted rather than assumed:
    // delivery is a separate visible action, and 'refunded' is a claim about
    // money that needs the external reference standing behind it.
    expect(REFUND_RELEASE_TARGETS as readonly string[]).not.toContain('delivered');
    expect(REFUND_RELEASE_TARGETS as readonly string[]).not.toContain('refunded');
    expect(REFUND_RELEASE_TARGETS as readonly string[]).not.toContain('refund_requested');
  });
});

describe('§7 🔴 a late webhook still lands on a row that was released back', () => {
  // THE PROPERTY THAT MAKES RELEASING SAFE, and it is a property of a function
  // NOBODY IS EDITING in this round — which is exactly why it is pinned here.
  // `confirmOneTimeRefund` is deliberately NOT conditioned on the prior state
  // (its own interface argues why: a refund issued from the provider's own
  // dashboard never passes through our route). The release path leans on that:
  // an operator who releases a stuck request has NOT made the provider's answer
  // unrecordable, so a webhook arriving an hour, a day or a week later still
  // writes 'refunded' and the buyer's console stops offering to withdraw money
  // that has already gone back.
  //
  // 🔴 IF SOMEBODY EVER ADDS "WHERE state = 'refund_requested'" TO THAT UPDATE
  // — which reads like tightening — these assertions go red, and that red is
  // the whole point: without it the release path would quietly turn a real
  // refund into an unrecordable one.
  function releasedRow(reason: RefundReleaseReason): OneTimePurchaseRepo {
    const repo = repoWith();
    expect(
      repo.requestOneTimeRefund('ord_1', { requested_at: BOUGHT, provider_id: null, provider_status: null }, BOUGHT),
    ).toBe('claimed');
    expect(repo.releaseOneTimeRefundRequest('ord_1', { to_state: 'paid', reason, released_at: BOUGHT }, BOUGHT)).toBe(
      'released',
    );
    return repo;
  }

  for (const reason of ['provider_declined', 'buyer_withdrew_request'] as const) {
    it(`lands on a row released as '${reason}'`, () => {
      const repo = releasedRow(reason);
      expect(repo.getOneTimePurchase('ord_1')!.state).toBe('paid');
      expect(
        repo.confirmOneTimeRefund(
          'ord_1',
          { refunded_at: '2026-09-02T00:00:00.000Z', provider_id: 'ref_1', provider_status: 'succeeded' },
          '2026-09-02T00:00:00.000Z',
        ),
      ).toBe('confirmed');
      const row = repo.getOneTimePurchase('ord_1')!;
      expect(row.state).toBe('refunded');
      expect(row.refunded_at).toBe('2026-09-02T00:00:00.000Z');
      expect(row.refund_provider_id).toBe('ref_1');
      // ⚠️ THE RELEASE RECORD SURVIVES. The row now says both true things: a
      // human released the request, and the provider paid anyway. Erasing
      // either would make one of them unanswerable.
      expect(row.refund_release_reason).toBe(reason);
      expect(row.refund_released_at).toBe(BOUGHT);
      // …and it did NOT invent an external reference. That column is the mark
      // of a HUMAN-asserted refund; this one came from the provider.
      expect(row.refund_external_reference).toBeNull();
    });
  }

  it('lands on a delivered row too — the negative control for the pin above', () => {
    // If the two assertions above were green merely because 'paid' happens to
    // be allowed by some new condition, this one would be red. It is the same
    // property seen from a state the release path can never produce.
    const repo = repoWith({ state: 'delivered', delivered_at: BOUGHT });
    expect(
      repo.confirmOneTimeRefund(
        'ord_1',
        { refunded_at: '2026-09-02T00:00:00.000Z', provider_id: 'ref_2', provider_status: 'succeeded' },
        '2026-09-02T00:00:00.000Z',
      ),
    ).toBe('confirmed');
    expect(repo.getOneTimePurchase('ord_1')!.state).toBe('refunded');
  });

  it("and an order that does not exist is still 'unknown_order', not a silent no-op", () => {
    expect(
      repoWith().confirmOneTimeRefund(
        'nope',
        { refunded_at: '2026-09-02T00:00:00.000Z', provider_id: null, provider_status: null },
        '2026-09-02T00:00:00.000Z',
      ),
    ).toBe('unknown_order');
  });
});
