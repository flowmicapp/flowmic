// SPEC-REF:
//   apps/server-core/src/auth/metering-principal.ts (the payer rule itself —
//     `resolvePayer`, `roomKindOf`, and the two questions below)
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §2 (the ordered
//     rule) · §8 Q1 (A's allowance stays a second gate) · D5
//   docs/decisions/... owner 2026-08-15 QTA-2 (「两边有一方不满足都不能继续」)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// Card MP-0 — the two questions `audio.handler.ts` asks about the room a
// recording is happening in, lifted out of it.
//
// WHY A MODULE AND NOT TWO INLINE BLOCKS: both start from the SAME row
// (`deps.pcRoom(auth.deviceId)`) and then diverge — one asks 「whose ceiling must
// ALSO admit this」, the other 「whose remaining minutes is the target end
// entitled to see」. Written inline they read as one lookup used twice, which is
// exactly the confusion `budget-frames.ts`'s `BudgetTarget` doc warns about; a
// reader could not tell that the second is deliberately NOT the payer.
//
// ⚠️ It also keeps audio.handler.ts under the 800-line cap (verify/lint
// `file-size`), which is a real reason and not the argument above — the split
// would be right at 400 lines too. NO BEHAVIOUR MOVED WITH THE CODE.

import { meteringPeerUserId, pcOwnerQuotaGate, roomKindOf, type AnonymousRowReader } from '../../auth/metering-principal';
import type { MeteredPrincipalRef } from '../../billing/usage-tracker';
import { getAuth } from '../wire';

/** The one row read both questions start from — `registry.findPc(pcId)` reduced
 *  to the two columns that decide money. */
export type PcRoomReader = (pc_device_id: string) => { userId: string; roomKind: string | null } | null;

export interface AudioMeteringDeps {
  pcRoom?: PcRoomReader;
  anonymousUser?: AnonymousRowReader;
}

/**
 * Card QTA-2's SECOND ledger — WHICH other account's quota must also admit this
 * session, or null for 「only the acting account's」.
 *
 * 🔴 IT SURVIVES 「谁说扣谁」 UNCHANGED (design §8 Q1, answered 甲). Since card MP-0
 * a signed-in phone B is billed to B rather than to the computer's owner A, so
 * A's remaining minutes are no longer the ones being spent — and they are still
 * a gate, because owner's 2026-08-15 ruling is about whether the session may
 * RUN, not about who pays for it. The seconds are still written to ONE ledger.
 *
 * The two far ends that are NOT asked, and why, are at `pcOwnerQuotaGate`.
 *
 * Absent `pcRoom` (old wiring, tests that predate QTA-2) ⇒ null, i.e.
 * single-account behaviour, which is also correct whenever the two ids are equal.
 */
export function secondLedgerFor(deps: AudioMeteringDeps, actingUserId: string, deviceId: string): string | null {
  const room = deps.pcRoom?.(deviceId) ?? null;
  return pcOwnerQuotaGate({
    pcUserId: room?.userId ?? null,
    actingUserId,
    // No row ⇒ 'app'. That is not a guess about a room: with no owner resolved
    // the gate answers null on the very next line, so the kind decides nothing.
    // Passing `null` here would mean 「a kind this build cannot read」, which is a
    // different and much louder claim.
    roomKind: room === null ? 'app' : roomKindOf({
      roomKind: room.roomKind,
      ownerUserId: room.userId,
      ...(deps.anonymousUser ? { reader: deps.anonymousUser } : {}),
    }),
    ...(deps.anonymousUser ? { reader: deps.anonymousUser } : {}),
  });
}

/**
 * WHOSE remaining minutes the room's TARGET end is shown — `pc_devices.user_id`
 * in every case but one (an ANONYMOUS site-demo owner follows the microphone's
 * ledger, because its own stops moving the moment the visitor signs in).
 *
 * 🔴 NOT THE PAYER, ON PURPOSE. Since MP-0 a desktop A can be shown its own
 * reading while phone B's ledger is the one moving; that is correct (A's minutes
 * really are a different ledger) and the fact that they are not moving is
 * carried by `billing:budget.payer:'far_end'` instead — an amount is never
 * crossed between ends.
 */
export function targetEndUserId(deps: AudioMeteringDeps, actingUserId: string, deviceId: string): string | null {
  return meteringPeerUserId({
    pcOwnerUserId: deps.pcRoom?.(deviceId)?.userId ?? null,
    actingUserId,
    ...(deps.anonymousUser ? { reader: deps.anonymousUser } : {}),
  });
}

/**
 * card MP-6 — WHY these seconds land on this account and WHO SPOKE, READ OFF THE
 * ADMISSION rather than re-derived.
 *
 * 🔴 R11 applied to a ledger row. The payer rule's inputs — the handshake
 * account, the room's kind, the pairing row — belong to the moment the socket
 * was admitted; by the time a recording settles the pairing can have been
 * revoked and the account gone with it. A layer that asked the question again
 * would be answering a different question with the same words, and the row it
 * wrote would look exactly as plausible.
 *
 * Either field may legitimately be absent — an `AuthContext` stamped by the
 * token middleware rather than by the payer rule — and absent stores NULL, which
 * is 「this admission did not record it」 and never 'self'.
 *
 * ⚠️ HERE RATHER THAN IN `audio.handler.ts` FOR THE REASON THIS MODULE EXISTS:
 * that file stands at the 800-line cap (verify/lint `file-size`). No behaviour
 * moved with the code.
 *
 * ── card MP-9 — AND THE LLM LEGS READ IT FROM HERE TOO ──────────────────────
 *
 * 🔴 THREE CALLERS, ONE ANSWER. `audio.handler.ts` passes this to BOTH
 * `commitSttUsage` and `commitPolishUsage`; `compose.handler.ts` passes it to
 * the AI turn; `bootstrap-connection-handlers.ts` hands it to the compose
 * factory so the off-band scenario-inference call can be metered against the
 * admission that scheduled it. Every one of them is the SAME decision, read
 * once — not four resolutions that happen to agree today.
 *
 * WHY IT HAD TO SPREAD: on 2026-09-11 production held an `stt` row saying
 * `payer_reason='self'` with a `speaker_ref`, beside an `llm` row from the same
 * session saying nothing at all. Card MP-6 stamped the recording leg;
 * `recordLlmUsage` kept a four-argument signature nobody had to revisit. So the
 * one table an operator aggregates could answer 「who paid for the recognition」
 * and not 「who paid for the AI turn that followed it」 — and owner §11 asks that
 * every metered unit name both.
 */
export function principalRefOf(socket: Parameters<typeof getAuth>[0]): MeteredPrincipalRef {
  const auth = getAuth(socket);
  return {
    ...(auth?.payerReason !== undefined ? { payer_reason: auth.payerReason } : {}),
    ...(auth?.speakerRef !== undefined ? { speaker_ref: auth.speakerRef } : {}),
    ...(auth?.capUserId !== undefined ? { cap_user_id: auth.capUserId } : {}),
    // card MP-1 — WHICH KEY. Read off the SAME admission as the three above,
    // for the reason this function exists at all: one answer, four callers.
    ...(auth?.integratorKeyId !== undefined ? { integrator_key_id: auth.integratorKeyId } : {}),
  };
}
