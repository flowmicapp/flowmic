// SPEC-REF:
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.3 (the per-browser 120 s and the site-wide anonymous
//     ceiling count every session's §4.9 basis, free re-sends included) · §4.11 (claim) · §4.12 (coverage)
//   apps/server-core/src/billing/usage-tracker.ts `recordSttUsage` (the cap counter)
//   apps/server-core/src/http/web-anon-routes.ts gate ⑥ (`msUsedToday` against ANON_DAILY_MINUTES)
//   *** billing ***
//
// Audit 2026-10-11 (Soniox minutes vs our meter), exposures 1 and 2: a session the claim (NR-138) or the recording
// coverage (NR-224) makes free still holds a Soniox stream open, but the site-demo visitor's cap counter moved only by
// what was CHARGED. So a visitor with any allowance left could re-send one paid operation five times, or catch up a
// paid live press, and spend vendor time that neither the per-browser 120 s nor the site-wide daily ceiling ever saw.
//
// Every press below goes through the PRODUCTION audio handler, the PRODUCTION tracker, claim ledger, coverage store,
// quota guard and trial ledger, on one real database. Only the engine is a stub whose settle seam is handed what a
// real bridge hands it (the §4.9 basis and the audio the pipeline took).

import { afterEach, describe, expect, it } from 'vitest';
import type { Socket } from 'socket.io';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { BillingService } from '../src/billing/billing-service';
import { makeQuotaGuard, type QuotaGuard } from '../src/billing/quota-guard';
import { makeUsageTracker } from '../src/billing/usage-tracker';
import { makeTrialLedger, TRIAL_LIFETIME_GRANT_MS } from '../src/billing/trial-ledger';
import { cappedRemainingSttMs } from '../src/billing/capped-remaining';
import { currentMonth } from '../src/db/repos/usage.repo';
import { SAMPLES_PER_MS } from '../src/db/repos/recording-coverage.repo';
import { RoomStore } from '../src/room/store';
import { registerAudioHandlers } from '../src/socket/handlers/audio.handler';
import { utcDay } from '../src/site/sanitize';

const DEMO = 'u-demo-payer';
const ANON = 'u-anon-visitor';
const NOW = Date.parse('2026-10-11T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const CHARS = { transcript: 0, delivered: 0 } as const;
const KEY = deriveKey('trial-cap-counts-free-resends-32b');
const S = (ms: number): number => ms * SAMPLES_PER_MS;

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string };
  constructor(auth: Record<string, unknown>) { this.data = { auth }; }
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

const dbs: DbConnection[] = [];
afterEach(() => { while (dbs.length > 0) { try { dbs.pop()!.close(); } catch { /* closed */ } } });

type Settle = (d: number, b: boolean, c: typeof CHARS, f?: unknown, r?: { uniqueMs: number }) => void;
interface Rig {
  db: DbConnection;
  guard: QuotaGuard;
  /** One `audio:start` settled with [ms] as both the basis and the audio taken. Returns the ack and whether an engine
   *  was built (a refused start builds none). */
  press(f: Record<string, unknown>, ms: number): { ack: unknown; ran: boolean };
  msUsedToday(): number;
}

/** A site-demo room: the bill lands on the demo account, the visitor's trial row rides along as the cap
 *  (`resolvePayer` branch 4, auth/metering-principal.ts). [withCap] false = the same presses by a payer with no cap. */
function demoRig(withCap = true): Rig {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: KEY });
  dbs.push(db);
  db.users.insert({ id: DEMO, display_name: 'Demo', plan: 'pro' });
  db.users.insert({ id: ANON, display_name: 'Visitor', plan: 'free', anonymous: true });
  db.trials.insert({
    anon_user_id: ANON, ip_bucket: 'b-1', day: utcDay(NOW), grants_used: 1, ms_granted: TRIAL_LIFETIME_GRANT_MS,
    anon_token: 'tok', token_expires_at: NOW + 3_600_000, created_at: new Date(NOW).toISOString(), device_uid: 'wb-1',
  });
  const trials = makeTrialLedger({ rows: db.trials, users: db.users });
  const billing = new BillingService({
    settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: true, now: () => NOW, trials,
  });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: 'saas', now: () => NOW });
  const usageTracker = makeUsageTracker(db.usage, { mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: db.usageEffects });
  const socket = new FakeSocket({ kind: 'mobile', userId: DEMO, ...(withCap ? { capUserId: ANON } : {}) });
  let seam: Settle | null = null;
  registerAudioHandlers(socket as unknown as Socket, {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker, recoveryOps: db.recoveryOps,
    store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
    sttFactory: (args) => { seam = args.onComplete as Settle; return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} }; },
    now: () => NOW,
  });
  return {
    db, guard,
    press(f, ms) {
      seam = null;
      let ack: unknown;
      socket.fire('audio:start', f, (r) => { ack = r; });
      const ran = seam !== null;
      if (seam !== null) (seam as Settle)(ms, false, CHARS, undefined, { uniqueMs: ms });
      return { ack, ran };
    },
    msUsedToday: () => trials.msUsedToday(NOW),
  };
}

const BASE = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'en', audio_format_version: 1 };
let seq = 0;
const live = (rec: string): Record<string, unknown> => ({
  ...BASE, recording_id: rec, attempt_id: `a-live-${++seq}`, attempt_kind: 'live', range_start_sample: 0, delivery: 'none',
});
/** A recovery frame; re-sending it with the same [op] and range is a re-send of one operation (new attempt id). */
const recovery = (rec: string, op: string, range: [number, number]): Record<string, unknown> => ({
  ...BASE, recording_id: rec, job_id: `job-${rec}`, attempt_id: `a-${++seq}`, operation_id: op,
  attempt_kind: 'auto_retry', range_start_sample: range[0], range_end_sample: range[1], delivery: 'none',
});

const msOf = (db: DbConnection, user: string): number => Math.round((db.usage.get(user, MONTH)?.stt_minutes ?? 0) * 60_000);

describe('a free re-send still spends the site-demo visitor\'s allowance', () => {
  it('claim re-sends: the 120 s cap and the site-wide ceiling count every session, the demo bill counts one', () => {
    const r = demoRig();
    // The NAME of the allowance, and the number the start gate actually enforces, asserted separately (D-21).
    expect(TRIAL_LIFETIME_GRANT_MS).toBe(120_000);
    expect(Math.round(cappedRemainingSttMs(r.guard, DEMO, ANON))).toBe(120_000);

    const op = recovery('rec-1', 'op-1', [0, S(30_000)]);
    expect(r.press(op, 30_000).ran).toBe(true); // paid first metering
    for (let i = 0; i < 3; i++) {
      // Three re-sends of the same operation: free for the bill by the claim (§4.11), but each held a vendor stream.
      expect(r.press({ ...op, attempt_id: `a-resend-${i}` }, 30_000).ran).toBe(true);
    }
    // The bill: one operation, charged once — unchanged by this rule.
    expect(msOf(r.db, DEMO)).toBe(30_000);
    // The cap and the site-wide anonymous ceiling: four sessions of 30 s.
    expect.soft(msOf(r.db, ANON)).toBe(120_000);
    expect.soft(r.msUsedToday()).toBe(120_000);
    // The effective number: nothing left, and the next re-send is refused at the door (no engine built).
    expect(Math.round(cappedRemainingSttMs(r.guard, DEMO, ANON))).toBe(0);
    const refused = r.press({ ...op, attempt_id: 'a-resend-last' }, 30_000);
    expect(refused.ran).toBe(false);
    expect(JSON.stringify(refused.ack)).toContain('QUOTA_EXCEEDED');
  });

  it('coverage credit: a catch-up of a paid live press is free for the bill and still spends the cap', () => {
    const r = demoRig();
    expect(r.press(live('rec-2'), 40_000).ran).toBe(true);
    expect(r.press(recovery('rec-2', 'op-2', [0, S(40_000)]), 40_000).ran).toBe(true); // NR-224 credit: charged 0
    expect(msOf(r.db, DEMO)).toBe(40_000);
    expect.soft(msOf(r.db, ANON)).toBe(80_000);
    expect.soft(r.msUsedToday()).toBe(80_000);
    expect(Math.round(cappedRemainingSttMs(r.guard, DEMO, ANON))).toBe(40_000);
  });

  it('control: with no cap identity the same re-sends stay free and nothing else is counted', () => {
    const r = demoRig(false);
    const op = recovery('rec-3', 'op-3', [0, S(30_000)]);
    r.press(op, 30_000);
    for (let i = 0; i < 3; i++) r.press({ ...op, attempt_id: `a-c-${i}` }, 30_000);
    expect(msOf(r.db, DEMO)).toBe(30_000);
    expect(msOf(r.db, ANON)).toBe(0);
    expect(r.msUsedToday()).toBe(0);
  });
});
