// SPEC-REF:
//   apps/server-core/src/db/schema-billing.ts refund_requests DDL (the table,
//     and the reasoning for every column — especially why `kind` has two values)
//   apps/server-core/src/http/billing-routes.ts handleWithdraw (the writer)
//   apps/server-core/src/billing/paddle/webhook-handler.ts (`confirmRefundRequest`'s
//     caller — the `adjustment.updated` half of the pipeline)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// The `refund_requests` table's repo, split out of billing.repo.ts on
// 2026-09-02 (AUD-2 addendum to audit F4), same pressure and same remedy as
// `one-time-purchase.repo.ts`'s own split (see that file's header): adding
// `findSubmittedRefundForTransaction` pushed billing.repo.ts to 809 lines,
// nine over the 800-line cap. `BillingRepo extends RefundRequestRepo` and
// `makeBillingRepo` spreads this factory, so callers still hold ONE repo and
// there is still one answer per question.

import type { DatabaseSync } from 'node:sqlite';

/**
 * One row of `refund_requests` (0.3.25 B3).
 *
 * 🔴 `kind` separates a RIGHT from a REQUEST. A statutory withdrawal is executed,
 * never decided; a discretionary refund is decided by a person. The DDL argues
 * this at length — the short version is that one shared value would put a reject
 * button in front of a legal obligation.
 */
export interface RefundRequestRow {
  id: string;
  user_id: string;
  subscription_id: string;
  /** null when there was nothing to refund — see state 'none_due'. */
  transaction_id: string | null;
  kind: 'statutory_withdrawal' | 'discretionary';
  /** submitted = asked Paddle. failed = asked and could not. none_due = valid and
   *  there was nothing to give back. 🔴 None of the three means 「the money is
   *  back in their account」; only Paddle can say that, later. */
  state: 'submitted' | 'failed' | 'none_due';
  amount_minor: number | null;
  currency: string | null;
  paddle_adjustment_id: string | null;
  /** Paddle's own word, verbatim — usually `pending_approval` on a live account. */
  paddle_status: string | null;
  detail: string | null;
  created_at: string;
}

export interface RefundRequestRepo {
  /**
   * 0.3.25 B3 — record a refund we asked Paddle for, whatever the answer was.
   *
   * 🔴 IT IS WRITTEN ON EVERY PATH, INCLUDING THE FAILURES, and that is the
   * feature rather than diligence. A withdrawal that we accepted and then could
   * not refund is the single case someone will come back about, and if the only
   * trace of it is a log line that has rotated away, the conversation starts
   * with us saying 「we have no record of that」 to a person who is right.
   *
   * ⚠️ 'submitted' does NOT mean the money moved — Paddle usually holds refunds
   * for approval. `paddle_status` carries its word verbatim so no reader has to
   * infer, and so nobody can round it up.
   */
  recordRefundRequest(row: RefundRequestRow): void;
  /**
   * 2026-09-02 audit F3 — Paddle confirming (via `adjustment.updated`) that a
   * refund THIS SYSTEM SUBMITTED (a `refund_requests` row, `state:'submitted'`)
   * has settled. Matched by `transaction_id`, the id both sides already agree
   * on (see the SQL for why).
   *
   * 🔴 THIS DID NOT EXIST BEFORE, and its absence was the defect: the webhook
   * handler's only refund path (`confirmOneTimeRefund`) matches against
   * `one_time_purchases`, so a SUBSCRIPTION refund — which only ever lands a
   * row here, never there — could never be confirmed. Every subscription
   * refund landed as `outcome:'unmapped'` and `paddle_status` stayed frozen
   * at whatever it was when we submitted the request (usually
   * `pending_approval`), forever, even after Paddle actually paid it back.
   *
   * Returns `'confirmed'` only when a row's `state` was `'submitted'` and its
   * `transaction_id` matched — `'unknown_transaction'` covers both `no such
   * transaction_id` and `matched a transaction_id that was already 'failed'
   * or 'none_due'`, and the caller's response to both is identical: fall
   * through to the one-time-purchase path.
   */
  confirmRefundRequest(transaction_id: string, paddle_status: string | null): 'confirmed' | 'unknown_transaction';
  /** Every refund record for this account, newest first. Read by the console so
   *  a user can see 「requested on X, Paddle says pending」 rather than having to
   *  trust that something happened. */
  listRefundRequests(user_id: string, limit: number): RefundRequestRow[];
  /**
   * 2026-09-02 (AUD-2 addendum to audit F4) — the most recent SUBMITTED refund
   * already recorded for this exact Paddle transaction_id, or null.
   *
   * 🔴 WHY THIS EXISTS: `findRefundableTransaction` names the most recently
   * BILLED completed transaction on a subscription and — unlike the Creem
   * client's equivalent, which filters on `refunded_amount` — has no notion of
   * "already adjusted" (paddle/client.ts's `readTransactionList`). This is the
   * local backstop `http/billing-routes.ts` checks BEFORE calling
   * `createRefund` a second time for the same transaction. `state = 'submitted'`
   * only: a 'failed' attempt never reached Paddle and must not block a genuine
   * retry — see `confirmRefundRequestStmt`'s own comment for the same rule.
   */
  findSubmittedRefundForTransaction(transaction_id: string): RefundRequestRow | null;
}

/** One row → `RefundRequestRow`. 🔴 Narrowed by TEST, never by `as`: `kind` and
 *  `state` are free text in SQLite, and a hand-written cast on a DB string is a
 *  claim the compiler does not check — book 13 §7 F1 ⑤, which this repo has
 *  already paid for once. An unrecognised value falls to the safest reading
 *  rather than being asserted into a union it is not in. */
function toRefundRow(r: Record<string, unknown>): RefundRequestRow {
  return {
    id: String(r.id),
    user_id: String(r.user_id),
    subscription_id: String(r.subscription_id),
    transaction_id: r.transaction_id === null ? null : String(r.transaction_id),
    kind: r.kind === 'discretionary' ? 'discretionary' : 'statutory_withdrawal',
    state: r.state === 'submitted' || r.state === 'none_due' ? r.state : 'failed',
    amount_minor: r.amount_minor === null ? null : Number(r.amount_minor),
    currency: r.currency === null ? null : String(r.currency),
    paddle_adjustment_id: r.paddle_adjustment_id === null ? null : String(r.paddle_adjustment_id),
    paddle_status: r.paddle_status === null ? null : String(r.paddle_status),
    detail: r.detail === null ? null : String(r.detail),
    created_at: String(r.created_at),
  };
}

export function makeRefundRequestRepo(db: DatabaseSync): RefundRequestRepo {
  // 0.3.25 B3. A plain INSERT with no upsert arm: every refund we ask for is its
  // own event and two withdrawals a month apart are two rows, not one row
  // overwritten. The id is minted by the caller.
  const refundInsert = db.prepare(
    `INSERT INTO refund_requests
       (id, user_id, subscription_id, transaction_id, kind, state,
        amount_minor, currency, paddle_adjustment_id, paddle_status, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const refundsForUser = db.prepare(
    'SELECT * FROM refund_requests WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
  );
  // 2026-09-02 audit F3 — the webhook's confirmation that a SUBSCRIPTION
  // refund we submitted was approved. Matched on `transaction_id` because
  // that is the id `POST /adjustments` itself takes (billing-routes.ts's
  // withdrawal handler stores it on the row at submission time) and the same
  // id Paddle's `adjustment.updated` payload names — no separate mapping
  // table to keep in sync. `state = 'submitted'` in the WHERE clause on
  // purpose: a 'failed' or 'none_due' row never had a live adjustment at
  // Paddle to be approved, so it must not be silently touched by a
  // transaction_id collision (it also usually has no transaction_id at all).
  const confirmRefundRequestStmt = db.prepare(
    `UPDATE refund_requests
        SET paddle_status = ?
      WHERE transaction_id = ? AND state = 'submitted'`,
  );
  // 2026-09-02 (AUD-2 addendum to audit F4) — `state = 'submitted'` on purpose,
  // same reasoning as `confirmRefundRequestStmt` above: a 'failed' attempt
  // never reached Paddle, so it must not block a genuine retry on the same
  // transaction, only a submission that Paddle actually accepted may.
  const submittedRefundForTxn = db.prepare(
    `SELECT * FROM refund_requests WHERE transaction_id = ? AND state = 'submitted'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  );

  return {
    recordRefundRequest(row): void {
      refundInsert.run(
        row.id,
        row.user_id,
        row.subscription_id,
        row.transaction_id,
        row.kind,
        row.state,
        row.amount_minor,
        row.currency,
        row.paddle_adjustment_id,
        row.paddle_status,
        row.detail,
        row.created_at,
      );
    },
    confirmRefundRequest(transaction_id, paddle_status): 'confirmed' | 'unknown_transaction' {
      const res = confirmRefundRequestStmt.run(paddle_status, transaction_id);
      return res.changes > 0 ? 'confirmed' : 'unknown_transaction';
    },
    listRefundRequests(user_id, limit): RefundRequestRow[] {
      return (refundsForUser.all(user_id, limit) as Record<string, unknown>[]).map(toRefundRow);
    },
    findSubmittedRefundForTransaction(transaction_id): RefundRequestRow | null {
      const r = submittedRefundForTxn.get(transaction_id) as Record<string, unknown> | undefined;
      return r === undefined ? null : toRefundRow(r);
    },
  };
}
