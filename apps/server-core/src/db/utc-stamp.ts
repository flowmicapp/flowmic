// SPEC-REF:
//   apps/server-core/src/db/schema.ts (`DEFAULT (datetime('now'))` on
//     users.created_at, pc_devices.created_at, mobile_pairings.paired_at,
//     user_settings.updated_at — the four columns SQLite stamps itself)
//   apps/server-core/src/billing/usage-period.ts (the first consumer, and where
//     this was measured)
//
// Parse a timestamp the way the DATABASE meant it.
//
// 🔴 THE FOUR COLUMNS ABOVE ARE STAMPED BY SQLITE AS `YYYY-MM-DD HH:MM:SS` — UTC,
// with NO zone suffix. `Date.parse` reads that space-separated form as LOCAL
// time. Measured 2026-09-05: on a UTC+8 developer machine a registration at
// 01:54Z parsed to the previous day and the metering cycle started a day early;
// on the UTC New York box the same code was right by coincidence; and the
// Tokyo replica runs in Asia/Shanghai, where it was wrong in production too.
// A ruler that answers differently on two machines is the shape this repo
// names first — and this app is used across every timezone, so 「which machine
// evaluated it」 must never be part of the answer.
//
// ⚠️ THIS IS THE ONLY WAY A STAMPED COLUMN MAY BE PARSED. `Date.parse(row.
// created_at)` on one of the four columns above is a bug, whatever the box it
// happens to be right on. ISO strings with a zone — everything our own code
// writes — pass through unchanged, so callers do not have to know which kind
// they hold.
//
// The process is ALSO pinned to UTC at the service level (`TZ=Etc/UTC` in
// /etc/flowmic-app/env on every node, 2026-09-05), which makes the bare parse
// right again; that is the belt, this is the braces. Neither alone is enough:
// the pin protects production, this protects every developer machine and
// every test.

const SQLITE_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function parseUtcStamp(stamp: string): number {
  const t = stamp.trim();
  if (SQLITE_STAMP.test(t)) return Date.parse(t.replace(' ', 'T') + 'Z');
  return Date.parse(t);
}
