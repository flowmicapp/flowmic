// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §1.3
//     (`billing:budget` payload) and §1.5 (the same shape on a reconnect ack)
//   docs/strategy/2026-09-07-web-client-crosscheck-after-audio-durability.md §4.1
//     (`resets_at`, owner 2026-09-07 ruling ① — every place a quota is shown
//      must also say when it comes back)
//   docs/decisions/2026-09-06-owner-web-client-rulings-repo-protocol-domains.md
//     ruling 2 (approved, and approved to land WITH its first producer — never
//     as a registered placeholder)
//   docs/strategy/2026-09-05-web-client-subproject-design.md §5 item 4 as
//     CORRECTED there: this event answers "how much is left", NOT "you were
//     refused".
//
// §3.9 Billing — the one server to client event that says how much of the
// account's transcription budget is still there.
//
// -- WHY THIS IS NOT A SECOND REFUSAL, AND MUST NEVER BECOME ONE -------------
//
// The refusal already exists and already reaches the screen: `audio:start`
// over quota answers `stt:error{QUOTA_EXCEEDED}` (card QTA-1,
// socket/handlers/audio-start-quota.ts), and a recording that runs OUT of
// budget mid-sentence is ended by the server itself and named as
// `audio:auto-stopped{reason:'quota_exhausted'}` (card W8-4,
// engine/stt-session-autostop.ts). Both are shipped, both are terminal, both
// are somebody's ANSWER.
//
// This event answers a different question -- "how much is left, and when does
// it come back" -- and it is a PROGRESS reading, not a verdict. `exhausted`
// therefore does NOT authorise a client to invent a refusal of its own: it is
// the same fact the auto-stop is about to state, sent so a meter can reach zero
// on screen at the moment the recording stops instead of a beat later. Two
// values answering "why did this end" is this repo's #1 bug shape; the whole
// reason this comment is here is that the two live one function apart.
//
// -- WHY AN EVENT AND NOT A FIELD -------------------------------------------
//
// The same test `stt:refined` and `mobile:released` had to pass. There is no
// existing frame to ride:
//   - the number must arrive BEFORE anyone speaks (so a page can show it at
//     rest), and at rest there is no audio frame at all;
//   - it must arrive DURING a recording, repeatedly, and the frames that flow
//     then (`stt:interim` / `stt:level`) are about the utterance's TEXT and
//     LOUDNESS -- hanging an account balance on them would give one frame two
//     subjects, and every consumer of those frames would have to learn to
//     ignore a field that is not about what it asked for;
//   - the reconnect ACK genuinely could carry it, and does (see
//     [[BudgetAckFieldsSchema]] below) -- but an ack only exists at the instant
//     a client reconnects, which is the one moment this number is least
//     interesting.
//
// -- FAILURE DIRECTION (it decides the deploy order, and here it is benign) --
//
// A client that does not listen for this name ignores it -- socket.io drops an
// unhandled event silently -- and gets exactly today's product. A client that
// listens against an OLD relay never hears it and renders whatever it rendered
// before. Neither direction degrades to a WORSE product, so relay-first is
// preferred rather than required. Contrast error code 60, where the failure
// direction really did dictate the order.

import { z } from 'zod';

/**
 * WHOSE ceiling this number came out of.
 *
 * ONLY `'plan'` HAS A PRODUCER TODAY, and that is a fact about the server, not
 * about this enum. Stage two of the web-client plan ships account-backed rooms
 * only; `'trial'` (the anonymous grant, `trial_ledger`) and `'integrator'` (a
 * publishable key's owner) are stage three and have no emitter anywhere in this
 * repo yet.
 *
 * They are declared here anyway because this is the CONTRACT the new-repo
 * clients are being written against (addendum §1.3), and a client that has to
 * re-learn the enum later is a worse outcome than three names with one
 * producer. But nothing may read the presence of a value here as evidence that
 * something emits it -- the only honest way to ask that question is to grep for
 * the producer, which is what anti-facade (4) says in general.
 */
export const BILLING_BUDGET_MODES = ['trial', 'plan', 'integrator'] as const;
export const BillingBudgetModeSchema = z.enum(BILLING_BUDGET_MODES);
export type BillingBudgetMode = z.infer<typeof BillingBudgetModeSchema>;

/**
 * WHY this frame was sent. Optional, and deliberately not load-bearing: a
 * client that ignores `reason` entirely still renders a correct meter, because
 * every frame carries the whole answer. It exists so a log line (and a golden
 * path) can tell "the ten-second heartbeat" from "the account just ran out"
 * without inferring it from timing.
 */
export const BillingBudgetReasonSchema = z.enum([
  /** Room joined / built -- the reading a page shows before anyone speaks. */
  'granted',
  /** A recording just started. */
  'started',
  /** The while-streaming tick. */
  'heartbeat',
  /** This session just hit the ceiling and the server is ending it. See the
   *  header: the ENDING is `audio:auto-stopped`, not this. */
  'exhausted',
  /** Re-synchronised after a reconnect. */
  'refreshed',
]);
export type BillingBudgetReason = z.infer<typeof BillingBudgetReasonSchema>;

/**
 * The reading itself -- the shape shared by the event and by the `budget` field
 * on a reconnect ack (addendum §1.5: "same shape", so a client has one parser).
 *
 * `remaining_ms: null` means "this deployment has no quota concept" --
 * standalone / self-hosted / BYOK. It does NOT mean "we could not read it" and
 * it does NOT mean unlimited-as-a-benefit: a client renders no meter at all for
 * null, the same rule `apps/mobile/lib/src/ui/quota_gauge.dart` already applies
 * to an end it cannot read ("a zero-length bar would read as 'you have used
 * none of it', which is an answer we do not have").
 *
 * `resets_at: null` means the same about the CYCLE: no period, so nothing to
 * count down to. Epoch milliseconds when present -- the account's own cycle end
 * (`BillingService.usagePeriod().endMs`), not a calendar month (owner
 * 2026-09-05, per-account anchored cycles).
 */
export const BudgetViewSchema = z.object({
  remaining_ms: z.number().int().nonnegative().nullable(),
  mode: BillingBudgetModeSchema,
  resets_at: z.number().int().positive().nullable(),
  /**
   * The FREE plan's monthly managed-STT ceiling, in whole minutes -- card
   * NR-31.
   *
   * WHY IT IS ON THE WIRE AT ALL. A page that has just spent an anonymous
   * trial wants to say 「sign in for a free plan with N minutes every month」,
   * and N is a SERVER number: `billing/plans.ts` holds the table and
   * `FLOWMIC_PLAN_LIMITS` may move any cell of it per deployment. A client that
   * hardcodes 20 is a copy of a configurable value (mock-billing design 8.4
   * forbids exactly that), and the day a deployment raises the free tier the
   * copy becomes a confident wrong number on a page whose whole job is to
   * persuade someone to sign up.
   *
   * WHY IT IS NOT THE RECIPIENT'S OWN ALLOWANCE. `remaining_ms` answers 「how
   * much may THIS socket still speak」; this answers 「what would an account
   * get」. They are two questions, so they are two fields -- the one-value-one-
   * question rule this repo keeps paying for.
   *
   * 🔴 PRESENT ONLY ON A `mode:'trial'` VIEW. A row that already has a plan is
   * told about its own plan and nothing else: shipping the free ceiling beside
   * a paid account's meter would put a second, smaller number next to the one
   * that governs, and no client has a use for it. The producer is
   * `budget-push.ts`'s `view()`, and it is the only one.
   *
   * OPTIONAL, integer, positive. Absence means 「this relay did not say」 --
   * an older relay, a deployment whose free tier is configured to zero minutes,
   * or a plan view -- and the ONLY honest rendering of absence is to leave the
   * sentence out. It never means 「unlimited」 and it never means 「zero」.
   */
  free_plan_minutes: z.number().int().positive().optional(),
  /**
   * WHO PAYS for what this room records -- card MP-0
   * (docs/archive/strategy/2026-09-11-metering-principal-matrix-design.md SS4, D5).
   *
   * `remaining_ms` answers 「how much is left on the account this socket is told
   * about」. It does NOT answer 「is that the account this room's recordings are
   * actually spending」, and the two really do come apart. Without this field a
   * meter simply does not move while a recording runs in front of it, and
   * nothing on the wire says why -- the status-truth red line (R11) with a
   * plausible number in it.
   *
   * 🔴 IN-PLACE CORRECTION, card MP-10: THE EXAMPLE THIS PARAGRAPH USED TO
   * GIVE IS NOW BACKWARDS, AND IT IS NOT KEPT BECAUSE A WORKED EXAMPLE POINTING
   * THE WRONG WAY IS READ AS THE RULE. MP-0 read owner's 「谁说扣谁」 as
   * billing a signed-in phone on somebody else's computer to the PHONE; owner's
   * 2026-09-11 凌晨 再追认 (「只要有对端，就扣对端」) says the
   * COMPUTER's owner pays, signed-in speaker or not. So on that pairing the
   * frame that reads `'far_end'` is the SPEAKER's, and the desktop is the end
   * whose meter moves.
   *
   *   'self'     -- the number in THIS frame is the one being spent.
   *   'far_end'  -- the room's OTHER end is paying; this frame's number will not
   *                 move for this recording. The design's copy for it is 「正在用
   *                 对方账号的额度」, and it deliberately carries NO amount: the
   *                 other end's remaining minutes are not this end's business.
   *   'trial'    -- the payer is an anonymous FlowMic trial allowance rather
   *                 than an account. Derived from `mode` by the one producer, so
   *                 it cannot drift from it.
   *
   * OPTIONAL, and absent means 「this relay did not say」 -- an older relay, or a
   * frame sent at a moment when no recording has a payer yet (a room-join
   * reading). Absent NEVER means 'self': a client that has not been told must
   * render nothing extra, which is exactly today's product.
   */
  payer: z.enum(['self', 'far_end', 'trial']).optional(),
  /**
   * `true` only on a frame sent to the account that OWNS the room, while an
   * UNSIGNED speaker is spending that account's allowance -- card MP-6
   * (docs/archive/strategy/2026-09-11-metering-principal-matrix-design.md SS10-1 step 4,
   * SS10-3).
   *
   * 🔴 IT IS THE ONLY SOURCE FOR THAT SENTENCE, and it exists because the
   * recipient CANNOT derive it. The owner's frame already says `payer:'self'`
   * (its minutes really are the ones being spent) and carries its own
   * `remaining_ms` -- so from the desktop's side a guest visitor and its own
   * phone are byte-identical. Who is holding the microphone is a fact only the
   * relay has, and a client that inferred it from anything adjacent (the room
   * having a web pairing, a name, a count) would be guessing about money.
   *
   * OPTIONAL, and absent means 「this relay did not say」 -- an older relay, or
   * any frame that is not that one case. Absent NEVER means `false` in the sense
   * of 「we checked and there is no guest」: a client that has not been told
   * renders nothing extra, which is exactly today's product.
   *
   * 🔴 NOT SENT TO THE SPEAKER. The speaker's own frame answers the same
   * situation with `payer:'far_end'` -- 「the minutes in this frame belong to the
   * other end」 -- and one fact wearing two names on two frames is how the two
   * ends start disagreeing about one recording.
   */
  guest_speaker: z.boolean().optional(),
  /**
   * `true` only on a frame sent to the account that OWNS the room, while a
   * DIFFERENT SIGNED-IN account is the speaker spending that account's
   * allowance -- card MP-10 (owner 2026-09-11 凌晨 再追认:
   * 「只要有对端，就扣对端」).
   *
   * 🔴 IT IS `guest_speaker`'S SIBLING AND NOT ITS REPLACEMENT, and the two
   * are mutually exclusive by construction (one producer, one `if`). Both say
   * 「the minutes in this frame are yours and somebody else is spending
   * them」; they differ on WHO, and that difference is the one thing the owner
   * can act on. An unsigned guest is a browser somebody scanned a code with --
   * the remedy is to unpair. A signed-in account is a person the owner can name
   * -- and telling them 「a guest is speaking」 would be a true sentence
   * about the wrong situation. Folding both into one flag would give one word
   * two meanings, which is this repo's #1 bug shape bought for nothing.
   *
   * 🔴 THE RECIPIENT CANNOT DERIVE IT, exactly as with `guest_speaker`. Since
   * MP-10 the far end pays whether or not the speaker is signed in, so the
   * owner's frame carries the owner's OWN id in both cases -- a signed-in
   * visitor, an unsigned one and the owner's own phone are byte-identical from
   * the desktop's side.
   *
   * OPTIONAL, and absent means 「this relay did not say」 -- an older relay,
   * or any frame that is not that one case. Absent NEVER means `false` in the
   * sense of 「we checked and everybody speaking here is a guest」.
   *
   * 🔴 NOT SENT TO THE SPEAKER, for the same reason `guest_speaker` is not:
   * the speaker's own frame answers this situation with `payer:'far_end'`, and
   * one fact wearing two names on two frames is how the two ends start
   * disagreeing about one recording.
   *
   * ⚠️ NO CLIENT RENDERS IT YET. Card MP-10 may not touch a user-visible
   * sentence; the desktop's reader (`apps/desktop/src/lib/billing-payer.ts`)
   * still folds `guest_speaker` alone. The follow-up card that owns the copy
   * owns this field's reader too.
   */
  signed_in_speaker: z.boolean().optional(),
});
export type BudgetView = z.infer<typeof BudgetViewSchema>;

export const BillingBudgetSchema = BudgetViewSchema.extend({
  reason: BillingBudgetReasonSchema.optional(),
  /**
   * Present and `true` only on the exhaustion frame. Redundant with
   * `remaining_ms === 0` on purpose: a client that shows a banner must not have
   * to decide whether 0 means "spent" or "rounded down", and the server is the
   * only end that knows which.
   */
  exhausted: z.boolean().optional(),
});
export type BillingBudget = z.infer<typeof BillingBudgetSchema>;

/**
 * The additive `budget` field on the `mobile:reconnect` / `pc:reconnect` acks
 * (addendum §1.5, option B -- adopted over a `billing:budget-request` event
 * precisely so this does NOT cost a second event name).
 *
 * A PARTIAL fields-schema, for the same reason
 * `MobileReconnectAckAudioFieldsSchema` is one (protocol-schemas-auth.ts): the
 * base ack is emitted as a literal in the handler, and a parallel full-ack
 * declaration that nothing verifies is the RV-36 drift trap. This one IS
 * verified on both sides -- the handler types its spread as [[BudgetAckFields]],
 * so the compiler holds it to this shape.
 *
 * OPTIONAL, and absence means "this server does not send it" (an older relay),
 * never "zero".
 */
export const BudgetAckFieldsSchema = z.object({ budget: BudgetViewSchema.optional() });
export type BudgetAckFields = z.infer<typeof BudgetAckFieldsSchema>;

export const BILLING_EVENT_SCHEMAS = {
  'billing:budget': BillingBudgetSchema,
} as const;
