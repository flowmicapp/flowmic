// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a (c) (the capabilities array)
//   docs/strategy/2026-09-06-web-client-parity-privacy-image-and-ux-addendum.md §3
//   ./mobile.handler.ts (the ONE caller — both acks spread these)
//   ../../room/target-caps.ts (the column encoding this file reads through)
//
// The two field-spreads that ride the `mobile:pair` and `mobile:reconnect` acks.
// RECOVERY_CAPABILITY_ACK moved out of mobile.handler.ts VERBATIM (2026-09-08,
// card S2-01) for the 800-line `file-size` lint — no behaviour and no comment
// moved with it; `targetCapsAck` is new and lands here because it is the second
// member of exactly the same family.
//
// 🔴 THEY ANSWER DIFFERENT QUESTIONS AND THAT IS WHY THERE ARE TWO OF THEM —
// see targetCapsAck below.

import { SERVER_RECOVERY_CAPABILITIES, type ServerCapabilityAckFields, type TargetCapsAckFields } from '@flowmic/protocol';
import type { PcRecord } from '../../db/repos/pc.repo';
import { parseTargetCaps } from '../../room/target-caps';

// ── card PR-1 (04 SPEC §3.3-a (c)) — what THIS build may honestly claim ──────
//
// Rides the two acks the phone already reads (`mobile:pair`, `mobile:reconnect`)
// rather than a new event or a new ack type: the phone's question is "what can
// the server I just reached actually do", and it has exactly one moment where it
// is reading an answer from that server anyway.
//
// TYPED, not spelled inline, for the same reason
// `MobileReconnectAckAudioFields` is: both acks are emitted as literals here, so
// the declaration in @flowmic/protocol is what holds this file to the wire shape
// instead of a parallel copy nothing verifies (the RV-36 drift trap).
//
// 🔴 `recovery.idempotent_operation` JOINED THIS LIST ON 2026-09-06, and only
// because card PR-2 landed the mechanism first: the operation registry
// (db/schema-recovery.ts), the metering-effect ledger wired into the primary
// node's tracker, and the replica's deterministic outbox key. The sentence that
// stood here — "MUST NOT BE ADDED UNTIL card PR-2 EXISTS" — was obeyed rather
// than overruled, and it is recorded because the reason has not weakened: the
// phone reads a missing bit fail-closed (it holds the audio and says so), while
// a bit we do not honour turns that into "looks successful, no protection",
// which audit §A7-3 names as the worst available outcome.
// ⚠️ THE LIST IS STATIC AND THE WIRING IS NOT CONDITIONAL, which is what keeps
// the claim true per deployment: `db.recoveryOps` is built unconditionally in
// db/connection.ts, and an `audio:start` that names an operation is REFUSED
// rather than admitted unprotected if it ever is not (audio-start-operation.ts).
// The membership is pinned by a test, not by this comment.
//
// FAILURE DIRECTION: an old phone ignores an ack key it does not know, and an
// old relay would not send it at all. Both produce exactly today's product.
export const RECOVERY_CAPABILITY_ACK: ServerCapabilityAckFields = {
  capabilities: [...SERVER_RECOVERY_CAPABILITIES],
};

/**
 * What the TARGET behind a pairing can receive, for the `mobile:pair` and
 * `mobile:reconnect` acks.
 *
 * 🔴 A DIFFERENT QUESTION FROM the `capabilities[]` array that rides the same
 * acks, which is why it is a different field and not another string in that
 * array. That one says what THIS SERVER can do and is identical for every
 * pairing on the node; this says what the PC (or browser room) at the other end
 * declared, and it is per row. One array carrying both would be a value
 * answering two questions — and the two even fail in opposite directions: an
 * unknown server capability is ignored, while an unknown target capability must
 * be read as 「undeclared, allowed」.
 *
 * OMITTED, NEVER `{image:false}`, when the row has nothing stored. Every PC
 * built before this card is in that state on the day this ships, and a
 * microphone end that read absence as a refusal would stop image delivery for
 * all of them. `parseTargetCaps` is the one reader and it collapses NULL,
 * unparseable text and an unknown shape to the same 「we do not know」.
 *
 * Typed against the protocol declaration, like the recovery-capability ack, so
 * the compiler holds the emitted literal to the wire shape rather than a
 * parallel copy nothing checks (the RV-36 drift trap).
 */
export function targetCapsAck(pc: PcRecord): TargetCapsAckFields {
  const caps = parseTargetCaps(pc.target_caps);
  return caps === undefined ? {} : { target_caps: caps };
}
