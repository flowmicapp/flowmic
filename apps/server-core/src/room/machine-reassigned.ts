// card C9 (2026-08-17) — a phone waiting on a room its machine no longer lives in.
//
// SPEC-REF:
//   apps/server-core/src/room/cross-account-reap.ts (card ACC-1 — the WRITE
//     side of this same fact, and the reason it could not reach the incident)
//   apps/server-core/src/http/presence-routes.ts (the one reader)
//   docs/strategy/2026-08-12-sensitive-surface-audit-queue.md row 25
//   *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// ── THE INCIDENT THIS ANSWERS ───────────────────────────────────────────────
// Diagnosed on production 2026-08-17. The phone said 「电脑已离线」 ("the computer
// is offline") while the desktop said it was connected and its room was empty.
// BOTH were telling the truth about DIFFERENT ROOMS: `pc_devices` held NINE rows
// for that one `machine_uid` — one per account that ever registered the machine —
// and the phone's pairing resolved to a row abandoned when the desktop signed
// into a different account (the old row's last heartbeat and the new row's
// creation were 29 seconds apart). `store.getPc(room_uuid)` answered `null`
// correctly. The answer was true and useless: it sent someone to check a machine
// that was powered on, running, and serving somebody else.
//
// 🔴 WHY ACC-1's REAP DID NOT ALREADY COVER THIS, because that is the finding
// that outranks this file. `reapCrossAccountSiblings` exists for exactly this
// stranding and its own header describes this exact incident — but it is called
// ONLY from `socket.on('pc:register')`, and a desktop holding a valid credential
// handshakes with `pc:reconnect` forever after. The machine that generated the
// bug report is the one machine that fix cannot reach: a recovery armed by an
// edge that never comes again (the same family as F-1, 49-3 and the register
// watchdog).
//
// 🔴 AND WHY THE ANSWER IS NOT 「REAP ON RECONNECT TOO」. Two accounts sharing one
// physical machine would then revoke each other's phones on every reconnect —
// strictly worse than the defect. The reap's header states the rule this file
// obeys rather than relaxes: a reconnect proves possession of a live token under
// the SAME account and displaces nobody; only a REGISTRATION states 「this
// machine now serves this account」. So this module WRITES NOTHING. It answers a
// question at read time and leaves every row exactly where it was.
//
// ── WHAT 「LIVE」 MEANS HERE, AND WHY IT IS THE ROOM AND NOT A COLUMN ─────────
// `store.getPc(room_uuid) !== null` — the SAME expression presence itself
// answers with, so 「that machine is here right now, under another account」 and
// 「is my PC here right now」 can never be two different definitions of being in
// a room. Deliberately NOT `is_online` or `last_seen_at`: those are persisted
// flags that outlive the fact they describe (a relay restart drops every room
// and leaves both columns saying 「online」), and a stale flag answering a
// present-tense question is the shape this repo keeps paying for.
//
// ⚠️ THE COST OF THAT CHOICE, STATED RATHER THAN HIDDEN: a machine that was
// reassigned and is currently POWERED OFF has no live sibling, so its phone is
// told plain 「offline」 — which is true, and whose action (turn it on) is right.
// The moment it comes back it comes back into the new account's room, and the
// phone learns the real answer on the next poll. The alternative — inferring
// reassignment from a NEWER sibling row while the machine is off — would keep
// asserting 「it belongs to someone else now」 about a machine whose next
// registration might well be the original account again, i.e. it would state a
// future we cannot see.
//
// ── WHAT THIS DISCLOSES, AND TO WHOM ────────────────────────────────────────
// `listByMachineUidOtherUsers` is a cross-account read, and until this card its
// only caller never put anything derived from it on a wire. What crosses now is
// ONE BIT, to a caller that already holds that pairing's own standing token:
// 「the machine your pairing points at is currently in a room under a different
// account」. No account id, no user name, no pc_id, no room, no count — the
// sibling rows are consulted and discarded. The holder of that token paired with
// this physical machine (they were at its keyboard for a QR scan or a short
// code), so what they learn is that the machine they already know about changed
// hands — the minimum needed to make 「re-pair」 the right instruction instead of
// 「go look at a computer that is fine」.

import type { PcRepo } from '../db/repos/pc.repo';
import type { RoomStore } from './store';

/** The wire value for this absence. NOT a member of `PC_ABSENT_REASONS`
 *  (room/pc-absence.ts) and that separation is deliberate: that set is 「what may
 *  be STORED in the absence table」 and every member of it has a write site.
 *  This reason is DERIVED at read time and never stored, so adding it there
 *  would create a member the table can never hold — the 「a value with no
 *  writer」 shape that file's own header refuses.
 *
 *  ⚠️ It is still a CONTRACT value: the phone mirrors this exact string
 *  (`apps/mobile/lib/src/session/pc_presence.dart`, `PcAbsentReason.parse`) and
 *  an unrecognised string there falls back to the plain 「offline」 sentence. So
 *  renaming it silently un-ships the feature for every phone already installed. */
export const MACHINE_REASSIGNED_REASON = 'machine_reassigned';

/** The row this question is asked about — a slice of `PcRecord`, so this module
 *  does not depend on the db layer for three fields. */
export interface MachineReassignmentSubject {
  user_id: string;
  machine_uid: string | null;
}

export interface MachineReassignmentDeps {
  pcs: Pick<PcRepo, 'listByMachineUidOtherUsers'>;
  /** Live room presence — the SAME instance the socket handlers mutate, which is
   *  what makes 「in its room」 have one definition (see the header). */
  store: Pick<RoomStore, 'getPc'>;
}

/**
 * Is the physical machine behind `pc` in a room RIGHT NOW under some other
 * account?
 *
 * `false` whenever we cannot tell, and the two cases that cannot tell are named
 * rather than merged into the answer: a row with no `machine_uid` (written
 * before v0.2.4, or the virtual cloud-instance row, which is not a machine at
 * all) has no way to have siblings, and a machine with no live sibling is
 * indistinguishable from a machine nobody reassigned. Both land on 「no reason
 * to give」, which is the response this route has always sent.
 */
export function isMachineServingAnotherAccount(
  deps: MachineReassignmentDeps,
  pc: MachineReassignmentSubject,
): boolean {
  if (!pc.machine_uid) return false;
  // The repo already refuses a blank uid (it would collect every row somebody
  // stamped with one, across accounts) — the guard above is this caller stating
  // the same requirement rather than relying on it silently.
  for (const sibling of deps.pcs.listByMachineUidOtherUsers(pc.machine_uid, pc.user_id)) {
    if (deps.store.getPc(sibling.room_uuid) !== null) return true;
  }
  return false;
}
