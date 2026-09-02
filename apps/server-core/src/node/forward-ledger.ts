// SPEC-REF:
//   apps/server-core/src/db/replica-outbox.ts (at-least-once, and why)
//   apps/server-core/src/node/forwarded-write.ts
//   CLAUDE.md red line: no silent failure, in BOTH directions
//
// The writer's side of at-least-once delivery: a record it has already performed
// must not be performed again.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE CLAIM AND THE EFFECT ARE ONE TRANSACTION
//
// There are only three orderings and two of them are wrong:
//
//   · claim, then apply — if the apply throws, the id is spent. The replica
//     retries, is told 「duplicate」, stops owing it, and the minutes are gone.
//     Silent, and it looks like success from both ends.
//   · apply, then claim — a crash in between means the retry applies it a second
//     time. That is a double charge.
//   · both inside one transaction — a failure anywhere rolls back BOTH, the
//     replica is told nothing, and it retries. The only ordering where the
//     failure mode is 「try again」 rather than 「money moved wrongly」.
//
// So this module owns the transaction, not the caller. A caller that could
// forget to open one is a caller that will.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ NOT IN db/schema.ts, and that is deliberate rather than convenient: this is
// node plumbing, not product data. It is created by the writer at boot and a
// single-node deployment never has the table at all — which is the honest
// expression of 「this row means a second machine exists」.

import type { DatabaseSync } from 'node:sqlite';

export const FORWARD_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS node_forward_seen (
  id   TEXT PRIMARY KEY,
  node TEXT,
  kind TEXT,
  at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_forward_seen_at ON node_forward_seen(at);
`;

/** How long a performed id is remembered. Must comfortably exceed the longest
 *  time a replica can keep retrying — MAX_TRIES attempts at the drain interval,
 *  plus any outage the outbox rode out. Seven days is 「a long weekend of
 *  unreachability」 with room to spare; the table costs ~50 bytes a row. */
export const FORWARD_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** F6 (2026-09-02 audit) — sweep cadence for `prune()`, which had zero
 *  production callers until this card: `node_forward_seen` grew without bound
 *  (~17k rows/PC/day at this route's own traffic estimate) because the method
 *  existed, was unit-tested, and was never armed on a timer anywhere bootstrap
 *  runs. Daily, same cadence as db/retention.ts and db/reaper.ts — a 7-day
 *  retention window does not need a tighter sweep than either of those. */
export const FORWARD_LEDGER_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ForwardLedger {
  /** Perform `effect` exactly once for this id.
   *
   *  Returns `'accepted'` when the effect ran, `'duplicate'` when this id was
   *  already performed. Throws only when the effect throws — and then nothing
   *  was written, so the caller must NOT report the record as handled. */
  once(
    rec: { id: string; node?: string; kind?: string; at?: number },
    effect: () => void,
  ): 'accepted' | 'duplicate';
  /** Drop ids older than the retention window. Returns how many went. */
  prune(now?: number): number;
}

export function makeForwardLedger(db: DatabaseSync): ForwardLedger {
  db.exec(FORWARD_LEDGER_DDL);
  const claim = db.prepare('INSERT INTO node_forward_seen (id, node, kind, at) VALUES (?, ?, ?, ?)');
  const seen = db.prepare('SELECT 1 AS hit FROM node_forward_seen WHERE id = ?');
  const sweep = db.prepare('DELETE FROM node_forward_seen WHERE at < ?');

  return {
    once(rec, effect): 'accepted' | 'duplicate' {
      // Checked before opening the transaction so the common duplicate costs one
      // indexed lookup rather than a rollback. The INSERT below is still the
      // authority — this is a fast path, not the guard.
      if (seen.get(rec.id)) return 'duplicate';
      db.exec('BEGIN IMMEDIATE');
      try {
        claim.run(rec.id, rec.node ?? null, rec.kind ?? null, rec.at ?? Date.now());
        effect();
        db.exec('COMMIT');
        return 'accepted';
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the transaction is already gone; the original error is the one that
             matters and rethrowing this one would hide it */
        }
        // A UNIQUE violation here means a concurrent request claimed the same id
        // between the fast path above and this INSERT. That is a duplicate, not
        // a failure — and reporting it as a failure would make the replica retry
        // a record that HAS been performed, forever.
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint failed: node_forward_seen\.id/.test(msg)) return 'duplicate';
        throw err;
      }
    },

    prune(now = Date.now()): number {
      const r = sweep.run(now - FORWARD_LEDGER_RETENTION_MS);
      return Number(r.changes ?? 0);
    },
  };
}
