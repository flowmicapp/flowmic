// NR-137 round 3 (independent review B1) — ONE Re-transcribe press is ONE billed operation.
// *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3-a, the NR-137 round-3 correction
//   docs/rebuild/22-METERING-AND-BILLING-BASELINE.md §4.9 (O-4: a press is metered per press)
//   apps/server-core/src/db/repos/recovery-operations.repo.ts (`sameBinding`: one operation = one recording,
//     one job, one range — which is why the phone feeds a press as ONE start)
//
// The frame below is the one the phone ACTUALLY sent for one press on a legacy recording with two kept
// segments, captured by apps/mobile/test/nr137_review_regressions_test.dart (`NR137_CAPTURE=1`); that test
// also pins its live frame to this fixture's shape. Round 2 sent one start per segment, each with its own
// operation, and the review fed them to this same handler and ledger: two new claims for one press.
//
// Each row drives the PRODUCTION audio handler (admission, the operation registry, `commitSttUsage`) over the
// real usage tracker and SQLite ledger, and asserts on the PERSISTED claims and minutes. Recognition is the
// seam recovery-claim-retention.test.ts uses: each attempt settles with the basis the row names.

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

const USER = 'u-nr137-r3';
const NOW = Date.parse('2026-10-02T00:00:00.000Z');
const MONTH = currentMonth(() => NOW);
const CHARS = { transcript: 0, delivered: 0 } as const;

const pressed = JSON.parse(
  readFileSync(new URL('./fixtures/nr137-one-press-frames.json', import.meta.url), 'utf8'),
) as Record<string, unknown>[];

class FakeSocket {
  data: { auth?: unknown; roomUuid?: string } = { auth: { kind: 'mobile', userId: USER } };
  private readonly handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  on(event: string, cb: (payload: unknown, ack?: unknown) => void): this { this.handlers.set(event, cb); return this; }
  emit(): boolean { return true; }
  fire(event: string, payload: unknown, ack?: (r: unknown) => void): void { this.handlers.get(event)?.(payload, ack); }
}

let db: DbConnection;
beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('nr-137-r3-one-press-one-claim-32b') });
  db.users.insert({ id: USER, display_name: 'U', plan: 'pro' });
});
afterEach(() => { db.close(); });

const minutesMs = (): number => Math.round((db.usage.get(USER, MONTH)?.stt_minutes ?? 0) * 60_000);

function relay() {
  const billing = new BillingService({ settings: db.settings, users: db.users, usage: db.usage, billing: db.billing, unlockAll: true, now: () => NOW });
  const guard = makeQuotaGuard(db.usage, { effectiveLimits: (u) => billing.effectiveLimits(u), usagePeriodKey: () => MONTH }, { mode: 'saas', now: () => NOW });
  const usageTracker = makeUsageTracker(db.usage, { mode: 'saas', now: () => NOW, periodKeyFor: () => MONTH, operations: db.usageEffects });
  const socket = new FakeSocket();
  let seam: ((d: number, byok: boolean, chars: typeof CHARS) => void) | null = null;
  registerAudioHandlers(socket as unknown as Socket, {
    io: {} as unknown as import('socket.io').Server,
    guard, usageTracker, recoveryOps: db.recoveryOps,
    store: new RoomStore<Socket>() as unknown as RoomStore<Socket>,
    sttFactory: (args) => { seam = args.onComplete; return { pushChunk(): void {}, async finish(): Promise<void> {}, dispose(): void {} }; },
    now: () => NOW,
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

/** The two original automatic attempts the kept segments came from (one per segment file, as NR-138 sends). */
function originals(r: ReturnType<typeof relay>): void {
  const base = pressed[0]!;
  const key = String(base.recording_id).replace(/__kept$/, '');
  for (const i of [0, 1]) {
    expect(r.attempt({
      ...base, recording_id: `${key}__seg-${i}`, job_id: `job-seg-${i}`, attempt_id: `orig-a-${i}`,
      operation_id: `orig-op-${i}`, attempt_kind: 'auto_retry', range_end_sample: 3200,
    }, 200)).toMatchObject({ ok: true });
  }
}

describe('NR-137 round 3 — one press, one billed operation, on the real handler and ledger', () => {
  it('the captured press is ONE user_retranscribe start covering both segments', () => {
    expect(pressed).toHaveLength(1);
    const f = pressed[0]!;
    expect(f.attempt_kind).toBe('user_retranscribe');
    expect(f.delivery).toBe('none');
    expect(f.range_start_sample).toBe(0);
    expect(f.range_end_sample).toBe(6400);
  });

  it('one press adds exactly ONE claim, charged once, and borrows no original claim', () => {
    const r = relay();
    originals(r);
    expect(minutesMs()).toBe(400);
    const before = db.usageEffects.listByUser(USER);
    expect(before).toHaveLength(2);

    // EVERY start the press sent (the fixture is the whole press), each settled at the press's basis split
    // evenly, so the total debit is the same whatever the count — the CLAIM count is what tells them apart.
    for (const f of pressed) expect(r.attempt(f, 400 / pressed.length)).toMatchObject({ ok: true });

    const after = db.usageEffects.listByUser(USER);
    const manual = after.filter((c) => pressed.some((f) => f.operation_id === c.operation_id));
    expect(manual).toHaveLength(1);
    expect(after).toHaveLength(3);
    expect(minutesMs()).toBe(800);
    expect(after.filter((c) => String(c.operation_id).startsWith('orig-')).every((c) => c.replays === 0)).toBe(true);
  });

  it('control: a second press is a NEW operation and is charged again (O-4); a resend of the same press is not', () => {
    const r = relay();
    originals(r);
    expect(r.attempt(pressed[0]!, 400)).toMatchObject({ ok: true });
    expect(minutesMs()).toBe(800);
    // The same start resent (reconnect replay of one press): no second debit.
    expect(r.attempt({ ...pressed[0]!, attempt_id: 'resend-a' }, 400)).toMatchObject({ ok: true });
    expect(minutesMs()).toBe(800);
    // The next press mints a fresh operation: charged per press.
    expect(r.attempt({ ...pressed[0]!, attempt_id: 'press-2-a', operation_id: 'press-2-op' }, 400)).toMatchObject({ ok: true });
    expect(minutesMs()).toBe(1200);
    expect(db.usageEffects.listByUser(USER)).toHaveLength(4);
  });
});
