// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §6.1 (single source of truth
//     PlanView + PlanSource's four values + four-step priority), §6.1-bis (permanent_free
//     is an exemption, not a tier; effectiveLimits is the sole source of quota)
//   docs/decisions/2026-08-01-owner-three-tier-pricing-usd-monthly.md (three-tier table)
//
// 🔴 SPLIT OUT OF billing-service.ts on 2026-09-02 (WP-2) SOLELY because that file
// hit the repo's 800-line cap while landing the P0-2 fix (canceled/paused +
// null-period ⇒ expired) — same reason schema-billing.ts split off schema.ts on
// 2026-08-21. Nothing about these types changed in the move: this is `Cycle` /
// `PlanSource` / `SubState` / `PlanView` / `QuotaView`, VERBATIM, re-exported from
// billing-service.ts so every existing `import ... from '.../billing-service'`
// keeps working unchanged.

import type { Plan } from '@flowmic/protocol';

export type Cycle = 'monthly' | 'yearly';
/** D1 §6.1 — "what makes this tier this tier". A SEPARATE field from `plan` on purpose:
 *  merging them is how a console ends up showing "you are Pro" with no way to say
 *  where that came from, which is this repo's #1 bug shape. */
export type PlanSource = 'permanent_free' | 'paddle' | 'mock' | 'none';
/** The mock machine's five states plus the two Paddle adds. `past_due` and
 *  `paused` are Paddle-only and deliberately NOT collapsed into `canceled`:
 *  "Paddle is still retrying the charge" and "the user paused it themselves" are
 *  different facts and produce different console copy, even though today neither
 *  one drops the tier (§5). */
export type SubState = 'none' | 'pending' | 'active' | 'canceled' | 'expired' | 'past_due' | 'paused';

export interface PlanView {
  /** The tier in force. 🔴 For a permanent_free account this stays `'free'` —
   *  owner bought nothing, and writing 'pro'/'max' there would be a lie. The
   *  "unlimited quota" face is driven by `source` + `quota_exempt`, never by `plan`. */
  plan: Plan;
  /** 🔴 Why `plan` is what it is. */
  source: PlanSource;
  /** D1 §6.1-bis — the exemption, surfaced so a UI can say where this account's
   *  numbers come from. Its ONE producer is the `users.permanent_free` branch
   *  below.
   *
   *  🔴 2026-08-07 — IT NO LONGER MEANS "unlimited quota". It means "the quota
   *  does not come from the `plan` table": an exempt account is now capped at
   *  MAX's numbers (see [EXEMPT_LIMITS]), so a limit IS being enforced. A surface
   *  that renders "unlimited"/"no cap" off this flag now states something false —
   *  the exact "label doesn't match the number actually in force" shape D1 and
   *  R11 exist to stop.
   *
   *  ⚠️ 2026-08-09 CORRECTION (card BILL-1, measured). This paragraph used to end:
   *  「Known consumer still doing it: `cloud_usage_minutes_exempt` … an OPEN
   *  follow-up owned outside apps/server-core, not something this file fixed.」
   *  It was FALSE THE DAY IT WAS WRITTEN. The same commit that wrote it (92a4289)
   *  also rewrote all four locales of that exact string — 不限额/unlimited/無制限/
   *  무제한 → 不计费/not billed/請求なし/청구 없음 — plus `usageLine` around it.
   *  Nobody re-read the desktop afterwards, so the sentence was carried forward
   *  into the 0.3.0 ledger as card BILL-1 and booked as a live R11 violation
   *  against a tree that no longer had one.
   *  ⇒ anti-façade ④ in its worst form: an assertion about ANOTHER file's behaviour,
   *  with no grep anchor and no test holding it, so nothing could turn red when it
   *  became wrong — and it was wrong immediately, not merely later.
   *  ⇒ The claim is now PINNED rather than asserted: cloud-account.test.ts
   *  describe ⑤ drives this flag through `usageLine` in all four UI locales and
   *  fails if any locale claims boundlessness or drops the server's number. Change
   *  that string in one locale and that test — not this comment — is what tells you. */
  quota_exempt: boolean;
  cycle: Cycle | null;
  state: SubState;
  expires_at: string | null;
  /**
   * 0.3.25 B1 — a change Paddle has SCHEDULED but not yet applied, or null.
   *
   * 🔴 A SEPARATE FIELD FROM `state`, and this is the R11 case the 0.3.25 round
   * exists for. A subscription scheduled to cancel at period end is `active` at
   * Paddle — because it is — so `state` alone gave the console ONE word for TWO
   * facts: 「active」 and 「active, and will not renew」. Folding the second into
   * `state:'canceled'` would be worse, not better: the tier IS still granted and
   * the service IS still running, so that word would be false in the direction
   * that matters — a user reading 「canceled」 stops using something they paid for.
   *
   * ⚠️ `action` is Paddle's RAW word, not a narrowed union, for the same reason
   * `status` is stored raw: cancel / pause / resume is what Paddle documents
   * today, and a fourth value must reach the console as itself rather than be
   * rounded into one of the three we knew about. The console renders copy for
   * the actions it recognises and says nothing for one it does not.
   *
   * ⚠️ `effective_at` can be null while `action` is set: the payload stated a
   * change without a readable date. 「Something is scheduled, we cannot say when」
   * is the truth in that case, and it is not the same fact as no change at all.
   */
  scheduled_change: { action: string; effective_at: string | null } | null;
  /**
   * 0.3.25 B1 — 「you will be charged again on」, or null when no charge is
   * scheduled (Paddle nulls it once a cancellation is pending).
   *
   * 🔴 NOT the same question as `expires_at`. That one answers 「how long you
   * have paid for」 and survives a cancellation; this one answers 「will money
   * move again, and when」 and disappears. On a live subscription the two hold
   * the same date and the temptation is to keep only one field; on a cancelled
   * one they differ, and that is exactly the state a user opens this page to
   * understand.
   */
  next_billed_at: string | null;
  /**
   * 0.3.25 B3 — the end of the EU statutory withdrawal period (CRD art. 9),
   * or null when there is none to state.
   *
   * 🔴 IT IS ON THE PLAN VIEW, not computed in the browser, because the console
   * and the server must not be able to disagree about it. A page that offers a
   * legal right the server then refuses — or hides one the server would have
   * honoured — is worse than not having the feature: the user is told, by us,
   * something about their rights that is false. `billing/withdrawal.ts` is the
   * single decider and both sides read this field.
   *
   * ⚠️ null carries TWO facts on purpose collapsed here and separated at the
   * route: 「the period has passed」 and 「we cannot compute it」. The console does
   * the same thing with both (offer nothing, which is correct either way), while
   * the route names them apart — because 「your period has ended」 is a claim we
   * cannot support for a subscription whose start we never recorded.
   */
  withdrawal_deadline: string | null;
  /**
   * 0.3.25 B3 — when the contract was concluded, or null if we never recorded it.
   *
   * 🔴 IT IS NOT A DUPLICATE OF THE DEADLINE. The deadline answers 「until when
   * may I withdraw」 and is what both sides branch on; this answers 「which
   * contract am I withdrawing from」, which CRD art. 11(3) requires the confirmation
   * step to state. Deriving one from the other in the browser would put a second
   * computation of a legal date in the UI — the thing `withdrawal_deadline`
   * exists on the wire to prevent.
   */
  contract_concluded_at: string | null;
  /** sub_xxx when `source === 'paddle'`, else null — the reconciliation handle
   *  that lets a human match this readout against Paddle's own dashboard. */
  paddle_subscription_id: string | null;
  /**
   * WHICH merchant of record that subscription lives at.
   *
   * 🔴 THE FIELD NAME ABOVE IS NOW A HISTORICAL ONE, AND THIS IS THE
   * CORRECTION. `paddle_subscription_id` holds a CREEM id for a Creem
   * subscription — the column is shared, and renaming it would move a wire
   * format the console and the desktop already read. So the id alone stopped
   * being enough to say where to send a cancellation, and this answers that
   * separately rather than letting the old name go on implying an answer it no
   * longer has.
   *
   * ⚠️ `null` WHEN THERE IS NO SUBSCRIPTION, and — importantly — also for rows
   * written before the `provider` column existed. Those are Paddle's by
   * construction (it was the only writer), but that is an INFERENCE, and
   * http/billing-routes.ts is the one place allowed to make it, out loud, once.
   * Defaulting it here would spread a guess into every reader.
   */
  billing_provider: string | null;
}
export interface QuotaView {
  /** ⚠️ 2026-08-07 CORRECTION — these used to be `Number.POSITIVE_INFINITY` for a
   *  quota-exempt account, and this note used to explain that ∞ serializes to
   *  `null`. Both meters are FINITE for every account now, exempt included (owner's
   *  ruling ①; see [EXEMPT_LIMITS]) ⇒ nothing here reaches the wire as `null` any
   *  more, and a `null` that does show up means we failed to compute it. Still do
   *  NOT read "unlimited" off these numbers — nobody is unlimited; read
   *  `PlanView.quota_exempt` for "what makes these numbers these numbers" and nothing else. */
  stt: { used_min: number; limit_min: number };
  /**
   * The metering cycle being counted (owner 2026-09-05, option 乙): its first
   * day and the day it resets, both `YYYY-MM-DD` UTC. Anchored to the account
   * — registration, the subscription's start, or the day a subscription ended —
   * not to the calendar month. `month` below still carries the bucket key for
   * older console builds.
   */
  period: { start: string; end: string };
  /** owner 2026-08-14 — `used` is the ENFORCED number: OUTPUT tokens only, the
   *  same quantity quota-guard.ts reads. `used_in` is the reference meter —
   *  recorded and shown, never charged against `limit`. Two fields on purpose:
   *  until 2026-08-14 `used` was `in + out`, i.e. one value answering both
   *  "how much quota is left" and "how much has been processed in total", and
   *  the ruling split them. `used_in`
   *  is ADDITIVE on the wire; older clients that only read `used`/`limit` keep
   *  working and now see the enforced number instead of the sum. */
  llm: { used: number; used_in: number; limit: number };
  month: string;
}
