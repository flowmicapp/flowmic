// SPEC-REF:
//   apps/server-core/src/node/forward-sync.ts              (the writer-side mutation)
//   apps/server-core/src/socket/handlers/pc.handler.ts     (pc:release-mobile, replica branch)
//   apps/server-core/src/socket/handlers/mobile.handler.ts (mobile:unpair, replica branch)
//   apps/server-core/src/node/token-rows.ts                (applyTokenResolution — the same
//                                                           move in the opposite direction)
//   apps/server-core/src/node/replica-puller.ts            (the 30-second whole-table pull)
//
// ── THE DEFECT THIS FILE EXISTS FOR (owner report 2026-09-10, measured) ─────
//
// owner:「网页建立的配对实例无法正常取消」("the pairing instances created by the web
// client cannot be cancelled"). Measured on srvjp's journal, the six frames his
// six presses produced:
//
//   02:00:20.131 pc:release-mobile (forwarded) {revoke:true, targets:1, revoked:1}
//   02:00:21.922 pc:release-mobile (forwarded) {revoke:true, targets:0, revoked:0}
//   02:00:23.502 pc:release-mobile (forwarded) {revoke:true, targets:0, revoked:0}
//   02:00:29.175 pc:release-mobile (forwarded) {revoke:true, targets:1, revoked:1}
//   02:00:32.227 pc:release-mobile (forwarded) {revoke:true, targets:1, revoked:1}
//   02:00:34.551 pc:release-mobile (forwarded) {revoke:true, targets:0, revoked:0}
//
// Three deletions really happened. Three presses found NOTHING TO DELETE — and
// they are the SAME three rows, pressed a second time. The cycle was:
//
//   press → the writer deletes the row → ack {ok:true, revoked:1} → the desktop
//   reloads its list → `pc:list-mobiles` is answered from THIS REPLICA's
//   snapshot, which still holds the row for up to 30 s → the row is back on
//   screen → the user presses it again → the writer says `targets: 0` →
//   ack {ok:true, revoked:0} → `parse_release_mobile_ack` (desktop
//   socket/wire.rs) correctly reads that as「did not happen」→「撤销失败」.
//
// So both ends were behaving exactly as designed and the user still could not
// remove a pairing: the deletion was applied to the authoritative database and
// to nothing the user could see. R11 in its purest form — the layer answering
// 「is this phone still paired?」did not have the fact it needed.
//
// ── WHY THIS IS NOT「A REPLICA PERFORMING A WRITE」───────────────────────────
//
// `writer-only.ts` forbids a replica from DECIDING a mutation, because a
// decision made here is lost at the next pull. Nothing is decided here: the
// writer has already performed and confirmed the deletion, and this only makes
// this node's snapshot stop contradicting it. `token-rows.ts`
// (`applyTokenResolution`) is the same move in the opposite direction — landing
// rows the writer already holds, ahead of the pull — and states the same
// idempotence argument: the pull's whole-table DELETE+INSERT remains the
// authority, and it will agree, because the row is gone there too.
//
// ⚠️ Deliberately NOT extended to「the writer answered `targets: 0`」. That
// answer is「this PC owns no such pairing HERE」and carries no existence claim
// (pc.handler.ts states the no-oracle rule), so deleting on the strength of it
// would be inferring a deletion from an absence. With the confirmed half applied
// the second press no longer happens, and the stale row still dies at the pull.

import type { Registry } from '../room/registry';

/** GA-08 revoke, forwarded: drop this node's copies of the rows the WRITER just
 *  deleted, so the very next `pc:list-mobiles` — which the desktop fires as its
 *  reload — cannot serve the pairing back.
 *
 *  Scoped through `revokeMobile(pc_device_id, …)`, the same ownership-checked
 *  method the writer's own direct path calls, and deliberately not the wider
 *  `retireMobile`: if this stale snapshot believes the row belongs to another
 *  PC, the conservative answer for a DELETE is to leave it to the pull.
 *
 *  Returns how many local rows were dropped (0 is normal — the id may have been
 *  reaped here already). */
export function dropRevokedPairingsOnReplica(
  registry: Registry,
  pcDeviceId: string,
  pairingIds: readonly string[],
): number {
  let dropped = 0;
  for (const id of pairingIds) {
    if (registry.revokeMobile(pcDeviceId, id)) dropped++;
  }
  return dropped;
}

/** v0.2.3 `mobile:unpair`, forwarded: the phone retired its OWN pairing on the
 *  writer. The PC watching this replica's list is the one who must stop seeing
 *  it, and `pc:mobile-left` only clears the live roster — the ROW is what
 *  `pc:list-mobiles` reads.
 *
 *  `retireMobile` (delete by id, no PC scope) mirrors the direct path's own
 *  authority: the writer proved the row was the caller's. */
export function dropRetiredPairingOnReplica(registry: Registry, pairingId: string): boolean {
  return registry.retireMobile(pairingId) !== null;
}
