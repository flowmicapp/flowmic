// SPEC-REF:
//   docs/decisions/2026-09-05-owner-usage-cycle-anchored-per-user.md (the ruling:
//     option 乙 — one cycle per account, anchored to the day it began)
//   apps/server-core/src/billing/billing-service.ts (`usagePeriod`, the only
//     caller that knows an account's anchor)
//   apps/server-core/src/billing/quota-guard.ts / usage-tracker.ts (the two
//     readers of the key this file computes — they MUST agree, see
//     test/quota-usage-month-bucket-alignment.test.ts)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// The metering period: which bucket a minute belongs to.
//
// ── 🔴 WHAT CHANGED, AND WHY IT IS A RULING AND NOT A REFACTOR ────────────
//
// Until 2026-09-05 every account's usage was bucketed by UTC CALENDAR MONTH
// (`currentMonth`, still in usage.repo.ts for the legacy rows). That clashed
// with the billing cycle in two ways the owner named:
//
//   · a Pro subscriber whose period ends on the 20th dropped to Free with the
//     whole month's spend still counted against Free's 20 minutes — locked out
//     until the 1st;
//   · somebody who subscribed on the 25th got a full allowance for six days and
//     another on the 1st.
//
// Owner ruled (option 乙): ONE CYCLE PER ACCOUNT, anchored to the day it began —
// registration for Free, the subscription's start for Pro/Max, and the day a
// subscription ENDED for the Free cycle that follows it. Quota resets on the
// account's own anniversary, the same day the provider bills.
//
// ── 🔴 THE KEY IS THE CYCLE'S START DATE, `YYYY-MM-DD` ────────────────────
//
// `usage_records.month` keeps its name and its type (TEXT, part of the PK) and
// simply holds a different kind of key from now on. Old rows keyed `YYYY-MM`
// stay where they are and are never read as a current bucket again — an
// account mid-month on deploy day starts a fresh bucket, once. That is the
// whole migration: no DDL, nothing rewritten, nothing destroyed, idempotent by
// construction.
//
// ── ANNIVERSARIES AND SHORT MONTHS ────────────────────────────────────────
//
// An anchor on the 31st rolls to Feb 28/29, Apr 30 … and back to the 31st in
// months that have one: the day-of-month is CLAMPED per month, never carried
// forward as an offset (an offset would drift: Jan 31 → Feb 28 → Mar 28 → …).
// This is the convention subscription providers use, and it is pinned by test.
//
// Everything here is UTC. A cycle boundary is a calendar day boundary in UTC,
// so `atMs` inside the same UTC day always maps to the same key.

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of a UTC instant. */
export function utcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** The anniversary `n` months after the anchor day, day-of-month clamped to
 *  the target month's length. Returns the UTC midnight of that day. */
export function anniversary(anchorMs: number, n: number): number {
  const a = new Date(anchorMs);
  const y = a.getUTCFullYear();
  const m = a.getUTCMonth() + n;
  const day = a.getUTCDate();
  const daysInTarget = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, daysInTarget));
}

export interface UsagePeriod {
  /** The bucket key: the cycle's first day, `YYYY-MM-DD`. */
  key: string;
  /** UTC midnight the cycle began (inclusive). */
  startMs: number;
  /** UTC midnight the next cycle begins (exclusive) — 「quota resets on」. */
  endMs: number;
  /** ISO dates of the two, for the wire. */
  start: string;
  end: string;
}

/**
 * The cycle containing `atMs`, counting monthly anniversaries from `anchorMs`.
 *
 * ⚠️ `atMs` before the anchor is a question with no honest answer — nothing was
 * metered before the account existed — so it is clamped to the anchor's own
 * first cycle rather than extrapolated backwards. A caller that hits this has a
 * clock problem, not a billing one, and the clamp keeps it from minting a key
 * in the past that nothing else will ever read.
 */
export function usagePeriodAt(anchorMs: number, atMs: number): UsagePeriod {
  const anchorDay = Date.UTC(new Date(anchorMs).getUTCFullYear(), new Date(anchorMs).getUTCMonth(), new Date(anchorMs).getUTCDate());
  const at = Math.max(atMs, anchorDay);
  // Estimate the month count, then correct by at most one step in each
  // direction — cheaper than looping from n=0 for an account several years old,
  // and exact because anniversaries are monotonic.
  const a = new Date(anchorDay);
  const b = new Date(at);
  let n = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (anniversary(anchorDay, n) > at) n -= 1;
  while (anniversary(anchorDay, n + 1) <= at) n += 1;
  const startMs = anniversary(anchorDay, n);
  const endMs = anniversary(anchorDay, n + 1);
  return { key: utcDate(startMs), startMs, endMs, start: utcDate(startMs), end: utcDate(endMs) };
}

/**
 * Which instant an account's current cycle is anchored to.
 *
 * 🔴 DERIVED, NEVER STORED, and that is the design. The three moments the ruling
 * names — registration, a subscription starting, a subscription ending — are
 * all facts the database already holds (`users.created_at`, and the rows the
 * webhook writes). Storing a fourth copy as 「the anchor」 would need an event
 * to fire at every transition, and the transition that matters most — a paid
 * period ENDING — is driven by the clock, not by an event we can be sure to
 * receive. Deriving it means it cannot be missed and cannot go stale.
 *
 * The anchor is the LATEST of:
 *   · registration;
 *   · the start of any subscription that currently grants (the cycle follows
 *     the provider's billing anniversary);
 *   · the end of any subscription that has ended, if that end is in the past
 *     (the Free cycle that follows a paid one starts the day the paid one
 *     stopped — the owner's 「初始化 FREE 档为当前日期开始」).
 *
 * A boundary in the future is not an anchor yet: a scheduled cancellation's
 * period end must not restart anybody's cycle before it happens.
 */
export function effectiveAnchorMs(
  registeredAtMs: number,
  subscriptions: readonly { startedAtMs: number | null; endedAtMs: number | null; grants: boolean }[],
  atMs: number,
): number {
  let anchor = registeredAtMs;
  for (const s of subscriptions) {
    if (s.grants && s.startedAtMs !== null && s.startedAtMs <= atMs) anchor = Math.max(anchor, s.startedAtMs);
    if (!s.grants && s.endedAtMs !== null && s.endedAtMs <= atMs) anchor = Math.max(anchor, s.endedAtMs);
  }
  return anchor;
}

/** Legacy `YYYY-MM` keys are exactly 7 characters; cycle keys are 10. The two
 *  never collide, so both can live in one table without a discriminator. */
export function isCycleKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key);
}

/** The database-stamp parser lives in db/utc-stamp.ts (it is needed outside
 *  billing too: the verification grace clock reads the same column). Re-exported
 *  here because this is where it was first measured and first used. */
export { parseUtcStamp } from '../db/utc-stamp';

/** The subset of a `paddle_subscriptions` row the expiry rule reads. */
export interface ExpiryRow {
  status: string;
  current_period_end: string | null;
  canceled_at: string | null;
  last_occurred_at: string;
}

/**
 * Has this subscription row stopped granting, and when did/does it end — THE
 * ONE expiry rule, shared by the tier (`BillingService.fromPaddle`) and the
 * metering cycle (`BillingService.usagePeriod`). It lives here rather than in
 * billing-service.ts because that file sits at the 800-line cap and because the
 * cycle is the second consumer: a subscription the tier treats as over must be
 * the same subscription the cycle treats as over, on the same instant.
 *
 * The rule (from D1 §5's event table, kept verbatim from fromPaddle):
 *   · a period end recorded ⇒ expired once `atMs` passes it (NaN ⇒ expired,
 *     fail-closed);
 *   · no period end on a TERMINAL status (canceled / paused) ⇒ that is the
 *     provider's spelling of 「already ended」: expired once `atMs` passes the
 *     cancellation stamp (or, lacking one, the row's last event);
 *   · no period end on any other status ⇒ omitted, not concluded ⇒ not expired.
 *
 * `endMs` is the recorded period end; `endedAtMs` the instant a terminal row
 * with no period actually ended. Evaluated at `atMs`, not at construction, so
 * a replica replaying a past record gets the answer that was true then.
 */
export function subscriptionRowExpiry(row: ExpiryRow, atMs: number): { expired: boolean; endMs: number | null; endedAtMs: number | null } {
  const endMs = row.current_period_end === null ? null : Date.parse(row.current_period_end);
  const terminalStatusWithNoPeriod = endMs === null && (row.status === 'canceled' || row.status === 'paused');
  const occurredMs = terminalStatusWithNoPeriod ? Date.parse(row.canceled_at ?? row.last_occurred_at) : null;
  const expired = terminalStatusWithNoPeriod
    ? !Number.isFinite(occurredMs) || atMs >= (occurredMs as number)
    : endMs === null
      ? false
      : !Number.isFinite(endMs) || atMs >= endMs;
  return {
    expired,
    endMs: endMs !== null && Number.isFinite(endMs) ? endMs : null,
    endedAtMs: occurredMs !== null && Number.isFinite(occurredMs) ? occurredMs : null,
  };
}

export const USAGE_PERIOD_DAY_MS = DAY_MS;
