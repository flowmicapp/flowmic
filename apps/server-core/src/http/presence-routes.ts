// SPEC-REF:
//   docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §1.4 / §1.4.1
//     (which question "online" answers; RV-98 has the instance list actually ask that PC)
//   docs/rebuild/15-… §6 G-15 (this route closes off exactly the ② half of it)
//   apps/server-core/src/socket/handlers/mobile.handler.ts (`pc_online`, each
//     site computed as `store.getPc(pc.room_uuid) !== null`)
//   CLAUDE.md human-audit the four sensitive paths: pairing/auth
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// GET /api/pc/presence — "is the PC I'm paired with in its room right now."
//
// owner 2026-08-01, exact words from a real-device session: "In screenshot 2, the
// cloud-relay instance shows 'relay reachable · PC online status unknown', but
// the PC is actually online — that display is wrong, it needs to correctly show
// whether the PC side is online."
//
// WHY AN HTTP ROUTE AND NOT A SOCKET EVENT. The screen that is wrong is the
// RESTING instance list, which by design holds no socket at all (a socket would
// join the room, raise pc:mobile-joined and evict whichever phone is already in
// there — RV-92 argued that through and rejected it). The list already makes one
// unauthenticated `GET /api/health` per endpoint; this is the second question it
// needs, asked the same way. Nothing about the protocol's event surface changes:
// no new event, no new error code, whitelist untouched.
//
// ── WHO IS ALLOWED TO ASK, AND ABOUT WHAT ──────────────────────────────────
//
// What this route hands out is "is someone's particular PC online right now", which is exactly the
// kind of fact a stranger must never be able to enumerate. Two properties, and
// the second one is the load-bearing one:
//
//   ① CREDENTIAL — `Authorization: Bearer <mobile_token>`, the phone's OWN
//      standing pairing credential (05 §7: `fm_` + 64 hex = 256 random bits; no
//      expiry, revoked by deleting the row). It is the same token `mobile:
//      reconnect` and `POST /api/inject/image` present, resolved against the same
//      registry, so this ingress can never admit a phone the socket path rejects.
//
//   ② NO SUBJECT PARAMETER AT ALL — the request carries no body and no query.
//      The PC being asked about is DERIVED from the token (pairing → its pc →
//      its room_uuid). "give a pc_id and it tells you whether it's there" is therefore not something
//      this route declines to do; it is something it has no way to express. That
//      is deliberate: a `?pc_id=` parameter plus an ownership check would be one
//      forgotten `if` away from an enumeration oracle, and this repo has already
//      shipped that shape once (RV-32's anonymous `/api/network`).
//
// NO RATE LIMIT, stated rather than omitted: the only thing an anonymous caller
// can do here is guess a 256-bit token, and the socket path (`mobile:reconnect`)
// accepts the very same guesses with no limiter either — a window here alone
// would close nothing while adding a mechanism nobody asked for. What it costs a
// VALID token holder is one Map lookup, i.e. less than the `/api/health` the same
// screen already sends. If a limiter is ever wanted it belongs on the credential,
// not on this one route.
//
// NO SIDE EFFECTS: resolution goes through `Registry.findPairingByToken`, the
// pure lookup, NOT `reconnectMobile`. A resting list polling for presence is not
// the phone having a session, so it must not stamp `last_seen_at` — see that
// method's own comment, and `pairing-auth.ts`'s warning that reconnectMobile must
// never be called speculatively. (This is also why the route does not reuse
// `verifyPairedMobile`: that helper IS the speculative-unsafe one.)
//
// WHAT COMES BACK is one bit plus an echo the caller already had:
//   `pc_online` — `store.getPc(room_uuid) !== null`, the EXACT expression behind
//                 the `pc_online` field on the pair/reconnect acks. Not a second
//                 definition of "in the room": the same one, read over http.
//   `pc_id`     — echoed so the phone can check the answer is about the PC it
//                 asked about (cross-wiring identifiers is strictly forbidden). The phone already stores this from its
//                 own pair ack, so nothing new is disclosed by returning it.
//   `pc_absent_reason` — OPTIONAL, and only ever alongside `pc_online:false`
//                 (book 18 §7.3, owner ruling ⑧ 2026-08-04). "Why is that PC not
//                 here" is a question about PRESENCE, so it is answered here
//                 rather than by a new error code (those answer "what happened
//                 to one delivery") or a new socket event: an additive JSON
//                 field moves neither the 54-event whitelist nor the 61 error
//                 codes, and a phone that does not know the key ignores it and
//                 keeps showing today's "offline". Present ONLY when the server
//                 actually recorded a reason (room/pc-absence.ts) — an ordinary
//                 shutdown records none, so that response is byte-identical to
//                 the one this route has always sent.
// Nothing else. No device name, no user id, no room_uuid — a token buys the one
// bit it asked for, plus (when there is one) the reason behind that bit, and not
// an inventory.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from '../room/registry';
import type { RoomStore } from '../room/store';
import { pcAbsenceReasons } from '../room/pc-absence';
import { sendJson } from './body';

/** The route path.
 *
 *  Exported for exactly ONE consumer — `test/http-pc-presence.test.ts`. Said
 *  plainly because the tempting sentence "so the router and this agree" would be
 *  false: the router never names the path, it delegates the whole match to
 *  `tryHandlePresenceRoutes` below (anti-façade ④ — a comment defending a design is
 *  itself a claim, and this repo has shipped a wrong one before). What the export
 *  buys is that a hand-copied literal in a test cannot drift into passing against
 *  a route nobody serves.
 *
 *  ⚠️ `verify/golden/g16-pc-presence.mjs` deliberately does NOT import it: golden
 *  runs the BUILT dist, so a harness sharing the constant could not tell "the
 *  route is /api/pc/presence" from "the route is whatever the constant says".
 *  Same reasoning as G15's repeated `ONE_MIB`. */
export const PC_PRESENCE_PATH = '/api/pc/presence';

/** Refusal code. An HTTP-LOCAL string, deliberately not a protocol `ErrorCode`:
 *  the same choice `DIAG_*` made. Protocol codes are the cross-boundary
 *  vocabulary that carries bilingual user-facing copy and a count guard; this
 *  never reaches a user (the phone renders "unknown" for every non-answer,
 *  whatever the reason) so minting one would add a string with no reader. */
export const PRESENCE_AUTH_REQUIRED = 'PRESENCE_AUTH_REQUIRED';

export interface PresenceRoutesDeps {
  /** Typed as a slice of the real Registry so there is no second interface to
   *  drift from it. `findPairingByToken` is the PURE lookup (no last_seen_at). */
  registry: Pick<Registry, 'findPairingByToken'>;
  /** Live room presence — the same instance the socket handlers mutate. */
  store: Pick<RoomStore, 'getPc'>;
}

/** `Authorization: Bearer <token>` → the token, or '' when absent/malformed.
 *  '' can never resolve to a pairing, so an empty return is always a refusal.
 *  Kept private for the same reason pairing-auth.ts keeps its copy private: an
 *  exported bearer parser with no caller is a façade waiting to happen. */
function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/** Returns true iff it handled the request. */
export function tryHandlePresenceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PresenceRoutesDeps,
): boolean {
  const url = (req.url ?? '').split('?')[0];
  if (url !== PC_PRESENCE_PATH) return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    return true;
  }

  const token = bearerToken(req);
  // ONE refusal for "no token" and "a token nothing owns" on purpose: telling
  // those two apart would confirm to a guesser that a value exists, which is the
  // only feedback a 256-bit guess could ever profit from.
  const resolved = token === '' ? null : deps.registry.findPairingByToken(token);
  if (!resolved) {
    sendJson(res, 401, { ok: false, error: PRESENCE_AUTH_REQUIRED });
    return true;
  }

  const { pc } = resolved;
  const online = deps.store.getPc(pc.room_uuid) !== null;
  // Asked ONLY when the PC is absent: a reason is an answer to "why is it not
  // here", and for a PC that IS here that question has no answer to give. This
  // also means the online response keeps exactly the three keys it always had.
  //
  // Read straight off the module table rather than through a dep: this route is
  // constructed by http/router.ts, which has no absence table to hand it, so an
  // injectable seam here could only ever be passed by a test — and a dependency
  // production cannot supply is the shape this repo keeps finding as a façade.
  // The socket handlers write to this same one instance (room/pc-absence.ts).
  const absentReason = online ? null : pcAbsenceReasons.reasonFor(pc);
  sendJson(res, 200, {
    ok: true,
    pc_id: pc.id,
    pc_online: online,
    // Omitted — not null — when nothing was recorded: an absent key reads as
    // "unknown" to every client, old and new, and that is the same answer this
    // route has always given.
    ...(absentReason !== null ? { pc_absent_reason: absentReason } : {}),
  });
  return true;
}
