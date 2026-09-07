// SPEC-REF:
//   apps/server-core/src/billing/guided-setup.ts (the one number and gs-5's
//     promise, which this is the machinery for)
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts (the row)
//   owner rulings 2026-08-30: 「14天客户未同意启动就退款」,
//     「默认到期由运营队列中由人按一下，但要实现自动退的功能和开关」,
//     the same day's lifecycle ruling: completion closes refunds and the
//     post-completion fortnight is support; and the evening ruling that
//     removed the completion deadline outright — the ONLY deadline is the
//     14 days to start, and a purchase that has been booked or begun is
//     never due on any clock.
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// 🔴 THE ONE PLACE THAT ANSWERS 「is this purchase past the deadline we promised」
// AND 「can it still be refunded」.
//
// The operator queue asks it to decide what to show; the sweep asks it to decide
// whether to act; the customer console asks it whether to draw the withdraw
// button. Two deciders would mean a queue that flags a purchase the sweep will
// not touch, or a console offering a button the write will refuse — and on a
// surface that moves money, those are not cosmetic.
//
// ⚠️ TWO CLOCKS LIVE HERE AND THEY START AT DIFFERENT EVENTS. The DEADLINE
// runs from the purchase (14 days to start); the SUPPORT period runs from the
// delivery. They are in one file because they are one promise seen from two
// ends, and they are separate functions because merging them would need a
// single 「due date」 that answered both — this repo's number-one defect shape
// (one value, two questions).
//
// 🔴 REFUNDABILITY IS A FUNCTION OF STATE ALONE since gs-5. Under gs-3/gs-4 a
// delivered purchase stayed refundable for a fortnight after the completion
// email, so this file needed a clock and a cutoff for the SQL. owner
// 2026-08-30 ruled that confirmed completion ends the no-reason refund, so
// `refundWindow` no longer reads a date and the claim SQL is a plain state
// list. The (subject, nowMs, policy) signature is kept so every caller and
// every pairing test stays stable; the extra arguments are simply unread.
//
// ── WHY THIS FILE IS PURE ─────────────────────────────────────────────────
//
// No database, no clock of its own, no provider. It maps (row, now) to a
// verdict, so the whole of the deadline policy is testable without a server and
// without money being able to move. Everything that CAN move money is on the
// other side of this boundary and has to state which verdict it acted on.

// ── 🔴 2026-08-31: A ROW A HUMAN TOOK OWNERSHIP OF CAN LEAVE THIS CLOCK ────
//
// The refund release path gave an operator two honest ways out of a stuck
// 'refund_requested'. One of them, `provider_declined`, means the payment
// provider has already refused an automatic refund on THIS row. Sending the
// unattended sweep back to ask the same provider the same question about the
// same charge is a loop, and an hourly timer must not keep re-opening a case a
// person has taken ownership of — the row would re-enter 'refund_requested'
// within the hour and land straight back where it was stuck, with the operator's
// decision silently undone.
//
// ⇒ `refundDueReason` returns null for such a row. Nothing else about it
// changes: it is still fully refundable by hand from the operator queue and
// still shows the buyer their withdraw button, because `refundWindow` is a
// function of STATE and the release put the state back.
//
// 🔴 AND `buyer_withdrew_request` DELIBERATELY STAYS ON THE SWEEP. That buyer
// changed their mind and wants the service; the 14-day no-start deadline exists
// to protect exactly them, and taking it away because of an unrelated
// bookkeeping action would be a silent loss of a promised protection — invisible
// to the buyer, invisible in any log, and discoverable only on the day it did
// not fire. The two reasons pulling in opposite directions is why the operator
// has to say which one it was.

/** The state a purchase must still be in for a deadline to mean anything. */
// parseUtcStamp: purchase rows are ISO-stamped by the webhook adapter today, but
// a parser that is right for BOTH stamp shapes costs nothing and removes a
// dependency on which writer produced the row (db/utc-stamp.ts).
import { parseUtcStamp } from '../db/utc-stamp';
import type { OneTimePurchaseState, RefundReleaseReason } from '../db/repos/one-time-purchase.repo';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why a purchase is due to be refunded, or null.
 *
 *   'no_start' — 14 days on, the customer has never engaged. We have done no
 *                work. Refunding costs us nothing and is the whole point of
 *                having this deadline: it stops us holding money for somebody
 *                who never came back, and it stops us doing unpaid work later
 *                for somebody who was never going to take part.
 *
 * 🔴 ONE REASON, AND IT IS A UNION ON PURPOSE. owner 2026-08-30 (evening)
 * removed the completion deadline this type used to carry a second member for:
 * a purchase that has been booked or begun is never due on a clock, full stop.
 * The type stays a named union rather than a bare literal so the operator
 * queue, the sweep and their tests keep reading 「which deadline」 through one
 * name — and so a second deadline, if owner ever restores one, is added here
 * and nowhere else.
 */
export type RefundDueReason = 'no_start';

export interface DeadlinePolicy {
  /** Days after purchase by which we must have started. The only deadline. */
  startDeadlineDays: number;
}

/** What the verdict needs from a row. A SLICE, not the row: these functions must
 *  not be able to see an amount or a customer, because neither may influence
 *  whether a promise was kept. */
export interface DeadlineSubject {
  state: OneTimePurchaseState;
  /** RFC3339. When the money arrived — the clock both deadlines run from. */
  created_at: string;
  /** RFC3339. When an operator recorded the setup as complete, or null. The
   *  support period runs from THIS. */
  delivered_at: string | null;
  /**
   * RFC3339. When we successfully EMAILED the customer that it was complete.
   *
   * ⚠️ A RECORD, NOT A CLOCK. Nothing in this file reads it: since gs-5 the
   * refund closes at `delivered_at` whether or not the email went out, and the
   * support period runs from `delivered_at` too. It stays on the slice so a
   * row can be passed here unchanged, and so a reader looking for 「where is
   * the notice used」 finds this sentence rather than silence.
   */
  completion_notice_at: string | null;
  /**
   * Why an operator released a stuck refund request, or null if none ever was.
   *
   * 🔴 THE ONE FIELD ON THIS SLICE THAT IS NOT A DATE, and the only one whose
   * value changes what the sweep does. See the block at the top of this file.
   */
  refund_release_reason: RefundReleaseReason | null;
}

/**
 * Is this purchase past the deadline we promised.
 *
 * ⚠️ ONLY 'paid' CAN EVER BE DUE. 'scheduled' and 'in_progress' are a customer
 * who engaged and work that is booked or under way — refunding either on a
 * clock would take money back from somebody we are actively working with, and
 * owner 2026-08-30 removed the clock that used to run on booked setups. A
 * 'delivered' one is a promise kept; 'refund_requested' and 'refunded' are
 * money already on its way back, and flagging them would put a second refund
 * in front of an operator for a purchase that has one.
 *
 * ⚠️ A ROW RELEASED AS 'provider_declined' RETURNS null WHATEVER ITS AGE, and
 * a row released as 'buyer_withdrew_request' is treated as though no release
 * had ever happened. The block at the top of this file argues both halves.
 *
 * ⚠️ AN UNPARSEABLE `created_at` RETURNS null, LOUDLY DOING NOTHING. A row whose
 * date we cannot read is not 「due」 — it is a row somebody has to look at, and
 * inventing a deadline from a NaN would refund on a date nobody chose. The
 * caller logs it; this function does not guess.
 */
export function refundDueReason(
  subject: DeadlineSubject,
  nowMs: number,
  policy: DeadlinePolicy,
): RefundDueReason | null {
  // 🔴 'paid' MEANS NOBODY HAS EVEN BOOKED A TIME. That is what makes the
  // 14-day rule mean 「the customer never engaged」 rather than 「we are slow」:
  // an operator who has spoken to them and put a time in the diary has already
  // moved the row to 'scheduled', and from that moment no deadline applies.
  if (subject.state !== 'paid') return null;
  // 🔴 A REFUND THIS PROVIDER ALREADY DECLINED IS NOT DUE AGAIN, EVER. Full
  // argument in the block at the top of this file. Note what is NOT here:
  // 'buyer_withdrew_request' falls through and stays on the clock.
  if (subject.refund_release_reason === 'provider_declined') return null;
  const boughtMs = parseUtcStamp(subject.created_at);
  if (Number.isNaN(boughtMs)) return null;
  const ageDays = (nowMs - boughtMs) / DAY_MS;
  return ageDays >= policy.startDeadlineDays ? 'no_start' : null;
}

/**
 * When the support period on a delivered purchase ends, or null if there is
 * none running.
 *
 * 🔴 RUNS FROM `delivered_at`, NOT FROM THE COMPLETION EMAIL. The email is how
 * the buyer learns the setup is done; the support they are owed starts when it
 * IS done. Null for every state but 'delivered', and for a delivered row whose
 * stamp we cannot read — a date we cannot parse is not a date we may promise
 * help until.
 *
 * ⚠️ DERIVED ON READ, NEVER STORED. A stored end date would keep saying the
 * same thing after a mis-marked delivery was walked back and re-made.
 */
export function supportUntil(
  subject: Pick<DeadlineSubject, 'state' | 'delivered_at'>,
  aftercareDays: number,
): string | null {
  if (subject.state !== 'delivered' || subject.delivered_at === null) return null;
  const deliveredMs = Date.parse(subject.delivered_at);
  if (Number.isNaN(deliveredMs)) return null;
  return new Date(deliveredMs + aftercareDays * DAY_MS).toISOString();
}

/**
 * The deadline a purchase is running against next, as a date, or null.
 *
 * Rendered to the operator so the queue can be read as a work list rather than
 * a list of rows that will one day turn red. NOT rendered to the customer: the
 * customer's promise is the sentence in gs-5, and a countdown to 「we refund
 * you」 invites waiting rather than the conversation the service needs.
 *
 * ⚠️ 'scheduled' AND 'in_progress' ANSWER null. There is no clock on a setup
 * that has been booked or begun (owner 2026-08-30); the operator is in the
 * conversation and the row needs no date beside it.
 */
export function nextDeadlineAt(
  subject: DeadlineSubject,
  policy: DeadlinePolicy,
  aftercareDays: number,
): string | null {
  // A delivered purchase is running against the SUPPORT clock, not a delivery
  // one. Answering null here would tell the operator console 「nothing is
  // pending on this row」 while we still owed two weeks of help on it.
  if (subject.state === 'delivered') return supportUntil(subject, aftercareDays);
  if (subject.state !== 'paid') return null;
  const boughtMs = parseUtcStamp(subject.created_at);
  if (Number.isNaN(boughtMs)) return null;
  return new Date(boughtMs + policy.startDeadlineDays * DAY_MS).toISOString();
}

/**
 * What a console shows about a refund request that ENDED without the money
 * moving through the provider — `null` when no release ever happened.
 *
 * 🔴 IT LIVES HERE, BESIDE `refundWindow`, FOR THAT FUNCTION'S REASON: the
 * customer console and the operator queue both render it, and two copies of
 * "what does a released refund look like" is how one of them comes to say
 * something the other does not. It deliberately carries NO sentence — the copy
 * is the console's, in its own nine (or four) locales; this answers only which
 * of the two things happened, and when.
 *
 * ⚠️ IT IS NOT A REFUND STATUS AND MUST NOT BE RENDERED AS ONE. A row can carry
 * a release AND be delivered, or carry a release and be back in flight on a
 * second request. The state is the state; this is the history of one decision.
 */
export interface RefundRelease {
  reason: RefundReleaseReason;
  /** RFC3339. */
  at: string;
}

export function refundRelease(
  subject: Pick<DeadlineSubject, 'refund_release_reason'> & { refund_released_at: string | null },
): RefundRelease | null {
  // 🔴 BOTH OR NEITHER, and the repo makes that true by writing them in one
  // statement. Answering with a reason and no date (or the reverse) would be
  // this function inventing half of a record — so a half-written row, which
  // the SQL cannot produce today, reads as "no release" rather than as a
  // partial one nobody can act on.
  const { refund_release_reason: reason, refund_released_at: at } = subject;
  if (reason === null || at === null) return null;
  return { reason, at };
}

/** Why a purchase can be refunded right now. */
export type RefundOpenReason =
  /** Completion has not been confirmed. paid, scheduled and in_progress alike:
   *  the buyer can withdraw at any moment up to the operator's confirmation. */
  'not_yet_completed';

/** Why it cannot. */
export type RefundClosedReason =
  /** Completion was confirmed. The no-reason refund ended at that instant;
   *  what remains is support, and the statutory-rights carve-out by email. */
  | 'completed'
  /** A refund is already in flight on this row — a second click, not an error. */
  | 'refund_in_flight'
  /** The money already went back. */
  | 'refunded'
  /** The row's state is not one this build knows. Refuse, never guess. */
  | 'unknown_state';

/**
 * ⚠️ `snake_case` BECAUSE THIS IS A WIRE SHAPE, not an internal one. Both routes
 * serialise it verbatim, and every other field on those responses is snake_case;
 * a camelCase field among them is the kind of inconsistency a client author
 * silently gets wrong once and then works around forever.
 */
export interface RefundWindow {
  open: boolean;
  reason: RefundOpenReason | RefundClosedReason;
  /** ALWAYS null since gs-5 — there is no longer a date on which an open
   *  window shuts; it shuts on an EVENT (confirmed completion). The field stays
   *  on the wire so a console built against gs-3/gs-4 keeps parsing, and it
   *  must never be rendered as 「expired」 on its own. */
  closes_at: null;
}

/**
 * Can this purchase be refunded right now, and why.
 *
 * 🔴 THE CUSTOMER CONSOLE, THE OPERATOR QUEUE AND THE SQL CLAIM ALL DERIVE FROM
 * THIS ONE ANSWER. It is not the enforcement point — the enforcement point is
 * the conditional UPDATE, because only a single atomic write can stop two tabs
 * refunding one charge twice. This is what makes the SCREENS agree with that
 * write, and its job is to be checkably identical to it rather than to be
 * trusted instead of it. The pairing test is what holds them together.
 *
 * ⚠️ `nowMs` AND `policy` ARE UNREAD since gs-5: the answer depends on state
 * alone. They stay in the signature so the three callers and the pairing test
 * did not have to change shape for a ruling that may yet be revisited.
 */
export function refundWindow(
  subject: Pick<DeadlineSubject, 'state'>,
  nowMs: number,
  policy: DeadlinePolicy,
): RefundWindow {
  void nowMs;
  void policy;
  switch (subject.state) {
    case 'paid':
    case 'scheduled':
    case 'in_progress':
      return { open: true, reason: 'not_yet_completed', closes_at: null };
    case 'delivered':
      // 🔴 CLOSED THE INSTANT COMPLETION IS CONFIRMED, whether or not the
      // completion email went out. The email is a record we owe, not the
      // trigger; a mail outage is logged and chased, it does not reopen money.
      return { open: false, reason: 'completed', closes_at: null };
    case 'refund_requested':
      return { open: false, reason: 'refund_in_flight', closes_at: null };
    case 'refunded':
      return { open: false, reason: 'refunded', closes_at: null };
    default:
      // The repo passes an unrecognised state through as the literal it is,
      // exactly so a caller can say so out loud rather than round it to
      // something convenient. Rounding here would either refuse a refund that
      // is owed or send money on a row nobody understands.
      return { open: false, reason: 'unknown_state', closes_at: null };
  }
}
