// SPEC-REF:
//   apps/server-core/src/billing/paddle/client.ts (the first implementation)
//   apps/server-core/src/billing/creem/client.ts (the second)
//   apps/server-core/src/http/billing-routes.ts (its only production caller)
//   apps/server-core/src/billing/webhook-types.ts (the INBOUND twin — same
//     split, opposite direction)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// What the console can ask a payment provider to DO, independent of which one.
//
// ── WHY THIS EXISTS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────
//
// `webhook-types.ts` did this for money coming IN. This is the same split for
// money going OUT, and it draws the line in the same place: the adapter answers
// 「what does this provider call that operation, and what did it say」, while
// every decision about WHETHER to make the call — the withdrawal window, the
// cancel-vs-withdraw distinction, what gets written down, what the customer is
// told — stays in one shared place. Two providers must never grow two answers
// to 「may this person get their money back」.
//
// It is NOT a general Paddle/Creem SDK. Five operations, because the console has
// exactly five things it can cause: stop the renewals, undo that, find what is
// refundable, give it back, and read the current state. A method with no caller
// is a client that looks connected, so nothing lands here until something calls
// it.
//
// ── 🔴 THE FAILURE CODES ARE NORMALISED HERE, AND THAT IS NOT COSMETIC ────
//
// Both clients already return `{ok:false, code, detail}` with structurally
// identical shapes — and DIFFERENT string constants (`PADDLE_UNREACHABLE` vs
// `CREEM_UNREACHABLE`). billing-routes.ts branches on that string to decide
// between two answers that are NOT interchangeable:
//
//   unreachable → 502 「we could not confirm it」  (it may have committed)
//   rejected    → 502 「the provider refused it」  (it definitely did not)
//
// Handing a Creem client to a function that compares against the Paddle literal
// would send every Creem timeout down the `rejected` branch — telling a user
// their cancellation definitely did not happen at the exact moment we do not
// know whether it did. That is the one sentence the unreachable branch was
// written to avoid, and it would have arrived with every test still green,
// because no test can see a string comparison that silently never matches.
//
// ⇒ the union below is the ONLY vocabulary billing-routes.ts is allowed to
//   branch on, and each adapter maps its own constants into it at the boundary.

/**
 * 🔴 UNREACHABLE AND REJECTED ARE DIFFERENT ANSWERS, NOT TWO WORDS FOR FAILURE.
 * `PROVIDER_UNREACHABLE` means we do not know what happened — a timeout can land
 * after the provider has already committed. `PROVIDER_REJECTED` means it
 * answered and said no. Collapsing them loses the only distinction the user's
 * next action depends on: wait and re-read, or try something else.
 */
export type BillingWriteFailCode = 'PROVIDER_UNREACHABLE' | 'PROVIDER_REJECTED';

export type BillingWriteResult<T> =
  | { ok: true; data: T }
  /** `detail` is for logs and operators. It may name the provider's status or
   *  error code, never a vendor message verbatim: those can name a customer. */
  | { ok: false; code: BillingWriteFailCode; detail: string };

/** A subscription as the console needs to describe it right after a write.
 *
 *  ⚠️ A RECEIPT, NOT OUR STATE. The local row is still the webhook's to write,
 *  seconds later. Nothing derived from this may be stored. */
export interface SubscriptionSnapshot {
  /** The provider's own status string, carried through untouched. */
  status: string;
  scheduled_change: { action: string; effective_at: string | null } | null;
}

/** A charge that could be given back. */
export interface RefundableTransaction {
  id: string;
  amount_minor: number;
  currency: string;
}

export interface RefundOutcome {
  /** The provider's id for the refund/adjustment, for reconciliation. */
  id: string;
  /**
   * 🔴 THE PROVIDER'S OWN STATUS WORD, VERBATIM, AND IT IS NOT A BOOLEAN.
   *
   * BOTH providers can answer `ok` with a NON-TERMINAL state, and this was
   * measured rather than assumed (2026-08-29): Paddle returns
   * `pending_approval` awaiting a human, and Creem's own schema documents
   * `pending` and `requiresAction` as non-terminal — a live probe returned
   * `pending` for a refund the transaction already showed as `refunded`.
   *
   * An earlier draft of this design said only Paddle needed the word carried and
   * Creem could be flattened. That was wrong for both, and the direction it
   * fails in is: we tell a customer exercising a statutory right that their
   * money is back when it is not.
   *
   * ⇒ nothing between here and the screen may round this up to 「refunded」.
   */
  status: string;
}

/** Cancel at period end, or now.
 *
 *  🔴 `immediately` REFUNDS NOTHING AT EITHER PROVIDER — measured at both
 *  (Paddle's docs say so; a Creem immediate cancel left the charge `paid` with
 *  `refunded_amount: null`). So a statutory withdrawal is TWO calls at every
 *  provider, and the invariant is shared rather than re-argued per adapter. */
export type CancelEffectiveFrom = 'next_billing_period' | 'immediately';

export interface CreateRefundInput {
  transaction_id: string;
  /** 🔴 ALWAYS ONE OF OUR OWN FIXED STRINGS, never anything a user typed: this
   *  lands in a vendor dashboard, and a free-text box is how a customer's words
   *  end up somewhere they never agreed to send them. */
  reason: string;
}

/**
 * The five things the console can cause at a payment provider.
 *
 * ⚠️ EVERY METHOD MAY THROW a provider-specific 「writes are switched off」
 * error rather than returning `{ok:false}`, and the distinction is deliberate at
 * both implementations: a failure result reads as 「the provider said no」 and
 * invites a retry, while a disabled deployment will never succeed no matter how
 * often it is retried. billing-routes.ts catches those by type and answers 503.
 */
export interface SubscriptionWriter {
  /** Which provider this is, for logs and for the 「did we dispatch correctly」
   *  assertion. Never used to branch on behaviour inside the routes — the whole
   *  point of this interface is that they do not have to. */
  readonly provider: string;
  cancelSubscription(
    subscriptionId: string,
    effectiveFrom: CancelEffectiveFrom,
  ): Promise<BillingWriteResult<SubscriptionSnapshot>>;
  /** Undo a scheduled cancellation. */
  clearScheduledChange(subscriptionId: string): Promise<BillingWriteResult<SubscriptionSnapshot>>;
  /** `found: null` is a REAL AND CORRECT OUTCOME, not a failure: a subscription
   *  that was never charged has nothing to give back, and the caller records it
   *  under its own state so nobody reading the table later mistakes it for one. */
  findRefundableTransaction(
    subscriptionId: string,
  ): Promise<BillingWriteResult<{ found: RefundableTransaction | null }>>;
  createRefund(input: CreateRefundInput): Promise<BillingWriteResult<RefundOutcome>>;
  getSubscription(subscriptionId: string): Promise<BillingWriteResult<SubscriptionSnapshot>>;
}

/**
 * Pick the writer for a subscription's provider.
 *
 * 🔴 IT RETURNS `null` FOR A PROVIDER THIS PROCESS HAS NO CLIENT FOR, rather
 * than falling back to whichever one is configured. A fallback here would send
 * a Creem subscription id to Paddle, which would answer 「entity not found」 —
 * and the console would tell a paying customer their subscription does not
 * exist. The refusal is loud and the caller names it.
 */
export type SubscriptionWriterFor = (provider: string) => SubscriptionWriter | null;
