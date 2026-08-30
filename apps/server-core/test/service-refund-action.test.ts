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
import { requestServiceRefund, type ServiceRefundDeps } from '../src/billing/service-refund';
import type { SubscriptionWriter } from '../src/billing/subscription-writer';
import { BILLING_SQL } from '../src/db/schema-billing';
import {
  makeOneTimePurchaseRepo,
  type OneTimePurchaseRepo,
  type OneTimePurchaseRow,
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
