// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §6.1 (single source of truth
//     PlanView + PlanSource's four values + four-step priority), §6.1-bis (permanent_free
//     is an exemption, not a tier; effectiveLimits is the sole source of quota)
//   docs/decisions/2026-08-01-owner-three-tier-pricing-usd-monthly.md (three-tier table)
//   docs/strategy/2026-07-23-mock-billing-design.md §1 (plan + cycle;
//     FLOWMIC_MOCK_UNLOCK_ALL bypasses in exactly one place), §2 (mock checkout state
//     machine none/pending/active/canceled/expired), §3 (getQuota's current-month
//     used/limit; the sole expiry-determination site), §4 (BillingService stub
//     interface signature), §8 (the lead's ruling)
//   CLAUDE.md red line: no silent failure (fail-loud on over-quota); plan-state
//     writes converge to one place
//
// 🔴 THE SINGLE POINT that answers "what tier is this user on right now" (`resolve`)
// and "what is this user's quota right now" (`effectiveLimits`). Nothing else in the
// repo may decide either — D1's headline red line is "shows as upgraded but never
// took effect server-side", and two deciders is exactly how the display and the
// enforcement drift apart.
//
// The mock subscription state machine also lives here, single-sourced. The
// subscription record persists as the user_settings `account.subscription` JSON
// (additive, zero DB migration). Expiry is evaluated lazily on every read through
// the injectable clock (the ONE expires_at boundary site). UNLOCK_ALL bypasses
// ONLY inside `resolve` and never mutates stored state (§1). The gateway (HTTP)
// is the only trigger.
//
// 🔴 0.2.38 — `users.plan` is a MIRROR of `resolve`'s answer and is written in
// exactly ONE place ([mirrorPlanColumn], driven by [resolve]). Before this it was
// written only by the mock machine, so a real Paddle upgrade never reached it and
// the JWT `plan` claim minted from it told a paying customer 「free」. Read the
// long note on that method before touching it — in particular: nothing may make a
// DECISION from that column.

import { isPlan, type Plan } from '@flowmic/protocol';
import type { BillingRepo, PaddleSubRow } from '../db/repos/billing.repo';
import type { SettingsRepo } from '../db/repos/settings.repo';
import type { UserRepo } from '../db/repos/user.repo';
import type { UsageRepo } from '../db/repos/usage.repo';
import { effectiveAnchorMs, parseUtcStamp, subscriptionRowExpiry, usagePeriodAt, type UsagePeriod } from './usage-period';
import { planLimits, type PlanLimits } from './plans';
import { withdrawalDeadline } from './withdrawal';
import { ServerError } from '../errors';

import type { Cycle, SubState, PlanView, QuotaView } from './billing-service-types';
export type { Cycle, PlanSource, SubState, PlanView, QuotaView } from './billing-service-types';

/** The mock machine's own record. Its `state` can only ever be one of the five
 *  mock values — the two Paddle-only ones are never written here. */
interface Subscription {
  cycle: Cycle | null;
  state: SubState;
  expires_at: string | null;
  session_id: string | null;
}

const SUBSCRIPTION_KEY = 'account.subscription';
const DAY_MS = 24 * 60 * 60 * 1000;
const CYCLE_MS: Record<Cycle, number> = { monthly: 30 * DAY_MS, yearly: 365 * DAY_MS };

/**
 * D1 §6.1-bis — the "exempt limits table" a `users.permanent_free = 1` account resolves to.
 *
 * 🔴 STILL NOT A TIER, and still not reachable from `planLimits()`. `plan` stays
 * `'free'`, `source` stays `'permanent_free'`, nothing is billed and no Paddle
 * row is written — "tier free + source permanent_free + quota capped at MAX".
 * What changed on 2026-08-07 is only the NUMBERS this resolves to.
 *
 * ── 🔴 2026-08-07 — THIS DELIBERATELY REVERSES A STANDING LESSON ─────────────
 * Ruling: docs/decisions/2026-08-07-owner-permanent-free-becomes-max-and-test-
 *         accounts-reset-to-free.md ① (owner, 2026-08-07).
 *
 * These cells used to be `Number.POSITIVE_INFINITY`, and CLAUDE.md still records
 * the D1-window lesson that produced them: "`permanent_free` must never map onto
 * a sellable tier (that would leave owner blocked by his own product)". owner
 * knew that and chose the other way, because the GROUND under the old table had
 * moved while the table itself did not:
 *
 *   · before the W1 engine switch, 「unlimited」 meant unlimited use of our OWN
 *     self-hosted engines — the cost was our own CPU;
 *   · after it (Soniox + DeepSeek), the SAME TABLE, not one character changed,
 *     came to mean 「unlimited spending of a VENDOR's money」 — and nobody ever
 *     re-consented to that new meaning.
 *
 * MAX is the highest tier we have ever sold, so it is already an 「enough」 upper
 * bound: capping here costs normal use nothing, but puts a FINITE number in front
 * of runaway spend from an accident or a fault. Of the two harms — 「owner blocked
 * by his own product」 (the old lesson) and 「owner's account can burn a vendor's
 * budget with no ceiling」 (today) — owner took the finite ceiling.
 *
 * ⚠️ DO NOT 「fix」 THIS BACK TO Infinity BY CITING THE OLD LESSON. It is not an
 * oversight, it is the ruling. Changing it back is owner's call, not a window's.
 *
 * ── why the numbers are WRITTEN OUT, not `= PLAN_LIMITS.max` ────────────────
 * They are max's numbers today, and test/plan-view-resolution.test.ts asserts
 * each cell against `PLAN_LIMITS.max` so the two cannot drift unnoticed. It is
 * still a COPY, on purpose, and this file deliberately does not import
 * `PLAN_LIMITS` at all so it cannot quietly become an alias:
 *
 *   ① `planLimits()` reads the ACTIVE table, which FLOWMIC_PLAN_LIMITS overrides
 *      at boot. Sourcing the ceiling from there would let an operator re-pricing
 *      the SELLABLE max tier move owner's SPEND CEILING as an invisible side
 *      effect — one value answering two questions, and it moves the very ceiling
 *      this table exists to hold. A deployment override must not reach here.
 *   ② aliasing the defaults (`= PLAN_LIMITS.max`) has the same defect one step
 *      later: the next re-pricing of max would silently re-price the exemption.
 *      The test makes that day a RED test and a DECISION instead.
 *
 * ⇒ if that test goes red, do not just copy the new numbers across. Ask whether
 *   the exemption should follow max — that is owner's question, not this file's.
 *
 * ── the two cells that did NOT change, and why ──────────────────────────────
 * `mobiles` is Infinity because MAX ITSELF IS Infinity there (pro and max are
 * identical on `mobiles` under the "the cloud sells convenience, never sells
 * capability" red line in plans.ts).
 * It is not an exception carved out for the exemption — copying max's numbers is
 * what put it there.
 *
 * `history_days` is 365 for the reason it always was, and that reason is
 * ARITHMETIC rather than policy: db/retention.ts computes `now - days*86400e3` as
 * a cutoff, so an infinite window makes that NaN — which compares false against
 * everything and would silently DISABLE the sweep instead of extending it. 365 is
 * also exactly max's value, so this cell needed no change either way.
 *
 * ⇒ THREE of the five cells moved (stt_minutes, llm_tokens, pcs); the other two
 *   already held max's values.
 *
 * 🔴 WHAT THIS TURNED ON. Every cell but `history_days` is read behind a
 * `Number.isFinite` short-circuit (quota-guard.ts `ensureQuota`/`remainingSttMs`,
 * room/registry.ts `deviceLimit`), so ∞ meant 「never enforced」 — those branches
 * were DEAD for an exempt account and are now live: QUOTA_EXCEEDED at 3,000 STT
 * minutes/month, QUOTA_EXCEEDED at 100M LLM tokens/month, and PCS_LIMIT_EXCEEDED
 * on the 11th PC. `mobiles` (still ∞) and `history_days` stay exactly as dead as
 * they were.
 */
const EXEMPT_LIMITS: Readonly<PlanLimits> = {
  stt_minutes: 3_000,
  // owner 2026-08-27: mirrors MAX's re-cut 100M → 15M
  // (docs/decisions/2026-08-27-owner-quota-gauge-and-token-caps.md). Still a
  // deliberate copy, not an independent number — see the comment above this
  // constant.
  llm_tokens: 15_000_000,
  pcs: 10,
  mobiles: Number.POSITIVE_INFINITY,
  history_days: 365,
  // owner 2026-08-29 — mirrors MAX's 30. Still a deliberate copy, not an alias
  // (see the comment above this constant), and the plan-view-resolution pin
  // walks PLAN_LIMIT_KEYS, so this cell cannot silently fall behind max.
  //
  // 🔴 THIS CELL IS THE WHOLE REASON `continuous_minutes` IS A LIMIT KEY. The
  // owner's own account is the `permanent_free` one: its `plan` reads 'free'
  // while its numbers come from here. A tier-name lookup would hand the person
  // who has to test a 30-minute recording a 10-minute ceiling — the D1-window
  // defect ("permanent_free must never map onto a sellable tier") in a new
  // dimension. Being a key makes the exemption automatic instead of remembered.
  continuous_minutes: 30,
};

function emptySub(): Subscription {
  return { cycle: null, state: 'none', expires_at: null, session_id: null };
}

/** `paddle_subscriptions.cycle` is a free-text column (Paddle's word, stored
 *  verbatim). Narrowed by TEST, never by `as Cycle`: a hand-written type
 *  assertion on a DB string is a claim the compiler does not check, which is the
 *  exact volume-13 §7 F1 ⑤ shape. An unrecognised billing period reads as "we do
 *  not know the cycle" (null), which is true, instead of pretending it is monthly. */
function asCycle(v: string | null): Cycle | null {
  return v === 'monthly' || v === 'yearly' ? v : null;
}

/**
 * Paddle's own status string → the product-facing `SubState`. Translation only:
 * whether the TIER is granted is decided by `current_period_end` alone (see
 * [BillingService.fromPaddle]), so nothing here can accidentally strip a payer.
 *
 * ⚠️ The `default` branch. Paddle's documented set is exactly
 * active / trialing / canceled / past_due / paused; a sixth value means Paddle
 * moved and we have not caught up. Every alternative landing spot is a lie —
 * 'active' claims a state we did not read, 'expired' claims a date passed, 'none'
 * claims there is no subscription while a row is sitting right there. `'pending'`
 * is the one that stays true: "there is a subscription row, but it hasn't been
 * translated into a state we recognize yet". It IS shared with the mock machine's
 * "checkout has started, not yet confirmed", which is the closest this file comes
 * to one value answering two questions — tolerated because the console renders
 * both as "processing" and because `source` (mock vs paddle) tells
 * them apart with no guessing. The RAW status is never lost: it stays verbatim in
 * `paddle_subscriptions.status` for reconciliation (see billing.repo.ts).
 */
function paddleState(status: string, expired: boolean): SubState {
  if (expired) return 'expired';
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'canceled':
      return 'canceled';
    case 'past_due':
      return 'past_due';
    case 'paused':
      return 'paused';
    // 🔴 CREEM'S WORD FOR 「active, with a cancellation booked」 (2026-09-04).
    //
    // This switch was written against Paddle's vocabulary, where that fact is
    // `status: 'active'` PLUS a scheduled_change object. Creem spells it as a
    // status of its own, so it was falling into `default` and a paying customer
    // with a cancellation scheduled read as 「processing」 — R11, on a
    // subscription that is running, is paid for, and has a date attached.
    //
    // ⚠️ IT IS THE SAME PROJECTION `creem/envelope.ts` ALREADY MAKES onto
    // `scheduled_change_action`, applied to the one reader that had not learned
    // the vocabulary. The two must agree: the console reads `state` for 「is it
    // running」 and `scheduled_change` for 「until when」, and a subscription that
    // is 「processing」 with a cancellation date is two answers to one question.
    //
    // ⚠️ NOT EXTENDED TO CREEM'S `unpaid`, deliberately. 'past_due' would claim
    // the provider is still retrying the charge and we have not measured that;
    // 'pending' at least says only 「there is a row whose state we do not
    // translate」, which is true. Registered as a gap rather than guessed.
    //
    // Caught by test/subscription-e2e.test.ts on its first run — no unit suite
    // could see it, because each one hands this function a status it chose.
    case 'scheduled_cancel':
      return 'active';
    default:
      return 'pending';
  }
}

export interface BillingServiceDeps {
  settings: SettingsRepo;
  users: UserRepo;
  usage: UsageRepo;
  /** D1 §6.1 step 2 — the Paddle subscription ledger.
   *
   *  🔴 REQUIRED, not optional. An absent repo would make `source:'paddle'`
   *  structurally unreachable, so every real subscriber would resolve to
   *  `{plan:'free', source:'none'}` — silently, with a green test suite. That is
   *  D1's headline red line "shows as upgraded but never took effect server-side"
   *  wearing a convenient face, and volume-13 §7 F1 ② says a DI default must be a
   *  real implementation or a throw, never a friendly nothing. Requiring it makes
   *  a mis-wired deployment a COMPILE error instead. */
  billing: BillingRepo;
  unlockAll: boolean;
  /** Injectable base clock (ms). Tests advance via advanceClock. */
  now?: () => number;
}

export class BillingService {
  private offsetMs = 0;
  private readonly baseNow: () => number;
  constructor(private readonly deps: BillingServiceDeps) {
    this.baseNow = deps.now ?? Date.now;
  }

  /** Mock/test-only: advance the injected clock (month reset / renewal proof). */
  advanceClock(offsetMs: number): void {
    this.offsetMs += offsetMs;
  }
  private now(): number {
    return this.baseNow() + this.offsetMs;
  }
  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private readSub(userId: string): Subscription {
    const row = this.deps.settings.read(userId, SUBSCRIPTION_KEY);
    if (!row || row.value === null || typeof row.value !== 'object') return emptySub();
    const v = row.value as Partial<Subscription>;
    return {
      cycle: v.cycle ?? null,
      state: v.state ?? 'none',
      expires_at: v.expires_at ?? null,
      session_id: v.session_id ?? null,
    };
  }

  /** The ONE mock-subscription write convergence point (§5 — each exactly once).
   *
   *  🔴 0.2.38 — this used to take a `plan` and call `users.setPlan` too, which
   *  made it a SECOND writer of `users.plan` alongside the mirror in [resolve].
   *  Two writers is two answers: every caller passed a hand-written literal
   *  ('pro' / 'free'), and `mockExpire` had drifted all the way to
   *  `sub.state === 'active' ? 'pro' : 'pro'` — a ternary whose branches are the
   *  same value, i.e. an argument nobody could still explain. The column is now
   *  written in exactly one place, from the resolved answer. */
  private writeSub(userId: string, sub: Subscription): void {
    this.deps.settings.write(userId, SUBSCRIPTION_KEY, sub, this.nowIso());
  }

  /**
   * 🔴 0.2.38 — THE one write of `users.plan`, and the only one there may ever be.
   *
   * `users.plan` is a **cache / projection of [resolve]'s answer, NOT the truth**.
   * The truth is `paddle_subscriptions` + `users.permanent_free`, resolved here;
   * this column exists because the auth surface reads it (auth-service mints the
   * JWT `plan` claim and the `/api/auth/me` projection from a `UserRecord`), and
   * before this it was written ONLY by the mock state machine — so a real Paddle
   * upgrade left it at 'free' and every token said "free" to a paying customer.
   * That is D1's headline red line "shows as upgraded but never took effect
   * server-side" with the sides swapped, and it is display-only (enforcement
   * reads `effectiveLimits`, never this column or the claim), which is exactly
   * why nothing caught it.
   *
   * 🔴 DO NOT READ THIS COLUMN TO DECIDE ANYTHING. It is eventually consistent by
   * construction: it is refreshed when someone asks a plan question, so between a
   * subscription lapsing and the next question it can name a tier that no longer
   * applies. Ask [effectivePlan] / [effectiveLimits].
   *
   * A `permanent_free` account mirrors **'free'** — not a special value. That is
   * not a carve-out, it falls straight out of §6.1-bis: owner bought nothing, so
   * `PlanView.plan` IS 'free' and the exemption lives in `source` +
   * `quota_exempt`. His JWT claim therefore stays 'free' and the token surface
   * never has to learn about exemptions.
   *
   * Writes only on CHANGE: `resolve` runs on every quota check and every device
   * registration, and an unconditional UPDATE would put a write on the hot read
   * path for no new information.
   */
  private mirrorPlanColumn(userId: string, stored: Plan | null, effective: Plan): void {
    if (stored === null) return; // no users row to mirror onto (nothing to lie about)
    if (stored === effective) return;
    this.deps.users.setPlan(userId, effective);
  }

  /** The ONE expires_at boundary evaluation (§5). Lazily transitions an
   *  active/canceled subscription past its expiry to expired + plan=free. */
  private evaluate(userId: string): Subscription {
    const sub = this.readSub(userId);
    if ((sub.state === 'active' || sub.state === 'canceled') && sub.expires_at) {
      if (this.now() >= Date.parse(sub.expires_at)) {
        const expired: Subscription = { ...sub, state: 'expired' };
        this.writeSub(userId, expired);
        return expired;
      }
    }
    return sub;
  }

  /**
   * 🔴 D1 §6.1 — THE one place that answers "what tier is this user on right now,
   * and on what basis".
   *
   * The order below is a DECISION, written once, and every step earns its place:
   *
   *   ① `users.permanent_free = 1` — owner's private-line exemption. FIRST
   *      because it must survive every other answer: any step that could preempt
   *      it would decide owner's limits from a SUBSCRIPTION he never bought, and
   *      a lapsed or absent one would drop him to free's 20 minutes. It resolves
   *      to `plan:'free'` with `quota_exempt:true` (§6.1-bis: an exemption, NOT a
   *      tier — writing 'pro'/'max' into `plan` would claim he bought something).
   *      ⚠️ 2026-08-07 — "never blocked by a commercial boundary" used to be the
   *      reason given here and is no longer true: he is capped at MAX's numbers
   *      (ruling ①, [EXEMPT_LIMITS]). The ORDER is unchanged; only its rationale
   *      is restated, because the old one now over-promises.
   *
   *   ② a `paddle_subscriptions` row — the only source backed by money. It sits
   *      ABOVE the mock branch, not below, because FLOWMIC_MOCK_UNLOCK_ALL says
   *      "pro" unconditionally: a real Max subscriber on a box with that dev
   *      flag left on would be silently DOWNGRADED to pro if mock won. A dev
   *      escape hatch must never overrule a paying customer.
   *
   *   ③ the mock machine (`account.subscription` + FLOWMIC_MOCK_UNLOCK_ALL) —
   *      `source` is reported honestly as `'mock'`. 🔴 A console that says
   *      "you are Pro" and cannot say why is the exact failure this window exists
   *      to prevent, so the unlock-all bypass is NOT allowed to borrow another
   *      source's name.
   *
   *   ④ nothing at all ⇒ `{plan:'free', source:'none'}`.
   *
   * Reads only, except for step ③'s lazy mock-expiry write (`evaluate`), which is
   * the pre-existing ONE expires_at boundary site.
   */
  private resolve(userId: string): PlanView {
    // ONE read of the users row, shared by step ① and by the mirror: re-reading
    // after `computeView` would pick up the mirror's own write on the next call
    // and make "did it change" depend on read ordering.
    const user = this.deps.users.findById(userId);
    const view = this.computeView(userId, user?.permanent_free === true);
    this.mirrorPlanColumn(userId, user?.plan ?? null, view.plan);
    return view;
  }

  /** [resolve] minus the mirror — the decision itself, so the write in `resolve`
   *  cannot be mistaken for part of the answer. */
  private computeView(userId: string, exempt: boolean): PlanView {
    // ── ① exemption ───────────────────────────────────────────────────────────
    if (exempt) {
      return {
        plan: 'free',
        source: 'permanent_free',
        quota_exempt: true,
        cycle: null,
        state: 'none',
        expires_at: null,
        // Nothing is scheduled and nothing will be charged: neither an exemption
        // nor an absent subscription has a Paddle-side change pending. null here
        // is the fact, not a placeholder.
        scheduled_change: null,
        next_billed_at: null,
        // No Paddle contract, so no statutory withdrawal period to state. Not
        // 「the period has passed」 — there was never one running.
        withdrawal_deadline: null,
        contract_concluded_at: null,
        paddle_subscription_id: null,
        billing_provider: null,

      };
    }
    // ── ② paddle ──────────────────────────────────────────────────────────────
    // 🔴 2026-09-02 audit F2/C1 — NOT `latestForUser`. That repo method answers
    // 「the row with the most recent `last_occurred_at`」, and it is right for
    // what IT documents itself as answering (repo-level reconciliation). But
    // computeView's question is different: 「what does this user have RIGHT
    // NOW」. Those two questions coincide unless a user has more than one
    // `subscription_id` on file, which happens exactly on a swap — cancel an
    // old plan, buy a new one. A late-arriving webhook for the OLD
    // subscription's cancellation can carry a NEWER `last_occurred_at` than the
    // new subscription's own last event, so `latestForUser` would hand back the
    // stale, terminal row and (after the P0-2 fix) drop an actively-paying user
    // to free. `listForUser` returns every row for the user in the same
    // newest-first order; `selectPaddleView` picks the newest row that still
    // GRANTS something over a newer but terminal one, and only falls back to
    // the plain newest-row-wins rule when nothing grants (matching the old,
    // pre-swap behaviour for an account with a single, or all-expired, row).
    const rows = this.deps.billing.listForUser(userId);
    const paddleView = this.selectPaddleView(rows);
    if (paddleView) return paddleView;
    // ── ③ mock ────────────────────────────────────────────────────────────────
    if (this.deps.unlockAll) {
      // Mutates nothing (mock-billing §1): no account.subscription row is written.
      return {
        plan: 'pro',
        source: 'mock',
        quota_exempt: false,
        cycle: 'yearly',
        state: 'active',
        expires_at: null,
        // Nothing is scheduled and nothing will be charged: neither an exemption
        // nor an absent subscription has a Paddle-side change pending. null here
        // is the fact, not a placeholder.
        scheduled_change: null,
        next_billed_at: null,
        // No Paddle contract, so no statutory withdrawal period to state. Not
        // 「the period has passed」 — there was never one running.
        withdrawal_deadline: null,
        contract_concluded_at: null,
        paddle_subscription_id: null,
        billing_provider: null,

      };
    }
    const sub = this.evaluate(userId);
    if (sub.state !== 'none') {
      const granting = sub.state === 'active' || sub.state === 'canceled';
      // An EXPIRED mock subscription keeps `source:'mock'` — same discipline as
      // the expired-paddle case below. "Came from mock, already expired" is a
      // different (and more useful) statement than "never had a subscription at
      // all", and collapsing the two would delete the only clue a support
      // question has to work from.
      return {
        plan: granting ? 'pro' : 'free',
        source: 'mock',
        quota_exempt: false,
        cycle: sub.cycle,
        state: sub.state,
        expires_at: sub.expires_at,
        // 🔴 The MOCK machine has no scheduled-change concept and is not given a
        // synthetic one. Its canceled state already means 「kept until expiry」
        // (mockCancel), so inventing a scheduled_change here would put a SECOND
        // encoding of the same fact on the same object, and the console would
        // then have two places to read 「will not renew」 from — which is how two
        // answers to one question start disagreeing. The mock gateway is
        // dev-only and refuses to mount under saas, so no user sees this branch.
        scheduled_change: null,
        next_billed_at: null,
        // No Paddle contract, so no statutory withdrawal period to state. Not
        // 「the period has passed」 — there was never one running.
        withdrawal_deadline: null,
        contract_concluded_at: null,
        paddle_subscription_id: null,
        billing_provider: null,

      };
    }
    // ── ④ nothing ─────────────────────────────────────────────────────────────
    return {
      plan: 'free',
      source: 'none',
      quota_exempt: false,
      cycle: null,
      state: 'none',
      expires_at: null,
      scheduled_change: null,
      next_billed_at: null,
      // No Paddle contract, so no statutory withdrawal period to state. Not
      // 「the period has passed」 — there was never one running.
      withdrawal_deadline: null,
      contract_concluded_at: null,
      paddle_subscription_id: null,
      billing_provider: null,

    };
  }

  /**
   * 2026-09-02 audit F2/C1 — chooses WHICH of a user's `paddle_subscriptions`
   * rows answers "what do they have right now", for a user who has more than
   * one row on file (a subscription swap: the old one canceled, a new one
   * bought). `rows` is newest-first by `last_occurred_at` (repo's order).
   *
   * The newest row that still GRANTS something (state !== 'expired' once
   * translated) wins, however much older it is than a newer but already-
   * terminal row — a late-arriving cancellation for a REPLACED subscription
   * must not outrank the replacement that is still being paid for. Only when
   * NOTHING grants does this fall back to the newest row overall, which
   * reproduces the pre-fix behaviour for the common case (one row, or every
   * row expired) and keeps answering "most recent" for support/reconciliation.
   */
  private selectPaddleView(rows: readonly PaddleSubRow[]): PlanView | null {
    // Loop rather than `.map(...).find(...)` + `views[0]` so the "newest row,
    // whatever its state" fallback never needs an unchecked array index —
    // `rows` is newest-first, so the FIRST view built here already is that
    // fallback. Returns null only for an empty `rows`, which the caller never
    // passes (see the `rows.length > 0` guard at the call site).
    let fallback: PlanView | null = null;
    for (const row of rows) {
      const view = this.fromPaddle(row);
      fallback ??= view;
      if (view.state !== 'expired') return view;
    }
    return fallback;
  }

  /** One `paddle_subscriptions` row → a PlanView. The grant rule is uniform and
   *  comes straight from D1 §5's event table: canceled keeps benefits to
   *  `current_period_end`, past_due does NOT drop the tier (Paddle is still
   *  retrying the charge), paused expires at `current_period_end` — i.e. every
   *  known status grants its tier until that date passes. So there is exactly ONE
   *  question to ask ("has the period passed") and the status only chooses the
   *  LABEL. */
  private fromPaddle(row: PaddleSubRow): PlanView {
    const endMs = row.current_period_end === null ? null : Date.parse(row.current_period_end);
    // null  = no period end recorded.
    //   Paddle's own docs (get-subscription) say `current_billing_period` is
    //   「null for paused and canceled subscriptions」 — i.e. a null period on a
    //   TERMINAL status is not a missing field, it is Paddle's spelling of
    //   「this already ended」. Reading it as 「not expired」 there means a
    //   canceled subscription keeps its paid tier forever (2026-09-02 audit
    //   P0-2), because nothing else in this row ever flips `expired` back to
    //   true once the period column goes null.
    //   For every OTHER status (active/trialing/past_due/an unrecognised sixth
    //   value) a null period still means 「omitted, not concluded」 — refusing a
    //   signed subscription because Paddle left a field blank would be the
    //   wrong direction of failure, so those keep the pre-existing `false`.
    // NaN   = the column holds something that is not a date ⇒ treat as EXPIRED.
    //         Fail-CLOSED on garbage: an unparseable date must not grant forever.
    // No `paused_at` column exists (only `canceled_at`), so a paused row falls
    // back to `last_occurred_at` — the out-of-order guard's own ruler for "when
    // did we learn this", already NOT NULL on every row. Comparing against now,
    // rather than hardcoding `true`, keeps this one rule (endMs-or-fallback vs
    // now) instead of a second, un-testable "terminal ⇒ always expired" branch.
    // 2026-09-05: the rule itself lives in `subscriptionRowExpiry`
    // (usage-period.ts), shared with the metering cycle — see its doc for why
    // the two must be one function.
    const { expired } = subscriptionRowExpiry(row, this.now());
    // `PaddleSubRow.tier` is typed `Plan` by an unchecked cast in the repo (the
    // column is free text). Re-narrowing by TEST here is the fail-closed reading:
    // a tier this build does not know must resolve to free, never to a paid one.
    const tier: Plan = isPlan(row.tier) ? row.tier : 'free';
    return {
      plan: expired ? 'free' : tier,
      // 🔴 Still 'paddle' after expiry — it says "came from that subscription,
      // now expired", which is what a human reconciling against Paddle's
      // dashboard needs to read.
      source: 'paddle',
      quota_exempt: false,
      cycle: asCycle(row.cycle),
      state: paddleState(row.status, expired),
      expires_at: row.current_period_end,
      // ── 0.3.25 B1 · the two facts `state` could never carry ────────────────
      //
      // 🔴 SUPPRESSED ONCE THE PERIOD HAS PASSED, and that is not tidying. An
      // expired row's `scheduled_change` describes a change that has already
      // happened or has been overtaken; rendering 「your service runs until X」
      // off a date in the past is the R11 failure this field was added to end,
      // committed in the other direction. `state` is already 'expired' there and
      // that is the whole answer.
      scheduled_change:
        expired || row.scheduled_change_action === null
          ? null
          : { action: row.scheduled_change_action, effective_at: row.scheduled_change_at },
      // Same reason: nothing is going to be charged on an expired subscription,
      // whatever the last event happened to leave in the column.
      next_billed_at: expired ? null : row.next_billed_at,
      // 🔴 NOT suppressed on expiry, unlike the two above, and the asymmetry is
      // the point. Those two describe what happens NEXT and are meaningless once
      // the period is over. A withdrawal period is anchored to when the contract
      // was CONCLUDED and runs on its own clock: a subscription can be expired,
      // cancelled or past_due and still be inside its fourteen days — someone
      // who signs up and cancels the same afternoon is exactly that case, and
      // that is the person most likely to want their money back. Suppressing it
      // here would withdraw a legal right from the user who needs it most.
      withdrawal_deadline: withdrawalDeadline(row.contract_concluded_at),
      // Straight through, unsuppressed on expiry for the same reason as the
      // deadline above: it identifies the contract, and a contract does not stop
      // having a start date because its period ended.
      contract_concluded_at: row.contract_concluded_at,
      paddle_subscription_id: row.subscription_id,
      // Straight off the row. NOT defaulted to 'paddle' when the column is
      // empty — see the field's doc: that inference belongs to one stated
      // caller, made once, not to every reader silently.
      billing_provider: row.provider,
    };
  }

  /** Effective plan after expiry + unlock-all (D1 §6.1-bis: "effectivePlan still
   *  exists, but is no longer the source of quota"). Enforcement callers must use
   *  [effectiveLimits] instead, because a tier can no longer express an exemption.
   *
   *  ⚠️ 0.2.38 CORRECTION — this doc used to name three consumers: "the JWT claim,
   *  log lines, the console readout". All three were greppably false (the JWT
   *  claim is minted from `users.plan` in auth-service; no log line calls it; the
   *  console reads `getPlan`), i.e. a comment defending a design by pointing at a
   *  caller that does not exist (volume-13 §7 F1 ④). Its ONE production consumer today
   *  is bootstrap's Paddle-webhook trigger, which calls it for the `users.plan`
   *  mirror [resolve] performs — the ANSWER is discarded there. If that call ever
   *  goes away, this method has no production consumer and must go with it. */
  effectivePlan(userId: string): Plan {
    return this.resolve(userId).plan;
  }

  /** 🔴 WP2 card 5 / M2-8 — read-only resolver for a caller looping over MANY
   *  accounts (ops-user-routes.ts's list) without writing `users.plan` per row
   *  like [resolve]: [resolve]'s first half, `mirrorPlanColumn` never invoked.
   *  ⚠️ [computeView]'s mock branch can still lazily write the mock ledger via
   *  [evaluate] (never `users.plan`; dead in saas, `assertMockBillingMountable`). */
  resolvePlanReadOnly(userId: string): PlanView {
    const user = this.deps.users.findById(userId);
    return this.computeView(userId, user?.permanent_free === true);
  }

  /**
   * 🔴 D1 §6.1-bis — THE one place that answers "what is this user's quota right
   * now".
   *
   * Both enforcement points consume this and NOTHING ELSE derives limits from a
   * plan: `billing/quota-guard.ts` (STT/LLM) and `room/registry.ts` (PC/mobile
   * slots). The registry one is not decoration — device counts ride the same
   * PLAN_LIMITS table, so an exempt owner resolved through `planLimits('free')`
   * would be walled at 2 PCs / 2 phones. That is a capability wall, i.e. a red
   * line, and it is invisible until someone plugs in a third machine.
   */
  effectiveLimits(userId: string): PlanLimits {
    const view = this.resolve(userId);
    return view.quota_exempt ? { ...EXEMPT_LIMITS } : planLimits(view.plan);
  }

  getPlan(userId: string): PlanView {
    return this.resolve(userId);
  }

  /**
   * The metering cycle this account is in at `atMs` (owner 2026-09-05, option 乙).
   *
   * 🔴 THE ONLY PLACE THAT KNOWS AN ACCOUNT'S ANCHOR. The guard and the meter
   * both ask this, so 「which bucket」 has one answer in the process; a second
   * derivation in either of them is the cross-bucket drift
   * test/quota-usage-month-bucket-alignment.test.ts exists to catch.
   *
   * The anchor is derived from facts already on file — registration, and the
   * start/end of every subscription row — never stored. See usage-period.ts for
   * why storing it would miss the transition that matters most (a paid period
   * ending is driven by the clock, not by an event). The 「has this row ended」
   * question is answered by the SAME rule `fromPaddle` uses for the tier
   * (`subscriptionRowExpiry`), so the tier and the cycle cannot disagree about
   * when a subscription stopped.
   */
  usagePeriod(userId: string, atMs: number = this.now()): UsagePeriod {
    const user = this.deps.users.findById(userId);
    // An account we cannot find has no registration instant; metering it at all
    // is a caller bug, but the honest fallback is 「as of now」 rather than a key
    // in 1970 that nothing else will ever read.
    const registeredAt = user ? parseUtcStamp(user.created_at) : atMs;
    const subscriptions = this.deps.billing.listForUser(userId).map((row) => {
      const { expired, endMs, endedAtMs } = subscriptionRowExpiry(row, atMs);
      const startedAt = row.contract_concluded_at ?? row.created_at;
      const startedAtMs = parseUtcStamp(startedAt);
      return {
        startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
        endedAtMs: expired ? (endedAtMs ?? endMs) : null,
        grants: !expired,
      };
    });
    return usagePeriodAt(effectiveAnchorMs(Number.isFinite(registeredAt) ? registeredAt : atMs, subscriptions, atMs), atMs);
  }

  /** The bucket key the meter writes to and the guard reads from, at `atMs`. */
  usagePeriodKey(userId: string, atMs: number = this.now()): string {
    return this.usagePeriod(userId, atMs).key;
  }

  getQuota(userId: string): QuotaView {
    // Through effectiveLimits, not planLimits(effectivePlan): an exempt account
    // must not be shown a fair line nothing is enforcing.
    const limits = this.effectiveLimits(userId);
    const period = this.usagePeriod(userId);
    const rec = this.deps.usage.get(userId, period.key);
    return {
      stt: { used_min: rec?.stt_minutes ?? 0, limit_min: limits.stt_minutes },
      // owner 2026-08-14: `used` = output tokens (what the guard enforces),
      // `used_in` = input tokens (reference). See QuotaView for the argument.
      llm: {
        used: rec?.llm_tokens_out ?? 0,
        used_in: rec?.llm_tokens_in ?? 0,
        limit: limits.llm_tokens,
      },
      // ⚠️ `month` KEEPS ITS NAME and now carries the cycle key (`YYYY-MM-DD`):
      // older console builds render it as-is, which is a true statement about
      // which bucket is being counted. `period` is the field new builds read.
      month: period.key,
      period: { start: period.start, end: period.end },
    };
  }

  // ── mock gateway triggers (the only state-machine drivers) ──────────────
  mockCheckout(userId: string, cycle: Cycle): { sessionId: string; state: 'pending' } {
    const sub = this.evaluate(userId);
    if (sub.state === 'active' || sub.state === 'canceled') {
      throw new ServerError('PLAN_UPGRADE_REQUIRED', 'already subscribed');
    }
    const sessionId = `mock_${Math.random().toString(36).slice(2, 12)}`;
    this.writeSub(userId, { cycle, state: 'pending', expires_at: null, session_id: sessionId });
    // 🔴 The ONE mock trigger that does not end in a PlanView, so it is the one
    // that would leave `users.plan` un-mirrored. `resolve` runs for its write, not
    // its answer: a pending checkout grants nothing, and the column must say so
    // rather than keep whatever the previous state left behind.
    this.resolve(userId);
    return { sessionId, state: 'pending' };
  }

  mockConfirm(userId: string, sessionId: string): PlanView {
    const sub = this.readSub(userId);
    if (sub.state !== 'pending' || sub.session_id !== sessionId || !sub.cycle) {
      throw new ServerError('PLAN_UPGRADE_REQUIRED', 'no matching pending checkout');
    }
    const expires_at = new Date(this.now() + CYCLE_MS[sub.cycle]).toISOString();
    this.writeSub(userId, { cycle: sub.cycle, state: 'active', expires_at, session_id: null });
    return this.getPlan(userId);
  }

  mockCancel(userId: string): PlanView {
    const sub = this.evaluate(userId);
    if (sub.state !== 'active') throw new ServerError('PLAN_UPGRADE_REQUIRED', 'no active subscription to cancel');
    this.writeSub(userId, { ...sub, state: 'canceled' }); // benefits kept to expiry
    return this.getPlan(userId);
  }

  mockRenew(userId: string): PlanView {
    const sub = this.evaluate(userId);
    if (sub.state !== 'canceled') throw new ServerError('PLAN_UPGRADE_REQUIRED', 'nothing to renew');
    this.writeSub(userId, { ...sub, state: 'active' });
    return this.getPlan(userId);
  }

  /** Test hook: force expiry (pull expires_at into the past), then evaluate. */
  mockExpire(userId: string): PlanView {
    const sub = this.readSub(userId);
    if (sub.state !== 'active' && sub.state !== 'canceled') {
      throw new ServerError('PLAN_UPGRADE_REQUIRED', 'nothing to expire');
    }
    const past = new Date(this.now() - 1000).toISOString();
    this.writeSub(userId, { ...sub, expires_at: past });
    this.evaluate(userId); // → expired + plan=free
    return this.getPlan(userId);
  }
}
