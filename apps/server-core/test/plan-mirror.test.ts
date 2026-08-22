// 🔴 0.2.38 F-2 — `users.plan` is the column the JWT `plan` claim is minted from,
// and a Paddle upgrade never wrote it.
//
// The failure this file exists to keep dead: a customer pays, the webhook applies,
// `paddle_subscriptions` says `pro`, `effectiveLimits` enforces pro's numbers —
// and the token handed out at the next login still claims `free`, so the desktop
// badge says FREE and the phone says "免费". D1 §0's headline red line "the UI shows upgraded
// but the server did not take effect" with the sides swapped, and invisible to every existing test
// because nothing ENFORCES on that column (enforcement rides effectiveLimits), so
// the only symptom is a string on a screen.
//
// Two levels, deliberately:
//   · the SERVICE level pins the write discipline (one writer, write-on-change,
//     permanent_free stays 'free');
//   · the END-TO-END level pins the thing that was actually broken, over a REAL
//     saas server: signed webhook in at the public ingress, `POST /api/login`
//     out, and the assertion is made on the DECODED JWT. Asserting on
//     `users.plan` alone would prove the mirror moved without proving the token
//     it exists for moved with it.
//
// SPEC-REF: docs/strategy/2026-08-01-d1-paddle-sandbox-design.md §6.1 (the one source of truth),
//           §6.1-bis (permanent_free is an exemption, not a tier), §5.3 (webhook pipeline)

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { verifyJwt } from '../src/auth/jwt';
import { BillingService } from '../src/billing/billing-service';
import { signPaddlePayload } from '../src/billing/paddle/signature';
import { resetPlanLimits } from '../src/billing/plans';
import { loadConfig } from '../src/config';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import type { PaddleSubRow } from '../src/db/repos/billing.repo';
import type { UserRepo } from '../src/db/repos/user.repo';

const DEPLOY_SECRET = 'plan-mirror-deploy-secret-32-bytes!!';
const WEBHOOK_SECRET = 'pdl_ntfset_TESTONLY_not_a_real_secret';
const PRICE_PRO = 'pri_pro_monthly_test';
const PRICE_MAX = 'pri_max_monthly_test';
const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const DAY = 86_400_000;

// ───────────────────────── service level ─────────────────────────

describe('F-2 · the write discipline (service level)', () => {
  let db: DbConnection;
  let planWrites: number;
  let billing: BillingService;

  /** The real UserRepo with a counter on the ONE method that writes the column,
   *  so "must not trigger extra DB writes" is measured rather than asserted by reading. */
  function countingUsers(inner: UserRepo): UserRepo {
    return {
      ...inner,
      setPlan(id, plan) {
        planWrites += 1;
        return inner.setPlan(id, plan);
      },
    };
  }

  function sub(over: Partial<PaddleSubRow> = {}): PaddleSubRow {
    const iso = new Date(NOW).toISOString();
    return {
      subscription_id: 'sub_mirror',
      user_id: 'u1',
      customer_id: 'ctm_1',
      status: 'active',
      tier: 'pro',
      price_id: PRICE_PRO,
      cycle: 'monthly',
      current_period_end: new Date(NOW + 30 * DAY).toISOString(),
      canceled_at: null,
      scheduled_change_action: null,
      scheduled_change_at: null,
      next_billed_at: null,
      contract_concluded_at: null,
      last_event_id: 'evt_1',
      last_occurred_at: iso,
      created_at: iso,
      updated_at: iso,
      ...over,
    };
  }

  beforeEach(() => {
    planWrites = 0;
    db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey(DEPLOY_SECRET) });
    db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
    billing = new BillingService({
      settings: db.settings,
      users: countingUsers(db.users),
      usage: db.usage,
      billing: db.billing,
      unlockAll: false,
      now: () => NOW,
    });
  });
  afterEach(() => db.close());

  it('a paddle row moves the column to the resolved tier', () => {
    db.billing.upsertSubscription(sub({ tier: 'max', price_id: PRICE_MAX }));
    expect(billing.getPlan('u1').plan).toBe('max');
    expect(db.users.findById('u1')?.plan).toBe('max');
  });

  it('🔴 writes only on CHANGE — resolve() runs on every quota check', () => {
    db.billing.upsertSubscription(sub());
    billing.getPlan('u1');
    expect(planWrites).toBe(1); // free → pro
    for (let i = 0; i < 10; i += 1) billing.effectiveLimits('u1');
    // Positive control that those ten calls really did resolve: they are the same
    // calls that produced the answer below, so a zero here cannot mean "nothing ran".
    expect(billing.effectivePlan('u1')).toBe('pro');
    expect(planWrites).toBe(1);
  });

  it('an expired subscription pulls the column back down to free', () => {
    db.billing.upsertSubscription(sub());
    billing.getPlan('u1');
    expect(db.users.findById('u1')?.plan).toBe('pro');

    db.billing.upsertSubscription(sub({ current_period_end: new Date(NOW - 1000).toISOString() }));
    expect(billing.getPlan('u1').plan).toBe('free');
    expect(db.users.findById('u1')?.plan).toBe('free');
  });

  it('🔴 a permanent_free account mirrors "free", even holding a max row', () => {
    // §6.1-bis: owner bought nothing, so 'free' is the true tier and the exemption
    // lives in `source` + `quota_exempt`. Writing 'max' here would put a purchase
    // on his account that never happened — and would then ride into his JWT.
    db.users.setPermanentFree('u1', true);
    db.billing.upsertSubscription(sub({ tier: 'max', price_id: PRICE_MAX }));
    const view = billing.getPlan('u1');
    expect(view).toMatchObject({ plan: 'free', source: 'permanent_free', quota_exempt: true });
    expect(db.users.findById('u1')?.plan).toBe('free');
    expect(planWrites).toBe(0); // it was already 'free' — nothing to write
  });

  it('the mock machine no longer writes the column itself (one writer, not two)', () => {
    // Every mock trigger used to pass a hand-written literal to writeSub. The
    // column now moves only through the mirror, so the mock path and the paddle
    // path cannot disagree about what 'plan' means.
    const { sessionId } = billing.mockCheckout('u1', 'monthly');
    expect(db.users.findById('u1')?.plan).toBe('free'); // pending grants nothing
    billing.mockConfirm('u1', sessionId);
    expect(db.users.findById('u1')?.plan).toBe('pro');
    billing.mockExpire('u1');
    expect(db.users.findById('u1')?.plan).toBe('free');
  });
});

// ───────────────────────── end to end ─────────────────────────

interface World {
  boot: BootstrapHandle;
  base: string;
}

async function bootSaas(): Promise<World> {
  resetPlanLimits(); // loadConfig installs a table as a side effect
  const config = loadConfig({
    mode: 'saas',
    port: 0,
    dbPath: ':memory:',
    secret: DEPLOY_SECRET,
    // fix-010: an in-process server has no proxy in front of it — its direct peer
    // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
    trustedProxies: [],
    paddle: {
      enabled: true,
      webhookSecret: WEBHOOK_SECRET,
      toleranceSec: 5,
      priceTiers: { [PRICE_PRO]: 'pro', [PRICE_MAX]: 'max' },
    },
  });
  const boot = await startServer(config);
  return { boot, base: `http://127.0.0.1:${boot.port}` };
}

async function register(w: World, email: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`${w.base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { id: body.user.id, token: body.token };
}

/** The claim as a CLIENT would read it — decoded and verified with the same
 *  deployment secret the server signs with. */
async function loginPlan(w: World, email: string): Promise<string> {
  const res = await fetch(`${w.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return verifyJwt(body.token, { secret: Buffer.from(DEPLOY_SECRET, 'utf8') }).plan;
}

let eventSeq = 0;

/** A correctly signed Paddle notification at the PUBLIC ingress — the same path
 *  Paddle uses. Nothing here reaches into the DB. */
async function webhook(
  w: World,
  opts: { userId: string; priceId: string; endsAt: string; status?: string; type?: string },
): Promise<number> {
  eventSeq += 1;
  const body = JSON.stringify({
    event_id: `evt_mirror_${eventSeq}`,
    event_type: opts.type ?? 'subscription.activated',
    // Strictly increasing, so the out-of-order guard never refuses a later event in a test.
    occurred_at: new Date(NOW + eventSeq * 1000).toISOString(),
    notification_id: `ntf_mirror_${eventSeq}`,
    data: {
      id: 'sub_E2E',
      status: opts.status ?? 'active',
      customer_id: 'ctm_e2e',
      items: [{ price: { id: opts.priceId } }],
      current_billing_period: { ends_at: opts.endsAt },
      custom_data: { flowmic_user_id: opts.userId },
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`${w.base}/api/paddle/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'paddle-signature': `ts=${ts};h1=${signPaddlePayload(body, ts, WEBHOOK_SECRET)}`,
    },
    body,
  });
  const json = (await res.json()) as { outcome?: string };
  expect(json.outcome).toBe('applied'); // the premise of every assertion below
  return res.status;
}

const FUTURE = new Date(Date.now() + 30 * DAY).toISOString();
const PAST = new Date(Date.now() - 30 * DAY).toISOString();

describe('F-2 · 🔴 the token a paying customer is handed at the next login', () => {
  let w: World;
  beforeEach(async () => {
    w = await bootSaas();
  });
  afterEach(async () => {
    await w.boot.close();
  });

  it('① paddle grants pro ⇒ the NEXT login mints plan:"pro"', async () => {
    const email = 'pro@flowmic.test';
    const { id } = await register(w, email);
    expect(await loginPlan(w, email)).toBe('free'); // the before-picture

    expect(await webhook(w, { userId: id, priceId: PRICE_PRO, endsAt: FUTURE })).toBe(200);

    // No plan question in between — the webhook itself is what has to have moved
    // the column, because a customer who pays and then signs in on the desktop
    // asks nothing else first.
    expect(await loginPlan(w, email)).toBe('pro');
  });

  it('② paddle grants max ⇒ plan:"max" (three tiers, not a two-way flag)', async () => {
    const email = 'max@flowmic.test';
    const { id } = await register(w, email);
    expect(await webhook(w, { userId: id, priceId: PRICE_MAX, endsAt: FUTURE })).toBe(200);
    expect(await loginPlan(w, email)).toBe('max');
  });

  it('③ once the period end has passed ⇒ back to plan:"free"', async () => {
    const email = 'lapsed@flowmic.test';
    const { id } = await register(w, email);
    await webhook(w, { userId: id, priceId: PRICE_PRO, endsAt: FUTURE });
    expect(await loginPlan(w, email)).toBe('pro');

    await webhook(w, {
      userId: id,
      priceId: PRICE_PRO,
      endsAt: PAST,
      status: 'canceled',
      type: 'subscription.canceled',
    });
    expect(await loginPlan(w, email)).toBe('free');
  });

  it('④ a permanent_free account is ALWAYS plan:"free", whatever Paddle says', async () => {
    const email = 'owner@flowmic.test';
    const { id } = await register(w, email);
    w.boot.db.users.setPermanentFree(id, true);
    await webhook(w, { userId: id, priceId: PRICE_MAX, endsAt: FUTURE });

    expect(await loginPlan(w, email)).toBe('free');
    // ...and the exemption is still in force — 'free' in the claim is not 'free'
    // in the enforcement. Without this the assertion above could pass because the
    // exemption had been quietly dropped.
    // 2026-08-07: was 「not finite」. The exemption is MAX's 3,000 min now (owner's
    // ruling ①), so the assertion is the NUMBER — and 3,000 is still provably not
    // what the 'free' claim above would have produced (that is 20).
    expect(w.boot.billing.effectiveLimits(id).stt_minutes).toBe(3_000);
    expect(w.boot.billing.getPlan(id).source).toBe('permanent_free');
  });
});
