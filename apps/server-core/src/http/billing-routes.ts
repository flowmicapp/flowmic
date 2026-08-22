// SPEC-REF:
//   docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md
//     §2.2 US-3/US-4 (a simple mechanism to stop recurring charges), §3.3 (the
//     route table and the gate ruling), §4 B2
//   apps/server-core/src/billing/paddle/client.ts (the only outbound writer)
//   CLAUDE.md red line: no silent failure / one value answers only one question
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// THE SUBSCRIPTION CONTROLS. Two routes: stop the renewals, and undo that.
//
// ── 🔴 WHY THESE ARE NOT BEHIND THE TWO CONSOLE GATES ──────────────────────
// Every other `/api/cloud/*` route in console-routes.ts calls `refuseRestricted`
// then `refuseUnverified` before doing anything. These two deliberately do not,
// and it is a ruling rather than an omission.
//
// ROSCA §8403(3) requires a SIMPLE MECHANISM to stop recurring charges, and the
// state auto-renewal laws add that it must be as easy as subscribing was. An
// account whose mailbox stopped working, or one an operator has restricted, is
// still being charged every month — so gating the stop button on 「verify your
// email first」 or 「you may not use the product」 converts a billing relationship
// the user is entitled to end into one they cannot reach. That is the precise
// sentence those gates were written to avoid producing.
//
// ✅ THERE IS A DIRECT PRECEDENT AND IT IS OWNER'S, NOT AN INHERITED ONE:
// `GET /api/account/export` and `POST /api/account/delete` are exempt from both
// gates because 「the user may clear their own data and delete their account at
// will」. 「Stop taking my money」 is the same family of right — it is not a
// product feature, it is the exit — so it takes the same exemption.
//
// ⚠️ WHAT IS **NOT** EXEMPT: identity. The Bearer is still required and the
// subject is always the account it proved. There is no `user_id` in any body, so
// 「cancel someone else's subscription」 is unrepresentable rather than merely
// refused — the same construction account-lifecycle-routes.ts uses.
//
// ⚠️ THIS FILE IS IN `ROUTE_SOURCES` (test/console-admin-gate-coverage.test.ts),
// and the paths below are WRITTEN AS LITERALS in their `if` conditions because
// that scanner reads this source for them. A path assembled from a constant is
// invisible to the one check that catches a new route that forgot its gate —
// which matters more here than anywhere, since this file's answer to that check
// is 「exempt, on purpose」 and that has to be a visible claim.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AuthService } from '../auth/auth-service';
import type { BillingService, PlanView } from '../billing/billing-service';
import {
  PaddleWritesDisabledError,
  type CancelEffectiveFrom,
  type PaddleClient,
} from '../billing/paddle/client';
import { windowFromDeadline } from '../billing/withdrawal';
import type { BillingRepo, RefundRequestRow } from '../db/repos/billing.repo';
import type { SubscriptionMailer } from '../mail/subscription-mailer';
import { accountUserFromBearer } from './account-auth';
import { sendJson } from './console-http';
import { log } from '../log';

/** Refusal codes. HTTP-LOCAL strings and NOT protocol `ErrorCode`s, the same
 *  choice `PADDLE_SIGNATURE_INVALID` and `PRESENCE_AUTH_REQUIRED` made: the only
 *  reader is the web console, whose nine-locale copy lives in its own repo. A
 *  protocol code is the cross-boundary vocabulary carrying bilingual copy and
 *  riding the count guard; minting one with no FlowMic client reading it is the
 *  façade `CLOUD_SESSION_NO_HISTORY` was retired for. */
export const BILLING_NO_SUBSCRIPTION = 'BILLING_NO_SUBSCRIPTION';
export const BILLING_NOT_CANCELLABLE = 'BILLING_NOT_CANCELLABLE';
export const BILLING_WRITE_DISABLED = 'BILLING_WRITE_DISABLED';
export const BILLING_PADDLE_UNREACHABLE = 'BILLING_PADDLE_UNREACHABLE';
export const BILLING_PADDLE_REJECTED = 'BILLING_PADDLE_REJECTED';
/** 0.3.25 B3. 🔴 TWO codes for what the console renders identically, because the
 *  two SENTENCES are different and only one of them is a claim we can support.
 *  'closed' says the fourteen days ran out — true, checkable, and it points the
 *  user at a discretionary request. 'unknown' says WE cannot compute the period,
 *  which is a fact about our records, not about their rights: it happens for any
 *  subscription created before `contract_concluded_at` existed, and the person
 *  may well still be inside their window. Telling them 「your period has ended」
 *  would be us asserting something we do not know, about a legal right. */
export const BILLING_WITHDRAWAL_WINDOW_CLOSED = 'BILLING_WITHDRAWAL_WINDOW_CLOSED';
export const BILLING_WITHDRAWAL_WINDOW_UNKNOWN = 'BILLING_WITHDRAWAL_WINDOW_UNKNOWN';

export interface BillingRoutesDeps {
  auth: AuthService;
  /**
   * The plan solver, and the ONLY database this file touches — read only.
   *
   * 🔴 THERE IS DELIBERATELY NO `billingLedger` HERE. An earlier draft took the
   * repo too, and it earned its place in nothing: every fact these routes need
   * (the subscription id, whether a change is already scheduled) comes off
   * `getPlan`, which is the single point that answers 「what is this account's
   * subscription」. A second reader would be a second answer to that question,
   * and a WRITER would be worse: the local row's only author stays the webhook
   * handler, so that Paddle tells us what happened and we record it. Two authors
   * disagree on exactly the request where the network dropped after Paddle had
   * already committed.
   */
  billing: BillingService;
  paddle: PaddleClient;
  /** Confirmation mail. REQUIRED, never optional: a cancellation the user is
   *  never told about is the state a chargeback comes from, and a friendly
   *  no-op default is the 13 §7 F1 ② shape on a path that costs money. */
  mailer: SubscriptionMailer;
  /** 0.3.25 B3 — where a withdrawal is written down. REQUIRED. A withdrawal we
   *  executed but did not record is a conversation that starts with us saying
   *  「we have no record of that」 to a person who is right. */
  refunds: Pick<BillingRepo, 'recordRefundRequest'>;
  /** ms clock, injectable so the window boundary is testable at all. */
  now?: () => number;
  /** Mints refund-record ids. Injected so a test can assert the exact row. */
  newId?: () => string;
}

/** What a caller gets back. Deliberately NOT a PlanView: the local row has not
 *  been rewritten yet (the webhook does that, seconds later), so returning one
 *  would hand the console a plan object that is about to change and invite it to
 *  cache the stale half. This says only what Paddle just accepted. */
interface AcceptedBody {
  ok: true;
  /** Paddle's own status right after the write — a receipt, not our state. */
  paddle_status: string;
  scheduled_change: { action: string; effective_at: string | null } | null;
  /** 🔴 Says out loud that the local view is not updated yet, so a console that
   *  re-reads immediately and sees the old row knows it is looking at a race and
   *  not at a failed cancellation. Without this the obvious client behaviour —
   *  cancel, then refetch — reads as 「it did not work」 and the user cancels
   *  again, or calls their bank. */
  settles_via_webhook: true;
}

function accepted(res: ServerResponse, snapshot: { status: string; scheduled_change: AcceptedBody['scheduled_change'] }): void {
  const body: AcceptedBody = {
    ok: true,
    paddle_status: snapshot.status,
    scheduled_change: snapshot.scheduled_change,
    settles_via_webhook: true,
  };
  sendJson(res, 200, body);
}

/**
 * The Paddle write outcome → an HTTP answer, in ONE place so the two routes
 * cannot drift apart on what a failure means.
 *
 * 🔴 THE UNREACHABLE CASE IS **502 AND SAYS 「WE DO NOT KNOW」**, not 「it
 * failed」. A timeout can happen after Paddle has already committed the change,
 * so telling the user 「nothing happened」 would be a claim we cannot support —
 * and the repair they would choose (cancel again, or call the bank) is the
 * expensive one. The honest sentence the console renders is 「we could not
 * confirm it; check back in a minute」.
 */
function refuseFromPaddle(res: ServerResponse, code: string, detail: string): void {
  if (code === 'PADDLE_UNREACHABLE') {
    sendJson(res, 502, { error: BILLING_PADDLE_UNREACHABLE, detail });
    return;
  }
  sendJson(res, 502, { error: BILLING_PADDLE_REJECTED, detail });
}

/**
 * POST /api/cloud/billing/withdraw — the EU statutory right of withdrawal
 * (CRD art. 9, exercised through the art. 11a function the console renders).
 *
 * 🔴 IT IS TWO OPERATIONS AND THE SECOND ONE IS THE MONEY.
 * Paddle's `immediately` cancellation does not refund anything — its docs say so
 * plainly — so a withdrawal that only cancels has taken the service away and
 * kept the payment. That is the single most expensive mistake available in this
 * whole round, and it is one forgotten `await` away. This function is written so
 * that the cancel arm cannot reach a success response: everything after the
 * cancel falls through to the refund, and the only 200 in here is emitted after
 * a `refund_requests` row exists.
 *
 * ⚠️ WHY THERE IS NO PRO-RATA DEDUCTION. CRD art. 14(3) would let us keep a
 * share for service already supplied — but only where the consumer expressly
 * asked for performance to begin during the withdrawal period AND was told they
 * would owe it. We have never asked for that consent (there is no checkout yet).
 * Art. 14(4)(a) then says the consumer bears NO cost. `retainableFraction()`
 * returns 0 and says why; the missing piece is the consent, not the arithmetic.
 *
 * ⚠️ PARTIAL WITHDRAWAL (art. 11a) TAKES NO PARAMETER TODAY, and the reason is
 * measured rather than assumed: this product sells exactly one subscription per
 * account — `getPlan` resolves one, and the plan surface has no concept of a
 * second. A selector would be a control with one option, which is worse than no
 * control. If a second concurrent subscription ever becomes possible, this route
 * needs a `subscription_id` in the body BEFORE that ships, and the console needs
 * the per-item choice the article requires.
 */
async function handleWithdraw(
  res: ServerResponse,
  deps: BillingRoutesDeps,
  ctx: { userId: string; email: string; subId: string; view: PlanView },
): Promise<void> {
  const nowMs = deps.now?.() ?? Date.now();
  // 🔴 From the SAME field the console reads to decide whether to show the
  // function at all. Re-deriving it from the raw column here would be two
  // computations of one legal date, and the day they disagree we either offer a
  // right we refuse or refuse one we are offering.
  const window = windowFromDeadline(ctx.view.withdrawal_deadline, nowMs);
  if (window !== 'open') {
    // 🔴 The two refusals are NOT interchangeable — see the code declarations.
    // 409 rather than 403: nothing about the caller is unauthorised, the state
    // simply does not permit the action.
    const error = window === 'closed' ? BILLING_WITHDRAWAL_WINDOW_CLOSED : BILLING_WITHDRAWAL_WINDOW_UNKNOWN;
    log.info('billing: withdrawal refused', { user_id: ctx.userId, window });
    sendJson(res, 409, { error, deadline: ctx.view.withdrawal_deadline });
    return;
  }

  // ── ① the service stops NOW ───────────────────────────────────────────────
  // `immediately`, unlike /cancel. A withdrawal unwinds the contract rather than
  // declining to renew it, so leaving the service running to period end would be
  // the wrong shape — and it is paired with ② below, never alone.
  const cancelled = await deps.paddle.cancelSubscription(ctx.subId, 'immediately');
  if (!cancelled.ok) {
    log.warn('billing: withdrawal could not cancel at paddle', { user_id: ctx.userId, code: cancelled.code });
    refuseFromPaddle(res, cancelled.code, cancelled.detail);
    return;
  }

  // ── ② the money goes back ─────────────────────────────────────────────────
  const mint = deps.newId ?? (() => `rfd_${randomUUID()}`);
  const createdAt = new Date(nowMs).toISOString();
  const found = await deps.paddle.findRefundableTransaction(ctx.subId);

  let record: RefundRequestRow;
  if (!found.ok) {
    // 🔴 THE CANCELLATION HAS ALREADY HAPPENED. We cannot put it back, so this
    // is NOT an error response — answering 502 here would tell the user their
    // withdrawal failed while their subscription is, in fact, gone. It is
    // recorded as a failed refund that a human has to finish, the acknowledgement
    // still goes out, and the response says the refund is outstanding.
    record = {
      id: mint(), user_id: ctx.userId, subscription_id: ctx.subId, transaction_id: null,
      kind: 'statutory_withdrawal', state: 'failed', amount_minor: null, currency: null,
      paddle_adjustment_id: null, paddle_status: null,
      detail: `could not look up a refundable transaction: ${found.code} ${found.detail}`,
      created_at: createdAt,
    };
  } else if (found.data.found === null) {
    // A real and correct outcome: a subscription that was never charged has
    // nothing to give back. Its own state value, so it cannot be mistaken for a
    // failure by anyone reading the table later.
    record = {
      id: mint(), user_id: ctx.userId, subscription_id: ctx.subId, transaction_id: null,
      kind: 'statutory_withdrawal', state: 'none_due', amount_minor: null, currency: null,
      paddle_adjustment_id: null, paddle_status: null,
      detail: 'no completed transaction on this subscription — nothing to refund',
      created_at: createdAt,
    };
  } else {
    const txn = found.data.found;
    // 🔴 `reason` is OURS, a fixed string. Never anything the user typed: this
    // field lands in a vendor's dashboard and a free-text box is how a customer's
    // own words end up somewhere they never agreed to send them.
    const refund = await deps.paddle.createRefund({ transaction_id: txn.id, reason: 'statutory_withdrawal' });
    record = refund.ok
      ? {
          id: mint(), user_id: ctx.userId, subscription_id: ctx.subId, transaction_id: txn.id,
          kind: 'statutory_withdrawal', state: 'submitted',
          amount_minor: txn.amount_minor, currency: txn.currency,
          paddle_adjustment_id: refund.data.id,
          // Paddle's word, verbatim, all the way to the surface — usually
          // `pending_approval`. Nothing between here and the user may round it
          // up to 「refunded」.
          paddle_status: refund.data.status, detail: null, created_at: createdAt,
        }
      : {
          id: mint(), user_id: ctx.userId, subscription_id: ctx.subId, transaction_id: txn.id,
          kind: 'statutory_withdrawal', state: 'failed',
          amount_minor: txn.amount_minor, currency: txn.currency,
          paddle_adjustment_id: null, paddle_status: null,
          detail: `${refund.code} ${refund.detail}`, created_at: createdAt,
        };
  }
  deps.refunds.recordRefundRequest(record);

  // ── ③ the acknowledgement (art. 11a: durable medium, without undue delay) ──
  // 🔴 THIS ONE IS A LEGAL OBLIGATION, not a courtesy like the cancellation
  // email — and it still must not turn a completed withdrawal into an error
  // response. Failure is logged at ERROR, not warn: an unsent acknowledgement is
  // a duty we have not discharged and somebody has to send it by hand.
  await deps.mailer
    .sendWithdrawalAcknowledged({
      to: ctx.email,
      receivedAt: createdAt,
      subscriptionId: ctx.subId,
      refundState: record.state,
      amountMinor: record.amount_minor,
      currency: record.currency,
    })
    .catch((e: unknown) => {
      log.error('billing: WITHDRAWAL ACKNOWLEDGEMENT NOT SENT — art. 11a duty outstanding, send it by hand', {
        user_id: ctx.userId,
        refund_record_id: record.id,
        error: e instanceof Error ? e.name : String(e),
      });
    });

  log.info('billing: withdrawal executed', {
    user_id: ctx.userId,
    subscription_id: ctx.subId,
    refund_state: record.state,
    paddle_status: record.paddle_status,
  });
  sendJson(res, 200, {
    ok: true,
    paddle_status: cancelled.data.status,
    // 🔴 The refund's own state, reported separately from the cancellation's.
    // One combined 「ok」 would let a failed refund hide behind a successful
    // cancel, which is precisely the pair this route exists to keep together.
    refund: {
      state: record.state,
      paddle_status: record.paddle_status,
      amount_minor: record.amount_minor,
      currency: record.currency,
    },
    settles_via_webhook: true,
  });
}

/** Returns true iff it handled the request. */
export function tryHandleBillingRoutes(req: IncomingMessage, res: ServerResponse, deps: BillingRoutesDeps): boolean {
  const url = (req.url ?? '').split('?')[0];
  const method = req.method ?? 'GET';

  // 🔴 THE PATH LITERALS LIVE IN THE `if` CONDITIONS, NEXT TO THE METHOD, AND
  // THAT IS NOT A STYLE CHOICE. `test/console-admin-gate-coverage.test.ts` finds
  // the routes a source serves by regex over its `if (...)` conditions, pairing
  // each `'/api/…'` literal with each `method === 'X'` in the SAME condition.
  //
  // ⚠️ MEASURED, 2026-08-21, on this file: the first draft hoisted these two into
  // `const isCancel = url === '…'` above the branch. Every test in that suite
  // stayed GREEN — because the scanner found no routes here at all, so there was
  // nothing to classify and nothing to complain about. Registering the file in
  // ROUTE_SOURCES had bought exactly nothing, and the gate exemption these two
  // routes rely on would have gone unwatched while looking supervised.
  // ⇒ this repo's #1 façade shape, committed inside the file whose own header
  //   warns about it. A guard that cannot see a thing reports no problem with it.
  let action: 'cancel' | 'resume' | 'withdraw';
  if (method === 'POST' && url === '/api/cloud/billing/cancel') {
    action = 'cancel';
  } else if (method === 'POST' && url === '/api/cloud/billing/resume') {
    action = 'resume';
  } else if (method === 'POST' && url === '/api/cloud/billing/withdraw') {
    action = 'withdraw';
  } else {
    return false;
  }
  const isCancel = action === 'cancel';

  const who = accountUserFromBearer(req, deps.auth);
  if (!who.ok) {
    sendJson(res, 401, { error: who.error });
    return true;
  }
  // 🔴 NO refuseRestricted AND NO refuseUnverified — see this file's header.
  // If you are here to 「tidy」 a gate onto these two routes, you are re-gating
  // the stop-charging-me button, and test/billing-routes.test.ts will go red
  // with the reason rather than letting it land quietly.
  const user = who.user;

  void (async (): Promise<void> => {
    const view = deps.billing.getPlan(user.id);
    const subId = view.paddle_subscription_id;
    if (subId === null) {
      // 🔴 NOT 404. There is an account and it is readable; what is missing is a
      // Paddle subscription to act on. A named 409 lets the console say 「there
      // is nothing to cancel」 instead of 「that page does not exist」, which is
      // the sentence a user reads as 「your product is broken」.
      sendJson(res, 409, { error: BILLING_NO_SUBSCRIPTION });
      return;
    }

    try {
      if (action === 'withdraw') {
        await handleWithdraw(res, deps, { userId: user.id, email: user.email ?? '', subId, view });
        return;
      }
      if (isCancel) {
        // ⚠️ `next_billing_period`, ALWAYS, and never `immediately` from this
        // route. Immediate cancellation at Paddle does not refund the unused
        // part of the period (its docs are explicit), so 「cancel」 meaning
        // 「immediately」 would take the service away and keep the money — the
        // user has paid to the end of the period and keeps it. The immediate
        // path belongs to the statutory withdrawal in B3, where it is paired
        // with a refund adjustment.
        const effectiveFrom: CancelEffectiveFrom = 'next_billing_period';
        const out = await deps.paddle.cancelSubscription(subId, effectiveFrom);
        if (!out.ok) {
          log.warn('billing: cancel refused by paddle', { user_id: user.id, code: out.code });
          refuseFromPaddle(res, out.code, out.detail);
          return;
        }
        // 🔴 THE MAIL IS AWAITED AND ITS FAILURE IS NOT FATAL, in that order and
        // for two different reasons. Awaited, so a process that exits right
        // after the response has still handed the message over. Non-fatal,
        // because the cancellation HAS happened at Paddle: turning a mail
        // outage into a 502 here would tell the user their cancellation failed
        // when it did not, and they would do it again or call their bank.
        // The failure is logged by name — it is recorded, not swallowed.
        await deps.mailer
          .sendCancellationConfirmed({
            to: user.email ?? '',
            endsAt: out.data.scheduled_change?.effective_at ?? view.expires_at,
          })
          .catch((e: unknown) => {
            log.warn('billing: cancellation confirmed at paddle but the email did not go out', {
              user_id: user.id,
              error: e instanceof Error ? e.name : String(e),
            });
          });
        log.info('billing: cancellation scheduled', {
          user_id: user.id,
          subscription_id: subId,
          effective_at: out.data.scheduled_change?.effective_at ?? null,
        });
        accepted(res, out.data);
        return;
      }

      // ── resume ────────────────────────────────────────────────────────────
      //
      // 🔴 NO LOCAL PRECONDITION, and the removal of one is the point.
      //
      // This used to refuse with BILLING_NOTHING_SCHEDULED when
      // `view.scheduled_change` was null, reasoning that a PATCH clearing a
      // change that does not exist would come back 200 and let the console claim
      // work it had not done. The reasoning was sound and the value was wrong:
      // `view` comes from OUR row, which is written by the webhook, which
      // arrives seconds after the cancel — this route's own success body says so
      // in `settles_via_webhook`. So the guard fired exactly in the window it
      // should not have: cancel, realise the mistake, click undo, refused.
      // 「I cancelled by accident, let me put it back」 is a thing people do
      // within seconds, and a user who cannot undo it goes to their bank instead.
      //
      // ⚠️ MEASURED (2026-08-21, test/billing-e2e-mock-paddle.test.ts): cancel
      // then resume in the same request sequence returned 409. Neither unit test
      // could see it — they assert against a row a fixture had already written.
      //
      // ⇒ PADDLE IS THE AUTHORITY on whether there is something to clear, which
      //   is the same rule the rest of this file follows (the local row has one
      //   author, and it is not us). The 「success message for work that did not
      //   happen」 risk is answered where it actually lives — in what we report:
      //   the response carries Paddle's own post-state, so a console rendering
      //   `scheduled_change: null` is stating a fact rather than a hope.
      const out = await deps.paddle.clearScheduledChange(subId);
      if (!out.ok) {
        log.warn('billing: resume refused by paddle', { user_id: user.id, code: out.code });
        refuseFromPaddle(res, out.code, out.detail);
        return;
      }
      log.info('billing: scheduled change cleared', { user_id: user.id, subscription_id: subId });
      accepted(res, out.data);
    } catch (e) {
      if (e instanceof PaddleWritesDisabledError) {
        // 🔴 503, and a code of its own. This is a deployment that has not been
        // switched on — an operator's problem, not the user's and not Paddle's.
        // Collapsing it into the Paddle-rejected code would send whoever reads
        // the log to the wrong dashboard, and would let a completely dead
        // outbound path masquerade as a vendor having a bad day.
        log.error('billing: a subscription control was used while paddle writes are OFF', {
          user_id: user.id,
          message: e.message,
        });
        sendJson(res, 503, { error: BILLING_WRITE_DISABLED });
        return;
      }
      log.warn('billing: subscription control failed', {
        user_id: user.id,
        error: e instanceof Error ? e.message : String(e),
      });
      sendJson(res, 500, { error: BILLING_NOT_CANCELLABLE });
    }
  })();

  return true;
}
