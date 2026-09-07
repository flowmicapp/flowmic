// F6 (2026-09-02 audit) — ForwardLedger.prune() (node/forward-ledger.ts) had
// zero production callers: it was built, unit-tested (node-forwarding.test.ts
// exercises the function directly), and never armed on a timer anywhere
// bootstrap runs. node_forward_seen therefore grew without bound on every real
// writer deployment (~17k rows/PC/day at the route's own traffic estimate).
//
// This file is the wiring proof node-forwarding.test.ts's unit test could
// never be: it drives a REAL boot as a writer, with a fake scheduler standing
// in for setInterval, and shows the sweep this card adds actually reaches the
// real table through the real ledger instance the forward-receive route uses.
//
// SPEC-REF: apps/server-core/src/bootstrap-sweeps.ts (`forwardLedgerPrune`)
//           apps/server-core/src/bootstrap.ts (`forwardLedger` construction)
//           apps/server-core/src/node/forward-ledger.ts

import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { FORWARD_LEDGER_RETENTION_MS } from '../src/node/forward-ledger';

interface FakeTimer { fn: () => void; ms: number; cleared: boolean }

function fakeScheduler(): {
  timers: FakeTimer[];
  setIntervalFn: (fn: () => void, ms: number) => unknown;
  clearIntervalFn: (handle: unknown) => void;
  tick: () => void;
} {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setIntervalFn: (fn, ms): unknown => {
      const t: FakeTimer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearIntervalFn: (handle): void => { (handle as FakeTimer).cleared = true; },
    tick: (): void => { for (const t of timers) if (!t.cleared) t.fn(); },
  };
}

const ENV_KEYS = [
  'FLOWMIC_NODE_ID', 'FLOWMIC_NODE_ROLE', 'FLOWMIC_NODE_WRITER_URL',
  'FLOWMIC_NODE_SHARED_SECRET', 'FLOWMIC_NODE_OUTBOX_PATH',
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let server: BootstrapHandle | null = null;

afterEach(async () => {
  if (server) await server.close();
  server = null;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('F6: the writer prunes its forward-ledger dedup table on a real timer', () => {
  it('🔴 a real boot arms the sweep, and a tick really deletes the stale row', async () => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.FLOWMIC_NODE_ID = 'srvny';
    process.env.FLOWMIC_NODE_ROLE = 'writer';
    process.env.FLOWMIC_NODE_SHARED_SECRET = 'forward-ledger-prune-secret-32b';

    const sched = fakeScheduler();
    const config = loadConfig({ mode: 'saas', secret: 'forward-ledger-prune-wiring-32b', port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, {
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });

    // The table only exists because a WRITER mounts POST /api/node/forward's
    // receiver, which is the only thing that ever calls `makeForwardLedger`.
    // A row older than the retention window, planted directly — no real
    // forwarded write is needed to prove the SWEEP reaches this table.
    const staleAt = Date.now() - FORWARD_LEDGER_RETENTION_MS - 1000;
    server.db.raw.prepare('INSERT INTO node_forward_seen (id, node, kind, at) VALUES (?, ?, ?, ?)')
      .run('stale-id-1', 'srvjp', 'usage', staleAt);
    const freshAt = Date.now();
    server.db.raw.prepare('INSERT INTO node_forward_seen (id, node, kind, at) VALUES (?, ?, ?, ?)')
      .run('fresh-id-1', 'srvjp', 'usage', freshAt);

    const before = server.db.raw.prepare('SELECT id FROM node_forward_seen ORDER BY id').all() as Array<{ id: string }>;
    expect(before.map((r) => r.id)).toEqual(['fresh-id-1', 'stale-id-1']);

    sched.tick();

    const after = server.db.raw.prepare('SELECT id FROM node_forward_seen ORDER BY id').all() as Array<{ id: string }>;
    expect(after.map((r) => r.id)).toEqual(['fresh-id-1']);
  });

  it('REVERSE CONTROL — a SINGLE-NODE deployment arms no such timer at all', async () => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    const sched = fakeScheduler();
    const config = loadConfig({ mode: 'saas', secret: 'forward-ledger-prune-single-32b', port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, {
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    });
    // Single-node deployment: retention + P2-6's growth reaper + card PR-2's
    // recovery sweep share this override (see retention-cleanup.test.ts's own
    // "arms the sweep" test for that baseline) — a FOURTH timer here would mean
    // this card's sweep is arming even where there is no ledger to prune.
    //
    // ⚠️ THE COUNT ALONE IS NOT THE ASSERTION, and after PR-2 it could not be:
    // 「there are three timers」 stays true if the forward-ledger sweep armed and
    // the recovery sweep did not. The line below — the table does not exist on a
    // single node — is what actually says the forward ledger is unarmed here, and
    // it is the one that would have to be deleted to fake this test.
    expect(sched.timers).toHaveLength(3);
    expect(() => server!.db.raw.prepare('SELECT 1 FROM node_forward_seen').all()).toThrow();
  });
});
