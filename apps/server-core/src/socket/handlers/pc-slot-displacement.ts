// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:register / pc:reconnect)
//   ./pc.handler.ts (the ONE caller — both pairing legs call this)
//   ./mobile.handler.ts `joinAndNotify` (the byte-for-byte sibling on the phone leg)
//
// The displaced-PC close. Moved out of pc.handler.ts VERBATIM (2026-09-08, merge
// of cards S2-01 + S2-02 pushed that file past the 800-line `file-size` cap) —
// not one character of the reasoning below moved with it, and no behaviour did
// either: it was a closure over nothing, so lifting it out is a pure relocation.
// It keeps its name so both call sites read exactly as they did.

import type { Socket } from 'socket.io';
import { log } from '../../log';

// F-3 Fix#2 — CONSUME `joinPc`'s `previous`. Both legs below used to throw it
// away, and that discard IS the defect: `RoomStore.joinPc` REPLACES the room's
// PC slot, so the socket it hands back is left connected, authenticated, and
// permanently deaf — every frame addressed to the room now goes to the new
// owner, and nothing will ever be addressed to it again. W9 experiment (A)
// measured that state 6/6 (last registrant owns the room; the loser stays
// alive). It is the server half of F-3: the desktop's devices page says
// "no phone connected currently" while a phone is connected and text is landing.
//
// WHY A DISCONNECT AND NOT A LOG OR A NEW EVENT — the three candidates:
//   · log only: nothing the peer can act on ever changes. That is F-3's OWN
//     shape (the desktop already writes 「No further CONNECTION frames will
//     reach the UI」 and nobody consumes it); repeating it one layer up would
//     produce a second sentence nobody reads.
//   · a 「you were displaced」 event: needs a protocol slot (owner gate), and an
//     unregistered event name is SILENTLY DISCARDED by every desktop already in
//     the field — so it would change nothing out there for months.
//   · a transport close: a true statement on the wire we already have — 「this
//     link is over」. `connected === true` on a deaf socket is the lie; closing
//     it makes the transport agree with the room. The peer's reconnect ladder
//     and its RV-26 register watchdog are exactly the machinery already shipped
//     to act on that fact, on every desktop version in the field.
// It is also byte-for-byte what the MOBILE leg has done with the identical
// `previous`, from the identical store, since GA-26 (mobile.handler
// `joinAndNotify`): "the same fact handled two different ways" is a shape this repo has paid for.
//
// THE TWO LEGS DO NOT DIFFER, and that was checked rather than assumed. Both
// resolve ONE pc_devices row (register by client_instance_id/machine_uid,
// reconnect by token) and both join THAT row's room_uuid, so `previous` is
// always an older session of the SAME machine in both. The one asymmetry —
// registerPc may have just ROTATED device_token, leaving the displaced socket
// holding a dead credential — argues for the same action, harder. So: ONE
// implementation, called from both, for the reason `confirmedMobiles` above
// gives verbatim — 0.2.1 shipped two copies of "what is this PC called" and only one
// ever got fixed.
//
// 🔴 `previous.id === socket.id` IS NOT A DISPLACEMENT. A second register on
// ONE live socket (the RV-26 register watchdog re-firing, or register followed
// by reconnect on the same connection) would otherwise kill the very session
// just admitted — before its ack was sent. Same guard as the mobile leg.
//
// FAILURE DIRECTION: never throws, and never reaches the caller's `try` — that
// one answers the ack, and a failed disconnect must not turn a successful
// registration into an error ack. If this whole function were skipped, the
// result is exactly today's behaviour, which is the bar.
//
// KNOWN RESIDUAL (recorded, deliberately NOT given an invented recovery path):
// if TWO genuinely live desktop sessions ever share one pc row, each will
// reconnect and re-register, and they will trade the slot — the 「endless
// re-register ping-pong」 registry.ts already names as the reason machine_uid
// folds in the Windows user. Not observed; the log line below is its evidence (the
// same two socket ids alternating at speed).
export const dropDisplacedPc = (roomUuid: string, previous: Socket | null, current: Socket): void => {
  if (previous === null || previous.id === current.id) return;
  try {
    log.warn('pc slot displaced — closing the previous session', {
      room_uuid: roomUuid,
      previous_socket_id: previous.id,
      socket_id: current.id,
    });
    previous.disconnect(true);
  } catch (err) {
    log.error('pc slot displacement: disconnect failed', { room_uuid: roomUuid, err: String(err) });
  }
};
