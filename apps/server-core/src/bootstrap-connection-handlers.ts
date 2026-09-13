// SPEC-REF:
//   src/bootstrap.ts (the ONE caller — this file is the per-socket half of its
//     wiring)
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §2 (module wiring)
//
// ── STRUCTURAL SPLIT, 800-LINE CAP (2026-09-09) ─────────────────────────────
// The `io.on('connection', ...)` callback moved VERBATIM out of `bootstrap.ts`
// `startServer` (which stood at 800 of its 800-line cap — same pressure and
// same remedy as bootstrap-http-deps.ts's and socket/handlers/disconnect.handler.ts's
// earlier splits, both named at their own call sites in bootstrap.ts). Every
// block and every comment travelled unchanged. The only difference a
// closure-to-function move forces: the callback body now reads its free
// variables off a `deps` object instead of closing over `startServer`'s
// locals — each field below is the SAME instance bootstrap constructs, for the
// same reason bootstrap-http-deps.ts's own header gives (a second instance is
// a second place the same rules can be wrong).
//
// Nothing else changed in the move: same handler registration order, same
// wrapSocketHandlers-must-be-first constraint, same disconnect wiring.

import type { Server as IoServer, Socket } from 'socket.io';
import type { ServerConfig } from './config';
import type { DbConnection } from './db/connection';
import type { AuthService } from './auth/auth-service';
import { RegisterRateLimiter } from './auth/register-rate-limit';
import type { QrGrantStore } from './auth/qr-grant';
import type { AuthExpiryClock } from './socket/handlers/auth-expiry';
import { armAuthExpiry } from './socket/handlers/auth-expiry';
import { getAccount, getSessionPrefs, type ActingIdentity } from './socket/wire';
import { principalRefOf } from './socket/handlers/audio-metering';
import type { Registry } from './room/registry';
import type { RoomStore } from './room/store';
import type { ReleaseSuppression } from './room/release-suppression';
import type { PairRateLimiter } from './room/pair-rate-limit';
import type { NodeRuntime } from './node/node-runtime';
import { nodeIdForHost, type NodeHostMap, requestHost } from './node/node-identity';
import type { QuotaGuard } from './billing/quota-guard';
import type { UsageTracker } from './billing/usage-tracker';
import type { BudgetPusher } from './billing/budget-push';
import { anonymousRowReader } from './auth/metering-principal';
import type { WebTrialIdentities } from './auth/web-trial-identity';
import type { AudioSessionRegistry } from './engine/audio-registry';
import { makeSttSessionFactory } from './engine/stt-factory';
import { createComposeFactory } from './compose';
import type { InjectPendingRegistry } from './socket/inject-pending';
import type { CloudImagePolicy } from './socket/cloud-image-policy';
import type { VerificationGraceGuard } from './auth/verification-grace';
import type { GrantPendingStore, GrantRequestRateLimiter } from './socket/handlers/grant.handler';
import { registerPcHandlers } from './socket/handlers/pc.handler';
import { registerMobileHandlers } from './socket/handlers/mobile.handler';
import { makeDisconnectHandler } from './socket/handlers/disconnect.handler';
import { registerHeartbeatHandler } from './socket/handlers/heartbeat.handler';
import { registerAuthHandlers } from './socket/handlers/auth.handler';
import { registerSettingsHandlers } from './socket/handlers/settings.handler';
import { registerHistoryHandlers } from './socket/handlers/history.handler';
import { registerTimelineHandlers } from './socket/handlers/timeline.handler';
import { registerGrantHandlers } from './socket/handlers/grant.handler';
import { installWebAllowlist } from './socket/web-allowlist';
import { registerAudioHandlers } from './socket/handlers/audio.handler';
import { registerComposeHandlers } from './socket/handlers/compose.handler';
import { registerRelayHandlers } from './socket/handlers/relay.handler';
import { wrapSocketHandlers } from './error-handling';

/** Everything the per-connection registration read out of `startServer`'s
 *  closure, named. Each field is the SAME instance bootstrap uses elsewhere —
 *  handing a fresh instance for any of them re-creates the two-answers trap
 *  the original closure avoided by construction (ReleaseSuppression's own
 *  comment is the canonical statement). */
export interface ConnectionHandlerWiring {
  io: IoServer;
  config: ServerConfig;
  expiryClock: AuthExpiryClock;
  authService: AuthService;
  registerLimiter: RegisterRateLimiter;
  qrGrants: QrGrantStore;
  db: DbConnection;
  nodeRuntime: NodeRuntime;
  nodeHostMap: NodeHostMap;
  budgetPusher: BudgetPusher;
  registry: Registry;
  store: RoomStore<Socket>;
  resolveActingUser: (socket: Socket) => ActingIdentity;
  releaseSuppression: ReleaseSuppression;
  pairLimiter: PairRateLimiter;
  quotaGuard: QuotaGuard;
  /** Card MP-1 — the per-key sub-quota guard, the SAME instance the budget
   *  pusher and the stt factory read through. */
  integratorKeys: { remainingMs(keyId: string, at: number): number };
  /** Card MP-1 — WHICH key minted a room, for the payer decision. Read off the
   *  room→key edge (`integrator_rooms`), never off a client frame. */
  integratorKeyIdForRoom: (pcDeviceId: string) => string | null;
  usageTracker: UsageTracker;
  audioRegistry: AudioSessionRegistry;
  budgetHeartbeatMs: number;
  sttSessionFactory: ReturnType<typeof makeSttSessionFactory>;
  verificationGraceGuard: VerificationGraceGuard;
  composeFactory: ReturnType<typeof createComposeFactory>;
  injectPending: InjectPendingRegistry;
  cloudImages: CloudImagePolicy;
  /** bootstrap's `overrides.now` (same value, threaded — importing
   *  BootstrapOverrides back would be a cycle). */
  now?: () => number;
  grantPending: GrantPendingStore;
  grantLimiter: GrantRequestRateLimiter;
  /** Card R-1 — mints/reuses the anonymous trial identity an unsigned WEB
   *  pairing spends. Built once in bootstrap (it holds the trial ledger and the
   *  process-wide IP salt), threaded like every other single instance here. */
  webTrial: WebTrialIdentities;
}

/** The `io.on('connection', ...)` body, VERBATIM. See file header. */
export function registerConnectionHandlers(socket: Socket, deps: ConnectionHandlerWiring): void {
  const {
    io, config, expiryClock, authService, registerLimiter, qrGrants, db, nodeRuntime, nodeHostMap,
    budgetPusher, registry, store, resolveActingUser, releaseSuppression, pairLimiter, quotaGuard, webTrial,
    integratorKeys, integratorKeyIdForRoom,
    usageTracker, audioRegistry, budgetHeartbeatMs, sttSessionFactory, verificationGraceGuard,
    composeFactory, injectPending, cloudImages, now, grantPending, grantLimiter,
  } = deps;
  const overrides = { ...(now ? { now } : {}) };

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
  registerPcHandlers(socket, { io, budget: budgetPusher, registry, store, resolveActingUser, suppression: releaseSuppression, writerOnly: nodeRuntime.writerOnly, ...(nodeRuntime.mintCodeOnWriter ? { mintCodeOnWriter: nodeRuntime.mintCodeOnWriter } : {}), ...(stampHomeNodeHere ? { stampHomeNode: stampHomeNodeHere } : {}), ...(nodeRuntime.resolveTokenOnWriter /* B1: same instance authMiddleware/mobile:reconnect got above */ ? { resolveTokenOnWriter: nodeRuntime.resolveTokenOnWriter } : {}), ...(nodeRuntime.forwardReleaseMobileOnWriter /* B5, WP-6: the generic handoff's release_mobile verb */ ? { forwardReleaseMobile: nodeRuntime.forwardReleaseMobileOnWriter } : {}), ...(socketNodeId /* OPS-1: refusal-log lines only, see pc.handler.ts's own doc */ ? { nodeId: socketNodeId } : {}) });
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
  registerMobileHandlers(socket, { io, budget: budgetPusher, registry, store, pairLimiter, mode: config.mode, resolveActingUser, suppression: releaseSuppression, writerOnly: nodeRuntime.writerOnly, restriction: authService, anonymousUser: anonymousRowReader(db.users) /* card W4-05 */, webTrial /* card R-1 */, demoPayerUserId: config.demoPayerUserId /* card MP-6 */, integratorKeyIdForRoom /* card MP-1 */, rowsFromReplicationPull: nodeRuntime.nodeConfig.role === 'replica', ...(nodeRuntime.resolveTokenOnWriter ? { resolveTokenOnWriter: nodeRuntime.resolveTokenOnWriter } : {}), ...(socketNodeId ? { nodeId: socketNodeId } : {}), ...(nodeRuntime.forwardUnpairMobileOnWriter /* B4, WP-6: the generic handoff's unpair_mobile verb */ ? { forwardUnpairMobile: nodeRuntime.forwardUnpairMobileOnWriter } : {}) });
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
    io, guard: quotaGuard, usageTracker, store, sessions: audioRegistry,
    budget: budgetPusher, budgetHeartbeatMs, // card S2-02
    sttFactory: (args) => sttSessionFactory(socket, args),
    // card QTA-2 — the PC owner's account, so the quota gate can ask BOTH
    // sides when the phone and the desktop are signed into different ones.
    // card MP-0 — ONE row read answering both of the gate's questions (the owner, and which far end this is).
    pcRoom: (pcId) => { const pc = registry.findPc(pcId); return pc ? { userId: pc.user_id, roomKind: pc.room_kind } : null; },
    anonymousUser: anonymousRowReader(db.users), // + card W4-05's two demo-identity exceptions (auth/metering-principal.ts)
    integratorKeys, // card MP-1 — the third ceiling the admission gate must clear
    verificationGrace: verificationGraceGuard, // NR-2a — the SAME guard on both legs
    recoveryOps: db.recoveryOps, // card PR-2 — the operation registry (unconditional; see its type doc)
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  // 2026-09-03 (design D2) — socket-closing, like `sttFactory` above: the
  // compose turn reads the phone-owned scenario card / consent from THIS
  // socket's bundle (settings/session-overlay.ts), never from the database.
  registerComposeHandlers(socket, {
    io, guard: quotaGuard, usageTracker, store, verificationGrace: verificationGraceGuard,
    // card MP-9 — the admission's principal rides the same seam, and for the
    // same reason: the scenario-inference call the factory schedules is metered
    // off-band, long after this socket is out of reach. `principalRefOf` is the
    // ONE reader of it, shared with both STT and the compose turn.
    composeFactory: (args) => composeFactory({
      ...args, sessionPrefs: getSessionPrefs(socket), principal: principalRefOf(socket),
    }),
  });
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
}
