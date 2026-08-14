// SPEC-REF:
//   docs/strategy/2026-07-30-task-package-v1.md group D D10 (RV-32: the
//     standalone HTTP surface's full unauthenticated table — root shape:
//     "standalone-only ≠ authenticated")
//   docs/rebuild/03-SYSTEM-ARCHITECTURE.md §1/§5.5 (standalone binds ALL
//     interfaces so an unpaired phone on the LAN can reach it; saas binds
//     loopback behind an edge proxy)
//   docs/rebuild/13-LESSONS-LEARNED.md §6.4 (X-Forwarded-For is spoofable
//     without a trusted-proxy config — key on the DIRECT peer address)
//   CLAUDE.md red line: no silent failure
//   *** HUMAN-AUDIT SENSITIVE (access control) — reviewable in isolation ***
//
// RV-32 in one sentence: A MODE GATE IS NOT AN AUTH GATE.
//
// Several routes were mounted standalone-only and that was read as 「so only the
// owner can reach them」. But standalone is exactly the mode that binds every
// interface, because a phone with no token yet has to be able to dial it.
// `config.mode === 'standalone'` answers 「which product shape is this process」;
// it was being consumed as the answer to 「is this caller allowed」 — the repo's
// head bug shape (CLAUDE.md: one value answers two questions). The consequence was concrete:
// any machine on the owner's LAN could POST /api/probe/stt and have the owner's
// PC dial an arbitrary address, then read back latency and error code — an
// internal port scanner with someone else's IP on the packets.
//
// So the routes whose only legitimate caller is THIS MACHINE (the desktop shell
// interrogating its own sidecar) say so per request, here, once.
//
// TWO THINGS THIS IS NOT:
//
//  • NOT a second listener. server-core has ONE http server and socket.io shares
//    it (bootstrap.ts), so 「bind these paths to 127.0.0.1」 is not expressible as
//    a bind — the equivalent on a single listener is to refuse a peer that is not
//    this machine. Same effect, no second port, no new deps.
//
//  • NOT a trust boundary in saas — UNLESS the operator configures
//    FLOWMIC_TRUSTED_PROXIES (0.3.0 M3). Behind nginx EVERY peer is 127.0.0.1,
//    so with the config unset a public saas caller passes this check trivially,
//    which is why a route that must not be public in saas has to be MODE-gated
//    as well (see /api/network in router.ts) and can never rest on this
//    function alone. With the config SET, the trusted proxy's appended
//    X-Forwarded-For now reveals the real client and this gate refuses it —
//    strictly tighter, see isLocalRequest.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { log } from '../log';
import { sendJson } from './body';
import { clientIpFromRequest } from './trusted-proxy';

/** The DIRECT peer address, or '' when the socket is gone (see the fail-closed
 *  note on isLocalRequest). Never reads X-Forwarded-For: a header the caller
 *  writes cannot be the answer to 「where did this TCP connection come from」
 *  (13 §6.4) — log lines and audit rows want the wire-level fact. The
 *  proxy-aware CLIENT derivation is http/trusted-proxy.ts, a different
 *  question with a different answer. */
export function peerAddress(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? '';
}

/** Is this address this very machine? IPv4 loopback is the whole 127.0.0.0/8
 *  block, and Node hands back the IPv6 forms ('::1', '::ffff:127.0.0.1') when the
 *  client resolved `localhost` to IPv6 or connected over a dual-stack socket —
 *  all three shapes reach us on Windows, so all three are recognised. */
export function isLoopbackAddress(addr: string): boolean {
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Did this request come from this machine? An UNKNOWN peer is answered `false`
 *  — fail closed: a gate that opens when it cannot tell is not a gate.
 *
 *  0.3.0 M3 — trusted-proxy narrowing, with a hard rule: X-Forwarded-For may
 *  only ever REVOKE localness, never grant it. Both conditions must hold:
 *
 *    ① the DIRECT peer is loopback (the wire-level fact, header-independent).
 *       An attacker connecting from anywhere with a forged
 *       `X-Forwarded-For: 127.0.0.1` fails HERE, whatever the trust config
 *       says — localness is not mintable by a header, by construction;
 *    ② the DERIVED client is loopback too. With FLOWMIC_TRUSTED_PROXIES unset
 *       the derivation returns the peer unchanged, so ② collapses into ① and
 *       behaviour is byte-identical to before. With a same-box nginx trusted,
 *       a public caller's request arrives peer=127.0.0.1 (passes ①) but
 *       carries the proxy-appended real client in XFF — ② now refuses it,
 *       closing the 「behind nginx everyone looks local」 hole for every
 *       consumer of this gate.
 *
 *  Monotonicity argument (why this cannot regress): ② can only differ from ①
 *  when the peer is a configured trusted proxy AND the header names a
 *  non-loopback client — a case that used to be answered 「local」 wrongly.
 *  Every answer this function changes flips true→false; no false→true edge
 *  exists, so nothing that was refused before is admitted now. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const peer = peerAddress(req);
  if (!isLoopbackAddress(peer)) return false; // ① — header can never override
  return isLoopbackAddress(clientIpFromRequest(req)); // ② — header may narrow
}

/** The refusal code. Deliberately NOT a protocol ErrorCode: this is an http-surface
 *  transport refusal like DIAG_NO_SINK / METHOD_NOT_ALLOWED, it never crosses the
 *  socket contract, and the 55-code table stays at 55. It also never reaches a
 *  user's face — the only legitimate callers of these routes are on loopback — so
 *  there is nothing to translate into four languages. */
export const LOCAL_ONLY_ERROR = 'LOCAL_ONLY';

/**
 * Refuse a non-local caller, by name (CLAUDE.md red line: no silent failure).
 *
 * 403 with a named reason rather than a fake 404 or an empty response: a scanner
 * learns nothing from this that it did not already know by completing a TCP
 * handshake, while the OWNER reading server.log needs to see which route was hit
 * from where — the log line is the only reason a probe attempt from the LAN is
 * ever noticed at all.
 */
export function refuseNonLocal(req: IncomingMessage, res: ServerResponse, route: string): void {
  log.warn('http: refused a non-local request to a local-only route', {
    route,
    peer: peerAddress(req) || 'unknown',
  });
  sendJson(res, 403, {
    ok: false,
    error: LOCAL_ONLY_ERROR,
    message: `${route} answers only requests from this machine`,
  });
}
