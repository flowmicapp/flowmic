// card RC-R (relay side, MAIN ruling 3 option 甲) — a recovery job's AUTOMATIC attempts carry ONE operation id,
// derived by the phone from `job_id` + `attempt_kind`, so the relay's existing operation ledger meters the job
// once. A user's own re-transcription is a new operation per press and is billed per press (owner ruling O-4).
//
// SPEC-REF:
//   docs/strategy/2026-09-24-cr12e-rerun3-root-cause.md §2.2 (S6: a 65.9 s owed stretch billed 4 × 65.85 s,
//     none settled — every attempt minted a fresh `operation_id`), §8 RC-R, §11-3 (MAIN: option 甲)
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.9 (RC-R block — the RC-8 line it closes)
//   apps/server-core/src/socket/handlers/audio-start-operation.ts (admission: registered / resend / conflict)
//   apps/server-core/src/billing/usage-tracker.ts `meterOnce` (the `(user, operation_id, kind)` claim)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// THE RELAY CHANGE IS NONE, AND THIS FILE IS WHY THAT IS TRUE. The card asked which of two changes resolves the
// `attempt_kind`-in-the-binding conflict: move the kind out of the registry's immutable binding
// (`recovery-operations.repo.ts sameBinding`), or put it into the derived id. The second is the smaller one —
// with the kind in the id, one operation id always carries one kind, the binding (recording, range, kind, mode)
// is identical on every attempt of that job, and the relay's registry answers `resend`; nothing on the relay
// moves. The first would widen what 「the same request」 means for every operation, live presses included.
// The rows below drive the PRODUCTION handler (`registerAudioHandlers`) over a real database and assert on
// the PERSISTED counter (`usage` minutes and the `usage_effects` claim), never on a call count (§A7-2).
//
// ⚠️ THE KNOWN CONSEQUENCE, WRITTEN INTO THE RULING (§11-3): a first attempt that was fed only half its range
// and then failed has already claimed the operation; the full re-transcription that follows is not billed.
// That is the under-billing direction, accepted. The third row pins it, so it is a decision and not a surprise.
//
// REVERSE CONTROL (see the card report): the id minted fresh per attempt (the phone before RC-R) ⇒ the first
// row red at two charges.

import { createHash } from 'node:crypto';
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

const USER = 'u-rcr';
const NOW = Date.parse('2026-09-24T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const CHARS = { transcript: 30, delivered: 30 } as const;
const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

/** The phone's rule after RC-R (MAIN 2026-09-24, phone agent's derivation; the relay never parses it):
 *  `'o-' + hex(sha256('op-v1|' + jobId + '|' + kind + '|' + generation))[0:32]`, where `generation` counts the
 *  earlier AUDIO_OP_BINDING_CONFLICT refusals for that job and kind. Only `auto_retry` shares an id this way;
 *  each `user_retranscribe` press is a fresh id (O-4). */
const derivedOperationId = (jobId: string, kind: string, generation = 0): string =>
  `o-${createHash('sha256').update(`op-v1|${jobId}|${kind}|${generation}`, 'utf8').digest('hex').slice(0, 32)}`;
let presses = 0;
const freshPressId = (): string => `o-press-${++presses}`;

let db: DbConnection;
beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('rc-r-recovery-bills-once-32-bytes') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
});
afterEach(() => { db.close(); });

/** One socket, the production audio handler, the production registry and ledger. Each `attempt` is one
 *  `audio:start` of a recovery range that runs to a settled session ([billedMs] handed to the metering seam). */
function relay(): { attempt(o: { job: string; kind: string; opId: string; billedMs: number; range?: [number, number] }): unknown } {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false, now: () => NOW });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: 'saas', now: () => NOW });
  const usageTracker = makeUsageTracker(db.usage, { mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: db.usageEffects });
  const socket = new FakeSocket('m');
  let seam: ((d: number, byok: boolean, chars: { transcript: number; delivered: number }) => void) | null = null;
  registerAudioHandlers(socket as unknown as Socket, {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker, recoveryOps: db.recoveryOps,
    store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
    sttFactory: (args) => { seam = args.onComplete; return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} }; },
    now: () => NOW,
  });
  return {
    attempt(o): unknown {
      seam = null;
      let ack: unknown;
      socket.fire('audio:start', {
        ...AUDIO_START,
        recording_id: 'rec-1', job_id: o.job, attempt_id: `a-${Math.random()}`, operation_id: o.opId, attempt_kind: o.kind,
        range_start_sample: o.range?.[0] ?? 0, range_end_sample: o.range?.[1] ?? 1_053_600,
      }, (r) => { ack = r; });
      if (seam !== null) (seam as (d: number, b: boolean, c: typeof CHARS) => void)(o.billedMs, false, CHARS);
      return ack;
    },
  };
}

const minutes = (): number => db.usage.get(USER, MONTH)?.stt_minutes ?? 0;
const claims = (): number => (db.raw.prepare(`SELECT COUNT(*) AS n FROM usage_effects WHERE user_id='${USER}' AND kind='stt'`).get() as { n: number }).n;

describe('RC-R — a recovery job is billed once, however many attempts it takes', () => {
  it('🔴 the same job, two automatic attempts (the first judged failed by the phone after the relay settled it) ⇒ the account moves once', async () => {
    const r = relay();
    const op = derivedOperationId('job-A', 'auto_retry');
    const first = r.attempt({ job: 'job-A', kind: 'auto_retry', opId: op, billedMs: 65_850 });
    expect(first, 'precondition: admitted').toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(65_850 / 60_000, 6);
    const second = r.attempt({ job: 'job-A', kind: 'auto_retry', opId: op, billedMs: 65_850 });
    expect(second, 'the re-send is admitted (same binding ⇒ `resend`), not refused').toMatchObject({ ok: true });
    expect(minutes(), 'the persisted minutes did not move a second time').toBeCloseTo(65_850 / 60_000, 6);
    expect(claims()).toBe(1);
    expect(db.recoveryOps.get(USER, op)?.resend_count).toBe(1);
  });

  it('different jobs (different ranges of the recording) each bill once', async () => {
    const r = relay();
    r.attempt({ job: 'job-A', kind: 'auto_retry', opId: derivedOperationId('job-A', 'auto_retry'), billedMs: 30_000, range: [0, 480_000] });
    r.attempt({ job: 'job-B', kind: 'auto_retry', opId: derivedOperationId('job-B', 'auto_retry'), billedMs: 12_000, range: [480_000, 672_000] });
    expect(minutes()).toBeCloseTo(42_000 / 60_000, 6);
    expect(claims()).toBe(2);
  });

  it('ruling O-4 — two presses of 「transcribe again」 on one job are two operations and are billed twice; the automatic retries beside them once', async () => {
    const r = relay();
    r.attempt({ job: 'job-A', kind: 'auto_retry', opId: derivedOperationId('job-A', 'auto_retry'), billedMs: 20_000 });
    r.attempt({ job: 'job-A', kind: 'auto_retry', opId: derivedOperationId('job-A', 'auto_retry'), billedMs: 20_000 });
    expect(r.attempt({ job: 'job-A', kind: 'user_retranscribe', opId: freshPressId(), billedMs: 20_000 })).toMatchObject({ ok: true });
    expect(r.attempt({ job: 'job-A', kind: 'user_retranscribe', opId: freshPressId(), billedMs: 20_000 })).toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(60_000 / 60_000, 6);
    expect(claims()).toBe(3);
  });

  it('why the kind must be in the id — one id reused across kinds is refused as a changed binding, and bills nothing', async () => {
    const r = relay();
    const shared = 'o-job-A';
    r.attempt({ job: 'job-A', kind: 'auto_retry', opId: shared, billedMs: 20_000 });
    const refused = r.attempt({ job: 'job-A', kind: 'user_retranscribe', opId: shared, billedMs: 20_000 });
    expect(refused).toMatchObject({ error: 'AUDIO_OP_BINDING_CONFLICT' });
    expect(minutes()).toBeCloseTo(20_000 / 60_000, 6);
  });

  it('after a binding refusal the phone moves to the next generation: the refused start bills nothing, the next one bills once', async () => {
    const r = relay();
    // A stored binding the job's auto id no longer matches (e.g. registered by an older build with another range).
    r.attempt({ job: 'job-A', kind: 'auto_retry', opId: derivedOperationId('job-A', 'auto_retry'), billedMs: 20_000, range: [0, 100] });
    const refused = r.attempt({ job: 'job-A', kind: 'auto_retry', opId: derivedOperationId('job-A', 'auto_retry'), billedMs: 20_000 });
    expect(refused).toMatchObject({ error: 'AUDIO_OP_BINDING_CONFLICT' });
    const next = r.attempt({ job: 'job-A', kind: 'auto_retry', opId: derivedOperationId('job-A', 'auto_retry', 1), billedMs: 20_000 });
    expect(next).toMatchObject({ ok: true });
    expect(r.attempt({ job: 'job-A', kind: 'auto_retry', opId: derivedOperationId('job-A', 'auto_retry', 1), billedMs: 20_000 })).toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(40_000 / 60_000, 6);
  });

  it('⚠️ the accepted consequence: a first attempt that was fed half its range claims the job; the full re-run is not billed', async () => {
    const r = relay();
    const op = derivedOperationId('job-A', 'auto_retry');
    r.attempt({ job: 'job-A', kind: 'auto_retry', opId: op, billedMs: 30_000 }); // half of a 60 s range reached the engine
    r.attempt({ job: 'job-A', kind: 'auto_retry', opId: op, billedMs: 60_000 }); // the whole range, recognised again
    expect(minutes()).toBeCloseTo(30_000 / 60_000, 6);
  });
});
