// SPEC-REF:
//   apps/server-core/src/billing/service-refund.ts (the claim that creates the
//     stuck row, and why it is left claimed when the provider says no)
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts
//     (settleOneTimeRefundByHand / releaseOneTimeRefundRequest — the two writes)
//   apps/server-core/src/billing/service-deadlines.ts (what the reason costs)
//   apps/server-core/src/http/ops-purchase-routes.ts (the shape this follows:
//     gate first, business audit row BEFORE the write, fail closed — and the
//     refusal strings, which are imported rather than re-declared)
//   *** HUMAN-AUDIT SENSITIVE (billing + auth) — reviewable in isolation ***
//
// THE WAY OUT OF 'refund_requested'.
//
// ── 🔴 THE PROBLEM, STATED AS THE DEFECT IT IS ────────────────────────────
//
// `requestServiceRefund` claims the row BEFORE it calls the provider, on
// purpose: the other order refunds one charge twice under two tabs, and a
// duplicate refund is money we cannot get back by apologising. The cost of that
// order is stated in its own header — if the provider then refuses, the row sits
// in 'refund_requested' with no refund behind it.
//
// Until this file existed, that was a ONE-WAY DOOR. Only the provider's
// `refund.created` webhook could leave the state, and a provider that never
// accepted the request will never send one. So the purchase froze:
//
//   · the buyer's console said "we have asked for your money back", for ever,
//     with no button and nothing to do;
//   · the operator console labelled the row "Closed" — which is false, and
//     falsely reassuring: the money may not have moved at all;
//   · `advanceOneTimePurchase` refuses the row by design, and correctly (that
//     route was an undesigned backdoor into a refund decision). That refusal is
//     not what is fixed here and must stay.
//
// ── 🔴 EXACTLY TWO HONEST OUTCOMES, AND NO THIRD ──────────────────────────
//
//   A. THE REFUND DID HAPPEN AND WE COULD NOT SEE IT (a lost webhook, a bank
//      transfer). -> 'refunded', terminal, AND an external reference is
//      REQUIRED. "Refunded" is a claim about money our system never observed;
//      without a reference the row would assert a fact with nothing at all
//      behind it. The reference is also what makes a human-asserted refund
//      distinguishable for ever from a provider-confirmed one — a distinction
//      that is deliberately NOT encoded by overloading `refund_status`, because
//      that column holds the provider's own word and must go on being readable
//      as such.
//
//   B. THE REFUND WILL NOT HAPPEN — the provider declined it, or the buyer
//      withdrew the request. -> back to one of paid / scheduled / in_progress,
//      chosen by the operator, and the buyer keeps the right to ask again while
//      the service is not yet completed (`refundWindow` is a function of state,
//      so the withdraw button returns on its own).
//
// 🔴 NEITHER MAY REACH 'delivered'. Declaring a setup complete is a separate,
// visible action with its own audit row and its own letter to the buyer. If a
// release could land on 'delivered' then one click would both end a refund AND
// close the refund window on it, and the trail would name only the first — a
// refund decision hidden inside a delivery. 'delivered' is therefore refused BY
// NAME here, with a sentence saying where a delivery actually comes from.
//
// ── ⚠️ THE TWO SUB-REASONS OF (B) ARE NOT COSMETIC ────────────────────────
//
// `provider_declined` takes the row off the unattended 14-day no-start sweep
// for ever; `buyer_withdrew_request` deliberately leaves it on. The full
// argument is at the top of billing/service-deadlines.ts. What matters at this
// surface is that the operator is choosing between two behaviours, not two
// labels, and the console is required to say so at the moment they choose.
//
// ── 🔴 2026-09-02 audit P3: A RACE THE WRITE LOSES MUST NOT LOOK LIKE A RACE
//    THE WRITE WON ─────────────────────────────────────────────────────────
//
// `loadRequestedRefund` checks the state, `auditFirst` writes the business row,
// THEN `settleOneTimeRefundByHand` / `releaseOneTimeRefundRequest` run their own
// atomic state test — and that gap is real: another operator tab, or the
// provider's webhook, can move the row between the check and the write. Before
// this fix, a race lost there still left the FIRST audit row standing alone,
// claiming an action ("settled", "released") that the outcome right below it
// says never happened. Audit rows are append-only (no `update`, no `remove` —
// ops-audit.repo.ts), so the fix is not to suppress or delete that row, it is
// to follow it with `PURCHASE_REFUND_SETTLE_NOT_APPLIED_ACTION` /
// `_RELEASE_NOT_APPLIED_ACTION` (`auditRaceLost`, below) the moment the write
// answers `'not_requested'`. The reader of this trail a year later then sees
// both true things in order: we tried, and it did not take effect.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  OneTimePurchaseRepo,
  OneTimePurchaseRow,
  RefundReleaseReason,
  RefundReleaseTarget,
} from '../db/repos/one-time-purchase.repo';
import {
  REFUND_RELEASE_REASONS,
  REFUND_RELEASE_TARGETS,
  isRefundReleaseReason,
  isRefundReleaseTarget,
} from '../db/repos/one-time-purchase.repo';
import type { AccountVerifier } from './account-auth';
import { adminGate, type OpsAuditSink } from './ops-audit-trail';
import { readJsonBody, sendJson, str } from './console-http';
import {
  PURCHASE_NOTE_MAX,
  PURCHASE_NOT_RECORDED,
  PURCHASE_TARGET_KIND,
  PURCHASE_TRANSITION_INVALID,
  PURCHASE_UNKNOWN,
} from './ops-purchase-routes';
import type { ServiceMailer } from '../mail/service-mailer';
import type { UserRepo } from '../db/repos/user.repo';
import { log } from '../log';

/** The two route literals this module serves. Written out here AND inline in
 *  the `if` conditions below, for the reason ops-purchase-routes.ts states: the
 *  coverage guard derives what a file serves by reading its source for path
 *  literals inside conditions, so a path assembled from a constant would be
 *  invisible to the one check that catches an operator route with no gate. */
export const PURCHASES_REFUND_SETTLE_ROUTE = 'POST /api/ops/purchases/refund/settle';
export const PURCHASES_REFUND_RELEASE_ROUTE = 'POST /api/ops/purchases/refund/release';

/** `<domain>.<object>.<verb>`, ONE ACTION PER OUTCOME — the same rule the four
 *  advance actions follow. "What did we actually do about this stuck refund" is
 *  a question somebody asks this table months later, and a single
 *  `ops.purchase.refund_resolve` carrying the outcome in `detail` would make it
 *  a string search inside a free-text column: one value answering two
 *  questions, which is this repo's number-one defect shape. */
export const PURCHASE_REFUND_SETTLE_ACTION = 'ops.purchase.refund_settle';
export const PURCHASE_REFUND_RELEASE_ACTION = 'ops.purchase.refund_release';

/**
 * 2026-09-02 audit P3 — the other half of the pair above, for the ONE outcome
 * neither of them named: the atomic write raced and lost AFTER the business
 * row already went in.
 *
 * 🔴 THE GAP THIS CLOSES. `auditFirst` runs before `settleOneTimeRefundByHand`
 * / `releaseOneTimeRefundRequest`, on purpose — a change must never land
 * unrecorded (see `auditFirst`'s own comment). But the state test that decides
 * whether the change actually happens lives INSIDE that later UPDATE
 * (`one-time-purchase.repo.ts`'s own comment on both methods says so, for the
 * same reason: only the atomic write can stop two operator tabs racing).
 * Between those two steps sits a real gap — a second tab, or the webhook,
 * landing 'refunded' first — and until this fix the FIRST audit row survived
 * a race it turned out to lose: the trail said "we settled this" or "we
 * released this" on a row that never moved, and there was nothing beside it
 * saying so.
 *
 * 🔴 THE OPTIONS WERE NOT "SILENCE" OR "DELETE". Audit rows are append-only
 * (ops-audit.repo.ts's own interface has no `update` and no `remove`, and that
 * absence IS the enforcement) — the first row cannot be taken back. Reusing
 * `PURCHASE_REFUND_SETTLE_ACTION`/`_RELEASE_ACTION` for the correction would
 * repeat the exact defect this file's header names for the outcome pair above:
 * a value search would then have to read `detail` to learn which of two
 * opposite facts a row records. So the correction gets its OWN name, matching
 * the ONE-ACTION-PER-OUTCOME rule those two already follow.
 *
 * ⚠️ `ops_audit_log` has no dedicated outcome column (read its DDL) — `detail`
 * is the only free-text field a caller controls, which is why the outcome is
 * carried in the ACTION NAME rather than a `detail:'no_change'` convention
 * that a later reader could miss.
 */
export const PURCHASE_REFUND_SETTLE_NOT_APPLIED_ACTION = 'ops.purchase.refund_settle_not_applied';
export const PURCHASE_REFUND_RELEASE_NOT_APPLIED_ACTION = 'ops.purchase.refund_release_not_applied';

/** Longest external reference this route will store. REFUSED, never truncated —
 *  the same rule as the note, and it bites harder here: half a bank reference
 *  is not a shorter reference, it is a wrong one, and this string exists purely
 *  so somebody can look the payment up. */
export const PURCHASE_EXTERNAL_REFERENCE_MAX = 200;

export interface OpsRefundReleaseRoutesDeps {
  /** The admin gate's verifier — the SAME `AuthService` every other http
   *  surface uses, sliced to what the gate needs. */
  auth: AccountVerifier;
  /**
   * 🔴 A THREE-METHOD SLICE, and the narrowness is the point, exactly as it is
   * on the advance route. `advanceOneTimePurchase` is NOT among them: this
   * surface must not be able to reach the delivery states by another name, and
   * the refusal of 'delivered' below would be decoration if the object in hand
   * could write it anyway.
   */
  purchases: Pick<
    OneTimePurchaseRepo,
    'getOneTimePurchase' | 'settleOneTimeRefundByHand' | 'releaseOneTimeRefundRequest'
  >;
  /**
   * The channel the buyer is told on.
   *
   * ⚠️ OPTIONAL, AND ITS ABSENCE IS NOT SILENT. A deployment without it still
   * makes the state change — mail must never gate a write that has already been
   * audited — but it logs the consequence and reports `notice_sent: false`, so
   * the operator knows a letter is owed rather than assuming one went out.
   */
  mailer?: ServiceMailer;
  /** Where the buyer's address comes from. 🔴 THE ACCOUNT ROW, never a request
   *  field: an operator route that could name its own recipient would be a way
   *  to send a FlowMic-branded message to any address. */
  users?: Pick<UserRepo, 'findById'>;
  /** Where BOTH rows go — the gate's route row and this route's business row.
   *  REQUIRED, no `?` and no default: an optional sink would mean a bootstrap
   *  missing one line still resolves refunds, untraceably, with nothing red. */
  audit: OpsAuditSink;
  now?: () => number;
}

function refuseBadRequest(res: ServerResponse, message: string): void {
  // An EXISTING protocol code, already this http family's malformed-body
  // answer. The code table does not move for a new operator route.
  sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message });
}

/** The operator's note, validated the way both neighbouring routes validate
 *  theirs. Returns the trimmed note, or null after having answered 400. */
function readNote(res: ServerResponse, body: Record<string, unknown>): string | null {
  const note = str(body.note).trim();
  if (note === '') {
    refuseBadRequest(res, 'note required (it is the only thing the audit row can say about WHY)');
    return null;
  }
  if (note.length > PURCHASE_NOTE_MAX) {
    refuseBadRequest(res, `note must be at most ${PURCHASE_NOTE_MAX} characters`);
    return null;
  }
  return note;
}

/**
 * Load the purchase and prove it is one this surface may act on.
 *
 * 🔴 409 AND NOT 404 FOR THE WRONG STATE, and the difference is the operator's
 * next move: 404 means "retype the id", 409 means "this row is not where you
 * think it is — go and look at it". Both routes here only ever act on
 * 'refund_requested', and that is asserted once, here, so the two cannot drift.
 *
 * ⚠️ THIS IS NOT THE ENFORCEMENT POINT. Both repo methods carry the same state
 * test inside their UPDATE, because only the atomic write can stop two operator
 * tabs settling and releasing the same row. This check exists so the answer is a
 * sentence rather than a silent no-op.
 */
function loadRequestedRefund(res: ServerResponse, deps: OpsRefundReleaseRoutesDeps, orderId: string): OneTimePurchaseRow | null {
  const row = deps.purchases.getOneTimePurchase(orderId);
  if (row === null) {
    sendJson(res, 404, { error: PURCHASE_UNKNOWN, message: 'order_id names no purchase' });
    return null;
  }
  if (row.state !== 'refund_requested') {
    sendJson(res, 409, {
      error: PURCHASE_TRANSITION_INVALID,
      // Names the state it IS in: an operator who reached this route reached it
      // from a row that looked stuck, and "it is not stuck any more, it is
      // refunded" is a different day's work from "you clicked the wrong row".
      message:
        `this purchase is in state '${row.state}', not 'refund_requested'; `
        + 'only a refund that is still in flight can be settled or released here',
    });
    return null;
  }
  return row;
}

/** Write the business row BEFORE the state change, and say so if it fails.
 *  Returns false after having answered 503 and changed nothing. */
function auditFirst(
  res: ServerResponse,
  deps: OpsRefundReleaseRoutesDeps,
  input: { actor: string; action: string; orderId: string; note: string; route: string },
): boolean {
  try {
    deps.audit.append({
      actor_user_id: input.actor,
      action: input.action,
      target_kind: PURCHASE_TARGET_KIND,
      target_id: input.orderId,
      // The operator's own sentence and nothing else the request carried. It is
      // length-capped above so it cannot become a body dump by another name.
      detail: input.note,
    });
    return true;
  } catch (err) {
    log.error('ops: REFUSING to resolve a stuck refund — the audit row could not be written', {
      route: input.route,
      actor: input.actor,
      target: input.orderId,
      intent: input.action,
      reason: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 503, {
      error: PURCHASE_NOT_RECORDED,
      message: 'the operations audit row could not be written, so the purchase was left unchanged',
    });
    return false;
  }
}

/**
 * 2026-09-02 audit P3 — append the correction row when the write `auditFirst`
 * preceded turns out to have been a no-op (the atomic UPDATE answered
 * `'not_requested'`, meaning the row left `refund_requested` between the
 * pre-check and the write).
 *
 * 🔴 BEST-EFFORT, ON PURPOSE, AND NEVER FED BACK INTO THE RESPONSE. The write
 * genuinely did not happen — the purchase is untouched, and the 409 the caller
 * sends afterwards is already the true answer. A failure here is a failure to
 * ANNOTATE a row that already exists, not a failure to protect money, so it
 * does not get `auditFirst`'s fail-closed treatment (there is nothing left to
 * fail closed on: the state change this whole file exists to gate never
 * happened). It is still never silent — a failure here means the FIRST row
 * goes on claiming an action that did not occur, which is exactly the defect
 * this function exists to close, so it is logged at ERROR with that stated
 * out loud.
 */
function auditRaceLost(
  deps: OpsRefundReleaseRoutesDeps,
  input: { actor: string; action: string; orderId: string; route: string },
): void {
  try {
    deps.audit.append({
      actor_user_id: input.actor,
      action: input.action,
      target_kind: PURCHASE_TARGET_KIND,
      target_id: input.orderId,
      detail:
        "did not take effect: the purchase left 'refund_requested' between the pre-check and the "
        + 'write (another operator, or the provider webhook, resolved it first)',
    });
  } catch (err) {
    log.error(
      'ops: could not append the not-applied correction row — the earlier row still claims an action that never happened',
      {
        route: input.route,
        actor: input.actor,
        target: input.orderId,
        intent: input.action,
        reason: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * Tell the buyer, AFTER the write, and never let it change the write.
 *
 * 🔴 A SILENT REVERT IS THE SAME CLASS OF DEFECT AS THE FROZEN ROW THIS FILE
 * FIXES. The buyer's console has been saying "we have asked for your money
 * back"; if that sentence simply stops appearing one day with no letter, they
 * are left to discover on their own that a refund they exercised is not coming.
 *
 * 🔴 AND IT NEVER FAILS THE ACTION. The decision was made by a named operator
 * and is already in the audit trail; refusing to record it because a mail server
 * had a bad minute would lose the decision and leave the row stuck — which is
 * precisely the state being escaped. What a failure costs is a duty left
 * undischarged, and it is LOGGED with its consequence rather than swallowed.
 *
 * Returns whether the buyer was actually told, so the response can say so
 * instead of letting the operator assume it.
 */
async function tellBuyer(
  deps: OpsRefundReleaseRoutesDeps,
  row: OneTimePurchaseRow,
  send: (mailer: ServiceMailer, to: string) => Promise<void>,
  what: string,
): Promise<{ sent: boolean; why: string | null }> {
  const mailer = deps.mailer;
  const users = deps.users;
  if (mailer === undefined || users === undefined) {
    log.error('ops: a stuck refund was resolved but this deployment has no channel to tell the buyer', {
      order_id: row.order_id,
      what,
      consequence: 'the buyer has NOT been told their refund request ended and must be emailed by hand',
    });
    return { sent: false, why: 'no_mail_channel' };
  }
  // 🔴 A PURCHASE WITH NO ACCOUNT (`unmapped`) HAS NOBODY TO TELL. It is a real
  // state — the webhook writes it when a checkout carried no user id — and it
  // must not become a crash or a cheerful "notified".
  const email = row.user_id === null ? null : (users.findById(row.user_id)?.email ?? null);
  if (email === null || email === '') {
    log.error('ops: a stuck refund was resolved but the buyer has no address on file', {
      order_id: row.order_id,
      user_id: row.user_id,
      what,
      consequence: 'the buyer has NOT been told and must be reached another way',
    });
    return { sent: false, why: 'no_address' };
  }
  try {
    await send(mailer, email);
  } catch (err) {
    log.error('ops: the refund-resolution notice could not be delivered', {
      order_id: row.order_id,
      transport: mailer.id,
      what,
      reason: err instanceof Error ? err.message : String(err),
      consequence: 'the state change STOOD; the buyer has NOT been told and must be emailed by hand',
    });
    return { sent: false, why: 'send_failed' };
  }
  return { sent: true, why: null };
}

/** Handle the two refund-resolution routes. Returns true iff it owned the
 *  request. */
export function tryHandleOpsRefundReleaseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsRefundReleaseRoutesDeps,
): boolean {
  const url = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;

  // ── POST /api/ops/purchases/refund/settle — outcome A ────────────────────
  //
  // 🔴 THE SECOND WRITER OF 'refunded' IN THE WHOLE PRODUCT, and the only thing
  // that entitles it to exist is the external reference it will not proceed
  // without. `ops-purchase-routes.ts` refuses 'refunded' by name for a reason
  // that is still true — a person typing "refunded" into a state field would
  // make the row claim a refund nobody made — and this route does not weaken
  // that: it demands the operator produce the thing that makes the claim
  // checkable by the person it is about.
  if (method === 'POST' && url === '/api/ops/purchases/refund/settle') {
    const who = adminGate(req, deps.auth, deps.audit, PURCHASES_REFUND_SETTLE_ROUTE);
    if (!who.ok) {
      sendJson(res, who.status, { error: who.error });
      return true;
    }
    const actor = who.userId;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const orderId = str(body.order_id).trim();
      if (orderId === '') return refuseBadRequest(res, 'order_id required');
      const reference = str(body.external_reference).trim();
      if (reference === '') {
        return refuseBadRequest(
          res,
          'external_reference required: recording a refund our system never saw is a claim about '
            + "money, and without a reference the row would assert it with nothing behind it",
        );
      }
      if (reference.length > PURCHASE_EXTERNAL_REFERENCE_MAX) {
        return refuseBadRequest(
          res,
          `external_reference must be at most ${PURCHASE_EXTERNAL_REFERENCE_MAX} characters`,
        );
      }
      const note = readNote(res, body);
      if (note === null) return;

      const row = loadRequestedRefund(res, deps, orderId);
      if (row === null) return;

      if (!auditFirst(res, deps, {
        actor,
        action: PURCHASE_REFUND_SETTLE_ACTION,
        orderId: row.order_id,
        note,
        route: PURCHASES_REFUND_SETTLE_ROUTE,
      })) return;

      const nowIso = new Date(now()).toISOString();
      const outcome = deps.purchases.settleOneTimeRefundByHand(
        row.order_id,
        { refunded_at: nowIso, external_reference: reference },
        nowIso,
      );
      if (outcome === 'not_requested') {
        // The row moved between the read above and this write — another operator
        // tab, or the webhook landing at last. 409, same as the read-time
        // refusal: one question, one operator action (go and look at it).
        //
        // 🔴 THE ROW `auditFirst` JUST WROTE STILL SAYS "settled" — audit rows are
        // append-only and this one already landed truthfully at the time it was
        // written. Correct it with its own row rather than leave it standing
        // alone as the only trace of an action that, per the outcome below,
        // never actually happened.
        auditRaceLost(deps, {
          actor,
          action: PURCHASE_REFUND_SETTLE_NOT_APPLIED_ACTION,
          orderId: row.order_id,
          route: PURCHASES_REFUND_SETTLE_ROUTE,
        });
        sendJson(res, 409, {
          error: PURCHASE_TRANSITION_INVALID,
          message: 'the refund stopped being in flight while this request was being handled; nothing was changed',
        });
        return;
      }

      // 🔴 `warn`, NOT `info`. This is a human asserting that money moved, on a
      // channel nothing else can confirm, and it must be findable in a log full
      // of INFO.
      log.warn('ops: a stuck refund was settled by hand', {
        actor,
        order_id: row.order_id,
        external_reference: reference,
      });

      const notice = await tellBuyer(
        deps,
        row,
        (mailer, to) =>
          mailer.sendRefundSettledByHand({
            to,
            orderId: row.order_id,
            externalReference: reference,
            amountMinor: row.amount_minor,
            currency: row.currency,
          }),
        'refund_settled',
      );

      sendJson(res, 200, {
        ok: true,
        order_id: row.order_id,
        state: 'refunded',
        refunded_at: nowIso,
        refund_external_reference: reference,
        // 🔴 REPORTED SEPARATELY FROM `ok`, because they are separate facts and
        // the operator has to be able to see the second one fail while the first
        // succeeded. `notice_sent: false` means the refund IS recorded and the
        // buyer was NOT told, so somebody has to send that letter by hand.
        notice_sent: notice.sent,
        ...(notice.why === null ? {} : { notice_failed: notice.why }),
      });
    })();
    return true;
  }

  // ── POST /api/ops/purchases/refund/release — outcome B ───────────────────
  if (method === 'POST' && url === '/api/ops/purchases/refund/release') {
    const who = adminGate(req, deps.auth, deps.audit, PURCHASES_REFUND_RELEASE_ROUTE);
    if (!who.ok) {
      sendJson(res, who.status, { error: who.error });
      return true;
    }
    const actor = who.userId;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const orderId = str(body.order_id).trim();
      if (orderId === '') return refuseBadRequest(res, 'order_id required');

      const rawTarget: unknown = body.to_state;
      if (!isRefundReleaseTarget(rawTarget)) {
        // 🔴 THREE VALUES GET THEIR OWN SENTENCE rather than falling into the
        // generic list, because each is a wrong value an operator will reach for
        // ON PURPOSE, believing it is right. "not one of: paid, scheduled,
        // in_progress" would leave all three believing the field is merely
        // misspelled — and the first of them is the one this whole design is
        // built to keep out.
        const message =
          rawTarget === 'delivered'
            ? 'a release cannot deliver a setup: declaring the work complete is its own action '
              + '(POST /api/ops/purchases/advance), so that a refund decision is never hidden inside a delivery. '
              + 'Release this purchase to paid, scheduled or in_progress, then deliver it if it is done.'
            : rawTarget === 'refunded'
              ? 'a release never writes refunded: that word means the money went back. It is written by the '
                + "provider's refund webhook, or here by POST /api/ops/purchases/refund/settle, which requires "
                + 'the external reference that stands behind the claim.'
              : rawTarget === 'refund_requested'
                ? 'that is the state this purchase is already stuck in; a release has to take it somewhere else'
                : `to_state must be one of: ${REFUND_RELEASE_TARGETS.join(', ')}`;
        return refuseBadRequest(res, message);
      }
      const target: RefundReleaseTarget = rawTarget;

      const rawReason: unknown = body.reason;
      if (!isRefundReleaseReason(rawReason)) {
        return refuseBadRequest(
          res,
          `reason must be one of: ${REFUND_RELEASE_REASONS.join(', ')} `
            + "(it is not a label: 'provider_declined' takes this purchase off the "
            + "no-start deadline sweep for ever, and 'buyer_withdrew_request' leaves it on)",
        );
      }
      const reason: RefundReleaseReason = rawReason;

      const note = readNote(res, body);
      if (note === null) return;

      const row = loadRequestedRefund(res, deps, orderId);
      if (row === null) return;

      if (!auditFirst(res, deps, {
        actor,
        action: PURCHASE_REFUND_RELEASE_ACTION,
        orderId: row.order_id,
        note,
        route: PURCHASES_REFUND_RELEASE_ROUTE,
      })) return;

      const nowIso = new Date(now()).toISOString();
      const outcome = deps.purchases.releaseOneTimeRefundRequest(
        row.order_id,
        { to_state: target, reason, released_at: nowIso },
        nowIso,
      );
      if (outcome === 'not_requested') {
        // Same correction as the settle route, and for the same reason: the
        // audit row `auditFirst` just wrote still says "released", and it must
        // not stand alone as the only trace of an action that did not happen.
        auditRaceLost(deps, {
          actor,
          action: PURCHASE_REFUND_RELEASE_NOT_APPLIED_ACTION,
          orderId: row.order_id,
          route: PURCHASES_REFUND_RELEASE_ROUTE,
        });
        sendJson(res, 409, {
          error: PURCHASE_TRANSITION_INVALID,
          message: 'the refund stopped being in flight while this request was being handled; nothing was changed',
        });
        return;
      }

      log.warn('ops: a stuck refund request was released', {
        actor,
        order_id: row.order_id,
        to_state: target,
        reason,
        // Says out loud what the reason just cost or preserved, because it is the
        // half of this action nobody can see on the screen afterwards.
        sweep: reason === 'provider_declined'
          ? 'this purchase is now OFF the no-start deadline sweep'
          : 'this purchase remains ON the no-start deadline sweep',
      });

      const notice = await tellBuyer(
        deps,
        row,
        (mailer, to) => mailer.sendRefundReleased({ to, orderId: row.order_id, reason }),
        'refund_released',
      );

      sendJson(res, 200, {
        ok: true,
        order_id: row.order_id,
        state: target,
        refund_released_at: nowIso,
        refund_release_reason: reason,
        notice_sent: notice.sent,
        ...(notice.why === null ? {} : { notice_failed: notice.why }),
      });
    })();
    return true;
  }

  // Anything else under this prefix falls to the router's 404 — the same
  // "no 405 for a known path" posture the other operator routes take: a 405
  // would tell an anonymous caller which paths exist before the gate refuses.
  return false;
}
