// Card D8 (0.3.0) — corrupted timeline data must never be silently clobbered.
//
// The defect: hydrate() wrapped its four reads in ONE try with an EMPTY catch, and
// the constructor calls persist() immediately after — so a corrupt-but-recoverable
// payload was overwritten with an empty array, zero log lines, in the store the repo
// declares the SOLE OWNER of the user's records.
//
// These tests pin the D8 rule: quarantine the bytes to `<key>.corrupt-<timestamp>`
// BEFORE anything can overwrite them; log loudly; a MISSING key stays a silent clean
// first run; a payload that could not be secured blocks every later write to its key.
//
// The key names and the `.corrupt-` infix are written as LITERALS on purpose: they
// are on-disk contract (the address of data already on users' machines), and a test
// importing the constant would follow a rename instead of failing on one.

import { describe, expect, it } from 'vitest';
import { TimelineStore } from './timeline-store';
import type { InjectResult, ReportingKvStore, TimelineTransport, WireHistoryItem } from './types';

const ROWS_KEY = 'flowmic.history.cache';
const QUEUE_KEY = 'flowmic.history.queue';
const IMAGES_KEY = 'flowmic.history.images';
const RETENTION_KEY = 'flowmic.history.retention';
const CORRUPT_INFIX = '.corrupt-';

/** A frozen clock so the quarantine key is predictable. */
const NOW = 1_722_750_000_000;

class StubTransport implements TimelineTransport {
  async reInjectLocally(): Promise<InjectResult | null> {
    return null;
  }
  async rowImage(): Promise<string | null> {
    return null;
  }
  dropRowImages(): void {}
}

class MemStore implements ReportingKvStore {
  m = new Map<string, string>();
  /** Simulate a full / refusing localStorage (writes report `false`). */
  refuse = false;
  /** Simulate a store whose READS blow up (localKv never throws, but the
   *  ReportingKvStore contract does not forbid it — read error ≠ first run). */
  throwOnGet = false;
  get(k: string): string | null {
    if (this.throwOnGet) throw new Error('storage unreadable');
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string): boolean {
    if (this.refuse) return false;
    this.m.set(k, v);
    return true;
  }
  keys(): string[] {
    return [...this.m.keys()];
  }
  quarantines(): string[] {
    return this.keys().filter((k) => k.includes(CORRUPT_INFIX));
  }
}

function boot(kv: MemStore): TimelineStore {
  return new TimelineStore(new StubTransport(), kv, () => NOW);
}

/** A row exactly as persist() writes one (already normalized + channel-tagged). */
function cachedRow(id: string): Record<string, unknown> {
  return {
    id,
    channel: 'lan',
    mode: 'realtime',
    status: 'injected',
    source_text: null,
    output_text: `text-${id}`,
    created_at: '2026-07-23T10:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
    target: null,
    entry_type: 'transcript',
  };
}

function wireItem(id: string): WireHistoryItem {
  return {
    id,
    mode: 'realtime',
    status: 'injected',
    source_text: null,
    output_text: `text-${id}`,
    created_at: '2026-07-23T10:00:00.000Z',
    updated_at: '2026-07-23T10:00:00.000Z',
  };
}

/** A truncated write — the classic shape of a payload that is corrupt but still
 *  carries the user's words, i.e. worth keeping. */
const TRUNCATED = '[{"id":"r1","channel":"lan","output_text":"the user’s words';

describe('D8 — a corrupt rows payload is quarantined, never silently clobbered', () => {
  it('reverse control: the original bytes survive in a sibling key, and the incident is logged', () => {
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, TRUNCATED);
    const store = boot(kv);

    // ① The bytes are secured BEFORE the boot-time persist could overwrite them.
    const q = kv.quarantines();
    expect(q).toEqual([`${ROWS_KEY}${CORRUPT_INFIX}${NOW}`]);
    expect(kv.get(q[0]!)).toBe(TRUNCATED); // byte-for-byte, not a re-serialization

    // ② Loud: at least one fault line names the key.
    expect(store.hydrateFaults.length).toBeGreaterThan(0);
    expect(store.hydrateFaults.join('\n')).toContain(ROWS_KEY);

    // ③ The app still works: boots empty, and the empty state MAY now be persisted
    //    because the original is already safe.
    expect(store.entries()).toEqual([]);
    expect(kv.get(ROWS_KEY)).toBe('[]');
    expect(store.storageFailed).toBe(false);
  });

  it('a second boot after the quarantine is clean and silent — one incident, one copy', () => {
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, TRUNCATED);
    boot(kv);
    const again = boot(kv);
    expect(again.hydrateFaults).toEqual([]);
    expect(kv.quarantines()).toEqual([`${ROWS_KEY}${CORRUPT_INFIX}${NOW}`]);
    expect(kv.get(`${ROWS_KEY}${CORRUPT_INFIX}${NOW}`)).toBe(TRUNCATED);
  });
});

describe('D8 — a missing file is a clean first run, NOT corruption', () => {
  it('boots empty with no quarantine and no fault line (first run must stay silent)', () => {
    const kv = new MemStore();
    const store = boot(kv);
    expect(store.entries()).toEqual([]);
    expect(store.hydrateFaults).toEqual([]);
    expect(kv.quarantines()).toEqual([]);
    expect(store.storageFailed).toBe(false);
  });

  it('a valid file hydrates unchanged — no quarantine, no fault lines', () => {
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, JSON.stringify([cachedRow('a'), cachedRow('b')]));
    const store = boot(kv);
    expect(store.entries().map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(store.hydrateFaults).toEqual([]);
    expect(kv.quarantines()).toEqual([]);
  });
});

describe('D8 — all four hydrate read sites get the same treatment', () => {
  it('site 3 (images): corrupt payload is quarantined; the rows still load', () => {
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, JSON.stringify([cachedRow('a')]));
    kv.m.set(IMAGES_KEY, '{oops');
    const store = boot(kv);
    expect(store.entries()).toHaveLength(1);
    expect(kv.quarantines()).toEqual([`${IMAGES_KEY}${CORRUPT_INFIX}${NOW}`]);
    expect(kv.get(`${IMAGES_KEY}${CORRUPT_INFIX}${NOW}`)).toBe('{oops');
    expect(store.hydrateFaults.join('\n')).toContain(IMAGES_KEY);
  });

  it('site 4 (retention): corrupt payload is quarantined; the rows still load', () => {
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, JSON.stringify([cachedRow('a')]));
    kv.m.set(RETENTION_KEY, '###not json###');
    const store = boot(kv);
    expect(store.entries()).toHaveLength(1);
    expect(store.retention.cutoff).toBeNull();
    expect(kv.quarantines()).toEqual([`${RETENTION_KEY}${CORRUPT_INFIX}${NOW}`]);
    expect(kv.get(`${RETENTION_KEY}${CORRUPT_INFIX}${NOW}`)).toBe('###not json###');
  });

  it('site 2 (retired queue): the bytes are quarantined BEFORE the wind-down empties the key', () => {
    const kv = new MemStore();
    kv.m.set(QUEUE_KEY, '{not json');
    const store = boot(kv);
    // The wind-down's answer is unchanged: unknown count, key emptied…
    expect(store.windedDownQueueOps).toBe(-1);
    expect(kv.get(QUEUE_KEY)).toBe('[]');
    // …but the emptying no longer destroys anything.
    expect(kv.quarantines()).toEqual([`${QUEUE_KEY}${CORRUPT_INFIX}${NOW}`]);
    expect(kv.get(`${QUEUE_KEY}${CORRUPT_INFIX}${NOW}`)).toBe('{not json');
  });

  it('a corrupt key does not stop the OTHER sites from loading (the shared try is gone)', () => {
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, TRUNCATED);
    kv.m.set(IMAGES_KEY, JSON.stringify(['img-1']));
    kv.m.set(RETENTION_KEY, JSON.stringify({ text: '2026-01-01T00:00:00.000Z', images: null }));
    const store = boot(kv);
    // Before D8 the rows' parse throw skipped both later reads; now they load.
    expect(store.retention.cutoffs.text).toBe('2026-01-01T00:00:00.000Z');
    expect(kv.quarantines()).toEqual([`${ROWS_KEY}${CORRUPT_INFIX}${NOW}`]);
  });
});

describe('D8 — corrupt shapes that parse are corruption too', () => {
  it('valid JSON that is not an array is quarantined, not silently emptied', () => {
    const kv = new MemStore();
    const wrongShape = '{"rows":[{"id":"r1"}]}';
    kv.m.set(ROWS_KEY, wrongShape);
    const store = boot(kv);
    expect(store.entries()).toEqual([]);
    expect(kv.get(`${ROWS_KEY}${CORRUPT_INFIX}${NOW}`)).toBe(wrongShape);
  });

  it('a non-empty array where NO row is usable is quarantined (total loss = whole-file corruption)', () => {
    const kv = new MemStore();
    const totalLoss = JSON.stringify([{ garbage: true }, { id: '' }]);
    kv.m.set(ROWS_KEY, totalLoss);
    const store = boot(kv);
    expect(store.entries()).toEqual([]);
    expect(kv.get(`${ROWS_KEY}${CORRUPT_INFIX}${NOW}`)).toBe(totalLoss);
  });

  it('…but a payload where SOME rows are usable keeps the per-row boundary: no quarantine', () => {
    // The normalizer dropping individual junk/untagged rows is a documented,
    // deliberate boundary (timeline-normalize) — D8 must not turn it into an alarm.
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, JSON.stringify([null, 42, { id: '' }, cachedRow('ok')]));
    const store = boot(kv);
    expect(store.entries().map((r) => r.id)).toEqual(['ok']);
    expect(kv.quarantines()).toEqual([]);
    expect(store.hydrateFaults).toEqual([]);
  });
});

describe('D8 — unsecured bytes are NEVER overwritten', () => {
  it('when the quarantine copy cannot be written, every write to that key is withheld', () => {
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, TRUNCATED);
    kv.refuse = true; // quota full: the quarantine copy cannot land
    const store = boot(kv);

    // The one copy of the user's records is still exactly where it was.
    expect(kv.get(ROWS_KEY)).toBe(TRUNCATED);
    expect(kv.quarantines()).toEqual([]);
    // And the situation is stated, not swallowed.
    expect(store.storageFailed).toBe(true);
    expect(store.hydrateFaults.join('\n')).toContain(ROWS_KEY);
  });

  it('a later persist retries the quarantine and resumes writing only once the bytes are safe', () => {
    const kv = new MemStore();
    kv.m.set(ROWS_KEY, TRUNCATED);
    kv.refuse = true;
    const store = boot(kv);
    expect(kv.get(ROWS_KEY)).toBe(TRUNCATED); // positive control: still withheld

    kv.refuse = false; // storage recovers
    store.onHistoryUpdated(wireItem('n1'), 'lan'); // any op that persists

    const q = kv.quarantines();
    expect(q).toEqual([`${ROWS_KEY}${CORRUPT_INFIX}${NOW}`]);
    expect(kv.get(q[0]!)).toBe(TRUNCATED); // secured first…
    expect(JSON.parse(kv.get(ROWS_KEY) ?? 'x')).toHaveLength(1); // …then written
    expect(store.storageFailed).toBe(false);
  });

  it('a store whose reads THROW is held: nothing read, nothing written, everything stated', () => {
    const kv = new MemStore();
    kv.throwOnGet = true;
    const store = boot(kv);
    // Read error ≠ first run: the store boots empty but writes NOTHING over keys it
    // could not read (they may hold the only copy).
    expect(store.entries()).toEqual([]);
    expect(kv.keys()).toEqual([]);
    expect(store.storageFailed).toBe(true);
    expect(store.hydrateFaults.length).toBeGreaterThan(0);
  });
});
