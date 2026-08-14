// 🔴 fix-025 (BILLING FACE) — the per-session ceiling and its ORIGIN come from
// one act, so they cannot disagree.
//
// WHAT WAS MEASURED BEFORE THE CHANGE (each link read, not inferred):
//   · `engine/stt-factory.ts` set `hardLimitMs = quota.remainingSttMs(userId)`;
//   · `billing/quota-guard.ts` returns `Math.max(0, limit - used) * 60_000` —
//     the user's REMAINING MONTHLY BUDGET in ms;
//   · `stt/audio/session.ts` defaulted `_limitOrigin` to `'engine_session'` and
//     the constructor never changed it;
//   · `clampHardLimitMs` was the ONLY writer of `'quota_budget'` and had ZERO
//     production callers.
// So the engine-session ceiling was REPLACED by the budget (1,200,000 ms for a
// fresh free account, against a 300,000 ms default) while still being labelled
// `engine_session` — and after N1-B4 that label means ROLL OVER. The billing wall
// was not mislabelled, it was off.
//
// THE THREE DESIGN QUESTIONS, ANSWERED HERE AND PINNED BELOW:
//   ① WHICH CEILING WINS — neither, permanently. They are two deadlines with
//      opposite actions; the nearer one is armed and `limitOrigin` names it. The
//      `min`-into-one-number shape cannot work after N1-B4: the engine ceiling
//      RE-ANCHORS itself at every rollover, so a budget that lost the `min` was
//      not merely unlabelled, it was unreachable.
//   ② `clampHardLimitMs` DOES NOT SURVIVE as a clamp. Its guard only tightened,
//      which drops the budget for every account with more than five minutes left
//      — the normal case. Replaced by `setQuotaBudgetMs`; the old name is kept as
//      a delegating alias ONLY because three test files this card did not own
//      call it, and the census at the bottom pins that.
//   ③ A ZERO BUDGET IS A CEILING OF ZERO, not 「no ceiling」. See the boundary
//      section for what it did before (a silent unbounded rollover loop) and what
//      it does now.
//
// ⚠️ WHAT THIS FILE CANNOT PROVE. Real billing behaviour under a real account
// with real usage is production and belongs to the device line. Everything below
// runs on an in-memory database and a fake or 60 ms clock.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'socket.io';
import { AUDIO_DEFAULTS } from '@flowmic/protocol';
import { AudioSession, type HardLimitOrigin } from '../src/stt/audio/session';
import { FakeClock, T0 } from './fixtures/stt-outage-harness';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { RoomStore } from '../src/room/store';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard } from '../src/billing/quota-guard';
import { planLimits } from '../src/billing/plans';
import { currentMonth } from '../src/db/repos/usage.repo';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import type { UsageTracker } from '../src/billing/usage-tracker';

/* ══════════════════════════════════════════════════════════════════════════════
 * 1 — THE ARITHMETIC. Two ceilings, one timer, and the origin that names the one
 *     that actually applied.
 * ═════════════════════════════════════════════════════════════════════════════ */

interface Rig {
  clock: FakeClock;
  session: AudioSession;
  /** ms since start at each engine-session rollover. */
  rollovers: number[];
  /** the `auto_stopped` reasons, in order. */
  stops: string[];
  /** `[ms since start, the origin ARMED at that moment]`, sampled at start and
   *  after every rollover — i.e. which ceiling was governing, moment by moment. */
  armed: [number, HardLimitOrigin][];
}

function rig(opts: { engineCeilingMs?: number; budgetMs?: number } = {}): Rig {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: opts.engineCeilingMs ?? AUDIO_DEFAULTS.hard_limit_ms,
  });
  if (opts.budgetMs !== undefined) session.setQuotaBudgetMs(opts.budgetMs);
  const rollovers: number[] = [];
  const stops: string[] = [];
  const armed: [number, HardLimitOrigin][] = [];
  session.on('engine_session_expired', () => {
    rollovers.push(clock.now - T0);
    armed.push([clock.now - T0, session.limitOrigin]);
  });
  session.on('auto_stopped', (reason: string) => stops.push(reason));
  session.start();
  armed.unshift([0, session.limitOrigin]);
  return { clock, session, rollovers, stops, armed };
}

describe('fix-025 ① — which ceiling applied, and what the origin says about it', () => {
  it('no budget declared ⇒ the engine ceiling rolls over, and it says `engine_session`', async () => {
    // The N1-B4 behaviour, unchanged. It is asserted here as the baseline the
    // other cases are read against, not because this card touched it.
    const r = rig();
    await r.clock.advance(900_000);

    expect(r.rollovers).toEqual([300_000, 600_000, 900_000]);
    expect(r.stops).toEqual([]);
    expect(r.session.state).toBe('recording');
    expect(r.session.limitOrigin).toBe('engine_session');
  });

  it('🔴 a budget LARGER than the engine ceiling survives every rollover and STOPS the recording', async () => {
    // THE CASE THE CLAMP DROPPED, and the one every free account is in. 20 minutes
    // of budget against a 5-minute engine ceiling: the leg recycles three times
    // (the user never finds out) and the fourth ceiling is the budget, which ends
    // the recording. Under `clampHardLimitMs` the budget was discarded here —
    // `1_200_000 < 300_000` is false — so nothing would ever have stopped.
    const r = rig({ budgetMs: 1_200_000 });
    await r.clock.advance(1_200_000);

    expect(r.rollovers).toEqual([300_000, 600_000, 900_000]);
    expect(r.stops).toEqual(['hard_limit']);
    expect(r.session.state).toBe('auto_stopped');
    expect(r.session.limitOrigin).toBe('quota_budget');
  });

  it('🔴 the origin follows the ceiling that is ARMED, moment by moment', async () => {
    // `limitOrigin` is not a property of the session, it is a property of the
    // moment: for the first 15 minutes the engine ceiling is nearer, and only the
    // last leg is governed by the budget. A field stamped once at audio:start
    // cannot express that — which is why the old one was always wrong for exactly
    // the accounts that had budget left.
    const r = rig({ budgetMs: 1_200_000 });
    await r.clock.advance(1_200_000);

    expect(r.armed).toEqual([
      [0, 'engine_session'],
      [300_000, 'engine_session'],
      [600_000, 'engine_session'],
      // At 900 s the next engine deadline is 1,200 s and so is the budget: from
      // here on the budget is the one being enforced, and it says so BEFORE it
      // fires rather than after.
      [900_000, 'quota_budget'],
    ]);
  });

  it('a budget SMALLER than the engine ceiling stops before any rollover', async () => {
    const r = rig({ budgetMs: 120_000 });
    await r.clock.advance(300_000);

    expect(r.rollovers).toEqual([]);
    expect(r.stops).toEqual(['hard_limit']);
    expect(r.session.limitOrigin).toBe('quota_budget');
  });

  it('🔴 a TIE goes to the budget — the failure directions are not symmetric', async () => {
    // Rolling a user who is out of minutes into a fresh engine session bills them
    // past their budget with nothing reporting it; stopping a user who has exactly
    // reached their ceiling is the ceiling working. Same instant, opposite prices.
    const r = rig({ engineCeilingMs: 1_000, budgetMs: 1_000 });
    await r.clock.advance(1_000);

    expect(r.rollovers).toEqual([]);
    expect(r.session.state).toBe('auto_stopped');
    expect(r.session.limitOrigin).toBe('quota_budget');
  });

  it('positive control: `Infinity` means there is NO quota ceiling (standalone / unmetered)', async () => {
    // Without this, every assertion above could pass because the wall was simply
    // always on — which would break standalone, where `remainingSttMs` is Infinity
    // by design and no recording may ever be stopped for money.
    const r = rig({ budgetMs: Number.POSITIVE_INFINITY });
    await r.clock.advance(900_000);

    expect(r.stops).toEqual([]);
    expect(r.session.state).toBe('recording');
    expect(r.session.limitOrigin).toBe('engine_session');
  });

  it('the second enforcement point agrees with the timer (a chunk cannot outvote it)', async () => {
    // `pushChunk` is the other place the ceiling is noticed. It used to compare
    // `now - startedAt` against the single number, and `startedAt` is re-anchored
    // by every rollover — so it could not have seen a budget deadline at all.
    const clock = new FakeClock(T0);
    const session = new AudioSession({
      now: clock.nowFn,
      // No timer at all: whatever stops this session was noticed by the push path.
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
      hardLimitMs: 300_000,
    });
    session.setQuotaBudgetMs(120_000);
    session.start();
    clock.now = T0 + 120_000;
    session.pushChunk({ seq: 0, ts_ms: 0, payload: Buffer.alloc(4) });

    expect(session.state).toBe('auto_stopped');
    expect(session.limitOrigin).toBe('quota_budget');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 2 — 🔴 THE QUOTA BOUNDARY. The assertion that would have caught this.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('fix-025 ③ — a spent budget', () => {
  it('🔴 budget exhausted ⇒ the session STOPS, and the origin says `quota_budget`', async () => {
    const r = rig({ budgetMs: 0 });
    await r.clock.advance(0);

    expect(r.session.state).toBe('auto_stopped');
    expect(r.session.limitOrigin).toBe('quota_budget');
    expect(r.stops).toEqual(['hard_limit']);
  });

  it('🔴 …and it does not SPIN, which is what a 0 ms ceiling did before', async () => {
    // Established before anything near it was changed: a 0 reaching the old
    // constructor survived `opts.hardLimitMs ?? AUDIO_DEFAULTS.hard_limit_ms` (0 is
    // not nullish), armed `setTimeout(…, 0)`, fired immediately, and — origin stuck
    // at `engine_session` — RE-ARMED AT 0. An unbounded rollover loop, emitting
    // `engine_session_expired` every tick, ending nothing and reporting nothing.
    // Meanwhile `clampHardLimitMs` refused 0 outright (`ms > 0`), so the two entry
    // points disagreed about what a spent budget meant — one said 「spin」 and the
    // other said 「no ceiling at all」.
    const r = rig({ budgetMs: 0 });
    await r.clock.advance(600_000);

    expect(r.rollovers).toEqual([]);
    expect(r.stops).toEqual(['hard_limit']); // exactly one, not one per tick
  });

  it('🔴 0 is not `Infinity`: the two neighbouring values mean opposite things', async () => {
    // The mapping the old `ms > 0` guard had: 「out of minutes」 and 「unlimited」
    // landed on the same branch. Asserted as a contrast pair so the day someone
    // re-adds a falsy-check, exactly one of these goes red.
    const spent = rig({ budgetMs: 0 });
    const unmetered = rig({ budgetMs: Number.POSITIVE_INFINITY });
    await spent.clock.advance(600_000);
    await unmetered.clock.advance(600_000);

    expect(spent.session.state).toBe('auto_stopped');
    expect(unmetered.session.state).toBe('recording');
  });

  it('a NaN budget throws instead of reading as 「no ceiling」', () => {
    const clock = new FakeClock(T0);
    const s = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    expect(() => s.setQuotaBudgetMs(Number.NaN)).toThrow(TypeError);
  });

  it('declaring a budget after start() is illegal (the ceiling is not retunable mid-run)', () => {
    const clock = new FakeClock(T0);
    const s = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    s.start();
    expect(() => s.setQuotaBudgetMs(1_000)).toThrow(/illegal call from recording/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 3 — 🔴 A PRODUCTION-SHAPED RUN: real DB → real BillingService → real QuotaGuard
 *     → real makeSttSessionFactory → real bridge → the frame the phone reads.
 *
 * The joint claim `fix-020` could not make: it pinned the origin → reason table
 * with the origin injected by hand, and said in as many words that the origin it
 * mapped could never arrive in production. This is that link, closed.
 * ═════════════════════════════════════════════════════════════════════════════ */

const USER = 'u1';
const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'zh' };
const noopUsage: UsageTracker = { recordSttUsage() {}, recordLlmUsage() {}, recordQuotaRefusal() {} };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
  received(event: string): Record<string, unknown>[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload as Record<string, unknown>);
  }
}

function freshDb(): DbConnection {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('quota-limit-origin-secret') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
  // This file states its own routing rather than borrowing whatever the seeder
  // happens to seed (the precedent is stt-polish-audio-start.test.ts's llm.config):
  // a green or red here must not have its reason living in another file. The
  // endpoint is a closed loopback port — the ENGINE leg is the one part of this run
  // that is not production-shaped, and a dead engine makes the claim stronger, not
  // weaker: the ceiling is the SESSION's, and it fires with no engine at all.
  db.settings.write(USER, 'stt.routings', [
    { language: '*', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '' },
  ]);
  return db;
}

function wire(db: DbConnection): { mobile: FakeSocket; remainingSttMs: () => number } {
  const billing = new BillingService({
    settings: db.settings, users: db.users, usage: db.usage, billing: db.billing,
    unlockAll: false, now: () => NOW,
  });
  // The guard wired exactly as bootstrap wires it, over a real saas config.
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u) }, {
    mode: 'saas', now: () => NOW,
  });
  const store = new RoomStore<FakeSocket>();
  const mobile = new FakeSocket('mobile-sock');
  const factory = makeSttSessionFactory({
    settings: db.settings, mode: 'saas', store: store as unknown as RoomStore<Socket>, quota: guard,
  });
  const deps: AudioHandlerDeps = {
    io: {} as unknown as import('socket.io').Server,
    guard,
    usageTracker: noopUsage,
    store: store as unknown as RoomStore<Socket>,
    sttFactory: (args: SttStartArgs) => factory(mobile as unknown as Socket, args),
  };
  registerAudioHandlers(mobile as unknown as Socket, deps);
  return { mobile, remainingSttMs: () => guard.remainingSttMs(USER) };
}

describe('fix-025 — `audio:auto-stopped{reason:quota_exhausted}` in a production-shaped run', () => {
  it('🔴 the ceiling a FRESH FREE ACCOUNT gets, with the number: 1,200,000 ms', () => {
    const { remainingSttMs } = wire(freshDb());
    // 20 STT minutes (owner 2026-08-02) ⇒ 1,200,000 ms of budget…
    expect(planLimits('free').stt_minutes).toBe(20);
    expect(remainingSttMs()).toBe(1_200_000);
    // …and that number is NOT the engine-session ceiling, which is 300,000 ms and
    // belongs to AUDIO_DEFAULTS. Before this card the first replaced the second
    // and kept the second's label, so a fresh free account's engine session was
    // twenty minutes long and it ROLLED OVER — i.e. nothing stopped at all.
    expect(AUDIO_DEFAULTS.hard_limit_ms).toBe(300_000);
    expect(remainingSttMs()).not.toBe(AUDIO_DEFAULTS.hard_limit_ms);
  });

  it('🔴 an account with 0.001 minutes left is ADMITTED and then stopped, saying `quota_exhausted`', async () => {
    const db = freshDb();
    // A fractional row is the normal shape, not a contrived one: recordSttUsage
    // writes `duration_ms / 60_000` and `usage_records.stt_minutes` is REAL.
    // 19.999 of 20 minutes ⇒ ~60 ms of budget, which is a real clock this test can
    // wait out — the branch reads the ORIGIN, never the size of the number.
    db.usage.increment(USER, currentMonth(() => NOW), { stt_minutes: 19.999 });
    const { mobile, remainingSttMs } = wire(db);
    expect(remainingSttMs()).toBeCloseTo(60, 3);

    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    // The admission gate let them in — they still had budget. This is why the
    // ceiling has to exist at all: `ensureQuota` is asked once, at the start.
    expect(ack).toEqual({ ok: true });

    await sleep(300);
    expect(mobile.received('audio:auto-stopped')).toEqual([{ reason: 'quota_exhausted' }]);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('🔴 positive control: the SAME harness with a full budget does not stop', async () => {
    // Without this, the assertion above proves 「a session auto-stops」 rather than
    // 「it auto-stopped because the minutes ran out」.
    const { mobile } = wire(freshDb());
    mobile.fire('audio:start', START, () => {});
    await sleep(300);

    expect(mobile.received('audio:auto-stopped')).toEqual([]);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('a fully spent account never reaches the factory: it is refused at audio:start', async () => {
    // Why `remainingSttMs() === 0` is not a live production state on this path:
    // `remainingSttMs` returns 0 exactly when `used >= limit`, which is what
    // `ensureQuota` throws on, and the handler asks it BEFORE building the factory.
    // So the 0 case above is a landmine removed, not a behaviour changed — and it
    // was worth removing because the mine and its safety catch live in different
    // files.
    const db = freshDb();
    db.usage.increment(USER, currentMonth(() => NOW), { stt_minutes: 20 });
    const { mobile, remainingSttMs } = wire(db);
    expect(remainingSttMs()).toBe(0);

    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    expect(ack?.error).toBe('QUOTA_EXCEEDED');
    await sleep(50);
    expect(mobile.received('audio:auto-stopped')).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 4 — THE CENSUS. Counted over SOURCE, because that is the only thing that could
 *     have caught the original defect: `clampHardLimitMs` had zero production
 *     callers and every functional test in the repo was green.
 * ═════════════════════════════════════════════════════════════════════════════ */

const SRC = fileURLToPath(new URL('../src', import.meta.url));
// `new URL('.', …)` keeps a trailing separator; dropping it here rather than
// compensating in the slice below, because a path that is sometimes terminated
// and sometimes not is how the first run of this file reported
// `utostop-reason.test.ts`.
const TEST = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, '');
const SELF = 'quota-limit-origin.test.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : abs.endsWith('.ts') ? [abs] : [];
  });
}

/** Strip whole-line comments so the PROSE mentions of a seam (this repo comments
 *  heavily and half those comments name it) cannot be counted as uses. */
function code(file: string): string {
  return readFileSync(file, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
}

function callSites(root: string, fn: string): string[] {
  return walk(root)
    .filter((f) => !f.endsWith(SELF))
    .filter((f) => new RegExp(`\\.${fn}\\s*\\(`).test(code(f)))
    .map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
}

describe('fix-025 ② — the census that keeps the retired name retired', () => {
  it('🔴 `clampHardLimitMs` has ZERO production callers', () => {
    // The claim the old code could have been checked against at any point. It was
    // true then too — that was the defect.
    expect(callSites(SRC, 'clampHardLimitMs')).toEqual([]);
  });

  it('🔴 …and exactly three test callers, which is why the alias still exists', () => {
    // When this list empties, DELETE `AudioSession.clampHardLimitMs` — a name that
    // describes an operation the class no longer performs is a façade waiting for
    // a reader. When it GROWS, the new caller is asking for a clamp that no longer
    // exists and should be calling `setQuotaBudgetMs`.
    expect(callSites(TEST, 'clampHardLimitMs').sort()).toEqual([
      'autostop-reason.test.ts',
      'stt-engine-session-rollover.test.ts',
      'stt-segment-settlement.test.ts',
    ]);
  });

  it('🔴 no production file writes a per-account engine-session ceiling', () => {
    // The trap that produced this card, closed from the only side this window
    // owned: `SttSessionDeps.hardLimitMs` used to land on the ENGINE ceiling,
    // so a producer here was a billing number in an engineering field again.
    //
    // ✅ The follow-up window that owns `engine/stt-session*.ts` removed the
    // field itself (it had zero producers left after this card): neither
    // `stt-session-deps.ts` nor `stt-session.ts` mentions `hardLimitMs` any
    // more, so `AudioSession` is always built with its own default. The two
    // remaining occurrences are `stt/audio/session.ts` (the ENGINEERING
    // constant's own option) and `stt/orchestrator-types.ts` (an unrelated,
    // separately-owned `OrchestratorOptions` field) — neither is a per-account
    // producer.
    const users = walk(SRC)
      .filter((f) => /hardLimitMs/.test(code(f)))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
      .sort();
    expect(users).toEqual([
      'stt/audio/session.ts',
      'stt/orchestrator-types.ts',
    ]);
  });

  it('the census can actually fail (it is not matching nothing)', () => {
    expect(callSites(TEST, 'clampHardLimitMs').length).toBeGreaterThan(0);
    // The replacement's own census: ONE production caller (the factory), plus the
    // retired alias delegating to it inside the class. Both are intended and both
    // are named, so 「where does a session's budget come from」 has exactly one
    // answer and one deprecated door onto it.
    expect(callSites(SRC, 'setQuotaBudgetMs').sort()).toEqual([
      'engine/stt-factory.ts',
      'stt/audio/session.ts',
    ]);
    expect(callSites(SRC, 'thisSeamDoesNotExist')).toEqual([]);
  });
});
