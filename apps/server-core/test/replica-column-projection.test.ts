// SPEC-REF:
//   apps/server-core/src/node/replica-puller.ts (header: NR-22-REFUSAL-RULE)
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md §9
//
// NR-22 — the replica copy must map by column NAME, never by position.
//
// 🔴 THE REVERSE CONTROL FOR THIS CARD IS THE WHOLE FILE, and it was actually
// red against the old `INSERT INTO main.t SELECT * FROM snap.t`:
//   · the "writer has one more column" case died with the production sentence
//     itself — `table main.users has 2 columns but 3 values were supplied`;
//   · the "same columns, different order" case did NOT die. It passed silently
//     and put the name in the id column, which is the failure this card exists
//     to stop and the one nobody would ever have seen in a log.
//
// Real sqlite on both sides, for the reason replica-replication.test.ts states:
// every interesting failure here is a sqlite behaviour, not a JavaScript one.

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeSnapshotProducer } from '../src/node/snapshot';
import { makeReplicaPuller } from '../src/node/replica-puller';

interface Note { msg: string; meta?: Record<string, unknown> }

function recorder(): { log: { info(m: string, x?: Record<string, unknown>): void; warn(m: string, x?: Record<string, unknown>): void }; warns: Note[]; infos: Note[] } {
  const warns: Note[] = [];
  const infos: Note[] = [];
  return {
    warns,
    infos,
    log: {
      info: (msg, meta) => { infos.push({ msg, ...(meta ? { meta } : {}) }); },
      warn: (msg, meta) => { warns.push({ msg, ...(meta ? { meta } : {}) }); },
    },
  };
}

/** A writer and a replica whose `users` tables are declared INDEPENDENTLY —
 *  which is the entire point: on a real deployment one end grew its columns
 *  through ALTERs and the other was created fresh from INIT_SQL. */
function makeEnds(writerDdl: string, replicaDdl: string): { dir: string; writer: DatabaseSync; replica: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), 'nr22-'));
  const writer = new DatabaseSync(join(dir, 'w.db'));
  writer.exec(writerDdl);
  const replica = new DatabaseSync(join(dir, 'r.db'));
  replica.exec(replicaDdl);
  return { dir, writer, replica };
}

function close(ends: { dir: string; writer: DatabaseSync; replica: DatabaseSync }): void {
  ends.writer.close();
  ends.replica.close();
  rmSync(ends.dir, { recursive: true, force: true });
}

describe('NR-22: the replica copy is projected by column name', () => {
  it('🔴 a writer column this build does not have is IGNORED, not fatal — and the rest still lands', async () => {
    // The production failure, verbatim: 「replica pull FAILED … table main.users
    // has 14 columns but 15 values were supplied」. The writer shipped one extra
    // column first and the replica could pull NOTHING — not just `users`,
    // because one pull is one transaction.
    const ends = makeEnds(
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, verify_grace_until TEXT)',
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)',
    );
    try {
      ends.writer.prepare('INSERT INTO users VALUES (?, ?, ?)').run('u1', 'Ada', '2026-09-09');
      const rec = recorder();
      const puller = makeReplicaPuller({
        db: ends.replica,
        fetchSnapshot: makeSnapshotProducer(ends.writer),
        log: rec.log,
        stagePath: join(ends.dir, 'stage.db'),
        setIntervalFn: () => null,
      });

      await expect(puller.pull()).resolves.toBe(1);
      // (a) no value landed in the wrong column.
      expect(ends.replica.prepare('SELECT id, name FROM users').all()).toEqual([{ id: 'u1', name: 'Ada' }]);
      // (b) and the drop is NAMED. Silence here would let a replica serve an
      //     out-of-date shape for ever while reporting healthy pulls.
      const ahead = rec.warns.find((w) => w.msg.includes('the writer has columns this build does not'));
      expect(ahead?.meta).toMatchObject({ table: 'users', columns: ['verify_grace_until'] });

      // Latched: the same shape does not re-warn every 30 seconds.
      await puller.pull();
      expect(rec.warns.filter((w) => w.msg.includes('the writer has columns this build does not'))).toHaveLength(1);
    } finally {
      close(ends);
    }
  });

  it('🔴 the SAME columns in a DIFFERENT ORDER do not swap values — the silent half of NR-22', async () => {
    // A replica first built from INIT_SQL can order its columns differently from
    // a writer that grew them through ALTERs. Positionally this throws NOTHING:
    // both columns are TEXT, so the name lands in `id` and the id in `name` and
    // every gate stays green.
    const ends = makeEnds(
      'CREATE TABLE users (name TEXT, id TEXT PRIMARY KEY, note TEXT)',
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, note TEXT)',
    );
    try {
      ends.writer.prepare('INSERT INTO users (id, name, note) VALUES (?, ?, ?)').run('u1', 'Ada', 'n');
      const rec = recorder();
      const puller = makeReplicaPuller({
        db: ends.replica,
        fetchSnapshot: makeSnapshotProducer(ends.writer),
        log: rec.log,
        stagePath: join(ends.dir, 'stage.db'),
        setIntervalFn: () => null,
      });

      await expect(puller.pull()).resolves.toBe(1);
      const row = ends.replica.prepare('SELECT id, name, note FROM users').get();
      expect(row).toEqual({ id: 'u1', name: 'Ada', note: 'n' });
      // Spelled out separately, because `toEqual` above would also be satisfied
      // by a test that agreed with the defect if it were ever rewritten: the id
      // column must hold an id, not a name.
      expect((row as { id: string }).id).not.toBe('Ada');

      // NR-22-ORDER-CHECK: safe now, recorded anyway — it is the only evidence
      // anybody will ever get that the two ends were built by different routes.
      const note = rec.warns.find((w) => w.msg.includes('different order on the two ends'));
      expect(note?.meta).toMatchObject({ table: 'users' });
    } finally {
      close(ends);
    }
  });

  it('🔴 REFUSES when the writer cannot supply a column this build requires — and applies nothing', async () => {
    // NR-22-REFUSAL-RULE 2(a). This is the replica-ahead-of-writer direction,
    // which the new deploy order (RELEASE-IRONRULES §1-23) makes the NORMAL one.
    // Refusing is the same failure mode this file already had: one transaction,
    // so nothing is applied and the latched WARN says the copy is ageing.
    const ends = makeEnds(
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)',
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, tier TEXT NOT NULL)',
    );
    try {
      ends.replica.prepare('INSERT INTO users VALUES (?, ?, ?)').run('keep', 'Existing', 'free');
      ends.writer.prepare('INSERT INTO users VALUES (?, ?)').run('u9', 'New');
      const rec = recorder();
      const puller = makeReplicaPuller({
        db: ends.replica,
        fetchSnapshot: makeSnapshotProducer(ends.writer),
        log: rec.log,
        stagePath: join(ends.dir, 'stage.db'),
        setIntervalFn: () => null,
      });

      await expect(puller.pull()).rejects.toThrow(/REFUSED \(NR-22\).*"tier"/s);
      // The refusal did not corrupt and did not half-apply.
      expect(ends.replica.prepare('SELECT id, name, tier FROM users').all())
        .toEqual([{ id: 'keep', name: 'Existing', tier: 'free' }]);
      expect(puller.lastAppliedAt()).toBeNull();
    } finally {
      close(ends);
    }
  });

  it('🔴 REFUSES when the writer has no primary-key column, instead of inserting NULL identities', async () => {
    // NR-22-REFUSAL-RULE 2(b), and it is not redundant with 2(a): sqlite leaves
    // a `TEXT PRIMARY KEY` NULLABLE, so without this clause the projection would
    // succeed and fill the identity column of every row with NULL.
    const ends = makeEnds(
      'CREATE TABLE users (name TEXT)',
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)',
    );
    try {
      ends.replica.prepare('INSERT INTO users VALUES (?, ?)').run('keep', 'Existing');
      ends.writer.prepare('INSERT INTO users VALUES (?)').run('Grace');
      const rec = recorder();
      const puller = makeReplicaPuller({
        db: ends.replica,
        fetchSnapshot: makeSnapshotProducer(ends.writer),
        log: rec.log,
        stagePath: join(ends.dir, 'stage.db'),
        setIntervalFn: () => null,
      });

      await expect(puller.pull()).rejects.toThrow(/REFUSED \(NR-22\).*"id"/s);
      expect(ends.replica.prepare('SELECT id, name FROM users').all())
        .toEqual([{ id: 'keep', name: 'Existing' }]);
    } finally {
      close(ends);
    }
  });

  it('a refusal does not become a permanent outage: the next good snapshot applies', async () => {
    // The snapshot must be DETACHed and the stage file removed on the refusal
    // path too, or one bad shape freezes this node until it is restarted.
    const ends = makeEnds(
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)',
      'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, tier TEXT NOT NULL)',
    );
    try {
      ends.writer.prepare('INSERT INTO users VALUES (?, ?)').run('u9', 'New');
      const rec = recorder();
      const bad = makeReplicaPuller({
        db: ends.replica,
        fetchSnapshot: makeSnapshotProducer(ends.writer),
        log: rec.log,
        stagePath: join(ends.dir, 'stage.db'),
        setIntervalFn: () => null,
      });
      await expect(bad.pull()).rejects.toThrow(/REFUSED \(NR-22\)/);

      // The writer catches up: now it has `tier` too.
      ends.writer.exec("ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'");
      const good = makeReplicaPuller({
        db: ends.replica,
        fetchSnapshot: makeSnapshotProducer(ends.writer),
        log: rec.log,
        stagePath: join(ends.dir, 'stage2.db'),
        setIntervalFn: () => null,
      });
      await expect(good.pull()).resolves.toBe(1);
      expect(ends.replica.prepare('SELECT id, name, tier FROM users').all())
        .toEqual([{ id: 'u9', name: 'New', tier: 'free' }]);
    } finally {
      close(ends);
    }
  });
});
