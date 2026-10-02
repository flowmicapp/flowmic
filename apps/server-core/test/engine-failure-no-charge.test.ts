// NR-138 item 5 — an engine failure that gave the person no usable transcript does not consume their allowance.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.10 (the rule, the failure set, the non-failures)
//   docs/decisions/2026-10-01-owner-engine-failure-no-charge.md (owner ruling, option ②)
//   apps/server-core/src/engine/stt-engine-failure.ts (`ENGINE_FAILURE_CODES`, `EngineFailureLatch`)
//
// THE CHAIN UNDER TEST IS THE PRODUCTION ONE: the real `SttSessionBridge` (its settle latch, its error / engine-status
// / final wiring), the real audio handler (`registerAudioHandlers`: audio:start admission, the stop → finish →
// dispose chain, its watchdog, `commitSttUsage`), and the real ledger (usage tracker + `usage_effects` +
// `recovery_operations` on SQLite). Assertions land on the PERSISTED minutes and claims, never on a call count.
//
// Two kinds of engine stand in, for two different questions:
//   · `ScriptedOrchestrator` — emits exactly the terminal facts a row is about (a spoken error, a recovery, a final
//     with or without words, a finish that never ends). It is how each failure kind and each non-failure is pinned
//     without depending on a vendor's timing;
//   · the real `SttEngineOrchestrator` over a stub leg — shows that facts the PRODUCTION orchestrator produces (a
//     refused cold open, a flush that never answers) reach the rule.
// Sessions are built non-gated (`gated:false`), the basis that bills every received millisecond: it is the one where
// "charged" and "not charged" differ by the most, so a wrong verdict cannot hide behind a basis that is already 0.
//
// REVERSE CONTROLS (run 2026-10-01, each restored byte-for-byte and re-run 21/21 green):
//   · duration-only charging restored (the bridge's `settle()` ignores the latch) ⇒ 11 of 21 red: all ten failure
//     rows on the persisted minutes (`expected 0.1 to be +0`), the watchdog row on its settle fact;
//   · the tracker's early return removed (the failure reaches `meterOnce`) ⇒ 11 of 21 red, every one on the
//     persisted minutes, the once-only row included.
//   A first version of the watchdog row was VACUOUS — it advanced 20 s, the watchdog window grows with the fed
//   audio, nothing settled, and 「0 minutes」 held under both mutations. The `settles` positive control is the fix.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import type { SttEngineId } from '@flowmic/protocol';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import { makeUsageTracker } from '../src/billing/usage-tracker';
import { SttAllowancePool } from '../src/billing/stt-allowance-pool';
import { currentMonth } from '../src/db/repos/usage.repo';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers } from '../src/socket/handlers/audio.handler';
import { SttSessionBridge } from '../src/engine/stt-session';
import { reserveSessionAllowance, settleSessionUsage } from '../src/engine/stt-session-allowance';
import { ENGINE_FAILURE_CODES } from '../src/engine/stt-engine-failure';
import type { SttCharCounts, SttEngineFailure } from '../src/engine/stt-session-deps';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { ChunkIntake } from '../src/stt/orchestrator-core';
import type { AudioSession } from '../src/stt/audio/session';
import type { VadGate } from '../src/stt/vad-gate';
import type { EngineState, SttEngine } from '../src/stt/engines/base';
import { CHUNK_BYTES, CHUNK_MS, FakeClock, T0, drain } from './fixtures/stt-outage-harness';

const USER = 'u-nocharge';
const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'en', delivery: 'none' };

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

/** Emits exactly the facts a row is about. `stop()` runs the row's script; `hang` makes it never return. */
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
  final(text: string, isSegment = false): void {
    this.emit('final', { text, confidence: 0.9, language: 'en', segment_idx: 0, is_segment: isSegment, duration_ms: 1000 });
  }
  error(code: string, retryable = false): void { this.emit('error', { code, message: code, retryable }); }
}

/** A stub vendor leg for the REAL orchestrator rows. */
class StubLeg extends EventEmitter implements SttEngine {
  readonly id: SttEngineId = 'soniox';
  private _state: EngineState = 'closed';
  constructor(private readonly mode: 'healthy' | 'refuse' | 'silent-flush') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { if (this.mode === 'refuse') throw new Error('connect refused'); this._state = 'open'; }
  push(): void {}
  flush(): Promise<void> {
    if (this.mode === 'healthy') {
      this.emit('final', { kind: 'final', text: 'real words', confidence: 0.9, language: 'en', duration_ms: 0 });
      return Promise.resolve();
    }
    // 'silent-flush': the vendor never answers the end-of-stream, so the flush never returns and the
    // orchestrator's flush cap is what ends the wait. (A flush that RETURNS with no final is the engine saying
    // 「done, nothing」 — a normal empty end, which is not this row.)
    return this.mode === 'silent-flush' ? new Promise<void>(() => {}) : Promise.resolve();
  }
  async close(): Promise<void> { this._state = 'closed'; }
}

/** A loud 200 ms chunk (well above the gate) — or a silent one. */
function chunk(loud: boolean): string {
  const b = Buffer.alloc(CHUNK_BYTES);
  if (loud) for (let i = 0; i < CHUNK_BYTES; i += 2) b.writeInt16LE(i % 64 < 32 ? 8_000 : -8_000, i);
  return b.toString('base64');
}

let db: DbConnection;
beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr-138-engine-failure-nocharge-32b') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
});
afterEach(() => { vi.useRealTimers(); db.close(); });

const minutes = (): number => db.usage.get(USER, MONTH)?.stt_minutes ?? 0;
const claims = (): number => (db.raw.prepare(`SELECT COUNT(*) AS n FROM usage_effects WHERE user_id='${USER}' AND kind='stt'`).get() as { n: number }).n;

type Engine = { kind: 'scripted'; script: (o: ScriptedOrchestrator) => Promise<void> } | { kind: 'real'; leg: 'healthy' | 'refuse' | 'silent-flush' };

/** One socket, the production audio handler and ledger; every session is a real bridge over [engine]. */
function relay(o: { mode?: 'saas' | 'standalone'; byok?: boolean } = {}) {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false, now: () => NOW });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: o.mode ?? 'saas', now: () => NOW });
  const usageTracker = makeUsageTracker(db.usage, { mode: o.mode ?? 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: db.usageEffects });
  const socket = new FakeSocket('m');
  const clock = new FakeClock(T0);
  let engine: Engine = { kind: 'scripted', script: async (s) => s.final('hello there') };
  let bridge: SttSessionBridge | null = null;
  const settles: Parameters<import('../src/engine/stt-session-deps').SttSessionDeps['onComplete']>[] = [];
  registerAudioHandlers(socket as unknown as Socket, {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker, recoveryOps: db.recoveryOps,
    store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
    sttFactory: (args) => {
      const e = engine;
      bridge = new SttSessionBridge({
        build: (session: AudioSession, _l: string, _u: string, vad?: VadGate) => {
          if (e.kind === 'scripted') {
            const s = new ScriptedOrchestrator(); s.script = e.script;
            return { orchestrator: s as unknown as SttEngineOrchestrator, isByok: o.byok === true, gated: false };
          }
          const orch = new SttEngineOrchestrator(session, () => new StubLeg(e.leg), {
            now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, softSegmentMs: 3_600_000,
            shouldFeedEngine: (): boolean => vad!.admitChunk, // as engine-factory.ts wires a managed leg
          });
          return { orchestrator: orch, isByok: o.byok === true, gated: false };
        },
        emitter: { emit: () => {} },
        userId: args.userId, mode: args.mode, sourceLang: args.sourceLang,
        // Recorded on the way through, so a row can prove its session DID settle (and with which fact).
        onComplete: (...a) => { settles.push(a); args.onComplete(...a); },
        levelIntervalMs: 0,
        now: clock.nowFn,
      });
      return bridge;
    },
    now: () => NOW,
  });
  return {
    clock,
    get bridge(): SttSessionBridge { return bridge!; },
    settles,
    /** One recording: start, [seconds] of audio, stop. Returns the start ack. */
    async record(e: Engine, opts: { seconds?: number; loud?: boolean; discard?: boolean; frame?: Record<string, unknown> } = {}): Promise<unknown> {
      engine = e;
      let ack: unknown;
      socket.fire('audio:start', { ...AUDIO_START, ...(opts.frame ?? {}) }, (r) => { ack = r; });
      await drain();
      for (let seq = 0; seq * CHUNK_MS < (opts.seconds ?? 6) * 1000; seq++) {
        bridge!.pushChunk(seq, chunk(opts.loud ?? true), clock.now);
        await clock.advance(CHUNK_MS);
      }
      socket.fire('audio:stop', opts.discard === true ? { discard: true } : {}, () => {});
      await drain();
      await clock.advance(15_000); // the terminal flush cap, on the fake clock (real-orchestrator rows)
      await drain();
      return ack;
    },
  };
}

const SIX_SECONDS_IN_MIN = 6_000 / 60_000;
const scripted = (script: (o: ScriptedOrchestrator) => Promise<void>): Engine => ({ kind: 'scripted', script });

describe('NR-138 item 5 — engine failures with no usable transcript are not charged (book 22 §4.10)', () => {
  // ── the failure set: 0 persisted minutes, no claim ─────────────────────────────────────────────────────────
  it.each([
    ['engine timeout (flush refused / timed out)', scripted(async (o) => { o.error('STT_ENGINE_TIMEOUT'); o.final(''); })],
    ['refusal (the engine would not open)', scripted(async (o) => { o.error('STT_ENGINE_NOT_OPEN'); o.final(''); })],
    ['transport loss (engine connection lost, ladder exhausted)', scripted(async (o) => { o.error('STT_NETWORK_DROP'); o.final(''); })],
    ['zero-transcript failure (voice captured, no engine reached)', scripted(async (o) => { o.error('STT_NO_ENGINE_REACHED'); o.final(''); })],
    ['an error with no code (the bridge reads it as STT_NETWORK_DROP)', scripted(async (o) => { o.emit('error', { message: 'x', retryable: false }); o.final(''); })],
    ['finish failure (finish() rejected)', scripted(async () => { throw new Error('engine stop blew up'); })],
  ])('🔴 %s ⇒ nothing is debited and no claim is taken', async (_name, engine) => {
    const r = relay();
    expect(await r.record(engine)).toMatchObject({ ok: true });
    expect(r.settles, 'positive control: the session settled, once').toHaveLength(1);
    expect(minutes(), 'the persisted ledger did not move').toBe(0);
    expect(claims()).toBe(0);
  });

  it('🔴 the finish watchdog forced the teardown ⇒ not charged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = relay();
    const ack = r.record(scripted(() => new Promise<void>(() => {}))); // finish() never ends
    await vi.advanceTimersByTimeAsync(0);
    await ack;
    expect(r.settles, 'precondition: finish() is still waiting, nothing has settled').toHaveLength(0);
    // AUDIO_STOP_FINISH_WATCHDOG_MS plus its growth for the audio this recording fed (audio-stop-watchdog.ts).
    await vi.advanceTimersByTimeAsync(300_000);
    expect(r.settles, 'positive control: the watchdog really forced the settle').toHaveLength(1);
    expect(r.settles[0]![3]).toEqual({ kind: 'finish_watchdog' });
    expect(minutes()).toBe(0);
    expect(claims()).toBe(0);
  });

  it('🔴 repeated disposal and a late finish settle nothing further', async () => {
    const r = relay();
    await r.record(scripted(async (o) => { o.error('STT_ENGINE_TIMEOUT'); o.final(''); }));
    r.bridge.dispose(); r.bridge.dispose();
    await r.bridge.finish();
    expect(minutes()).toBe(0);
    expect(claims()).toBe(0);
  });

  it('🔴 the claim stays free: a failed automatic attempt, then the same operation succeeds ⇒ exactly one debit', async () => {
    const r = relay();
    const op = { recording_id: 'rec-1', job_id: 'job-1', attempt_id: 'a-1', operation_id: 'o-job-1', attempt_kind: 'auto_retry', range_start_sample: 0, range_end_sample: 96_000 };
    expect(await r.record(scripted(async (o) => { o.error('STT_ENGINE_TIMEOUT'); o.final(''); }), { frame: op })).toMatchObject({ ok: true });
    expect(minutes()).toBe(0);
    expect(claims(), 'no successful-operation claim was spent on the failure').toBe(0);
    expect(await r.record(scripted(async (o) => o.final('the words')), { frame: { ...op, attempt_id: 'a-2' } })).toMatchObject({ ok: true });
    expect(minutes(), 'the successful resend is metered').toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
    expect(claims()).toBe(1);
    await r.record(scripted(async (o) => o.final('the words')), { frame: { ...op, attempt_id: 'a-3' } });
    expect(minutes(), 'and only once').toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });

  // ── the real orchestrator's own facts reach the rule ───────────────────────────────────────────────────────
  it('🔴 real orchestrator: a refused cold open ⇒ not charged', async () => {
    const r = relay();
    await r.record({ kind: 'real', leg: 'refuse' });
    expect(r.settles).toHaveLength(1);
    expect(minutes()).toBe(0);
  });

  it('🔴 real orchestrator: a flush the vendor never answers ⇒ not charged', async () => {
    const r = relay();
    await r.record({ kind: 'real', leg: 'silent-flush' });
    expect(r.settles).toHaveLength(1);
    expect(r.settles[0]![3]).toEqual({ kind: 'engine_error', code: 'STT_ENGINE_TIMEOUT' });
    expect(minutes()).toBe(0);
  });

  // ── positive controls: billed exactly as before ────────────────────────────────────────────────────────────
  it('control — healthy speech is billed (scripted and real orchestrator)', async () => {
    const r = relay();
    await r.record(scripted(async (o) => o.final('hello there')));
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
    await r.record({ kind: 'real', leg: 'healthy' });
    expect(minutes()).toBeCloseTo(2 * SIX_SECONDS_IN_MIN, 6);
  });

  it('control — real silence: a normal end with empty recognition is not a failure, billed as today', async () => {
    const r = relay();
    await r.record(scripted(async (o) => o.final('')), { loud: false });
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });

  it('control — a vendor 「no audio received」 suppressed as our own silence is not a failure', async () => {
    const r = relay();
    await r.record(scripted(async (o) => { o.emit('error-suppressed', { code: 'STT_NO_ENGINE_REACHED', message: 'no audio', retryable: false }); o.final(''); }), { loud: false });
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });

  it('control — a partial usable transcript bills normally, whatever failed after it', async () => {
    const r = relay();
    await r.record(scripted(async (o) => { o.final('part one', true); o.error('STT_NETWORK_DROP'); o.final(''); }));
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });

  it('control — an engine that recovered hands the verdict to what came after (a normal empty end ⇒ billed)', async () => {
    const r = relay();
    await r.record(scripted(async (o) => { o.error('STT_NETWORK_DROP', true); o.emit('engine-status', { provider: 'soniox', status: 'ready' }); o.final(''); }));
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });

  it('control — the user\'s swipe-up cancel is not an engine failure, billed as today', async () => {
    const r = relay();
    await r.record(scripted(async (o) => o.final('never asked for')), { discard: true });
    expect(minutes()).toBeCloseTo(SIX_SECONDS_IN_MIN, 6);
  });

  it('control — BYOK and standalone are never charged, failure or not', async () => {
    const byok = relay({ byok: true });
    await byok.record(scripted(async (o) => o.final('hello')));
    await byok.record(scripted(async (o) => { o.error('STT_ENGINE_TIMEOUT'); o.final(''); }));
    const standalone = relay({ mode: 'standalone' });
    await standalone.record(scripted(async (o) => o.final('hello')));
    expect(minutes()).toBe(0);
  });
});

describe('the hold: released whole, nothing committed (stt-session-allowance.ts settleSessionUsage)', () => {
  const chars: SttCharCounts = { transcript: 0, delivered: 0 };
  const failure: SttEngineFailure = { kind: 'engine_error', code: 'STT_ENGINE_TIMEOUT' };

  it('🔴 an uncharged settle commits nothing and gives the whole hold back', () => {
    const pool = new SttAllowancePool();
    const allowance = reserveSessionAllowance(pool, { userId: USER, roomId: 'r', payerMs: () => 60_000, keyMs: () => undefined, planCapMs: 60_000 });
    expect(pool.available(USER, 60_000), 'precondition: the session holds the allowance').toBe(0);
    const metered: unknown[][] = [];
    settleSessionUsage(allowance, 6_000, false, chars, failure, (...a) => { metered.push(a); });
    expect(pool.available(USER, 60_000), 'the hold is back').toBe(60_000);
    expect(metered).toEqual([[6_000, false, chars, failure]]);
  });

  it('control: a charged settle commits min(ms, hold) and releases, exactly as before', () => {
    const pool = new SttAllowancePool();
    const allowance = reserveSessionAllowance(pool, { userId: USER, roomId: 'r', payerMs: () => 60_000, keyMs: () => undefined, planCapMs: 60_000 });
    const metered: unknown[][] = [];
    settleSessionUsage(allowance, 6_000, false, chars, undefined, (...a) => { metered.push(a); });
    expect(pool.available(USER, 60_000)).toBe(60_000);
    expect(metered).toEqual([[6_000, false, chars]]);
  });

  it('the failure set the contract names is exactly the table in stt-engine-failure.ts', () => {
    expect([...ENGINE_FAILURE_CODES].sort()).toEqual([
      'STT_CONFIG_MISSING', 'STT_ENGINE_AUTH_FAIL', 'STT_ENGINE_NOT_OPEN', 'STT_ENGINE_RATE_LIMITED', 'STT_ENGINE_TIMEOUT',
      'STT_LANGUAGE_UNSUPPORTED', 'STT_NETWORK_DROP', 'STT_NO_ENGINE_REACHED', 'STT_POOL_NO_ROUTE', 'STT_SEGMENT_NOT_TRANSCRIBED',
    ]);
  });
});
