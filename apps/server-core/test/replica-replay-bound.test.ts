// NR-151 — a replay forwarded through a REPLICA is bounded exactly like a direct one.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.11 「The bound on a free replay」
//   apps/server-core/src/node/forwarding-usage-tracker.ts (`operationRecordId`, the NR-151 note)
//   apps/server-core/src/node/forward-ledger.ts (the writer's transport dedupe, 7-day retention)
//   test/claimed-operation-replay-bound.test.ts (the direct leg this file compares against)
//
// WHY: the replica forwarded every automatic retry of one recording under ONE record id (the phone derives one
// operation for all of them and mints a fresh attempt each time), so the writer's forward ledger answered
// 「duplicate」 for each replay inside its 7-day retention and the NR-138 bound never ran: free at any length, any
// number of times.
//
// Both legs run the PRODUCTION audio handler (`registerAudioHandlers`), so `attempt_id` must really travel from the
// `audio:start` frame to the record id. The direct leg meters on the writer; the replica leg meters through
// `makeForwardingUsageTracker`, and its outbox records are delivered to a second writer through the production
// receive path (`makeForwardReceiver` → `forward-ledger.once` → `parseForwardedWrite` → a replay tracker built the
// way node-runtime.ts builds `replayUsage`). Assertions are on the PERSISTED minutes of each writer.
//
// REVERSE CONTROL (run 2026-10-10; restored byte-for-byte, then this file re-run green): `operationRecordId` with the
// attempt left out of the id ⇒ the replica leg stays at 1 minute where the direct leg bills the sixth replay
// (`sixth replay: replica leg vs direct leg: expected 1 to be close to 2`), and the deploy-order row stays at 1;
// the STT call site in audio.handler.ts without `parsed.data.attempt_id` ⇒ the same three rows red (the lost-ack
// row: `expected 'op|u-nr151|o-151|stt|platform' to be 'op|u-nr151|o-151|stt|platform|a=a-2'`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import { makeUsageTracker, type UsageTracker } from '../src/billing/usage-tracker';
import { currentMonth } from '../src/db/repos/usage.repo';
import { claimInCallerTransaction } from '../src/db/repos/usage-effects.repo';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers } from '../src/socket/handlers/audio.handler';
import { makeForwardingUsageTracker, operationRecordId } from '../src/node/forwarding-usage-tracker';
import { makeForwardLedger } from '../src/node/forward-ledger';
import { makeForwardReceiver } from '../src/node/forward-receiver';
import type { OutboxRecord } from '../src/db/replica-outbox';

const USER = 'u-nr151';
const NOW = Date.parse('2026-10-10T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const CHARS = { transcript: 0, delivered: 0 } as const;
const KEY = deriveKey('nr-151-replica-replay-bound-32b!!');
const BINDING = { recording_id: 'run-151__seg-0', job_id: 'job-151', range_start_sample: 0, range_end_sample: 960_000 };

/** One automatic retry's frame: same recording, job, range and (derived) operation; a fresh attempt each time. */
let attemptSeq = 0;
function frame(attempt = `a-${++attemptSeq}`): Record<string, unknown> {
  return {
    sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', delivery: 'none', source_lang: 'en',
    ...BINDING, attempt_id: attempt, operation_id: 'o-151', attempt_kind: 'auto_retry', audio_format_version: 1,
  };
}

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

const dbs: DbConnection[] = [];
function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: KEY });
  db.users.insert({ id: USER, display_name: 'U', plan: 'pro' });
  dbs.push(db);
  return db;
}
beforeEach(() => { attemptSeq = 0; });
afterEach(() => { while (dbs.length > 0) dbs.pop()!.close(); });

const minutesOf = (db: DbConnection): number => db.usage.get(USER, MONTH)?.stt_minutes ?? 0;

/** The production audio handler on [db], metering through [usageTracker]; each attempt settles with [billedMs]. */
function relay(db: DbConnection, usageTracker: UsageTracker): (f: Record<string, unknown>, billedMs: number) => unknown {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: true, now: () => NOW });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: 'saas', now: () => NOW });
  const socket = new FakeSocket();
  let seam: ((d: number, byok: boolean, chars: typeof CHARS) => void) | null = null;
  registerAudioHandlers(socket as unknown as Socket, {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker, recoveryOps: db.recoveryOps,
    store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
    sttFactory: (args) => { seam = args.onComplete; return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} }; },
    now: () => NOW,
  });
  return (f, billedMs) => {
    seam = null;
    let ack: unknown;
    socket.fire('audio:start', f, (r) => { ack = r; });
    if (seam !== null) (seam as (d: number, b: boolean, c: typeof CHARS) => void)(billedMs, false, CHARS);
    return ack;
  };
}

/** Direct leg: the writer's own handler and ledger. */
function directLeg() {
  const db = freshDb();
  const attempt = relay(db, makeUsageTracker(db.usage, { mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: db.usageEffects }));
  return { attempt, minutes: (): number => minutesOf(db) };
}

/** Replica leg: a replica's handler forwards into an outbox; a second writer receives the records it owes. */
function replicaLeg() {
  const replicaDb = freshDb();
  const writerDb = freshDb();
  const owed: OutboxRecord[] = [];
  const forwarding = makeForwardingUsageTracker({
    outbox: { enqueue: (r: Omit<OutboxRecord, 'at'>) => { owed.push({ at: NOW, ...r }); } } as never,
    nodeId: 'srvjp',
    newId: (() => { let n = 0; return (): string => `random-${++n}`; })(),
  });
  const receive = makeForwardReceiver({
    ledger: makeForwardLedger(writerDb.raw),
    targets: {
      // The writer's replay tracker, as node-runtime.ts builds `replayUsage`: the claim is taken inside the forward
      // ledger's transaction.
      usage: makeUsageTracker(writerDb.usage, {
        mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: claimInCallerTransaction(writerDb.usageEffects),
      }),
      setHomeNode: () => {}, setPresence: () => {}, setPcIdentity: () => {},
    },
  });
  const onReplica = relay(replicaDb, forwarding);
  return {
    owed,
    receive: (recs: OutboxRecord[]): Record<string, string> => receive(recs, 'srvjp'),
    /** One attempt on the replica, records left in the outbox. */
    attemptOnly: onReplica,
    /** One attempt on the replica, then the drain delivers everything owed. */
    attempt(f: Record<string, unknown>, billedMs: number): unknown {
      const ack = onReplica(f, billedMs);
      receive(owed.splice(0), 'srvjp');
      return ack;
    },
    minutes: (): number => minutesOf(writerDb),
  };
}

describe('NR-151 — a replay forwarded via the replica is capped exactly like a direct one', () => {
  it('🔴 first attempt, six same-length replays, then a longer one: both legs persist the same minutes at every step', () => {
    const direct = directLeg();
    const replica = replicaLeg();
    const seen: number[] = [];
    const run = (label: string, billedMs: number): void => {
      const f = frame();
      expect(direct.attempt(f, billedMs)).toMatchObject({ ok: true });
      expect(replica.attempt({ ...f }, billedMs)).toMatchObject({ ok: true });
      seen.push(Number(direct.minutes().toFixed(6)));
      expect(replica.minutes(), `${label}: replica leg vs direct leg`).toBeCloseTo(direct.minutes(), 6);
    };
    run('first attempt', 60_000);
    for (let i = 1; i <= 5; i += 1) run(`free replay ${i}`, 60_000);
    run('sixth replay', 60_000);
    run('seventh, longer replay', 90_000);
    // The direct leg's own numbers, so the comparison above is against the bound and not against a leg that is
    // equally broken: five free replays, the sixth billed in full, the seventh billed in full at its length.
    expect(seen).toEqual([1, 1, 1, 1, 1, 1, 2, 3.5]);
  });

  it('a lost-ack retry of ONE forwarded record is still a transport duplicate, not a second replay', () => {
    const replica = replicaLeg();
    replica.attempt(frame(), 60_000);
    const f = frame();
    replica.attemptOnly(f, 60_000);
    expect(replica.owed).toHaveLength(1);
    const rec = replica.owed[0]!;
    // Positive control: the production handler put THIS frame's attempt into the id.
    expect(rec.id).toBe(operationRecordId(USER, 'o-151', 'stt', false, f.attempt_id as string));
    expect(replica.receive([rec])).toEqual({ [rec.id]: 'accepted' });
    expect(replica.receive([rec]), 'the outbox re-sent the record it stored').toEqual({ [rec.id]: 'duplicate' });
    expect(replica.minutes()).toBeCloseTo(1, 6);
  });
});

describe('NR-151 deploy order — old and new record ids meet on one writer without loss or a double charge', () => {
  it('an old-format record (no attempt in the id) performed first, then new-format replays of the same operation', () => {
    const replica = replicaLeg();
    // What an un-updated replica sent for the first attempt: the pre-NR-151 spelling and body.
    const old = operationRecordId(USER, 'o-151', 'stt', false);
    const body = {
      kind: 'usage.stt', user_id: USER, engine: { is_byok: false }, duration_ms: 60_000, chars: CHARS,
      operation_id: 'o-151', operation_binding: BINDING,
    };
    expect(replica.receive([{ id: old, kind: 'usage', node: 'srvjp', at: NOW, body }])).toEqual({ [old]: 'accepted' });
    expect(replica.minutes()).toBeCloseTo(1, 6);
    // The updated replica's replays of the same operation: distinct ids, so each reaches the claim — free inside the
    // bound (no second charge) and the sixth billed (not lost).
    for (let i = 1; i <= 5; i += 1) replica.attempt(frame(), 60_000);
    expect(replica.minutes(), 'five replays inside the bound: free').toBeCloseTo(1, 6);
    replica.attempt(frame(), 60_000);
    expect(replica.minutes(), 'the sixth replay is billed').toBeCloseTo(2, 6);
  });

  it('a frame with no attempt_id keeps the old id byte for byte (older phones, records already queued)', () => {
    expect(operationRecordId(USER, 'o-151', 'stt', false, undefined)).toBe(`op|${USER}|o-151|stt|platform`);
    expect(operationRecordId(USER, 'o-151', 'stt', false, '')).toBe(`op|${USER}|o-151|stt|platform`);
    // Injective across the two spellings: an attempt cannot be forged into another operation's id.
    expect(operationRecordId(USER, 'o-151', 'stt', false, 'x')).not.toBe(operationRecordId(USER, 'o-151|a=x', 'stt', false));
  });
});
