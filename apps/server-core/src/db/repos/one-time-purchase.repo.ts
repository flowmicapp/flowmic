// SPEC-REF:
//   apps/server-core/src/db/schema-billing.ts ONE_TIME_PURCHASE_SQL (the table,
//     and the reasoning for every column — especially the two consent stamps)
//   apps/server-core/src/billing/paddle/webhook-handler.ts step 5b (its writer)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// The one-time purchase table's repo, split out of billing.repo.ts on
// 2026-08-29.
//
// 🔴 WHY IT MOVED, so nobody re-merges it: billing.repo.ts crossed the 800-line
// cap the moment these four methods landed in it (845). The repo precedent is to
// SPLIT AND KEEP THE EVIDENCE rather than compress the comments away — schema.ts
// → schema-billing.ts, bootstrap.ts → bootstrap-http-deps.ts, the same pressure
// and the same remedy. Nothing about the injection changed: `BillingRepo`
// extends this interface and `makeBillingRepo` spreads this factory, so callers
// still hold ONE repo and there is still one answer per question.

import type { DatabaseSync } from 'node:sqlite';

/** 🔴 DELIVERY, NOT PAYMENT — the row only exists once money arrived, so there
 *  is no 'unpaid'. Each value is something a PERSON did; a state nobody can
 *  advance is the shape this repo forbids.
 *
 *  'in_progress' (2026-08-30 lifecycle ruling) is the operator saying 「the
 *  session has begun」. It matters to money in two directions at once: the
 *  buyer can still withdraw from it (a setup that has started but not been
 *  confirmed complete is not complete), and NO deadline can refund it unasked
 *  (a clock must not take money back from somebody mid-session). */
export type OneTimePurchaseState =
  | 'paid'
  | 'scheduled'
  | 'in_progress'
  | 'delivered'
  | 'refund_requested'
  | 'refunded';

/**
 * 🔴 'refund_requested' AND 'refunded' ARE TWO STATES BECAUSE THEY ARE TWO
 * CLAIMS, and merging them is the one mistake this area cannot afford.
 * 'refund_requested' says WE asked the provider to send the money back — a fact
 * about our own action, which we know. 'refunded' says the money went back — a
 * fact about the provider, which only the provider can tell us. Creem's own
 * POST /v1/refunds answers 'pending' even for a refund the transaction already
 * shows as refunded (measured 2026-08-29), so treating that reply as
 * confirmation would tell a consumer exercising a statutory right that their
 * money is back when nobody has said so.
 *
 * ⚠️ 'refunded' HAS EXACTLY ONE WRITER: the refund webhook.
 */
export function isOneTimePurchaseState(v: unknown): v is OneTimePurchaseState {
  return (
    v === 'paid' ||
    v === 'scheduled' ||
    v === 'in_progress' ||
    v === 'delivered' ||
    v === 'refund_requested' ||
    v === 'refunded'
  );
}

/**
 * Why an operator took a stuck refund off 'refund_requested'.
 *
 * 🔴 THE TWO MEMBERS ARE NOT COSMETIC AND THIS TYPE IS NOT A LABEL. The value
 * decides whether the unattended 14-day no-start sweep still protects the
 * buyer: `provider_declined` takes the row off it for ever (retrying an
 * automatic refund through a provider that already refused THIS row is a loop),
 * and `buyer_withdrew_request` deliberately leaves it on (the buyer changed
 * their mind and wants the service — the deadline exists for exactly them).
 * billing/service-deadlines.ts `refundDueReason` is where that is spent.
 *
 * ⚠️ IT IS NOT A FOURTH `RefundOrigin`. An origin says why a refund was ASKED
 * for; this says why one stopped being asked for. Merging them would hand the
 * provider call a reason it must never carry.
 */
export type RefundReleaseReason = 'provider_declined' | 'buyer_withdrew_request';

/**
 * Every `RefundReleaseReason`, as a runtime table.
 *
 * 🔴 EXISTS SO A TEST CAN COUNT THEM, and it is a `Record<RefundReleaseReason,
 * true>` rather than an array for the reason `REFUND_ORIGIN_TABLE` in
 * billing/service-refund.ts states: BOTH a missing member and an extra one are
 * then compile errors, where a hand-written list would let the union grow while
 * the list stayed stale. A third member is a deliberate act, and whoever adds
 * one owes an answer to the only question this type is ever asked — does the
 * sweep still run on a row released for that reason.
 */
const REFUND_RELEASE_REASON_TABLE: Readonly<Record<RefundReleaseReason, true>> = {
  provider_declined: true,
  buyer_withdrew_request: true,
};
export const REFUND_RELEASE_REASONS: readonly RefundReleaseReason[] = Object.keys(
  REFUND_RELEASE_REASON_TABLE,
) as RefundReleaseReason[];

export function isRefundReleaseReason(v: unknown): v is RefundReleaseReason {
  return v === 'provider_declined' || v === 'buyer_withdrew_request';
}

/**
 * The states a released refund may land back in.
 *
 * 🔴 'delivered' IS ABSENT, AND THE ABSENCE IS THE DESIGN. Declaring a setup
 * complete is its own visible action with its own audit row; letting a release
 * reach 'delivered' would let one click both end a refund AND close the refund
 * window on it, with the trail naming only the first. 'refunded' is absent
 * because it is a claim about money — the webhook writes it, or an operator
 * does with an external reference behind it, never as a side effect of
 * releasing.
 *
 * Declared as a tuple so a refusal message can list the legal values rather
 * than a second hand-written copy of them drifting out of date.
 */
export const REFUND_RELEASE_TARGETS = ['paid', 'scheduled', 'in_progress'] as const;
export type RefundReleaseTarget = (typeof REFUND_RELEASE_TARGETS)[number];

export function isRefundReleaseTarget(v: unknown): v is RefundReleaseTarget {
  return v === 'paid' || v === 'scheduled' || v === 'in_progress';
}

/** Column-for-column with the table. */
export interface OneTimePurchaseRow {
  order_id: string;
  provider: string;
  user_id: string | null;
  product_id: string | null;
  checkout_id: string | null;
  transaction_id: string | null;
  customer_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  state: OneTimePurchaseState;
  early_start_consent_at: string | null;
  withdrawal_waiver_ack_at: string | null;
  /** The id of the wording those two stamps are against. */
  consent_terms_version: string | null;
  scheduled_at: string | null;
  /** When the operator recorded that the session BEGAN. Part of the delivery
   *  picture (assigned, not coalesced), like the two beside it. */
  started_at: string | null;
  delivered_at: string | null;
  /** When WE asked the provider to give the money back. Ours, always knowable. */
  refund_requested_at: string | null;
  /** The provider's handle for that refund. Creem has no GET /v1/refunds
   *  (probed: 404), so nothing can poll it — it exists for a person. */
  refund_provider_id: string | null;
  /** The provider's own status word, verbatim. 'pending' and 'requiresAction'
   *  are documented NON-TERMINAL, so this must never be read as "money back". */
  refund_status: string | null;
  /** When the PROVIDER confirmed it. The webhook is its only writer. */
  refunded_at: string | null;
  /** When we successfully emailed the buyer that the setup was complete.
   *
   *  ⚠️ A RECORD OF THE EMAIL AND NOTHING MORE (gs-5). It does not affect
   *  refundability — the refund closes at 'delivered' whether or not this is
   *  set — and it starts no clock. NULL on a delivered row means we still owe
   *  the buyer that email, which the operator queue surfaces as a duty. */
  completion_notice_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  /** When an operator released a stuck refund request. NULL means no release
   *  ever happened — it never means "we do not know". */
  refund_released_at: string | null;
  /** Why. 🔴 READ BY `refundDueReason`: 'provider_declined' takes this row off
   *  the unattended 14-day sweep for ever, and 'buyer_withdrew_request' leaves
   *  it on. Nothing else in the product branches on it. */
  refund_release_reason: RefundReleaseReason | null;
  /** The operator's proof that money moved somewhere we cannot see.
   *
   *  🔴 NON-NULL IS WHAT DISTINGUISHES A HUMAN-ASSERTED REFUND FROM A
   *  PROVIDER-CONFIRMED ONE, for ever. 'refunded' with this null came from the
   *  webhook; 'refunded' with this set came from a person who typed a reference
   *  they can be held to. `refund_status` is deliberately NOT overloaded to
   *  carry that distinction — it holds the provider's own word and nothing of
   *  ours. */
  refund_external_reference: string | null;
}

/**
 * What `recordOneTimePurchase` is given.
 *
 * 🔴 THE THREE RELEASE COLUMNS ARE OMITTED, NOT DEFAULTED. A purchase being
 * written for the FIRST time cannot have had a stuck refund released by a
 * human, so requiring three nulls would ask the webhook to hold an opinion
 * about something that has not happened — and the INSERT does not name those
 * columns at all, so the table's own NULL is the answer. A type rather than a
 * convention, so a future caller cannot pass one by accident.
 */
export type NewOneTimePurchase = Omit<
  OneTimePurchaseRow,
  'updated_at' | 'refund_released_at' | 'refund_release_reason' | 'refund_external_reference'
>;

export interface OneTimePurchaseRepo {
  /**
   * Write a paid one-time purchase, once.
   *
   * 🔴 RETURNS WHICH IT WAS, AND THE CALLER IS REQUIRED TO CARE. Providers
   * redeliver a completed checkout (Creem: 5 attempts over 24h), so 'duplicate'
   * is the NORMAL path on a retry and must conclude without touching state. A
   * void return would make 「we wrote it」 and 「we already had it」 the same
   * observation, and the ledger would then report a state change for a delivery
   * that changed nothing.
   */
  recordOneTimePurchase(row: NewOneTimePurchase): 'inserted' | 'duplicate';
  getOneTimePurchase(order_id: string): OneTimePurchaseRow | null;
  /** Newest first. The console's own read; it never joins against subscriptions. */
  listOneTimePurchasesForUser(user_id: string, limit: number): OneTimePurchaseRow[];
  /** Every purchase, newest first — the OPERATOR read, across accounts.
   *
   *  🔴 A SEPARATE METHOD FROM `listOneTimePurchasesForUser` RATHER THAN THE
   *  SAME ONE WITH AN OPTIONAL `user_id`. An optional filter is one missing
   *  argument away from returning every customer’s purchases to a customer,
   *  and the defect would then be an ABSENCE rather than a visible call. Here
   *  the cross-account read has its own name, so `grep` answers 「who can see
   *  everybody’s purchases」 in one line. */
  listAllOneTimePurchases(limit: number): OneTimePurchaseRow[];
  /**
   * Move a purchase along its delivery states.
   *
   * ⚠️ NAMED FIELDS, NOT A FREE PATCH, and the two consent stamps are absent
   * from this signature on purpose. They record what a buyer was shown at the
   * moment of purchase; a later write to them would be a claim about a past
   * conversation that nobody can check — and it is exactly the record a
   * withdrawal dispute turns on.
   *
   * 🔴 THE THREE DELIVERY STAMPS ARE ASSIGNED, NOT COALESCED — a correction to
   * this method’s first shape rather than a preference. Under COALESCE a caller
   * could only ever ADD a stamp, so a mis-marked delivery walked back to
   * `scheduled` would leave `delivered_at` set: a row saying 「not delivered」 in
   * one column and 「delivered at 14:03」 in another. Two answers to one
   * question, on the surface that tells a customer whether they still have a
   * session coming. The caller therefore states the WHOLE delivery picture each
   * time, and http/ops-purchase-routes.ts is the one place that knows which
   * stamps belong to which state.
   *
   * ⚠️ `transaction_id` and `note` KEEP their COALESCE semantics: they are not
   * part of the state picture, and an operator advancing a purchase has no
   * business being able to erase the transaction it was paid by.
   */
  /**
   * Record that WE asked the provider to refund this purchase.
   *
   * 🔴 IT WRITES NEITHER 'refunded' NOR `refunded_at`. That pair is the
   * provider's answer and this method only ever knows the question.
   *
   * ⚠️ THE STATE TEST IS INSIDE THE UPDATE, not in the caller: two browser tabs
   * both clicking withdraw would otherwise both read 'scheduled', both call the
   * provider, and refund the same charge twice. The second UPDATE matches
   * nothing — which is why this returns whether it won, and why the caller is
   * required to care.
   *
   * 🔴 THE CONDITION IS A STATE LIST AND NOTHING ELSE (gs-5): paid, scheduled
   * or in_progress. A delivered purchase is refused here regardless of whether
   * the completion email went out — `completion_notice_at` is a record, not a
   * clock, and this UPDATE never reads it.
   */
  requestOneTimeRefund(
    order_id: string,
    fields: {
      requested_at: string;
      provider_id: string | null;
      provider_status: string | null;
    },
    nowIso: string,
  ): 'claimed' | 'not_refundable';
  /**
   * Record that we told the buyer their setup is complete.
   *
   * 🔴 IT IS CALLED ONLY WHEN THE MAIL TRANSPORT ACCEPTED THE MESSAGE. The
   * column records that the buyer WAS told; writing it on 「we tried」 would
   * put a letter in the record that nobody received.
   *
   * ⚠️ IT AFFECTS NOTHING ELSE. Since gs-5 the refund closes at 'delivered',
   * with or without this stamp, and the support period runs from
   * `delivered_at`. A NULL here on a delivered row is a duty the operator queue
   * shows (「we owe them the email」), not a right the buyer keeps.
   *
   * ⚠️ CONDITIONAL ON 'delivered' AND ON THE COLUMN STILL BEING NULL, so a
   * re-sent notice keeps the date of the first letter rather than the latest.
   */
  stampCompletionNotice(order_id: string, atIso: string, nowIso: string): void;
  /**
   * Record WHAT THE PROVIDER SAID about a refund we already claimed.
   *
   * 🔴 IT WRITES TWO FIELDS AND NO STATE. Without it the provider's refund id
   * would be lost whenever the webhook did not arrive — and that id is the only
   * handle a human has for reconciling by hand, on a provider that offers no
   * `GET /v1/refunds` to look it up with (probed: 404).
   *
   * ⚠️ CONDITIONAL ON 'refund_requested', so it can only ever annotate a row
   * this system already claimed. It cannot start a refund, cannot finish one,
   * and cannot touch a row in any other state — which is what stops it becoming
   * a second way to move a purchase.
   */
  stampRefundProviderFacts(
    order_id: string,
    fields: { provider_id: string | null; provider_status: string | null },
    nowIso: string,
  ): void;
  /**
   * Record that the PROVIDER confirmed the money went back.
   *
   * 🔴 THE ONLY WRITER OF 'refunded'.
   *
   * ⚠️ IT DOES NOT REQUIRE 'refund_requested' FIRST. A refund issued from the
   * provider's own dashboard never passes through our route, so insisting on
   * our prior state would make a real refund unrecordable — and the customer's
   * console would go on offering to withdraw money that had already gone back.
   */
  confirmOneTimeRefund(
    order_id: string,
    fields: { refunded_at: string; provider_id: string | null; provider_status: string | null },
    nowIso: string,
  ): 'confirmed' | 'unknown_order';
  /**
   * Record that a refund we asked for DID happen, on the word of a human who
   * has proof of it.
   *
   * 🔴 THE SECOND WRITER OF 'refunded', and the only thing that entitles it to
   * exist is that it demands something the webhook cannot: an external
   * reference. The webhook writes 'refunded' because the provider said so; this
   * writes it because a person says so AND leaves behind what they said it on.
   * Without the reference the row would assert that money moved with nothing at
   * all behind the claim — the "said it was done when it was not" half of
   * no-silent-failure, pointed at somebody's money.
   *
   * ⚠️ CONDITIONAL ON 'refund_requested' IN THE SQL, not in the caller — the
   * same discipline as the claim above. Two operators on two tabs would
   * otherwise both read the state and both write, and only one of their
   * references would survive. The route checks the state too so it can answer
   * 409 with a sentence; this condition is what makes that answer true under a
   * race.
   *
   * ⚠️ `refund_status` AND `refund_provider_id` ARE LEFT ALONE. They are the
   * history of what the provider said when we asked, and that history is
   * exactly what makes this row readable a year later.
   */
  settleOneTimeRefundByHand(
    order_id: string,
    fields: { refunded_at: string; external_reference: string },
    nowIso: string,
  ): 'settled' | 'not_requested';
  /**
   * Take a stuck refund request back off 'refund_requested'.
   *
   * 🔴 IT NEVER WRITES 'refunded' AND CANNOT REACH 'delivered'. The target is a
   * `RefundReleaseTarget` — paid, scheduled, in_progress — so the buyer keeps
   * the right to ask again while the service is not yet completed, and a refund
   * decision can never be hidden inside a delivery.
   *
   * 🔴 THE TWO STAMPS ARE WRITTEN BY THIS ONE STATEMENT AND THERE IS NO OTHER
   * WAY TO SET EITHER. A caller able to write the date without the reason would
   * produce a row saying a release happened that cannot say what it meant — and
   * the reason is the input to whether the 14-day sweep still runs.
   *
   * ⚠️ `refund_requested_at`, `refund_status` and `refund_provider_id` are
   * kept as history: they record that we DID ask and what came back, which is
   * the whole reason anybody is looking at this row.
   *
   * ⚠️ CONDITIONAL ON 'refund_requested' IN THE SQL, for the reason above.
   */
  releaseOneTimeRefundRequest(
    order_id: string,
    fields: { to_state: RefundReleaseTarget; reason: RefundReleaseReason; released_at: string },
    nowIso: string,
  ): 'released' | 'not_requested';
  advanceOneTimePurchase(
    order_id: string,
    patch: {
      state: OneTimePurchaseState;
      scheduled_at: string | null;
      /** 🔴 ASSIGNED WITH THE OTHER DELIVERY STAMPS, not coalesced — the same
       *  reasoning as `delivered_at`: a setup walked back from 'in_progress'
       *  must stop claiming it began. */
      started_at: string | null;
      delivered_at: string | null;
      /** 🔴 ASSIGNED WITH THE OTHERS, not coalesced. It is part of the
       *  delivery picture: a delivery walked back must stop claiming the buyer
       *  was told about it, or a re-delivery would carry the record of an
       *  email about a delivery we retracted. */
      completion_notice_at: string | null;
      refunded_at: string | null;
      transaction_id?: string | null;
      note?: string | null;
    },
    nowIso: string,
  ): void;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toPurchaseRow(r: Record<string, unknown>): OneTimePurchaseRow {
  return {
    order_id: String(r.order_id),
    provider: String(r.provider),
    user_id: str(r.user_id),
    product_id: str(r.product_id),
    checkout_id: str(r.checkout_id),
    transaction_id: str(r.transaction_id),
    customer_id: str(r.customer_id),
    amount_minor:
      r.amount_minor === null || r.amount_minor === undefined ? null : Number(r.amount_minor),
    currency: str(r.currency),
    // 🔴 SQLite has no enum, so an unknown value CAN reach here (a hand-edited
    // row, a future state written by a newer build). It is passed through as the
    // literal it is, NOT rounded to a known one: rounding to 'paid' would say
    // 「we still owe them a session」 and rounding to 'delivered' would say the
    // opposite, and both would be this repo inventing an answer about money and
    // an obligation. `isOneTimePurchaseState` is exported so the caller can gate
    // on it and say 「I do not recognise this」 out loud.
    state: isOneTimePurchaseState(r.state) ? r.state : (String(r.state) as OneTimePurchaseState),
    early_start_consent_at: str(r.early_start_consent_at),
    withdrawal_waiver_ack_at: str(r.withdrawal_waiver_ack_at),
    consent_terms_version: str(r.consent_terms_version),
    scheduled_at: str(r.scheduled_at),
    started_at: str(r.started_at),
    delivered_at: str(r.delivered_at),
    refund_requested_at: str(r.refund_requested_at),
    refund_provider_id: str(r.refund_provider_id),
    refund_status: str(r.refund_status),
    refunded_at: str(r.refunded_at),
    completion_notice_at: str(r.completion_notice_at),
    note: str(r.note),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    refund_released_at: str(r.refund_released_at),
    // 🔴 GATED ON THE PREDICATE, not cast. SQLite has no enum, so a hand-edited
    // row could carry any word here — and this one is READ BY THE SWEEP. A
    // silent cast would let 'provider-declined' (a typo) be neither of the two
    // things this system knows how to do: it would not stop the sweep, and
    // nothing would say so. NULL is the honest answer for a value we do not
    // recognise, and NULL means "the sweep still runs", which is the safe
    // direction — a buyer keeps a protection rather than losing one silently.
    // 🔴 THE STATE COLUMN ABOVE DOES THE OPPOSITE ON PURPOSE (it passes an
    // unknown value through) because there the callers are built to say "I do
    // not recognise this" out loud; here there is no caller that could.
    refund_release_reason: isRefundReleaseReason(r.refund_release_reason)
      ? r.refund_release_reason
      : null,
    refund_external_reference: str(r.refund_external_reference),
  };
}

export function makeOneTimePurchaseRepo(db: DatabaseSync): OneTimePurchaseRepo {
  // 🔴 `ON CONFLICT DO NOTHING` + `RETURNING` is what makes the idempotency
  // OBSERVABLE. `INSERT OR IGNORE` would swallow the conflict and leave the
  // caller unable to tell a fresh purchase from a redelivery; with RETURNING, a
  // conflict yields no row and that absence IS the answer.
  const insertPurchase = db.prepare(
    `INSERT INTO one_time_purchases
       (order_id, provider, user_id, product_id, checkout_id, transaction_id, customer_id,
        amount_minor, currency, state, early_start_consent_at, withdrawal_waiver_ack_at,
        consent_terms_version, scheduled_at, started_at, delivered_at, refund_requested_at,
        refund_provider_id, refund_status, refunded_at, completion_notice_at, note,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(order_id) DO NOTHING
     RETURNING order_id`,
  );
  const purchaseById = db.prepare('SELECT * FROM one_time_purchases WHERE order_id = ?');
  // 🔴 THE WHOLE REFUND POLICY, AS ONE ATOMIC CONDITION. Everything else that
  // decides 「can this be refunded」 — the console button, the operator queue's
  // badge, the sweep — is a PROJECTION of this WHERE clause, and this clause is
  // the only one that stops two clicks refunding one charge twice.
  //
  // 🔴 A STATE LIST, AND NOTHING ABOUT DATES (gs-5). 'delivered' is absent on
  // purpose: confirmed completion closes the no-reason refund at that instant,
  // and `completion_notice_at` is never consulted — it records the email, it
  // does not gate money. `refundWindow` in service-deadlines.ts is the
  // TypeScript transcription of this list and the pairing test holds the two
  // together.
  const claimRefund = db.prepare(
    `UPDATE one_time_purchases SET
       state = 'refund_requested',
       refund_requested_at = ?,
       refund_provider_id = ?,
       refund_status = ?,
       updated_at = ?
     WHERE order_id = ? AND state IN ('paid','scheduled','in_progress')`,
  );
  // ⚠️ `completion_notice_at IS NULL` IS PART OF THE MATCH, not a COALESCE, so
  // a second send keeps the date of the first letter rather than the latest.
  const stampNotice = db.prepare(
    `UPDATE one_time_purchases SET
       completion_notice_at = ?,
       updated_at = ?
     WHERE order_id = ? AND state = 'delivered' AND completion_notice_at IS NULL`,
  );
  // COALESCE, so a second call adds what it knows and erases nothing.
  const stampRefundFacts = db.prepare(
    `UPDATE one_time_purchases SET
       refund_provider_id = COALESCE(?, refund_provider_id),
       refund_status = COALESCE(?, refund_status),
       updated_at = ?
     WHERE order_id = ? AND state = 'refund_requested'`,
  );
  // COALESCE on the two provider fields: a webhook that names the refund adds
  // what it knows and never erases what the request already recorded.
  const confirmRefund = db.prepare(
    `UPDATE one_time_purchases SET
       state = 'refunded',
       refunded_at = COALESCE(refunded_at, ?),
       refund_provider_id = COALESCE(?, refund_provider_id),
       refund_status = COALESCE(?, refund_status),
       updated_at = ?
     WHERE order_id = ?`,
  );
  // ── the release path out of 'refund_requested' (2026-08-31) ──────────────
  //
  // 🔴 BOTH ARE CONDITIONAL ON `state = 'refund_requested'`, which is what makes
  // them incapable of doing anything to a row somebody else already moved. The
  // routes read the state first so they can answer 409 with a sentence a person
  // can act on; these conditions are what make that answer true under a race
  // between two operator tabs.
  //
  // ⚠️ `refunded_at` KEEPS ITS COALESCE, exactly as `confirmRefund` does. If a
  // webhook landed 'refunded' between the route's read and this write the UPDATE
  // matches nothing anyway — but if the ordering ever changes, the date the
  // money actually moved must not be rewritten by the date somebody typed it in.
  const settleRefundByHand = db.prepare(
    `UPDATE one_time_purchases SET
       state = 'refunded',
       refunded_at = COALESCE(refunded_at, ?),
       refund_external_reference = ?,
       updated_at = ?
     WHERE order_id = ? AND state = 'refund_requested'`,
  );
  // 🔴 ONE STATEMENT WRITES BOTH STAMPS. There is deliberately no way to set the
  // date without the reason: the reason is what decides whether the 14-day sweep
  // still protects this buyer, and a row carrying a release with no reason would
  // be a decision nobody made.
  const releaseRefundRequest = db.prepare(
    `UPDATE one_time_purchases SET
       state = ?,
       refund_released_at = ?,
       refund_release_reason = ?,
       updated_at = ?
     WHERE order_id = ? AND state = 'refund_requested'`,
  );
  const purchasesForUser = db.prepare(
    'SELECT * FROM one_time_purchases WHERE user_id = ? ORDER BY created_at DESC, order_id DESC LIMIT ?',
  );
  const allPurchases = db.prepare(
    'SELECT * FROM one_time_purchases ORDER BY created_at DESC, order_id DESC LIMIT ?',
  );
  // The delivery stamps are ASSIGNED; `transaction_id` and `note` keep
  // COALESCE. The consent stamps are absent from this UPDATE entirely — see the
  // interface for both decisions.
  //
  // ⚠️ THE THREE RELEASE COLUMNS ARE ABSENT TOO, and that is not an oversight:
  // they are not part of the delivery picture, they are the record of a
  // decision an operator already made and signed an audit row for. A purchase
  // released back to 'paid' and later delivered keeps saying WHY its refund
  // stopped — which is exactly what somebody reading it a year later needs.
  const advancePurchase = db.prepare(
    `UPDATE one_time_purchases SET
       state = ?,
       scheduled_at = ?,
       started_at = ?,
       delivered_at = ?,
       completion_notice_at = ?,
       refunded_at = ?,
       transaction_id = COALESCE(?, transaction_id),
       note = COALESCE(?, note),
       updated_at = ?
     WHERE order_id = ?`,
  );

  return {
    recordOneTimePurchase(row): 'inserted' | 'duplicate' {
      const res = insertPurchase.get(
        row.order_id,
        row.provider,
        row.user_id,
        row.product_id,
        row.checkout_id,
        row.transaction_id,
        row.customer_id,
        row.amount_minor,
        row.currency,
        row.state,
        row.early_start_consent_at,
        row.withdrawal_waiver_ack_at,
        row.consent_terms_version,
        row.scheduled_at,
        row.started_at,
        row.delivered_at,
        row.refund_requested_at,
        row.refund_provider_id,
        row.refund_status,
        row.refunded_at,
        row.completion_notice_at,
        row.note,
        row.created_at,
        row.created_at,
      );
      return res === undefined ? 'duplicate' : 'inserted';
    },
    getOneTimePurchase(order_id): OneTimePurchaseRow | null {
      const r = purchaseById.get(order_id) as Record<string, unknown> | undefined;
      return r === undefined ? null : toPurchaseRow(r);
    },
    listOneTimePurchasesForUser(user_id, limit): OneTimePurchaseRow[] {
      return (purchasesForUser.all(user_id, limit) as Record<string, unknown>[]).map(toPurchaseRow);
    },
    listAllOneTimePurchases(limit): OneTimePurchaseRow[] {
      return (allPurchases.all(limit) as Record<string, unknown>[]).map(toPurchaseRow);
    },
    requestOneTimeRefund(order_id, fields, nowIso): 'claimed' | 'not_refundable' {
      const res = claimRefund.run(
        fields.requested_at,
        fields.provider_id,
        fields.provider_status,
        nowIso,
        order_id,
      );
      // ⚠️ `changes` IS THE ANSWER: zero means the row was already delivered,
      // already refunded, already requested, or does not exist — all of which
      // are 「do not send money back」 and none of which is an error here.
      return res.changes > 0 ? 'claimed' : 'not_refundable';
    },
    stampRefundProviderFacts(order_id, fields, nowIso): void {
      stampRefundFacts.run(fields.provider_id, fields.provider_status, nowIso, order_id);
    },
    stampCompletionNotice(order_id, atIso, nowIso): void {
      stampNotice.run(atIso, nowIso, order_id);
    },
    confirmOneTimeRefund(order_id, fields, nowIso): 'confirmed' | 'unknown_order' {
      const res = confirmRefund.run(
        fields.refunded_at,
        fields.provider_id,
        fields.provider_status,
        nowIso,
        order_id,
      );
      return res.changes > 0 ? 'confirmed' : 'unknown_order';
    },
    settleOneTimeRefundByHand(order_id, fields, nowIso): 'settled' | 'not_requested' {
      const res = settleRefundByHand.run(
        fields.refunded_at,
        fields.external_reference,
        nowIso,
        order_id,
      );
      // `changes` IS THE ANSWER, same as the claim: zero means the row moved
      // between the caller's read and this write, or never existed.
      return res.changes > 0 ? 'settled' : 'not_requested';
    },
    releaseOneTimeRefundRequest(order_id, fields, nowIso): 'released' | 'not_requested' {
      const res = releaseRefundRequest.run(
        fields.to_state,
        fields.released_at,
        fields.reason,
        nowIso,
        order_id,
      );
      return res.changes > 0 ? 'released' : 'not_requested';
    },
    advanceOneTimePurchase(order_id, patch, nowIso): void {
      advancePurchase.run(
        patch.state,
        patch.scheduled_at,
        patch.started_at,
        patch.delivered_at,
        patch.completion_notice_at,
        patch.refunded_at,
        patch.transaction_id ?? null,
        patch.note ?? null,
        nowIso,
        order_id,
      );
    },
  };
}
