// SPEC-REF:
//   apps/server-core/src/billing/webhook-types.ts (BillingProviderAdapter)
//   apps/server-core/src/billing/creem/{signature,envelope}.ts (all the logic)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Creem, as the pipeline sees it. Assembly only — every line of behaviour is in
// the two modules it names, so this file cannot develop a second opinion about
// anything and a reviewer can confirm that by its length.

import type { BillingProviderAdapter } from '../webhook-types';
import {
  isCreemLedgerOnlyEvent,
  isCreemSubscriptionEvent,
  parseCreemEnvelope,
  isCreemRefundEvent,
  readCreemOneTimePurchase,
  readCreemRefundFacts,
  readCreemRefundOrderId,
  readCreemSubscriptionFacts,
} from './envelope';
import { CREEM_SIGNATURE_HEADER, verifyCreemSignature } from './signature';

export const creemAdapter: BillingProviderAdapter = {
  id: 'creem',
  signatureHeader: CREEM_SIGNATURE_HEADER,
  verifySignature: verifyCreemSignature,
  parseEnvelope: parseCreemEnvelope,
  readSubscriptionFacts: readCreemSubscriptionFacts,
  isSubscriptionEvent: isCreemSubscriptionEvent,
  isLedgerOnlyEvent: isCreemLedgerOnlyEvent,
  readOneTimePurchase: readCreemOneTimePurchase,
  readRefund: (env) =>
    isCreemRefundEvent(env.event_type)
      ? { order_id: readCreemRefundOrderId(env), ...readCreemRefundFacts(env) }
      : null,
};
