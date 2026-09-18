// NR-67 — the background sweeps do not run on a read replica.
//
// SPEC-REF:
//   apps/server-core/src/bootstrap-sweeps.ts (the gate, and why it is one
//     decision rather than five)
//   apps/server-core/src/node/replica-puller.ts (what makes a replica's own
//     writes pointless: every shared table is DELETEd and re-INSERTed from the
//     writer's snapshot every 30 s)
//   docs/decisions/2026-09-17-owner-enables-anon-trial-cleanup-with-archive.md
//     (「要留下记录，以备数据分析」 — the promise a replica tick cannot keep)
//
// ── 🔴 THE FACT THIS FILE EXISTS FOR ───────────────────────────────────────
// srvjp (the JP replica) logged `anon cleanup {"mode":"dry-run"}` on 2026-09-14
// and 2026-09-15. Dry run was the ONLY thing standing between that and a sweep
// that deletes an anonymous identity, writes its archive rows, and then has both
// wiped by the next pull — 「destroyed without a record」, which is exactly the
// outcome the archive ruling was attached to prevent. The gate was an env var
// nobody had uncommented; this makes it the node's role.
//
// ⚠️ WHY THE ASSERTION IS 「THE ROW SURVIVES A TICK」 AND NOT 「NO TIMER」.
// Both are here, and they answer different questions. The timer census can stay
// green while a sweep runs from somewhere else; the surviving row can stay green
// because the probe is blind — a stale row that nothing would have deleted
// anyway survives on a writer too. So the writer case below is the POSITIVE
// CONTROL: the same plant, the same tick, and the row is GONE. Without it the
// replica assertion proves nothing at all.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { makeTrialLedger } from '../src/billing/trial-ledger';
import { ANON_CLEANUP_INTERVAL_MS, ANON_ROW_RETENTION_MS } from '../src/db/anon-cleanup';

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
  'FLOWMIC_WEB_ANON_CLEANUP_APPLY',
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let server: BootstrapHandle | null = null;
let dir: string | null = null;

function clearEnv(): void {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
}

afterEach(async () => {
  if (server) await server.close();
  server = null;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = null;
});

/** Mint an anonymous identity that is already past the 48-hour window, through
 *  the SAME ledger the site demo uses — not by hand-writing rows, so the sweep
 *  sees the shape it sees in production. */
function plantExpiredDemoIdentity(handle: BootstrapHandle): string {
  const ledger = makeTrialLedger({ rows: handle.db.trials, users: handle.db.users });
  return ledger.claim({
    deviceUid: 'wb-nr67',
    ipBucket: 'bucket',
    nowMs: Date.now() - ANON_ROW_RETENTION_MS - 60 * 60 * 1000,
    tokenTtlMs: 60 * 60 * 1000,
    newId: () => 'anon-nr67',
    newToken: () => 'fm_nr67',
  }).userId;
}

function userRowCount(handle: BootstrapHandle, id: string): number {
  const row = handle.db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(id) as { n: number };
  return row.n;
}

/** How many of this boot's timers run on the daily cadence.
 *
 *  All four sweeps in bootstrap-sweeps.ts share DAY_MS, and on a WRITER the
 *  forward-ledger prune (F6) makes a fifth at the same cadence — measured, not
 *  assumed: the first version of this helper expected 4 on a writer and the
 *  writer case failed with 5. The replica's own puller (30 s) and outbox drainer
 *  never collide with this number. */
function dailyTimers(sched: { timers: FakeTimer[] }): number {
  return sched.timers.filter((t) => t.ms === ANON_CLEANUP_INTERVAL_MS).length;
}

describe('NR-67: a read replica arms no destructive sweep', () => {
  it('🔴 a replica schedules no daily sweep, and a tick leaves the expired anonymous identity alone', async () => {
    clearEnv();
    dir = mkdtempSync(join(tmpdir(), 'flowmic-nr67-replica-'));
    process.env.FLOWMIC_NODE_ID = 'srvjp';
    process.env.FLOWMIC_NODE_ROLE = 'replica';
    // Loopback, and nothing is listening: a pull that fails is logged and
    // survived by design (replica-puller.ts), so ticking here cannot reach the
    // network and cannot rewrite the table under the assertion.
    process.env.FLOWMIC_NODE_WRITER_URL = 'http://127.0.0.1:1';
    process.env.FLOWMIC_NODE_SHARED_SECRET = 'nr67-replica-node-secret-32bytes';
    process.env.FLOWMIC_NODE_OUTBOX_PATH = join(dir, 'outbox.jsonl');
    // 🔴 ARMED. The bug this card closes is not 「a replica runs a dry run」, it
    // is 「a replica runs whatever this variable says」 — so the test sets the
    // variable to the dangerous value and asserts the ROLE stops it anyway.
    process.env.FLOWMIC_WEB_ANON_CLEANUP_APPLY = '1';

    const sched = fakeScheduler();
    const config = loadConfig({ mode: 'saas', secret: 'nr67-replica-gate-secret-32bytes', port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, { setIntervalFn: sched.setIntervalFn, clearIntervalFn: sched.clearIntervalFn });

    const userId = plantExpiredDemoIdentity(server);
    expect(userRowCount(server, userId)).toBe(1);

    expect(dailyTimers(sched)).toBe(0);
    sched.tick();
    expect(userRowCount(server, userId)).toBe(1);
  });

  it('POSITIVE CONTROL — a WRITER arms them and the same tick really destroys it', async () => {
    clearEnv();
    process.env.FLOWMIC_NODE_ID = 'srvny';
    process.env.FLOWMIC_NODE_ROLE = 'writer';
    process.env.FLOWMIC_NODE_SHARED_SECRET = 'nr67-writer-node-secret-32bytesxx';
    process.env.FLOWMIC_WEB_ANON_CLEANUP_APPLY = '1';

    const sched = fakeScheduler();
    const config = loadConfig({ mode: 'saas', secret: 'nr67-writer-gate-secret-32bytesx', port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, { setIntervalFn: sched.setIntervalFn, clearIntervalFn: sched.clearIntervalFn });

    const userId = plantExpiredDemoIdentity(server);
    expect(userRowCount(server, userId)).toBe(1);

    // Four sweeps + the writer-only forward-ledger prune, which is already
    // writer-gated by its own construction in bootstrap.ts.
    expect(dailyTimers(sched)).toBe(5);
    sched.tick();
    // Gone, and its record kept: the archive row is what owner's ruling asked
    // for, and it is the thing a replica tick would have destroyed with it.
    expect(userRowCount(server, userId)).toBe(0);
    const archived = server.db.raw
      .prepare('SELECT COUNT(*) AS n FROM trial_ledger_archive WHERE anon_user_id = ?').get(userId) as { n: number };
    expect(archived.n).toBe(1);
  });

  it('a deployment with NO node variables at all is a writer — production today, unchanged', async () => {
    clearEnv();
    process.env.FLOWMIC_WEB_ANON_CLEANUP_APPLY = '1';

    const sched = fakeScheduler();
    const config = loadConfig({ mode: 'saas', secret: 'nr67-single-gate-secret-32bytesx', port: 0, dbPath: ':memory:', trustedProxies: [] });
    server = await startServer(config, { setIntervalFn: sched.setIntervalFn, clearIntervalFn: sched.clearIntervalFn });

    const userId = plantExpiredDemoIdentity(server);
    // `single` is the default role and must stay permissive: the gate reads
    // `role === 'replica'`, so a missing variable can never silence a sweep.
    expect(dailyTimers(sched)).toBe(4);
    sched.tick();
    expect(userRowCount(server, userId)).toBe(0);
  });
});
