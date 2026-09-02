// SPEC-REF:
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §2 (module wiring), §5.5 (standalone
//     open-source boundary), §4 (/api/health)
//   docs/rebuild/13-LESSONS-LEARNED.md §4 (deploy: bind fail-loud, health grace)
//   CLAUDE.md red line: no silent failure; standalone auto-generates its key and persists it
//
// The single wiring root: config → repos → services → socket.io + http → listen.
// Standalone binds all interfaces (LAN phone pairing); saas binds loopback.
// Handler registration happens per connection. Returns a closeable handle.

import { createServer, type Server as HttpServer } from 'node:http';
import type { Server as TcpServer } from 'node:net';
import type { Server as IoServer, Socket } from 'socket.io';
import type { ServerConfig } from './config';
import { deriveKey } from './auth/crypto';
import { createDbConnection, type DbConnection } from './db/connection';
import { checkSettingsSecretAtBoot } from './startup-secret-check';
import { startSweepsForBootstrap } from './bootstrap-sweeps';
import { makeForwardLedger } from './node/forward-ledger';
import { seedDefaultSettings, seedDefaultSettingsForAllUsers } from './settings/defaults';
import { Registry } from './room/registry';
import { RoomStore } from './room/store';
import { PairRateLimiter } from './room/pair-rate-limit';
import { ReleaseSuppression } from './room/release-suppression';
import { authMiddleware, type JwtHandshakeConfig, type TokenLookup } from './auth/middleware';
import { makeAuthService } from './auth/auth-service';
import { makeAuthRateLimiters } from './auth/register-rate-limit';
import { QrGrantStore } from './auth/qr-grant';
import { VerificationSendLimiter } from './auth/email-verification';
import { wireVerificationGrace } from './auth/verification-grace';
import { createSocketServer } from './socket/server';
import { wireNodeRuntime } from './node/node-runtime';
import { nodeIdForHost, parseNodeHostMap, requestHost } from './node/node-identity';
import { makeQuotaGuard } from './billing/quota-guard';
import { BillingService } from './billing/billing-service';
import { makeHttpHandler } from './http/router';
import { composeHttpDeps } from './bootstrap-http-deps';
import { getAccount, getAccountAuthError, type ActingIdentity } from './socket/wire';
import { registerPcHandlers } from './socket/handlers/pc.handler';
import { registerMobileHandlers } from './socket/handlers/mobile.handler';
import { makeDisconnectHandler } from './socket/handlers/disconnect.handler';
import { registerHeartbeatHandler } from './socket/handlers/heartbeat.handler';
import { registerAuthHandlers } from './socket/handlers/auth.handler';
import { armAuthExpiry, type AuthExpiryClock } from './socket/handlers/auth-expiry';
import { broadcastUpdated, registerSettingsHandlers } from './socket/handlers/settings.handler';
import { registerHistoryHandlers } from './socket/handlers/history.handler';
import { registerTimelineHandlers } from './socket/handlers/timeline.handler';
import { GrantPendingStore, GrantRequestRateLimiter, registerGrantHandlers } from './socket/handlers/grant.handler';
import { installWebAllowlist } from './socket/web-allowlist';
import { registerAudioHandlers } from './socket/handlers/audio.handler';
import { registerComposeHandlers } from './socket/handlers/compose.handler';
import { registerRelayHandlers } from './socket/handlers/relay.handler';
import { InjectPendingRegistry } from './socket/inject-pending';
import { makeCloudImagePolicy } from './socket/cloud-image-policy';
import { makeSttSessionFactory } from './engine/stt-factory';
import { AudioSessionRegistry } from './engine/audio-registry';
import { createComposeFactory } from './compose';
import { wrapSocketHandlers } from './error-handling';
import { makeShutdownSequence } from './shutdown';
import { makeStatusProbes } from './status/status-probes';
import { loadOrMintLanTlsIdentity } from './lan-tls/cert-store';
import { createDualProtocolFront, type DualProtocolFront } from './lan-tls/dual-listener';
import { resolveMailers } from './bootstrap-mail';
import {
  type EmailVerificationMailer,
  type PasswordResetMailer,
  type SubscriptionMailer,
  type ServiceMailer,
} from './mail';
import {
  resolveGoogleIdTokenVerifier,
  unconfiguredGoogleIdTokenVerifier,
  type GoogleIdTokenVerifier,
} from './auth/google-id-token';
import type { PaddleClient } from './billing/paddle/client';
import { resolvePaddleClient } from './billing/paddle/resolve-client';
import { log } from './log';
import { startLatencyReader } from './obs/latency';

export const SERVER_VERSION = '0.3.58';

/** Standalone single-user identity (03 §5.5): ONE local owner, no account layer
 *  mounted, every row in the DB hers. This is the true answer in that mode, not a
 *  placeholder — see http/account-auth.ts before 「fixing」 it. saas resolves its
 *  http identity from the verified Bearer JWT (R4 ④, wired below). */
export const STANDALONE_USER_ID = 'default';

export interface BootstrapHandle {
  httpServer: HttpServer;
  io: IoServer;
  port: number;
  /** D2-LAN — the SPKI fingerprint of the certificate this server is serving on
   *  the LAN, or null when it is serving plain only (which is every saas
   *  deployment, every test, and any standalone run with no durable home — see
   *  config.ts symbol `resolveLanTls`).
   *
   *  ✅ WIRED as of card D2LAN-B2b (this comment used to say "[not wired]" and named
   *  the two missing links; both now exist, so the note is updated rather than
   *  left to become a stale truth). The same value reaches the pairing QR through:
   *  `/api/network` (http/router.ts, symbol `publishableLanTlsFingerprint`) →
   *  the desktop shell (`sidecar/io.rs`, symbol `parse_lan_tls_fingerprint`) →
   *  Rust `PairingInfo.lan_tls_fp` → `buildQrPayload` (desktop `lib/pairing.ts`).
   *
   *  ⚠️ This handle field is NOT what the route reads — the route reads the same
   *  local through a thunk, because the http handler is built before this value
   *  exists. Two readers, one assignment. */
  lanTlsFingerprint: string | null;
  db: DbConnection;
  billing: BillingService;
  close(): Promise<void>;
}

export interface BootstrapOverrides {
  /** Injectable clock (ms) for tests — threads into billing/usage/quota + the
   *  JWT handshake/mint clock + the auth:expired watchdog. */
  now?: () => number;
  /** Injectable scheduler for the auth:expired watchdog (deterministic tests). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** GA-06: injectable interval scheduler for the retention sweep — tests drive
   *  the tick instead of waiting 24 real hours. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** MAIL-1: the password-reset mail channel. Absent → resolved from the
   *  FLOWMIC_MAIL_* env, which is what production does. Optional HERE and
   *  required DOWNSTREAM, which is the right way round: an absent override still
   *  yields a real (or loudly failing) mailer, never nothing. */
  mail?: PasswordResetMailer;
  /** VERIFY-1: the email-verification code channel — same contract as `mail`
   *  one field up (optional here, required downstream; absent → resolved from
   *  the same FLOWMIC_MAIL_* env, or the loudly-failing channel). Tests inject
   *  a fake provider through this seam exactly the way mail-password-reset's
   *  do through `mail`. */
  verificationMail?: EmailVerificationMailer;
  /** NR-1: the Google ID-token verifier. Absent → resolved from
   *  FLOWMIC_GOOGLE_CLIENT_ID, which is what production does; unset there yields
   *  the LOUD unconfigured verifier, never a permissive one.
   *
   *  🔴 TESTS SHOULD USUALLY NOT USE THIS SEAM. Injecting a whole verifier
   *  replaces every check the real one performs (algorithm, issuer, audience,
   *  expiry) with an assumption — the 0.2.48 L9 shape, where fifteen green
   *  adapter tests all drove a fake that answered the way we assumed.
   *  test/google-login.test.ts instead builds the REAL verifier over a fake KEY
   *  FETCH and mints tokens with a locally generated RSA key, so the four checks
   *  are the thing under test. This field exists for the cases where the
   *  verifier itself is not what is being examined. */
  googleVerifier?: GoogleIdTokenVerifier;
  /** 0.3.25 B2: the subscription-confirmation channel — same contract as its two
   *  siblings above (optional here, required downstream). */
  subscriptionMail?: SubscriptionMailer;
  /** gs-3: the setup service's channel — same contract as the three above
   *  (optional here, required downstream; absent → resolved from the env). */
  serviceMail?: ServiceMailer;
  /** 0.3.25 B2: the outbound Paddle writer. Absent → built from config, which is
   *  what production does, and which is OFF unless FLOWMIC_PADDLE_WRITE_ENABLED
   *  says otherwise.
   *
   *  🔴 THIS IS THE SEAM EVERY TEST OF THE CANCEL PATH USES, and it has to exist:
   *  the alternative is a suite that either talks to Paddle for real or proves
   *  nothing. A fake here is a fake of a BOUNDARY WE DO NOT OWN, so the tests
   *  that drive it are only as true as our reading of Paddle docs — which is why
   *  the sandbox run is a separate, named piece of evidence and not something
   *  these tests can stand in for. (0.2.48 L9: fifteen green adapter tests all
   *  driving a FakeWs that answered the way we assumed.) */
  paddleClient?: PaddleClient;
}

/** Exported for the cross-node handshake tests ONLY, so they drive the
 *  production definition of 「what this node's database says a token means」
 *  instead of a lookalike written in a test file. There is no second production
 *  caller — grep says so, and if one ever appears it belongs beside this one. */
export function tokenLookupOver(db: DbConnection): TokenLookup {
  return {
    findPcByToken(t) {
      const r = db.pcs.findByToken(t);
      return r ? { id: r.id, user_id: r.user_id } : null;
    },
    findMobileByToken(t) {
      const r = db.mobiles.findByToken(t);
      return r ? { id: r.id, user_id: r.user_id ?? STANDALONE_USER_ID, pc_device_id: r.pc_device_id } : null;
    },
  };
}

export async function startServer(config: ServerConfig, overrides: BootstrapOverrides = {}): Promise<BootstrapHandle> {
  const encryptionKey = deriveKey(config.secret);
  const db = createDbConnection({ dbPath: config.dbPath, encryptionKey });

  // 🔴 D2 Stage 0 (2026-08-05, design doc §3.4/§1.3) — decrypt ONE real stored
  // enc: envelope with the key this boot is about to use for every settings
  // read. Guards against config.ts's saas boot guard (FLOWMIC_JWT_SECRET OR
  // FLOWMIC_SETTINGS_SECRET, either sufficient) disagreeing with identity.ts's
  // value precedence (FLOWMIC_SETTINGS_SECRET first) — restoring only one env
  // var today passes the boot guard and silently decrypts with the wrong key.
  //
  // Refuse-to-boot vs warn-only is design doc §7-3, an OPEN owner decision (the
  // doc's author recommends refusing). The lead's ruling for this round: warn only.
  // Converting it later is one line: `throw` after the log.error below.
  const secretCheck = checkSettingsSecretAtBoot(db.raw, encryptionKey);
  if (secretCheck.ok) {
    log.info('startup secret check: ok', { totalApiKeyFields: secretCheck.totalApiKeyFields, byPrefix: secretCheck.byPrefix, unparseableRows: secretCheck.unparseableRows, detail: secretCheck.detail });
  } else {
    log.error('startup secret check: FAILED — a stored settings field could not be decrypted with the active key', {
      totalApiKeyFields: secretCheck.totalApiKeyFields,
      byPrefix: secretCheck.byPrefix,
      unparseableRows: secretCheck.unparseableRows,
      reason: secretCheck.reason,
      detail: secretCheck.detail,
    });
  }

  // Standalone FK seed: the 'default' user must exist before any device row.
  if (!db.users.findById(STANDALONE_USER_ID)) {
    db.users.insert({ id: STANDALONE_USER_ID, display_name: 'Local User', plan: 'free' });
  }
  const seeded = seedDefaultSettings(db.settings, STANDALONE_USER_ID);
  if (seeded.length > 0) log.info('seeded default settings', { keys: seeded });
  // owner 2026-07-27: and for every REGISTERED account too. Seeding the
  // standalone user alone left every saas account with no STT engine at all —
  // flowmic.app's owner account had one settings row (stt.polish) and
  // therefore no way to transcribe. Idempotent; a user's own edits are never
  // overwritten. See seedDefaultSettingsForAllUsers for the public-facing-build caveat.
  for (const { userId, keys } of seedDefaultSettingsForAllUsers(db.settings, db.users)) {
    if (userId !== STANDALONE_USER_ID) log.info('seeded default settings', { userId, keys });
  }

  const registry = new Registry({
    pcs: db.pcs,
    mobiles: db.mobiles,
    // GA-16: PLAN_LIMITS.pcs/.mobiles enforcement. `mode` is the standalone NOOP
    // gate; `limitsOf` is billing.effectiveLimits — the SAME single solver the
    // QuotaGuard uses, so subscription expiry, FLOWMIC_MOCK_UNLOCK_ALL and the
    // `permanent_free` exemption are already resolved and are never re-decided in
    // the registry. `billing` is constructed below; this lambda only runs
    // post-boot, per device registration.
    //
    // D1 §6.1-bis — this used to be `planOf: billing.effectivePlan`, with the
    // registry doing `planLimits(planOf(u))[kind]` itself. That second derivation
    // is exactly what had to go: `permanent_free` is an EXEMPTION, not a tier, so
    // an exempt owner resolves to `plan:'free'` (he bought nothing) and re-deriving
    // limits from that tier would wall him at free's 2 PCs / 2 phones — a
    // capability wall, i.e. a red line, invisible until the third machine.
    mode: config.mode,
    limitsOf: (userId) => billing.effectiveLimits(userId),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const store = new RoomStore<Socket>();
  // 4-digit pairing-code brute-force guard (WP-R23-1) — one shared in-memory
  // limiter across every connection (per-socket backoff + per-IP window).
  const pairLimiter = new PairRateLimiter(overrides.now ? { now: overrides.now } : {});
  // GA-08: ONE reconnect-suppression window per server, shared by the PC handler
  // (which writes it on "disconnect") and the mobile handler (which reads it on
  // mobile:reconnect). Two instances would make the whole mechanism a no-op, so
  // it is constructed here and injected — never per connection.
  const releaseSuppression = new ReleaseSuppression(overrides.now ?? Date.now);

  // WP-R4-1: the saas account layer. The JWT signing/verification secret is the
  // SAME explicit deployment secret (config.secret) already used to derive the
  // enc:v1: settings key — saas requires it explicitly (config guards that). In
  // standalone these are still built (cheap, no side effects) but never wired:
  // the REST auth surface and the socket account path are both mode-gated below.
  const jwtSecret = Buffer.from(config.secret, 'utf8');
  const authService = makeAuthService({
    users: db.users,
    jwtSecret,
    // LOGIN-1 — the ONE line that carries FLOWMIC_LOGIN_RECORD_ENABLED from the
    // environment to the only writer of `users.last_login_at`. Passed
    // UNCONDITIONALLY (not spread-if-true) so the value that reaches the service
    // is always the deployment's real answer, and so deleting this line changes
    // behaviour visibly rather than leaving a switch that silently does nothing —
    // the failure `AuthServiceDeps.loginRecordEnabled` says its default cannot
    // catch on its own. Pinned by test/last-login-record.test.ts.
    loginRecordEnabled: config.loginRecordEnabled,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  // NR-2a — the five per-IP budgets of the account layer, built together and kept
  // apart; each separation's own argument lives with the counter it separates
  // (auth/register-rate-limit.ts `makeAuthRateLimiters`).
  const {
    register: registerLimiter, siteAnalytics: siteAnalyticsLimiter, password: passwordLimiter,
    accountMint: accountMintLimiter, verificationLink: verificationLinkLimiter,
  } = makeAuthRateLimiters(overrides.now);
  // GA-31 QR-code login — one-time, 60 s account grants the console draws as a QR.
  // In-memory by design (a restart invalidating every pending QR is the correct
  // disposition for a 60-second credential); see auth/qr-grant.ts.
  const qrGrants = new QrGrantStore(overrides.now);
  // The four mail channels, resolved once per process. All four blocks — and
  // the argument for why one env block yields FOUR resolutions with four
  // failure lines — live in bootstrap-mail.ts (see its header for why they
  // moved).
  const { mail, verificationMail, subscriptionMail, serviceMail } = resolveMailers(config, overrides);
  // 🔴 0.3.25 B2 — the ONE outbound Paddle writer, constructed once per process
  // beside the limiters and for the same reason they are single instances: it
  // carries the write switch and the API key, and a second one built somewhere
  // convenient is a second place both can be wrong — including one where
  // `writeEnabled` is true by accident.
  //
  // ⚠️ CONSTRUCTED IN BOTH MODES, and it is never a null. Standalone mounts no
  // route that can reach it, and a nullable here would force a `!` at the deps
  // literal — 「it cannot be null there, trust me」 is exactly the claim
  // `mail` above refuses to make. Building it costs nothing: every method
  // refuses by name while the switch is off, which is what standalone would want
  // anyway if something ever did reach it.
  // NR-1 — the Google ID-token verifier, resolved beside the three mail channels
  // and under the same two rules: saas-only resolution (standalone mounts no
  // account surface, so its arm is the loudly-refusing verifier and never null),
  // and `??` short-circuits so an injected test double never triggers an env
  // resolution or its boot log line.
  //
  // ⚠️ THE STANDALONE ARM IS THE UNCONFIGURED VERIFIER AND NOT A NULL, for the
  // reason `mail` states one screen up: a nullable would force a `!` at the deps
  // literal, and "it cannot be null there, trust me" is the kind of claim that
  // outlives its truth. Standalone never mounts the route, so it is never read.
  const googleVerifier: GoogleIdTokenVerifier =
    config.mode === 'saas'
      ? (overrides.googleVerifier ?? resolveGoogleIdTokenVerifier())
      : (overrides.googleVerifier ?? unconfiguredGoogleIdTokenVerifier());
  const paddleClient: PaddleClient = overrides.paddleClient ?? resolvePaddleClient(config, db.billing);
  // VERIFY-1 — the per-account send budget (≤3 codes / 15 min). ONE instance per
  // server, same argument as every limiter above it: a per-request instance
  // would count to one and limit nothing (the ReleaseSuppression trap).
  const verificationSendLimiter = new VerificationSendLimiter(overrides.now);
  const expiryClock: AuthExpiryClock = {
    ...(overrides.now ? { nowMs: overrides.now } : {}),
    ...(overrides.setTimeoutFn ? { setTimeoutFn: overrides.setTimeoutFn } : {}),
    ...(overrides.clearTimeoutFn ? { clearTimeoutFn: overrides.clearTimeoutFn } : {}),
  };

  const billing = new BillingService({
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    // D1 §6.1 step 2 — the Paddle subscription ledger, so `source:'paddle'` can
    // actually be reached. The SAME BillingRepo instance the webhook ingress
    // writes through (wired below): the webhook is the only writer and this is
    // the only reader, and a second instance over the same file would be two
    // objects answering "what did this user buy" with no guarantee they agree.
    billing: db.billing,
    unlockAll: config.mockUnlockAll,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  // A2-5 / REQ-12-08 — the meter now also appends to `usage_events`, AFTER the
  // month-bucket increment and only when the switch is on.
  //
  // 2026-08-29 multi-node: the node role, the metering seam that role implies,
  // and both replication timers. ONE call — see node/node-runtime.ts.
  // 2026-08-31 multi-door — read once, consulted per socket. Empty for every
  // deployment that has not published a second hostname for this process.
  const nodeHostMap = parseNodeHostMap(process.env.FLOWMIC_NODE_HOSTS);
  const nodeRuntime = wireNodeRuntime({
    db, config, log,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.setIntervalFn ? { setIntervalFn: overrides.setIntervalFn } : {}),
    ...(overrides.clearIntervalFn ? { clearIntervalFn: overrides.clearIntervalFn } : {}),
  });
  const { usageTracker, outboxDrainer, replicaPuller } = nodeRuntime;
  // First-party site analytics — announced in BOTH directions, same standing as
  // the usage-events switch log (an absence that could mean "off" or "this build
  // has no switch" is worse than a line that says DISABLED).
  log.info(
    `site analytics: FLOWMIC_SITE_ANALYTICS ${config.siteAnalyticsEnabled ? 'ENABLED' : 'DISABLED'}`,
    { env: 'FLOWMIC_SITE_ANALYTICS', enabled: config.siteAnalyticsEnabled, mode: config.mode },
  );
  // D1 §6.1-bis — the guard asks for the NUMBERS, not for a tier it would then
  // look up itself. Same reason as the registry above: an exempt account has no
  // `Plan` that expresses its exemption, so a guard re-deriving limits from
  // `effectivePlan` would enforce free's 20 minutes on the one account the flag
  // exists to leave alone.
  const quotaGuard = nodeRuntime.wrapQuota(makeQuotaGuard(
    db.usage,
    { effectiveLimits: (userId) => billing.effectiveLimits(userId) },
    { mode: config.mode, ...(overrides.now ? { now: overrides.now } : {}) },
  ));

  // NR-2a — the 3-day unverified grace, on the SAME two session-start sites the
  // quota guard sits on. Reader + guard + boot line are ONE call (see there).
  const verificationGraceGuard = wireVerificationGrace({
    users: db.users, mode: config.mode, ...(overrides.now ? { now: overrides.now } : {}),
  });

  // The interval-owning background sweeps — retention, and the deadline refund
  // sweep. Both live in bootstrap-sweeps.ts (see its header for why they moved
  // and why the status probes did not), and both are STOPPED by the sequence
  // below.
  // F6 (2026-09-02 audit) — constructed HERE, once, rather than inline inside
  // composeHttpDeps's writer-only branch, so this sweep and POST
  // /api/node/forward's receiver share the SAME instance instead of each
  // holding a private one. Writer-only: a replica never mounts the receive
  // side this ledger backs, and node_forward_seen is node plumbing that a
  // single-node deployment never creates at all.
  const forwardLedger = nodeRuntime.nodeConfig.role === 'writer' ? makeForwardLedger(db.raw) : undefined;
  const sweeps = startSweepsForBootstrap({ config, db, billing, overrides, forwardLedger });
  const retention = sweeps.retention;

  // W-5a (REQ-13-03) — the status probe timer. ONE per server, held here for the
  // same reason `retention` is: it owns an interval, so a fresh instance per
  // request would be a timer that never accumulates a result (the
  // ReleaseSuppression trap), and it has to be STOPPED on the way down.
  //
  // 🔴 THIS IS `probeManagedLlmLiveness`'s FIRST PRODUCTION CALLER. That function
  // has carried a header since 2026-08-06 saying its production consumer was a
  // deferred ops-console item and that only a drill called it (FB-11). This line
  // is the consumer. Deleting it does not merely remove a status row — it returns
  // that module to being a capability nobody invokes.
  //
  // ⚠️ Started AFTER listen() below, not here: the first tick dials our STT and
  // LLM providers, and a relay that spends its boot waiting on someone else's TLS
  // handshake before it can accept a request has made a health check into a
  // startup dependency.
  const statusProbes = makeStatusProbes({
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  // GRANT-1 — ONE pending-grant store + ONE per-account request limiter per
  // server (per-connection instances would pend/limit nothing — the
  // ReleaseSuppression trap; in-memory by design: grant.handler.ts head).
  const grantPending = new GrantPendingStore(overrides.now);
  const grantLimiter = new GrantRequestRateLimiter(overrides.now);

  // 2026-07-30 (RCA-v3): the request_id → waiter bridge between the http image
  // upload and the PC's inject:result. ONE instance per server, shared by the
  // route (waits) and the relay handler (resolves) — two instances would make
  // the wait a guaranteed timeout, the same trap as ReleaseSuppression above.
  const injectPending = new InjectPendingRegistry();

  // RV-87 (owner 2026-08-01): the cloud relay's image policy — 1 MiB per picture
  // and 200 pictures / 24 h per ACCOUNT, enforced by the SERVER so that "uniformly
  // blocking at the server, not the client" covers any client, including ones that
  // do not exist yet. ONE instance
  // per server for the same reason as the two objects above: a per-connection
  // limiter would count to one and limit nothing. Constructed in BOTH modes and
  // mode-gated INSIDE (it NOOPs in standalone) — a `mode === 'saas' ? … : null`
  // here would put the same branch in two places, and the one that drifts is
  // always the copy.
  const cloudImages = makeCloudImagePolicy({
    mode: config.mode,
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  // WP-W1b: the console REST settings write reuses the socket path's exact
  // broadcastUpdated fan-out. `io` is created AFTER the http handler, so the
  // hook late-binds through this ref (null until createSocketServer below —
  // unreachable in practice: no request lands before listen()).
  let ioRef: IoServer | null = null;
  // D2LAN-B2b: declared HERE rather than beside the TLS front below for the same
  // late-binding reason as `ioRef` — the http handler is built before the front
  // exists, so `/api/network` reads this through a thunk. Assigned in exactly one
  // place (the TLS block below), and only after the front is actually serving.
  let lanTlsFingerprint: string | null = null;
  // ── The HttpDeps composition — moved VERBATIM to bootstrap-http-deps.ts ────
  // (card VERIFY-1 pre-step: this function stood at 797 of its 800-line cap;
  // same split-for-size remedy as http/password-reset-routes.ts. That file's
  // header names the seam adaptations; every instance below is the SAME one the
  // socket handlers use, which is the property the move must not break.)
  const httpHandler = makeHttpHandler(composeHttpDeps({
    config,
    billing,
    version: SERVER_VERSION,
    standaloneUserId: STANDALONE_USER_ID,
    db,
    nodeRuntime, quota: quotaGuard,
    ...(forwardLedger ? { forwardLedger } : {}),
    authService,
    registerLimiter,
    siteAnalyticsLimiter,
    passwordLimiter,
    qrGrants,
    registry,
    store,
    injectPending,
    releaseSuppression,
    mail,
    verificationMail,
    subscriptionMail,
    serviceMail,
    paddleClient,
    verificationSendLimiter, verificationLinkLimiter, accountMintLimiter,
    googleVerifier,
    // D2LAN-B2b — the same late-binding thunk as before the split: the http
    // handler is built before the TLS front exists, so the route reads the
    // local below through this closure per request (HttpDeps.lanTlsFingerprint
    // carries the whole ordering argument).
    lanTlsFingerprint: () => lanTlsFingerprint,
    // WP-W1b — the same ioRef late-binding as before the split: io is created
    // AFTER the http handler, so the fan-out reaches it through this closure
    // (null until createSocketServer below — unreachable in practice: no
    // request lands before listen()).
    broadcastSettingsUpdated: (userId, payload): void => {
      if (ioRef) broadcastUpdated(ioRef, '', userId, payload);
    },
    // W-5a — a thunk, not a value: the handler is built once and the answer
    // changes every tick. Staleness is applied inside `snapshot`, so the route
    // cannot accidentally publish a cached green by holding this too long.
    statusSnapshot: () => statusProbes.snapshot(),
    ...(overrides.now ? { now: overrides.now } : {}),
  }));

  const httpServer = createServer((req, res) => {
    if (!httpHandler(req, res)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });

  // saas: verify the optional handshake JWT (auth:{jwt}) with the same secret the
  // REST routes sign with. Absent in standalone → the account path is inert.
  const jwtHandshake: JwtHandshakeConfig | undefined =
    config.mode === 'saas' ? { secret: jwtSecret, ...(overrides.now ? { nowMs: overrides.now } : {}) } : undefined;
  const { io, close: closeSocket } = createSocketServer({
    httpServer,
    // 2026-08-31 (P0-①) — the third argument is present ONLY on a multi-node
    // replica (`nodeRuntime.resolveTokenOnWriter` is null everywhere else), so a
    // single-node deployment gets the two-argument middleware that shipped
    // before this existed. See node/token-read-through.ts for the thirty-second
    // window it closes and why absence-of-dependency is the guarantee.
    // OPS-1 (2026-09-02) — the fourth argument is purely for the refusal-log
    // lines (auth/refusal-log.ts): it names WHICH node answered a refused
    // handshake, same convention as node-runtime.ts's own `nodeId ?? 'unknown'`.
    // It never gates anything; a single-node deployment passes 'unknown', same
    // as every other log line that already carries this field.
    authMiddleware: authMiddleware(
      tokenLookupOver(db),
      jwtHandshake,
      nodeRuntime.resolveTokenOnWriter ?? undefined,
      nodeRuntime.nodeConfig.nodeId ?? 'unknown',
    ),
    // GA-15: the saas allow-list is env-driven (FLOWMIC_CORS_ORIGIN, comma
    // separated) with the current production value as the default, so putting
    // flowmic.app in front of .online is a deploy-time change rather than a
    // code change. standalone stays '*' — it is a LAN server for one owner.
    cors: { origin: config.mode === 'saas' ? config.corsOrigins : '*' },
  });
  ioRef = io; // WP-W1b: arm the console REST settings fan-out hook

  // Truthful acting-user resolution (04 §3.1 / F-2094): standalone collapses to
  // 'default'; saas derives from the verified handshake JWT / in-session login,
  // and fails loud (never a silent 'default') when the saas socket is
  // unauthenticated — AUTH_TOKEN_EXPIRED vs AUTH_TOKEN_INVALID per the contract.
  const resolveActingUser = (socket: Socket): ActingIdentity => {
    if (config.mode !== 'saas') return { userId: STANDALONE_USER_ID };
    const acct = getAccount(socket);
    if (acct) return { userId: acct.userId };
    return { error: getAccountAuthError(socket) === 'AUTH_TOKEN_EXPIRED' ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_INVALID' };
  };

  // WP-R1-3: the STT engine layer. Asserts FLOWMIC_STT_* tuning env at build
  // (fail-loud), then produces a fresh SttSessionBridge per audio:start whose
  // stt:* events fan out to the mobile + the paired PC.
  const sttSessionFactory = makeSttSessionFactory({
    settings: db.settings,
    mode: config.mode,
    store,
    quota: quotaGuard,
  });

  // GA-04: audio sessions belong to the (room, pairing), not to the socket. One
  // registry per server holds them across a mobile socket drop for the protocol
  // grace window, and owns the deferred pc:mobile-left below. Timers come from
  // the same injectable scheduler the auth watchdog uses (tests never sleep).
  const audioRegistry = new AudioSessionRegistry({
    ...(overrides.setTimeoutFn ? { setTimeoutFn: overrides.setTimeoutFn } : {}),
    ...(overrides.clearTimeoutFn ? { clearTimeoutFn: overrides.clearTimeoutFn } : {}),
  });

  // WP-R1-4: the compose/scenario pipeline (controller-wired seam).
  // M6: `usage` is the SAME tracker the handlers meter through — the scenario-
  // inference LLM call records into the single llm bucket (owner ruling ⑨).
  const composeFactory = createComposeFactory({ settings: db.settings, usage: usageTracker });

  io.on('connection', (socket: Socket) => {
    // D4 layer 2 — MUST stay the FIRST line of this callback: it patches
    // socket.on, so only handlers registered AFTER it are contained. Every
    // register* call below (and room/liveness.ts's probe listeners, which
    // attach to these same store-held sockets later) goes through the patched
    // seam. socket.io dispatches handlers in a bare process.nextTick with no
    // try/catch (see error-handling.ts header), so without this one throwing
    // handler — e.g. a disk-full SQLite write — is a whole-process crash.
    wrapSocketHandlers(socket);
    // GRANT-1 §3.3 — default-deny for kind:'web' sockets. A different seam
    // from wrapSocketHandlers (socket.use vs a patched socket.on) so handlers
    // below stay wrapped; installed before them so none can hear a refused
    // frame. Self-gating: pc/mobile frames pass through untouched.
    installWebAllowlist(socket);
    registerAuthHandlers(socket, {
      mode: config.mode,
      clock: expiryClock,
      // saas: share the REST per-IP login throttle so the socket credential
      // channel cannot bypass it (human-audit finding, WP-R4-1).
      ...(config.mode === 'saas'
        ? { auth: authService, loginLimiter: registerLimiter, qrGrants }
        : {}),
    });
    // saas: arm the auth:expired watchdog for a socket whose identity rests on a
    // verified handshake JWT (F-2093). Sockets that authenticate by pairing token
    // (mobile:pair / reconnect) or standalone sockets never set `account` and are
    // exempt. An in-session mobile:login arms its own watchdog in the handler.
    if (config.mode === 'saas') {
      const acct = getAccount(socket);
      if (acct) armAuthExpiry(socket, acct.exp, expiryClock);
    }
    // GA-07: the application-layer liveness consumer — `heartbeat` moves
    // last_seen_at so "recent activity" stops being frozen at pairing time.
    registerHeartbeatHandler(socket, { pcs: db.pcs, mobiles: db.mobiles, ...(nodeRuntime.stampPresence ? { stampPresence: nodeRuntime.stampPresence } : {}) });
    // 2026-08-31 multi-door — which node this process answers AS for THIS socket.
    // A process reached under a regional front door (`srvasia02`) must say so on
    // the ack and must stamp THAT into pc_devices.home_node, or the phone that
    // follows its PC would be sent to the slow door the PC deliberately left.
    // Falls back to the process's own id whenever the host is unmapped, which is
    // every deployment that has not configured a second name.
    const socketNodeId = nodeRuntime.nodeConfig.nodeId === null
      ? null
      : nodeIdForHost(
        requestHost(socket.handshake.headers as unknown as Record<string, unknown>),
        nodeHostMap,
        nodeRuntime.nodeConfig.nodeId,
      );
    const stampHomeNodeHere = nodeRuntime.stampHomeNode === null
      ? null
      : (pcId: string): void => nodeRuntime.stampHomeNode?.(pcId, socketNodeId ?? undefined);
    registerPcHandlers(socket, { io, registry, store, resolveActingUser, suppression: releaseSuppression, writerOnly: nodeRuntime.writerOnly, ...(nodeRuntime.mintCodeOnWriter ? { mintCodeOnWriter: nodeRuntime.mintCodeOnWriter } : {}), ...(stampHomeNodeHere ? { stampHomeNode: stampHomeNodeHere } : {}), ...(nodeRuntime.resolveTokenOnWriter /* B1: same instance authMiddleware/mobile:reconnect got above */ ? { resolveTokenOnWriter: nodeRuntime.resolveTokenOnWriter } : {}), ...(nodeRuntime.forwardReleaseMobileOnWriter /* B5, WP-6: the generic handoff's release_mobile verb */ ? { forwardReleaseMobile: nodeRuntime.forwardReleaseMobileOnWriter } : {}), ...(socketNodeId /* OPS-1: refusal-log lines only, see pc.handler.ts's own doc */ ? { nodeId: socketNodeId } : {}) });
    // A2-3 F1 — "usage restricted" reaches the PHONE here. `restriction: authService` is
    // the SAME instance `console-routes.refuseRestricted` reads through and the
    // same one Bearers are verified with, so the HTTP gate and the two socket
    // admissions cannot disagree; one real `users` read per pair/reconnect is
    // what makes a lifted restriction take effect on the very next attempt
    // instead of at some token's exp (auth/account-restriction.ts explains why
    // the JWT could not carry this). Passed in BOTH modes — standalone's single
    // 'default' row is never restricted, so the gate is inert by fact rather
    // than by being unwired.
    // 2026-09-01 — `rowsFromReplicationPull` travels with `nodeId` because the two
    // are one question: which node is answering, and did its copy of the row come
    // from a pull. `pcPresence` needs both to answer `pc_online` for a PC on a
    // different node from the phone asking (room/pc-presence.ts). Z4's
    // `resolveTokenOnWriter` is the SAME instance `authMiddleware` got above (one
    // budget, one single-flight table) and is null on the writer and on every
    // single-node deployment, so that spread is empty there.
    registerMobileHandlers(socket, { io, registry, store, pairLimiter, mode: config.mode, resolveActingUser, suppression: releaseSuppression, writerOnly: nodeRuntime.writerOnly, restriction: authService, rowsFromReplicationPull: nodeRuntime.nodeConfig.role === 'replica', ...(nodeRuntime.resolveTokenOnWriter ? { resolveTokenOnWriter: nodeRuntime.resolveTokenOnWriter } : {}), ...(socketNodeId ? { nodeId: socketNodeId } : {}), ...(nodeRuntime.forwardUnpairMobileOnWriter /* B4, WP-6: the generic handoff's unpair_mobile verb */ ? { forwardUnpairMobile: nodeRuntime.forwardUnpairMobileOnWriter } : {}) });
    registerSettingsHandlers(socket, { io, repo: db.settings, registry, store, writerOnly: nodeRuntime.writerOnly, ...(nodeRuntime.forwardSettingsUpdateOnWriter /* B6, WP-6: the generic handoff's settings_update verb */ ? { forwardSettingsUpdate: nodeRuntime.forwardSettingsUpdateOnWriter } : {}) });
    // (0.2.27) still registered, and now ONLY to refuse out loud: the five
    // history:* names answer HISTORY_SYNC_RETIRED. An unregistered event name is
    // silently discarded by socket.io, and a 0.2.26 client is still in the field —
    // see history.handler's header for the full reason it is kept.
    registerHistoryHandlers(socket);
    // VERIFY-1 D3 — `verifiedEmail` on both timeline-family handlers is the
    // SAME repo instance the confirm route writes through, so the socket gates
    // and the HTTP gates cannot disagree about whose gate is open.
    registerTimelineHandlers(socket, { repo: db.timeline, grants: db.timelineGrants, verifiedEmail: db.emailVerification, ...(overrides.now ? { now: overrides.now } : {}) });
    // GRANT-1 — web requests / phone grants / blind wrap forward.
    registerGrantHandlers(socket, { io, grants: db.timelineGrants, pending: grantPending, limiter: grantLimiter, verifiedEmail: db.emailVerification, ...(overrides.now ? { now: overrides.now } : {}) });
    registerAudioHandlers(socket, {
      io, guard: quotaGuard, usageTracker, store,
      sessions: audioRegistry,
      sttFactory: (args) => sttSessionFactory(socket, args),
      // card QTA-2 — the PC owner's account, so the quota gate can ask BOTH
      // sides when the phone and the desktop are signed into different ones.
      pcOwnerUserId: (pcId) => registry.findPc(pcId)?.user_id ?? null,
      verificationGrace: verificationGraceGuard, // NR-2a — the SAME guard on both legs
    });
    registerComposeHandlers(socket, { io, guard: quotaGuard, usageTracker, store, composeFactory, verificationGrace: verificationGraceGuard });
    registerRelayHandlers(socket, {
      store, pending: injectPending, cloudImages,
      // B3, WP-6: same `socketNodeId`/`registry` the mobile handler above uses
      // for `nodeId`/home_node — one instance, one answer, never a second
      // reading of "which node is this" or "where does the PC live".
      ...(socketNodeId ? { nodeId: socketNodeId } : {}),
      pcHomeNode: (pcId: string): string | null => registry.findPc(pcId)?.home_node ?? null,
    });
    // 2026-09-02 — moved verbatim to socket/handlers/disconnect.handler.ts
    // (800-line cap). Same behaviour, same comments, one call site.
    socket.on('disconnect', makeDisconnectHandler(socket, {
      store, pcs: db.pcs, audioRegistry, stampPresence: nodeRuntime.stampPresence,
    }));
  });

  // D2-LAN (design 2026-08-08 §4-2) — the LAN leg's TLS front.
  //
  // 🔴 The failure disposition is the important part. Minting/persisting can fail
  // for reasons that have nothing to do with us (read-only home, full disk), and
  // refusing to boot would take a WORKING product down over an OPTIONAL
  // hardening. So it degrades to plain — but not silently, and the honesty lives
  // in a second place too: the fingerprint stays null, so the pairing QR cannot
  // publish an `fp=` claiming an encryption that is not being served. "Never claim
  // something was done when it wasn't" is satisfied by suppressing the CLAIM, not
  // just by logging.
  let lanTls: DualProtocolFront | null = null;
  if (config.lanTls) {
    try {
      const identity = loadOrMintLanTlsIdentity(config.lanTls.dir);
      lanTls = createDualProtocolFront({ httpServer, certPem: identity.certPem, keyPem: identity.keyPem });
      lanTlsFingerprint = identity.fingerprint;
      // The fingerprint is public by design (it rides the QR); the key never
      // appears here or anywhere else. `origin` distinguishes "generated for the
      // first time" from "read back the one from last time" — a changed
      // fingerprint is the one event that invalidates every phone's pin, so it
      // must be visible in the log.
      log.info('lan tls: serving TLS and plain on one port', {
        origin: identity.origin,
        fingerprint: identity.fingerprint,
        dir: config.lanTls.dir,
      });
    } catch (err) {
      log.error('lan tls: could not mint or load an identity — the LAN leg stays PLAIN', {
        dir: config.lanTls.dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ONE listen path, one bound-port answer. When the TLS front exists it — not
  // the http server — holds the port, and http.Server extends net.Server so both
  // satisfy the same two calls. A second `listen` branch would be a second place
  // for the bind-fail-loud contract (13 §4) to be got right.
  const listener: TcpServer = lanTls ? lanTls.server : httpServer;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(new Error(`bootstrap: bind ${config.port} failed: ${err.message}`));
    listener.once('error', onError);
    const listenArgs: [number, string?] = config.host !== undefined ? [config.port, config.host] : [config.port];
    listener.listen(...listenArgs, () => {
      listener.removeListener('error', onError);
      resolve();
    });
  });
  const addr = listener.address();
  const boundPort = addr && typeof addr === 'object' ? addr.port : config.port;
  log.info('server listening', { mode: config.mode, port: boundPort, mockBilling: config.mockBilling, unlockAll: config.mockUnlockAll });

  // W-5a — armed only now that the port is bound (see the construction note):
  // the first tick dials external providers, and that must never sit between the
  // process starting and the process being able to answer.
  statusProbes.start();

  // WP2-6b — in-process reader for latency.segment. Real setInterval, not the
  // bootstrap setIntervalFn override: retention's bootstrap test asserts that
  // override sees exactly one timer. This does not dial out, so it is armed
  // with the port (same moment as statusProbes).
  const latencyReader = startLatencyReader();

  const stop = makeShutdownSequence({
    retention, statusProbes, latencyReader, closeSocket, audioRegistry, httpServer, db,
    growthReaper: sweeps.growthReaper,
    ...(sweeps.serviceRefunds ? { serviceRefunds: sweeps.serviceRefunds } : {}),
    ...(sweeps.forwardLedgerPrune ? { forwardLedgerPrune: sweeps.forwardLedgerPrune } : {}),
    ...(outboxDrainer ? { outboxDrainer } : {}),
    ...(replicaPuller ? { replicaPuller } : {}) });
  return {
    httpServer,
    io,
    port: boundPort,
    lanTlsFingerprint,
    db,
    billing,
    // 🔴 The front is closed BEFORE the ordered sequence rather than inside it:
    // it is the thing holding the port, so it has to stop ACCEPTING before the
    // sequence starts draining what was already accepted — otherwise a shutdown
    // races new arrivals it will then have to force-close. Everything else stays
    // owned by makeShutdownSequence (「ONE list, one order, one owner」, see
    // shutdown.ts); this is the only step outside it, and it is outside because
    // it must be first. ⚠️ It is therefore NOT covered by that file's per-step
    // timing log — naming it as a step there is a follow-up in shutdown.ts,
    // which this card does not own.
    close: async (): Promise<void> => {
      if (lanTls) await lanTls.close();
      await stop();
    },
  };
}
