// Window D1 Lane C — billing/paddle/webhook-handler.ts, over a REAL database.
//
// A real `createDbConnection` rather than a fake repo, on purpose: three of the
// properties under test are properties of the STORAGE, and a fake would agree
// with whatever the handler did.
//   · `event_id` is a PRIMARY KEY, which is what makes the second delivery a
//     no-op — a fake Map would be "idempotent" even if the handler deduped on
//     the wrong field;
//   · `paddle_subscriptions.user_id` has a FK and `PRAGMA foreign_keys = ON` is
//     set, so an unverified user id really does throw;
//   · `last_occurred_at` is compared AS TEXT, which is the whole reason
//     occurred_at has to be normalized before it lands.
//
// What each block pins, in order of what it would cost to get wrong:
//   ① the signature is checked BEFORE anything is written (an unsigned body must
//      not leave a trace, let alone a subscription);
//   ② a redelivery writes NO state a second time — asserted on the STATE, not on
//      the status code, and with a positive control so a green 「nothing changed」
//      cannot be a test that changed nothing in the first place;
//   ③ 🔴 an unmapped price_id NEVER becomes a tier — the failure mode is a user
//      who paid and silently got Pro he did not buy, or Free he did;
//   ④ 「unknown event」 and 「cannot tell who it is」 are DIFFERENT ledger outcomes;
//   ⑤ occurred_at is normalized, so a `+08:00` delivery cannot disarm the
//      ordering guard for every event after it;
//   ⑥ 🔴 (Window D1 Lane H) the YEARLY cycle — `year/1` is the only shape that may
//      become 「yearly」, and the expiry a yearly subscriber gets must be the date
//      Paddle sent, never one derived from a cycle constant. The failure this
//      block exists for: the tier is right, the expiry is computed as monthly ⇒ the user paid for a year and is downgraded after one month.

import { describe, expect, it, vi } from 'vitest';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { handlePaddleWebhook, type PaddleWebhookDeps } from '../src/billing/paddle/webhook-handler';
import { signPaddlePayload } from '../src/billing/paddle/signature';
import { normalizeRfc3339, readSubscriptionFacts } from '../src/billing/paddle/envelope';
import { BillingService } from '../src/billing/billing-service';

const SECRET = 'pdl_ntfset_01j0_TESTONLY_not_a_real_secret';
const TS = 1_780_000_000;
const NOW_MS = TS * 1000;
const PRICE_PRO = 'pri_pro_monthly_test';
const PRICE_MAX = 'pri_max_monthly_test';

function world(over: Partial<PaddleWebhookDeps> = {}) {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
  const deps: PaddleWebhookDeps = {
    repo: db.billing,
    users: db.users,
    secret: SECRET,
    toleranceSec: 5,
    priceTiers: { [PRICE_PRO]: 'pro', [PRICE_MAX]: 'max' },
    now: () => NOW_MS,
    ...over,
  };
  return { db, deps };
}

interface FrameOver {
  event_id?: string;
  event_type?: string;
  occurred_at?: string;
  notification_id?: string;
  data?: Record<string, unknown>;
}

/** A Paddle `subscription.*` payload, shaped the way Paddle really sends one
 *  (`data.id` is the subscription, the price lives under `items[].price.id`,
 *  the period end under `current_billing_period.ends_at`). */
function subscriptionData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub_A',
    status: 'active',
    customer_id: 'ctm_1',
    canceled_at: null,
    scheduled_change_action: null,
    scheduled_change_at: null,
    next_billed_at: null,
    contract_concluded_at: null,
    items: [{ price: { id: PRICE_PRO } }],
    billing_cycle: { interval: 'month', frequency: 1 },
    current_billing_period: { starts_at: '2026-08-01T00:00:00.000000Z', ends_at: '2026-09-01T00:00:00.000000Z' },
    custom_data: { flowmic_user_id: 'u1' },
    ...over,
  };
}

function frame(over: FrameOver = {}): string {
  return JSON.stringify({
    event_id: over.event_id ?? 'evt_1',
    event_type: over.event_type ?? 'subscription.activated',
    occurred_at: over.occurred_at ?? '2026-08-01T10:00:00.000000Z',
    notification_id: over.notification_id ?? 'ntf_1',
    data: over.data ?? subscriptionData(),
  });
}

/** Deliver a body. Correctly signed unless `signature` is overridden. */
function deliver(deps: PaddleWebhookDeps, rawBody: string, signature?: string | undefined | null) {
  return handlePaddleWebhook(deps, {
    rawBody,
    signature: signature === null ? undefined : (signature ?? `ts=${TS};h1=${signPaddlePayload(rawBody, TS, SECRET)}`),
  });
}

function ledger(db: ReturnType<typeof world>['db'], userId: string) {
  return db.billing.listEventsForUser(userId, 50);
}

/** Every `billing_events` row, INCLUDING the ones with no `user_id` (an
 *  `ignored` event belongs to nobody, so `listEventsForUser` cannot see it —
 *  and 「the row exists」 is precisely what no-silent-drop claims). Reaches past the
 *  repo on purpose: asserting the ledger with the same projection the product
 *  uses would make an invisible row look like an absent one. */
function allEventRows(db: ReturnType<typeof world>['db']) {
  return db.raw.prepare('SELECT event_id, event_type, user_id, outcome, detail FROM billing_events').all() as {
    event_id: string; event_type: string; user_id: string | null; outcome: string; detail: string | null;
  }[];
}

describe('① signature is checked before anything is written', () => {
  it('🔴 a tampered body is 401 AND leaves the database untouched', () => {
    const { db, deps } = world();
    const body = frame();
    const goodSig = `ts=${TS};h1=${signPaddlePayload(body, TS, SECRET)}`;

    // The tamper: one byte of the body changed, the signature left alone.
    const tampered = body.replace('"sub_A"', '"sub_B"');
    expect(tampered).not.toBe(body);
    const refused = deliver(deps, tampered, goodSig);
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ ok: false, error: 'PADDLE_SIGNATURE_INVALID', reason: 'mismatch' });

    // 🔴 The negative assertion, written on the STATE rather than on the code:
    // 「it answered 401」 is also true of an implementation that answers 401 and
    // applies the event anyway.
    expect(db.billing.getSubscription('sub_A')).toBeNull();
    expect(db.billing.getSubscription('sub_B')).toBeNull();
    expect(ledger(db, 'u1')).toHaveLength(0);

    // …and its POSITIVE CONTROL: the same probe, on the untampered body, DOES
    // see writes — so the zeros above are the guard working, not a blind probe.
    expect(deliver(deps, body, goodSig).status).toBe(200);
    expect(db.billing.getSubscription('sub_A')).not.toBeNull();
    expect(ledger(db, 'u1')).toHaveLength(1);
  });

  it('an expired-but-correctly-signed frame is 401 `expired`, still with no writes', () => {
    const { db, deps } = world({ now: () => NOW_MS + 60_000 });
    const body = frame();
    const out = deliver(deps, body);
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ error: 'PADDLE_SIGNATURE_INVALID', reason: 'expired' });
    expect(db.billing.getSubscription('sub_A')).toBeNull();
    expect(ledger(db, 'u1')).toHaveLength(0);
  });

  it('a missing signature header is 401, not a 500 and not an accept', () => {
    const { db, deps } = world();
    const out = deliver(deps, frame(), null);
    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ reason: 'missing_header' });
    expect(ledger(db, 'u1')).toHaveLength(0);
  });

  it('a signed body that is not JSON is 400, and still writes nothing', () => {
    const { db, deps } = world();
    const out = deliver(deps, 'not json at all');
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: 'PADDLE_ENVELOPE_INVALID' });
    expect(ledger(db, 'u1')).toHaveLength(0);
  });

  it('a signed JSON body missing envelope fields is 400 and names the field', () => {
    const { deps } = world();
    for (const [body, field] of [
      [JSON.stringify({ event_type: 'subscription.activated', occurred_at: '2026-08-01T10:00:00Z', data: {} }), 'event_id'],
      [JSON.stringify({ event_id: 'evt_x', occurred_at: '2026-08-01T10:00:00Z', data: {} }), 'event_type'],
      [JSON.stringify({ event_id: 'evt_x', event_type: 't', occurred_at: 'yesterday', data: {} }), 'occurred_at'],
      [JSON.stringify({ event_id: 'evt_x', event_type: 't', occurred_at: '2026-08-01T10:00:00Z' }), 'data'],
    ] as const) {
      const out = deliver(deps, body);
      expect(out.status).toBe(400);
      expect(String(out.body.detail)).toContain(field);
    }
  });
});

describe('② a redelivery applies nothing a second time', () => {
  it('🔴 same event_id twice ⇒ 200 duplicate, one ledger row, subscription untouched', () => {
    const { db, deps } = world();
    const body = frame();

    const first = deliver(deps, body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, duplicate: false, outcome: 'applied' });
    const afterFirst = db.billing.getSubscription('sub_A');
    expect(afterFirst?.tier).toBe('pro');

    // Paddle's retry: SAME event_id, NEW notification_id (that difference is
    // exactly why notification_id must never be the dedup key).
    const retry = frame({ notification_id: 'ntf_2' });
    const second = deliver(deps, retry);
    expect(second.status).toBe(200); // 🔴 a non-200 makes Paddle retry forever
    expect(second.body).toEqual({ ok: true, duplicate: true });

    // The assertions that actually prove idempotency:
    const rows = ledger(db, 'u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('applied'); // NOT overwritten by the retry
    expect(rows[0]?.redelivery_count).toBe(1); // …and the retry IS counted
    expect(rows[0]?.last_notification_id).toBe('ntf_2');
    expect(db.billing.getSubscription('sub_A')).toEqual(afterFirst); // byte-identical row
  });

  it('a DIFFERENT event_id for the same subscription is NOT a duplicate', () => {
    // The positive control for the block above: dedup keys on the event, so a
    // genuinely new event must still get through.
    const { db, deps } = world();
    deliver(deps, frame({ event_id: 'evt_1' }));
    const out = deliver(deps, frame({ event_id: 'evt_2', occurred_at: '2026-08-01T11:00:00.000000Z' }));
    expect(out.body).toMatchObject({ duplicate: false, outcome: 'applied' });
    expect(ledger(db, 'u1')).toHaveLength(2);
  });
});

describe('③ 🔴 the tier comes from the price mapping and from nowhere else', () => {
  it('maps a configured price to its tier', () => {
    const { db, deps } = world();
    deliver(deps, frame({ data: subscriptionData({ items: [{ price: { id: PRICE_MAX } }] }) }));
    expect(db.billing.getSubscription('sub_A')?.tier).toBe('max');
  });

  it('🔴 an UNMAPPED price is `unmapped` with the id in the detail — never a default pro', () => {
    const { db, deps } = world();
    const out = deliver(deps, frame({ data: subscriptionData({ items: [{ price: { id: 'pri_unknown_xyz' } }] }) }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ outcome: 'unmapped' });
    // No row at all — not a row that quietly says 'pro', and not one that says
    // 'free' either (that would silently downgrade a real subscriber).
    expect(db.billing.getSubscription('sub_A')).toBeNull();
    const row = ledger(db, 'u1')[0];
    expect(row?.outcome).toBe('unmapped');
    expect(row?.detail).toContain('pri_unknown_xyz');
    expect(row?.detail).toContain('FLOWMIC_PADDLE_PRICE_TIERS');
  });

  it('refuses to guess when two items map to conflicting tiers', () => {
    const { db, deps } = world();
    const out = deliver(deps, frame({ data: subscriptionData({ items: [{ price: { id: PRICE_PRO } }, { price: { id: PRICE_MAX } }] }) }));
    expect(out.body).toMatchObject({ outcome: 'unmapped' });
    expect(ledger(db, 'u1')[0]?.detail).toContain('conflicting tiers');
    expect(db.billing.getSubscription('sub_A')).toBeNull();
  });

  it('an event carrying no price keeps the tier the row already has', () => {
    const { db, deps } = world();
    deliver(deps, frame()); // establishes sub_A @ pro
    const out = deliver(deps, frame({
      event_id: 'evt_2',
      event_type: 'subscription.paused',
      occurred_at: '2026-08-01T12:00:00.000000Z',
      data: subscriptionData({ status: 'paused', items: [] }),
    }));
    expect(out.body).toMatchObject({ outcome: 'applied' });
    const row = db.billing.getSubscription('sub_A');
    expect(row?.status).toBe('paused'); // Paddle's own word, stored verbatim
    expect(row?.tier).toBe('pro'); // carried over, not re-guessed
  });

  it('with no price AND no existing row there is nothing to inherit — unmapped, not a guess', () => {
    const { db, deps } = world();
    const out = deliver(deps, frame({ data: subscriptionData({ items: [] }) }));
    expect(out.body).toMatchObject({ outcome: 'unmapped' });
    expect(db.billing.getSubscription('sub_A')).toBeNull();
  });
});

describe('④ 「unknown event」 and 「cannot tell who it is」 are different outcomes', () => {
  it('an event type we do not handle is `ignored` — and is still recorded', () => {
    const { db, deps } = world();
    const out = deliver(deps, frame({ event_type: 'address.updated', data: { id: 'add_1', custom_data: { flowmic_user_id: 'u1' } } }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ outcome: 'ignored' });
    // Must not silently drop — the row really is there, with the reason written down.
    expect(allEventRows(db)).toEqual([
      { event_id: 'evt_1', event_type: 'address.updated', user_id: null, outcome: 'ignored', detail: expect.stringContaining('not handled') },
    ]);
    // ⚠️ `user_id` is NULL, so this row is invisible to GET /api/cloud/billing/
    // events (which filters by user). That is deliberate — an `address.updated`
    // from a product we do not sell is not the user's billing history — but it
    // does mean 「ignored」 rows are an OPERATOR-facing record only.
    expect(db.billing.listEventsForUser('u1', 50)).toHaveLength(0);
    expect(db.billing.getSubscription('sub_A')).toBeNull();
  });

  it('🔴 an UNHANDLED type does not consume the `unmapped` label', () => {
    // The distinction that matters: if unrelated Paddle traffic were labelled
    // `unmapped`, the ledger row that needs a human would be buried under a
    // permanent stream of ones that never will.
    const { deps } = world();
    const unrelated = deliver(deps, frame({ event_id: 'evt_a', event_type: 'payout.paid', data: { id: 'pay_1' } }));
    const trulyUnmapped = deliver(deps, frame({
      event_id: 'evt_b',
      data: subscriptionData({ custom_data: {} }),
    }));
    expect(unrelated.body).toMatchObject({ outcome: 'ignored' });
    expect(trulyUnmapped.body).toMatchObject({ outcome: 'unmapped' });
  });

  it('a subscription event naming nobody we know is `unmapped` + 200, with the reason', () => {
    const { db, deps } = world();
    const out = deliver(deps, frame({ data: subscriptionData({ custom_data: { flowmic_user_id: 'ghost' } }) }));
    // 🔴 200: a 4xx would make Paddle redeliver an event we can never recognise.
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ outcome: 'unmapped' });
    expect(db.billing.getSubscription('sub_A')).toBeNull();
    // Not attributed to a user that does not exist…
    expect(db.billing.listEventsForUser('ghost', 50)).toHaveLength(0);
    // …but recorded, naming BOTH lookups that were tried, because 「no user id was sent」
    // and 「it sent one we do not recognize」 are two different repairs.
    const rows = allEventRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('unmapped');
    expect(rows[0]?.detail).toContain('ghost');
    expect(rows[0]?.detail).toContain('sub_A');
  });

  it('🔴 a user id that names no account is NOT written (it would hit the FK and 500)', () => {
    const { db, deps } = world();
    expect(() => deliver(deps, frame({ data: subscriptionData({ custom_data: { flowmic_user_id: 'ghost' } }) }))).not.toThrow();
    expect(db.billing.getSubscription('sub_A')).toBeNull();
    // Positive control: the FK really is armed, so 「it did not throw」 above is
    // the existence check working rather than a database with FKs off.
    expect(() =>
      db.billing.upsertSubscription({
        subscription_id: 'sub_FK', user_id: 'ghost', customer_id: null, status: 'active', tier: 'pro',
        price_id: null, cycle: null, current_period_end: null, canceled_at: null,
        scheduled_change_action: null, scheduled_change_at: null,
        next_billed_at: null, contract_concluded_at: null,
        last_event_id: 'evt_fk', last_occurred_at: '2026-08-01T10:00:00.000Z',
        created_at: '2026-08-01T10:00:00.000Z', updated_at: '2026-08-01T10:00:00.000Z',
      }),
    ).toThrow();
  });

  it('falls back to the subscription\'s known owner when custom_data is absent', () => {
    const { db, deps } = world();
    deliver(deps, frame()); // sub_A ← u1, via custom_data
    const out = deliver(deps, frame({
      event_id: 'evt_2',
      event_type: 'subscription.updated',
      occurred_at: '2026-08-01T11:00:00.000000Z',
      data: subscriptionData({ custom_data: {} }), // Paddle omits it on later events
    }));
    expect(out.body).toMatchObject({ outcome: 'applied' });
    expect(db.billing.getSubscription('sub_A')?.user_id).toBe('u1');
  });
});

describe('⑤ occurred_at is normalized, and the ordering guard rests on it', () => {
  it('🔴 a +08:00 delivery and the same instant in Z land on the SAME stored string', () => {
    // Lane A's pushback: the column is compared AS TEXT, so an offset would sort three
    // hours away from its own instant and disarm the guard for everything after.
    expect(normalizeRfc3339('2026-08-01T18:00:00+08:00')).toBe(normalizeRfc3339('2026-08-01T10:00:00Z'));
    expect(normalizeRfc3339('2026-08-01T18:00:00+08:00')).toBe('2026-08-01T10:00:00.000Z');

    const { db, deps } = world();
    deliver(deps, frame({ occurred_at: '2026-08-01T18:00:00+08:00' }));
    expect(db.billing.getSubscription('sub_A')?.last_occurred_at).toBe('2026-08-01T10:00:00.000Z');
  });

  it('every normalized stamp is the same width, which is what makes TEXT sorting chronological', () => {
    const stamps = [
      '2026-08-01T10:00:00Z',
      '2026-08-01T10:00:00.1Z',
      '2026-08-01T10:00:00.123456Z',
      '2026-08-01T18:00:00+08:00',
      '2026-12-31T23:59:59.999Z',
    ].map((s) => normalizeRfc3339(s));
    expect(stamps.every((s) => s !== null && s.length === 24)).toBe(true);
    // …and the text order really is the time order.
    const sorted = [...stamps].sort();
    expect(sorted[sorted.length - 1]).toBe('2026-12-31T23:59:59.999Z');
  });

  it('🔴 a strictly OLDER event does not overwrite newer state — it is recorded as stale', () => {
    const { db, deps } = world();
    // Newer first (the out-of-order delivery webhooks do not promise not to do).
    deliver(deps, frame({ event_id: 'evt_new', occurred_at: '2026-08-01T12:00:00.000000Z', data: subscriptionData({ status: 'canceled' }) }));
    expect(db.billing.getSubscription('sub_A')?.status).toBe('canceled');

    const out = deliver(deps, frame({ event_id: 'evt_old', occurred_at: '2026-08-01T10:00:00.000000Z', data: subscriptionData({ status: 'active' }) }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ outcome: 'stale' });
    // The state did NOT move back…
    expect(db.billing.getSubscription('sub_A')?.status).toBe('canceled');
    // …and the drop left a trace (discard must leave a trail).
    const stale = ledger(db, 'u1').find((r) => r.event_id === 'evt_old');
    expect(stale?.outcome).toBe('stale');
    expect(stale?.detail).toContain('older');
  });

  it('a NEWER event still applies — the positive control for the guard', () => {
    const { db, deps } = world();
    deliver(deps, frame({ event_id: 'evt_1', occurred_at: '2026-08-01T10:00:00.000000Z' }));
    deliver(deps, frame({
      event_id: 'evt_2', occurred_at: '2026-08-01T12:00:00.000000Z',
      data: subscriptionData({ status: 'paused' }),
    }));
    expect(db.billing.getSubscription('sub_A')?.status).toBe('paused');
  });

  it('two events at the SAME normalized instant both apply (why the test is `<`, not `<=`)', () => {
    // Paddle stamps to the microsecond and we store milliseconds, so a genuine
    // pair like updated→canceled can collapse onto one string. Under `<=` the
    // second one would be silently dropped and the account would stay active
    // with no expiry, forever.
    const { db, deps } = world();
    deliver(deps, frame({ event_id: 'evt_upd', event_type: 'subscription.updated', occurred_at: '2026-08-01T10:00:00.000000Z' }));
    const out = deliver(deps, frame({
      event_id: 'evt_can', event_type: 'subscription.canceled', occurred_at: '2026-08-01T10:00:00.000900Z',
      data: subscriptionData({ status: 'canceled', canceled_at: '2026-08-01T10:00:00.000900Z' }),
    }));
    expect(out.body).toMatchObject({ outcome: 'applied' });
    expect(db.billing.getSubscription('sub_A')?.status).toBe('canceled');
  });
});

describe('the event table — what each family does to the row', () => {
  it('canceled keeps the period end that decides 「until when the tier is kept」', () => {
    const { db, deps } = world();
    deliver(deps, frame());
    deliver(deps, frame({
      event_id: 'evt_2', event_type: 'subscription.canceled', occurred_at: '2026-08-01T11:00:00.000000Z',
      data: subscriptionData({ status: 'canceled', canceled_at: '2026-08-01T11:00:00.000000Z' }),
    }));
    const row = db.billing.getSubscription('sub_A');
    expect(row?.status).toBe('canceled');
    expect(row?.canceled_at).toBe('2026-08-01T11:00:00.000Z');
    expect(row?.current_period_end).toBe('2026-09-01T00:00:00.000Z'); // benefits run to here
    expect(row?.tier).toBe('pro'); // this round does not downgrade — expiry is BillingService's call
  });

  it('🔴 resumed CLEARS canceled_at, because an explicit null is not 「not mentioned」', () => {
    const { db, deps } = world();
    deliver(deps, frame({
      event_type: 'subscription.canceled',
      data: subscriptionData({ status: 'canceled', canceled_at: '2026-08-01T10:00:00.000000Z' }),
    }));
    expect(db.billing.getSubscription('sub_A')?.canceled_at).not.toBeNull();

    deliver(deps, frame({
      event_id: 'evt_2', event_type: 'subscription.resumed', occurred_at: '2026-08-01T11:00:00.000000Z',
      data: subscriptionData({ status: 'active', canceled_at: null }),
    }));
    // A merge that treated `null` as 「no news」 would leave this subscription
    // flagged cancelled forever.
    expect(db.billing.getSubscription('sub_A')?.canceled_at).toBeNull();
  });

  it('an OMITTED field keeps its stored value — the other half of that distinction', () => {
    const { db, deps } = world();
    deliver(deps, frame());
    const data = subscriptionData({ status: 'past_due' });
    delete data.current_billing_period; // Paddle simply does not mention it
    deliver(deps, frame({ event_id: 'evt_2', event_type: 'subscription.past_due', occurred_at: '2026-08-01T11:00:00.000000Z', data }));
    const row = db.billing.getSubscription('sub_A');
    expect(row?.status).toBe('past_due');
    expect(row?.current_period_end).toBe('2026-09-01T00:00:00.000Z'); // NOT wiped
    expect(row?.tier).toBe('pro'); // this round does not downgrade (Paddle is still retrying the charge)
  });

  it('ledger-only events are recorded as applied, and change no subscription state', () => {
    const { db, deps } = world();
    deliver(deps, frame());
    const before = db.billing.getSubscription('sub_A');
    for (const [id, type] of [['evt_pf', 'transaction.payment_failed'], ['evt_adj', 'adjustment.created']] as const) {
      const out = deliver(deps, frame({
        event_id: id, event_type: type, occurred_at: '2026-08-01T13:00:00.000000Z',
        data: { id: 'txn_1', subscription_id: 'sub_A' },
      }));
      expect(out.body).toMatchObject({ outcome: 'applied' });
    }
    // The state is byte-identical — 「record only, do not change the tier」 out loud.
    expect(db.billing.getSubscription('sub_A')).toEqual(before);
    const rows = ledger(db, 'u1');
    expect(rows.filter((r) => r.detail?.includes('ledger-only'))).toHaveLength(2);
    // …and they are attributed to the right human, via data.subscription_id
    // (NOT data.id, which is a txn_/adj_ id and would never match).
    expect(rows.filter((r) => r.user_id === 'u1')).toHaveLength(3);
  });

  it('records the cycle Paddle actually sent, and does not round an odd one into monthly', () => {
    const { db, deps } = world();
    deliver(deps, frame({ data: subscriptionData({ billing_cycle: { interval: 'year', frequency: 1 } }) }));
    expect(db.billing.getSubscription('sub_A')?.cycle).toBe('yearly');

    const w2 = world();
    deliver(w2.deps, frame({ data: subscriptionData({ billing_cycle: { interval: 'month', frequency: 3 } }) }));
    // A quarterly plan recorded as 「monthly」 is a wrong renewal date shown to a
    // paying user; the column is `string | null` so the truth has somewhere to go.
    expect(w2.db.billing.getSubscription('sub_A')?.cycle).toBe('3xmonth');
  });

  it('two subscriptions for one user stay separate rows, newest wins latestForUser', () => {
    const { db, deps } = world();
    deliver(deps, frame({ event_id: 'evt_a', occurred_at: '2026-08-01T10:00:00.000000Z' }));
    deliver(deps, frame({
      event_id: 'evt_b', occurred_at: '2026-08-02T10:00:00.000000Z',
      data: subscriptionData({ id: 'sub_B', items: [{ price: { id: PRICE_MAX } }] }),
    }));
    expect(db.billing.getSubscription('sub_A')?.tier).toBe('pro');
    expect(db.billing.getSubscription('sub_B')?.tier).toBe('max');
    expect(db.billing.latestForUser('u1')?.subscription_id).toBe('sub_B');
  });
});

describe('🔴 the skew is logged on EVERY verification, and the secret on none', () => {
  it('logs the skew when the signature passes and when it fails', () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const { deps } = world({ now: () => NOW_MS + 2_000 });
      deliver(deps, frame()); // passes, skew 2
      deliver(deps, frame({ event_id: 'evt_2' }), `ts=${TS};h1=${'0'.repeat(64)}`); // fails, skew 2
      const logged = writes.join('');
      // Positive controls first — both branches really did log.
      expect(logged).toMatch(/paddle webhook: signature ok/);
      expect(logged).toMatch(/paddle webhook: signature refused/);
      // The number itself, on BOTH. A ruler only kept on the good days is no ruler.
      expect(logged.match(/"ts_skew_sec":2\b/g)?.length).toBe(2);
      // 🔴 and never the secret.
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain(SECRET.slice(0, 16));
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ── ⑥ yearly (Window D1 Lane H) ─────────────────────────────────────────────────
//
// owner has four sandbox prices, two of them annual ($60 pro / $200 max), and his
// ruling for this round is 「test yearly first… do not ship it in release phases 1 and 2」 — so the code
// path has to be provably correct BEFORE anyone can buy it. Nothing here touches
// a user-visible surface; it only pins what the server does when such an event
// arrives.
//
// Two failures are specific to yearly and neither is visible from a monthly test:
//   · a NON-1 frequency rounded into 「yearly」;
//   · the tier landing correctly while the EXPIRY is a month out. That one is
//     silent for four weeks and then downgrades someone who paid for a year,
//     which is the most expensive shape of 「the UI shows upgraded but the server did not take effect」.
//
// ⚠️ WHAT `cycle` IS AND IS NOT, greppable rather than assumed (2026-08-01, Lane
// H). `paddle_subscriptions.cycle` has exactly ONE reader in the whole server —
// `asCycle` in billing-service.ts, which copies it into `PlanView.cycle` for the
// API read-out — and ZERO views render it (`grep -rn cycle` over the web repo's
// src/views + src/components: 0 hits). The ONLY place a date is derived from a
// cycle is `mockConfirm`'s CYCLE_MS, which belongs to the mock machine and never
// sees a Paddle row. So a mislabelled cadence today is a wrong WORD in an API
// response and a wrong reconciliation against Paddle's dashboard — NOT a wrong
// renewal date, because nothing computes one. The expiry comes from
// `current_period_end` alone. That is stated here rather than left as an implied
// consequence because book 13 §7 F1 ④ is precisely 「the sentence in a comment that defends a design is itself
// a grep-falsifiable assertion」; the tests below stand guard for the day someone
// DOES compute from this column, and that is a real reason without inventing a
// caller that does not exist.

const DAY_MS = 86_400_000;
const YEARLY = { interval: 'year', frequency: 1 };
const MONTHLY = { interval: 'month', frequency: 1 };

/** A `current_billing_period` running `days` from the fixed test clock. */
function periodEndingIn(days: number): Record<string, unknown> {
  return { starts_at: new Date(NOW_MS).toISOString(), ends_at: new Date(NOW_MS + days * DAY_MS).toISOString() };
}

/** The REAL resolver, over the row the handler just wrote — 「which tier, until when,
 *  how large is the gate」 is BillingService's question and asking it here is what makes this a
 *  test of the CONSEQUENCE rather than of a column's spelling. */
function resolver(db: ReturnType<typeof world>['db'], nowMs: number): BillingService {
  return new BillingService({
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    billing: db.billing,
    unlockAll: false,
    now: () => nowMs,
  });
}

describe('⑥ 🔴 yearly — the cycle Paddle sent, and the expiry it must not shorten', () => {
  it('year/1 ⇒ `yearly` and month/1 ⇒ `monthly`, asserted together', () => {
    // Both in ONE test on purpose: a build that answered 「yearly」 to everything
    // would pass a yearly-only assertion, and one that answered 「monthly」 to
    // everything would pass a monthly-only one. Each is the other's control.
    const y = world();
    deliver(y.deps, frame({ data: subscriptionData({ billing_cycle: YEARLY, current_billing_period: periodEndingIn(365) }) }));
    expect(y.db.billing.getSubscription('sub_A')?.cycle).toBe('yearly');

    const m = world();
    deliver(m.deps, frame({ data: subscriptionData({ billing_cycle: MONTHLY, current_billing_period: periodEndingIn(30) }) }));
    expect(m.db.billing.getSubscription('sub_A')?.cycle).toBe('monthly');
  });

  it('🔴 ANY frequency other than 1 is kept verbatim — never rounded into `yearly`', () => {
    // 「yearly」 is `year × 1` and nothing else. `paddle_subscriptions.cycle` is
    // free text precisely so an unforeseen cadence (biennial, quarterly) has
    // somewhere honest to go instead of being rounded to the nearest word we
    // recognise — see the ⚠️ note above for what that word does and does not
    // drive today.
    for (const [bc, expected] of [
      [{ interval: 'year', frequency: 2 }, '2xyear'],
      [{ interval: 'year', frequency: 0 }, '0xyear'],
      [{ interval: 'year', frequency: 1.5 }, '?xyear'],
      [{ interval: 'year', frequency: '1' }, '?xyear'], // a STRING 1 is not 1
      [{ interval: 'month', frequency: 6 }, '6xmonth'],
    ] as const) {
      const label = JSON.stringify(bc);
      const w = world();
      deliver(w.deps, frame({ data: subscriptionData({ billing_cycle: bc, current_billing_period: periodEndingIn(365) }) }));
      const stored = w.db.billing.getSubscription('sub_A')?.cycle;
      expect(stored, label).toBe(expected);
      expect(stored, label).not.toBe('yearly');
      expect(stored, label).not.toBe('monthly');
      // …and the READ-OUT says 「we do not know the cycle」 rather than inventing
      // one: asCycle narrows by test, so an unrecognised cadence is null.
      expect(resolver(w.db, NOW_MS).getPlan('u1').cycle, label).toBeNull();
    }
  });

  it('🔴 an absent or explicitly-null billing_cycle never becomes `monthly`', () => {
    // At the source, where the three-way distinction lives: 「not mentioned」 (undefined,
    // keep what the row has) and 「said empty」 (null, clear it) are two different
    // instructions and NEITHER of them is a default cadence.
    const absent = subscriptionData();
    delete absent.billing_cycle;
    expect(readSubscriptionFacts('subscription.activated', absent).cycle).toBeUndefined();
    expect(readSubscriptionFacts('subscription.activated', subscriptionData({ billing_cycle: null })).cycle).toBeNull();
    // A billing_cycle that is present but unreadable reads as 「not mentioned」 rather than
    // 「said empty」 — destroying a stored value on the strength of a value we could
    // not parse is the more damaging of the two mistakes.
    expect(readSubscriptionFacts('subscription.activated', subscriptionData({ billing_cycle: 'yearly' })).cycle).toBeUndefined();

    // …and the consequence, on the real row: a later event that omits the cycle
    // must not silently re-file a yearly subscriber as monthly.
    const w = world();
    deliver(w.deps, frame({ data: subscriptionData({ billing_cycle: YEARLY, current_billing_period: periodEndingIn(365) }) }));
    expect(w.db.billing.getSubscription('sub_A')?.cycle).toBe('yearly');

    const later = subscriptionData({ status: 'past_due', current_billing_period: periodEndingIn(365) });
    delete later.billing_cycle; // Paddle simply does not mention it
    deliver(w.deps, frame({ event_id: 'evt_2', event_type: 'subscription.past_due', occurred_at: '2026-08-01T11:00:00.000000Z', data: later }));
    expect(w.db.billing.getSubscription('sub_A')?.cycle).toBe('yearly');
    expect(resolver(w.db, NOW_MS).getPlan('u1').cycle).toBe('yearly');

    // The other half of the distinction, as the positive control for the line
    // above: an EXPLICIT null really does clear the column.
    deliver(w.deps, frame({
      event_id: 'evt_3', event_type: 'subscription.updated', occurred_at: '2026-08-01T12:00:00.000000Z',
      data: subscriptionData({ billing_cycle: null, current_billing_period: periodEndingIn(365) }),
    }));
    expect(w.db.billing.getSubscription('sub_A')?.cycle).toBeNull();
    expect(resolver(w.db, NOW_MS).getPlan('u1').cycle).toBeNull();
  });

  it('🔴 a yearly subscriber expires a YEAR out — and is still paid up two months in', () => {
    const period = periodEndingIn(365);
    const w = world();
    deliver(w.deps, frame({ data: subscriptionData({ billing_cycle: YEARLY, current_billing_period: period }) }));

    const view = resolver(w.db, NOW_MS).getPlan('u1');
    expect(view).toMatchObject({ plan: 'pro', source: 'paddle', cycle: 'yearly', state: 'active' });
    // The date is PADDLE's, stored verbatim. Nothing on this path derives an
    // expiry from the cycle — BillingService's CYCLE_MS table belongs to the mock
    // machine and must never reach a paid row (that is the whole bug this test
    // exists for: the tier is right, the expiry is computed as monthly).
    expect(view.expires_at).toBe(period.ends_at);
    expect(Date.parse(String(view.expires_at)) - NOW_MS).toBeGreaterThan(300 * DAY_MS);

    // 🔴 THE FAILURE, stated as an OUTCOME rather than as a string comparison: two
    // months in, a build that filed this as monthly has already cut a customer who
    // paid for a year down to free.
    const twoMonthsIn = resolver(w.db, NOW_MS + 60 * DAY_MS);
    expect(twoMonthsIn.getPlan('u1')).toMatchObject({ plan: 'pro', state: 'active', cycle: 'yearly' });
    // The LABEL and the GATE, separately (Window D1 §4 rule 2: a test that only asserts the label is green on 「the label moved, the gate did not」).
    expect(twoMonthsIn.getQuota('u1').stt.limit_min).toBe(900);
    expect(twoMonthsIn.effectiveLimits('u1').llm_tokens).toBe(20_000_000);
  });

  it('positive control: a MONTHLY subscriber at that same clock IS expired', () => {
    // Without this, every assertion above could pass on a build where expiry
    // never fires at all.
    const w = world();
    deliver(w.deps, frame({ data: subscriptionData({ billing_cycle: MONTHLY, current_billing_period: periodEndingIn(30) }) }));
    const twoMonthsIn = resolver(w.db, NOW_MS + 60 * DAY_MS);
    expect(twoMonthsIn.getPlan('u1')).toMatchObject({ plan: 'free', source: 'paddle', state: 'expired', cycle: 'monthly' });
    expect(twoMonthsIn.getQuota('u1').stt.limit_min).toBe(20);
  });

  it('the tier and the cycle are two independent answers (max, yearly)', () => {
    // The tier comes from the price mapping and the cycle from billing_cycle;
    // a build that inferred one from the other would pass every monthly test.
    const w = world();
    deliver(w.deps, frame({
      data: subscriptionData({
        items: [{ price: { id: PRICE_MAX } }],
        billing_cycle: YEARLY,
        current_billing_period: periodEndingIn(365),
      }),
    }));
    const billing = resolver(w.db, NOW_MS);
    expect(billing.getPlan('u1')).toMatchObject({ plan: 'max', cycle: 'yearly', source: 'paddle' });
    expect(billing.getQuota('u1').stt.limit_min).toBe(3_000);
    expect(billing.effectiveLimits('u1').llm_tokens).toBe(100_000_000);
  });
});
