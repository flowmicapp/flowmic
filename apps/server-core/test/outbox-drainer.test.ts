// F1 (2026-09-02 audit) — outbox-drainer.ts's `warnedStuck` alarm reads
// `stats().oldest_pending_ms` as "is the ACTIVE queue draining". Before
// db/replica-outbox.ts excluded parked records from that number, a SINGLE
// permanently-poisoned record kept it growing forever — the alarm fired once
// and then never cleared again, for the rest of the process's life, even while
// every other record delivered normally on every subsequent tick.
//
// This file drives the drainer directly against a fake outbox whose stats
// sequence is authored by the test, so the "did the alarm actually clear"
// claim is checked against the exact numbers replica-outbox.ts now promises to
// produce (parked excluded from `pending`/`oldest_pending_ms`) rather than
// against a real multi-cycle parking dance, which this same fix is already
// unit-tested against directly in replica-outbox.test.ts.
//
// SPEC-REF: apps/server-core/src/node/outbox-drainer.ts
//           apps/server-core/src/db/replica-outbox.ts (`OutboxStats.parked`)

import { describe, expect, it } from 'vitest';
import { startOutboxDrainer } from '../src/node/outbox-drainer';
import type { ReplicaOutbox, OutboxStats } from '../src/db/replica-outbox';
import type { WriterClient } from '../src/node/writer-client';

/** A `ReplicaOutbox` double that answers `drainBatch` with a scripted
 *  sequence of stats, one per call — ignoring the sender callback, exactly
 *  like a real drain whose sender always resolves before drainBatch returns
 *  its final tallies. */
function scriptedOutbox(seq: OutboxStats[]): ReplicaOutbox {
  let i = 0;
  return {
    drainBatch: async () => seq[Math.min(i++, seq.length - 1)],
  } as unknown as ReplicaOutbox;
}

const noopClient = { forward: async () => ({ outcomes: new Map() }) } as unknown as WriterClient;

function capturingLog(): {
  warns: Array<[string, Record<string, unknown> | undefined]>;
  infos: Array<[string, Record<string, unknown> | undefined]>;
  log: { warn: (m: string, meta?: Record<string, unknown>) => void; info: (m: string, meta?: Record<string, unknown>) => void };
} {
  const warns: Array<[string, Record<string, unknown> | undefined]> = [];
  const infos: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    warns, infos,
    log: {
      warn: (m, meta) => warns.push([m, meta]),
      info: (m, meta) => infos.push([m, meta]),
    },
  };
}

describe('F1: the stuck-queue alarm reads the ACTIVE age, not the poisoned one', () => {
  it('🔴 clears once the active queue is empty — EVEN WHILE a record stays parked forever', async () => {
    const { warns, infos, log } = capturingLog();
    const outbox = scriptedOutbox([
      // Tick 1: one ACTIVE record aged well past the default 5-minute
      // threshold — a genuinely stuck queue, correctly alarmed on.
      { pending: 1, delivered: 0, failed: 0, oldest_pending_ms: 20 * 60_000, parked: 0 },
      // Tick 2: that record has since been abandoned by MAX_TRIES and PARKED —
      // `pending`/`oldest_pending_ms` now read the (empty) active queue, per
      // replica-outbox.ts's own contract, NOT the parked record's age.
      { pending: 0, delivered: 0, failed: 1, oldest_pending_ms: null, parked: 1 },
    ]);
    const drainer = startOutboxDrainer({
      outbox, client: noopClient, log,
      setIntervalFn: () => 0, clearIntervalFn: () => {},
    });

    await drainer.tick();
    expect(warns, 'tick 1: a genuinely stuck queue must still alarm').toHaveLength(1);
    expect(warns[0]?.[0]).toContain('not draining');

    await drainer.tick();
    // 🔴 THE CLAIM: an all-clear fires even though the file still holds a
    // record that will never move again. Before this card `oldest_pending_ms`
    // would have kept reporting that record's (old) age forever, and this
    // line would never have been reached.
    expect(infos.some(([m]) => m.includes('draining again')), 'the all-clear never fired').toBe(true);
  });

  it('REVERSE CONTROL — a queue that is GENUINELY still stuck does not clear', async () => {
    const { warns, infos, log } = capturingLog();
    const outbox = scriptedOutbox([
      { pending: 1, delivered: 0, failed: 0, oldest_pending_ms: 20 * 60_000, parked: 0 },
      // Still one ACTIVE record, still old — nothing parked, nothing improved.
      { pending: 1, delivered: 0, failed: 0, oldest_pending_ms: 21 * 60_000, parked: 0 },
    ]);
    const drainer = startOutboxDrainer({
      outbox, client: noopClient, log,
      setIntervalFn: () => 0, clearIntervalFn: () => {},
    });

    await drainer.tick();
    await drainer.tick();
    expect(warns).toHaveLength(1); // warned once, not re-warned (existing behaviour)
    expect(infos.some(([m]) => m.includes('draining again')), 'a still-stuck queue must not get an all-clear').toBe(false);
  });

  it('the parked count is surfaced on the stuck warning line', async () => {
    const { warns, log } = capturingLog();
    const outbox = scriptedOutbox([
      { pending: 1, delivered: 0, failed: 3, oldest_pending_ms: 20 * 60_000, parked: 3 },
    ]);
    const drainer = startOutboxDrainer({
      outbox, client: noopClient, log,
      setIntervalFn: () => 0, clearIntervalFn: () => {},
    });
    await drainer.tick();
    expect(warns[0]?.[1]?.parked).toBe(3);
  });
});
