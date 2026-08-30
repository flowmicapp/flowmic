// SPEC-REF:
//   apps/server-core/src/bootstrap-http-deps.ts (its only caller)
//   apps/server-core/src/http/paddle-routes.ts (PaddleRoutesDeps — the shape)
//   apps/server-core/src/billing/paddle/webhook-handler.ts (what the deps feed)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Which billing providers this process accepts webhooks from, and with what.
//
// 🔴 WHY IT MOVED OUT OF bootstrap-http-deps.ts, so nobody re-merges it: that
// file crossed the repo's 800-line cap the moment Creem was wired beside Paddle
// (831). The precedent is to SPLIT AND KEEP THE EVIDENCE rather than compress
// the reasoning away — schema.ts → schema-billing.ts, bootstrap.ts →
// bootstrap-http-deps.ts. Nothing about the wiring changed.

import { creemAdapter } from './billing/creem/adapter';
import { createCreemClient } from './billing/creem/client';
import { createCreemSubscriptionClient } from './billing/creem/subscription-client';
import { paddleAdapter } from './billing/paddle/adapter';
import { asPaddleSubscriptionWriter } from './billing/paddle/subscription-writer-adapter';
import type { PaddleClient } from './billing/paddle/client';
import type { SubscriptionWriter, SubscriptionWriterFor } from './billing/subscription-writer';
import type { BillingService } from './billing/billing-service';
import type { ServerConfig } from './config';
import type { DbConnection } from './db/connection';
import type { BillingRepo, PaddleSubRow } from './db/repos/billing.repo';
import type { AuthService } from './auth/auth-service';
import type { PaddleRoutesDeps } from './http/paddle-routes';
import type { ServicePurchaseRoutesDeps } from './http/service-purchase-routes';
import type { RefundOrigin, ServiceRefundOutcome } from './billing/service-refund';
import { requestServiceRefund } from './billing/service-refund';
import { PROMISED_DEADLINES } from './billing/guided-setup';
import { resolveServiceMailer } from './mail';
import type { ServiceMailer } from './mail/service-mailer';

export interface BillingWebhookWiring {
  config: ServerConfig;
  db: DbConnection;
  billing: BillingService;
  now?: () => number;
}

/**
 * The repo every provider's intake writes through.
 *
 * 🔴 THE `upsertSubscription` OVERRIDE IS THE TRIGGER FOR THE `users.plan`
 * MIRROR, not a second copy of it: the write itself lives in BillingService
 * (mirrorPlanColumn). It is here rather than in the handler because that handler
 * is a pure decision function (bytes in, {status,body} out) with no
 * BillingService in reach — and because "a billing event genuinely changed the
 * effective tier" IS this statement: `upsertSubscription` is the only way an
 * event can move a tier. Without it the mirror is only eventually consistent, so
 * a customer who paid and then signed in before anyone asked a plan question
 * would still be handed a token claiming 「free」.
 *
 * ⚠️ It cannot cover the OTHER direction: a subscription lapsing is driven by the
 * clock, not by an event, so the column can still name a tier a moment after it
 * stopped applying. That is why nothing may ENFORCE on it (enforcement reads
 * effectiveLimits) and why the mirror's own doc says it is eventually consistent
 * by construction.
 *
 * 🔴 BOTH PROVIDERS GET THIS SAME WRAPPER. Handing Creem a plain `db.billing`
 * would have made the mirror correct for Paddle customers and stale for Creem
 * ones — the worst kind of half-working, because it looks right in every test
 * that used whichever provider the test author happened to pick.
 *
 * ⚠️ And it is the SAME underlying repo instance everything else uses: a second
 * BillingRepo over the same file would be a second answer to 「have we seen this
 * event_id」, which is the one question the whole idempotency table exists to
 * have exactly one answer to.
 */
function mirroringRepo(db: DbConnection, billing: BillingService): BillingRepo {
  return {
    ...db.billing,
    upsertSubscription: (row: PaddleSubRow): void => {
      db.billing.upsertSubscription(row);
      billing.effectivePlan(row.user_id);
    },
  };
}

/**
 * `{ paddle: … }` when at least one provider is switched on, `{}` otherwise.
 *
 * 🔴 EACH PROVIDER MOUNTS ON ITS OWN FLAG. This used to be one block behind
 * `config.paddle.enabled`, which was fine while Paddle was the only provider and
 * became a trap the moment it was not: Creem is the provider we intend to sell
 * through, Paddle will be OFF in that deployment, and under the old shape
 * turning Paddle off would have silently taken Creem's endpoint down with it.
 * The first symptom would have been a customer who paid and was never upgraded.
 *
 * ⚠️ A provider that is OFF gets no key here, so its path 404s rather than
 * answering 200 to webhooks it never processed — which would tell the sender to
 * stop retrying events we had not seen.
 */
export function billingWebhookDeps(w: BillingWebhookWiring): { paddle?: PaddleRoutesDeps } {
  const { config, db, billing, now } = w;
  if (config.mode !== 'saas' || !(config.paddle.enabled || config.creem.enabled)) return {};

  const repo = mirroringRepo(db, billing);
  const paddle: PaddleRoutesDeps = {
    // WHICH PROVIDER EACH ROUTE SPEAKS FOR. Fixed from configuration, never
    // sniffed from the body — see BillingWebhookDeps.adapter for why letting the
    // payload choose its own verifier is the whole ballgame.
    ...(config.paddle.enabled
      ? {
          webhook: {
            adapter: paddleAdapter,
            repo,
            users: db.users,
            secret: config.paddle.webhookSecret ?? '',
            toleranceSec: config.paddle.toleranceSec,
            priceTiers: config.paddle.priceTiers,
            ...(now ? { now } : {}),
          },
        }
      : {}),
    ...(config.creem.enabled
      ? {
          creemWebhook: {
            adapter: creemAdapter,
            repo,
            users: db.users,
            secret: config.creem.webhookSecret ?? '',
            // ⚠️ ACCEPTED AND IGNORED by the Creem verifier — its signature
            // carries no timestamp to be outside a window of. Passed anyway so
            // the shared deps stay one shape; the ignoring is documented and
            // pinned where it happens (billing/creem/signature.ts).
            toleranceSec: 0,
            // 🔴 PRODUCT ids here, PRICE ids for Paddle, and two separate env
            // vars. One shared table would check a `prod_xxx` against `pri_xxx`
            // keys, find nothing, and file a correct-looking `unmapped` row for a
            // payment that was fine.
            priceTiers: config.creem.productTiers,
            ...(now ? { now } : {}),
          },
        }
      : {}),
  };
  return { paddle };
}

/**
 * The paid one-time service's routes, when this deployment can sell it.
 *
 * ⚠️ RETURNS `{}` RATHER THAN A HALF-WIRED OBJECT when Creem is off or the
 * product id is unset. The routes then 404, which is the honest answer — a
 * mounted buy button that always answers 503 is a button we put in front of
 * people for no reason.
 */
/**
 * Ask the provider to refund one purchase — the ONE construction the customer's
 * withdraw button, the operator's refund button and the deadline sweep all use.
 *
 * 🔴 IT RESOLVES THE WRITER FROM THE PURCHASE'S OWN ROW, not from configuration.
 * A refund is the one operation where sending an id to the wrong provider is
 * unrecoverable in the customer's favour — Paddle would answer 「entity not
 * found」 and the money would simply not come back, while the row said we asked.
 *
 * Returns `undefined` when this deployment has no client to refund with, and
 * both routes then refuse by name rather than appearing to work.
 */
export function serviceRefunder(
  w: BillingWebhookWiring,
): ((orderId: string, origin: RefundOrigin) => Promise<ServiceRefundOutcome>) | undefined {
  const { config, db, now } = w;
  if (config.mode !== 'saas' || !config.creem.enabled) return undefined;
  const clock = now ?? Date.now;
  const creem: SubscriptionWriter = createCreemSubscriptionClient({
    apiKey: config.creem.apiKey,
    env: config.creem.env,
    writeEnabled: config.creem.writeEnabled,
    // ⚠️ The refund path never needs a customer lookup — it refunds a
    // TRANSACTION whose id is already on the purchase row. This lookup exists
    // for `findRefundableTransaction`, which refunds are not routed through.
    lookup: { customerIdFor: (id) => db.billing.getSubscription(id)?.customer_id ?? null },
  });
  return (orderId, origin) =>
    requestServiceRefund(
      {
        purchases: db.billing,
        writer: creem,
        // 🔴 THE PROMISED PERIODS, FROM THE CONSTANTS THE CONSENT WORDING IS
        // WRITTEN AGAINST — the same object the sweep and the operator queue
        // read. A second literal here would be a second copy of a legal period,
        // and the copy nobody is looking at is the one that goes stale.
        deadlines: PROMISED_DEADLINES,
        now: clock,
      },
      orderId,
      origin,
    );
}

export function servicePurchaseDeps(
  w: BillingWebhookWiring & { auth: AuthService; serviceMailer?: ServiceMailer },
): {
  servicePurchases?: ServicePurchaseRoutesDeps;
} {
  const { config, db, auth, now } = w;
  // 🔴 MOUNTED WHENEVER THIS IS A saas BOX — NOT ONLY WHEN IT CAN SELL.
  //
  // It used to return `{}` unless Creem was on and a product id was set, so the
  // routes 404'd. The console can read a 404 exactly one way — 「something went
  // wrong asking」 — and it rendered 「we could not load your purchases」 to
  // somebody whose account was fine, on a deployment that simply is not selling
  // yet. An absence turned into a claim about a failure.
  //
  // The routes already refuse the WRITE by name when there is no client
  // (`SERVICE_NOT_AVAILABLE`), so mounting costs nothing and buys the console a
  // truthful answer: `on_sale: false`, rendered as 「coming soon」.
  //
  // ⚠️ THE READ IS STILL WORTH SERVING WITH THE SWITCH OFF. Somebody who bought
  // while it was on must not watch their purchase disappear because a deployment
  // flag moved; the row is money they paid and an obligation we owe.
  if (config.mode !== 'saas') return {};
  const canSell = config.creem.enabled && config.creem.serviceProductId !== null;
  // ⚠️ BUILT ONCE. An earlier shape called `serviceRefunder(w)` twice inside the
  // object literal — once to test it and once to use it — which constructed two
  // Creem clients and quietly contradicted the 「the clients are built ONCE
  // here」 argument three functions down.
  const refund = serviceRefunder(w);
  return {
    servicePurchases: {
      auth,
      // The SAME repo instance the webhook writes through — one answer to 「what
      // has this person bought」, and the read cannot disagree with the write.
      purchases: db.billing,
      // 🔴 THE CLIENT AND THE PRODUCT ID ARE ABSENT WHEN THIS BOX CANNOT SELL,
      // and their absence is what the buy route already refuses on by name. It
      // is also what the list route reports as `on_sale: false` — one condition,
      // read by both, so 「the button is hidden」 and 「the write would refuse」
      // can never disagree.
      ...(canSell
        ? {
            creem: createCreemClient({
              apiKey: config.creem.apiKey,
              env: config.creem.env,
              // 🔴 CREATING A CHECKOUT IS A WRITE and rides the same switch as
              // every other outbound call. A deployment with intake on and writes
              // off can still RECEIVE payments (someone with an old link) but
              // cannot ISSUE new checkouts — and it says so by name instead of
              // appearing to work.
              writeEnabled: config.creem.writeEnabled,
            }),
            productId: config.creem.serviceProductId ?? undefined,
          }
        : {}),
      // The same function the operator surface gets. Two constructions would be
      // two places for the claim-then-call order to drift.
      ...(refund === undefined ? {} : { refund }),
      // The withdrawal acknowledgement's channel (CRD art. 11(3)). Resolved by the
      // caller so that one mail configuration is read once per boot.
      ...(w.serviceMailer === undefined ? {} : { mailer: w.serviceMailer }),
      ...(config.creem.serviceSuccessUrl === null ? {} : { successUrl: config.creem.serviceSuccessUrl }),
      ...(now ? { now } : {}),
    },
  };
}

/**
 * Which outbound client speaks for a given provider.
 *
 * 🔴 IT RETURNS `null` FOR ANYTHING IT DOES NOT KNOW, and never a default.
 * Falling back to whichever client happens to be configured would send a Creem
 * subscription id to Paddle — which answers 「entity not found」, and the console
 * would then tell a paying customer their subscription does not exist. A refusal
 * the route can name is strictly better than a wrong answer that looks like one.
 *
 * ⚠️ CREEM'S WRITER IS ABSENT WHEN CREEM IS OFF, so a deployment that has never
 * been configured for it refuses by name rather than constructing a client with
 * an empty key and discovering that one request later.
 *
 * ⚠️ The clients are built ONCE here rather than per request: each holds only
 * configuration and a fetch, so a per-call construction would be waste — and it
 * would also make the write switch re-read at a different moment than the
 * checkout client re-reads it.
 */
export function subscriptionWriterFor(w: BillingWebhookWiring & { paddleClient: PaddleClient }): SubscriptionWriterFor {
  const paddle = asPaddleSubscriptionWriter(w.paddleClient);
  const creem: SubscriptionWriter | null = w.config.creem.enabled
    ? createCreemSubscriptionClient({
        apiKey: w.config.creem.apiKey,
        env: w.config.creem.env,
        writeEnabled: w.config.creem.writeEnabled,
        lookup: {
          // ⚠️ FROM OUR OWN ROW, not a second round trip to Creem. The row is
          // already the thing that records which customer a subscription is,
          // and asking the provider would make a refund lookup depend on two
          // calls succeeding where one will do. A one-method slice, so this
          // client cannot reach the row it is reading in order to write it —
          // the webhook stays that row's only author.
          customerIdFor: (subscriptionId: string): string | null =>
            w.db.billing.getSubscription(subscriptionId)?.customer_id ?? null,
        },
      })
    : null;
  return (provider: string): SubscriptionWriter | null => {
    if (provider === 'paddle') return paddle;
    if (provider === 'creem') return creem;
    return null;
  };
}
