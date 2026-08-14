// SPEC-REF:
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §4 (sidecar /api/health)
//   docs/strategy/2026-07-23-mock-billing-design.md §2/§4 (mock gateway = a
//     server-internal fake-payment endpoint set driving the state machine; gated by
//     FLOWMIC_MOCK_BILLING), §8.3 (UNLOCK_ALL shutdown-path acceptance)
//   CLAUDE.md: payment uses a mock (0.1.0 private internal build)
//
// The plain node:http router: health + the mock billing gateway. The gateway is
// the ONLY trigger for the BillingService state machine and exists only when
// FLOWMIC_MOCK_BILLING=1. Account identity comes from `deps.resolveUserId`
// (http/account-auth.ts): the verified Bearer subject in saas, the single local
// user in standalone — and a named 401 when it cannot be established, never a
// fallback user. advance-clock is mock/test-only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { ServerConfig } from '../config';
import type { Cycle } from '../billing/billing-service';
import { ServerError } from '../errors';
import { log } from '../log';
import { tryHandleAuthRoutes } from './auth-routes';
import { tryHandleConsoleRoutes } from './console-routes';
import { tryHandleOpsRoutes } from './ops-routes';
import { tryHandleAccountRestrictionRoutes } from './account-restriction-routes';
import { tryHandleUsageEventsRoutes } from './usage-events-routes';
import { tryHandleOpsUserRoutes } from './ops-user-routes';
import { tryHandleOpsUsageEventsRoutes } from './ops-usage-events-routes';
import { tryHandleProbeRoutes } from './probe-routes';
import { tryHandlePresenceRoutes } from './presence-routes';
import { DiagUploadThrottle, tryHandleDiagRoutes } from './diag-routes';
import { tryHandleInjectRoutes } from './inject-routes';
import { tryHandleTimelineKeymetaRoutes } from './timeline-keymeta-routes';
import { tryHandleTimelineGrantsRoutes } from './timeline-grants-routes';
import { tryHandleEmailVerificationRoutes } from './email-verification-routes';
import { makeUpdateRoutes } from './update-routes';
import { tryHandleStatusRoutes } from './status-routes';
import { tryHandlePaddleRoutes } from './paddle-routes';
import { isLocalRequest, refuseNonLocal } from './local-only';
import { refuseUnidentified } from './account-auth';
import { isWellFormedFingerprint } from '../lan-tls/fingerprint';
// 🔴 THE DEPS INTERFACE MOVED, THE IMPORT PATH DID NOT. `HttpDeps` now lives in
// `./router-deps` (the 800-line cap forced the split — that file's header says
// so) and is RE-EXPORTED from here so every existing importer keeps working:
// `bootstrap-http-deps.ts` still writes `import type { HttpDeps } from
// './http/router'`. Read this as a file-size split, not as a new layer.
import type { HttpDeps } from './router-deps';
export type { HttpDeps } from './router-deps';

/** How an IPv4 address ranks as a "phone on the same LAN can dial this" guess.
 *  GA-21: the old heuristic was a binary RFC1918 / not-RFC1918 split, which sank
 *  legal-but-non-standard office ranges (owner's `100.64.7.x`) BELOW public
 *  addresses and made them permanently non-primary. Three tiers now. */
export type LanIpKind = 'rfc1918' | 'non-standard-private' | 'other';

/** One `/api/network` candidate: the address plus the marker the desktop's
 *  endpoint picker renders ("non-standard private segment"). Ordering is a DEFAULT, never a
 *  filter — nothing is hidden, because a hidden candidate the owner needs is a
 *  silent failure (CLAUDE.md red line: no silent failure). */
export interface LanCandidate {
  address: string;
  kind: LanIpKind;
  /** `kind === 'non-standard-private'` — mirrored as a field so the desktop does
   *  not have to re-implement the classification to draw the badge. */
  nonStandardPrivate: boolean;
}

const RFC1918 = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./;
/** Ranges that are NOT RFC1918 yet are, in practice, LAN-only wiring:
 *   • 100.64.0.0/10  — RFC6598 CGNAT (also what most mesh VPNs hand out);
 *   • the rest of 172.0.0.0/8 — the "looks like RFC1918 but isn't" family that
 *     office networks routinely co-opt (owner's 100.64.7.0/24);
 *   • 198.18.0.0/15  — RFC2544 benchmarking, used by several VPN clients.
 *  A phone CAN be on one of these with the PC, so they outrank public addresses;
 *  they still sort below true RFC1918 because that remains the common case. */
const NON_STANDARD_PRIVATE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^172\.|^198\.1[89]\./;

/** Pure classifier — the single definition of the three ordering tiers. */
export function classifyLanIpv4(ip: string): LanIpKind {
  if (RFC1918.test(ip)) return 'rfc1918';
  if (NON_STANDARD_PRIVATE.test(ip)) return 'non-standard-private';
  return 'other';
}

const TIER: Record<LanIpKind, number> = { 'rfc1918': 0, 'non-standard-private': 1, 'other': 2 };

/** Pure ordering core (GA-21): classify + stable-sort by tier. Every input
 *  survives to the output — this ranks, it never drops. */
export function rankLanIpv4(addresses: readonly string[]): LanCandidate[] {
  return addresses
    .map((address) => {
      const kind = classifyLanIpv4(address);
      return { address, kind, nonStandardPrivate: kind === 'non-standard-private' };
    })
    .sort((a, b) => TIER[a.kind] - TIER[b.kind]); // Array#sort is stable → NIC order kept within a tier
}

/** Enumerate this host's non-internal IPv4 addresses as ranked candidates.
 *  Link-local 169.254.x (APIPA — no DHCP lease yet) is excluded so the desktop's
 *  LAN-IP poll keeps waiting for a real address instead of latching a dead one
 *  (07 §5 / F-2343). Pure over an injectable interface map for testability. */
export function collectLanCandidates(
  ifaces: NodeJS.Dict<Array<{ family: string | number; address: string; internal: boolean }>> = networkInterfaces(),
): LanCandidate[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      const fam = ni.family === 4 || ni.family === 'IPv4';
      if (!fam || ni.internal) continue;
      if (/^169\.254\./.test(ni.address)) continue; // APIPA link-local
      out.push(ni.address);
    }
  }
  return rankLanIpv4(out);
}

/** The address-only view of `collectLanCandidates` (the historical `lan_ipv4`
 *  shape — kept verbatim so existing readers keep working). */
export function collectLanIpv4(
  ifaces: NodeJS.Dict<Array<{ family: string | number; address: string; internal: boolean }>> = networkInterfaces(),
): string[] {
  return collectLanCandidates(ifaces).map((c) => c.address);
}

/** D2LAN-B2b — what `/api/network` may publish as `lan_tls_fp`.
 *
 *  Three outcomes, deliberately only two of them visible on the wire:
 *    • no producer / no TLS  → `null`  (the QR keeps its pre-D2-LAN bytes)
 *    • a well-formed value   → the value
 *    • a MALFORMED value     → `null`, and a log line saying so.
 *
 *  🔴 The malformed case is refused rather than forwarded because of the DIRECTION
 *  of each failure. A missing pin degrades to today's plain connection, which the
 *  phone can say out loud; a broken pin makes the phone refuse the server that IS
 *  the right one, which looks exactly like a network fault and has no diagnosis
 *  path. `buildQrPayload` makes the same call for the same reason one hop later —
 *  two gates, because either layer can be the one that corrupts it.
 *
 *  ⚠️ `isWellFormedFingerprint` is a SHAPE check and its own doc comment says it is
 *  explicitly not a trust decision. It is not used as one here: nothing about this
 *  route decides whether a peer is trusted. It answers "does this string look like a fingerprint"
 *  so that the answer to "why print it into the QR code" is not "because it's sitting in a variable". */
export function publishableLanTlsFingerprint(deps: Pick<HttpDeps, 'lanTlsFingerprint'>): string | null {
  const raw = deps.lanTlsFingerprint?.() ?? null;
  if (raw === null) return null;
  if (!isWellFormedFingerprint(raw)) {
    // Out loud, and with the length rather than the value: a malformed fingerprint
    // is usually a truncation, and "how long" is the fact that identifies it. Not a
    // throw — /api/network is also how the desktop finds its own LAN address, and
    // taking pairing down over an optional hardening is the trade bootstrap.ts
    // already refused to make when it degraded to plain.
    log.error('api/network: refusing to publish a malformed LAN TLS fingerprint', {
      length: raw.length,
    });
    return null;
  }
  return raw;
}


function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64_000) raw = raw.slice(0, 64_000);
    });
    req.on('end', () => {
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function isCycle(v: unknown): v is Cycle {
  return v === 'monthly' || v === 'yearly';
}

/** M5 — the loud name `assertMockBillingMountable` throws under, exported so the
 *  test asserting the refusal and any operator grepping a crash log find the same
 *  string. */
export const MOCK_BILLING_IN_SAAS_ERROR = 'MOCK_BILLING_FORBIDDEN_IN_SAAS';

/**
 * M5 (2026-08-04) — saas + mock billing REFUSES TO SERVE, at mount, not at
 * request time.
 *
 * Why no request-time gate can hold this door: the mock gateway grants paid
 * plans without payment (`mockConfirm`) and moves the PROCESS-WIDE billing clock
 * (`advance-clock`), and its only request-time guards are `isLocalRequest` —
 * which gate 1's own comment admits is a no-op in saas, because nginx makes
 * every public request look loopback — and a Bearer, which any self-registered
 * account has. This exact combination WAS exposed in production once
 * (2026-07-31, closed by flipping the env). An env flag someone can leave on is
 * a latch, not a wall; this makes the combination structurally unservable: the
 * process throws before it can accept a single request.
 *
 * The standalone/dev mock is deliberately untouched — deleting the mock gateway
 * outright is an OWNER-GATED action (it is the only driver of the
 * BillingService state machine in dev and the golden path's G9 quota face), not
 * something this guard may do by side effect. saas with the flag OFF keeps its
 * existing honest 404 (`mock billing gateway disabled`).
 *
 * Called from `makeHttpHandler` (bootstrap.ts:372 — the single production mount)
 * so no bootstrap change is needed for the refusal to bite at startup.
 */
export function assertMockBillingMountable(config: Pick<ServerConfig, 'mode' | 'mockBilling'>): void {
  if (config.mode === 'saas' && config.mockBilling) {
    throw new Error(
      `${MOCK_BILLING_IN_SAAS_ERROR}: refusing to serve — FLOWMIC_MODE=saas with the mock billing `
      + 'gateway enabled (FLOWMIC_MOCK_BILLING). The mock gateway grants paid plans without payment '
      + 'and moves the process-wide billing clock, and behind nginx every public caller looks '
      + 'loopback, so no request-time gate can hold this door (exposed in production 2026-07-31). '
      + 'Unset FLOWMIC_MOCK_BILLING on this deployment; the standalone/dev mock is unaffected.',
    );
  }
}

/** Build the node:http request handler. Returns true iff it handled the request
 *  (so socket.io's own upgrade handling still sees engine.io paths). */
export function makeHttpHandler(deps: HttpDeps): (req: IncomingMessage, res: ServerResponse) => boolean {
  const { config, billing, version } = deps;
  // M5 — mount-time hard refusal. FIRST, before any closure state exists: a
  // handler that can serve even one request before noticing would not be a wall.
  assertMockBillingMountable(config);
  const scriptPath = deps.scriptPath ?? process.argv[1] ?? '';
  // ONE throttle per server, held in this closure. Constructed here rather than in
  // bootstrap because this is the only place that knows a diag route exists at all,
  // and a fresh instance per request would be a limiter that never limits (the
  // ReleaseSuppression trap, bootstrap.ts:126).
  const diagThrottle = new DiagUploadThrottle();
  // ONE handler per server, held in this closure for the same reason as the
  // throttle above: it owns a mtime-keyed cache, and a fresh instance per request
  // would be a cache that never caches.
  const updateRoutes = deps.updates ? makeUpdateRoutes(deps.updates) : null;

  return (req, res): boolean => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';
    // Let socket.io own its own path.
    if (url.startsWith('/socket.io')) return false;

    if (url === '/api/health' && method === 'GET') {
      // PUBLIC BY NECESSITY, and the ONE route that must stay that way: a phone
      // with no token yet probes it to draw the instance list and to learn which
      // channel answered (mobile/src/session/instance_probe.dart reads `ok` +
      // `mode`), the desktop's bring-up gate polls it, and the saas console reads
      // `version`. Requiring a credential here would break pairing itself.
      //
      // `version` STAYS (0.2.x caught real bugs with it: three builds all called
      // 0.1.0, and a stale in-place upgrade is only visible by comparing this to
      // the client's own version) — and it is not sensitive: the download page
      // publishes it anyway.
      //
      // `script` is ADDITIVE (owner 2026-07-27) and exists for exactly one reader:
      // the desktop's adopt-first probe. On finding :41879 already taken, the
      // desktop used to adopt any listener whose health said `ok:true` — which is
      // true of a stale orphan left by a DIFFERENT build, so a freshly-installed
      // (or portable) app would silently run against someone else's server.js and
      // none of its server-side fixes would be in effect. The absolute path of the
      // script actually running is the honest answer to "is this my own copy".
      //
      // RV-32: that reader is ALWAYS on loopback (desktop dials SIDECAR_HOST =
      // 127.0.0.1, sidecar/io.rs), while the route itself is reachable from the
      // whole LAN — so the absolute path was being handed to anyone who asked,
      // and on Windows it carries the account name and the install layout
      // (C:\Users\<owner>\AppData\Local\…). The FIELD is never removed: an absent
      // `script` reads to the adopt probe as "pre-2026-07-27 build" and costs a
      // wrong adopt (adopt.rs:97). It is `null` for a caller that has no business
      // knowing, which is a refusal to answer, not a plausible wrong answer.
      //
      // Why not the basename: every build's is `server.js`, so a reader comparing
      // basenames would conclude "same build" for two DIFFERENT builds — the exact
      // "one value answering two questions" trap this field was created to break. A boolean cannot
      // work either: only the caller knows which path it expected.
      //
      // saas is excluded even on loopback because nginx makes every public request
      // look loopback (see local-only.ts) — that would publish the VPS path to the
      // internet — and no saas client has ever read this field.
      const script = config.mode === 'standalone' && isLocalRequest(req) ? scriptPath : null;
      // D3 — probe the database when a probe was wired (HttpDeps.dbProbe). The
      // response stays ADDITIVE either way: every pre-D3 key keeps its exact
      // meaning and position; `db` appears only when a probe actually ran, so
      // no reader can mistake "never asked" for "asked and got a yes".
      //
      // Consumers walked before this change (full list in the D3 report):
      //  · desktop adopt / await_health / supervisor (sidecar/adopt.rs symbol
      //    `probe_existing`, io.rs:171, shell/sidecar_ctl.rs symbol
      //    `spawn_health_supervisor`) — all require 200, two of them
      //    also grep `"ok":true`. A DB-dead sidecar now reads as unhealthy
      //    there, which is the POINT: it must not be adopted or declared up, it
      //    would serve pairing screens it cannot persist. ⚠️ The adopt probe's
      //    forensic line then says "not FlowMic" for something that IS FlowMic
      //    — a wording bug in a file this change does not own; recorded, not
      //    silently patched.
      //  · mobile instance_probe.dart:125 — anything but 200+`ok:true` renders
      //    offline (a chooser, never a gate — the tap still dials).
      //  · verify/golden/g16 + the ops preflight curls — read `ok`/`version`,
      //    which the 503 body still carries.
      if (deps.dbProbe) {
        try {
          deps.dbProbe();
        } catch (err) {
          // Out loud, both directions: the caller gets a named unhealthy body,
          // the operator gets the actual SQLite error in the log — "ok:false"
          // alone would be a status word with no "on what basis" (R11).
          log.error('health: db probe failed', { error: err instanceof Error ? err.message : String(err) });
          sendJson(res, 503, { ok: false, mode: config.mode, port: config.port, version, script, db: 'error' });
          return true;
        }
        sendJson(res, 200, { ok: true, mode: config.mode, port: config.port, version, script, db: 'ok' });
        return true;
      }
      sendJson(res, 200, { ok: true, mode: config.mode, port: config.port, version, script });
      return true;
    }

    // Additive http endpoint (07 §5 / F-2343): the desktop polls this to build a
    // LAN-reachable pairing endpoint (QR carries a phone-dialable address, not
    // 127.0.0.1). Not a socket event — no whitelist/count guard involvement.
    //
    // RV-32 — TWO gates, because either alone is insufficient:
    //  • standalone-only, which 09-WEB-SPEC §"standalone-only: GET /api/network"
    //    already specified and the code had drifted from: mounted in saas, the
    //    public relay was handing every one of the VPS's NIC addresses to any
    //    anonymous caller. In saas it now falls through to the router's 404, the
    //    same "not mounted in this mode" answer auth/console/probe give.
    //  • loopback-only, because this is THE DESKTOP ASKING ITSELF (sidecar/io.rs
    //    fetch_lan_candidates / fetch_lan_primary, always 127.0.0.1). owner's
    //    ruling "list every listening IP" is about the device page's picker, i.e. this
    //    machine's own question — never about an anonymous LAN reader being owed
    //    a NIC inventory. Nothing the desktop sees changes.
    if (config.mode === 'standalone' && url === '/api/network' && method === 'GET') {
      if (!isLocalRequest(req)) {
        refuseNonLocal(req, res, url);
        return true;
      }
      // GA-21: `candidates` is additive — `lan_ipv4` / `primary` keep their exact
      // historical shape so existing readers are untouched. The desktop picker
      // needs the classification to draw its "non-standard private segment" badge, and the ORDER
      // here is a default rather than a verdict: every address the host has is
      // listed, because the one the owner's tablet can actually reach may not be
      // the one the heuristic likes (that is precisely the defect this fixes).
      const candidates = collectLanCandidates();
      sendJson(res, 200, {
        lan_ipv4: candidates.map((c) => c.address),
        primary: candidates[0]?.address ?? null,
        candidates,
        port: config.port,
        // D2LAN-B2b — the transport the two delivered halves of this feature were
        // missing. B1 mints the certificate and knows its fingerprint; B2 puts a
        // fingerprint on the QR; NOTHING carried one to the other, so the feature
        // was worth zero with both cards "done". This key is that carriage: the
        // desktop shell reads it here (apps/desktop/src-tauri/src/sidecar/io.rs,
        // symbol `parse_lan_tls_fingerprint`) and it reaches the QR builder
        // (apps/desktop/src/lib/pairing.ts, symbol `buildQrPayload`).
        //
        // 🔴 WHY PUBLISHING IT HERE IS NOT A DISCLOSURE, since the next reader
        // will reasonably ask. A fingerprint is a hash of the PUBLIC key, and that
        // public key is handed in the clear to every peer that opens a TLS
        // handshake with this port — anyone who can reach the port already has it,
        // by design (that is what makes pinning possible at all). The value it
        // adds is INTEGRITY, not secrecy: a phone that learned it over a trusted
        // channel (a QR on the owner's own screen) can detect a substituted key.
        // Nothing secret is anywhere near this route — the private key never
        // leaves `lan-tls/cert-store.ts` (symbol `LanTlsIdentity.keyPem`) and is
        // never logged. The route is still loopback-gated above, but that gate is
        // about the NIC inventory beside it, not about this field.
        //
        // The shape is re-checked at this boundary rather than trusted: the value
        // is about to be printed into a picture a phone pins for months, and a
        // malformed one must be refused where it is READ (loudly, below), never
        // quietly forwarded to become a pin nothing can ever match.
        lan_tls_fp: publishableLanTlsFingerprint(deps),
      });
      return true;
    }

    // RV-98 — the resting instance list's second question. NOT mode-gated and NOT
    // loopback-gated, both deliberately and for the same reason: the caller is a
    // phone somewhere else on the network (or on the public internet, via the
    // relay), and the mode that MOST needs to answer is saas. What replaces those
    // two gates is a credential — see presence-routes.ts, which is the whole
    // argument. Placed above the standalone-only block so the mounting difference
    // is visually obvious rather than buried in a shared `&&`.
    if (deps.presence && tryHandlePresenceRoutes(req, res, deps.presence)) return true;

    // L-④ — GET /api/updates/latest. PUBLIC and UNAUTHENTICATED, on the same
    // argument as /api/health above: a client that has not logged in (or has not
    // even paired) must still be able to ask "should I be updating now", and the answer is
    // already published on the download page. Mounted purely by whether an
    // operator put a manifest file somewhere — no mode gate, because this route
    // holds no secret and no per-deployment truth (update-routes.ts §mounting condition).
    if (updateRoutes && updateRoutes(req, res)) return true;

    // W-5a (REQ-13-03) — GET /api/status. PUBLIC and UNAUTHENTICATED, on the
    // SAME argument as the two routes above: a status page that requires a
    // credential is unreadable on the day it matters. Mounted in both modes and
    // gated only on whether bootstrap armed a probe timer. It publishes no error
    // strings and no percentages — status-routes.ts argues both.
    if (deps.status && tryHandleStatusRoutes(req, res, deps.status)) return true;

    // GA-12 "test connection" probes (POST /api/probe/llm | /api/probe/stt). STANDALONE
    // ONLY: the body names an arbitrary endpoint for the server to dial, which on
    // a public saas instance would be an SSRF pivot into its own network. On the
    // owner's own machine — which is the only place the desktop settings page runs
    // — that is exactly the intent. The routes persist nothing and bill nothing
    // (see probe-routes.ts header); in saas mode they fall through to 404.
    // RV-32: standalone was never the same thing as local, so the module now also
    // refuses a non-loopback peer — see its own header.
    if (config.mode === 'standalone' && tryHandleProbeRoutes(req, res, deps.probe ?? {})) return true;

    // The phone's diagnostic upload. D6 (2026-08-04): mounted in BOTH modes.
    // It was standalone-only, which left the cloud leg — the ONLY leg a public
    // user has — answering 404 to "upload diagnostics"; yet the cloud leg is exactly where
    // the phone's half of a broken chain is hardest to reach any other way.
    //
    // RV-13/RV-32: the route must NOT be anonymous (a forged trail poisons the
    // very evidence chain this repo's root-cause method rests on), and in saas
    // that stops being a marking and becomes a REFUSAL (`requireVerified`):
    //  · standalone keeps the two-stage posture — an unverified LAN upload is
    //    accepted but indelibly marked UNVERIFIED (the owner's broken-pairing
    //    phone is the valuable uploader there);
    //  · saas REQUIRES the pairing Bearer (401 DIAG_UNVERIFIED otherwise), and
    //    not only against forgery: behind nginx every public caller shares ONE
    //    peer address (local-only.ts), so an anonymous cloud upload could not
    //    even be rate-bucketed or attributed — "origin=UNVERIFIED peer=
    //    127.0.0.1" marks nothing and one flooder spends the whole internet's
    //    budget. The phone already sends the Bearer when it has one
    //    (mobile diag_upload.dart:76-78).
    //
    // `deps.pairing` is the registry that judges the Bearer — ONE dep, wired by
    // bootstrap in both modes, rather than borrowed from whichever other route
    // happens to be mounted (see HttpDeps.pairing for why borrowing `presence`
    // was wrong and not merely untyped). It is applied AFTER `deps.diag` spreads
    // so the production wiring always wins over a route-level test seam.
    // `throttle` is created ONCE per server (above) for the same reason
    // ReleaseSuppression is: a per-request limiter would limit nothing.
    if (tryHandleDiagRoutes(req, res, {
      ...(deps.diag ?? {}),
      ...(deps.pairing ? { registry: deps.pairing } : {}),
      throttle: diagThrottle,
      requireVerified: config.mode === 'saas',
    })) return true;

    // The phone's image delivery ingress (RCA-v3). Standalone-only: it persists
    // user images to the host's data dir, which belongs on the owner's machine
    // and nowhere else; the cloud channel keeps the hardened socket path.
    if (config.mode === 'standalone' && deps.inject && tryHandleInjectRoutes(req, res, deps.inject)) return true;

    // saas-only account REST (register / login / me). In standalone deps.auth is
    // absent, so these paths fall through to the 404 below (mounted saas-only).
    if (deps.auth && tryHandleAuthRoutes(req, res, deps.auth)) return true;

    // saas-only console REST (logout / password reset / cloud summary+subscription
    // / device+pairing mgmt — R5-WEB WP-W1). Same saas-only gating as auth above.
    if (deps.console && tryHandleConsoleRoutes(req, res, deps.console)) return true;

    // A2-5 — `GET /api/cloud/usage/events`. Mounted exactly like `console` above
    // (bootstrap builds the dep saas-only): it IS a `/api/cloud/*` console route.
    if (deps.usageEvents && tryHandleUsageEventsRoutes(req, res, deps.usageEvents)) return true;

    // 0.2.48 — saas-only ops REST (`/api/ops/*`). Same mode gating as `console`
    // above and for a stronger reason: every route in it reads across accounts,
    // and standalone has no account layer to read across (one local owner, no JWT,
    // `is_admin` never set) — so an admin gate there would be guarding a door in a
    // field. Absent dep → these paths fall to the 404 below, which honestly means
    // "this deployment has no ops surface" rather than "you don't have permission".
    if (deps.ops && tryHandleOpsRoutes(req, res, deps.ops)) return true;

    // A2-3 — saas-only `POST /api/ops/users/restrict` ("restrict usage" write).
    //
    // TWO conditions, the keymeta/timelineGrants shape rather than `ops`'s one:
    // bootstrap builds the dep saas-only, AND the mode is re-checked here — and
    // for this route that second condition is worth more than it is for a read.
    // standalone has no account layer (one local owner, no JWT, `is_admin` never
    // set), so a mis-wired dep would expose a cross-account WRITE on somebody's
    // LAN box behind a gate that can never say no. `test/account-restriction
    // .test.ts` wires exactly that mistake on purpose.
    if (config.mode === 'saas' && deps.restriction
      && tryHandleAccountRestrictionRoutes(req, res, deps.restriction)) return true;

    // A2-4 — saas-only `GET /api/ops/users{,/detail}` (the read-only account
    // list). Same TWO conditions as the restriction mount right above, and for a
    // reason that survives being a read: standalone has no account layer at all
    // (one local owner, no JWT, `is_admin` never set), so a mis-wired dep would
    // publish every account row on somebody's LAN box behind a gate that can
    // never say yes to anyone — i.e. the paths would exist and refuse everybody,
    // which is a worse answer than the honest "this deployment has no ops surface" 404.
    // Ordered AFTER the restriction mount purely so the three ops blocks read in
    // the order they were built; the three path sets are disjoint.
    if (config.mode === 'saas' && deps.opsUsers
      && tryHandleOpsUserRoutes(req, res, deps.opsUsers)) return true;

    // A2-5 / REQ-12-08 — saas-only `GET /api/ops/usage/events?user_id=` (one
    // account's usage detail, for operators). Same TWO conditions as the two
    // mounts above and for the same reason: standalone has no account layer, so
    // a mis-wired dep would publish per-event usage on somebody's LAN box behind
    // a gate that can never say yes to anyone. Ordered after `opsUsers` purely
    // so the four ops blocks read in the order they were built; the path sets
    // are disjoint.
    if (config.mode === 'saas' && deps.opsUsageEvents
      && tryHandleOpsUsageEventsRoutes(req, res, deps.opsUsageEvents)) return true;

    // SALT-1 — GET/PUT /api/timeline/keymeta. SAAS ONLY, the reverse of the
    // image inject mount above (that door exists only in standalone; this one
    // only in saas — in standalone these paths MUST 404). TWO conditions on the
    // paddle precedent: bootstrap builds the dep saas-only, and the explicit
    // mode test is what catches a MIS-WIRED dep — a bootstrap that passed
    // `keymeta` in standalone would otherwise serve account key metadata from a
    // deployment that has no account layer to have verified anyone against.
    // test/timeline-keymeta.test.ts wires exactly that mistake on purpose.
    if (config.mode === 'saas' && deps.keymeta && tryHandleTimelineKeymetaRoutes(req, res, deps.keymeta)) return true;

    // GRANT-1 — GET/DELETE /api/timeline/grants. Same TWO conditions as the
    // keymeta mount above, for the same reasons: bootstrap builds the dep
    // saas-only, and the explicit mode test is what catches a MIS-WIRED dep
    // (a standalone deployment has no accounts, so serving "your grants"
    // there would be answering for a person that does not exist).
    if (config.mode === 'saas' && deps.timelineGrants && tryHandleTimelineGrantsRoutes(req, res, deps.timelineGrants)) return true;

    // VERIFY-1 — POST /api/auth/email-verification/{send,confirm}. Same TWO
    // conditions as the keymeta/timelineGrants mounts above, for the same
    // reasons: bootstrap builds the dep saas-only, and the explicit mode test
    // is what catches a MIS-WIRED dep (a standalone deployment has no accounts,
    // so a verification surface there would mint codes for a person that does
    // not exist).
    if (config.mode === 'saas' && deps.emailVerification && tryHandleEmailVerificationRoutes(req, res, deps.emailVerification)) return true;

    // D1 §5.1 — Paddle's webhook ingress, mounted ABOVE the `/api/billing/`
    // block on purpose: that block's two gates (isLocalRequest + the Bearer
    // resolve) would both refuse Paddle, so this route must never be able to
    // fall into them. paddle-routes.ts's header is the full argument; the short
    // version is that a webhook 401 is SILENT to us — Paddle just retries, backs
    // off, and gives up, and the first symptom is a user who paid and never got
    // upgraded.
    //
    // THREE conditions, and ALL THREE are load-bearing — none is decoration:
    //  · `deps.paddle` — bootstrap builds it only for saas + enabled, the same
    //    way it builds `auth` and `console`;
    //  · the two config tests — they are what catches a MIS-WIRED dep. A
    //    bootstrap that passed `paddle` in standalone would otherwise open a
    //    webhook endpoint on someone's LAN box, and config.ts's clamp cannot
    //    help there (it clamps `config.paddle.enabled`, not what bootstrap
    //    hands us). `test/paddle-webhook-route.test.ts` "refuses even when the
    //    deps ARE present" wires exactly that mistake on purpose, and deleting
    //    this line turns it red — measured, not assumed.
    // ⚠️ So there is nothing here to "simplify": each condition fails a
    // different way and each has its own test.
    //
    // ORDER: `deps.paddle` is asked FIRST, and not for speed. Several existing
    // suites build a ServerConfig by hand as a partial literal behind an
    // `as never` cast (http-access-control.test.ts:91, http-pc-presence.test.ts),
    // so `config.paddle` is genuinely `undefined` on those routers — reading it
    // before the dep check turns every one of them into a TypeError on EVERY
    // request. Short-circuiting on the dep costs nothing and leaves the two
    // config tests exactly as load-bearing: the only way to reach them is to
    // HAVE the dep, which is precisely the mis-wiring case they exist to catch.
    if (deps.paddle && config.mode === 'saas' && config.paddle.enabled
      && tryHandlePaddleRoutes(req, res, deps.paddle)) return true;

    if (!url.startsWith('/api/billing/')) return false;
    // ── GATE 1 (RV-32): WHERE did this come from ─────────────────────────────
    // The mock gateway is a DEVELOPMENT affordance and it MUTATES: with
    // FLOWMIC_MOCK_BILLING=1 on a standalone box, anyone on the LAN could upgrade,
    // cancel or expire the owner's plan and — worst of all — call advance-clock,
    // which moves the billing clock for the whole process. standalone carries no
    // per-request credential at all (single user, no account layer), so where the
    // packet came from is the only question there is to ask. Its only callers are
    // on this machine (the golden path's G9 hits /api/billing/quota over loopback;
    // no desktop or mobile code references these paths — grep in the report).
    //
    // Checked BEFORE the mockBilling branch on purpose: whether the gateway is
    // enabled is itself something an off-box caller has no business learning.
    if (!isLocalRequest(req)) {
      refuseNonLocal(req, res, url);
      return true;
    }
    // ── GATE 2 (R4 ④ / owner A3): WHO is this ────────────────────────────────
    // Gate 1 is a no-op in saas — nginx makes every public request look loopback
    // — which is exactly why it can never be the only gate. This one asks for a
    // credential instead of a source address: in saas the verified Bearer
    // subject, in standalone the single local user (account-auth.ts explains why
    // 'default' is the TRUE answer there and must not be "fixed").
    //
    // FAIL CLOSED: `who.ok === false` ends the request with a named 401 and a log
    // line. It must never resolve to some other user — booking an anonymous
    // caller's upgrade/cancel/advance-clock onto a real account (and, with Paddle,
    // its money) is worse than the missing gate it replaces.
    //
    // Ordered BEFORE the mockBilling 404 for the same reason gate 1 is: a caller
    // who has not proved who they are is not owed the deployment's configuration.
    const who = deps.resolveUserId(req);
    if (!who.ok) {
      refuseUnidentified(req, res, url, who.error);
      return true;
    }
    if (!config.mockBilling) {
      sendJson(res, 404, { error: 'PLAN_UPGRADE_REQUIRED', message: 'mock billing gateway disabled (FLOWMIC_MOCK_BILLING=0)' });
      return true;
    }
    const userId = who.userId;

    void (async (): Promise<void> => {
      try {
        if (url === '/api/billing/plan' && method === 'GET') return sendJson(res, 200, billing.getPlan(userId));
        if (url === '/api/billing/quota' && method === 'GET') return sendJson(res, 200, billing.getQuota(userId));
        const body = method === 'POST' ? await readBody(req) : {};
        if (url === '/api/billing/checkout' && method === 'POST') {
          if (!isCycle(body.cycle)) return sendJson(res, 400, { error: 'PLAN_UPGRADE_REQUIRED', message: 'cycle must be monthly|yearly' });
          return sendJson(res, 200, billing.mockCheckout(userId, body.cycle));
        }
        if (url === '/api/billing/confirm' && method === 'POST') {
          if (typeof body.sessionId !== 'string') return sendJson(res, 400, { error: 'PLAN_UPGRADE_REQUIRED', message: 'sessionId required' });
          return sendJson(res, 200, billing.mockConfirm(userId, body.sessionId));
        }
        if (url === '/api/billing/cancel' && method === 'POST') return sendJson(res, 200, billing.mockCancel(userId));
        if (url === '/api/billing/renew' && method === 'POST') return sendJson(res, 200, billing.mockRenew(userId));
        if (url === '/api/billing/expire' && method === 'POST') return sendJson(res, 200, billing.mockExpire(userId));
        if (url === '/api/billing/advance-clock' && method === 'POST') {
          const offset = Number(body.offsetMs);
          if (!Number.isFinite(offset)) return sendJson(res, 400, { error: 'PLAN_UPGRADE_REQUIRED', message: 'offsetMs required' });
          billing.advanceClock(offset);
          return sendJson(res, 200, { ok: true });
        }
        sendJson(res, 404, { error: 'PLAN_UPGRADE_REQUIRED', message: 'unknown billing route' });
      } catch (err) {
        if (err instanceof ServerError) return sendJson(res, 409, { error: err.code, message: err.message });
        sendJson(res, 500, { error: 'SETTINGS_SYNC_FAIL', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  };
}
