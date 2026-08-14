// Contract tests for platform-level usage aggregation — usage.repo.ts's three new methods.
//
// Why each block is here rather than "for coverage":
//   ① An aggregate that mixes accounts is a data-integrity bug that looks
//      perfectly healthy from the outside: the number is plausible, it is just
//      somebody else's. Two users with DISJOINT, individually-identifiable
//      numbers so a mix-up cannot land on a coincidentally-correct total.
//   ② Month isolation is the same failure in the other axis. The month bucket is
//      the ONLY thing standing between "how much was used this month" and "how much was used ever",
//      and a dropped `WHERE month=?` is a one-character bug that makes every
//      total bigger and never throws.
//   ③ The empty month is a deliberate design decision (0, not null), so it gets
//      an assertion instead of a comment — and the assertion pins BOTH halves:
//      the totals are 0 AND `users` is 0, because it is `users` that carries
//      "this month has no rows at all".
//   ④ Pagination's cursor must be truthful at the exactly-full-page boundary.
//      That is the case `rows.length < limit` gets wrong, and it is the case a
//      test with 3 rows and limit 2 never reaches.
//   ⑤ 🔴 The existing two methods must still behave EXACTLY as before. Their
//      consumers (billing-service.ts:515 `getQuota`, quota-guard.ts:45,
//      usage-tracker.ts:28)
//      are all single-user/single-month and were not touched.

import { describe, expect, it } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { USAGE_PAGE_MAX } from '../src/db/repos/usage.repo';

const M1 = '2026-07';
const M2 = '2026-08';

function freshDb(users: string[] = ['u1', 'u2', 'u3']): DbConnection {
  const db = createDbConnection({
    dbPath: ':memory:',
    encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx'),
  });
  // usage_records.user_id is a FK to users(id) and openDatabase turns FKs ON, so
  // the rows have to hang off real accounts.
  for (const id of users) db.users.insert({ id, display_name: id, plan: 'free' });
  return db;
}

describe('usage repo — platform rollup "how much did the whole platform use this month"', () => {
  it('sums every account in the month, and attributes nothing to the wrong user', () => {
    const db = freshDb();
    // Disjoint magnitudes: any cross-attribution changes a per-user number in a
    // way no coincidence can hide.
    db.usage.increment('u1', M1, { stt_minutes: 1.5, llm_tokens_in: 100, llm_tokens_out: 10 });
    db.usage.increment('u2', M1, { stt_minutes: 20, llm_tokens_in: 2000, llm_tokens_out: 200 });
    db.usage.increment('u3', M1, { stt_minutes: 300, llm_tokens_in: 30_000, llm_tokens_out: 3000 });

    const total = db.usage.totalForMonth(M1);
    expect(total).toEqual({
      month: M1,
      users: 3,
      stt_minutes: 321.5,
      llm_tokens_in: 32_100,
      llm_tokens_out: 3210,
    });

    // The rollup is right AND each row is still the right person's — a total can
    // be correct while the rows underneath it are shuffled.
    const { rows } = db.usage.listUsersForMonth(M1);
    expect(rows.map((r) => [r.user_id, r.stt_minutes, r.llm_tokens_in])).toEqual([
      ['u1', 1.5, 100],
      ['u2', 20, 2000],
      ['u3', 300, 30_000],
    ]);
  });

  it('accumulates repeated increments for one user into that ONE user', () => {
    const db = freshDb(['u1', 'u2']);
    db.usage.increment('u1', M1, { stt_minutes: 1 });
    db.usage.increment('u1', M1, { stt_minutes: 2 });
    db.usage.increment('u1', M1, { stt_minutes: 4 });
    db.usage.increment('u2', M1, { stt_minutes: 8 });

    expect(db.usage.totalForMonth(M1).stt_minutes).toBe(15);
    expect(db.usage.totalForMonth(M1).users).toBe(2); // 2 ROWS, not 4 increments
    expect(db.usage.get('u1', M1)?.stt_minutes).toBe(7);
    expect(db.usage.get('u2', M1)?.stt_minutes).toBe(8);
  });

  it('does NOT round stt_minutes — the repo reports what was used, not what to display', () => {
    const db = freshDb(['u1', 'u2']);
    // What usage-tracker.ts actually writes: duration_ms / 60_000.
    db.usage.increment('u1', M1, { stt_minutes: 30_000 / 60_000 }); // 0.5
    db.usage.increment('u2', M1, { stt_minutes: 15_000 / 60_000 }); // 0.25
    expect(db.usage.totalForMonth(M1).stt_minutes).toBe(0.75);
  });

  it('keeps token totals as integers, not floats', () => {
    const db = freshDb(['u1', 'u2']);
    db.usage.increment('u1', M1, { llm_tokens_in: 3, llm_tokens_out: 5 });
    db.usage.increment('u2', M1, { llm_tokens_in: 4, llm_tokens_out: 6 });
    const t = db.usage.totalForMonth(M1);
    expect(Number.isInteger(t.llm_tokens_in)).toBe(true);
    expect(Number.isInteger(t.llm_tokens_out)).toBe(true);
    expect([t.llm_tokens_in, t.llm_tokens_out]).toEqual([7, 11]);
  });
});

describe('usage repo — month isolation', () => {
  it('a rollup covers ONE month, never the whole table', () => {
    const db = freshDb(['u1', 'u2']);
    db.usage.increment('u1', M1, { stt_minutes: 10, llm_tokens_in: 100, llm_tokens_out: 1 });
    db.usage.increment('u2', M1, { stt_minutes: 20, llm_tokens_in: 200, llm_tokens_out: 2 });
    db.usage.increment('u1', M2, { stt_minutes: 5, llm_tokens_in: 50, llm_tokens_out: 3 });

    expect(db.usage.totalForMonth(M1)).toEqual({
      month: M1, users: 2, stt_minutes: 30, llm_tokens_in: 300, llm_tokens_out: 3,
    });
    expect(db.usage.totalForMonth(M2)).toEqual({
      month: M2, users: 1, stt_minutes: 5, llm_tokens_in: 50, llm_tokens_out: 3,
    });
    // 🔴 The all-time sum (35) must appear in NEITHER answer — that is what a
    // dropped `WHERE month=?` would produce, and it would look plausible.
    expect(db.usage.totalForMonth(M1).stt_minutes).not.toBe(35);
    expect(db.usage.totalForMonth(M2).stt_minutes).not.toBe(35);
  });

  it('a listing covers ONE month too', () => {
    const db = freshDb(['u1', 'u2']);
    db.usage.increment('u1', M1, { stt_minutes: 10 });
    db.usage.increment('u2', M1, { stt_minutes: 20 });
    db.usage.increment('u1', M2, { stt_minutes: 5 });

    expect(db.usage.listUsersForMonth(M1).rows.map((r) => r.user_id)).toEqual(['u1', 'u2']);
    const m2 = db.usage.listUsersForMonth(M2).rows;
    expect(m2.map((r) => r.user_id)).toEqual(['u1']);
    expect(m2[0]?.stt_minutes).toBe(5); // u1's JULY 10 must not leak into August
    expect(m2.every((r) => r.month === M2)).toBe(true);
  });

  it('listMonths reports exactly the months that have rows, newest first', () => {
    const db = freshDb(['u1', 'u2']);
    expect(db.usage.listMonths()).toEqual([]);
    db.usage.increment('u1', M2, { stt_minutes: 1 });
    db.usage.increment('u2', M1, { stt_minutes: 1 });
    db.usage.increment('u1', M1, { stt_minutes: 1 });
    expect(db.usage.listMonths()).toEqual([M2, M1]); // DISTINCT: M1 appears once
  });
});

describe('usage repo — the empty month is a PROVEN zero, not an unknown', () => {
  it('returns 0 (never null/undefined) for a month with no rows', () => {
    const db = freshDb(['u1']);
    db.usage.increment('u1', M1, { stt_minutes: 10, llm_tokens_in: 5, llm_tokens_out: 5 });

    const empty = db.usage.totalForMonth('2026-01');
    expect(empty).toEqual({
      month: '2026-01', users: 0, stt_minutes: 0, llm_tokens_in: 0, llm_tokens_out: 0,
    });
    // Explicitly NOT null — SUM() over the empty set is NULL in SQL and the
    // COALESCE is the whole point of this assertion.
    expect(empty.stt_minutes).not.toBeNull();
    expect(empty.llm_tokens_in).not.toBeNull();
  });

  it('empty on a table that is entirely empty', () => {
    const db = freshDb(['u1']);
    expect(db.usage.totalForMonth(M1)).toEqual({
      month: M1, users: 0, stt_minutes: 0, llm_tokens_in: 0, llm_tokens_out: 0,
    });
    expect(db.usage.listUsersForMonth(M1)).toEqual({ rows: [], next_after_user_id: null });
  });

  it('`users` — not the totals — is what says "this month has no rows"', () => {
    const db = freshDb(['u1', 'u2']);
    // Real rows whose measured usage happens to be zero. Same totals as an empty
    // month; DIFFERENT `users`. If the emptiness had been folded into the totals
    // these two states would be indistinguishable.
    db.usage.increment('u1', M1, {});
    db.usage.increment('u2', M1, {});
    const present = db.usage.totalForMonth(M1);
    const absent = db.usage.totalForMonth('2026-01');
    expect(present.stt_minutes).toBe(absent.stt_minutes);
    expect(present.users).toBe(2);
    expect(absent.users).toBe(0);
    // And listMonths agrees with `users`, which is why it exists.
    expect(db.usage.listMonths()).toContain(M1);
    expect(db.usage.listMonths()).not.toContain('2026-01');
  });
});

describe('usage repo — keyset pagination tells the truth about "is there more"', () => {
  const ids = ['u01', 'u02', 'u03', 'u04', 'u05'];

  function seeded(): DbConnection {
    const db = freshDb(ids);
    ids.forEach((id, i) => db.usage.increment(id, M1, { stt_minutes: i + 1 }));
    return db;
  }

  it('walks every row exactly once across pages', () => {
    const db = seeded();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page: { rows: { user_id: string }[]; next_after_user_id: string | null } =
        db.usage.listUsersForMonth(M1, { limit: 2, after_user_id: cursor });
      seen.push(...page.rows.map((r) => r.user_id));
      if (page.next_after_user_id === null) break;
      cursor = page.next_after_user_id;
    }
    expect(seen).toEqual(ids); // every row, in order, no duplicates, no gaps
  });

  it('🔴 an exactly-full last page still reports next=null (the limit+1 probe)', () => {
    const db = seeded();
    // 5 rows, limit 5 => the page is exactly full and there is nothing after it.
    // `rows.length < limit` would say "there is another page" here, forever.
    const page = db.usage.listUsersForMonth(M1, { limit: 5 });
    expect(page.rows).toHaveLength(5);
    expect(page.next_after_user_id).toBeNull();

    // And the page before it correctly says there IS more.
    const p4 = db.usage.listUsersForMonth(M1, { limit: 4 });
    expect(p4.rows).toHaveLength(4);
    expect(p4.next_after_user_id).toBe('u04');
    const rest = db.usage.listUsersForMonth(M1, { limit: 4, after_user_id: 'u04' });
    expect(rest.rows.map((r) => r.user_id)).toEqual(['u05']);
    expect(rest.next_after_user_id).toBeNull();
  });

  it('clamps an oversized limit but does not lie about it', () => {
    const db = seeded();
    const page = db.usage.listUsersForMonth(M1, { limit: 10_000 });
    expect(page.rows).toHaveLength(5); // all we have; clamp is invisible here
    expect(page.next_after_user_id).toBeNull();
    // The clamp is real and is the documented ceiling.
    expect(USAGE_PAGE_MAX).toBe(200);
  });

  it('throws on a limit that cannot mean anything', () => {
    const db = seeded();
    expect(() => db.usage.listUsersForMonth(M1, { limit: 0 })).toThrow(/positive integer/);
    expect(() => db.usage.listUsersForMonth(M1, { limit: -1 })).toThrow(/positive integer/);
    expect(() => db.usage.listUsersForMonth(M1, { limit: 2.5 })).toThrow(/positive integer/);
  });

  it('a cursor past the end yields an empty final page, not a wrap-around', () => {
    const db = seeded();
    const page = db.usage.listUsersForMonth(M1, { after_user_id: 'zzz' });
    expect(page.rows).toEqual([]);
    expect(page.next_after_user_id).toBeNull();
  });
});

describe('usage repo — the two pre-existing methods are untouched', () => {
  it('get() still answers about ONE user in ONE month', () => {
    const db = freshDb(['u1', 'u2']);
    db.usage.increment('u1', M1, { stt_minutes: 7, llm_tokens_in: 1, llm_tokens_out: 2 });
    db.usage.increment('u2', M1, { stt_minutes: 99 });
    db.usage.increment('u1', M2, { stt_minutes: 3 });

    const rec = db.usage.get('u1', M1);
    expect(rec?.user_id).toBe('u1');
    expect(rec?.month).toBe(M1);
    expect(rec?.stt_minutes).toBe(7); // not 106 (all users), not 10 (all months)
    expect(db.usage.get('u1', '2026-01')).toBeNull();
    expect(db.usage.get('nobody', M1)).toBeNull();
  });

  it('increment() still returns the accumulated row for that user/month', () => {
    const db = freshDb(['u1']);
    expect(db.usage.increment('u1', M1, { stt_minutes: 2 }).stt_minutes).toBe(2);
    const after = db.usage.increment('u1', M1, { stt_minutes: 3, llm_tokens_in: 9 });
    expect(after.stt_minutes).toBe(5);
    expect(after.llm_tokens_in).toBe(9);
    expect(after.user_id).toBe('u1');
    expect(after.month).toBe(M1);
  });
});
