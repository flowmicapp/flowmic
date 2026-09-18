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
// 🔴 NR-22 — WHY THIS COPIES BY COLUMN NAME, AND WHEN IT REFUSES
//
//   grep anchors: NR-22-PROJECT-BY-NAME · NR-22-REFUSAL-RULE · NR-22-ORDER-CHECK
//                 NR-22-WRITER-AHEAD
//
// This used to be `INSERT INTO main.t SELECT * FROM snap.t`, which maps BY
// POSITION. That has two failure shapes and only the loud one was ever seen:
//   · different column COUNT — production, NY→JP, 2026-09-09, verbatim:
//     「replica pull FAILED … table main.users has 14 columns but 15 values were
//     supplied」. The writer shipped `verify_grace_until` first and the replica
//     could not pull anything at all until it was deployed too. Loud, and
//     because one pull is one transaction it stalled EVERY table, not just
//     `users`.
//   · same count, different ORDER — never observed and far worse: a replica
//     first built from `INIT_SQL` can order its columns differently from a
//     writer that grew the same columns through ALTERs, and then every value
//     lands in the WRONG column with no error anywhere.
//
// So the copy is now projected by name (NR-22-PROJECT-BY-NAME): both ends are
// read with `PRAGMA table_info`, the shared column names are taken in the LOCAL
// table's order, and the statement is
// `INSERT INTO main.t (c1,…) SELECT c1,… FROM snap.t`. Order stops mattering on
// both sides, and a column the two ends do not share is a decision rather than
// an accident:
//
// NR-22-REFUSAL-RULE — per table, after the intersection is taken:
//   1. WRITER-ONLY columns (the writer has them, this build does not) are
//      DROPPED. The replica has nowhere to put them; that is the rolling-deploy
//      transient the production failure above was, and it is now survivable
//      instead of fatal. One named WARN (NR-22-WRITER-AHEAD), not silence.
//   2. LOCAL-ONLY columns (this build has them, the writer does not) are left to
//      their default — EXCEPT when the local schema says the projection could
//      not produce a complete row, which is either
//        (a) NOT NULL with no default, or
//        (b) part of the local PRIMARY KEY.
//      Then the PULL IS REFUSED. (b) is not redundant: sqlite leaves a
//      `TEXT PRIMARY KEY` nullable, so without it a writer missing the identity
//      column would quietly insert NULL identities instead of throwing.
//   3. An EMPTY intersection is refused for the same reason — there is no
//      statement to write that would mean anything.
//   REFUSE = throw, which is the failure mode this file already had: the import
//   is one transaction, so nothing is applied, the replica keeps serving the
//   copy it had, and the interval's latched WARN says so. Skipping just the one
//   table was rejected: a replica that silently stops replicating `users` while
//   reporting healthy pulls is the 「quiet ≠ recovered」 shape this card exists
//   to remove.
//
// NR-22-ORDER-CHECK — the shared columns are also compared for ORDER. A
// mismatch is SAFE now (that is the whole point of projecting by name), so it
// is never a refusal — but it is the exact shape that used to corrupt in
// silence, so each distinct shape gets one forensic WARN and then stops
// repeating. It is the only evidence anyone will ever get that the two ends were
// built by different routes.
//
// ⚠️ THE LATCH IS UNCHANGED AND SO IS ITS MEANING: the failure WARN fires once
// per outage, and recovery gets its own `replica pull: recovered` INFO line —
// so quiet means 「still broken, already said so」 and only that INFO line means
// recovered. The order notes latch separately, per shape, for the same reason:
// a warning every 30 seconds is a warning nobody reads by the second hour.
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

/** One row of `PRAGMA table_info`, narrowed to what the refusal rule reads. */
interface ColumnInfo {
  name: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columnsOf(db: DatabaseSync, schema: string, table: string): ColumnInfo[] {
  // The table name is quoted rather than bound: PRAGMA arguments cannot be
  // parameters in sqlite, and every name reaching here came out of that same
  // database's own sqlite_master.
  return db
    .prepare(`PRAGMA ${schema}.table_info("${table.replace(/"/g, '""')}")`)
    .all() as unknown as ColumnInfo[];
}

/** What a refusal is, so a caller can tell it apart from a sqlite error. */
export class ReplicaColumnMismatchError extends Error {
  readonly table: string;
  constructor(table: string, detail: string) {
    super(`replica pull REFUSED (NR-22): table "${table}" — ${detail}`);
    this.name = 'ReplicaColumnMismatchError';
    this.table = table;
  }
}

interface TableProjection {
  table: string;
  /** Shared column names, in the LOCAL table's order. */
  columns: string[];
  /** Columns the writer has and this build does not — dropped by the copy. */
  writerOnly: string[];
  /** True when the shared columns sit in a different relative order on the two
   *  ends. Safe under name projection; recorded because it used to corrupt. */
  orderDiffers: boolean;
}

/** NR-22-PROJECT-BY-NAME / NR-22-REFUSAL-RULE — decide how, or whether, one
 *  table can be copied. Throws `ReplicaColumnMismatchError` on a shape the
 *  intersection cannot cover safely; the rule is spelled out in this file's
 *  header, and the reverse control for it is in
 *  test/replica-column-projection.test.ts. */
function planProjection(db: DatabaseSync, table: string): TableProjection {
  const localCols = columnsOf(db, 'main', table);
  const snapCols = columnsOf(db, 'snap', table);
  const snapNames = new Set(snapCols.map((c) => c.name));
  const localNames = new Set(localCols.map((c) => c.name));

  const shared = localCols.filter((c) => snapNames.has(c.name));
  const localOnly = localCols.filter((c) => !snapNames.has(c.name));

  // NR-22-REFUSAL-RULE 2: a local column the writer cannot supply, which the
  // local schema will not let the projection leave out.
  const unfillable = localOnly.filter(
    (c) => (c.notnull === 1 && c.dflt_value === null) || c.pk > 0,
  );
  if (unfillable.length) {
    throw new ReplicaColumnMismatchError(
      table,
      `the writer's snapshot has no ${unfillable.map((c) => `"${c.name}"`).join(', ')}, `
      + 'and this build cannot leave that column unset (NOT NULL without a default, '
      + 'or part of the primary key). Deploy the writer to this build.',
    );
  }
  // NR-22-REFUSAL-RULE 3.
  if (!shared.length) {
    throw new ReplicaColumnMismatchError(
      table,
      `the two ends share no column at all (local: ${localCols.length}, writer: ${snapCols.length})`,
    );
  }

  // NR-22-ORDER-CHECK: the shared columns' relative order on both ends.
  const sharedOnWriter = snapCols.filter((c) => localNames.has(c.name)).map((c) => c.name);
  const sharedLocally = shared.map((c) => c.name);
  const orderDiffers = sharedOnWriter.join('\u0000') !== sharedLocally.join('\u0000');

  return {
    table,
    columns: sharedLocally,
    writerOnly: snapCols.filter((c) => !localNames.has(c.name)).map((c) => c.name),
    orderDiffers,
  };
}

function quoteCols(columns: string[]): string {
  return columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
}

export function makeReplicaPuller(deps: ReplicaPullerDeps): ReplicaPuller {
  const { db, log } = deps;
  const stagePath = deps.stagePath ?? join(tmpdir(), 'flowmic-replica-snapshot.db');
  let appliedAt: number | null = null;
  // Latched forensics for the two shape notes below. Keyed by the SHAPE, not by
  // the table, so a note fires again the day the shape changes and stays quiet
  // while it does not — the same reason the failure WARN further down is
  // latched, and the same reading: quiet means "already said so".
  const noted = new Set<string>();
  const noteOnce = (key: string, emit: () => void): void => {
    if (noted.has(key)) return;
    noted.add(key);
    emit();
  };

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

      // 🔴 PLANNED BEFORE THE TRANSACTION OPENS, deliberately: a refusal is a
      // decision about shapes, not a write, so a refusing pull never takes a
      // write lock at all and never leaves one to roll back.
      const plans = applying.map((t) => planProjection(db, t));
      for (const plan of plans) {
        // NR-22-WRITER-AHEAD — named, not silent. The copy still applies; this
        // build simply has nowhere to put those values yet.
        if (plan.writerOnly.length) {
          noteOnce(`ahead:${plan.table}:${plan.writerOnly.join(',')}`, () => {
            log.warn('replica pull: the writer has columns this build does not — they are not copied', {
              table: plan.table,
              columns: plan.writerOnly,
              hint: 'deploy the replica to the writer’s version',
            });
          });
        }
        // NR-22-ORDER-CHECK — safe under name projection, recorded anyway.
        if (plan.orderDiffers) {
          noteOnce(`order:${plan.table}:${plan.columns.join(',')}`, () => {
            log.warn('replica pull: shared columns are in a different order on the two ends', {
              table: plan.table,
              local_order: plan.columns,
              note: 'copied by name, so this is safe; it means the two databases were built by different routes',
            });
          });
        }
      }

      db.exec('BEGIN IMMEDIATE');
      try {
        // Deferred rather than disabled: constraints are still checked, just at
        // COMMIT instead of per statement. Disabling them would let a snapshot
        // with a broken reference land silently, and `PRAGMA foreign_keys` is a
        // no-op inside a transaction anyway — which is the trap this avoids.
        db.exec('PRAGMA defer_foreign_keys = ON');
        for (const plan of plans) {
          const cols = quoteCols(plan.columns);
          db.exec(`DELETE FROM main."${plan.table}"`);
          // NR-22-PROJECT-BY-NAME. The two lists are the same names in the same
          // order, so the writer's physical column order never reaches this
          // statement.
          db.exec(`INSERT INTO main."${plan.table}" (${cols}) SELECT ${cols} FROM snap."${plan.table}"`);
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
      return plans.length;
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
