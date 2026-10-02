// NR-138 round 4 (MAIN decision, 2026-10-01) — a replay of a claimed recovery operation is free only inside a bound.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.11 「The bound on a free replay」
//   apps/server-core/src/db/repos/usage-effects.repo.ts (`replayCharge`, `REPLAY_FREE_LIMIT`, `replayToleranceMs`)
//   apps/server-core/src/db/repos/recovery-operations.repo.ts (`prune` keeps a claimed operation's binding)
//
// WHY: round 3 kept claims for the life of the account, and the registry binds no content hash — so one claimed
// `operation_id` could carry any audio, free, forever. Each row below drives the PRODUCTION audio handler
// (admission, the operation registry, `commitSttUsage`) over the real usage tracker and SQLite ledger, and asserts
// on the PERSISTED minutes. The recognition is the same seam as recovery-claim-retention.test.ts: each attempt
// settles with the basis the row names.
//
// REVERSE CONTROLS (run 2026-10-01; each restored byte-for-byte, then this file re-run green):
//   · the bound removed (`replayCharge` answers 「free」 for every replay) ⇒ 4 of 8 red, every one on the persisted
//     ledger: the excess, sixth-replay and expired-pre-change rows on the minutes, the LLM row on the tokens
//     (`expected 100 to be 400`);
//   · the registry prune without its 「keep a claimed operation」 clause ⇒ the 「another recording, after the
//     registry's seven days」 row red: the borrowed frame is admitted (`expected { ok: true } to match object
//     { error: 'AUDIO_OP_BINDING_CONFLICT' }`) instead of refused.

import { readFileSync } from 'node:fs';
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
import { startBackgroundSweeps } from '../src/bootstrap-sweeps';
import { loadConfig } from '../src/config';
import { REPLAY_FREE_LIMIT, replayToleranceMs } from '../src/db/repos/usage-effects.repo';

const USER = 'u-nr138-r4';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const CHARS = { transcript: 0, delivered: 0 } as const;

/** One legacy segment's recovery frame (the shape the phone sends, 04 §3.3-a). */
function frame(o: { op?: string; recording?: string; end?: number; attempt?: string } = {}): Record<string, unknown> {
  return {
    sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', delivery: 'none', source_lang: 'en',
    recording_id: o.recording ?? 'run-r4__seg-0', job_id: 'job-r4', attempt_id: o.attempt ?? `a-${Math.random()}`,
    operation_id: o.op ?? 'o-r4', attempt_kind: 'auto_retry',
    range_start_sample: 0, range_end_sample: o.end ?? 960_000, audio_format_version: 1,
  };
}

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

let db: DbConnection;
let relayNow = NOW;
beforeEach(() => {
  relayNow = NOW;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr-138-r4-replay-bound-32-bytes!!') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'pro' });
});
afterEach(() => { db.close(); });

const minutes = (): number => db.usage.get(USER, MONTH)?.stt_minutes ?? 0;
const MIN = 60_000;

/** The production handler and ledger; each attempt settles with [billedMs] (the §4.9 basis). */
function relay() {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: true, now: () => relayNow });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: 'saas', now: () => relayNow });
  const usageTracker = makeUsageTracker(db.usage, { mode: 'saas', now: () => relayNow, periodKeyFor: () => MONTH, operations: db.usageEffects });
  const socket = new FakeSocket();
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

describe('NR-138 round 4 — the free replay of a claimed operation is bounded (book 22 §4.11)', () => {
  it('🔴 an honest re-send within the tolerance is free', () => {
    const r = relay();
    expect(r.attempt(frame(), 60_000)).toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(1, 6);
    expect(replayToleranceMs(60_000), 'max(1 s, 2%) of a minute').toBe(1_200);
    r.attempt(frame(), 60_000);
    r.attempt(frame(), 61_200); // the gate and the vendor's step moved the basis a little: still the same audio
    expect(minutes(), 'the persisted ledger did not move').toBeCloseTo(1, 6);
  });

  it('🔴 a longer re-send is billed for the excess only, and then that length is paid for', () => {
    const r = relay();
    r.attempt(frame(), 60_000);
    r.attempt(frame(), 90_000);
    expect(minutes(), 'one minute, plus the 30 s it never paid').toBeCloseTo(1.5, 6);
    r.attempt(frame(), 90_000);
    expect(minutes(), 'the 90 s are paid now: free again').toBeCloseTo(1.5, 6);
  });

  it('🔴 the sixth replay is billed in full, and every one after it', () => {
    const r = relay();
    r.attempt(frame(), 60_000);
    for (let i = 0; i < REPLAY_FREE_LIMIT; i++) r.attempt(frame(), 60_000);
    expect(minutes(), 'five free replays').toBeCloseTo(1, 6);
    r.attempt(frame(), 60_000);
    expect(minutes(), 'the sixth').toBeCloseTo(2, 6);
    r.attempt(frame(), 60_000);
    expect(minutes(), 'the seventh').toBeCloseTo(3, 6);
  });

  it('🔴 another recording under its own id is billed', () => {
    const r = relay();
    r.attempt(frame(), 60_000);
    r.attempt(frame({ op: 'o-other', recording: 'run-other__seg-0' }), 60_000);
    expect(minutes()).toBeCloseTo(2, 6);
  });

  it('🔴 another recording reusing a claimed id is refused — at once, and after the registry\'s seven days', () => {
    const r = relay();
    r.attempt(frame(), 60_000);
    expect(r.attempt(frame({ recording: 'run-elsewhere__seg-0', end: 9_600_000 }), 600_000))
      .toMatchObject({ error: 'AUDIO_OP_BINDING_CONFLICT' });
    // Every daily sweep the relay arms, at relay day 8 (an unclaimed registration proves they ran).
    db.recoveryOps.admit(USER, 'o-never-claimed', { mode: 'realtime' }, NOW);
    const ticks: (() => void)[] = [];
    const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: true, now: () => relayNow });
    startBackgroundSweeps({
      config: loadConfig({ mode: 'saas', secret: 'nr-138-r4-replay-bound-secret-32b', port: 0, dbPath: ':memory:', trustedProxies: [] }),
      db, billing, nodeRole: 'single', now: () => relayNow,
      setIntervalFn: (fn) => { ticks.push(fn); return ticks.length; }, clearIntervalFn: () => {},
    });
    relayNow = NOW + 8 * DAY;
    for (const t of ticks) t();
    expect(db.recoveryOps.get(USER, 'o-never-claimed'), 'positive control: the sweeps ran').toBeNull();
    expect(r.attempt(frame({ recording: 'run-elsewhere__seg-0', end: 9_600_000 }), 600_000))
      .toMatchObject({ error: 'AUDIO_OP_BINDING_CONFLICT' });
    expect(minutes(), 'nothing was transcribed under the borrowed id, and nothing was given away').toBeCloseTo(1, 6);
  });

  // ⚠️ Round 6 (final review B6 + B7, MAIN decision; book 22 §4.11): this row used to pin round 4's 「a pre-change
  // claim keeps its seven-day promise」 (the two-day-old re-send free). A claim written before round 6 has no binding,
  // and a claim without a binding is invalid: every replay of it is billed normally.
  it('🔴 a claim written before binding existed has none, so every replay of it is billed normally', () => {
    const r = relay();
    // Pre-change rows: no billed_ms, no binding (NULL), replays 0 — exactly what reconcileSchema leaves on an old database.
    const claim = db.raw.prepare('INSERT INTO usage_effects (user_id, operation_id, kind, applied_at) VALUES (?, ?, ?, ?)');
    claim.run(USER, 'o-young', 'stt', NOW - 2 * DAY);
    claim.run(USER, 'o-old', 'stt', NOW - 8 * DAY);
    r.attempt(frame({ op: 'o-young', recording: 'run-young__seg-0' }), 60_000);
    expect(minutes(), 'a two-day-old unbound claim: billed').toBeCloseTo(1, 6);
    r.attempt(frame({ op: 'o-old', recording: 'run-old__seg-0' }), 60_000);
    expect(minutes(), 'an eight-day-old unbound claim: billed').toBeCloseTo(2, 6);
  });

  it('LLM claims take the counter only: five free replays, the sixth billed', () => {
    const t = makeUsageTracker(db.usage, { mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: db.usageEffects });
    const b = { recording_id: 'run-llm__seg-0', job_id: 'job-llm', range_start_sample: 0, range_end_sample: 960_000 };
    for (let i = 0; i < 1 + REPLAY_FREE_LIMIT; i++) t.recordLlmUsage(USER, { is_byok: false }, 100 + i, 50, {}, 'o-llm', b);
    expect(db.usage.get(USER, MONTH)?.llm_tokens_in).toBe(100);
    t.recordLlmUsage(USER, { is_byok: false }, 300, 50, {}, 'o-llm', b);
    expect(db.usage.get(USER, MONTH)?.llm_tokens_in).toBe(400);
  });

  it('the free-replay limit is the phone\'s own automatic cap (read from the phone source)', () => {
    const src = readFileSync('../mobile/lib/src/session/recovery_backoff.dart', 'utf8');
    const m = /const int kRecoveryMaxAutoAttempts = (\d+);/.exec(src);
    expect(m, 'the phone constant moved or changed shape').not.toBeNull();
    expect(REPLAY_FREE_LIMIT).toBe(Number(m![1]));
  });
});
