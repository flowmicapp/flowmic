// SPEC-REF:
//   apps/server-core/src/node/forward-ledger.ts   (exactly-once, in one transaction)
//   apps/server-core/src/node/forwarded-write.ts  (what may cross a node boundary)
//   apps/server-core/src/http/node-routes.ts      (POST /api/node/forward)
//
// The writer's receive path, assembled: validate → perform exactly once → report
// per record.
//
// 🔴 EVERY RECORD IS ITS OWN OUTCOME. A batch is a convenience for the network,
// never a transaction: one record from a replica running an older build must not
// stop the good ones behind it, and 「the batch failed」 makes a replica retry a
// poison record forever with everything else stuck behind it.
//
// The three outcomes mean three different things to the sender:
//   · accepted  — performed. Stop owing it.
//   · duplicate — already performed. Stop owing it. (Counted separately because
//                 a duplicate RATE is the health signal for the retry loop;
//                 folding it into `accepted` would erase the only evidence that
//                 the loop is misbehaving.)
//   · rejected  — this writer will never perform it. The replica PARKS it rather
//                 than dropping it: a metering record we cannot deliver is
//                 something an operator has to be able to find.

import type { ForwardTargets } from './forwarded-write';
import { applyForwardedWrite, parseForwardedWrite } from './forwarded-write';
import type { ForwardLedger } from './forward-ledger';

export type ReceiveOutcome = 'accepted' | 'duplicate' | 'rejected';

export interface ForwardReceiverDeps {
  ledger: ForwardLedger;
  targets: ForwardTargets;
  /**
   * Pin the metering clock to the record's own timestamp for the duration of
   * one apply, then release it.
   *
   * 🔴 A FORWARDED RECORD DESCRIBES A MOMENT THAT HAS ALREADY PASSED. The meter
   * buckets into `currentMonth(clock)`, so replaying a record from 23:59 on the
   * last day of a month after a writer outage would bill it to the NEXT month —
   * silently, with both totals wrong and nothing reporting an error. Optional
   * only so a test can leave it out; production always passes it.
   */
  pinClock?: (atMs: number) => void;
  /** Called for each rejected record. 🔴 Not optional in spirit: a rejection is
   *  a record we are refusing to perform, and refusing in silence is the failure
   *  this whole subsystem exists to prevent. */
  onRejected?: (id: string, reason: string, fromNode: string | null) => void;
  /** Called when performing a record threw. Distinct from a rejection: the
   *  record was well-formed and we could not do it, so the replica must retry. */
  onFailed?: (id: string, reason: string, fromNode: string | null) => void;
}

interface Incoming {
  id?: unknown;
  kind?: unknown;
  at?: unknown;
  node?: unknown;
  body?: unknown;
}

export function makeForwardReceiver(deps: ForwardReceiverDeps) {
  return (records: unknown[], fromNode: string | null): Record<string, ReceiveOutcome> => {
    const outcomes: Record<string, ReceiveOutcome> = {};
    for (const raw of records) {
      const rec = (raw ?? {}) as Incoming;
      const id = typeof rec.id === 'string' && rec.id.length ? rec.id : null;
      if (!id) {
        // Nothing to key on and nothing to report against. Dropping it here is
        // the one place that is safe: the sender cannot be told about an id it
        // did not send, so it will retry, and the retry is equally unusable.
        // Logged so the pathology is visible rather than inferred from a queue
        // that never shrinks.
        deps.onRejected?.('(no id)', 'record has no id', fromNode);
        continue;
      }
      let write;
      try {
        write = parseForwardedWrite(rec.body);
      } catch (err) {
        outcomes[id] = 'rejected';
        deps.onRejected?.(id, err instanceof Error ? err.message : String(err), fromNode);
        continue;
      }
      try {
        outcomes[id] = deps.ledger.once(
          {
            id,
            node: typeof rec.node === 'string' ? rec.node : (fromNode ?? undefined),
            kind: typeof rec.kind === 'string' ? rec.kind : undefined,
            at: typeof rec.at === 'number' ? rec.at : undefined,
          },
          () => {
            // The pin and the apply are ONE expression on purpose: the clock is
            // a shared cell, and it is only safe because nothing can interleave
            // between these two synchronous statements. Do not separate them.
            deps.pinClock?.(typeof rec.at === 'number' ? rec.at : 0);
            try {
              applyForwardedWrite(write, deps.targets);
            } finally {
              // Released even when the apply throws, or the next LOCAL metering
              // call on this process would be stamped with a forwarded record's
              // timestamp — a defect that would look like clock drift.
              deps.pinClock?.(0);
            }
          },
        );
      } catch (err) {
        // ⚠️ NOT recorded in `outcomes`. Leaving the id out is what tells the
        // replica to retry — see node-routes.ts: 「silence is not consent」. A
        // `rejected` here would make a transient database error look permanent
        // and discard a billing fact.
        deps.onFailed?.(id, err instanceof Error ? err.message : String(err), fromNode);
      }
    }
    return outcomes;
  };
}
