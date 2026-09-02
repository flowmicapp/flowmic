// SPEC-REF:
//   apps/server-core/src/db/replica-outbox.ts
//   docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §3-4
//
// The assertions that carry weight here are the ones about LOSS, because loss
// is the only outcome of this module that costs money and the only one that is
// invisible when it happens. Everything else — ordering, stats, duplicates — is
// recoverable or cosmetic.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_TRIES, ReplicaOutbox, type OutboxRecord } from '../src/db/replica-outbox';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  file = join(dir, 'nested', 'outbox.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const usage = (id: string): Omit<OutboxRecord, 'at'> => ({
  id,
  kind: 'usage',
  body: { user_id: 'u1', stt_ms: 1800_000 },
});

describe('ReplicaOutbox: durability', () => {
  it('🔴 the fact is on disk before enqueue returns', () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    // Read the file directly, not through the object: a queue that only
    // remembers in memory passes every other test in this file and loses
    // everything on the one event it exists for.
    expect(readFileSync(file, 'utf8')).toContain('"id":"a"');
  });

  it('a fresh process finds what the previous one owed', () => {
    new ReplicaOutbox(file).enqueue(usage('a'));
    expect(new ReplicaOutbox(file).pending().map((r) => r.id)).toEqual(['a']);
  });

  it('creates its directory rather than throwing on the first write', () => {
    expect(existsSync(dir)).toBe(true);
    new ReplicaOutbox(file).enqueue(usage('a'));
    expect(existsSync(file)).toBe(true);
  });
});

describe('ReplicaOutbox: delivery', () => {
  it('delivered records leave the queue, undelivered ones stay', async () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    ob.enqueue(usage('b'));
    await ob.drain(async (r) => r.id === 'a');
    expect(ob.pending().map((r) => r.id)).toEqual(['b']);
  });

  it('🔴 a send that THROWS is a retry, not a loss', async () => {
    // The dangerous shape: an exception that unwinds past the bookkeeping and
    // drops the record along with the stack.
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    await ob.drain(async () => {
      throw new Error('writer unreachable');
    });
    expect(ob.pending().map((r) => r.id)).toEqual(['a']);
  });

  it('🔴 negative control: a send that RESOLVES FALSE also keeps it', async () => {
    // Without this, a change that only handled thrown errors would look correct
    // — and a writer answering 500 politely would silently eat every record.
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    await ob.drain(async () => false);
    expect(ob.pending().map((r) => r.id)).toEqual(['a']);
  });

  it('counts attempts in the RECORD, so a restart does not reset them', async () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    await ob.drain(async () => false);
    await ob.drain(async () => false);
    // Re-open: the count has to survive the process, or a poison record retries
    // forever across restarts and never reaches the parked state an operator
    // can see.
    expect(new ReplicaOutbox(file).pending()[0]?.tries).toBe(2);
  });

  it('parks a record after MAX_TRIES but does NOT drop it', async () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    for (let i = 0; i <= MAX_TRIES + 1; i++) await ob.drain(async () => false);
    // Still there. A metering record we cannot deliver is something an operator
    // must be able to find; discarding it would be the silent failure this
    // module exists to prevent, one layer deeper.
    expect(ob.pending().map((r) => r.id)).toEqual(['a']);
    expect(ob.stats().failed).toBeGreaterThan(0);
  });

  it('🔴 F1: `failed` counts a parked record ONCE, not once per tick forever', async () => {
    // Before this card, every drain cycle after parking re-entered the parking
    // branch (a frozen `tries` is never NOT over the limit again) and
    // incremented `failed` again — a metric that grew without bound for the
    // rest of the process's life over a SINGLE poison record.
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    for (let i = 0; i <= MAX_TRIES + 1; i++) await ob.drain(async () => false);
    expect(ob.stats().failed).toBe(1);
    // Ten MORE drain cycles on the same already-parked record.
    for (let i = 0; i < 10; i++) await ob.drain(async () => false);
    expect(ob.stats().failed, 'failed must not grow past the ONE real failure').toBe(1);
  });

  it('🔴 F1: a parked record is excluded from pending/oldest_pending_ms and counted in `parked`', async () => {
    // outbox-drainer.ts's stuck-queue alarm reads `oldest_pending_ms` as "is the
    // ACTIVE queue draining". Before this card a permanently-parked record's
    // age stayed IN that number forever, so the alarm could never clear again
    // even while every other record flowed normally.
    const ob = new ReplicaOutbox(file);
    ob.enqueue({ ...usage('poison'), at: Date.now() - 20 * 60_000 }); // old — would read as "stuck" if counted
    for (let i = 0; i <= MAX_TRIES + 1; i++) await ob.drain(async () => false);

    const parkedOnly = ob.stats();
    expect(parkedOnly.pending, 'the parked record must not count as pending').toBe(0);
    expect(parkedOnly.oldest_pending_ms, 'no ACTIVE record ⇒ null, not the poison record\'s age').toBeNull();
    expect(parkedOnly.parked).toBe(1);

    // A fresh, healthy record now shares the file with the permanently parked
    // one. It must read as a fast-draining queue on its own merits.
    ob.enqueue({ ...usage('fresh'), at: Date.now() });
    const mixed = ob.stats();
    expect(mixed.pending).toBe(1);
    expect(mixed.oldest_pending_ms, 'must be the FRESH record\'s age, not the poison record\'s').toBeLessThan(5_000);
    expect(mixed.parked).toBe(1);
  });

  it('retries deliver at-least-once rather than at-most-once', async () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    const seen: string[] = [];
    await ob.drain(async (r) => {
      seen.push(r.id);
      return false;
    });
    await ob.drain(async (r) => {
      seen.push(r.id);
      return true;
    });
    // The writer sees it twice and dedupes on `id`. That is the deliberate
    // trade: a duplicate is a rounding error the writer drops, a loss is money.
    expect(seen).toEqual(['a', 'a']);
    expect(ob.pending()).toEqual([]);
  });
});

describe('ReplicaOutbox: survives a damaged file', () => {
  it('skips a torn line and still delivers the rest', () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    // A power cut mid-append leaves a partial line. One bad line must not make
    // the whole queue undeliverable.
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"id":"b","kind":"usa`, 'utf8');
    ob.enqueue(usage('c'));
    expect(ob.pending().map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('ReplicaOutbox: stats say whether the queue is MOVING', () => {
  it('oldest_pending_ms is null on an empty queue, not zero', () => {
    // Zero would read as "the oldest record is brand new", which is a different
    // fact from "there are no records" — and an alert built on it would be
    // permanently reassured.
    expect(new ReplicaOutbox(file).stats().oldest_pending_ms).toBeNull();
  });

  it('reports an age once something is owed', () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue({ ...usage('a'), at: Date.now() - 5_000 } as OutboxRecord);
    expect(ob.stats().oldest_pending_ms).toBeGreaterThanOrEqual(4_000);
  });
});

describe('ReplicaOutbox: the compaction must not eat what arrived during the drain', () => {
  it('🔴 a record enqueued WHILE send was in flight survives', async () => {
    // Found by probe, not by reading: the first implementation snapshotted the
    // queue, awaited the network, then wrote the snapshot-minus-delivered back —
    // silently deleting anything the process enqueued in between. The drain
    // reported success while the record was gone. `send` is async and this
    // process keeps metering during it, so this is the ordinary case on a busy
    // node, not an exotic one.
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    await ob.drain(async () => {
      ob.enqueue(usage('late'));
      return true;
    });
    expect(ob.pending().map((r) => r.id)).toEqual(['late']);
  });

  it('a concurrent drain is a no-op rather than a second sender', async () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    let sends = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const first = ob.drain(async () => { sends += 1; await gate; return true; });
    const second = await ob.drain(async () => { sends += 1; return true; });
    release();
    await first;
    // Two overlapping drains would send the same record twice — survivable
    // (the writer dedupes) but it doubles the wire for nothing, and the two
    // compactions would race with the loser silently reviving delivered records.
    expect(sends).toBe(1);
    expect(second.pending).toBe(1);
  });
});

describe('ReplicaOutbox: drainBatch tells apart refused from never-asked', () => {
  it('🔴 an id the sender said NOTHING about keeps its try count', async () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('asked'));
    ob.enqueue(usage('silent'));
    await ob.drainBatch(async () => new Map([['asked', false]]));
    const byId = Object.fromEntries(ob.pending().map((r) => [r.id, r.tries ?? 0]));
    // 「the writer refused this」 and 「the writer never saw this」 are different
    // facts. Charging a retry for the second burns a record's budget toward the
    // parked state for something that was never its fault — and the record that
    // gets parked is a billing fact.
    expect(byId).toEqual({ asked: 1, silent: 0 });
  });

  it('negative control: a sender that throws marks NOTHING', async () => {
    const ob = new ReplicaOutbox(file);
    ob.enqueue(usage('a'));
    await ob.drainBatch(async () => { throw new Error('writer down'); });
    expect(ob.pending().map((r) => r.tries ?? 0)).toEqual([0]);
  });
});
