// SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md §3
import { describe, it, expect } from 'vitest';
import { createDbConnection } from '../src/db/connection';
import { SITE_TOTAL_DIM, SITE_TOTAL_VALUE } from '../src/db/repos/site-counts.repo';
import { startRetentionSweeper, SITE_COUNTS_RETENTION_DAYS } from '../src/db/retention';
import { planLimits } from '../src/billing/plans';

function db() {
  return createDbConnection({ dbPath: ':memory:', encryptionKey: Buffer.alloc(32) });
}

describe('site_daily_counts buckets', () => {
  it('🔴 summary reads only dim=_ — five pageview dims must not become five pageviews', () => {
    const conn = db();
    const day = '2026-08-15';
    conn.siteCounts.bump({ day, kind: 'pageview', dim: 'path', dim_value: '/' });
    conn.siteCounts.bump({ day, kind: 'pageview', dim: 'locale', dim_value: 'en' });
    conn.siteCounts.bump({ day, kind: 'pageview', dim: 'referrer_host', dim_value: '(direct)' });
    conn.siteCounts.bump({ day, kind: 'pageview', dim: 'utm', dim_value: '(none)' });
    conn.siteCounts.bump({ day, kind: 'pageview', dim: SITE_TOTAL_DIM, dim_value: SITE_TOTAL_VALUE });
    expect(conn.siteCounts.summary(day, day)).toEqual([{ kind: 'pageview', count: 1 }]);
    expect(conn.siteCounts.breakdown('pageview', 'path', day, day)).toEqual([{ dim_value: '/', count: 1 }]);
    conn.close();
  });

  it('ON CONFLICT increments the same bucket', () => {
    const conn = db();
    conn.siteCounts.bump({ day: '2026-08-15', kind: 'download_click', dim: 'src', dim_value: 'band' });
    conn.siteCounts.bump({ day: '2026-08-15', kind: 'download_click', dim: 'src', dim_value: 'band' });
    expect(conn.siteCounts.breakdown('download_click', 'src', '2026-08-15', '2026-08-15')).toEqual([
      { dim_value: 'band', count: 2 },
    ]);
    conn.close();
  });

  it(`retention sweeper deletes site buckets older than ${SITE_COUNTS_RETENTION_DAYS} days`, () => {
    const conn = db();
    const now = Date.parse('2026-08-15T12:00:00Z');
    conn.siteCounts.bump({ day: '2026-01-01', kind: 'pageview', dim: SITE_TOTAL_DIM, dim_value: SITE_TOTAL_VALUE });
    conn.siteCounts.bump({ day: '2026-08-15', kind: 'pageview', dim: SITE_TOTAL_DIM, dim_value: SITE_TOTAL_VALUE });
    const s = startRetentionSweeper({
      timeline: conn.timeline,
      siteCounts: conn.siteCounts,
      listUserIds: () => [],
      limitsOf: () => planLimits('free'),
      nowMs: () => now,
      setIntervalFn: () => 1,
      clearIntervalFn: () => undefined,
    });
    expect(s.runOnce().siteCounts).toBe(1);
    expect(conn.siteCounts.summary('2026-01-01', '2026-08-15')).toEqual([{ kind: 'pageview', count: 1 }]);
    s.stop();
    conn.close();
  });
});
