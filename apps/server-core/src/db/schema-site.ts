// SPEC-REF:
//   docs/strategy/2026-08-15-site-analytics-first-party-design.md
//   ./schema.ts (INIT_SQL — SITE_SQL is interpolated there unconditionally, in
//     one exec, exactly like TRIAL_SQL and RECOVERY_SQL)
//
// 🔴 STRUCTURAL SPLIT ONLY (card MP-1, 2026-09-11) — moved VERBATIM out of
// db/schema.ts, comments included, because that file stood at 799 of the
// 800-line `file-size` cap and MP-1's two tables needed an interpolation line.
// NO DDL CHANGED, no column moved, no comment dropped: the SQL text below is
// byte-for-byte what schema.ts held, so a database migrated by the previous
// build and one created by this one are the same database.
//
// 🔴 SAME TEMPLATE-LITERAL TRAP AS schema.ts: this is ONE template literal, so a
// backtick anywhere inside it — even inside a `--` SQL comment — terminates it
// early and breaks the whole server-core build.

export const SITE_SQL = /* sql */ `
-- ── site_daily_counts (2026-08-15 — first-party public-site aggregate counts) ─
-- SPEC-REF: docs/strategy/2026-08-15-site-analytics-first-party-design.md
--
-- Daily BUCKETS only — never a per-visitor row. Primary key is the whole
-- dimension tuple so concurrent increments UPSERT rather than race into
-- duplicates. Not FK-linked to users: register_ok / login_ok are platform
-- totals, not account-scoped events (privacy: no visitor id, no account id).
-- Retention = 90 days (db/retention.ts SITE_COUNTS_RETENTION_DAYS), swept
-- table-wide because there is no per-account owner to walk.
CREATE TABLE IF NOT EXISTS site_daily_counts (
  day        TEXT NOT NULL,               -- UTC YYYY-MM-DD
  kind       TEXT NOT NULL,               -- pageview | download_click | register_ok | login_ok
  dim        TEXT NOT NULL,               -- path | locale | referrer_host | utm | src | _
  dim_value  TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, dim, dim_value)
);
CREATE INDEX IF NOT EXISTS idx_site_daily_counts_day ON site_daily_counts(day);
`;
