// SPEC-REF:
//   apps/server-core/src/bootstrap-http-deps.ts (its only caller)
//   apps/server-core/src/http/ops-audit-trail.ts (ADMIN_GATED_ROUTES — the fence
//     every surface below sits behind)
//   *** HUMAN-AUDIT SENSITIVE (auth + billing) — reviewable in isolation ***
//
// THE VPN-ONLY OPERATOR SURFACES, and what each one is allowed to reach.
//
// 🔴 WHY IT MOVED OUT OF bootstrap-http-deps.ts, so nobody re-merges it: that
// file crossed the repo's 800-line cap when gs-3 wired the refund action and the
// completion-notice channel into the purchase queue. The precedent is to move a
// coherent family out VERBATIM and keep the reasoning — schema.ts →
// schema-billing.ts, bootstrap-http-deps.ts → bootstrap-billing-deps.ts,
// bootstrap.ts → bootstrap-sweeps.ts / bootstrap-mail.ts. Every block below is
// that file's text, unchanged.
//
// ── 🔴 THE ONE PROPERTY THIS WHOLE FILE IS ABOUT ──────────────────────────
//
// Every dep here is handed a WIDE repo and sliced by its CONSUMER's type. That
// is not an accident of style: it means `grep` answers 「what can this operator
// route actually do」 by reading ONE `Pick<>` at the route, rather than by
// tracing what happened to be passed from here. A route that could reach
// `users.remove` or `billing.recordOneTimePurchase` would be one body field
// away from destroying an account or inventing a purchase nobody paid for.
//
// ⚠️ EVERY BLOCK IS saas-ONLY, and the router re-checks the mode. A mis-wired
// dep must not be able to open a cross-account read — let alone a write — on a
// standalone box sitting on somebody's desk.

import type { ServerConfig } from './config';
import type { DbConnection } from './db/connection';
import type { AuthService } from './auth/auth-service';
import type { HttpDeps } from './http/router-deps';
import type { RefundOrigin, ServiceRefundOutcome } from './billing/service-refund';
import type { ServiceMailer } from './mail/service-mailer';

export interface OpsDepsWiring {
  config: ServerConfig;
  db: DbConnection;
  authService: AuthService;
  /** Injectable clock, threaded through unchanged from the caller. */
  now?: () => number;
  /** gs-3 — the channel the completion notice goes out on. */
  serviceMail: ServiceMailer;
  /** The shared refund action, or undefined when this deployment cannot refund.
   *  🔴 UNDEFINED MEANS THE REFUND ROUTE REFUSES BY NAME rather than appearing
   *  to work — see http/ops-purchase-routes.ts. */
  opsRefund?: (orderId: string, origin: RefundOrigin) => Promise<ServiceRefundOutcome>;
}

/** The operator-surface slice of {@link HttpDeps}. Spread into the literal that
 *  builds the rest. */
export function opsHttpDeps(w: OpsDepsWiring): Partial<HttpDeps> {
  const { config, db, authService, opsRefund, now } = w;
  return {
    // 0.2.48 — saas-only CROSS-ACCOUNT ops REST (`/api/ops/*`, O-2 platform usage aggregation).
    //
    // 🔴 This block is what turns O-2 from [not wired] into a route. The aggregates
    // (`usage.listMonths/totalForMonth/listUsersForMonth`) shipped in 0.2.47 with
    // 17 green tests and no HTTP exposure at all — the repo's #1 shape, and the
    // reason the M2 handoff report refused to call it "implemented".
    //
    // Three deps, all required, and each one is the SAME instance the rest of the
    // process uses: the verifier is the account AuthService (so this ingress can
    // never admit a Bearer the console rejects), the usage repo is the one billing
    // writes through (so an ops read cannot show a different number from the one
    // being enforced), and the audit sink is the one db/connection.ts built.
    ...(config.mode === 'saas'
      ? {
          ops: {
            auth: authService,
            usage: db.usage,
            audit: db.opsAudit,
            // D11 — the READ slice. Same `OpsAuditRepo` instance as `audit` one
            // line up, deliberately handed over as a SECOND dep rather than by
            // widening `OpsAuditSink`: the gate must not gain the ability to read
            // its own trail as a side effect of being able to write it
            // (ops-routes.ts §OpsRoutesDeps.auditLog carries the full argument).
            auditLog: db.opsAudit,
          },
        }
      : {}),
    // A2-3 (2026-08-12) — saas-only `POST /api/ops/users/restrict`, the
    // "restrict usage" write. Same saas-only shape as `ops` right above; the router
    // re-checks the mode so a mis-wired dep cannot open a cross-account WRITE on
    // a standalone box.
    //
    // 🔴 `db.users` is handed over WHOLE and the route only ever sees two
    // methods of it — `AccountRestrictionRoutesDeps.users` is typed
    // `Pick<UserRepo,'findById'|'setRestricted'>`, so `remove` (destroys an
    // account) and `setPlan` (moves a tier, which owner ruled the ops side "won't do for now")
    // are not reachable from that module even though this object has them. The
    // slice belongs on the consumer, exactly as `ops.usage` does one block up.
    //
    // The audit sink is the SAME `OpsAuditRepo` instance the gate writes
    // through: this route appends a SECOND, business-level row beside the gate's
    // route-level one, and two instances would be two answers to "was this action
    // logged" — the one question the whole table exists to answer once.
    ...(config.mode === 'saas'
      ? {
          restriction: {
            auth: authService,
            users: db.users,
            audit: db.opsAudit,
            ...(now ? { now } : {}),
          },
        }
      : {}),
    // A2-4 (2026-08-12) — saas-only `GET /api/ops/users{,/detail}`, the read-only
    // account list. Same saas-only shape as `ops` and `restriction` above; the
    // router re-checks the mode so a mis-wired dep cannot publish account rows
    // from a deployment that has no account layer.
    //
    // 🔴 `db.users` is handed over WHOLE and the route only ever sees two READ
    // methods of it — `OpsUserRoutesDeps.users` is typed
    // `Pick<UserRepo,'listPage'|'findById'>`, so `remove`, `setPlan`,
    // `setRestricted`, `setPassword` and `setPermanentFree` are all unreachable
    // from a list surface even though this object has them. The slice belongs on
    // the consumer, exactly as `ops.usage` and `restriction.users` do.
    //
    // ⚠️ NO `billing` DEP, AND ITS ABSENCE IS THE POINT (M2-8): a list is a loop,
    // and the only way to answer "which tier" today is `getPlan`, which WRITES the
    // column it reports. The surface cannot ask because it has nobody to ask.
    ...(config.mode === 'saas'
      ? {
          opsUsers: {
            auth: authService,
            users: db.users,
            audit: db.opsAudit,
            // LOGIN-1 — the SWITCH STATE, not a permission. The route is mounted
            // either way and reports `login_recording` honestly; what this
            // decides is whether the card can say "we are not recording"
            // (我们没在记) instead of showing a blank that looks like a dormant
            // account. Same reasoning as `opsUsageEvents` being mounted
            // regardless of `usageEventsEnabled` just below: the switch gates
            // COLLECTION, never READING.
            loginRecording: config.loginRecordEnabled,
          },
        }
      : {}),
    // A2-5 / REQ-12-08 — saas-only GET /api/ops/usage/events?user_id=, the
    // operator's view of ONE account's usage detail. The ops-side twin of
    // `usageEvents` above, and a SEPARATE dep because the two have opposite
    // trust models (that one is scoped to the Bearer with no target parameter;
    // this one names another account and is admin-gated).
    //
    // 🔴 `db.usageEvents` is handed over whole and the route sees exactly one
    // method of it — `Pick<UsageEventsRepo,'listForUser'>` — so `append` and
    // `purgeOlderThan` are unreachable from a read surface. Slice on the
    // consumer, as everywhere else in this file.
    //
    // 🔴 MOUNTED REGARDLESS OF `config.usageEventsEnabled`, same argument as the
    // account-side twin: the switch gates COLLECTION, not reading, and 404-ing
    // the route instead would make "this deployment has no such route" and "nothing was recorded during this period"
    // the same answer to an operator trying to tell them apart.
    ...(config.mode === 'saas'
      ? {
          opsUsageEvents: {
            auth: authService,
            events: db.usageEvents,
            audit: db.opsAudit,
          },
        }
      : {}),
    // 2026-08-29 — the paid setup service's work queue and its one write.
    //
    // 🔴 GATED ON `creem.enabled`, UNLIKE the four ops surfaces above, and the
    // difference is not a style choice: those answer questions about a running
    // platform and are useful on any saas box, while this one lists purchases
    // that only exist where the service can be sold. On a box with no provider
    // it would be a permanently empty screen, and 「nobody has bought」 and
    // 「this box cannot sell」 must not be the same thing an operator sees.
    //
    // 🔴 `db.billing` whole, sliced by the CONSUMER to three methods — so
    // `recordOneTimePurchase` (the webhook's writer) is unreachable from an
    // operator route even though this object carries it. Same construction as
    // `opsUsers.users` and `restriction.users`.
    ...(config.mode === 'saas' && config.creem.enabled
      ? {
          opsPurchases: {
            auth: authService,
            purchases: db.billing,
            audit: db.opsAudit,
            // gs-3 — the completion notice's channel, and the account row the
            // address comes from. 🔴 BOTH OR NEITHER: with only one of them the
            // route can never send, and it says so by leaving the stamp null
            // rather than by pretending.
            mailer: w.serviceMail,
            users: db.users,
            // The SAME refunder the customer's own withdraw button gets. Three
            // authorities, one code path — see bootstrap-billing-deps.ts.
            ...(opsRefund === undefined ? {} : { refund: opsRefund }),
          },
        }
      : {}),
  };
}
