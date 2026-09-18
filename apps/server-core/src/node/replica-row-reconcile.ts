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
//
// ── 🔴 THE PARAGRAPH ABOVE IS KEPT VERBATIM AND ITS LAST SENTENCE IS FALSE
//    (card RL-4, owner report 2026-09-13, measured on the same journal) ──────
//
// 「the second press no longer happens」 was a PREDICTION, and srvjp answered it
// three days later, with the 09-10 fix deployed (relay 0.3.83, both nodes):
//
//   11:08:09.121 pc:release-mobile (forwarded) {revoke:true, targets:1, revoked:1}
//   11:08:11.144 pc:release-mobile (forwarded) {revoke:true, targets:1, revoked:1}
//   11:08:15.610 pc:release-mobile (forwarded) {revoke:true, targets:0, revoked:0}  ← 🔴
//   11:09:07.372 pc:release-mobile (forwarded) {revoke:true, targets:1, revoked:1}
//
// owner:「有时候可以，有时候不行」("sometimes it works, sometimes it doesn't"),
// desktop banner 「操作未生效（未连接或服务端拒绝），请重试」— which is
// `dev_release_failed`, i.e. `parse_release_mobile_ack` reading `revoked: 0`.
//
// The 09-10 fix closed exactly one route to `targets: 0` — THIS desktop's own
// previous press — and there are others, because the deletion does not have to
// come from this node at all:
//   · a web client calls `mobile:unpair` ON THE WRITER. Measured: every
//     `pair.node_hint {pairing_id, home_node:"srvasia02", paired_on:"srvny"}`
//     on srvny (16 of them, 2026-09-01…09-13T07:21) is a phone or browser whose
//     PC lives on the replica. Web rows are BORN on the writer and reach this
//     node only through the 30-second pull — and they DIE there the same way;
//   · a revoke issued from another session that is attached to the writer;
//   · reaper.ts.
// In every one of those the user's FIRST press lands on a row this snapshot is
// still serving and the writer no longer has. Snapshot divergence is not
// hypothetical either: read read-only the same day, srvjp held 32
// `mobile_pairings` rows and srvny 31.
//
// ── SO WHY IS IT NOW SAFE TO DROP ON `targets: 0` ──────────────────────────
//
// Because the sentence 「carries no existence claim」 is true of an arbitrary
// node and false of THE WRITER. A replica's `mobile_pairings` is not a second
// opinion; it is a COPY that the next pull replaces wholesale from that exact
// table. 「the writer owns no such pairing for this PC」 is therefore not an
// absence we are reasoning from — it is the verdict the pull will apply in at
// most thirty seconds, applied early. That is the same argument
// `applyTokenResolution` (node/token-rows.ts) makes in the opposite direction,
// and the pull remains the authority in both.
//
// 🔴 AND IT IS SCOPED TO THE FORWARDED PATH ON PURPOSE. A single-node server
// answering `targets: 0` IS the no-oracle case: there the list the user read and
// the table being revoked are the same table, so `targets: 0` means「you are
// asking the wrong server about a row it never had」— owner 2026-07-29
//「提示成功，但仍然还在」, the defect v0.2.7's `channel` argument and the
// desktop's `revoked >= 1` rule exist to catch. Nothing here changes that path.

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

/** RL-4 — the writer named NO targets for a revoke that DID name a pairing id:
 *  the authoritative table has no such pairing for this PC, so the deletion the
 *  user pressed for is already true there and this snapshot is the only thing
 *  still saying otherwise. Drop that copy so the desktop's reload
 *  (`pc:list-mobiles`, answered from THIS node) stops serving it back.
 *
 *  Ownership-scoped through `revokeMobile` for the same reason as
 *  `dropRevokedPairingsOnReplica`: if this stale snapshot files the row under a
 *  DIFFERENT PC, leave it to the pull rather than let one PC delete another's.
 *
 *  🔴 The return value is NOT the answer the ack needs, and conflating the two
 *  would be this repo's #1 shape. It says「did I drop a local row」; the ack's
 *  `absent` says「does the AUTHORITY still have it」. `false` here is routine —
 *  the row may already be gone from this node too — and the pairing is absent on
 *  the writer either way. */
export function dropAbsentPairingOnReplica(
  registry: Registry,
  pcDeviceId: string,
  pairingId: string,
): boolean {
  return registry.revokeMobile(pcDeviceId, pairingId);
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
