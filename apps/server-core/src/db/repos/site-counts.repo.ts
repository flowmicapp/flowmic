// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §3
//
// Daily aggregate buckets for the public website. One question per method:
//   bump()           → add one to a named bucket (the only writer shape)
//   summary()        → totals by kind for a day range
//   breakdown()      → one (kind, dim) sliced by dim_value for a day range
//   purgeOlderThan() → delete buckets strictly before a UTC day string
//
// 🔴 NO VISITOR IDENTITY. There is no session column and no way to invent one
// from this table. A UV / bounce-rate derived from these rows would be fiction.

import type { DatabaseSync } from 'node:sqlite';

export type SiteCountKind = 'pageview' | 'download_click' | 'register_ok' | 'login_ok';
export type SiteCountDim = 'path' | 'locale' | 'referrer_host' | 'utm' | 'src' | '_';

/** The total-only dimension used by register_ok / login_ok (and by summary
 *  rollups that do not care about a breakdown). */
export const SITE_TOTAL_DIM: SiteCountDim = '_';
export const SITE_TOTAL_VALUE = '_';

export interface SiteCountBump {
  day: string;
  kind: SiteCountKind;
  dim: SiteCountDim;
  dim_value: string;
  /** Defaults to 1. */
  delta?: number;
}

export interface SiteKindTotal {
  kind: SiteCountKind;
  count: number;
}

export interface SiteBreakdownRow {
  dim_value: string;
  count: number;
}

export interface SiteCountsRepo {
  bump(row: SiteCountBump): void;
  /** Sum of `count` per `kind` over `[fromDay, toDay]` inclusive (UTC days). */
  summary(fromDay: string, toDay: string): SiteKindTotal[];
  /** One kind + one dim, broken down by dim_value over the same inclusive range. */
  breakdown(kind: SiteCountKind, dim: SiteCountDim, fromDay: string, toDay: string): SiteBreakdownRow[];
  /** Delete every bucket whose `day` is strictly less than `cutoffDay` (UTC). */
  purgeOlderThan(cutoffDay: string): number;
}

export function makeSiteCountsRepo(db: DatabaseSync): SiteCountsRepo {
  const upsert = db.prepare(
    `INSERT INTO site_daily_counts (day, kind, dim, dim_value, count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, kind, dim, dim_value) DO UPDATE SET count = count + excluded.count`,
  );
  const summaryStmt = db.prepare(
    `SELECT kind, SUM(count) AS count
       FROM site_daily_counts
      WHERE day >= ? AND day <= ?
        AND dim = '_'
      GROUP BY kind
      ORDER BY kind`,
  );
  const breakdownStmt = db.prepare(
    `SELECT dim_value, SUM(count) AS count
       FROM site_daily_counts
      WHERE kind = ? AND dim = ? AND day >= ? AND day <= ?
      GROUP BY dim_value
      ORDER BY count DESC, dim_value`,
  );
  const purgeStmt = db.prepare(`DELETE FROM site_daily_counts WHERE day < ?`);

  return {
    bump(row): void {
      const delta = row.delta ?? 1;
      if (delta <= 0) return;
      upsert.run(row.day, row.kind, row.dim, row.dim_value, delta);
    },
    summary(fromDay, toDay): SiteKindTotal[] {
      const rows = summaryStmt.all(fromDay, toDay) as Array<{ kind: string; count: number | bigint }>;
      return rows.map((r) => ({
        kind: r.kind as SiteCountKind,
        count: Number(r.count),
      }));
    },
    breakdown(kind, dim, fromDay, toDay): SiteBreakdownRow[] {
      const rows = breakdownStmt.all(kind, dim, fromDay, toDay) as Array<{
        dim_value: string;
        count: number | bigint;
      }>;
      return rows.map((r) => ({ dim_value: r.dim_value, count: Number(r.count) }));
    },
    purgeOlderThan(cutoffDay): number {
      return Number(purgeStmt.run(cutoffDay).changes);
    },
  };
}
