// SPEC-REF:
//   src/db/connection.ts `reconcileSchema` (the guarded ALTER block under test)
//   src/db/schema-billing.ts BILLING_ADDITIVE_TEXT_COLUMNS (the fix)
//   test/refund-release-migration.test.ts (the pattern this file follows)
//   *** HUMAN-AUDIT SENSITIVE (schema migration) ***
//
// 2026-09-02 audit P2-7 — `one_time_purchases.consent_terms_version` shipped in
// the CREATE TABLE (schema-billing.ts) but was never added to
// BILLING_ADDITIVE_TEXT_COLUMNS, so a database built from a commit between the
// table's founding and the one that added this column has `one_time_purchases`
// WITHOUT it. `recordOneTimePurchase` states every column by name (see
// one-time-purchase.repo.ts), so the first real purchase's INSERT throws "no
// such column: consent_terms_version" instead of recording a sale.
//
// This file drives the fix — `consent_terms_version` now rides the guarded
// ADD COLUMN loop — against a literal legacy shape that has every OTHER
// one_time_purchases column already (this fix touches only the one column;
// the audit separately flags early_start_consent_at/withdrawal_waiver_ack_at/
// scheduled_at as the SAME shape of gap, left for a follow-up pass).

import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reconcileSchema } from '../src/db/connection';
import { INIT_SQL } from '../src/db/schema';
import { makeOneTimePurchaseRepo } from '../src/db/repos/one-time-purchase.repo';

const tmp = mkdtempSync(join(tmpdir(), 'flowmic-consent-terms-version-migration-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * `one_time_purchases`, WITHOUT `consent_terms_version` — every other column
 * present, exactly the "intermediate commit" shape the audit names.
 *
 * ⚠️ A LITERAL, NOT A DERIVATION — same reasoning as the sibling suite: this
 * asks whether TODAY's reconcile can forward-port a database that is missing
 * only this one column, and deriving the fixture from the current DDL would
 * make that question untestable.
 */
const LEGACY_ONE_TIME_PURCHASES = `
CREATE TABLE IF NOT EXISTS one_time_purchases (
  order_id            TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  user_id             TEXT,
  product_id          TEXT,
  checkout_id         TEXT,
  transaction_id      TEXT,
  customer_id         TEXT,
  amount_minor        INTEGER,
  currency            TEXT,
  state               TEXT NOT NULL,
  early_start_consent_at   TEXT,
  withdrawal_waiver_ack_at TEXT,
  scheduled_at        TEXT,
  started_at          TEXT,
  delivered_at        TEXT,
  refund_requested_at TEXT,
  refund_provider_id  TEXT,
  refund_status       TEXT,
  refunded_at         TEXT,
  completion_notice_at TEXT,
  refund_released_at  TEXT,
  refund_release_reason TEXT,
  refund_external_reference TEXT,
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
`;

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columns(db: DatabaseSync, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
}

function columnInfo(db: DatabaseSync, table: string, name: string): ColumnInfo | undefined {
  return columns(db, table).find((c) => c.name === name);
}

function shape(db: DatabaseSync, table: string): Omit<ColumnInfo, 'cid'>[] {
  return columns(db, table).map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
}

function allRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM one_time_purchases ORDER BY order_id').all() as Record<string, unknown>[];
}

const LEGACY_ROW = {
  order_id: 'ord_legacy', provider: 'creem', user_id: 'u1', product_id: 'prod_setup',
  checkout_id: 'ch_1', transaction_id: 'tx_1', customer_id: 'cus_1', amount_minor: 20000,
  currency: 'USD', state: 'delivered',
  early_start_consent_at: '2026-08-01T00:00:00.000Z',
  withdrawal_waiver_ack_at: '2026-08-01T00:00:00.000Z',
  scheduled_at: '2026-08-02T00:00:00.000Z',
  started_at: '2026-08-03T00:00:00.000Z',
  delivered_at: '2026-08-03T09:00:00.000Z',
  refund_requested_at: null, refund_provider_id: null, refund_status: null,
  refunded_at: null, completion_notice_at: '2026-08-03T09:05:00.000Z',
  refund_released_at: null, refund_release_reason: null, refund_external_reference: null,
  note: 'booked before consent_terms_version existed',
  created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-03T09:05:00.000Z',
};

function makeLegacy(dbPath: string): void {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(LEGACY_ONE_TIME_PURCHASES);
  const cols = Object.keys(LEGACY_ROW);
  legacy
    .prepare(`INSERT INTO one_time_purchases (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => (LEGACY_ROW as Record<string, string | number | null>)[c] ?? null));
  // The premise of the file: this database really does predate the column.
  expect(columnInfo(legacy, 'one_time_purchases', 'consent_terms_version')).toBeUndefined();
  expect(legacy.prepare('SELECT COUNT(*) AS n FROM one_time_purchases').get()).toEqual({ n: 1 });
  legacy.close();
}

describe('consent_terms_version: the migration, run for real', () => {
  it('🔴 ALTERs the column onto a DB built without it, backfills NOTHING, loses NOTHING', () => {
    const dbPath = join(tmp, 'add-consent-terms-version.db');
    makeLegacy(dbPath);

    const migrated = openDatabase(dbPath);

    // ① SHAPE — nullable TEXT, no default (the additive-int shape would
    // instead read `{notnull: 1, dflt_value: '0'}`, which is wrong for a
    // column that names free-text wording, not a flag).
    expect(columnInfo(migrated, 'one_time_purchases', 'consent_terms_version')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    });

    // ② NO BACKFILL, NO DATA LOSS — the whole row, not a spot check.
    const after = allRows(migrated);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ order_id: 'ord_legacy', consent_terms_version: null, note: LEGACY_ROW.note });

    // ③ REPLAY — idempotent is a measurement, not a reading of the guard.
    const shapeAfterFirst = shape(migrated, 'one_time_purchases');
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(shape(migrated, 'one_time_purchases')).toEqual(shapeAfterFirst);
    expect(allRows(migrated)).toEqual(after);
    migrated.close();

    // …and across a restart, the shape a real deploy has.
    const restarted = openDatabase(dbPath);
    expect(shape(restarted, 'one_time_purchases')).toEqual(shapeAfterFirst);
    expect(allRows(restarted)).toEqual(after);

    // ④ CONVERGENCE, minus position — name/type/nullability/default agree with
    // a fresh database's. `cid` is DELIBERATELY excluded: `ADD COLUMN` always
    // appends, while the fresh CREATE TABLE declares this column mid-table, so
    // the two tables' column ORDER can never converge for this one field
    // without dropping and recreating the table — a cost this fix does not
    // take on. That position difference is cosmetic (SQLite has no concept of
    // "this column must be Nth"); a `SELECT *` or `PRAGMA table_info` reader
    // that assumed position would already be broken by every other additive
    // column in this file, which append the same way.
    const fresh = openDatabase(':memory:');
    const stripCid = (c: ColumnInfo | undefined) =>
      c === undefined ? undefined : { name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value };
    expect(stripCid(columnInfo(restarted, 'one_time_purchases', 'consent_terms_version'))).toEqual(
      stripCid(columnInfo(fresh, 'one_time_purchases', 'consent_terms_version')),
    );
    fresh.close();
    restarted.close();
  });

  // 🔴 THIS IS THE DEFECT ITSELF, REPRODUCED: without the fix, this INSERT is
  // exactly what a real purchase does on a database in this shape, and it
  // throws "no such column: consent_terms_version" rather than recording a
  // sale — the failure the audit's "首笔购买 INSERT 炸" names.
  it('🔴 a real purchase INSERT succeeds on a migrated legacy DB (the actual failure this closes)', () => {
    const dbPath = join(tmp, 'post-migration-purchase.db');
    makeLegacy(dbPath);
    const db = openDatabase(dbPath);
    const repo = makeOneTimePurchaseRepo(db);
    expect(() =>
      repo.recordOneTimePurchase({
        order_id: 'ord_new',
        provider: 'creem',
        user_id: 'u2',
        product_id: 'prod_setup',
        checkout_id: null,
        transaction_id: 'tx_2',
        customer_id: null,
        amount_minor: 20000,
        currency: 'USD',
        state: 'paid',
        early_start_consent_at: null,
        withdrawal_waiver_ack_at: null,
        consent_terms_version: 'gs-5',
        scheduled_at: null,
        started_at: null,
        delivered_at: null,
        refund_requested_at: null,
        refund_provider_id: null,
        refund_status: null,
        refunded_at: null,
        completion_notice_at: null,
        note: null,
        created_at: '2026-09-02T00:00:00.000Z',
      }),
    ).not.toThrow();
    expect(repo.getOneTimePurchase('ord_new')).toMatchObject({ order_id: 'ord_new', consent_terms_version: 'gs-5' });
    db.close();
  });
});
