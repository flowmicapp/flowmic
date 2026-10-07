// NR-161: WAL permits concurrent readers, but writers still need a bounded busy wait.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection';

function holdWriteLock(file: string) {
  const shared = new SharedArrayBuffer(8);
  const state = new Int32Array(shared);
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const state = new Int32Array(workerData.shared);
    const db = new DatabaseSync(workerData.file);
    try {
      db.exec('BEGIN IMMEDIATE; UPDATE lock_probe SET value=7');
      Atomics.store(state, 0, 1); Atomics.notify(state, 0);
      Atomics.wait(state, 1, 0, 10_000);
      Atomics.wait(state, 0, 1, 200);
      db.exec('COMMIT');
    } catch (error) {
      Atomics.store(state, 0, -1); Atomics.notify(state, 0); throw error;
    } finally { db.close(); }
  `, { eval: true, workerData: { file, shared } });
  const done = new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  });
  const deadline = Date.now() + 10_000;
  while (Atomics.load(state, 0) === 0 && Date.now() < deadline) Atomics.wait(state, 0, 0, 100);
  expect(Atomics.load(state, 0)).toBe(1);
  const releaseSoon = () => { Atomics.store(state, 1, 1); Atomics.notify(state, 1); };
  return { done, releaseSoon };
}

async function withDatabase(run: (file: string, db: DatabaseSync) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'flowmic-nr161-'));
  const file = join(dir, 'contention.sqlite');
  const db = openDatabase(file);
  try {
    db.exec('CREATE TABLE lock_probe (value INTEGER); INSERT INTO lock_probe VALUES (0)');
    await run(file, db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('NR-161 SQLite busy handling', () => {
  it('reads during a WAL writer and waits for that writer before updating', async () => {
    await withDatabase(async (file, db) => {
      const writer = holdWriteLock(file);
      try {
        expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
        expect(db.prepare('SELECT value FROM lock_probe').get()).toMatchObject({ value: 0 });
        writer.releaseSoon();
        db.exec('UPDATE lock_probe SET value=value+1');
        expect(db.prepare('SELECT value FROM lock_probe').get()).toMatchObject({ value: 8 });
        expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
      } finally { writer.releaseSoon(); await writer.done; }
    });
  });

  it('installs the busy wait before startup migrations encounter another writer', async () => {
    await withDatabase(async (file, db) => {
      // Make reconcileSchema perform real DDL, even on a current database.
      db.exec('DROP INDEX idx_pc_devices_web_room_owner');
      const writer = holdWriteLock(file);
      let reopened: DatabaseSync | undefined;
      try {
        writer.releaseSoon();
        reopened = openDatabase(file);
        expect(reopened.prepare('SELECT value FROM lock_probe').get()).toMatchObject({ value: 7 });
        expect(reopened.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
      } finally {
        reopened?.close();
        writer.releaseSoon();
        await writer.done;
      }
    });
  });
});
