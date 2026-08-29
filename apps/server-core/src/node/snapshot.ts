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

import { gzipSync } from 'node:zlib';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

/** Serialise concurrent snapshot requests. Two replicas pulling at the same
 *  instant would otherwise VACUUM INTO the same path and hand each other half a
 *  file — a corruption whose symptom appears on a different machine minutes
 *  later, which is the hardest kind to trace back. */
let inFlight: Promise<Buffer> | null = null;

export function makeSnapshotProducer(db: DatabaseSync): () => Promise<Buffer> {
  return async (): Promise<Buffer> => {
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<Buffer> => {
      // A unique path per call, so even if the guard above is ever removed the
      // failure is wasted work rather than a corrupt hand-off.
      const out = join(tmpdir(), `flowmic-snapshot-${process.pid}-${Date.now()}.db`);
      try {
        db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
        return gzipSync(readFileSync(out));
      } finally {
        try {
          unlinkSync(out);
        } catch {
          // Leaving it would leak a full copy of the user database into tmp on
          // every pull, so this is worth a try/catch and not worth a throw.
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
