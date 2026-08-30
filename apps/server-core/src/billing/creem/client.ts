// SPEC-REF:
//   apps/server-core/src/billing/paddle/client.ts (the sibling; its write-gate,
//     its result type and its 「never pretend it worked」 rule are followed here)
//   https://docs.creem.io/api-reference/endpoint/create-checkout (read 2026-08-29)
//   apps/server-core/src/http/billing-routes.ts (its only production caller)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Outbound calls to Creem. Today: exactly one, creating a checkout session.
//
// ⚠️ WHY ONLY ONE. Cancel / resume / refund all exist at Creem and are NOT here
// yet, deliberately: the console still drives those through Paddle, and adding
// unreachable methods would be a client that looks connected. The day the
// console switches, they land together with the surface that calls them —
// `grep -rn 'creemClient\.' apps/server-core/src` must never find a method with
// no caller.

import type { OneTimePurchaseState } from '../../db/repos/one-time-purchase.repo';

/** 🔴 A DISTINCT ERROR TYPE, not a string in a message. A caller that catches
 *  `Error` broadly would otherwise report a switched-off deployment as 「Creem
 *  had a bad minute」, and an operator would go looking at Creem's status page
 *  for a setting on our own box. */
export class CreemWritesDisabledError extends Error {
  readonly code = 'CREEM_WRITE_DISABLED';
  constructor(operation: string) {
    super(
      `creem write refused: ${operation} was called while FLOWMIC_CREEM_WRITE_ENABLED is off. ` +
        'This is a deployment switch, not a Creem failure — nothing was sent and nothing changed.',
    );
    this.name = 'CreemWritesDisabledError';
  }
}

/** Outcome codes. HTTP-LOCAL strings, deliberately NOT protocol `ErrorCode`s —
 *  the same choice the Paddle client made two files over, for the same reason:
 *  minting protocol codes with no FlowMic client reading them is a façade. */
export const CREEM_UNREACHABLE = 'CREEM_UNREACHABLE';
export const CREEM_REJECTED = 'CREEM_REJECTED';

export type CreemWriteResult<T> =
  | { ok: true; data: T }
  /** `detail` is for logs and operators. It may quote Creem's own status or
   *  error code but never a vendor message verbatim: those can name a customer. */
  | { ok: false; code: typeof CREEM_UNREACHABLE | typeof CREEM_REJECTED; detail: string };

export interface CreemCheckoutSession {
  id: string;
  /** Where the browser goes next. The ONLY thing the route hands to a client. */
  checkout_url: string;
}

export interface CreateCheckoutInput {
  productId: string;
  /** Echoed back on `checkout.completed`. 🔴 THE ONLY WAY A PAYMENT CAN NAME ITS
   *  BUYER — see the metadata contract in creem/envelope.ts. */
  metadata: Record<string, string>;
  /** Our own correlation id, returned on the checkout object. */
  requestId: string;
  successUrl?: string;
}

export interface CreemClient {
  /**
   * `POST /v1/checkouts`.
   *
   * ⚠️ A CHECKOUT IS NOT A PURCHASE. This returns a URL a person may or may not
   * pay at; nothing is owed, granted, or recorded on the strength of it. The
   * `one_time_purchases` row is written by the webhook, from a PAID order, and
   * by nothing else. A route that wrote a row here would show a buyer a purchase
   * they had not made.
   */
  createCheckout(input: CreateCheckoutInput): Promise<CreemWriteResult<CreemCheckoutSession>>;
}

export interface CreemClientOptions {
  apiKey: string | null;
  env: 'test' | 'prod';
  writeEnabled: boolean;
  /** Injected for tests. Production passes nothing and gets `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const HOSTS: Readonly<Record<'test' | 'prod', string>> = {
  test: 'https://test-api.creem.io',
  prod: 'https://api.creem.io',
};

/** 10s. Long enough for a cross-continent round trip, short enough that a hung
 *  vendor cannot pin one of our request handlers open indefinitely. */
const DEFAULT_TIMEOUT_MS = 10_000;

export function createCreemClient(opts: CreemClientOptions): CreemClient {
  const base = HOSTS[opts.env];
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async createCheckout(input): Promise<CreemWriteResult<CreemCheckoutSession>> {
      // 🔴 THROWS RATHER THAN RETURNING A FAILURE RESULT, and the difference
      // matters: a `{ok:false}` reads as 「Creem said no」 and invites a retry,
      // while this is 「this deployment is not configured to send」 and retrying
      // will never help. Same split the Paddle client draws.
      if (!opts.writeEnabled) throw new CreemWritesDisabledError('createCheckout');
      if (opts.apiKey === null || opts.apiKey === '') {
        throw new CreemWritesDisabledError('createCheckout (FLOWMIC_CREEM_API_KEY is empty)');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${base}/v1/checkouts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey },
          body: JSON.stringify({
            product_id: input.productId,
            request_id: input.requestId,
            metadata: input.metadata,
            ...(input.successUrl === undefined ? {} : { success_url: input.successUrl }),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          // The STATUS, not the body. Creem's error body carries a trace_id and
          // may echo request values; a vendor message quoted into our logs is
          // how a customer's details end up somewhere nobody audited.
          return { ok: false, code: CREEM_REJECTED, detail: `creem returned HTTP ${res.status} for POST /v1/checkouts` };
        }

        const body = (await res.json()) as Record<string, unknown>;
        const id = typeof body.id === 'string' ? body.id : null;
        const url = typeof body.checkout_url === 'string' ? body.checkout_url : null;
        if (id === null || url === null) {
          // A 200 whose shape we cannot read is NOT a success. Returning a
          // half-object here would hand the browser `undefined` as a URL.
          return { ok: false, code: CREEM_REJECTED, detail: 'creem accepted the request but returned no id/checkout_url' };
        }
        return { ok: true, data: { id, checkout_url: url } };
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        return {
          ok: false,
          code: CREEM_UNREACHABLE,
          detail: aborted ? `creem did not answer within ${timeoutMs}ms` : `creem request failed: ${e instanceof Error ? e.name : 'unknown'}`,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** What the console renders for a purchase, in one place.
 *
 *  🔴 IT IS A FUNCTION OF THE STATE (AND, FOR A DELIVERED ROW, OF THE CLOCK),
 *  NOT A STRING STORED ON THE ROW. A stored sentence would be written once and
 *  then keep saying the same thing after the fact it described stopped being
 *  true — this repo's most-recorded failure. 'support' → 'closed' is exactly
 *  that kind of fact: it changes on its own, two weeks after delivery, and
 *  deriving it on every read is the only way the console follows it. */
export function purchaseNextStep(
  row: { state: OneTimePurchaseState; delivered_at: string | null },
  nowMs: number,
  aftercareDays: number,
): 'awaiting_contact' | 'scheduled' | 'in_progress' | 'support' | 'closed' | 'refund_requested' | 'refunded' {
  switch (row.state) {
    case 'paid':
      return 'awaiting_contact';
    case 'scheduled':
      return 'scheduled';
    case 'in_progress':
      return 'in_progress';
    case 'delivered': {
      // Two weeks of help from `delivered_at` (gs-5), then the service is
      // closed. A delivered row with no readable delivery stamp falls to
      // 'closed' rather than to a support period we cannot date.
      const deliveredMs = row.delivered_at === null ? NaN : Date.parse(row.delivered_at);
      if (Number.isNaN(deliveredMs)) return 'closed';
      return nowMs < deliveredMs + aftercareDays * 24 * 60 * 60 * 1000 ? 'support' : 'closed';
    }
    // 🔴 A SEPARATE ANSWER FROM 'refunded', because the two sentences a console
    // renders for them are different claims: 「we have asked for your money
    // back」 is ours and true the moment we ask; 「your money has been returned」
    // is the provider's and true only once it says so.
    case 'refund_requested':
      return 'refund_requested';
    case 'refunded':
      return 'refunded';
  }
}
