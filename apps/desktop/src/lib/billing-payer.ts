// SPEC-REF:
//   docs/strategy/2026-09-11-metering-principal-matrix-design.md §4 (what the
//     wire must carry and what the far end may learn) + §3 D5 (「PC 屏幕不许把
//     「别人在扣」画成自己的表」) + §8 Q3 (the adopted answer: say it, without an
//     amount)
//   packages/protocol/src/protocol-schemas-billing.ts (`BudgetViewSchema.payer`
//     — the contract this file parses, and the only producer's own words about
//     what an ABSENT value means)
//   apps/desktop/src-tauri/src/socket/bridge.rs `channel::BILLING_BUDGET`
//     (the Tauri channel these frames arrive on; the desktop's subscription is
//     wired in socket/client.rs and pinned by billing-payer-wire.test.ts)
//
// WHO IS PAYING FOR THE RECORDING HAPPENING RIGHT NOW — the desktop's half.
//
// -- WHY THIS FILE EXISTS AT ALL --------------------------------------------
//
// Since card MP-0 the account being spent is the account of whoever SPEAKS
// (owner 2026-09-11 「谁说扣谁」). A phone signed into its own account, paired to
// somebody else's computer, spends the PHONE's minutes. That computer is still
// told its OWN reading, and that reading is correct — those minutes really are
// not moving. What it produces on screen is a recording in progress in front of
// a meter that stands perfectly still, with nothing anywhere saying why.
//
// That is R11 (「每个状态词都要能回答『凭什么这么说』」) in its quietest form: no
// value is wrong, nothing fails, and the user is left to conclude either 「it is
// not recording」 or 「the meter is broken」. The frame carries one word that
// answers it, and this module turns that word into a sentence.
//
// -- AND THE MIRROR CASE (card MP-8) ----------------------------------------
//
// The same room, the other way round: a visitor who is NOT signed in speaks into
// this computer, and since card MP-6 the relay bills the computer's owner (owner
// §11 / design §10-1 step 4). Here the meter DOES move, correctly, and the person
// making it move is not the person watching it. `guest_speaker: true` on that same
// frame is the only fact on the wire that says so; nothing adjacent — a web
// pairing existing, a device count, a name — is evidence about whose words are
// being charged.
//
// -- WHAT IT DELIBERATELY DOES NOT DO ---------------------------------------
//
// 🔴 IT NEVER LEARNS AN AMOUNT. The other end's remaining minutes are not this
// end's business (design §4 「不透对方余量」) and the relay does not send them:
// the peer frame carries THIS end's number with the far end's `payer` word. So
// there is nothing here to accidentally render, and the sentence in the
// catalogue carries no placeholder.
//
// 🔴 IT IS NOT A SECOND METER. `remaining_ms` is deliberately not read here.
// The account card's numbers come from the HTTP read (`cloud_account_fetch`)
// and keep coming from there; a second source for the same number is this
// repo's #1 bug shape wearing a new hat. This module answers exactly one
// question — 「is somebody else paying for what is being recorded right now」 —
// and holds exactly the state that question needs.

/** The contract's three values, mirrored from `BudgetViewSchema.payer`. */
export const BUDGET_PAYERS = ['self', 'far_end', 'trial'] as const;
export type BudgetPayer = (typeof BUDGET_PAYERS)[number];

/**
 * The `payer` word off one `billing:budget` frame, or `null`.
 *
 * 🔴 `null` COVERS THREE DIFFERENT SITUATIONS AND THAT IS ON PURPOSE, because
 * all three have the same correct rendering — nothing:
 *   · a relay old enough not to send the field at all;
 *   · a frame sent at a moment when no recording has a payer yet;
 *   · a value this build does not recognise (a later relay, a typo, a proxy).
 * The one thing `null` never means is `'self'`. A client that has not been told
 * must render today's product, not a claim it cannot back — the same rule
 * `remaining_ms: null` already states one field up in the same schema.
 *
 * ⚠️ Tolerant by construction: it reads ONE key off an unknown object and
 * ignores everything else on the frame. A malformed neighbour field must not be
 * able to suppress this sentence, and a malformed `payer` must not be able to
 * drop a frame somebody else on this channel may want later.
 */
export function asBudgetPayer(frame: unknown): BudgetPayer | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const v = (frame as { payer?: unknown }).payer;
  return typeof v === 'string' && (BUDGET_PAYERS as readonly string[]).includes(v)
    ? (v as BudgetPayer)
    : null;
}

/**
 * Is an unsigned visitor spending THIS computer's plan? — card MP-8.
 *
 * 🔴 IT IS THE OPPOSITE SITUATION TO `payer:'far_end'`, ON THE SAME CHANNEL. There
 * the meter on screen stands still because somebody else's ledger is moving; here
 * the meter on screen moves and the person making it move is not the person
 * looking at it. Both are 「the number is correct and the reason is invisible」, and
 * `guest_speaker` is the only thing on the wire that carries the reason (design
 * §10-3: 「不许由客户端推断」). A room having a web pairing, or a name, or a device
 * count, is not evidence about money.
 *
 * 🔴 IT ONLY COUNTS WHEN IT RIDES WITH `payer:'self'`, which is the only shape the
 * producer emits (`payerHintFor`, and the field's own contract in
 * packages/protocol/src/protocol-schemas-billing.ts). Reading it that way is what
 * makes 「somebody else pays」 and 「a guest spends yours」 unable to be true of one
 * frame: a frame claiming both is self-contradictory, and the honest rendering of
 * a frame this build cannot read is nothing.
 *
 * ⚠️ `=== true`, not truthiness. A `'false'` string or a `1` from a proxy is a
 * frame we do not understand, and 「I do not understand this」 must not be able to
 * put a sentence about somebody else's billing on a user's screen.
 */
export function asGuestSpeaker(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as { guest_speaker?: unknown; payer?: unknown };
  return f.guest_speaker === true && f.payer === 'self';
}

/**
 * Is a DIFFERENT signed-in account spending THIS computer's plan? — card MP-10.
 *
 * 🔴 SAME SHAPE AS `asGuestSpeaker`, DELIBERATELY KEPT A SEPARATE READER. The two
 * wire flags name two situations the owner would fix differently (an unsigned
 * guest: unpair the device; a signed-in account: it is somebody they can go tell)
 * — `payerHintFor` (apps/server-core/src/billing/budget-push.ts) emits at most
 * one of them per frame, never both, precisely so that distinction survives on
 * the wire. Reading them with two functions keeps that distinction available to
 * whichever card next needs it; card G-2b2 folds their OUTPUT into one boolean
 * at [`foldBudgetFrame`] because today's product still answers 「is somebody
 * other than the owner spending this plan right now」 with the one sentence in
 * [`guestIsSpending`]'s slot (`S.cloud_usage_spent_by_other`) — see that
 * function's doc for why merging the READING would have been the wrong place.
 *
 * 🔴 IT ONLY COUNTS WHEN IT RIDES WITH `payer:'self'`, for the same reason
 * `asGuestSpeaker` does: that is the only shape the producer emits, and the two
 * flags being mutually exclusive on one frame (one producer, one `if`) is what
 * keeps 「a guest is spending yours」 and 「a colleague is spending yours」 unable
 * to both be true of one frame.
 *
 * ⚠️ `=== true`, not truthiness, for the same reason as `asGuestSpeaker`: a
 * frame this build cannot read must render nothing, not a guess.
 */
export function asSignedInSpeaker(frame: unknown): boolean {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as { signed_in_speaker?: unknown; payer?: unknown };
  return f.signed_in_speaker === true && f.payer === 'self';
}

/** The last thing the relay said about who pays, and when it said it. */
export interface PayerLatch {
  payer: BudgetPayer;
  /**
   * Cards MP-8 and MP-10 (folded together, card G-2b2) — was that same frame
   * marked `guest_speaker` OR `signed_in_speaker`?
   *
   * 🔴 ONE BOOLEAN FOR TWO WIRE FLAGS, BECAUSE THIS SCREEN ASKS ONE QUESTION —
   * 「is somebody other than the owner spending this plan right now」 — and
   * either flag answers it the same way for [`guestIsSpending`]'s purposes; the
   * two situations differ only in what the owner would do about it, and nothing
   * downstream of this latch renders that difference today (see
   * `asSignedInSpeaker`'s doc for why the two READERS still stay separate).
   * `payerHintFor` never sets both on one frame, so this fold loses no
   * information a frame could have carried.
   *
   * 🔴 IT LIVES ON THE SAME LATCH AS `payer` BECAUSE IT ARRIVES ON THE SAME FRAME,
   * and a second latch would be a second answer to 「what did the relay last say
   * about this recording」 that a dropped frame could split. `false` here is a real
   * `false`: the frame carried a payer word (so this relay speaks the MP-6
   * language) and did not mark either kind of other-speaker. That is what
   * retires the sentence the moment the owner starts speaking for themselves —
   * no timer needed for that edge, because the next heartbeat is the one that
   * says so.
   */
  guestSpeaker: boolean;
  /** `Date.now()` at the moment the frame arrived — the watchdog's only input. */
  atMs: number;
}

/**
 * How long a `payer` word is allowed to keep speaking for a recording after the
 * last frame that carried it.
 *
 * 🔴 THIS IS A LOCAL WATCHDOG ON A REMOTE LATCH, which this repo requires by
 * name (「远端事件闭合的 latch 必须有本地看门狗」). The relay pushes a budget frame
 * when a recording starts and then every ~10 s while it runs
 * (`DEFAULT_BUDGET_HEARTBEAT_MS`), and pushes NOTHING when it ends — there is
 * no 「the recording is over」 frame on this channel to close the latch with. A
 * latch with no watchdog would leave 「this recording is charged to …」 on screen
 * for the rest of the session, describing a recording that finished.
 *
 * 15 s = one heartbeat plus half of one. The margin is deliberately small and
 * the failure direction is deliberately outward: a late heartbeat blinks the
 * sentence OFF, which costs a flicker; a generous margin would keep a sentence
 * about a finished recording on screen, which costs the truth. Absence of
 * evidence makes us stop talking — it never makes us keep talking.
 */
export const PAYER_FRESH_MS = 15_000;

/**
 * Fold one arriving frame into the latch.
 *
 * 🔴 AN ABSENT `payer` CHANGES NOTHING — it neither sets nor clears. It means
 * 「this relay did not say」, and a relay that does not say cannot be read as
 * saying 「self」 (which would clear a live, true sentence) nor as saying
 * `far_end` (which would invent one). The latch simply keeps ageing, and
 * [`farEndIsPaying`] retires it on time.
 *
 * 🔴 A PRESENT `payer` REPLACES ALL THREE WORDS AT ONCE (cards MP-8 and MP-10).
 * `guest_speaker`/`signed_in_speaker` are only ever emitted alongside
 * `payer:'self'`, so a frame that carries a payer word and neither flag is a
 * relay saying 「nobody else is speaking」, not a relay staying silent — which is
 * exactly why the other-speaker sentence needs no timer to go out when the owner
 * takes the microphone back. Carrying either flag forward across such a frame
 * would be the one reading that leaves 「somebody else is spending your plan」 on
 * screen while the owner is the one speaking.
 *
 * 🔴 THE TWO FLAGS ARE OR'D HERE, NOT KEPT SEPARATE (card G-2b2). This is the
 * one place [`asGuestSpeaker`] and [`asSignedInSpeaker`]'s outputs meet: the
 * latch has held one 「is somebody else speaking」 bit since MP-8, and MP-10
 * added a second wire flag for the same question rather than a second bit, so
 * folding both readers into that one bit is what makes the new flag light the
 * existing sentence instead of needing a sentence of its own.
 */
export function foldBudgetFrame(
  prev: PayerLatch | null,
  frame: unknown,
  nowMs: number,
): PayerLatch | null {
  const payer = asBudgetPayer(frame);
  return payer === null
    ? prev
    : { payer, guestSpeaker: asGuestSpeaker(frame) || asSignedInSpeaker(frame), atMs: nowMs };
}

/**
 * Is somebody else paying for what is being recorded right now?
 *
 * 🔴 ONLY `'far_end'` ANSWERS YES.
 *   · `'self'` — this end's own ledger is moving, the meter on screen is the
 *     one being spent, and there is nothing to explain. Today's product.
 *   · `'trial'` — the payer is an anonymous FlowMic allowance. It cannot reach
 *     a desktop today (a desktop that receives budget frames at all is signed
 *     in, so its own view's `mode` is `'plan'`, and the producer derives this
 *     word from `mode`), and if it ever does, the honest desktop rendering is
 *     still nothing: there is no authored sentence for it, and inventing one
 *     here rather than in the catalogue is how a bare identifier reaches a user
 *     (0.2.53). Card MP-4 owns copy.
 */
export function farEndIsPaying(latch: PayerLatch | null, nowMs: number): boolean {
  return latch !== null && latch.payer === 'far_end' && isFresh(latch, nowMs);
}

/**
 * Is somebody other than the owner spending this computer's plan right now? —
 * an unsigned visitor (card MP-8) or a different signed-in account (card
 * MP-10, folded in by card G-2b2). `signed_in_speaker` did not get its own
 * sentence or its own predicate name: both flags answer 「is somebody other than
 * me spending this plan right now」, and the name stays `guestIsSpending`
 * because renaming it would not make the answer any truer — the fold already
 * happened at [`foldBudgetFrame`], where `asGuestSpeaker(frame) ||
 * asSignedInSpeaker(frame)` is the actual union; this function only reads the
 * one bit that resulted.
 *
 * 🔴 SAME WATCHDOG, AND FOR THE SAME REASON, not for symmetry. The relay has no
 * 「the recording ended」 frame on this channel either: whoever else was speaking
 * stops, the heartbeats stop, and nothing arrives to say so. A sentence left
 * standing would tell the owner that their plan is being spent by somebody who
 * left — which is worse than the peer sentence going stale, because this one is
 * about the owner's own money. The latch's `guestSpeaker: false` closes the
 * ordinary case (the owner starts speaking, the next heartbeat says `self` with
 * neither flag); the ageing test closes the case where nothing arrives at all.
 *
 * 🔴 AND IT CANNOT BE TRUE AT THE SAME MOMENT AS [`farEndIsPaying`], by
 * construction rather than by a rule written somewhere: both `asGuestSpeaker`
 * and `asSignedInSpeaker` only read their flag off a `payer:'self'` frame, and
 * one latch holds one `payer` word.
 */
export function guestIsSpending(latch: PayerLatch | null, nowMs: number): boolean {
  return latch !== null && latch.guestSpeaker && isFresh(latch, nowMs);
}

/**
 * Has the relay spoken recently enough for its last word to still be describing
 * the recording in front of the user? Shared by both readings so the two
 * sentences can never disagree about when the evidence ran out.
 */
function isFresh(latch: PayerLatch, nowMs: number): boolean {
  const age = nowMs - latch.atMs;
  // A frame stamped in the future is a clock that moved, not evidence. Treated
  // as fresh rather than as stale: the alternative is that a backwards clock
  // step silently deletes a true sentence.
  return age <= PAYER_FRESH_MS;
}
