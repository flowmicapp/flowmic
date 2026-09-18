// owner 2026-09-17 — `trial_ledger_archive`, the table the anonymous sweep
// copies a row into one statement before it destroys it.
//
// SPEC-REF:
//   docs/decisions/2026-09-17-owner-enables-anon-trial-cleanup-with-archive.md
//   src/db/schema-trial.ts TRIAL_ARCHIVE_SQL · src/db/repos/trial-archive.repo.ts
//
// 🔴 A SCHEMA CHANGE ON A DEPLOYED DATABASE, so the questions are the ones the
// 2026-09-10 JP crash-loop taught: does opening an EXISTING database twice do
// nothing the second time, does it destroy anything, and is the shape actually
// the shape the copy statement assumes.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection';
import { makeTrialArchiveRepo } from '../src/db/repos/trial-archive.repo';

let dir: string;
let path: string;
let db: DatabaseSync;

const columnsOf = (handle: DatabaseSync, table: string): string[] =>
  (handle.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[])
    .map((c) => c.name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowmic-trial-archive-'));
  path = join(dir, 'archive.sqlite');
  db = openDatabase(path);
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the migration', () => {
  it('🔴 is idempotent: opening the same database again changes nothing', () => {
    db.prepare(
      `INSERT INTO trial_ledger_archive
         (anon_user_id, ip_bucket, day, grants_used, ms_granted, anon_token,
          token_expires_at, created_at, device_uid, swept_at)
       VALUES ('anon-1','bucket','2026-09-17',0,120000,'fm_1',1,'2026-09-15T00:00:00.000Z','wb-1','2026-09-17T00:00:00.000Z')`,
    ).run();
    db.close();

    // The replay. `openDatabase` runs INIT_SQL and reconcileSchema on EVERY
    // boot, so this is literally what the next restart does.
    db = openDatabase(path);
    expect(db.prepare('SELECT COUNT(*) AS n FROM trial_ledger_archive').get()).toEqual({ n: 1 });
    // And a third time, because 「ran twice」 is a weaker claim than 「replayable」.
    db.close();
    db = openDatabase(path);
    expect(db.prepare('SELECT anon_user_id FROM trial_ledger_archive').get())
      .toEqual({ anon_user_id: 'anon-1' });
  });

  it('adds the table to a database that predates it, and takes nothing with it', () => {
    // A deployment upgraded from a release before this table existed — the state
    // both production nodes are in right now. Reproduced by removing it.
    db.prepare("INSERT INTO users (id, created_at, anonymous) VALUES ('keep-me','2026-09-01T00:00:00.000Z',1)").run();
    db.exec('DROP TABLE trial_ledger_archive');
    db.close();

    db = openDatabase(path);
    expect(columnsOf(db, 'trial_ledger_archive').length).toBeGreaterThan(0);
    // 🔴 The other half of 「non-destructive」: the upgrade did not take a row
    // with it. A migration that recreated the world would pass the line above.
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });
});

describe('the shape the copy statement assumes', () => {
  it('🔴 is trial_ledger column for column, plus swept_at', () => {
    // The standing check behind 「the archive IS the row that was deleted」. If
    // someone gives `trial_ledger` a column and not this table, the copy in
    // trial-archive.repo.ts would keep working and would quietly stop carrying
    // it — this is the thing that fails instead.
    //
    // 🔴 AS A SET, NOT AS A SEQUENCE, and that is not laziness — an ordered
    // comparison here is a WRONG RULER. `device_uid` sits sixth in the DDL on a
    // fresh database and LAST on a database that grew it through the ALTER loop
    // (NR-22 measured the same non-convergence between the two production
    // nodes), so an ordered assertion would report a difference that exists
    // between two correct databases. What the copy statement depends on is the
    // set of NAMES: it writes both column lists out and sqlite matches them by
    // name (trial-archive.repo.ts).
    //
    // 〔measured here, the first time this was written as `toEqual` on the
    // ordered lists: fresh order is …ms_granted, device_uid, anon_token…, and
    // the archive's own DDL order is …ms_granted, anon_token, …, device_uid.〕
    expect([...columnsOf(db, 'trial_ledger_archive')].sort())
      .toEqual([...columnsOf(db, 'trial_ledger'), 'swept_at'].sort());
  });

  it('🔴 has NO foreign key, so the delete it records cannot erase it', () => {
    // The archive row is written inside the transaction that deletes the
    // `users` row it names. A `REFERENCES users(id) ON DELETE CASCADE` here
    // would cascade it away in that same statement, and the symptom would be an
    // archive that is always empty while every count agrees it worked.
    expect(db.prepare('PRAGMA foreign_key_list(trial_ledger_archive)').all()).toEqual([]);
    // The source table, by contrast, HAS one — so this is not a test that would
    // pass on any table at all.
    expect(db.prepare('PRAGMA foreign_key_list(trial_ledger)').all()).not.toEqual([]);
  });

  it('accepts a second row for an identity that is long gone', () => {
    // No primary key, deliberately (schema-trial.ts): a unique constraint could
    // only fire on a repeat of an id that no longer exists, and its effect would
    // be to abort a whole sweep transaction for ever.
    const repo = makeTrialArchiveRepo(db);
    expect(repo.count()).toBe(0);
    const insert = db.prepare(
      `INSERT INTO trial_ledger_archive
         (anon_user_id, ip_bucket, day, grants_used, ms_granted, anon_token,
          token_expires_at, created_at, device_uid, swept_at)
       VALUES ('anon-dup','bucket','2026-09-17',0,0,NULL,1,'2026-09-15T00:00:00.000Z',NULL,?)`,
    );
    insert.run('2026-09-17T00:00:00.000Z');
    insert.run('2026-09-18T00:00:00.000Z');
    expect(repo.count()).toBe(2);
  });
});

// ── owner 2026-09-17, second half: `usage_records_archive` ──────────────────
// The same three questions, asked of the meter's archive. They are asked
// separately rather than parameterised over both tables because the answers
// differ in one place that matters: this table's source has a COMPOSITE primary
// key, so "one row per identity" is false here and the copy is a range.
describe('the meter archive migration', () => {
  const seed = (sweptAt: string, month = '2026-09'): void => {
    db.prepare(
      `INSERT INTO usage_records_archive
         (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at,
          swept_at)
       VALUES ('anon-1',?,1.5,10,20,'2026-09-15T00:00:00.000Z',?)`,
    ).run(month, sweptAt);
  };

  it('🔴 is idempotent: opening the same database again changes nothing', () => {
    seed('2026-09-17T00:00:00.000Z');
    db.close();
    db = openDatabase(path);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_records_archive').get()).toEqual({ n: 1 });
    db.close();
    db = openDatabase(path);
    expect(db.prepare('SELECT stt_minutes FROM usage_records_archive').get())
      .toEqual({ stt_minutes: 1.5 });
  });

  it('adds the table to a database that predates it, and takes nothing with it', () => {
    // The state both production nodes are in right now, reproduced by removal.
    db.prepare("INSERT INTO users (id, created_at, anonymous) VALUES ('keep-me','2026-09-01T00:00:00.000Z',1)").run();
    db.exec('DROP TABLE usage_records_archive');
    db.close();

    db = openDatabase(path);
    expect(columnsOf(db, 'usage_records_archive').length).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
  });

  it('🔴 is usage_records column for column, plus swept_at', () => {
    // As a SET, for the reason its sibling's version of this test states: column
    // ORDER differs between a fresh database and one grown through the ALTER
    // loop, and an ordered assertion would be the wrong ruler. What the copy in
    // repos/usage-archive.repo.ts depends on is the set of NAMES.
    expect([...columnsOf(db, 'usage_records_archive')].sort())
      .toEqual([...columnsOf(db, 'usage_records'), 'swept_at'].sort());
  });

  it('🔴 has NO foreign key, so the cascade it records cannot erase it', () => {
    // `usage_records` cascades from `users`. If this table copied that FK out of
    // symmetry, every archive row would be erased by the very DELETE that wrote
    // it — and the symptom would be an empty archive with every count agreeing.
    expect(db.prepare('PRAGMA foreign_key_list(usage_records_archive)').all()).toEqual([]);
    // The source HAS one, so this is not a test that passes on any table.
    expect(db.prepare('PRAGMA foreign_key_list(usage_records)').all()).not.toEqual([]);
  });

  it('accepts the same (identity, month) twice', () => {
    // No primary key, deliberately. `usage_records` is keyed on
    // (user_id, month); copying that key here would let ONE anomalous repeat —
    // of an identity that no longer exists — abort a whole sweep transaction
    // for ever, trading a duplicate record for a retention promise.
    seed('2026-09-17T00:00:00.000Z');
    seed('2026-09-18T00:00:00.000Z');
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_records_archive').get()).toEqual({ n: 2 });
  });
});
