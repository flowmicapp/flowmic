// SPEC-REF:
//   docs/strategy/2026-08-31-lan-ops-console-third-party-spec.md §7 REQ-002
//     (the approved disposition and its fixed decisions), §5.2 routes 17/18
//   src/http/billing-routes.ts (the SELF-SERVICE twin — the same writer calls,
//     the same provider-failure mapping, and the `next_billing_period` argument)
//   src/http/account-restriction-routes.ts (the fail-closed shape this copies)
//   src/http/ops-audit-trail.ts `adminGate` (the gate + its route-level row)
//   src/billing/subscription-writer.ts (SubscriptionWriterFor — one client per
//     subscription, chosen by the row's own provider)
//   *** HUMAN-AUDIT SENSITIVE (billing + auth + operator accountability) ***
//
// POST /api/ops/subscriptions/cancel — stop this account's renewals.
// POST /api/ops/subscriptions/resume — undo that.
//
// REQ-002 from the LAN ops console: an operator has to be able to stop somebody
// being charged when that somebody has written in rather than clicked the
// button. THE SIXTH AND SEVENTH MUTATING ADMIN-GATED ROUTES.
//
// ── 🔴 THERE IS NO `immediate`, AND IT IS NOT A MISSING FEATURE ─────────────
//
// Cancellation is ALWAYS `next_billing_period`, which is the same rule
// billing-routes.ts follows on the user's own button and for the same measured
// reason: cancelling immediately at the provider does NOT refund the unused part
// of the period. 「Cancel」 meaning 「immediately」 therefore takes the service away
// and keeps the money — from a person who has paid to the end of the period. The
// immediate path exists exactly once in this product, in the EU statutory
// withdrawal, where it is paired with a refund adjustment. An operator surface
// must not be a second way to reach it: this route has no parameter for it, so
// it is unrepresentable rather than merely refused.
//
// ── 🔴 WHY THIS IS ITS OWN FILE AND NOT A `user_id` ON THE SELF-SERVICE PAIR ─
//
// billing-routes.ts's header states, as a structural property, that 「there is no
// `user_id` in any body, so 『cancel someone else's subscription』 is
// unrepresentable rather than merely refused」. Adding a target parameter there
// would delete that property for both of its routes at once — and it is
// load-bearing, because those two are DELIBERATELY exempt from the restriction
// and email-verification gates (ROSCA §8403(3): stopping the charges must stay
// reachable). An exempt route that can also name a stranger is a different
// animal from an exempt route that cannot.
//
// So the trust models stay apart: that surface acts on the Bearer's own
// subscription with no gate; this one acts on somebody else's, behind the admin
// gate, and writes an audit row. The WRITERS are shared — `writer.cancelSubscription`
// / `writer.clearScheduledChange`, resolved by the row's own provider — because
// two code paths to a provider is two answers to 「what did we send」.
//
// ── ⚠️ THE ONE GUARD THAT DIFFERS FROM THE SELF-SERVICE TWIN, AND ITS COST ──
//
// `resume` here REFUSES unless a cancellation is actually scheduled. That is the
// precondition billing-routes.ts MEASURED and REMOVED (a user who cancels and
// clicks undo three seconds later was refused, because our row is written by the
// webhook and the webhook had not arrived). It is taken back here because an
// operator acting on a stranger's account needs 「there is nothing to undo」 to be
// an answer rather than a cheerful 200 over a no-op.
//
// 🔴 THE COST IS REAL AND IS NOT HIDDEN: an operator who cancels through this
// route and immediately resumes through it will hit that same 409 until the
// webhook lands. It is written into the third-party contract (§7 REQ-002 note 2)
// so the console can say 「wait a moment and re-read the account」 instead of
// showing a failure. If that ever proves worse than the no-op it prevents, the
// fix is to ask the provider — not to relax this into a silent success.
//
// ── ⚠️ 「TOMBSTONED」 HAS NO BRANCH HERE, AND THAT IS MEASURED ────────────────
//
// `paddle_subscription_tombstones` has NO `user_id` column (schema-billing.ts
// argues why: the users row is gone by definition), and its only production
// writer is `deleteAccount` (http/account-lifecycle.ts), which removes the users
// row in the next statement. So from a `user_id` a tombstoned subscription is
// unreachable, and the state an operator can actually hit is 「that account no
// longer exists」 — answered by {@link OPS_SUBSCRIPTION_TARGET_UNKNOWN} below. A
// tombstone branch here would be a branch with no reachable input, defended by a
// comment; volume-13 §7 F1 ⑦ is exactly about that shape.
//
// ── ⚠️ THE OPERATOR IS NOT SUBJECT TO `restricted`, STATED AS A KNOWN FACT ───
//
// `adminFromBearer` does not consult the `restricted` column, so restricting an
// admin account does not close this route to it. That is the existing posture of
// the whole `/api/ops/…` family and this card does not change it; it is written
// down so nobody has to discover it from a database.
//
// ── ⚠️ NOBODY IS EMAILED, AND THAT IS A STATED GAP ──────────────────────────
//
// The self-service cancel awaits `SubscriptionMailer.sendCancellationConfirmed`.
// This route sends nothing, because that letter says the cancellation the reader
// ASKED FOR is confirmed — and here they did not ask. Sending it would tell
// somebody they requested something they did not. The honest letter is a
// user-visible sentence in nine locales that nobody has written yet, so the gap
// is reported rather than papered over with the wrong words.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BillingService, PlanView } from '../billing/billing-service';
import { PaddleWritesDisabledError } from '../billing/paddle/client';
import { CreemWritesDisabledError } from '../billing/creem/client';
import type { CancelEffectiveFrom, SubscriptionWriterFor } from '../billing/subscription-writer';
import type { UserRepo } from '../db/repos/user.repo';
import type { AccountVerifier } from './account-auth';
import { adminGate, type OpsAuditSink } from './ops-audit-trail';
import { readJsonBody, sendJson, str } from './console-http';
import {
  BILLING_NOT_CANCELLABLE,
  BILLING_NO_SUBSCRIPTION,
  BILLING_WRITE_DISABLED,
  refuseFromProvider,
} from './billing-routes';
import { log } from '../log';

/** The two route literals this module serves. Written out here AND inline in
 *  the `if` conditions below, for the reason its three neighbours state: the
 *  coverage guard derives what a file serves by reading the source for `'/api/…'`
 *  literals inside conditions, so a path assembled from a constant would be
 *  invisible to the one check that catches an ops route with no gate. */
export const SUBSCRIPTION_CANCEL_ROUTE = 'POST /api/ops/subscriptions/cancel';
export const SUBSCRIPTION_RESUME_ROUTE = 'POST /api/ops/subscriptions/resume';

/** `<domain>.<object>.<verb>` per the DDL, ONE ACTION PER OUTCOME. A single
 *  `billing.subscription.change` carrying the direction in `detail` would make
 *  「how many accounts did we cancel this month」 a string search inside a
 *  free-text column — one value answering two questions. */
export const SUBSCRIPTION_CANCEL_ACTION = 'billing.subscription.cancel';
export const SUBSCRIPTION_RESUME_ACTION = 'billing.subscription.resume';
/** `target_kind`. The row names the ACCOUNT, not the subscription id: the
 *  question somebody asks this table a year later is 「what did we do to this
 *  person」, and the subscription id is a handle that can change while the
 *  account does not. The id still reaches the trail — it is in the operator's
 *  own sentence if they put it there, and in the log line below either way. */
export const SUBSCRIPTION_TARGET_KIND = 'user';

/** Longest `reason` this route will store. REFUSED, never truncated — same rule
 *  as the restriction route: a half-stored justification is a worse audit record
 *  than a rejected one, and only the operator can shorten it correctly. */
export const SUBSCRIPTION_REASON_MAX = 500;

// ── HTTP-LOCAL refusal strings ──────────────────────────────────────────────
//
// Same precedent and same boundary as `RESTRICT_TARGET_UNKNOWN` and the
// `BILLING_*` family: these are HTTP-local strings, NOT protocol `ErrorCode`s.
// Minting a protocol code is owner-gated, and the vocabulary it carries is the
// cross-boundary one with bilingual copy riding the count guard — the only
// reader here is the repo-owned admin console on a VPN-only surface, and no
// phone, desktop or end-user browser can reach these paths at all.
//
// 🔴 THREE STRINGS AND NOT ONE, because they demand three different operator
// actions: retype the id / read the account and stop / retry safely.

/** `user_id` is well-formed but names no account. 🔴 NOT the same answer as
 *  「this account has no subscription」: one means retype the id, the other means
 *  this person never bought anything. Collapsing them is the shape this repo
 *  keeps paying for. */
export const OPS_SUBSCRIPTION_TARGET_UNKNOWN = 'OPS_SUBSCRIPTION_TARGET_UNKNOWN';
/** `resume` was asked for while nothing is scheduled to be undone.
 *  🔴 Deliberately NOT `BILLING_NOT_CANCELLABLE`: that one is billing-routes.ts's
 *  name for 「the call blew up」 and it answers a different question. Borrowing it
 *  would send an operator to look for an outage that is not happening. */
export const OPS_SUBSCRIPTION_NOTHING_SCHEDULED = 'OPS_SUBSCRIPTION_NOTHING_SCHEDULED';
/** The audit row could not be written, so nothing was asked of the provider. */
export const OPS_SUBSCRIPTION_NOT_RECORDED = 'OPS_SUBSCRIPTION_NOT_RECORDED';

/** The only cancellation timing this surface can express. A `const` rather than
 *  a literal at the call site so that grepping `immediately` across src/ keeps
 *  answering 「the statutory withdrawal, and nothing else」. */
const NEXT_BILLING_PERIOD: CancelEffectiveFrom = 'next_billing_period';

/** What Paddle calls a scheduled cancellation. Raw provider vocabulary, kept as
 *  a named constant so the one comparison below is greppable rather than a
 *  string sitting in an `if`. */
const SCHEDULED_CANCEL = 'cancel';

export interface OpsSubscriptionRoutesDeps {
  /** The account verifier for the admin gate — the SAME `AuthService` instance
   *  every other http surface uses, sliced to the two methods the gate needs. */
  auth: AccountVerifier;
  /**
   * 🔴 A ONE-METHOD SLICE OF `UserRepo`, and the narrowness is the feature (the
   * shape account-restriction-routes.ts and ops-user-routes.ts both use). The
   * full repo carries `remove`, `setPlan` and `setRestricted`; a body-driven
   * `user_id` must not be able to reach any of them from a billing surface.
   * bootstrap passes `db.users`; the slice is enforced HERE, on the consumer.
   */
  users: Pick<UserRepo, 'findById'>;
  /**
   * The plan solver, and the ONLY database this file reads through.
   *
   * ⚠️ `getPlan`, not `resolvePlanReadOnly`, and the choice is deliberate. That
   * read-only twin exists for a caller LOOPING over many accounts
   * (ops-user-routes.ts's list) without writing the `users.plan` mirror per row.
   * This route resolves exactly ONE account and is about to mutate its
   * subscription — refreshing the same mirror the self-service twin refreshes is
   * the behaviour we want, and asking a different question than that twin asks
   * is how the two surfaces start disagreeing about which subscription is in
   * force.
   *
   * 🔴 THERE IS NO `BillingRepo` HERE, for billing-routes.ts's reason: the local
   * subscription row has ONE author and it is the webhook handler. A second
   * writer disagrees with it on exactly the request where the network dropped
   * after the provider had already committed.
   */
  billing: Pick<BillingService, 'getPlan'>;
  /** Which outbound client speaks for a given subscription, chosen by the row's
   *  own provider. 🔴 The SAME resolver the self-service routes get (built once
   *  in bootstrap-billing-deps.ts): a fixed client would send a Creem id to
   *  Paddle and be told 「entity not found」, and this route would then tell an
   *  operator that a paying customer has no subscription. */
  writerFor: SubscriptionWriterFor;
  /** Where BOTH rows go — the gate's route-level row and this route's business
   *  row. REQUIRED, no `?` and no default (volume-13 §7 F1 ②): an optional sink
   *  would mean a bootstrap missing one line still changes people's billing,
   *  untraceably, with nothing red and no new symbol to grep. */
  audit: OpsAuditSink;
}

type Action = 'cancel' | 'resume';

function refuseBadRequest(res: ServerResponse, message: string): void {
  // `SETTINGS_SCHEMA_INVALID` is an EXISTING protocol code and is already this
  // http family's malformed-body answer. The code table does not move.
  sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message });
}

/** Write the business row BEFORE the provider is called, and say so if it fails.
 *  Returns false after having answered 503 and asked the provider nothing.
 *
 *  🔴 THIS IS THE (a) BRANCH ops-audit-trail.ts's `recordGateOutcome`
 *  deliberately did NOT take for its GETs, and its own comment says why the
 *  argument expires for a mutator: an unrecorded CHANGE is a different animal
 *  from an unrecorded READ. Here the change is somebody's money.
 *
 *  ⚠️ THE RESIDUAL RISK, STATED SO NOBODY DISCOVERS IT: append-then-call means a
 *  row can exist for a provider call that then failed. That is the safe
 *  direction — the trail may over-report, never under-report — and the caller is
 *  told by a 5xx rather than a 200, so an over-reported row always sits beside a
 *  failed request. The other order produces the state ops-audit-trail.ts
 *  forbids: a change nobody recorded, reported to the operator as success. */
function auditFirst(
  res: ServerResponse,
  deps: OpsSubscriptionRoutesDeps,
  input: { actor: string; action: string; targetId: string; reason: string; route: string },
): boolean {
  try {
    deps.audit.append({
      actor_user_id: input.actor,
      action: input.action,
      target_kind: SUBSCRIPTION_TARGET_KIND,
      target_id: input.targetId,
      // The operator's own sentence, and nothing else the request carried. The
      // DDL's rule — 「detail holds only a sentence we wrote ourselves, never the
      // raw request body」 — is about not spilling a body into the table; a
      // `reason` field EXISTS to be the recorded justification, so it is the one
      // caller-supplied value that belongs here. Length-capped above so it
      // cannot become a body dump by another name.
      detail: input.reason,
    });
    return true;
  } catch (err) {
    log.error('ops: REFUSING to change a subscription — the audit row could not be written', {
      route: input.route,
      actor: input.actor,
      target: input.targetId,
      intent: input.action,
      reason: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 503, {
      error: OPS_SUBSCRIPTION_NOT_RECORDED,
      message: 'the operations audit row could not be written, so nothing was asked of the payment provider',
    });
    return false;
  }
}

/**
 * The success body.
 *
 * 🔴 `provider` AND `local` ARE TWO OBJECTS BECAUSE THEY ANSWER TWO QUESTIONS,
 * and flattening them is how a console renders a hope as a fact. `provider` is
 * the receipt — what the provider itself said the moment it accepted the write.
 * `local` is OUR row, and our row is written by the webhook, which arrives
 * seconds later; `settles_via_webhook` says so out loud. A flat body would
 * invite the obvious client behaviour (act, then refetch) to read the unchanged
 * local half as 「it did not work」, which is the state a duplicate cancellation
 * or a bank call comes from.
 *
 * ⚠️ `local` IS NOT RE-READ AFTER THE WRITE, and re-reading it would be theatre:
 * the only author of that row has not run yet, so a second `getPlan` returns the
 * same values and the extra call would merely make them look confirmed.
 */
interface OpsSubscriptionOk {
  ok: true;
  user_id: string;
  action: Action;
  provider: {
    /** Which merchant of record holds this subscription. */
    name: string;
    /** The provider's own status right after the write — a receipt, not state. */
    status: string;
    scheduled_change: PlanView['scheduled_change'];
  };
  local: {
    plan: PlanView['plan'];
    state: PlanView['state'];
    scheduled_change: PlanView['scheduled_change'];
    expires_at: PlanView['expires_at'];
  };
  settles_via_webhook: true;
}

/** Handle the two ops subscription writes. Returns true iff it owned the
 *  request. */
export function tryHandleOpsSubscriptionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsSubscriptionRoutesDeps,
): boolean {
  const url = (req.url ?? '/').split('?')[0];
  const method = req.method ?? 'GET';

  // 🔴 THE PATH LITERALS LIVE IN THE `if` CONDITIONS, NEXT TO THE METHOD.
  // billing-routes.ts measured what happens otherwise: hoisting them into a
  // `const` above the branch left every gate-coverage assertion GREEN while the
  // scanner found no routes in the file at all — a guard that cannot see a thing
  // reports no problem with it.
  let action: Action;
  let route: typeof SUBSCRIPTION_CANCEL_ROUTE | typeof SUBSCRIPTION_RESUME_ROUTE;
  if (method === 'POST' && url === '/api/ops/subscriptions/cancel') {
    action = 'cancel';
    route = SUBSCRIPTION_CANCEL_ROUTE;
  } else if (method === 'POST' && url === '/api/ops/subscriptions/resume') {
    action = 'resume';
    route = SUBSCRIPTION_RESUME_ROUTE;
  } else {
    // Anything else under this prefix falls through to the router's 404 — the
    // same 「no 405 for a known path」 posture the rest of the ops family states:
    // a 405 would tell an anonymous caller which ops paths exist before the gate
    // can refuse them.
    return false;
  }

  // The gate FIRST, before a single byte of the body is parsed: no branch of
  // this route may be reachable by someone who has proved nothing.
  const who = adminGate(req, deps.auth, deps.audit, route);
  if (!who.ok) {
    sendJson(res, who.status, { error: who.error });
    return true;
  }
  const actor = who.userId;

  void (async (): Promise<void> => {
    const body = await readJsonBody(req);
    const targetId = str(body.user_id).trim();
    if (targetId === '') return refuseBadRequest(res, 'user_id required');
    // REQUIRED, both directions. 「Why did we put it back」 matters as much as
    // 「why did we stop it」 — an unexplained resume is the half of the trail an
    // audit actually needs.
    const reason = str(body.reason).trim();
    if (reason === '') {
      return refuseBadRequest(res, 'reason required (it is the only thing the audit row can say about WHY)');
    }
    if (reason.length > SUBSCRIPTION_REASON_MAX) {
      return refuseBadRequest(res, `reason must be at most ${SUBSCRIPTION_REASON_MAX} characters`);
    }

    const target = deps.users.findById(targetId);
    // 🔴 404, and NOT an idempotent 「ok:true, changed:false」. The caller is a
    // proven admin who can already enumerate accounts through
    // /api/ops/users, so answering honestly leaks nothing — while a cheerful 200
    // for a typo'd id would tell an operator they had stopped somebody's
    // charges when they had stopped nobody's. That is the 「claiming something
    // was done」 half of no-silent-failure, on a path about money.
    if (!target) {
      sendJson(res, 404, {
        error: OPS_SUBSCRIPTION_TARGET_UNKNOWN,
        message: 'user_id names no account (this is NOT the same as an account with no subscription)',
      });
      return;
    }

    const view = deps.billing.getPlan(target.id);
    const subId = view.paddle_subscription_id;
    if (subId === null) {
      // 🔴 NOT 404, and the SAME code the self-service twin uses. There is an
      // account and it is readable; what is missing is a subscription to act on.
      sendJson(res, 409, { error: BILLING_NO_SUBSCRIPTION });
      return;
    }

    if (action === 'resume') {
      // 🔴 A SCHEDULED CANCELLATION SPECIFICALLY, not 「any scheduled change」.
      // `clearScheduledChange` would clear a scheduled PAUSE just as happily,
      // and the audit row this route writes says `billing.subscription.resume` —
      // a row that claims we undid a cancellation when we cleared something else
      // is a trail that lies in the one place it is read.
      //
      // ⚠️ 「NOT EXPIRED」 IS SUBSUMED, not omitted: `BillingService`'s
      // `fromPaddle` nulls `scheduled_change` for an expired row (an expired
      // row's scheduled change describes something that has already happened),
      // so an expired subscription cannot pass this test. Asserted in
      // test/ops-subscription-routes.test.ts rather than only claimed here.
      if (view.scheduled_change === null || view.scheduled_change.action !== SCHEDULED_CANCEL) {
        sendJson(res, 409, {
          error: OPS_SUBSCRIPTION_NOTHING_SCHEDULED,
          message: 'this subscription has no scheduled cancellation to undo',
          scheduled_change: view.scheduled_change,
        });
        return;
      }
    }

    // ── which provider holds this subscription ──────────────────────────────
    //
    // 🔴 `null` IN THE COLUMN MEANS 'paddle', and billing-routes.ts is where that
    // inference is argued (every row written before 2026-08-29 predates the
    // column, and Paddle was the only writer that could have made one). Repeated
    // here rather than exported as a helper would be a second place to change;
    // repeated as a LINE is the cost of not adding an indirection for two
    // callers. If a third caller appears, this belongs in one function.
    const provider = view.billing_provider ?? 'paddle';
    const writer = deps.writerFor(provider);
    if (writer === null) {
      // A subscription whose provider this process has no client for. NOT a
      // fallback to whichever client is configured — that would send a Creem id
      // to Paddle. 503 because it is a deployment problem: the account and the
      // request are both fine.
      log.error('ops: no outbound client for this subscription provider', {
        route,
        actor,
        target: target.id,
        subscription_id: subId,
        provider,
      });
      sendJson(res, 503, { error: BILLING_WRITE_DISABLED });
      return;
    }

    // ── the fail-closed half (see this file's header) ──────────────────────
    if (
      !auditFirst(res, deps, {
        actor,
        action: action === 'cancel' ? SUBSCRIPTION_CANCEL_ACTION : SUBSCRIPTION_RESUME_ACTION,
        targetId: target.id,
        reason,
        route,
      })
    ) {
      return;
    }

    try {
      const out = action === 'cancel'
        // ⚠️ `next_billing_period`, ALWAYS — see this file's header. Named as a
        // typed constant rather than passed inline so that 「what did ops send」
        // is one greppable word.
        ? await writer.cancelSubscription(subId, NEXT_BILLING_PERIOD)
        : await writer.clearScheduledChange(subId);
      if (!out.ok) {
        // 🔴 THE SAME MAPPING THE SELF-SERVICE ROUTES USE, imported rather than
        // re-typed: 「unreachable」 must stay 502-and-we-do-not-know on BOTH
        // surfaces, because a timeout can land after the provider has already
        // committed. Two copies of that decision is how one of them starts
        // telling an operator 「it definitely did not happen」.
        log.warn('ops: subscription control refused by the provider', {
          route,
          actor,
          target: target.id,
          provider,
          code: out.code,
        });
        refuseFromProvider(res, out.code, out.detail);
        return;
      }
      log.warn('ops: an operator changed somebody else\'s subscription', {
        route,
        actor,
        target: target.id,
        provider,
        subscription_id: subId,
        effective_at: out.data.scheduled_change?.effective_at ?? null,
      });
      const okBody: OpsSubscriptionOk = {
        ok: true,
        user_id: target.id,
        action,
        provider: { name: provider, status: out.data.status, scheduled_change: out.data.scheduled_change },
        local: {
          plan: view.plan,
          state: view.state,
          scheduled_change: view.scheduled_change,
          expires_at: view.expires_at,
        },
        settles_via_webhook: true,
      };
      sendJson(res, 200, okBody);
    } catch (e) {
      // 🔴 BOTH PROVIDERS' 「writes are off」 ERRORS. Each client throws its OWN
      // type, so catching only Paddle's would send a switched-off Creem
      // deployment down the generic 500 — 「something went wrong」 for a setting
      // an operator can fix in one line, with nothing in the log naming it.
      if (e instanceof PaddleWritesDisabledError || e instanceof CreemWritesDisabledError) {
        log.error('ops: a subscription control was used while provider writes are OFF', {
          route,
          actor,
          target: target.id,
          message: e.message,
        });
        sendJson(res, 503, { error: BILLING_WRITE_DISABLED });
        return;
      }
      log.warn('ops: subscription control failed', {
        route,
        actor,
        target: target.id,
        error: e instanceof Error ? e.message : String(e),
      });
      sendJson(res, 500, { error: BILLING_NOT_CANCELLABLE });
    }
  })();
  return true;
}

