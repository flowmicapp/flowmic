// SPEC-REF:
//   apps/server-core/src/site/sanitize.ts `originAllowed` (the flowmic.app
//     allow-list `POST /api/site/collect` already trusts — reused here rather
//     than re-declared, so a CORS grant and the payload sanitizer's own origin
//     check can never disagree about who "the web app" is)
//   apps/server-core/src/http/stt-model-routes.ts (the WebView-origin CORS this
//     module is modelled on — same shape, different allow-list: that one grants
//     `tauri://localhost` and friends for the DESKTOP's own WebView, this one
//     grants `flowmic.app` for the public web client. The two are deliberately
//     separate allow-lists for two different browsers serving two different
//     pages; neither should ever grow to include the other's origins.)
//   CLAUDE.md red line: one value answers one question — an allow-list is one
//     such value, and this file exists so it is answered once.
//
// Card CORS-1 (2026-09-08) — the web mic page follows a paired PC to its
// `home_node` and then reads `GET /api/pc/presence` and `GET /api/node/list`
// on THAT node's own origin (page on e.g. https://flowmic.app, relay on e.g.
// https://srvasia02.flowmic.app): a genuine cross-origin fetch. A device pass
// measured the concrete failure this closes: a preflight OPTIONS on
// `/api/pc/presence` came back 405 with no grant headers at all, because the
// route's method switch had never heard of OPTIONS — the browser never sends
// the real GET after that, and the console shows "unknown" for a PC that is
// actually online.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { originAllowed } from '../site/sanitize';

/**
 * Set `access-control-allow-origin` (+ `vary: origin`) on `res` when `req`'s
 * `Origin` header is on the flowmic.app allow-list. A no-op — nothing is set,
 * `false` is returned — for a missing or foreign origin, which leaves a
 * same-origin or non-browser caller with exactly the response it always got.
 *
 * Returns whether a grant was set so `handleWebCorsPreflight` below does not
 * have to re-read the header it just wrote.
 */
export function applyWebCors(req: IncomingMessage, res: ServerResponse, allowLocalhost = false): boolean {
  // `req.headers?.` rather than `req.headers.`: several existing test harnesses
  // in this repo hand-roll a bare `{ url, method, socket }` IncomingMessage with
  // no `headers` object at all (real Node always supplies one, so this never
  // happens outside a test double) — `http-network.test.ts`'s `callHealth` is
  // one, and it predates this file. A route that grants CORS must not turn a
  // caller with no headers into a crash instead of "no grant".
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || !originAllowed(origin, allowLocalhost)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  return true;
}

export interface WebCorsPreflightOptions {
  /** This route's own answer, e.g. `'GET, OPTIONS'`. */
  methods: string;
  /** Non-simple request headers the browser is told it may send, e.g.
   *  `'authorization'` for a route that reads a Bearer token. Defaults to
   *  `'content-type'`, the one every route here already tolerates. */
  allowHeaders?: string;
  allowLocalhost?: boolean;
}

/**
 * Answer an OPTIONS preflight for a CORS-eligible GET route: 204, with the
 * origin grant (when the Origin earned one, via {@link applyWebCors}) plus the
 * methods/headers a browser needs to see before it will send the real
 * request.
 *
 * The methods/headers lines are written UNCONDITIONALLY, same as
 * stt-model-routes.ts's WebView preflight: without the origin grant a browser
 * discards the whole preflight regardless of what else this said, so naming
 * the accepted methods here discloses nothing a plain fetch to the route
 * would not already reveal.
 *
 * Returns `false` (and touches nothing) for any method other than OPTIONS, so
 * a caller can call this unconditionally at the top of its handler, before
 * its own method switch gets a chance to 405 the preflight.
 */
export function handleWebCorsPreflight(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebCorsPreflightOptions,
): boolean {
  if ((req.method ?? '') !== 'OPTIONS') return false;
  applyWebCors(req, res, opts.allowLocalhost ?? false);
  res.setHeader('access-control-allow-methods', opts.methods);
  res.setHeader('access-control-allow-headers', opts.allowHeaders ?? 'content-type');
  res.statusCode = 204;
  res.end();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Card MP-11 / gap G-16 (2026-09-11) — THE OTHER KIND OF CORS THIS SERVER DOES,
// and the two must never be confused with each other.
//
// Everything above answers「is this origin THE WEB APP?」— one closed
// allow-list, one answer, and the right answer for a page FlowMic ships.
// `POST /api/web/rooms {auth:{kind:'publishable_key'}}` is the opposite
// question: it exists to be called from a page FlowMic has never heard of.
// An allow-list cannot serve it — by construction there is no list of the
// internet — so the grant below REFLECTS whatever origin asked.
//
// 🔴 WHY THAT IS NOT A HOLE, stated where somebody reviewing a wildcard CORS
// grant will land:
//  ① `access-control-allow-credentials` IS NEVER SET. No cookie and no
//     ambient credential travels on these requests, so a reflected origin buys
//     an attacker exactly what a plain `curl` already buys them: the right to
//     send a request carrying a Bearer token they had to steal first. CORS is
//     not what stops that; the token being secret is.
//  ② THE REAL GATE IS INSIDE THE HANDLER AND IS UNCHANGED — the publishable
//     key's own per-key origin allow-list, answered as
//     `WEB_ROOM_ORIGIN_NOT_ALLOWED` (web-room-routes.ts `handleIntegrator`).
//     A preflight CANNOT be key-scoped: a browser sends it with no
//     `Authorization` header at all, so at preflight time there is no key to
//     ask about. Refusing the preflight for an origin the key WOULD have
//     allowed is the failure G-16 records (MP-2 measured it); refusing it for
//     an origin the key would NOT have allowed only moves a refusal the
//     handler makes anyway one round-trip earlier.
//  ③ SCOPE IS ONE PATH. These helpers are exported, but the only caller is the
//     room route; nothing else on this server reflects an origin, and the
//     allow-list above stays the answer everywhere else.
// W6a correction (2026-09-22): router.ts also calls the reflection for this
// SAME path's replica POST refusal, before the room handler can run. It only
// exposes NODE_IS_REPLICA and the writer URL, never room credentials. The key
// is publishable, not secret (integrator-quota.ts); registered Origins and the
// per-key quota bound its use, and Origin can still be forged outside browsers.
// ─────────────────────────────────────────────────────────────────────────────

/** The methods and headers the room route's preflight announces. Named here,
 *  beside the reflection that makes them reachable, so the two cannot drift. */
export const WEB_ROOM_CORS_METHODS = 'POST, OPTIONS';
/** `authorization` because all three arms read their credential from the header
 *  and only from there (web-room-routes.ts's own rule), `content-type` because
 *  the body is JSON — both are non-simple, so a browser will not send the POST
 *  until a preflight has named them. */
export const WEB_ROOM_CORS_HEADERS = 'authorization, content-type';

/**
 * Reflect `req`'s `Origin` back as the grant, with `vary: origin` and NO
 * credentials. Returns whether anything was set — `false` for a request with no
 * `Origin` at all (a non-browser caller, which needs no grant and must keep the
 * response it always got).
 */
export function applyReflectedOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  res.setHeader('access-control-allow-origin', origin);
  // 🔴 REQUIRED, not decoration: the answer now depends on a request header, so
  // a cache that keyed only on the URL would serve one site's grant to another.
  res.setHeader('vary', 'origin');
  return true;
}

/**
 * Answer an OPTIONS preflight for the room route: 204, reflected grant,
 * methods + headers. Returns `false` and touches nothing for any other method,
 * so the caller can run it before its own method switch.
 */
export function handleReflectedOriginPreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if ((req.method ?? '') !== 'OPTIONS') return false;
  applyReflectedOrigin(req, res);
  res.setHeader('access-control-allow-methods', WEB_ROOM_CORS_METHODS);
  res.setHeader('access-control-allow-headers', WEB_ROOM_CORS_HEADERS);
  res.statusCode = 204;
  res.end();
  return true;
}
