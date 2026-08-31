// SPEC-REF:
//   src/db/connection.ts `reconcileSchema` (the guarded ALTER block under test)
//   src/db/schema-billing.ts ONE_TIME_PURCHASE_SQL (the fresh CREATE it has to
//     converge with, and why the three columns are declared LAST)
//   test/migration-idempotency.test.ts (the suite this follows; it is at 1104
//     lines against a 1200-line cap, so this round's block lives in its own
//     file rather than deepening that debt)
//   *** HUMAN-AUDIT SENSITIVE (schema migration) ***
//
// 2026-08-31 — one_time_purchases gains refund_released_at,
// refund_release_reason and refund_external_reference.
//
// 🔴 WHAT THIS FILE IS FOR, IN ONE SENTENCE: "the migration is idempotent" is a
// claim about what happens on the SECOND boot, and reading the guard and
// concluding it is not the same instrument as running it twice against a real
// database with real rows in it. Every assertion below is measured, not argued.
//
// The four questions, the same four every column step in the sibling suite
// answers:
//   ① SHAPE — nullable TEXT with no default. The additive-int shape
//      (`NOT NULL DEFAULT 0`) would forward-port every legacy row as though a
//      release had happened, and `refund_release_reason` is READ BY THE SWEEP;
//   ② NO BACKFILL and NO DATA LOSS — every pre-existing row keeps every value
//      it had, and gets NULL in the three new columns;
//   ③ REPLAY — running it again (and again) changes nothing and throws nothing;
//   ④ CONVERGENCE — the forward-ported table is indistinguishable from a fresh
//      one, column for column, IN ORDER.

import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reconcileSchema } from '../src/db/connection';
import { INIT_SQL } from '../src/db/schema';
import { makeOneTimePurchaseRepo } from '../src/db/repos/one-time-purchase.repo';

const tmp = mkdtempSync(join(tmpdir(), 'flowmic-refund-release-migration-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * `one_time_purchases` exactly as it stood the day before this round —
 * everything up to and including `started_at`, and none of the three new
 * columns.
 *
 * ⚠️ A LITERAL, NOT A DERIVATION. Deriving it by stripping the current DDL
 * would make the fixture change whenever the DDL does, and the whole question
 * this file asks is whether TODAY's reconcile can forward-port YESTERDAY's
 * shape. The convergence assertion (④) is what stops this literal rotting: if
 * it ever stops being a real prefix of the fresh table, the column-order
 * comparison fails.
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
  consent_terms_version    TEXT,
  scheduled_at        TEXT,
  started_at          TEXT,
  delivered_at        TEXT,
  refund_requested_at TEXT,
  refund_provider_id  TEXT,
  refund_status       TEXT,
  refunded_at         TEXT,
  completion_notice_at TEXT,
  note                TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
`;

const NEW_COLUMNS = ['refund_released_at', 'refund_release_reason', 'refund_external_reference'] as const;

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

/** Name/type/nullability/default, IN ORDER. `cid` is dropped because it is
 *  positional and would make the comparison trivially true or trivially false
 *  rather than informative. */
function shape(db: DatabaseSync, table: string): Omit<ColumnInfo, 'cid'>[] {
  return columns(db, table).map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
}

/** Every row of the table, so "no data loss" can be a comparison rather than a
 *  spot check of the columns somebody happened to think of. */
function allRows(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM one_time_purchases ORDER BY order_id').all() as Record<string, unknown>[];
}

/**
 * Three legacy purchases, one per shape that matters.
 *
 * ⚠️ COLUMNS ARE NAMED, NOT POSITIONAL. The first draft of this fixture used
 * `INSERT INTO ... VALUES (...)` with 24 bare values, and two of the date
 * columns silently swapped — a fixture that lies about what it wrote is worse
 * than no fixture, because every assertion against it still passes for the
 * wrong reason. That mistake was caught here by a red assertion; it is spelled
 * out so it is not made again.
 */
const LEGACY_ROWS: Record<string, string | number | null>[] = [
  // A live purchase, mid-service.
  {
    order_id: 'ord_live', provider: 'creem', user_id: 'u1', product_id: 'prod_setup',
    checkout_id: 'ch_1', transaction_id: 'tx_1', customer_id: 'cus_1', amount_minor: 20000,
    currency: 'USD', state: 'in_progress',
    early_start_consent_at: '2026-08-01T00:00:00.000Z',
    withdrawal_waiver_ack_at: '2026-08-01T00:00:00.000Z',
    consent_terms_version: 'gs-5',
    scheduled_at: '2026-08-02T00:00:00.000Z', started_at: '2026-08-03T00:00:00.000Z',
    delivered_at: null, refund_requested_at: null, refund_provider_id: null,
    refund_status: null, refunded_at: null, completion_notice_at: null,
    note: 'booked by hand',
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-03T00:00:00.000Z',
  },
  // 🔴 THE ONE THIS ROUND EXISTS FOR: a refund we asked for and never heard back
  // about. `refund_status: null` is what "stuck" looks like on disk.
  {
    order_id: 'ord_stuck', provider: 'creem', user_id: 'u2', product_id: 'prod_setup',
    checkout_id: 'ch_2', transaction_id: 'tx_2', customer_id: 'cus_2', amount_minor: 20000,
    currency: 'USD', state: 'refund_requested',
    early_start_consent_at: null, withdrawal_waiver_ack_at: null, consent_terms_version: 'gs-5',
    scheduled_at: null, started_at: null, delivered_at: null,
    refund_requested_at: '2026-08-10T00:00:00.000Z', refund_provider_id: null,
    refund_status: null, refunded_at: null, completion_notice_at: null, note: null,
    created_at: '2026-08-05T00:00:00.000Z', updated_at: '2026-08-10T00:00:00.000Z',
  },
  // A finished one, with the completion notice sent.
  {
    order_id: 'ord_done', provider: 'creem', user_id: 'u3', product_id: 'prod_setup',
    checkout_id: 'ch_3', transaction_id: 'tx_3', customer_id: 'cus_3', amount_minor: 20000,
    currency: 'USD', state: 'delivered',
    early_start_consent_at: null, withdrawal_waiver_ack_at: null, consent_terms_version: 'gs-5',
    scheduled_at: '2026-08-06T00:00:00.000Z', started_at: '2026-08-07T00:00:00.000Z',
    delivered_at: '2026-08-07T09:00:00.000Z',
    refund_requested_at: null, refund_provider_id: null, refund_status: null, refunded_at: null,
    completion_notice_at: '2026-08-07T09:05:00.000Z', note: null,
    created_at: '2026-08-05T00:00:00.000Z', updated_at: '2026-08-07T09:05:00.000Z',
  },
];

function makeLegacy(dbPath: string): void {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(LEGACY_ONE_TIME_PURCHASES);
  for (const row of LEGACY_ROWS) {
    const cols = Object.keys(row);
    legacy
      .prepare(`INSERT INTO one_time_purchases (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map((c) => row[c] ?? null));
  }
  // The premise of the whole file, asserted rather than assumed: this database
  // really does predate the three columns.
  for (const c of NEW_COLUMNS) expect(columnInfo(legacy, 'one_time_purchases', c)).toBeUndefined();
  expect(legacy.prepare('SELECT COUNT(*) AS n FROM one_time_purchases').get()).toEqual({ n: 3 });
  legacy.close();
}

describe('refund-release columns: the migration, run for real', () => {
  it('🔴 ALTERs the three columns onto a pre-2026-08-31 DB, backfills NOTHING, and loses NOTHING', () => {
    const dbPath = join(tmp, 'add-refund-release.db');
    makeLegacy(dbPath);

    // The migration: exactly what a deploy + restart runs.
    const migrated = openDatabase(dbPath);

    // ① SHAPE — nullable TEXT, no default. `notnull: 0` and a null default are
    // the assertion. The additive-int shape would read `{notnull: 1,
    // dflt_value: '0'}` here, and on `refund_release_reason` that would take
    // EVERY legacy purchase off the 14-day no-start sweep for ever — a silent
    // withdrawal of a promised protection, on every row at once.
    for (const c of NEW_COLUMNS) {
      expect(columnInfo(migrated, 'one_time_purchases', c), `${c} was not added`).toMatchObject({
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
      });
    }

    // ② NO BACKFILL, and NO DATA LOSS. Compared as WHOLE ROWS rather than a
    // handful of columns: a migration that dropped `note` or rewrote
    // `refund_requested_at` would pass a spot check of the three new columns
    // and fail this.
    const after = allRows(migrated);
    expect(after).toHaveLength(3);
    expect(after.map((r) => r.order_id)).toEqual(['ord_done', 'ord_live', 'ord_stuck']);
    for (const r of after) {
      for (const c of NEW_COLUMNS) expect(r[c], `${String(r.order_id)}.${c}`).toBeNull();
    }
    // The stuck row, field by field, because it is the one this round is about.
    expect(after.find((r) => r.order_id === 'ord_stuck')).toMatchObject({
      state: 'refund_requested',
      refund_requested_at: '2026-08-10T00:00:00.000Z',
      refund_status: null,
      refunded_at: null,
      transaction_id: 'tx_2',
      amount_minor: 20000,
    });
    // …and the two neighbours kept their own stamps and their operator note.
    expect(after.find((r) => r.order_id === 'ord_live')).toMatchObject({
      started_at: '2026-08-03T00:00:00.000Z',
      note: 'booked by hand',
    });
    expect(after.find((r) => r.order_id === 'ord_done')).toMatchObject({
      delivered_at: '2026-08-07T09:00:00.000Z',
      completion_notice_at: '2026-08-07T09:05:00.000Z',
    });

    // ③ REPLAY. 🔴 RUN FOR REAL, TWICE MORE, on the same connection: this is the
    // assertion that "idempotent" is a measurement rather than a reading of the
    // guard. It must not throw (a second unguarded ALTER is a hard error in
    // SQLite) and must change neither the schema nor a single row.
    const shapeAfterFirst = shape(migrated, 'one_time_purchases');
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(shape(migrated, 'one_time_purchases')).toEqual(shapeAfterFirst);
    expect(allRows(migrated)).toEqual(after);
    migrated.close();

    // …and across a RESTART, which is the shape a deploy actually has.
    const restarted = openDatabase(dbPath);
    expect(shape(restarted, 'one_time_purchases')).toEqual(shapeAfterFirst);
    expect(allRows(restarted)).toEqual(after);

    // ④ CONVERGENCE. The forward-ported table is indistinguishable from a fresh
    // one — name, type, nullability, default, AND ORDER. 🔴 THE ORDER IS THE
    // HALF THAT COSTS SOMETHING: ALTER TABLE ADD COLUMN appends, so declaring
    // any of these three mid-table in schema-billing.ts would make a migrated
    // database and a fresh one differ in a way nothing else here would notice.
    const fresh = openDatabase(':memory:');
    expect(shape(restarted, 'one_time_purchases')).toEqual(shape(fresh, 'one_time_purchases'));
    fresh.close();
    restarted.close();
  });

  it('🔴 a purchase written AFTER the migration still gets NULL in all three', () => {
    // There is no UPDATE inside the guard to run a second time — but a future
    // one added outside it, or an INSERT that started naming these columns,
    // would be caught here.
    const dbPath = join(tmp, 'post-migration-insert.db');
    makeLegacy(dbPath);
    const db = openDatabase(dbPath);
    const repo = makeOneTimePurchaseRepo(db);
    repo.recordOneTimePurchase({
      order_id: 'ord_new',
      provider: 'creem',
      user_id: 'u4',
      product_id: 'prod_setup',
      checkout_id: null,
      transaction_id: 'tx_4',
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
      created_at: '2026-08-31T00:00:00.000Z',
    });
    const row = repo.getOneTimePurchase('ord_new')!;
    expect(row.refund_released_at).toBeNull();
    expect(row.refund_release_reason).toBeNull();
    expect(row.refund_external_reference).toBeNull();
    db.close();
  });

  it('🔴 the release path WORKS on a forward-ported database, not merely on a fresh one', () => {
    // The migration's real acceptance test. A schema that is present but
    // unusable — a column added with the wrong affinity, an index the write
    // trips over — would pass every PRAGMA assertion above and fail the first
    // operator who pressed the button on a production row.
    //
    // ⚠️ AND THE ROW IT ACTS ON IS A LEGACY ONE (`ord_stuck`, written by the
    // pre-migration INSERT), which is the only kind that can prove this.
    const dbPath = join(tmp, 'release-on-migrated.db');
    makeLegacy(dbPath);
    const db = openDatabase(dbPath);
    const repo = makeOneTimePurchaseRepo(db);

    expect(repo.getOneTimePurchase('ord_stuck')!.state).toBe('refund_requested');
    expect(
      repo.releaseOneTimeRefundRequest(
        'ord_stuck',
        { to_state: 'scheduled', reason: 'provider_declined', released_at: '2026-08-31T12:00:00.000Z' },
        '2026-08-31T12:00:00.000Z',
      ),
    ).toBe('released');
    const released = repo.getOneTimePurchase('ord_stuck')!;
    expect(released.state).toBe('scheduled');
    expect(released.refund_released_at).toBe('2026-08-31T12:00:00.000Z');
    expect(released.refund_release_reason).toBe('provider_declined');
    // The history the release is required to keep.
    expect(released.refund_requested_at).toBe('2026-08-10T00:00:00.000Z');

    // …and the other outcome, on a row that is still stuck. Both writes, on the
    // migrated shape, because they are two different UPDATE statements.
    expect(
      repo.requestOneTimeRefund(
        'ord_live',
        { requested_at: '2026-08-31T12:00:00.000Z', provider_id: null, provider_status: null },
        '2026-08-31T12:00:00.000Z',
      ),
    ).toBe('claimed');
    expect(
      repo.settleOneTimeRefundByHand(
        'ord_live',
        { refunded_at: '2026-08-31T13:00:00.000Z', external_reference: 'BANK-REF-1' },
        '2026-08-31T13:00:00.000Z',
      ),
    ).toBe('settled');
    const settled = repo.getOneTimePurchase('ord_live')!;
    expect(settled.state).toBe('refunded');
    expect(settled.refund_external_reference).toBe('BANK-REF-1');
    expect(settled.note).toBe('booked by hand');
    db.close();
  });
});
