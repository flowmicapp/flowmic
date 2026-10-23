// SPEC-REF:
//   apps/server-core/src/node/replica-puller.ts (the consumer)
//   apps/server-core/src/http/node-routes.ts    (GET /api/node/snapshot)
//
// The writer producing a consistent copy of its database.
//
// 🔴 `VACUUM INTO`, NOT A FILE COPY. sqlite's database file is not safe to read
// with `fs` while a process is writing to it — a copy taken mid-transaction is a
// torn database that opens fine and answers wrongly. `VACUUM INTO` takes the
// same read lock a query does and writes a defragmented, transactionally
// consistent database. Measured on production (NY, 2026-08-29): 8 ms of writer
// time, 757 KB in, 120 KB gzipped on the wire.
//
// ⚠️ IT IS ALSO NOT `.backup`: the online-backup API copies pages while writes
// continue and restarts on contention. VACUUM INTO is one statement and either
// produces a whole database or throws.

//
// REPL-TIER 1b (docs/strategy/2026-10-11-replication-tiering-design.md §3-1) —
// the copy leaves out tables no consumer of this route reads. The writer's
// exactly-once ledger was 97% of the file (30 MB of a 31 MB database) and went
// to every replica every 30 s, although the replica drops it on import
// (replica-puller.ts `NEVER_REPLICATED`) and the ops console contract never
// listed it (2026-08-31-lan-ops-console-third-party-spec.md §4.3). It is
// dropped from the PRIVATE copy, never from the live database, and the copy is
// then VACUUMed: a dropped table's pages stay in the file as free pages and
// gzip would ship them anyway.

import { gzipSync } from 'node:zlib';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// A runtime require with a non-static specifier, for the reason db/connection.ts
// gives at its own `SQLITE_SPECIFIER`: the bundler rewrites a static
// `node:sqlite` import to a bare `sqlite` and the built server fails to boot.
const SQLITE_SPECIFIER = 'node:sqlite';
const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)(SQLITE_SPECIFIER) as {
  DatabaseSync: new (path: string) => DatabaseSync;
};

/** Tables the snapshot never carries. DROPPED rather than emptied because no
 *  consumer has them locally (a replica imports only tables both sides have,
 *  replica-puller.ts `applying`), so absence and emptiness read the same and
 *  absence is smaller. */
export const SNAPSHOT_EXCLUDED_TABLES: readonly string[] = ['node_forward_seen'];

/** REPL-TIER 1c — one line per produced snapshot, so post-deploy acceptance can
 *  read size and event-loop cost. The work is synchronous on the writer's only
 *  thread; the line is what tells us whether that ever matters. Logged on the
 *  first snapshot, every 60th, and any time one step exceeds this many ms. */
export const SNAPSHOT_SLOW_STEP_MS = 100;
const SNAPSHOT_LOG_EVERY = 60;

export interface SnapshotProducerOptions {
  log?: { info(msg: string, meta?: Record<string, unknown>): void };
}

function stripPrivateCopy(path: string): void {
  const copy = new DatabaseSyncCtor(path);
  try {
    for (const t of SNAPSHOT_EXCLUDED_TABLES) copy.exec(`DROP TABLE IF EXISTS "${t}"`);
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
}

/** Serialise concurrent snapshot requests. Two replicas pulling at the same
 *  instant would otherwise VACUUM INTO the same path and hand each other half a
 *  file — a corruption whose symptom appears on a different machine minutes
 *  later, which is the hardest kind to trace back. */
let inFlight: Promise<Buffer> | null = null;

export function makeSnapshotProducer(db: DatabaseSync, opts: SnapshotProducerOptions = {}): () => Promise<Buffer> {
  let produced = 0;
  return async (): Promise<Buffer> => {
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<Buffer> => {
      // A unique path per call, so even if the guard above is ever removed the
      // failure is wasted work rather than a corrupt hand-off.
      const out = join(tmpdir(), `flowmic-snapshot-${process.pid}-${Date.now()}.db`);
      try {
        const t0 = performance.now();
        db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
        const t1 = performance.now();
        stripPrivateCopy(out);
        const t2 = performance.now();
        const raw = readFileSync(out);
        const t3 = performance.now();
        const gz = gzipSync(raw);
        const t4 = performance.now();
        const steps = { vacuum_ms: t1 - t0, strip_ms: t2 - t1, read_ms: t3 - t2, gzip_ms: t4 - t3 };
        produced += 1;
        if (opts.log && (produced === 1 || produced % SNAPSHOT_LOG_EVERY === 0
          || Object.values(steps).some((ms) => ms > SNAPSHOT_SLOW_STEP_MS))) {
          opts.log.info('node.snapshot produced', {
            n: produced,
            ...Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, Math.round(v * 10) / 10])),
            raw_bytes: raw.length,
            gz_bytes: gz.length,
          });
        }
        return gz;
      } finally {
        // The private copy and anything sqlite left beside it while stripping.
        for (const f of [out, `${out}-journal`, `${out}-wal`, `${out}-shm`]) {
          try {
            unlinkSync(f);
          } catch {
            // Leaving it would leak a full copy of the user database into tmp on
            // every pull, so this is worth a try/catch and not worth a throw.
            // (The three side files usually do not exist; that is the ENOENT.)
          }
        }
      }
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
