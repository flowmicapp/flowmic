// NR-138 round 6 (final review B6 + B7, MAIN decisions, 2026-10-01) — every metering claim is bound to its recording,
// job and range, and the binding lives exactly as long as the claim.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.11, the 「Round 6」 block
//   _dispatch/2026-10-01-nr138-final-review.md.out B6 / B7 (the probes below are that review's, made to pass)
//   apps/server-core/src/db/repos/usage-effects.repo.ts (`claimBindingOf`, the claim's own binding, `replay_unbound`)
//   apps/server-core/src/db/repos/recovery-operations.repo.ts (`admit` asks the bound claim first; `job_id`)
//
// Two rigs, the review's own: the production audio handler + registry + tracker + SQLite ledger with the recognition
// as a seam (each attempt settles with the basis it names), and — for B7 — the real `SttSessionBridge` with a scripted
// engine, so the first attempt is a REAL engine failure that the no-charge rule leaves unclaimed (book 22 §4.10).
//
// REVERSE CONTROLS (run 2026-10-01; each restored byte-for-byte, then this file re-run green):
//   · the bound-claim check removed from `admit` ⇒ both day-91 B7 rows red: the borrowed id is admitted
//     (`expected { ok: true } to match object { error: 'AUDIO_OP_BINDING_CONFLICT' }`);
//   · `job_id` left out of the registry comparison ⇒ the 「B6 before any claim」 row red the same way (once a claim
//     exists, the claim's own binding refuses a changed job anyway — that is the B6 row);
//   · the claim's binding not stored at insert ⇒ 7 of 12 red: both day-91 B7 rows (the borrowed id admitted), the B6
//     row (the claim has no job), and four ledger rows, because an unbound claim bills every replay
//     (e.g. `expected 6.1 to be close to 1`).
// RC-1's reading: both day-91 B7 rows, `expected { ok: true } to match object { error: 'AUDIO_OP_BINDING_CONFLICT' }`.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import { makeUsageTracker } from '../src/billing/usage-tracker';
import { currentMonth } from '../src/db/repos/usage.repo';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers } from '../src/socket/handlers/audio.handler';
import { SttSessionBridge } from '../src/engine/stt-session';
import type { SttSessionDeps } from '../src/engine/stt-session-deps';
import type { SttEngineOrchestrator, ChunkIntake } from '../src/stt/orchestrator-core';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';
import { parseForwardedWrite } from '../src/node/forwarded-write';

const USER = 'u-nr138-r6';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const CHARS = { transcript: 0, delivered: 0 } as const;
const CONFLICT = { error: 'AUDIO_OP_BINDING_CONFLICT' };

function frame(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', delivery: 'none', source_lang: 'en',
    recording_id: 'run-r6__seg-0', job_id: 'job-r6', attempt_id: `a-${Math.random()}`,
    operation_id: 'o-r6', attempt_kind: 'auto_retry',
    range_start_sample: 0, range_end_sample: 960_000, audio_format_version: 1, ...o,
  };
}

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(userId: string) { this.data = { auth: { kind: 'mobile', userId } }; }
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

let db: DbConnection;
let relayNow = NOW;
beforeEach(() => {
  relayNow = NOW;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr-138-r6-claim-binding-32-bytes!') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'pro' });
});
afterEach(() => { db.close(); });

const minutes = (u = USER): number => db.usage.get(u, MONTH)?.stt_minutes ?? 0;

function deps() {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: true, now: () => relayNow });
  return {
    guard: makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: 'saas', now: () => relayNow }),
    usageTracker: makeUsageTracker(db.usage, { mode: 'saas', now: () => relayNow, periodKeyFor: () => MONTH, operations: db.usageEffects }),
  };
}

/** The seam rig: production handler, registry and ledger; each attempt settles with [billedMs]. */
function relay(account = USER) {
  const { guard, usageTracker } = deps();
  const socket = new FakeSocket(account);
  let seam: ((d: number, byok: boolean, chars: typeof CHARS) => void) | null = null;
  registerAudioHandlers(socket as unknown as Socket, {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker, recoveryOps: db.recoveryOps,
    store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
    sttFactory: (args) => { seam = args.onComplete; return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} }; },
    now: () => relayNow,
  });
  return {
    attempt(f: Record<string, unknown>, billedMs: number): unknown {
      seam = null;
      let ack: unknown;
      socket.fire('audio:start', f, (r) => { ack = r; });
      if (seam !== null) (seam as (d: number, b: boolean, c: typeof CHARS) => void)(billedMs, false, CHARS);
      return ack;
    },
  };
}

/** Emits exactly the facts a row is about; `stop()` runs the row's script. */
class ScriptedOrchestrator extends EventEmitter {
  fedBytes = 0;
  script: (o: ScriptedOrchestrator) => Promise<void> = async (o) => o.final('hello there');
  async start(): Promise<void> {}
  pushChunk(c: { payload: Buffer }): ChunkIntake { this.fedBytes += c.payload.length; return 'fed'; }
  stop(): Promise<void> { return this.script(this); }
  async close(): Promise<void> {}
  async waitForTerminal(): Promise<void> {}
  get fedAudioMs(): number { return this.fedBytes / 32; }
  get uniqueFedAudioMs(): number { return this.fedBytes / 32; }
  final(text: string): void { this.emit('final', { text, confidence: 0.9, language: 'en', segment_idx: 0, is_segment: false, duration_ms: 1000 }); }
  error(code: string): void { this.emit('error', { code, message: code, retryable: false }); }
}

/** The real-bridge rig: production handler, registry, ledger and a real `SttSessionBridge` over a scripted engine. */
function bridgeRelay() {
  const { guard, usageTracker } = deps();
  const socket = new FakeSocket(USER);
  const clock = new FakeClock(T0);
  let script: (o: ScriptedOrchestrator) => Promise<void> = async (o) => o.final('hello');
  let bridge: SttSessionBridge | null = null;
  const settles: Parameters<SttSessionDeps['onComplete']>[] = [];
  registerAudioHandlers(socket as unknown as Socket, {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker, recoveryOps: db.recoveryOps,
    store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
    sttFactory: (args) => {
      const s = script;
      bridge = new SttSessionBridge({
        build: () => { const o = new ScriptedOrchestrator(); o.script = s; return { orchestrator: o as unknown as SttEngineOrchestrator, isByok: false, gated: false }; },
        emitter: { emit: () => {} },
        userId: args.userId, mode: args.mode, sourceLang: args.sourceLang,
        onComplete: (...a) => { settles.push(a); args.onComplete(...a); },
        levelIntervalMs: 0, now: clock.nowFn,
      });
      return bridge;
    },
    now: () => relayNow,
  });
  const loud = (): string => {
    const b = Buffer.alloc(CHUNK_BYTES);
    for (let i = 0; i < CHUNK_BYTES; i += 2) b.writeInt16LE(i % 64 < 32 ? 8_000 : -8_000, i);
    return b.toString('base64');
  };
  return {
    settles,
    async record(f: Record<string, unknown>, s: (o: ScriptedOrchestrator) => Promise<void>): Promise<unknown> {
      script = s;
      bridge = null;
      let ack: unknown;
      socket.fire('audio:start', f, (r) => { ack = r; });
      await drain();
      if (bridge === null) return ack; // refused at admission: nothing was built
      for (let seq = 0; seq * CHUNK_MS < 6_000; seq++) {
        (bridge as SttSessionBridge).pushChunk(seq, loud(), clock.now);
        await clock.advance(CHUNK_MS);
      }
      socket.fire('audio:stop', {}, () => {});
      await drain();
      await clock.advance(15_000);
      await drain();
      return ack;
    },
  };
}

describe('NR-138 round 6 — the review\'s probes, made to pass (book 22 §4.11)', () => {
  it('🔴 REVIEW B6: the same claimed operation with a changed job_id is refused', () => {
    const r = relay();
    expect(r.attempt(frame(), 60_000)).toMatchObject({ ok: true });
    expect(r.attempt(frame({ job_id: 'job-unrelated' }), 60_000)).toMatchObject(CONFLICT);
    expect(minutes(), 'nothing was given away').toBeCloseTo(1, 6);
    expect(db.usageEffects.listByUser(USER)[0]).toMatchObject({ replays: 0, job_id: 'job-r6' });
  });

  it('🔴 B6 before any claim: a registered operation re-sent under a different job is refused by the registry', () => {
    const r = relay();
    expect(r.attempt(frame(), 0)).toMatchObject({ ok: true }); // registered; an uncharged attempt, no claim
    expect(db.usageEffects.listByUser(USER)).toHaveLength(0);
    expect(r.attempt(frame({ job_id: 'job-unrelated' }), 60_000)).toMatchObject(CONFLICT);
    expect(minutes()).toBe(0);
  });

  it('🔴 REVIEW B7: a later-created claim keeps its binding until that claim expires (seam)', () => {
    const r = relay();
    expect(r.attempt(frame(), 0)).toMatchObject({ ok: true }); // day 0: nothing billed, nothing claimed
    relayNow = NOW + 5 * DAY;
    expect(r.attempt(frame(), 60_000)).toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(1, 6);
    relayNow = NOW + 91 * DAY;
    expect(db.usageEffects.prune(relayNow), 'the claim is 86 days old').toBe(0);
    expect(db.recoveryOps.prune(relayNow), 'the registry row is 91 days old').toBe(1);
    expect(db.usageEffects.listByUser(USER)).toHaveLength(1);
    expect(r.attempt(frame({ recording_id: 'different-recording' }), 60_000)).toMatchObject(CONFLICT);
    expect(r.attempt(frame({ job_id: 'different-job' }), 60_000)).toMatchObject(CONFLICT);
    expect(r.attempt(frame({ range_end_sample: 960_001 }), 60_000)).toMatchObject(CONFLICT);
    expect(minutes(), 'the different recording was not given the claim').toBeCloseTo(1, 6);
    // ...and the honest re-send under the same binding is still a bounded replay of it.
    expect(r.attempt(frame(), 60_000)).toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(1, 6);
  });

  it('🔴 REVIEW B7: a real engine failure first, a charge five days later, a borrowed id at day 91 (real bridge)', async () => {
    const op = { recording_id: 'record-original', job_id: 'job-original', operation_id: 'o-late-claim', attempt_kind: 'auto_retry', range_start_sample: 0, range_end_sample: 96_000 };
    const r = bridgeRelay();
    await r.record(frame({ ...op, attempt_id: 'a-first' }), async (o) => { o.error('STT_ENGINE_TIMEOUT'); o.final(''); });
    expect(r.settles[0]![3], 'precondition: a real engine-failure settle').toBeDefined();
    expect(db.usageEffects.listByUser(USER), 'no claim on the failure').toHaveLength(0);
    relayNow = NOW + 5 * DAY;
    await r.record(frame({ ...op, attempt_id: 'a-success' }), async (o) => o.final('original usable text'));
    expect(minutes()).toBeCloseTo(0.1, 6);
    relayNow = NOW + 91 * DAY;
    expect(db.usageEffects.prune(relayNow)).toBe(0);
    expect(db.recoveryOps.prune(relayNow)).toBe(1);
    const ack = await r.record(
      frame({ ...op, recording_id: 'record-different', job_id: 'job-different', attempt_id: 'a-borrowed' }),
      async (o) => o.final('different recording usable text'),
    );
    expect(ack).toMatchObject(CONFLICT);
    expect(minutes()).toBeCloseTo(0.1, 6);
  });

  it('control: account B cannot borrow account A\'s claim or binding', () => {
    db.users.insert({ id: 'review-B', display_name: 'B', plan: 'pro' });
    relay().attempt(frame(), 60_000);
    expect(relay('review-B').attempt(frame({ recording_id: 'B-recording' }), 60_000)).toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(1, 6);
    expect(minutes('review-B')).toBeCloseTo(1, 6);
  });

  it('control: recording, job, range, kind and mode conflicts are refused while the binding lives', () => {
    const r = relay();
    r.attempt(frame(), 60_000);
    for (const changed of [
      { recording_id: 'other' }, { job_id: 'other' }, { range_start_sample: 1 }, { range_end_sample: 960_001 },
      { attempt_kind: 'user_retranscribe' }, { mode: 'translate' },
    ]) expect(r.attempt(frame(changed), 60_000)).toMatchObject(CONFLICT);
    expect(minutes()).toBeCloseTo(1, 6);
  });

  it('control: tolerance-max replays do not grow billed_ms; the sixth is billed', () => {
    const r = relay();
    r.attempt(frame(), 60_000);
    for (let i = 0; i < 5; i++) r.attempt(frame(), 61_200);
    expect(minutes()).toBeCloseTo(1, 6);
    expect(db.usageEffects.listByUser(USER)[0]).toMatchObject({ billed_ms: 60_000, replays: 5 });
    r.attempt(frame(), 61_200);
    expect(minutes()).toBeCloseTo(2.02, 6);
  });

  it('control: one ms over tolerance bills the whole excess; a growing basis must be paid', () => {
    const r = relay();
    r.attempt(frame(), 60_000);
    r.attempt(frame(), 61_201);
    expect(minutes()).toBeCloseTo(61_201 / 60_000, 6);
    expect(db.usageEffects.listByUser(USER)[0]).toMatchObject({ billed_ms: 61_201, replays: 1 });
    r.attempt(frame(), 62_426);
    expect(minutes()).toBeCloseTo(62_426 / 60_000, 6);
  });

  it('control: concurrency — 20 same-tick settlements of one operation spend the free counter exactly five times', async () => {
    relay().attempt(frame(), 60_000);
    await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => relay().attempt(frame(), 60_000))));
    expect(db.usageEffects.listByUser(USER)[0]?.replays).toBe(20);
    expect(minutes(), 'one charge + 5 free + 15 billed in full').toBeCloseTo(16, 6);
  });
});

describe('NR-138 round 6 — the ledger\'s second lock and the unbound claim', () => {
  const A = { recording_id: 'rec-a', job_id: 'job-a', range_start_sample: 0, range_end_sample: 960_000 };
  const ref = (binding?: typeof A) => ({ user_id: USER, operation_id: 'o-ledger', kind: 'stt' as const, at: NOW, binding });

  it('🔴 a replay whose binding differs from the claim\'s is billed in full and leaves the claim untouched', () => {
    const charged: number[] = [];
    expect(db.usageEffects.meter(ref(A), 60_000, (c) => charged.push(c))).toBe('applied');
    expect(db.usageEffects.meter(ref({ ...A, job_id: 'job-b' }), 60_000, (c) => charged.push(c))).toBe('replay_unbound');
    expect(db.usageEffects.meter(ref(undefined), 60_000, (c) => charged.push(c))).toBe('replay_unbound');
    expect(charged).toEqual([60_000, 60_000, 60_000]);
    expect(db.usageEffects.listByUser(USER)[0]).toMatchObject({ replays: 0, billed_ms: 60_000, job_id: 'job-a' });
    expect(db.usageEffects.meter(ref(A), 60_000, (c) => charged.push(c)), 'the same binding is still a free replay').toBe('replay_free');
  });

  it('🔴 a claim with no binding (written before round 6, or with none) is invalid: every replay billed', () => {
    const charged: number[] = [];
    db.usageEffects.meter(ref(undefined), 60_000, (c) => charged.push(c));
    db.usageEffects.meter(ref(A), 60_000, (c) => charged.push(c));
    db.usageEffects.meter(ref(undefined), 60_000, (c) => charged.push(c));
    expect(charged).toEqual([60_000, 60_000, 60_000]);
  });

  it('a registry row written before job_id existed does not compare it (its claim carries the binding that bills)', () => {
    db.raw.prepare(
      `INSERT INTO recovery_operations (user_id, operation_id, recording_id, range_start_sample, range_end_sample,
         attempt_kind, mode, first_seen_at, last_seen_at, resend_count) VALUES (?,?,?,?,?,?,?,?,?,0)`,
    ).run(USER, 'o-legacy-row', 'rec-l', 0, 960_000, 'auto_retry', 'realtime', NOW, NOW);
    expect(db.recoveryOps.admit(USER, 'o-legacy-row', {
      recording_id: 'rec-l', job_id: 'job-now-known', range_start_sample: 0, range_end_sample: 960_000, attempt_kind: 'auto_retry', mode: 'realtime',
    }, NOW)).toMatchObject({ outcome: 'resend' });
  });
});

describe('NR-138 round 6 — a replica carries the binding to the writer', () => {
  const body = { kind: 'usage.stt', user_id: USER, engine: { is_byok: false }, duration_ms: 60_000, chars: CHARS, operation_id: 'o-fwd' };
  const B = { recording_id: 'rec-f', job_id: 'job-f', range_start_sample: 0, range_end_sample: 960_000 };

  it('a complete binding survives the forwarded record; a partial one, or one without an operation, is dropped', () => {
    expect(parseForwardedWrite({ ...body, operation_binding: B })).toMatchObject({ operation_binding: B });
    expect(parseForwardedWrite({ ...body, operation_binding: { ...B, job_id: undefined } })).not.toHaveProperty('operation_binding');
    const { operation_id: _drop, ...noOp } = body;
    expect(parseForwardedWrite({ ...noOp, operation_binding: B })).not.toHaveProperty('operation_binding');
  });
});
