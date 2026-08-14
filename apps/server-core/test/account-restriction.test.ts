// A2-3 「restricted use」 — 「does login still succeed」「does the block hold」「can the user still get their own things back」.
//
// SPEC-REF: docs/strategy/2026-08-12-a2-3-restricted-use-design.md §9 (acceptance table)
//           docs/decisions/owner-web-rulings/latest.md:71 (owner, verbatim)
//           src/auth/account-restriction.ts (the policy under test)
//           src/http/account-restriction-routes.ts (the write path)
//           CLAUDE.md red line: no silent failure (both directions) / one value answers one question / R11
//           *** HUMAN-AUDIT SENSITIVE (auth + DB write) ***
//
// 🔴 THE DIVIDING LINE OF THIS WHOLE REVISION IS ASSERTION #1 BELOW: a restricted
// account's `POST /api/login` must still answer 200 WITH A TOKEN. owner replaced
// 「ban」 with 「restricted use」 and inverted the mechanism in the same breath — 「the user can still
// log in, but only sees the restricted-use notice」. If that assertion is ever changed to expect a
// 401, the superseded ban design has come back and this file is the thing that
// was supposed to notice.
//
// Everything here drives the REAL bootstrap over a real HTTP port, so a green is
// evidence about wiring and not only about a function: a `restriction: {…}` that
// bootstrap forgot to build would 404 here and pass in a hand-assembled deps test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, RESTRICTION_REASON_KEYS } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { signJwt } from '../src/auth/jwt';
import { log } from '../src/log';
import { ACCOUNT_RESTRICTED, isAccountRestricted } from '../src/auth/account-restriction';
import {
  RESTRICT_ACTION,
  RESTRICT_NOT_RECORDED,
  RESTRICT_REASON_MAX,
  RESTRICT_TARGET_KIND,
  RESTRICT_TARGET_PROTECTED,
  RESTRICT_TARGET_UNKNOWN,
  UNRESTRICT_ACTION,
} from '../src/http/account-restriction-routes';

const SECRET = 'account-restriction-secret-32-bytes-x';
const RESTRICT_PATH = '/api/ops/users/restrict';

let server: BootstrapHandle | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await server.close();
  server = null;
});

async function saas(): Promise<string> {
  // fix-010: an in-process server has no proxy in front of it — its direct peer
  // IS the client (config.ts §trustedProxies).
  const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', trustedProxies: [] });
  server = await startServer(config);
  return `http://127.0.0.1:${server.port}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON body is a fact the caller may assert on */ }
  return { status: res.status, json, text };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** A real registered account, held VERIFIED through the real repo — this suite
 *  measures the RESTRICTION gate, and an unverified account would be refused by
 *  the neighbouring one and prove nothing about this file's subject. (The one
 *  test that deliberately leaves an account unverified is the precedence test.) */
async function member(url: string, email: string): Promise<{ id: string; token: string }> {
  const r = await call('POST', `${url}/api/register`, { email, password: 'longenough1', display_name: 'M' });
  expect(r.status, `register ${email}`).toBe(201);
  const id = r.json.user.id as string;
  server!.db.emailVerification.markVerified(id, Date.now());
  return { id, token: r.json.token as string };
}

/** An admin. The bit is written through `UserRepo.insert` — the ONLY writer of
 *  that column — so the thing under test is the real one. */
function admin(email = 'ops@restrict.co', id = 'u-restrict-admin'): { id: string; token: string } {
  const user = server!.db.users.insert({ id, email, display_name: 'A', is_admin: true });
  server!.db.emailVerification.markVerified(user.id, Date.now());
  return { id: user.id, token: signJwt({ sub: user.id, plan: user.plan }, { secret: Buffer.from(SECRET, 'utf8') }) };
}

function restrictedAtOf(userId: string): number | null {
  return server!.db.users.findById(userId)?.restricted_at ?? null;
}

// ── ① the dividing line: login still succeeds ─────────────────────────────────────────────────
describe('A2-3 · a restriction is NOT a refusal to sign in', () => {
  it('🔴 a restricted account still gets 200 + a working token from POST /api/login', async () => {
    const url = await saas();
    const m = await member(url, 'signin@restrict.co');
    server!.db.users.setRestricted(m.id, Date.now(), 'terms_violation');

    const login = await call('POST', `${url}/api/login`, { email: 'signin@restrict.co', password: 'longenough1' });
    expect(login.status, 'owner: 「the user can still log in」 — a 401 here means the ban design came back').toBe(200);
    expect(typeof login.json.token, 'a restricted sign-in must mint a REAL session, not an empty 200').toBe('string');
    // …and the token is genuinely usable: /api/me answers 200 for it. A token
    // that were minted and then rejected everywhere would satisfy the line above
    // while making the sentence 「you can still log in」 false in practice.
    const me = await call('GET', `${url}/api/me`, undefined, bearer(login.json.token as string));
    expect(me.status).toBe(200);
  });

  it('🔴 the state ARRIVES at the client — publicUser.restricted, recomputed from the row every call', async () => {
    const url = await saas();
    const m = await member(url, 'carrier@restrict.co');
    // Before: false on the register response and on /api/me.
    expect((await call('GET', `${url}/api/me`, undefined, bearer(m.token))).json.user.restricted).toBe(false);

    server!.db.users.setRestricted(m.id, Date.now(), 'terms_violation');
    // 🔴 THE SAME TOKEN, no re-login: this is what makes the JWT rejection
    // (design §2.2 candidate A) observable. A claims-carried flag would still
    // read `false` here for up to seven days.
    expect((await call('GET', `${url}/api/me`, undefined, bearer(m.token))).json.user.restricted).toBe(true);
    // …and the login ack carries it too (a second surface, same projection).
    const login = await call('POST', `${url}/api/login`, { email: 'carrier@restrict.co', password: 'longenough1' });
    expect(login.json.user.restricted).toBe(true);

    // 🔴 AND IT COMES BACK. The 「still says restricted after it was lifted」 direction is the other half
    // of why the flag is not in the token, and it is asserted rather than assumed.
    server!.db.users.setRestricted(m.id, null, null);
    expect((await call('GET', `${url}/api/me`, undefined, bearer(m.token))).json.user.restricted).toBe(false);
  });
});

// ── ② does the block hold ───────────────────────────────────────────────────────────────
describe('A2-3 · enforcement — every console feature refuses BY NAME, the carve-outs do not', () => {
  /** The console FEATURE surface this card gates. Method + path + a body that
   *  gets past parsing where one is needed — the same census shape
   *  test/email-verification.test.ts uses for its own gate. */
  const GATED: Array<[string, string, unknown?]> = [
    ['GET', '/api/cloud/summary'],
    ['GET', '/api/cloud/subscription'],
    ['GET', '/api/cloud/billing/events'],
    ['GET', '/api/cloud/devices'],
    ['GET', '/api/cloud/stt-routings'],
    ['POST', '/api/cloud/stt-routings', { routings: [] }],
    ['POST', '/api/cloud/stt-routings/test', { routing: { language: 'en', engine_id: 'custom-openai-compatible', endpoint: 'http://127.0.0.1:9/v1' } }],
    ['POST', '/api/cloud/devices/revoke', { pairing_id: 'p-x' }],
  ];

  it('🔴 restricted → 403 ACCOUNT_RESTRICTED on every gated route; the SAME account released → never that refusal', async () => {
    const url = await saas();
    const m = await member(url, 'matrix@restrict.co');

    // Positive control FIRST: the routes admit this account while it is clean.
    // Without it, a 403 below could equally mean 「this route already refused me」.
    for (const [method, path, body] of GATED) {
      const r = await call(method, `${url}${path}`, body, bearer(m.token));
      expect(r.status, `${method} ${path} refused an UNRESTRICTED account`).not.toBe(403);
    }

    server!.db.users.setRestricted(m.id, Date.now(), 'terms_violation');
    for (const [method, path, body] of GATED) {
      const r = await call(method, `${url}${path}`, body, bearer(m.token));
      expect(r.status, `${method} ${path} for a restricted account`).toBe(403);
      // Q2 — the body now carries the ENUMERATED reason beside the code. The
      // account was restricted with 'terms_violation' at the top of this block,
      // so this is a real round trip through the column and not a constant.
      expect(r.json, `${method} ${path} refusal body`).toEqual({ error: ACCOUNT_RESTRICTED, reason: 'terms_violation' });
    }

    server!.db.users.setRestricted(m.id, null, null);
    for (const [method, path, body] of GATED) {
      const r = await call(method, `${url}${path}`, body, bearer(m.token));
      expect(r.json?.error, `${method} ${path} after release`).not.toBe(ACCOUNT_RESTRICTED);
      expect(r.status, `${method} ${path} after release`).not.toBe(403);
    }
  });

  it('🔴 owner\'s carve-out: export and delete stay REACHABLE for a restricted account', async () => {
    const url = await saas();
    const m = await member(url, 'rights@restrict.co');
    server!.db.users.setRestricted(m.id, Date.now(), 'terms_violation');

    // GET /api/account/export — 200, with the account's own data in it.
    const exported = await call('GET', `${url}/api/account/export`, undefined, bearer(m.token));
    expect(exported.status, 'owner: 「the user can clear their own data」 — export must not be walled').toBe(200);
    expect(exported.text).toContain(m.id);

    // POST /api/account/delete with an unconfirmed body: reaching the route's OWN
    // named 400 is what proves the gate is not in front of it (the shape the
    // verification-gate suite uses for the same pair).
    const del = await call('POST', `${url}/api/account/delete`, {}, bearer(m.token));
    expect(del.json?.error, 'delete must reach its own validation, not the restriction gate').not.toBe(ACCOUNT_RESTRICTED);
    expect(del.status).not.toBe(403);

    // Signed-in password change stays reachable: rotating a password you
    // already know is not 「using the product」.
    const pw = await call(
      'POST',
      `${url}/api/account/password`,
      { current_password: 'wrong-password-1', new_password: 'brandnewpass1' },
      bearer(m.token),
    );
    expect(pw.json?.error, 'change-password must reach its own check, not the restriction gate').not.toBe(ACCOUNT_RESTRICTED);
    expect(pw.status).not.toBe(403);
    expect(pw.status).toBe(401);
    expect(pw.json.error).toBe('AUTH_LOGIN_FAILED');

    // …and it really deletes: the escape hatch is a working door, not an
    // unlocked one. The route's own confirmation SHAPE still applies (both
    // fields — `confirm_user_id` is a CONFIRMATION and never a selector, and
    // `confirm` is the literal 'DELETE'). That is not the restriction gate and
    // must not be confused with it: a gate asks WHO may call, a confirmation
    // asks whether this call was meant.
    const done = await call('POST', `${url}/api/account/delete`, { confirm: 'DELETE', confirm_user_id: m.id }, bearer(m.token));
    expect(done.status, `delete for a restricted account: ${done.text}`).toBe(200);
    expect(server!.db.users.findById(m.id)).toBeNull();
  });

  it('logout is reachable too — a restriction you cannot sign out of is a trap', async () => {
    const url = await saas();
    const m = await member(url, 'logout@restrict.co');
    server!.db.users.setRestricted(m.id, Date.now(), 'terms_violation');
    expect((await call('POST', `${url}/api/logout`, {}, bearer(m.token))).status).toBe(200);
  });

  it('🔴 precedence: an account that is BOTH unverified and restricted hears the restriction', async () => {
    // Both states are true and only one can be the answer. 「go collect a verification code」 is an
    // errand this user cannot complete into anything, because there is no appeal
    // channel — telling them to go verify would be a true sentence used as a
    // false next action.
    const url = await saas();
    const r = await call('POST', `${url}/api/register`, { email: 'both@restrict.co', password: 'longenough1' });
    const id = r.json.user.id as string;
    const token = r.json.token as string;
    // Deliberately NOT marked verified — this is the one account in the suite
    // that is left in the state the neighbouring gate refuses.
    server!.db.users.setRestricted(id, Date.now(), 'terms_violation');
    const walled = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(token));
    expect(walled.status).toBe(403);
    expect(walled.json).toEqual({ error: ACCOUNT_RESTRICTED, reason: 'terms_violation' });
    // Positive control that the OTHER gate is genuinely armed for this account —
    // otherwise 「restriction wins」 would be indistinguishable from 「verification
    // was never checked here」.
    server!.db.users.setRestricted(id, null, null);
    const stillWalled = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(token));
    expect(stillWalled.status).toBe(403);
    expect(stillWalled.json.error, 'the verification gate must be the one answering now').toBe('EMAIL_NOT_VERIFIED');
  });
});

// ── ③ write path ─────────────────────────────────────────────────────────────────
describe('A2-3 · POST /api/ops/users/restrict — the first mutating admin route', () => {
  it('restricts, then releases, and the round trip is visible to the target on /api/me', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'target@restrict.co');

    const on = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'spam reports', reason_code: 'terms_violation' }, bearer(a.token));
    expect(on.status, on.text).toBe(200);
    expect(on.json).toMatchObject({ ok: true, user_id: m.id, restricted: true, changed: true });
    expect(typeof on.json.restricted_at).toBe('number');
    expect(isAccountRestricted(restrictedAtOf(m.id))).toBe(true);
    expect((await call('GET', `${url}/api/me`, undefined, bearer(m.token))).json.user.restricted).toBe(true);

    const off = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: false, reason: 'appeal upheld out of band' }, bearer(a.token));
    expect(off.status, off.text).toBe(200);
    expect(off.json).toMatchObject({ ok: true, restricted: false, restricted_at: null, changed: true });
    expect(restrictedAtOf(m.id)).toBeNull();
    expect((await call('GET', `${url}/api/me`, undefined, bearer(m.token))).json.user.restricted).toBe(false);
  });

  it('🔴 idempotent: restricting an already-restricted account does NOT move the first timestamp', async () => {
    // Overwriting it would erase 「when it was first restricted」, which is the only thing
    // a timestamp buys over a boolean.
    const url = await saas();
    const a = admin();
    const m = await member(url, 'idem@restrict.co');

    const first = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'first', reason_code: 'terms_violation' }, bearer(a.token));
    const stamp = first.json.restricted_at as number;
    const again = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'second', reason_code: 'other' }, bearer(a.token));
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, restricted: true, changed: false });
    expect(again.json.restricted_at, 'the first restriction moment was overwritten').toBe(stamp);
    expect(restrictedAtOf(m.id)).toBe(stamp);
    // …and the no-op left NO business row: `ops.user.restrict` asserts that the
    // state changed, so one written for a no-op would put a change in the trail
    // that never happened. (The gate row for the attempt IS there — asserted in
    // the audit test below.)
    const business = server!.db.opsAudit.listRecent(50).filter((r) => r.action === RESTRICT_ACTION);
    expect(business).toHaveLength(1);
    expect(business[0]!.detail).toBe('first');
  });

  it('🔴 an is_admin account cannot be restricted — one misclick would lock the console', async () => {
    // `is_admin` is only recoverable with out-of-band SQL (account-auth.ts says
    // so at the gate), so this refusal is what keeps a moderation surface from
    // being able to destroy its own access.
    const url = await saas();
    const a = admin();
    const victim = admin('other-admin@restrict.co', 'u-other-admin');

    const r = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: victim.id, restricted: true, reason: 'oops', reason_code: 'other' }, bearer(a.token));
    expect(r.status).toBe(409);
    expect(r.json.error).toBe(RESTRICT_TARGET_PROTECTED);
    expect(restrictedAtOf(victim.id), 'the refusal did not actually protect the row').toBeNull();

    // 🔴 C1 (「must not restrict yourself」) is UNREPRESENTABLE rather than separately
    // guarded: only an admin reaches this route and every admin is a platform
    // account, so a self-target hits the same refusal. Asserted so that the
    // structural argument in the route's comment is a checked claim.
    const self = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: a.id, restricted: true, reason: 'self', reason_code: 'other' }, bearer(a.token));
    expect(self.status).toBe(409);
    expect(self.json.error).toBe(RESTRICT_TARGET_PROTECTED);
    expect(restrictedAtOf(a.id)).toBeNull();

    // …and a permanent_free NON-admin is protected by the same predicate (the
    // stated cost of reusing `isPlatformAccount` — conservative, and recorded).
    const exempt = await member(url, 'exempt@restrict.co');
    server!.db.users.setPermanentFree(exempt.id, true);
    const r2 = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: exempt.id, restricted: true, reason: 'x', reason_code: 'other' }, bearer(a.token));
    expect(r2.status).toBe(409);
    expect(restrictedAtOf(exempt.id)).toBeNull();
  });

  it('malformed bodies are refused by name, and none of them touches the row', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'body@restrict.co');
    const bad: Array<[string, unknown]> = [
      ['missing user_id', { restricted: true, reason: 'r', reason_code: 'other' }],
      ['blank user_id', { user_id: '   ', restricted: true, reason: 'r', reason_code: 'other' }],
      ['missing restricted', { user_id: m.id, reason: 'r', reason_code: 'other' }],
      // 🔴 `'false'` is TRUTHY in JS: a coercing parser would RESTRICT an account
      // the operator meant to release. This is the storage-face bug this repo
      // already shipped once (`permanent_free` as TEXT), on the request face.
      ['stringly restricted', { user_id: m.id, restricted: 'false', reason: 'r', reason_code: 'other' }],
      ['missing reason', { user_id: m.id, restricted: true, reason_code: 'other' }],
      ['blank reason', { user_id: m.id, restricted: true, reason: '  ', reason_code: 'other' }],
      ['overlong reason', { user_id: m.id, restricted: true, reason: 'x'.repeat(RESTRICT_REASON_MAX + 1), reason_code: 'other' }],
    ];
    for (const [label, body] of bad) {
      const r = await call('POST', `${url}${RESTRICT_PATH}`, body, bearer(a.token));
      expect(r.status, label).toBe(400);
      expect(r.json.error, label).toBe('SETTINGS_SCHEMA_INVALID');
      expect(typeof r.json.message, `${label}: a bare code cannot say WHICH field`).toBe('string');
    }
    expect(restrictedAtOf(m.id), 'a malformed request changed the account').toBeNull();
  });

  it('an unknown user_id is a named 404 — never a cheerful 200 for a typo', async () => {
    const url = await saas();
    const a = admin();
    const r = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: 'no-such-account', restricted: true, reason: 'r', reason_code: 'other' }, bearer(a.token));
    expect(r.status).toBe(404);
    expect(r.json.error).toBe(RESTRICT_TARGET_UNKNOWN);
  });

  it('🔴 restricting changes NOTHING else: plan, permanent_free, is_admin and email_verified_at are byte-identical', async () => {
    // The M2-8 reverse-control shape. A restriction that also moved a tier would
    // hand the billing face a change nobody made.
    const url = await saas();
    const a = admin();
    const m = await member(url, 'columns@restrict.co');
    server!.db.users.setPlan(m.id, 'pro');
    const before = server!.db.users.findById(m.id)!;

    await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: 'other' }, bearer(a.token));
    const after = server!.db.users.findById(m.id)!;
    // Q2 — TWO columns move now (the timestamp and the SHOWN reason), and they
    // are blanked together here for the same reason `restricted_at` always was:
    // this assertion is about everything that must NOT move. `plan`,
    // `permanent_free`, `is_admin` and `email_verified_at` are all inside it.
    expect({ ...after, restricted_at: null, restriction_reason: null })
      .toEqual({ ...before, restricted_at: null, restriction_reason: null });
    // Positive control: the TWO columns that were supposed to move, moved — and
    // the reason is the ENUMERATED one, never the operator's note ('r').
    expect(after.restricted_at).not.toBeNull();
    expect(before.restricted_at).toBeNull();
    expect(after.restriction_reason).toBe('other');
    expect(before.restriction_reason).toBeNull();
  });

  it('no response body on this route ever contains password_hash', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'hash@restrict.co');
    // Positive control: a recognisable hash really is in the database, so a
    // clean body below means 「not exposed」 and not 「nothing was stored」.
    expect(server!.db.users.findById(m.id)!.password_hash).toContain('scrypt$');
    const r = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: 'other' }, bearer(a.token));
    expect(r.text).not.toContain('password_hash');
    expect(r.text).not.toContain('scrypt$');
  });
});

// ── ④ leave a trail: if it cannot be written, it must not change ─────────────────────────────────────────────────
describe('A2-3 · the audit trail — two rows, and the mutation is FAIL-CLOSED', () => {
  it('a successful restrict writes the gate row AND a business row naming the reason', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'audit@restrict.co');
    await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'abuse: mass invites', reason_code: 'terms_violation' }, bearer(a.token));
    await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: false, reason: 'resolved' }, bearer(a.token));

    const rows = server!.db.opsAudit.listRecent(50);
    // The GATE row: it knows WHO and WHICH ROUTE, and it must not pretend to
    // know what the route meant.
    const gate = rows.filter((r) => r.target_id === `POST ${RESTRICT_PATH}`);
    expect(gate.length, 'the admin gate left no route-level row').toBeGreaterThanOrEqual(2);
    expect(gate[0]!.action).toBe('ops.admin.granted');
    // The BUSINESS rows: two directions, two action names, the operator's reason.
    const business = rows.filter((r) => r.target_kind === RESTRICT_TARGET_KIND);
    expect(business.map((r) => r.action)).toEqual([UNRESTRICT_ACTION, RESTRICT_ACTION]); // newest first
    expect(business.every((r) => r.target_id === m.id)).toBe(true);
    expect(business.every((r) => r.actor_user_id === a.id)).toBe(true);
    expect(business.map((r) => r.detail)).toEqual(['resolved', 'abuse: mass invites']);
  });

  it('🔴 a sink that throws leaves the account UNCHANGED and answers 503 — the read policy does not apply to a write', async () => {
    // ops-audit-trail.ts's `recordGateOutcome` deliberately serves a GET whose
    // audit row could not be written. Its own comment says that argument expires
    // for a mutation, and this is the assertion that it really did.
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const url = await saas();
    const a = admin();
    const m = await member(url, 'sink@restrict.co');
    // Break the ONE seam: the repo instance bootstrap handed to both surfaces.
    vi.spyOn(server!.db.opsAudit, 'append').mockImplementation(() => { throw new Error('disk is full'); });

    const r = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: 'other' }, bearer(a.token));
    expect(r.status).toBe(503);
    expect(r.json.error).toBe(RESTRICT_NOT_RECORDED);
    expect(restrictedAtOf(m.id), '🔴 an UNRECORDED restriction was executed').toBeNull();
    expect((await call('GET', `${url}/api/me`, undefined, bearer(m.token))).json.user.restricted).toBe(false);

    // POSITIVE CONTROL — the same request against a WORKING sink does change it.
    // Without this, the 503 above could mean the route is broken for every input.
    vi.restoreAllMocks();
    const ok = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: 'other' }, bearer(a.token));
    expect(ok.status, ok.text).toBe(200);
    expect(restrictedAtOf(m.id)).not.toBeNull();
  });
});

// ── ⑤ boundaries and pins ─────────────────────────────────────────────────────────────
describe('A2-3 · boundaries', () => {
  it('the route is admin-only and mounted saas-only', async () => {
    const url = await saas();
    const m = await member(url, 'nonadmin@restrict.co');
    // anonymous → named 401 (never an empty 200 that reads as 「done」).
    const anon = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: 'other' });
    expect(anon.status).toBe(401);
    expect(anon.json.error).toBe('AUTH_TOKEN_INVALID');
    // a real account that is not an admin → 403 ADMIN_ONLY, and nothing moved.
    const asMember = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: 'other' }, bearer(m.token));
    expect(asMember.status).toBe(403);
    expect(asMember.json.error).toBe('ADMIN_ONLY');
    expect(restrictedAtOf(m.id)).toBeNull();
    await server!.close();
    server = null;

    // standalone: 404, because the surface is NOT MOUNTED — not because an admin
    // check said no. If this ever became a 403, a network/mode boundary would
    // have been silently replaced by an auth one, which is a weaker thing.
    server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
    const local = `http://127.0.0.1:${server.port}`;
    expect((await call('POST', `${local}${RESTRICT_PATH}`, { user_id: 'x', restricted: true, reason: 'r', reason_code: 'other' })).status).toBe(404);
  });

  it('🔴 ACCOUNT_RESTRICTED is a REGISTERED protocol code with both languages', () => {
    // It is not an HTTP-local string: the owner gate for adding a code was
    // opened for this state. The count guard lives in packages/protocol
    // (68 → 69) and `verify:lint i18n-error-keys` counts the same table by a
    // different means; this assertion is the server-side end of that chain —
    // the gate answers with a name a client can actually look up.
    expect(ERROR_CODES[ACCOUNT_RESTRICTED]).toBeDefined();
    expect(ERROR_CODES[ACCOUNT_RESTRICTED].zh_CN.trim().length).toBeGreaterThan(0);
    expect(ERROR_CODES[ACCOUNT_RESTRICTED].en.trim().length).toBeGreaterThan(0);
    // The 28-character phone slot (`_truncateFailureReason`) — the 0.2.53 defect
    // was a code rendered as three letters. 18 here.
    expect(ACCOUNT_RESTRICTED.length).toBe(18);
    // …and it carries none of the wording owner called too authoritative.
    expect(/BAN|SUSPEND/.test(ACCOUNT_RESTRICTED)).toBe(false);
  });

  it('the three operator-facing refusals are HTTP-LOCAL, not protocol codes', () => {
    // They are diagnostics for the VPN-only admin console and no end-user client
    // can reach the route at all, so they ride the KEYMETA_NOT_FOUND / DIAG_*
    // precedent. Pinned out of the table so 「add a code」 stays a decision.
    for (const s of [RESTRICT_TARGET_UNKNOWN, RESTRICT_TARGET_PROTECTED, RESTRICT_NOT_RECORDED]) {
      expect(Object.keys(ERROR_CODES), `${s} drifted into the protocol table`).not.toContain(s);
    }
  });
});

// ── ⑥ Q2: tell the user 「why」, and the operator's free text never leaves the audit ────────────────────
//
// owner 2026-08-12 §Stamp Q2:「give the user an enumerated reason; operator free text goes only into the audit」. The Terms
// already promised 「we will tell you why unless the law prevents us」; this block
// is what makes that promise keepable AND bounded.
describe('A2-3 · Q2 — an ENUMERATED reason reaches the user, the operator note never does', () => {
  /** A canary an operator might plausibly type: another account's address, an
   *  internal ticket, a suspicion. If any of it ever reaches a user surface, it
   *  reaches it as THIS string. */
  const NOTE = 'INTERNAL-9931 reported by victim@example.com, suspected billing fraud';

  it('🔴 the operator note is in the AUDIT ROW and in no user-facing body anywhere', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'q2-note@restrict.co');
    const on = await call(
      'POST', `${url}${RESTRICT_PATH}`,
      { user_id: m.id, restricted: true, reason: NOTE, reason_code: 'terms_violation' },
      bearer(a.token),
    );
    expect(on.status, on.text).toBe(200);

    // 🔴 POSITIVE CONTROL FIRST. Without it, 「the note is nowhere」 could mean
    // 「the note was never stored」, and the whole block would be measuring
    // nothing (the probe-is-blind failure).
    const business = server!.db.opsAudit.listRecent(20).filter((r) => r.target_kind === RESTRICT_TARGET_KIND);
    expect(business).toHaveLength(1);
    expect(business[0]!.detail, 'the audit row is where the note is SUPPOSED to be').toBe(NOTE);

    // …and now the negative half, asserted on WHOLE serialized bodies rather
    // than on field names a nested echo could slip past (the M2-7 shape).
    expect(on.text, 'the write route echoed the operator note back').not.toContain(NOTE);
    const me = await call('GET', `${url}/api/me`, undefined, bearer(m.token));
    expect(me.text, '/api/me carried the operator note to the account holder').not.toContain(NOTE);
    const refused = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(m.token));
    expect(refused.status).toBe(403);
    expect(refused.text, 'the REFUSAL carried the operator note').not.toContain(NOTE);
    // Belt: not even a fragment of it.
    for (const fragment of ['INTERNAL-9931', 'victim@example.com', 'fraud']) {
      expect(refused.text).not.toContain(fragment);
      expect(me.text).not.toContain(fragment);
    }
  });

  it('the ENUMERATED reason DOES reach the account holder — on /api/me and on the refusal', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'q2-shown@restrict.co');
    await call(
      'POST', `${url}${RESTRICT_PATH}`,
      { user_id: m.id, restricted: true, reason: NOTE, reason_code: 'account_security' },
      bearer(a.token),
    );
    const me = await call('GET', `${url}/api/me`, undefined, bearer(m.token));
    expect(me.json.user.restricted).toBe(true);
    expect(me.json.user.restricted_reason, 'the user cannot be told WHY').toBe('account_security');
    const refused = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(m.token));
    expect(refused.json).toEqual({ error: ACCOUNT_RESTRICTED, reason: 'account_security' });
  });

  it('🔴 a release clears the reason with the timestamp — no sentence survives to be re-used', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'q2-clear@restrict.co');
    await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: 'legal_requirement' }, bearer(a.token));
    expect(server!.db.users.findById(m.id)!.restriction_reason).toBe('legal_requirement');

    await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: false, reason: 'resolved' }, bearer(a.token));
    // Both columns, together. A stale reason left behind would be attached to
    // the NEXT restriction and would then be a sentence about a person that
    // nobody decided this time.
    expect(server!.db.users.findById(m.id)!.restriction_reason).toBeNull();
    const me = await call('GET', `${url}/api/me`, undefined, bearer(m.token));
    expect(me.json.user.restricted).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(me.json.user, 'restricted_reason'),
      'a released account still carries a reason key',
    ).toBe(false);
  });

  it('an UNKNOWN reason_code is refused by name, and every legal one is accepted', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'q2-enum@restrict.co');

    for (const bad of ['banned', 'TERMS_VIOLATION', 'toString', '', '   ']) {
      const r = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: bad }, bearer(a.token));
      expect(r.status, `reason_code=「${bad}」 should have been refused`).toBe(400);
      expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
      expect(server!.db.users.findById(m.id)!.restricted_at, 'a refused body still changed the row').toBeNull();
    }
    // 🔴 THE POSITIVE CONTROL, over the WHOLE enum rather than one member: a
    // guard that accepted only the first key would pass a single-value probe.
    for (const good of RESTRICTION_REASON_KEYS) {
      const on = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: good }, bearer(a.token));
      expect(on.status, `reason_code=${good}: ${on.text}`).toBe(200);
      expect(server!.db.users.findById(m.id)!.restriction_reason).toBe(good);
      await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: false, reason: 'r' }, bearer(a.token));
    }
  });

  it('a RELEASE must not carry a reason_code — there is no notice to show', async () => {
    const url = await saas();
    const a = admin();
    const m = await member(url, 'q2-release@restrict.co');
    await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: true, reason: 'r', reason_code: 'other' }, bearer(a.token));
    const r = await call('POST', `${url}${RESTRICT_PATH}`, { user_id: m.id, restricted: false, reason: 'r', reason_code: 'other' }, bearer(a.token));
    expect(r.status).toBe(400);
    // The row is untouched by the refused call — still restricted.
    expect(server!.db.users.findById(m.id)!.restricted_at).not.toBeNull();
  });

  it('a restriction applied BEFORE this column existed shows no reason rather than a made-up one', async () => {
    // The legacy row. `null` is what the migration leaves (no backfill), and the
    // honest rendering of it is 「no reason was recorded」 — never the catch-all, which would
    // be a sentence nobody decided about this specific person.
    const url = await saas();
    const m = await member(url, 'q2-legacy@restrict.co');
    server!.db.users.setRestricted(m.id, Date.now(), null);
    const me = await call('GET', `${url}/api/me`, undefined, bearer(m.token));
    expect(me.json.user.restricted).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(me.json.user, 'restricted_reason')).toBe(false);
    const refused = await call('GET', `${url}/api/cloud/summary`, undefined, bearer(m.token));
    expect(refused.json).toEqual({ error: ACCOUNT_RESTRICTED });
  });
});
