// SPEC-REF:
//   docs/rebuild/05-DATA-MODEL.md §1 (usage_records PK (user_id, month),
//     UPSERT accumulate)
//   docs/strategy/2026-07-23-mock-billing-design.md §3 (month bucket = UTC
//     YYYY-MM; cross-month = new row = natural reset, NO reset job)
//   Ported UPSERT mechanism from legacy usage-tracker.ts makeSqliteUsageRepo.
//
// ── platform-level aggregation (added this round) ──────────────────────────
// Until now this repo could only answer "how much did this one account use this
// one month" — there was no way to ask "how much did the whole platform use" at
// all. `grep -rn "SUM(\|COUNT(\|GROUP BY" src/`
// across the whole of server-core returned ZERO before this file; these are the
// first aggregates in the codebase, so they are written to be the template.
//
// 🔴 EACH METHOD ANSWERS ONLY ONE QUESTION (CLAUDE.md's #1 bug shape, "one value
// answering two questions"):
//   get()               → "how much did this account use this month"        (unchanged)
//   listByUser()        → "how much did this account use each month"    (0.3.0 P4, one account)
//   listUsersForMonth() → "how much did each account use this month"    (per-user ROWS only)
//   totalForMonth()     → "how much did the whole platform use this month"    (platform SUM only)
//   listMonths()        → "which months have usage rows"            (existence only)
// There is deliberately NO `listUsersForMonth(month, { withTotals: true })` and
// no `total` field smuggled into the page result: one call, one question.
//
// ✅ 0.2.48 — wired up. The 0.2.47 header here read "[not wired] — nothing calls the
// three new methods", with the correct reason (a whole-platform usage surface
// without the admin gate is a data leak, and the auth surface was not this file's
// to build). That gate now exists, so the three methods are exposed by
// `http/ops-routes.ts` behind it:
//   listMonths()         → GET /api/ops/usage/months
//   totalForMonth()      → GET /api/ops/usage/summary?month=
//   listUsersForMonth()  → GET /api/ops/usage/users?month=
// Contract: docs/strategy/2026-08-02-o2-usage-route-contract.md (change
// discipline: edit that document first). Verdict = [proven by unit test + not deployed] — `test/ops-usage-route.test.ts` boots a
// real saas server, so it proves the ROUTES exist and not merely the functions;
// nothing here has run in production yet.
//
// ⚠️ THE TABLE-SCAN NOTE BELOW IS NOW LIVE, not hypothetical: `totalForMonth`
// has a real HTTP caller, so "an index added for a query no production caller
// makes" has stopped being the argument against it. It is still the right call at
// ~42 accounts — the point is that the reason changed, and the next person to
// read that paragraph should know which half of it still holds.
//
// ⚠️ TABLE SCAN, knowingly accepted: PRIMARY KEY is (user_id, month), so the
// implicit index is ordered user_id-first and a `WHERE month=?` rollup cannot
// seek — it walks every row. At ~41 accounts × a handful of months that is
// microseconds, and an index added for a query no production caller makes yet
// would be a write-path cost paid for a façade. The fix, when a real caller
// exists and the table is big enough to notice, is
// `CREATE INDEX idx_usage_records_month ON usage_records(month, user_id)` in
// connection.ts reconcileSchema(); it is named here so nobody has to rediscover
// it. (The keyset pagination below DOES use the PK index for its `user_id > ?`
// range, so paging is not quadratic the way OFFSET would be.)

import type { DatabaseSync } from 'node:sqlite';

export interface UsageRecord {
  user_id: string;
  month: string;
  stt_minutes: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
  updated_at: string;
}

export interface UsageDelta {
  stt_minutes?: number;
  llm_tokens_in?: number;
  llm_tokens_out?: number;
}

/**
 * Platform-level monthly total —— answers, and only answers, "how much did the
 * whole platform use this month".
 *
 * 🔴 An empty month returns 0, not null, while `users` is the "was there
 * anything at all" answer.
 * The standing rule "a `null` duration must never be treated as 0" exists because a per-entry duration of
 * `null` means "this entry was not measured" — genuinely unknown, and rendering unknown as zero
 * is a lie. This aggregate is the OPPOSITE case and the distinction is load-
 * bearing: `usage_records` is a COMPLETE historical record (db/retention.ts:42
 * deliberately never sweeps it — a swept usage row would silently refund quota),
 * so "not a single row this month" is not "unknown", it is a PROVEN zero. Returning `null`
 * would push a three-state (`number | null | 0`) onto every caller for a state
 * that cannot occur.
 * What must NOT be silent is "this month has no account records at all" vs "all 41 accounts are 0",
 * and those two are different sentences here — `users:0` vs `users:41` — instead
 * of being crammed into the totals. That is the same one-value-one-question rule
 * applied to the empty set: the totals answer "how much was used", `users` answers
 * "how many accounts left a row this month".
 * Use `listMonths()` to find out whether a month string exists at all before
 * reading a zero as news.
 */
export interface UsageMonthTotal {
  month: string;
  /** How many accounts have a row in this month (NOT how many users exist). */
  users: number;
  /** 🔴 Unrounded. Rounding is a presentation decision and would make this value
   *  answer "what does the interface display" instead of "how much was actually used". */
  stt_minutes: number;
  llm_tokens_in: number;
  llm_tokens_out: number;
}

/** Keyset page request for {@link UsageRepo.listUsersForMonth}. */
export interface UsagePageRequest {
  /** Rows per page. Defaults to {@link USAGE_PAGE_DEFAULT}, hard-capped at
   *  {@link USAGE_PAGE_MAX}. A non-integer or <= 0 THROWS (it cannot mean
   *  anything); a too-large value is clamped, and the clamp is not silent
   *  because `next_after_user_id` then comes back non-null. */
  limit?: number;
  /** Cursor: the `next_after_user_id` of the previous page. Omit for page 1. */
  after_user_id?: string;
}

/** One page of per-user rows. */
export interface UsageMonthPage {
  rows: UsageRecord[];
  /**
   * Cursor for the next page, or `null` when this page is provably the last.
   *
   * Computed by fetching `limit + 1` and trimming — NOT by `rows.length < limit`.
   * That shortcut is wrong exactly when the final page is exactly full, and it
   * fails in the direction that keeps handing out a cursor forever.
   */
  next_after_user_id: string | null;
}

/** Default page size for {@link UsageRepo.listUsersForMonth}. */
export const USAGE_PAGE_DEFAULT = 50;

/**
 * Hard cap on page size. An unbounded "list every user" is a latent problem that
 * grows with the users table: it would be fine at today's ~41 accounts and would
 * become a memory/latency cliff with no code change and no warning. Capping here
 * means the ceiling is a constant somebody has to raise on purpose.
 */
export const USAGE_PAGE_MAX = 200;

export interface UsageRepo {
  /** "How much did this account use this month". Unchanged. */
  get(user_id: string, month: string): UsageRecord | null;
  /** "Add this usage to this account for this month". Unchanged. */
  increment(user_id: string, month: string, delta: UsageDelta): UsageRecord;
  /**
   * 0.3.0 P4 — "how much did this account use each month, respectively", newest month first.
   *
   * The account-data export's usage section (GDPR portability: the privacy policy
   * promises the console can hand back "monthly usage totals", and this repo is
   * where they live). It answers for ONE account across ALL months, which is the
   * exact transpose of `listUsersForMonth` — hence a separate method rather than
   * a flag on that one: one call, one question.
   *
   * ⚠️ Deliberately UNPAGINATED, and the bound is different from the one that
   * makes `listMonths` defensible: here the row count is (months this account has
   * existed), i.e. tens at most, and it is per-account rather than per-platform.
   * It also seeks rather than scans — PRIMARY KEY (user_id, month) is ordered
   * user_id-first, so `WHERE user_id=?` uses the implicit index.
   */
  listByUser(user_id: string): UsageRecord[];
  /**
   * "How much did each account use this month" — per-user rows, one page at a time.
   *
   * Ordered by `user_id ASC`, which is both the PK index order (so the keyset
   * `user_id > ?` seeks instead of scanning from the top) and stable under
   * concurrent writes. Deliberately NOT ordered by consumption: "who used the most" is
   * a different question, it cannot be keyset-paginated on user_id, and building
   * it as an `orderBy` flag here is the flag-shaped version of the bug this file
   * is trying not to have.
   *
   * Returns rows only. It never returns a platform total — see {@link totalForMonth}.
   */
  listUsersForMonth(month: string, page?: UsagePageRequest): UsageMonthPage;
  /** "How much did the whole platform use this month" — one row, always, never null. */
  totalForMonth(month: string): UsageMonthTotal;
  /**
   * "Which months have usage rows", newest first.
   *
   * Unpaginated on purpose, and this is the one place where "unbounded" is defensible:
   * the row count is bounded by how many calendar months the product has existed
   * (tens, ever), not by the users table. It exists so a caller can tell a real
   * zero from a mistyped month string instead of reading a legitimate-looking
   * `{ users: 0 }` as fact.
   */
  listMonths(): string[];
}

/** UTC YYYY-MM bucket key (05 §1 / mock-billing §3). */
export function currentMonth(now: () => number = Date.now): string {
  const d = new Date(now());
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, '0')}`;
}

function toRecord(r: Record<string, unknown>): UsageRecord {
  return {
    user_id: r.user_id as string,
    month: r.month as string,
    stt_minutes: r.stt_minutes as number,
    llm_tokens_in: r.llm_tokens_in as number,
    llm_tokens_out: r.llm_tokens_out as number,
    updated_at: r.updated_at as string,
  };
}

/** SUM()/COUNT() come back as number | bigint depending on magnitude and on the
 *  driver's integer handling; the empty-set NULL is already turned into 0 by
 *  COALESCE in SQL. One coercion site, so no two call sites can disagree. */
function toNum(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : ((v as number | null) ?? 0);
}

export function makeUsageRepo(db: DatabaseSync): UsageRepo {
  const getStmt = db.prepare('SELECT * FROM usage_records WHERE user_id=? AND month=?');
  // 0.3.0 P4 — every month of ONE account (the data export). Seeks on the PK's
  // user_id-first index; `month DESC` matches listMonths()'s newest-first order
  // so the two never disagree about which end of a list is "most recent".
  const byUserStmt = db.prepare('SELECT * FROM usage_records WHERE user_id=? ORDER BY month DESC');
  // Two statements rather than one with a `user_id > ''` sentinel: '' happens to
  // sort below every non-empty TEXT in SQLite, but that is an assumption about
  // the id format that nothing in this file enforces, and a wrong one would
  // silently drop the first row of page 1.
  const listFirstStmt = db.prepare(
    'SELECT * FROM usage_records WHERE month=? ORDER BY user_id ASC LIMIT ?',
  );
  const listAfterStmt = db.prepare(
    'SELECT * FROM usage_records WHERE month=? AND user_id>? ORDER BY user_id ASC LIMIT ?',
  );
  // COUNT(*) is 0 for an empty set (never NULL); SUM() is NULL for an empty set,
  // hence COALESCE. Not SQLite's TOTAL(): it also returns 0 for the empty set but
  // it returns REAL unconditionally, which would turn the two INTEGER token
  // columns into floats — a token count is a count, and "why does it have a decimal point" is a
  // question nobody should have to answer later.
  const totalStmt = db.prepare(
    `SELECT COUNT(*)                         AS users,
            COALESCE(SUM(stt_minutes), 0)    AS stt_minutes,
            COALESCE(SUM(llm_tokens_in), 0)  AS llm_tokens_in,
            COALESCE(SUM(llm_tokens_out), 0) AS llm_tokens_out
       FROM usage_records WHERE month=?`,
  );
  const monthsStmt = db.prepare('SELECT DISTINCT month FROM usage_records ORDER BY month DESC');
  const upsertStmt = db.prepare(
    `INSERT INTO usage_records (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       stt_minutes    = stt_minutes    + excluded.stt_minutes,
       llm_tokens_in  = llm_tokens_in  + excluded.llm_tokens_in,
       llm_tokens_out = llm_tokens_out + excluded.llm_tokens_out,
       updated_at     = excluded.updated_at`,
  );
  return {
    get(user_id, month): UsageRecord | null {
      const r = getStmt.get(user_id, month) as Record<string, unknown> | undefined;
      return r ? toRecord(r) : null;
    },
    increment(user_id, month, delta): UsageRecord {
      upsertStmt.run(
        user_id,
        month,
        delta.stt_minutes ?? 0,
        delta.llm_tokens_in ?? 0,
        delta.llm_tokens_out ?? 0,
        new Date().toISOString(),
      );
      return toRecord(getStmt.get(user_id, month) as Record<string, unknown>);
    },
    listByUser(user_id): UsageRecord[] {
      return (byUserStmt.all(user_id) as Record<string, unknown>[]).map(toRecord);
    },
    listUsersForMonth(month, page = {}): UsageMonthPage {
      const asked = page.limit ?? USAGE_PAGE_DEFAULT;
      if (!Number.isInteger(asked) || asked <= 0) {
        throw new RangeError(
          `usage.listUsersForMonth: limit must be a positive integer, got ${String(page.limit)}`,
        );
      }
      const limit = Math.min(asked, USAGE_PAGE_MAX);
      // limit + 1 is the probe row: its presence is the ONLY honest evidence that
      // another page exists.
      const probe = limit + 1;
      const raw = (
        page.after_user_id === undefined
          ? (listFirstStmt.all(month, probe) as Record<string, unknown>[])
          : (listAfterStmt.all(month, page.after_user_id, probe) as Record<string, unknown>[])
      ).map(toRecord);
      if (raw.length <= limit) return { rows: raw, next_after_user_id: null };
      const rows = raw.slice(0, limit);
      const last = rows[rows.length - 1];
      return { rows, next_after_user_id: last ? last.user_id : null };
    },
    totalForMonth(month): UsageMonthTotal {
      // Aggregate with no GROUP BY always yields exactly one row, even over the
      // empty set — so there is no `undefined` branch to invent a value for.
      const r = totalStmt.get(month) as Record<string, unknown>;
      return {
        month,
        users: toNum(r.users),
        stt_minutes: toNum(r.stt_minutes),
        llm_tokens_in: toNum(r.llm_tokens_in),
        llm_tokens_out: toNum(r.llm_tokens_out),
      };
    },
    listMonths(): string[] {
      return (monthsStmt.all() as Record<string, unknown>[]).map((r) => r.month as string);
    },
  };
}
