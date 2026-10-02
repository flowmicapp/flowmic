// NR-138 round 3, MAIN decision B5 — a recovery operation's metering claim outlives every re-send the phone can make.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.11 (the rule, the two numbers, the two pruning clocks)
//   _dispatch/2026-10-01-nr138-r2-review.md.out B5 (the counterexample this file replays) and F2 (the two clocks)
//
// THE REVIEW'S COUNTEREXAMPLE, REPLAYED. The two frames below are the ones the reviewer captured from the production
// phone controller: one stalled legacy segment started at 2026-10-01 00:00 UTC, then the phone reconnecting at relay
// time 2026-10-09 00:00 UTC with its own clock showing 2026-10-06 — eight real days, five phone days, the same job and
// the same `operation_id`, a new attempt id, `auto_retry`. Before this change the relay's daily sweep had removed the
// first claim by day 8 and the same segment was debited twice (200 → 400 of 60,000 ms).
//
// The relay side is production: `registerAudioHandlers` (admission, the operation registry, `commitSttUsage`), the
// usage tracker with its `usage_effects` claims on SQLite, and the relay's OWN daily sweeps — `startBackgroundSweeps`,
// every interval it arms, fired at the relay day under test. The recognition itself is a seam, as in the review:
// each attempt settles with the 200 ms a stalled engine still settles.
//
// REVERSE CONTROL (run 2026-10-01; restored byte-for-byte, then this file re-run green): the claim sweep put back
// into the daily recovery tick (`DELETE FROM usage_effects WHERE applied_at < now - 7 days`) ⇒ 2 of 4 red, both on
// the persisted ledger: the day-8 row at the review's own reading, 400 of 60,000 ms (`expected 0.006666666666666667
// to be close to 0.0033333333333333335`), the day-400 row at three debits (`expected 0.01 …`).
//
// ⚠️ Round 5 (MAIN decision, 2026-10-01; book 22 §4.11): the claim is kept 90 days, not for the account's life; the
// day-400 row is replaced by a day-91 row that is BILLED. Reverse controls, run 2026-10-01, each restored
// byte-for-byte and re-run 5/5 green:
//   · no claim sweep in the daily tick ⇒ the day-91 row red on the persisted ledger (`past the 90 days the same
//     segment is debited again: expected 0.0033333333333333335 to be close to 0.006666666666666667`);
//   · a 7-day claim retention ⇒ the day-8 row red on the persisted ledger (`the persisted ledger: one debit for one
//     segment: expected 0.006666666666666667 to be close to 0.0033333333333333335`), the day-91 row likewise at
//     day 8, and the policy pin (`expected 604800000 to be 7776000000`).

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
import { RECOVERY_CLAIM_RETENTION_MS } from '../src/db/schema-recovery';
import { USAGE_EVENTS_RETENTION_DAYS } from '../src/db/retention';

const USER = 'u-nr138-b5';
const DAY = 24 * 60 * 60 * 1000;
/** The review's clocks (`nr138-r2-review-skew-frames.json`): first start, and the re-send eight relay days later. */
const FIRST_RELAY_AT = 1_790_812_800_000; // 2026-10-01T00:00:00Z
const SECOND_RELAY_AT = FIRST_RELAY_AT + 8 * DAY; // the phone's own clock read FIRST_RELAY_AT + 5 days
const MONTH = currentMonth(() => FIRST_RELAY_AT);
const CHARS = { transcript: 0, delivered: 0 } as const;

/** The two frames, byte for byte as captured, except the user they are admitted for. */
const CAPTURED = [
  { attempt_id: 'a-hmsohh35lg-2' },
  { attempt_id: 'a-hmsohh4fg9-3' },
].map((a) => ({
  recording_id: 'run-clock-skew__seg-0',
  job_id: 'a2d9a51505c4d1bdbe91ab1e69d0ecfd',
  ...a,
  operation_id: 'o-4297ecfb7e9a5594d405d5cc42ee97a8',
  attempt_kind: 'auto_retry',
  range_start_sample: 0, range_end_sample: 3200, audio_format_version: 1,
  sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', send_policy: 'direct', delivery: 'none', source_lang: 'en',
}));
const OP = CAPTURED[0]!.operation_id;

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

let db: DbConnection;
let relayNow = FIRST_RELAY_AT;
beforeEach(() => {
  relayNow = FIRST_RELAY_AT;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr-138-b5-claim-retention-32bytes') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
});
afterEach(() => { db.close(); }); // the sweeps were scheduled on a capturing no-op: nothing stays armed

const minutes = (): number => db.usage.get(USER, MONTH)?.stt_minutes ?? 0;
const claims = (): number => (db.raw.prepare('SELECT COUNT(*) AS n FROM usage_effects WHERE user_id=? AND operation_id=?').get(USER, OP) as { n: number }).n;
const registered = (): number => (db.raw.prepare('SELECT COUNT(*) AS n FROM recovery_operations WHERE user_id=? AND operation_id=?').get(USER, OP) as { n: number }).n;

/** The production handler and ledger, and the relay's own daily sweeps on a clock the test moves. */
function relay() {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: false, now: () => relayNow });
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
  const ticks: (() => void)[] = [];
  const config = loadConfig({ mode: 'saas', secret: 'nr-138-b5-claim-retention-secret-32', port: 0, dbPath: ':memory:', trustedProxies: [] });
  startBackgroundSweeps({
    config, db, billing, nodeRole: 'single',
    now: () => relayNow,
    setIntervalFn: (fn) => { ticks.push(fn); return ticks.length; },
    clearIntervalFn: () => {},
  });
  return {
    attempt(frame: Record<string, unknown>): unknown {
      seam = null;
      let ack: unknown;
      socket.fire('audio:start', frame, (r) => { ack = r; });
      if (seam !== null) (seam as (d: number, b: boolean, c: typeof CHARS) => void)(200, false, CHARS);
      return ack;
    },
    /** Every daily sweep the relay armed, run once at relay time [at]. */
    async sweepAt(at: number): Promise<void> {
      relayNow = at;
      expect(ticks.length, 'positive control: the relay armed its daily sweeps').toBeGreaterThan(0);
      for (const t of ticks) t();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('NR-138 rounds 3–5 — the claim outlives every automatic re-send, for 90 days (book 22 §4.11)', () => {
  it('🔴 the review\'s captured frames: a re-send at relay day 8 (phone clock day 5) is debited once, not twice', async () => {
    const r = relay();
    expect(r.attempt(CAPTURED[0]!)).toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(200 / 60_000, 6);
    expect(claims()).toBe(1);

    // ⚠️ Round 4 (book 22 §4.11 「Recording identity」): the claimed operation's registry row is kept now, so the
    // positive control that the sweeps ran is an operation that was registered and never claimed.
    db.recoveryOps.admit(USER, 'o-never-claimed', { mode: 'realtime' }, FIRST_RELAY_AT);
    await r.sweepAt(SECOND_RELAY_AT);
    expect(db.recoveryOps.get(USER, 'o-never-claimed'), 'positive control: the sweeps DID run').toBeNull();

    expect(r.attempt(CAPTURED[1]!)).toMatchObject({ ok: true });
    expect(minutes(), 'the persisted ledger: one debit for one segment').toBeCloseTo(200 / 60_000, 6);
    expect(claims(), 'the metering claim (by applied_at, never refreshed) survived the sweep').toBe(1);
    expect(registered(), 'the claimed operation kept its binding').toBe(1);
  });

  // ⚠️ Round 5 (MAIN decision, 2026-10-01; book 22 §4.11): this row used to assert that a re-send at relay day 400
  // was still free (the claim kept for the life of the account). The claim is now kept 90 days — the privacy
  // policy's per-use window — so a re-send after that is billed again: the stated consequence, pinned.
  it('🔴 a re-send at relay day 91 finds neither claim nor registry row, and is billed again', async () => {
    const r = relay();
    r.attempt(CAPTURED[0]!);
    await r.sweepAt(SECOND_RELAY_AT);
    r.attempt(CAPTURED[1]!);
    expect(minutes(), 'day 8: still one debit').toBeCloseTo(200 / 60_000, 6);
    await r.sweepAt(FIRST_RELAY_AT + 91 * DAY);
    expect(r.attempt({ ...CAPTURED[1]!, attempt_id: 'a-day-91' })).toMatchObject({ ok: true });
    expect(minutes(), 'past the 90 days the same segment is debited again').toBeCloseTo(400 / 60_000, 6);
    expect(claims(), 'a fresh claim').toBe(1);
  });

  it('the 90 days are the privacy policy\'s per-use window (USAGE_EVENTS_RETENTION_DAYS)', () => {
    expect(RECOVERY_CLAIM_RETENTION_MS).toBe(USAGE_EVENTS_RETENTION_DAYS * DAY);
  });

  it('control — a different operation id is a new operation and is debited (a Re-transcribe press, O-4)', async () => {
    const r = relay();
    r.attempt(CAPTURED[0]!);
    await r.sweepAt(SECOND_RELAY_AT);
    r.attempt({ ...CAPTURED[1]!, operation_id: 'o-user-press-1', attempt_kind: 'user_retranscribe' });
    expect(minutes()).toBeCloseTo(400 / 60_000, 6);
  });

  it('control — the claim still goes with the account', () => {
    const r = relay();
    r.attempt(CAPTURED[0]!);
    expect(claims()).toBe(1);
    expect(db.users.remove(USER)).toBe(true);
    expect(claims()).toBe(0);
  });
});
