// SPEC-REF:
//   apps/server-core/src/db/replica-outbox.ts   (the durable queue)
//   apps/server-core/src/node/writer-client.ts  (the one place that dials the writer)
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §3-4
//
// The replica's delivery loop: hand the writer what we owe it, forever, until it
// takes it.
//
// ⚠️ SEPARATE FROM THE REPLICATION PULL, AND ON A DIFFERENT CLOCK. Replication
// (writer → replica, a snapshot every ~30 s) and this (replica → writer, every
// few seconds) are two directions of two different mechanisms, and coupling
// their intervals would tie a billing delay to a snapshot size for no reason.
//
// 🔴 A STUCK QUEUE MUST BE AUDIBLE. `pending` alone cannot tell a queue that is
// draining from one that is frozen — both look like a number at any single
// instant. The age of the oldest record can: it stays small while delivery works
// and grows without bound when it does not. That is what this warns on.

import type { ReplicaOutbox } from '../db/replica-outbox';
import type { WriterClient } from './writer-client';

export interface OutboxDrainerDeps {
  outbox: ReplicaOutbox;
  client: WriterClient;
  /** How often to try. Short, because the queue is durable and a failed attempt
   *  costs one request. */
  intervalMs?: number;
  /** Warn when the oldest owed record is older than this. Default 5 minutes:
   *  long enough that a redeploy of the writer does not page anyone, short
   *  enough that a genuinely broken link is noticed the same hour. */
  stuckAfterMs?: number;
  log: {
    warn(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
  };
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface OutboxDrainer {
  /** Run one cycle now. Exposed so a test drives it instead of waiting, and so
   *  shutdown can make a last attempt before the process goes. */
  tick(): Promise<void>;
  stop(): void;
}

export const DRAIN_INTERVAL_MS = 5_000;
export const DRAIN_STUCK_AFTER_MS = 5 * 60_000;

export function startOutboxDrainer(deps: OutboxDrainerDeps): OutboxDrainer {
  const intervalMs = deps.intervalMs ?? DRAIN_INTERVAL_MS;
  const stuckAfterMs = deps.stuckAfterMs ?? DRAIN_STUCK_AFTER_MS;
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
  let warnedStuck = false;

  const tick = async (): Promise<void> => {
    const stats = await deps.outbox.drainBatch(async (owed) => {
      const verdicts = new Map<string, boolean>();
      // A transport failure throws out of here, and drainBatch turns that into
      // 「nothing was marked」 — every record keeps its try count and is offered
      // again next cycle. That is the behaviour a writer restart needs.
      const { outcomes } = await deps.client.forward(owed);
      for (const [id, outcome] of outcomes) {
        // `rejected` is FALSE here on purpose: the record stays owed and burns
        // its retry budget down to the parked state, where an operator can find
        // it. Dropping it on the replica's say-so would delete a billing fact
        // because the writer disliked its shape.
        verdicts.set(id, outcome === 'accepted' || outcome === 'duplicate');
      }
      return verdicts;
    });

    const age = stats.oldest_pending_ms;
    if (age !== null && age > stuckAfterMs) {
      if (!warnedStuck) {
        deps.log.warn('node.outbox is not draining — the writer is not taking our writes', {
          pending: stats.pending,
          oldest_pending_ms: age,
          failed: stats.failed,
        });
        warnedStuck = true;
      }
    } else if (warnedStuck) {
      // Say so in BOTH directions. A warning that never gets an all-clear
      // trains the reader to ignore it.
      deps.log.info('node.outbox is draining again', { pending: stats.pending });
      warnedStuck = false;
    }
  };

  const handle = setIntervalFn(() => {
    // Fire-and-forget: an unhandled rejection here would take the process down
    // over a network blip. drainBatch already swallows send failures; this is
    // the belt for anything else.
    void tick().catch((err) => deps.log.warn('node.outbox drain cycle threw', {
      reason: err instanceof Error ? err.message : String(err),
    }));
  }, intervalMs);
  if (typeof (handle as { unref?: () => void })?.unref === 'function') {
    // A drain timer must not be the reason a process refuses to exit.
    (handle as { unref: () => void }).unref();
  }

  return {
    tick,
    stop: () => clearIntervalFn(handle),
  };
}
