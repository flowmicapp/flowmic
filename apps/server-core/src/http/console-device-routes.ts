// SPEC-REF:
//   docs/strategy/2026-08-28-console-device-management-redesign.md (the survey
//     this surface was cut from — §1 measures what the console could do before)
//   docs/decisions/2026-08-28-owner-web-rulings-console-device-management.md
//     (owner's 9 + 4 rulings; §5-1 presence, §5-2 immediate revoke, §5-3 PCID)
//   docs/strategy/2026-08-05-it03-delete-this-pc-design.md (the original design;
//     its four drifts are listed in the survey above and are corrected here)
//   docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md (the ceiling this
//     surface is the escape hatch from)
//   docs/decisions/2026-08-01-idle-pc-presence-poll-interval.md (the 10 s poll)
//   docs/decisions/2026-08-20-owner-pc-initiated-disconnect-is-terminal.md
//     (say it before closing the door — why revoke emits before it disconnects)
//   *** HUMAN-AUDIT SENSITIVE (auth: device/pairing revocation + row deletion,
//       and the ONLY console route family that can touch a live socket)
//       — reviewable in isolation ***
//
// The device-management WRITE surface: revoke one pairing, remove one computer.
//
// ── WHY THIS IS ITS OWN FILE ───────────────────────────────────────────────
// Not the 800-line cap (console-routes.ts has room). These two routes are the
// only ones in the console family that reach past the database and touch a live
// connection, and the 2026-08-12 substitute for the old pre-merge human gate
// asks that such a change be separately grep-able and separately revertible.
// A reader who wants to know "what can the console do to a running session"
// should find one file, not a paragraph inside a router.
//
// ── THE ONE THING THAT MUST NOT DRIFT ──────────────────────────────────────
// "Is this computer here right now" has ONE author, and it is no longer in this
// file: `pcPresence()` moved VERBATIM to room/pc-presence.ts, which states the
// rule and lists every surface that asks it. The remove route below is one of
// those surfaces; the console's GET projection (console-routes.ts `is_present`)
// is another, and the two must never compute presence separately or the user
// gets either a disabled button that would have worked or an enabled one that
// is refused.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthService } from '../auth/auth-service';
import type { MobileRepo } from '../db/repos/mobile.repo';
import type { PcRecord, PcRepo } from '../db/repos/pc.repo';
import type { RoomSocketLike } from '../room/store';
import { isRealPc } from '../room/registry';
import { accountFromBearer, type UserIdVerdict } from './account-auth';
import { restrictionRefusalBody, restrictionVerdict } from '../auth/account-restriction';
import { EMAIL_NOT_VERIFIED, isEmailVerified, type EmailVerifiedReader } from '../auth/email-verification';
import { readJsonBody, sendJson, str } from './console-http';
import { log } from '../log';
import { pcPresence } from '../room/pc-presence';

/**
 * A socket, as far as this file is concerned: something that can be told one
 * thing and then closed. Narrower than socket.io's `Socket` on purpose — see
 * `RoomLookup` below for why the narrowing is the point rather than tidiness.
 */
export interface EvictableSocket extends RoomSocketLike {
  emit(event: string, payload: unknown): void;
  disconnect(close?: boolean): void;
}

/**
 * 🔴 THE READ-ONLY HALF of the room store, and this file takes nothing more.
 *
 * `RoomStore` can also join and leave rooms. Nothing here has any business doing
 * that — membership is the socket handlers' to write — and a dependency typed as
 * the whole class would hand a console request the ability to put something INTO
 * a room, which is a capability no reviewer of this surface should have to rule
 * out by reading the body. Two lookups is the entire contract.
 *
 * The production `RoomStore<Socket>` satisfies this structurally, so bootstrap
 * passes the real instance unchanged and there is still exactly one store.
 * Being return-position only, it also lets a test hand over a store of fake
 * sockets without a cast — which matters more than it looks: a cast is where a
 * test stops proving things about the type the production code actually gets.
 */
export interface RoomLookup {
  getPc(room_uuid: string): EvictableSocket | null;
  getMobile(room_uuid: string, mobile_id: string): EvictableSocket | null;
}

export interface ConsoleDeviceRoutesDeps {
  auth: AuthService;
  pcs: PcRepo;
  mobiles: MobileRepo;
  verifiedEmail: EmailVerifiedReader;
  /**
   * 🔴 THE DEPENDENCY THAT CHANGES WHAT THIS FILE IS. Every other console route
   * reads and writes rows; with this one, a console request can close somebody's
   * socket. It is the SAME store instance the socket handlers hold — the answer
   * to "is that PC in its room" must not have a second implementation (the
   * expression is already named as the answer in bootstrap-http-deps.ts and in
   * http/presence-routes.ts).
   *
   * REQUIRED, no `?` and no default (book 13 §7 F1 ②): an optional store would
   * let a bootstrap missing one line still mount these routes, which would then
   * delete rows and silently skip every eviction — a revoke that answers ok
   * while the evicted phone keeps injecting. Making it required turns that
   * omission into a compile error at the one object literal that has to change.
   *
   * ⚠️ NOT `io`. The socket.io Server is deliberately NOT a dependency here:
   * `store.getMobile()` / `store.getPc()` hand back the sockets themselves, which
   * is all an eviction needs, and pc.handler.ts's revoke path does exactly this.
   * Taking `io` would hand this file the whole broadcast surface to answer a
   * question that needs two map lookups.
   */
  store: RoomLookup;
  /**
   * This relay node's own id, so `pcPresence` can tell a PC that lives HERE from
   * one that lives on another node. Absent means single-node — where `home_node`
   * is null on every row, the remote branch never runs, and behaviour is exactly
   * what it was. The `stampHomeNode` precedent: absent is「there is no such fact」,
   * never「skip it」.
   */
  nodeId?: string | null;
  now?: () => number;
}

function authUser(req: IncomingMessage, deps: ConsoleDeviceRoutesDeps): UserIdVerdict {
  return accountFromBearer(req, deps.auth);
}

function refuseUnverified(res: ServerResponse, deps: ConsoleDeviceRoutesDeps, userId: string): boolean {
  if (isEmailVerified(deps.verifiedEmail.emailVerifiedAt(userId))) return false;
  sendJson(res, 403, { error: EMAIL_NOT_VERIFIED });
  return true;
}

function refuseRestricted(res: ServerResponse, deps: ConsoleDeviceRoutesDeps, userId: string): boolean {
  const verdict = restrictionVerdict(deps.auth, userId);
  if (verdict === null) return false;
  sendJson(res, 403, restrictionRefusalBody(verdict.reason));
  return true;
}

/**
 * Evict one pairing: tell the phone WHY, then close the socket.
 *
 * Order is the delivery (pc.handler.ts states this at its own call site):
 * socket.io drops anything queued on a closed socket, so the emit has to precede
 * the disconnect or the phone learns nothing.
 *
 * `retry_after_ms: 0` with `revoked: true` — there is no window to wait out
 * because the row is gone. The phone reads `revoked` rather than a magic zero,
 * and its existing handler renders 「电脑上已取消这台手机的配对，请重新配对连接」
 * and returns to the instance list (chat_flow_exits.dart). NO PHONE CHANGE is
 * needed for any of this: the event, its schema and its copy all shipped with
 * the PC-initiated revoke on 2026-08-20. This route is only becoming the second
 * caller of a path the phone already knows.
 */
function evictPairing(
  store: RoomLookup,
  room_uuid: string,
  pairing_id: string,
): boolean {
  const sock = store.getMobile(room_uuid, pairing_id);
  if (!sock) return false;
  sock.emit('mobile:released', { retry_after_ms: 0, revoked: true });
  sock.disconnect(true);
  return true;
}

/** Handle the console's device-management writes. Returns true iff it owned the
 *  request. Mounted from console-routes.ts, so the saas-only gating and the
 *  404-in-standalone answer are unchanged. */
export function tryHandleConsoleDeviceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConsoleDeviceRoutesDeps,
): boolean {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';
  const now = deps.now ?? Date.now;

  // ── POST /api/cloud/devices/revoke — revoke ONE mobile pairing ────────────
  //
  // IDEMPOTENT: revoking a missing pairing (already gone / never existed / not
  // owned by the caller) returns ok:true, revoked:false — a truthful "nothing of
  // yours was revoked", NOT a silent failure, and NOT an existence oracle (a
  // pairing you don't own is indistinguishable from one that doesn't exist).
  //
  // 🔴 CHANGED 2026-08-28 (owner §5-2): this used to be the delete and nothing
  // else. The row went away and the phone was told nothing, so until it happened
  // to reconnect it kept a live session — and in that window the SAME handset got
  // two different answers, because socket injection reads the cached
  // `socket.data.auth` (relay.handler.ts) while the HTTP image ingress re-checks
  // the pairing row on every request (inject-routes.ts) and started answering
  // 401. Text kept landing; pictures had already stopped. The eviction below
  // closes that window and makes this verb mean the same thing here as it does on
  // the PC's own device page.
  if (url === '/api/cloud/devices/revoke' && method === 'POST') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true;
    if (refuseUnverified(res, deps, who.userId)) return true;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const pairingId = str(body.pairing_id);
      if (pairingId === '') {
        return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: 'pairing_id required' });
      }
      const mobile = deps.mobiles.findById(pairingId);
      const pc = mobile ? deps.pcs.findById(mobile.pc_device_id) : null;
      const owned = !!mobile && !!pc && pc.user_id === who.userId;
      let evicted = false;
      if (owned && pc) {
        // Delete FIRST, evict SECOND. The phone's reconnect ladder must meet a
        // dead token rather than a re-admittable one — the same ordering
        // cross-account-reap.ts spells out for the same reason.
        deps.mobiles.remove(pairingId);
        evicted = evictPairing(deps.store, pc.room_uuid, pairingId);
      }
      log.info('console: devices/revoke', { user_id: who.userId, revoked: owned, evicted });
      sendJson(res, 200, { ok: true, revoked: owned, evicted });
    })();
    return true;
  }

  // ── POST /api/cloud/devices/remove-pc — free one PC slot ──────────────────
  //
  // THE ESCAPE HATCH. `PcRepo.remove` has carried a comment naming "an HTTP
  // route, or the reaper" as its callers since D11; both were fiction until this
  // line, so a user who filled the free tier's 2 machines by reinstalling Windows
  // had no way off the ceiling except paying. `room/registry.ts` recomputes the
  // count fresh on every registration (`listByUser(...).filter(isRealPc)`, no
  // cache), so a row deleted here is a slot free on the very next connect.
  //
  // ANSWERS, not error codes. Like the revoke above, the refusals are domain
  // answers on a 200: `{ok:true, removed:false, reason}`. That is deliberate and
  // it is not laziness about error handling — minting a protocol error code is an
  // owner gate (CLAUDE.md), and none of the three reasons below is a protocol
  // failure. The request was well-formed and authorised in every case; the
  // account's state is what refuses.
  //
  //   · `not_found`      — no such row, or not yours. ONE reason for both, byte-
  //                        identical, so this is not an enumeration oracle.
  //   · `present`        — the computer is in its room right now (owner ruling
  //                        2026-08-28 §2: block, do not merely warn).
  //   · `cloud_instance` — the virtual relay row. It is not a machine, takes no
  //                        plan slot, and admission re-creates it immediately, so
  //                        removing it would be a button that appears to work and
  //                        changes nothing.
  if (url === '/api/cloud/devices/remove-pc' && method === 'POST') {
    const who = authUser(req, deps);
    if (!who.ok) {
      sendJson(res, 401, { error: who.error });
      return true;
    }
    if (refuseRestricted(res, deps, who.userId)) return true;
    if (refuseUnverified(res, deps, who.userId)) return true;
    void (async (): Promise<void> => {
      const body = await readJsonBody(req);
      const pcId = str(body.pc_id);
      if (pcId === '') {
        return sendJson(res, 400, { error: 'SETTINGS_SCHEMA_INVALID', message: 'pc_id required' });
      }
      const pc = deps.pcs.findById(pcId);
      if (!pc || pc.user_id !== who.userId) {
        return sendJson(res, 200, { ok: true, removed: false, reason: 'not_found' });
      }
      if (!isRealPc(pc)) {
        return sendJson(res, 200, { ok: true, removed: false, reason: 'cloud_instance' });
      }
      // 🔴 The SAME function the GET projection used to enable this button. The
      // browser's copy of the answer is by definition older than this one, so
      // this check is not a duplicate of the disabled state — it is the race
      // window between the page's last poll and the click.
      if (pcPresence(deps.store, pc, now(), deps.nodeId ?? null)) {
        return sendJson(res, 200, { ok: true, removed: false, reason: 'present' });
      }

      // Read the pairings BEFORE the delete: `mobile_pairings.pc_device_id`
      // references `pc_devices(id) ON DELETE CASCADE` with foreign keys actually
      // enabled on this connection (db/connection.ts + schema.ts), so after the
      // next line there is nothing left to enumerate.
      const pairings = deps.mobiles.listByPc(pc.id).map((m) => m.id);
      deps.pcs.remove(pc.id);

      // Evict AFTER the rows are gone, same ordering argument as the revoke.
      let evicted = 0;
      for (const pairingId of pairings) {
        if (evictPairing(deps.store, pc.room_uuid, pairingId)) evicted++;
      }
      // ⚠️ The PC's own socket, if this lost the race with a reconnect. Under the
      // `present` refusal above this is normally unreachable — which is exactly
      // why it is here: "normally unreachable" is not "unreachable", and a PC
      // holding a socket against a deleted row would sit in a room nothing can
      // address. It gets no `mobile:released`; that event is the phone's, and
      // inventing a PC-shaped variant would be a new protocol surface for a race.
      const pcSocket = deps.store.getPc(pc.room_uuid);
      if (pcSocket) pcSocket.disconnect(true);

      log.warn('console: devices/remove-pc', {
        user_id: who.userId,
        pc_id: pc.id,
        pairings: pairings.length,
        evicted,
        raced_pc_socket: pcSocket !== null,
      });
      // ⚠️ A `log.warn`, NOT an `ops_audit_log` row, and the choice is argued
      // rather than forgotten: that table answers "what did OUR OWN operators
      // touch" (its `actor_user_id` is defined as an admin proven by a Bearer,
      // and the admin gate is its only sanctioned writer). A user removing his
      // own computer is not an operator action. account-lifecycle.ts reached the
      // same conclusion for self-service account deletion.
      sendJson(res, 200, { ok: true, removed: true, released: pairings.length, evicted });
    })();
    return true;
  }

  return false;
}
