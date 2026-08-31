// SPEC-REF:
//   apps/server-core/src/billing/guided-setup.ts (the promise, and the consent
//     wording these routes record agreement to)
//   apps/server-core/src/billing/creem/client.ts (createCheckout)
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts (the read)
//   owner rulings 2026-08-29: 「必须登录才能买」, 「控制台独立成区」,
//     「付款后 3 个工作日内联系」
//   *** HUMAN-AUDIT SENSITIVE (billing + auth) — reviewable in isolation ***
//
// The paid one-time service: buying it, and seeing what you bought.
//
// ── 🔴 WHY A BEARER IS REQUIRED TO BUY (owner ruling, and the mechanism) ────
//
// A checkout we did not build carries no `flowmic_user_id`, so its payment
// arrives attributable to nobody and sits in the ledger as `unmapped` while a
// person waits for a service we cannot connect to an account. Requiring a signed-
// in buyer is what makes attribution structural instead of best-effort — and it
// costs the buyer nothing they would not have had to do anyway, since the service
// is delivered by contacting them.
//
// ⚠️ AND IT IS NOT THE SAME AS `refuseUnverified`. A person with an unverified
// email may buy: refusing them would take money-in off the table for an account
// state that is recoverable, and the contact address for the session is confirmed
// in the first email either way. What is refused is being ANONYMOUS.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AuthService } from '../auth/auth-service';
import type { CreemClient } from '../billing/creem/client';
import { purchaseNextStep } from '../billing/creem/client';
import {
  GUIDED_SETUP_AFTERCARE_DAYS,
  GUIDED_SETUP_CONSENT_VERSION,
  GUIDED_SETUP_CONTACT_BUSINESS_DAYS,
  GUIDED_SETUP_MAX_SESSION_HOURS,
  GUIDED_SETUP_META,
  PROMISED_DEADLINES,
} from '../billing/guided-setup';
import type { DeadlinePolicy } from '../billing/service-deadlines';
import { refundRelease, refundWindow, supportUntil } from '../billing/service-deadlines';
import type { ServiceMailer } from '../mail/service-mailer';
import { CREEM_USER_ID_KEY } from '../billing/creem/envelope';
import type { OneTimePurchaseRepo } from '../db/repos/one-time-purchase.repo';
import { accountUserFromBearer } from './account-auth';
import { sendJson } from './console-http';
import { readBounded } from './body';
import type { RefundOrigin, ServiceRefundOutcome } from '../billing/service-refund';
import { log } from '../log';

/** HTTP-LOCAL error strings, not protocol `ErrorCode`s — the same choice every
 *  other route in this directory made, for the reason stated in
 *  paddle/webhook-handler.ts: minting protocol codes with no FlowMic client
 *  reading them is a façade. The console's own locales carry the sentences. */
export const SERVICE_CONSENT_REQUIRED = 'SERVICE_CONSENT_REQUIRED';
export const SERVICE_NOT_AVAILABLE = 'SERVICE_NOT_AVAILABLE';
export const SERVICE_CHECKOUT_FAILED = 'SERVICE_CHECKOUT_FAILED';
export const SERVICE_BODY_UNREADABLE = 'SERVICE_BODY_UNREADABLE';
/** The purchase is not one this account can withdraw from — already delivered,
 *  already refunded, already asked for, or not theirs. 🔴 ONE code for all of
 *  those on purpose: telling a stranger WHICH of them is true about an order id
 *  they guessed would answer a question they have no business asking. */
export const SERVICE_NOT_REFUNDABLE = 'SERVICE_NOT_REFUNDABLE';
/** We asked and the provider did not accept. The money has NOT moved. */
export const SERVICE_REFUND_REFUSED = 'SERVICE_REFUND_REFUSED';

/** A consent body is a few dozen bytes. The cap exists so an authenticated but
 *  hostile client cannot make us buffer megabytes. */
const MAX_BODY_BYTES = 8 * 1024;

/** Cap on what the console lists. There is no pagination because a person does
 *  not buy fifty setup sessions; if that ever stops being true, the cap is the
 *  thing that will be seen to be wrong rather than a silently truncated list. */
const LIST_LIMIT = 50;

export interface ServicePurchaseRoutesDeps {
  auth: AuthService;
  purchases: OneTimePurchaseRepo;
  /** Absent when Creem is not configured on this deployment. 🔴 ABSENT MEANS THE
   *  BUY ROUTE REFUSES BY NAME, never that it quietly succeeds: a deployment
   *  with no payment provider must not hand a browser a URL that goes nowhere. */
  creem?: CreemClient;
  /** The Creem product id for the setup service. Absent ⇒ same refusal as above. */
  productId?: string;
  successUrl?: string;
  /** Ask the provider to refund one purchase. Injected as a FUNCTION rather
   *  than as a client + repo, so this route cannot reach anything else that
   *  moves money, and so the operator route and the sweep provably call the
   *  same code path. Absent ⇒ the withdraw route refuses by name. */
  refund?: (orderId: string, origin: RefundOrigin) => Promise<ServiceRefundOutcome>;
  /** The channel a withdrawal acknowledgement goes out on (CRD art. 11(3)).
   *
   *  ⚠️ OPTIONAL, AND ITS ABSENCE NEVER BLOCKS A WITHDRAWAL. The refund is
   *  already asked for by the time this is used; refusing the exit because a
   *  mail server had a bad minute would be the worst possible place to fail
   *  closed. A failure is logged at error and named as a duty somebody has to
   *  discharge by hand — the same trade billing-routes.ts makes for the
   *  subscription side. */
  mailer?: ServiceMailer;
  /** The promised periods. Injected only so a test can move a deadline without
   *  moving the clock; production passes nothing and gets the promise. */
  deadlines?: DeadlinePolicy;
  now?: () => number;
}

interface ConsentBody {
  early_start: boolean;
  waiver_ack: boolean;
}

/** 🔴 BOTH AFFIRMATIONS ARE REQUIRED, AND NEITHER IS INFERRED FROM THE OTHER.
 *  They do different legal work — one is a request to begin inside the 14-day
 *  window (CRD art. 7(3)), the other an acknowledgement that full performance
 *  ends the right (art. 16(a)) — so a body that carried one and not the other
 *  would leave us evidencing half of what we relied on. A missing or non-boolean
 *  value is refused rather than read as false: 「they did not tick it」 and 「the
 *  client did not send the field」 are different, and only the first is a thing a
 *  person did. */
function readConsent(raw: unknown): ConsentBody | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.early_start !== true || o.waiver_ack !== true) return null;
  return { early_start: true, waiver_ack: true };
}

export function tryHandleServicePurchaseRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServicePurchaseRoutesDeps,
): boolean {
  const url = (req.url ?? '').split('?')[0];
  const method = req.method ?? 'GET';

  // The path literals stay inside the `if` conditions, beside the method — the
  // console-admin-gate scanner pairs them that way, and hoisting them into
  // consts makes this file invisible to it while looking supervised.
  let action: 'buy' | 'list' | 'withdraw';
  if (method === 'POST' && url === '/api/cloud/billing/service-checkout') {
    action = 'buy';
  } else if (method === 'GET' && url === '/api/cloud/billing/services') {
    action = 'list';
  } else if (method === 'POST' && url === '/api/cloud/billing/service-withdraw') {
    action = 'withdraw';
  } else {
    return false;
  }

  const who = accountUserFromBearer(req, deps.auth);
  if (!who.ok) {
    sendJson(res, 401, { error: who.error });
    return true;
  }
  const user = who.user;

  const policy = deps.deadlines ?? PROMISED_DEADLINES;
  const nowMs = deps.now?.() ?? Date.now();

  if (action === 'list') {
    const rows = deps.purchases.listOneTimePurchasesForUser(user.id, LIST_LIMIT);
    sendJson(res, 200, {
      // 🔴 THE PROMISE IS SERVED FROM THE CONSTANT, NOT COPIED INTO THE CLIENT.
      // The console renders 「we will contact you within N business days」; if N
      // lived in the client too, changing it would change one of the two places
      // and the other would keep making the old promise.
      // 🔴 CAN THIS DEPLOYMENT SELL IT RIGHT NOW — the console's ONE input for
      // 「buy card」 vs 「coming soon」.
      //
      // It is derived from exactly what the BUY route refuses on, so the two
      // cannot disagree: a page that offered a button the write refuses would
      // send somebody to a checkout that 503s, and a page that hid one the write
      // would have served would lose a sale for no reason.
      //
      // ⚠️ FALSE IS NOT AN ERROR, and the distinction is the whole point of
      // this field. 「We could not ask」 and 「this is not on sale yet」 are
      // different sentences about different things, and before this existed the
      // console had no way to tell them apart — the route simply 404'd and the
      // page said the read had failed.
      on_sale: deps.creem !== undefined && deps.productId !== undefined && deps.productId !== '',
      contact_business_days: GUIDED_SETUP_CONTACT_BUSINESS_DAYS,
      max_session_hours: GUIDED_SETUP_MAX_SESSION_HOURS,
      // The periods the wording names, served from the same constants it is
      // written against — so the page that explains the service and the machine
      // that enforces it cannot come to disagree. ⚠️ There is ONE deadline
      // (owner 2026-08-30): a completion deadline used to be echoed here too
      // and was removed with the concept; a client must not expect it back.
      start_deadline_days: policy.startDeadlineDays,
      aftercare_days: GUIDED_SETUP_AFTERCARE_DAYS,
      terms_version: GUIDED_SETUP_CONSENT_VERSION,
      purchases: rows.map((p) => ({
        order_id: p.order_id,
        product_id: p.product_id,
        amount_minor: p.amount_minor,
        currency: p.currency,
        state: p.state,
        // Derived from the state and the clock on every read — never a sentence
        // stored on the row, which would keep saying the same thing after it
        // stopped being true ('support' becomes 'closed' on its own).
        next_step: purchaseNextStep(p, nowMs, GUIDED_SETUP_AFTERCARE_DAYS),
        purchased_at: p.created_at,
        scheduled_at: p.scheduled_at,
        started_at: p.started_at,
        delivered_at: p.delivered_at,
        // When we emailed them that it was done. A record the page may show;
        // it moves no date and gates no button (gs-5).
        completion_notice_at: p.completion_notice_at,
        // The end of the two weeks of help, derived from `delivered_at`; null
        // unless the setup is delivered.
        support_until: supportUntil(p, GUIDED_SETUP_AFTERCARE_DAYS),
        // 🔴 WHETHER THE WITHDRAW BUTTON MAY BE DRAWN — computed from the SAME
        // function the claim SQL is a transcription of. A console that decided
        // this for itself would eventually offer a button the write refuses,
        // which is worse than no button: the customer would have exercised a
        // right and been told nothing happened. `closes_at` is always null
        // since gs-5 (the window shuts on an event, not a date).
        refund_window: refundWindow(p, nowMs, policy),
        // 🔴 WHY A REFUND REQUEST THIS BUYER MADE IS NO LONGER IN FLIGHT — null
        // unless an operator ended one by hand. Without it the console would
        // simply STOP saying "we have asked for your money back" one day, and
        // the buyer would be left to work out on their own that the refund they
        // exercised is not coming. A silent revert is the same class of defect
        // as the frozen row this field exists because of.
        //
        // ⚠️ ADDITIVE AND ALWAYS PRESENT (null, not omitted): a console reading
        // `refund_release` must be able to tell "no release" from "a server too
        // old to answer", and an absent key answers both.
        refund_release: refundRelease(p),
        // ⚠️ SURFACED, because the console has to be able to say what the buyer
        // agreed to and when. A consent record nobody can read is a record that
        // only exists for us.
        consent: {
          early_start_at: p.early_start_consent_at,
          waiver_ack_at: p.withdrawal_waiver_ack_at,
          terms_version: p.consent_terms_version,
        },
      })),
    });
    return true;
  }

  if (action === 'withdraw') {
    // ── 🔴 THE BUTTON THE WORDING PROMISES (gs-2 onward; gs-5 today) ─────────
    //
    // 「Until then you can get all of your money back at any time, from your
    // console, without giving a reason — you have to ask; we do not assume.」
    // That sentence was first written before this route existed, which made it
    // a promise with no mechanism — the shape this repo forbids, on a legal
    // right, in nine languages. 「Until then」 is confirmed completion: the
    // refund action's claim refuses a 'delivered' row and this route answers
    // 409 SERVICE_NOT_REFUNDABLE for it.
    //
    // ⚠️ NO REASON IS ASKED FOR, and that is not an oversight: a withdrawal is
    // exercised, not applied for, and a required 「why」 is friction on a right.
    // The origin recorded is 'customer_withdrawal', which is all the audit needs.
    //
    // 🔴 NOT GATED ON VERIFIED EMAIL OR RESTRICTION, the same exemption
    // billing-routes.ts takes for cancel/resume and for the same reason: this is
    // the exit, not a product feature, and a person whose mailbox died or whose
    // account was restricted is still owed their money.
    void (async (): Promise<void> => {
      const refunder = deps.refund;
      if (refunder === undefined) {
        sendJson(res, 503, { error: SERVICE_NOT_AVAILABLE });
        return;
      }
      const body = await readBounded(req, MAX_BODY_BYTES).catch(() => null);
      let orderId = '';
      if (body !== null && body !== 'TOO_LARGE') {
        try {
          const parsed: unknown = JSON.parse(body);
          if (typeof parsed === 'object' && parsed !== null) {
            const v = (parsed as Record<string, unknown>).order_id;
            if (typeof v === 'string') orderId = v.trim();
          }
        } catch {
          /* falls through to the empty check */
        }
      }
      if (orderId === '') {
        sendJson(res, 400, { error: SERVICE_BODY_UNREADABLE });
        return;
      }
      // 🔴 OWNERSHIP IS CHECKED HERE AND THE ID ALONE IS NEVER ENOUGH. The
      // refund action below is keyed by order id and knows nothing about who is
      // asking; without this, a signed-in stranger could refund somebody else's
      // purchase by guessing an id.
      const mine = deps.purchases
        .listOneTimePurchasesForUser(user.id, LIST_LIMIT)
        .find((p) => p.order_id === orderId);
      if (mine === undefined) {
        sendJson(res, 409, { error: SERVICE_NOT_REFUNDABLE });
        return;
      }
      // 🔴 READ BEFORE THE REFUND, USED AFTER IT. The acknowledgement quotes the
      // amount, and by the time the call returns the row has been claimed — so
      // taking the figures afterwards would read a row that is mid-change for
      // the sake of a letter about what it used to be.
      const receivedAt = new Date(nowMs).toISOString();
      const out = await refunder(orderId, 'customer_withdrawal');
      if (!out.ok) {
        if (out.reason === 'not_refundable') {
          sendJson(res, 409, { error: SERVICE_NOT_REFUNDABLE });
          return;
        }
        // 🔴 THE MONEY HAS NOT MOVED, and the body says so rather than leaving
        // the console to guess from a bare 502.
        sendJson(res, 502, { error: SERVICE_REFUND_REFUSED });
        return;
      }
      // ── CRD art. 11(3): acknowledge it, on a durable medium ────────────────
      //
      // 🔴 AFTER THE REFUND AND OUTSIDE ITS SUCCESS PATH'S CONTROL. The
      // withdrawal has already happened; a mail failure must not undo it, must
      // not turn a 200 into a 502, and must not be swallowed either. It is
      // logged at ERROR naming the duty, because that duty is now OUTSTANDING
      // and only a person can discharge it.
      //
      // ⚠️ THE ADDRESS IS THE ACCOUNT'S OWN (`user.email`), never a request
      // field. A route that could name its own recipient is a way to send
      // FlowMic-branded mail anywhere.
      if (deps.mailer !== undefined && user.email !== null && user.email !== '') {
        try {
          await deps.mailer.sendWithdrawalReceived({
            to: user.email,
            orderId,
            receivedAt,
            amountMinor: mine.amount_minor,
            currency: mine.currency,
          });
        } catch (err) {
          log.error('service withdrawal: the acknowledgement could not be delivered', {
            order_id: orderId,
            user_id: user.id,
            reason: err instanceof Error ? err.message : String(err),
            duty: 'CRD art. 11(3) acknowledgement is now OUTSTANDING and must be sent by hand',
          });
        }
      } else {
        log.error('service withdrawal: no channel or no address — the acknowledgement was not sent', {
          order_id: orderId,
          user_id: user.id,
          duty: 'CRD art. 11(3) acknowledgement is now OUTSTANDING and must be sent by hand',
        });
      }
      sendJson(res, 200, {
        ok: true,
        order_id: orderId,
        // ⚠️ THE PROVIDER'S OWN WORD, and it is usually NOT terminal. The
        // console must render 「we have asked for your money back」 off this and
        // never 「refunded」 — that word belongs to the webhook.
        provider_status: out.providerStatus,
        settles_via_webhook: true,
      });
    })();
    return true;
  }

  void (async (): Promise<void> => {
    const creem = deps.creem;
    const productId = deps.productId;
    if (creem === undefined || productId === undefined || productId === '') {
      // Named, not a 404 and not a 500: the account is fine and the request was
      // fine — this deployment simply cannot sell it. The console can say so.
      sendJson(res, 503, { error: SERVICE_NOT_AVAILABLE });
      return;
    }

    const body = await readBounded(req, MAX_BODY_BYTES).catch(() => null);
    if (body === null || body === 'TOO_LARGE') {
      sendJson(res, 400, { error: SERVICE_BODY_UNREADABLE });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: SERVICE_BODY_UNREADABLE });
      return;
    }
    if (readConsent(parsed) === null) {
      sendJson(res, 400, { error: SERVICE_CONSENT_REQUIRED, terms_version: GUIDED_SETUP_CONSENT_VERSION });
      return;
    }

    // 🔴 OUR STAMP, TAKEN HERE. Not a value from the request body, which the
    // buyer controls, and not one read back off the provider later. The record
    // says when WE observed the affirmation, on our clock.
    const at = new Date(deps.now?.() ?? Date.now()).toISOString();
    const requestId = randomUUID();

    const out = await creem.createCheckout({
      productId,
      requestId,
      ...(deps.successUrl === undefined ? {} : { successUrl: deps.successUrl }),
      metadata: {
        [CREEM_USER_ID_KEY]: user.id,
        [GUIDED_SETUP_META.consentVersion]: GUIDED_SETUP_CONSENT_VERSION,
        [GUIDED_SETUP_META.earlyStartAt]: at,
        [GUIDED_SETUP_META.waiverAckAt]: at,
      },
    });

    if (!out.ok) {
      // The provider's code and our own sentence — never its message verbatim.
      log.warn('service checkout refused by creem', { user_id: user.id, code: out.code, detail: out.detail });
      sendJson(res, 502, { error: SERVICE_CHECKOUT_FAILED });
      return;
    }

    // ⚠️ NOTHING IS RECORDED HERE. A checkout is not a purchase: the person may
    // never pay. The `one_time_purchases` row is written by the webhook, from a
    // PAID order, and by nothing else — two writers would disagree on exactly
    // the request where the browser was closed after the URL was issued.
    log.info('service checkout created', { user_id: user.id, request_id: requestId, checkout_id: out.data.id });
    sendJson(res, 200, { checkout_url: out.data.checkout_url, terms_version: GUIDED_SETUP_CONSENT_VERSION });
  })().catch((e) => {
    log.warn('service checkout route failed', { error: String(e) });
    try {
      sendJson(res, 500, { error: SERVICE_CHECKOUT_FAILED });
    } catch {
      /* headers already sent */
    }
  });

  return true;
}
