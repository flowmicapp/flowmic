// SPEC-REF:
//   apps/server-core/src/node/node-config.ts
//   apps/server-core/src/node/forwarded-write.ts
//   apps/server-core/src/node/forward-ledger.ts
//   apps/server-core/src/node/forward-receiver.ts
//   apps/server-core/src/node/forwarding-usage-tracker.ts
//
// The assertions that carry weight here are about MONEY MOVING TWICE and MONEY
// NOT MOVING AT ALL. Everything else in this subsystem is recoverable.

import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeConfigError, readNodeConfig } from '../src/node/node-config';
import { makeForwardLedger } from '../src/node/forward-ledger';
import { makeForwardReceiver } from '../src/node/forward-receiver';
import { makeForwardingUsageTracker } from '../src/node/forwarding-usage-tracker';
import { ReplicaOutbox } from '../src/db/replica-outbox';
import { parseForwardedWrite, applyForwardedWrite, type ForwardTargets } from '../src/node/forwarded-write';
import type { UsageTracker } from '../src/billing/usage-tracker';
import { makeAuthoritativeQuotaReader } from '../src/node/authoritative-quota';
import { wireNodeRuntime } from '../src/node/node-runtime';

// ── node-config: every incoherent combination stops the boot ─────────────────

describe('readNodeConfig — a misconfiguration fails the BOOT, not a session', () => {
  it('an untouched deployment is `single`, and that must never change', () => {
    // The whole product until today sets none of these. If this test ever needs
    // editing, something has changed the default behaviour of every existing
    // installation.
    expect(readNodeConfig({}).role).toBe('single');
  });

  it('🔴 a writer URL with no role is refused rather than guessed', () => {
    // The dangerous shape: inferring `replica` from the URL means a typo'd role
    // silently leaves a node writing into a file the next pull overwrites.
    expect(() => readNodeConfig({ FLOWMIC_NODE_WRITER_URL: 'https://w' }))
      .toThrow(NodeConfigError);
  });

  it('rejects an unknown role', () => {
    expect(() => readNodeConfig({ FLOWMIC_NODE_ROLE: 'reader' })).toThrow(/single \| writer \| replica/);
  });

  it('a replica must name a writer, a secret, an outbox and itself', () => {
    const base = { FLOWMIC_NODE_ROLE: 'replica' } as NodeJS.ProcessEnv;
    expect(() => readNodeConfig(base)).toThrow(/FLOWMIC_NODE_ID/);
    expect(() => readNodeConfig({ ...base, FLOWMIC_NODE_ID: 'srvjp' })).toThrow(/WRITER_URL/);
    expect(() => readNodeConfig({
      ...base, FLOWMIC_NODE_ID: 'srvjp', FLOWMIC_NODE_WRITER_URL: 'https://w',
    })).toThrow(/SHARED_SECRET/);
    expect(() => readNodeConfig({
      ...base, FLOWMIC_NODE_ID: 'srvjp', FLOWMIC_NODE_WRITER_URL: 'https://w',
      FLOWMIC_NODE_SHARED_SECRET: 's',
    })).toThrow(/OUTBOX_PATH/);
  });

  it('🔴 refuses a plaintext writer URL across the network', () => {
    // The forwarded payload carries metering and the shared secret. This is the
    // confidentiality of the whole channel, not a hardening preference.
    expect(() => readNodeConfig({
      FLOWMIC_NODE_ROLE: 'replica', FLOWMIC_NODE_ID: 'srvjp',
      FLOWMIC_NODE_WRITER_URL: 'http://srvny.flowmic.app',
      FLOWMIC_NODE_SHARED_SECRET: 's', FLOWMIC_NODE_OUTBOX_PATH: '/tmp/o',
    })).toThrow(/https/);
  });

  it('allows loopback http, because there is no network to cross', () => {
    const cfg = readNodeConfig({
      FLOWMIC_NODE_ROLE: 'replica', FLOWMIC_NODE_ID: 'srvjp',
      FLOWMIC_NODE_WRITER_URL: 'http://127.0.0.1:3310',
      FLOWMIC_NODE_SHARED_SECRET: 's', FLOWMIC_NODE_OUTBOX_PATH: '/tmp/o',
    });
    expect(cfg.role).toBe('replica');
  });

  it('a writer with no shared secret is refused', () => {
    // Otherwise /api/node/forward accepts records from anyone who can reach it.
    expect(() => readNodeConfig({ FLOWMIC_NODE_ROLE: 'writer', FLOWMIC_NODE_ID: 'srvny' }))
      .toThrow(/SHARED_SECRET/);
  });
});

// ── the ledger: exactly once, or not at all ─────────────────────────────────

const ledgerDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE effects (n INTEGER)');
  return db;
};

describe('ForwardLedger — the claim and the effect are one transaction', () => {
  it('performs an id once', () => {
    const db = ledgerDb();
    const ledger = makeForwardLedger(db);
    let ran = 0;
    expect(ledger.once({ id: 'a' }, () => { ran += 1; })).toBe('accepted');
    expect(ledger.once({ id: 'a' }, () => { ran += 1; })).toBe('duplicate');
    expect(ran).toBe(1);
  });

  it('🔴 an effect that THROWS leaves the id unclaimed, so the retry works', () => {
    // The failure this ordering exists to prevent: claim-then-apply spends the
    // id, the apply fails, the replica is told 「duplicate」 on retry, and the
    // minutes are gone silently. Both ends would report success.
    const db = ledgerDb();
    const ledger = makeForwardLedger(db);
    expect(() => ledger.once({ id: 'a' }, () => { throw new Error('db full'); })).toThrow('db full');
    let ran = 0;
    expect(ledger.once({ id: 'a' }, () => { ran += 1; })).toBe('accepted');
    expect(ran).toBe(1);
  });

  it('🔴 negative control: the effect is rolled back with the claim', () => {
    // Without the transaction, a partial effect would survive a failed apply and
    // the successful retry would double it. This asserts the ROLLBACK, which the
    // test above cannot see.
    const db = ledgerDb();
    const ledger = makeForwardLedger(db);
    const ins = db.prepare('INSERT INTO effects (n) VALUES (?)');
    expect(() => ledger.once({ id: 'a' }, () => {
      ins.run(1);
      throw new Error('boom after a partial write');
    })).toThrow();
    const rows = db.prepare('SELECT COUNT(*) AS c FROM effects').get() as { c: number };
    expect(Number(rows.c)).toBe(0);
  });

  it('prune drops only what is past the retention window', () => {
    const db = ledgerDb();
    const ledger = makeForwardLedger(db);
    const now = 1_800_000_000_000;
    ledger.once({ id: 'old', at: now - 30 * 24 * 3600_000 }, () => {});
    ledger.once({ id: 'new', at: now }, () => {});
    expect(ledger.prune(now)).toBe(1);
    expect(ledger.once({ id: 'new' }, () => {})).toBe('duplicate');
  });
});

// ── the receiver: per record, never per batch ───────────────────────────────

const spyTargets = (): { t: ForwardTargets; calls: string[] } => {
  const calls: string[] = [];
  const usage: UsageTracker = {
    recordSttUsage: (u, _e, ms) => { calls.push(`stt:${u}:${ms}`); },
    recordLlmUsage: (u, _e, i, o) => { calls.push(`llm:${u}:${i}/${o}`); },
    recordQuotaRefusal: (u, k, r) => { calls.push(`refused:${u}:${k}:${r}`); },
  };
  return {
    calls,
    t: {
      usage,
      setHomeNode: (pc, n) => { calls.push(`home:${pc}:${n}`); },
      setPresence: (pc, on) => { calls.push(`presence:${pc}:${on}`); },
    },
  };
};

const sttRecord = (id: string, ms = 60_000) => ({
  id, kind: 'usage', at: 1, node: 'srvjp',
  body: { kind: 'usage.stt', user_id: 'u1', engine: { is_byok: false }, duration_ms: ms, chars: { transcript: 1, delivered: 1 } },
});

describe('forward receiver — one bad record does not stop the good ones', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = ledgerDb(); });

  it('🔴 a malformed record is rejected while its neighbours are performed', () => {
    // The shape that matters: a replica running an older build sends one kind
    // this writer has never heard of. Failing the batch would make it retry
    // forever with the poison record at the front and everything stuck behind.
    const { t, calls } = spyTargets();
    const rejected: string[] = [];
    const recv = makeForwardReceiver({
      ledger: makeForwardLedger(db), targets: t,
      onRejected: (id) => rejected.push(id),
    });
    const out = recv([
      sttRecord('good1'),
      { id: 'bad', kind: 'usage', at: 1, body: { kind: 'usage.telepathy' } },
      sttRecord('good2', 30_000),
    ], 'srvjp');
    expect(out).toEqual({ good1: 'accepted', bad: 'rejected', good2: 'accepted' });
    expect(calls).toEqual(['stt:u1:60000', 'stt:u1:30000']);
    expect(rejected).toEqual(['bad']);
  });

  it('🔴 a record replayed after a lost ack is a duplicate, not a second charge', () => {
    const { t, calls } = spyTargets();
    const recv = makeForwardReceiver({ ledger: makeForwardLedger(db), targets: t });
    recv([sttRecord('x')], 'srvjp');
    expect(recv([sttRecord('x')], 'srvjp')).toEqual({ x: 'duplicate' });
    expect(calls).toEqual(['stt:u1:60000']);
  });

  it('🔴 a record that FAILED is left out of the outcomes entirely', () => {
    // Not `rejected`. The replica reads a missing id as 「retry」 and a
    // `rejected` as 「park it」 — reporting a transient database error as
    // permanent would discard a billing fact. Silence is not consent.
    const failing: ForwardTargets = {
      ...spyTargets().t,
      usage: {
        recordSttUsage: () => { throw new Error('disk full'); },
        recordLlmUsage: () => {},
        recordQuotaRefusal: () => {},
      },
    };
    const failed: string[] = [];
    const recv = makeForwardReceiver({
      ledger: makeForwardLedger(db), targets: failing,
      onFailed: (id) => failed.push(id),
    });
    expect(recv([sttRecord('x')], 'srvjp')).toEqual({});
    expect(failed).toEqual(['x']);
  });

  it('every forwardable kind reaches its own seam', () => {
    // The closed union's whole point: adding a member without teaching the
    // writer to perform it must not compile. This is the runtime half.
    const { t, calls } = spyTargets();
    const recv = makeForwardReceiver({ ledger: makeForwardLedger(db), targets: t });
    recv([
      sttRecord('a'),
      { id: 'b', kind: 'usage', at: 1, body: { kind: 'usage.llm', user_id: 'u1', engine: { is_byok: false }, tokens_in: 10, tokens_out: 20 } },
      { id: 'c', kind: 'usage', at: 1, body: { kind: 'usage.quota_refused', user_id: 'u1', event_kind: 'stt', refused_user_id: 'u2' } },
      { id: 'd', kind: 'home_node', at: 1, body: { kind: 'pc.home_node', pc_id: 'p1', home_node: 'srvjp' } },
      { id: 'e', kind: 'presence', at: 1, body: { kind: 'pc.presence', pc_id: 'p1', is_online: true, last_seen_at: 5 } },
    ], 'srvjp');
    expect(calls).toEqual([
      'stt:u1:60000', 'llm:u1:10/20', 'refused:u1:stt:u2', 'home:p1:srvjp', 'presence:p1:true',
    ]);
  });
});

// ── the replica's tracker: durable before it returns ────────────────────────

describe('forwarding UsageTracker — the fact is on disk before the call returns', () => {
  it('all three metering methods become owed records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fwd-'));
    try {
      const outbox = new ReplicaOutbox(join(dir, 'o.jsonl'));
      let n = 0;
      const tracker = makeForwardingUsageTracker({
        outbox, nodeId: 'srvjp', newId: () => `id${++n}`,
      });
      tracker.recordSttUsage('u1', { is_byok: false }, 1000, { transcript: 1, delivered: 1 });
      tracker.recordLlmUsage('u1', { is_byok: false }, 5, 6);
      tracker.recordQuotaRefusal('u1', 'stt', 'u2');
      // 🔴 Read the FILE, not the object: a queue that only remembers in memory
      // passes every other assertion here and loses everything on a restart.
      const kinds = outbox.pending().map((r) => (r.body as { kind: string }).kind);
      expect(kinds).toEqual(['usage.stt', 'usage.llm', 'usage.quota_refused']);
      expect(outbox.pending().every((r) => r.node === 'srvjp')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('🔴 does NOT filter zero-length or BYOK, on purpose', () => {
    // Re-stating the writer's billing predicates here would make the replica a
    // second author of them, and the two would agree until someone edited one.
    // If this test is ever "fixed" to expect filtering, read forwarded-write.ts.
    const dir = mkdtempSync(join(tmpdir(), 'fwd2-'));
    try {
      const outbox = new ReplicaOutbox(join(dir, 'o.jsonl'));
      const tracker = makeForwardingUsageTracker({ outbox, nodeId: 'srvjp', newId: () => 'z' });
      tracker.recordSttUsage('u1', { is_byok: true }, 0, { transcript: 0, delivered: 0 });
      expect(outbox.pending()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a round trip through parse+apply preserves the arguments verbatim', () => {
    const { t, calls } = spyTargets();
    applyForwardedWrite(parseForwardedWrite({
      kind: 'usage.stt', user_id: 'u9', engine: { is_byok: false },
      duration_ms: 1_234_567, chars: { transcript: 3, delivered: 4 },
    }), t);
    expect(calls).toEqual(['stt:u9:1234567']);
  });
});

// ── the authoritative quota read ───────────────────────────────────────────

describe('authoritative quota — the ONE read that leaves a replica', () => {
  it('🔴 the read is SYNCHRONOUS and never awaits the writer', () => {
    // Constraint ① — this runs at engine-leg birth, on the hot path, because the
    // owner ruling was explicitly 「这个过程要很短」. A version that awaited would
    // still pass a test that awaited it; this one asserts the call returns a
    // number by itself, with the writer's promise still unresolved.
    let resolveWriter: (n: number) => void = () => {};
    const reader = makeAuthoritativeQuotaReader({
      local: { remainingSttMs: () => 111 },
      askWriter: () => new Promise<number>((r) => { resolveWriter = r; }),
      log: { warn: () => {} },
    });
    expect(reader.remainingSttMs('u1')).toBe(111);
    resolveWriter(0);
  });

  it('serves the writer’s answer once it has arrived', async () => {
    let answer = 900;
    const reader = makeAuthoritativeQuotaReader({
      local: { remainingSttMs: () => 111 },
      askWriter: async () => answer,
      log: { warn: () => {} },
    });
    reader.remainingSttMs('u1');            // first read: local, kicks off refresh
    await new Promise((r) => setImmediate(r));
    expect(reader.remainingSttMs('u1')).toBe(900);
    answer = 5;
    // Within the staleness window the cell stands — constraint ③, the floor.
    expect(reader.remainingSttMs('u1')).toBe(900);
  });

  it('🔴 an unreachable writer KEEPS the last known budget — never zero', async () => {
    // Constraint ②. Zeroing here would end a live thirty-minute recording
    // because of somebody else's network, which is the exact failure the
    // existing catch in stt/quota-recheck.ts exists to prevent.
    let fail = false;
    const reader = makeAuthoritativeQuotaReader({
      local: { remainingSttMs: () => 111 },
      askWriter: async () => {
        if (fail) throw new Error('writer unreachable');
        return 900;
      },
      staleAfterMs: 0,
      log: { warn: () => {} },
    });
    reader.remainingSttMs('u1');
    await new Promise((r) => setImmediate(r));
    expect(reader.remainingSttMs('u1')).toBe(900);
    fail = true;
    reader.remainingSttMs('u1');
    await new Promise((r) => setImmediate(r));
    expect(reader.remainingSttMs('u1')).toBe(900);
  });

  it('does not stampede the writer with one request per read', async () => {
    let asks = 0;
    const reader = makeAuthoritativeQuotaReader({
      local: { remainingSttMs: () => 111 },
      askWriter: async () => { asks += 1; return 900; },
      log: { warn: () => {} },
    });
    for (let i = 0; i < 20; i += 1) reader.remainingSttMs('u1');
    await new Promise((r) => setImmediate(r));
    expect(asks).toBe(1);
  });

  it('🔴 wrapQuota is IDENTITY off a replica', () => {
    // Every deployment that exists today is single-node. A wrapper that always
    // wrapped would put a Map lookup and a staleness check on all of their hot
    // paths in exchange for nothing.
    const runtime = wireNodeRuntime({
      db: { usage: {}, usageEvents: {}, raw: {} } as never,
      config: { mode: 'standalone', usageEventsEnabled: false } as never,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      periodKeyFor: () => 'p',
    });
    const guard = { remainingSttMs: () => 42 };
    expect(runtime.wrapQuota(guard)).toBe(guard);
  });
});

describe('a forwarded record bills in ITS OWN month, not the delivery month', () => {
  // 🔴 Raised by the other window while describing CR-3, which keeps the
  // microphone open through a link death: a phone can capture for minutes with
  // no socket and replay on reconnect, so "delivered long after the seconds it
  // describes" stopped being an outage-only case.
  //
  // The meter buckets into currentMonth(clock). Without the pin, a record
  // enqueued at 23:59:58 on 31 August and delivered at 00:00:02 on 1 September
  // is billed to September: both months wrong, nobody told.
  const AUG_31_2359 = Date.parse('2026-08-31T23:59:58.000Z');
  const SEP_01_0000 = Date.parse('2026-09-01T00:00:02.000Z');

  it('🔴 the clock is pinned to the record, so August stays August', () => {
    const db = ledgerDb();
    const seen: number[] = [];
    let clockNow = SEP_01_0000;
    let pinned = 0;
    const recv = makeForwardReceiver({
      ledger: makeForwardLedger(db),
      pinClock: (at) => { pinned = at; },
      targets: {
        usage: {
          // Stands in for the meter reading its clock: whatever the tracker
          // would see at the instant of the call.
          recordSttUsage: () => { seen.push(pinned > 0 ? pinned : clockNow); },
          recordLlmUsage: () => {},
          recordQuotaRefusal: () => {},
        },
        setHomeNode: () => {}, setPresence: () => {},
      },
    });
    recv([{ ...sttRecord('late'), at: AUG_31_2359 }], 'srvjp');
    expect(new Date(seen[0]!).toISOString().slice(0, 7)).toBe('2026-08');
    expect(clockNow).toBe(SEP_01_0000); // the delivery instant really was September
  });

  it('🔴 the pin is RELEASED even when the apply throws', () => {
    // Otherwise the next LOCAL metering call on this process carries a forwarded
    // record's timestamp — a defect that would present as clock drift and would
    // be hunted anywhere but here.
    const db = ledgerDb();
    let pinned = -1;
    const recv = makeForwardReceiver({
      ledger: makeForwardLedger(db),
      pinClock: (at) => { pinned = at; },
      targets: {
        usage: {
          recordSttUsage: () => { throw new Error('disk full'); },
          recordLlmUsage: () => {}, recordQuotaRefusal: () => {},
        },
        setHomeNode: () => {}, setPresence: () => {},
      },
    });
    recv([{ ...sttRecord('boom'), at: AUG_31_2359 }], 'srvjp');
    expect(pinned).toBe(0);
  });
});

describe('home_node is recorded on WHICHEVER node admits the PC', () => {
  // 🔴 The reason this exists at all: a phone locating its PC asks the WRITER.
  // A replica that admitted a PC and did not forward the fact would leave every
  // PC on it permanently unlocatable — the feature would look implemented, every
  // test would pass, and phones would be sent to the wrong node forever.
  const runtime = (env: NodeJS.ProcessEnv, dir?: string) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    if (dir) process.env.FLOWMIC_NODE_OUTBOX_PATH = join(dir, 'o.jsonl');
    try {
      const set: string[] = [];
      const rt = wireNodeRuntime({
        db: { usage: {}, usageEvents: {}, raw: {}, pcs: { setHomeNode: (id: string, n: string) => set.push(`${id}:${n}`) } } as never,
        config: { mode: 'saas', usageEventsEnabled: false } as never,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        periodKeyFor: () => 'p',
      });
      return { rt, set };
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  it('a WRITER stamps it locally', () => {
    const { rt, set } = runtime({
      FLOWMIC_NODE_ROLE: 'writer', FLOWMIC_NODE_ID: 'srvny', FLOWMIC_NODE_SHARED_SECRET: 's',
    });
    rt.stampHomeNode?.('pc-1');
    expect(set).toEqual(['pc-1:srvny']);
  });

  it('🔴 a REPLICA forwards it instead of writing it locally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hn-'));
    try {
      const { rt, set } = runtime({
        FLOWMIC_NODE_ROLE: 'replica', FLOWMIC_NODE_ID: 'srvjp',
        FLOWMIC_NODE_WRITER_URL: 'https://w.example', FLOWMIC_NODE_SHARED_SECRET: 's',
      }, dir);
      rt.stampHomeNode?.('pc-1');
      // Not written locally — a local write lands in a snapshot the next pull
      // replaces, so it would be a success that was not true.
      expect(set).toEqual([]);
      const owed = new ReplicaOutbox(join(dir, 'o.jsonl')).pending();
      expect(owed.map((r) => r.body)).toEqual([
        { kind: 'pc.home_node', pc_id: 'pc-1', home_node: 'srvjp' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a SINGLE node has no such fact, and says so with null', () => {
    // Not a no-op function: null. With one node there is nothing to record, and
    // writing a node id there would assert something nothing observed.
    expect(runtime({}).rt.stampHomeNode).toBeNull();
  });
});
