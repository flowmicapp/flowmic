// Upgrade path for `trial_ledger.device_uid` (card R-1b) — the boot that a
// deployment created BEFORE R-1b actually performs.
//
// WHY THIS IS ITS OWN FILE. It belongs to the migration suite, but
// `migration-idempotency.test.ts` is already past its size cap (that is exactly
// why `migration-google-sub.test.ts` was split out on 2026-08-27), so this
// step gets a file of its own beside it and shares the same fixtures.
//
// ── WHAT WENT WRONG, AND WHAT THIS FILE IS THE GUARD FOR ──────────────────
// `TRIAL_SQL` (db/schema-trial.ts) is interpolated into `INIT_SQL`, and
// `openDatabase` runs INIT_SQL on EVERY boot BEFORE `reconcileSchema`'s guarded
// `ALTER TABLE ... ADD COLUMN` loop. R-1b (commit 9de2f7b8, merged as 79f3272b)
// added `device_uid` to the CREATE TABLE **and** a partial unique index on it
// directly underneath, inside TRIAL_SQL.
//
// On a FRESH database that is harmless — the CREATE TABLE runs first and the
// column is there. On an EXISTING database whose `trial_ledger` predates the
// column it is fatal: `CREATE TABLE IF NOT EXISTS` is skipped, the column
// arrives only later (ADDITIVE_TEXT_COLUMNS → the ALTER loop), and the index
// statement therefore runs against a table that does not have `device_uid` yet.
// SQLite answers `no such column: device_uid`, `openDatabase` rethrows it as
// `FlowMic DB migration failed: ...`, and the process cannot boot. That is not
// a thought experiment: it crash-looped the JP replica ten times on 2026-09-10
// (deploy r-20260910-123458) and forced an auto-rollback.
//
// The fix is ORDER, not defensiveness — `IF NOT EXISTS` on the index does not
// help, because the index really does not exist; the COLUMN does not either.
// The index's single owner is now `reconcileSchema()` in db/connection.ts,
// after the ALTER loop, beside `idx_pc_devices_pcid` (grep that file for
// `idx_trial_ledger_device`).
//
// 🔴 THE ONLY TEST THAT COULD HAVE CAUGHT THIS IS ONE THAT OPENS A DATABASE
// THAT REALLY PREDATES THE COLUMN. A fresh-DB test is green either way — the
// bug lives exclusively on the upgrade path, which is the path production is on
// and the test suite was not.

import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reconcileSchema } from '../src/db/connection';
import { INIT_SQL } from '../src/db/schema';
import { columnInfo, LEGACY_USERS_PRE_D1, masterNames, schemaSnapshot } from './fixtures/migration-schema';

/** `trial_ledger` exactly as card M4-01 shipped it — i.e. `TRIAL_SQL` as it
 *  stood in `db/schema-trial.ts` at `9de2f7b8^` (the parent of the R-1b commit
 *  `9de2f7b8`, merged as `79f3272b`), with the SQL comments dropped. No
 *  `device_uid` column and no index over it: this is the shape every database
 *  deployed between 2026-09-09 and R-1b is in.
 *
 *  🔴 Kept as a fixture rather than reconstructed by hand, and the difference
 *  matters: a hand-written "roughly the old table" would not prove anything
 *  about the databases that are actually out there. */
const LEGACY_TRIAL_LEDGER_PRE_R1B = /* sql */ `
CREATE TABLE IF NOT EXISTS trial_ledger (
  anon_user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ip_bucket        TEXT NOT NULL,
  day              TEXT NOT NULL,
  grants_used      INTEGER NOT NULL DEFAULT 0,
  ms_granted       INTEGER NOT NULL DEFAULT 0,
  anon_token       TEXT,
  token_expires_at INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_ledger_day_bucket ON trial_ledger(day, ip_bucket);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_ledger_token ON trial_ledger(anon_token) WHERE anon_token IS NOT NULL;
`;

const tmp = mkdtempSync(join(tmpdir(), 'flowmic-trial-mig-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('trial_ledger.device_uid upgrade path', () => {
  it('boots a pre-R-1b database and forward-ports the column AND its index', () => {
    const dbPath = join(tmp, 'pre-r1b-trial-ledger.db');

    // ── a database that really predates the column ──
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec(LEGACY_TRIAL_LEDGER_PRE_R1B);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('anon-old', 'Visitor', 'free')");
    legacy.exec(
      `INSERT INTO trial_ledger (anon_user_id, ip_bucket, day, grants_used, ms_granted, anon_token, token_expires_at, created_at)
       VALUES ('anon-old', 'bucket-old', '2026-09-09', 0, 120000, 'fm_old', 1757462400000, '2026-09-09T00:00:00.000Z')`,
    );
    // The premise of the whole test, asserted rather than assumed.
    expect(columnInfo(legacy, 'trial_ledger', 'device_uid')).toBeUndefined();
    expect(masterNames(legacy, 'index')).not.toContain('idx_trial_ledger_device');
    legacy.close();

    // ── the migration: exactly what a deploy + restart runs ──
    // 🔴 This line is the regression guard. With the index statement inside
    // TRIAL_SQL it throws `FlowMic DB migration failed: no such column:
    // device_uid` here, before a single assertion below is reached.
    const migrated = openDatabase(dbPath);

    // ① the column arrived through ADDITIVE_TEXT_COLUMNS' loop: TEXT, nullable.
    expect(columnInfo(migrated, 'trial_ledger', 'device_uid')).toMatchObject({ type: 'TEXT', notnull: 0 });
    // ② and the index exists AFTERWARDS — the reconcile-path copy is the owner,
    //    so removing the INIT_SQL one did not quietly drop the guarantee.
    expect(masterNames(migrated, 'index')).toContain('idx_trial_ledger_device');
    // ③ it is the same index R-1b intended: UNIQUE and PARTIAL. A plain index
    //    would let one browser identity hold two allowances, which is the whole
    //    thing `device_uid` was added to prevent.
    const indexSql = (
      migrated
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_trial_ledger_device'")
        .get() as { sql: string }
    ).sql;
    expect(indexSql).toContain('UNIQUE');
    expect(indexSql).toContain('WHERE device_uid IS NOT NULL');

    // ④ the pre-existing row survived, reading NULL — zero backfill, which is
    //    the honest answer for a visitor whose browser identity we never saw.
    expect(
      migrated.prepare("SELECT ms_granted, anon_token, device_uid FROM trial_ledger WHERE anon_user_id='anon-old'").get(),
    ).toEqual({ ms_granted: 120000, anon_token: 'fm_old', device_uid: null });

    // ⑤ and the partial predicate really keeps legacy rows out of the index:
    //    a SECOND NULL row must be insertable, or an upgraded database with more
    //    than one swept row could never boot.
    migrated.exec("INSERT INTO users (id, display_name, plan) VALUES ('anon-old-2', 'Visitor', 'free')");
    migrated.exec(
      `INSERT INTO trial_ledger (anon_user_id, ip_bucket, day, ms_granted, token_expires_at, created_at)
       VALUES ('anon-old-2', 'bucket-old', '2026-09-09', 0, 1757462400000, '2026-09-09T00:00:00.000Z')`,
    );

    // ⑥ idempotent: the second and third boot change nothing and do not throw.
    const after = schemaSnapshot(migrated);
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(schemaSnapshot(migrated)).toEqual(after);
    migrated.close();

    // …and a genuine restart (fresh connection) is likewise inert.
    const restarted = openDatabase(dbPath);
    expect(masterNames(restarted, 'index')).toContain('idx_trial_ledger_device');
    expect(columnInfo(restarted, 'trial_ledger', 'device_uid')).toMatchObject({ type: 'TEXT', notnull: 0 });
    restarted.close();
  });

  it('a fresh database converges on the same trial_ledger shape', () => {
    // The pair to the test above: whatever the upgrade path produces, the
    // fresh path must produce too, or the two would drift. (This one is green
    // with or without the defect — that is precisely why it cannot stand alone.)
    const db = openDatabase(':memory:');
    expect(columnInfo(db, 'trial_ledger', 'device_uid')).toMatchObject({ type: 'TEXT', notnull: 0 });
    expect(masterNames(db, 'index')).toContain('idx_trial_ledger_device');
    db.close();
  });
});
