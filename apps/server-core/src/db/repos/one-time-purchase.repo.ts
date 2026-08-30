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
}

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
  recordOneTimePurchase(row: Omit<OneTimePurchaseRow, 'updated_at'>): 'inserted' | 'duplicate';
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
  const purchasesForUser = db.prepare(
    'SELECT * FROM one_time_purchases WHERE user_id = ? ORDER BY created_at DESC, order_id DESC LIMIT ?',
  );
  const allPurchases = db.prepare(
    'SELECT * FROM one_time_purchases ORDER BY created_at DESC, order_id DESC LIMIT ?',
  );
  // The delivery stamps are ASSIGNED; `transaction_id` and `note` keep
  // COALESCE. The consent stamps are absent from this UPDATE entirely — see the
  // interface for both decisions.
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
