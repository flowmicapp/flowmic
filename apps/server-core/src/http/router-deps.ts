// The construction contract of the node:http router (`http/router.ts`): every
// dependency `makeHttpHandler` may be given, together with WHY each one exists
// and what its ABSENCE means — which is the bulk of this file. Types only;
// there is no runtime behaviour here.
//
// ⚠️ THE SPLIT FROM `router.ts` WAS FORCED BY THE 800-LINE CAP
// (verify/lint/file-size.mjs), and it is the same remedy `engine/
// stt-session-deps.ts` applied to `engine/stt-session.ts`. The block moved
// VERBATIM, every doc comment with the field it documents, and `router.ts`
// re-exports `HttpDeps` so no importer changed (`bootstrap-http-deps.ts` still
// imports it from `./http/router`). Read it as a file-size split, not as a
// claim that the router's contract became a separate layer.
//
// 🔴 ONE PROPERTY OF THIS FILE IS LOAD-BEARING AND EASY TO ERODE: every optional
// field below documents what happens when it is ABSENT, and in almost every case
// the answer is "that path 404s" rather than "that path runs unguarded". A new
// dep added without that sentence is a mount whose failure direction nobody
// chose.

import type { IncomingMessage } from 'node:http';
import type { ServerConfig } from '../config';
import type { BillingService } from '../billing/billing-service';
import type { AuthRoutesDeps } from './auth-routes';
import type { ConsoleRoutesDeps } from './console-routes';
import type { OpsRoutesDeps } from './ops-routes';
import type { AccountRestrictionRoutesDeps } from './account-restriction-routes';
import type { UsageEventsRoutesDeps } from './usage-events-routes';
import type { OpsUserRoutesDeps } from './ops-user-routes';
import type { OpsUsageEventsRoutesDeps } from './ops-usage-events-routes';
import type { ProbeRoutesDeps } from './probe-routes';
import type { PresenceRoutesDeps } from './presence-routes';
import type { DiagRoutesDeps } from './diag-routes';
import type { PairingRegistry } from './pairing-auth';
import type { InjectRoutesDeps } from './inject-routes';
import type { TimelineKeymetaRoutesDeps } from './timeline-keymeta-routes';
import type { TimelineGrantsRoutesDeps } from './timeline-grants-routes';
import type { EmailVerificationRoutesDeps } from './email-verification-routes';
import type { PaddleRoutesDeps } from './paddle-routes';
import type { UpdateRoutesDeps } from './update-routes';
import type { StatusRoutesDeps } from './status-routes';
import type { SiteCollectRoutesDeps } from './site-collect-routes';
import type { OpsSiteRoutesDeps } from './ops-site-routes';
import type { UserIdVerdict } from './account-auth';

export interface HttpDeps {
  config: ServerConfig;
  billing: BillingService;
  version: string;
  /** Who is this request? A VERDICT, not a string: the saas branch can fail, and
   *  a `string` return has no way to say so except by inventing a user (which is
   *  what it used to do — see http/account-auth.ts). Built by makeResolveUserId. */
  resolveUserId(req: IncomingMessage): UserIdVerdict;
  /** saas-only account REST (register/login/me). Absent in standalone → those
   *  paths are unhandled (404), i.e. the REST surface is mounted saas-only. */
  auth?: AuthRoutesDeps;
  /** saas-only console REST (logout / password reset / cloud summary+subscription
   *  / device+pairing mgmt — R5-WEB WP-W1). Absent in standalone → 404, same
   *  saas-only mounting as `auth`. */
  console?: ConsoleRoutesDeps;
  /** A2-5 / REQ-12-08 — saas-only `GET /api/cloud/usage/events`, the account's
   *  OWN per-event usage log. A separate dep from `console` ONLY because the
   *  route lives in its own file (console-routes.ts is at its line cap); the
   *  trust model is `console`'s and emphatically not `ops`'s — see
   *  usage-events-routes.ts's header. Absent → 404, mounted saas-only. */
  usageEvents?: UsageEventsRoutesDeps;
  /** 0.2.48 — saas-only CROSS-ACCOUNT ops REST (`/api/ops/*`, O-2 platform usage aggregation).
   *  Absent → 404, the same saas-only mounting as `auth` and `console`.
   *
   *  A SEPARATE dep from `console` even though both are "REST behind a Bearer":
   *  that surface answers "my own stuff" and feeds every repo the id the Bearer
   *  proved; this one reads ACROSS accounts and every route in it is admin-gated.
   *  Two trust models, two deps — see ops-routes.ts's header. */
  ops?: OpsRoutesDeps;
  /** A2-3 — saas-only `POST /api/ops/users/restrict`, the "restrict usage" write.
   *
   *  A SEPARATE dep from `ops` above even though the path shares that prefix,
   *  and the separation is structural rather than tidy: `OpsRoutesDeps` is a
   *  READ surface that deliberately has no path to a `UserRecord` at all (that
   *  is how M2-7 is defused there), so the account-writing slice must not be
   *  reachable from it. Absent → the path falls to the router's 404, the same
   *  saas-only mounting as `console` and `ops`. */
  restriction?: AccountRestrictionRoutesDeps;
  /** A2-4 — saas-only `GET /api/ops/users` + `GET /api/ops/users/detail`, the
   *  read-only account list.
   *
   *  A THIRD dep under the same prefix, and the split is the same structural one
   *  `restriction` above explains: `OpsRoutesDeps` is a read surface that
   *  deliberately has NO path to a `UserRecord` (that is how M2-7 is defused
   *  there), and folding an account read into it would delete that property for
   *  every route in that file. This dep holds a two-method READ slice of
   *  `UserRepo` — no writer of any kind is reachable from it. Absent → the paths
   *  fall to the router's 404, the same saas-only mounting as `ops`. */
  opsUsers?: OpsUserRoutesDeps;
  /** A2-5 / REQ-12-08 — saas-only `GET /api/ops/usage/events?user_id=`, the
   *  operator's view of ONE account's per-event usage log.
   *
   *  A FOURTH dep under the `/api/ops/` prefix, and the split is the same
   *  structural one `restriction` and `opsUsers` explain: `OpsRoutesDeps` is the
   *  cross-account AGGREGATE surface and has no path to a per-account event
   *  reader, while this one holds a ONE-METHOD slice of `UsageEventsRepo`
   *  (`listForUser`) and cannot reach `append` or `purgeOlderThan`.
   *
   *  🔴 It is a SEPARATE dep from `usageEvents` above even though both read the
   *  same table, because they have opposite trust models: that one is scoped to
   *  the Bearer and has no target parameter at all; this one names somebody else
   *  and is admin-gated. Folding them would put a `?user_id=` within one
   *  refactor of the account surface. Absent → the path falls to the router's
   *  404, the same saas-only mounting as `ops` and `opsUsers`. */
  opsUsageEvents?: OpsUsageEventsRoutesDeps;
  /** GA-12 STT/LLM "test connection" probes. Test seams only — production passes {} and
   *  the module's own defaults dial the real engines. */
  probe?: ProbeRoutesDeps;
  /** POST /api/diag/mobile — the phone's own diagnostic trail, appended next to
   *  the desktop's forensic log. D6 (2026-08-04): mounted in BOTH modes — the
   *  cloud leg is the ONLY path a public user has, and it used to 404 there
   *  (see the mount site below for the saas auth posture). Absent → the route
   *  answers DIAG_NO_SINK rather than pretending it stored one. */
  diag?: DiagRoutesDeps;
  /** D6 (2026-08-04) — the pairing registry `/api/diag/mobile` judges its Bearer
   *  against, wired by bootstrap in BOTH modes.
   *
   *  A DEP OF ITS OWN, deliberately, and this is the second attempt: the first
   *  one read the registry out of whichever OTHER route's deps happened to carry
   *  one (`inject` in standalone, `presence` in saas). That does not type-check
   *  and it should not: `PresenceRoutesDeps.registry` is narrowed to
   *  `findPairingByToken` ON PURPOSE — presence is a resting poll and must never
   *  stamp `last_seen_at` (presence-routes.ts §NO SIDE EFFECTS) — whereas this
   *  route resolves through `verifyPairedMobile`/`reconnectMobile`, which is the
   *  side-effecting one. Two different questions, two different slices of the
   *  same object; scavenging one for the other would have been a cast away from
   *  calling a method the donor deliberately does not expose.
   *
   *  Absent ⇒ no upload can be verified: standalone marks every block UNVERIFIED
   *  (its pre-D6 behaviour when `inject` was absent), and saas — which REQUIRES
   *  a verified uploader — refuses them all. Both are honest; neither invents a
   *  pairing. */
  pairing?: PairingRegistry;
  /** POST /api/inject/image — the phone's picture delivery over a fresh http
   *  request (RCA-v3: the room socket dies silently under the photo picker's
   *  backgrounding). STANDALONE only (see inject-routes.ts header for why the
   *  cloud relay deliberately does not mount it). */
  inject?: InjectRoutesDeps;
  /** SALT-1 — GET/PUT /api/timeline/keymeta, the account's blind-store key
   *  metadata (KDF salt + verification sentinel). SAAS ONLY — the exact
   *  reverse of `inject` above: the cloud blind store IS the saas relay's
   *  table, and standalone has no account layer to authenticate against.
   *  Absent (or mode !== saas) → the paths fall to the router's 404, the same
   *  "not mounted in this deployment" answer auth/console/ops give. */
  keymeta?: TimelineKeymetaRoutesDeps;
  /** GRANT-1 — GET/DELETE /api/timeline/grants: list + revoke the account's
   *  web-preview grants. SAAS ONLY, same double-gated mounting as `keymeta`
   *  right above and for the same reason (an account surface has no meaning in
   *  standalone). Absent (or mode !== saas) → the paths fall to the router's
   *  404. */
  timelineGrants?: TimelineGrantsRoutesDeps;
  /** VERIFY-1 — POST /api/auth/email-verification/{send,confirm}. SAAS ONLY,
   *  same double-gated mounting as `keymeta`/`timelineGrants` above and for the
   *  same reason (standalone has no account layer and no email to verify).
   *  Absent (or mode !== saas) → the paths fall to the router's 404. These two
   *  routes are themselves EXEMPT from the verified-email gate they feed —
   *  gating the door's own key would lock it forever. */
  emailVerification?: EmailVerificationRoutesDeps;
  /** RV-98 — GET /api/pc/presence: "the PC this Bearer token is paired to, is it
   *  in its room right now". Mounted in BOTH modes, unlike every other route
   *  above: saas is the mode that needs it (the relay answering /api/health says
   *  nothing about the owner's PC — that was owner's complaint), and standalone
   *  wants it too, because a sidecar orphaned by a dead desktop keeps answering
   *  health while nobody is in the room. Absent → the path 404s and the phone
   *  reads that as "unknown", which is the honest pre-0.2.36 answer. */
  presence?: PresenceRoutesDeps;
  /** D1 §5.1 — POST /api/paddle/webhook. Present ONLY when bootstrap resolved
   *  `mode === 'saas' && config.paddle.enabled`; absent → the path falls through
   *  to the router's 404, the same "not mounted in this deployment" answer
   *  auth/console/probe give. See paddle-routes.ts for why it deliberately does
   *  NOT live under the `/api/billing/` prefix and its two gates. */
  paddle?: PaddleRoutesDeps;
  /** L-④ (owner 2026-08-02 in-app update) — GET /api/updates/latest. Present ONLY when
   *  `FLOWMIC_UPDATE_MANIFEST_PATH` is configured; absent → the path falls through
   *  to the router's 404, the same "not mounted in this deployment" answer
   *  auth/console/ops give.
   *
   *  🔴 It answers "which version is the latest released artifact", which is NOT the question
   *  `/api/health`'s `version` answers ("which version is this server running"). The two drift by
   *  design — 0.2.37 shipped without a relay deploy — so the manifest is DATA on
   *  disk, never derived from SERVER_VERSION. See update-routes.ts's header. */
  updates?: UpdateRoutesDeps;
  /** W-5a (REQ-13-03) — GET /api/status, the public status page's data source.
   *  Present when bootstrap armed the probe timer; absent → the path falls
   *  through to the router's 404, the same "not mounted in this deployment"
   *  answer auth/console/ops give, and the page renders its own fetch failure.
   *
   *  🔴 It answers "whether the managed STT/LLM lines are usable right now", which is NOT the question
   *  `/api/health` answers ("is this relay alive"). A relay that answers health perfectly
   *  while its STT provider refuses every session is exactly the state this
   *  exists to make visible — the same "one value answers one question only" split as `updates`
   *  above. See status-routes.ts for why it publishes no error strings. */
  status?: StatusRoutesDeps;
  /**
   * First-party public-site analytics intake (`POST /api/site/collect` +
   * `GET /api/site/go/download`). SAAS ONLY. Absent → paths 404.
   * 🔴 PUBLIC — not admin-gated (same standing as `/api/status`).
   */
  siteCollect?: SiteCollectRoutesDeps;
  /**
   * Operator read of site aggregates (`GET /api/ops/site/{summary,breakdown}`).
   * SAAS ONLY, admin-gated. Absent → 404.
   */
  opsSite?: OpsSiteRoutesDeps;
  /** Absolute path of the server script this process is running, echoed by
   *  `/api/health` so the desktop's adopt probe can tell OUR sidecar from a stale
   *  one left by another build. Defaults to `process.argv[1]`; injectable so the
   *  health test does not depend on how the test runner was invoked. */
  scriptPath?: string;
  /** D2LAN-B2b — the SPKI fingerprint of the certificate this process is serving
   *  on the LAN, for `/api/network` to publish to the desktop shell (which puts it
   *  on the pairing QR as `fp=`). `null`/absent ⇒ the key is reported as `null`
   *  and the QR stays byte-identical to the pre-D2-LAN one.
   *
   *  🔴 A THUNK, not a value, and that is forced by an ordering fact rather than a
   *  taste: this deps object is built (bootstrap.ts, symbol `startServer`) BEFORE
   *  the TLS front is created, so at construction time the answer does not exist
   *  yet. A `string | null` field would therefore be permanently `null` — the
   *  "a placeholder got treated by a downstream consumer as the criterion" shape (M4 F2b). Reading it per request also makes
   *  the honest answer automatic: bootstrap assigns the fingerprint only AFTER
   *  `createDualProtocolFront` returns, so a mint that succeeded while the front
   *  failed publishes nothing.
   *
   *  🔴 Publishing it is not a secret disclosure — see the route body for the
   *  argument, which belongs where a reader will ask it. */
  lanTlsFingerprint?: () => string | null;
  /** D3 (2026-08-04) — the health DB probe. `/api/health` used to answer
   *  `ok:true` unconditionally: the ONE thing it proved was that node:http was
   *  still accepting sockets, and it said "healthy" anyway. A sidecar whose SQLite
   *  handle no longer answers still reported healthy to the desktop supervisor,
   *  to the phone's instance list and to the relay's readiness checks — and then
   *  served a pairing screen it could not persist a row for.
   *
   *  Must be CHEAP (it runs on every health poll, unauthenticated) and THROW on
   *  failure; a throw turns the response into `503 {ok:false, db:'error'}` while
   *  keeping every existing key (mode/port/version/script) so no reader loses a
   *  field it already parses.
   *
   *  🔴 WHAT IT PROVES, EXACTLY — and no more. The wired probe (bootstrap.ts) is
   *  a READ: `SELECT count(*) FROM sqlite_master`. It catches "the handle no
   *  longer answers a query" (closed/finalized handle, an unreadable or
   *  corrupted schema page, a DB that was never opened). It does NOT catch a
   *  full disk or a read-only volume — those are WRITE failures, and a read
   *  probe cannot see them. A write probe was considered and REJECTED: this
   *  route is unauthenticated and polled by three clients, so a write here would
   *  be an amplification lever pointed at the owner's own disk. So the field
   *  `db:'ok'` means "can be read", not "can be written to", and nothing in this file may claim
   *  the wider sentence.
   *
   *  Absent → no probe ran, and the response carries NO `db` key at all — the
   *  pre-D3 shape byte-for-byte. A missing measurement vanishes; it is never
   *  backfilled with a plausible 'ok' (V2-15). */
  dbProbe?: () => void;
}
