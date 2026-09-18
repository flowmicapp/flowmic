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
import { makeTrialArchiveRepo, type TrialArchiveRepo } from '../src/db/repos/trial-archive.repo';
import { makeUsageArchiveRepo, type UsageArchiveRepo } from '../src/db/repos/usage-archive.repo';
import { makeTransactionRunner, type TransactionRunner } from '../src/db/tx';
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
let trialArchive: TrialArchiveRepo;
let usageArchive: UsageArchiveRepo;
let tx: TransactionRunner;
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
  trialArchive = makeTrialArchiveRepo(db);
  usageArchive = makeUsageArchiveRepo(db);
  tx = makeTransactionRunner(db);
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
    const report = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: false }, NOW);
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
    runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: false }, NOW);
    const armed = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
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

    const report = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
    expect(report.deleted).toBe(1);
    expect(users.findById(expired)).toBeNull();
    expect(users.findById(fresh)).not.toBeNull();
    expect(users.findById(person)).not.toBeNull();
  });

  it('takes the ledger row with it, through the foreign key and not by hand', () => {
    const expired = demo(ANON_ROW_RETENTION_MS + HOUR);
    runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
    expect(rows.findByUser(expired)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM trial_ledger').get()).toEqual({ n: 0 });
  });

  it('takes the demo room with it too, so no orphan device row is left behind', () => {
    const expired = demo(ANON_ROW_RETENTION_MS + HOUR);
    db.prepare(
      `INSERT INTO pc_devices (id, user_id, device_name, device_token, room_uuid, short_code, created_at, room_kind)
       VALUES (?,?,?,?,?,?,?,'web')`,
    ).run('pc-1', expired, 'FlowMic Web', 'tok', 'room-uuid-1', '1234', new Date(NOW).toISOString());
    runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pc_devices').get()).toEqual({ n: 0 });
  });

  it('is bounded per pass, and the leftovers survive to the next one', () => {
    for (let i = 0; i < 5; i += 1) demo(ANON_ROW_RETENTION_MS + HOUR);
    const first = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true, batch: 2 }, NOW);
    expect(first.deleted).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get()).toEqual({ n: 3 });
    const second = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true, batch: 2 }, NOW);
    expect(second.deleted).toBe(2);
  });

  it('deletes nothing at all when nothing has aged out', () => {
    demo(HOUR);
    demo(ANON_ROW_RETENTION_MS - HOUR);
    const report = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
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
      trials: rows, users, trialArchive, usageArchive, tx, apply: true,
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
      trials: rows, users, trialArchive, usageArchive, tx, apply: false, nowMs: () => NOW,
      setIntervalFn: () => 'handle', clearIntervalFn: () => {},
    });
    expect(sweeper.runOnce().candidates).toBe(1);
    expect(sweeper.runOnce().deleted).toBe(0);
    sweeper.stop();
  });
});

// ── owner 2026-09-17: the sweep archives every row before it destroys it ────
// docs/decisions/2026-09-17-owner-enables-anon-trial-cleanup-with-archive.md
//
// 🔴 THE TWO DIRECTIONS ARE BOTH HERE, and they are not the same test: 「what
// was deleted got recorded」 and 「what could not be recorded did not get
// deleted」. A sweep can pass the first and fail the second, and the second is
// the one owner's condition actually depends on.
describe('the archive', () => {
  /** Every column of a live ledger row, as sqlite holds it. Read through SQL
   *  rather than through `TrialLedgerRow` on purpose: the claim under test is
   *  「the archive row IS the row that was deleted」, and a comparison that went
   *  through `toRow()` on both sides would be a comparison of that function. */
  const liveRow = (id: string): Record<string, unknown> =>
    db.prepare('SELECT * FROM trial_ledger WHERE anon_user_id=?').get(id) as Record<string, unknown>;
  const archiveRows = (): Record<string, unknown>[] =>
    db.prepare('SELECT * FROM trial_ledger_archive ORDER BY rowid').all() as Record<string, unknown>[];

  it('🔴 copies the row field for field, and stamps when it was swept', () => {
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    const before = liveRow(old);

    const report = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
    expect(report.deleted).toBe(1);
    expect(report.archived).toBe(1);

    const [kept] = archiveRows();
    const { swept_at: sweptAt, ...columns } = kept as Record<string, unknown>;
    expect(columns).toEqual(before);
    // The sweep's own clock, not a second one three layers down.
    expect(sweptAt).toBe(new Date(NOW).toISOString());
  });

  it('archives exactly as many rows as it deletes, batch after batch', () => {
    for (let i = 0; i < 5; i += 1) demo(ANON_ROW_RETENTION_MS + HOUR);
    const first = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true, batch: 2 }, NOW);
    expect([first.archived, first.deleted]).toEqual([2, 2]);
    expect(archiveRows()).toHaveLength(2);
    const second = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true, batch: 2 }, NOW);
    expect([second.archived, second.deleted]).toEqual([2, 2]);
    // The ledger lost exactly what the archive gained — asserted on the two
    // TABLES rather than on the report, which is the thing being checked.
    expect(archiveRows()).toHaveLength(4);
    expect(db.prepare('SELECT COUNT(*) AS n FROM trial_ledger').get()).toEqual({ n: 1 });
  });

  it('survives the users row going with it — no foreign key drags it back out', () => {
    // The archive is written INSIDE the transaction that deletes `users`, and a
    // `REFERENCES users(id) ON DELETE CASCADE` on the archive would erase it in
    // that same statement. This is the case that would catch that, and it would
    // catch it as 「the archive is always empty」 rather than as an error.
    demo(ANON_ROW_RETENTION_MS + HOUR);
    runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
    expect(archiveRows()).toHaveLength(1);
  });

  it('writes nothing on a dry run', () => {
    demo(ANON_ROW_RETENTION_MS + HOUR);
    const report = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: false }, NOW);
    expect(report.archived).toBe(0);
    expect(report.rolledBack).toBe(false);
    expect(archiveRows()).toEqual([]);
  });

  it('🔴 deletes NOTHING when the archive throws', () => {
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    const broken = {
      archiveByUser: (): number => { throw new Error('disk is full'); },
      count: () => trialArchive.count(),
    };
    const report = runAnonCleanup({ trials: rows, users, trialArchive: broken, usageArchive, tx, apply: true }, NOW);
    expect(report.rolledBack).toBe(true);
    expect(report.deleted).toBe(0);
    expect(report.archived).toBe(0);
    // The row is still there, which is the whole point: a retention promise
    // that cannot be recorded is postponed to the next tick, not kept anyway.
    expect(users.findById(old)).not.toBeNull();
    expect(rows.findByUser(old)).not.toBeNull();
    expect(archiveRows()).toEqual([]);
  });

  it('🔴 deletes NOTHING when the archive silently records nothing', () => {
    // The failure the count guard exists for, and the one a `try/catch` cannot
    // see: an archive that reports success and writes no row. This is what
    // removing the INSERT looks like from the sweep's side.
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    const silent = { archiveByUser: (): number => 0, count: () => trialArchive.count() };
    const report = runAnonCleanup({ trials: rows, users, trialArchive: silent, usageArchive, tx, apply: true }, NOW);
    expect(report.rolledBack).toBe(true);
    expect(report.deleted).toBe(0);
    expect(users.findById(old)).not.toBeNull();
    expect(archiveRows()).toEqual([]);
  });

  it('🔴 deletes NOTHING when the insert claims a row the table did not gain', () => {
    // The OTHER half of the guard: `changes` says 1, the table grew by 0. No
    // try/catch and no per-statement check can see this — only counting the
    // table itself can, which is why the guard counts it.
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    const lying = { archiveByUser: (): number => 1, count: (): number => 0 };
    const report = runAnonCleanup({ trials: rows, users, trialArchive: lying, usageArchive, tx, apply: true }, NOW);
    expect(report.rolledBack).toBe(true);
    expect(report.deleted).toBe(0);
    expect(users.findById(old)).not.toBeNull();
  });
});

// ── owner 2026-09-17, second half: it archives what the identity SPENT ──────
// The `usage_records` rows belonging to a swept identity are destroyed by the
// foreign key, not by this sweep — which is exactly why they had to be copied
// out inside its transaction. Without this the archive would record what every
// anonymous visitor was OFFERED and destroy what they actually USED.
describe('the meter archive', () => {
  /** A meter row for one identity and one month, written through SQL rather
   *  than through `UsageRepo`: the claim under test is 「the archive row IS the
   *  row that was deleted」, and routing both sides through one writer would
   *  make it a claim about that writer. */
  const meter = (
    userId: string, month: string, sttMinutes: number, tokensIn = 0, tokensOut = 0,
  ): void => {
    db.prepare(
      `INSERT INTO usage_records
         (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(userId, month, sttMinutes, tokensIn, tokensOut, new Date(NOW).toISOString());
  };
  const liveMeter = (id: string): Record<string, unknown>[] =>
    db.prepare('SELECT * FROM usage_records WHERE user_id=? ORDER BY month')
      .all(id) as Record<string, unknown>[];
  const archivedMeter = (): Record<string, unknown>[] =>
    db.prepare('SELECT * FROM usage_records_archive ORDER BY rowid')
      .all() as Record<string, unknown>[];

  it('🔴 copies the meter row field for field, and stamps the same sweep', () => {
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    meter(old, '2026-09', 1.75, 40, 60);
    const [before] = liveMeter(old);

    const report = runAnonCleanup(
      { trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW,
    );
    expect(report.deleted).toBe(1);
    expect(report.usageArchived).toBe(1);

    // The cascade really did destroy the original — otherwise 「we archived it」
    // would be true and pointless.
    expect(liveMeter(old)).toEqual([]);

    const [kept] = archivedMeter();
    const { swept_at: sweptAt, ...columns } = kept as Record<string, unknown>;
    expect(columns).toEqual(before);
    // One record in two tables: the same stamp as its ledger half, so the two
    // can be rejoined on (anon_user_id = user_id AND swept_at).
    expect(sweptAt).toBe(new Date(NOW).toISOString());
    const ledgerHalves = db.prepare('SELECT swept_at FROM trial_ledger_archive')
      .all() as { swept_at: string }[];
    expect(ledgerHalves.map((r) => r.swept_at)).toEqual([sweptAt]);
  });

  it('takes every month the identity has, not one row per identity', () => {
    // The whole reason the meter guard cannot reuse `deleted` as its third
    // number: (user_id, month) is the primary key, so one identity is one, two
    // or zero rows here.
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    meter(old, '2026-08', 0.5);
    meter(old, '2026-09', 2);
    const report = runAnonCleanup(
      { trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW,
    );
    expect(report.deleted).toBe(1);
    expect(report.usageArchived).toBe(2);
    expect(archivedMeter().map((r) => r.month)).toEqual(['2026-08', '2026-09']);
  });

  it('is fine with an identity that never spoke', () => {
    // 0 is ORDINARY, not a failure: a visitor who opened the page and said
    // nothing has a ledger row and no meter row at all. A guard that demanded
    // one row per identity would stop the sweep for the commonest case there is.
    demo(ANON_ROW_RETENTION_MS + HOUR);
    const report = runAnonCleanup(
      { trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW,
    );
    expect(report.deleted).toBe(1);
    expect(report.usageArchived).toBe(0);
    expect(report.rolledBack).toBe(false);
    expect(archivedMeter()).toEqual([]);
  });

  it('leaves a LIVE account meter alone', () => {
    // The positive control for the negative one: the copy is `WHERE user_id=?`,
    // so a non-anonymous account's meter must be neither archived nor touched.
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    meter(old, '2026-09', 1);
    const person = `person-${n += 1}`;
    db.prepare('INSERT INTO users (id, created_at, anonymous) VALUES (?,?,0)')
      .run(person, new Date(NOW - 10 * ANON_ROW_RETENTION_MS).toISOString());
    meter(person, '2026-09', 99);

    const report = runAnonCleanup(
      { trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW,
    );
    expect(report.usageArchived).toBe(1);
    expect(archivedMeter().map((r) => r.stt_minutes)).toEqual([1]);
    expect(liveMeter(person)).toHaveLength(1);
  });

  it('writes nothing on a dry run', () => {
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    meter(old, '2026-09', 1);
    const report = runAnonCleanup(
      { trials: rows, users, trialArchive, usageArchive, tx, apply: false }, NOW,
    );
    expect(report.usageArchived).toBe(0);
    expect(archivedMeter()).toEqual([]);
    expect(liveMeter(old)).toHaveLength(1);
  });

  it('🔴 deletes NOTHING when the meter archive throws', () => {
    // 🔴 THE DIRECTION THAT MATTERS. A sweep can archive the ledger, fail to
    // archive the meter, and still delete — and the result looks exactly like a
    // successful sweep, because the row is gone, which is what the sweep is for.
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    meter(old, '2026-09', 1);
    const broken = {
      archiveByUser: (): number => { throw new Error('disk is full'); },
      liveCountForUser: (id: string): number => usageArchive.liveCountForUser(id),
      count: (): number => usageArchive.count(),
    };
    const report = runAnonCleanup(
      { trials: rows, users, trialArchive, usageArchive: broken, tx, apply: true }, NOW,
    );
    expect(report.rolledBack).toBe(true);
    expect(report.deleted).toBe(0);
    expect(report.usageArchived).toBe(0);
    // Everything is still there — including the LEDGER archive row, which was
    // written before the meter copy threw. That is the transaction, not luck.
    expect(users.findById(old)).not.toBeNull();
    expect(liveMeter(old)).toHaveLength(1);
    expect(archivedMeter()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM trial_ledger_archive').get()).toEqual({ n: 0 });
  });

  it('🔴 deletes NOTHING when the meter archive silently records nothing', () => {
    // What removing the INSERT looks like from the sweep's side, and the reason
    // `liveCountForUser` exists: reported success, no row written, and no throw
    // anywhere for a try/catch to see.
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    meter(old, '2026-09', 1);
    const silent = {
      archiveByUser: (): number => 0,
      liveCountForUser: (id: string): number => usageArchive.liveCountForUser(id),
      count: (): number => usageArchive.count(),
    };
    const report = runAnonCleanup(
      { trials: rows, users, trialArchive, usageArchive: silent, tx, apply: true }, NOW,
    );
    expect(report.rolledBack).toBe(true);
    expect(report.deleted).toBe(0);
    expect(users.findById(old)).not.toBeNull();
    expect(liveMeter(old)).toHaveLength(1);
  });

  it('🔴 deletes NOTHING when the insert claims a row the table did not gain', () => {
    // The third witness: `changes` says 1, the source said 1, and the table grew
    // by 0. Only counting the table itself can see this.
    const old = demo(ANON_ROW_RETENTION_MS + HOUR);
    meter(old, '2026-09', 1);
    const lying = {
      archiveByUser: (): number => 1,
      liveCountForUser: (): number => 1,
      count: (): number => 0,
    };
    const report = runAnonCleanup(
      { trials: rows, users, trialArchive, usageArchive: lying, tx, apply: true }, NOW,
    );
    expect(report.rolledBack).toBe(true);
    expect(report.deleted).toBe(0);
    expect(users.findById(old)).not.toBeNull();
  });
});
