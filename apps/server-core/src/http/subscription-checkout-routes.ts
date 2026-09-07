// SPEC-REF:
//   apps/server-core/src/billing/creem/client.ts (createCheckout)
//   apps/server-core/src/billing/creem/envelope.ts (CREEM_USER_ID_KEY — the
//     metadata contract this route's only job is to satisfy)
//   apps/server-core/src/http/service-purchase-routes.ts (the sibling that sells
//     the one-time product; its auth rule and its refusal shapes are followed)
//   apps/server-core/src/http/billing-routes.ts (cancel/resume/withdraw — the
//     other half of the lifecycle, deliberately in a different file)
//   *** HUMAN-AUDIT SENSITIVE (billing + auth) — reviewable in isolation ***
//
// Starting a subscription: turning 「I want Pro」 into a checkout URL.
//
// ── 🔴 WHY THIS IS A SEPARATE FILE FROM billing-routes.ts ─────────────────
//
// That one is money going OUT and state we already hold — cancel, resume,
// refund, all keyed on a subscription that exists. This is money coming IN for
// one that does not exist yet, and it is the only route in the directory that
// can start a recurring charge. Keeping it apart means an audit of 「what can
// begin billing somebody」 has exactly one file to read, and it keeps
// billing-routes.ts (596 lines) under the cap without compressing its reasoning.
//
// ── 🔴 WHAT THIS ROUTE DOES NOT DO, AND WHY THAT MATTERS MOST ─────────────
//
// It does not record anything. A checkout is not a subscription: the person may
// close the tab. The `paddle_subscriptions` row is written by the webhook, from
// a payload Creem signed, and by nothing else. Two writers would disagree on
// exactly the request where the browser was closed after the URL was issued —
// and the one that guessed would be the one telling a customer they are paying.
//
// It also does not CHANGE a plan. Creem has an endpoint for that
// (`POST /v1/subscriptions/{id}/upgrade`, probed live 2026-08-29: $6→$20 charged
// a $14 proration on the same subscription id), and we have not wired it. Until
// we do, this route REFUSES anyone who already has a live subscription — see
// [ALREADY]. A second checkout would not upgrade them; it would leave them
// paying twice.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Plan } from '@flowmic/protocol';
import type { AuthService } from '../auth/auth-service';
import type { BillingService } from '../billing/billing-service';
import { CreemWritesDisabledError, type CreemClient } from '../billing/creem/client';
import { CREEM_USER_ID_KEY } from '../billing/creem/envelope';
import type { SubState } from '../billing/billing-service-types';
import type { SubscriptionWriterFor } from '../billing/subscription-writer';
import { accountUserFromBearer } from './account-auth';
import { sendJson } from './console-http';
import { readBounded } from './body';
import { log } from '../log';

/** HTTP-LOCAL error strings, not protocol `ErrorCode`s — the same choice the
 *  sibling routes made: minting a protocol code no FlowMic client reads is a
 *  façade. The console's own locales carry the sentences. */
export const SUB_NOT_AVAILABLE = 'SUBSCRIPTION_NOT_AVAILABLE';
export const SUB_TIER_UNKNOWN = 'SUBSCRIPTION_TIER_UNKNOWN';
export const SUB_ALREADY_ACTIVE = 'SUBSCRIPTION_ALREADY_ACTIVE';
export const SUB_NOT_NEEDED = 'SUBSCRIPTION_NOT_NEEDED';
export const SUB_BODY_UNREADABLE = 'SUBSCRIPTION_BODY_UNREADABLE';
export const SUB_CHECKOUT_FAILED = 'SUBSCRIPTION_CHECKOUT_FAILED';

// ── change-plan codes, one per cause ─────────────────────────────────────
/** No live subscription to move. Buying is the answer, not switching. */
export const SWITCH_NO_SUBSCRIPTION = 'SUBSCRIPTION_SWITCH_NO_SUBSCRIPTION';
/** Asked to move to the tier already held. Nothing to do, and no charge. */
export const SWITCH_SAME_TIER = 'SUBSCRIPTION_SWITCH_SAME_TIER';
/** The subscription exists but is not in a state we will re-price: a
 *  cancellation is scheduled (resume first), or the provider is chasing a
 *  failed charge. Body carries `state` and `scheduled_change` so the console
 *  can say which. */
export const SWITCH_BLOCKED = 'SUBSCRIPTION_SWITCH_BLOCKED';
/** This deployment cannot do it: the provider holding the row has no
 *  change-plan call wired, the tier is not for sale here, or writes are off. */
export const SWITCH_UNAVAILABLE = 'SUBSCRIPTION_SWITCH_UNAVAILABLE';
/** We asked and do not know what happened — a timeout can land after the
 *  provider has already committed. NOT 「it failed」. */
export const SWITCH_UNCONFIRMED = 'SUBSCRIPTION_SWITCH_UNCONFIRMED';
/** We asked and the provider said no. Nothing changed. */
export const SWITCH_REFUSED = 'SUBSCRIPTION_SWITCH_REFUSED';

/** `{"tier":"pro"}` is 15 bytes. The cap stops an authenticated but hostile
 *  client making us buffer megabytes. */
const MAX_BODY_BYTES = 4 * 1024;

export const SUBSCRIBE_PATH = '/api/cloud/billing/subscribe';
export const CHANGE_PLAN_PATH = '/api/cloud/billing/change-plan';

/**
 * [ALREADY] The states in which a person must NOT be handed a second checkout.
 *
 * 🔴 THE TEST IS 「could this still bill them」, NOT 「are they enjoying it」.
 *   · `active` — including one with a cancellation already scheduled: Creem
 *     reports that as active, so it is in here, and the right control for that
 *     person is 「resume」, not a second subscription.
 *   · `pending` — a checkout of theirs is settling. Two tabs, one intent.
 *   · `past_due` / `paused` — the subscription EXISTS at the provider and can
 *     resume charging. Selling a second one leaves two live agreements and a
 *     customer who cannot tell which of the two they cancelled.
 *
 * ⚠️ `canceled` and `expired` are NOT here, deliberately. Those will never bill
 * again, so buying is the correct and only way back — refusing there would tell
 * a former customer we do not want their money.
 */
const BLOCKING_STATES: ReadonlySet<SubState> = new Set<SubState>(['active', 'pending', 'past_due', 'paused']);

export interface SubscriptionCheckoutDeps {
  auth: AuthService;
  /** Read-only, and the ONLY reader here: 「does this account already have a
   *  subscription」 has one answer in this process and it is `getPlan`. */
  billing: BillingService;
  /** Absent when this deployment has no Creem client. 🔴 ABSENT MEANS THIS ROUTE
   *  REFUSES BY NAME — never that it quietly succeeds. */
  creem?: CreemClient;
  /**
   * Which Creem product sells which tier — DERIVED at bootstrap by reversing
   * `FLOWMIC_CREEM_PRODUCT_TIERS`, never configured a second time.
   *
   * 🔴 ONE TABLE, READ IN BOTH DIRECTIONS. The webhook reads it product→tier to
   * decide what somebody bought; this reads it tier→product to decide what to
   * sell. A second env var would be a second copy of the same mapping, and the
   * day they disagreed we would sell one thing and grant another — with both
   * halves individually looking correct.
   *
   * ⚠️ A tier with no entry (or an ambiguous one — see `subscriptionProducts`)
   * is simply missing here, and the route refuses by name for that tier alone.
   * A deployment selling Pro but not Max is a strange state, not a broken one,
   * and it says so out loud rather than guessing.
   */
  products: Readonly<Partial<Record<Plan, string>>>;
  /** Where the browser lands after paying. Absent ⇒ Creem's own page, which is
   *  honest but says nothing about us. */
  successUrl?: string;
  /**
   * Which outbound client speaks for the subscription's OWN provider — the same
   * resolver billing-routes.ts uses for cancel, for the same reason: a fixed
   * client would send a Creem id to Paddle and tell a paying customer their
   * subscription does not exist. Change-plan asks it once and then asks the
   * writer whether it can do this at all (`changePlan` is optional).
   */
  writerFor: SubscriptionWriterFor;
}

/**
 * Reverse `FLOWMIC_CREEM_PRODUCT_TIERS` into tier→product.
 *
 * 🔴 AN AMBIGUOUS TIER IS DROPPED, NOT PICKED FROM. Two products mapping to
 * `pro` (a monthly and a yearly, say) means 「subscribe to Pro」 has two possible
 * answers, and choosing one by iteration order would silently sell whichever the
 * JSON happened to list first — a price decided by key order. Dropping it makes
 * the route refuse by name, which is a sentence somebody can act on.
 *
 * ⚠️ `free` is skipped even if someone maps a product to it: a paid checkout for
 * the free tier is a contradiction, and selling it would take money for the one
 * thing we give away.
 */
export function subscriptionProducts(
  productTiers: Readonly<Record<string, Plan>>,
): Readonly<Partial<Record<Plan, string>>> {
  const byTier = new Map<Plan, string[]>();
  for (const [productId, tier] of Object.entries(productTiers)) {
    if (tier === 'free') continue;
    const list = byTier.get(tier) ?? [];
    list.push(productId);
    byTier.set(tier, list);
  }
  const out: Partial<Record<Plan, string>> = {};
  for (const [tier, ids] of byTier) {
    const only = ids[0];
    if (ids.length === 1 && only !== undefined) {
      out[tier] = only;
      continue;
    }
    log.warn('billing: tier maps to more than one Creem product — refusing to guess which one to sell', {
      tier,
      product_count: ids.length,
    });
  }
  return out;
}

/** The body's tier, or `undefined`. Anything unrecognised is undefined rather
 *  than defaulted: 「subscribe me to something」 has no safe default when the
 *  something costs money every month. */
function readTier(raw: unknown): Plan | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const tier = (raw as { tier?: unknown }).tier;
  return tier === 'pro' || tier === 'max' ? tier : undefined;
}

export function tryHandleSubscriptionCheckoutRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SubscriptionCheckoutDeps,
): boolean {
  const url = (req.url ?? '').split('?')[0];
  if (url === CHANGE_PLAN_PATH && req.method === 'POST') return handleChangePlan(req, res, deps);
  if (url !== SUBSCRIBE_PATH) return false;

  // ── GET: what, if anything, can be bought here ──────────────────────────
  //
  // 🔴 THE SAME CONDITION THE WRITE REFUSES ON, read out loud. The console must
  // not show a button we would then refuse, and the only way to guarantee that
  // is for both answers to come from one value — `deps.products`, which is
  // empty unless Creem is on AND selling is switched on. A separate 「is it on
  // sale」 flag computed anywhere else is a second opinion, and the day the two
  // disagreed we would either hide a live checkout or advertise a dead one.
  //
  // ⚠️ AUTHENTICATED, like everything else under /api/cloud. It is not secret,
  // but the console is the only caller and an unauthenticated variant would be
  // a second door to keep in step.
  if (req.method === 'GET') {
    const whoGet = accountUserFromBearer(req, deps.auth);
    if (!whoGet.ok) {
      sendJson(res, 401, { error: whoGet.error });
      return true;
    }
    const purchasable =
      deps.creem === undefined
        ? []
        : (['pro', 'max'] as const).filter((t) => {
            const id = deps.products[t];
            return id !== undefined && id !== '';
          });
    sendJson(res, 200, { purchasable });
    return true;
  }

  if (req.method !== 'POST') return false;

  // 🔴 SIGNED IN, ALWAYS — the same rule as the one-time service, for the same
  // mechanical reason: a checkout we did not build carries no
  // `flowmic_user_id`, so the payment arrives attributable to nobody and lands
  // in the ledger as `unmapped` while somebody's card has been charged. Being
  // signed in is what makes attribution structural instead of best-effort.
  //
  // ⚠️ AND EMAIL VERIFICATION IS NOT REQUIRED, matching the sibling. Refusing an
  // unverified address takes money off the table for an account state that is
  // recoverable; what is refused here is being ANONYMOUS.
  const who = accountUserFromBearer(req, deps.auth);
  if (!who.ok) {
    sendJson(res, 401, { error: who.error });
    return true;
  }
  const user = who.user;

  void (async (): Promise<void> => {
    const body = await readBounded(req, MAX_BODY_BYTES).catch(() => null);
    if (body === null || body === 'TOO_LARGE') {
      sendJson(res, 400, { error: SUB_BODY_UNREADABLE });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: SUB_BODY_UNREADABLE });
      return;
    }
    const tier = readTier(parsed);
    if (tier === undefined) {
      sendJson(res, 400, { error: SUB_TIER_UNKNOWN });
      return;
    }

    const view = deps.billing.getPlan(user.id);

    // 🔴 AN EXEMPT ACCOUNT IS REFUSED, and this is money we are declining. A
    // permanent-free account already has MAX's limits; letting it buy would
    // charge somebody every month for something they already have, and the first
    // thing we would do on noticing is refund it. Its own code, not
    // ALREADY_ACTIVE — 「you already have this for free」 and 「you already have a
    // subscription」 are two different sentences, and this repo has paid more
    // than once for folding two answers into one value.
    if (view.quota_exempt) {
      sendJson(res, 409, { error: SUB_NOT_NEEDED, plan: view.plan, source: view.source });
      return;
    }

    // [ALREADY] — see the set's own doc for why these four and not the others.
    if (BLOCKING_STATES.has(view.state)) {
      log.info('subscription checkout refused — this account already has one', {
        user_id: user.id,
        state: view.state,
        plan: view.plan,
      });
      sendJson(res, 409, {
        error: SUB_ALREADY_ACTIVE,
        // What the console needs in order to say the right sentence WITHOUT
        // asking again: 「you are on Pro」 and 「your cancellation is already
        // scheduled」 are different screens, and a second round trip could come
        // back with a different answer than the one this refusal was based on.
        plan: view.plan,
        state: view.state,
        scheduled_change: view.scheduled_change,
      });
      return;
    }

    const creem = deps.creem;
    const productId = deps.products[tier];
    if (creem === undefined || productId === undefined || productId === '') {
      // Named, not 404 and not 500: the account is fine and the request is fine,
      // this deployment just cannot sell that tier. The console can say so.
      log.warn('subscription checkout unavailable', {
        user_id: user.id,
        tier,
        has_client: creem !== undefined,
        has_product: productId !== undefined && productId !== '',
      });
      sendJson(res, 503, { error: SUB_NOT_AVAILABLE, tier });
      return;
    }

    const requestId = randomUUID();
    // 🔴 THE WRITE SWITCH THROWS, AND IT IS NOT A FAILURE. `createCheckout`
    // raises `CreemWritesDisabledError` when FLOWMIC_CREEM_WRITE_ENABLED is off;
    // letting that reach the catch below would report a deployment setting of
    // ours as 「the checkout failed」, and send an operator to Creem's status page
    // to look for a switch on our own box. Same distinction billing-routes.ts
    // draws for cancel — one sentence per cause.
    let out;
    try {
      out = await creem.createCheckout({
        productId,
        requestId,
        ...(deps.successUrl === undefined ? {} : { successUrl: deps.successUrl }),
        // 🔴 THE ONLY WAY THIS PAYMENT WILL EVER NAME ITS BUYER. If this key
        // is missing or misspelled the money still arrives, the webhook still
        // verifies, and the row lands `unmapped` — a paying customer on the
        // free tier, with nothing red anywhere. `creem/envelope.ts` owns the
        // constant and its test pins the spelling.
        metadata: { [CREEM_USER_ID_KEY]: user.id },
      });
    } catch (e) {
      if (e instanceof CreemWritesDisabledError) {
        log.warn('subscription checkout refused — outbound writes are switched off here', {
          user_id: user.id,
          tier,
        });
        sendJson(res, 503, { error: SUB_NOT_AVAILABLE, tier });
        return;
      }
      throw e;
    }

    if (!out.ok) {
      // The provider's code and our own sentence — never its message verbatim,
      // which can name a customer.
      log.warn('subscription checkout refused by creem', {
        user_id: user.id,
        tier,
        code: out.code,
        detail: out.detail,
      });
      sendJson(res, 502, { error: SUB_CHECKOUT_FAILED });
      return;
    }

    log.info('subscription checkout created', {
      user_id: user.id,
      tier,
      product_id: productId,
      request_id: requestId,
      checkout_id: out.data.id,
    });
    sendJson(res, 200, { checkout_url: out.data.checkout_url, tier });
  })().catch((e) => {
    log.warn('subscription checkout route failed', { error: String(e) });
    try {
      sendJson(res, 500, { error: SUB_CHECKOUT_FAILED });
    } catch {
      /* headers already sent */
    }
  });

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Changing plan on a live subscription: Pro ⇄ Max, proration charged now.
//
// 🔴 MONEY MOVES INSIDE THIS REQUEST, unlike `subscribe` above where the
// person still has a checkout page between them and the charge. So the console
// confirms first and states the mechanism (「the difference is charged now」),
// and this route refuses anything it is not sure about rather than trying.
//
// It writes nothing. The tier arrives on `subscription.update` over the
// webhook, from the provider's own signed statement, exactly as cancel and
// resume do — the row keeps its one author.
// ═══════════════════════════════════════════════════════════════════════════

/** The one state a plan can be re-priced in. A scheduled cancellation is
 *  reported as `active` in `state` but carries a scheduled change; what the
 *  upgrade endpoint does to a subscription on its way out was NOT measured, so
 *  it is refused by name rather than tried. past_due / paused: the provider is
 *  chasing money already — re-pricing on top is a second problem. */
function canRePrice(view: { state: SubState; scheduled_change: unknown }): boolean {
  return view.state === 'active' && view.scheduled_change === null;
}

function handleChangePlan(req: IncomingMessage, res: ServerResponse, deps: SubscriptionCheckoutDeps): boolean {
  const who = accountUserFromBearer(req, deps.auth);
  if (!who.ok) {
    sendJson(res, 401, { error: who.error });
    return true;
  }
  const user = who.user;

  void (async (): Promise<void> => {
    const body = await readBounded(req, MAX_BODY_BYTES).catch(() => null);
    if (body === null || body === 'TOO_LARGE') {
      sendJson(res, 400, { error: SUB_BODY_UNREADABLE });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: SUB_BODY_UNREADABLE });
      return;
    }
    const tier = readTier(parsed);
    if (tier === undefined) {
      sendJson(res, 400, { error: SUB_TIER_UNKNOWN });
      return;
    }

    const view = deps.billing.getPlan(user.id);
    const subId = view.paddle_subscription_id;
    // 🔴 THE REFUSALS, IN THE ORDER THAT COSTS LEAST TO GET WRONG.
    if (view.quota_exempt) {
      sendJson(res, 409, { error: SUB_NOT_NEEDED, plan: view.plan, source: view.source });
      return;
    }
    if (subId === null || view.state === 'none' || view.state === 'expired' || view.state === 'canceled') {
      sendJson(res, 409, { error: SWITCH_NO_SUBSCRIPTION, state: view.state });
      return;
    }
    if (view.plan === tier) {
      sendJson(res, 409, { error: SWITCH_SAME_TIER, plan: view.plan });
      return;
    }
    if (!canRePrice(view)) {
      sendJson(res, 409, { error: SWITCH_BLOCKED, state: view.state, scheduled_change: view.scheduled_change });
      return;
    }

    // Which client holds this row — see billing-routes.ts for why null is not
    // a fallback. Then: can that client do THIS at all.
    const provider = view.billing_provider ?? 'paddle';
    const writer = deps.writerFor(provider);
    const productId = deps.products[tier];
    if (writer === null || writer.changePlan === undefined || productId === undefined || productId === '') {
      log.warn('billing: plan change unavailable on this deployment', {
        user_id: user.id,
        provider,
        has_writer: writer !== null,
        can_change: writer?.changePlan !== undefined,
        has_product: productId !== undefined && productId !== '',
        tier,
      });
      sendJson(res, 503, { error: SWITCH_UNAVAILABLE, tier });
      return;
    }

    let out;
    try {
      out = await writer.changePlan(subId, productId);
    } catch (e) {
      if (e instanceof CreemWritesDisabledError) {
        log.warn('billing: plan change refused — outbound writes are switched off here', { user_id: user.id });
        sendJson(res, 503, { error: SWITCH_UNAVAILABLE, tier });
        return;
      }
      throw e;
    }
    if (!out.ok) {
      // 🔴 TWO SENTENCES, NOT ONE. A timeout can land after the provider has
      // already re-priced and charged; telling that person 「it failed」 sends
      // them to click again. The normalised code is what separates the two —
      // the same distinction billing-routes.ts draws for cancel.
      log.warn('billing: plan change not confirmed by provider', {
        user_id: user.id,
        provider,
        code: out.code,
        detail: out.detail,
      });
      sendJson(res, 502, { error: out.code === 'PROVIDER_UNREACHABLE' ? SWITCH_UNCONFIRMED : SWITCH_REFUSED });
      return;
    }

    log.info('billing: plan change accepted by provider', {
      user_id: user.id,
      provider,
      subscription_id: subId,
      from: view.plan,
      to: tier,
      provider_status: out.data.status,
    });
    // The provider's own post-state, and a flag saying the local row is not
    // yet updated — the same receipt shape cancel returns.
    sendJson(res, 200, { ok: true, to: tier, provider_status: out.data.status, settles_via_webhook: true });
  })().catch((e) => {
    log.warn('billing: plan change route failed', { error: String(e) });
    try {
      sendJson(res, 500, { error: SWITCH_REFUSED });
    } catch {
      /* headers already sent */
    }
  });

  return true;
}
