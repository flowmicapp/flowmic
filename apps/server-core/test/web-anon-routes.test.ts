// Card M4-01 — `POST /api/web/anon` and the anonymous arm of
// `POST /api/web/rooms`, measured through both routes with real repos, a real
// `Registry`, the real trial ledger and the real budget producer.
//
// SPEC-REF:
//   docs/strategy/2026-09-09-web-client-stage4-site-demo-design.md §2.2 / §2.3 /
//     §3.1 (the five gates) / §3.2 (the five log lines)
//   src/http/web-anon-routes.ts · src/http/web-room-routes.ts
//   src/billing/trial-ledger.ts
//
// WHY IT DRIVES THE ROUTES RATHER THAN BOOTING A SERVER: the same argument
// web-room-routes.test.ts makes at its own head. Bootstrap's half — that these
// deps are actually wired, and that a phone can then pair into the room and
// speak until the meter runs out — is proven where it can only be proven, by
// verify/golden/g26-site-demo.mjs on a real relay process.
//
// 🔴 THE CAPTCHA IS INJECTED, NOT MONKEY-PATCHED. auth/captcha.ts defines the
// question as an interface with NO permissive implementation anywhere, so a test
// double here is one more implementation of that interface rather than a hole
// punched in the gate — and the `configured:false` double below is the REAL
// production one (`unconfiguredCaptchaVerifier`), not a copy of it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { makeBudgetPusher, budgetReaderFrom } from '../src/billing/budget-push';
import { planLimits } from '../src/billing/plans';
import { makeTrialLedger, type TrialLedger } from '../src/billing/trial-ledger';
import { unconfiguredCaptchaVerifier, type CaptchaVerifier } from '../src/auth/captcha';
import { Registry } from '../src/room/registry';
import {
  tryHandleWebAnonRoutes, ANON_TOKEN_TTL_MS, type WebAnonRoutesDeps,
} from '../src/http/web-anon-routes';
import { tryHandleWebRoomRoutes, type WebRoomRoutesDeps } from '../src/http/web-room-routes';
import { DEMO_ROOM_TTL_MS } from '../src/bootstrap-web-room-deps';

const SECRET = 'web-anon-routes-secret-32-bytes-min-x';
const T0 = Date.parse('2026-09-09T00:00:00.000Z');
const SITE = 'https://flowmic.app';
const OTHER = 'https://evil.example';

/** A verifier that always vouches. `configured:true`, because 「this deployment
 *  can run a challenge」 and 「this token passed」 are two facts and every case
 *  below needs to move them independently. */
function passing(): CaptchaVerifier {
  return { id: 'fake-pass', configured: true, verify: () => Promise.resolve(true) };
}
/** Configured, and it says no. NOT `unconfiguredCaptchaVerifier` — that one is a
 *  different refusal with a different code, which is the point of the pair. */
function failing(): CaptchaVerifier {
  return { id: 'fake-fail', configured: true, verify: () => Promise.resolve(false) };
}

let db: DbConnection;
let auth: AuthService;
let registry: Registry;
let trials: TrialLedger;
let server: Server;
let url: string;
let now = T0;
let anonDeps: WebAnonRoutesDeps;
let roomDeps: WebRoomRoutesDeps;

function makeAnonDeps(over: Partial<WebAnonRoutesDeps> = {}): WebAnonRoutesDeps {
  return {
    enabled: true,
    captcha: passing(),
    trials,
    limiter: new RegisterRateLimiter({ now: () => now, maxAttempts: 5, windowMs: 60_000 }),
    ipSalt: 'test-salt',
    activeDemoRooms: () => trials.liveRooms(now),
    allowLocalhost: true,
    now: () => now,
    ...over,
  };
}

function makeRoomDeps(over: Partial<WebRoomRoutesDeps['anon']> = {}): WebRoomRoutesDeps {
  return {
    auth,
    rooms: registry,
    // The REAL producer over the REAL reader, so `mode` is derived from the row
    // rather than asserted by the fixture — the whole point of the trial-mode
    // case below.
    budget: makeBudgetPusher(budgetReaderFrom({
      quota: { remainingSttMs: () => 120_000 },
      billing: { usagePeriod: () => ({ endMs: null }) },
      users: db.users,
    })),
    limiter: new RegisterRateLimiter({ now: () => now, maxAttempts: 5, windowMs: 60_000 }),
    anon: { enabled: true, trials, allowLocalhost: true, ttlMs: DEMO_ROOM_TTL_MS, now: () => now, ...over },
  };
}

async function mint(headers: Record<string, string> = { origin: SITE }, body: unknown = { turnstile: 'tok' }) {
  const res = await fetch(`${url}/api/web/anon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

async function room(headers: Record<string, string>) {
  const res = await fetch(`${url}/api/web/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ auth: { kind: 'anon_token' } }),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

beforeEach(async () => {
  now = T0;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => now });
  registry = new Registry({
    pcs: db.pcs, mobiles: db.mobiles, mode: 'saas', limitsOf: () => planLimits('free'), now: () => now,
  });
  trials = makeTrialLedger({ rows: db.trials, users: db.users });
  anonDeps = makeAnonDeps();
  roomDeps = makeRoomDeps();
  server = createServer((req, res) => {
    if (tryHandleWebAnonRoutes(req, res, anonDeps)) return;
    if (tryHandleWebRoomRoutes(req, res, roomDeps)) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe('the master switch', () => {
  it('unset ⇒ 503 WEB_DEMO_UNAVAILABLE, and NOTHING is minted', async () => {
    anonDeps = makeAnonDeps({ enabled: false });
    const r = await mint();
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('WEB_DEMO_UNAVAILABLE');
    // The half a status code cannot prove, and the reverse control this file was
    // written around: a route that minted first and refused second would answer
    // 503 too, and the demo would be running with the switch off.
    expect(db.users.listAll()).toHaveLength(0);
    expect(trials.bucketCountToday('any', now)).toBe(0);
  });

  it('a deployment with no Turnstile secret answers the same 503, not a pass', async () => {
    anonDeps = makeAnonDeps({ captcha: unconfiguredCaptchaVerifier() });
    const r = await mint();
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('WEB_DEMO_UNAVAILABLE');
    expect(db.users.listAll()).toHaveLength(0);
  });

  it('also closes the room arm, not just the mint', async () => {
    const ok = await mint();
    roomDeps = makeRoomDeps({ enabled: false });
    const r = await room({ origin: SITE, authorization: `Bearer ${ok.json.anon_token}` });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('WEB_DEMO_UNAVAILABLE');
  });
});

describe('the Origin gate', () => {
  it('a foreign origin is refused by name on the MINT', async () => {
    const r = await mint({ origin: OTHER });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('WEB_ROOM_ORIGIN_NOT_ALLOWED');
    expect(db.users.listAll()).toHaveLength(0);
  });

  it('a MISSING origin is refused too — "we could not tell" is not the loose arm', async () => {
    const r = await mint({});
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('WEB_ROOM_ORIGIN_NOT_ALLOWED');
  });

  it('🔴 a VALID token from a foreign origin cannot build a room', async () => {
    // The reverse control the card names: with the Origin check removed from the
    // room arm this returns 200 and a foreign page owns a working demo room.
    const ok = await mint();
    const r = await room({ origin: OTHER, authorization: `Bearer ${ok.json.anon_token}` });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('WEB_ROOM_ORIGIN_NOT_ALLOWED');
    // And it is refused BEFORE any room exists, not after.
    expect(db.pcs.listByUser(db.users.listAll()[0]!.id)).toHaveLength(0);
  });
});

describe('Turnstile', () => {
  it('a token the verifier rejects ⇒ 400 WEB_ROOM_TURNSTILE_FAILED', async () => {
    anonDeps = makeAnonDeps({ captcha: failing() });
    const r = await mint();
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('WEB_ROOM_TURNSTILE_FAILED');
    expect(db.users.listAll()).toHaveLength(0);
  });

  it('a failed solve still spends the burst budget, or the brake could not slow a script', async () => {
    anonDeps = makeAnonDeps({ captcha: failing() });
    for (let i = 0; i < 5; i += 1) expect((await mint()).status).toBe(400);
    const sixth = await mint();
    expect(sixth.status).toBe(429);
    expect(sixth.json.error).toBe('WEB_ROOM_RATE_LIMITED');
  });
});

describe('the caps', () => {
  it('5 mints a minute from one bucket, then 429', async () => {
    for (let i = 0; i < 5; i += 1) expect((await mint()).status).toBe(200);
    const sixth = await mint();
    expect(sixth.status).toBe(429);
    expect(sixth.json.error).toBe('WEB_ROOM_RATE_LIMITED');
    expect(sixth.json.error).not.toBe('WEB_DEMO_UNAVAILABLE');
  });

  it('a per-day identity ceiling that a restart cannot reset (it is a row count)', async () => {
    anonDeps = makeAnonDeps({ maxPerIpPerDay: 2 });
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    const third = await mint();
    expect(third.status).toBe(429);
    // Rebuilding every in-memory piece — which is what a relay restart does —
    // must not hand the same network a fresh allowance.
    anonDeps = makeAnonDeps({ maxPerIpPerDay: 2 });
    expect((await mint()).status).toBe(429);
  });

  it('the site-wide daily budget is measured on minutes SPENT, not handed out', async () => {
    anonDeps = makeAnonDeps({ dailyMinutes: 1 });
    // Three full grants have been HANDED OUT (owner §10 — 2 + 2 + 2 = 6 minutes)
    // and the cap is 1 — yet nothing has been spoken, so the demo is still open.
    // A cap on grants would already have closed it.
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    const third = await mint();
    expect(third.status).toBe(200);
    // Now put a real minute on the ONE meter this server has.
    const anonId = db.users.listAll()[0]!.id;
    db.raw.prepare(
      `INSERT INTO usage_records (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at)
       VALUES (?,?,?,0,0,?)`,
    ).run(anonId, '2026-09-09', 1, new Date(now).toISOString());
    const fourth = await mint();
    expect(fourth.status).toBe(503);
    expect(fourth.json.error).toBe('WEB_DEMO_UNAVAILABLE');
  });

  it('a live-room ceiling, and it counts DEMO rooms rather than every web room', async () => {
    anonDeps = makeAnonDeps({ maxActiveRooms: 1 });
    const first = await mint();
    expect((await room({ origin: SITE, authorization: `Bearer ${first.json.anon_token}` })).status).toBe(200);
    const second = await mint();
    expect(second.status).toBe(503);
    expect(second.json.error).toBe('WEB_DEMO_UNAVAILABLE');
  });
});

describe('what a minted identity is', () => {
  it('carries an opaque token, a TTL in SECONDS, and the grant it will be held to', async () => {
    const r = await mint();
    expect(r.status).toBe(200);
    expect(r.json.anon_token).toMatch(/^fm_[0-9a-f]{64}$/);
    expect(r.json.expires_in).toBe(ANON_TOKEN_TTL_MS / 1000);
    expect(r.json.granted_ms).toBe(120_000);
  });

  it('🔴 owner §10 — a NEW browser always gets the whole two minutes, however busy the network', async () => {
    // The SUPERSEDED behaviour, pinned as its own negative: four identities on
    // one network used to be worth 120/60/30/0. The ceilings that bound abuse
    // are the gates above (5/min, 10/day, 600 min/day, 200 rooms) and they
    // decide whether a request is SERVED, never what it is worth.
    for (const uid of ['wb-0001', 'wb-0002', 'wb-0003', 'wb-0004']) {
      const r = await mint({ origin: SITE }, { turnstile: 'tok', device_uid: uid });
      expect(r.json.granted_ms).toBe(120_000);
      expect(r.json.remaining_ms).toBe(120_000);
    }
  });

  it('🔴 the SAME browser comes back to the SAME identity, with what is left of it', async () => {
    // owner §10: 「只要不清空浏览器缓存就要记住」. This is the whole ruling on the
    // site-demo arm, and the assertion that has to be on `remaining_ms` rather
    // than on `granted_ms` — the grant is a lifetime figure and does not move.
    const first = await mint({ origin: SITE }, { turnstile: 'tok', device_uid: 'wb-returns' });
    const anonId = db.raw.prepare('SELECT anon_user_id FROM trial_ledger WHERE device_uid=?').get('wb-returns')
      ?.anon_user_id as string;
    expect(anonId).toBeTruthy();
    // Spend 90 s through the ONE meter, never through the ledger row.
    db.raw.prepare(
      `INSERT INTO usage_records (user_id, month, stt_minutes, llm_tokens_in, llm_tokens_out, updated_at)
       VALUES (?,?,?,0,0,?)`,
    ).run(anonId, '2026-09-09', 1.5, new Date(now).toISOString());

    const again = await mint({ origin: SITE }, { turnstile: 'tok', device_uid: 'wb-returns' });
    expect(again.status).toBe(200);
    expect(again.json.granted_ms).toBe(120_000);
    expect(again.json.remaining_ms).toBe(30_000);
    // ONE identity, and a FRESH credential on it (the first one's hour is
    // shorter than a trial's life, so a returning page needs a live token).
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get()).toEqual({ n: 1 });
    expect(again.json.anon_token).not.toBe(first.json.anon_token);
  });

  it('a browser that declares nothing gets a fresh identity each time (an older build)', async () => {
    const a = await mint();
    const b = await mint();
    expect(a.json.granted_ms).toBe(120_000);
    expect(b.json.granted_ms).toBe(120_000);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE anonymous=1').get()).toEqual({ n: 2 });
  });

  it('is NOT an account credential: the token opens no account route', async () => {
    const r = await mint();
    // The account arm of the very endpoint it CAN use, asked with the same
    // bearer: a 401, because `accountFromBearer` has never heard of this token.
    const res = await fetch(`${url}/api/web/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${r.json.anon_token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe('the room a demo identity gets', () => {
  it('is an ordinary web room, and its budget says trial', async () => {
    const identity = await mint();
    const r = await room({ origin: SITE, authorization: `Bearer ${identity.json.anon_token}` });
    expect(r.status).toBe(200);
    for (const key of ['room_token', 'pcid', 'code', 'pair_url', 'endpoint', 'expires_at', 'budget']) {
      expect(r.json[key]).toBeDefined();
    }
    expect(String(r.json.code)).toMatch(/^\d{4}$/);
    expect(String(r.json.pcid)).toMatch(/^\d{9}$/);
    // 🔴 The card's whole point: both ends learn they are in a demo from THIS
    // field, on a frame that already existed. It is derived from the row, not
    // passed by the route.
    expect(r.json.budget.mode).toBe('trial');
  });

  // Card M4-01b — owner ruling 6 (docs/decisions/2026-09-09-owner-stage4-site-
  // demo-twelve-rulings.md): a phone that already has FlowMic installed and
  // scans the SITE's demo QR must still land on the web demo, not be pulled
  // into the app. `/go/pair` is declared to Android/iOS as an App Link
  // (verify/lint/applink-declarations.mjs); `/go/demo` is deliberately NOT, so
  // this positive case is the only thing standing between that ruling and a
  // regression that quietly puts `/go/pair` back under a demo room's pair_url.
  it('🔴 M4-01b: its pair_url uses /go/demo, not the App-Link path /go/pair', async () => {
    const identity = await mint();
    const r = await room({ origin: SITE, authorization: `Bearer ${identity.json.anon_token}` });
    expect(r.status).toBe(200);
    expect(String(r.json.pair_url)).toMatch(/^https:\/\/flowmic\.app\/go\/demo\?/);
    expect(String(r.json.pair_url)).not.toContain('/go/pair');
  });

  // The control half of the same measurement: an ordinary account room (the
  // SAME route, the `account_jwt` arm `handle()` reaches instead of
  // `handleAnonymous()`) must keep minting the App-Link path unchanged — this
  // card touches only the demo arm's one call site.
  it('🔴 M4-01b control: an ACCOUNT room still uses /go/pair, unaffected by this card', async () => {
    const user = await auth.register({ email: 'm401b-control@flowmic.test', password: 'longenough1', display_name: 'T' });
    const res = await fetch(`${url}/api/web/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.issueToken(user).token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(String(json.pair_url)).toMatch(/^https:\/\/flowmic\.app\/go\/pair\?/);
    expect(String(json.pair_url)).not.toContain('/go/demo');
  });

  it('is held for ten minutes, not the thirty an account room gets', async () => {
    const identity = await mint();
    const r = await room({ origin: SITE, authorization: `Bearer ${identity.json.anon_token}` });
    expect(r.json.expires_at).toBe(now + DEMO_ROOM_TTL_MS);
  });

  it('refuses an expired token with a credential answer, not a demo one', async () => {
    const identity = await mint();
    now = T0 + ANON_TOKEN_TTL_MS + 1;
    const r = await room({ origin: SITE, authorization: `Bearer ${identity.json.anon_token}` });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('refuses an unknown token exactly the same way, telling a prober nothing', async () => {
    const r = await room({ origin: SITE, authorization: 'Bearer fm_deadbeef' });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('leaves the ACCOUNT arm alone: it still needs no Origin at all', async () => {
    const user = await auth.register({ email: 'a@flowmic.test', password: 'longenough1', display_name: 'T' });
    const res = await fetch(`${url}/api/web/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.issueToken(user).token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    // And its budget is NOT trial — the mode follows the row, and this row is a
    // real account.
    expect(((await res.json()) as any).budget.mode).toBe('plan');
  });
});
