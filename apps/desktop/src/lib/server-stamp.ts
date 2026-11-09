// FR-D2 (D-MKT-7, 2026-11-06) — parse a timestamp the way the DATABASE meant it.
//
// SQLite stamps `mobile_pairings.paired_at` and three other columns itself as
// `YYYY-MM-DD HH:MM:SS`: UTC, with no zone suffix. `new Date` reads that form as
// LOCAL time, so a UTC+8 reader saw a pairing made at 16:20 as "Paired 08:20".
//
// This is the desktop's copy of the rule in `apps/server-core/src/db/utc-stamp.ts`
// (`parseUtcStamp`), which states it in full and names the columns. Both channels
// hand the desktop the raw column, so the read has to be right on this side.
// A stamp with a zone, or an ISO form without one, passes through untouched.

const SQLITE_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function parseServerStamp(stamp: string): Date {
  const t = stamp.trim();
  return new Date(SQLITE_STAMP.test(t) ? `${t.replace(' ', 'T')}Z` : t);
}
