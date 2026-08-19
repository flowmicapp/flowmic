// SPEC-REF:
//   src/bootstrap.ts (the ONE caller — this file is the http half of its wiring)
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §2 (module wiring)
//
// ── STRUCTURAL SPLIT, CARD VERIFY-1 (2026-08-11) ────────────────────────────
// The HttpDeps composition below moved VERBATIM out of `bootstrap.ts`
// `startServer` (which stood at 797 lines against the 800-line cap
// verify/lint/file-size.mjs enforces — the same pressure and the same remedy as
// http/password-reset-routes.ts's split out of console-routes.ts). Every block
// and every comment travelled unchanged. The ONLY differences are the seam
// adaptations a closure-to-function move forces, each named here so nobody has
// to diff to find them:
//   · `SERVER_VERSION`        → the `version` wiring field (importing it back
//     from bootstrap.ts would be a cycle);
//   · `STANDALONE_USER_ID`    → the `standaloneUserId` wiring field (same cycle);
//   · `overrides.now`         → the `now` wiring field (same value, threaded);
//   · `() => lanTlsFingerprint` (a closure over bootstrap's late-assigned let)
//     → the `lanTlsFingerprint` thunk wiring field — bootstrap still owns the
//     variable and still passes the same closure;
//   · the `broadcastSettingsUpdated` lambda (a closure over bootstrap's `ioRef`
//     let) → the `broadcastSettingsUpdated` wiring field — the lambda body now
//     lives at the call site in bootstrap, beside the `ioRef` it closes over.
// Nothing else changed in the move.
//
// VERIFY-1's OWN wiring (the email-verification routes dep + the `verifiedEmail`
// gate reader on the console and timeline-grants surfaces) landed HERE, in the
// new file, per the card — those blocks are marked VERIFY-1 and are the only
// non-moved content.

import { dirname, join } from 'node:path';
import type { Socket } from 'socket.io';
import type { ServerConfig } from './config';
import type { BillingService } from './billing/billing-service';
import type { DbConnection } from './db/connection';
import type { PaddleSubRow } from './db/repos/billing.repo';
import type { AuthService } from './auth/auth-service';
import type { RegisterRateLimiter } from './auth/register-rate-limit';
import type { QrGrantStore } from './auth/qr-grant';
import type { VerificationSendLimiter } from './auth/email-verification';
import type { Registry } from './room/registry';
import type { RoomStore } from './room/store';
import type { ReleaseSuppression } from './room/release-suppression';
import type { InjectPendingRegistry } from './socket/inject-pending';
import type { HttpDeps } from './http/router';
import { makeResolveUserId } from './http/account-auth';
import { diagLogPathBeside } from './http/diag-routes';
import { seedDefaultSettings } from './settings/defaults';
import { seedSaasByokEmpty } from './settings/byok';
import type { EmailVerificationMailer, PasswordResetMailer } from './mail';
import type { ProbedTargets } from './status/status-probes';
import { log } from './log';

/** Everything the HttpDeps composition read out of `startServer`'s closure,
 *  named. Each field is the SAME instance bootstrap uses elsewhere — handing a
 *  fresh instance for any of them re-creates the two-answers trap the original
 *  closure avoided by construction (ReleaseSuppression's own comment is the
 *  canonical statement). */
export interface HttpDepsWiring {
  config: ServerConfig;
  billing: BillingService;
  /** bootstrap's SERVER_VERSION (passed in — importing it back would be a cycle). */
  version: string;
  /** bootstrap's STANDALONE_USER_ID (same cycle argument as `version`). */
  standaloneUserId: string;
  db: DbConnection;
  authService: AuthService;
  registerLimiter: RegisterRateLimiter;
  /** Separate per-IP limiter for POST /api/site/collect. */
  siteAnalyticsLimiter: RegisterRateLimiter;
  passwordLimiter: RegisterRateLimiter;
  qrGrants: QrGrantStore;
  registry: Registry;
  store: RoomStore<Socket>;
  injectPending: InjectPendingRegistry;
  releaseSuppression: ReleaseSuppression;
  mail: PasswordResetMailer;
  /** VERIFY-1 — the verification-code channel (sibling of `mail`; see
   *  mail/email-verification-mailer.ts). Required for the same book 13 §7 F1 ②
   *  reason `mail` is: an optional mailer here would let a bootstrap missing one
   *  line mount a send route that stores a code and delivers nothing. */
  verificationMail: EmailVerificationMailer;
  /** VERIFY-1 — the per-account send budget (≤3 / 15 min). ONE instance per
   *  server, constructed in bootstrap beside the other limiters — a fresh
   *  instance here would be a limiter that never limits (the ReleaseSuppression
   *  trap). */
  verificationSendLimiter: VerificationSendLimiter;
  /** The late-binding thunk over bootstrap's `lanTlsFingerprint` let — see the
   *  original comment at the field below. */
  lanTlsFingerprint: () => string | null;
  /** The WP-W1b ioRef fan-out lambda — the body lives at bootstrap's call site
   *  beside the `ioRef` it closes over. */
  broadcastSettingsUpdated: (userId: string, payload: { key: string; value: unknown }) => void;
  /** W-5a (REQ-13-03) — the status probe store's read side. A THUNK over
   *  bootstrap's runner, for the same reason `lanTlsFingerprint` is one: the http
   *  handler is built once, and the answer changes on every probe tick. The
   *  runner itself stays owned by bootstrap because it has to be STOPPED (the
   *  shutdown sequence), and a route module is not where a timer's lifetime
   *  belongs. */
  statusSnapshot: () => ProbedTargets;
  /** bootstrap's `overrides.now`, threaded through unchanged. */
  now?: () => number;
}

/** Compose the HttpDeps `makeHttpHandler` consumes. VERBATIM from bootstrap.ts
 *  (see the file header for the move record and the seam adaptations). */
export function composeHttpDeps(w: HttpDepsWiring): HttpDeps {
  const {
    config, billing, version, standaloneUserId, db, authService, registerLimiter,
    siteAnalyticsLimiter,
    passwordLimiter, qrGrants, registry, store, injectPending, releaseSuppression,
    mail, lanTlsFingerprint, broadcastSettingsUpdated, statusSnapshot, now,
  } = w;
  return {
    config,
    billing,
    version,
    // D2LAN-B2b — the carriage to the pairing QR. Publishing the fingerprint of a
    // public key is not a disclosure; the argument lives at the route (http/router.ts,
    // symbol `publishableLanTlsFingerprint`), where a reader will ask it.
    lanTlsFingerprint,
    // R4 ④ / owner ruling A3 (2026-07-31): the http surface's acting user. This
    // was `() => STANDALONE_USER_ID` in BOTH modes — i.e. every saas caller was
    // the same person — which is the lock behind the door the owner closed on the
    // VPS by disabling FLOWMIC_MOCK_BILLING. saas now reads the verified Bearer
    // subject and refuses (401, named, logged) when there is none; standalone
    // keeps its single local user, which is correct there (account-auth.ts §head).
    // `authService` is the SAME instance the REST + socket paths verify with — a
    // second one would be a second answer to 「is this token good」.
    resolveUserId: makeResolveUserId({
      mode: config.mode,
      standaloneUserId,
      ...(config.mode === 'saas' ? { account: authService } : {}),
    }),
    // RV-98 (owner 2026-08-01: "must correctly show whether the PC side is online"): GET /api/pc/presence.
    // Wired in BOTH modes — this is the one route the relay must answer, because
    // the relay answering /api/health proves nothing about the owner's PC. Same
    // `registry` and `store` instances the socket handlers use: the answer is
    // literally `store.getPc(room) !== null`, the expression already behind the
    // `pc_online` field on the pair/reconnect acks, not a second definition.
    // C9 (2026-08-17) — `db.pcs` is the read-only half of the same table the
    // registry writes: the route asks it whether this machine is in a room under
    // another account, so a stranded phone is told to re-pair instead of being
    // sent to check a computer that is powered on and fine. The dep is REQUIRED
    // (presence-routes.ts states why), so forgetting this line is a type error
    // rather than a feature that silently is not there.
    presence: { registry, store, pcs: db.pcs },
    // D6 (2026-08-04) — the pairing registry `POST /api/diag/mobile` judges its
    // Bearer against, wired in BOTH modes because the route is now mounted in
    // both. The SAME `registry` the socket handlers use; a dep of its own rather
    // than something the router digs out of `presence` (which is narrowed to the
    // side-effect-free lookup on purpose) — full reasoning at HttpDeps.pairing.
    pairing: registry,
    // D3 (2026-08-04) — /api/health used to answer `ok:true` unconditionally,
    // i.e. it only ever proved node:http was still accepting sockets. This is the
    // cheapest question that actually touches the database; it THROWS on failure
    // and the router turns that into `503 {ok:false, db:'error'}`.
    //
    // 🔴 It proves 「the handle still answers a query」 and NOT 「the disk can be
    // written」 — that is a write failure a read cannot see, and a write probe was
    // rejected because this route is unauthenticated and polled (see
    // HttpDeps.dbProbe). Prepared per call on purpose: a statement prepared once
    // at wiring time is a handle captured while the DB was provably healthy, and
    // the failure this exists to catch arrives later.
    dbProbe: () => { db.raw.prepare('SELECT count(*) FROM sqlite_master').get(); },
    // owner 2026-07-29: "add remote sync of phone logs". ⚠️ IT-15 EXPIRED CLAIM kept
    // visible: 「lands in the SAME file the server already writes」— that let one
    // authenticated uploader rotate away every tenant's ops history (see
    // diagLogPathBeside). Intent kept as SAME DIRECTORY; write target is now
    // the sibling. 🔴 Deployed: FLOWMIC_LOG_PATH set ⇒ `*-mobile-diag.log`
    // beside ops, not into it. Unset ⇒ DIAG_NO_SINK (mount decision unchanged).
    ...(process.env.FLOWMIC_LOG_PATH
      ? { diag: { logPath: diagLogPathBeside(process.env.FLOWMIC_LOG_PATH) } }
      : {}),
    // L-④ (owner 2026-08-02, both-ends online upgrade): GET /api/updates/latest. Same
    // "only mounted once configured" shape as FLOWMIC_LOG_PATH right above — the env var IS the
    // mount decision, and an unset one means this deployment simply does not
    // publish an update manifest (→ router 404), which is a different answer from
    // "configured but the file can't be read" (→ 503 UPDATE_MANIFEST_UNAVAILABLE).
    //
    // 🔴 The manifest is a FILE, deliberately: it answers "which version is the latest released artifact"
    // while SERVER_VERSION answers "which version this relay is running", and those two genuinely drift
    // (0.2.37 shipped with no relay deploy). Deriving one from the other is the
    // "one value answering two questions" shape this repo has already shipped five times.
    // In production = /etc/flowmic-app/updates.json, beside the existing env file, so a
    // release updates the manifest WITHOUT redeploying the relay.
    ...(process.env.FLOWMIC_UPDATE_MANIFEST_PATH
      ? { updates: { manifestPath: process.env.FLOWMIC_UPDATE_MANIFEST_PATH } }
      : {}),
    // W-5a (REQ-13-03): GET /api/status. UNCONDITIONAL, unlike the two
    // env-gated mounts above — and the difference is the point. `updates` and
    // `diag` are absent when a deployment does not participate at all; a status
    // endpoint that disappeared when the managed lines were unconfigured would
    // fail to answer the one question it exists for. It reports `not_configured` for those
    // lines instead, which is a fact, and keeps answering for the relay row.
    status: { snapshot: statusSnapshot, version, mode: config.mode },
    // RCA-v3 (owner 2026-07-30: "first transfer the picture to the PC, save it to the data directory, then copy it -> CTRL+V"):
    // the picture-delivery http ingress. Standalone-only (router gates it);
    // images land next to the DB. An in-memory DB has no data dir → the route
    // still relays, and answers saved:false honestly.
    ...(config.mode === 'standalone'
      ? {
          inject: {
            registry,
            store,
            pending: injectPending,
            suppression: releaseSuppression,
            ...(config.dbPath !== ':memory:'
              ? { imagesDir: join(dirname(config.dbPath), 'inbox-images') }
              : {}),
          },
        }
      : {}),
    // D1 §5.1 — Paddle's webhook ingress. Mounted ONLY when this deployment is
    // actually taking money: saas AND `FLOWMIC_PADDLE_ENABLED`. Absent → the path
    // 404s, the same 「not mounted in this deployment」 answer auth/console give.
    //
    // `config.paddle.webhookSecret` is non-null here BY CONSTRUCTION, not by
    // hope: config.ts refuses to boot when paddle is enabled without one (an
    // enabled endpoint with no secret verifies nothing, i.e. accepts a forged
    // upgrade from anyone). The `?? ''` below can therefore never be the value
    // that runs — it exists because TypeScript cannot see that guard, and an
    // empty secret would fail every signature closed rather than open.
    //
    // ⚠️ `config.paddle.apiKey` is deliberately NOT passed to anything. It is
    // stored-but-unused this round (D1 §4-3: "this round only stores it without using it, left for a later reconciliation pull") —
    // Paddle's REST API is how a later window RECONCILES (asks Paddle 「what do
    // you think this subscription is?」), and nothing in this window ever calls
    // out to Paddle. Wiring it now would make it look connected.
    ...(config.mode === 'saas' && config.paddle.enabled
      ? {
          paddle: {
            webhook: {
              // The SAME repo instances everything else uses — a second
              // BillingRepo over the same file would be a second answer to
              // 「have we seen this event_id」, which is the one question the
              // whole idempotency table exists to have exactly one answer to.
              //
              // 🔴 0.2.38 — the ONE call below is the TRIGGER for the `users.plan`
              // mirror, not a second copy of it: the write itself lives in
              // BillingService (see mirrorPlanColumn). It is here rather than in
              // the handler because that handler is a pure decision function
              // (bytes in, {status,body} out) with no BillingService in reach,
              // and because "a Paddle event genuinely changed the effective tier" IS this statement —
              // `upsertSubscription` is the only way a Paddle event can move a
              // tier. Without it the mirror is only eventually consistent, so a
              // customer who paid and then logged in before anyone asked a plan
              // question would still be handed a token claiming 「free」.
              // ⚠️ It cannot cover the OTHER direction: a subscription lapsing is
              // driven by the clock, not by an event, so the column can still name
              // a tier a moment after it stopped applying. That is why nothing may
              // ENFORCE on it (enforcement reads effectiveLimits) and why the
              // mirror's own doc says it is eventually consistent by construction.
              repo: {
                ...db.billing,
                upsertSubscription: (row: PaddleSubRow): void => {
                  db.billing.upsertSubscription(row);
                  billing.effectivePlan(row.user_id);
                },
              },
              users: db.users,
              secret: config.paddle.webhookSecret ?? '',
              toleranceSec: config.paddle.toleranceSec,
              priceTiers: config.paddle.priceTiers,
              ...(now ? { now } : {}),
            },
          },
        }
      : {}),
    // saas-only: mount the account REST (register/login/me). Absent in standalone
    // → those routes 404 (the REST surface is mounted saas-only, per the card).
    ...(config.mode === 'saas'
      ? {
          auth: {
            service: authService,
            limiter: registerLimiter,
            qrGrants,
            // owner 2026-07-27: a brand-new account gets its default STT/LLM
            // routings immediately, not at the next restart. Without this the
            // boot-time backfill above would leave anyone who registers mid-run
            // unable to transcribe until the server bounced.
            onUserCreated: (userId): void => {
              // Empty BYOK first so seedDefaultSettings sees `stt.routings`
              // already present and does not write the stock presets into a
              // stranger's console editor (owner 2026-08-14).
              const byok = seedSaasByokEmpty(db.settings, userId);
              const keys = seedDefaultSettings(db.settings, userId);
              const written = [...byok, ...keys];
              if (written.length > 0) log.info('seeded default settings', { userId, keys: written });
            },
            // Site analytics conversions — switch gates COLLECTION only.
            siteCounts: {
              counts: db.siteCounts,
              enabled: config.siteAnalyticsEnabled,
              ...(now ? { now } : {}),
            },
          },
        }
      : {}),
    // First-party public-site collect + download hop. Mounted saas-only; the
    // switch is inside the handler so a closed switch still 302s downloads.
    ...(config.mode === 'saas'
      ? {
          siteCollect: {
            counts: db.siteCounts,
            limiter: siteAnalyticsLimiter,
            enabled: config.siteAnalyticsEnabled,
            allowLocalhostOrigin: process.env.NODE_ENV !== 'production',
            ...(now ? { now } : {}),
          },
          opsSite: {
            auth: authService,
            counts: db.siteCounts,
            audit: db.opsAudit,
            ...(now ? { now } : {}),
          },
        }
      : {}),
    // saas-only: mount the console REST (R5-WEB WP-W1). Bearer reuses authService;
    // billing/repos are the same instances the socket + billing gateway share.
    ...(config.mode === 'saas'
      ? {
          console: {
            auth: authService,
            billing,
            // D1 §6.2 — GET /api/cloud/billing/events reads the SAME ledger the
            // webhook ingress writes (both take `db.billing`). Separate dep from
            // `billing` above on purpose: that one DECIDES "what tier this user is",
            // this one REMEMBERS "which webhooks we've received" — two questions.
            billingLedger: db.billing,
            // 0.2.48 — 🔴 THE FIRST PRODUCTION WRITER of `ops_audit_log`. Until
            // this line the repo was constructed in db/connection.ts and passed to
            // nobody: [not wired], a capability with no caller. /billing/orphans is
            // the one admin route this file mounts, so this is the dep that makes
            // "who read the reconciliation view" answerable at all. See http/ops-audit-trail.ts.
            opsAudit: db.opsAudit,
            pcs: db.pcs,
            mobiles: db.mobiles,
            settings: db.settings,
            // 0.3.0 P4 — account deletion + data export (GDPR). `users` is the
            // ONE writer that destroys the account row (the FK cascade in
            // db/schema.ts does the rest — a hand-written sibling DELETE list
            // would be a second answer to "which tables", and the copy that forgets
            // table #10 is the one that silently leaves data behind); `usage` is
            // the account's monthly totals, which the export owes the user
            // because the privacy policy lists them as data we hold.
            users: db.users,
            usage: db.usage,
            // (0.2.27) `history: db.history` was removed with GET /api/cloud/history
            // and the table behind it — owner: "the web console can't see transcript history".
            passwordLimiter,
            // 🔴 MAIL-1 — THE ONLY PRODUCTION CONSUMER of src/mail/'s password-
            // reset half. Without this line the whole module is a capability with
            // no caller, this repo's #1 historical bug class;
            // test/mail-password-reset.test.ts asserts from the source tree that
            // this file is where it gets built.
            mail,
            // VERIFY-1 D3 — the email-verification gate's reader (the ONE
            // `users.email_verified_at` → verdict conversion is
            // auth/email-verification.ts `isEmailVerified`; this dep only
            // carries the column). Same repo instance the verification routes
            // write through, so the gate can never disagree with the confirm
            // that just opened it.
            verifiedEmail: db.emailVerification,
            broadcastSettingsUpdated,
            ...(now ? { now } : {}),
          },
        }
      : {}),
    // A2-5 / REQ-12-08 — saas-only GET /api/cloud/usage/events, the account's
    // OWN per-event usage log. Same saas-only shape as `console` above, because
    // it IS a `/api/cloud/*` console route: it lives in its own module only
    // because console-routes.ts stands at 784 of the 800-line cap.
    //
    // 🔴 `db.usageEvents` is handed over whole and the route sees exactly one
    // method of it — `UsageEventsRoutesDeps.events` is typed
    // `Pick<UsageEventsRepo,'listForUser'>`, so `append` (the meter's job) and
    // `purgeOlderThan` (the sweep's) are not reachable from a read surface. The
    // slice belongs on the consumer, exactly as `ops.usage` does below.
    //
    // 🔴 MOUNTED REGARDLESS OF `config.usageEventsEnabled`. The switch gates
    // COLLECTION, not reading: with it off this route honestly answers "zero rows"
    // for a period during which nothing was recorded, and 404-ing it instead
    // would make "this deployment has no such route" and "nothing was recorded during this period" the same answer.
    //
    // `verifiedEmail` is the SAME repo instance the console gate reads through,
    // so this surface can never disagree with `/api/cloud/summary` about whether
    // an account has verified.
    ...(config.mode === 'saas'
      ? {
          usageEvents: {
            auth: authService,
            events: db.usageEvents,
            verifiedEmail: db.emailVerification,
          },
        }
      : {}),
    // SALT-1 (design-e-multidevice-salt §3.1) — GET/PUT /api/timeline/keymeta,
    // the account's blind-store key metadata (KDF salt + verification
    // sentinel). saas-only, same mounting shape as `auth`/`console` above, and
    // the router re-checks the mode so a mis-wired dep cannot open it in
    // standalone. Bearer verification reuses the SAME `authService` instance
    // every other account surface uses; the repo is the one db/connection.ts
    // built over `timeline_keymeta`.
    //
    // ⚠️ VERIFY-1 deliberately does NOT gate this surface: its production
    // caller is the PHONE's blind-store provisioner (SALT-2), and every
    // device surface is exempt by the owner's own wording ("console") —
    // test/email-verification.test.ts pins the exemption.
    ...(config.mode === 'saas'
      ? { keymeta: { auth: authService, repo: db.timelineKeymeta } }
      : {}),
    // GRANT-1 §3.4 — GET/DELETE /api/timeline/grants (list + revoke). Same
    // saas-only double-gated mounting as keymeta above; same authService.
    // VERIFY-1 D3 — `verifiedEmail` gates both verbs (a web console surface).
    ...(config.mode === 'saas'
      ? { timelineGrants: { auth: authService, repo: db.timelineGrants, verifiedEmail: db.emailVerification } }
      : {}),
    // VERIFY-1 D2 — POST /api/auth/email-verification/{send,confirm}. SAAS
    // ONLY, the keymeta/timelineGrants double-gated mounting shape (the router
    // re-checks the mode so a mis-wired dep cannot open it in standalone —
    // standalone has no account layer and no email to verify). The mailer and
    // the send limiter are the single per-server instances bootstrap built;
    // the repo is the one db/connection.ts built, and it is the SAME instance
    // the console gate reads through (one answer to "has this account verified").
    ...(config.mode === 'saas'
      ? {
          emailVerification: {
            auth: authService,
            repo: db.emailVerification,
            mailer: w.verificationMail,
            sendLimiter: w.verificationSendLimiter,
            ...(now ? { now } : {}),
          },
        }
      : {}),
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
  };
}
