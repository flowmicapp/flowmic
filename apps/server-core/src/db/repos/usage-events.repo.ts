// SPEC-REF:
//   docs/strategy/2026-08-12-req1208-usage-log-storage-audit-and-design.md
//     §5.2 (the column list, argued per column), §5.3 (write points + the two
//     hard constraints), §5.4 (retention), §5.5 (the two read APIs)
//   src/db/schema.ts `-- 14. usage_events` (the DDL argues every column)
//   src/db/repos/usage.repo.ts (the MONTH bucket — the table this one is not)
//   CLAUDE.md red line: no silent failures / one value answers only one
//     question / anti-façade
//
// THE PER-EVENT USAGE LOG — card A2-5 / REQ-12-08.
//
// ── WHAT THIS REPO IS NOT ───────────────────────────────────────────────────
// It is NOT the quota's input. `usage_records` (usage.repo.ts) stays the single
// source of truth for "how much was used this month" (这个月用了多少), and
// `billing/quota-guard.ts` reads that one and only that one. The relationship
// between the two is an INEQUALITY that
// is designed in rather than tolerated:
//
//     SUM(usage_events over a month)  <=  usage_records for that month
//
// with exactly one legitimate cause for the gap — retention swept old events
// (db/retention.ts `USAGE_EVENTS_RETENTION_DAYS`), while `usage_records` is
// deliberately never swept. Any code that starts enforcing on the sum below is
// enforcing on a number that shrinks on its own.
//
// ── ONE METHOD, ONE QUESTION ────────────────────────────────────────────────
//   append()          → "record this thing that just happened" (记下刚刚发生的这一次)
//   listForUser()     → "what happened for this account during this window"
//                        (这个账号在这段时间里发生过什么) (one page)
//   purgeOlderThan()  → "delete this account's events earlier than a given
//                        moment" (把这个账号早于某一刻的事件删掉) (the retention leg)
// There is deliberately no `countForUser`, no `sumForUser` and no
// `listForUser(..., { total: true })`: a page that also carries a total is one
// call answering two questions, and the total is the very number nobody may
// reconcile against (see the inequality above).
//
// ── 🔴 THE SWITCH IS NOT IN HERE ────────────────────────────────────────────
// This module is the MECHANISM; whether a row may be written at all is POLICY
// and lives at the meter (`billing/usage-tracker.ts`, gated on
// `FLOWMIC_USAGE_EVENTS_ENABLED`). Putting the switch here would make every
// test that wants a row have to defeat it, and would hide the one decision an
// operator has to be able to see from the one file that announces it.

import type { DatabaseSync } from 'node:sqlite';

/** Which metered resource this event is about. The SAME two values as
 *  `QuotaKind` (billing/quota-guard.ts) — a third word for the same idea is how
 *  two parts of one system start disagreeing about what 'stt' means. */
export type UsageEventKind = 'stt' | 'llm';

/**
 * How this event ended.
 *
 * 🔴 A SEPARATE AXIS FROM THE COUNTS, which is the whole reason it exists: a
 * refusal records `stt_ms = 0`, and "zero minutes" (零分钟) and "was blocked"
 * (被挡住了) have to be two statements. Fold the refusal into the number and one
 * value means both "wasn't used" (没用) and "wasn't allowed to be used" (不让用).
 *
 * ⚠️ The design's third value `'torn_down'` is deliberately absent — see the
 * DDL comment in db/schema.ts: the metering seam cannot distinguish a clean
 * `finish()` from a `dispose()`, so the value could never be produced, and a
 * reader would take its absence as evidence that no session was ever torn down.
 */
export type UsageEventOutcome = 'ok' | 'quota_refused';

/**
 * Which DELIVERY path the traffic took — LAN or cloud relay.
 *
 * 🔴 CLOSED BY OWNER ON 2026-08-12 (docs/decisions/2026-08-12-owner-c5-usage-
 * channel-is-cloud-relay.md). Ruling ⑨'s "channel" (通道) is the delivery
 * channel, NOT an engine-pool line, and the detail table records ONLY
 * cloud-relay traffic.
 * ⚠️ The paragraph that used to stand here said 「NOTHING PRODUCES THIS TODAY, ON
 * PURPOSE … the honest stored value is NULL」. That was true when it was written
 * — the word had two possible meanings and this layer knew only one of them —
 * and the ruling is what made it expire. `billing/usage-tracker.ts`
 * `USAGE_EVENT_CHANNEL` now stamps every row, and carries the argument for why
 * that is a measurement rather than the guess this comment used to forbid.
 *
 * 🔴 'lan' EXISTS IN THE UNION AND NOTHING PRODUCES IT — deliberately, per the
 * same ruling's ②. A LAN session is served by the standalone sidecar, which
 * never reaches the meter. Do not add a 'lan' write 「for symmetry」.
 *
 * NULL remains storable and remains meaningful: it is what a row written before
 * this ruling says, and it means "don't know" (不知道) rather than 「lan」.
 */
export type UsageChannel = 'lan' | 'cloud';

/** One row, as it is written. */
export interface UsageEventInput {
  user_id: string;
  /** ms since epoch. The caller stamps it (the meter has the clock seam). */
  occurred_at: number;
  kind: UsageEventKind;
  /** STT milliseconds consumed. 0 on an `llm` event and on a refusal — a true
   *  zero, not a missing measurement. */
  stt_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  /** Was this consumption on the USER's own key. `true` still means "not
   *  billed" (不计费) — the billing exemption is unchanged; only the RECORD is
   *  new. */
  is_byok?: boolean;
  /** Omit (or `null`) for "don't know" (不知道). See {@link UsageChannel}. */
  channel?: UsageChannel | null;
  outcome: UsageEventOutcome;
  /**
   * A2-5 — the two character counts, or `null` for "this leg doesn't measure
   * character counts" (这条腿不量字数).
   *
   * 🔴 `null` AND `0` ARE DIFFERENT SENTENCES and the repo never converts one
   * into the other: `0` is "measured, and it's zero" (量了，是零) (a silent
   * utterance that still burned audio ms), `null` is "not measured" (没量)
   * (every `llm` event, every refusal). Defaulting
   * them to 0 would put a permanently-zero pair on two thirds of the table —
   * the exact shape this card was told not to build.
   *
   * `transcript_chars` is what the engine produced (post pure-pipeline, PRE
   * polish); `delivered_chars` is what actually left on `stt:final`. The DDL
   * argues why they are two columns.
   */
  transcript_chars?: number | null;
  delivered_chars?: number | null;
  /**
   * 2026-08-17 — WHOSE QUOTA REFUSED, on a `quota_refused` row.
   *
   * 🔴 A DIFFERENT QUESTION FROM `user_id`, which is why it is a different
   * column. `user_id` says whose ATTEMPT this was and whose ledger the minutes
   * would have been metered to; this says whose CEILING was hit. Since QTA-2
   * those can be two accounts — the phone's own and the paired PC owner's — and
   * a row that answered both with one value asserted that the acting account was
   * out of minutes when it was not.
   *
   * Omit (or `null`) for "nobody recorded it": every `outcome:'ok'` row (nothing
   * refused anything) and every row written before this column existed. `null`
   * is NOT "the acting account" — that inference is the defect.
   */
  refused_user_id?: string | null;
}

/** One row, as it is read back. `channel` is `string | null` rather than the
 *  narrowed union because a value that arrived before this process's idea of
 *  the enum must be readable, not silently dropped. */
export interface UsageEventRow {
  id: number;
  user_id: string;
  occurred_at: number;
  kind: string;
  stt_ms: number;
  tokens_in: number;
  tokens_out: number;
  /** 0 or 1 — the stored INTEGER, not a JS boolean, so the wire keeps the
   *  column's own shape and no consumer has to guess how a boolean was encoded. */
  is_byok: number;
  channel: string | null;
  outcome: string;
  /** `null` = this leg does not measure characters (llm events, refusals, and
   *  any row written before the columns existed). Carried through to the wire
   *  AS `null` — a surface that renders it as 0 has invented a measurement. */
  transcript_chars: number | null;
  delivered_chars: number | null;
  // 🔴 `refused_user_id` IS STORED AND IS DELIBERATELY NOT READ BACK HERE
  // (2026-08-17). This interface is the wire shape of BOTH read surfaces —
  // `GET /api/cloud/usage/events` returns these rows verbatim to the account
  // itself — and on a PC-owner refusal the stored value is ANOTHER ACCOUNT'S id.
  // Handing that to the phone's owner would be a cross-account identifier
  // disclosure to fix a wording problem. What the USER needs to be told is
  // "it was not your quota", which is a rendered sentence in nine locales and a
  // product decision, not a raw id; the ops surface shares this same projection,
  // so exposing it there means deciding this one first. Registered as the
  // follow-up rather than smuggled onto the wire as a side effect of a storage
  // card.
}

/** One page of events for one account. */
export interface UsageEventPage {
  rows: UsageEventRow[];
  /**
   * Cursor for the next page, or `null` when this page is provably the last.
   *
   * Computed from a `limit + 1` PROBE ROW, never from `rows.length < limit` —
   * that shortcut is wrong exactly when the final page is exactly full, and it
   * is wrong in the direction that hands out a cursor forever. Same mechanism
   * and same argument as `UsageMonthPage.next_after_user_id`.
   */
  next_after_id: number | null;
}

/** What a caller may ask for. Every field is REQUIRED except the cursor —
 *  see the route module for why the time window is not optional. */
export interface UsageEventQuery {
  /** Inclusive lower bound, ms epoch. */
  from: number;
  /** EXCLUSIVE upper bound, ms epoch. Half-open so two adjacent windows can be
   *  stitched without double-counting the boundary millisecond. */
  to: number;
  limit: number;
  /** The previous page's `next_after_id`. Omit for page 1. */
  after_id?: number;
}

/** Default page size for {@link UsageEventsRepo.listForUser}. */
export const USAGE_EVENTS_PAGE_DEFAULT = 100;

/**
 * Hard cap on page size. Same argument as `USAGE_PAGE_MAX`: an unbounded
 * "list everything" (列出全部) is fine today and becomes a latency cliff later with no code
 * change and no warning, so the ceiling is a constant somebody has to raise on
 * purpose. A DIFFERENT constant from the month-bucket one because it bounds a
 * different question (events for one account over a window, not accounts for
 * one month), and the two happening to be comparable numbers is not a reason to
 * share one name.
 */
export const USAGE_EVENTS_PAGE_MAX = 500;

export interface UsageEventsRepo {
  /** Append one row. Returns the assigned `id` (strictly increasing). */
  append(input: UsageEventInput): number;
  /** "what happened for this account during this window"
   *  (这个账号在这段时间里发生过什么), oldest first, one page. */
  listForUser(user_id: string, query: UsageEventQuery): UsageEventPage;
  /** Delete this account's events older than `cutoffMs` (exclusive). Returns
   *  how many rows went. The retention leg — see db/retention.ts. */
  purgeOlderThan(user_id: string, cutoffMs: number): number;
}

function toRow(r: Record<string, unknown>): UsageEventRow {
  return {
    id: Number(r.id as number | bigint),
    user_id: r.user_id as string,
    occurred_at: Number(r.occurred_at as number | bigint),
    kind: r.kind as string,
    stt_ms: Number(r.stt_ms as number | bigint),
    tokens_in: Number(r.tokens_in as number | bigint),
    tokens_out: Number(r.tokens_out as number | bigint),
    is_byok: Number(r.is_byok as number | bigint),
    channel: (r.channel as string | null) ?? null,
    outcome: r.outcome as string,
    // 🔴 `?? null` and NOT `Number(...)`: `Number(null)` is 0, which would erase
    // the whole distinction the two columns exist to carry (see UsageEventInput).
    transcript_chars: nullableNum(r.transcript_chars),
    delivered_chars: nullableNum(r.delivered_chars),
  };
}

/** A nullable INTEGER column, preserving the NULL. `number | bigint | null`
 *  depending on magnitude and on whether the row predates the column. */
function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? Number(v) : (v as number);
}

/** A count that arrives as `number | bigint` depending on magnitude, coerced in
 *  ONE place so two call sites cannot disagree. */
function toNum(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : ((v as number | null) ?? 0);
}

/** Non-negative integer ms, or 0. Guards the write path against a NaN/negative
 *  duration reaching an INTEGER column — the meter already drops `<= 0`
 *  durations, and this is the second gate on the value rather than a second
 *  copy of that policy (it clamps, it does not decide whether to record). */
function nonNegInt(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.round(v));
}

/** The same clamp for a NULLABLE count. Absent / null / NaN all stay NULL —
 *  "not measured" (没量) is preserved rather than converted into a measurement
 *  of zero. The NaN case lands on NULL deliberately: a broken number is closer
 *  to "don't know" (不知道) than to "zero" (零), and a 0 there would be
 *  indistinguishable from a real silent utterance. */
function nonNegIntOrNull(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return Math.max(0, Math.round(v));
}

export function makeUsageEventsRepo(db: DatabaseSync): UsageEventsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO usage_events
       (user_id, occurred_at, kind, stt_ms, tokens_in, tokens_out, is_byok, channel, outcome,
        transcript_chars, delivered_chars, refused_user_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // Two statements rather than one with an `id > 0` sentinel: 0 happens to sort
  // below every AUTOINCREMENT rowid, but that is an assumption about the key
  // space rather than something this file enforces, and the usage.repo.ts
  // precedent already refused the same shortcut.
  const firstPageStmt = db.prepare(
    `SELECT * FROM usage_events
      WHERE user_id=? AND occurred_at>=? AND occurred_at<?
      ORDER BY id ASC LIMIT ?`,
  );
  const afterStmt = db.prepare(
    `SELECT * FROM usage_events
      WHERE user_id=? AND occurred_at>=? AND occurred_at<? AND id>?
      ORDER BY id ASC LIMIT ?`,
  );
  // 🔴 SCOPED BY user_id, always. The sweep walks accounts one at a time
  // (db/retention.ts per-user isolation), so a table-wide DELETE here would be
  // a second, unscoped way to empty this table sitting one call away from a
  // loop that does not need it.
  const purgeStmt = db.prepare('DELETE FROM usage_events WHERE user_id=? AND occurred_at<?');
  const countStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM usage_events WHERE user_id=? AND occurred_at<?',
  );
  return {
    append(input): number {
      const info = insertStmt.run(
        input.user_id,
        // Round rather than trust: `occurred_at` is an INTEGER column and a
        // fractional ms would be stored as a REAL, quietly making one row's
        // type differ from every other row's.
        Math.round(input.occurred_at),
        input.kind,
        nonNegInt(input.stt_ms),
        nonNegInt(input.tokens_in),
        nonNegInt(input.tokens_out),
        // 🔴 1/0, never true/false and never '1'/'0'. node:sqlite would bind a
        // boolean, but the column's whole argument (db/schema.ts) is that it
        // holds an INTEGER, and the one place that decides the encoding is here.
        input.is_byok === true ? 1 : 0,
        input.channel ?? null,
        input.outcome,
        // 🔴 `nonNegIntOrNull`, not `nonNegInt`: the clamp that turns `undefined`
        // into 0 is right for the three counters above (an absent duration IS
        // zero consumption) and WRONG here (an absent count is "not measured"
        // (没量)). Two helpers because there are two questions.
        nonNegIntOrNull(input.transcript_chars),
        nonNegIntOrNull(input.delivered_chars),
        // 🔴 `?? null` and nothing else — no coercion, no substitution of
        // `input.user_id`. An absent value means the caller did not know whose
        // quota refused, and the one thing this column must never do is guess.
        input.refused_user_id ?? null,
      );
      return Number(info.lastInsertRowid);
    },
    listForUser(user_id, query): UsageEventPage {
      if (!Number.isInteger(query.limit) || query.limit <= 0) {
        throw new RangeError(
          `usageEvents.listForUser: limit must be a positive integer, got ${String(query.limit)}`,
        );
      }
      const limit = Math.min(query.limit, USAGE_EVENTS_PAGE_MAX);
      // The probe row: its PRESENCE is the only honest evidence of a next page.
      const probe = limit + 1;
      const raw = (
        query.after_id === undefined
          ? (firstPageStmt.all(user_id, query.from, query.to, probe) as Record<string, unknown>[])
          : (afterStmt.all(user_id, query.from, query.to, query.after_id, probe) as Record<string, unknown>[])
      ).map(toRow);
      if (raw.length <= limit) return { rows: raw, next_after_id: null };
      const rows = raw.slice(0, limit);
      const last = rows[rows.length - 1];
      return { rows, next_after_id: last ? last.id : null };
    },
    purgeOlderThan(user_id, cutoffMs): number {
      // COUNT first: node:sqlite's `changes` is reliable here, but the sweep
      // reports a number an operator reads as "how many were deleted" (删了多少)
      // and this makes that number come from the same predicate as the DELETE
      // rather than from the driver's bookkeeping. One extra indexed read per
      // account per day.
      const n = toNum((countStmt.get(user_id, cutoffMs) as Record<string, unknown>).n);
      if (n > 0) purgeStmt.run(user_id, cutoffMs);
      return n;
    },
  };
}
