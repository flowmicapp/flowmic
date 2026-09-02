// SPEC-REF:
//   src/bootstrap.ts (the ONE caller, per-connection `socket.on('disconnect', …)`)
//   docs/rebuild/18-CONNECTION-STATES-THREE-ENDS.md §7.3 (absence reason)
//
// 2026-09-02 — MOVED VERBATIM out of bootstrap.ts's connection handler, which
// crossed the 800-line cap (file-size lint) while B8/F3 added the presence
// forward this file's PC branch now carries. Every comment below travelled
// with the code it explains; nothing about the behaviour changed by this move.
//
// One socket's `disconnect` event, for BOTH kinds this process ever admits:
//  · a PC's socket closing — attribute the absence, and (F-3 Fix#2) only write
//    `is_online=false` when THIS socket was the room's PC, never for a socket
//    a newer session already displaced;
//  · a phone's socket closing — GA-04's grace window, collapsed early (GA-26)
//    when the phone said it was leaving on purpose.

import type { Socket } from 'socket.io';
import type { RoomStore } from '../../room/store';
import type { PcRepo } from '../../db/repos/pc.repo';
import { hashedRoomId } from '../../http/presence-routes';
import { log } from '../../log';
import {
  type AudioSessionRegistry,
  audioSessionKey,
  isDeliberateLeave,
  mobileLeftOnGraceExpiry,
} from '../../engine/audio-registry';

export interface DisconnectHandlerDeps {
  store: RoomStore<Socket>;
  pcs: PcRepo;
  audioRegistry: AudioSessionRegistry;
  /** REPLICA ONLY — forward `is_online:false` the same way the heartbeat
   *  handler forwards `true` (B8/F3, node/node-runtime.ts `stampPresence`).
   *  `null`/absent on the writer and every single-node deployment, where the
   *  local `pcs.setOnline(id, false)` write two lines up is already the truth. */
  stampPresence?: ((pcId: string, isOnline: boolean, lastSeenAtMs: number) => void) | null;
}

/** Build the `disconnect` listener for one socket. Bound per-connection in
 *  bootstrap.ts (`socket.on('disconnect', makeDisconnectHandler(deps))`),
 *  exactly like every other handler registered there. */
export function makeDisconnectHandler(socket: Socket, deps: DisconnectHandlerDeps): (reason: string) => void {
  const { store, pcs, audioRegistry } = deps;
  return (reason: string): void => {
    const roomUuid = (socket.data as { roomUuid?: string }).roomUuid;
    const auth = (socket.data as { auth?: { kind: string; deviceId?: string; pairingId?: string } | null }).auth;
    if (!roomUuid || !auth) return;
    if (auth.kind === 'pc') {
      // F-3 Fix#2 — the offline WRITE follows leavePc's socket_id VERDICT, not
      // the bare fact that a PC socket closed. `leavePc` returns false when this
      // socket was no longer the room's PC, i.e. it had already been displaced by
      // a NEWER session — and `auth.deviceId` is that same pc_devices row, so an
      // unconditional write here marks a machine that is live right now as
      // offline (read by /api/cloud/devices and by the reaper's staleness gate).
      // The mobile branch below has followed leaveMobile's socket_id verdict
      // since GA-26 for exactly this reason; this branch never did.
      // Pre-existing, not introduced by Fix#2: an ordinary reconnect already hit
      // this ~20 s later when the old socket's pingTimeout expired. Fix#2 closes
      // the displaced socket immediately, which would have made it deterministic.
      const leftItsRoom = store.leavePc(roomUuid, socket.id);
      // 🔴 The one line that can attribute a PC's absence AFTER THE FACT, and the
      // only place in the process that holds both halves of it:
      //   · `reason` is socket.io's own verdict on WHY this socket went away, and
      //     the distinction it carries is the one support work always needs —
      //     'client namespace disconnect' (the desktop chose to leave) vs
      //     'ping timeout' / 'transport close' (the network took it). Nothing
      //     downstream keeps that: the room map only learns that the PC is gone,
      //     and `pc_devices.is_online` is one bit with no cause attached.
      //   · `left_room` is `leavePc`'s socket_id VERDICT (F-3 Fix#2 above), so a
      //     `false` here says 「this was a DISPLACED socket, the machine is live
      //     right now」 — which is exactly the line that stops the next reader
      //     from concluding a healthy PC went offline.
      // Counts/ids/verdicts only: no window titles, no transcripts, no tokens,
      // and the room travels as a digest (`hashedRoomId`, whose other caller is
      // the presence route — the two lines are meant to be joined).
      log.info('pc left its room', {
        pc_id: auth.deviceId ?? null,
        room: hashedRoomId(roomUuid),
        reason,
        left_room: leftItsRoom,
      });
      if (leftItsRoom) {
        pcs.setOnline(auth.deviceId ?? '', false);
        // B8/F3: the `false` counterpart of the heartbeat's forwarded `true`.
        deps.stampPresence?.(auth.deviceId ?? '', false, Date.now());
      }
    } else if (auth.kind === 'mobile' && auth.pairingId) {
      // GA-04: a mobile drop is NOT a departure yet. Defer the room-leave and
      // the pc:mobile-left announcement to the end of the audio grace window
      // (AUDIO_DEFAULTS.mobile_drop_grace_ms) — a phone back inside 30 s
      // resumes its session and the PC never learns it was away. The audio
      // handler arms the same window for the session half; beginGrace is
      // idempotent per drop, so this only appends the presence callback.
      // GA-26's discriminator lives on inside mobileLeftOnGraceExpiry: the
      // announcement follows leaveMobile's socket_id verdict, so a displaced
      // socket never deletes a live phone from the desktop's presence set.
      const key = audioSessionKey(roomUuid, auth.pairingId);
      audioRegistry.beginGrace(
        key,
        mobileLeftOnGraceExpiry({ store, roomUuid, pairingId: auth.pairingId, socketId: socket.id }),
        socket.id,
      );
      // …unless the phone said it was leaving. Backing out to the connection
      // list calls socket.disconnect() → `client namespace disconnect`, which
      // is a departure, not a brief flicker: collapse the window so the PC's
      // capsule retreats on the same gesture (owner 2026-07-27: it lingered ~30 s).
      if (isDeliberateLeave(reason)) audioRegistry.expireGraceNow(key);
    }
  };
}
