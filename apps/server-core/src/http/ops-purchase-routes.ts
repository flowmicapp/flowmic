// SPEC-REF:
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts (the row, and why
//     the delivery stamps are assigned rather than coalesced)
//   apps/server-core/src/billing/guided-setup.ts (the promise being delivered)
//   apps/server-core/src/http/account-restriction-routes.ts (the shape this
//     follows: gate first, business audit row BEFORE the write, fail closed)
//   apps/server-core/src/http/ops-audit-trail.ts (the gate and its trail)
//   *** HUMAN-AUDIT SENSITIVE (billing + auth) — reviewable in isolation ***
//
// THE OPERATOR SIDE OF THE PAID SETUP SERVICE: seeing what is owed, and
// recording that it was booked or delivered.
//
// ── 🔴 WHY THIS FILE HAD TO EXIST BEFORE THE SERVICE COULD BE SOLD ─────────
//
// `advanceOneTimePurchase` landed with the table and had NO caller. With no
// caller every purchase stays 'paid' forever, and the customer console renders
// 'paid' as 「we will contact you within 3 business days」 — a sentence that
// would still be on the screen a month later, shown to somebody whose session
// already happened. That is this repo's named red line (a 「待…」 with no
// mechanism behind it) pointed at a customer who paid $200, so the buy button
// and this surface are one deliverable and not two.
//
// ── 🔴 WHAT AN OPERATOR CANNOT DO HERE, AND WHY EACH IS ABSENT ────────────
//
// · Set 'refunded'. Money moving back is a PROVIDER fact and arrives on a
//   webhook. A person typing 'refunded' into this route would make the row —
//   and the customer's console — claim a refund that Creem never made, which is
//   the exact 「said it was done when it was not」 half of no-silent-failure. So
//   'refunded' is refused by name here, and the refusal says where a refund
//   actually comes from.
// · Touch a purchase that IS refunded. That record is closed; re-opening it to
//   'delivered' would assert we still owe a session for money we gave back.
// · Touch a purchase whose refund is IN FLIGHT ('refund_requested'). The buyer
//   already pressed withdraw and we already asked the provider; marking it
//   'delivered' now would close the refund window (gs-5: `refundWindow`
//   answers 'completed' for delivered, and `requestOneTimeRefund`'s claim SQL
//   no longer matches) on a refund the buyer already exercised, and their
//   console would flip from 「we have asked for your money back」 to 「completed,
//   refunds closed」 — while the provider may still send the money back. A
//   stuck request (`refund_status: null`) has no release path from here
//   either; see billing/service-refund.ts's header — that path is a card.
// · Touch the two consent stamps. They are not in the repo's patch type at all
//   (see its interface) — the record a withdrawal dispute turns on is not
//   editable by the party it would exonerate.
// · Change an amount, a product, or a buyer. Nothing here writes any column the
//   money is described by.
//
// ── ⚠️ MOVING BACKWARDS IS ALLOWED, ON PURPOSE ───────────────────────────
//
// delivered → in_progress → scheduled → paid are legal, and this file's first
// draft refused them (「a delivery record should not be retractable」). That was
// wrong in the direction that costs a customer: an operator who clicks the
// wrong row marks a stranger's session delivered, that customer's console then
// says it is done AND their refund button disappears (gs-5), and nobody can put
// it back. The correction path IS the audit trail — every move writes a row
// naming the operator, the purchase and their note — so the mistake is
// recoverable AND findable, which beats irreversible and findable.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  OneTimePurchaseRepo,
  OneTimePurchaseRow,
  OneTimePurchaseState,
} from '../db/repos/one-time-purchase.repo';
import { isOneTimePurchaseState } from '../db/repos/one-time-purchase.repo';
import { purchaseNextStep } from '../billing/creem/client';
import {
  GUIDED_SETUP_AFTERCARE_DAYS,
  GUIDED_SETUP_CONTACT_BUSINESS_DAYS,
  GUIDED_SETUP_MAX_SESSION_HOURS,
} from '../billing/guided-setup';
import type { AccountVerifier } from './account-auth';
import { adminGate, type OpsAuditSink } from './ops-audit-trail';
import { readJsonBody, sendJson, str } from './console-http';
import type { RefundOrigin, ServiceRefundOutcome } from '../billing/service-refund';
import type { DeadlinePolicy } from '../billing/service-deadlines';
import { nextDeadlineAt, refundDueReason, refundRelease, refundWindow, supportUntil } from '../billing/service-deadlines';
import { PROMISED_DEADLINES } from '../billing/guided-setup';
import type { ServiceMailer } from '../mail/service-mailer';
import type { UserRepo } from '../db/repos/user.repo';
import { log } from '../log';



/** The two route literals this module serves. Written out here AND inline in
 *  the `if` conditions below: the coverage guard derives what a file serves by
 *  reading its source for path literals inside conditions, so a path assembled
 *  from a constant would be invisible to the one check that catches a new
 *  operator route that forgot its gate. */
export const PURCHASES_LIST_ROUTE = 'GET /api/ops/purchases';
export const PURCHASES_ADVANCE_ROUTE = 'POST /api/ops/purchases/advance';
/** 2026-08-30 — the operator presses the refund a deadline made due. */
export const PURCHASES_REFUND_ROUTE = 'POST /api/ops/purchases/refund';

/** `<domain>.<object>.<verb>`, ONE ACTION PER TARGET STATE.
 *
 *  🔴 NOT a single `ops.purchase.advance` carrying the state in `detail`. The
 *  question an operator asks this table six months later is 「what did we
 *  actually deliver」, and a single action name would make that a string search
 *  inside a free-text column — a value answering a second question. Four
 *  names, four equality matches. */
export const PURCHASE_SCHEDULE_ACTION = 'ops.purchase.schedule';
/** 2026-08-30 (gs-5) — the session has begun. */
export const PURCHASE_START_ACTION = 'ops.purchase.start';
export const PURCHASE_DELIVER_ACTION = 'ops.purchase.deliver';
/** Back to 'paid' — 「this is not done after all」, the correction move. */
export const PURCHASE_REOPEN_ACTION = 'ops.purchase.reopen';
/** 🔴 A FOURTH ACTION, and it is the only one that moves money. It is named for
 *  what it does — ASK — because that is all it does: the provider decides, and
 *  'refunded' is written by the webhook alone. */
export const PURCHASE_REFUND_ACTION = 'ops.purchase.refund';
/** `target_kind`. Kind and id stay two columns so 「every action against this
 *  order」 is an equality match and not a LIKE prefix. */
export const PURCHASE_TARGET_KIND = 'purchase';

/** Longest operator note this route will store. REFUSED, never truncated: a
 *  half-stored justification is a worse record than a rejected one, and the
 *  operator is the only person who can shorten it correctly. */
export const PURCHASE_NOTE_MAX = 500;

/** How many rows the operator list returns. No pagination, because the whole
 *  point of this surface is a work queue a person clears; if it ever needs
 *  paging, hitting the cap is the signal — and a silently truncated list is
 *  not, which is a bill this repo has already paid once. */
export const PURCHASES_LIST_LIMIT = 200;

// ── HTTP-LOCAL refusal strings ──────────────────────────────────────────────
//
// Not protocol `ErrorCode`s, and the boundary is the one the restriction route
// states: the only client that can reach these is the VPN-only operator
// console, so they are operator diagnostics rather than product copy. Minting
// protocol codes for them would be a façade — no FlowMic client would read one.
//
// 🔴 THREE STRINGS, because they demand three different operator actions:
// retype the id / pick a legal move / fix the database.

/** `order_id` is well-formed but names no purchase. */
export const PURCHASE_UNKNOWN = 'PURCHASE_UNKNOWN';
/** The requested move is not one this surface may make. */
export const PURCHASE_TRANSITION_INVALID = 'PURCHASE_TRANSITION_INVALID';
/** The audit row could not be written, so nothing was changed. */
export const PURCHASE_NOT_RECORDED = 'PURCHASE_NOT_RECORDED';
/** The purchase is not in a state a refund can be asked for. */
export const PURCHASE_NOT_REFUNDABLE = 'PURCHASE_NOT_REFUNDABLE';
/** We asked and the provider did not accept. THE MONEY HAS NOT MOVED, and the
 *  row is left showing 'refund_requested' so it stays visible in this queue. */
export const PURCHASE_REFUND_REFUSED = 'PURCHASE_REFUND_REFUSED';

/** The states an operator may move a purchase TO.
 *
 *  🔴 'refunded' IS ABSENT and that absence is the point — see this file's
 *  header. Declared as a tuple so the refusal message can list the legal values
 *  rather than a second hand-written copy of them drifting out of date. */
export const OPERATOR_SETTABLE_STATES = ['paid', 'scheduled', 'in_progress', 'delivered'] as const;
export type OperatorSettableState = (typeof OPERATOR_SETTABLE_STATES)[number];

function isOperatorSettable(v: unknown): v is OperatorSettableState {
  return v === 'paid' || v === 'scheduled' || v === 'in_progress' || v === 'delivered';
}

export interface OpsPurchaseRoutesDeps {
  /** The account verifier for the admin gate — the SAME `AuthService` instance
   *  every other http surface uses, sliced to what the gate needs. */
  auth: AccountVerifier;
  /**
   * 🔴 A THREE-METHOD SLICE, and the narrowness is the feature. The full
   * `BillingRepo` also carries `recordOneTimePurchase` (the webhook's writer)
   * and every subscription method. An operator route holding the webhook's
   * insert would put 「invent a purchase nobody paid for」 one body field away
   * from a surface whose entire job is to describe money that already moved.
   */
  purchases: Pick<
    OneTimePurchaseRepo,
    | 'listAllOneTimePurchases'
    | 'getOneTimePurchase'
    | 'advanceOneTimePurchase'
    // Stamped after the completion notice is accepted, and nowhere else.
    | 'stampCompletionNotice'
  >;
  /**
   * The channel the completion notice goes out on.
   *
   * ⚠️ OPTIONAL, AND ITS ABSENCE IS NOT A SILENT ONE. A deployment without it
   * can still record a delivery — the work happened, and the refund closes with
   * it (gs-5) — but it never stamps `completion_notice_at`, and the response
   * says so in `notice_sent: false`. The operator sees a delivery whose buyer
   * still has to be told, rather than a letter the record pretends went out.
   */
  mailer?: ServiceMailer;
  /** Where the buyer's address comes from. 🔴 THE ACCOUNT ROW, never a request
   *  field: an operator route that could name its own recipient would be a way
   *  to send a FlowMic-branded message to any address. */
  users?: Pick<UserRepo, 'findById'>;
  /** Where BOTH rows go — the gate's route row and this route's business row.
   *  REQUIRED, no `?` and no default: an optional sink would mean a bootstrap
   *  missing one line still advances purchases, untraceably, with nothing red. */
  audit: OpsAuditSink;
  /** Ask the provider to refund one purchase — the SAME function the customer's
   *  own withdraw button and the deadline sweep call. Three authorities, one
   *  code path, so what happens to the money cannot differ by who pressed. */
  refund?: (orderId: string, origin: RefundOrigin) => Promise<ServiceRefundOutcome>;
  /** The deadlines this deployment promised. Injected rather than imported so a
   *  test can move them without moving the clock. */
  deadlines?: DeadlinePolicy;
  now?: () => number;
}

/** The delivery stamps that belong to a state, given what the row already has.
 *
 *  🔴 ONE FUNCTION, because 「which stamps does this state imply」 is exactly
 *  the knowledge that must not be spread across the branches that write them.
 *  The repo ASSIGNS all four, so anything this function omits is CLEARED —
 *  which is how walking a mis-marked delivery back actually removes
 *  `delivered_at` instead of leaving the row disagreeing with itself.
 *
 *  The picture per target (gs-5):
 *    paid        → all null;
 *    scheduled   → scheduled_at set, started_at null, delivered_at null;
 *    in_progress → scheduled_at kept, started_at set, delivered_at null;
 *    delivered   → scheduled_at kept, started_at kept, delivered_at set.
 *  `completion_notice_at` is null unless the target is 'delivered', and on the
 *  way to 'delivered' it is PRESERVED, never invented — the route stamps it
 *  after the transport accepts the letter.
 *
 *  ⚠️ EACH STAMP SURVIVES FORWARD MOVES AND SURVIVES A MOVE BACK TO ITS OWN
 *  STATE (re-stamping would rewrite when a thing first happened, which is the
 *  only thing the timestamp is for). It is cleared only on a move to a state
 *  BEFORE it, where the claim being retracted is precisely that it happened. */
export function deliveryStampsFor(
  target: OperatorSettableState,
  row: Pick<OneTimePurchaseRow, 'scheduled_at' | 'started_at' | 'delivered_at' | 'completion_notice_at'>,
  nowIso: string,
): {
  scheduled_at: string | null;
  started_at: string | null;
  delivered_at: string | null;
  completion_notice_at: string | null;
} {
  switch (target) {
    case 'paid':
      return { scheduled_at: null, started_at: null, delivered_at: null, completion_notice_at: null };
    case 'scheduled':
      // 🔴 THE NOTICE STAMP IS CLEARED ON THE WAY BACK, and this is the whole
      // reason it belongs to the assigned set rather than being COALESCEd. A
      // delivery walked back was not delivered, so the record must not go on
      // saying the buyer was told it was; a re-made delivery sends its own
      // letter.
      return {
        scheduled_at: row.scheduled_at ?? nowIso,
        started_at: null,
        delivered_at: null,
        completion_notice_at: null,
      };
    case 'in_progress':
      return {
        scheduled_at: row.scheduled_at,
        started_at: row.started_at ?? nowIso,
        delivered_at: null,
        completion_notice_at: null,
      };
    case 'delivered':
      return {
        scheduled_at: row.scheduled_at,
        started_at: row.started_at,
        delivered_at: row.delivered_at ?? nowIso,
        // ⚠️ PRESERVED, NOT RE-STAMPED. Re-marking an already-delivered row must
        // not rewrite when the buyer was first told. The notice for a row
        // arriving here with null is sent AFTER the write, by the route, and
        // stamped separately.
        completion_notice_at: row.completion_notice_at,
      };
  }
}

/**
 * Tell the buyer their setup is complete, and stamp WHEN WE DID.
 *
 * 🔴 THE STAMP IS WRITTEN ONLY IF THE TRANSPORT ACCEPTED THE MESSAGE. It is a
 * record that the buyer was told (gs-5: the letter that names the end of their
 * refund right and the start of their support); stamping on 「we tried」 would
 * put a letter in the record that nobody received.
 *
 * ⚠️ IT DECIDES NOTHING ABOUT MONEY. The refund closed when the state became
 * 'delivered', whether or not this letter goes out. What a failure here costs
 * is a duty left undischarged — the queue shows the row as unnotified and a
 * person sends it by hand — never a change to what the buyer can do.
 *
 * 🔴 IT NEVER THROWS AND NEVER FAILS THE ADVANCE. The session really happened;
 * refusing to record it because a mail server had a bad minute would lose the
 * work.
 *
 * Returns whether the buyer was actually told, so the route can say so rather
 * than let the operator assume it.
 */
async function noticeAfterDelivery(
  deps: OpsPurchaseRoutesDeps,
  row: OneTimePurchaseRow,
  aftercareDays: number,
  nowIso: string,
): Promise<{ sent: boolean; why: string | null }> {
  // Already notified — a re-mark of a delivered row must not send a second
  // letter, and must not rewrite when the first one went.
  if (row.completion_notice_at !== null) return { sent: true, why: null };
  const mailer = deps.mailer;
  const users = deps.users;
  if (mailer === undefined || users === undefined) {
    log.error('ops: a setup was delivered but this deployment has no channel to tell the buyer', {
      order_id: row.order_id,
      // Names the consequence, not just the absence — an operator reading this
      // has to know what is now theirs to do.
      consequence: 'completion_notice_at stays null; the buyer has not been told and must be emailed by hand',
    });
    return { sent: false, why: 'no_mail_channel' };
  }
  // 🔴 A PURCHASE WITH NO ACCOUNT (`unmapped`) HAS NOBODY TO TELL. It is a real
  // state — the webhook writes it when a checkout carried no user id — and it
  // must not be turned into a crash or into a cheerful 「notified」.
  const email = row.user_id === null ? null : (users.findById(row.user_id)?.email ?? null);
  if (email === null || email === '') {
    log.error('ops: a setup was delivered but the buyer has no address on file', {
      order_id: row.order_id,
      user_id: row.user_id,
      consequence: 'completion_notice_at stays null; the buyer has not been told and must be reached another way',
    });
    return { sent: false, why: 'no_address' };
  }
  try {
    await mailer.sendSetupCompleted({ to: email, orderId: row.order_id, aftercareDays });
  } catch (err) {
    log.error('ops: the setup completion notice could not be delivered', {
      order_id: row.order_id,
      transport: mailer.id,
      reason: err instanceof Error ? err.message : String(err),
      consequence: 'completion_notice_at stays null; the buyer has not been told and must be emailed by hand',
    });
    return { sent: false, why: 'send_failed' };
  }
  deps.purchases.stampCompletionNotice(row.order_id, nowIso, nowIso);
  return { sent: true, why: null };
}

function actionFor(target: OperatorSettableState): string {
  switch (target) {
    case 'paid':
      return PURCHASE_REOPEN_ACTION;
    case 'scheduled':
      return PURCHASE_SCHEDULE_ACTION;
    case 'in_progress':
      return PURCHASE_START_ACTION;
    case 'delivered':
      return PURCHASE_DELIVER_ACTION;
  }
}

/** What the operator console renders per row — the customer console's
 *  projection plus the two fields only an operator needs. */
function toOperatorRow(
  p: OneTimePurchaseRow,
  nowMs: number,
  policy: DeadlinePolicy,
): Record<string, unknown> {
  return {
    order_id: p.order_id,
    provider: p.provider,
    // 🔴 THE ACCOUNT ID, NEVER THE EMAIL. An operator who needs the address has
    // the account list; putting it here would spread a contact detail onto a
    // second surface for the convenience of not clicking through.
    user_id: p.user_id,
    product_id: p.product_id,
    amount_minor: p.amount_minor,
    currency: p.currency,
    state: p.state,
    // Derived on every read, never a sentence stored on the row.
    next_step: purchaseNextStep(p, nowMs, GUIDED_SETUP_AFTERCARE_DAYS),
    // ⚠️ SURFACED because an operator handling a withdrawal request has to see
    // what the buyer agreed to and when, without a database prompt.
    consent: {
      early_start_at: p.early_start_consent_at,
      waiver_ack_at: p.withdrawal_waiver_ack_at,
      terms_version: p.consent_terms_version,
    },
    purchased_at: p.created_at,
    scheduled_at: p.scheduled_at,
    started_at: p.started_at,
    delivered_at: p.delivered_at,
    // The end of the buyer's two weeks of help (gs-5), from `delivered_at`;
    // null unless delivered.
    support_until: supportUntil(p, GUIDED_SETUP_AFTERCARE_DAYS),
    refund_requested_at: p.refund_requested_at,
    refund_provider_id: p.refund_provider_id,
    // 🔴 THE PROVIDER'S WORD, VERBATIM, AND `null` IS MEANINGFUL HERE: it means
    // we asked and have not heard back. That is the row an operator has to look
    // at, and it is distinguishable from 「the provider answered 'pending'」 only
    // because this is not flattened.
    refund_status: p.refund_status,
    refunded_at: p.refunded_at,
    // When the buyer was actually told their setup was done.
    //
    // 🔴 `null` ON A DELIVERED ROW IS THE ONE AN OPERATOR MUST ACT ON: it means
    // we recorded the work and never told them, and that letter is owed. It is
    // surfaced beside the state rather than folded into it because it is a
    // different question — 「did we finish」 and 「did we say so」 — and the
    // second one is ours to fix. ⚠️ It changes nothing about the refund (gs-5):
    // the console must not read a null here as 「still refundable」.
    completion_notice_at: p.completion_notice_at,
    // Computed on every read from the row and the clock — never stored, so it
    // cannot go on saying 「due」 after somebody acted.
    refund_due: refundDueReason(p, nowMs, policy),
    next_deadline_at: nextDeadlineAt(p, policy, GUIDED_SETUP_AFTERCARE_DAYS),
    // 🔴 THE SAME FUNCTION THE CUSTOMER'S CONSOLE RENDERS ITS BUTTON FROM, and a
    // projection of the same condition the claim SQL enforces. An operator who
    // could see 「refundable」 where the write would refuse (or the reverse) would
    // be looking at a second opinion about somebody's money.
    refund_window: refundWindow(p, nowMs, policy),
    // 🔴 WHETHER A HUMAN ALREADY RESOLVED A STUCK REFUND ON THIS ROW, and how.
    // An operator looking at a purchase back in 'paid' cannot otherwise tell it
    // from one that was never refunded at all — and the difference decides
    // whether the no-start sweep will pick it up (see service-deadlines.ts).
    refund_release: refundRelease(p),
    // 🔴 THE OPERATOR'S OWN PROOF, WHERE THEY CAN READ IT. A 'refunded' row with
    // this set was settled by a person, not confirmed by the provider — and this
    // string is the only handle anybody has for checking it.
    refund_external_reference: p.refund_external_reference,
    note: p.note,
    updated_at: p.updated_at,
  };
}

function refuseBadRequest(res: ServerResponse, message: string): void {
  // An EXISTING protocol code, already this http family's malformed-body
  // answer. The code table does not move for a new operator route.
  sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message });
}

/** Handle the saas operator purchase routes. Returns true iff it owned the
 *  request. */
export function tryHandleOpsPurchaseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsPurchaseRoutesDeps,
): boolean {
  const url = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;
  // Resolved ONCE for every branch: the queue renders its deadlines from it and
  // echoes it to the console. One policy, resolved in one place.
  const policy = deps.deadlines ?? PROMISED_DEADLINES;

  // ── GET /api/ops/purchases — the work queue ───────────────────────────────
  if (method === 'GET' && url === '/api/ops/purchases') {
    const who = adminGate(req, deps.auth, deps.audit, PURCHASES_LIST_ROUTE);
    if (!who.ok) {
      sendJson(res, who.status, { error: who.error });
      return true;
    }
    const rows = deps.purchases.listAllOneTimePurchases(PURCHASES_LIST_LIMIT);
    sendJson(res, 200, {
      // Served from the constants for the reason the customer route states: the
      // operator console renders the promise it is helping keep, and a second
      // copy in a client is how one of them goes on making the old one.
      contact_business_days: GUIDED_SETUP_CONTACT_BUSINESS_DAYS,
      max_session_hours: GUIDED_SETUP_MAX_SESSION_HOURS,
      // ⚠️ THE CAP IS ECHOED. A console holding 200 rows cannot otherwise tell
      // 「that is all of them」 from 「that is as many as we send」.
      limit: PURCHASES_LIST_LIMIT,
      // The deadline is echoed so the console renders the promise from the
      // server's number rather than a second copy of it. ⚠️ ONE deadline
      // (owner 2026-08-30): the completion deadline this queue used to flag on
      // booked setups was removed with the concept, not demoted.
      start_deadline_days: policy.startDeadlineDays,
      aftercare_days: GUIDED_SETUP_AFTERCARE_DAYS,
      purchases: rows.map((p) => toOperatorRow(p, now(), policy)),
    });
    return true;
  }

  // ── POST /api/ops/purchases/advance — record booked / delivered ──────────
  //
  // ONE route for every legal move rather than one per verb: 「what state is
  // this purchase in now」 must have exactly one writer, and two writers is how
  // they come to disagree. No batch form — a mis-typed bulk delivery would mark
  // a dozen strangers' sessions done at once.
  if (method === 'POST' && url === '/api/ops/purchases/advance') {
    // The gate FIRST, before a byte of the body is parsed.
    const who = adminGate(req, deps.auth, deps.audit, PURCHASES_ADVANCE_ROUTE);
    if (!who.ok) {
      sendJson(res, who.status, { error: who.error });
      return true;
    }
    const actor = who.userId;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const orderId = str(body.order_id).trim();
      if (orderId === '') return refuseBadRequest(res, 'order_id required');

      const rawState: unknown = body.state;
      if (!isOperatorSettable(rawState)) {
        // 🔴 'refunded' GETS ITS OWN SENTENCE rather than falling into the
        // generic list. It is the one wrong value an operator will reach for on
        // purpose, and 「not one of: paid, scheduled, in_progress, delivered」
        // would leave them believing the field is merely misspelled.
        const message =
          rawState === 'refunded'
            ? 'a refund is not recorded from here: it is a provider fact and arrives on a webhook. '
              + 'Refund at the provider, and this row will follow.'
            : `state must be one of: ${OPERATOR_SETTABLE_STATES.join(', ')}`;
        return refuseBadRequest(res, message);
      }
      const target: OperatorSettableState = rawState;

      // REQUIRED in every direction, exactly as the restriction route requires
      // one. 「Why was it marked delivered」 and 「why was it walked back」 are
      // both things the trail needs, and the second one more than the first.
      const note = str(body.note).trim();
      if (note === '') {
        return refuseBadRequest(
          res,
          'note required (it is the only thing the audit row can say about WHY)',
        );
      }
      if (note.length > PURCHASE_NOTE_MAX) {
        return refuseBadRequest(res, `note must be at most ${PURCHASE_NOTE_MAX} characters`);
      }

      const row = deps.purchases.getOneTimePurchase(orderId);
      // 404, not an idempotent cheerful 200: a mistyped id answered with
      // `ok:true` would tell an operator they had marked a session delivered
      // when they had marked nothing.
      if (row === null) {
        sendJson(res, 404, { error: PURCHASE_UNKNOWN, message: 'order_id names no purchase' });
        return;
      }
      // A refunded purchase is closed. Moving it to 'delivered' would assert we
      // still owe a session for money we already gave back.
      if (row.state === 'refunded') {
        sendJson(res, 409, {
          error: PURCHASE_TRANSITION_INVALID,
          message:
            'this purchase was refunded; its delivery record is closed and cannot be re-opened from here',
        });
        return;
      }
      // 🔴 A REFUND IN FLIGHT IS REFUSED TOO. 'refund_requested' means the buyer
      // already withdrew and we already asked the provider. Advancing it to
      // 'delivered' would close the refund window (gs-5) on a refund already
      // exercised; walking it back to 'paid'/'scheduled' would re-offer the
      // refund button on a charge the provider may be refunding right now —
      // a second click there is a duplicate refund. The webhook still lands
      // 'refunded' on this row via `confirmOneTimeRefund`, which does not pass
      // through here. Same code as above: it is one question (「may this row
      // move from here」) with the same operator action (do not).
      if (row.state === 'refund_requested') {
        sendJson(res, 409, {
          error: PURCHASE_TRANSITION_INVALID,
          message:
            'a refund is in flight for this purchase; it cannot be moved from here until the provider answers',
        });
        return;
      }
      // 🔴 AND A STATE WE DO NOT RECOGNISE IS REFUSED RATHER THAN OVERWRITTEN.
      // The repo passes unknown values through as the literals they are,
      // exactly so a caller can say 「I do not know what this row means」 out
      // loud instead of rounding it to something convenient. Advancing from an
      // unreadable state would be this route inventing the fact it starts from.
      if (!isOneTimePurchaseState(row.state)) {
        sendJson(res, 409, {
          error: PURCHASE_TRANSITION_INVALID,
          message: `this purchase is in a state this build does not recognise (${row.state}); refusing to move it`,
        });
        return;
      }

      const current: OneTimePurchaseState = row.state;
      // Idempotent, and the no-op writes NEITHER the row NOR a business audit
      // entry: each action name ASSERTS that the state changed, so appending
      // one for a no-op would put a change in the trail that never happened.
      // The attempt is not lost — `adminGate` already recorded that this admin
      // called this route, which is the division of labour ops-audit-trail.ts
      // describes.
      if (current === target) {
        sendJson(res, 200, {
          ok: true,
          order_id: row.order_id,
          state: current,
          next_step: purchaseNextStep(row, now(), GUIDED_SETUP_AFTERCARE_DAYS),
          changed: false,
        });
        return;
      }

      const nowIso = new Date(now()).toISOString();
      const stamps = deliveryStampsFor(target, row, nowIso);

      // ── the fail-closed half ────────────────────────────────────────────
      // The business row goes in BEFORE the write, and a failure leaves the
      // purchase untouched. This is the branch `recordGateOutcome` deliberately
      // does not take for its GETs; an unrecorded CHANGE to a delivery
      // obligation is a different animal from an unrecorded read.
      try {
        deps.audit.append({
          actor_user_id: actor,
          action: actionFor(target),
          target_kind: PURCHASE_TARGET_KIND,
          target_id: row.order_id,
          // The operator's own sentence and nothing else the request carried. A
          // `note` field EXISTS to be the recorded justification, so it is the
          // one caller-supplied value that belongs here; it is length-capped
          // above so it cannot become a body dump by another name.
          detail: note,
        });
      } catch (err) {
        log.error('ops: REFUSING to advance a purchase — the audit row could not be written', {
          route: PURCHASES_ADVANCE_ROUTE,
          actor,
          target: row.order_id,
          intent: actionFor(target),
          reason: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 503, {
          error: PURCHASE_NOT_RECORDED,
          message:
            'the operations audit row could not be written, so the purchase was left unchanged',
        });
        return;
      }

      deps.purchases.advanceOneTimePurchase(
        row.order_id,
        {
          state: target,
          scheduled_at: stamps.scheduled_at,
          started_at: stamps.started_at,
          delivered_at: stamps.delivered_at,
          completion_notice_at: stamps.completion_notice_at,
          // 🔴 EXPLICITLY THE ROW'S OWN VALUE, not `null`. The stamps are
          // assigned now, so passing null here would CLEAR a refund timestamp.
          // This route already refuses to touch 'refunded' AND
          // 'refund_requested' rows (both guards above), so the only way that
          // could bite is a future state that carries a refund stamp without
          // being one of those two — and stating it is cheaper than relying on
          // the guards above to stay true forever.
          refunded_at: row.refunded_at,
          note,
        },
        nowIso,
      );

      log.info('ops: purchase advanced', {
        actor,
        order_id: row.order_id,
        from: current,
        to: target,
      });

      // ── tell the buyer, AFTER the write ──────────────────────────────────
      //
      // 🔴 AFTER, NEVER BEFORE. The message says 「we have confirmed your setup
      // is complete」, and sending it first would make that sentence true only
      // if the write that follows it succeeds. A letter that has already left
      // is not retractable by a failed UPDATE.
      //
      // ⚠️ ONLY ON THE MOVE TO 'delivered'. Booking a session, starting one and
      // walking a delivery back are not things a buyer gets a completion notice
      // about.
      const notice =
        target === 'delivered'
          ? await noticeAfterDelivery(deps, { ...row, ...stamps }, GUIDED_SETUP_AFTERCARE_DAYS, nowIso)
          : { sent: false, why: null };

      sendJson(res, 200, {
        ok: true,
        order_id: row.order_id,
        state: target,
        next_step: purchaseNextStep({ state: target, delivered_at: stamps.delivered_at }, now(), GUIDED_SETUP_AFTERCARE_DAYS),
        scheduled_at: stamps.scheduled_at,
        started_at: stamps.started_at,
        delivered_at: stamps.delivered_at,
        changed: true,
        // 🔴 REPORTED SEPARATELY FROM `ok`, because they are separate facts and
        // the operator has to be able to see the second one fail while the first
        // succeeded. `notice_sent: false` on a delivered purchase means the
        // delivery IS recorded (and the refund is closed with it) and the buyer
        // was NOT told — so somebody has to send that letter by hand.
        ...(target === 'delivered'
          ? { notice_sent: notice.sent, ...(notice.why === null ? {} : { notice_failed: notice.why }) }
          : {}),
      });
    })();
    return true;
  }

  // ── POST /api/ops/purchases/refund — the operator presses a due refund ───
  //
  // 🔴 THIS IS NOT THE SAME THING AS 'refunded' ON THE ADVANCE ROUTE, which is
  // refused there and always will be. That refusal is about RECORDING a refund
  // nobody made; this route MAKES one — it calls the provider and writes
  // 'refund_requested', which says we asked. The webhook still owns 'refunded'.
  //
  // 🔴 IT IS THE DEFAULT PATH FOR BOTH DEADLINES (owner 2026-08-30: 「默认到期由
  // 运营队列中由人按一下」). The sweep that can do this unattended exists and is
  // switched OFF unless a deployment turns it on — the capability is built so
  // the promise is keepable, and the human stays in the loop by default.
  if (method === 'POST' && url === '/api/ops/purchases/refund') {
    const who = adminGate(req, deps.auth, deps.audit, PURCHASES_REFUND_ROUTE);
    if (!who.ok) {
      sendJson(res, who.status, { error: who.error });
      return true;
    }
    const actor = who.userId;
    void (async (): Promise<void> => {
      const refunder = deps.refund;
      if (refunder === undefined) {
        // No outbound client on this deployment. Named, not a 500: the request
        // was fine and so is the account.
        sendJson(res, 503, { error: PURCHASE_NOT_REFUNDABLE });
        return;
      }
      const body = await readJsonBody(req);
      const orderId = str(body.order_id).trim();
      if (orderId === '') return refuseBadRequest(res, 'order_id required');
      const note = str(body.note).trim();
      if (note === '') {
        return refuseBadRequest(res, 'note required (it is the only thing the audit row can say about WHY)');
      }
      if (note.length > PURCHASE_NOTE_MAX) {
        return refuseBadRequest(res, `note must be at most ${PURCHASE_NOTE_MAX} characters`);
      }

      // ── the fail-closed half, and it matters more here than anywhere ──────
      // The business row goes in BEFORE the money moves. An unrecorded refund
      // is worse than an unrecorded state change: it is a payment nobody
      // authorised on paper, and 「who sent this customer $200 back」 would have
      // no answer.
      try {
        deps.audit.append({
          actor_user_id: actor,
          action: PURCHASE_REFUND_ACTION,
          target_kind: PURCHASE_TARGET_KIND,
          target_id: orderId,
          detail: note,
        });
      } catch (err) {
        log.error('ops: REFUSING to refund — the audit row could not be written', {
          route: PURCHASES_REFUND_ROUTE,
          actor,
          target: orderId,
          reason: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 503, {
          error: PURCHASE_NOT_RECORDED,
          message: 'the operations audit row could not be written, so no refund was requested',
        });
        return;
      }

      const out = await refunder(orderId, 'operator');
      if (!out.ok) {
        if (out.reason === 'not_refundable' || out.reason === 'no_transaction') {
          sendJson(res, 409, { error: PURCHASE_NOT_REFUNDABLE, reason: out.reason });
          return;
        }
        sendJson(res, 502, { error: PURCHASE_REFUND_REFUSED, detail: out.detail });
        return;
      }
      log.warn('ops: refund requested by an operator', { actor, order_id: orderId });
      sendJson(res, 200, {
        ok: true,
        order_id: orderId,
        state: 'refund_requested',
        // ⚠️ The provider's own word, and usually NOT terminal. The console must
        // render 「asked」 off this, never 「refunded」.
        provider_status: out.providerStatus,
        settles_via_webhook: true,
      });
    })();
    return true;
  }

  // Anything else under this prefix falls to the router's 404 — the same
  // "no 405 for a known path" posture the other operator routes take: a 405
  // would tell an anonymous caller which paths exist before the gate refuses.
  return false;
}
