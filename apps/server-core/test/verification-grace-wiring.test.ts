// The PRODUCTION wiring of the unverified-grace gate, driven end to end over a
// real database: INIT_SQL/reconcileSchema → makeUserRepo → UserRecord →
// wireVerificationGrace's own `graceInputs` → the guard the two session-start
// sites call.
//
// 🔴 WHY THIS FILE EXISTS AS A SEPARATE THING FROM test/verification-grace.test.ts.
// That file drives `makeVerificationGraceGuard` with a HAND-WRITTEN reader — a
// literal `{ graceInputs: () => row }`. It proves the arithmetic and it proves
// the guard, and it proves NOTHING about the line that actually feeds them in
// production, which is `graceUntilMs: u.verify_grace_until` inside
// `wireVerificationGrace`. That single line is the whole of the new plumbing;
// a typo there (or the column simply not being read) leaves every test in that
// file green and the gate refusing the accounts it was meant to admit. This is
// CLAUDE.md 13 §7 F1 ③ verbatim — 「单测全绿对「接线」零证明力」 — and the
// remedy it prescribes: make one test travel the real path.
//
// 🔴 MEASURED, NOT ASSUMED (2026-09-09). Replacing that line with
// `graceUntilMs: null` — the exact shape of「the column is never read」— fails
// EXACTLY ONE assertion in this file, verbatim `AssertionError: expected
// { …(2) } to be null`, while ALL TWENTY tests in test/verification-grace.test.ts
// stay green. That is the whole justification for this file existing, and it is
// a reading rather than a guess.
//
// Deliberately NOT merged into that file: it is the only test in the suite that
// needs a real sqlite database for this gate, and its whole value is that it
// does not construct the reader itself.
//
// *** SCHEMA-SENSITIVE (users.verify_grace_until) + auth (who may start a
//     managed cloud session) ***

import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, reconcileSchema } from '../src/db/connection';
import { makeUserRepo, type UserRepo } from '../src/db/repos/user.repo';
import { DAY_MS, VERIFICATION_GRACE_MS, wireVerificationGrace } from '../src/auth/verification-grace';

/** Old enough that the computed deadline (max(created_at, epoch) + 3 days) is
 *  long past whatever `now` the tests below use — the shape the five store-review
 *  accounts are actually in (created 2026-08-15, refused since 2026-08-30). */
const LONG_AGO = '2020-01-01 00:00:00';
const NOW = Date.parse('2026-09-09T00:00:00.000Z');

function columnNames(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
}

/** A real database, a real repo, and one account that is past its grace by FACT
 *  (an old `created_at`) rather than by a mocked clock. */
function oneExpiredAccount(): { db: DatabaseSync; users: UserRepo } {
  const db = openDatabase(':memory:');
  const users = makeUserRepo(db);
  users.insert({ id: 'u-review', email: 'review@example.test', display_name: 'Review' });
  db.prepare('UPDATE users SET created_at=? WHERE id=?').run(LONG_AGO, 'u-review');
  return { db, users };
}

describe('wireVerificationGrace over a real users row', () => {
  it('🔴 with NO override the account is refused — the baseline everything below rests on', () => {
    const { users } = oneExpiredAccount();
    expect(users.findById('u-review')?.verify_grace_until).toBeNull();
    const guard = wireVerificationGrace({ users, mode: 'saas', now: () => NOW });
    expect(guard.check('u-review')).not.toBeNull();
    expect(guard.daysLeft('u-review')).toBe(0);
  });

  it('🔴 a future users.verify_grace_until admits the account THROUGH THE REAL READER', () => {
    const { db, users } = oneExpiredAccount();
    const until = NOW + 10 * DAY_MS;
    db.prepare('UPDATE users SET verify_grace_until=? WHERE id=?').run(until, 'u-review');
    // The column really round-trips through the repo. Without this line a null
    // read would be measuring the guard's tolerance of a FAILED read (which
    // admits, by design) rather than the override doing anything.
    expect(users.findById('u-review')?.verify_grace_until).toBe(until);
    const guard = wireVerificationGrace({ users, mode: 'saas', now: () => NOW });
    expect(guard.check('u-review')).toBeNull();
    expect(guard.daysLeft('u-review')).toBe(10);
  });

  it('a past value changes nothing — the same refusal as no override at all', () => {
    const { db, users } = oneExpiredAccount();
    db.prepare('UPDATE users SET verify_grace_until=? WHERE id=?').run(NOW - DAY_MS, 'u-review');
    const guard = wireVerificationGrace({ users, mode: 'saas', now: () => NOW });
    expect(guard.check('u-review')).not.toBeNull();
    expect(guard.daysLeft('u-review')).toBe(0);
  });

  it('a database that PREDATES the column forward-ports to the same answers, with no backfill', () => {
    // The migrated shape, built by taking the column away and letting
    // reconcileSchema put it back — which is what every production database did
    // on the deploy that shipped this. It lands at the END of the table rather
    // than where INIT_SQL puts it, so the two shapes differ in column ORDER;
    // everything here reads by NAME, and the assertion that matters is that a
    // legacy row comes back with NULL (the「BACKFILLS NOTHING」half of the step).
    const db = openDatabase(':memory:');
    db.exec('ALTER TABLE users DROP COLUMN verify_grace_until');
    expect(columnNames(db)).not.toContain('verify_grace_until');
    reconcileSchema(db);
    expect(columnNames(db).at(-1)).toBe('verify_grace_until');
    const users = makeUserRepo(db);
    users.insert({ id: 'u-legacy', email: 'legacy@example.test' });
    db.prepare('UPDATE users SET created_at=? WHERE id=?').run(LONG_AGO, 'u-legacy');
    expect(users.findById('u-legacy')?.verify_grace_until).toBeNull();
    expect(wireVerificationGrace({ users, mode: 'saas', now: () => NOW }).check('u-legacy')).not.toBeNull();
    expect(VERIFICATION_GRACE_MS).toBe(3 * DAY_MS); // the policy this file assumes, pinned
  });
});
