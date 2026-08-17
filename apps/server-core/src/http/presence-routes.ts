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
//                 keeps showing today's "offline". Present ONLY when there is a
//                 reason to give — an ordinary shutdown has none, so that
//                 response is byte-identical to the one this route has always
//                 sent.
//
// 🔴 THE REASON HAS TWO SOURCES, AND THEY ARE NOT THE SAME KIND OF FACT (C9,
// 2026-08-17). One is RECORDED — `room/pc-absence.ts` is a table a watchdog and
// a refusal gate write into. The other is DERIVED here, at read time, from rows
// that were never about this pairing: `machine_reassigned` asks whether the
// physical machine behind this row is in a room right now under a DIFFERENT
// account. Keeping them separate is deliberate; the derived one has no write
// site and must not become a member of the stored set (the argument is at
// `MACHINE_REASSIGNED_REASON`).
// Nothing else. No device name, no user id, no room_uuid — a token buys the one
// bit it asked for, plus (when there is one) the reason behind that bit, and not
// an inventory.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RateGate } from '../error-handling';
import { log } from '../log';
import type { Registry } from '../room/registry';
import type { RoomStore } from '../room/store';
import type { PcRepo } from '../db/repos/pc.repo';
import { pcAbsenceReasons } from '../room/pc-absence';
import type { PcAbsentReason } from '../room/pc-absence';
import {
  MACHINE_REASSIGNED_REASON,
  isMachineServingAnotherAccount,
} from '../room/machine-reassigned';
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

/** How often the ABSENT answer may put a line in the log.
 *
 *  A resting instance list polls this route roughly every 10 s per pairing, and
 *  the answer it is polling for is 「still not here」 — so an ungated line would
 *  be 6 lines/minute/pairing describing one unchanging fact, which buries the
 *  answers that matter under the answer that does not. Same shape and the same
 *  remedy as `HEARTBEAT_WRITE_FAILURE_LOG_WINDOW_MS`; a longer window because a
 *  PC being away is a state, not an event. */
export const PRESENCE_ABSENT_LOG_WINDOW_MS = 60_000;

/** ONE gate per process, shared across every caller — same reasoning as the
 *  heartbeat handler's: the flood this defends against is 「many phones polling
 *  about many dead PCs」, and per-pairing gates would multiply it right back.
 *  What the sharing costs is stated rather than hidden: the line that survives
 *  names ONE pc_id, and `suppressedSinceLastLine` says how many other absent
 *  answers went unlogged — volume reduced, never volume hidden. The alternative
 *  (a gate per pairing) is an unbounded map keyed by caller-supplied input, i.e.
 *  a second thing to bound. */
const sharedAbsentLogGate = new RateGate(PRESENCE_ABSENT_LOG_WINDOW_MS);

/** The slice of the logger this route needs. Deliberately not `GuardLogger`
 *  (`error`-only): an absent PC is not an error, it is the normal answer to a
 *  normal question — logging it at ERROR would train the reader to ignore it. */
export interface PresenceLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
}

/** A room you can CORRELATE without writing the room id down.
 *
 *  `room_uuid` is the address an inject frame is delivered to, so it does not
 *  belong in a log file in the clear; 12 hex of its sha256 is enough to join two
 *  lines about the same room and useless for addressing one.
 *
 *  🔴 It is exported for exactly ONE other caller — the `pc left its room` line
 *  in `bootstrap.ts`'s disconnect handler. The two lines exist to be read
 *  together (that one says why the PC went away, this one says a phone later
 *  asked and was told it is not there), and two independent 「hash the room」
 *  expressions would join only until one of them was edited. */
export function hashedRoomId(roomUuid: string): string {
  return createHash('sha256').update(roomUuid).digest('hex').slice(0, 12);
}

/** What may appear in `pc_absent_reason` on the wire: the RECORDED set plus the
 *  one reason this route DERIVES. A union rather than one enum because the two
 *  halves have different lifetimes — see the header. */
export type PcAbsentWireReason = PcAbsentReason | typeof MACHINE_REASSIGNED_REASON;

export interface PresenceRoutesDeps {
  /** Typed as a slice of the real Registry so there is no second interface to
   *  drift from it. `findPairingByToken` is the PURE lookup (no last_seen_at). */
  registry: Pick<Registry, 'findPairingByToken'>;
  /** Live room presence — the same instance the socket handlers mutate. */
  store: Pick<RoomStore, 'getPc'>;
  /** C9 — the ONE cross-account read this route makes, and it is READ-ONLY:
   *  「is this machine in a room under another account right now」
   *  (room/machine-reassigned.ts owns the question and the disclosure argument).
   *
   *  🔴 REQUIRED, not optional, and that is the whole wiring guarantee. Every
   *  other dep on this surface documents what its absence means because absence
   *  is a legitimate deployment shape there; here it is not — a relay that
   *  answered presence without this slice would answer 「offline」 to exactly the
   *  phones this card exists for, and nothing would say so. This repo's #1
   *  historical defect is a capability defined and never called, and an optional
   *  dep with a friendly fallback is how one is built. The compiler is the gate:
   *  bootstrap cannot construct these deps without supplying it. */
  pcs: Pick<PcRepo, 'listByMachineUidOtherUsers'>;
  /** Forensic seams. Defaults are the REAL logger and the REAL shared gate —
   *  never no-ops (DI-default rule: a friendly empty implementation is how a
   *  capability ends up wired to nothing). */
  logger?: PresenceLogger;
  absentLogGate?: RateGate;
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
  //
  // 🔴 C9 — REASSIGNMENT OUTRANKS A RECORDED REASON, and the order is a product
  // decision rather than a preference. Both can be true at once: the account
  // this row belongs to may well have had its cloud sign-in lapse BEFORE the
  // machine was signed into another account, leaving an `auth_expired` entry
  // that is still perfectly accurate about a row nobody will ever use again.
  // Answering with it would send the user to re-enter a Cloud Key for the OLD
  // account on a machine that is currently working under the new one — an
  // instruction that is not merely useless but would displace the account
  // actually in use. `machine_reassigned` is the one of the two whose action
  // ("pair again") is right.
  const absentReason: PcAbsentWireReason | null = online
    ? null
    : isMachineServingAnotherAccount({ pcs: deps.pcs, store: deps.store }, pc)
      ? MACHINE_REASSIGNED_REASON
      : pcAbsenceReasons.reasonFor(pc);
  if (!online) {
    // ONLY the absent answer gets a line. The online path carries no information
    // — it is the expected state, it is the overwhelming majority of the traffic,
    // and logging it would be the surest way to make this file unreadable on the
    // day someone actually needs it.
    //
    // `absent_reason` is the field the line exists for. Without it the record
    // says 「a phone asked about a PC that is not here」, which is precisely what
    // the caller already knew; with it, an absence is ATTRIBUTABLE after the fact
    // ('auth_expired' is a different incident from a machine someone switched
    // off, and today they are indistinguishable in every server-side artefact).
    // 'none' rather than an omitted key: 「we recorded no reason」 is an answer,
    // and a missing key would read as 「this line predates the field」.
    //
    // No `timestamp` field on purpose: `log.ts` stamps every line with an ISO
    // prefix, and a second copy inside the fields would be a second answer to
    // one question — the shape this repo keeps paying for.
    const suppressed = (deps.absentLogGate ?? sharedAbsentLogGate).tryAcquire();
    if (suppressed !== null) {
      (deps.logger ?? log).info('presence: PC is not in its room', {
        pc_id: pc.id,
        room: hashedRoomId(pc.room_uuid),
        absent_reason: absentReason ?? 'none',
        suppressedSinceLastLine: suppressed,
      });
    }
  }
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
