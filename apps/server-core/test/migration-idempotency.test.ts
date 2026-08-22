// Migration idempotency (acceptance): running the migration twice must leave
// the schema byte-identical and preserve data. This is the "run twice, no difference"
// guard (05 §1 additive-only discipline; 13-LESSONS §3 D1 version-bump-without-
// writer class of bug).

import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reconcileSchema } from '../src/db/connection';
import { INIT_SQL } from '../src/db/schema';

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
const TABLES = [
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
  'billing_events',
  'ops_audit_log',
  'site_daily_counts',
];

/** The 0.2.26 `transcript_history` DDL, verbatim, so the drop can be tested
 *  against a database that really predates the retirement. Kept ONLY as this
 *  fixture — production has no CREATE for it any more. */
const LEGACY_TRANSCRIPT_HISTORY = /* sql */ `
CREATE TABLE IF NOT EXISTS transcript_history (
  id              TEXT PRIMARY KEY,
  pairing_id      TEXT REFERENCES mobile_pairings(id) ON DELETE SET NULL,
  pc_device_id    TEXT NOT NULL REFERENCES pc_devices(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mobile_id       TEXT,
  mode            TEXT NOT NULL,
  source_text     TEXT,
  source_lang     TEXT,
  output_text     TEXT NOT NULL,
  output_lang     TEXT,
  duration_ms     INTEGER,
  segments_count  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  edited          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  entry_type      TEXT NOT NULL DEFAULT 'transcript',
  origin          TEXT NOT NULL DEFAULT 'paired',
  attachment_ref  TEXT,
  device_label    TEXT,
  processed_text  TEXT,
  process_mode    TEXT,
  process_params  TEXT,
  inject_target   TEXT,
  thumb_b64       TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcript_user_time ON transcript_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_pc_time ON transcript_history(pc_device_id, created_at DESC);
`;

/** The `users` DDL exactly as it stood BEFORE Window D1 (0.2.36) — no
 *  `permanent_free`, and no billing tables anywhere in the file. Kept as a
 *  fixture so the guarded ADD COLUMN can be tested against a database that
 *  really predates the column, which is the only kind of database it ever runs
 *  against in production. */
const LEGACY_USERS_PRE_D1 = /* sql */ `
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

/** `billing_events` as it stood in D1's FIRST draft — before §3.3-bis added the
 *  redelivery tally. Kept as a fixture because the guarded ADD COLUMN for those
 *  two columns has to be provable against a table that really lacks them, and a
 *  database in that shape exists the moment D1 ships in more than one round. */
const LEGACY_BILLING_EVENTS_PRE_BIS = /* sql */ `
CREATE TABLE IF NOT EXISTS billing_events (
  event_id        TEXT PRIMARY KEY,
  notification_id TEXT,
  event_type      TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  subscription_id TEXT,
  user_id         TEXT,
  outcome         TEXT NOT NULL,
  detail          TEXT
);
`;

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columnInfo(db: DatabaseSync, table: string, column: string): ColumnInfo | undefined {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[]).find((c) => c.name === column);
}

/** Names of every table AND index currently in the DB. */
function masterNames(db: DatabaseSync, type: 'table' | 'index'): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='${type}' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function schemaSnapshot(db: DatabaseSync): Record<string, unknown> {
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

const tmp = mkdtempSync(join(tmpdir(), 'flowmic-mig-'));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('migration idempotency', () => {
  it('re-running INIT_SQL + reconcileSchema on one connection is a no-op', () => {
    const db = openDatabase(':memory:');
    const first = schemaSnapshot(db);
    // Second pass — exactly what a restart would run.
    db.exec(INIT_SQL);
    reconcileSchema(db);
    reconcileSchema(db); // third, for good measure
    const second = schemaSnapshot(db);
    expect(second).toEqual(first);
    db.close();
  });

  it('re-opening a persisted DB preserves data and schema', () => {
    const dbPath = join(tmp, 'idempotency.db');
    const a = openDatabase(dbPath);
    a.exec("INSERT INTO users (id, display_name, plan) VALUES ('u1', 'X', 'free')");
    const snapA = schemaSnapshot(a);
    a.close();

    const b = openDatabase(dbPath); // migration runs again on the existing file
    const snapB = schemaSnapshot(b);
    const user = b.prepare("SELECT id, plan FROM users WHERE id='u1'").get() as { id: string; plan: string };
    expect(snapB).toEqual(snapA);
    expect(user).toEqual({ id: 'u1', plan: 'free' });
    b.close();
  });

  // ── 0.2.27 destructive migration (DB-SENSITIVE — human review) ────────────────────
  //
  // The two tests that stood here asserted `transcript_history`'s `edited` column
  // and its pc_device_id index. Both are gone with the table; what replaces them
  // is the only question that now matters — does an EXISTING database actually
  // lose the table, its indexes and its rows, and does the drop survive a restart.
  it('DROPS transcript_history (+ its two indexes and its rows) from a pre-0.2.27 DB, idempotently', () => {
    const dbPath = join(tmp, 'drop-transcripts.db');
    // ── build a database that really predates the retirement ──
    const legacy = openDatabase(dbPath);
    legacy.exec(LEGACY_TRANSCRIPT_HISTORY);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-keep', 'Keeper', 'free')");
    legacy.exec(
      `INSERT INTO pc_devices (id, user_id, device_name, device_token, room_uuid, short_code)
       VALUES ('pc-keep', 'u-keep', 'PC', 'tok-keep', 'room-keep', '1234')`,
    );
    legacy.exec(
      `INSERT INTO transcript_history
         (id, pc_device_id, user_id, mode, output_text, status, created_at, updated_at)
       VALUES ('h-doomed', 'pc-keep', 'u-keep', 'realtime', 'said out loud', 'injected',
               '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')`,
    );
    expect(masterNames(legacy, 'table')).toContain('transcript_history');
    expect(masterNames(legacy, 'index')).toEqual(expect.arrayContaining(['idx_transcript_user_time', 'idx_transcript_pc_time']));
    legacy.close();

    // ── the migration: exactly what a deploy + restart runs ──
    const migrated = openDatabase(dbPath);
    expect(masterNames(migrated, 'table')).not.toContain('transcript_history');
    expect(masterNames(migrated, 'index')).not.toContain('idx_transcript_user_time');
    expect(masterNames(migrated, 'index')).not.toContain('idx_transcript_pc_time');
    // The rows are really gone, not merely unreachable through a repo.
    expect(() => migrated.prepare('SELECT COUNT(*) AS n FROM transcript_history').get()).toThrow();
    // Nothing ELSE was collateral: this DROP hits a CHILD table, so its parents
    // and their rows must be untouched (FKs are ON — see openDatabase).
    expect(new Set(masterNames(migrated, 'table'))).toEqual(new Set(TABLES));
    expect(migrated.prepare("SELECT id FROM users WHERE id='u-keep'").get()).toEqual({ id: 'u-keep' });
    expect(migrated.prepare("SELECT id FROM pc_devices WHERE id='pc-keep'").get()).toEqual({ id: 'pc-keep' });
    // Idempotent: the second and third boot must not throw on a table that is
    // already gone (DROP ... IF EXISTS), and must change nothing.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    // …and a genuine restart (fresh connection) is likewise inert.
    const restarted = openDatabase(dbPath);
    expect(new Set(masterNames(restarted, 'table'))).toEqual(new Set(TABLES));
    restarted.close();
  });

  it('a FRESH database never creates transcript_history in the first place', () => {
    const db = openDatabase(':memory:');
    expect(masterNames(db, 'table')).not.toContain('transcript_history');
    db.close();
  });

  // ── Window D1 additive migration (DB-SENSITIVE — human review) ──────────────────────
  //
  // Everything below is ADDITIVE: one INTEGER column on `users`, two new tables.
  // Nothing is dropped, so the only questions that matter are ① does a database
  // that predates the change really get them, ② does the forward-ported column
  // look identical to the one a fresh CREATE makes, and ③ is "not exempt" what
  // an account that predates the flag reads as.
  it('ALTERs permanent_free onto a pre-D1 DB, defaulting existing accounts to NOT exempt', () => {
    const dbPath = join(tmp, 'add-permanent-free.db');
    // ── a database that really predates the column ──
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-old', 'Before D1', 'free')");
    expect(columnInfo(legacy, 'users', 'permanent_free')).toBeUndefined();
    legacy.close();

    // ── the migration: exactly what a deploy + restart runs ──
    const migrated = openDatabase(dbPath);
    const col = columnInfo(migrated, 'users', 'permanent_free');
    // INTEGER, not TEXT: a TEXT '0' is TRUTHY in JS, i.e. every un-marked
    // account would read as permanently exempt. This assertion is the guard.
    expect(col).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    // …and the pre-existing row was backfilled with 0, not left NULL.
    expect(migrated.prepare("SELECT permanent_free FROM users WHERE id='u-old'").get()).toEqual({ permanent_free: 0 });

    // The forward-ported column must be INDISTINGUISHABLE from the one a fresh
    // CREATE produces — otherwise the two kinds of database diverge silently
    // (only cid/order will differ; that is inevitable for ALTER and has nothing to do with column semantics).
    const fresh = openDatabase(':memory:');
    const freshCol = columnInfo(fresh, 'users', 'permanent_free');
    expect(freshCol).toBeDefined();
    const { name, type, notnull, dflt_value } = col!;
    expect({ name, type, notnull, dflt_value }).toEqual({
      name: freshCol!.name,
      type: freshCol!.type,
      notnull: freshCol!.notnull,
      dflt_value: freshCol!.dflt_value,
    });
    fresh.close();

    // Idempotent: the second and third boot must not try to add it again.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    const restarted = openDatabase(dbPath);
    expect(columnInfo(restarted, 'users', 'permanent_free')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    restarted.close();
  });

  it('creates the two billing tables (+ their indexes) on a pre-D1 DB', () => {
    const dbPath = join(tmp, 'add-billing-tables.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    expect(masterNames(legacy, 'table')).not.toContain('paddle_subscriptions');
    expect(masterNames(legacy, 'table')).not.toContain('billing_events');
    legacy.close();

    const migrated = openDatabase(dbPath);
    expect(masterNames(migrated, 'table')).toEqual(expect.arrayContaining(['paddle_subscriptions', 'billing_events']));
    expect(masterNames(migrated, 'index')).toEqual(
      expect.arrayContaining(['idx_paddle_subs_user', 'idx_billing_events_user']),
    );
    // Dedup key = event_id, and it must really be the PRIMARY KEY — the whole
    // idempotency story rests on the second INSERT of the same event_id being
    // rejected by the DB rather than by a hopeful SELECT (D1 §3.3).
    const pk = (migrated.prepare('PRAGMA table_info(billing_events)').all() as unknown as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pk).toEqual(['event_id']);
    migrated.close();
  });

  it('ALTERs the §3.3-bis redelivery columns onto a pre-bis billing_events, 0 / NULL', () => {
    const dbPath = join(tmp, 'add-redelivery-columns.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec(LEGACY_BILLING_EVENTS_PRE_BIS);
    legacy.exec(
      `INSERT INTO billing_events (event_id, notification_id, event_type, occurred_at, received_at, outcome)
       VALUES ('evt_old', 'ntf_old', 'subscription.activated',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z', 'applied')`,
    );
    expect(columnInfo(legacy, 'billing_events', 'redelivery_count')).toBeUndefined();
    expect(columnInfo(legacy, 'billing_events', 'last_notification_id')).toBeUndefined();
    legacy.close();

    const migrated = openDatabase(dbPath);
    // INTEGER for the counter (it rides ADDITIVE_INT_COLUMNS), TEXT+nullable for
    // the id (ADDITIVE_TEXT_COLUMNS). A counter arriving as TEXT would make the
    // '0' truthy and the increment string-concatenate.
    expect(columnInfo(migrated, 'billing_events', 'redelivery_count')).toMatchObject({
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
    });
    expect(columnInfo(migrated, 'billing_events', 'last_notification_id')).toMatchObject({ type: 'TEXT', notnull: 0 });
    // The pre-existing ledger row: counter backfilled to 0 (what we can honestly
    // say we counted), last id left NULL (we do not know it, so we do not invent it).
    expect(
      migrated.prepare("SELECT redelivery_count, last_notification_id FROM billing_events WHERE event_id='evt_old'").get(),
    ).toEqual({ redelivery_count: 0, last_notification_id: null });
    // Its original data survived the two ALTERs untouched.
    expect(migrated.prepare("SELECT outcome, notification_id FROM billing_events WHERE event_id='evt_old'").get()).toEqual({
      outcome: 'applied',
      notification_id: 'ntf_old',
    });

    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();
  });

  // ── 0.2.47 additive migration: ops_audit_log (DB-SENSITIVE — human review) ────────
  //
  // Purely additive (one CREATE TABLE IF NOT EXISTS + two indexes, no ALTER), so
  // the questions are the same three as D1's: ① does a database that predates it
  // really get the table, ② is the shape the one the DDL argues for, ③ is a
  // re-run inert.
  it('creates ops_audit_log (+ its two indexes) on a pre-0.2.47 DB, idempotently', () => {
    const dbPath = join(tmp, 'add-ops-audit.db');
    // A database that really predates the table: pre-D1 `users` and nothing else.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-audit', 'Before', 'free')");
    expect(masterNames(legacy, 'table')).not.toContain('ops_audit_log');
    legacy.close();

    // The migration: exactly what a deploy + restart runs.
    const migrated = openDatabase(dbPath);
    expect(masterNames(migrated, 'table')).toContain('ops_audit_log');
    expect(masterNames(migrated, 'index')).toEqual(
      expect.arrayContaining(['idx_ops_audit_created', 'idx_ops_audit_actor']),
    );
    // The pre-existing row is untouched — this migration adds, it does not touch
    // anyone else's data.
    expect(migrated.prepare("SELECT id FROM users WHERE id='u-pre-audit'").get()).toEqual({ id: 'u-pre-audit' });

    // ① The key is the INTEGER rowid alias, not a TEXT id. The DDL's whole
    // ordering argument (「A happened before B」 has an exact answer / numbers are never reused) rests on it, and a
    // TEXT primary key would keep every assertion in ops-audit-repo.test.ts green
    // while quietly making same-millisecond ordering a coin flip again.
    const pk = (migrated.prepare('PRAGMA table_info(ops_audit_log)').all() as unknown as { name: string; pk: number; type: string }[])
      .filter((c) => c.pk > 0);
    expect(pk.map((c) => c.name)).toEqual(['id']);
    expect(pk[0]!.type).toBe('INTEGER');
    // …and AUTOINCREMENT is really on it (that is the 「numbers are never reused」 half, and it is
    // invisible to PRAGMA table_info — only the stored DDL says so).
    const ddl = (migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ops_audit_log'").get() as {
      sql: string;
    }).sql;
    expect(ddl).toContain('AUTOINCREMENT');

    // ② actor_user_id is NOT NULL — 「an ops action has no anonymous tier」 is a DB constraint,
    // not a comment. The reverse control: the INSERT really is refused.
    expect(columnInfo(migrated, 'ops_audit_log', 'actor_user_id')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(() =>
      migrated.exec("INSERT INTO ops_audit_log (action, created_at) VALUES ('x.y.z', '2026-08-02T00:00:00.000Z')"),
    ).toThrow();

    // ③ NO foreign key on actor_user_id — an ON DELETE CASCADE would let deleting
    // an account erase the record of what it did. FKs are ON (openDatabase), so a
    // row naming a user that does not exist must still land. This is the assertion
    // that fails the day somebody "fixes" the missing REFERENCES.
    expect(migrated.prepare('PRAGMA foreign_key_list(ops_audit_log)').all()).toEqual([]);
    migrated.exec(
      `INSERT INTO ops_audit_log (actor_user_id, action, created_at)
       VALUES ('u-does-not-exist', 'test.orphan.write', '2026-08-02T00:00:00.000Z')`,
    );
    expect(migrated.prepare("SELECT COUNT(*) AS n FROM ops_audit_log WHERE actor_user_id='u-does-not-exist'").get()).toEqual({
      n: 1,
    });

    // Idempotent: second and third boot change nothing and keep the row.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    // …and a genuine restart converges on the same shape, with the data intact.
    const restarted = openDatabase(dbPath);
    expect(schemaSnapshot(restarted)).toEqual(after);
    expect(restarted.prepare('SELECT COUNT(*) AS n FROM ops_audit_log').get()).toEqual({ n: 1 });
    restarted.close();
  });

  // ── SALT-1 additive migration: timeline_keymeta (DB-SENSITIVE — human review) ─────
  //
  // Purely additive (one CREATE TABLE IF NOT EXISTS, no index, no ALTER, no new
  // reconcileSchema step), so the questions are ops_audit_log's three: ① does a
  // database that predates it really get the table, ② is the shape the one the
  // DDL argues for (user_id PK, FK CASCADE to users, NOT NULL columns,
  // schema_ver defaulting to 1), ③ is a re-run inert.
  it('creates timeline_keymeta on a pre-SALT-1 DB, idempotently', () => {
    const dbPath = join(tmp, 'add-timeline-keymeta.db');
    // A database that really predates the table.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-keymeta', 'Before', 'free')");
    expect(masterNames(legacy, 'table')).not.toContain('timeline_keymeta');
    legacy.close();

    // The migration: exactly what a deploy + restart runs.
    const migrated = openDatabase(dbPath);
    expect(masterNames(migrated, 'table')).toContain('timeline_keymeta');
    // The pre-existing row is untouched — this migration adds, nothing else.
    expect(migrated.prepare("SELECT id FROM users WHERE id='u-pre-keymeta'").get()).toEqual({ id: 'u-pre-keymeta' });

    // ① PK is user_id — one row per account is the whole first-writer-wins story.
    const pk = (migrated.prepare('PRAGMA table_info(timeline_keymeta)').all() as unknown as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pk).toEqual(['user_id']);
    // ② the load-bearing column shapes: NOT NULL everywhere, schema_ver
    // defaulting to '1' (the DDL's DEFAULT is the single answer to what a fresh
    // row gets — the repo deliberately does not restate it), created_at INTEGER
    // (design §3.1 says INT — ms epoch, not this file's usual TEXT).
    expect(columnInfo(migrated, 'timeline_keymeta', 'salt_b64')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(columnInfo(migrated, 'timeline_keymeta', 'sentinel')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(columnInfo(migrated, 'timeline_keymeta', 'schema_ver')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '1' });
    expect(columnInfo(migrated, 'timeline_keymeta', 'created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    // ③ FK CASCADE to users — account deletion (0.3.0 P4) relies on the FK
    // graph being THE answer to 「which tables does account deletion wipe」; key metadata outliving its
    // account would be exactly what a hand-written delete list forgets.
    const fks = migrated.prepare('PRAGMA foreign_key_list(timeline_keymeta)').all() as unknown as {
      table: string; from: string; on_delete: string;
    }[];
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ table: 'users', from: 'user_id', on_delete: 'CASCADE' });
    // …and the cascade really fires (FKs are ON — openDatabase).
    migrated.exec(
      "INSERT INTO timeline_keymeta (user_id, salt_b64, sentinel, created_at) VALUES ('u-pre-keymeta', 'c2FsdA==', 'e2e:v1:x', 1)",
    );
    migrated.exec("DELETE FROM users WHERE id='u-pre-keymeta'");
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM timeline_keymeta').get()).toEqual({ n: 0 });

    // Idempotent: second and third boot change nothing.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    // …and a genuine restart converges on the same shape.
    const restarted = openDatabase(dbPath);
    expect(schemaSnapshot(restarted)).toEqual(after);
    restarted.close();
  });

  // ── GRANT-1 additive migration: timeline_grants (DB-SENSITIVE — human review) ─────
  //
  // Purely additive (one CREATE TABLE IF NOT EXISTS + one index, no ALTER, no
  // new reconcileSchema step) — the same three questions as SALT-1's block:
  // ① does a pre-GRANT-1 database really get the table, ② is the shape the one
  // the DDL argues for (gid PK, FK CASCADE to users, revoked INTEGER NOT NULL
  // DEFAULT 0 — never TEXT), ③ is a re-run inert.
  it('creates timeline_grants (+ its index) on a pre-GRANT-1 DB, idempotently', () => {
    const dbPath = join(tmp, 'add-timeline-grants.db');
    // A database that really predates the table.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-grants', 'Before', 'free')");
    expect(masterNames(legacy, 'table')).not.toContain('timeline_grants');
    legacy.close();

    // The migration: exactly what a deploy + restart runs.
    const migrated = openDatabase(dbPath);
    expect(masterNames(migrated, 'table')).toContain('timeline_grants');
    expect(masterNames(migrated, 'index')).toContain('idx_timeline_grants_user');
    // The pre-existing row is untouched — this migration adds, nothing else.
    expect(migrated.prepare("SELECT id FROM users WHERE id='u-pre-grants'").get()).toEqual({ id: 'u-pre-grants' });

    // ① PK is gid — one row per authorization, never one per account (an
    // account accumulates superseded rows on purpose).
    const pk = (migrated.prepare('PRAGMA table_info(timeline_grants)').all() as unknown as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pk).toEqual(['gid']);
    // ② load-bearing column shapes. `revoked` INTEGER is the guard the DDL
    // argues for: a TEXT '0' is truthy in JS, i.e. every live grant would read
    // as revoked's opposite on exactly the databases with real users on them.
    expect(columnInfo(migrated, 'timeline_grants', 'origin')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(columnInfo(migrated, 'timeline_grants', 'expires_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(columnInfo(migrated, 'timeline_grants', 'created_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(columnInfo(migrated, 'timeline_grants', 'revoked')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    // …and there is NO column that could hold the wrap — the blind relay must
    // not be one ALTER away from key escrow without this census noticing.
    const cols = (migrated.prepare('PRAGMA table_info(timeline_grants)').all() as unknown as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(['created_at', 'expires_at', 'gid', 'origin', 'revoked', 'user_id']);
    // ③ FK CASCADE to users — the delete census (account-lifecycle.ts
    // USER_CASCADING_TABLES) relies on the FK graph being THE answer.
    const fks = migrated.prepare('PRAGMA foreign_key_list(timeline_grants)').all() as unknown as {
      table: string; from: string; on_delete: string;
    }[];
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ table: 'users', from: 'user_id', on_delete: 'CASCADE' });
    // …and the cascade really fires (FKs are ON — openDatabase).
    migrated.exec(
      "INSERT INTO timeline_grants (gid, user_id, origin, expires_at, created_at) VALUES ('g1', 'u-pre-grants', 'https://x', 2, 1)",
    );
    migrated.exec("DELETE FROM users WHERE id='u-pre-grants'");
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM timeline_grants').get()).toEqual({ n: 0 });

    // Idempotent: second and third boot change nothing.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    // …and a genuine restart converges on the same shape.
    const restarted = openDatabase(dbPath);
    expect(schemaSnapshot(restarted)).toEqual(after);
    restarted.close();
  });

  // ── VERIFY-1 migration: users.email_verified_at + email_verifications ─────
  // (DB-SENSITIVE — human review)
  //
  // The column step is THE one ALTER in this repo that also BACKFILLS, so on
  // top of the usual three questions (does a pre-VERIFY-1 DB get it / does it
  // converge / is a re-run inert) there are two of its own:
  // ① GRANDFATHER — a row that predates the gate gets a non-NULL stamp (the
  //   alternative locks every existing user, owner included, behind a mail
  //   channel production has not configured — schema.ts's DDL comment);
  // ② BACKFILL RUNS ONCE — a row registered AFTER the migration stays NULL
  //   through any number of reconcile re-runs, because the UPDATE lives inside
  //   the column-was-missing guard. A backfill outside the guard would
  //   silently verify every future registration at the next reboot, i.e. turn
  //   the whole gate off — this is the assertion that catches that.
  it('ALTERs email_verified_at onto a pre-VERIFY-1 DB, grandfathering EXISTING rows only', () => {
    const dbPath = join(tmp, 'add-email-verified-at.db');
    // A database that really predates the column, with an account in it.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-gate', 'Before the gate', 'free')");
    expect(columnInfo(legacy, 'users', 'email_verified_at')).toBeUndefined();
    legacy.close();

    // The migration: exactly what a deploy + restart runs.
    const migrated = openDatabase(dbPath);
    // Nullable INTEGER (NULL = unverified) — NOT the additive-int shape
    // (NOT NULL DEFAULT 0): a 0 here would be a timestamp claim, and the
    // honest 「gate closed」 value is the absence of one.
    expect(columnInfo(migrated, 'users', 'email_verified_at')).toMatchObject({
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
    });
    // ① the pre-existing account is GRANDFATHERED: stamped non-NULL.
    const stamped = migrated
      .prepare("SELECT email_verified_at FROM users WHERE id='u-pre-gate'")
      .get() as { email_verified_at: number | null };
    expect(typeof stamped.email_verified_at).toBe('number');

    // ② a row registered AFTER the migration stays NULL…
    migrated.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-post-gate', 'After the gate', 'free')");
    const freshRow = (): unknown =>
      migrated.prepare("SELECT email_verified_at FROM users WHERE id='u-post-gate'").get();
    expect(freshRow()).toEqual({ email_verified_at: null });
    // …through the exact statements a reboot runs, run twice more.
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(freshRow()).toEqual({ email_verified_at: null }); // the backfill ran ONCE
    // …and the grandfather stamp did not move either.
    expect(
      migrated.prepare("SELECT email_verified_at FROM users WHERE id='u-pre-gate'").get(),
    ).toEqual(stamped);

    // The forward-ported column is INDISTINGUISHABLE from a fresh CREATE's
    // (same convergence contract as permanent_free above; only cid/order may
    // differ, which is inherent to ALTER).
    const fresh = openDatabase(':memory:');
    const freshCol = columnInfo(fresh, 'users', 'email_verified_at');
    const col = columnInfo(migrated, 'users', 'email_verified_at')!;
    expect({ name: col.name, type: col.type, notnull: col.notnull, dflt_value: col.dflt_value }).toEqual({
      name: freshCol!.name,
      type: freshCol!.type,
      notnull: freshCol!.notnull,
      dflt_value: freshCol!.dflt_value,
    });
    // …and a FRESH database backfills NOTHING: a first registration on a new
    // deployment starts unverified (the guard saw the column present and
    // skipped — CREATE made it, no legacy rows existed to grandfather).
    fresh.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-fresh', 'Fresh DB', 'free')");
    expect(fresh.prepare("SELECT email_verified_at FROM users WHERE id='u-fresh'").get()).toEqual({
      email_verified_at: null,
    });
    fresh.close();

    // Idempotent overall: two more boots change nothing.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();
  });

  // ── A2-3 migration: users.restricted_at (DB-SENSITIVE — human review) ──────────────
  //
  // The SECOND hand-written `users` column step, and the questions are the
  // email_verified_at block's inverted:
  // ① SHAPE — nullable INTEGER, NOT the additive-int `NOT NULL DEFAULT 0`. 0 is
  //   a legal ms-epoch, so that shape would forward-port every existing account
  //   as 「restricted since 1970-01-01」;
  // ② 🔴 NO BACKFILL — the neighbouring step stamps every legacy row on purpose;
  //   this one must stamp NONE, because any non-NULL value here restricts the
  //   whole platform in one migration. The two steps sit next to each other and
  //   look alike, which is exactly why this is asserted rather than trusted;
  // ③ convergence + idempotency, as for every other column here.
  it('🔴 ALTERs restricted_at onto a pre-A2-3 DB and backfills NOTHING (the inverse of the gate stamp beside it)', () => {
    const dbPath = join(tmp, 'add-restricted-at.db');
    // A database that really predates the column, with an account in it.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-restrict', 'Before A2-3', 'free')");
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-restrict-2', 'Also before', 'free')");
    expect(columnInfo(legacy, 'users', 'restricted_at')).toBeUndefined();
    legacy.close();

    // The migration: exactly what a deploy + restart runs.
    const migrated = openDatabase(dbPath);
    // ① Nullable INTEGER (NULL = not restricted). `notnull: 0` and a null
    // default are the assertion — the additive-int shape would read
    // `{notnull: 1, dflt_value: '0'}` here and every account would be
    // restricted at the epoch.
    expect(columnInfo(migrated, 'users', 'restricted_at')).toMatchObject({
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
    });
    // ② 🔴 THE ONE THAT MATTERS: every pre-existing row is still NULL. This is
    // the assertion that fails if somebody 「makes it consistent」 with the
    // email_verified_at step three lines above it in reconcileSchema.
    const rows = migrated.prepare('SELECT id, restricted_at FROM users ORDER BY id').all() as {
      id: string; restricted_at: number | null;
    }[];
    expect(rows).toEqual([
      { id: 'u-pre-restrict', restricted_at: null },
      { id: 'u-pre-restrict-2', restricted_at: null },
    ]);
    // …and the grandfather stamp on the NEIGHBOURING column really did run, so
    // this is not a green produced by a reconcile that did nothing at all
    // (the positive control for the negative assertion above).
    const stamped = migrated
      .prepare("SELECT email_verified_at FROM users WHERE id='u-pre-restrict'")
      .get() as { email_verified_at: number | null };
    expect(typeof stamped.email_verified_at, 'reconcile did not run — the NULL above proves nothing').toBe('number');

    // A row inserted AFTER the migration is NULL too, through any number of
    // reboots (there is no UPDATE inside the guard to run a second time, but a
    // future one added outside it would be caught here).
    migrated.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-post-restrict', 'After', 'free')");
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(migrated.prepare("SELECT restricted_at FROM users WHERE id='u-post-restrict'").get()).toEqual({
      restricted_at: null,
    });
    expect(migrated.prepare("SELECT restricted_at FROM users WHERE id='u-pre-restrict'").get()).toEqual({
      restricted_at: null,
    });

    // ③ The forward-ported column is INDISTINGUISHABLE from a fresh CREATE's.
    const fresh = openDatabase(':memory:');
    const freshCol = columnInfo(fresh, 'users', 'restricted_at');
    const col = columnInfo(migrated, 'users', 'restricted_at')!;
    expect({ name: col.name, type: col.type, notnull: col.notnull, dflt_value: col.dflt_value }).toEqual({
      name: freshCol!.name,
      type: freshCol!.type,
      notnull: freshCol!.notnull,
      dflt_value: freshCol!.dflt_value,
    });
    // …and a FRESH database starts every account unrestricted.
    fresh.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-fresh-r', 'Fresh', 'free')");
    expect(fresh.prepare("SELECT restricted_at FROM users WHERE id='u-fresh-r'").get()).toEqual({ restricted_at: null });
    fresh.close();

    // Idempotent overall.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    const restarted = openDatabase(dbPath);
    expect(schemaSnapshot(restarted)).toEqual(after);
    restarted.close();
  });

  // ── LOGIN-1 migration: users.last_login_at (DB-SENSITIVE — collection surface) ────
  //
  // The THIRD hand-written `users` column step, sitting between two that look
  // exactly like it and behave in two different ways. Same three questions:
  // ① SHAPE — nullable INTEGER, NOT the additive-int `NOT NULL DEFAULT 0`, for
  //   `restricted_at`'s reason: 0 is a legal ms-epoch, so that shape would
  //   forward-port every existing account as 「last signed in 1970-01-01」;
  // ② 🔴 NO BACKFILL — and for a reason neither neighbour has.
  //   `email_verified_at` MUST backfill (otherwise the gate locks everyone out);
  //   `restricted_at` MUST NOT (any value restricts the platform); this one must
  //   not because THE ANSWER IS NOT KNOWABLE — nothing on disk records when
  //   anybody last signed in, which is the entire premise of the card. Any stamp
  //   would be manufactured evidence about a person on the screen where an
  //   operator decides whether to restrict them;
  // ③ convergence + idempotency, as for every other column here.
  //
  // 🔴 AND THE MIGRATION IS UNCONDITIONAL — it must NOT consult
  // `FLOWMIC_LOGIN_RECORD_ENABLED`. A schema that appears only when a switch is
  // on differs between two machines running the same build, and flipping the
  // switch would then be a migration. Asserted below by running the whole thing
  // with the env var explicitly absent AND explicitly set, and requiring the
  // same column both times.
  it('🔴 ALTERs last_login_at onto a pre-LOGIN-1 DB, backfills NOTHING, and does not consult the collection switch', () => {
    const dbPath = join(tmp, 'add-last-login-at.db');
    // A database that really predates the column, with accounts in it.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-login', 'Before LOGIN-1', 'free')");
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-login-2', 'Also before', 'free')");
    expect(columnInfo(legacy, 'users', 'last_login_at')).toBeUndefined();
    legacy.close();

    // The migration: exactly what a deploy + restart runs.
    const migrated = openDatabase(dbPath);
    // ① Nullable INTEGER. `notnull: 0` + null default IS the assertion — the
    // additive-int shape would read `{notnull: 1, dflt_value: '0'}` and every
    // account would claim a 1970 sign-in.
    expect(columnInfo(migrated, 'users', 'last_login_at')).toMatchObject({
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
    });
    // ② 🔴 THE ONE THAT MATTERS: every pre-existing row is still NULL. This is
    // what fails if somebody 「makes it consistent」 with the email_verified_at
    // step a few lines above it in reconcileSchema.
    expect(migrated.prepare('SELECT id, last_login_at FROM users ORDER BY id').all()).toEqual([
      { id: 'u-pre-login', last_login_at: null },
      { id: 'u-pre-login-2', last_login_at: null },
    ]);
    // …with the SAME positive control the restricted_at block uses: the
    // neighbouring grandfather stamp really did run, so the NULLs above are
    // evidence about this step rather than about a reconcile that did nothing.
    const stamped = migrated
      .prepare("SELECT email_verified_at FROM users WHERE id='u-pre-login'")
      .get() as { email_verified_at: number | null };
    expect(typeof stamped.email_verified_at, 'reconcile did not run — the NULLs above prove nothing').toBe('number');

    // A row inserted AFTER the migration is NULL too, through any number of
    // reboots (there is no UPDATE in the guard today; one added outside it later
    // would be caught here).
    migrated.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-post-login', 'After', 'free')");
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(migrated.prepare("SELECT last_login_at FROM users WHERE id='u-post-login'").get()).toEqual({
      last_login_at: null,
    });
    expect(migrated.prepare("SELECT last_login_at FROM users WHERE id='u-pre-login'").get()).toEqual({
      last_login_at: null,
    });

    // 🔴 A REAL STAMP SURVIVES A RESTART — otherwise every NULL assertion above
    // could be produced by a column nothing can write, and the whole block would
    // be green on a broken feature.
    migrated.exec("UPDATE users SET last_login_at=1765432109876 WHERE id='u-post-login'");
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    expect(migrated.prepare("SELECT last_login_at FROM users WHERE id='u-post-login'").get()).toEqual({
      last_login_at: 1_765_432_109_876,
    });

    // ③ The forward-ported column is INDISTINGUISHABLE from a fresh CREATE's.
    const fresh = openDatabase(':memory:');
    const freshCol = columnInfo(fresh, 'users', 'last_login_at');
    const col = columnInfo(migrated, 'users', 'last_login_at')!;
    expect({ name: col.name, type: col.type, notnull: col.notnull, dflt_value: col.dflt_value }).toEqual({
      name: freshCol!.name,
      type: freshCol!.type,
      notnull: freshCol!.notnull,
      dflt_value: freshCol!.dflt_value,
    });
    // …and a FRESH database starts every account with no recorded sign-in.
    fresh.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-fresh-l', 'Fresh', 'free')");
    expect(fresh.prepare("SELECT last_login_at FROM users WHERE id='u-fresh-l'").get()).toEqual({
      last_login_at: null,
    });
    fresh.close();

    // Idempotent overall.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    const restarted = openDatabase(dbPath);
    expect(schemaSnapshot(restarted)).toEqual(after);
    restarted.close();
  });

  it('🔴 the last_login_at migration is INDEPENDENT of FLOWMIC_LOGIN_RECORD_ENABLED (same schema either way)', () => {
    // The switch gates the WRITE, never the SCHEMA. If the migration ever grew a
    // flag check, two machines running the same build would have different
    // tables and turning collection on would silently become a migration — the
    // failure this asserts against.
    const before = process.env.FLOWMIC_LOGIN_RECORD_ENABLED;
    try {
      delete process.env.FLOWMIC_LOGIN_RECORD_ENABLED;
      const off = openDatabase(join(tmp, 'login-switch-off.db'));
      const offSnap = schemaSnapshot(off);
      off.close();

      process.env.FLOWMIC_LOGIN_RECORD_ENABLED = '1';
      const on = openDatabase(join(tmp, 'login-switch-on.db'));
      expect(columnInfo(on, 'users', 'last_login_at')).toBeDefined();
      expect(schemaSnapshot(on)).toEqual(offSnap);
      on.close();
    } finally {
      if (before === undefined) delete process.env.FLOWMIC_LOGIN_RECORD_ENABLED;
      else process.env.FLOWMIC_LOGIN_RECORD_ENABLED = before;
    }
  });

  it('creates email_verifications on a pre-VERIFY-1 DB, idempotently (PK user_id, FK CASCADE, hash-shaped columns)', () => {
    const dbPath = join(tmp, 'add-email-verifications.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-verif', 'Before', 'free')");
    expect(masterNames(legacy, 'table')).not.toContain('email_verifications');
    legacy.close();

    const migrated = openDatabase(dbPath);
    expect(masterNames(migrated, 'table')).toContain('email_verifications');
    expect(migrated.prepare("SELECT id FROM users WHERE id='u-pre-verif'").get()).toEqual({ id: 'u-pre-verif' });

    // ① PK is user_id — 「one active code per account」 is the schema, not a
    // repo promise: a resend structurally cannot add a second live code.
    const pk = (migrated.prepare('PRAGMA table_info(email_verifications)').all() as unknown as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pk).toEqual(['user_id']);
    // ② load-bearing column shapes: everything NOT NULL except nothing;
    // attempts defaults to 0 (a fresh code has its whole guess budget).
    expect(columnInfo(migrated, 'email_verifications', 'code_hash')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(columnInfo(migrated, 'email_verifications', 'expires_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    expect(columnInfo(migrated, 'email_verifications', 'attempts')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    expect(columnInfo(migrated, 'email_verifications', 'sent_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    // …and there is NO column that could hold the plaintext code — the census
    // that catches a 「store the code for support convenience」 ALTER.
    const cols = (migrated.prepare('PRAGMA table_info(email_verifications)').all() as unknown as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(['attempts', 'code_hash', 'expires_at', 'sent_at', 'user_id']);
    // ③ FK CASCADE to users, and it really fires (FKs are ON — openDatabase):
    // a pending code must die with its account.
    const fks = migrated.prepare('PRAGMA foreign_key_list(email_verifications)').all() as unknown as {
      table: string; from: string; on_delete: string;
    }[];
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ table: 'users', from: 'user_id', on_delete: 'CASCADE' });
    migrated.exec(
      "INSERT INTO email_verifications (user_id, code_hash, expires_at, sent_at) VALUES ('u-pre-verif', 'ab'||'cd', 2, 1)",
    );
    migrated.exec("DELETE FROM users WHERE id='u-pre-verif'");
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM email_verifications').get()).toEqual({ n: 0 });

    // Idempotent: second and third boot change nothing.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    const restarted = openDatabase(dbPath);
    expect(schemaSnapshot(restarted)).toEqual(after);
    restarted.close();
  });

  it('the forward-ported email_verifications is INDISTINGUISHABLE from a fresh one', () => {
    const dbPath = join(tmp, 'email-verifications-converge.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.close();

    const migrated = openDatabase(dbPath);
    const fresh = openDatabase(':memory:');
    const ddlOf = (db: DatabaseSync): unknown =>
      db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name='email_verifications' ORDER BY type, name").all();
    expect(ddlOf(migrated)).toEqual(ddlOf(fresh));
    expect(migrated.prepare('PRAGMA table_info(email_verifications)').all()).toEqual(
      fresh.prepare('PRAGMA table_info(email_verifications)').all(),
    );
    migrated.close();
    fresh.close();
  });

  it('the forward-ported timeline_grants is INDISTINGUISHABLE from a fresh one', () => {
    const dbPath = join(tmp, 'grants-converge.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.close();

    const migrated = openDatabase(dbPath);
    const fresh = openDatabase(':memory:');
    const ddlOf = (db: DatabaseSync): unknown =>
      db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name='timeline_grants' ORDER BY type, name").all();
    expect(ddlOf(migrated)).toEqual(ddlOf(fresh));
    expect(migrated.prepare('PRAGMA table_info(timeline_grants)').all()).toEqual(
      fresh.prepare('PRAGMA table_info(timeline_grants)').all(),
    );
    migrated.close();
    fresh.close();
  });

  it('the forward-ported timeline_keymeta is INDISTINGUISHABLE from a fresh one', () => {
    const dbPath = join(tmp, 'keymeta-converge.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.close();

    const migrated = openDatabase(dbPath);
    const fresh = openDatabase(':memory:');
    const ddlOf = (db: DatabaseSync): unknown =>
      db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name='timeline_keymeta' ORDER BY type, name").all();
    expect(ddlOf(migrated)).toEqual(ddlOf(fresh));
    expect(migrated.prepare('PRAGMA table_info(timeline_keymeta)').all()).toEqual(
      fresh.prepare('PRAGMA table_info(timeline_keymeta)').all(),
    );
    migrated.close();
    fresh.close();
  });

  it('the forward-ported ops_audit_log is INDISTINGUISHABLE from a fresh one', () => {
    // The D1 lesson, applied: a migrated database and a fresh one must not diverge
    // silently — that split is 「green in tests, wrong in production」.
    const dbPath = join(tmp, 'ops-audit-converge.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.close();

    const migrated = openDatabase(dbPath);
    const fresh = openDatabase(':memory:');
    const ddlOf = (db: DatabaseSync): unknown =>
      db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name='ops_audit_log' ORDER BY type, name").all();
    expect(ddlOf(migrated)).toEqual(ddlOf(fresh));
    expect(migrated.prepare('PRAGMA table_info(ops_audit_log)').all()).toEqual(
      fresh.prepare('PRAGMA table_info(ops_audit_log)').all(),
    );
    migrated.close();
    fresh.close();
  });

  // ── A2-5 / REQ-12-08 additive migration: usage_events (DB-SENSITIVE — human review) ─
  //
  // Purely additive (one CREATE TABLE IF NOT EXISTS + one index, no ALTER, no
  // new reconcileSchema step) — the ops_audit_log / timeline_grants three
  // questions, plus two that belong only to this table:
  // ① the AUTOINCREMENT key (the keyset cursor AND the 「A happened before B」 answer);
  // ② 🔴 THE COLUMN CENSUS — the whitelist is the schema. A future ALTER that
  //   adds `source_text`, an excerpt, an IP or a window title is a privacy
  //   red-line breach (design §3.3), and this is the assertion that refuses to
  //   let one land quietly.
  it('creates usage_events (+ its index) on a pre-A2-5 DB, idempotently', () => {
    const dbPath = join(tmp, 'add-usage-events.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-events', 'Before', 'free')");
    expect(masterNames(legacy, 'table')).not.toContain('usage_events');
    legacy.close();

    const migrated = openDatabase(dbPath);
    expect(masterNames(migrated, 'table')).toContain('usage_events');
    expect(masterNames(migrated, 'index')).toContain('idx_usage_events_user_seq');
    // The pre-existing row is untouched — this migration adds, nothing else.
    expect(migrated.prepare("SELECT id FROM users WHERE id='u-pre-events'").get()).toEqual({ id: 'u-pre-events' });

    // ① INTEGER rowid alias + AUTOINCREMENT. A TEXT key would keep every repo
    // test green while making same-millisecond ordering a coin flip again AND
    // silently breaking the keyset cursor, which pages on `id > ?`.
    const pk = (migrated.prepare('PRAGMA table_info(usage_events)').all() as unknown as { name: string; pk: number; type: string }[])
      .filter((c) => c.pk > 0);
    expect(pk.map((c) => c.name)).toEqual(['id']);
    expect(pk[0]!.type).toBe('INTEGER');
    const ddl = (migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_events'").get() as {
      sql: string;
    }).sql;
    expect(ddl).toContain('AUTOINCREMENT');

    // ② load-bearing column shapes.
    // `occurred_at` INTEGER, never TEXT: this database sorts TEXT timestamps AS
    // TEXT, and a +08:00 offset once silently shuffled a whole table
    // (billing.repo.ts). A TEXT column here would ALSO break the time window,
    // because '1755000000000' and '999' compare as strings.
    expect(columnInfo(migrated, 'usage_events', 'occurred_at')).toMatchObject({ type: 'INTEGER', notnull: 1 });
    // `is_byok` INTEGER, never TEXT: a TEXT '0' is truthy in JS — the
    // permanent_free trap, one table over.
    expect(columnInfo(migrated, 'usage_events', 'is_byok')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    // `channel` NULLABLE: owner ruling ⑨'s meaning is open, so 「unknown」 must be
    // storable. A NOT NULL here would force every writer to invent a value.
    expect(columnInfo(migrated, 'usage_events', 'channel')).toMatchObject({ type: 'TEXT', notnull: 0 });
    // `outcome` NOT NULL: 「how this one ended」 has no unknown state — every row is
    // written by code that knows which one it is.
    expect(columnInfo(migrated, 'usage_events', 'outcome')).toMatchObject({ type: 'TEXT', notnull: 1 });

    // A2-5 round 2 — the two character counts, and the ONE property that makes
    // them honest: NULLABLE. `NOT NULL DEFAULT 0` would make every `llm` row and
    // every refusal ASSERT 「zero characters」 about something nobody counted — the
    // permanently-zero pair this card was explicitly told not to build. Asserted
    // on the FORWARD-PORTED database on purpose: the guarded ALTER in
    // reconcileSchema is a different code path from the CREATE, and it is the
    // one that could quietly emit a different shape.
    expect(columnInfo(migrated, 'usage_events', 'transcript_chars')).toMatchObject({ type: 'INTEGER', notnull: 0 });
    expect(columnInfo(migrated, 'usage_events', 'delivered_chars')).toMatchObject({ type: 'INTEGER', notnull: 0 });
    // 🔴 AND NO BACKFILL. A row that predates the columns was never measured, so
    // NULL is the only value that asserts nothing — the exact opposite of
    // `email_verified_at`'s grandfather stamp two steps up in reconcileSchema.
    migrated.exec(
      `INSERT INTO usage_events (user_id, occurred_at, kind, stt_ms, outcome)
       VALUES ('u-pre-events', 1, 'stt', 5, 'ok')`,
    );
    expect(migrated.prepare('SELECT transcript_chars, delivered_chars FROM usage_events').get())
      .toEqual({ transcript_chars: null, delivered_chars: null });

    // 2026-08-17 — `refused_user_id`, and the two properties that make it safe.
    // NULLABLE TEXT: a NOT NULL column would force every writer to name an
    // account, and the `ok` legs have none to name. NO BACKFILL: a legacy row's
    // refusing account is not merely unmeasured, it is UNKNOWABLE — stamping it
    // with its own `user_id` would manufacture the exact claim ("A hit A's
    // ceiling") that this column exists to stop manufacturing.
    expect(columnInfo(migrated, 'usage_events', 'refused_user_id')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(migrated.prepare('SELECT refused_user_id FROM usage_events').get()).toEqual({ refused_user_id: null });
    migrated.exec('DELETE FROM usage_events');

    // ③ 🔴 THE WHITELIST CENSUS. These THIRTEEN columns and nothing else. The
    // privacy design's forbidden list is not enforceable by review alone — this
    // is the assertion that a `source_text`, an excerpt, an `ip`, a
    // `window_title` or a `request_id` column cannot be added without somebody
    // deliberately editing this line.
    // ⚠️ Two changes on 2026-08-12: the character counts joined the list (with
    // the policy line that names them — docs/legal/privacy-policy.md
    // 「character counts of transcripts / delivered finals」), and the word in
    // this sentence was corrected from 「NINE」, which had been undercounting the
    // TEN names it listed since the day it was written. The prose was wrong and
    // the assertion was right, which is the safe direction — but it is worth
    // recording that the number in a comment drifted from the array under it
    // within one card.
    // ⚠️ 2026-08-17: `refused_user_id` joined the list. It is the first column
    // here that can hold an id belonging to a DIFFERENT account than the row's
    // own, which is precisely why it had to pass through this census rather than
    // arrive quietly.
    const cols = (migrated.prepare('PRAGMA table_info(usage_events)').all() as unknown as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual([
      'channel', 'delivered_chars', 'id', 'is_byok', 'kind', 'occurred_at', 'outcome',
      'refused_user_id', 'stt_ms', 'tokens_in', 'tokens_out', 'transcript_chars', 'user_id',
    ]);

    // ④ FK CASCADE to users, and it really fires (FKs are ON — openDatabase).
    // A per-utterance record outliving the account that asked to be erased is
    // the worst leftover the delete census could miss.
    // 🔴 AND EXACTLY ONE FK, which since 2026-08-17 guards a second thing:
    // `refused_user_id` deliberately carries no `REFERENCES users(id)`. A second
    // cascade into this table would let the PC OWNER deleting their account
    // delete the PHONE user's usage rows — one account erasing another's record.
    const fks = migrated.prepare('PRAGMA foreign_key_list(usage_events)').all() as unknown as {
      table: string; from: string; on_delete: string;
    }[];
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ table: 'users', from: 'user_id', on_delete: 'CASCADE' });
    migrated.exec(
      `INSERT INTO usage_events (user_id, occurred_at, kind, stt_ms, outcome)
       VALUES ('u-pre-events', 1, 'stt', 5, 'ok')`,
    );
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 1 });
    migrated.exec("DELETE FROM users WHERE id='u-pre-events'");
    expect(migrated.prepare('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: 0 });

    // Idempotent: second and third boot change nothing.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    // …and a genuine restart converges on the same shape.
    const restarted = openDatabase(dbPath);
    expect(schemaSnapshot(restarted)).toEqual(after);
    restarted.close();
  });

  it('the forward-ported usage_events is INDISTINGUISHABLE from a fresh one', () => {
    const dbPath = join(tmp, 'usage-events-converge.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.close();

    const migrated = openDatabase(dbPath);
    const fresh = openDatabase(':memory:');
    const ddlOf = (db: DatabaseSync): unknown =>
      db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name='usage_events' ORDER BY type, name").all();
    expect(ddlOf(migrated)).toEqual(ddlOf(fresh));
    expect(migrated.prepare('PRAGMA table_info(usage_events)').all()).toEqual(
      fresh.prepare('PRAGMA table_info(usage_events)').all(),
    );
    migrated.close();
    fresh.close();
  });

  it('has exactly the 16 tables it should (05-DATA-MODEL §1.1: minus the retired one, plus D1 §3.2/§3.3, 0.2.47 §10, SALT-1 §11, GRANT-1 §12, VERIFY-1 §13, A2-5 §14, 0.3.25 B1 §8b and 0.3.25 B3 §8c)', () => {
    const db = openDatabase(':memory:');
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(new Set(names)).toEqual(new Set(TABLES));
    db.close();
  });
});
