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

import { billingWebhookDeps, serviceRefunder, servicePurchaseDeps, subscriptionWriterFor } from './bootstrap-billing-deps';
import type { ServiceMailer } from './mail/service-mailer';
import { opsHttpDeps } from './bootstrap-ops-deps';
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
import type { GoogleIdTokenVerifier } from './auth/google-id-token';
import { resolveRegistrationSurgeGate } from './auth/registration-surge';
import type { Registry } from './room/registry';
import type { RoomStore } from './room/store';
import type { ReleaseSuppression } from './room/release-suppression';
import type { InjectPendingRegistry } from './socket/inject-pending';
import type { HttpDeps } from './http/router';
import { makeResolveUserId } from './http/account-auth';
import type { NodeRuntime } from './node/node-runtime';
import { makeForwardReceiver } from './node/forward-receiver';
import { makeForwardLedger } from './node/forward-ledger';
import { diagLogPathBeside } from './http/diag-routes';
import { seedDefaultSettings } from './settings/defaults';
import { seedSaasByokEmpty } from './settings/byok';
import type { PaddleClient } from './billing/paddle/client';
import type { SubscriptionMailer } from './mail/subscription-mailer';
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
  /** 2026-08-29 multi-node: which node this is, the metering seam that implies,
   *  and the snapshot producer if this one is the writer (node/node-runtime.ts).
   *
   *  Passed in whole rather than rebuilt here for the same reason `paddleClient`
   *  is: a second instance is a second place the same rules can be wrong. Passed
   *  as ONE object rather than three fields because they are one decision — the
   *  role determines the other two, and three fields is three chances to wire a
   *  writer's snapshot into a replica. */
  nodeRuntime: NodeRuntime;
  /** The SAME quota guard the STT path uses — passed rather than rebuilt so the
   *  number a replica asks this writer for is produced by the one authority on
   *  what a remaining budget is. On a replica this guard is itself the wrapped
   *  one, which is harmless: a replica never mounts the route that reads it. */
  quota: { remainingSttMs(userId: string): number };
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
  /** 0.3.25 B2 — the subscription-confirmation channel (third sibling of `mail`
   *  and `verificationMail`, required for the same reason both of those are: an
   *  optional mailer here would let a bootstrap missing one line mount a cancel
   *  route that cancels a subscription and tells nobody). */
  subscriptionMail: SubscriptionMailer;
  /** gs-3 — the setup service's channel. REQUIRED, no `?`: bootstrap always
   *  resolves one (real or loudly failing), and an optional field here would let
   *  a wiring that forgot the line still compile and quietly never notify a
   *  buyer that their setup was done. */
  serviceMail: ServiceMailer;
  /** 0.3.25 B2 — the ONE outbound Paddle writer this process has.
   *
   *  🔴 A SINGLE INSTANCE, built in bootstrap beside the limiters and for the
   *  same reason they are: it holds the write switch and the API key, and a
   *  second one constructed somewhere convenient is a second place those two can
   *  be wrong — including a place where `writeEnabled` is accidentally `true`. */
  paddleClient: PaddleClient;
  /** VERIFY-1 — the per-account send budget (≤3 / 15 min). ONE instance per
   *  server, constructed in bootstrap beside the other limiters — a fresh
   *  instance here would be a limiter that never limits (the ReleaseSuppression
   *  trap). */
  verificationSendLimiter: VerificationSendLimiter;
  /** NR-2a — per-IP bucket for the anonymous `confirm-link` route. */
  verificationLinkLimiter: RegisterRateLimiter;
  /** NR-2a item 3 (i) — per-IP DAILY cap on real account mints (24 h /
   *  REGISTER_MAX_PER_DAY; the number is owner-ruled and lives with the
   *  constant, never copied into a second place that can drift). */
  accountMintLimiter: RegisterRateLimiter;
  /** NR-1 — the ONE Google ID-token verifier this process has, constructed in
   *  bootstrap beside the mail channels. Required, and never nullable: an
   *  unconfigured deployment gets the LOUD unconfigured implementation, because
   *  on this surface a permissive DI default is an authentication bypass
   *  (auth/google-id-token.ts's header). A SINGLE instance for the same reason
   *  the limiters are single instances — it owns the JWKS cache, and a
   *  per-request one would re-fetch Google's keys on every sign-in. */
  googleVerifier: GoogleIdTokenVerifier;
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
  // 🔴 THE ONE REFUND ACTION THIS PROCESS HANDS OUT, built once. It carries an
  // outbound client, and a second construction is a second place the write
  // switch and the API key can be read at a different moment — which is exactly
  // the argument `subscriptionWriterFor` makes for building its clients once.
  const opsRefund = serviceRefunder({ config, db, billing, ...(now ? { now } : {}) });
  // ── 2026-08-27 batch-2 item 4 — the GLOBAL daily registration surge gate ───
  //
  // 🔴 ONE INSTANCE PER PROCESS, and it is built HERE rather than in
  // bootstrap.ts for one measured reason: that function is at 799 of its
  // 800-line cap, and this file exists precisely to hold what does not fit
  // (see the header's move record). `composeHttpDeps` is called exactly once
  // per server, immediately before `makeHttpHandler`, so a construction here
  // has the same lifetime a construction there would — which is the property
  // that matters. A per-request counter would count to one and gate nothing.
  //
  // 🔴 SAAS ONLY. Standalone is a LAN sidecar with no accounts and no
  // registration route, so a gate there would be a mechanism nobody can reach;
  // more importantly, `resolveCaptchaVerifier` WARNS about a missing secret,
  // and firing that on every desktop launch would train the one reader of that
  // log to ignore it. Both dep literals below are already saas-gated, so an
  // `undefined` here reaches nothing.
  //
  // Env: FLOWMIC_TURNSTILE_SECRET, FLOWMIC_REGISTER_SURGE_THRESHOLD (both
  // documented at their readers — auth/captcha.ts and auth/registration-surge.ts).
  const surgeGate = config.mode === 'saas' ? resolveRegistrationSurgeGate(process.env, now) : undefined;
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
    // 2026-08-29 multi-node (design: 2026-08-29-multi-node-relay-design-srvny-srvjp.md).
    // Gated on FLOWMIC_NODE_ID and on nothing else, so a single-node deployment —
    // every deployment that exists today — keeps behaving exactly as it does now.
    // That is the compatibility guarantee the design rests on: the node list is an
    // ADDITION. Installed clients dial flowmic.app and must keep working, and we
    // have no channel to tell them otherwise.
    //
    // FLOWMIC_NODE_WRITER_URL present = THIS NODE IS A REPLICA. Its absence is not
    // a default, it is the writer saying so: a replica must never answer a locate
    // miss as authoritative, because replication makes rows arrive late and a miss
    // here is a maybe, not a no.
    ...(process.env.FLOWMIC_NODE_ID
      ? {
          nodes: {
            nodeId: process.env.FLOWMIC_NODE_ID,
            version,
            ...(process.env.FLOWMIC_NODE_LIST_PATH
              ? { nodeListPath: process.env.FLOWMIC_NODE_LIST_PATH }
              : {}),
            ...(process.env.FLOWMIC_NODE_WRITER_URL
              ? { writerUrl: process.env.FLOWMIC_NODE_WRITER_URL }
              : {}),
            // The directory read itself. findByPcid is already user-unscoped by
            // design (pc.repo.ts says why: a phone pairing by PCID has no account
            // of its own yet), which is exactly the shape this needs.
            locatePc: (pcid: string) => {
              const row = db.pcs.findByPcid(pcid);
              // known:false is 「not in THIS copy of the database」 — the route
              // turns that into 「ask the writer」 on a replica. Do not collapse it
              // into node:null; they are different facts and the client acts
              // differently on each.
              return row ? { node: row.home_node, known: true } : { node: null, known: false };
            },
            // ── the writer's receive side ──────────────────────────────────
            //
            // Mounted ONLY on the writer, and the guard is the role rather than
            // 「is a secret configured」. A replica that also accepted forwarded
            // writes would perform them into a snapshot the next replication
            // pull overwrites — a success that was not true, silently, and on
            // billing data. The role is the only thing that answers 「may this
            // process write」, so it is the only thing allowed to gate this.
            ...(w.nodeRuntime.nodeConfig.role === 'writer' && w.nodeRuntime.nodeConfig.sharedSecret
              ? {
                  sharedSecret: w.nodeRuntime.nodeConfig.sharedSecret,
                  ...(w.nodeRuntime.snapshot ? { snapshot: w.nodeRuntime.snapshot } : {}),
                  remainingSttMs: (userId: string) => w.quota.remainingSttMs(userId),
                  receiveForward: makeForwardReceiver({
                    ledger: makeForwardLedger(db.raw),
                    targets: {
                      // The REPLAY tracker, not the ordinary one: same rules,
                      // clock pinned to the record's own timestamp. See
                      // node-runtime.ts `replayUsage` for why that matters at a
                      // month boundary.
                      usage: w.nodeRuntime.replayUsage?.tracker ?? w.nodeRuntime.usageTracker,
                      setHomeNode: (pc_id, home_node) => db.pcs.setHomeNode(pc_id, home_node),
                      setPresence: (pc_id, is_online, last_seen_at) => {
                        db.pcs.setOnline(pc_id, is_online);
                        db.pcs.touchLastSeen(pc_id, new Date(last_seen_at).toISOString());
                      },
                    },
                    ...(w.nodeRuntime.replayUsage
                      ? { pinClock: w.nodeRuntime.replayUsage.pinClock }
                      : {}),
                    onRejected: (id, reason, from) =>
                      log.warn('node.forward rejected', { id, reason, from }),
                    onFailed: (id, reason, from) =>
                      log.error('node.forward FAILED — the replica still owes it', { id, reason, from }),
                  }),
                }
              : {}),
          },
        }
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
    // The billing webhook intake, for whichever providers are switched on.
    // 🔴 EXTRACTED 2026-08-29 because this file crossed the 800-line cap the
    // moment Creem was wired beside Paddle. The reasoning did not disappear —
    // it moved with the code, to bootstrap-billing-deps.ts.
    ...billingWebhookDeps({ config, db, billing, ...(now ? { now } : {}) }),
    // The paid one-time service (owner 2026-08-29). Its own deps object, mounted
    // only when this deployment can actually sell it — see servicePurchaseDeps.
    ...servicePurchaseDeps({
      config, db, billing, auth: authService, serviceMailer: w.serviceMail,
      ...(now ? { now } : {}),
    }),
    // saas-only: mount the account REST (register/login/me). Absent in standalone
    // → those routes 404 (the REST surface is mounted saas-only, per the card).
    ...(config.mode === 'saas'
      ? {
          auth: {
            service: authService,
            limiter: registerLimiter,
            // NR-2a item 3 (i) — the daily account-mint cap. A SEPARATE instance
            // from `limiter`: that one is shared with /api/login and is a burst
            // brake; this one is spent only when an account really exists.
            mintLimiter: w.accountMintLimiter,
            // 2026-08-27 batch-2 item 4 — the GLOBAL daily surge gate. THE SAME
            // object the Google route below receives: two counters would each
            // see half the day's mints, so 80 accounts would read as two calm
            // days of 40 and the gate would never arm.
            ...(surgeGate ? { surgeGate } : {}),
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
            // NR-2a — registration mails its own verification. The SAME three
            // instances the send/confirm routes use, so a link minted here and
            // a link spent there cannot be looking at different stores. Wired
            // unconditionally within saas: when no mail channel is configured
            // `w.verificationMail` is the loudly-failing one, and the dispatch
            // logs a named failure instead of silently not existing.
            verificationMail: {
              mailer: w.verificationMail,
              repo: db.emailVerification,
              settings: db.settings,
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
            // 2026-08-28 (owner §5-1/§5-2) — the console's device surface needs
            // LIVE room membership for two things it could not do before: answer
            // "is this computer here right now" without consulting the persisted
            // `is_online` flag (which a relay restart leaves lying), and evict a
            // phone the moment its pairing is revoked instead of leaving it a
            // working session until it happens to reconnect.
            //
            // The SAME instance the socket handlers and /api/pc/presence use.
            // That is the requirement, not a convenience: presence must have one
            // definition, and a console holding its own store would be a second
            // one that drifts the day rooms are sharded.
            store,
            // The console asks THIS node about a PC that may live on another
            // one. Without an id here, `pcPresence` cannot tell those apart and
            // a healthy remote computer reads as offline — and removable.
            nodeId: w.nodeRuntime.nodeConfig.nodeId,
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
            // NR-2a — the LINK arm's store and its own per-IP bucket. `settings`
            // is the same repo every other `account.*` row goes through, so the
            // send that writes the token and the confirm-link that spends it
            // cannot be looking at two different stores.
            settings: db.settings,
            linkLimiter: w.verificationLinkLimiter,
            ...(now ? { now } : {}),
          },
        }
      : {}),
    // NR-1 — POST /api/auth/google. SAAS ONLY, the same double-gated mounting as
    // its neighbours above (the router re-checks the mode, so a mis-wired dep
    // cannot open account creation on a standalone LAN box).
    //
    // 🔴 BUILT FOR EVERY SAAS DEPLOYMENT, CONFIGURED OR NOT. When
    // FLOWMIC_GOOGLE_CLIENT_ID is unset, `w.googleVerifier` is the loud
    // unconfigured one and the route answers a named 503 — never a 404, and never
    // a quiet acceptance. Gating the MOUNT on configuration instead would make
    // "we do not offer this" and "we are misconfigured" the same answer.
    //
    // `limiter` is the SAME RegisterRateLimiter instance /api/register and
    // /api/login share: one per-IP budget for the whole account layer, not a
    // third door with a fresh allowance. `verifiedEmail` is the SAME repo the
    // verification routes write through and every D3 gate reads, so a gate
    // opened by Google's `email_verified` and one opened by a 6-digit code are
    // the same fact in the same column. `onUserCreated` is the register route's
    // seeding hook, duplicated here deliberately rather than shared through a
    // local: both literals hand over the SAME closure body, and an account minted
    // by either door must be able to transcribe on its first session.
    ...(config.mode === 'saas'
      ? {
          googleAuth: {
            service: authService,
            users: db.users,
            verifiedEmail: db.emailVerification,
            limiter: registerLimiter,
            // 2026-08-27 batch-2 item 4 — the SAME gate object `auth:` above
            // holds. This route is a mint path; before this card it counted
            // nowhere, which made it the surge gate's own bypass
            // (google-auth-routes.ts `surgeGate` carries the argument).
            ...(surgeGate ? { surgeGate } : {}),
            verifier: w.googleVerifier,
            onUserCreated: (userId): void => {
              const byok = seedSaasByokEmpty(db.settings, userId);
              const keys = seedDefaultSettings(db.settings, userId);
              const written = [...byok, ...keys];
              if (written.length > 0) log.info('seeded default settings', { userId, keys: written });
            },
            ...(now ? { now } : {}),
          },
        }
      : {}),
    // 🔴 0.3.25 B2 — POST /api/cloud/billing/{cancel,resume}. SAAS ONLY, the
    // same mounting shape as its neighbours: standalone is a LAN server with no
    // merchant of record, so there is nothing there to cancel and the paths 404.
    //
    // ⚠️ MOUNTED EVEN WHEN OUTBOUND WRITES ARE OFF, on purpose. The switch is
    // read inside the client, which throws by name, and the route turns that
    // into a 503 the console can render. Gating the MOUNT on it instead would
    // make a switched-off deployment answer 404 — 「there is no such feature」 —
    // which is a different and less true sentence than 「this deployment cannot
    // do that right now」, and it is the one a user cannot act on.
    ...(config.mode === 'saas'
      ? {
          billingControls: {
            auth: authService,
            billing,
            // Chosen per subscription, from the provider on its own row — see
            // bootstrap-billing-deps.ts for why there is no default.
            writerFor: subscriptionWriterFor({ config, db, billing, ...(now ? { now } : {}), paddleClient: w.paddleClient }),
            mailer: w.subscriptionMail,
            // 0.3.25 B3 — the same repo the webhook writes through. A withdrawal
            // has to leave a row behind, and it is the ONLY write these routes
            // make: the subscription row itself still has exactly one author,
            // the webhook handler.
            refunds: db.billing,
          },
        }
      : {}),
    // The VPN-only operator surfaces — every /api/ops/* dep plus the account
    // restriction write. They live in bootstrap-ops-deps.ts (see its header for
    // why they moved and for the one property they all share: a wide repo in,
    // sliced by the CONSUMER, so `grep` answers 「what can this route do」 at the
    // route rather than here).
    ...opsHttpDeps({
      config, db, authService, serviceMail: w.serviceMail,
      ...(now ? { now } : {}),
      ...(opsRefund === undefined ? {} : { opsRefund }),
    }),
  };
}
