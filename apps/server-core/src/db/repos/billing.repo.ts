// SPEC-REF:
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §3.2 (paddle_subscriptions),
//     §3.3 (billing_events — the idempotency ledger), §3.4 (this interface, verbatim)
//   docs/decisions/2026-08-01-owner-three-tier-pricing-usd-monthly.md (tier table)
//   CLAUDE.md red line: no silent failure / one value answers only one question
//
// Two tables, two questions:
//   · `paddle_subscriptions` answers "what state is this subscription in right
//     now" (one row per sub_xxx);
//   · `billing_events`       answers "which webhooks have we received, and what
//     happened to each one"
//     (one row per evt_xxx — the idempotency ledger AND the reconciliation trail).
//
// 🔴 This repo STORES. It does not decide. It does not compare occurred_at, it
// does not pick which subscription is "the effective one", it does not map a
// price_id to a tier. Every one of those is a policy question and policy has
// exactly one owner elsewhere (webhook-handler for ordering/mapping, D1 §5.3;
// BillingService for "what tier is this user on", D1 §6.1). Deciding twice is
// how the two answers drift apart, which is this window's headline red line
// "shows as upgraded but never took effect server-side".
//
// ⚠️ RULE ④ HONESTY MARKER (lane A ships BEFORE lane C): every sentence below
// that says "the handler will…" is an OBLIGATION ON LANE C, not a description
// of code that exists — `billing/paddle/webhook-handler.ts` is not written yet,
// so grepping for it today returns nothing. What IS greppable today is the
// source of the obligation: docs/strategy/2026-08-01-d1-paddle-sandbox-design.md
// §5.3. Anyone reading this file after lane C lands should re-check that each of
// those sentences became true; if one did not, this repo is UNPROTECTED in
// exactly the way the comment claims it is protected.
//
// ⚠️ ISO-STRING ORDERING: `last_occurred_at` / `received_at` are compared and
// sorted AS TEXT (SQLite has no date type). That equals chronological order only
// while every writer stores normalized, UTC, fixed-width RFC3339
// (`2026-08-01T10:00:00.000Z`). A `+08:00` offset from one writer would sort
// wrong and silently mis-order the out-of-order guard — the normalization
// belongs to the caller, and this repo cannot detect the violation.

import type { DatabaseSync } from 'node:sqlite';
import type { Plan } from '@flowmic/protocol';

/**
 * The outcomes a handler may CONCLUDE with (D1 §3.4, as corrected by §3.3-bis).
 *
 * 🔴 `'duplicate'` was REMOVED (the lead, 2026-08-01). It had no reachable
 * producer: `event_id` is the PRIMARY KEY, so a redelivery cannot mint a second
 * ledger row, and writing 'duplicate' onto the EXISTING row would overwrite its
 * 'applied' — erasing the fact that it took effect. Per the `INJECT_NO_RECEIPT`
 * precedent (CLAUDE.md), a value with no producer goes away with its producer
 * rather than hanging around for someone to answer a different question with.
 * "How many times was it redelivered" is now `billing_events.redelivery_count`
 * — a separate column, because it is a separate question.
 */
export type EventOutcome = 'applied' | 'stale' | 'unmapped' | 'ignored';

/**
 * The outcome `claimEvent` writes, and the ONLY value never passed to
 * `finishEvent`.
 *
 * §3.3's DDL declares `outcome TEXT NOT NULL` while §3.4's `claimEvent` row
 * carries no outcome at all (it is not known yet — that is what `finishEvent`
 * is for), so something must occupy the column between the two calls. Every
 * value in EventOutcome would be a lie there: 'ignored' claims we decided to
 * skip it, 'applied' claims a state write that has not happened.
 *
 * The lead adopted it as REAL state, not scaffolding, on 2026-08-01: if the
 * process dies between claim and finish the row STAYS 'pending' forever, and
 * "we accepted it but never finished resolving it" must be VISIBLE somewhere
 * rather than only true in the table.
 *
 * ⚠️ RULE ④ — the "somewhere" in that sentence is greppable, and it was not
 * until 0.2.38. This comment used to say "the reconciliation view (§6.2) should
 * display…" while the only
 * reader of `billing_events` was `listEventsForUser` (`WHERE user_id = ?`), and
 * a row stuck at 'pending' has NULL there because `claimEvent` does not write
 * `user_id` — so every row this comment described was structurally invisible to
 * every surface. The reader that makes it true now exists:
 *   · repo:  `listOrphanEvents` (below);
 *   · route: `GET /api/cloud/billing/orphans` (http/console-routes.ts, admin-only).
 * If either of those two greps ever comes back empty again, this paragraph is a
 * façade's defence and the state it describes is once more unobservable.
 */
export const OUTCOME_PENDING = 'pending';

/** What the `outcome` column can hold: a concluded outcome, or the claim-time
 *  placeholder above. */
export type StoredOutcome = EventOutcome | typeof OUTCOME_PENDING;

/** One row of `paddle_subscriptions` (D1 §3.2). Field-for-field with the DDL. */
export interface PaddleSubRow {
  /** sub_xxx — Paddle's id, our primary key. */
  subscription_id: string;
  user_id: string;
  /** ctm_xxx */
  customer_id: string | null;
  /** Paddle's OWN status string, stored verbatim, never translated. The product
   *  meaning lives in `tier`; keeping both keeps "what Paddle says" separate from
   *  "what tier we grant based on it", so a new Paddle status can never silently
   *  become a tier. */
  status: string;
  /** free|pro|max — mapped from `price_id` by config.paddle.priceTiers (lane B/C).
   *  Never defaulted to 'pro' anywhere: an unmapped price is `outcome:'unmapped'`. */
  tier: Plan;
  price_id: string | null;
  /**
   * Paddle's billing period, `monthly`/`yearly` today.
   *
   * Deliberately `string | null` and NOT the product-facing `Cycle` union: that
   * union is declared in `billing/billing-service.ts`, a layer ABOVE the db, and
   * importing it down here would invert the dependency AND put a second owner on
   * the same concept. Narrowing it here would also be a hand-written assertion
   * the compiler never checks (13 §7 F1 ⑤) — a row written by another build can
   * hold anything, and `as Cycle` would make it *look* proven.
   */
  cycle: string | null;
  /** RFC3339. The one date that decides "how long the tier is retained" (§5 canceled/paused). */
  current_period_end: string | null;
  canceled_at: string | null;
  /** evt_xxx of the event that last wrote this row — the audit link into
   *  `billing_events`. */
  last_event_id: string;
  /** `occurred_at` of that event. The handler compares against it to drop
   *  out-of-order deliveries (D1 §3.2 out-of-order guard). This repo only stores it. */
  last_occurred_at: string;
  created_at: string;
  updated_at: string;
}

/** One row of `billing_events` (D1 §3.3). */
export interface BillingEventRow {
  /** evt_xxx — 🔴 the dedup key. */
  event_id: string;
  /** ntf_xxx of the FIRST delivery — 🔴 log/diagnostics ONLY, and immutable once
   *  written. Paddle mints a NEW notification_id for every delivery attempt of
   *  the SAME event, so deduping on it would let every retry through: the table
   *  would exist and never once have worked. */
  notification_id: string | null;
  event_type: string;
  occurred_at: string;
  received_at: string;
  subscription_id: string | null;
  user_id: string | null;
  outcome: StoredOutcome;
  /** One sentence WE wrote (which price_id was unmapped, why it was stale, …).
   *  🔴 NEVER the raw webhook payload: it carries addresses and tax data we
   *  neither need nor should hold (D1 §3.3). */
  detail: string | null;
  /**
   * Window D1 §3.3-bis — how many times Paddle re-sent THIS event after the first
   * delivery. 0 = delivered once.
   *
   * It exists because the PRIMARY KEY makes a redelivery structurally invisible:
   * without this counter, "redelivered four times" would be silently dropped. It answers ONLY
   * that; whether the event took effect is `outcome`, and the two must never be
   * merged (a redelivery is not an outcome).
   */
  redelivery_count: number;
  /** ntf_xxx of the MOST RECENT delivery. Equal to `notification_id` on a row
   *  that has never been redelivered. NULL means exactly one thing: the row
   *  predates §3.3-bis and was backfilled by the migration — every row written
   *  since carries a value. */
  last_notification_id: string | null;
}

export interface BillingRepo {
  /** true = this event_id is new (now registered); false = already seen, the
   *  caller must return 200 directly and write no state */
  claimEvent(row: {
    event_id: string;
    notification_id: string | null;
    event_type: string;
    occurred_at: string;
    received_at: string;
  }): boolean;
  finishEvent(
    event_id: string,
    patch: {
      subscription_id?: string | null;
      user_id?: string | null;
      outcome: EventOutcome;
      detail?: string | null;
    },
  ): void;
  getSubscription(subscription_id: string): PaddleSubRow | null;
  latestForUser(user_id: string): PaddleSubRow | null;
  upsertSubscription(row: PaddleSubRow): void;
  listEventsForUser(user_id: string, limit: number): BillingEventRow[];
  /**
   * 0.2.38 — the rows NO per-user view can ever show.
   *
   * `listEventsForUser` keys on `user_id`, and the two states most worth a
   * human's attention are exactly the ones that may not have one:
   *   · `outcome='pending'` — claimed, never finished (the process died between
   *     the two calls). `claimEvent` writes no `user_id`, so this row is
   *     ALWAYS `user_id IS NULL`;
   *   · `outcome='unmapped'` — money arrived and we could not say whose it is,
   *     which is precisely the case where the mapping to a user failed.
   * Both are therefore invisible to every per-user surface BY CONSTRUCTION, not
   * by oversight. This is their one reader.
   *
   * 🔴 It is an OPERATIONS read, not a user read: it deliberately spans accounts
   * (that is the whole point — "these rows don't belong to any account"), so its
   * route is gated on `users.is_admin` and refuses a normal account BY NAME
   * (ADMIN_ONLY / 403) rather than handing back an empty list. "You don't have
   * permission to see this" and "no such rows exist" are two
   * different answers and one value must not carry both.
   *
   * ⚠️ NOT filtered to a user and NOT filterable: a `user_id` parameter would
   * turn it back into the per-user read it exists to complement.
   */
  listOrphanEvents(limit: number): BillingEventRow[];
  /**
   * D11 — every `paddle_subscriptions` row that is BOTH superseded AND old.
   *
   * "Superseded" uses the EXACT SAME tie-break as {@link latestForUser}
   * (`ORDER BY last_occurred_at DESC, updated_at DESC, subscription_id DESC`,
   * partitioned per user): the row a `ROW_NUMBER()` of 1 would pick is THE row
   * `latestForUser` answers with, and this method can never return it. Two
   * definitions of "current" computed by two different queries is exactly how
   * D1's header warns the two drift apart ("shows as upgraded but never took
   * effect server-side"); reusing the literal ORDER BY is what keeps them one
   * definition.
   *
   * 🔴 THREE conditions, ALL required, none decoration:
   *   · `rn > 1`             — there exists a NEWER row for this user (so a
   *     user with exactly one subscription ever is never touched, no matter
   *     how old);
   *   · `canceled_at IS NOT NULL` — belt-and-braces on top of `rn > 1`: only a
   *     row we KNOW Paddle marked terminated is ever a deletion candidate, even
   *     if a future bug in the ranking briefly let a live-looking row rank
   *     below 1;
   *   · `updated_at < cutoffIso` — old enough that the age policy (not just the
   *     ranking) agrees it is safe to forget.
   *
   * This repo still only STORES and ranks; it does not choose the cutoff or
   * decide dry-run vs. real — that policy lives in `db/reaper.ts`, same split
   * as everywhere else in this file.
   */
  listSupersededSubscriptions(cutoffIso: string): PaddleSubRow[];
  /** D11 — hard-delete ONE `paddle_subscriptions` row by id. No ownership
   *  check (system-wide by construction: a subscription is not scoped to a
   *  single caller the way a pc_devices row is) and no age/rank check either
   *  — both live in the query that PRODUCED the candidate
   *  ({@link listSupersededSubscriptions}), not in the delete itself, so there
   *  is exactly one place that decides "safe to remove". */
  removeSubscription(subscription_id: string): void;
}

function toSubRow(r: Record<string, unknown>): PaddleSubRow {
  return {
    subscription_id: r.subscription_id as string,
    user_id: r.user_id as string,
    customer_id: (r.customer_id as string | null) ?? null,
    status: r.status as string,
    tier: r.tier as Plan,
    price_id: (r.price_id as string | null) ?? null,
    cycle: (r.cycle as string | null) ?? null,
    current_period_end: (r.current_period_end as string | null) ?? null,
    canceled_at: (r.canceled_at as string | null) ?? null,
    last_event_id: r.last_event_id as string,
    last_occurred_at: r.last_occurred_at as string,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function toEventRow(r: Record<string, unknown>): BillingEventRow {
  return {
    event_id: r.event_id as string,
    notification_id: (r.notification_id as string | null) ?? null,
    event_type: r.event_type as string,
    occurred_at: r.occurred_at as string,
    received_at: r.received_at as string,
    subscription_id: (r.subscription_id as string | null) ?? null,
    user_id: (r.user_id as string | null) ?? null,
    outcome: r.outcome as StoredOutcome,
    detail: (r.detail as string | null) ?? null,
    redelivery_count: Number(r.redelivery_count ?? 0),
    last_notification_id: (r.last_notification_id as string | null) ?? null,
  };
}

export function makeBillingRepo(db: DatabaseSync): BillingRepo {
  // ── claim: "check + claim + record one redelivery" must be one single statement ──
  //
  // 🔴 A SELECT-then-INSERT here would be a race, not a guard. Paddle retries
  // deliveries CONCURRENTLY (a slow first attempt is still in flight when the
  // retry arrives), so two requests can both SELECT "not seen" and both go on to
  // apply the same state write. Making the check, the claim AND the redelivery
  // tally one atomic statement is what removes the window entirely.
  //
  // ⚠️ The verdict CANNOT come from `changes` any more: §3.3-bis turned the
  // conflict arm from DO NOTHING into DO UPDATE, and an UPDATE reports changes=1
  // exactly like the INSERT does — reading it would report every retry as a fresh
  // claim, i.e. the idempotency gate would be wide open while looking closed.
  // `RETURNING redelivery_count` is the discriminator instead: the INSERT arm
  // returns the column DEFAULT 0, the UPDATE arm returns an already-incremented
  // value, so `=== 0` is "this one is new" and it is read from the same statement
  // that decided it. (node:sqlite ships SQLite 3.51.3; RETURNING is 3.35+.)
  //
  // `notification_id` is bound to BOTH columns on the way in so that
  // `excluded.last_notification_id` carries the retry's id on the conflict arm.
  // The first column then never changes again (the first delivery), the second
  // tracks the most recent one.
  const claimStmt = db.prepare(
    `INSERT INTO billing_events
       (event_id, notification_id, event_type, occurred_at, received_at, outcome, last_notification_id)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(event_id) DO UPDATE SET
       redelivery_count     = redelivery_count + 1,
       last_notification_id = excluded.last_notification_id
     RETURNING redelivery_count AS redelivery_count`,
  );
  // finishEvent writes the row's FINAL state in one shot. It is called exactly
  // once per claimed event, immediately before the 200 — so assigning NULL for an
  // omitted field is not data loss: claimEvent left those three columns NULL and
  // nothing else writes them.
  const finishStmt = db.prepare(
    `UPDATE billing_events
        SET subscription_id = ?, user_id = ?, outcome = ?, detail = ?
      WHERE event_id = ?`,
  );
  const eventsByUser = db.prepare(
    `SELECT * FROM billing_events WHERE user_id = ? ORDER BY received_at DESC, event_id DESC LIMIT ?`,
  );
  // 0.2.38 — orphan rows. The OR is not redundant with the IN list: they answer two
  // different questions and each catches rows the other misses.
  //   · `user_id IS NULL`  → "this row cannot be attributed to any account" — true
  //     for every 'pending' row, and also for an 'applied'/'stale' row that
  //     somehow finished without a user (a defect we want to SEE, not to filter
  //     out);
  //   · `outcome IN (...)` → "this row never finished resolving / we don't know
  //     who to attribute it to" — an 'unmapped'
  //     row that DID get a user attached is still an unresolved payment and must
  //     stay in the list.
  // Same ORDER BY + tie-break as eventsByUser so paging behaves identically.
  const orphanEvents = db.prepare(
    `SELECT * FROM billing_events
      WHERE user_id IS NULL OR outcome IN ('pending','unmapped')
      ORDER BY received_at DESC, event_id DESC
      LIMIT ?`,
  );
  const subById = db.prepare('SELECT * FROM paddle_subscriptions WHERE subscription_id = ?');
  // "This user's most recent subscription row" —— NOT "the one in effect". Picking
  // the effective row (active beats canceled, expiry, permanent_free) is
  // BillingService's single answer (D1 §6.1); if this ORDER BY also tried to
  // answer it, there would be two places deciding a user's plan and they would
  // drift.
  // Ordered by last_occurred_at: a user who cancels sub_A and later buys sub_B
  // must resolve to sub_B, and "which subscription had activity most recently"
  // is exactly that question.
  // subscription_id is the tie-break so the answer is deterministic, never a coin flip.
  const subLatestForUser = db.prepare(
    `SELECT * FROM paddle_subscriptions
      WHERE user_id = ?
      ORDER BY last_occurred_at DESC, updated_at DESC, subscription_id DESC
      LIMIT 1`,
  );
  // ⚠️ `created_at` is deliberately ABSENT from the DO UPDATE SET list: it answers
  // "when did this subscription first enter our database" and a later event
  // cannot change that.
  // Every other column is last-writer-wins, and the ordering guard that decides
  // WHO the last writer may be lives in the handler (D1 §5.3 step 6) — this
  // statement does not compare last_occurred_at and does not protect against an
  // out-of-order write. Do not read the presence of that column here as a guard;
  // if the handler stops comparing, an old event WILL overwrite a new state.
  const upsertSub = db.prepare(
    `INSERT INTO paddle_subscriptions
       (subscription_id, user_id, customer_id, status, tier, price_id, cycle,
        current_period_end, canceled_at, last_event_id, last_occurred_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(subscription_id) DO UPDATE SET
       user_id            = excluded.user_id,
       customer_id        = excluded.customer_id,
       status             = excluded.status,
       tier               = excluded.tier,
       price_id           = excluded.price_id,
       cycle              = excluded.cycle,
       current_period_end = excluded.current_period_end,
       canceled_at        = excluded.canceled_at,
       last_event_id      = excluded.last_event_id,
       last_occurred_at   = excluded.last_occurred_at,
       updated_at         = excluded.updated_at`,
  );
  // D11 — the SAME ORDER BY as subLatestForUser above, literally: `rn = 1`
  // within a user's partition IS the row subLatestForUser would return, so
  // `rn > 1` can never select it. canceled_at + updated_at are the two extra
  // gates the interface doc comment argues (belt-and-braces + age policy).
  // node:sqlite ships SQLite 3.51.3; window functions are 3.25+.
  const supersededSubs = db.prepare(
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (
         PARTITION BY user_id
         ORDER BY last_occurred_at DESC, updated_at DESC, subscription_id DESC
       ) AS rn
       FROM paddle_subscriptions
     )
     WHERE rn > 1 AND canceled_at IS NOT NULL AND updated_at < ?
     ORDER BY updated_at ASC`,
  );
  const removeSubStmt = db.prepare('DELETE FROM paddle_subscriptions WHERE subscription_id = ?');

  return {
    claimEvent(row): boolean {
      const res = claimStmt.get(
        row.event_id,
        row.notification_id,
        row.event_type,
        row.occurred_at,
        row.received_at,
        OUTCOME_PENDING,
        row.notification_id,
      ) as { redelivery_count: number | bigint } | undefined;
      // A conflict-free INSERT and a conflict-taken UPDATE both RETURN a row, so
      // `undefined` is not "already seen" — it would mean the statement matched
      // nothing at all, which is unreachable for this shape. Fail loud rather
      // than answer "new" (double-apply) or "already seen" (silently drop a real event).
      if (!res) throw new Error(`billing_events: claimEvent returned no row for event_id=${row.event_id}`);
      return Number(res.redelivery_count) === 0;
    },
    finishEvent(event_id, patch): void {
      const res = finishStmt.run(
        patch.subscription_id ?? null,
        patch.user_id ?? null,
        patch.outcome,
        patch.detail ?? null,
        event_id,
      );
      // No silent failure: a finish for an event nobody claimed means the ledger is
      // lying — it would keep a 'pending' row (or none at all) while we answered
      // 200 "applied". Unreachable by construction (the handler claims first and
      // returns early when the claim fails), so if it ever fires it is a real
      // defect and must not be swallowed. Throwing is also the SAFE failure here:
      // the request 500s, Paddle retries, the retry's claim returns false and the
      // handler answers 200 duplicate — no state is written twice.
      if (Number(res.changes) !== 1) {
        throw new Error(`billing_events: finishEvent found no claimed row for event_id=${event_id}`);
      }
    },
    getSubscription(subscription_id): PaddleSubRow | null {
      const r = subById.get(subscription_id) as Record<string, unknown> | undefined;
      return r ? toSubRow(r) : null;
    },
    latestForUser(user_id): PaddleSubRow | null {
      const r = subLatestForUser.get(user_id) as Record<string, unknown> | undefined;
      return r ? toSubRow(r) : null;
    },
    upsertSubscription(row): void {
      upsertSub.run(
        row.subscription_id,
        row.user_id,
        row.customer_id,
        row.status,
        row.tier,
        row.price_id,
        row.cycle,
        row.current_period_end,
        row.canceled_at,
        row.last_event_id,
        row.last_occurred_at,
        row.created_at,
        row.updated_at,
      );
    },
    listEventsForUser(user_id, limit): BillingEventRow[] {
      return (eventsByUser.all(user_id, limit) as Record<string, unknown>[]).map(toEventRow);
    },
    listOrphanEvents(limit): BillingEventRow[] {
      return (orphanEvents.all(limit) as Record<string, unknown>[]).map(toEventRow);
    },
    listSupersededSubscriptions(cutoffIso): PaddleSubRow[] {
      return (supersededSubs.all(cutoffIso) as Record<string, unknown>[]).map(toSubRow);
    },
    removeSubscription(subscription_id): void {
      removeSubStmt.run(subscription_id);
    },
  };
}
