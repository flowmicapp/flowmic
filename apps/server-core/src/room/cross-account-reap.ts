// card ACC-1 (2026-08-15) — one machine, two accounts, stranded phones.
//
// A machine registering under a NEW account makes the SAME machine's rows under
// other accounts describe a PC that cannot come back: the desktop app is
// single-account, and 「the destination is a MACHINE」 is the queue-addressing
// ruling (docs/decisions/2026-07-31-queue-destination-is-a-machine-not-a-
// connection.md). Measured stranding on the relay that day (journal
// 11:06→11:17): owner signed the desktop into a fresh account (new pc_id
// `e4171936`, new room); the tablet stayed legitimately re-admitted into the
// OLD room `c7dddf71`, and every utterance ended `relay: inject:request but no
// PC in room` — answered, queued, and waiting for a PC whose return was
// impossible. Nothing anywhere could ever tell it to stop waiting.
//
// The reap REVOKES those siblings' pairings — not release: release means
// 「pause, come back」, and the whole finding is that coming back is impossible.
// Revocation is what the phone already knows how to render (0.2.51: the
// handshake refusal becomes 「电脑上已取消这台手机的配对，请重新配对连接」), so
// the stranded wait turns into a one-scan re-pair.

import type { PcRepo } from '../db/repos/pc.repo';
import type { MobileRepo } from '../db/repos/mobile.repo';

export interface DisplacedRoom {
  room_uuid: string;
  pairing_ids: string[];
}

/**
 * Revoke every pairing on this machine's rows under accounts other than
 * `keep_user_id`, and report which rooms lost them so the HANDLER can eject any
 * live sockets (this layer holds no sockets). Ejection must come AFTER this
 * revoke, so the phone ladder's reconnect meets a dead token, not a re-admit.
 *
 * ⚠️ Called from `registerPc`'s handler only, deliberately never from
 * `reconnectPc`: a reconnect proves possession of a live token under the SAME
 * account and displaces nobody. Only a REGISTRATION (a sign-in) states 「this
 * machine now serves this account」.
 */
export function reapCrossAccountSiblings(
  deps: { pcs: PcRepo; mobiles: MobileRepo },
  machine_uid: string | undefined,
  keep_user_id: string,
): DisplacedRoom[] {
  if (!machine_uid) return [];
  const displaced: DisplacedRoom[] = [];
  for (const sibling of deps.pcs.listByMachineUidOtherUsers(machine_uid, keep_user_id)) {
    const pairings = deps.mobiles.listByPc(sibling.id);
    if (pairings.length === 0) continue;
    for (const m of pairings) deps.mobiles.remove(m.id);
    displaced.push({ room_uuid: sibling.room_uuid, pairing_ids: pairings.map((m) => m.id) });
  }
  return displaced;
}
