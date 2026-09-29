// SPEC-REF: docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §12 (EMB-14).
// HUMAN-AUDIT SENSITIVE: visitor duration and per-key admission.
import type { DatabaseSync } from 'node:sqlite';
import { ipBucketOf } from './trial-ip-bucket';
import { ServerError } from '../errors';

// IntegratorKeyRow has no settings field. These are independent of plan limits.
export const INTEGRATOR_SESSION_MS = 5 * 60_000;
export const INTEGRATOR_DAILY_MS = 30 * 60_000;
export const INTEGRATOR_CONCURRENT_MAX = 20;
export const INTEGRATOR_RETRY_MS = 1000;
const DAY_MS = 86_400_000;

/** The UTC day number `take()` writes into `integrator_visitor_days.day`. */
export const utcDayOf = (ms: number): number => Math.floor(ms / DAY_MS);

/**
 * Delete (or, `dryRun`, only COUNT) every per-visitor daily total older than
 * `beforeDay` — i.e. every row that is not today's (UTC). ONE delete path, two
 * callers (card EMB-15): `IntegratorSessionCaps.take()` (lazy, on the next
 * admission) and the daily growth reaper (`db/reaper.ts`, so the rows do not
 * outlive their day just because nobody spoke afterwards). Privacy draft C-3:
 * the salted-bucket totals must not linger. Returns the row count.
 */
export function pruneVisitorDays(db: DatabaseSync, beforeDay: number, dryRun = false): number {
  if (dryRun) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM integrator_visitor_days WHERE day < ?').get(beforeDay) as { n: number };
    return row.n;
  }
  return Number(db.prepare('DELETE FROM integrator_visitor_days WHERE day < ?').run(beforeDay).changes);
}

export class IntegratorSessionCaps {
  private readonly active = new Map<string, number>();
  constructor(private readonly db: DatabaseSync, private readonly salt: string,
    private readonly now: () => number = Date.now, private readonly writer = true) {}

  admission(keyId: string): { allowed: boolean; retryAfterMs: number } {
    return { allowed: (this.active.get(keyId) ?? 0) < INTEGRATOR_CONCURRENT_MAX, retryAfterMs: INTEGRATOR_RETRY_MS };
  }

  bindRoom(roomId: string, keyId: string, ip: string): void {
    this.db.prepare('INSERT INTO integrator_visitor_rooms (pc_device_id, key_id, bucket) VALUES (?,?,?)')
      .run(roomId, keyId, ipBucketOf(ip, `${this.salt}|${keyId}`));
  }

  take(roomId: string, keyId: string): { capMs: number; release(elapsedMs: number): void } {
    // Admissions and holds must share the writer. A replicated snapshot cannot
    // serialize two live spenders; refusing is safer than minting another budget.
    if (!this.writer) throw new ServerError('NODE_IS_REPLICA');
    if (!this.admission(keyId).allowed) {
      throw new ServerError('REGISTER_RATE_LIMITED', undefined, true, INTEGRATOR_RETRY_MS);
    }
    const row = this.db.prepare('SELECT bucket FROM integrator_visitor_rooms WHERE pc_device_id=? AND key_id=?')
      .get(roomId, keyId) as { bucket: string } | undefined;
    if (!row) throw new ServerError('INTEGRATOR_QUOTA_EXCEEDED');
    const day = utcDayOf(this.now());
    const bucket = row.bucket;
    // Charge a conservative duration hold durably BEFORE start. A crash cannot
    // reset today's spend. A clean stop refunds unused wall time, not audio silence.
    pruneVisitorDays(this.db, day);
    this.db.prepare('INSERT OR IGNORE INTO integrator_visitor_days (key_id,bucket,day,used_ms) VALUES (?,?,?,0)')
      .run(keyId, bucket, day);
    const spent = this.db.prepare('SELECT used_ms FROM integrator_visitor_days WHERE key_id=? AND bucket=? AND day=?')
      .get(keyId, bucket, day) as { used_ms: number };
    const capMs = Math.max(0, Math.min(INTEGRATOR_SESSION_MS, INTEGRATOR_DAILY_MS - spent.used_ms,
      (day + 1) * DAY_MS - this.now()));
    this.db.prepare('UPDATE integrator_visitor_days SET used_ms=used_ms+? WHERE key_id=? AND bucket=? AND day=?')
      .run(capMs, keyId, bucket, day);
    this.active.set(keyId, (this.active.get(keyId) ?? 0) + 1);
    let released = false;
    return { capMs, release: (elapsedMs) => {
      if (released) return;
      released = true;
      this.db.prepare('UPDATE integrator_visitor_days SET used_ms=used_ms-? WHERE key_id=? AND bucket=? AND day=?')
        .run(capMs - Math.min(capMs, Math.max(0, elapsedMs)), keyId, bucket, day);
      const left = (this.active.get(keyId) ?? 1) - 1;
      if (left === 0) this.active.delete(keyId); else this.active.set(keyId, left);
    } };
  }
}
