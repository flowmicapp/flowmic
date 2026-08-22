// SPEC-REF:
//   apps/server-core/src/billing/paddle/client.ts (the interface it stands in for)
//   docs/strategy/2026-08-21-0325-console-subscription-compliance-design.md §3.2
//   docs/strategy/2026-07-23-mock-billing-design.md (the precedent: a mock that
//     is honest about being a mock, and refuses to serve where it must not)
//   *** HUMAN-AUDIT SENSITIVE (billing) — reviewable in isolation ***
//
// A PADDLE STAND-IN THAT LIVES IN THIS PROCESS.
//
// It exists so the whole chain — console click, route, cancel, refund, email,
// state read-back — can be driven and watched without credentials, a network, or
// a sandbox account. Without it the only way to exercise these paths is a unit
// test holding a hand-written fake, and this repo has written down twice what
// that is worth: 「测试把我们的假设念回给我们听」 (the Soniox FakeWs round) and
// 「单测全绿对『接线』零证明力」 (book 13 §7 F1 ③).
//
// ── 🔴 WHAT THIS CAN AND CANNOT PROVE ──────────────────────────────────────
// CAN: that our routes call the right operations in the right order, that a
//   withdrawal really does BOTH halves, that a refusal reaches the user as a
//   sentence, that the console renders the state that comes back, and that
//   nothing crashes end to end.
// CANNOT: that Paddle behaves the way this file says it does. Every rule below
//   is OUR READING of Paddle's documentation, and a mock built from a reading
//   agrees with the reading by construction. A green run here is evidence about
//   OUR code and no evidence at all about theirs.
// ⇒ anything verified only against this file is 「mock-verified, real link
//   unproven」 and must be written down that way. It does not become 「verified」
//   until it has run against a real sandbox account.
//
// ── WHY IT REFUSES PRODUCTION ──────────────────────────────────────────────
// `resolvePaddleClient` will not build this against `FLOWMIC_PADDLE_ENV=production`.
// A mock that silently stood in for the real thing on a production box would
// report every cancellation as successful while cancelling nothing, and every
// refund as requested while refunding nothing — the single worst failure this
// whole round exists to prevent, produced by the tool built to prevent it. The
// mock-billing gateway takes the same shape: it refuses to mount under saas
// rather than trusting nobody will set the flag.

import { log } from '../../log';
import {
  PADDLE_REJECTED,
  PaddleWritesDisabledError,
  type CancelEffectiveFrom,
  type FoundTransaction,
  type PaddleAdjustmentSnapshot,
  type PaddleClient,
  type PaddleSubscriptionSnapshot,
  type PaddleWriteResult,
  type RefundInput,
} from './client';

/** One subscription in the stand-in's world. */
interface MockSub {
  id: string;
  status: string;
  scheduledAction: string | null;
  scheduledAt: string | null;
  nextBilledAt: string | null;
  periodEnd: string;
}

export interface MockPaddleOptions {
  /** Mirrors the real client: OFF still throws. The switch is what is being
   *  tested as often as the calls are, so the mock must honour it or the test
   *  that proves 「off refuses by name」 would be testing nothing. */
  writeEnabled: boolean;
  now?: () => number;
  /** Seed subscriptions. A subscription the mock has never heard of is REJECTED,
   *  not invented — see `mustFind`. */
  seed?: readonly { id: string; periodEnd: string; status?: string }[];
  /**
   * Adopt a subscription the mock has not seen, by asking the real database.
   *
   * 🔴 IT IS A LOOKUP, NOT AN AUTO-CREATE, and the difference is the point. A
   * dev process starts with whatever subscriptions the local DB already holds,
   * and enumerating them up front would mean re-reading the table at boot and
   * going stale the moment a webhook writes a new row. Asking on demand keeps
   * the two in step. What it does NOT do is invent: an id the database does not
   * have still returns 「entity not found」, so 「we sent the wrong id」 — the most
   * likely real bug in this area — stays visible instead of being absorbed.
   */
  lookup?: (subscriptionId: string) => { periodEnd: string; status?: string } | null;
}

export interface MockPaddleClient extends PaddleClient {
  /** Test/diagnostic view of what the stand-in believes. Never used by
   *  production code — the real client has no such method, so anything that
   *  reaches for it will not compile against `PaddleClient`. */
  readonly state: () => readonly MockSub[];
  /** Every operation, in order, with its argument. This is what makes 「did the
   *  withdrawal really do BOTH halves」 an assertion rather than a hope. */
  readonly calls: () => readonly { op: string; arg: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createMockPaddleClient(opts: MockPaddleOptions): MockPaddleClient {
  const now = opts.now ?? Date.now;
  const subs = new Map<string, MockSub>();
  const calls: { op: string; arg: string }[] = [];
  let adjustmentSeq = 0;

  for (const s of opts.seed ?? []) {
    subs.set(s.id, {
      id: s.id,
      status: s.status ?? 'active',
      scheduledAction: null,
      scheduledAt: null,
      nextBilledAt: s.periodEnd,
      periodEnd: s.periodEnd,
    });
  }

  function gate(op: string, arg: string): void {
    if (!opts.writeEnabled) throw new PaddleWritesDisabledError(op);
    calls.push({ op, arg });
  }

  /** 🔴 An unknown id is a REJECTION, not an auto-created subscription. A mock
   *  that conjures whatever it is asked about would make 「we sent the wrong id」
   *  — the single most likely real bug in this area — invisible, and would pass
   *  a test suite while the production call 404s. */
  function mustFind(id: string): MockSub | PaddleWriteResult<never> {
    const known = subs.get(id);
    if (known !== undefined) return known;
    const adopted = opts.lookup?.(id) ?? null;
    if (adopted === null) {
      return { ok: false, code: PADDLE_REJECTED, detail: 'http 404 / entity_not_found (mock)' };
    }
    const fresh: MockSub = {
      id,
      status: adopted.status ?? 'active',
      scheduledAction: null,
      scheduledAt: null,
      nextBilledAt: adopted.periodEnd,
      periodEnd: adopted.periodEnd,
    };
    subs.set(id, fresh);
    return fresh;
  }

  function snapshot(s: MockSub): PaddleSubscriptionSnapshot {
    return {
      id: s.id,
      status: s.status,
      scheduled_change: s.scheduledAction === null ? null : { action: s.scheduledAction, effective_at: s.scheduledAt },
      next_billed_at: s.nextBilledAt,
    };
  }

  return {
    state: () => [...subs.values()].map((s) => ({ ...s })),
    calls: () => calls.map((c) => ({ ...c })),

    cancelSubscription(subscriptionId: string, effectiveFrom: CancelEffectiveFrom) {
      gate('cancelSubscription', `${subscriptionId}:${effectiveFrom}`);
      const found = mustFind(subscriptionId);
      if ('ok' in found) return Promise.resolve(found);
      // 🔴 A CANCELLED SUBSCRIPTION CANNOT BE CANCELLED AGAIN. Paddle refuses
      // this, and reproducing the refusal is not pedantry — it is what stops a
      // SECOND withdrawal from reaching the refund half and asking for the same
      // money back twice. Without it the mock happily re-cancels, the route
      // proceeds, and a duplicate refund request is created against a
      // transaction that already has one.
      //
      // ⚠️ MEASURED (2026-08-21): the end-to-end test drove withdraw twice and
      // got two `refund_requests` rows. The route was right — it stops when the
      // cancel fails — and the stand-in was wrong. A double refund is a real
      // amount of real money, so a stand-in that is generous here is worse than
      // no stand-in: it makes the safe path look tested.
      if (found.status === 'canceled') {
        return Promise.resolve({
          ok: false as const,
          code: PADDLE_REJECTED,
          detail: 'http 400 / subscription_update_when_canceled (mock)',
        });
      }
      if (effectiveFrom === 'immediately') {
        // Paddle's documented behaviour, reproduced exactly INCLUDING the part
        // that costs money: the status flips now and NOTHING IS REFUNDED. The
        // mock is deliberately not kind here — if it credited the unused period
        // the withdrawal route could forget its second call and still look
        // correct, which is the one bug this whole area must not ship.
        found.status = 'canceled';
        found.scheduledAction = null;
        found.scheduledAt = null;
        found.nextBilledAt = null;
      } else {
        // Scheduled: STILL ACTIVE. This is the fact `state` alone could not
        // carry, and the mock reproduces it so the console's two-fact rendering
        // is exercised rather than assumed.
        found.status = 'active';
        found.scheduledAction = 'cancel';
        found.scheduledAt = found.periodEnd;
        found.nextBilledAt = null;
      }
      return Promise.resolve({ ok: true as const, data: snapshot(found) });
    },

    clearScheduledChange(subscriptionId: string) {
      gate('clearScheduledChange', subscriptionId);
      const found = mustFind(subscriptionId);
      if ('ok' in found) return Promise.resolve(found);
      if (found.status === 'canceled') {
        // Already gone: Paddle cannot un-cancel a cancelled subscription, and
        // pretending otherwise here would hide a real dead end from the console.
        return Promise.resolve({ ok: false as const, code: PADDLE_REJECTED, detail: 'http 400 / subscription_update_when_canceled (mock)' });
      }
      found.scheduledAction = null;
      found.scheduledAt = null;
      found.nextBilledAt = found.periodEnd;
      return Promise.resolve({ ok: true as const, data: snapshot(found) });
    },

    findRefundableTransaction(subscriptionId: string): Promise<PaddleWriteResult<FoundTransaction>> {
      gate('findRefundableTransaction', subscriptionId);
      const found = mustFind(subscriptionId);
      if ('ok' in found) return Promise.resolve(found);
      // One completed charge, priced like the Pro tier. `billed_at` is derived
      // from the period end so it is always in the past relative to it.
      return Promise.resolve({
        ok: true as const,
        data: {
          found: {
            id: `txn_mock_${found.id.slice(-6)}`,
            amount_minor: 600,
            currency: 'USD',
            billed_at: new Date(Date.parse(found.periodEnd) - 30 * DAY_MS).toISOString(),
          },
        },
      });
    },

    createRefund(input: RefundInput): Promise<PaddleWriteResult<PaddleAdjustmentSnapshot>> {
      gate('createRefund', input.transaction_id);
      adjustmentSeq += 1;
      // 🔴 `pending_approval`, NOT `approved`. On a live account most refunds
      // wait for a human at Paddle, and the whole point of carrying that word
      // to the user is that nothing in between rounds 「requested」 up to
      // 「refunded」. A mock that answered `approved` would let a surface which
      // says 「your money has been returned」 pass every test we have.
      return Promise.resolve({
        ok: true as const,
        data: { id: `adj_mock_${adjustmentSeq}`, status: 'pending_approval' },
      });
    },

    getSubscription(subscriptionId: string) {
      gate('getSubscription', subscriptionId);
      const found = mustFind(subscriptionId);
      if ('ok' in found) return Promise.resolve(found);
      return Promise.resolve({ ok: true as const, data: snapshot(found) });
    },
  };
}

/** Boot-time announcement. Separate from the factory so a test can build a mock
 *  without shouting, while a PROCESS that runs on one always says so — a server
 *  quietly not talking to Paddle is exactly the thing an operator must not have
 *  to discover from behaviour. */
export function announceMockPaddle(): void {
  log.warn(
    'paddle client is the IN-PROCESS MOCK — no request will leave this machine. ' +
      'Cancellations and refunds are simulated: nothing is really cancelled, no money moves, ' +
      'and every success it reports is a success it invented.',
  );
}

/**
 * The `lookup` a dev process passes: 「ask the real database whether this
 * subscription exists, and if so when its period ends」.
 *
 * 🔴 Derived rather than invented, for one reason: a stand-in that does not know
 * the ids the console is showing answers 「entity not found」 to every real
 * request, and the hour that follows is spent debugging the stand-in. Derived
 * rather than ENUMERATED AT BOOT for another: the table changes under us every
 * time a webhook lands, and a snapshot taken at startup goes stale silently.
 */
export function lookupFromDb(
  getSubscription: (id: string) => { current_period_end: string | null; status: string } | null,
): (id: string) => { periodEnd: string; status?: string } | null {
  return (id) => {
    const row = getSubscription(id);
    if (row === null) return null;
    return {
      // A row with no period end is a real state (a `subscription.created` that
      // carried none). Thirty days out is a stand-in's guess and is labelled as
      // one here rather than being passed off as data.
      periodEnd: row.current_period_end ?? new Date(Date.now() + 30 * DAY_MS).toISOString(),
      status: row.status,
    };
  };
}
