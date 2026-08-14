// Window D1 §3 —— the billing data model's contract tests.
//   docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §3.1/§3.2/§3.3/§3.4
//
// What these pin, and why each one is here rather than "for coverage":
//   ① claimEvent is the idempotency gate. If it ever admits the same event_id
//      twice, Paddle's retries apply the same state write twice and the ledger
//      says it only happened once. It is the ONE thing in this repo whose
//      failure is invisible from the outside.
//   ② permanent_free must read FALSE by default — including on a database that
//      predates the column (that half is in migration-idempotency.test.ts, where
//      the migration itself lives).
//   ③ ON DELETE CASCADE really cascades: FKs are only ON because openDatabase
//      passes enableForeignKeyConstraints, and a constraint nobody exercises is
//      indistinguishable from one that was never enforced.

import { describe, expect, it } from 'vitest';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { OUTCOME_PENDING, type PaddleSubRow } from '../src/db/repos/billing.repo';

function freshDb() {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U', plan: 'free' });
  return db;
}

function claim(id: string, extra: Partial<{ notification_id: string | null; event_type: string; occurred_at: string }> = {}) {
  return {
    event_id: id,
    notification_id: extra.notification_id ?? `ntf_${id}`,
    event_type: extra.event_type ?? 'subscription.activated',
    occurred_at: extra.occurred_at ?? '2026-08-01T10:00:00.000Z',
    received_at: '2026-08-01T10:00:01.000Z',
  };
}

function subRow(over: Partial<PaddleSubRow> = {}): PaddleSubRow {
  return {
    subscription_id: 'sub_A',
    user_id: 'u1',
    customer_id: 'ctm_1',
    status: 'active',
    tier: 'pro',
    price_id: 'pri_pro_monthly',
    cycle: 'monthly',
    current_period_end: '2026-09-01T00:00:00.000Z',
    canceled_at: null,
    last_event_id: 'evt_1',
    last_occurred_at: '2026-08-01T10:00:00.000Z',
    created_at: '2026-08-01T10:00:01.000Z',
    updated_at: '2026-08-01T10:00:01.000Z',
    ...over,
  };
}

describe('billing repo — claimEvent is the idempotency gate', () => {
  it('admits an event_id once and refuses it forever after', () => {
    const db = freshDb();
    expect(db.billing.claimEvent(claim('evt_1'))).toBe(true);
    // Paddle's retry: SAME event_id, DIFFERENT notification_id (that is exactly
    // what changes between delivery attempts — and exactly why notification_id
    // must never be the dedup key).
    expect(db.billing.claimEvent(claim('evt_1', { notification_id: 'ntf_retry' }))).toBe(false);
    expect(db.billing.claimEvent(claim('evt_1', { notification_id: 'ntf_retry_2' }))).toBe(false);

    // The refusal is a real refusal, not a silent second row: one row, and it
    // still carries the FIRST delivery's notification_id.
    const rows = db.raw.prepare('SELECT * FROM billing_events').all() as {
      event_id: string;
      notification_id: string;
      redelivery_count: number;
      last_notification_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notification_id).toBe('ntf_evt_1');
    // …and the two retries were COUNTED, not dropped (§3.3-bis).
    expect(rows[0]!.redelivery_count).toBe(2);
    expect(rows[0]!.last_notification_id).toBe('ntf_retry_2');
    db.close();
  });

  // Window D1 §7 step 3, as corrected by the lead 2026-08-01. The original wording
  // (「billing_events only gains one extra duplicate row」) is structurally impossible — event_id is
  // the PRIMARY KEY. This is what idempotency actually looks like from outside.
  it('a verbatim redelivery leaves the row COUNT and the OUTCOME untouched, and only bumps the tally', () => {
    const db = freshDb();
    db.billing.claimEvent(claim('evt_1'));
    db.billing.finishEvent('evt_1', { subscription_id: 'sub_A', user_id: 'u1', outcome: 'applied' });
    const before = db.billing.listEventsForUser('u1', 10);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ outcome: 'applied', redelivery_count: 0, last_notification_id: 'ntf_evt_1' });

    // Verbatim redelivery —— same event, new delivery attempt.
    expect(db.billing.claimEvent(claim('evt_1', { notification_id: 'ntf_second_attempt' }))).toBe(false);

    const after = db.billing.listEventsForUser('u1', 10);
    expect(after).toHaveLength(1); // row count unchanged
    expect(after[0]).toMatchObject({
      outcome: 'applied', // 🔴 NOT overwritten — 「it already took effect」 survives the retry
      redelivery_count: 1, // 0 → 1
      last_notification_id: 'ntf_second_attempt',
      notification_id: 'ntf_evt_1', // the first-delivery one is unchanged
      subscription_id: 'sub_A',
    });
    // The whole table, not just this user's view: no second row anywhere.
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM billing_events').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('a claimed-but-unfinished event stays visible as pending (leave a trail, not silent)', () => {
    const db = freshDb();
    db.billing.claimEvent(claim('evt_crash'));
    const row = db.raw
      .prepare("SELECT outcome, user_id, detail, redelivery_count FROM billing_events WHERE event_id='evt_crash'")
      .get();
    expect(row).toEqual({ outcome: OUTCOME_PENDING, user_id: null, detail: null, redelivery_count: 0 });
    db.close();
  });

  it('deduping on notification_id would NOT have worked — the reverse control', () => {
    const db = freshDb();
    // Two DIFFERENT events that happen to share nothing but a delivery batch.
    db.billing.claimEvent(claim('evt_a', { notification_id: 'ntf_same' }));
    expect(db.billing.claimEvent(claim('evt_b', { notification_id: 'ntf_same' }))).toBe(true);
    // Both are distinct events and BOTH must be admitted: a notification_id-keyed
    // table would have dropped the second one on the floor.
    expect(db.billing.listEventsForUser('u1', 10)).toHaveLength(0); // not attributed yet
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM billing_events').get() as { n: number }).n).toBe(2);
    db.close();
  });
});

describe('billing repo — finishEvent', () => {
  it('writes the concluded outcome, subject and detail onto the claimed row', () => {
    const db = freshDb();
    db.billing.claimEvent(claim('evt_1'));
    db.billing.finishEvent('evt_1', {
      subscription_id: 'sub_A',
      user_id: 'u1',
      outcome: 'applied',
      detail: 'pri_pro_monthly → pro',
    });
    const [row] = db.billing.listEventsForUser('u1', 10);
    expect(row).toMatchObject({
      event_id: 'evt_1',
      subscription_id: 'sub_A',
      user_id: 'u1',
      outcome: 'applied',
      detail: 'pri_pro_monthly → pro',
      event_type: 'subscription.activated',
    });
    db.close();
  });

  it('records an unmapped event against no user, but records it (discard must leave a trail)', () => {
    const db = freshDb();
    db.billing.claimEvent(claim('evt_x', { event_type: 'subscription.updated' }));
    db.billing.finishEvent('evt_x', { outcome: 'unmapped', detail: 'no flowmic_user_id, price pri_unknown' });
    const row = db.raw.prepare("SELECT * FROM billing_events WHERE event_id='evt_x'").get() as {
      outcome: string;
      user_id: string | null;
      detail: string;
    };
    expect(row.outcome).toBe('unmapped');
    expect(row.user_id).toBeNull();
    expect(row.detail).toContain('pri_unknown');
    db.close();
  });

  it('throws (never silently no-ops) when the event was never claimed', () => {
    const db = freshDb();
    expect(() => db.billing.finishEvent('evt_never', { outcome: 'applied' })).toThrow(/finishEvent/);
    db.close();
  });
});

describe('billing repo — subscriptions', () => {
  it('upsert inserts, then updates in place while PRESERVING created_at', () => {
    const db = freshDb();
    db.billing.upsertSubscription(subRow());
    const first = db.billing.getSubscription('sub_A');
    expect(first).toMatchObject({ status: 'active', tier: 'pro', cycle: 'monthly', user_id: 'u1' });

    db.billing.upsertSubscription(
      subRow({
        status: 'canceled',
        canceled_at: '2026-08-15T00:00:00.000Z',
        last_event_id: 'evt_2',
        last_occurred_at: '2026-08-15T00:00:00.000Z',
        // A caller that (wrongly) passes a fresh created_at must not be able to
        // rewrite when this subscription first entered our books.
        created_at: '2999-01-01T00:00:00.000Z',
        updated_at: '2026-08-15T00:00:01.000Z',
      }),
    );
    const second = db.billing.getSubscription('sub_A');
    expect(second).toMatchObject({
      status: 'canceled',
      canceled_at: '2026-08-15T00:00:00.000Z',
      last_event_id: 'evt_2',
      updated_at: '2026-08-15T00:00:01.000Z',
      created_at: '2026-08-01T10:00:01.000Z',
    });
    // Still ONE row — an upsert that quietly forked into two subscriptions would
    // give latestForUser a coin to flip.
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM paddle_subscriptions').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('latestForUser answers 「the most recently active one」, deterministically', () => {
    const db = freshDb();
    db.billing.upsertSubscription(subRow({ subscription_id: 'sub_old', last_occurred_at: '2026-01-01T00:00:00.000Z' }));
    db.billing.upsertSubscription(subRow({ subscription_id: 'sub_new', last_occurred_at: '2026-08-01T00:00:00.000Z' }));
    expect(db.billing.latestForUser('u1')?.subscription_id).toBe('sub_new');
    expect(db.billing.latestForUser('nobody')).toBeNull();
    expect(db.billing.getSubscription('sub_missing')).toBeNull();
    db.close();
  });

  it('listEventsForUser is user-scoped, newest first, and honours the limit', () => {
    const db = freshDb();
    db.users.insert({ id: 'u2', display_name: 'Other', plan: 'free' });
    for (const [id, user, received] of [
      ['evt_1', 'u1', '2026-08-01T10:00:00.000Z'],
      ['evt_2', 'u1', '2026-08-01T11:00:00.000Z'],
      ['evt_3', 'u2', '2026-08-01T12:00:00.000Z'],
    ] as const) {
      db.billing.claimEvent({ ...claim(id), received_at: received });
      db.billing.finishEvent(id, { user_id: user, outcome: 'applied' });
    }
    expect(db.billing.listEventsForUser('u1', 10).map((e) => e.event_id)).toEqual(['evt_2', 'evt_1']);
    expect(db.billing.listEventsForUser('u1', 1).map((e) => e.event_id)).toEqual(['evt_2']);
    // only the caller's own rows (D1 §6.2) — u2's event must never appear under u1.
    expect(db.billing.listEventsForUser('u2', 10).map((e) => e.event_id)).toEqual(['evt_3']);
    db.close();
  });
});

describe('billing repo — ON DELETE CASCADE', () => {
  it('deleting a user takes their paddle_subscriptions rows with it', () => {
    const db = freshDb();
    db.billing.upsertSubscription(subRow({ subscription_id: 'sub_A' }));
    db.billing.upsertSubscription(subRow({ subscription_id: 'sub_B' }));
    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM paddle_subscriptions').get() as { n: number }).n).toBe(2);

    db.raw.exec("DELETE FROM users WHERE id='u1'");

    expect((db.raw.prepare('SELECT COUNT(*) AS n FROM paddle_subscriptions').get() as { n: number }).n).toBe(0);
    expect(db.billing.latestForUser('u1')).toBeNull();
    db.close();
  });

  it('but the billing_events ledger SURVIVES a user deletion (no FK, on purpose)', () => {
    const db = freshDb();
    db.billing.claimEvent(claim('evt_1'));
    db.billing.finishEvent('evt_1', { user_id: 'u1', subscription_id: 'sub_A', outcome: 'applied' });

    db.raw.exec("DELETE FROM users WHERE id='u1'");

    // The ledger has no FK on user_id BECAUSE an event we could not attribute to
    // anybody (outcome:'unmapped') still has to be recordable — a REFERENCES
    // users(id) would make that row unwritable and turn 「discard must leave a trail」 into a silent
    // drop. The visible consequence is here: money events outlive the account.
    // It carries no payload and no PII (D1 §3.3), only our own one-liner.
    const n = (db.raw.prepare('SELECT COUNT(*) AS n FROM billing_events').get() as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });
});

describe('users.permanent_free — the exemption flag', () => {
  it('defaults to false and round-trips as a real boolean, both ways', () => {
    const db = freshDb();
    expect(db.users.findById('u1')?.permanent_free).toBe(false);

    db.users.setPermanentFree('u1', true);
    expect(db.users.findById('u1')?.permanent_free).toBe(true);
    // The stored value is an INTEGER 1, not the string '1' — the whole reason
    // this column is not in ADDITIVE_TEXT_COLUMNS (schema.ts).
    expect(db.raw.prepare("SELECT permanent_free FROM users WHERE id='u1'").get()).toEqual({ permanent_free: 1 });

    db.users.setPermanentFree('u1', false);
    expect(db.users.findById('u1')?.permanent_free).toBe(false);
    // …and false is a REAL false, not the truthy string '0'.
    expect(db.users.findById('u1')?.permanent_free).not.toBeTruthy();
    db.close();
  });

  it('is exposed on every UserRecord projection, not just findById', () => {
    const db = freshDb();
    db.users.setPermanentFree('u1', true);
    // Every method that mints a UserRecord goes through the one toRecord(); if a
    // projection ever forked, one of these would come back undefined.
    expect(db.users.insert({ id: 'u2', email: 'two@example.com', display_name: 'Two', plan: 'free' }).permanent_free).toBe(
      false,
    );
    expect(db.users.findByEmail('two@example.com')?.permanent_free).toBe(false);
    expect(db.users.setPlan('u1', 'pro')?.permanent_free).toBe(true);
    expect(db.users.setPassword('u1', 'hash')?.permanent_free).toBe(true);
    expect(Object.fromEntries(db.users.listAll().map((u) => [u.id, u.permanent_free]))).toEqual({ u1: true, u2: false });
    db.close();
  });

  it('does NOT touch users.plan — exemption and tier are two questions', () => {
    const db = freshDb();
    db.users.setPermanentFree('u1', true);
    // The mirror column is untouched: turning the exemption off later must not
    // leave a fake 'pro' behind. The effective tier is BillingService's single
    // answer (D1 §6.1), computed from this flag — never mirrored into it.
    expect(db.users.findById('u1')?.plan).toBe('free');
    db.close();
  });
});
