// SPEC-REF:
//   docs/archive/strategy/2026-09-11-metering-principal-matrix-design.md §3 D5 + §8 Q3
//     (「PC 屏幕不许把「别人在扣」画成自己的表」; the adopted answer is 「说、但不透
//      对方余量」)
//   apps/desktop/src/lib/billing-payer.ts (where the `payer` word off
//     `billing:budget` becomes the boolean this file is handed, and where the
//     watchdog lives)
//   apps/desktop/src/lib/cloud-account.ts (④ the quota gauge this sentence sits
//     under; its only production caller, rendered by
//     main-window/components/CloudAccountLines.vue)
//
// One sentence: whose minutes the recording happening right now is costing —
// somebody else's (MP-3), or this computer's on behalf of somebody else who is
// speaking into it — a visitor who is not signed in (MP-8) or a different
// signed-in account (MP-10, card G-2b2). At most one of them, in one slot.
//
// 🔴 ITS OWN FILE FOR THE SAME REASON cloud-account-reset.ts IS ONE. It takes two
// yes/no answers and returns a sentence; it never reads a number, a plan or a
// ledger, which is precisely the property that has to stay true — the moment this
// function can see an amount, somebody will render one, and the amount in
// question belongs to an account this computer is not entitled to report on.
//
// ⚠️ It takes `accountOnScreen: boolean` rather than the account itself, and that
// is not only taste: importing `LiveAccount` from cloud-account.ts (even as a
// type) closes an import cycle, and `verify:lint circular` says so — measured,
// this file's first draft failed exactly that way.

import { S } from './strings';

/**
 * ④-quater — the sentence, or nothing (card MP-3, design §8 Q3 as adopted:
 * 「说、但不透对方余量」; card MP-8 for the guest half, design §10-3; card MP-10
 * folded into the same half by card G-2b2).
 *
 * 🔴 GATED ON HAVING AN ACCOUNT ON SCREEN, not merely on the frame. The sentence
 * is an explanation of ④; on a card that is showing nothing (signed out, 401,
 * never-answered) there is no still meter to explain, and a lone line about
 * somebody else's billing would raise the question it exists to close. A phase
 * with no account also cannot produce these frames in the first place — the
 * relay only pushes a budget frame to a socket it has an account for — so this
 * gate should never be the thing that hides it, and if it ever is, the missing
 * account is the more interesting fault.
 *
 * ⚠️ It is deliberately NOT gated on `gauge !== null`. An unreadable meter is a
 * different failure with its own rendering (both ends absent), and 「who is
 * paying」 stays true and worth saying whether or not we managed to read our own
 * numbers.
 */
export function payerNote(
  accountOnScreen: boolean,
  farEndPays: boolean,
  guestSpends: boolean,
): string | null {
  if (!accountOnScreen) return null;
  // 🔴 ONE SLOT, TWO OPPOSITE FACTS, AND AT MOST ONE OF THEM (cards MP-8 and
  // MP-10). They answer the same question — 「whose minutes are these words
  // costing」 — and a screen that showed both would be answering it twice,
  // differently. They cannot both arrive: `guest_speaker` and
  // `signed_in_speaker` are each only read off a `payer:'self'` frame
  // (billing-payer.ts [asGuestSpeaker] / [asSignedInSpeaker]), so `far_end`
  // excludes both upstream of here. The order below is what a
  // self-contradictory frame would get if that ever stopped being true, and it
  // prefers the sentence that claims LESS: 「the other end is paying」 makes no
  // claim about this account's money, while 「somebody else is spending your
  // plan」 does.
  //
  // ⚠️ UNREACHABLE FOR A PC FAR END SINCE 09-11 (record-only; card G-2b,
  // docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §7.2). Target-state payer
  // resolution names the PC owner in every app/web-room case that can reach a
  // PC's socket, so `farEndPays` should never arrive `true` here again. Left in
  // place (failure direction: an old relay might still send it) — remove this
  // branch and `cloud_usage_paid_by_peer` only once that is confirmed to have
  // stopped for good.
  if (farEndPays) return S.cloud_usage_paid_by_peer;
  // 🔴 THE TRIGGER WIDENED; THE SENTENCE ALREADY SAID THE RIGHT THING (card
  // G-2b2, closing the account this file's own history left open at G-2b).
  // `guestSpends` is no longer `asGuestSpeaker` alone: since card G-2b2,
  // billing-payer.ts's `foldBudgetFrame` OR's `asGuestSpeaker` together with
  // `asSignedInSpeaker` (card MP-10's sibling wire flag,
  // packages/protocol/src/protocol-schemas-billing.ts `signed_in_speaker`)
  // into the one bit `guestIsSpending` reads — so this parameter is `true` for
  // an UNSIGNED visitor (card MP-6) exactly as before, AND for a DIFFERENT
  // SIGNED-IN account speaking into this computer (card MP-10). Both are 「the
  // minutes in this frame are yours and somebody else is spending them」, which
  // is exactly the fact this sentence claims and nothing more — that is why
  // MP-10 got no sentence of its own and this branch needed no second `if`.
  if (guestSpends) return S.cloud_usage_spent_by_other;
  return null;
}
