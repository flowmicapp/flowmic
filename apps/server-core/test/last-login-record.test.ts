// LOGIN-1 (2026-08-19) — `users.last_login_at`: the sign-in record the owner
// approved on 2026-08-11 and nobody built.
//
// SPEC-REF: docs/decisions/owner-web-rulings/latest.md:59-62 (THE ruling —
//             「上次登录时间 / 登录流水」→「要记，并同步改隐私政策」, option value
//             `approve_with_policy`)
//           src/auth/auth-service.ts `recordSignIn` (THE writer, and the
//             enumeration of which paths count)
//           src/db/schema.ts `users.last_login_at` + src/db/connection.ts
//             reconcileSchema (the column; its migration is proved in
//             test/migration-idempotency.test.ts, not here)
//           src/db/repos/user.repo.ts `OpsUserView` (the three-state read)
//           src/config.ts `loginRecordEnabled` (the switch, DEFAULT OFF)
//           docs/legal/privacy-policy.md 「What we collect and why」
//           CLAUDE.md red lines: no silent failure / one value answers one
//             question / anti-façade
//
// ── 🔴 WHY THIS CARD EXISTED AT ALL, KEPT HERE BECAUSE IT IS THE LESSON ───────
// The ruling was submitted 2026-08-11T23:23:05Z. The commit that wrote 「Adding
// `users.last_login_at` … is an owner gate; nothing here may open it」 into
// src/http/ops-user-routes.ts is `b1ad6311`, authored 2026-08-12T03:55:36Z —
// FOUR AND A HALF HOURS LATER. Meanwhile a THIRD hand added the disclosure row
// to docs/legal/privacy-policy.md in `82ba0e61` (2026-08-12T05:13:43Z).
// ⇒ For a week the repo simultaneously (a) had owner's approval, (b) promised
// the collection to the public, and (c) carried a code comment forbidding it.
// Each artefact read like a settled decision on its own. Nothing was red.
//
// ── 🔴 WHAT THIS FILE PROVES, AND WHAT IT CANNOT ──────────────────────────────
// Every test below boots the REAL bootstrap and speaks over a real port —
// because the defect this repo ships most often is 「the function exists and
// nothing calls it」, which a suite that assembles deps by hand cannot see.
// ⚠️ Nothing here has been deployed and no operator has called it. The honest
// grade for all of it is 【unit-test proven + not deployed】, never 「verified」.
//
// ── 🔴 REVERSE CONTROL, MEASURED (2026-08-19, dev-pc-a) ────────────────
// Two of them, transcribed verbatim in the block at the FOOT of this file
// (grep `CONTROL A —` / `CONTROL B —`). Read them before trusting anything here:
// one of the two shows this header's own first draft predicting a failure count
// that turned out to be wrong.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { startServer, type BootstrapHandle } from '../src/bootstrap';
import { loadConfig, type LoadConfigOverrides } from '../src/config';
import { signJwt } from '../src/auth/jwt';

const SECRET = 'last-login-record-secret-32-bytes-xx';
const EMAIL = 'signin@login.co';
const PASSWORD = 'longenough1';

let server: BootstrapHandle | null = null;
const sockets: ClientSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  if (server) await server.close();
  server = null;
});

/** A real saas server. `loginRecordEnabled` is passed EXPLICITLY in both
 *  directions rather than relying on the env var being unset — a test whose OFF
 *  case depends on `process.env` not containing something passes on this machine
 *  and fails on the machine where an operator exported it. */
async function saas(overrides: Partial<LoadConfigOverrides> = {}): Promise<string> {
  server = await startServer(
    // fix-010: an in-process server has no proxy in front of it — its direct
    // peer IS the client (config.ts §trustedProxies).
    loadConfig({
      mode: 'saas', secret: SECRET, port: 0, dbPath: ':memory:', mockBilling: false, trustedProxies: [],
      ...overrides,
    }),
  );
  return `http://127.0.0.1:${server.port}`;
}

function handle(): BootstrapHandle {
  if (!server) throw new Error('test bug: no server');
  return server;
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{
  status: number; json: Record<string, unknown>;
}> {
  const r = await fetch(`${url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { __raw: text }; }
  return { status: r.status, json };
}

async function getJson(url: string, path: string, headers: Record<string, string> = {}): Promise<{
  status: number; json: Record<string, unknown>;
}> {
  const r = await fetch(`${url}${path}`, { headers });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { __raw: text }; }
  return { status: r.status, json };
}

/** Register an account and return its id + the token registration handed back. */
async function register(url: string, email = EMAIL): Promise<{ id: string; token: string }> {
  const r = await post(url, '/api/register', { email, password: PASSWORD });
  expect(r.status, `register failed: ${JSON.stringify(r.json)}`).toBe(201);
  const user = r.json.user as { id: string };
  return { id: user.id, token: r.json.token as string };
}

/** Read the column straight out of SQLite — never through the surface under
 *  test. A read that went through `toOpsUser` could not tell 「nothing was
 *  written」 from 「something was written and the projection hid it」, and this
 *  file has to distinguish exactly those two. */
function storedLastLogin(userId: string): number | null {
  const row = handle().db.raw
    .prepare('SELECT last_login_at FROM users WHERE id=?')
    .get(userId) as { last_login_at: number | null } | undefined;
  if (!row) throw new Error(`test setup: no such user ${userId}`);
  return row.last_login_at;
}

/** Every column of one account EXCEPT the one under test, as a comparable
 *  string — so 「a sign-in moved something else」 is a failure with a diff. */
function otherColumns(userId: string): string {
  const row = handle().db.raw.prepare('SELECT * FROM users WHERE id=?').get(userId) as Record<string, unknown>;
  const { last_login_at: _ignored, ...rest } = row;
  return JSON.stringify(rest, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function adminBearer(userId: string): Record<string, string> {
  const user = handle().db.users.findById(userId);
  if (!user) throw new Error(`test setup: no such user ${userId}`);
  return { authorization: `Bearer ${signJwt({ sub: user.id, plan: user.plan }, { secret: Buffer.from(SECRET, 'utf8') })}` };
}

function connect(url: string, auth: Record<string, unknown> = {}): Promise<ClientSocket> {
  const socket = ioClient(url, { transports: ['websocket'], auth, forceNew: true, reconnection: false });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function ackOf(socket: ClientSocket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} ack timeout`)), 5000);
    socket.emit(event, payload, (r: Record<string, unknown>) => { clearTimeout(t); resolve(r ?? {}); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('LOGIN-1 · the three sign-in paths that COUNT', () => {
  it('POST /api/login stamps last_login_at (path 1 of 3 — password over REST)', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id } = await register(url);
    // 🔴 THE PRECONDITION IS AN ASSERTION, not a hope: registration must leave
    // it NULL, or every 「it got stamped」 below would be green on the wrong
    // write. This is the exclusion in ①'s own words, checked before the act.
    expect(storedLastLogin(id), 'registration must not stamp — see recordSignIn').toBeNull();

    const before = Date.now();
    const r = await post(url, '/api/login', { email: EMAIL, password: PASSWORD });
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    const stamped = storedLastLogin(id);
    expect(typeof stamped).toBe('number');
    // A plausible ms-epoch NOW, not 0 and not seconds. The additive-int default
    // this column deliberately avoids would land exactly on 0.
    expect(stamped!).toBeGreaterThanOrEqual(before);
    expect(stamped!).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('mobile:login with a password stamps it (path 2 of 3 — the client most users sign in from)', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id } = await register(url);
    expect(storedLastLogin(id)).toBeNull();

    const socket = await connect(url);
    const ack = await ackOf(socket, 'mobile:login', { email: EMAIL, password: PASSWORD });
    expect(ack.error, `mobile:login: ${JSON.stringify(ack)}`).toBeUndefined();
    expect(ack.ok).toBe(true);

    expect(typeof storedLastLogin(id), 'the phone leg did not record a sign-in').toBe('number');
  });

  it('mobile:login with a QR nonce stamps it (path 3 of 3 — GA-31 is a first-class path)', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id, token } = await register(url);
    expect(storedLastLogin(id)).toBeNull();

    // The console (already signed in) mints the grant; the phone redeems it.
    // Both halves are the production routes — no store is reached into.
    const minted = await post(url, '/api/auth/qr-grant', {}, { authorization: `Bearer ${token}` });
    expect(minted.status, JSON.stringify(minted.json)).toBe(200);
    const nonce = minted.json.nonce as string;
    expect(typeof nonce).toBe('string');

    const socket = await connect(url);
    const ack = await ackOf(socket, 'mobile:login', { qr_nonce: nonce });
    expect(ack.error, `qr mobile:login: ${JSON.stringify(ack)}`).toBeUndefined();
    expect(ack.ok).toBe(true);

    expect(typeof storedLastLogin(id), 'a QR sign-in left no record').toBe('number');
  });

  it('a later sign-in REPLACES the earlier one (「last」 login, not 「first」 — the opposite of setRestricted)', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id } = await register(url);

    await post(url, '/api/login', { email: EMAIL, password: PASSWORD });
    const first = storedLastLogin(id);
    expect(typeof first).toBe('number');

    // Drive the second stamp through the repo with a value that cannot be
    // confused with a clock reading, so 「it moved」 is unambiguous. The route
    // above already proved the production path reaches this method.
    handle().db.users.stampLastLogin(id, 1_999_888_777_666);
    expect(storedLastLogin(id)).toBe(1_999_888_777_666);
    expect(storedLastLogin(id)).not.toBe(first);
  });

  it('a sign-in moves last_login_at AND NOTHING ELSE on the row', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id } = await register(url);
    const before = otherColumns(id);

    await post(url, '/api/login', { email: EMAIL, password: PASSWORD });

    expect(typeof storedLastLogin(id)).toBe('number');
    // Byte-identical: no tier moved, no exemption, no admin bit, no restriction.
    expect(otherColumns(id)).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('LOGIN-1 · the paths that deliberately DO NOT count', () => {
  it('🔴 POST /api/register does NOT stamp — created_at already answers 「when did this account appear」', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id } = await register(url);

    // If registration stamped, `last_login_at` would be non-NULL for every
    // account from the instant it exists, and the operator could no longer tell
    // 「registered and never came back」 from 「has been back」 — both would render
    // as the same date. That distinction is the entire value of the field.
    expect(storedLastLogin(id)).toBeNull();

    // …and the positive control: with collection ON, this very account DOES get
    // stamped the moment it actually signs in. Without this line the assertion
    // above would also pass on a build where recording is broken outright.
    await post(url, '/api/login', { email: EMAIL, password: PASSWORD });
    expect(typeof storedLastLogin(id), 'recording is broken — the NULL above proves nothing').toBe('number');
  });

  it('🔴 verifying a token (GET /api/me) does NOT stamp — this is 「last login」, not 「last activity」', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id, token } = await register(url);
    await post(url, '/api/login', { email: EMAIL, password: PASSWORD });
    const afterSignIn = storedLastLogin(id);
    expect(typeof afterSignIn).toBe('number');

    // Move the stored value to a recognisable constant, then USE the product.
    handle().db.users.stampLastLogin(id, 1_600_000_000_000);
    for (let i = 0; i < 3; i += 1) {
      const me = await getJson(url, '/api/me', { authorization: `Bearer ${token}` });
      expect(me.status, JSON.stringify(me.json)).toBe(200);
    }

    // 🔴 UNCHANGED. Auth here is stateless JWT, so a token is verified on
    // essentially every request; a value moved by verification would answer
    // 「has this account been active」 — which pc_devices.last_seen_at and
    // mobile_pairings.last_seen_at already answer — while being LABELLED
    // 「last login」 on the screen where an operator decides whether to restrict
    // somebody. A person who signs in once and then uses a 7-day token for a
    // week has ONE login, which is what the words say.
    expect(storedLastLogin(id)).toBe(1_600_000_000_000);
  });

  it('a FAILED sign-in stamps nothing (the column says 「successful」)', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id } = await register(url);

    const bad = await post(url, '/api/login', { email: EMAIL, password: 'wrongpassword9' });
    expect(bad.status).toBe(401);
    expect(storedLastLogin(id)).toBeNull();

    // Positive control on the same server: the right password does stamp, so
    // the NULL above is about the refusal and not about a dead code path.
    const good = await post(url, '/api/login', { email: EMAIL, password: PASSWORD });
    expect(good.status).toBe(200);
    expect(typeof storedLastLogin(id)).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('LOGIN-1 · the switch (FLOWMIC_LOGIN_RECORD_ENABLED), default OFF', () => {
  it('🔴 DEFAULT IS OFF — a config with nothing said about it records nothing', () => {
    const before = process.env.FLOWMIC_LOGIN_RECORD_ENABLED;
    try {
      delete process.env.FLOWMIC_LOGIN_RECORD_ENABLED;
      expect(loadConfig({ mode: 'saas', secret: SECRET, dbPath: ':memory:', trustedProxies: [] }).loginRecordEnabled).toBe(false);
      // Fails CLOSED on junk: `envFlag` accepts only '1'/'true', which is the
      // safe direction for a switch guarding a data-collection promise.
      for (const junk of ['0', 'yes', 'TRUE ', 'on', '']) {
        process.env.FLOWMIC_LOGIN_RECORD_ENABLED = junk;
        expect(
          loadConfig({ mode: 'saas', secret: SECRET, dbPath: ':memory:', trustedProxies: [] }).loginRecordEnabled,
          `a typo'd value (${JSON.stringify(junk)}) must not enable collection`,
        ).toBe(false);
      }
      // …and the two values that DO mean yes, so this is not a constant `false`.
      for (const on of ['1', 'true']) {
        process.env.FLOWMIC_LOGIN_RECORD_ENABLED = on;
        expect(loadConfig({ mode: 'saas', secret: SECRET, dbPath: ':memory:', trustedProxies: [] }).loginRecordEnabled).toBe(true);
      }
    } finally {
      if (before === undefined) delete process.env.FLOWMIC_LOGIN_RECORD_ENABLED;
      else process.env.FLOWMIC_LOGIN_RECORD_ENABLED = before;
    }
  });

  it('🔴 WITH THE SWITCH OFF, NOT ONE VALUE IS WRITTEN — on any of the three paths', async () => {
    const url = await saas({ loginRecordEnabled: false });
    const { id, token } = await register(url);

    // ① REST password
    expect((await post(url, '/api/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
    expect(storedLastLogin(id), 'REST sign-in wrote while collection was off').toBeNull();

    // ② socket password
    const s1 = await connect(url);
    expect((await ackOf(s1, 'mobile:login', { email: EMAIL, password: PASSWORD })).ok).toBe(true);
    expect(storedLastLogin(id), 'socket sign-in wrote while collection was off').toBeNull();

    // ③ socket QR
    const minted = await post(url, '/api/auth/qr-grant', {}, { authorization: `Bearer ${token}` });
    const s2 = await connect(url);
    expect((await ackOf(s2, 'mobile:login', { qr_nonce: minted.json.nonce })).ok).toBe(true);
    expect(storedLastLogin(id), 'QR sign-in wrote while collection was off').toBeNull();
  });

  it('🔴 THE SWITCH IS REALLY WIRED THROUGH THE PRODUCTION BOOTSTRAP (not just through the service)', async () => {
    // The failure this catches: an operator sets the env var, bootstrap never
    // passes it to makeAuthService, and the control changes nothing. That build
    // is green on every test that constructs an AuthService by hand — which is
    // why this one goes through `startServer` and `process.env`.
    const before = process.env.FLOWMIC_LOGIN_RECORD_ENABLED;
    try {
      process.env.FLOWMIC_LOGIN_RECORD_ENABLED = '1';
      // No `loginRecordEnabled` override — the value must arrive from the ENV,
      // through loadConfig, through bootstrap, into the writer.
      const url = await saas();
      const { id } = await register(url);
      expect((await post(url, '/api/login', { email: EMAIL, password: PASSWORD })).status).toBe(200);
      expect(
        typeof storedLastLogin(id),
        'FLOWMIC_LOGIN_RECORD_ENABLED=1 changed nothing — the switch is not wired end to end',
      ).toBe('number');
    } finally {
      if (before === undefined) delete process.env.FLOWMIC_LOGIN_RECORD_ENABLED;
      else process.env.FLOWMIC_LOGIN_RECORD_ENABLED = before;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('LOGIN-1 · the ops card distinguishes its THREE states', () => {
  const ADMIN = 'u-ops-admin';

  function seedAdmin(): void {
    handle().db.users.insert({ id: ADMIN, email: 'admin@login.co', display_name: 'Admin', is_admin: true });
  }

  async function rowFor(url: string, userId: string): Promise<Record<string, unknown>> {
    const r = await getJson(url, `/api/ops/users/detail?user_id=${userId}`, adminBearer(ADMIN));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.user as Record<string, unknown>;
  }

  it('STATE 1 — not recording: `login_recording:false`, and the stamp is WITHHELD even though the column holds one', async () => {
    const url = await saas({ loginRecordEnabled: false });
    seedAdmin();
    const { id } = await register(url);
    // A deployment that recorded for a while and then had the switch turned off
    // still has stamps on disk. This is that database.
    handle().db.users.stampLastLogin(id, 1_700_000_000_000);
    expect(storedLastLogin(id)).toBe(1_700_000_000_000);

    const row = await rowFor(url, id);
    expect(row.login_recording).toBe(false);
    // 🔴 NULL, not the stored number. Publishing it under the words 「last login」
    // would put an arbitrarily stale date in front of an operator with nothing
    // on the screen to say the clock stopped. Refusing to answer is not hiding a
    // fact — it is declining a question this deployment can no longer answer.
    expect(row.last_login_at, 'a stale stamp leaked while collection was off').toBeNull();
  });

  it('STATE 2 — recording, nothing observed yet: `login_recording:true` with a null stamp', async () => {
    const url = await saas({ loginRecordEnabled: true });
    seedAdmin();
    const { id } = await register(url);

    const row = await rowFor(url, id);
    expect(row.login_recording).toBe(true);
    expect(row.last_login_at).toBeNull();
    // 🔴 The pair is the point: this blank is a FACT ABOUT THE ACCOUNT (nobody
    // has signed in since recording began), whereas STATE 1's identical-looking
    // blank says nothing about the account at all. Same `null`, opposite
    // meanings, different next action — which is why one nullable number could
    // not carry this and a second field had to exist.
    expect({ recording: row.login_recording, stamp: row.last_login_at })
      .not.toEqual({ recording: false, stamp: null });
  });

  it('STATE 3 — recording, and here is the moment', async () => {
    const url = await saas({ loginRecordEnabled: true });
    seedAdmin();
    const { id } = await register(url);
    await post(url, '/api/login', { email: EMAIL, password: PASSWORD });

    const row = await rowFor(url, id);
    expect(row.login_recording).toBe(true);
    expect(typeof row.last_login_at).toBe('number');
    expect(row.last_login_at).toBe(storedLastLogin(id));
  });

  it('🔴 the LIST and the DETAIL agree — one projection, applied at both response points', async () => {
    const url = await saas({ loginRecordEnabled: true });
    seedAdmin();
    const { id } = await register(url);
    await post(url, '/api/login', { email: EMAIL, password: PASSWORD });

    const list = await getJson(url, '/api/ops/users?limit=200', adminBearer(ADMIN));
    expect(list.status).toBe(200);
    const rows = list.json.rows as Record<string, unknown>[];
    // 🔴 EVERY row, not just the one that signed in. `Array.prototype.map` passes
    // the INDEX as a second argument, so a bare `.map(toOpsUser)` would hand `0`
    // to the first row and `1` to the rest — row 1 claiming 「not recording」 and
    // the others 「recording」, from one deployment, on one page. That is what
    // this loop is looking for.
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.login_recording, `row ${String(row.id)} disagreed about the switch`).toBe(true);
    }
    const listed = rows.find((r) => r.id === id)!;
    const detail = await rowFor(url, id);
    expect(listed.last_login_at).toEqual(detail.last_login_at);
    expect(listed.login_recording).toEqual(detail.login_recording);
  });

  it('the account holder\'s own surfaces carry NEITHER field (this is an operator fact)', async () => {
    const url = await saas({ loginRecordEnabled: true });
    const { id, token } = await register(url);
    await post(url, '/api/login', { email: EMAIL, password: PASSWORD });
    expect(typeof storedLastLogin(id)).toBe('number');

    const me = await getJson(url, '/api/me', { authorization: `Bearer ${token}` });
    expect(me.status).toBe(200);
    const user = me.json.user as Record<string, unknown>;
    // `publicUser` is an explicit key list; this asserts the new column did not
    // spread into it. The switch state in particular is a DEPLOYMENT fact an end
    // user is not owed — the same call http/usage-events-routes.ts makes about
    // its own switch.
    expect(Object.keys(user)).not.toContain('last_login_at');
    expect(Object.keys(user)).not.toContain('login_recording');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE STRUCTURAL GUARD — the one that survives people, not just this build.
//
// Everything above tests the three call sites that exist TODAY. This tests the
// FOURTH one somebody adds next year: a new place that mints a session and
// neither records a sign-in nor says why not. That is not a hypothetical — the
// column's whole meaning is 「the set of moments we decided to count」, and a set
// maintained only by memory drifts silently, in the direction of a field that
// means something different from its label.
describe('LOGIN-1 · every session-minting site has DECIDED about recording', () => {
  const SRC = join(__dirname, '..', 'src');

  /** The sites that mint a session and deliberately do NOT record one. Adding a
   *  file here is a decision somebody has to write down; forgetting to is red. */
  const DECLARED_EXCLUSIONS: Readonly<Record<string, string>> = {
    'http/auth-routes.ts:register':
      'registration is not a sign-in — users.created_at already answers it, and stamping here '
      + 'would erase the difference between 「registered and never came back」 and 「has been back」',
  };

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('🔴 no `issueToken` call site mints a session without either recording it or being a declared exclusion', () => {
    const found: { file: string; line: number; records: boolean }[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, '/');
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        // The CALL, not the interface declaration or a mention in prose.
        if (!/\.issueToken\(/.test(text)) return;
        // Does a `recordSignIn(` appear within the same handler-sized window?
        // Deliberately a WINDOW rather than an exact next line: the three real
        // sites put the call in different positions relative to `issueToken`,
        // and a rule that demanded adjacency would be a formatting rule wearing
        // a policy's clothes.
        const window = lines.slice(Math.max(0, i - 6), i + 12).join('\n');
        found.push({ file: rel, line: i + 1, records: /recordSignIn\(/.test(window) });
      });
    }

    // The instrument itself must not be blind: if the scan finds nothing, it is
    // broken, and 「zero unrecorded sites」 would be a vacuous green.
    expect(found.length, 'the scan found no issueToken call sites at all — it is broken, not clean').toBeGreaterThanOrEqual(4);

    // 🔴 COUNTED PER FILE, NOT MERELY MATCHED PER FILE — and the difference was
    // found by running reverse control A rather than by thinking about it.
    // The first version of this check asked 「does this file have ANY declared
    // exclusion?」, which means one entry for `auth-routes.ts:register` would
    // have silently excused a SECOND silent site in the same file — including
    // the /api/login site the reverse control had just emptied. It only went red
    // by luck, on the separate 「at least three sites record」 assertion below.
    // Comparing COUNTS is what makes a new silent neighbour red on its own.
    const silentByFile = new Map<string, number>();
    for (const f of found.filter((x) => !x.records)) {
      silentByFile.set(f.file, (silentByFile.get(f.file) ?? 0) + 1);
    }
    const allowedByFile = new Map<string, number>();
    for (const key of Object.keys(DECLARED_EXCLUSIONS)) {
      const file = key.slice(0, key.lastIndexOf(':'));
      allowedByFile.set(file, (allowedByFile.get(file) ?? 0) + 1);
    }
    const unexplained = [...silentByFile.entries()]
      .filter(([file, n]) => n > (allowedByFile.get(file) ?? 0))
      .map(([file, n]) => `${file}: ${n} silent site(s), ${allowedByFile.get(file) ?? 0} declared`);
    expect(
      unexplained,
      'a site mints a session without recording a sign-in and without a declared reason — '
      + 'decide whether it is a login and say so in DECLARED_EXCLUSIONS, or call recordSignIn',
    ).toEqual([]);

    // …and the converse: at least the three known paths DO record, so a build
    // where `recordSignIn` was deleted everywhere cannot pass this test by
    // having nothing left to complain about.
    expect(found.filter((f) => f.records).length).toBeGreaterThanOrEqual(3);
  });

  // The public export ships no docs/ tree at all (legal texts are published on
  // the website, not in the code drop), so on that tree this lockstep has no
  // second half to read — it SKIPS by name there rather than dying in ENOENT
  // (measured 2026-08-20: the public repo's Linux gate failed on exactly this
  // read). On the private tree the file always exists and the pin runs at full
  // force; the skip is a statement about which tree we are on, not a loophole.
  const POLICY_PATH = join(__dirname, '..', '..', '..', 'docs', 'legal', 'privacy-policy.md');
  (existsSync(POLICY_PATH) ? it : it.skip)('the privacy policy still discloses the field this code collects', () => {
    // 🔴 THE POINT IS THE LOCKSTEP, and it is here because this card's own
    // history is the argument: the ruling said `approve_with_policy`, and for a
    // week the policy and the code disagreed in BOTH directions at once (the
    // policy promised a collection that did not exist; a code comment declared
    // the collection forbidden). A test is the only participant that reads both.
    const policy = readFileSync(POLICY_PATH, 'utf8');
    expect(policy).toContain('Last successful sign-in time');
    // The corrected wording, not the original 「when the account was last used」 —
    // that phrasing described ACTIVITY for a value that only moves when a
    // credential is presented.
    expect(policy).toContain('Creating the account does not set it');
    expect(policy).toContain('we keep no history of sign-ins');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── 🔴 REVERSE CONTROL, MEASURED (2026-08-19, dev-pc-a) ────────────────
//
// A reverse control counts only if it was really seen red, so the readings below
// are transcribed from the terminal rather than predicted.
//
// ── CONTROL A — remove the write from the REST sign-in path ──────────────────
// Deleting the single line `deps.service.recordSignIn(user);` from
// src/http/auth-routes.ts (the /api/login branch) and running this file:
//
//        Tests  10 failed | 8 passed (18)
//
//   FAIL  … > POST /api/login stamps last_login_at (path 1 of 3 — password over
//         REST)
//   AssertionError: expected 'object' to be 'number' // Object.is equality
//   Expected: "number"
//   Received: "object"
//
//   FAIL  … > 🔴 POST /api/register does NOT stamp — created_at already answers
//         「when did this account appear」
//   AssertionError: recording is broken — the NULL above proves nothing:
//     expected 'object' to be 'number' // Object.is equality
//
//   FAIL  … > 🔴 THE SWITCH IS REALLY WIRED THROUGH THE PRODUCTION BOOTSTRAP
//         (not just through the service)
//   AssertionError: FLOWMIC_LOGIN_RECORD_ENABLED=1 changed nothing — the switch
//     is not wired end to end: expected 'object' to be 'number'
//
//   FAIL  … > 🔴 no `issueToken` call site mints a session without either
//         recording it or being a declared exclusion
//   AssertionError: … expected [ Array(1) ] to deeply equal []
//   - []
//   + [ "http/auth-routes.ts: 2 silent site(s), 1 declared" ]
//
// 🔴 THREE THINGS THE MEASUREMENT CHANGED, recorded because a reverse control's
// evidence is what was SEEN and not what was predicted:
//   ① I had written 「5 failed | 11 passed (16)」 into this header before running
//      it. The real reading is 10 of 18. The prediction was not close, and it
//      was sitting in the file looking like a measurement;
//   ② the register-exclusion test asserts a NULL, and a NULL is EXACTLY what a
//      build with recording ripped out produces — so without the positive
//      control appended to it, that test would have stayed GREEN while the
//      feature was gone, certifying an exclusion in a build that could not have
//      included anything. That is a reverse control pointing the wrong way: it
//      would not have missed a defect, it would have written one into the
//      acceptance criteria;
//   ③ 🔴 THE STRUCTURAL GUARD CAUGHT THIS ONLY BY LUCK ON THE FIRST RUN, AND
//      THE RUN IS WHAT REVEALED IT. Its first version asked 「does this file have
//      ANY declared exclusion?」, so the one entry for `auth-routes.ts:register`
//      silently excused the emptied /api/login site in the same file; it went
//      red only on the separate 「at least three sites record」 assertion. It now
//      compares COUNTS per file, which is why the transcript above names
//      「2 silent site(s), 1 declared」. An instrument that passes for the wrong
//      reason is the thing this repo calls 「first check your ruler」.
//
// ── CONTROL B — make the projection ignore the switch ────────────────────────
// Changing `last_login_at: loginRecording ? u.last_login_at : null` in
// src/db/repos/user.repo.ts `toOpsUser` to the bare `last_login_at:
// u.last_login_at` and running this file:
//
//        Tests  1 failed | 17 passed (18)
//
//   FAIL  test/last-login-record.test.ts > LOGIN-1 · the ops card distinguishes
//         its THREE states > STATE 1 — not recording: `login_recording:false`,
//         and the stamp is WITHHELD even though the column holds one
//   AssertionError: a stale stamp leaked while collection was off:
//     expected 1700000000000 to be null
//
// EXACTLY ONE test moved, which is the answer this control was asked for: the
// withholding lives at ONE place (`toOpsUser`), so removing it has exactly one
// signal. Had two or three tests failed, the rule would have been written down
// in more than one place — the drift this projection exists to prevent.
//
// Both edits were reverted: `grep -n "loginRecording ? u.last_login_at : null"`
// finds the line in src/db/repos/user.repo.ts, `grep -n "recordSignIn(user)"`
// finds it in src/http/auth-routes.ts, `find src -name "*.bak"` is empty, and
// this file is 18/18 green again.
// ─────────────────────────────────────────────────────────────────────────────
