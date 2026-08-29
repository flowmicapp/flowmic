// SPEC-REF:
//   apps/server-core/src/node/replica-puller.ts
//   apps/server-core/src/node/snapshot.ts
//
// Replication, end to end, against real sqlite on both sides — because every
// interesting failure here is a sqlite behaviour, not a JavaScript one, and a
// mocked database would assert only that the code calls the functions it calls.
//
// 🔴 THE ASSERTION THAT MATTERS MOST IS THE ONE ABOUT PREPARED STATEMENTS. The
// design's whole reason for importing into the live database rather than
// replacing the file is that `node:sqlite` holds statements against an inode: a
// rename leaves every one of them reading a file nobody is writing to any more,
// and the reads keep succeeding. That failure is invisible from inside the
// process, so it has to be asserted from outside.

import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeSnapshotProducer } from '../src/node/snapshot';
import { makeReplicaPuller } from '../src/node/replica-puller';

const silent = { info: () => {}, warn: () => {} };

function makePair(): { dir: string; writer: DatabaseSync; replica: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), 'repl-'));
  const schema = `
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE pcs (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), home_node TEXT);
  `;
  const writer = new DatabaseSync(join(dir, 'w.db'), { enableForeignKeyConstraints: true });
  writer.exec(schema);
  const replica = new DatabaseSync(join(dir, 'r.db'), { enableForeignKeyConstraints: true });
  replica.exec(schema);
  return { dir, writer, replica };
}

describe('replication: the writer snapshot lands in the live replica', () => {
  it('copies rows across, and 🔴 EXISTING PREPARED STATEMENTS SEE THEM', async () => {
    const { dir, writer, replica } = makePair();
    try {
      // Prepared BEFORE the pull, and deliberately never re-prepared. This is
      // the file-rename design failing in one line if anybody switches to it:
      // the statement would keep answering from the unlinked inode and return
      // the OLD row count forever, with no error anywhere.
      const countUsers = replica.prepare('SELECT COUNT(*) AS c FROM users');
      expect(Number((countUsers.get() as { c: number }).c)).toBe(0);

      writer.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u1', 'Ada');
      writer.prepare('INSERT INTO pcs (id, user_id, home_node) VALUES (?, ?, ?)').run('p1', 'u1', 'srvjp');

      const snapshot = makeSnapshotProducer(writer);
      const puller = makeReplicaPuller({
        db: replica,
        fetchSnapshot: snapshot,
        log: silent,
        stagePath: join(dir, 'stage.db'),
        setIntervalFn: () => null,
      });
      const tables = await puller.pull();

      expect(tables).toBe(2);
      expect(Number((countUsers.get() as { c: number }).c)).toBe(1);
      expect(replica.prepare('SELECT home_node FROM pcs WHERE id = ?').get('p1'))
        .toEqual({ home_node: 'srvjp' });
      expect(puller.lastAppliedAt()).not.toBeNull();
    } finally {
      writer.close();
      replica.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a row DELETED on the writer disappears from the replica', async () => {
    // Replication that only ever adds is a cache, not a replica — and the row
    // that matters here is a revoked pairing or a deleted account.
    const { dir, writer, replica } = makePair();
    try {
      writer.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u1', 'Ada');
      const puller = makeReplicaPuller({
        db: replica, fetchSnapshot: makeSnapshotProducer(writer), log: silent,
        stagePath: join(dir, 'stage.db'), setIntervalFn: () => null,
      });
      await puller.pull();
      writer.prepare('DELETE FROM users WHERE id = ?').run('u1');
      await puller.pull();
      expect(replica.prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 0 });
    } finally {
      writer.close();
      replica.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 foreign keys survive: a child table can be replaced before its parent', async () => {
    // The trap this is here for: with FKs on and no deferral, `DELETE FROM users`
    // throws while `pcs` still references it, and the table order is whatever
    // sqlite_master happens to return. Deferring to COMMIT keeps the constraint
    // AND makes the order irrelevant. Disabling FKs would also pass this test —
    // and would let a genuinely broken snapshot land silently, which is why the
    // implementation defers rather than disables.
    const { dir, writer, replica } = makePair();
    try {
      replica.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('old', 'Stale');
      replica.prepare('INSERT INTO pcs (id, user_id, home_node) VALUES (?, ?, ?)').run('oldpc', 'old', 'srvny');
      writer.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u2', 'Grace');
      writer.prepare('INSERT INTO pcs (id, user_id, home_node) VALUES (?, ?, ?)').run('p2', 'u2', 'srvjp');
      const puller = makeReplicaPuller({
        db: replica, fetchSnapshot: makeSnapshotProducer(writer), log: silent,
        stagePath: join(dir, 'stage.db'), setIntervalFn: () => null,
      });
      await expect(puller.pull()).resolves.toBe(2);
      expect(replica.prepare('SELECT id FROM pcs').all()).toEqual([{ id: 'p2' }]);
    } finally {
      writer.close();
      replica.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 a failed import leaves the replica EXACTLY as it was', async () => {
    // Half a database is worse than an old one: an old replica is consistent and
    // merely behind, a half-imported one is neither and nothing says so.
    const { dir, writer, replica } = makePair();
    try {
      replica.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('keep', 'Existing');
      const puller = makeReplicaPuller({
        db: replica,
        // A snapshot whose shape this build cannot accept: an extra column makes
        // `INSERT INTO main.users SELECT * FROM snap.users` fail mid-transaction,
        // which is exactly the rolling-deploy case (writer ahead of replica).
        fetchSnapshot: async () => {
          const other = new DatabaseSync(join(dir, 'ahead.db'));
          other.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT)');
          other.prepare('INSERT INTO users VALUES (?, ?, ?)').run('u9', 'New', 'a@b.c');
          const produce = makeSnapshotProducer(other);
          const bytes = await produce();
          other.close();
          return bytes;
        },
        log: silent,
        stagePath: join(dir, 'stage.db'),
        setIntervalFn: () => null,
      });
      await expect(puller.pull()).rejects.toThrow();
      expect(replica.prepare('SELECT id FROM users').all()).toEqual([{ id: 'keep' }]);
      expect(puller.lastAppliedAt()).toBeNull();
      // And the next pull must still work — a failed import that left the
      // snapshot ATTACHed would turn one bad payload into a permanent outage.
      const good = makeReplicaPuller({
        db: replica, fetchSnapshot: makeSnapshotProducer(writer), log: silent,
        stagePath: join(dir, 'stage2.db'), setIntervalFn: () => null,
      });
      await expect(good.pull()).resolves.toBeGreaterThan(0);
    } finally {
      writer.close();
      replica.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 refuses a body that is not a database, instead of importing it', async () => {
    // An HTML error page from a proxy is a completely ordinary thing to receive
    // on this route, and ATTACHing one produces an error three layers from the
    // cause. Named here instead.
    const { dir, writer, replica } = makePair();
    try {
      const puller = makeReplicaPuller({
        db: replica,
        fetchSnapshot: async () => Buffer.from('<html>502 Bad Gateway</html>'),
        log: silent, stagePath: join(dir, 'stage.db'), setIntervalFn: () => null,
      });
      await expect(puller.pull()).rejects.toThrow(/not a sqlite database/);
    } finally {
      writer.close();
      replica.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the snapshot is gzipped, and the puller accepts it either way', async () => {
    const { dir, writer, replica } = makePair();
    try {
      writer.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u1', 'Ada');
      const bytes = await makeSnapshotProducer(writer)();
      expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
      const puller = makeReplicaPuller({
        db: replica, fetchSnapshot: async () => bytes, log: silent,
        stagePath: join(dir, 'stage.db'), setIntervalFn: () => null,
      });
      await puller.pull();
      expect(replica.prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 1 });
    } finally {
      writer.close();
      replica.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
