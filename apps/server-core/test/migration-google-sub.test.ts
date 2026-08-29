// Card NR-1 — the `users.google_sub` migration: the guarded ADD COLUMN and the
// PARTIAL UNIQUE INDEX that go with it (db/connection.ts `reconcileSchema`).
//
// A SEPARATE FILE FROM test/migration-idempotency.test.ts, AND NOT BY PREFERENCE:
// that file stood at the 1200-line cap, so this block could not join its three
// siblings there (email_verified_at / restricted_at / last_login_at). The
// registry, the legacy `users` DDL and the schema-reading helpers are IMPORTED
// from test/fixtures/migration-schema.ts rather than re-declared — one `TABLES`
// array for the whole migration suite, for the reason that file's header gives.
//
// ⚠️ READ THE THREE SIBLINGS BESIDE THIS ONE. Four hand-written `users` column
// steps now sit next to each other in reconcileSchema, they look alike, and they
// backfill in FOUR different ways for four different reasons. Making them
// uniform is the failure this file and its neighbours exist to catch.
//
// *** SCHEMA-SENSITIVE (users, additive) ***

import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, reconcileSchema } from '../src/db/connection';
import { INIT_SQL } from '../src/db/schema';
import { columnInfo, LEGACY_USERS_PRE_D1, masterNames, schemaSnapshot } from './fixtures/migration-schema';

const tmp = mkdtempSync(join(tmpdir(), 'flowmic-mig-google-'));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('NR-1 migration: users.google_sub', () => {
  // ── NR-1 migration: users.google_sub + its partial UNIQUE index ────────────
  //
  // The FOURTH hand-written `users` column step, and the FIRST that is a column
  // AND an index. Four questions:
  // ① SHAPE — nullable TEXT with no default, and NO column-level UNIQUE (a
  //   fresh CREATE carrying one would not converge with the ALTER's shape);
  // ② 🔴 NO BACKFILL — the fourth distinct reason on this table: any value here
  //   would assert that a particular GOOGLE account belongs to a particular
  //   person, invented for rows that have never been near Google;
  // ③ 🔴 THE UNIQUE INDEX REALLY REFUSES A DUPLICATE — the whole point of the
  //   column is that 「which account is this Google identity」 has exactly one
  //   answer, and an index that exists but does not bite is worse than none;
  // ④ convergence + idempotency, as for every other column here.
  it('🔴 ALTERs google_sub onto a pre-NR-1 DB, backfills NOTHING, and the partial UNIQUE index really bites', () => {
    const dbPath = join(tmp, 'add-google-sub.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(LEGACY_USERS_PRE_D1);
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-google', 'Before NR-1', 'free')");
    legacy.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-pre-google-2', 'Also before', 'free')");
    expect(columnInfo(legacy, 'users', 'google_sub')).toBeUndefined();
    expect(masterNames(legacy, 'index')).not.toContain('idx_users_google_sub');
    legacy.close();

    // The migration: exactly what a deploy + restart runs.
    const migrated = openDatabase(dbPath);
    // ① Nullable TEXT, no default.
    expect(columnInfo(migrated, 'users', 'google_sub')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    });
    // ② 🔴 THE ONE THAT MATTERS: every pre-existing row is still NULL.
    expect(migrated.prepare('SELECT id, google_sub FROM users ORDER BY id').all()).toEqual([
      { id: 'u-pre-google', google_sub: null },
      { id: 'u-pre-google-2', google_sub: null },
    ]);
    // …with the same positive control the two blocks above use: the neighbouring
    // grandfather stamp really did run, so the NULLs are evidence about THIS step
    // rather than about a reconcile that did nothing at all.
    const stamped = migrated
      .prepare("SELECT email_verified_at FROM users WHERE id='u-pre-google'")
      .get() as { email_verified_at: number | null };
    expect(typeof stamped.email_verified_at, 'reconcile did not run — the NULLs above prove nothing').toBe('number');

    // ③ 🔴 The index exists AND refuses a second row carrying the same sub…
    expect(masterNames(migrated, 'index')).toContain('idx_users_google_sub');
    migrated.exec("UPDATE users SET google_sub='goog-abc' WHERE id='u-pre-google'");
    expect(() =>
      migrated.exec("UPDATE users SET google_sub='goog-abc' WHERE id='u-pre-google-2'"),
    ).toThrow(/UNIQUE/i);
    // …while STILL allowing any number of rows with NO Google identity, which is
    // every row on every deployment the day this ships (the partial predicate).
    migrated.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-post-google', 'After', 'free')");
    migrated.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-post-google-2', 'After too', 'free')");
    expect(migrated.prepare("SELECT google_sub FROM users WHERE id='u-post-google'").get()).toEqual({
      google_sub: null,
    });

    // A real binding survives a restart — otherwise every NULL assertion above
    // could be produced by a column nothing can write.
    migrated.exec(INIT_SQL);
    reconcileSchema(migrated);
    reconcileSchema(migrated);
    expect(migrated.prepare("SELECT google_sub FROM users WHERE id='u-pre-google'").get()).toEqual({
      google_sub: 'goog-abc',
    });
    expect(migrated.prepare("SELECT google_sub FROM users WHERE id='u-pre-google-2'").get()).toEqual({
      google_sub: null,
    });

    // ④ The forward-ported column is INDISTINGUISHABLE from a fresh CREATE's,
    // and so is the index — the half a column-level UNIQUE would have broken.
    const fresh = openDatabase(':memory:');
    const freshCol = columnInfo(fresh, 'users', 'google_sub');
    const col = columnInfo(migrated, 'users', 'google_sub')!;
    expect({ name: col.name, type: col.type, notnull: col.notnull, dflt_value: col.dflt_value }).toEqual({
      name: freshCol!.name,
      type: freshCol!.type,
      notnull: freshCol!.notnull,
      dflt_value: freshCol!.dflt_value,
    });
    expect(fresh.prepare('PRAGMA index_list(users)').all()).toEqual(
      migrated.prepare('PRAGMA index_list(users)').all(),
    );
    fresh.exec("INSERT INTO users (id, display_name, plan) VALUES ('u-fresh-g', 'Fresh', 'free')");
    expect(fresh.prepare("SELECT google_sub FROM users WHERE id='u-fresh-g'").get()).toEqual({ google_sub: null });
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
});
