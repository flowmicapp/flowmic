// SPEC-REF: apps/server-core/src/socket/handlers/mobile.handler.ts (the ONE
//   caller of both functions here — `mobile:pair` / `mobile:reconnect`).
//
// MOVED OUT OF mobile.handler.ts VERBATIM (2026-09-02, WP-6) for the 800-line
// `file-size` lint, the same cap `pc.handler.ts`/`bootstrap-http-deps.ts` keep
// bumping against — no behaviour moved with the code. It earns its own file for
// a second reason: "who is allowed to occupy this room, and how" is one
// question with two parts (may a socket take the slot at all, and once it
// does, what does taking it announce), and having both parts named together is
// what makes `liveContender` and `joinAndNotify` legible as one concern rather
// than two functions that happen to sit near each other.

import type { Socket } from 'socket.io';
import type { RoomStore } from '../../room/store';

/**
 * A12/F2-b (2026-09-02, WP-6) — SERVER-AUTHORED CONTENTION.
 *
 * 「Is a DIFFERENT pairing already holding a live socket in this room?」 The
 * roster (`RoomStore`) has always known the answer; until now nothing asked it
 * before admitting a second phone. `PC_BUSY` had NO server author — the only
 * way it was ever produced was the PC noticing a second `pc:mobile-joined`,
 * refusing in its own `Admission` FSM, and calling `pc:release-mobile{busy}`
 * to evict the loser AFTER the fact. On a replica, before WP-6's generic
 * handoff (`forwardReleaseMobile`), that release call was itself refused
 * (`NODE_IS_REPLICA`) — so the eviction never happened, no suppression window
 * was ever built, and the second phone stayed in the room indefinitely: every
 * mirrored frame answered `INJECT_NOT_PRIMARY`, every item sat at 「待投递」
 * forever, and no banner ever explained why.
 *
 * Judging it HERE, before either verb ever calls `joinAndNotify`, closes that
 * gap at its root rather than patching the eviction path a second way: a
 * contended phone never enters `mobileSockets`, so there is no `pc:mobile-left`
 * to forget, no corpse to linger through the GA-04 grace, and no dependency on
 * the PC (or a working forward to the writer) to notice and evict it.
 *
 * A LIVE contender only — `sock.connected`, not merely `store.getMobile`
 * returning non-null. A displaced/dead socket the GA-04 grace has not yet
 * pruned must NOT count: that corpse is not occupying anything, and refusing
 * a genuine reconnect because of it would be the exact defect
 * `capsule-single-holder.test.ts` was built to catch, aimed at a phone that
 * did nothing wrong.
 *
 * Excludes `thisPairingId` itself: the SAME phone re-joining (a reconnect, a
 * re-pair of the same handset) is not a second phone — `joinAndNotify`'s own
 * header states this rule for the announce boolean, and this is the same rule
 * one layer earlier, for whether the phone is admitted at all.
 */
export function liveContender(store: RoomStore<Socket>, roomUuid: string, thisPairingId: string): string | null {
  for (const id of store.snapshot(roomUuid)?.mobile_ids ?? []) {
    if (id === thisPairingId) continue;
    if (store.getMobile(roomUuid, id)?.connected) return id;
  }
  return null;
}

/**
 * Put this socket in the room AS this pairing, then answer TWO independent
 * questions with TWO named booleans — never one value for both:
 *
 *   needsJoinAnnounce — should the PC hear `pc:mobile-joined`?
 *                    Whenever a socket TAKES THE SLOT: a first arrival
 *                    (`previous === null`) or a same-pairing socket SWAP.
 *   needsFocusSeed — should THIS socket hear the room's last `focus:state`?
 *                    Yes for every new socket: it has never been on the wire,
 *                    so a CHANGE-only mirror would leave its header blank until
 *                    the user happens to alt-tab (A-1 / owner 2026-07-29).
 *
 * The bug that made A-1: the early-return on `previous !== null` answered
 * needsFocusSeed with the announce question's answer. Silent reconnect (EMUI /
 * WiFi↔4G) then left the phone's destination as `—` for the whole session.
 *
 * 🔴 fix-001 (P0 red line "the capsule allows only one phone") — THE SAME COLLAPSE, A THIRD TIME, and
 * this one had a red line on it. The announce boolean used to be `isNewPresence`
 * = `previous === null`, i.e. it answered 「is this phone newly PRESENT?」 and was
 * then reused for 「may this SOCKET speak into the capsule?」. Those come apart
 * for exactly one input, and it is the one the owner hit:
 *
 *   1. second phone B joins → announced → the desktop's `Admission` REFUSES it →
 *      `pc:release-mobile{reason:'busy'}` → B suppressed 8 s and disconnected;
 *   2. B's dead socket STAYS in the slot — `leaveMobile` is deferred to the end of
 *      the GA-04 mobile-drop grace (~30 s). Deliberate, and the precondition here;
 *   3. B's ladder returns after the 8 s hold-out but INSIDE that grace ⇒ admitted,
 *      and `previous !== null` (the corpse) ⇒ **no announce** ⇒ the capsule verdict
 *      never runs again. `Admission::join` is reachable from `PC_MOBILE_JOINED` and
 *      from NOWHERE else (presence.rs) — no pull, no poll, no watchdog for this;
 *   4. when the grace expires, `leaveMobile(room, B, OLD_id)` correctly returns
 *      false (GA-26's displaced-socket guard: the slot holds a NEWER socket) ⇒ no
 *      `pc:mobile-left` either.
 *
 * ⇒ B squats on the capsule, invisible to the only layer allowed to refuse it.
 *   Real-device forensics (2026-08-11): `mobiles=2` for EIGHT MINUTES, both phones
 *   on the transcription screen, and the server's `released:1` true the whole time
 *   — it counts 「I closed a socket」, never 「that phone gave up the capsule」.
 *
 * WHY WIDENING IS SAFE, i.e. why GA-26 narrowed the wrong thing: GA-26's actual
 * fix was making the desktop's presence a SET keyed by mobile_id, and its own
 * header says in as many words that 「a duplicate joined (server re-announced a
 * reconnecting phone)」 is thereby harmless — `Reconciler::on_join` is an
 * idempotent insert, and `Admission::join` GRANTS the holder re-joining
 * (admission.rs, 「The SAME phone re-joining (a reconnect) is not a second
 * phone」). The desktop was hardened for this frame; suppressing it here bought
 * nothing and cost the verdict.
 *
 * 🔴 2026-09-02 (WP-6) — THIS SPECIFIC SQUATTING SEQUENCE CAN NO LONGER OCCUR
 * for a genuinely NEW second phone: `liveContender` above refuses it BEFORE
 * step 1 (no `pc:mobile-joined`, no room entry, no corpse). It stays true and
 * load-bearing for the case this function alone still owns — a phone
 * legitimately RETURNING to its OWN slot on a new socket (silent reconnect,
 * the exact scenario A-1 was about) — which is precisely why the function
 * (and this whole history) is not deleted, only no longer the last line of
 * defense against a second HANDSET. `capsule-single-holder.test.ts` has the
 * full account, both what changed and what is still pinned unchanged.
 *
 * Scope: a socket swap is per-server, so this cannot make a phone refuse ITSELF
 * across channels — the two channels are two servers with two RoomStores, and a
 * same-channel swap always lands on `Admission`'s Granted arm.
 *
 * The displaced socket is dropped here as well — one live link per pairing —
 * so it can neither be probed as alive (GA-07) nor speak into the room.
 */
export function joinAndNotify(
  store: RoomStore<Socket>,
  roomUuid: string,
  mobile: { id: string; mobile_name: string },
  socket: Socket,
): void {
  const { previous } = store.joinMobile(roomUuid, mobile.id, socket);
  // Named separately on purpose — do not collapse these into one boolean again.
  // 「Took the slot」, NOT 「is newly present」 — see the header: the capsule verdict
  // is a question about THIS SOCKET, and the difference is the P0 red line.
  const needsJoinAnnounce = previous === null || previous.id !== socket.id;
  const needsFocusSeed = true; // every fresh socket; independent of presence

  if (previous !== null && previous.id !== socket.id) {
    previous.disconnect(true);
  }

  if (needsJoinAnnounce) {
    const pc = store.getPc(roomUuid);
    pc?.emit('pc:mobile-joined', {
      mobile_id: mobile.id,
      mobile_name: mobile.mobile_name,
      room_uuid: roomUuid,
    });
  }

  if (needsFocusSeed) {
    // 2026-07-29 (owner: "the PC capsule shows the focus window, but it doesn't
    // show above the phone's transcription screen — only appears after exiting
    // and reconnecting"): `focus:state` is a CHANGE-only mirror, so a phone that arrives
    // (or re-arrives on a new socket) between two foreground switches never
    // learns the focus that is already true. The server replays what it holds
    // on the SAME event — no new protocol, no PC/phone build. "Pushed state must
    // also be pullable" — 0.2.x wrap-up §8-2.
    const focus = store.getLastFocus(roomUuid);
    if (focus) socket.emit('focus:state', focus);
  }
}
