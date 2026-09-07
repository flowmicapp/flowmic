// SPEC-REF:
//   apps/server-core/src/http/ops-subscription-routes.ts (the surface under test)
//   apps/server-core/src/http/billing-routes.ts (the self-service twin — same
//     writers, same provider-failure mapping)
//   docs/strategy/2026-08-31-lan-ops-console-third-party-spec.md §7 REQ-002
//
// POST /api/ops/subscriptions/{cancel,resume} — the operator's way to stop
// somebody being charged.
//
// ⚠️ WHAT THIS FILE DOES NOT TEST, for its siblings' reason: that the two routes
// refuse an ANONYMOUS caller. `console-admin-gate-coverage.test.ts` sweeps every
// route in its registry against a real bootstrapped server with a real
// anonymous request and a real ordinary account, and both of these are declared
// 'admin' there. The non-admin refusal IS re-asserted here because the card
// asked for it, and the weaker of the two answers is named as such: this one
// drives a hand-built verifier, so it proves the route calls the gate — not that
// the running server mounts it behind one.
//
// 🔴 THE ASSERTION IN HERE WORTH THE MOST is not any single status code: it is
// that the audit row exists BEFORE the provider is asked anything, and that a
// sink which throws leaves the provider untouched. An unrecorded change to a
// recurring charge is a payment nobody authorised on paper.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OPS_SUBSCRIPTION_NOTHING_SCHEDULED,
  OPS_SUBSCRIPTION_NOT_RECORDED,
  OPS_SUBSCRIPTION_TARGET_UNKNOWN,
  SUBSCRIPTION_CANCEL_ACTION,
  SUBSCRIPTION_CANCEL_ROUTE,
  SUBSCRIPTION_RESUME_ACTION,
  SUBSCRIPTION_RESUME_ROUTE,
  SUBSCRIPTION_TARGET_KIND,
  tryHandleOpsSubscriptionRoutes,
  type OpsSubscriptionRoutesDeps,
} from '../src/http/ops-subscription-routes';
import { BILLING_NO_SUBSCRIPTION, BILLING_WRITE_DISABLED } from '../src/http/billing-routes';
import { ADMIN_GATED_ROUTES, MUTATING_ADMIN_GATED_ROUTES } from '../src/http/ops-audit-trail';
import { stripTsComments as stripComments } from '../../../verify/lint/strip-ts-comments.mjs';
import type { PlanView } from '../src/billing/billing-service';
import type { SubscriptionSnapshot } from '../src/billing/subscription-writer';
import type { UserRecord } from '../src/db/repos/user.repo';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const ADMIN_ID = 'u-admin';
const TARGET_ID = 'u-target';
const SUB_ID = 'sub_live_1';
/** A value that exists ONLY inside `users.password_hash`. Same instrument
 *  ops-user-routes.test.ts uses: if it ever shows up in a response body, the
 *  projection leaked the column rather than 「the field name is absent」. */
const HASH_MARKER = 'HASH-MARKER-ops-subscription-routes';

function planView(over: Partial<PlanView> = {}): PlanView {
  return {
    plan: 'pro',
    source: 'paddle',
    quota_exempt: false,
    cycle: 'monthly',
    state: 'active',
    expires_at: '2026-10-01T00:00:00.000Z',
    scheduled_change: null,
    next_billed_at: '2026-10-01T00:00:00.000Z',
    withdrawal_deadline: null,
    paddle_subscription_id: SUB_ID,
    billing_provider: 'creem',
    ...over,
  } as unknown as PlanView;
}

const CANCEL_SCHEDULED = planView({
  scheduled_change: { action: 'cancel', effective_at: '2026-10-01T00:00:00.000Z' },
});

function targetUser(): UserRecord {
  return {
    id: TARGET_ID,
    email: 'target@example.com',
    display_name: 'T',
    plan: 'pro',
    password_hash: HASH_MARKER,
    is_admin: false,
    permanent_free: false,
    restricted_at: null,
    restriction_reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
  } as unknown as UserRecord;
}

type AuditRow = Parameters<OpsSubscriptionRoutesDeps['audit']['append']>[0];

interface Rig {
  deps: OpsSubscriptionRoutesDeps;
  audit: AuditRow[];
  /** Every provider call, in order, with the audit rows that existed when it
   *  was made — which is how 「the row came FIRST」 is asserted behaviourally
   *  rather than by reading the source. */
  calls: Array<{ op: 'cancel' | 'clear'; subId: string; effectiveFrom?: string; auditRowsAtCallTime: number }>;
}

function rig(opts: {
  view?: PlanView;
  user?: UserRecord | null;
  admin?: boolean;
  writer?: 'ok' | 'refuses' | 'unreachable' | 'missing' | 'throws';
  auditThrows?: boolean;
} = {}): Rig {
  const audit: AuditRow[] = [];
  const calls: Rig['calls'] = [];
  const mode = opts.writer ?? 'ok';
  const snapshot = (scheduled: SubscriptionSnapshot['scheduled_change']): SubscriptionSnapshot =>
    ({ status: 'active', scheduled_change: scheduled } as unknown as SubscriptionSnapshot);
  const outcome = (scheduled: SubscriptionSnapshot['scheduled_change']): unknown => {
    if (mode === 'refuses') return { ok: false, code: 'PROVIDER_REJECTED', detail: 'the provider said no' };
    if (mode === 'unreachable') return { ok: false, code: 'PROVIDER_UNREACHABLE', detail: 'timed out' };
    return { ok: true, data: snapshot(scheduled) };
  };
  const writer = {
    async cancelSubscription(subId: string, effectiveFrom: string) {
      calls.push({ op: 'cancel', subId, effectiveFrom, auditRowsAtCallTime: audit.length });
      if (mode === 'throws') throw new Error('boom');
      return outcome({ action: 'cancel', effective_at: '2026-10-01T00:00:00.000Z' });
    },
    async clearScheduledChange(subId: string) {
      calls.push({ op: 'clear', subId, auditRowsAtCallTime: audit.length });
      if (mode === 'throws') throw new Error('boom');
      return outcome(null);
    },
  };
  const user = opts.user === undefined ? targetUser() : opts.user;
  const deps: OpsSubscriptionRoutesDeps = {
    auth: {
      verifyToken: () => ({ ok: true as const, sub: ADMIN_ID }),
      getUser: () => ({ id: ADMIN_ID, is_admin: opts.admin === false ? 0 : 1 }),
    } as unknown as OpsSubscriptionRoutesDeps['auth'],
    users: { findById: (id: string) => (user && id === user.id ? user : null) } as OpsSubscriptionRoutesDeps['users'],
    billing: { getPlan: () => opts.view ?? planView() } as unknown as OpsSubscriptionRoutesDeps['billing'],
    writerFor: () => (mode === 'missing' ? null : (writer as unknown as ReturnType<OpsSubscriptionRoutesDeps['writerFor']>)),
    audit: {
      append: (row: AuditRow) => {
        if (opts.auditThrows) throw new Error('ops_audit_log is unwritable');
        audit.push(row);
        return audit.length;
      },
    },
  };
  return { deps, audit, calls };
}

/** 🔴 NOT objectMode — `Readable.from([string])` defaults to it and the bounded
 *  body reader then waits for bytes that never arrive. Verbatim from the sibling
 *  ops suites, where it cost an hour once. */
function makeReq(url: string, body: unknown, withBearer = true): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')], { objectMode: false });
  const req = stream as unknown as IncomingMessage;
  req.method = 'POST';
  req.url = url;
  req.headers = withBearer ? { authorization: 'Bearer admin-token' } : {};
  (req as unknown as { socket: unknown }).socket = { remoteAddress: '127.0.0.1' };
  return req;
}

async function call(
  deps: OpsSubscriptionRoutesDeps,
  url: string,
  body: unknown,
  withBearer = true,
): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') raw += chunk;
      return this;
    },
    write(chunk: string) {
      raw += chunk;
      return true;
    },
    headersSent: false,
  } as unknown as ServerResponse;
  expect(tryHandleOpsSubscriptionRoutes(makeReq(url, body, withBearer), res, deps), `${url} was not handled`).toBe(true);
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  return { status, raw, body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) };
}

const CANCEL_URL = '/api/ops/subscriptions/cancel';
const RESUME_URL = '/api/ops/subscriptions/resume';
const REASON = 'buyer emailed support asking us to stop the renewal';

describe('① the happy paths', () => {
  it('cancel: ALWAYS next_billing_period, and the body separates the receipt from our row', async () => {
    const r = rig();
    const res = await call(r.deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    expect(res.status).toBe(200);
    // 🔴 THE ONE ARGUMENT. Cancelling immediately at the provider does not
    // refund the unused period, so it would take the service away and keep the
    // money. There is no parameter for it and this pins that there never is.
    expect(r.calls).toEqual([
      { op: 'cancel', subId: SUB_ID, effectiveFrom: 'next_billing_period', auditRowsAtCallTime: 2 },
    ]);
    expect(res.body.action).toBe('cancel');
    expect(res.body.settles_via_webhook).toBe(true);
    // The provider's own post-state — a receipt.
    expect(res.body.provider).toEqual({
      name: 'creem',
      status: 'active',
      scheduled_change: { action: 'cancel', effective_at: '2026-10-01T00:00:00.000Z' },
    });
    // …and OUR row, still unchanged, said so rather than dressed up as the
    // outcome. A console that renders `local` as the result is looking at a
    // race; a console that renders `provider` is stating a fact.
    expect(res.body.local).toEqual({
      plan: 'pro',
      state: 'active',
      scheduled_change: null,
      expires_at: '2026-10-01T00:00:00.000Z',
    });
  });

  it('resume: clears the scheduled cancellation on the SAME subscription id', async () => {
    const r = rig({ view: CANCEL_SCHEDULED });
    const res = await call(r.deps, RESUME_URL, { user_id: TARGET_ID, reason: 'buyer changed their mind' });
    expect(res.status).toBe(200);
    expect(r.calls).toEqual([{ op: 'clear', subId: SUB_ID, auditRowsAtCallTime: 2 }]);
    expect(res.body.action).toBe('resume');
    expect((res.body.provider as { scheduled_change: unknown }).scheduled_change).toBe(null);
  });
});

describe('② the refusals, each with the operator action it implies', () => {
  it('no such account ⇒ 404, and the provider is never called', async () => {
    const r = rig({ user: null });
    const res = await call(r.deps, CANCEL_URL, { user_id: 'nobody', reason: REASON });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(OPS_SUBSCRIPTION_TARGET_UNKNOWN);
    expect(r.calls).toEqual([]);
    // No BUSINESS row either: nothing happened, and `billing.subscription.cancel`
    // asserts that something did. The gate's own row is there (below), which is
    // the division of labour ops-audit-trail.ts describes.
    expect(r.audit.map((a) => a.action)).toEqual(['ops.admin.granted']);
  });

  it('🔴 「no such account」 and 「no subscription」 are DIFFERENT answers', async () => {
    // The two demand different operator actions — retype the id vs. stop,
    // this person never bought anything — so they must not be one code.
    const noSub = rig({ view: planView({ paddle_subscription_id: null }) });
    const res = await call(noSub.deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(BILLING_NO_SUBSCRIPTION);
    expect(res.body.error).not.toBe(OPS_SUBSCRIPTION_TARGET_UNKNOWN);
    expect(noSub.calls).toEqual([]);
  });

  it('⚠️ a tombstoned subscription arrives here as 404, not as a tombstone code', async () => {
    // 🔴 MEASURED, AND THE REASON THERE IS NO TOMBSTONE BRANCH:
    // `paddle_subscription_tombstones` has no `user_id` column and its only
    // production writer (`deleteAccount`) removes the users row in the next
    // statement — so from a `user_id` a tombstoned subscription is unreachable.
    // What an operator can actually hit is the account being gone, and that is
    // the case pinned here. A `409 tombstoned` branch would be a branch with no
    // reachable input, defended by a comment (volume-13 §7 F1 ⑦).
    const gone = rig({ user: null });
    const res = await call(gone.deps, RESUME_URL, { user_id: 'deleted-account', reason: REASON });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(OPS_SUBSCRIPTION_TARGET_UNKNOWN);
    expect(gone.calls).toEqual([]);
  });

  it('resume with nothing scheduled ⇒ 409, and a scheduled PAUSE is not a cancellation', async () => {
    const none = rig();
    expect((await call(none.deps, RESUME_URL, { user_id: TARGET_ID, reason: REASON })).body.error)
      .toBe(OPS_SUBSCRIPTION_NOTHING_SCHEDULED);
    expect(none.calls).toEqual([]);
    // `clearScheduledChange` would clear a pause just as happily, and the audit
    // row says `billing.subscription.resume`. A row claiming we undid a
    // cancellation when we cleared something else is a trail that lies.
    const paused = rig({ view: planView({ scheduled_change: { action: 'pause', effective_at: null } }) });
    expect((await call(paused.deps, RESUME_URL, { user_id: TARGET_ID, reason: REASON })).body.error)
      .toBe(OPS_SUBSCRIPTION_NOTHING_SCHEDULED);
    expect(paused.calls).toEqual([]);
    // POSITIVE CONTROL: the same rig with a real scheduled cancellation goes
    // through, so the two refusals above are not「this route never works」.
    const ok = rig({ view: CANCEL_SCHEDULED });
    expect((await call(ok.deps, RESUME_URL, { user_id: TARGET_ID, reason: REASON })).status).toBe(200);
  });

  it('⚠️ an EXPIRED subscription cannot be resumed — the guard subsumes it', async () => {
    // BillingService.fromPaddle nulls `scheduled_change` for an expired row (an
    // expired row's scheduled change describes something that already happened),
    // so 「not expired」 needs no second test in the route. Asserted here rather
    // than only claimed in a comment.
    const expired = rig({ view: planView({ state: 'expired', scheduled_change: null }) });
    const res = await call(expired.deps, RESUME_URL, { user_id: TARGET_ID, reason: REASON });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(OPS_SUBSCRIPTION_NOTHING_SCHEDULED);
    expect(expired.calls).toEqual([]);
  });

  it('a malformed body is refused by name, and reason is REQUIRED in both directions', async () => {
    const r = rig({ view: CANCEL_SCHEDULED });
    for (const body of [{}, { user_id: TARGET_ID }, { user_id: TARGET_ID, reason: '   ' }, { reason: REASON }]) {
      const res = await call(r.deps, CANCEL_URL, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('SETTINGS_SCHEMA_INVALID');
    }
    const tooLong = await call(r.deps, RESUME_URL, { user_id: TARGET_ID, reason: 'x'.repeat(501) });
    expect(tooLong.status).toBe(400);
    // REFUSED, never truncated: a half-stored justification is a worse audit
    // record than a rejected one.
    expect(r.audit.some((a) => a.detail?.length === 500)).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('a non-admin Bearer is refused 403 by name and reaches nothing', async () => {
    const r = rig({ admin: false });
    const res = await call(r.deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ADMIN_ONLY');
    expect(r.calls).toEqual([]);
    expect(r.audit.map((a) => a.action)).toEqual(['ops.admin.denied']);
  });

  it('provider outcomes keep the self-service twin\'s meanings', async () => {
    // 🔴 UNREACHABLE IS 502-AND-WE-DO-NOT-KNOW, never 「it failed」: a timeout can
    // land after the provider has already committed, and the repair an operator
    // would choose on 「it failed」 (do it again) is the expensive one.
    const unreachable = await call(rig({ writer: 'unreachable' }).deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error).toBe('BILLING_PADDLE_UNREACHABLE');
    const refused = await call(rig({ writer: 'refuses' }).deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe('BILLING_PADDLE_REJECTED');
    // No client for this subscription's provider is a DEPLOYMENT problem, not
    // the account's and not the provider's.
    const missing = rig({ writer: 'missing' });
    const noClient = await call(missing.deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    expect(noClient.status).toBe(503);
    expect(noClient.body.error).toBe(BILLING_WRITE_DISABLED);
    // 🔴 …and it happens BEFORE the audit row: nothing was attempted, so nothing
    // is claimed.
    expect(missing.audit.map((a) => a.action)).toEqual(['ops.admin.granted']);
  });
});

describe('③ the audit row — the assertion this file exists for', () => {
  it('the business row names the action, the account and the operator\'s own sentence', async () => {
    const r = rig({ view: CANCEL_SCHEDULED });
    await call(r.deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    await call(r.deps, RESUME_URL, { user_id: TARGET_ID, reason: 'they changed their mind' });
    const business = r.audit.filter((a) => a.action.startsWith('billing.'));
    expect(business).toEqual([
      {
        actor_user_id: ADMIN_ID,
        action: SUBSCRIPTION_CANCEL_ACTION,
        target_kind: SUBSCRIPTION_TARGET_KIND,
        target_id: TARGET_ID,
        detail: REASON,
      },
      {
        actor_user_id: ADMIN_ID,
        action: SUBSCRIPTION_RESUME_ACTION,
        target_kind: SUBSCRIPTION_TARGET_KIND,
        target_id: TARGET_ID,
        detail: 'they changed their mind',
      },
    ]);
    // 🔴 THE ACTOR IS THE BEARER'S, never the body's. A `user_id` in the body
    // names the TARGET; an actor taken from a caller-supplied field would let
    // the trail be written in somebody else's name.
    expect(business.every((a) => a.actor_user_id === ADMIN_ID)).toBe(true);
  });

  it('🔴 the audit row is present BEFORE the provider is called', async () => {
    const r = rig({ view: CANCEL_SCHEDULED });
    await call(r.deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    expect(r.calls).toHaveLength(1);
    // Two rows by then: the gate's route-level row and this route's business
    // row. Both must exist before a single byte goes to the provider.
    expect(
      r.calls[0]?.auditRowsAtCallTime,
      'the provider was called before the audit row existed — an unrecorded change to a recurring charge',
    ).toBe(2);
    expect(r.audit[1]?.action).toBe(SUBSCRIPTION_CANCEL_ACTION);
  });

  it('🔴 an unwritable trail ⇒ 503 and the provider is NOT called', async () => {
    const r = rig({ view: CANCEL_SCHEDULED, auditThrows: true });
    const res = await call(r.deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(OPS_SUBSCRIPTION_NOT_RECORDED);
    expect(r.calls, 'the subscription was changed with no record of it').toEqual([]);
    // POSITIVE CONTROL: the same rig with a WORKING sink does reach the
    // provider, so the empty array above is the fail-closed branch and not a
    // route that never calls anybody.
    expect((await call(rig({ view: CANCEL_SCHEDULED }).deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON })).status)
      .toBe(200);
  });

  it('🔴 STRUCTURAL: the append is written before the writer call in the source', async () => {
    // The behavioural assertions above use a WORKING sink and a throwing one.
    // Neither notices somebody moving the append AFTER the provider call while
    // keeping both — which is the edit that reintroduces the defect. So the
    // order is read out of the source too, the way ops-audit-wiring.test.ts
    // reads account-restriction-routes.ts.
    //
    // 🔴 REVERSE CONTROL, RUN AND SEEN RED (2026-09-07, worktree
    // ops-console-support): deleting the `auditFirst(...)` call from
    // ops-subscription-routes.ts made the two assertions in this describe fail
    // with
    //   AssertionError: the provider was called before the audit row existed —
    //   an unrecorded change to a recurring charge: expected 1 to be 2
    // and
    //   expected 200 to be 503
    // Restored; `git diff` on that file is clean of the removal.
    const src = stripComments(readFileSync(join(SRC, 'http', 'ops-subscription-routes.ts'), 'utf8'));
    // 🔴 `auditFirst(` ALONE WAS NOT ENOUGH, and this is measured: during the
    // reverse control above, deleting the CALL left the function DECLARATION
    // matching that string, and this assertion stayed green while five others
    // went red. The needle is the call site.
    const appendAt = src.indexOf('auditFirst(res, deps,');
    const cancelAt = src.indexOf('writer.cancelSubscription(');
    const clearAt = src.indexOf('writer.clearScheduledChange(');
    expect(appendAt, 'the route does not write a business row at all').toBeGreaterThan(-1);
    expect(cancelAt, 'the route does not call the provider cancel').toBeGreaterThan(-1);
    expect(clearAt, 'the route does not call the provider clear').toBeGreaterThan(-1);
    expect(
      appendAt,
      'the audit append must come BEFORE the provider call. Call-then-append produces the one\n' +
        'state ops-audit-trail.ts forbids: a change nobody recorded, reported as success.',
    ).toBeLessThan(Math.min(cancelAt, clearAt));
  });
});

describe('④ the fence and the projection', () => {
  it('both routes are declared admin-gated AND declared mutating', () => {
    for (const r of [SUBSCRIPTION_CANCEL_ROUTE, SUBSCRIPTION_RESUME_ROUTE]) {
      expect(ADMIN_GATED_ROUTES).toContain(r);
      expect(MUTATING_ADMIN_GATED_ROUTES).toContain(r);
    }
  });

  it('🔴 no response body can carry a password hash', async () => {
    // The account row this route holds is a whole `UserRecord`, hash included —
    // the same exposure ops-user-routes.ts had to project away. This asserts on
    // the SERIALISED body, not on a field name, because a projection that
    // emitted `password_hash: null` would be one schema change away from
    // emitting the value.
    const r = rig({ view: CANCEL_SCHEDULED });
    const bodies = [
      await call(r.deps, CANCEL_URL, { user_id: TARGET_ID, reason: REASON }),
      await call(r.deps, RESUME_URL, { user_id: TARGET_ID, reason: REASON }),
      await call(r.deps, CANCEL_URL, { user_id: 'nobody', reason: REASON }),
      await call(r.deps, CANCEL_URL, {}),
    ];
    // POSITIVE CONTROL: the marker really is on the record this route reads, so
    // 「not found in the body」 is a fact about the projection rather than about
    // a fixture that never had a hash.
    expect(targetUser().password_hash).toBe(HASH_MARKER);
    for (const b of bodies) {
      expect(b.raw).not.toContain(HASH_MARKER);
      expect(b.raw).not.toContain('password_hash');
      expect(JSON.stringify(b.body)).not.toContain(HASH_MARKER);
    }
    // …and nothing caller-supplied beyond `reason` reached the trail either.
    expect(r.audit.every((a) => a.detail === undefined || a.detail === REASON)).toBe(true);
  });
});
