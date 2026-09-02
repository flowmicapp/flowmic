// SPEC-REF:
//   apps/server-core/src/db/schema-billing.ts ONE_TIME_PURCHASE_SQL
//   apps/server-core/src/billing/creem/envelope.ts (reads these metadata keys)
//   apps/server-core/src/http/billing-routes.ts (writes them at checkout)
//   owner ruling 2026-08-29: 「付款后 3 个工作日内联系；一次会话不超过 3 小时,
//     具体要看下单客户方的资源准备情况, 在联系时会先确认资源准备情况和要求」
//   Directive 2011/83/EU (CRD) art. 7(3), 16(a) — the two affirmations below
//   *** HUMAN-AUDIT SENSITIVE (billing / legal) — reviewable in isolation ***
//
// The paid one-time service: what we promise, and what the buyer agreed to.
//
// ── 🔴 WHY THE WORDING IS VERSIONED AND NOT JUST TIMESTAMPED ────────────────
//
// A consent record that stores only 「they ticked it at 14:03」 cannot answer the
// only question a dispute actually asks: WHAT DID THEY AGREE TO. The wording
// will change — it is product copy — and a timestamp against wording nobody kept
// is evidence of nothing. So the version is stored beside the stamp, this file
// is the one place a version's text lives, and 🔴 A PUBLISHED VERSION'S TEXT IS
// IMMUTABLE: changing the words means minting the next id, never editing these.
//
// ⚠️ THIS IS THE FIRST-RESPONSIBLE'S DRAFTING, NOT LEGAL ADVICE, and owner
// delegated it ('其它的你自主决定') rather than reviewing it. It should be read by
// a lawyer before the first real sale. What it is built on is stated so that
// review has something to check rather than a paraphrase:
//   · art. 7(3) — to begin a service inside the 14-day window at all, the
//     trader needs the consumer's EXPRESS REQUEST. That is affirmation ①.
//   · art. 16(a) — the right of withdrawal is lost only once the service is
//     FULLY PERFORMED, and only if performance began with that prior express
//     consent AND with the consumer's acknowledgement that full performance
//     ends the right. That acknowledgement is affirmation ②.
//   · art. 14(4)(a) read with 14(3) — a consumer who withdraws after requesting
//     an early start still owes a PROPORTIONATE amount for what was delivered,
//     not the whole price. ⇒ 「you lose your right」 on its own would be false
//     until the session is finished, which is why ② names the moment the right
//     ends and the copy says what remains true before then.
//     ⚠️ SINCE gs-3 THIS ARTICLE IS BACKGROUND, NOT MACHINERY. owner's rules
//     give a FULL refund at any time before completion is confirmed, so there
//     is no partial one to compute and nothing in the code calculates a
//     fraction. If that generosity is ever withdrawn, this article comes back —
//     and it comes back needing a calculation that has never existed here.
//
// 🔴 WHAT THESE TWO ARE NOT: a waiver of the withdrawal right in general. Such a
// waiver is unenforceable, and copy that implied one would be worse than no copy
// — it would tell a consumer they had lost a right they still hold. Everything
// below is written to survive being read by the person it is about.

import type { DeadlinePolicy } from './service-deadlines';

/** owner 2026-08-29. The promise the console is allowed to make on the strength
 *  of a completed purchase, and the ONLY number any surface may print for it. */
export const GUIDED_SETUP_CONTACT_BUSINESS_DAYS = 3;

/** owner 2026-08-29: 「一次会话不超过 3 小时」. An upper bound, not a duration —
 *  the copy must not promise three hours of anything. */
export const GUIDED_SETUP_MAX_SESSION_HOURS = 3;

/**
 * The current consent wording's id.
 *
 * ⚠️ BUMP THIS, NEVER EDIT A PUBLISHED ENTRY. A stamp stored against `gs-1`
 * must keep meaning the words `gs-1` had on the day it was stored.
 */
export const GUIDED_SETUP_CONSENT_VERSION = 'gs-5';

/** Days after purchase by which we contact and start, or refund unasked.
 *  🔴 THE ONLY DEADLINE. History, one line: a 40-day completion promise existed
 *  in the gs-2..gs-4 wording (and briefly survived gs-5 as an internal flag);
 *  owner removed the concept entirely on 2026-08-30 (「不要再提 40 天了」). */
export const GUIDED_SETUP_START_DEADLINE_DAYS = 14;
/**
 * Days of support AFTER completion, counted from `delivered_at`.
 *
 * 🔴 SUPPORT ONLY, since gs-5. Under gs-3/gs-4 this same number also measured a
 * post-completion refund window that ran from the completion email; owner
 * 2026-08-30 ruled that completion ends the no-reason refund outright, so there
 * is no second clock for this number to be. What remains of the fortnight is
 * help: while it runs the console shows `next_step: 'support'` and a
 * `support_until` date, and after it the service is `closed`. Neither is stored
 * — both are derived from `delivered_at` on every read.
 */
export const GUIDED_SETUP_AFTERCARE_DAYS = 14;

/**
 * The deadline above, as the one object every deadline consumer reads.
 *
 * 🔴 NOT CONFIGURABLE, AND THAT IS THE POINT. The start deadline appears
 * verbatim in the text a buyer agreed to (gs-5). An env var that could move it
 * would let a deployment enforce a promise nobody was ever shown — the
 * version-stamped wording would say 14 days while the machine counted 4. If it
 * ever needs to differ per deployment, the CONSENT WORDING has to be
 * per-deployment too, and that is a different design with a different evidence
 * problem.
 *
 * ⚠️ Route deps still accept an override, and that is for TESTS ONLY: a test has
 * to be able to move a deadline without moving the clock. Nothing in
 * `bootstrap-*.ts` passes one.
 */
export const PROMISED_DEADLINES: DeadlinePolicy = {
  startDeadlineDays: GUIDED_SETUP_START_DEADLINE_DAYS,
};

/**
 * The English source of what a buyer affirms. The console renders its own
 * locales; this is the record's canonical text and what a reviewer reads.
 *
 * 🔴 THE TWO ARE SEPARATE AFFIRMATIONS AND MUST STAY SEPARATE. They do different
 * legal work — one is a request, the other is an acknowledgement — and a single
 * merged checkbox could not evidence either one cleanly.
 */
export const GUIDED_SETUP_CONSENT_TEXT: Readonly<Record<string, { earlyStart: string; waiverAck: string; whatRemains: string }>> = {
  // ⚠️ NEVER PUBLISHED. gs-1 was written on 2026-08-29 and superseded on
  // 2026-08-30 before Creem was ever enabled on any deployment, so no stored
  // stamp anywhere references it. It is kept rather than deleted because the
  // table's whole contract is that a version's text is immutable, and deleting
  // the first entry would teach the opposite lesson to the next reader.
  //
  // 🔴 WHY IT WAS SUPERSEDED, since that is the reusable part: its third
  // paragraph promised a PROPORTIONATE refund for a withdrawal 「after we have
  // started but before we finish」 — and the state machine had no such state,
  // no calculation existed, and the retention on this path was always zero
  // (billing/withdrawal.ts's header carries the CRD art. 14 argument for why).
  // The copy described a case the mechanism could not represent. owner's
  // rules then removed the case entirely: a full refund is available until
  // completion, so there is no partial one to compute.
  'gs-1': {
    // ① CRD art. 7(3) — the express request.
    earlyStart:
      'I ask FlowMic to begin this setup service before the 14-day withdrawal period ends, ' +
      'so that it can be scheduled straight away rather than after that period.',
    // ② CRD art. 16(a) — the acknowledgement. Note 「once it has been fully
    // performed」: before that point the right is still there, which is the next
    // line's job to say.
    waiverAck:
      'I understand that once this setup session has been fully performed I will no longer ' +
      'have a right to withdraw from it.',
    // 🔴 NOT DECORATION. Without this sentence the two above are technically
    // accurate and practically misleading: a buyer would reasonably read them as
    // 「I have given up my refund」, which is false until the session happens.
    whatRemains:
      'Until the session takes place you can still withdraw. If you withdraw after we have ' +
      'started but before we finish, you pay only for the part already delivered, and the rest is refunded.',
  },
  // ⚠️ NEVER PUBLISHED EITHER. gs-2 was written and superseded on the same day
  // (2026-08-30), again before Creem was enabled anywhere, so again no stored
  // stamp references it. Kept for the same reason gs-1 is.
  //
  // 🔴 WHY IT WAS SUPERSEDED, and this one is the reusable lesson: its ②
  // claimed that 「completed」 named something checkable — 「the product itself
  // observes the setup working」 — and NOTHING OBSERVED ANYTHING. The only
  // producer of that state was an operator clicking a button. So the sentence
  // was a claim about a mechanism that did not exist, written into the one
  // artefact a consumer would be held to: 「契约写对了不等于实现做到了」, on a
  // legal right, in nine languages.
  //
  // ⚠️ THE HONEST FIX WAS NOT TO BUILD THE OBSERVER. Automatic observation was
  // designed and then withdrawn: the only way to see 「their phone and PC are
  // working together」 is to record LAN sessions, and privacy-policy.md line 48
  // promises verbatim that sessions which stay on the local network are NOT
  // recorded. The product's whole point is that they stay there. So gs-3 stops
  // claiming an observation and instead makes the operator's assertion
  // CONTESTABLE — which is what the consumer actually needed from it.
  'gs-2': {
    // ① CRD art. 7(3) — the express request, unchanged in substance.
    earlyStart:
      'I ask FlowMic to begin this setup service before the 14-day withdrawal period ends, ' +
      'so that it can be scheduled straight away rather than after that period.',
    // ② CRD art. 16(a). 🔴 'completed' NOW NAMES SOMETHING CHECKABLE rather than
    // an operator's opinion: the product itself observes the setup working. A
    // consumer who is told they lose a right at a moment they cannot verify has
    // been told very little.
    waiverAck:
      'I understand that this service counts as completed once my phone and computer are ' +
      'working together through FlowMic, and that from that moment I can no longer withdraw from it.',
    // 🔴 THE PART THAT DOES THE REAL WORK, and it is now a plain promise rather
    // than a fraction nobody could compute. owner 2026-08-30: a full refund is
    // available at any time before completion, from the console, without asking
    // us. That is more generous than the CRD requires, which is why the
    // proportionate-payment case (art. 14(3)) simply never arises.
    whatRemains:
      'Until then you can get all of your money back at any time, from your console, without ' +
      'giving a reason. If we have not started within 14 days, or have not finished within 40 days, ' +
      'we refund you without being asked. We issue the refund ourselves; if the payment channel ' +
      'cannot return it the way you paid, we will arrange another way with you. ' +
      'After completion you keep 14 days of support — that is help, not a refund window.',
  },
  // ⚠️ NEVER PUBLISHED EITHER — Creem was still switched off when gs-4 replaced
  // it on 2026-08-30, so no stored stamp references it.
  //
  // 🔴 WHY IT WAS SUPERSEDED, and this is the lesson of the three: its last
  // sentence, and the console line that echoed it, said the service was 「final
  // and cannot be refunded」 after the fortnight. Full stop. That reads as a term
  // shutting out remedies a consumer keeps by law no matter how old the purchase
  // — not supplied as described, never delivered, misrepresented — which is what
  // Directive 93/13/EEC Annex 1(b) names as potentially unfair.
  //
  // ⚠️ NOTE WHAT WAS AND WAS NOT WRONG WITH IT. At the time, the MECHANISM was
  // judged right and gs-4 kept it: a post-completion window, the notice that
  // started it, the null-stamp rule. What was wrong was one word too absolute
  // in the copy — which is exactly the kind of defect a legal read catches and
  // a test suite never will, because every test was asserting that the
  // sentence was PRESENT. (That mechanism was itself retired by gs-5; see the
  // gs-5 comment below.)
  'gs-3': {
    // ① CRD art. 7(3) — the express request. Unchanged in three versions, which
    // is the point: it is the only one of the three that was right first time.
    earlyStart:
      'I ask FlowMic to begin this setup service before the 14-day withdrawal period ends, ' +
      'so that it can be scheduled straight away rather than after that period.',
    // ② CRD art. 16(a), and it named a moment the consumer was present for.
    // gs-2 tied the loss of the right to an event only we could see; this tied
    // it to an email we send and a fortnight they could answer in. ⚠️ HISTORY,
    // NOT MACHINERY: under gs-3/gs-4 the claim SQL kept accepting a withdrawal
    // for 14 days after `completion_notice_at`, and a NULL stamp held it open.
    // gs-5 removed that window (completion closes the refund; the stamp is now
    // a record of the email and nothing else), so none of those clauses
    // describe what the code does today.
    waiverAck:
      'I understand that FlowMic records this service as completed once my phone and computer are ' +
      'working together, that FlowMic will email me when that happens, and that my right to ' +
      'withdraw ends 14 days after that email rather than at the moment it is sent.',
    // 🔴 THE PART THAT DOES THE REAL WORK. Note what it does NOT ask for: a
    // reason. A withdrawal is exercised, not applied for, and the console button
    // behind this sentence asks for nothing.
    whatRemains:
      'Until then you can get all of your money back at any time, from your console, without ' +
      'giving a reason. If we have not started within 14 days, or have not finished within 40 days, ' +
      'we refund you without being asked. We issue the refund ourselves; if the payment channel ' +
      'cannot return it the way you paid, we will arrange another way with you. ' +
      'The 14 days after the completion email are both your support period and your last chance to ' +
      'ask for the money back — one period, so that being helped and being refunded never run to ' +
      'different clocks. If we never send that email, the period never starts and you can still withdraw.',
  },
  // ⚠️ NEVER PUBLISHED EITHER — Creem was still switched off when gs-5 replaced
  // it on 2026-08-30, so no stored stamp references it.
  'gs-4': {
    // ① CRD art. 7(3) — the express request. Unchanged in four versions.
    earlyStart:
      'I ask FlowMic to begin this setup service before the 14-day withdrawal period ends, ' +
      'so that it can be scheduled straight away rather than after that period.',
    // ② CRD art. 16(a). Unchanged from gs-3 in substance (and, like gs-3's,
    // describing the email-started window that gs-5 retired).
    waiverAck:
      'I understand that FlowMic records this service as completed once my phone and computer are ' +
      'working together, that FlowMic will email me when that happens, and that my right to ' +
      'withdraw ends 14 days after that email rather than at the moment it is sent.',
    // 🔴 THE ONE SENTENCE THAT CHANGED FROM gs-3, AND WHY IT HAD TO.
    //
    // gs-3 ended 「After completion you keep 14 days…」 with the machinery for it,
    // and the console printed a companion line saying the service was then
    // 「final and cannot be refunded」. Read as a contract term, an unqualified
    // 「cannot be refunded」 purports to shut out remedies a consumer keeps by
    // law however long ago they bought: a service that was not supplied as
    // described, was never actually delivered, or was misrepresented. A term
    // that inappropriately excludes or limits a consumer's legal rights against
    // the trader is squarely what Directive 93/13/EEC Annex 1(b) names as
    // potentially unfair — and an unfair term is not merely unenforceable, it
    // draws enforcement.
    //
    // ⚠️ THE CARVE-OUT COST NOTHING gs-4 MEANT TO KEEP. It did not reopen the
    // no-reason withdrawal — under gs-4 that still ended with the fortnight. It
    // said the fortnight was the end of 「change your mind」, not the end of
    // 「it does not work」, which was always what we meant. gs-5 keeps the
    // carve-out and moves the end of 「change your mind」 to completion itself.
    whatRemains:
      'Until then you can get all of your money back at any time, from your console, without ' +
      'giving a reason. If we have not started within 14 days, or have not finished within 40 days, ' +
      'we refund you without being asked. We issue the refund ourselves; if the payment channel ' +
      'cannot return it the way you paid, we will arrange another way with you. ' +
      'The 14 days after the completion email are both your support period and your last chance to ' +
      'change your mind — one period, so that being helped and being refunded never run to ' +
      'different clocks. If we never send that email, the period never starts and you can still withdraw. ' +
      'After those 14 days you can no longer withdraw simply because you have changed your mind. ' +
      'This does not affect your legal rights: if the setup was not provided as described, was not ' +
      'delivered, or does not work, you keep every remedy the law gives you and we will put it right ' +
      'or refund you.',
  },
  // 🔴 WHY gs-4 WAS SUPERSEDED (owner ruling 2026-08-30, verbatim intent):
  //   · completion ENDS the no-reason refund. The moment an operator confirms
  //     the setup is complete ('delivered'), the withdraw button disappears and
  //     the claim SQL refuses. gs-3/gs-4 kept a fortnight open after the
  //     completion email; that window no longer exists.
  //   · the post-completion fortnight is SUPPORT ONLY. Two weeks of help,
  //     reachable by replying to the completion email, and then the service is
  //     closed. It is not a refund period and the copy must not read as one.
  //   · the buyer must INITIATE a refund (console button, no reason asked).
  //     The one refund we make unasked is the 14-day no-start deadline, which
  //     stays in the text. The completion deadline earlier wordings promised
  //     is not mentioned — and since the evening ruling it no longer exists
  //     anywhere in the product; after completion a refund is discussed by
  //     email only.
  //
  // ⚠️ WHAT THIS DOES TO THE ART. 16(a) ARGUMENT. gs-3's reason for the window
  // was that 「complete」 was decided by the party it benefits, on a fact only
  // that party could see. That concern is now answered by the email (the buyer
  // is told the instant the right ends, with the order named) and by the
  // statutory-rights carve-out, which is unconditional and survives completion:
  // a setup that was not as described, not delivered, or does not work is put
  // right or refunded however long ago it was marked done.
  //
  // 🔴 EVERY CLAUSE BELOW MAPS TO A MECHANISM THAT EXISTS TODAY:
  //   「once FlowMic confirms my setup is complete」 → state 'delivered', set by
  //       POST /api/ops/purchases/advance and nothing else;
  //   「I can no longer withdraw」 → `refundWindow` answers closed/'completed'
  //       and the claim SQL's state list excludes 'delivered';
  //   「FlowMic will email me」 → `sendSetupCompleted`, stamped as a record in
  //       `completion_notice_at` (it affects nothing);
  //   「two weeks of support」 → GUIDED_SETUP_AFTERCARE_DAYS, `supportUntil`;
  //   「at any time, from your console」 → POST /api/cloud/billing/service-withdraw,
  //       open while state ∈ {paid, scheduled, in_progress};
  //   「within 14 days of your order」 → GUIDED_SETUP_START_DEADLINE_DAYS and
  //       the 'no_start' deadline (sweep / ops queue).
  'gs-5': {
    // ① CRD art. 7(3) — the express request. Unchanged in five versions.
    earlyStart:
      'I ask FlowMic to begin this setup service before the 14-day withdrawal period ends, ' +
      'so that it can be scheduled straight away rather than after that period.',
    // ② CRD art. 16(a). The right ends at CONFIRMED COMPLETION; the email is
    // how the buyer learns of it, and the fortnight after is named as help so
    // it cannot be read as a second window.
    waiverAck:
      'I understand that once FlowMic confirms my setup is complete, I can no longer withdraw from ' +
      'this service. FlowMic will email me when that happens, and the two weeks of support that ' +
      'follow are help, not a refund period.',
    // 🔴 THE PART THAT DOES THE REAL WORK. Note 「you have to ask; we do not
    // assume」: the buyer initiates, and the only unasked refund is the no-start
    // deadline. No completion deadline is named, on purpose.
    whatRemains:
      'Until then you can get all of your money back at any time, from your console, without ' +
      'giving a reason — you have to ask; we do not assume. If we have not started within 14 days ' +
      'of your order, we refund you without being asked. We issue the refund ourselves; if the ' +
      'payment channel cannot return it the way you paid, we will arrange another way with you. ' +
      'After the two weeks of support the service is closed; you can still email us if you need ' +
      'help. This does not affect your legal rights: if the setup was not provided as described, ' +
      'was not delivered, or does not work, you keep every remedy the law gives you and we will put ' +
      'it right or refund you.',
  },
};

/** Metadata keys we set on a Creem checkout and read back off its webhook.
 *
 *  🔴 PREFIXED `fm_` SO OURS ARE DISTINGUISHABLE FROM ANYTHING CREEM OR A
 *  FUTURE INTEGRATION PUTS THERE. `flowmic_user_id` predates the prefix and is
 *  kept as-is: renaming a key that is already round-tripping through a live
 *  provider would orphan every checkout in flight at the moment of deploy.
 *
 *  ⚠️ THESE VALUES ARE OURS, ROUND-TRIPPED. We generate the stamps server-side
 *  at checkout creation; Creem echoes them back. A buyer cannot alter them
 *  without forging the webhook signature. But they CAN be lost if a provider
 *  ever drops metadata — in which case the purchase also loses its
 *  `flowmic_user_id` and lands as `unmapped`, which is loud. The failure is
 *  detectable rather than silent, and that is the property being relied on. */
export const GUIDED_SETUP_META = {
  consentVersion: 'fm_consent_v',
  earlyStartAt: 'fm_early_start_at',
  waiverAckAt: 'fm_waiver_ack_at',
} as const;
