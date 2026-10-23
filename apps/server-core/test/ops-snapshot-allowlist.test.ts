// SPEC-REF:
//   docs/strategy/2026-08-31-lan-ops-console-third-party-spec.md §4.5.3 (the column list)
//   apps/server-core/src/node/ops-snapshot.ts (OPS_SNAPSHOT_TABLES, the producer)
//
// WHAT LEAVES THE BUILDING IN THE OPS CONSOLE'S SLIM SNAPSHOT.
//
// 🔴 THE EXPECTATION IS GENERATED FROM THE LIVE SCHEMA, NOT WRITTEN DOWN HERE.
// Every table and column the production schema has today (openDatabase + the
// writer's forward ledger) gets a row whose every column holds a unique marker
// string `LEAK~<table>.<column>~`. The slim file is then checked two ways:
//   · structurally — each table's column list is EXACTLY the allowlist entry;
//   · by bytes — no marker of a non-allowlisted column appears anywhere in the
//     uncompressed file, which also catches a value smuggled out under another
//     name or left in a freed page.
// So the day somebody adds `users.some_new_secret`, this suite seeds it, finds
// it absent, and stays green; the day somebody allowlists it by mistake (or
// copies a whole table), the marker shows up and the suite goes red naming it.
//
// ⚠️ EVERY ABSENCE HAS ITS POSITIVE CONTROL: the markers of ALLOWLISTED columns
// must be present in the same bytes, or 「no leak found」 could be a blind scan.
//
// 🔴 REVERSE CONTROLS, RUN AND SEEN RED (2026-10-11, lane/ops-snapshot), each by
// editing src/node/ops-snapshot.ts, running only this file, then restoring:
//   · 'mobile_token' added to the mobile_pairings allowlist entry ⇒ red;
//   · `ORDER BY` dropped from the copy and rows inserted out of key order ⇒
//     the determinism test is red;
//   (the exact failure lines are in the audit queue row for this change).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection';
import { FORWARD_LEDGER_DDL } from '../src/node/forward-ledger';
import {
  OPS_SNAPSHOT_DERIVED,
  OPS_SNAPSHOT_TABLES,
  makeOpsSnapshotProducer,
  type OpsSnapshotOutcome,
} from '../src/node/ops-snapshot';

const { DatabaseSync: Ctor } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseSync;
};

/** Credentials and ciphertext that must never be in the console's copy. Kept
 *  here as a SECOND, independent statement: the allowlist must not intersect it
 *  even if somebody edits both the allowlist and the spec at once. */
const NEVER = [
  'users.password_hash', 'users.google_sub', 'pc_devices.device_token', 'pc_devices.short_code',
  'pc_devices.room_uuid', 'mobile_pairings.mobile_token', 'trial_ledger.anon_token',
  'trial_ledger_archive.anon_token', 'email_verifications.code_hash', 'timeline_blobs.ciphertext',
  'timeline_keymeta.salt_b64', 'timeline_keymeta.sentinel', 'integrator_keys.publishable_key',
  'user_settings.value',
];

const marker = (table: string, column: string): string => `LEAK~${table}.${column}~`;

let dir = '';
let db: DatabaseSync;

function liveSchema(d: DatabaseSync): Map<string, string[]> {
  const tables = (d.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as { name: string }[]).map((r) => r.name);
  const out = new Map<string, string[]>();
  for (const t of tables) {
    out.set(t, (d.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name));
  }
  return out;
}

/** Columns that cannot hold a text marker: an INTEGER PRIMARY KEY (a rowid
 *  alias) and any numeric column of a STRICT table. They get the integer 1 and
 *  are checked structurally only — the byte scan cannot see a bare integer. */
function unmarkable(d: DatabaseSync, table: string): Set<string> {
  const strict = (d.prepare('SELECT strict FROM pragma_table_list WHERE name = ?').get(table) as { strict: number } | undefined)?.strict === 1;
  const info = d.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string; pk: number }[];
  const pkCount = info.filter((c) => c.pk > 0).length;
  return new Set(info.filter((c) => {
    const type = c.type.toUpperCase();
    if (c.pk > 0 && pkCount === 1 && type === 'INTEGER') return true;
    return strict && (type === 'INTEGER' || type === 'INT' || type === 'REAL');
  }).map((c) => c.name));
}

/** One marker row per table, every markable column a marker. Foreign keys off
 *  so the rows need not reference each other; a CHECK constraint would fail
 *  loudly here rather than silently seed less. */
function seedMarkers(d: DatabaseSync): void {
  d.exec('PRAGMA foreign_keys = OFF');
  for (const [table, cols] of liveSchema(d)) {
    const numeric = unmarkable(d, table);
    const values = cols.map((c) => (numeric.has(c) || (table === 'timeline_blobs' && c === 'deleted') ? (c === 'deleted' ? 0 : 1) : marker(table, c)));
    d.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...values);
  }
}

async function produce(d: DatabaseSync, inm?: string, now = () => 1_760_000_000_000): Promise<OpsSnapshotOutcome> {
  return makeOpsSnapshotProducer(d, { now })(inm);
}

function openSlim(raw: Buffer): DatabaseSync {
  const p = join(dir, `slim-${Math.random().toString(36).slice(2)}.db`);
  writeFileSync(p, raw);
  return new Ctor(p, { readOnly: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ops-snapshot-'));
  db = openDatabase(join(dir, 'live.db'));
  db.exec(FORWARD_LEDGER_DDL);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ops snapshot — column allowlist, generated from the live schema', () => {
  it('the allowlist names only columns the live schema has, and none of the NEVER list', () => {
    const schema = liveSchema(db);
    for (const t of OPS_SNAPSHOT_TABLES) {
      expect(schema.has(t.table), `allowlisted table ${t.table} is not in the schema`).toBe(true);
      for (const c of [...t.columns, ...t.orderBy]) {
        expect(schema.get(t.table), `${t.table}.${c} is not in the schema`).toContain(c);
      }
      for (const c of t.columns) {
        expect(NEVER, `${t.table}.${c} is a credential and must not be allowlisted`).not.toContain(`${t.table}.${c}`);
      }
    }
    // The NEVER list itself must name real columns, or it guards nothing.
    for (const tc of NEVER) {
      const [t, c] = tc.split('.') as [string, string];
      expect(schema.get(t), `NEVER entry ${tc} names no live column`).toContain(c);
    }
  });

  it('🔴 every table in the slim file has EXACTLY its allowlisted columns, and nothing else is in it', async () => {
    seedMarkers(db);
    const out = await produce(db);
    expect(out.status).toBe('fresh');
    if (out.status !== 'fresh') return;
    const slim = openSlim(gunzipSync(out.body));
    try {
      const got = liveSchema(slim);
      const want = new Map<string, string[]>(OPS_SNAPSHOT_TABLES.map((t) => [t.table, [...t.columns]]));
      want.set(OPS_SNAPSHOT_DERIVED.table, [...OPS_SNAPSHOT_DERIVED.columns]);
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
      for (const [t, cols] of got) expect(cols, `columns of ${t}`).toEqual(want.get(t));
      // No index, view or trigger rode along.
      const other = slim.prepare("SELECT type, name FROM sqlite_master WHERE type <> 'table'").all();
      expect(other).toEqual([]);
    } finally {
      slim.close();
    }
  });

  it('🔴 no marker of a non-allowlisted column is in the bytes — with every allowlisted marker present as the control', async () => {
    seedMarkers(db);
    const schema = liveSchema(db);
    const out = await produce(db);
    if (out.status !== 'fresh') throw new Error('expected a fresh snapshot');
    const raw = gunzipSync(out.body).toString('latin1');
    const allowed = new Set(OPS_SNAPSHOT_TABLES.flatMap((t) => t.columns.map((c) => `${t.table}.${c}`)));
    const leaked: string[] = [];
    const missing: string[] = [];
    for (const [t, cols] of schema) {
      const numeric = unmarkable(db, t);
      for (const c of cols) {
        if (numeric.has(c) || (t === 'timeline_blobs' && c === 'deleted')) continue;
        const present = raw.includes(marker(t, c));
        if (allowed.has(`${t}.${c}`)) {
          if (!present) missing.push(`${t}.${c}`);
        } else if (present) {
          // timeline_blobs.user_id legitimately reappears as the derived
          // table's key; it is the ONE value the totals table is keyed by.
          if (!(t === 'timeline_blobs' && c === 'user_id')) leaked.push(`${t}.${c}`);
        }
      }
    }
    expect(missing, 'positive control: allowlisted values must be in the file').toEqual([]);
    expect(leaked, 'columns outside the allowlist found in the slim snapshot').toEqual([]);
    // Spelled out for the credentials, in case the loop above is ever narrowed.
    for (const tc of NEVER) {
      const [t, c] = tc.split('.') as [string, string];
      expect(unmarkable(db, t).has(c), `${tc} could not be seeded with a marker, so its absence proves nothing`).toBe(false);
      expect(raw.includes(marker(t, c)), `${tc} leaked`).toBe(false);
    }
  });

  it('timeline_blob_totals counts only non-deleted blobs and sums their ciphertext length', async () => {
    const ins = db.prepare('INSERT INTO timeline_blobs (id, user_id, seq, ciphertext, created_at, schema_ver, deleted) VALUES (?,?,?,?,?,1,?)');
    db.exec('PRAGMA foreign_keys = OFF');
    ins.run('b1', 'u1', 1, 'e2e:v1:aaaa', 1, 0);
    ins.run('b2', 'u1', 2, 'e2e:v1:bbbbbbbb', 2, 0);
    ins.run('b3', 'u1', 3, 'e2e:v1:deleted', 3, 1);
    ins.run('b4', 'u2', 1, 'e2e:v1:x', 4, 1);
    const out = await produce(db);
    if (out.status !== 'fresh') throw new Error('expected a fresh snapshot');
    const raw = gunzipSync(out.body);
    expect(raw.toString('latin1')).not.toContain('e2e:v1:');
    const slim = openSlim(raw);
    try {
      expect(slim.prepare('SELECT user_id, n, bytes FROM timeline_blob_totals ORDER BY user_id').all())
        .toEqual([{ user_id: 'u1', n: 2, bytes: 'e2e:v1:aaaa'.length + 'e2e:v1:bbbbbbbb'.length }]);
    } finally {
      slim.close();
    }
  });

  it('the live database is read, never written (a second connection sees no commit)', async () => {
    seedMarkers(db);
    const other = new Ctor(join(dir, 'live.db'));
    try {
      const before = (other.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
      await produce(db);
      const after = (other.prepare('PRAGMA data_version').get() as { data_version: number }).data_version;
      expect(after).toBe(before);
      // The private file is detached again: the live connection sees only main (+ temp).
      const names = (db.prepare('PRAGMA database_list').all() as { name: string }[]).map((r) => r.name);
      expect(names).not.toContain('ops_slim');
    } finally {
      other.close();
    }
  });
});

describe('ops snapshot — content-hash ETag', () => {
  const addUser = (id: string, email: string, hash = 'h'): void => {
    db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, '2026-10-01 00:00:00')")
      .run(id, email, hash);
  };

  it('the ETag is the SHA-256 of the uncompressed file, and data-as-of is the generation clock', async () => {
    addUser('u1', 'a@example.com');
    const out = await produce(db, undefined, () => Date.UTC(2026, 9, 11, 3, 4, 5));
    if (out.status !== 'fresh') throw new Error('expected fresh');
    const raw = gunzipSync(out.body);
    expect(out.etag).toBe(`"sha256-${createHash('sha256').update(raw).digest('hex')}"`);
    expect(out.dataAsOf).toBe('2026-10-11T03:04:05.000Z');
  });

  it('🔴 unchanged content ⇒ identical ETag and `unchanged` for If-None-Match; an allowlisted change ⇒ new ETag', async () => {
    // Inserted out of key order on purpose: the copy must not depend on rowid order.
    addUser('u2', 'b@example.com');
    addUser('u1', 'a@example.com');
    const first = await produce(db);
    const again = await produce(db, first.etag);
    expect(again.status).toBe('unchanged');
    expect(again.etag).toBe(first.etag);
    expect('body' in again).toBe(false);

    // Same rows, different physical order ⇒ same bytes.
    db.exec('DELETE FROM users');
    addUser('u1', 'a@example.com');
    addUser('u2', 'b@example.com');
    expect((await produce(db, first.etag)).status, 'row order must not change the bytes').toBe('unchanged');

    db.prepare("UPDATE users SET email = 'c@example.com' WHERE id = 'u1'").run();
    const changed = await produce(db, first.etag);
    expect(changed.status).toBe('fresh');
    expect(changed.etag).not.toBe(first.etag);
  });

  it('a change only to a column the console never gets does NOT change the ETag', async () => {
    addUser('u1', 'a@example.com', 'hash-one');
    const first = await produce(db);
    db.prepare("UPDATE users SET password_hash = 'hash-two' WHERE id = 'u1'").run();
    expect((await produce(db, first.etag)).status).toBe('unchanged');
  });

  it('If-None-Match: lists, weak prefix and * are honoured; a stale tag is not', async () => {
    addUser('u1', 'a@example.com');
    const first = await produce(db);
    expect((await produce(db, `"nope", W/${first.etag}`)).status).toBe('unchanged');
    expect((await produce(db, '*')).status).toBe('unchanged');
    expect((await produce(db, '"sha256-0000"')).status).toBe('fresh');
    expect((await produce(db, '')).status).toBe('fresh');
  });
});
