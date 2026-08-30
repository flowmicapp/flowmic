// SPEC-REF:
//   apps/server-core/src/billing/creem/subscription-client.ts (under test)
//   apps/server-core/src/billing/subscription-writer.ts (the contract)
//   docs/strategy/2026-08-29-creem-stage0-findings.md §2b (the live probes)
//
// Creem's outbound half.
//
// ⚠️ WHAT THESE TESTS CAN AND CANNOT SHOW. They drive a fake `fetch`, so they
// prove what we SEND and how we read what comes back — they cannot prove that
// Creem behaves the way the fixtures say. That half was established by live
// probes against test-api.creem.io and is recorded in the findings document;
// the fixtures below are transcriptions of those responses, not inventions.
// This distinction is the reason this repo does not treat 「the adapter tests
// are green」 as evidence about a vendor.

import { describe, expect, it } from 'vitest';
import { createCreemSubscriptionClient } from '../src/billing/creem/subscription-client';
import { CreemWritesDisabledError } from '../src/billing/creem/client';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function harness(
  responder: (call: Call) => { status: number; body: unknown } | 'network-error' | 'timeout',
  over: { writeEnabled?: boolean; apiKey?: string | null; customerId?: string | null } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = responder(call);
    if (r === 'network-error') throw new TypeError('fetch failed');
    if (r === 'timeout') {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const client = createCreemSubscriptionClient({
    apiKey: over.apiKey === undefined ? 'creem_test_key' : over.apiKey,
    env: 'test',
    writeEnabled: over.writeEnabled ?? true,
    lookup: { customerIdFor: () => (over.customerId === undefined ? 'cus_1' : over.customerId) },
    fetchImpl,
  });
  return { client, calls };
}

/** A subscription payload, in the shape the live API returned. */
const SUB = (status: string) => ({
  id: 'sub_1',
  status,
  current_period_end_date: '2026-09-30T00:00:00.000Z',
});

describe('cancel', () => {
  it('sends the enum value Creem validates, per mode', async () => {
    // 🔴 PROBED: a third value is refused with 「mode must be a valid enum
    // value」, so getting this wrong fails loudly at the API rather than
    // silently defaulting — but only if we send the right two, which is what
    // this pins.
    const a = harness(() => ({ status: 200, body: SUB('scheduled_cancel') }));
    await a.client.cancelSubscription('sub_1', 'next_billing_period');
    expect(a.calls[0]?.body).toEqual({ mode: 'scheduled' });

    const b = harness(() => ({ status: 200, body: SUB('canceled') }));
    await b.client.cancelSubscription('sub_1', 'immediately');
    expect(b.calls[0]?.body).toEqual({ mode: 'immediate' });
  });

  it('hits the probed path and reports a scheduled cancellation as one', async () => {
    const { client, calls } = harness(() => ({ status: 200, body: SUB('scheduled_cancel') }));
    const out = await client.cancelSubscription('sub_1', 'next_billing_period');
    expect(calls[0]?.url).toBe('https://test-api.creem.io/v1/subscriptions/sub_1/cancel');
    expect(out).toEqual({
      ok: true,
      data: {
        status: 'scheduled_cancel',
        // ⚠️ DERIVED from the status, because Creem has no scheduled-change
        // field — it expresses a booked cancellation as a status value.
        scheduled_change: { action: 'cancel', effective_at: '2026-09-30T00:00:00.000Z' },
      },
    });
  });

  it('an active subscription reports NO scheduled change', async () => {
    const { client } = harness(() => ({ status: 200, body: SUB('active') }));
    const out = await client.cancelSubscription('sub_1', 'next_billing_period');
    expect(out.ok && out.data.scheduled_change).toBeNull();
  });
});

describe('clearScheduledChange — the undocumented dependency', () => {
  it('🔴 PINS that we call `resume`, which no document promises does this', async () => {
    // SKILL.md and the API reference both describe `resume` as the partner of
    // `pause`. It nonetheless clears a scheduled cancellation today (probed:
    // scheduled_cancel → resume → active). We depend on that, so it is pinned
    // here rather than trusted — the day Creem changes it, this test is what
    // says which of our behaviours was resting on it.
    const { client, calls } = harness(() => ({ status: 200, body: SUB('active') }));
    const out = await client.clearScheduledChange('sub_1');
    expect(calls[0]?.url).toBe('https://test-api.creem.io/v1/subscriptions/sub_1/resume');
    expect(calls[0]?.method).toBe('POST');
    expect(out.ok && out.data.status).toBe('active');
    expect(out.ok && out.data.scheduled_change).toBeNull();
  });
});

describe('findRefundableTransaction', () => {
  const txn = (over: Record<string, unknown>) => ({
    id: 'tran_1',
    amount: 1400,
    currency: 'USD',
    status: 'paid',
    refunded_amount: null,
    subscription: 'sub_1',
    ...over,
  });

  it('searches by CUSTOMER, because Creem refuses a subscription filter', async () => {
    // 🔴 PROBED: `?subscription_id=` comes back 400 「property subscription_id
    // should not exist」, while `?customer_id=` is 200. The client-side match is
    // a constraint of the API, not a shortcut.
    const { client, calls } = harness(() => ({ status: 200, body: { items: [txn({})] } }));
    const out = await client.findRefundableTransaction('sub_1');
    expect(calls[0]?.url).toContain('customer_id=cus_1');
    expect(calls[0]?.url).not.toContain('subscription_id=');
    expect(out).toEqual({ ok: true, data: { found: { id: 'tran_1', amount_minor: 1400, currency: 'USD' } } });
  });

  it('ignores charges on OTHER subscriptions of the same customer', async () => {
    // The reason the client-side match cannot be skipped: one customer may hold
    // more than one subscription, and refunding the wrong one is money.
    const { client } = harness(() => ({
      status: 200,
      body: { items: [txn({ id: 'tran_other', subscription: 'sub_2' })] },
    }));
    const out = await client.findRefundableTransaction('sub_1');
    expect(out.ok && out.data.found).toBeNull();
  });

  it('ignores a charge that was already refunded', async () => {
    const { client } = harness(() => ({
      status: 200,
      body: { items: [txn({ refunded_amount: 1400 })] },
    }));
    const out = await client.findRefundableTransaction('sub_1');
    expect(out.ok && out.data.found).toBeNull();
  });

  it('ignores a charge that is not paid', async () => {
    const { client } = harness(() => ({ status: 200, body: { items: [txn({ status: 'pending' })] } }));
    const out = await client.findRefundableTransaction('sub_1');
    expect(out.ok && out.data.found).toBeNull();
  });

  it('picks the LARGEST eligible charge, not whichever came back first', async () => {
    // Creem does not promise an ordering, so an implementation that took
    // `items[0]` would make the refunded amount depend on page order.
    const { client } = harness(() => ({
      status: 200,
      body: { items: [txn({ id: 'tran_small', amount: 600 }), txn({ id: 'tran_big', amount: 2000 })] },
    }));
    const out = await client.findRefundableTransaction('sub_1');
    expect(out.ok && out.data.found?.id).toBe('tran_big');
  });

  it('nothing to refund is `found: null` and NOT a failure', async () => {
    const { client } = harness(() => ({ status: 200, body: { items: [] } }));
    const out = await client.findRefundableTransaction('sub_1');
    expect(out).toEqual({ ok: true, data: { found: null } });
  });

  it('🔴 「we have no customer id」 is a FAILURE, not `found: null`', async () => {
    // The two are different answers and the caller records them under different
    // states — one is a normal outcome, the other is work a human must finish.
    // Collapsing them would file a customer who is owed money as 「nothing due」.
    const { client, calls } = harness(() => ({ status: 200, body: { items: [] } }), { customerId: null });
    const out = await client.findRefundableTransaction('sub_1');
    expect(out.ok).toBe(false);
    // And it does not go asking Creem a question it cannot form.
    expect(calls).toHaveLength(0);
  });
});

describe('createRefund', () => {
  it('sends only the transaction id — the API is full-refund-only', async () => {
    const { client, calls } = harness(() => ({ status: 200, body: { id: 'ref_1', status: 'pending' } }));
    await client.createRefund({ transaction_id: 'tran_1', reason: 'statutory_withdrawal' });
    expect(calls[0]?.url).toBe('https://test-api.creem.io/v1/refunds');
    expect(calls[0]?.body).toEqual({ transaction_id: 'tran_1' });
  });

  it('🔴 carries the provider status VERBATIM and never flattens it', async () => {
    // MEASURED: this comes back `pending` for a refund the transaction itself
    // already shows as `refunded`. Creem's own schema documents `pending` and
    // `requiresAction` as non-terminal. An earlier design note claimed only
    // Paddle needed the word carried; it was wrong for both, and the direction
    // it fails in is telling a customer exercising a statutory right that their
    // money is back when it is not.
    const { client } = harness(() => ({ status: 200, body: { id: 'ref_1', status: 'pending' } }));
    const out = await client.createRefund({ transaction_id: 'tran_1', reason: 'statutory_withdrawal' });
    expect(out).toEqual({ ok: true, data: { id: 'ref_1', status: 'pending' } });
  });

  it('a 200 we cannot read is NOT a success', async () => {
    const { client } = harness(() => ({ status: 200, body: { id: 'ref_1' } }));
    const out = await client.createRefund({ transaction_id: 'tran_1', reason: 'x' });
    expect(out.ok).toBe(false);
  });
});

describe('🔴 the normalised failure vocabulary', () => {
  it('a timeout is PROVIDER_UNREACHABLE —「we do not know」', async () => {
    // THE TEST THIS WHOLE ADAPTER LAYER EXISTS FOR. billing-routes.ts branches
    // on this string to choose between 「we could not confirm it」 and 「the
    // provider refused it」, and those are not interchangeable: a timeout can
    // land after the provider already committed. Before normalisation this
    // returned CREEM_UNREACHABLE, the route compared against the Paddle literal,
    // and every Creem timeout was reported as a definite refusal — with nothing
    // red, because a string comparison that never matches is invisible.
    const { client } = harness(() => 'timeout');
    const out = await client.cancelSubscription('sub_1', 'immediately');
    expect(out).toMatchObject({ ok: false, code: 'PROVIDER_UNREACHABLE' });
  });

  it('a dropped connection is PROVIDER_UNREACHABLE too', async () => {
    const { client } = harness(() => 'network-error');
    const out = await client.clearScheduledChange('sub_1');
    expect(out).toMatchObject({ ok: false, code: 'PROVIDER_UNREACHABLE' });
  });

  it('an HTTP refusal is PROVIDER_REJECTED —「it answered and said no」', async () => {
    const { client } = harness(() => ({ status: 400, body: { message: 'Subscription does not exist' } }));
    const out = await client.cancelSubscription('sub_1', 'immediately');
    expect(out).toMatchObject({ ok: false, code: 'PROVIDER_REJECTED' });
  });

  it('⚠️ never quotes the vendor message — it can name a customer', async () => {
    const { client } = harness(() => ({
      status: 400,
      body: { message: 'customer alice@example.com is not eligible', trace_id: 't1' },
    }));
    const out = await client.cancelSubscription('sub_1', 'immediately');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.detail).not.toContain('@');
    expect(out.ok === false && out.detail).not.toContain('t1');
  });
});

describe('🔴 the write switch throws rather than answering `{ok:false}`', () => {
  it('writes off ⇒ CreemWritesDisabledError, and nothing is sent', async () => {
    // A failure result reads as 「the provider said no」 and invites a retry; a
    // disabled deployment will never succeed no matter how often it is retried.
    // billing-routes.ts catches this by TYPE and answers 503, which sends an
    // operator to our own configuration rather than to Creem's status page.
    const { client, calls } = harness(() => ({ status: 200, body: SUB('active') }), { writeEnabled: false });
    await expect(client.cancelSubscription('sub_1', 'immediately')).rejects.toBeInstanceOf(
      CreemWritesDisabledError,
    );
    expect(calls).toHaveLength(0);
  });

  it('an empty api key throws the same way, and says which one is missing', async () => {
    const { client, calls } = harness(() => ({ status: 200, body: SUB('active') }), { apiKey: '' });
    await expect(client.createRefund({ transaction_id: 't', reason: 'r' })).rejects.toThrow(
      /FLOWMIC_CREEM_API_KEY/,
    );
    expect(calls).toHaveLength(0);
  });
});
