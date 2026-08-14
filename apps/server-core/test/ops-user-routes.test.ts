// A2-4 (2026-08-12) — the cross-account USER LIST (`/api/ops/users` and its
// single-account read).
//
// SPEC-REF: docs/strategy/2026-08-02-o3-user-management-final.md §3 R1/R2 (THE
//             contract this implements)
//           docs/strategy/2026-08-12-req1207-admin-user-management-design.md §2
//             (§2.1 the contract, §2.2 the two mines, §2.3 why 「login information」 is not
//             here, §2.4 why USAGE is not here)
//           src/http/ops-user-routes.ts / src/db/repos/user.repo.ts `toOpsUser`
//           CLAUDE.md red line: no silent failure / one value answers one question / anti-façade
//
// 🔴 WHY THIS BOOTS A REAL SERVER rather than assembling deps by hand: the thing
// most likely to be wrong about a new route is that nothing mounts it. A suite
// that builds `OpsUserRoutesDeps` itself proves the handler works and goes green
// against a bootstrap that never wires it — i.e. it tests everything except the
// defect this repo has shipped most often. `startServer` + `fetch` is the only
// shape that can tell 「this route exists」 from 「this function exists」.
//
// ⚠️ WHAT IT STILL DOES NOT PROVE: that any of this works in production. Nothing
// here has been deployed and no operator has ever called it. The honest grade for
// everything below is 【unit-test proven + not deployed】, never 「verified」.
//
// ── 🔴 REVERSE CONTROL, MEASURED (2026-08-12, LAN lead-dev machine) ────────────────
// The M2-7 assertions were proved to bite by widening `toOpsUser` in
// src/db/repos/user.repo.ts with ONE line — `password_hash: u.password_hash` —
// and running this file. TWO tests went red (20 passed | 2 failed), and the
// failure text is transcribed rather than paraphrased:
//
//   FAIL … > 🔴 M2-7 … > the hash IS in the database (positive control) and is
//            in NEITHER body
//   AssertionError: /api/ops/users?limit=200 leaked a password hash: expected
//     '{"rows":[{"id":"default","email":null…' not to contain
//     'pbkdf2$MARKER_HASH_MUST_NEVER_LEAVE_T…'
//
//   FAIL … > the projection is EXACTLY the declared whitelist, field for field
//   AssertionError: the ops projection changed shape. …
//     + Received  "password_hash",
//
// The line was then removed; `grep -rn "REVERSE-CONTROL-A24" src` and
// `grep -rn "password_hash: u.password_hash" src` both return 0, and the file is
// 22/22 green again.
//
// 🔴 TWO THINGS THE MEASUREMENT CHANGED ABOUT WHAT I EXPECTED, recorded because
// the rule is that a reverse control's evidence is what was SEEN, not what was
// predicted:
//   ① the leaked body starts with `"id":"default"`, not `"id":"u-admin"` — there
//      is an account in every saas database that this test did not create (see
//      SEED_IDS). I had written the expected transcript with u-admin first;
//   ② the SHAPE assertion is the more valuable of the two, and it is the one I
//      added second. The marker assertion catches THIS column under THIS name; a
//      future column called `secret_token` would sail past it and fail only the
//      shape check. Keep both, and if one has to go, keep the shape.

import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '@flowmic/protocol';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { signJwt } from '../src/auth/jwt';
import { OPS_USER_PAGE_MAX } from '../src/db/repos/user.repo';
import { OPS_USER_Q_MAX, OPS_USER_UNKNOWN } from '../src/http/ops-user-routes';
import { ADMIN_GATE_DENIED, ADMIN_GATE_GRANTED } from '../src/http/ops-audit-trail';

const SECRET = 'ops-user-routes-secret-32-bytes-min-x';

/** A value that exists ONLY inside `users.password_hash`. If it ever shows up in
 *  an HTTP body, M2-7 has landed on this surface. */
const HASH_MARKER = 'pbkdf2$MARKER_HASH_MUST_NEVER_LEAVE_THE_DB';

/** The ms-epoch written into `restricted_at` for the one restricted seed. A
 *  fixed, recognisable number so a wrong field cannot coincidentally look right. */
const RESTRICTED_AT = 1_765_432_109_876;

const LIST = '/api/ops/users';
const DETAIL = '/api/ops/users/detail';

/** THE whitelist, written down a SECOND time on purpose and by a different hand
 *  than `toOpsUser`'s object literal. Two lists maintained by different means,
 *  forced to agree — the technique ADMIN_GATED_ROUTES/REGISTRY already uses. A
 *  single list could be widened in one edit; this one cannot. */
const OPS_USER_FIELDS = [
  'created_at',
  'display_name',
  'email',
  'id',
  'is_admin',
  'permanent_free',
  'restricted',
  'restricted_at',
  // Q2 (2026-08-12) — WHICH publishable reason the account holder is being
  // shown. 🔴 The operator's FREE TEXT is deliberately NOT on this list and must
  // never join it: it lives in `ops_audit_log.detail`, and a list screen is not
  // an audit trail. This array is the thing that makes adding it a deliberate
  // edit rather than a spread.
  'restriction_reason',
].sort();

let server: BootstrapHandle | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

interface Res {
  status: number;
  body: string;
  json: Record<string, unknown>;
}

async function saas(): Promise<{ url: string; handle: BootstrapHandle }> {
  server = await startServer(
    // fix-010: an in-process server has no proxy in front of it — its direct peer
    // IS the client. A declared posture, not an exemption (config.ts §trustedProxies).
    loadConfig({ mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [] }),
  );
  return { url: `http://127.0.0.1:${server.port}`, handle: server };
}

async function get(url: string, path: string, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(`${url}${path}`, { headers });
  const body = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* a non-JSON body is itself a finding — `body` carries it to the assertion */
  }
  return { status: r.status, body, json };
}

function bearer(handle: BootstrapHandle, userId: string): Record<string, string> {
  const user = handle.db.users.findById(userId);
  if (!user) throw new Error(`test setup: no such user ${userId}`);
  const token = signJwt({ sub: user.id, plan: user.plan }, { secret: Buffer.from(SECRET, 'utf8') });
  return { authorization: `Bearer ${token}` };
}

/**
 * Eight accounts, and every one of them is bait for a specific assertion.
 *
 * 🔴 The admin carries `password_hash` AND a DRIFTED `users.plan` ('pro' with no
 * subscription behind it, so the effective tier is 'free') — the two M2 mines.
 * `u-mixed` is stored lower-cased by the repo but is SEARCHED for in upper case.
 * `u-pct` has a literal `%` in its display name, which is how the LIKE-escaping
 * assertion tells 「search for a percent sign literally」 from 「return everything」.
 *
 * 🔴 THE NINTH ID IS `default`, AND NOBODY IN THIS FILE CREATED IT. bootstrap
 * inserts a 'Local User' account UNCONDITIONALLY at startup (its comment calls it
 * the 「Standalone FK seed」, but the `if` around it tests only whether the row
 * already exists — not the mode), so every saas deployment has one too. It is
 * listed here rather than filtered out, because filtering it would make this
 * suite disagree with what an operator will actually see on the real console.
 * ⚠️ Reported with the card as a finding about bootstrap, not fixed here.
 *
 * NINE is not an arbitrary count: the paging test uses limit 3, so the LAST page
 * is exactly full — the one case `rows.length < limit` gets wrong.
 */
const SEED_IDS = ['default', 'u-admin', 'u-mixed', 'u-normal', 'u-p1', 'u-p2', 'u-p3', 'u-p4', 'u-pct'].sort();

function seed(handle: BootstrapHandle): void {
  handle.db.users.insert({
    id: 'u-admin',
    email: 'admin@ops.co',
    display_name: 'Admin',
    is_admin: true,
    password_hash: HASH_MARKER,
    plan: 'pro', // deliberately drifted: nothing has been paid for
  });
  handle.db.users.insert({ id: 'u-normal', email: 'normal@ops.co', display_name: 'Normal' });
  handle.db.users.insert({ id: 'u-mixed', email: 'Mixed.Case@Ops.CO', display_name: 'Casey Office' });
  handle.db.users.insert({ id: 'u-pct', display_name: '100% Coverage' });
  for (const id of ['u-p1', 'u-p2', 'u-p3', 'u-p4']) {
    handle.db.users.insert({ id, email: `${id}@ops.co`, display_name: id });
  }
  // The restriction A2-3 writes, written through the SAME repo method that route
  // uses — so what this list renders is the real column, not a test fixture.
  handle.db.users.setRestricted('u-p4', RESTRICTED_AT, 'account_security');
  // The seed's own precondition, asserted rather than assumed: everything below
  // reasons about how many accounts exist, and the count includes a row this
  // file did not write (see SEED_IDS). If bootstrap ever seeds another one, THIS
  // is the line that says so, instead of four paging assertions failing with
  // arithmetic that looks like a route bug.
  expect(handle.db.users.listAll().map((u) => u.id).sort()).toEqual(SEED_IDS);
}

/** Every column of every account row, as one comparable string. `bigint` is
 *  stringified rather than dropped: node:sqlite can hand back either, and a
 *  JSON.stringify that threw would look like a test bug instead of a finding. */
function usersSnapshot(handle: BootstrapHandle): string {
  const rows = handle.db.raw.prepare('SELECT * FROM users ORDER BY id ASC').all();
  return JSON.stringify(rows, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

// ── ① the gate: three answers, not two ─────────────────────────────────────────────────
describe('/api/ops/users — the gate answers 401 / 403 / 200, never an empty list', () => {
  it('anonymous → 401 AUTH_TOKEN_INVALID on both routes', async () => {
    const { url, handle } = await saas();
    seed(handle);
    for (const path of [LIST, `${DETAIL}?user_id=u-normal`]) {
      const r = await get(url, path);
      expect(r.status, `${path} admitted an anonymous caller`).toBe(401);
      expect(r.json.error, `${path}'s 401 is not named`).toBe('AUTH_TOKEN_INVALID');
      // 🔴 An empty 200 would be a lie AND an oracle. Assert no account leaked
      // into the refusal at all.
      expect(r.body).not.toContain('admin@ops.co');
    }
  });

  it('a normal account → 403 ADMIN_ONLY, and an admin against the SAME server → 200', async () => {
    const { url, handle } = await saas();
    seed(handle);
    for (const path of [LIST, `${DETAIL}?user_id=u-normal`]) {
      const refused = await get(url, path, bearer(handle, 'u-normal'));
      expect(refused.status, `${path} did not refuse a normal account`).toBe(403);
      expect(refused.json.error).toBe('ADMIN_ONLY');
      expect(refused.body).not.toContain('admin@ops.co');
      // 🔴 THE POSITIVE CONTROL. Without it the 403 above could equally mean
      // 「this route was never mounted」, which is a different defect with a different fix.
      const allowed = await get(url, path, bearer(handle, 'u-admin'));
      expect(allowed.status, `${path} refused an ADMIN`).toBe(200);
    }
  });
});

// ── ② 🔴 M2-7: whitelist projection, with a positive control ────────────────────────────────────────
describe('🔴 M2-7 — no response body can carry a password hash', () => {
  it('the hash IS in the database (positive control) and is in NEITHER body', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');

    // 🔴 POSITIVE CONTROL FIRST. Without it, 「the marker is absent」 could simply
    // mean the seed never stored one — the probe would be blind and every
    // assertion below would be green for the wrong reason.
    expect(handle.db.users.findById('u-admin')?.password_hash).toBe(HASH_MARKER);
    expect(HASH_MARKER.length).toBeGreaterThan(10);

    for (const path of [`${LIST}?limit=${OPS_USER_PAGE_MAX}`, `${DETAIL}?user_id=u-admin`]) {
      const r = await get(url, path, admin);
      expect(r.status).toBe(200);
      // Asserted on the WHOLE serialized body, never on a field name: a nested
      // echo, a debug key or a future join would slip past a per-field check.
      expect(r.body, `${path} leaked a password hash`).not.toContain(HASH_MARKER);
      // Not just the value — the COLUMN NAME must not appear either. A projection
      // that emitted `password_hash: null` for some rows would be one schema
      // change away from emitting the real thing.
      expect(r.body, `${path} exposes the password_hash field`).not.toContain('password_hash');
    }
  });

  it('the projection is EXACTLY the declared whitelist, field for field', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');

    const list = await get(url, `${LIST}?limit=${OPS_USER_PAGE_MAX}`, admin);
    const rows = list.json.rows as Record<string, unknown>[];
    expect(rows).toHaveLength(SEED_IDS.length);
    for (const row of rows) {
      expect(
        Object.keys(row).sort(),
        'the ops projection changed shape. Every field on this surface is a decision:\n' +
          'add one only by editing BOTH `toOpsUser` and OPS_USER_FIELDS, which is the point.',
      ).toEqual(OPS_USER_FIELDS);
    }
    // The detail route must project through the SAME function — a second literal
    // there is exactly how one of the two grows a field.
    const detail = await get(url, `${DETAIL}?user_id=u-admin`, admin);
    expect(Object.keys(detail.json.user as Record<string, unknown>).sort()).toEqual(OPS_USER_FIELDS);
  });

  it('the restriction state is rendered as BOTH the verdict and the operator timestamp', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    const restricted = await get(url, `${DETAIL}?user_id=u-p4`, admin);
    expect(restricted.json.user).toMatchObject({
      restricted: true, restricted_at: RESTRICTED_AT, restriction_reason: 'account_security',
    });
    // …and the negative side, because a `restricted: true` that is true for
    // everybody proves nothing.
    const plain = await get(url, `${DETAIL}?user_id=u-p3`, admin);
    expect(plain.json.user).toMatchObject({ restricted: false, restricted_at: null, restriction_reason: null });
  });
});

// ── ③ 🔴 M2-8: no tier, and this path writes not one byte to the database ─────────────────────────────
describe('🔴 M2-8 — a read-only account list must not carry a tier, and must not write', () => {
  it('no `plan` anywhere in the list, and the drifted column survives both routes', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');

    // The bait: `users.plan` says 'pro' while nothing has been paid for.
    expect(handle.db.users.findById('u-admin')?.plan).toBe('pro');
    const before = usersSnapshot(handle);

    for (const path of [`${LIST}?limit=${OPS_USER_PAGE_MAX}`, `${LIST}?q=ops.co`, `${DETAIL}?user_id=u-admin`]) {
      const r = await get(url, path, admin);
      expect(r.status).toBe(200);
      // A list is a loop; a tier in it is `getPlan` per row, and `getPlan` writes.
      expect(r.body, `${path} published a tier`).not.toContain('"plan"');
      expect(r.body).not.toContain('"pro"');
    }

    // 🔴 THE NEGATIVE HALF, on the WHOLE table rather than on one column: nothing
    // about any account moved, not the tier and not anything beside it.
    expect(usersSnapshot(handle), 'a read route wrote to the users table').toBe(before);

    // 🔴 THE POSITIVE CONTROL, and it is the load-bearing half: prove the probe
    // can SEE a write. ONE direct getPlan() and the column is rewritten — so the
    // byte-identical snapshot above is the routes behaving, not the probe being
    // blind. (This is also why the deps carry no BillingService at all: the mine
    // is unreachable from the route, not merely unused.)
    expect(handle.billing.getPlan('u-admin').plan).toBe('free');
    expect(handle.db.users.findById('u-admin')?.plan).toBe('free');
    expect(usersSnapshot(handle)).not.toBe(before);
  });
});

// ── ④ limit: refuse out-of-range, do not clamp ────────────────────────────────────────────────
describe('?limit= — refused, never clamped', () => {
  it('junk and out-of-range values are 400 SETTINGS_SCHEMA_INVALID', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    for (const bad of ['0', '-1', '1.5', 'abc', '', String(OPS_USER_PAGE_MAX + 1), '10000']) {
      const r = await get(url, `${LIST}?limit=${bad}`, admin);
      expect(r.status, `limit=${bad} was accepted`).toBe(400);
      expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
      // 🔴 NOT CLAMPED: a caller that asked for 10 000 and got a page back would
      // have no way to know it did not get all of them.
      expect(r.body).not.toContain('rows');
    }
  });

  it('the boundary value is accepted, and absence means the default (positive control)', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    // Without this the test above could be passing because EVERY limit is
    // refused, which is a different (and equally broken) route.
    expect((await get(url, `${LIST}?limit=${OPS_USER_PAGE_MAX}`, admin)).status).toBe(200);
    expect((await get(url, `${LIST}?limit=1`, admin)).status).toBe(200);
    const dflt = await get(url, LIST, admin);
    expect(dflt.status).toBe(200);
    expect((dflt.json.rows as unknown[]).length).toBe(SEED_IDS.length);
  });
});

// ── ⑤ q: NOCASE, and wildcards are literals ────────────────────────────────────────────
describe('?q= — case-insensitive, and the wildcards belong to the operator', () => {
  it('an UPPER-CASE email finds the account the repo stored lower-cased', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    // The repo normalises on write, so the stored value differs in case from what
    // the operator types. `findByEmail` matches COLLATE NOCASE; a search that did
    // not would answer 「cannot find it」 for an account this same process can find — and on
    // screen 「we did not find it」 and 「it does not exist」 are the same picture.
    expect(handle.db.users.findById('u-mixed')?.email).toBe('mixed.case@ops.co');
    const r = await get(url, `${LIST}?q=MIXED.CASE%40OPS.CO`, admin);
    expect(r.status).toBe(200);
    expect((r.json.rows as { id: string }[]).map((x) => x.id)).toEqual(['u-mixed']);
  });

  it('a lower-case term finds a mixed-case display_name, and a substring is enough', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    const r = await get(url, `${LIST}?q=casey`, admin);
    expect((r.json.rows as { id: string }[]).map((x) => x.id)).toEqual(['u-mixed']);
  });

  it('🔴 `%` is searched for LITERALLY — it does not mean 「everything」', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    // Positive control built in: there are eight accounts, so an unescaped `%`
    // (LIKE '%%%') would come back with all of them. Exactly one has a percent
    // sign in its name.
    expect(SEED_IDS.length).toBeGreaterThan(1);
    const r = await get(url, `${LIST}?q=%25`, admin);
    expect(r.status).toBe(200);
    expect(
      (r.json.rows as { id: string }[]).map((x) => x.id),
      'a LIKE wildcard reached SQLite unescaped: the search returned every account',
    ).toEqual(['u-pct']);
    // `_` is the other one, and it matches a single character rather than
    // everything — so its failure mode is subtler and worth pinning too.
    expect(((await get(url, `${LIST}?q=_`, admin)).json.rows as unknown[])).toEqual([]);
  });

  it('an empty or oversized q is refused rather than silently ignored/truncated', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    for (const bad of ['', '%20%20']) {
      const r = await get(url, `${LIST}?q=${bad}`, admin);
      expect(r.status, `q=${bad} was treated as 「no filter」`).toBe(400);
      expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
    }
    const long = await get(url, `${LIST}?q=${'a'.repeat(OPS_USER_Q_MAX + 1)}`, admin);
    expect(long.status).toBe(400);
  });

  it('a term that matches nothing is an empty page, not an error', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    const r = await get(url, `${LIST}?q=nobody-by-that-name`, admin);
    expect(r.status).toBe(200);
    expect(r.json.rows).toEqual([]);
    expect(r.json.next_after_user_id).toBeNull();
  });
});

// ── ⑥ keyset paging: the end is a null cursor, not a row count ──────────────────────────────
describe('keyset paging — the walk ends on a null cursor, never on a row count', () => {
  it('an EXACTLY FULL last page still reports 「there is no next page」', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    // 9 accounts, limit 3 ⇒ THREE exactly-full pages, and the final one is still
    // the end. That is precisely the case `rows.length < limit` gets wrong, and
    // it fails in the direction that hands out a cursor forever.
    expect(SEED_IDS.length % 3, 'this test needs a total divisible by 3').toBe(0);
    let cursor: string | null = null;
    for (let page = 1; page <= SEED_IDS.length / 3; page += 1) {
      const suffix: string = cursor === null ? '' : `&after_user_id=${cursor}`;
      const r = await get(url, `${LIST}?limit=3${suffix}`, admin);
      const rows = r.json.rows as { id: string }[];
      expect(rows.length, `page ${page} was not full`).toBe(3);
      cursor = r.json.next_after_user_id as string | null;
      if (page < SEED_IDS.length / 3) {
        // Mid-walk: the cursor is the LAST ROW OF THIS PAGE, never anything else
        // — a cursor taken from the probe row would skip an account per page.
        expect(cursor, `page ${page} ended the walk early`).toBe(rows[2]?.id);
      }
    }
    expect(
      cursor,
      'the last page is exactly full and the route still handed out a cursor',
    ).toBeNull();
  });

  it('walking to the null cursor visits every account exactly once, in id order', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    const seen: string[] = [];
    let cursor: string | null = null;
    // Bounded so a route that never terminates fails as an assertion rather than
    // as a hung test — a timeout names the wrong thing.
    for (let hop = 0; hop < 20; hop += 1) {
      const path: string = cursor === null ? `${LIST}?limit=3` : `${LIST}?limit=3&after_user_id=${cursor}`;
      const r = await get(url, path, admin);
      expect(r.status).toBe(200);
      seen.push(...(r.json.rows as { id: string }[]).map((x) => x.id));
      cursor = r.json.next_after_user_id as string | null;
      if (cursor === null) break;
    }
    expect(cursor, 'paging never reached a null cursor').toBeNull();
    expect(seen).toEqual(SEED_IDS); // sorted ascending, no duplicates, nothing missed
  });

  it('a filtered walk pages over the FILTER, not over the table', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    // Seven of the nine accounts have an `@ops.co` address; `u-pct` and the
    // bootstrap-seeded `default` have no email at all. Paging two at a time makes
    // the last page a PARTIAL one, which is the other half of the pair the
    // exactly-full test above pins.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let hop = 0; hop < 20; hop += 1) {
      const suffix: string = cursor === null ? '' : `&after_user_id=${cursor}`;
      const r = await get(url, `${LIST}?q=%40ops.co&limit=2${suffix}`, admin);
      expect(r.status).toBe(200);
      // 🔴 The filter must survive every hop. A cursor implementation that
      // dropped `q` on page 2 would still terminate and would still look like a
      // working list — it would just quietly widen.
      expect((r.json.rows as unknown[]).length).toBeLessThanOrEqual(2);
      seen.push(...(r.json.rows as { id: string }[]).map((x) => x.id));
      cursor = r.json.next_after_user_id as string | null;
      if (cursor === null) break;
    }
    expect(cursor, 'the filtered walk never reached a null cursor').toBeNull();
    const NO_EMAIL = ['default', 'u-pct'];
    expect(seen).toEqual(SEED_IDS.filter((id) => !NO_EMAIL.includes(id)));
    // The accounts with no email at all never appear — the negative half, named,
    // so 「the filter took effect」 is not inferred from a count.
    for (const id of NO_EMAIL) expect(seen).not.toContain(id);
  });
});

// ── ⑦ single account: 404 is the answer, an empty 200 is not ────────────────────────────────────────
describe('/api/ops/users/detail — one account, by the id the ops surface speaks in', () => {
  it('an unknown id is a named 404, never a cheerful empty user', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const r = await get(url, `${DETAIL}?user_id=u-does-not-exist`, bearer(handle, 'u-admin'));
    expect(r.status).toBe(404);
    expect(r.json.error).toBe(OPS_USER_UNKNOWN);
    expect(r.body).not.toContain('"user"');
  });

  it('a missing user_id is a 400 — there is no 「default to somebody」', async () => {
    const { url, handle } = await saas();
    seed(handle);
    const admin = bearer(handle, 'u-admin');
    for (const path of [DETAIL, `${DETAIL}?user_id=`, `${DETAIL}?user_id=%20`]) {
      const r = await get(url, path, admin);
      expect(r.status, `${path} was accepted`).toBe(400);
      expect(r.json.error).toBe('SETTINGS_SCHEMA_INVALID');
    }
  });

  it('the id an audit row carries is the id this route accepts', async () => {
    // The consumer story, as an assertion: `ops_audit_log.target_id` is a bare
    // `users.id` and nothing else, so this route is what turns a trail row into a
    // name. If the two ever spoke different id shapes, the operator's only path
    // from 「who was restricted」 to 「who is that」 would break silently.
    const { url, handle } = await saas();
    seed(handle);
    handle.db.opsAudit.append({
      actor_user_id: 'u-admin',
      action: 'ops.user.restrict',
      target_kind: 'user',
      target_id: 'u-p4',
      detail: 'test',
    });
    const row = handle.db.opsAudit.listRecent(1)[0];
    const r = await get(url, `${DETAIL}?user_id=${String(row?.target_id)}`, bearer(handle, 'u-admin'));
    expect(r.status).toBe(200);
    expect((r.json.user as { id: string }).id).toBe('u-p4');
  });
});

// ── ⑧ leave a trail: one row per admitted request, named as the route itself ───────────────────────────────────
describe('ops_audit_log — every read of this surface leaves a row naming the route', () => {
  it('an admitted request writes exactly one granted row per route', async () => {
    const { url, handle } = await saas();
    seed(handle);
    expect(handle.db.opsAudit.listRecent(50)).toEqual([]); // clean slate
    const admin = bearer(handle, 'u-admin');

    await get(url, `${LIST}?limit=5`, admin);
    await get(url, `${DETAIL}?user_id=u-p1`, admin);
    const rows = handle.db.opsAudit.listRecent(50);
    expect(rows).toHaveLength(2);
    // 🔴 The route literal, and NOT `req.url` — the query string (`?limit=5`,
    // `?user_id=…`) must never reach the table. That is what ADMIN_GATED_ROUTES
    // exists to make impossible, asserted here on the stored value.
    expect(rows.map((r) => r.target_id).sort()).toEqual([DETAIL, LIST].map((p) => `GET ${p}`).sort());
    for (const r of rows) {
      expect(r).toMatchObject({ actor_user_id: 'u-admin', action: ADMIN_GATE_GRANTED, target_kind: 'route' });
      expect(r.target_id).not.toContain('?');
      expect(r.target_id).not.toContain('u-p1');
    }
  });

  it('a 403 writes a DENIED row naming who was refused', async () => {
    const { url, handle } = await saas();
    seed(handle);
    await get(url, LIST, bearer(handle, 'u-normal'));
    const rows = handle.db.opsAudit.listRecent(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: 'u-normal', // proven: this caller authenticated fine
      action: ADMIN_GATE_DENIED,
      target_id: `GET ${LIST}`,
    });
  });
});

// ── ⑨ this refusal string is HTTP-local, not a protocol code ───────────────────────────────────
describe('OPS_USER_UNKNOWN is an operator diagnostic, not a protocol code', () => {
  it('it is pinned OUT of the protocol table', () => {
    // The VPN-only admin console is the only client that can reach the route, so
    // this rides the KEYMETA_NOT_FOUND / RESTRICT_TARGET_UNKNOWN precedent.
    // Minting a real code is owner-gated; pinning it here keeps 「add a code」 a
    // decision rather than a drift.
    expect(Object.keys(ERROR_CODES), `${OPS_USER_UNKNOWN} drifted into the protocol table`)
      .not.toContain(OPS_USER_UNKNOWN);
  });
});
