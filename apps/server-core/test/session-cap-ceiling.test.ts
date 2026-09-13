// 🔴 Card G-8 — THE PER-SITTING LENGTH CEILING IS A FACT ON THE RELAY, not only
// a clock in the phone.
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4 (gap G-8)
//   owner 2026-08-29 long-recording rulings (free 10 min per sitting, pro/max 30)
//   ../src/billing/session-cap.ts (why it is NOT a smaller budget)
//   ../src/stt/audio/session.ts `setSessionCapMs` / `nextCeiling`
//   ../src/engine/stt-session-autostop.ts (`session_cap` → `hard_limit`, argued)
//
// ── WHAT WAS MEASURED BEFORE THE CHANGE ────────────────────────────────────
//   · `continuous_minutes` appeared in `apps/server-core/src` in exactly three
//     places, all of them READ-OUTS: the plan table that defines it
//     (`billing/plans.ts`), `/api/cloud/summary` (`http/console-routes.ts`) and
//     standalone's `/api/limits` (`http/router.ts`). None of them was on the
//     recording path; nothing under `socket/` or `engine/` mentioned it at all.
//   · The only enforcer was `apps/mobile/lib/src/audio/continuous_cap_timer.dart`,
//     and `local_stop_reasons.dart` wrote the threat model down in as many
//     words: 「a modified client can ignore the ceiling, and what it burns is its
//     own monthly quota, which the server does enforce」.
//   · Card MP-10 (「far end pays」) made that last clause false. What an unbounded
//     session burns is now the ROOM OWNER's month, and the owner is not the
//     person running the modified client.
//
// ⚠️ WHAT THIS FILE CANNOT PROVE. Section 1 runs on a fake clock and section 3
// on an in-memory database with a dead engine; a real recording against a real
// vendor on a real account is the device line's. The relay-process end of this
// chain — a real server, real sockets, a real wall-clock minute — is golden G32.

import { afterEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { AUDIO_DEFAULTS, type Plan } from '@flowmic/protocol';
import { AudioSession, type HardLimitOrigin } from '../src/stt/audio/session';
import { autoStopReasonFor } from '../src/engine/stt-session-autostop';
import { FakeClock, T0 } from './fixtures/stt-outage-harness';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { RoomStore } from '../src/room/store';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard, type QuotaGuard } from '../src/billing/quota-guard';
import {
  PLAN_LIMITS, installPlanLimits, planLimits, resetPlanLimits, type PlanLimits,
} from '../src/billing/plans';
import { continuousCapMsFrom } from '../src/billing/session-cap';
import { makeSttSessionFactory } from '../src/engine/stt-factory';
import { registerAudioHandlers, type AudioHandlerDeps, type SttStartArgs } from '../src/socket/handlers/audio.handler';
import type { UsageTracker } from '../src/billing/usage-tracker';

/* ══════════════════════════════════════════════════════════════════════════════
 * 1 — THE ARITHMETIC. Three ceilings, one timer, and which one is armed.
 * ═════════════════════════════════════════════════════════════════════════════ */

interface Rig {
  clock: FakeClock;
  session: AudioSession;
  rollovers: number[];
  stops: string[];
}

function rig(opts: {
  engineCeilingMs?: number; budgetMs?: number; capMs?: number;
  /** Installed BEFORE start(), the one moment the session accepts it — same
   *  rule and same seam as the two ceilings above (card CR-Q). */
  refresher?: () => number;
} = {}): Rig {
  const clock = new FakeClock(T0);
  const session = new AudioSession({
    now: clock.nowFn,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    hardLimitMs: opts.engineCeilingMs ?? AUDIO_DEFAULTS.hard_limit_ms,
  });
  if (opts.budgetMs !== undefined) session.setQuotaBudgetMs(opts.budgetMs);
  if (opts.capMs !== undefined) session.setSessionCapMs(opts.capMs);
  if (opts.refresher !== undefined) session.setQuotaRefresher(opts.refresher, { floorMs: 60_000 });
  const rollovers: number[] = [];
  const stops: string[] = [];
  session.on('engine_session_expired', () => rollovers.push(clock.now - T0));
  session.on('auto_stopped', (reason: string) => stops.push(reason));
  session.start();
  return { clock, session, rollovers, stops };
}

describe('G-8 ① — min(budget deadline, cap deadline), and the origin that names the winner', () => {
  it('🔴 CAP BINDING: a rich month and a 10-minute sitting ⇒ stopped at 10 minutes, origin `session_cap`', async () => {
    // The shape the card exists for. A free account that has bought nothing
    // still has 20 minutes of month; its sitting ceiling is 10. Before this card
    // the relay armed only the budget, so the deadline sat at 20:00 and a client
    // that ignored its own clock got twice what it was sold — and under 「far end
    // pays」 the account it came out of was somebody else's.
    const r = rig({ budgetMs: 1_200_000, capMs: 600_000 });
    await r.clock.advance(600_000);

    expect(r.session.state).toBe('auto_stopped');
    expect(r.session.limitOrigin).toBe('session_cap');
    expect(r.stops).toEqual(['hard_limit']);
    // …and the engine ceiling rolled over underneath it exactly as before: the
    // sitting ran through 300 s without the user noticing (N1-B4).
    expect(r.rollovers).toEqual([300_000]);
  });

  it('🔴 BUDGET BINDING: a poor month and a 30-minute sitting ⇒ stopped at the money, origin `quota_budget`', async () => {
    const r = rig({ budgetMs: 400_000, capMs: 1_800_000 });
    await r.clock.advance(1_800_000);

    expect(r.session.limitOrigin).toBe('quota_budget');
    expect(r.stops).toEqual(['hard_limit']);
  });

  it('🔴 BOTH: neither ceiling is 「the」 ceiling — the nearer one wins', async () => {
    // Asserted as a contrast pair from ONE rig shape, because the defect this
    // guards against is a ceiling picked once at audio:start. Same session
    // length, the two numbers swapped, two different origins.
    const capWins = rig({ budgetMs: 900_000, capMs: 600_000 });
    const budgetWins = rig({ budgetMs: 600_000, capMs: 900_000 });
    await capWins.clock.advance(900_000);
    await budgetWins.clock.advance(900_000);

    expect(capWins.session.limitOrigin).toBe('session_cap');
    expect(budgetWins.session.limitOrigin).toBe('quota_budget');
  });

  it('a TIE goes to the budget — the fact that changes what the user should do next', () => {
    // Both are true at that instant. 「Press again」 (the cap's sentence) would
    // send the user straight into a QUOTA_EXCEEDED refusal at the admission
    // gate; 「your month is gone」 is the one that survives the next press.
    // The engine ceiling is pushed out of the way (30 minutes) so this asserts
    // the quota-vs-cap tie and nothing else — with the 5-minute default it is
    // the ENGINE deadline that is nearest at t=0, which is a true fact about a
    // different pair of ceilings. Measured: the first draft of this assertion
    // read `engine_session` and would have been "fixed" by relaxing it.
    const r = rig({ engineCeilingMs: 1_800_000, budgetMs: 600_000, capMs: 600_000 });
    expect(r.session.limitOrigin).toBe('quota_budget');
  });

  it('🔴 the cap SURVIVES ENGINE ROLLOVERS — it is anchored on start(), never on the leg', async () => {
    // The failure mode fix-025 recorded for the quota ceiling, re-run for this
    // one: the engine ceiling re-anchors itself at every rollover, so a cap that
    // shared that anchor would be pushed past every moment it was due and would
    // never fire at all. Twelve minutes of sitting over a five-minute engine
    // ceiling ⇒ two rollovers, then the wall.
    const r = rig({ engineCeilingMs: 300_000, capMs: 720_000 });
    await r.clock.advance(720_000);

    expect(r.rollovers).toEqual([300_000, 600_000]);
    expect(r.session.limitOrigin).toBe('session_cap');
    expect(r.stops).toEqual(['hard_limit']);
  });

  it('🔴 a TIE with the ENGINE ceiling goes to the CAP — otherwise the cap is unreachable, not merely mislabelled', async () => {
    // The engine ceiling does not end anything (N1-B4): it re-anchors and
    // re-arms. Handing it a tie would restart the only clock there is and push
    // the cap one full leg into the future, forever.
    const r = rig({ engineCeilingMs: 300_000, capMs: 300_000 });
    await r.clock.advance(300_000);

    expect(r.rollovers).toEqual([]);
    expect(r.session.limitOrigin).toBe('session_cap');
    expect(r.stops).toEqual(['hard_limit']);
  });

  it('🔴 the CR-Q mid-recording budget re-read cannot erase the cap', async () => {
    // Reason ③ on `setSessionCapMs`, as a measurement. The refresher OVERWRITES
    // `quotaBudgetMs` with a fresh monthly read; a cap folded into that number
    // would exist for exactly one refresh floor and then quietly not. Here the
    // month gets RICHER mid-sitting and the sitting still ends on time.
    const r = rig({ budgetMs: 700_000, capMs: 600_000, refresher: () => 3_600_000 });
    // Drive the refresher the way production does — from the leg born at the
    // 300 s rollover (orchestrator-core's `spawnEngine` tail).
    r.session.on('engine_session_expired', () => r.session.refreshQuotaBudget());
    await r.clock.advance(600_000);

    expect(r.session.limitOrigin).toBe('session_cap');
    expect(r.stops).toEqual(['hard_limit']);
  });

  it('no cap declared ⇒ byte-identical to the behaviour this card found (the baseline)', async () => {
    const r = rig({ budgetMs: 1_200_000 });
    await r.clock.advance(1_200_000);

    expect(r.session.limitOrigin).toBe('quota_budget');
    expect(r.stops).toEqual(['hard_limit']);
  });

  it('`Infinity` means 「no length ceiling」 and `0` means a ceiling of zero — the two neighbouring values are opposite', async () => {
    const unbounded = rig({ capMs: Number.POSITIVE_INFINITY });
    const zero = rig({ capMs: 0 });
    await unbounded.clock.advance(600_000);
    await zero.clock.advance(600_000);

    expect(unbounded.session.state).toBe('recording');
    expect(zero.session.state).toBe('auto_stopped');
    expect(zero.stops).toEqual(['hard_limit']); // exactly one — it does not spin
  });

  it('a NaN cap throws instead of reading as 「no ceiling」', () => {
    const clock = new FakeClock(T0);
    const s = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    expect(() => s.setSessionCapMs(Number.NaN)).toThrow(TypeError);
  });

  it('declaring a cap after start() is illegal (the sitting length is not retunable mid-run)', () => {
    const clock = new FakeClock(T0);
    const s = new AudioSession({ now: clock.nowFn, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    s.start();
    expect(() => s.setSessionCapMs(1_000)).toThrow(/illegal call from recording/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 2 — WHAT THE USER IS TOLD, and why it is not the quota sentence.
 * ═════════════════════════════════════════════════════════════════════════════ */

describe('G-8 ② — the origin → reason table', () => {
  it('🔴 `session_cap` is NOT `quota_exhausted` — the two sentences lead somewhere opposite', () => {
    const cap: HardLimitOrigin = 'session_cap';
    const money: HardLimitOrigin = 'quota_budget';
    expect(autoStopReasonFor(cap)).toBe('hard_limit');
    expect(autoStopReasonFor(money)).toBe('quota_exhausted');
    // The phone's selector (`recording_strings.dart`) keys on these wire values:
    // `hard_limit` → 「press once and keep talking」, which is true of a ceiling
    // that resets with the next sitting; `quota_exhausted` → 「this month's
    // minutes are gone」, which would send a user with hours left away to wait.
  });

  it('an origin this layer cannot name still emits nothing rather than borrowing a sentence', () => {
    expect(autoStopReasonFor('session-cap')).toBeNull();
    expect(autoStopReasonFor('toString')).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 3 — THE NUMBER, AND A PRODUCTION-SHAPED RUN: real DB → real BillingService →
 *     real QuotaGuard → real makeSttSessionFactory → the frame the phone reads.
 * ═════════════════════════════════════════════════════════════════════════════ */

const USER = 'u1';
const NOW = Date.parse('2026-09-11T00:00:00.000Z');
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
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('session-cap-secret') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
  // Same choice, and the same reason, as `quota-limit-origin.test.ts`: a closed
  // loopback port. The engine leg is the one part of this run that is not
  // production-shaped, and a dead engine makes the claim STRONGER — the ceiling
  // is the SESSION's, and it fires with no engine at all.
  db.settings.write(USER, 'stt.routings', [
    { language: '*', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:1/v1', api_key: '' },
  ]);
  return db;
}

function guardFor(db: DbConnection, mode: 'saas' | 'standalone'): QuotaGuard {
  const billing = new BillingService({
    settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false, now: () => NOW,
  });
  return makeQuotaGuard(
    db.usage,
    { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: (u, at) => billing.usagePeriodKey(u, at) },
    { mode, now: () => NOW },
  );
}

function wire(db: DbConnection): FakeSocket {
  const guard = guardFor(db, 'saas');
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
  return mobile;
}

/** A table an EMBEDDER could hand to `installPlanLimits` (its doc names that
 *  caller explicitly). Sub-minute cells on purpose: `FLOWMIC_PLAN_LIMITS` only
 *  accepts integer minutes, and a test that waited a real minute to prove an
 *  arithmetic section 1 already proves on a fake clock would buy nothing. The
 *  real-minute version of this run is golden G32. */
function tableWithFreeCap(minutes: number): Readonly<Record<Plan, Readonly<PlanLimits>>> {
  return {
    ...PLAN_LIMITS,
    free: { ...PLAN_LIMITS.free, continuous_minutes: minutes },
  };
}

afterEach(() => { resetPlanLimits(); });

describe('G-8 ③ — the number comes off the single solver, and the relay arms it', () => {
  it('🔴 the ceiling a FREE account gets, with the number: 600,000 ms (owner 2026-08-29)', () => {
    expect(planLimits('free').continuous_minutes).toBe(10);
    expect(planLimits('pro').continuous_minutes).toBe(30);
    expect(planLimits('max').continuous_minutes).toBe(30);
    expect(guardFor(freshDb(), 'saas').continuousCapMs(USER)).toBe(600_000);
  });

  it('🔴 STANDALONE gets no ceiling from this layer — card A8 is still open', () => {
    // `http/router.ts`'s `/api/limits` still answers a number there so the
    // phone's own clock has something to arm; what standalone does NOT get is a
    // relay-imposed wall on a machine with no commercial boundary. Asserted as a
    // pair so a future 「unify the modes」 turns exactly one of them red.
    expect(guardFor(freshDb(), 'standalone').continuousCapMs(USER)).toBe(Number.POSITIVE_INFINITY);
    expect(guardFor(freshDb(), 'saas').continuousCapMs(USER)).toBe(600_000);
  });

  it('the EXEMPT account reads its exemption, not its tier name', () => {
    // The defect this file's header quotes from `quota-guard.ts`: owner's own
    // account resolves to `plan:'free'` because he bought nothing, so a reader
    // that re-derived the number from the tier would cap him at 10 minutes.
    const db = freshDb();
    db.users.setPermanentFree(USER, true);
    expect(guardFor(db, 'saas').continuousCapMs(USER)).toBe(planLimits('max').continuous_minutes * 60_000);
  });

  it('a malformed cell OPENS the ceiling rather than closing it (and the budget still stands behind it)', () => {
    // The direction argued in `billing/session-cap.ts`: `0` read as a ceiling
    // would end every recording on the deployment instantly, from one mistyped
    // character. `Infinity` loses a ceiling that has a second one behind it.
    expect(continuousCapMsFrom({ continuous_minutes: 0 })).toBe(Number.POSITIVE_INFINITY);
    expect(continuousCapMsFrom({ continuous_minutes: Number.NaN })).toBe(Number.POSITIVE_INFINITY);
    expect(continuousCapMsFrom({ continuous_minutes: 10 })).toBe(600_000);
  });

  it('🔴 A RICH MONTH AND A SHORT SITTING: the relay ends it, and says `hard_limit`', async () => {
    // THE CARD, end to end through the real audio handler. 20 minutes of month,
    // untouched (`ensureQuota` admits, `remainingSttMs` is 1,200,000 ms), and a
    // sitting ceiling of 300 ms. Before this card nothing on this side of the
    // wire read `continuous_minutes` at all and this run never ended.
    installPlanLimits(tableWithFreeCap(0.005));
    const db = freshDb();
    const mobile = wire(db);
    expect(guardFor(db, 'saas').remainingSttMs(USER)).toBe(1_200_000);

    let ack: Record<string, unknown> | undefined;
    mobile.fire('audio:start', START, (r) => { ack = r as Record<string, unknown>; });
    expect(ack).toEqual({ ok: true });

    await sleep(400);
    expect(mobile.received('audio:auto-stopped')).toEqual([{ reason: 'hard_limit' }]);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('🔴 positive control: the SAME harness with the shipped 10-minute cap does not stop', async () => {
    // Without this, the assertion above proves 「a session auto-stops」 rather
    // than 「it auto-stopped because the SITTING ceiling was short」.
    const mobile = wire(freshDb());
    mobile.fire('audio:start', START, () => {});
    await sleep(400);

    expect(mobile.received('audio:auto-stopped')).toEqual([]);
    mobile.fire('audio:stop', {}, () => {});
  });

  it('🔴 the phone-owned LIGHT RECORD path gets the same cap — it is the PAYER that is read', async () => {
    // 「A phone recording with no far end」 is the cloud-instance admission
    // (`registry.admitCloudInstance`), which mints a virtual `pc_devices` row
    // OWNED BY THE SPEAKER'S OWN ACCOUNT — so the payer is `'self'` and
    // `auth.userId` on this socket IS the speaker (`auth/metering-principal.ts`
    // states it in those words). There is no second branch to test, and that is
    // the point: the same `audio:start`, the same payer id, the same wall.
    installPlanLimits(tableWithFreeCap(0.005));
    const db = freshDb();
    const mobile = wire(db);
    // No PC in the room at all — the shape a light record actually runs in.
    mobile.data.roomUuid = undefined;

    mobile.fire('audio:start', { ...START, delivery: 'none' }, () => {});
    await sleep(400);

    expect(mobile.received('audio:auto-stopped')).toEqual([{ reason: 'hard_limit' }]);
    mobile.fire('audio:stop', {}, () => {});
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
 * 4 — REVERSE CONTROL, as run.
 *
 * 🔴 MEASURED, NOT DESCRIBED. With the `capAt` term removed from the `min` in
 * `AudioSession.nextCeiling` — i.e. the quota branch back to
 * `quotaAt <= engineAt` alone and the `session_cap` branch deleted — the run was
 * 8 failed / 12 passed, verbatim:
 *
 *   CAP BINDING .................. expected 'auto_stopped' → got 'recording'
 *   BOTH ......................... expected 'session_cap'  → got 'quota_budget'
 *   survives engine rollovers .... expected 'session_cap'  → got 'engine_session'
 *   tie with the ENGINE ceiling .. expected []             → got [300000]
 *   CR-Q cannot erase the cap .... expected 'session_cap'  → got 'engine_session'
 *   Infinity vs 0 ................ expected 'auto_stopped' → got 'recording'
 *   ③ rich month, short sitting .. expected [{reason:'hard_limit'}] → got []
 *   ③ light record ............... expected [{reason:'hard_limit'}] → got []
 *
 * 🔴 READ THE FIRST AND THE LAST TWO TOGETHER: without the term the session
 * simply KEEPS RECORDING — it does not stop late and it does not stop with the
 * wrong sentence, it does not stop. That is the pre-card production behaviour,
 * and it is what makes this a wall rather than a label.
 *
 * ⚠️ The 12 that stayed GREEN are the control: the budget ceiling, the engine
 * rollover, the origin→reason table and the `continuousCapMsFrom` arithmetic are
 * all untouched by the cap term, and a reverse control that turned everything
 * red would only have proved the file runs.
 *
 * Restored from a byte copy and re-run: 20 passed. The break was a direct edit
 * with NO marker string inserted anywhere, so the tree's count of the usual
 * reverse-control token is untouched by this card — and this comment says so
 * without spelling that token, because writing it here would have moved the
 * very number the claim is about.
 * ═════════════════════════════════════════════════════════════════════════════ */
