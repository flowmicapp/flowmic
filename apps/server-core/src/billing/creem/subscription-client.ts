// SPEC-REF:
//   apps/server-core/src/billing/subscription-writer.ts (the contract)
//   apps/server-core/src/billing/creem/client.ts (the checkout half + transport)
//   docs/strategy/2026-08-29-creem-stage0-findings.md §2b (the live probes every
//     endpoint and enum value below was measured with)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Creem's side of `SubscriptionWriter`: cancel, undo, find, refund, read.
//
// ── EVERY PATH AND EVERY ENUM VALUE HERE WAS PROBED, NOT READ ────────────
//
// Measured against test-api.creem.io on 2026-08-29, with a NEGATIVE CONTROL so
// that 「the route exists」 is distinguishable from 「the API answers everything」:
//
//   POST /v1/subscriptions/{id}/cancel          → 400 「Subscription does not
//   POST /v1/subscriptions/{id}/resume             exist」 — i.e. past routing
//   POST /v1/subscriptions/{id}/notarealaction  → 404, and a DIFFERENT body
//                                                  shape with no trace_id
//   POST /v1/subscriptions/{id}/cancel {"mode":"not_a_real_mode"}
//                                               → 400 「mode must be a valid
//                                                  enum value」
//   GET  /v1/transactions/search?customer_id=…  → 200
//   GET  /v1/transactions/search?subscription_id=…
//                                               → 400 「property
//                                                  subscription_id should not
//                                                  exist」
//
// 🔴 THE LAST TWO ARE WHY `findRefundableTransaction` LOOKS THE WAY IT DOES.
// Creem cannot filter transactions by subscription, so the lookup goes by
// CUSTOMER and matches the subscription client-side. That is a real constraint
// of the API, not a shortcut — and it is why this method needs a customer id
// that `SubscriptionWriter` does not carry (see `CreemSubscriptionLookup`).
//
// ── ⚠️ `resume` IS UNDOCUMENTED FOR THIS PURPOSE ──────────────────────────
//
// SKILL.md and the API reference both describe `resume` as the partner of
// `pause` (「Resume billing」). It nonetheless clears a scheduled cancellation
// today — probed: cancel --mode scheduled → `scheduled_cancel`, then resume →
// `active`. We depend on that behaviour, so it is PINNED by a test rather than
// trusted, and stated here so the day it changes the surprise is cheap.

import {
  CREEM_REJECTED,
  CREEM_UNREACHABLE,
  CreemWritesDisabledError,
  type CreemWriteResult,
} from './client';
import type {
  BillingWriteResult,
  CancelEffectiveFrom,
  CreateRefundInput,
  RefundableTransaction,
  RefundOutcome,
  SubscriptionSnapshot,
  SubscriptionWriter,
} from '../subscription-writer';

/**
 * 🔴 THE CODE NORMALISATION, AND IT IS THE WHOLE REASON THIS FUNCTION EXISTS.
 * `CREEM_UNREACHABLE` and `PROVIDER_UNREACHABLE` are different strings for the
 * same fact, and billing-routes.ts branches on the second one. Without this
 * mapping every Creem timeout would fall through to the 「rejected」 branch and
 * tell a user their cancellation definitely did not happen at precisely the
 * moment we do not know — with every test still green, because nothing can see
 * a string comparison that silently never matches.
 */
function normalise<T>(r: CreemWriteResult<T>): BillingWriteResult<T> {
  if (r.ok) return r;
  return {
    ok: false,
    code: r.code === CREEM_UNREACHABLE ? 'PROVIDER_UNREACHABLE' : 'PROVIDER_REJECTED',
    detail: r.detail,
  };
}

/** Creem's cancel takes a validated enum; these are the two values it accepts.
 *  Probed — a third value is refused by the API, so a typo here fails loudly
 *  rather than defaulting to the expensive one. */
const CANCEL_MODE: Readonly<Record<CancelEffectiveFrom, 'scheduled' | 'immediate'>> = {
  next_billing_period: 'scheduled',
  immediately: 'immediate',
};

/** What the writer needs that the subscription id alone cannot answer: the
 *  customer this subscription belongs to.
 *
 *  🔴 A ONE-METHOD SLICE OF THE REPO, passed in rather than reached for. The
 *  refund lookup has to go by customer (see the header), and a writer holding a
 *  whole `BillingRepo` would be a client that can also rewrite the row it is
 *  reading — with the webhook as the only legitimate author of that row. */
export interface CreemSubscriptionLookup {
  /** The provider's customer id for a subscription, or null if we have none. */
  customerIdFor(subscriptionId: string): string | null;
}

export interface CreemSubscriptionClientOptions {
  apiKey: string | null;
  env: 'test' | 'prod';
  writeEnabled: boolean;
  lookup: CreemSubscriptionLookup;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const HOSTS: Readonly<Record<'test' | 'prod', string>> = {
  test: 'https://test-api.creem.io',
  prod: 'https://api.creem.io',
};
const DEFAULT_TIMEOUT_MS = 10_000;

/** Creem's `status` for a subscription that has a cancellation booked. Probed. */
const SCHEDULED_CANCEL = 'scheduled_cancel';

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** A subscription payload → the neutral snapshot.
 *
 *  ⚠️ `scheduled_change` is DERIVED from Creem's status rather than read from a
 *  field, because Creem has no such field: it expresses a booked cancellation as
 *  a status value. Same projection the inbound envelope reader makes, and the
 *  two are deliberately the same shape so a console cannot tell which direction
 *  a snapshot came from. */
function toSnapshot(body: Record<string, unknown>): SubscriptionSnapshot | null {
  const status = asString(body.status);
  if (status === null) return null;
  const periodEnd = asString(body.current_period_end_date);
  return {
    status,
    scheduled_change:
      status === SCHEDULED_CANCEL ? { action: 'cancel', effective_at: periodEnd } : null,
  };
}

export function createCreemSubscriptionClient(
  opts: CreemSubscriptionClientOptions,
): SubscriptionWriter {
  const base = HOSTS[opts.env];
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** One request, with the write gate, the timeout and the 「never quote the
   *  vendor's message」 rule applied in exactly one place. */
  async function send(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<CreemWriteResult<Record<string, unknown>>> {
    // 🔴 THROWS rather than returning a failure result — a switched-off
    // deployment is not a provider having a bad minute, and retrying will never
    // help. Same split the checkout client and the Paddle client draw.
    if (!opts.writeEnabled) throw new CreemWritesDisabledError(operation);
    if (opts.apiKey === null || opts.apiKey === '') {
      throw new CreemWritesDisabledError(`${operation} (FLOWMIC_CREEM_API_KEY is empty)`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          'x-api-key': opts.apiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // The STATUS, not the body: Creem's error body carries a trace_id and
        // may echo request values.
        return {
          ok: false,
          code: CREEM_REJECTED,
          detail: `creem returned HTTP ${res.status} for ${method} ${path}`,
        };
      }
      const parsed = asObject(await res.json());
      if (parsed === null) {
        return { ok: false, code: CREEM_REJECTED, detail: `creem returned a non-object for ${method} ${path}` };
      }
      return { ok: true, data: parsed };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return {
        ok: false,
        code: CREEM_UNREACHABLE,
        detail: aborted
          ? `creem did not answer within ${timeoutMs}ms`
          : `creem request failed: ${e instanceof Error ? e.name : 'unknown'}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function snapshotFrom(
    operation: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<BillingWriteResult<SubscriptionSnapshot>> {
    const r = await send(operation, method, path, body);
    if (!r.ok) return normalise(r);
    const snap = toSnapshot(r.data);
    if (snap === null) {
      // A 200 whose shape we cannot read is NOT a success — returning a
      // half-object would hand the console `undefined` as a status.
      return {
        ok: false,
        code: 'PROVIDER_REJECTED',
        detail: `creem accepted ${operation} but returned no readable status`,
      };
    }
    return { ok: true, data: snap };
  }

  return {
    provider: 'creem',

    cancelSubscription(subscriptionId, effectiveFrom): Promise<BillingWriteResult<SubscriptionSnapshot>> {
      return snapshotFrom(
        'cancelSubscription',
        'POST',
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
        { mode: CANCEL_MODE[effectiveFrom] },
      );
    },

    clearScheduledChange(subscriptionId): Promise<BillingWriteResult<SubscriptionSnapshot>> {
      // See this file's header: `resume` is undocumented for this purpose and
      // pinned by a test rather than trusted.
      return snapshotFrom(
        'clearScheduledChange',
        'POST',
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/resume`,
      );
    },

    getSubscription(subscriptionId): Promise<BillingWriteResult<SubscriptionSnapshot>> {
      return snapshotFrom(
        'getSubscription',
        'GET',
        `/v1/subscriptions?subscription_id=${encodeURIComponent(subscriptionId)}`,
      );
    },

    async findRefundableTransaction(
      subscriptionId,
    ): Promise<BillingWriteResult<{ found: RefundableTransaction | null }>> {
      // ⚠️ BY CUSTOMER, THEN MATCHED CLIENT-SIDE — Creem's transaction search
      // refuses `subscription_id` outright (probed). The customer id comes from
      // our own row rather than from a second round trip, because the row is
      // already the thing that says which customer this subscription is.
      const customerId = opts.lookup.customerIdFor(subscriptionId);
      if (customerId === null) {
        // 🔴 NOT `{found: null}`. 「there is nothing to refund」 and 「we cannot
        // tell what there is to refund」 are different answers, and the caller
        // records them under different states — one is a normal outcome, the
        // other is work a human has to finish. Collapsing them would file a
        // customer owed money as 「nothing due」.
        return {
          ok: false,
          code: 'PROVIDER_REJECTED',
          detail: 'no customer id is recorded for this subscription, so its transactions cannot be looked up',
        };
      }
      const r = await send(
        'findRefundableTransaction',
        'GET',
        `/v1/transactions/search?customer_id=${encodeURIComponent(customerId)}&page_size=50`,
      );
      if (!r.ok) return normalise(r);
      const items = Array.isArray(r.data.items) ? r.data.items : [];
      // Newest first is NOT guaranteed by the API, so the pick is explicit:
      // the largest paid charge on this subscription that has not already been
      // given back. A statutory withdrawal is a full refund of the charge that
      // bought the period, and picking 「whichever came back first」 would make
      // the amount depend on Creem's page ordering.
      let best: RefundableTransaction | null = null;
      for (const raw of items) {
        const t = asObject(raw);
        if (t === null) continue;
        if (asString(t.subscription) !== subscriptionId) continue;
        if (asString(t.status) !== 'paid') continue;
        // `refunded_amount` is null when nothing has been given back. A charge
        // already refunded must not be offered up a second time.
        if (t.refunded_amount !== null && t.refunded_amount !== undefined) continue;
        const id = asString(t.id);
        const currency = asString(t.currency);
        const amount = typeof t.amount === 'number' ? t.amount : null;
        if (id === null || currency === null || amount === null) continue;
        if (best === null || amount > best.amount_minor) {
          best = { id, amount_minor: amount, currency };
        }
      }
      return { ok: true, data: { found: best } };
    },

    async createRefund(input: CreateRefundInput): Promise<BillingWriteResult<RefundOutcome>> {
      // ⚠️ FULL REFUNDS ONLY, and that is the API's shape rather than ours:
      // `POST /v1/refunds` takes only `transaction_id` and resolves the full
      // remaining refundable amount itself. Creem's own feature docs claim
      // partial refunds are supported — that is the dashboard, not the API, and
      // the mismatch is recorded here so nobody designs against the doc.
      // It costs us nothing: a statutory withdrawal is full by definition.
      const r = await send('createRefund', 'POST', '/v1/refunds', {
        transaction_id: input.transaction_id,
      });
      if (!r.ok) return normalise(r);
      const id = asString(r.data.id);
      const status = asString(r.data.status);
      if (id === null || status === null) {
        return {
          ok: false,
          code: 'PROVIDER_REJECTED',
          detail: 'creem accepted the refund but returned no id/status',
        };
      }
      // 🔴 `status` GOES OUT UNTOUCHED. Measured: this comes back `pending` for
      // a refund the transaction itself already shows as `refunded`. It is not
      // a boolean and nothing downstream may round it up — see RefundOutcome.
      return { ok: true, data: { id, status } };
    },
  };
}
