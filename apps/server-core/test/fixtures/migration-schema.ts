// The migration suite's shared vocabulary: the de-facto table registry, the
// legacy `users` DDL fixture, and the four schema-reading helpers.
//
// WHY THIS FILE EXISTS. All of it was module-private inside
// `test/migration-idempotency.test.ts` from that file's first line until
// 2026-08-27, when NR-1's `users.google_sub` step took that file past the
// 1200-line cap and its own test had to move out. Both halves still need the
// same registry and the same helpers — and a SECOND copy of `TABLES` would be
// the worst possible duplication here, because the whole point of that array is
// that it is the ONE place a new table has to be registered. Two copies means a
// new table registered in one of them, and the test that would have caught the
// omission passing in the other.
//
// This is therefore a MOVE, not a multiplication: every declaration below is
// verbatim from that file, comments included, behaviour unchanged.

import type { DatabaseSync } from 'node:sqlite';

// SIX tables since 0.2.27: `transcript_history` was DROPPED (owner architecture ruling
// docs/decisions/2026-07-31-no-cloud-sync-for-phone-pc.md — the server does not
// store transcripts). (05-DATA-MODEL §1 used to still list seven; it was rewritten
// 2026-08-02 and its §1.1 now lists all nine, so the doc and this array agree.)
// EIGHT since Window D1 (docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §3.2/§3.3):
// `paddle_subscriptions` (subscription truth) + `billing_events` (idempotency ledger). Both are ADDITIVE —
// nothing was dropped for them.
// NINE since 0.2.47: `ops_audit_log` (ops-action trail, schema.ts `-- 10.`). Also purely
// additive — one CREATE TABLE IF NOT EXISTS, no ALTER, no new reconcileSchema step.
// TEN since card SALT-1 (2026-08-11): `timeline_keymeta` (per-account blind-store
// key metadata, schema.ts `-- 11.`). Purely additive, same shape as ops_audit_log.
// ELEVEN since card GRANT-1 (same batch): `timeline_grants` (web-preview grant
// authorization rows + one index, schema.ts `-- 12.`). Purely additive too.
// TWELVE since card VERIFY-1 (same batch): `email_verifications` (the one active
// verification code per account, schema.ts `-- 13.`) — plus the guarded
// `users.email_verified_at` ADD COLUMN in reconcileSchema, the one ALTER in this
// repo that also BACKFILLS (the grandfather stamp; its own tests below).
// THIRTEEN since card A2-5 / REQ-12-08 (2026-08-12): `usage_events` (one row per
// metered event, schema.ts `-- 14.`) — purely additive, one CREATE plus one
// index, no ALTER and no new reconcileSchema step.
//
// 🔴 THIS ARRAY IS THE DE-FACTO TABLE REGISTRY. 'has exactly the N tables it
// should' below compares it against `sqlite_master`, so a table added to
// INIT_SQL without being appended here turns that test RED — which is the point:
// a new table nobody registered is a new table nobody proves converges.
export const TABLES = [
  'users',
  'pc_devices',
  'mobile_pairings',
  'user_settings',
  'usage_records',
  'usage_events',
  'timeline_blobs',
  'timeline_keymeta',
  'timeline_grants',
  'email_verifications',
  'paddle_subscriptions',
  // 0.3.25 B1 (card D-2) — the tombstone table. NO foreign key by design: it
  // records subscriptions whose owning users row is already gone.
  'paddle_subscription_tombstones',
  // 0.3.25 B3 — refund records. HAS a foreign key (cascades with the account),
  // unlike the tombstone above; the two sit together so the contrast is visible.
  'refund_requests',
  // 2026-08-29 — one-time (non-subscription) purchases, i.e. the paid service.
  // NO foreign key, like the tombstone above and for a related reason: money
  // received is a commercial record that must outlive the account it was
  // received from. Its `user_id` is nullable for the same reason billing_events'
  // is — a paid order we could not attribute must still be written down.
  'one_time_purchases',
  'billing_events',
  'ops_audit_log',
  'site_daily_counts',
  // 2026-09-06 card PR-2: the recovery domain's two tables (db/schema-recovery.ts).
  // FIFTEEN/SIXTEEN. Purely additive — two CREATEs plus two indexes, no ALTER and
  // no new reconcileSchema step. BOTH carry `REFERENCES users(id) ON DELETE
  // CASCADE` (db/schema-recovery.ts:99 and :134), i.e. they are the OPPOSITE of
  // the tombstone above: a deleted account takes its dedupe markers with it,
  // which is what a seven-day marker keyed on a user id should do.
  // ⚠️ This comment said 「NEITHER has a foreign key」 and argued it from a
  // standalone sidecar admitting identities with no users row. The DDL never
  // said that, and the argument survived here only because nothing in this file
  // reads the constraint — the list below is table NAMES. Corrected 2026-09-06
  // (audit F4).
  'recovery_operations',
  'usage_effects',
];

/** The `users` DDL exactly as it stood BEFORE Window D1 (0.2.36) — no
 *  `permanent_free`, and no billing tables anywhere in the file. Kept as a
 *  fixture so the guarded ADD COLUMN can be tested against a database that
 *  really predates the column, which is the only kind of database it ever runs
 *  against in production. */
export const LEGACY_USERS_PRE_D1 = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE,
  password_hash   TEXT,
  display_name    TEXT NOT NULL DEFAULT 'User',
  plan            TEXT NOT NULL DEFAULT 'free',
  locale          TEXT NOT NULL DEFAULT 'zh-CN',
  is_admin        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

export function columnInfo(db: DatabaseSync, table: string, column: string): ColumnInfo | undefined {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[]).find((c) => c.name === column);
}

/** Names of every table AND index currently in the DB. */
export function masterNames(db: DatabaseSync, type: 'table' | 'index'): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

export function schemaSnapshot(db: DatabaseSync): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const t of TABLES) {
    snap[`table:${t}`] = db.prepare(`PRAGMA table_info(${t})`).all();
    snap[`index:${t}`] = db.prepare(`PRAGMA index_list(${t})`).all();
  }
  snap.master = db
    .prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all();
  return snap;
}
