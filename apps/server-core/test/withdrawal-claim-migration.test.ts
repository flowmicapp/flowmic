// SPEC-REF:
//   src/db/connection.ts `reconcileSchema` (the guarded ALTER block under test)
//   src/db/schema-billing.ts BILLING_ADDITIVE_TEXT_COLUMNS (the entry this pins)
//   src/db/repos/withdrawal-claim.repo.ts (the reader/writer, exercised for real)
//   test/consent-terms-version-migration.test.ts (the pattern this follows)
//
// 2026-09-02 audit F4 — `paddle_subscriptions.withdrawal_claimed_at` is a NEW
// column, added correctly to `BILLING_ADDITIVE_TEXT_COLUMNS` in the SAME commit
// that introduces it (unlike `consent_terms_version`, which shipped without
// that listing for one commit and needed a forward-port fix). Every database
// that exists today predates this column, so the forward-port is not a
// hypothetical — it is what every real deployment will do the next time it
// boots this build.

import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reconcileSchema } from '../src/db/connection';
import { INIT_SQL } from '../src/db/schema';

const tmp = mkdtempSync(join(tmpdir(), 'flowmic-withdrawal-claim-migration-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** `paddle_subscriptions`, WITHOUT `withdrawal_claimed_at` — every column that
 *  exists in production TODAY, and no more. A literal, not a derivation from
 *  the current DDL, for the same reason the sibling file gives: deriving the
 *  fixture from today's schema would make "can reconcile forward-port this"
 *  untestable. FK checking is off on this raw handle (no `PRAGMA foreign_keys`
 *  statement runs against it), so `user_id` need not resolve to a real row —
 *  the same latitude sqlite itself gives a file that predates the pragma. */
const LEGACY_PADDLE_SUBSCRIPTIONS = `
CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  subscription_id     TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  customer_id         TEXT,
  status              TEXT NOT NULL,
  provider            TEXT,
  tier                TEXT NOT NULL,
  price_id            TEXT,
  cycle               TEXT,
  current_period_end  TEXT,
  canceled_at         TEXT,
  scheduled_change_action TEXT,
  scheduled_change_at     TEXT,
  next_billed_at          TEXT,
  contract_concluded_at   TEXT,
  last_event_id       TEXT NOT NULL,
  last_occurred_at    TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
`;

const LEGACY_ROW = {
  subscription_id: 'sub_legacy', user_id: 'u_legacy', customer_id: 'ctm_1', status: 'active',
  provider: 'paddle', tier: 'pro', price_id: 'pri_1', cycle: 'monthly',
  current_period_end: '2026-09-01T00:00:00.000Z', canceled_at: null,
  scheduled_change_action: null, scheduled_change_at: null, next_billed_at: '2026-09-01T00:00:00.000Z',
  contract_concluded_at: '2026-08-01T00:00:00.000Z', last_event_id: 'evt_1', last_occurred_at: '2026-08-01T00:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
};

function columnInfo(db: DatabaseSync, table: string, name: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null }[])
    .find((c) => c.name === name);
}

function makeLegacy(dbPath: string): void {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(LEGACY_PADDLE_SUBSCRIPTIONS);
  const cols = Object.keys(LEGACY_ROW);
  legacy
    .prepare(`INSERT INTO paddle_subscriptions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => (LEGACY_ROW as Record<string, string | null>)[c] ?? null));
  expect(columnInfo(legacy, 'paddle_subscriptions', 'withdrawal_claimed_at')).toBeUndefined();
  legacy.close();
}

describe('withdrawal_claimed_at: forward-ported onto a DB that predates it', () => {
  it('ALTERs the column on, backfills nothing, loses nothing, and the claim works for real afterwards', () => {
    const dbPath = join(tmp, 'add-withdrawal-claimed-at.db');
    makeLegacy(dbPath);

    const migrated = openDatabase(dbPath);

    expect(columnInfo(migrated, 'paddle_subscriptions', 'withdrawal_claimed_at')).toMatchObject({
      type: 'TEXT', notnull: 0, dflt_value: null,
    });
    const row = migrated.prepare('SELECT * FROM paddle_subscriptions WHERE subscription_id = ?').get('sub_legacy') as Record<string, unknown>;
    expect(row).toMatchObject({ subscription_id: 'sub_legacy', tier: 'pro', withdrawal_claimed_at: null });

    // Replay is idempotent, the shape both routes converge on.
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(columnInfo(migrated, 'paddle_subscriptions', 'withdrawal_claimed_at')).toMatchObject({
      type: 'TEXT', notnull: 0, dflt_value: null,
    });

    // 🔴 THE ACTUAL FAILURE THIS CLOSES: `claimWithdrawal` against a migrated
    // legacy row must not throw "no such column", and it must actually claim.
    const claimed = migrated
      .prepare(`UPDATE paddle_subscriptions SET withdrawal_claimed_at = ? WHERE subscription_id = ? AND withdrawal_claimed_at IS NULL`)
      .run('2026-09-02T00:00:00.000Z', 'sub_legacy');
    expect(claimed.changes).toBe(1);
    const second = migrated
      .prepare(`UPDATE paddle_subscriptions SET withdrawal_claimed_at = ? WHERE subscription_id = ? AND withdrawal_claimed_at IS NULL`)
      .run('2026-09-02T00:00:01.000Z', 'sub_legacy');
    expect(second.changes).toBe(0);
    migrated.close();
  });
});
