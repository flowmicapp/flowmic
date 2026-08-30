// SPEC-REF:
//   apps/server-core/src/billing/guided-setup.ts (the two numbers and gs-5's
//     promise, which this is the machinery for)
//   apps/server-core/src/db/repos/one-time-purchase.repo.ts (the row)
//   owner rulings 2026-08-30: 「14天客户未同意启动就退款」,
//     「默认到期由运营队列中由人按一下，但要实现自动退的功能和开关」,
//     and the same day's lifecycle ruling: completion closes refunds; the
//     40-day completion deadline is internal only and never applies to a
//     setup that is in progress; the post-completion fortnight is support.
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// 🔴 THE ONE PLACE THAT ANSWERS 「is this purchase past a deadline we promised」
// AND 「can it still be refunded」.
//
// The operator queue asks it to decide what to show; the sweep asks it to decide
// whether to act; the customer console asks it whether to draw the withdraw
// button. Two deciders would mean a queue that flags a purchase the sweep will
// not touch, or a console offering a button the write will refuse — and on a
// surface that moves money, those are not cosmetic.
//
// ⚠️ TWO CLOCKS LIVE HERE AND THEY START AT DIFFERENT EVENTS. The two DEADLINES
// run from the purchase (14 days to start, 40 to finish); the SUPPORT period
// runs from the delivery. They are in one file because they are one promise
// seen from two ends, and they are separate functions because merging them
// would need a single 「due date」 that answered both — this repo's number-one
// defect shape (one value, two questions).
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

/** The state a purchase must still be in for a deadline to mean anything. */
import type { OneTimePurchaseState } from '../db/repos/one-time-purchase.repo';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why a purchase is due to be refunded, or null.
 *
 * 🔴 TWO REASONS AND NOT ONE, because they are two different failures and an
 * operator's next move differs:
 *
 *   'no_start'      — 14 days on, the customer has never engaged. We have done
 *                     no work. Refunding costs us nothing and is the whole
 *                     point of having this deadline: it stops us holding money
 *                     for somebody who never came back, and it stops us doing
 *                     unpaid work later for somebody who was never going to
 *                     take part.
 *   'not_completed' — 40 days on, the customer DID engage (a time was booked)
 *                     and we have not started. This one is ours. The operator
 *                     may well want to talk to them before refunding, which is
 *                     exactly why the default is a queue entry rather than an
 *                     automatic refund. ⚠️ INTERNAL ONLY: it is not in the
 *                     consent wording and must not reach customer copy.
 *
 * Collapsing them into 「overdue」 would hide which side failed, on the screen
 * where somebody decides what to do about it.
 */
export type RefundDueReason = 'no_start' | 'not_completed';

export interface DeadlinePolicy {
  /** Days after purchase by which we must have started. */
  startDeadlineDays: number;
  /** Days after purchase by which a BOOKED setup must have finished. Internal. */
  completeDeadlineDays: number;
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
}

/**
 * Is this purchase past a deadline we promised, and which one.
 *
 * ⚠️ 'in_progress', 'delivered', 'refund_requested' and 'refunded' ARE NEVER
 * DUE. A setup that has started is being worked on — refunding it on a clock
 * would take money back from somebody mid-session; a delivered one is a promise
 * kept; the other two are money already on its way back, and flagging them
 * would put a second refund in front of an operator for a purchase that has one.
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
  if (subject.state !== 'paid' && subject.state !== 'scheduled') return null;
  const boughtMs = Date.parse(subject.created_at);
  if (Number.isNaN(boughtMs)) return null;
  const ageDays = (nowMs - boughtMs) / DAY_MS;

  // 🔴 'paid' MEANS NOBODY HAS EVEN BOOKED A TIME. That is what makes the
  // 14-day rule mean 「the customer never engaged」 rather than 「we are slow」:
  // an operator who has spoken to them and put a time in the diary has already
  // moved the row to 'scheduled', which changes which deadline applies — and
  // one who has actually begun has moved it to 'in_progress', which removes it
  // from every deadline.
  if (subject.state === 'paid' && ageDays >= policy.startDeadlineDays) return 'no_start';
  if (ageDays >= policy.completeDeadlineDays) return 'not_completed';
  return null;
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
 * ⚠️ 'in_progress' ANSWERS null. There is no clock on a setup that has begun;
 * the operator is in the room and the row needs no date beside it.
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
  if (subject.state !== 'paid' && subject.state !== 'scheduled') return null;
  const boughtMs = Date.parse(subject.created_at);
  if (Number.isNaN(boughtMs)) return null;
  const days = subject.state === 'paid' ? policy.startDeadlineDays : policy.completeDeadlineDays;
  return new Date(boughtMs + days * DAY_MS).toISOString();
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
