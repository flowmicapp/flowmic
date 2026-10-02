// NR-138 ③ — the phone's LEGACY segment leg now sends the recovery identity, so an automatic job of one retained
// segment is metered once, the way RC-R made the journal leg's jobs metered once.
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, NR-138 correction (2026-10-01) ③ (the legacy fields)
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.9 (RC-R) and its NR-138 note
//   apps/mobile/lib/src/session/legacy_recovery_identity.dart (the phone's derivation; this file copies it)
//   apps/server-core/test/recovery-attempt-bills-once.test.ts (the journal leg's rows; same rig)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// NO RELAY CODE CHANGED. The registry and `meterOnce` already did the right thing for a frame that names an
// operation; the legacy leg simply never named one, so `meterOnce` ran the effect directly on every attempt (the
// first row below pins that exposure as a control). The rows drive the PRODUCTION handler over a real database and
// assert on the PERSISTED minutes and `usage_effects` claims, never on a call count.
//
// 🔴 ONE VECTOR, PINNED ON BOTH SIDES. `LEGACY_VECTOR` is the id the phone derives for
// `run-1757000000000000__seg-0`, 6400 bytes, source language `en`, no preferences. The Dart test
// `apps/mobile/test/legacy_backfill_identity_test.dart` asserts the SAME two strings on the frame that leaves the
// phone, so a drift in either derivation turns one of the two files red instead of silently re-billing.
//
// REVERSE CONTROL (run 2026-10-01): `operation_id` dropped from `legacyFrame` ⇒ 4 of 6 red — the five-attempt row
// ended in `QUOTA_EXCEEDED` after four full five-minute debits, the equal-length row billed 0.01 min instead of
// 0.00667, the O-4 row 0.0133 instead of 0.01, the cross-kind row was admitted; restored ⇒ 6/6 green.

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

const USER = 'u-nr138';
const NOW = Date.parse('2026-10-01T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const CHARS = { transcript: 0, delivered: 0 } as const; // a stalled engine: no words came back
const AUDIO_START = { sample_rate: 16000, channels: 1, encoding: 'pcm_s16le', mode: 'realtime', source_lang: 'en' };

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The phone's `legacySegmentIdentity` (legacy_recovery_identity.dart), restated: recording id
 *  `<session>__seg-<n>`, range `[0, bytes / 2)`, variant `realtime|<lang>|<prefs digest>` ('' for no prefs). */
function legacyIds(session: string, seg: number, bytes: number, lang = 'en'): {
  recording: string; end: number; job: string; autoOp: string;
} {
  const recording = `${session}__seg-${seg}`;
  const end = bytes / 2;
  const job = sha(`v1|${recording}|0|${end}|realtime|${lang}|`).slice(0, 32);
  return { recording, end, job, autoOp: `o-${sha(`op-v1|${job}|auto_retry|0`).slice(0, 32)}` };
}

const LEGACY_VECTOR = { job: '505fb29f0fe8ac041f775a3af57d3638', op: 'o-a8f5706cb76a5d7de03311241d1e929c' } as const;

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  constructor(readonly id: string) {}
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(event: string, payload?: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

let db: DbConnection;
beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr-138-legacy-bills-once-32-bytes') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'free' });
});
afterEach(() => { db.close(); });

type Start = Record<string, unknown>;

/** One socket, the production audio handler, registry and ledger. Each `attempt` is one `audio:start` that runs to
 *  a settled session with [billedMs] handed to the metering seam — what a stalled engine still settles. */
function relay(): { attempt(frame: Start, billedMs: number): unknown } {
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
    attempt(frame, billedMs): unknown {
      seam = null;
      let ack: unknown;
      socket.fire('audio:start', { ...AUDIO_START, delivery: 'none', ...frame }, (r) => { ack = r; });
      if (seam !== null) (seam as (d: number, b: boolean, c: typeof CHARS) => void)(billedMs, false, CHARS);
      return ack;
    },
  };
}

/** The frame the phone's legacy leg sends after NR-138 (`beginBackfill(identity, legacySegment: true)`). */
function legacyFrame(session: string, seg: number, bytes: number, kind: 'auto_retry' | 'user_retranscribe', op?: string): Start {
  const ids = legacyIds(session, seg, bytes);
  return {
    recording_id: ids.recording, job_id: ids.job, attempt_id: `a-${Math.random()}`,
    operation_id: op ?? ids.autoOp, attempt_kind: kind,
    range_start_sample: 0, range_end_sample: ids.end, audio_format_version: 1,
  };
}

const minutes = (): number => db.usage.get(USER, MONTH)?.stt_minutes ?? 0;
const claims = (): number => (db.raw.prepare(`SELECT COUNT(*) AS n FROM usage_effects WHERE user_id='${USER}' AND kind='stt'`).get() as { n: number }).n;
const FIVE_MIN = 5 * 60_000;

describe('NR-138 — a legacy retained segment is billed once per automatic job', () => {
  it('the shared vector: this restatement of the phone derivation yields the strings the Dart test pins', () => {
    const ids = legacyIds('run-1757000000000000', 0, 6400);
    expect(ids.job).toBe(LEGACY_VECTOR.job);
    expect(ids.autoOp).toBe(LEGACY_VECTOR.op);
  });

  it('control — the frame the legacy leg sent BEFORE NR-138 (no identity) is billed on every attempt', () => {
    const r = relay();
    r.attempt({}, FIVE_MIN);
    r.attempt({}, FIVE_MIN);
    expect(minutes(), 'the exposure this card closes: two stalled replays, two full debits').toBeCloseTo(10, 6);
    expect(claims()).toBe(0);
  });

  it('🔴 five automatic attempts at one stalled five-minute segment move the account once', () => {
    const r = relay();
    for (let i = 0; i < 5; i++) {
      expect(r.attempt(legacyFrame('run-1757000000000000', 0, FIVE_MIN * 32, 'auto_retry'), FIVE_MIN)).toMatchObject({ ok: true });
    }
    expect(minutes(), 'persisted minutes moved once').toBeCloseTo(5, 6);
    expect(claims()).toBe(1);
    expect(db.recoveryOps.get(USER, legacyIds('run-1757000000000000', 0, FIVE_MIN * 32).autoOp)?.resend_count).toBe(4);
  });

  it('two segments of one session with the SAME length are two jobs and each bills once', () => {
    const r = relay();
    r.attempt(legacyFrame('run-1757000000000000', 0, 6400, 'auto_retry'), 200);
    r.attempt(legacyFrame('run-1757000000000000', 1, 6400, 'auto_retry'), 200);
    r.attempt(legacyFrame('run-1757000000000000', 1, 6400, 'auto_retry'), 200);
    expect(minutes(), 'per-segment recording ids keep equal ranges apart').toBeCloseTo(400 / 60_000, 6);
    expect(claims()).toBe(2);
  });

  it('ruling O-4 — two re-transcribe presses are two operations and bill twice; the automatic job beside them once', () => {
    const r = relay();
    r.attempt(legacyFrame('run-1', 0, 6400, 'auto_retry'), 200);
    r.attempt(legacyFrame('run-1', 0, 6400, 'auto_retry'), 200);
    expect(r.attempt(legacyFrame('run-1', 0, 6400, 'user_retranscribe', 'o-press-1'), 200)).toMatchObject({ ok: true });
    expect(r.attempt(legacyFrame('run-1', 0, 6400, 'user_retranscribe', 'o-press-2'), 200)).toMatchObject({ ok: true });
    expect(minutes()).toBeCloseTo(600 / 60_000, 6);
    expect(claims()).toBe(3);
  });

  // NR-138 round 2 (review B3) pinned here what 「billed once」 was worth on the real pruners: the claim survived to
  // day 6 and was gone at day 8, and the same job was billed again (400/60,000). ⚠️ Retired in round 3 (review B5,
  // MAIN decision, book 22 §4.11): the relay keeps the claim for 90 days (round 5), so that residual is now the
  // defect it was standing in for, up to a clock rollback of 84 days. Its replacement lives with the relay change, on branch
  // `lane/nr138-nocharge`: `test/recovery-claim-retention.test.ts` replays the review's two captured phone frames with
  // the relay's own daily sweeps fired at day 8 and asserts ONE debit.

  it('one id reused across kinds is refused as a changed binding and bills nothing', () => {
    const r = relay();
    const auto = legacyIds('run-1', 0, 6400).autoOp;
    r.attempt(legacyFrame('run-1', 0, 6400, 'auto_retry'), 200);
    expect(r.attempt(legacyFrame('run-1', 0, 6400, 'user_retranscribe', auto), 200))
      .toMatchObject({ error: 'AUDIO_OP_BINDING_CONFLICT' });
    expect(minutes()).toBeCloseTo(200 / 60_000, 6);
    expect(claims()).toBe(1);
  });
});
