// 0.2.47 — 「does this gate really cover every route it is supposed to」.
//
// SPEC-REF: src/http/account-auth.ts `adminFromBearer` (THE admin gate)
//           src/http/console-routes.ts (its one call site today)
//           CLAUDE.md red line: no silent failure / one value answers one question / anti-façade
//           *** HUMAN-AUDIT SENSITIVE (auth) ***
//
// WHY THIS FILE EXISTS. `test/billing-events-route.test.ts` already proves that
// GET /api/cloud/billing/orphans refuses a non-admin. What it CANNOT prove is
// that the NEXT route somebody adds is gated at all — a route added without a
// gate is invisible to every test that names routes one at a time. That gap is
// this repo's #1 historical bug shape wearing an auth costume: the capability
// (the gate) exists, and the new surface simply does not call it.
//
// 🔴 HOW THE ROT IS AVOIDED. The ENUMERATION is derived from the source, not
// hand-written: `scanRoutes()` reads console-routes.ts and extracts every
// (method, path) the handler actually matches on. The REGISTRY below only says
// WHICH GATE each of those is supposed to have. So:
//   · a new route with no registry entry  → RED ("undeclared route"), always;
//   · a deleted route still in the registry → RED ("declared but gone"), so the
//     registry cannot rot in the other direction either.
// A hand-maintained list of routes that nobody updates would be the same façade
// shape the file is trying to prevent, which is why the list is not of routes.
//
// ⚠️ WHAT IS STILL A HUMAN JUDGEMENT, stated plainly rather than papered over:
// nothing here can decide that a route SHOULD be admin-only. If a future ops
// route is added and declared `'account'`, this file goes green. What it
// guarantees is that the choice was made explicitly, in one place, by someone
// who had to type it — never by omission. That is the honest boundary.
//
// ⚠️ SCANNER LIMITS, so nobody mistakes it for a parser: it strips block comments
// and whole-line `//` comments, then reads `if (…) {` conditions. A route matched
// some other way (a lookup table, a regex, a `switch`) would be invisible to it —
// the failure mode is a MISSED route, so the counter-assertion is that the
// registry and the scan must agree exactly, and the scan must be non-empty.

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { signJwt } from '../src/auth/jwt';
import { ADMIN_GATED_ROUTES } from '../src/http/ops-audit-trail';
import { stripTsComments as stripComments } from '../../../verify/lint/strip-ts-comments.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');
/** 0.2.48 — the scan now covers BOTH Bearer-gated REST files. A new file was
 *  exactly the blind spot this suite was built to close one level down: a route
 *  added where the scanner is not looking is invisible to it, so adding
 *  `ops-routes.ts` to the sources is part of shipping `ops-routes.ts`.
 *
 *  🔴 MAIL-1 (2026-08-09) — `password-reset-routes.ts` joined the list the moment
 *  `POST /api/password/{forgot,reset}` moved out of console-routes.ts, and this
 *  suite is what NOTICED: the split alone turned the coverage assertion red with
 *  「REGISTRY declares routes no route source serves any more」, naming both
 *  routes. That is the direction this list can rot in, closed by a test rather
 *  than by remembering — and it is worth recording that the instrument worked on
 *  a move, not just on an addition. */
const ROUTE_SOURCES = [
  join(SRC, 'http', 'console-routes.ts'),
  join(SRC, 'http', 'password-reset-routes.ts'),
  join(SRC, 'http', 'ops-routes.ts'),
  // 🔴 A2-3 (2026-08-12) — `account-restriction-routes.ts` joined the list in the
  // same commit that created it, and adding it here is part of shipping it (the
  // 0.2.48 note above says exactly that about ops-routes.ts). It is a NEW FILE
  // holding a NEW ADMIN ROUTE, i.e. both blind spots this suite exists to close,
  // at once: a route added where the scanner is not looking is invisible to the
  // scan, and an admin route with no REGISTRY entry is a route nobody classified.
  join(SRC, 'http', 'account-restriction-routes.ts'),
  // A2-4 (2026-08-12) — `ops-user-routes.ts`, added in the same commit that
  // created it, for the reason the two notes above give: a route added where the
  // scanner is not looking is invisible to the scan. This one is additionally the
  // FIRST route source that holds `UserRecord`s (M2-7 can only be projected away
  // here, not made unreachable), so the file being scanned at all is what keeps
  // its two routes classified.
  join(SRC, 'http', 'ops-user-routes.ts'),
  // A2-5 / REQ-12-08 (2026-08-12) — `usage-events-routes.ts`, added in the same
  // commit that created it, for the reason every note above gives. It holds an
  // 'account'-gated route rather than an admin one, and that is exactly why it
  // must be scanned: the blind spot this suite closes is 「a route added where
  // the scanner is not looking」, and a route that ought to be account-scoped is
  // as invisible to the scan as one that ought to be admin-gated.
  join(SRC, 'http', 'usage-events-routes.ts'),
  // 2026-08-12 — `account-lifecycle-routes.ts`, added in the same commit that
  // created it (the 800-line cap forced GET /api/account/export + POST
  // /api/account/delete out of console-routes.ts). This is the MAIL-1 shape
  // again, and the note at that entry is the one that matters: the last time
  // routes MOVED rather than appeared, this suite is what noticed — 「REGISTRY
  // declares routes no route source serves any more」, naming both. Registering
  // the new source here is what keeps that from being the answer this time.
  join(SRC, 'http', 'account-lifecycle-routes.ts'),
  // 2026-08-14 — signed-in POST /api/account/password. Same MAIL-1 shape:
  // a route in a file the scanner is not reading is invisible.
  join(SRC, 'http', 'account-password-routes.ts'),
  // 2026-08-14 — BYOK editor + TEST moved out of console-routes.ts. Same
  // MAIL-1 shape: a route in a file the scanner is not reading is invisible.
  join(SRC, 'http', 'byok-routes.ts'),
  // A2-5 / REQ-12-08 (2026-08-12) — `ops-usage-events-routes.ts`, added in the
  // same commit that created it. 🔴 THIS SUITE IS WHY THE ROUTE EXISTS AT ALL:
  // the handoff card said 「add the missing ADMIN_GATED_ROUTES literal」, and the
  // agreement assertion below is what makes that impossible on its own — a fence
  // entry for a route no source serves dies as 「declared but gone」. The literal
  // was missing because the route was.
  join(SRC, 'http', 'ops-usage-events-routes.ts'),
  // 2026-08-15 — first-party site aggregate ops reads. Same "register in the
  // same commit that creates the file" rule as every entry above.
  join(SRC, 'http', 'ops-site-routes.ts'),
];

const SECRET = 'admin-gate-coverage-secret-32-bytes-x';

/**
 * The three gates a console route can have. `'public'` is a real, deliberate
 * category — not "ungated by accident":
 *   · POST /api/logout must work with a dead/absent token, or an expired session
 *     could never be signed out of;
 *   · POST /api/password/{forgot,reset} are BY DEFINITION reachable by someone
 *     who cannot authenticate. They are throttled per-IP instead.
 * Writing them down as `'public'` is what makes 「this route has no gate」 a decision on
 * the record rather than an absence nobody noticed.
 */
type Gate = 'public' | 'account' | 'admin';

const REGISTRY: Readonly<Record<string, Gate>> = {
  'POST /api/logout': 'public',
  'POST /api/password/forgot': 'public',
  'POST /api/password/reset': 'public',
  'GET /api/cloud/summary': 'account',
  'GET /api/cloud/subscription': 'account',
  'GET /api/cloud/billing/events': 'account',
  // 🔴 The admin routes. Every one of them reads ACROSS accounts by design.
  'GET /api/cloud/billing/orphans': 'admin',
  // D11 — the ops_audit_log READ side (listRecent shipped 0.2.48 with zero HTTP
  // exposure — an audit trail nobody could read). Admin-gated for the same
  // reason as its siblings: it reads every admin's granted/denied rows, not
  // just the caller's own.
  'GET /api/ops/audit/recent': 'admin',
  // 0.2.48 — O-2 platform usage aggregation (docs/strategy/2026-08-02-o2-usage-route-contract.md).
  'GET /api/ops/usage/months': 'admin',
  'GET /api/ops/usage/summary': 'admin',
  'GET /api/ops/usage/users': 'admin',
  // 🔴 A2-3 — the FIRST admin-gated route in this table that CHANGES anything.
  // 'admin' and emphatically not 'account': it takes a `user_id` from the body
  // and acts on somebody else, which is the definition of cross-account. The
  // failure-policy consequence (a mutating route may not rely on the gate's
  // serve-but-shout audit write) is asserted in test/ops-audit-wiring.test.ts,
  // not here — this table only records that the gate choice was made on purpose.
  'POST /api/ops/users/restrict': 'admin',
  // A2-4 — the read-only account list and its single-account read. 'admin' for
  // the same reason as every other `/api/ops/` entry: they enumerate and read
  // ACROSS accounts. Note the detail route's shape — `?user_id=` rather than
  // `/:id` — is what lets ADMIN_GATED_ROUTES stay a list of literals.
  'GET /api/ops/users': 'admin',
  'GET /api/ops/users/detail': 'admin',
  // 🔴 A2-5 — 'account', and the classification is the whole design. It reads
  // the caller's OWN per-event usage log and takes NO `user_id` parameter at
  // all — there is nothing cross-account for an admin gate to protect, and an
  // admin gate here would lock every user out of their own record. The ops-side
  // twin (`GET /api/ops/usage/events?user_id=`) is a SEPARATE route — it LANDED
  // on 2026-08-12, and it is 'admin' with its own ADMIN_GATED_ROUTES literal,
  // exactly as this note predicted.
  'GET /api/cloud/usage/events': 'account',
  // 🔴 A2-5 — the ops-side twin. 'admin' because it takes `?user_id=` and reads
  // ACROSS accounts, which is the same line every other `/api/ops/` entry sits
  // on. Note the path shape: a QUERY PARAMETER rather than `/:id`, so
  // ADMIN_GATED_ROUTES stays a list of literals (ops-usage-events-routes.ts
  // §PATH SHAPE carries the full argument).
  'GET /api/ops/usage/events': 'admin',
  // 2026-08-15 — first-party public-site aggregate reads (VPN ops console).
  'GET /api/ops/site/summary': 'admin',
  'GET /api/ops/site/breakdown': 'admin',
  'GET /api/cloud/devices': 'account',
  'GET /api/cloud/stt-routings': 'account',
  'POST /api/cloud/stt-routings': 'account',
  'POST /api/cloud/stt-routings/test': 'account',
  'POST /api/cloud/devices/revoke': 'account',
  // 0.3.0 P4 — the GDPR pair (docs/legal/privacy-policy.md 「Your rights」).
  // 🔴 'account', emphatically NOT 'admin' and NOT 'public': both act on the
  // account the Bearer PROVED and neither takes a target parameter, so there is
  // nothing cross-account for an admin gate to protect — while a 'public'
  // deletion route would be an unauthenticated way to destroy an account. The
  // extra guard on the destructive one is a confirmation SHAPE
  // (src/http/account-lifecycle.ts `checkDeleteConfirmation`), which is a
  // different instrument from a gate: it does not ask WHO may call, it asks
  // whether this call was meant. A platform account (is_admin / permanent_free)
  // additionally has to acknowledge what it is deleting.
  'GET /api/account/export': 'account',
  'POST /api/account/delete': 'account',
  // 2026-08-14 — signed-in password change. 'account' not 'public': Bearer
  // required. Not a GDPR right, but the same identity-only gate — current
  // password is the extra factor, not email-verification or restriction.
  'POST /api/account/password': 'account',
};

/** Every `METHOD /api/...` pair the Bearer-gated REST handlers match on, read out
 *  of the sources themselves. */
function scanRoutes(): string[] {
  // 🔴 PER FILE, never over a concatenation. Joining the sources first lets the
  // non-greedy `[\s\S]*?` below bridge an unterminated `if (` at the end of one
  // file into a `) {` at the start of the next, producing a phantom "condition"
  // made of two unrelated files — which is exactly how this scan first went red
  // when ops-routes.ts was added (a throw about a path with no method, on a
  // condition that exists in neither file).
  return [...new Set(ROUTE_SOURCES.flatMap((f) => scanOneSource(readFileSync(f, 'utf8'))))].sort();
}

function scanOneSource(raw: string): string[] {
  const code = stripComments(raw);
  const out = new Set<string>();
  const conditions = /\bif\s*\(([\s\S]*?)\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = conditions.exec(code)) !== null) {
    const cond = m[1] as string;
    // `'/api/x'` and the `startsWith('/api/x?')` twin collapse to one path.
    const paths = new Set([...cond.matchAll(/'(\/api\/[^'?]*)\??'/g)].map((x) => x[1] as string));
    if (paths.size === 0) continue;
    const methods = new Set([...cond.matchAll(/method === '([A-Z]+)'/g)].map((x) => x[1] as string));
    // A route condition with a path but NO method would silently produce zero
    // pairs and hide the route entirely. Throw rather than drop it: a scanner
    // that quietly skips what it cannot parse is the same façade as a list that
    // nobody updates.
    if (methods.size === 0) {
      throw new Error(`scanRoutes: route condition names a path but no HTTP method — ${cond.trim()}`);
    }
    for (const p of paths) for (const mm of methods) out.add(`${mm} ${p}`);
  }
  return [...out].sort();
}

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFilesUnder(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('admin gate — route coverage is derived from the source, not from a list', () => {
  it('every route the handler matches on has a DECLARED gate (and vice versa)', () => {
    const scanned = scanRoutes();
    // A scanner that silently matched nothing would make this whole file green
    // and worthless — the classic 「the probe is blind」 failure. Pin the floor.
    expect(scanned.length).toBeGreaterThanOrEqual(14);
    const declared = Object.keys(REGISTRY).sort();
    // Both directions, and the messages tell the next author what to do.
    const undeclared = scanned.filter((r) => !(r in REGISTRY));
    expect(
      undeclared,
      `a route source matches these routes but REGISTRY does not classify them.\n` +
        `Add each one with its gate ('public' | 'account' | 'admin') — an ops route that reads across\n` +
        `accounts MUST be 'admin' and must refuse by name (403 ADMIN_ONLY), never with an empty 200.`,
    ).toEqual([]);
    const vanished = declared.filter((r) => !scanned.includes(r));
    expect(vanished, 'REGISTRY declares routes no route source serves any more — delete them.').toEqual([]);
    expect(scanned).toEqual(declared);
  });

  // ── 🔴 ONE GATE, ONE IMPLEMENTATION ───────────────────────────────────────
  it('exactly ONE place in src/ decides admin-ness', () => {
    // The whole-repo grep, as an assertion. `is_admin` may legitimately appear in
    // STORAGE (the DDL) and in the ONE projection that turns the column into a
    // boolean (user.repo.ts toRecord + its insert path). Anywhere else means a
    // second gate has been born, and two gates is how one of them ends up
    // admitting what the other rejects (the argument account-auth.ts already
    // makes for `bearerToken` / `accountFromBearer`).
    const hits: Record<string, number> = {};
    for (const f of tsFilesUnder(SRC)) {
      const n = (stripComments(readFileSync(f, 'utf8')).match(/is_admin/g) ?? []).length;
      if (n > 0) hits[relative(SRC, f).replace(/\\/g, '/')] = n;
    }
    expect(
      Object.keys(hits).sort(),
      'a new file reads users.is_admin — is it a SECOND admin gate? The gate is\n' +
        'http/account-auth.ts adminFromBearer; call it instead of re-deriving it.',
    ).toEqual(['db/repos/user.repo.ts', 'db/schema.ts', 'http/account-auth.ts']);
    // …and inside the gate module there is exactly ONE read: the decision itself.
    // Two would mean adminFromBearer grew a second branch, or a second function.
    expect(hits['http/account-auth.ts'], 'account-auth.ts now reads is_admin more than once').toBe(1);
    // console-routes.ts must hold NO copy of the decision — its `authAdmin` is a
    // delegate. This is the assertion that fails if the 0.2.38 body is ever
    // pasted back in beside the delegate.
    expect(hits['http/console-routes.ts']).toBeUndefined();
    // 0.2.48 — and neither does the trail wrapper, nor the ops surface. Both call
    // the gate; neither re-derives it.
    expect(hits['http/ops-audit-trail.ts']).toBeUndefined();
    expect(hits['http/ops-routes.ts']).toBeUndefined();
  });

  it('the admin routes are the ones the registry says they are', () => {
    // Guards against a quiet re-classification: if someone flips orphans to
    // 'account', the behavioural sweep below would stop testing a 403 at all and
    // go green. This says out loud which routes are admin-gated.
    const admin = Object.entries(REGISTRY).filter(([, g]) => g === 'admin').map(([r]) => r).sort();
    expect(admin).toEqual([
      'GET /api/cloud/billing/orphans',
      'GET /api/ops/audit/recent',
      'GET /api/ops/site/breakdown',
      'GET /api/ops/site/summary',
      'GET /api/ops/usage/events', // A2-5 — one account's usage DETAIL
      'GET /api/ops/usage/months',
      'GET /api/ops/usage/summary',
      'GET /api/ops/usage/users',
      'GET /api/ops/users', // A2-4 — the account list
      'GET /api/ops/users/detail', // A2-4 — one account, by id
      'POST /api/ops/users/restrict', // A2-3 — the one that mutates
    ]);
  });

  it('🔴 0.2.48 — the audit gate\'s route fence and this REGISTRY agree exactly', () => {
    // TWO lists, maintained by DIFFERENT means, forced to agree:
    //   · ADMIN_GATED_ROUTES (src) is a TYPE FENCE — its job is to make a caller-
    //     supplied string unrepresentable as an audit `target_id`, and the
    //     compiler refuses any `adminGate` call not listed there;
    //   · REGISTRY (this file) is checked against routes SCANNED OUT OF THE SOURCE.
    // Neither can drift alone: a new admin route that skips the fence will not
    // compile, and a fence entry for a route nobody serves dies here.
    const declaredAdmin = Object.entries(REGISTRY).filter(([, g]) => g === 'admin').map(([r]) => r).sort();
    expect(
      [...ADMIN_GATED_ROUTES].sort(),
      'ADMIN_GATED_ROUTES (src/http/ops-audit-trail.ts) and the admin entries of this\n' +
        'REGISTRY disagree. One of them names a route the other does not — which means\n' +
        'either an admin route leaves no audit trail, or the fence has a stale entry.',
    ).toEqual(declaredAdmin);
  });
});

// ── Behavioural half: a REAL saas server, three identities ──────────────────
//
// ⚠️ WHICH KIND OF TEST THIS IS: unlike billing-events-route.test.ts (which
// assembles ConsoleRoutesDeps by hand and therefore proves nothing about
// wiring), this boots the real bootstrap. So it additionally proves that the
// gate and the ledger dep are wired in production shape — a `console: {…}` that
// forgot `billingLedger` would fail here and pass there.
describe('admin gate — every declared gate is what the running server actually does', () => {
  let server: BootstrapHandle | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  async function saas(): Promise<{ url: string; handle: BootstrapHandle }> {
    // 0.3.0 M5: saas + mock billing REFUSES TO MOUNT (router.ts
    // `assertMockBillingMountable`). Dropping the flag cannot weaken this suite:
    // the routes it enumerates come from console-routes.ts + ops-routes.ts, and
    // the mock gateway lives in router.ts under `/api/billing/*` — a prefix the
    // REGISTRY above does not contain and this file never requests (grep: 0
    // hits). `GET /api/cloud/billing/{events,orphans}` are Paddle-ledger reads,
    // a different surface from the mock gateway that shares only the word.
    // fix-010: an in-process server has no proxy in front of it — its direct peer
    // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
    const config = loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] });
    server = await startServer(config);
    return { url: `http://127.0.0.1:${server.port}`, handle: server };
  }

  async function call(url: string, route: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
    const [method, path] = route.split(' ') as [string, string];
    const res = await fetch(`${url}${path}`, {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json', ...headers }, body: '{}' } : { headers }),
    });
    return { status: res.status, body: await res.text() };
  }

  /** A real registered account — is_admin = 0, like every account the product
   *  can mint. */
  async function normalBearer(url: string): Promise<Record<string, string>> {
    const res = await fetch(`${url}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'normal@gate.co', password: 'longenough1', display_name: 'N' }),
    });
    const json = (await res.json()) as { token: string; user: { id: string } };
    // VERIFY-1 — the ADMIN gate is this suite's subject; the account is held
    // verified so the probes measure is_admin, not the verification gate
    // (which test/email-verification.test.ts proves on its own).
    server!.db.emailVerification.markVerified(json.user.id, Date.now());
    return { authorization: `Bearer ${json.token}` };
  }

  /** An admin. The flag is written through `UserRepo.insert` — the ONLY writer of
   *  that column — rather than by UPDATE, so the bit under test is the real one;
   *  the token is a real HS256 JWT the running server verifies for itself. */
  function adminBearer(handle: BootstrapHandle): Record<string, string> {
    const user = handle.db.users.insert({ id: 'u-gate-admin', email: 'admin@gate.co', display_name: 'A', is_admin: true });
    // VERIFY-1 — same reason as normalBearer: this suite measures the admin
    // bit, so the account is held verified through the real repo.
    handle.db.emailVerification.markVerified(user.id, Date.now());
    const token = signJwt({ sub: user.id, plan: user.plan }, { secret: Buffer.from(SECRET, 'utf8') });
    return { authorization: `Bearer ${token}` };
  }

  it('public → not refused; account → 401 by name then admitted; admin → 403 ADMIN_ONLY for a normal account', async () => {
    const { url, handle } = await saas();
    const normal = await normalBearer(url);
    const admin = adminBearer(handle);

    for (const [route, gate] of Object.entries(REGISTRY)) {
      const anon = await call(url, route);
      if (gate === 'public') {
        // Reachable without a credential ON PURPOSE. (429 is legal here too — the
        // password pair is throttled per IP — hence "not a credential refusal"
        // rather than "200".)
        expect(anon.status, `${route} is declared public but refused an anonymous caller`).not.toBe(401);
        expect(anon.status, `${route} is declared public but refused an anonymous caller`).not.toBe(403);
        continue;
      }
      // 🔴 An anonymous caller gets a NAMED 401 — never an empty 200. An empty
      // list is an ANSWER, and answering 「you have no…」 to someone who never proved
      // who they are is both a lie and an oracle.
      expect(anon.status, `${route} did not refuse an anonymous caller`).toBe(401);
      expect(JSON.parse(anon.body).error, `${route}'s 401 is not named`).toBe('AUTH_TOKEN_INVALID');

      const asNormal = await call(url, route, normal);
      if (gate === 'account') {
        // A plain account is ADMITTED (400 for a malformed POST body is fine —
        // what must not happen is 401/403).
        expect(asNormal.status, `${route} is declared 'account' but refused a valid account`).not.toBe(401);
        expect(asNormal.status, `${route} is declared 'account' but refused a valid account`).not.toBe(403);
        continue;
      }
      // gate === 'admin'
      expect(asNormal.status, `${route} is declared 'admin' but did not refuse a normal account`).toBe(403);
      expect(JSON.parse(asNormal.body).error, `${route}'s refusal is not named`).toBe('ADMIN_ONLY');
      // 🔴 The POSITIVE half: an admin asking the SAME question of the SAME server
      // is admitted. Without it, the 403 above could equally mean 「the route was never mounted」.
      //
      // 🔴 0.3.0 D11 —— the third assertion below was added this round, **and the act of adding it overturned the reason I added it,
      // so the reason is rewritten from what was measured** (repo rule: reverse-control evidence only counts as 「I watched it go red」,
      // and what was seen must not be rewritten into what was predicted).
      //   · The failure shape I predicted: `bootstrap.ts` omits the required `ops.auditLog`
      //     ⇒ the handler reads a property off undefined ⇒ **answers 500**, and `not.toBe(403)` +
      //     `not.toBe(401)` is green on 500 ⇒ need a `<500`.
      //   · 【measured】drop that line and actually run it once, **there is no 500 at all**:
      //     `TypeError: Cannot read properties of undefined (reading 'listRecent')`
      //     it escapes the handler directly, **this request answers not one byte**, and the test hangs until
      //     `Test timed out in 5000ms` (that TypeError shows up in the vitest summary as an unhandled error,
      //     not on any assertion).
      //   ⇒ **What actually bites the D11 half-finished state is the timeout, not this new assertion.**
      //     This scan was already red then; nobody ran it again — and `tsc` was red at the same time.
      // ⚠️ So why keep this `<500`: it guards a **different** failure shape — the handler catches its own
      //   exception and answers 500. That one does not time out, has no unhandled error, and quietly
      //   walks under `not.toBe(403)` / `not.toBe(401)`. **This assertion has not been measured going red**;
      //   that is written here on purpose — do not read it as 「verified」.
      const asAdmin = await call(url, route, admin);
      expect(asAdmin.status, `${route} refused an ADMIN`).not.toBe(403);
      expect(asAdmin.status, `${route} refused an ADMIN`).not.toBe(401);
      expect(
        asAdmin.status,
        `${route} let an ADMIN through the gate and then FAILED with a 5xx — the gate\n` +
          `admitting and the handler working are two different sentences.\n` +
          `body: ${asAdmin.body.slice(0, 200)}`,
      ).toBeLessThan(500);
    }
  });

  // ── 🔴 REVERSE CONTROL, on the real server ────────────────────────────────
  it("a non-admin's 403 carries no row, and an admin against the SAME db gets it", async () => {
    const { url, handle } = await saas();
    const normal = await normalBearer(url);
    const admin = adminBearer(handle);
    // A real orphan: claimed and never finished, so `user_id IS NULL` and no
    // per-user surface can ever show it. Written through the repo, so the ledger's
    // own invariants are exercised rather than bypassed.
    handle.db.billing.claimEvent({
      event_id: 'evt_gate_probe',
      notification_id: 'ntf_gate_probe',
      event_type: 'subscription.activated',
      occurred_at: '2026-08-02T00:00:00.000Z',
      received_at: '2026-08-02T00:00:00.000Z',
    });

    const refused = await call(url, 'GET /api/cloud/billing/orphans', normal);
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body).error).toBe('ADMIN_ONLY');
    // Not one ledger field leaked into the refusal body — the negative half is
    // asserted on the WHOLE serialized body, not on a field name a nested echo
    // could slip past.
    expect(refused.body).not.toContain('evt_gate_probe');

    const allowed = await call(url, 'GET /api/cloud/billing/orphans', admin);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain('evt_gate_probe');
    // …and this is also the only place `billingLedger` is proven to be wired by
    // BOOTSTRAP rather than by a test's hand-built deps object.
    expect(JSON.parse(allowed.body).orphans[0]).toMatchObject({ event_id: 'evt_gate_probe', outcome: 'pending', user_id: null });
  });

  it('an EXPIRED admin token is 401, not 403 — 「you have not proved who you are」 is not 「you are not an admin」', async () => {
    const { url, handle } = await saas();
    const user = handle.db.users.insert({ id: 'u-stale-admin', email: 'stale@gate.co', display_name: 'S', is_admin: true });
    const token = signJwt(
      { sub: user.id, plan: user.plan },
      { secret: Buffer.from(SECRET, 'utf8'), ttlMs: 1_000, now: () => Date.now() - 60_000 },
    );
    const r = await call(url, 'GET /api/cloud/billing/orphans', { authorization: `Bearer ${token}` });
    // Three answers, not two: this account IS an admin, but the credential is
    // dead — so the honest reply names the credential, and tells the client to
    // re-login rather than to go ask for a permission it already has.
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body).error).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('standalone mounts NO console route at all — the gate is not what keeps them shut there', async () => {
    // Worth pinning next to the gate: in standalone these paths 404 because the
    // module is not mounted, NOT because someone failed an admin check. If that
    // ever changed to a 403, the mode gating would have been replaced by an auth
    // gate — a different, weaker thing.
    server = await startServer(loadConfig({ mode: 'standalone', secret: SECRET, port: 0, dbPath: ':memory:' }));
    const url = `http://127.0.0.1:${server.port}`;
    for (const route of Object.keys(REGISTRY)) {
      const r = await call(url, route);
      expect(r.status, `${route} should be unmounted (404) in standalone`).toBe(404);
    }
  });
});
