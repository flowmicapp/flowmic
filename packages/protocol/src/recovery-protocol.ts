// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a — 恢复标识 / 覆盖回执 / 能力位
//     (THE source of truth for every shape in this file; the audit draft and the
//      ruling below are an input and an authorisation, not a definition)
//   docs/strategy/2026-08-27-project-status-log.md#audio-durability-audit-draft
//     §A6-1 (four identity layers), §A7 (field table), §A7-1 (coverage receipt),
//     §A7-3 (capability bits)
//   docs/decisions/2026-09-06-owner-audio-durability-rulings-o9-o10-cleanup-threshold.md
//
// Cards CV-1 + PR-1. Three additive, optional surfaces and NOT ONE NEW EVENT:
// the identifiers ride `audio:start`, the receipt rides the TERMINAL `stt:final`,
// and the capability list rides the acks the phone already reads. The event
// whitelist and its count guard are therefore untouched — these are payload
// fields, the same statement `polish` / `inject_origin` / `home_node` make.
//
// 🔴 WHY THE PIECES LIVE HERE AND NOT IN `protocol-schemas-audio.ts`: they are
// spread INTO two schemas in that file (see `AudioStartSchema` /
// `SttFinalSchema`) rather than declared twice, so there is exactly one
// declaration of each field and the two call sites cannot drift. Declaring them
// beside their host schemas would have meant the receipt's ten fields sit inside
// a file that also owns eleven event payloads; this module keeps one subject
// per file and the host file keeps one line per spread.

import { z } from 'zod';
import { NonEmpty } from './protocol-primitives';

/**
 * The version stamped on every receipt this build emits (04 §3.3-a (b)).
 *
 * 🔴 IT IS A VERSION, NOT A FEATURE FLAG. A reader that does not recognise the
 * number must treat the receipt as ABSENT — never as "an older, weaker proof it
 * can still lean on". A newer emitter may reuse a field name for a differently
 * measured quantity, and the whole point of the number is that a consumer can
 * refuse to guess which one it is holding.
 */
export const COVERAGE_RECEIPT_VERSION = 1;

/**
 * §A6-1 layer ③/④ — WHOSE idea this attempt was.
 *
 * 🔴 THREE VALUES BECAUSE THREE PARTIES OWE DIFFERENT THINGS, not because three
 * words were available. `'auto_retry'` is a debt WE owe the user (we failed and
 * are trying again — it must not be billed as a fresh action, and it backs off);
 * `'user_retranscribe'` is a thing the user ASKED FOR (it is billed as a new
 * attempt per ruling O-4, and it must not back off); `'live'` is the ordinary
 * press.
 *
 * ⚠️ WHAT ACTUALLY FORKS ON IT TODAY, MEASURED (audit F4): nothing on the
 * server. `recovery-operations.repo.ts` stores the value and compares it as part
 * of the immutable binding — a re-send that changed its `attempt_kind` is
 * refused — and that is the whole of the server's use. Billing does not read it
 * (the account is metered once per `(user, operation, kind)` whatever the kind
 * says), and the back-off is the PHONE's: it mints a fresh `operation_id` per
 * attempt and decides for itself whether to wait. The field is carried so those
 * decisions can be made and audited, and so the three cases stay
 * distinguishable if the server ever does need to tell them apart.
 *
 * 🔴 THE THREE VALUES STILL MAY NOT BE COLLAPSED, and that does not depend on
 * anything branching on them today: `'user_retranscribe'` is a person asking
 * again, `'auto_retry'` is a machine that must not back off, `'live'` is the
 * ordinary press. One value answering all three questions is what this enum
 * prevents.
 *
 * ⚠️ This paragraph said billing, back-off and copy 「all fork on this one
 * field」. They do not, and a reader who believed it would have gone looking on
 * the server for a branch that has never existed.
 */
export const AttemptKindSchema = z.enum(['live', 'auto_retry', 'user_retranscribe']);
export type AttemptKind = z.infer<typeof AttemptKindSchema>;

/**
 * 04 §3.3-a (a) — the eight recovery identifiers, spread into `AudioStartSchema`.
 *
 * ALL OPTIONAL, and that is a compatibility statement rather than laxity:
 * `AudioStartSchema` is deliberately NOT `.strict()`, so a relay older than this
 * card STRIPS these keys silently and finalises exactly as it does today. That
 * is the measured failure direction (audit §A2-5 E38, and the same shape the
 * `audio:stop` `discard` field's comment records for the branch that already
 * shipped) — and it is precisely why the recovery leg may not simply "send them
 * and hope": a stripped identifier looks identical to a server that honoured it.
 * The capability bits below exist to make that difference observable.
 *
 * 🔴 THE RANGE IS IN SAMPLES, HALF-OPEN `[start, end)`, AND NEITHER HALF OF THAT
 * IS DECORATION. Milliseconds cannot name a PCM boundary without a rounding rule
 * that both ends must agree on forever (audit §A3-2a bans deriving the offset
 * from `byteOffset / 6400` for the same reason); half-open is what lets adjacent
 * ranges meet exactly once, with no overlap and no hole, which is the property
 * the local journal's continuity check is written against.
 *
 * 🔴 `job_id` IS OPAQUE TO THE SERVER. The client derives it from
 * `(recording_id, sampleRange, resultVariant)`, and the server neither parses
 * nor validates that structure — if it did, the derivation rule would have two
 * homes and one of them would go stale.
 */
export const AudioStartRecoveryFieldsSchema = z.object({
  /** ① the raw asset — "which sound is this". One per recording, never reused. */
  recording_id: NonEmpty.optional(),
  /** ② the logical job / result-version key. Client-derived, server-opaque. */
  job_id: NonEmpty.optional(),
  /** ③ one real recognition attempt. */
  attempt_id: NonEmpty.optional(),
  /** ④ one network send OF that attempt; a resend reuses the value.
   *
   *  🔴 WHAT THE SERVER PROMISES ON IT, EXACTLY (card PR-2, 2026-09-06). A
   *  re-send is REGISTERED against an immutable binding and the account is
   *  METERED ONCE; a re-send whose binding changed is REFUSED. It is NOT a
   *  result cache — ruling O-9 (乙) set that option aside, so the audio is
   *  recognised again and the duplicated vendor cost is ours.
   *  ⚠️ The word 「exactly-once」 is banned from this subject (audit §A7-2): we
   *  have no such guarantee toward a vendor, only toward the user's bill. */
  operation_id: NonEmpty.optional(),
  attempt_kind: AttemptKindSchema.optional(),
  /** Inclusive start of the fed range, in SAMPLES. */
  range_start_sample: z.number().int().nonnegative().optional(),
  /** EXCLUSIVE end of the fed range, in SAMPLES. */
  range_end_sample: z.number().int().nonnegative().optional(),
  /** Must match the local manifest's `format`; a mismatch refuses the recovery
   *  rather than guessing or transcoding. */
  audio_format_version: z.number().int().nonnegative().optional(),
});
export type AudioStartRecoveryFields = z.infer<typeof AudioStartRecoveryFieldsSchema>;

/**
 * 04 §3.3-a (b) — the coverage receipt, spread into `SttFinalSchema` and emitted
 * ONLY on the terminal final (`is_segment:false`). A soft-segment final is not a
 * conclusion about a recording, so a receipt on one would name a range nobody
 * asked about.
 *
 * 🔴 WHAT THESE NUMBERS ARE NOT. `fed_frames` matching the count the phone sent
 * does not prove the CONTENT matched (a replay, or zero-fill, produces the same
 * count), and `seq_gaps === 0` says nothing whatsoever about whether the words
 * are right — audit §A5-4 states plainly that no machine criterion exists for
 * the latter. They are diagnostics. The one thing they are allowed to gate is
 * stated in 04 §3.3-a (b) and fixed by the 2026-09-06 ruling: automatic cleanup
 * of the local audio requires L2 completeness AND `ended_normally` AND a
 * persisted, read-back result row. Any two of the three is not the threshold.
 *
 * 🔴 `ended_normally` IS THE HALF THAT COSTS SOMETHING TO GET RIGHT. It is false
 * for an auto-stop, for a watchdog-forced dispose and for a timeout — i.e. for
 * every ending where the engine was cut off rather than flushed. It is the
 * closest observable this chain has to "the vendor is done with this range", and
 * the ruling picked it precisely because a true L3 vendor confirmation does not
 * exist on either the relay or the provider side today (card CV-2).
 */
export const CoverageReceiptFieldsSchema = z.object({
  /** Absent ⇒ NO RECEIPT. An unrecognised value must be read the same way. */
  coverage_receipt_version: z.number().int().positive().optional(),
  /** `audio:chunk` frames the server's PIPELINE took: decoded AND accepted by
   *  the audio session. A frame that arrived after the session stopped accepting
   *  is in `drops`, not here (audit F3). */
  fed_frames: z.number().int().nonnegative().optional(),
  /** How many TIMES the sequence tracker saw a gap — not how many frames. */
  seq_gaps: z.number().int().nonnegative().optional(),
  /** Frames taken off the wire that never entered the pipeline.
   *  🔴 Replay de-duplication is NOT a drop: it is the design working. */
  drops: z.number().int().nonnegative().optional(),
  /** Leg rotations this session ATTEMPTED (soft-segment cuts + ceiling
   *  rollovers). A recording can be complete across several legs; this says how
   *  many seams the answer had to survive.
   *  ⚠️ Attempts, not legs that opened: the server counts at the top of the
   *  rotation, so one that bails at a fence is counted too (audit F4). The wire
   *  name is unchanged — renaming a shipped field to fix a sentence would cost
   *  every client a compatibility branch to repair a comment. */
  engine_leg_rollovers: z.number().int().nonnegative().optional(),
  /** false ⇒ auto-stop / watchdog dispose / timeout. See the note above. */
  ended_normally: z.boolean().optional(),
  // ── echoes of the start frame, so a receipt can be pinned to a range ──────
  //
  // 🔴 ECHOED, NOT DERIVED. The server does not parse, validate or invent any of
  // these; it hands back exactly what the start frame carried, and nothing at
  // all when the start frame carried nothing. A server that "helpfully" filled
  // one in would be answering a question only the client can answer, and the
  // client would have no way to tell the two apart.
  recording_id: NonEmpty.optional(),
  attempt_id: NonEmpty.optional(),
  range_start_sample: z.number().int().nonnegative().optional(),
  range_end_sample: z.number().int().nonnegative().optional(),
});
export type CoverageReceiptFields = z.infer<typeof CoverageReceiptFieldsSchema>;

/** 04 §3.3-a (c) — "I will put a coverage receipt on the terminal final." */
export const CAPABILITY_RECOVERY_COVERAGE_RECEIPT = 'recovery.coverage_receipt';
/** 04 §3.3-a (c) — "my `attempt_kind` / `delivery:'none'` semantics match yours." */
export const CAPABILITY_RECOVERY_DELIVERY_NONE_SAFE = 'recovery.delivery_none_safe';
/**
 * 04 §3.3-a (c) — "a re-send of the same `operation_id` will not charge the
 * account twice, and one that changed its binding will be refused."
 *
 * ⚠️ IT WAS `RESERVED_CAPABILITY_IDEMPOTENT_OPERATION` UNTIL 2026-09-06, WITH A
 * COMMENT FORBIDDING ITS ADVERTISEMENT. The prohibition was correct and it was
 * lifted by card PR-2 implementing the thing, not by anyone deciding the comment
 * was too strict — the registry (`recovery_operations`), the metering ledger
 * (`usage_effects`) and the replica's deterministic record id all landed first.
 * The name is unchanged, so a phone built against the old constant reads the same
 * string off the wire; only its spelling in TypeScript moved.
 *
 * 🔴 WHAT IT DOES NOT SAY, because the phone's fail-closed rule turns this bit
 * into permission: it does not say the server kept the transcript, and it does
 * not say the vendor was only asked once. It says the BILL is right.
 */
export const CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION = 'recovery.idempotent_operation';

/**
 * What THIS build may honestly claim. The three implemented bits, in a frozen
 * tuple so the advertisement has one author.
 *
 * 🔴 A MEMBER OF THIS TUPLE IS A PROMISE, NOT A LABEL. The phone reads a present
 * bit as permission to stop protecting its own audio (audit §A7-3), so adding a
 * name here before the mechanism exists converts a safe hold into a silent,
 * unprotected success — the outcome that section calls the worst one available.
 * The third member arrived only when card PR-2's registry, ledger and replica
 * key were all in and tested.
 */
export const SERVER_RECOVERY_CAPABILITIES = [
  CAPABILITY_RECOVERY_COVERAGE_RECEIPT,
  CAPABILITY_RECOVERY_DELIVERY_NONE_SAFE,
  CAPABILITY_RECOVERY_IDEMPOTENT_OPERATION,
] as const;

/**
 * 04 §3.3-a (c) — the `capabilities` array on the `mobile:pair` /
 * `mobile:reconnect` acks.
 *
 * A PARTIAL fields-schema, the same construction (and for the same reason) as
 * `MobileReconnectAckAudioFieldsSchema`: the base acks are emitted as literals
 * in `mobile.handler.ts`, and a parallel full-ack declaration that nothing
 * verifies is the RV-36 drift trap. The emitter types its spread as
 * {@link ServerCapabilityAckFields}, so the compiler holds the handler to this
 * declaration.
 *
 * 🔴 A PERMISSIVE `string[]`, NOT AN ENUM, and that is forward-compatibility
 * rather than looseness: a phone must never reject an ack because a newer server
 * named a capability it has not heard of. Recognition is the READER's job — an
 * unknown bit is simply a bit this build cannot act on.
 *
 * ABSENCE MEANS "we do not know", NOT "the server cannot do it" (audit §A7-3
 * fail-closed). An old relay strips the key; an old phone ignores it. Both
 * produce exactly today's product.
 */
export const ServerCapabilityAckFieldsSchema = z.object({
  capabilities: z.array(NonEmpty).optional(),
});
export type ServerCapabilityAckFields = z.infer<typeof ServerCapabilityAckFieldsSchema>;
