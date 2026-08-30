// SPEC-REF:
//   apps/server-core/src/billing/subscription-writer.ts (the contract)
//   apps/server-core/src/billing/paddle/client.ts (the client being adapted)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Paddle's side of `SubscriptionWriter`.
//
// ⚠️ A SHIM, NOT A REWRITE. `PaddleClient` already had every one of these five
// methods and already returned the right shapes; what it did not have was the
// NORMALISED failure vocabulary. So this file is almost entirely one mapping —
// and that mapping is the point, for the reason the contract's header states at
// length: `PADDLE_UNREACHABLE` and `CREEM_UNREACHABLE` are different strings for
// the same fact, and a route that branches on one of them literally would send
// the other provider's timeouts down the branch that tells a user their
// cancellation definitely did not happen.
//
// 🔴 THE ADAPTER IS WHERE THE MAPPING GOES, NOT THE ROUTE. Putting it in the
// route would mean the route knows both vocabularies, which is the thing having
// an interface was supposed to buy.

import type { PaddleClient, PaddleWriteResult } from './client';
import { PADDLE_UNREACHABLE } from './client';
import type {
  BillingWriteResult,
  SubscriptionWriter,
} from '../subscription-writer';

function normalise<T>(r: PaddleWriteResult<T>): BillingWriteResult<T> {
  if (r.ok) return r;
  return {
    ok: false,
    code: r.code === PADDLE_UNREACHABLE ? 'PROVIDER_UNREACHABLE' : 'PROVIDER_REJECTED',
    detail: r.detail,
  };
}

/** Wrap a `PaddleClient` as a `SubscriptionWriter`. */
export function asPaddleSubscriptionWriter(client: PaddleClient): SubscriptionWriter {
  return {
    provider: 'paddle',
    async cancelSubscription(id, effectiveFrom) {
      return normalise(await client.cancelSubscription(id, effectiveFrom));
    },
    async clearScheduledChange(id) {
      return normalise(await client.clearScheduledChange(id));
    },
    async findRefundableTransaction(id) {
      return normalise(await client.findRefundableTransaction(id));
    },
    async createRefund(input) {
      // ⚠️ Paddle calls it an ADJUSTMENT and its snapshot carries `{id, status}`
      // — structurally the neutral `RefundOutcome` already. The status word is
      // passed through untouched (usually `pending_approval`, awaiting a human
      // at Paddle); see RefundOutcome for why nothing may round it up.
      return normalise(await client.createRefund(input));
    },
    async getSubscription(id) {
      return normalise(await client.getSubscription(id));
    },
  };
}
