// SPEC-REF:
//   docs/strategy/2026-10-10-nr224-billed-once-guard-design.md (the design; §2.2 the rule, §3 replica and restart)
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.12
//   apps/server-core/src/db/repos/recording-coverage.repo.ts (the store) · usage-effects.repo.ts `step` (its caller)
//   *** billing ***
//
// NR-224 — an old phone (0.3.95–0.3.107) that loses a long recording's link re-sends the WHOLE recording as one
// automatic catch-up ([0, end), `auto_retry`, the live session's own `recording_id`). Before this guard the account
// paid for the live audio twice. Every scenario below drives the PRODUCTION audio handler and the PRODUCTION ledger;
// only the engine is a stub, whose settle seam is handed what a real bridge hands it: the §4.9 basis and the audio the
// pipeline took (`received.uniqueMs`, engine/stt-session-intake.ts `FrameTally.fedBytes`).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import { makeUsageTracker, type UsageTracker } from '../src/billing/usage-tracker';
import { currentMonth } from '../src/db/repos/usage.repo';
import { claimInCallerTransaction, makeUsageEffectLedger } from '../src/db/repos/usage-effects.repo';
import {
  COVERAGE_CREDIT_LIMIT, COVERAGE_MAX_STRETCHES, SAMPLES_PER_MS, coverageRefOf, isRollbackClassSqliteError,
  makeRecordingCoverageStore, settleCoverage, type CoverageState,
} from '../src/db/repos/recording-coverage.repo';
import { RECOVERY_CLAIM_RETENTION_MS, RECOVERY_SQL } from '../src/db/schema-recovery';
import { DatabaseSync } from 'node:sqlite';
import { FrameTally } from '../src/engine/stt-session-intake';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { SttAllowancePool } from '../src/billing/stt-allowance-pool';
import { reserveSessionAllowance, settleSessionUsage } from '../src/engine/stt-session-allowance';
import type { QuotaGuard } from '../src/billing/quota-guard';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers } from '../src/socket/handlers/audio.handler';
import { makeForwardingUsageTracker } from '../src/node/forwarding-usage-tracker';
import { makeForwardLedger } from '../src/node/forward-ledger';
import { makeForwardReceiver } from '../src/node/forward-receiver';
import type { OutboxRecord } from '../src/db/replica-outbox';

const USER = 'u-nr224';
const NOW = Date.parse('2026-10-10T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const CHARS = { transcript: 0, delivered: 0 } as const;
const KEY = deriveKey('nr-224-billed-once-guard-32bytes!');
const S = (ms: number): number => ms * SAMPLES_PER_MS; // ms of audio → samples

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string };
  constructor(userId = USER) { this.data = { auth: { kind: 'mobile', userId } }; }
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

const dbs: DbConnection[] = [];
const dirs: string[] = [];
function openDb(path = ':memory:', insertUser = true): DbConnection {
  const db = createDbConnection({ dbPath: path, encryptionKey: KEY });
  if (insertUser) db.users.insert({ id: USER, display_name: 'U', plan: 'pro' });
  dbs.push(db);
  return db;
}
let seq = 0;
beforeEach(() => { seq = 0; });
afterEach(() => {
  while (dbs.length > 0) { try { dbs.pop()!.close(); } catch { /* closed by the test */ } }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const minutesOf = (db: DbConnection): number => db.usage.get(USER, MONTH)?.stt_minutes ?? 0;
const ms = (db: DbConnection): number => Math.round(minutesOf(db) * 60_000);

type Settle = (d: number, b: boolean, c: typeof CHARS, f?: unknown, r?: { uniqueMs: number }) => void;
/** One settled `audio:start` through the production handler: [billedMs] is the §4.9 basis, [receivedMs] the audio taken,
 *  [byok] whether the session ran on the user's own key. */
type Press = (f: Record<string, unknown>, billedMs: number, receivedMs: number, byok?: boolean) => unknown;

function relay(db: DbConnection, usageTracker: UsageTracker, userId = USER): Press {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: true, now: () => NOW });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: 'saas', now: () => NOW });
  const socket = new FakeSocket(userId);
  let seam: Settle | null = null;
  registerAudioHandlers(socket as unknown as Socket, {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker, recoveryOps: db.recoveryOps,
    store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
    sttFactory: (args) => { seam = args.onComplete as Settle; return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} }; },
    now: () => NOW,
  });
  return (f, billedMs, receivedMs, byok = false) => {
    seam = null;
    let ack: unknown;
    socket.fire('audio:start', f, (r) => { ack = r; });
    if (seam !== null) (seam as Settle)(billedMs, byok, CHARS, undefined, { uniqueMs: receivedMs });
    return ack;
  };
}

const BASE = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'en', audio_format_version: 1 };
/** The live press, as `liveStartFields` sends it (0.3.107): no operation, no job, no end. */
const live = (rec: string): Record<string, unknown> => ({
  ...BASE, recording_id: rec, attempt_id: `a-live-${++seq}`, attempt_kind: 'live', range_start_sample: 0,
});
/** A recovery attempt, as `RecoveryIdentity.toStartFields` sends it. */
const recovery = (rec: string, kind: 'auto_retry' | 'user_retranscribe', op: string, range: [number, number]): Record<string, unknown> => ({
  ...BASE, recording_id: rec, job_id: `job-${rec}-${range[0]}-${range[1]}`, attempt_id: `a-${++seq}`, operation_id: op,
  attempt_kind: kind, range_start_sample: range[0], range_end_sample: range[1], delivery: 'none',
});

function direct(db: DbConnection, userId = USER, events = false): Press {
  return relay(db, makeUsageTracker(db.usage, {
    mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: db.usageEffects,
    ...(events ? { usageEventsEnabled: true, events: db.usageEvents } : {}),
  }), userId);
}

describe('NR-224 (a) — a whole-recording catch-up after a live session bills only the uncovered tail', () => {
  it('🔴 live 7 min, then the old phone re-sends [0, 8 min): the account pays the live basis plus the tail, once', () => {
    const db = openDb();
    const press = direct(db);
    expect(press(live('rec-A'), 400_000, 420_000)).toMatchObject({ ok: true });
    expect(ms(db), 'precondition: the live press is billed in full').toBe(400_000);
    expect(press(recovery('rec-A', 'auto_retry', 'o-A', [0, S(480_000)]), 456_000, 480_000)).toMatchObject({ ok: true });
    expect(ms(db), 'only the 56 s the live press never paid for').toBe(456_000);
    // The phone's automatic re-send of the same operation stays free (the claim's rule, unchanged).
    press(recovery('rec-A', 'auto_retry', 'o-A', [0, S(480_000)]), 456_000, 480_000);
    expect(ms(db)).toBe(456_000);
  });

  it('NR-106 — stop, then the final never reached the phone: re-sending the last 10 s of a paid press costs nothing', () => {
    const db = openDb();
    const press = direct(db);
    press(live('rec-B'), 50_000, 60_000);
    press(recovery('rec-B', 'auto_retry', 'o-B', [S(50_000), S(60_000)]), 9_500, 10_000);
    expect(ms(db)).toBe(50_000);
  });

  it('control: a catch-up of a DIFFERENT recording, and a tail that does not overlap the live audio, are billed in full', () => {
    const db = openDb();
    const press = direct(db);
    press(live('rec-C'), 30_000, 30_000);
    press(recovery('rec-other', 'auto_retry', 'o-X', [0, S(30_000)]), 30_000, 30_000);
    press(recovery('rec-C', 'auto_retry', 'o-C', [S(30_000), S(42_000)]), 12_000, 12_000);
    expect(ms(db)).toBe(72_000);
  });
});

describe('NR-224 (b) — a user re-transcribe (NR-137 / ruling O-4) keeps its own rule', () => {
  it('🔴 「transcribe again」 on a paid recording is billed in full, every press, before and after a catch-up', () => {
    const db = openDb();
    const press = direct(db);
    press(live('rec-D'), 60_000, 60_000);
    press(recovery('rec-D', 'user_retranscribe', 'o-press-1', [0, S(60_000)]), 60_000, 60_000);
    expect(ms(db), 'the press is a new attempt the user asked for').toBe(120_000);
    press(recovery('rec-D', 'auto_retry', 'o-D', [0, S(66_000)]), 66_000, 66_000);
    expect(ms(db), 'the automatic catch-up pays only its 6 s tail').toBe(126_000);
    press(recovery('rec-D', 'user_retranscribe', 'o-press-2', [0, S(66_000)]), 66_000, 66_000);
    expect(ms(db)).toBe(192_000);
  });
});

describe('NR-224 (c) — the replica-forwarded path behaves the same', () => {
  function twoNodes() {
    const writerDb = openDb();
    const replicaDb = openDb();
    const owed: OutboxRecord[] = [];
    const forwarding = makeForwardingUsageTracker({
      outbox: { enqueue: (r: Omit<OutboxRecord, 'at'>) => { owed.push({ at: NOW, ...r }); } } as never,
      nodeId: 'srvjp',
      newId: (() => { let n = 0; return (): string => `random-${++n}`; })(),
    });
    const receive = makeForwardReceiver({
      ledger: makeForwardLedger(writerDb.raw),
      targets: {
        usage: makeUsageTracker(writerDb.usage, {
          mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: claimInCallerTransaction(writerDb.usageEffects),
        }),
        setHomeNode: () => {}, setPresence: () => {}, setPcIdentity: () => {},
      },
    });
    // Records go through JSON, as they do on the wire between nodes.
    const drain = (): void => { receive(owed.splice(0).map((r) => JSON.parse(JSON.stringify(r)) as OutboxRecord), 'srvjp'); };
    return { writerDb, onReplica: relay(replicaDb, forwarding), onWriter: direct(writerDb), drain, owed };
  }

  it('🔴 live and catch-up both on the replica: the writer charges the live basis plus the tail', () => {
    const n = twoNodes();
    n.onReplica(live('rec-E'), 400_000, 420_000);
    n.onReplica(recovery('rec-E', 'auto_retry', 'o-E', [0, S(480_000)]), 456_000, 480_000);
    expect(n.owed.map((r) => (r.body as { coverage?: unknown }).coverage), 'both records carry the replica-measured coverage')
      .toEqual([
        { recording_id: 'rec-E', start_sample: 0, end_sample: S(420_000), attempt_kind: 'live' },
        { recording_id: 'rec-E', start_sample: 0, end_sample: S(480_000), attempt_kind: 'auto_retry' },
      ]);
    n.drain();
    expect(ms(n.writerDb)).toBe(456_000);
  });

  it('🔴 cross-node order: the catch-up lands on the writer BEFORE the replica forwards the live press — same total', () => {
    const n = twoNodes();
    n.onReplica(live('rec-F'), 400_000, 420_000); // still in the replica's outbox
    n.onWriter(recovery('rec-F', 'auto_retry', 'o-F', [0, S(480_000)]), 456_000, 480_000);
    expect(ms(n.writerDb), 'precondition: the writer has seen no live press yet ⇒ billed in full').toBe(456_000);
    n.drain();
    expect(ms(n.writerDb), 'the live press arrives already paid for by the catch-up').toBe(456_000);
  });
});

describe('NR-224 (d) — a restart in between keeps the coverage', () => {
  it('🔴 live press, relay restarts (database closed and reopened), then the catch-up: still only the tail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr224-'));
    dirs.push(dir);
    const path = join(dir, 'relay.db');
    const before = openDb(path);
    direct(before)(live('rec-G'), 400_000, 420_000);
    before.close();
    const after = openDb(path, false);
    direct(after)(recovery('rec-G', 'auto_retry', 'o-G', [0, S(480_000)]), 456_000, 480_000);
    expect(ms(after)).toBe(456_000);
  });
});

describe('the rule, pure (recording-coverage.repo.ts settleCoverage)', () => {
  const ref = (kind: 'live' | 'auto_retry' | 'user_retranscribe', lo: number, hi: number) =>
    ({ recording_id: 'r', start_sample: S(lo), end_sample: S(hi), attempt_kind: kind });

  it('a modified client gets at most COVERAGE_CREDIT_LIMIT credited sessions per recording, then pays in full', () => {
    let state: CoverageState | undefined = settleCoverage(undefined, ref('live', 0, 60_000), 60_000, 60_000).next!;
    const charges: number[] = [];
    for (let i = 0; i < COVERAGE_CREDIT_LIMIT + 2; i++) {
      const out = settleCoverage(state, ref('auto_retry', 0, 60_000), 60_000, 60_000);
      charges.push(out.charge);
      state = out.next!;
    }
    expect(charges).toEqual([...Array(COVERAGE_CREDIT_LIMIT).fill(0), 60_000, 60_000]);
  });

  it('a second LIVE session of one recording never draws (its position is wrong by construction); a live press may draw from a recovery', () => {
    const afterLive = settleCoverage(undefined, ref('live', 0, 60_000), 60_000, 60_000).next!;
    expect(settleCoverage(afterLive, ref('live', 0, 30_000), 30_000, 30_000).charge).toBe(30_000);
    const afterRecovery = settleCoverage(undefined, ref('auto_retry', 0, 60_000), 60_000, 60_000).next!;
    expect(settleCoverage(afterRecovery, ref('live', 0, 30_000), 30_000, 30_000).charge).toBe(0);
  });

  it('an interval offers no more than the audio that overlaps it, and the paid total is conserved', () => {
    const s1 = settleCoverage(undefined, ref('live', 0, 60_000), 60_000, 60_000).next!; // dense speech: 60 s paid for 60 s
    const tail = settleCoverage(s1, ref('auto_retry', 55_000, 70_000), 15_000, 15_000);
    expect(tail.charge, '5 s overlapped, 10 s new').toBe(10_000);
    const total = tail.next!.segments.reduce((a, g) => a + g.ms, 0);
    expect(total, 'paid ms over the recording = 60 s + 10 s charged').toBe(70_000);
  });

  it('coverage is undeterminable ⇒ none (billed as before): no recording, no start, no measured audio, unknown kind', () => {
    const f = { recording_id: 'r', range_start_sample: 0, attempt_kind: 'live' };
    expect(coverageRefOf(f, 1_000)).toEqual({ recording_id: 'r', start_sample: 0, end_sample: S(1_000), attempt_kind: 'live' });
    expect(coverageRefOf({ ...f, recording_id: undefined }, 1_000)).toBeUndefined();
    expect(coverageRefOf({ ...f, range_start_sample: undefined }, 1_000)).toBeUndefined();
    expect(coverageRefOf(f, undefined)).toBeUndefined();
    expect(coverageRefOf({ ...f, attempt_kind: 'something' }, 1_000)).toBeUndefined();
    // A stated end only shortens: a client cannot claim more coverage than the audio it sent.
    expect(coverageRefOf({ ...f, range_end_sample: S(500) }, 1_000)?.end_sample).toBe(S(500));
    expect(coverageRefOf({ ...f, range_end_sample: S(5_000) }, 1_000)?.end_sample).toBe(S(1_000));
  });
});

describe('the measure (engine/stt-session-intake.ts FrameTally.fedBytes)', () => {
  it('counts the bytes of frames the pipeline took once; a ring replay (deduped) and a refused frame add nothing', () => {
    const t = new FrameTally();
    t.note('fed', 6_400);
    t.note('deduped', 6_400);
    t.note('refused', 6_400);
    t.note('fed', 3_200);
    expect(t.fedBytes).toBe(9_600);
    expect(t.fed, 'the receipt\'s frame count is unchanged: deduped still counts as fed').toBe(3);
  });
});

describe('the wiring: bridge → factory → settle seam carries the measure (anti-façade ③)', () => {
  it('🔴 the production factory and bridge hand the seam the de-duplicated received audio', () => {
    vi.useFakeTimers();
    try {
      const db = openDb();
      db.settings.write(USER, 'stt.routings', [
        { language: '*', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '' },
      ]);
      const quota = { remainingSttMs: () => 600_000, continuousCapMs: () => 1_800_000, ensureQuota: () => {} } as unknown as QuotaGuard;
      const factory = makeSttSessionFactory({ settings: db.settings, mode: 'saas', store: new RoomStore<Socket>(), quota,
        integratorKeys: { remainingMs: () => Infinity } });
      const settled: unknown[][] = [];
      const session = factory({ id: 's', data: {}, emit: () => {} } as unknown as Socket, {
        userId: USER, mode: 'realtime', delivery: 'none', sourceLang: 'en', onComplete: (...a) => { settled.push(a); },
      });
      const pcm = Buffer.alloc(6_400).toString('base64'); // 200 ms of 16 kHz s16le
      session.pushChunk(0, pcm, Date.now());
      session.pushChunk(1, pcm, Date.now());
      session.pushChunk(1, pcm, Date.now()); // seq 1 again: a ring replay, its bytes arrived the first time
      vi.advanceTimersByTime(600);
      session.dispose();
      expect(settled, 'positive control: the session settled, once').toHaveLength(1);
      expect(settled[0]![3], 'precondition: a charged settle (no engine-failure fact)').toBeUndefined();
      expect(settled[0]![4]).toEqual({ uniqueMs: 400 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settleSessionUsage passes the measure on with a charged settle, and leaves the old arity when there is none', () => {
    const chars = { transcript: 1, delivered: 1 };
    const allowance = reserveSessionAllowance(new SttAllowancePool(), { userId: USER, roomId: 'r', payerMs: () => 60_000, keyMs: () => undefined, planCapMs: 60_000 });
    const metered: unknown[][] = [];
    settleSessionUsage(allowance, 6_000, false, chars, undefined, (...a) => { metered.push(a); }, { uniqueMs: 6_000 });
    settleSessionUsage(undefined, 6_000, false, chars, undefined, (...a) => { metered.push(a); });
    expect(metered).toEqual([[6_000, false, chars, undefined, { uniqueMs: 6_000 }], [6_000, false, chars]]);
  });
});

describe('NR-224 review (MAIN decision) — ONE free budget per recording, re-sends of credited operations included', () => {
  /** Every charge of [steps], in order, as the account's minutes moved. */
  function charges(db: DbConnection, steps: (() => unknown)[]): number[] {
    const out: number[] = [];
    for (const step of steps) { const before = ms(db); step(); out.push(ms(db) - before); }
    return out;
  }

  it('🔴 a paid live press, then fabricated recovery operations and their re-sends: at most five free sessions, then full', () => {
    const db = openDb();
    const press = direct(db);
    press(live('rec-H'), 60_000, 60_000);
    const whole: [number, number] = [0, S(60_000)];
    const op = (id: string) => (): unknown => press(recovery('rec-H', 'auto_retry', id, whole), 60_000, 60_000);
    // One credited operation re-sent past the budget, then fresh fabricated operations.
    expect(charges(db, [op('o-1'), op('o-1'), op('o-1'), op('o-1'), op('o-1'), op('o-1'), op('o-2'), op('o-3')]))
      .toEqual([0, 0, 0, 0, 0, 60_000, 60_000, 60_000]);
    expect(db.usageEffects.listCoverageByUser(USER)[0]).toMatchObject({ credits: COVERAGE_CREDIT_LIMIT, credited_ops: ['o-1'] });
  });

  it('🔴 the review\'s attack order — five operations credited first, then each re-sent — is free five times in all', () => {
    const db = openDb();
    const press = direct(db);
    press(live('rec-I'), 60_000, 60_000);
    const whole: [number, number] = [0, S(60_000)];
    const op = (id: string) => (): unknown => press(recovery('rec-I', 'auto_retry', id, whole), 60_000, 60_000);
    const ids = ['o-1', 'o-2', 'o-3', 'o-4', 'o-5'];
    const got = charges(db, [...ids.map(op), ...ids.map(op), ...ids.map(op)]);
    expect(got.filter((c) => c === 0), 'free sessions on this recording').toHaveLength(COVERAGE_CREDIT_LIMIT);
    expect(got.slice(COVERAGE_CREDIT_LIMIT), 'every later session billed in full').toEqual(Array(10).fill(60_000));
  });

  it('an honest old phone fits: one credited catch-up and its four automatic re-sends are all free', () => {
    const db = openDb();
    const press = direct(db);
    press(live('rec-J'), 400_000, 420_000);
    const resend = (): unknown => press(recovery('rec-J', 'auto_retry', 'o-J', [0, S(480_000)]), 456_000, 480_000);
    expect(charges(db, [resend, resend, resend, resend, resend])).toEqual([56_000, 0, 0, 0, 0]);
  });
});

describe('NR-224 review — the rest', () => {
  it('credited sessions still write their usage_events row, with the actual charge (0 included)', () => {
    const db = openDb();
    const press = direct(db, USER, true);
    press(live('rec-K'), 50_000, 60_000);
    press(recovery('rec-K', 'auto_retry', 'o-K1', [0, S(70_000)]), 58_000, 70_000);
    press(recovery('rec-K', 'auto_retry', 'o-K2', [S(60_000), S(70_000)]), 8_000, 10_000); // an operation credited to 0
    press(recovery('rec-K3', 'auto_retry', 'o-K3', [0, S(30_000)]), 30_000, 30_000);
    press(live('rec-K3'), 30_000, 30_000); // a live press (no operation) credited to 0 by the catch-up that landed first
    const rows = db.raw.prepare(`SELECT stt_ms, outcome FROM usage_events WHERE user_id = ? AND kind = 'stt' ORDER BY rowid`).all(USER);
    expect(rows.map((r) => Number((r as { stt_ms: number }).stt_ms))).toEqual([50_000, 8_000, 0, 30_000, 0]);
    expect(ms(db), 'the detail rows sum to the bill').toBe(88_000);
  });

  it('own-key (BYOK) sessions neither draw nor record', () => {
    const db = openDb();
    const press = direct(db);
    press(live('rec-L'), 60_000, 60_000, true);
    expect(db.usageEffects.listCoverageByUser(USER), 'an own-key press pays nothing, so it records nothing').toEqual([]);
    press(recovery('rec-L', 'auto_retry', 'o-L', [0, S(60_000)]), 60_000, 60_000);
    expect(ms(db), 'the managed catch-up is billed in full').toBe(60_000);
    press(recovery('rec-L', 'auto_retry', 'o-L2', [0, S(60_000)]), 60_000, 60_000, true);
    expect(db.usageEffects.listCoverageByUser(USER)[0]?.credits, 'and an own-key catch-up draws nothing').toBe(0);
  });

  it('account A\'s coverage never credits account B, even under the same recording id', () => {
    const db = openDb();
    db.users.insert({ id: 'u-other', display_name: 'B', plan: 'pro' });
    direct(db)(live('rec-M'), 60_000, 60_000);
    direct(db, 'u-other')(recovery('rec-M', 'auto_retry', 'o-M', [0, S(60_000)]), 60_000, 60_000);
    expect(Math.round((db.usage.get('u-other', MONTH)?.stt_minutes ?? 0) * 60_000)).toBe(60_000);
  });

  it('coverage is pruned with the claims at 90 days by its creation time', () => {
    const db = openDb();
    direct(db)(live('rec-N'), 60_000, 60_000);
    db.usageEffects.prune(NOW + RECOVERY_CLAIM_RETENTION_MS - 1);
    expect(db.usageEffects.listCoverageByUser(USER)).toHaveLength(1);
    db.usageEffects.prune(NOW + RECOVERY_CLAIM_RETENTION_MS + 1);
    expect(db.usageEffects.listCoverageByUser(USER)).toHaveLength(0);
  });

  it(`a row holds at most ${COVERAGE_MAX_STRETCHES} stretches; past that a session draws nothing and the row does not grow`, () => {
    const full: CoverageState = {
      segments: Array.from({ length: COVERAGE_MAX_STRETCHES }, (_, i) => ({ s: i * 100, e: i * 100 + 50, ms: 3, by: 'r' as const })),
      credits: 0, credited_ops: [],
    };
    const ref = { recording_id: 'r', start_sample: 0, end_sample: 6_400 * 100, attempt_kind: 'auto_retry' as const };
    expect(settleCoverage(full, ref, 1_000, 1_000)).toEqual({ charge: 1_000, credited: 0, next: null });
    const almost: CoverageState = { ...full, segments: full.segments.slice(1) }; // 63, and a session in a gap adds one more
    expect(settleCoverage(almost, { ...ref, start_sample: 60, end_sample: 70 }, 1, 1).next?.segments).toHaveLength(COVERAGE_MAX_STRETCHES);
    const db = openDb();
    db.raw.prepare(`INSERT INTO recording_coverage (user_id, recording_id, segments, credits, created_at, updated_at) VALUES (?, 'r', ?, 0, ?, ?)`)
      .run(USER, JSON.stringify(full.segments.map((g) => [g.s, g.e, g.ms, g.by])), NOW, NOW);
    const charged: number[] = [];
    db.usageEffects.meter({ user_id: USER, kind: 'stt', at: NOW + 1, coverage: ref }, 1_000, (c) => { charged.push(c); });
    expect(charged).toEqual([1_000]);
    expect(db.usageEffects.listCoverageByUser(USER)[0]).toMatchObject({ updated_at: NOW });
  });

  describe('SQLite errors (recording-coverage.repo.ts isRollbackClassSqliteError)', () => {
    function rawPair(): { a: DatabaseSync; b: DatabaseSync } {
      const dir = mkdtempSync(join(tmpdir(), 'nr224-sql-'));
      dirs.push(dir);
      const path = join(dir, 'c.db');
      const a = new DatabaseSync(path);
      a.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
      a.exec(RECOVERY_SQL);
      a.prepare('INSERT INTO users (id) VALUES (?)').run(USER);
      return { a, b: new DatabaseSync(path) };
    }
    const ref = { recording_id: 'r', start_sample: 0, end_sample: S(1_000), attempt_kind: 'live' as const };

    it('🔴 a rollback-class error (a real SQLITE_BUSY) is re-thrown: the metering fails as a whole, nothing is charged outside it', () => {
      const { a, b } = rawPair();
      try {
        const ledger = makeUsageEffectLedger(a, makeRecordingCoverageStore(a));
        b.exec('BEGIN IMMEDIATE');
        const charged: number[] = [];
        expect(() => ledger.meterInCallerTransaction({ user_id: USER, kind: 'stt', at: NOW, coverage: ref }, 1_000, (c) => { charged.push(c); }))
          .toThrow(/locked/);
        expect(charged).toEqual([]);
        b.exec('ROLLBACK');
        ledger.meterInCallerTransaction({ user_id: USER, kind: 'stt', at: NOW, coverage: ref }, 1_000, (c) => { charged.push(c); });
        expect(charged, 'positive control: the same call succeeds once the lock is gone').toEqual([1_000]);
      } finally { a.close(); b.close(); }
    });

    it('a data error (an unreadable row) is billed in full and logged, not thrown', () => {
      const { a, b } = rawPair();
      try {
        a.prepare(`INSERT INTO recording_coverage (user_id, recording_id, segments, created_at, updated_at) VALUES (?, 'r', 'not json', 0, 0)`).run(USER);
        const ledger = makeUsageEffectLedger(a, makeRecordingCoverageStore(a));
        const charged: number[] = [];
        ledger.meter({ user_id: USER, kind: 'stt', at: NOW, coverage: { ...ref, attempt_kind: 'auto_retry' } }, 1_000, (c) => { charged.push(c); });
        expect(charged).toEqual([1_000]);
      } finally { a.close(); b.close(); }
    });

    it('the classes: BUSY, NOMEM, INTERRUPT, IOERR (extended too), CORRUPT, FULL roll back; logic errors and constraints do not', () => {
      const e = (errcode: number): unknown => Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode });
      expect([5, 7, 9, 10, 266, 11, 13].map((c) => isRollbackClassSqliteError(e(c)))).toEqual(Array(7).fill(true));
      expect([1, 19, 1555, 2067].map((c) => isRollbackClassSqliteError(e(c)))).toEqual([false, false, false, false]);
      expect(isRollbackClassSqliteError(new Error('plain'))).toBe(false);
    });
  });
});
