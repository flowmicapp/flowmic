// Card R-1 — WHICH COLUMN the trial identity is stored in, proved against a
// real sqlite file and the real 48-hour sweep.
//
// SPEC-REF:
//   src/db/schema.ts (mobile_pairings.trial_user_id, and the DDL argument)
//   src/db/connection.ts (the idempotent ALTER, and why it is hand-written)
//   src/db/anon-cleanup.ts (the sweep this file drives)
//   docs/strategy/2026-09-10-web-room-release-and-unsigned-limit-design.md §2.1
//     (「🔴 陷阱」 — the trap this file exists to keep shut)
//
// ── WHY A TEST AND NOT A COMMENT ───────────────────────────────────────────
// The design names the trap in one line: `mobile_pairings.user_id` is
// `ON DELETE CASCADE`, so an anonymous identity written there would be deleted
// together with the PAIRING ROW forty-eight hours later — and card ID-1's
// promise that a desktop shows one web instance forever would expire two days
// after every visit, silently, with nothing in any log.
//
// 🔴 SO THE REVERSE CONTROL IS THE POINT OF THIS FILE, and it is not a
// hypothetical: the second test below writes the identity into `user_id`, runs
// the same sweep, and asserts the pairing IS GONE. If that ever stops being red,
// the column's delete rule has changed and the first test is passing for a
// reason nobody chose.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/connection';
import { makeUserRepo, type UserRepo } from '../src/db/repos/user.repo';
import { makeMobileRepo, type MobileRepo } from '../src/db/repos/mobile.repo';
import { makePcRepo, type PcRepo } from '../src/db/repos/pc.repo';
import { makeTrialLedgerRepo, type TrialLedgerRepo } from '../src/db/repos/trial-ledger.repo';
import { makeTrialArchiveRepo, type TrialArchiveRepo } from '../src/db/repos/trial-archive.repo';
import { makeUsageArchiveRepo, type UsageArchiveRepo } from '../src/db/repos/usage-archive.repo';
import { makeTransactionRunner, type TransactionRunner } from '../src/db/tx';
import { makeTrialLedger, type TrialLedger } from '../src/billing/trial-ledger';
import { runAnonCleanup, ANON_ROW_RETENTION_MS } from '../src/db/anon-cleanup';

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

let dir: string;
let db: DatabaseSync;
let users: UserRepo;
let pcs: PcRepo;
let mobiles: MobileRepo;
let rows: TrialLedgerRepo;
let trialArchive: TrialArchiveRepo;
let usageArchive: UsageArchiveRepo;
let tx: TransactionRunner;
let ledger: TrialLedger;
let n = 0;

/** A real PC owned by a real account, and a web pairing on it. */
function room(): { ownerId: string; pairingId: string } {
  const ownerId = `owner-${(n += 1)}`;
  users.insert({ id: ownerId, email: `${ownerId}@flowmic.test`, password_hash: 'x' });
  const pc = pcs.insert({
    id: `pc-${n}`, user_id: ownerId, device_name: 'R1 PC',
    device_token: `dt-${n}`, room_uuid: `room-${n}`, short_code: '0001',
  });
  const mobile = mobiles.insert({
    id: `pairing-${n}`, user_id: ownerId, pc_device_id: pc.id,
    mobile_token: `mt-${n}`, mobile_name: 'Web-abcd', device_uid: `wb-${n}`, client: 'web',
  });
  return { ownerId, pairingId: mobile.id };
}

/** Mint a demo identity `ageMs` ago, through the production ledger. */
function trialIdentity(ageMs: number): string {
  n += 1;
  return ledger.claim({
    deviceUid: `wb-anon-${n}`,
    ipBucket: 'bucket', nowMs: NOW - ageMs, tokenTtlMs: HOUR,
    newId: () => `anon-${n}`, newToken: () => `fm_${n}`,
  }).userId;
}

const pairingExists = (id: string): boolean => mobiles.findById(id) !== null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flowmic-r1-fk-'));
  db = openDatabase(join(dir, 'r1.sqlite'));
  users = makeUserRepo(db);
  pcs = makePcRepo(db);
  mobiles = makeMobileRepo(db);
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

describe('the column exists, is nullable, and points at users with SET NULL', () => {
  it('the migration produced exactly the delete rule the card argues for', () => {
    // Read off the LIVE schema rather than trusted from the DDL text: an ALTER
    // TABLE ADD COLUMN with a REFERENCES clause is legal only because the
    // default is NULL, and 「it is in the file」 is not 「sqlite applied it」.
    const fks = db.prepare('PRAGMA foreign_key_list(mobile_pairings)').all() as {
      table: string; from: string; on_delete: string;
    }[];
    const trialFk = fks.find((f) => f.from === 'trial_user_id');
    expect(trialFk?.table).toBe('users');
    expect(trialFk?.on_delete).toBe('SET NULL');
    // …and its neighbour is untouched. The two rules beside each other ARE the
    // card: one says 「this identity is temporary」, the other 「this account owns
    // the row」.
    expect(fks.find((f) => f.from === 'user_id')?.on_delete).toBe('CASCADE');
  });

  it('a fresh pairing has no identity, and the column takes one', () => {
    const { pairingId } = room();
    expect(mobiles.findById(pairingId)?.trial_user_id).toBeNull();
    const anon = trialIdentity(0);
    mobiles.setTrialUser(pairingId, anon);
    expect(mobiles.findById(pairingId)?.trial_user_id).toBe(anon);
  });
});

describe('the 48-hour anonymous sweep, against a pairing that names an identity', () => {
  it('🔴 does NOT touch an identity that is still inside the window', () => {
    const { pairingId } = room();
    const anon = trialIdentity(ANON_ROW_RETENTION_MS - HOUR);
    mobiles.setTrialUser(pairingId, anon);

    const report = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
    // The candidate count is asserted as well as the deletion, because 「nothing
    // was deleted」 is also what a sweep that found nothing at all looks like.
    expect(report.candidates).toBe(0);
    expect(report.deleted).toBe(0);
    expect(users.findById(anon)).not.toBeNull();
    expect(mobiles.findById(pairingId)?.trial_user_id).toBe(anon);
  });

  it('🔴 past the window: the identity goes, the PAIRING SURVIVES, the column empties', () => {
    const { pairingId, ownerId } = room();
    const anon = trialIdentity(ANON_ROW_RETENTION_MS + HOUR);
    mobiles.setTrialUser(pairingId, anon);

    const report = runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);
    expect(report.deleted).toBe(1);
    expect(users.findById(anon)).toBeNull();
    // THE WHOLE CARD, IN THREE LINES: the browser's instance is still there, it
    // still belongs to the same computer, and it no longer names an identity —
    // so the next unsigned admission mints a fresh one, still under that
    // network's daily sequence.
    expect(pairingExists(pairingId)).toBe(true);
    expect(mobiles.findById(pairingId)?.user_id).toBe(ownerId);
    expect(mobiles.findById(pairingId)?.trial_user_id).toBeNull();
  });

  it('🔴 REVERSE CONTROL — the same sweep, with the identity in `user_id`, DELETES the pairing', () => {
    // Design §2.1's trap, reproduced deliberately. This is the implementation
    // the card rejected: one column instead of two. Everything else is
    // identical — same sweep, same age, same repos.
    const { pairingId } = room();
    const anon = trialIdentity(ANON_ROW_RETENTION_MS + HOUR);
    db.prepare('UPDATE mobile_pairings SET user_id=? WHERE id=?').run(anon, pairingId);
    expect(pairingExists(pairingId)).toBe(true); // positive control: it is there NOW

    runAnonCleanup({ trials: rows, users, trialArchive, usageArchive, tx, apply: true }, NOW);

    expect(pairingExists(pairingId)).toBe(false);
    // ⚠️ If this ever goes green, `user_id`'s CASCADE is gone and the first test
    // above is no longer proving anything about WHICH column was chosen.
  });
});
