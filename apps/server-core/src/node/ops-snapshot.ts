// SPEC-REF:
//   docs/strategy/2026-08-31-lan-ops-console-third-party-spec.md §4.5 (channel A v2)
//   docs/strategy/2026-10-11-ops-console-direct-and-slow-pull.md §2 (what the
//     console reads), §4-2 (this producer), §5-1 O1
//   apps/server-core/src/http/node-routes-ops-snapshot.ts (the route that serves it)
//
// The SLIM snapshot for the LAN ops console: only the tables and columns the
// console's own queries read, never the whole database.
//
// 🔴 WHY THIS EXISTS. `/api/node/snapshot` (node/snapshot.ts) hands its caller
// the entire database — password hashes, the plaintext bearer tokens PCs and
// phones connect with (`pc_devices.device_token`, `mobile_pairings.mobile_token`;
// mobile.repo.ts looks a phone up by the raw value, so a copy IS the phone),
// Google subject ids, verification code hashes and every blind-store
// ciphertext. The console reads none of those (design §2, read from its
// `server/src/queries/reports.ts`). Narrowing what a third party holds is the
// first reason for this file; the 13 MB → ~0.1 MB on the wire is the second.
//
// 🔴 THE ALLOWLIST IS A TABLE OF COLUMN NAMES, NOT A LIST OF THINGS TO DROP.
// A denylist ages the wrong way: the day somebody adds `users.some_new_secret`
// it ships until somebody remembers to add it to the denylist. Here a new column
// is absent until somebody adds it to [OPS_SNAPSHOT_TABLES] on purpose, and
// `test/ops-snapshot-allowlist.test.ts` enumerates the LIVE schema and goes red
// for any column it finds in the output that this table does not name.
//
// HOW THE COPY IS MADE — NOT `VACUUM INTO` + strip, which the design sketched.
// The full copy would read and write every page of the database (30 MB of it
// is the writer's forward ledger on production, 2026-10-11) only to throw most
// of it away, all on the writer's single thread. Instead the LIVE connection
// ATTACHes a fresh private file and fills it with `CREATE TABLE … AS SELECT
// <allowlisted columns>` inside one transaction, which reads only the allowlisted
// tables and writes only the private file. The live database is read, never
// written (`main` takes no write in that transaction; the test asserts a second
// connection's `PRAGMA data_version` does not move). Secrets never reach the private
// file at all, so there are no freed pages holding them for a VACUUM to clean.
//
// ⚠️ ATTACH ON THE LIVE CONNECTION IS SAFE ONLY BECAUSE node:sqlite IS
// SYNCHRONOUS. Between ATTACH and DETACH no other JavaScript runs on this
// thread, so no other caller can see `ops_slim` or have its unqualified table
// names resolve into it (and `main` is searched before attached databases
// anyway). If this ever became async, that stops being true.
//
// ETAG = SHA-256 OF THE UNCOMPRESSED FILE. Same content ⇒ same bytes: the
// tables are created in a fixed order, every table is written ORDER BY its
// primary key, and the file is built by the same single transaction every time.
// So a 304 cannot be a false 304 — there is no dirty bit to forget to set
// (design §4-2; a false 304 is the replication design's §7-2 headline risk).

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';

export interface OpsSnapshotTable {
  /** Table name, identical in the live database and in the slim file. */
  table: string;
  /** The ONLY columns copied. Order is the column order in the slim file. */
  columns: readonly string[];
  /** Deterministic row order — the table's primary key. Without it a VACUUM of
   *  the live database could renumber rowids and change the bytes (a spurious
   *  200, never a false 304, but still churn on the wire). */
  orderBy: readonly string[];
}

/** 🔴 The allowlist. Every entry is a column the console's queries read
 *  (design §2, which cites the console's `reports.ts` query by query). Adding a
 *  column here is a decision to hand it to a third party: change the spec
 *  (§4.5.3) first. */
export const OPS_SNAPSHOT_TABLES: readonly OpsSnapshotTable[] = [
  {
    table: 'users',
    columns: ['id', 'email', 'display_name', 'locale', 'is_admin', 'permanent_free', 'restricted_at',
      'restriction_reason', 'last_login_at', 'plan', 'created_at'],
    orderBy: ['id'],
  },
  {
    table: 'usage_records',
    columns: ['user_id', 'month', 'stt_minutes', 'llm_tokens_in', 'llm_tokens_out'],
    orderBy: ['user_id', 'month'],
  },
  {
    table: 'usage_events',
    columns: ['user_id', 'occurred_at', 'kind', 'outcome', 'stt_ms', 'tokens_in', 'tokens_out', 'is_byok'],
    orderBy: ['id'],
  },
  {
    table: 'paddle_subscriptions',
    columns: ['subscription_id', 'user_id', 'tier', 'status', 'cycle', 'current_period_end', 'next_billed_at',
      'canceled_at', 'scheduled_change_action', 'scheduled_change_at', 'created_at'],
    orderBy: ['subscription_id'],
  },
  {
    // The console reads this one with `SELECT *`; the list is every column the
    // table has today (none is a credential). A column added later does NOT
    // follow automatically — that is the point of the allowlist.
    table: 'paddle_subscription_tombstones',
    columns: ['subscription_id', 'customer_id', 'status_at_deletion', 'tier_at_deletion', 'current_period_end',
      'reason', 'created_at', 'cancel_verified_at'],
    orderBy: ['subscription_id'],
  },
  {
    table: 'one_time_purchases',
    columns: ['order_id', 'provider', 'user_id', 'product_id', 'amount_minor', 'currency', 'state',
      'scheduled_at', 'started_at', 'delivered_at', 'completion_notice_at', 'refund_requested_at',
      'refund_status', 'refunded_at', 'refund_released_at', 'refund_release_reason',
      'refund_external_reference', 'note', 'created_at', 'updated_at'],
    orderBy: ['order_id'],
  },
  {
    table: 'billing_events',
    columns: ['event_id', 'notification_id', 'event_type', 'occurred_at', 'received_at', 'subscription_id',
      'user_id', 'outcome', 'detail'],
    orderBy: ['event_id'],
  },
  {
    table: 'refund_requests',
    columns: ['id', 'user_id', 'subscription_id', 'transaction_id', 'kind', 'state', 'amount_minor', 'currency',
      'detail', 'created_at'],
    orderBy: ['id'],
  },
  {
    table: 'site_daily_counts',
    columns: ['day', 'kind', 'dim', 'dim_value', 'count'],
    orderBy: ['day', 'kind', 'dim', 'dim_value'],
  },
  {
    table: 'pc_devices',
    columns: ['id', 'user_id', 'device_name', 'pcid', 'is_online', 'last_seen_at', 'created_at'],
    orderBy: ['id'],
  },
  {
    table: 'mobile_pairings',
    columns: ['id', 'user_id', 'mobile_name', 'device_uid', 'paired_at', 'last_seen_at'],
    orderBy: ['id'],
  },
  {
    table: 'ops_audit_log',
    columns: ['id', 'actor_user_id', 'action', 'target_kind', 'target_id', 'detail', 'created_at'],
    orderBy: ['id'],
  },
];

/** The one derived table: per-account totals of the blind store, replacing
 *  `timeline_blobs` (the console only ever ran COUNT and SUM(LENGTH(ciphertext))
 *  over it — design §2). Not a column of any live table, so it is listed apart
 *  from [OPS_SNAPSHOT_TABLES] and the allowlist test checks it by name. */
export const OPS_SNAPSHOT_DERIVED = {
  table: 'timeline_blob_totals',
  columns: ['user_id', 'n', 'bytes'] as const,
  select: 'SELECT user_id, COUNT(*) AS n, COALESCE(SUM(LENGTH(ciphertext)), 0) AS bytes '
    + 'FROM main.timeline_blobs WHERE deleted = 0 GROUP BY user_id ORDER BY user_id',
} as const;

export interface OpsSnapshotGeneration {
  /** Uncompressed SQLite bytes. */
  raw: Buffer;
  /** Strong ETag, quoted: `"sha256-<hex>"`. */
  etag: string;
  /** RFC 3339 instant the data was read from the live database. */
  dataAsOf: string;
}

/** `fresh` carries the gzip of [OpsSnapshotGeneration.raw]; `unchanged` carries
 *  no body at all, so a 304 cannot accidentally ship one. */
export type OpsSnapshotOutcome =
  | { status: 'fresh'; etag: string; dataAsOf: string; body: Buffer }
  | { status: 'unchanged'; etag: string; dataAsOf: string };

export interface OpsSnapshotProducerOptions {
  log?: { info(msg: string, meta?: Record<string, unknown>): void };
  now?: () => number;
}

/** Does an `If-None-Match` header value name this ETag? Handles a list, `*`,
 *  and the weak prefix (RFC 9110 §13.1.2 uses the weak comparison for it). */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string): string => t.trim().replace(/^W\//, '');
  for (const part of header.split(',')) {
    const tag = part.trim();
    if (tag === '*') return true;
    if (tag !== '' && bare(tag) === bare(etag)) return true;
  }
  return false;
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Build the slim file at [out] from the live connection. Synchronous by
 *  design (see the ATTACH note in the header). */
function buildSlimFile(db: DatabaseSync, out: string): void {
  db.prepare('ATTACH DATABASE ? AS ops_slim').run(out);
  try {
    // A throwaway file: no rollback journal, no fsync. A crash mid-build leaves
    // a garbage temp file and no answer, never a half file handed out (the
    // caller only reads it after this returns).
    db.exec('PRAGMA ops_slim.journal_mode = OFF');
    db.exec('PRAGMA ops_slim.synchronous = OFF');
    db.exec('BEGIN');
    try {
      for (const t of OPS_SNAPSHOT_TABLES) {
        db.exec(
          `CREATE TABLE ops_slim.${quote(t.table)} AS SELECT ${t.columns.map(quote).join(', ')} `
          + `FROM main.${quote(t.table)} ORDER BY ${t.orderBy.map(quote).join(', ')}`,
        );
      }
      db.exec(`CREATE TABLE ops_slim.${quote(OPS_SNAPSHOT_DERIVED.table)} AS ${OPS_SNAPSHOT_DERIVED.select}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Nothing open to roll back; the original error is the one to report.
      }
      throw err;
    }
  } finally {
    db.exec('DETACH DATABASE ops_slim');
  }
}

/**
 * One producer per process, holding ITS OWN in-flight guard. Deliberately not
 * shared with node/snapshot.ts's module-level one: two different documents
 * behind one guard would hand a replica the console's slim file or the console
 * the whole database (the replication design's 2a warning, same shape).
 */
export function makeOpsSnapshotProducer(
  db: DatabaseSync,
  opts: OpsSnapshotProducerOptions = {},
): (ifNoneMatch?: string) => Promise<OpsSnapshotOutcome> {
  const now = opts.now ?? Date.now;
  let inFlight: Promise<OpsSnapshotGeneration> | null = null;
  let produced = 0;

  const generate = (): OpsSnapshotGeneration => {
    // Unique per call so a removed guard costs wasted work, not a shared file.
    const out = join(tmpdir(), `flowmic-ops-snapshot-${process.pid}-${Date.now()}-${produced}.db`);
    try {
      const at = now();
      const t0 = performance.now();
      buildSlimFile(db, out);
      const t1 = performance.now();
      const raw = readFileSync(out);
      const t2 = performance.now();
      const etag = `"sha256-${createHash('sha256').update(raw).digest('hex')}"`;
      const t3 = performance.now();
      produced += 1;
      opts.log?.info('node.ops_snapshot generated', {
        n: produced,
        build_ms: Math.round((t1 - t0) * 10) / 10,
        read_ms: Math.round((t2 - t1) * 10) / 10,
        hash_ms: Math.round((t3 - t2) * 10) / 10,
        raw_bytes: raw.length,
      });
      return { raw, etag, dataAsOf: new Date(at).toISOString() };
    } finally {
      for (const f of [out, `${out}-journal`]) {
        try {
          unlinkSync(f);
        } catch {
          // Usually ENOENT for the journal. Leaving the file would leak the
          // console's view of every account into tmp, so try; never throw.
        }
      }
    }
  };

  return async (ifNoneMatch?: string): Promise<OpsSnapshotOutcome> => {
    if (!inFlight) {
      inFlight = (async (): Promise<OpsSnapshotGeneration> => generate())();
    }
    const mine = inFlight;
    let gen: OpsSnapshotGeneration;
    try {
      gen = await mine;
    } finally {
      if (inFlight === mine) inFlight = null;
    }
    if (ifNoneMatchHits(ifNoneMatch, gen.etag)) {
      return { status: 'unchanged', etag: gen.etag, dataAsOf: gen.dataAsOf };
    }
    const t0 = performance.now();
    const body = gzipSync(gen.raw);
    opts.log?.info('node.ops_snapshot gzipped', {
      gzip_ms: Math.round((performance.now() - t0) * 10) / 10,
      gz_bytes: body.length,
    });
    return { status: 'fresh', etag: gen.etag, dataAsOf: gen.dataAsOf, body };
  };
}
