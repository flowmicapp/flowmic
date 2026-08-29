// SPEC-REF:
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §3-4, §8
//   apps/server-core/src/node/writer-client.ts (the authenticated node channel)
//
// The other direction: the writer's database, arriving on a replica.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 A CORRECTION TO THE SPIKE, AND IT REMOVES A WHOLE DEPLOYMENT STEP
//
// The 2026-08-29 spike proved replication over ssh: a `command=`-locked key, a
// `VACUUM INTO` snapshot, gzip, 120 KB on the wire, 8 ms of writer time. All of
// that measurement still stands. What it got wrong was the LAST step.
//
// The spike assumed the snapshot would replace the replica's database FILE.
// It cannot, in this process: `node:sqlite` holds an open handle and 106
// prepared statements against a specific inode. A rename leaves every one of
// them reading the OLD, now-unlinked file — the reads keep succeeding and the
// data silently stops advancing, which is the worst failure this system has.
// Making it work would mean reopening the database and rebuilding every
// statement — a refactor the size of the one this design chose sqlite to avoid.
//
// So the snapshot is IMPORTED into the live database instead: ATTACH, replace
// every table inside ONE transaction, DETACH. Same file, same handle, same
// prepared statements, and readers never observe a half-applied state because a
// transaction is exactly the thing that guarantees they cannot.
//
// That also lets the transport be the node channel we already have, so ssh keys,
// a snapshot script on the writer, a systemd timer and its unit file all stop
// being part of this design. Deployment steps that do not exist cannot be
// forgotten during a 3am incident.
//
// ⚠️ COST, MEASURED NOT ASSUMED: this rewrites every row every cycle. The
// production database is 757 KB (NY, 2026-08-29), so a cycle is milliseconds of
// local work. That is the reason this is affordable — not a general claim about
// replication. At two orders of magnitude larger this becomes the wrong design
// and the honest fix is incremental change-tracking, not a longer interval.
// ─────────────────────────────────────────────────────────────────────────────

import { gunzipSync } from 'node:zlib';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

export interface ReplicaPullerDeps {
  db: DatabaseSync;
  /** Fetches the writer's snapshot. Returns the raw bytes (gzip or plain). */
  fetchSnapshot: () => Promise<Buffer>;
  /** Where to stage the downloaded snapshot before ATTACHing it. A real path on
   *  disk is required — sqlite cannot ATTACH a buffer. */
  stagePath?: string;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
  intervalMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface ReplicaPuller {
  /** One pull-and-apply. Resolves with how many tables were replaced, or throws
   *  — and a throw means NOTHING was applied, never a half-import. */
  pull(): Promise<number>;
  lastAppliedAt(): number | null;
  stop(): void;
}

export const PULL_INTERVAL_MS = 30_000;

/** Tables that belong to THIS node and must survive a pull.
 *
 *  🔴 `node_forward_seen` is the writer's exactly-once ledger. It has no meaning
 *  on a replica, and — more to the point — importing the writer's copy of it
 *  would be importing a record of work this node did not do. It is created by
 *  the writer only, so on a replica it is simply absent; this list exists so
 *  that stays true if that ever changes. */
const NEVER_REPLICATED = new Set(['node_forward_seen', 'sqlite_sequence']);

function tablesIn(db: DatabaseSync, schema: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  return rows.map((r) => r.name).filter((n) => !NEVER_REPLICATED.has(n));
}

export function makeReplicaPuller(deps: ReplicaPullerDeps): ReplicaPuller {
  const { db, log } = deps;
  const stagePath = deps.stagePath ?? join(tmpdir(), 'flowmic-replica-snapshot.db');
  let appliedAt: number | null = null;

  const pull = async (): Promise<number> => {
    const raw = await deps.fetchSnapshot();
    // gzip magic. Accepting both means a writer that stops compressing does not
    // become an outage, and it costs one byte comparison.
    const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    if (bytes.length < 16 || bytes.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
      // A proxy error page is a plausible thing to receive here, and importing
      // one would be a very confusing failure three layers down.
      throw new Error(`snapshot is not a sqlite database (${bytes.length} bytes)`);
    }
    writeFileSync(stagePath, bytes);

    try {
      db.exec(`ATTACH DATABASE '${stagePath.replace(/'/g, "''")}' AS snap`);
    } catch (err) {
      throw new Error(`could not attach snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const incoming = tablesIn(db, 'snap');
      const local = new Set(tablesIn(db, 'main'));
      // 🔴 A table the writer has and this build does not means the REPLICA IS
      // OLDER THAN THE WRITER. Deploy order is writer-first, so this is a
      // legitimate transient during a rolling deploy — but silently skipping the
      // table would let a replica serve an out-of-date shape indefinitely while
      // reporting healthy pulls. Named, and the rest still applies.
      const unknown = incoming.filter((t) => !local.has(t));
      if (unknown.length) {
        log.warn('replica pull: writer has tables this build does not know', {
          tables: unknown,
          hint: 'deploy the replica to the writer’s version',
        });
      }
      const applying = incoming.filter((t) => local.has(t));

      db.exec('BEGIN IMMEDIATE');
      try {
        // Deferred rather than disabled: constraints are still checked, just at
        // COMMIT instead of per statement. Disabling them would let a snapshot
        // with a broken reference land silently, and `PRAGMA foreign_keys` is a
        // no-op inside a transaction anyway — which is the trap this avoids.
        db.exec('PRAGMA defer_foreign_keys = ON');
        for (const t of applying) {
          db.exec(`DELETE FROM main."${t}"`);
          db.exec(`INSERT INTO main."${t}" SELECT * FROM snap."${t}"`);
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already unwound; the original error is the one that matters */
        }
        throw err;
      }
      appliedAt = Date.now();
      return applying.length;
    } finally {
      // DETACH even on the failure path, or the next cycle cannot attach and one
      // bad snapshot becomes a permanent outage.
      try {
        db.exec('DETACH DATABASE snap');
      } catch {
        /* nothing attached */
      }
      try {
        unlinkSync(stagePath);
      } catch {
        /* the staged file is a cache, not a fact */
      }
    }
  };

  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
  let warned = false;
  const handle = setIntervalFn(() => {
    void pull().then(
      (n) => {
        if (warned) {
          log.info('replica pull: recovered', { tables: n });
          warned = false;
        }
      },
      (err) => {
        // Once per outage, not once per cycle: a warning every 30 seconds is a
        // warning nobody reads by the second hour.
        if (!warned) {
          log.warn('replica pull FAILED — this node is serving an ageing copy', {
            reason: err instanceof Error ? err.message : String(err),
            last_applied_ms_ago: appliedAt === null ? null : Date.now() - appliedAt,
          });
          warned = true;
        }
      },
    );
  }, deps.intervalMs ?? PULL_INTERVAL_MS);
  if (typeof (handle as { unref?: () => void })?.unref === 'function') {
    (handle as { unref: () => void }).unref();
  }

  return { pull, lastAppliedAt: () => appliedAt, stop: () => clearIntervalFn(handle) };
}
