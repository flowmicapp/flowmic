// The PR-2 recovery domain's migration, asserted the way every other additive
// table in this repo is (test/migration-idempotency.test.ts is the pattern; this
// lives in its own file because that one stands at 1104 of the 1200-line cap).
//
// Three questions, and the third is the one this card is about:
//   ① do the two tables and their indexes appear on a database that predates them;
//   ② is a second migration a no-op (replayable, non-destructive — the standing
//      condition on DB changes, decisions/2026-08-12-owner-needle-closure §5 :92-94);
//   ③ do the two KEYS differ in the way §A7-2 requires — `(user, operation)` for
//      the registry, `(user, operation, kind)` for the metering ledger. A key that
//      quietly lost `kind` would let an operation's STT metering swallow its LLM
//      metering, and every functional test in the repo would still be green.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/connection';
import { LEGACY_USERS_PRE_D1, masterNames, schemaSnapshot } from './fixtures/migration-schema';

describe('card PR-2 — recovery_operations + usage_effects migration', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'flowmic-pr2-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('creates both tables (+ their indexes) on a database that predates them', () => {
    const dbPath = join(tmp, 'add-recovery.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-pr2', 'Before', 'free')");
    expect(masterNames(legacy, 'table')).not.toContain('recovery_operations');
    expect(masterNames(legacy, 'table')).not.toContain('usage_effects');
    legacy.close();

    const migrated = openDatabase(dbPath);
    expect(masterNames(migrated, 'table')).toEqual(
      expect.arrayContaining(['recovery_operations', 'usage_effects']),
    );
    expect(masterNames(migrated, 'index')).toEqual(
      expect.arrayContaining(['idx_recovery_operations_last_seen', 'idx_usage_effects_applied_at']),
    );
    // The pre-existing row is untouched — this migration adds, nothing else.
    expect(migrated.prepare("SELECT id FROM users WHERE id='u-pre-pr2'").get()).toEqual({ id: 'u-pre-pr2' });
    migrated.close();
  });

  it('is replayable: migrating twice changes neither the schema nor the rows', () => {
    const dbPath = join(tmp, 'replay-recovery.db');
    const first = openDatabase(dbPath);
    first.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-replay', 'R', 'free')");
    first.exec(
      `INSERT INTO recovery_operations
         (user_id, operation_id, recording_id, range_start_sample, range_end_sample,
          attempt_kind, mode, first_seen_at, last_seen_at, resend_count)
       VALUES ('u-replay','op-1','rec-1',0,16000,'live','realtime',1000,1000,0)`,
    );
    first.exec("INSERT INTO usage_effects (user_id, operation_id, kind, applied_at) VALUES ('u-replay','op-1','stt',1000)");
    const before = schemaSnapshot(first);
    first.close();

    const second = openDatabase(dbPath);
    expect(schemaSnapshot(second)).toEqual(before);
    expect(second.prepare('SELECT COUNT(*) AS n FROM recovery_operations').get()).toEqual({ n: 1 });
    expect(second.prepare('SELECT COUNT(*) AS n FROM usage_effects').get()).toEqual({ n: 1 });
    second.close();
  });

  it('🔴 the two primary keys differ by `kind` — the split §A7-2 requires', () => {
    const db = openDatabase(':memory:');
    const pk = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string; pk: number }[])
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    expect(pk('recovery_operations')).toEqual(['user_id', 'operation_id']);
    expect(pk('usage_effects')).toEqual(['user_id', 'operation_id', 'kind']);

    // And the consequence, stated as behaviour rather than as a shape: one
    // operation may hold BOTH metering markers, and may hold only one registry row.
    db.exec("INSERT INTO users (id, display_name, plan) VALUES ('u','U','free')");
    db.exec("INSERT INTO usage_effects (user_id, operation_id, kind, applied_at) VALUES ('u','op','stt',1)");
    db.exec("INSERT INTO usage_effects (user_id, operation_id, kind, applied_at) VALUES ('u','op','llm',1)");
    expect(db.prepare("SELECT COUNT(*) AS n FROM usage_effects WHERE operation_id='op'").get()).toEqual({ n: 2 });
    expect(() => db.exec(
      "INSERT INTO usage_effects (user_id, operation_id, kind, applied_at) VALUES ('u','op','stt',2)",
    )).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  it('🔴 both tables cascade with the account — the rows do not outlive the user', () => {
    // The privacy half. `recovery_operations` names which recording and which
    // sample range an account's attempt covered — a per-utterance trace — and
    // `usage_effects` names an account beside a metering fact. Seven-day
    // retention is a storage policy and not an erasure one, so the delete has to
    // reach them. (test/account-lifecycle.test.ts re-derives the same thing from
    // the live schema; this asserts the BEHAVIOUR, which is the half a census
    // cannot see.)
    const db = openDatabase(':memory:');
    db.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-gone','G','free')");
    db.exec(
      `INSERT INTO recovery_operations
         (user_id, operation_id, mode, first_seen_at, last_seen_at, resend_count)
       VALUES ('u-gone','op-x','realtime',1,1,0)`,
    );
    db.exec("INSERT INTO usage_effects (user_id, operation_id, kind, applied_at) VALUES ('u-gone','op-x','stt',1)");
    db.exec("DELETE FROM users WHERE id='u-gone'");
    expect(db.prepare('SELECT COUNT(*) AS n FROM recovery_operations').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_effects').get()).toEqual({ n: 0 });
    db.close();
  });
});
