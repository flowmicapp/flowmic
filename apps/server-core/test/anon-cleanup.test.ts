// Card M4-01 — the anonymous-row sweep, on a real sqlite file and the real repos.
//
// SPEC-REF:
//   src/db/anon-cleanup.ts (why it is a dry run unless an env var is set)
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.4 / §7.1 F-1
//
// 🔴 THIS IS THE FIRST AUTOMATIC TASK IN THIS SERVER THAT DELETES A `users` ROW,
// so the two cases that matter are 「the dry run deletes NOTHING」 and 「the armed
// run deletes ONLY expired anonymous rows」. Everything else here is scaffolding
// around those two.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection';
import { makeUserRepo, type UserRepo } from '../src/db/repos/user.repo';
import { makeTrialLedgerRepo, type TrialLedgerRepo } from '../src/db/repos/trial-ledger.repo';
import { makeTrialLedger, type TrialLedger } from '../src/billing/trial-ledger';
import {
  runAnonCleanup, startAnonCleanupSweeper, anonCleanupApplyFromEnv, ANON_ROW_RETENTION_MS,
} from '../src/db/anon-cleanup';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

let dir: string;
let db: DatabaseSync;
let users: UserRepo;
let rows: TrialLedgerRepo;
let ledger: TrialLedger;
let n = 0;

/** Mint a demo identity `ageMs` ago. */
function demo(ageMs: number): string {
  n += 1;
  return ledger.claim({
    deviceUid: `wb-${n}`,
    ipBucket: 'bucket', nowMs: NOW - ageMs, tokenTtlMs: HOUR,
    newId: () => `anon-${n}`, newToken: () => `fm_${n}`,
  }).userId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowmic-anon-cleanup-'));
  db = openDatabase(join(dir, 'cleanup.sqlite'));
  users = makeUserRepo(db);
  rows = makeTrialLedgerRepo(db);
  ledger = makeTrialLedger({ rows, users });
  n = 0;
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the switch', () => {
  it('is OFF when the env var is unset or empty', () => {
    expect(anonCleanupApplyFromEnv({})).toBe(false);
    expect(anonCleanupApplyFromEnv({ FLOWMIC_WEB_ANON_CLEANUP_APPLY: '' })).toBe(false);
    expect(anonCleanupApplyFromEnv({ FLOWMIC_WEB_ANON_CLEANUP_APPLY: '   ' })).toBe(false);
  });

  it('is ON for any non-empty value', () => {
    expect(anonCleanupApplyFromEnv({ FLOWMIC_WEB_ANON_CLEANUP_APPLY: '1' })).toBe(true);
    expect(anonCleanupApplyFromEnv({ FLOWMIC_WEB_ANON_CLEANUP_APPLY: 'yes' })).toBe(true);
  });
});

describe('a dry run', () => {
  it('🔴 deletes NOTHING, and still reports what it would have deleted', () => {
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    const report = runAnonCleanup({ trials: rows, users, apply: false }, NOW);
    expect(report.apply).toBe(false);
    expect(report.candidates).toBe(1);
    // The two halves are separate assertions on purpose: a sweep that reported
    // its intentions as deletions would pass a test that only checked one.
    expect(report.deleted).toBe(0);
    expect(users.findById(old)).not.toBeNull();
    expect(rows.findByUser(old)).not.toBeNull();
  });

  it('leaves the row for the armed run that follows it', () => {
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    runAnonCleanup({ trials: rows, users, apply: false }, NOW);
    const armed = runAnonCleanup({ trials: rows, users, apply: true }, NOW);
    expect(armed.deleted).toBe(1);
    expect(users.findById(old)).toBeNull();
  });
});

describe('an armed run', () => {
  it('🔴 deletes ONLY the expired anonymous rows', () => {
    const expired = demo(ANON_ROW_RETENTION_MS + HOUR);
    const fresh = demo(HOUR);
    const person = users.insert({ id: 'real-1', email: 'a@flowmic.test' }).id;
    // A real account old enough to be swept if the `anonymous` predicate were
    // dropped — which is the reverse control this case is built around.
    db.prepare('UPDATE users SET created_at=? WHERE id=?')
      .run(new Date(NOW - 10 * ANON_ROW_RETENTION_MS).toISOString(), person);

    const report = runAnonCleanup({ trials: rows, users, apply: true }, NOW);
    expect(report.deleted).toBe(1);
    expect(users.findById(expired)).toBeNull();
    expect(users.findById(fresh)).not.toBeNull();
    expect(users.findById(person)).not.toBeNull();
  });

  it('takes the ledger row with it, through the foreign key and not by hand', () => {
    const expired = demo(ANON_ROW_RETENTION_MS + HOUR);
    runAnonCleanup({ trials: rows, users, apply: true }, NOW);
    expect(rows.findByUser(expired)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM trial_ledger').get()).toEqual({ n: 0 });
  });

  it('takes the demo room with it too, so no orphan device row is left behind', () => {
    const expired = demo(ANON_ROW_RETENTION_MS + HOUR);
    db.prepare(
      `INSERT INTO pc_devices (id, user_id, device_name, device_token, room_uuid, short_code, created_at, room_kind)
       VALUES (?,?,?,?,?,?,?,'web')`,
    ).run('pc-1', expired, 'FlowMic Web', 'tok', 'room-uuid-1', '1234', new Date(NOW).toISOString());
    runAnonCleanup({ trials: rows, users, apply: true }, NOW);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pc_devices').get()).toEqual({ n: 0 });
  });

  it('is bounded per pass, and the leftovers survive to the next one', () => {
    for (let i = 0; i < 5; i += 1) demo(ANON_ROW_RETENTION_MS + HOUR);
    const first = runAnonCleanup({ trials: rows, users, apply: true, batch: 2 }, NOW);
    expect(first.deleted).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get()).toEqual({ n: 3 });
    const second = runAnonCleanup({ trials: rows, users, apply: true, batch: 2 }, NOW);
    expect(second.deleted).toBe(2);
  });

  it('deletes nothing at all when nothing has aged out', () => {
    demo(HOUR);
    demo(ANON_ROW_RETENTION_MS - HOUR);
    const report = runAnonCleanup({ trials: rows, users, apply: true }, NOW);
    expect(report.candidates).toBe(0);
    expect(report.deleted).toBe(0);
  });
});

describe('the timer', () => {
  it('arms one interval, runs on tick, and stops', () => {
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    let armed: (() => void) | null = null;
    let cleared = 0;
    const sweeper = startAnonCleanupSweeper({
      trials: rows, users, apply: true,
      nowMs: () => NOW,
      setIntervalFn: (fn) => { armed = fn; return 'handle'; },
      clearIntervalFn: () => { cleared += 1; },
    });
    expect(armed).not.toBeNull();
    // Nothing at arming time — the first pass lands on the first tick, the same
    // as every other sweep in this server.
    expect(users.findById(old)).not.toBeNull();
    (armed as unknown as () => void)();
    expect(users.findById(old)).toBeNull();
    sweeper.stop();
    expect(cleared).toBe(1);
  });

  it('exposes runOnce, so an operator and a test share one seam', () => {
    demo(ANON_ROW_RETENTION_MS + HOUR);
    const sweeper = startAnonCleanupSweeper({
      trials: rows, users, apply: false, nowMs: () => NOW,
      setIntervalFn: () => 'handle', clearIntervalFn: () => {},
    });
    expect(sweeper.runOnce().candidates).toBe(1);
    expect(sweeper.runOnce().deleted).toBe(0);
    sweeper.stop();
  });
});
