// card S2-04 — `POST /api/web/rooms`, measured through the route with real
// repos, a real `Registry`, a real `AuthService` and the real budget producer.
//
// SPEC-REF:
//   docs/strategy/2026-09-05-web-client-protocol-and-api-addendum.md §2.1
//   docs/strategy/2026-09-08-web-client-target-and-self-pairing-state-machine.md
//     §5.1 / §5.2 / §13 Q-3 (the cascade this file pins)
//   src/http/web-room-routes.ts · src/room/web-room.ts
//
// WHY IT DRIVES THE ROUTE RATHER THAN BOOTING A SERVER: same argument
// `pc-device-self-service.test.ts` makes at its own head — the deps here are the
// production classes over a real sqlite connection, so what is proven is this
// route's behaviour rather than bootstrap's wiring. Bootstrap's half is proven
// where it can only be proven, by the golden path (verify/golden/g25-web-room.mjs),
// which reaches the same URL through a real relay process.
//
// 🔴 THE TWO CASES THAT ARE NOT ABOUT THIS ROUTE AT ALL, and are the reason this
// file exists rather than a smaller one:
//   · 「a web room does not spend a PC slot, AND a phone can still pair with it」.
//     Those two are one measurement. The register (design §3) proposed making a
//     web room fail `isRealPc`, which is ALSO the filter on both pairing-resolve
//     arms and inside `stampPcid` — that shape would have shipped a target
//     nothing could ever reach, with a green slot test beside it.
//   · 「the phones on a web room still count against the handset ceiling」. The
//     same predicate split, in the direction where being generous is a hole
//     rather than a feature.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { makeBudgetPusher } from '../src/billing/budget-push';
import { planLimits } from '../src/billing/plans';
import { Registry, isWebRoom, occupiesPcSlot } from '../src/room/registry';
import { WEB_ROOM_TTL_MS } from '../src/room/web-room';
import { tryHandleWebRoomRoutes, type WebRoomRoutesDeps } from '../src/http/web-room-routes';
import { ServerError } from '../src/errors';

const SECRET = 'web-room-routes-secret-32-bytes-min-x';
const T0 = Date.parse('2026-09-08T00:00:00.000Z');
/** The account's remaining transcription budget, in ms — a value with no round
 *  number in it so a zero or a default cannot pass for it. */
const REMAINING_MS = 1_234_567;

let db: DbConnection;
let auth: AuthService;
let registry: Registry;
let server: Server;
let url: string;
let now = T0;
let deps: WebRoomRoutesDeps;

function makeDeps(over: Partial<WebRoomRoutesDeps> = {}): WebRoomRoutesDeps {
  return {
    auth,
    rooms: registry,
    // The REAL producer, not a stub: the addendum puts this field in the
    // response so the page's meter and the relay's meter are one arithmetic,
    // and a stub here would prove the field exists rather than that it agrees.
    budget: makeBudgetPusher({
      remainingSttMs: () => REMAINING_MS,
      periodEndMs: () => T0 + 86_400_000, modeFor: () => 'plan' as const, freePlanMinutes: () => 20, integratorKeyRemainingMs: () => Number.POSITIVE_INFINITY,
    }),
    limiter: new RegisterRateLimiter({ now: () => now, maxAttempts: 5, windowMs: 60_000 }),
    ...over,
  };
}

async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'T' });
  return { id: user.id, bearer: { authorization: `Bearer ${auth.issueToken(user).token}` } };
}

async function build(headers: Record<string, string> = {}, body: unknown = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}/api/web/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(async () => {
  now = T0;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => now });
  // The production class, the free plan's REAL ceilings out of billing/plans.ts —
  // not a hand-picked number that could drift from what GA-16 enforces.
  registry = new Registry({
    pcs: db.pcs, mobiles: db.mobiles, mode: 'saas', limitsOf: () => planLimits('free'), now: () => now,
  });
  deps = makeDeps();
  server = createServer((req, res) => {
    if (tryHandleWebRoomRoutes(req, res, deps)) return;
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

describe('identity is required, and the refusal names the right failure', () => {
  it('no Authorization header ⇒ 401 and no row', async () => {
    const r = await build();
    expect(r.status).toBe(401);
    // 🔴 NR-55 — 「presented nothing」 is no longer answered with the code that
    // says 「your credential is bad」 (AUTH_TOKEN_INVALID, asserted one test
    // down). Nothing was refused; nothing was presented.
    expect(r.json.error).toBe('AUTH_ACCOUNT_REQUIRED');
    expect(r.json.error).not.toBe('AUTH_TOKEN_INVALID');
    // The half a status code cannot prove: nothing was minted on the way to the
    // refusal. A route that built first and refused second would still be 401.
    expect(db.pcs.listByUser('anyone')).toHaveLength(0);
  });

  it('a Bearer that is not one of ours ⇒ 401', async () => {
    const r = await build({ authorization: 'Bearer not-a-token' });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('a RESTRICTED account is refused 403, through the real route, before anything is minted', async () => {
    const a = await account('web-room-restricted@flowmic.test');
    // Through the repo method the ops route uses — the ONE writer of this
    // column — not an UPDATE, so the flag under test is the real one
    // (billing-routes.test.ts's own precedent for this exact setter).
    db.users.setRestricted(a.id, now, 'abuse');
    // POSITIVE CONTROL: prove the account really IS restricted before trusting
    // the 403 — otherwise a green result here could just mean the setter is a
    // no-op.
    expect(db.users.findById(a.id)?.restricted_at).toBe(now);

    const r = await build(a.bearer);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('ACCOUNT_RESTRICTED');
    // The half a status code cannot prove: nothing was minted on the way to
    // the refusal — the same shape the no-Authorization case above pins.
    expect(db.pcs.listByUser(a.id)).toHaveLength(0);
  });

  it('an identity kind this deployment does not serve ⇒ 400, NOT 401', async () => {
    // 🔴 THE DISTINCTION IS THE POINT. A caller holding a perfectly good
    // credential for another door must not be told their credential is bad: that
    // sends them to re-authenticate, which cannot ever work. Addendum §2.1's
    // 09-07 note ("branch on the kind first") is what this pins.
    //
    // ⚠️ 2026-09-09, card M4-01 — the KIND used here changed from 'anon_token'
    // to 'publishable_key'. Not a weakening: `anon_token` was now SERVED (the
    // site demo), so asking about it would no longer be asking this question at
    // all.
    //
    // ⚠️ 2026-09-11, card MP-1 — AND IT HAD TO MOVE AGAIN, because
    // 'publishable_key' is served too and ALL THREE named kinds now are. The
    // rule this case pins (「a good credential for another door is a 400 about
    // the door, never a 401 about the credential」) has no named kind left to
    // demonstrate it on, so it is demonstrated on an UNNAMED one — which is the
    // other half of the same switch and the half that will still exist when a
    // fourth kind is invented. The message assertion moves with it.
    //
    // 🔴 THE 'publishable_key' HALF DID NOT DISAPPEAR: the case directly below
    // asserts an unwired deployment answers 503 rather than 400 or 401, which is
    // the same 「say which door, not that your key is bad」 discipline applied to
    // a door that exists.
    const r = await build({}, { auth: { kind: 'carrier_pigeon' }, auth_value: 'whatever' });
    expect(r.status).toBe(400);
    expect(r.json.error).not.toBe('AUTH_TOKEN_INVALID');
    expect(String(r.json.message)).toContain('carrier_pigeon');
    expect(String(r.json.message)).toContain('not a known identity kind');
  });

  it('card MP-1 — the publishable_key arm on a build with no integrator wiring ⇒ 503, not 400 and not 401', async () => {
    // The third door's version of the case above. 503 because nothing is wrong
    // with the request OR the credential — this relay simply does not serve
    // integrations — and the same code the demo arm uses for its own unwired
    // state, because from the page's side the two are the same fact.
    //
    // 🔴 AND IT MUST NOT BE 401: a 401 would send an integrator to rotate a key
    // that is perfectly good, which is the exact failure the 400-not-401 rule
    // above exists to prevent, one door along.
    const r = await build({}, { auth: { kind: 'publishable_key' } });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('WEB_DEMO_UNAVAILABLE');
  });

  it('the anon_token arm is refused with the DEMO code when this build has no demo wiring', async () => {
    // The other half of the same rule, and the reason `anon` is optional on the
    // deps rather than defaulted: a deployment that does not serve demos must
    // say so by name, and must never fall through to the account arm.
    const r = await build({}, { auth: { kind: 'anon_token' } });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('WEB_DEMO_UNAVAILABLE');
    expect(r.json.error).not.toBe('AUTH_TOKEN_INVALID');
  });
});

describe('a failure inside the build is an ANSWER, never a hang', () => {
  // 🔴 THIS CASE EXISTS BECAUSE THE REVERSE CONTROL PRODUCED IT. Removing the
  // auth check (to prove these tests can go red) made the route mint a room for
  // an id with no `users` row; the foreign key threw inside the detached promise
  // the route body runs in, and the request was never answered at all — the two
  // auth cases went red by TIMING OUT rather than by reading a 200. A hang is
  // worse than the wrong status: the page sits in `building` forever with nothing
  // to render. The route now catches; this pins that it does.
  it('a throwing minter answers with the refusal code instead of leaving the request open', async () => {
    const a = await account('web-room-throws@flowmic.test');
    deps = makeDeps({
      rooms: {
        ensureWebRoom(): never {
          throw new ServerError('PAIR_INVALID_CODE', 'no free short code');
        },
      },
    });
    const r = await build(a.bearer);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('PAIR_INVALID_CODE');
  });

  it('an unexpected error answers 500 rather than hanging', async () => {
    const a = await account('web-room-boom@flowmic.test');
    deps = makeDeps({
      rooms: {
        ensureWebRoom(): never {
          throw new Error('boom');
        },
      },
    });
    const r = await build(a.bearer);
    expect(r.status).toBe(500);
    // The message never carries the internal one: it says nothing useful to a
    // caller and everything useful to somebody probing.
    expect(r.json.message).toBe('internal error');
  });
});

describe('the room it hands back', () => {
  it('carries every field the addendum promises, and they agree with the row', async () => {
    const a = await account('web-room-shape@flowmic.test');
    const r = await build(a.bearer);
    expect(r.status).toBe(200);

    const rows = db.pcs.listByUser(a.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(isWebRoom(row)).toBe(true);

    expect(r.json.room_token).toBe(row.device_token);
    expect(r.json.code).toBe(row.short_code);
    expect(r.json.code).toMatch(/^\d{4}$/);
    // 🔴 A PCID, not null. `stampPcid` skips rows that fail `isRealPc`, so this
    // assertion is what fails the day somebody "simplifies" the two predicates
    // back into one — before any phone ever tries to pair.
    expect(r.json.pcid).toBe(row.pcid);
    expect(String(r.json.pcid)).toMatch(/^\d{9}$/);
    expect(r.json.expires_at).toBe(now + WEB_ROOM_TTL_MS);
    expect(r.json.budget).toEqual({ remaining_ms: REMAINING_MS, mode: 'plan', resets_at: T0 + 86_400_000 });

    // The pair URL is the desktop's spelling with this room's own values in it.
    expect(r.json.endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(r.json.pair_url).toBe(
      `https://flowmic.app/go/pair?endpoint=${encodeURIComponent(r.json.endpoint)}`
      + `&code=${r.json.code}&channel=saas&pcid=${r.json.pcid}&v=1`,
    );
  });

  it('a repeat call returns the SAME room rather than a second one', async () => {
    const a = await account('web-room-idempotent@flowmic.test');
    const first = await build(a.bearer);
    const second = await build(a.bearer);

    expect(second.status).toBe(200);
    // The token IS the idempotency: rotating it would disconnect a page that is
    // already working, which no repeat of a build call may do.
    expect(second.json.room_token).toBe(first.json.room_token);
    expect(second.json.pcid).toBe(first.json.pcid);
    // And a live code is not re-minted either — a QR being scanned right now
    // must not change under the scanner, and each mint burns a 4-digit code.
    expect(second.json.code).toBe(first.json.code);
    expect(db.pcs.listByUser(a.id)).toHaveLength(1);
  });

  it('two accounts get two rooms, and neither can see the other', async () => {
    const a = await account('web-room-tenant-a@flowmic.test');
    const b = await account('web-room-tenant-b@flowmic.test');
    const ra = await build(a.bearer);
    const rb = await build(b.bearer);
    expect(ra.json.room_token).not.toBe(rb.json.room_token);
    expect(ra.json.pcid).not.toBe(rb.json.pcid);
    expect(db.pcs.listByUser(a.id)).toHaveLength(1);
    expect(db.pcs.listByUser(b.id)).toHaveLength(1);
  });
});

describe('what a web room does and does not cost the account', () => {
  it('does not spend a PC slot — owner ruling W-3', async () => {
    const a = await account('web-room-slots@flowmic.test');
    await build(a.bearer);
    // free = 2 computers (planLimits('free').pcs). Both must still fit.
    registry.registerPc({ device_name: 'PC one', user_id: a.id, client_instance_id: 'inst-one' });
    registry.registerPc({ device_name: 'PC two', user_id: a.id, client_instance_id: 'inst-two' });
    // …and the third is still refused, so the ceiling is enforced, not disabled.
    expect(() => registry.registerPc({ device_name: 'PC three', user_id: a.id, client_instance_id: 'inst-3' }))
      .toThrowError(ServerError);
    expect(db.pcs.listByUser(a.id).filter(occupiesPcSlot)).toHaveLength(2);
  });

  it('IS pairable — by its code and by its PCID', async () => {
    const a = await account('web-room-pairable@flowmic.test');
    const r = await build(a.bearer);
    const byCode = registry.resolvePcForPair({ short_code: r.json.code, pcid: r.json.pcid });
    expect(byCode.device_token).toBe(r.json.room_token);
    // The QR arm reaches the same row through the string the page renders.
    const byQr = registry.resolvePcForPair({ qr_payload: r.json.pair_url });
    expect(byQr.id).toBe(byCode.id);
  });

  it('its phones DO count against the handset ceiling', async () => {
    const a = await account('web-room-handsets@flowmic.test');
    const r = await build(a.bearer);
    // free = 2 handsets. Pair two to the web room, then a third must be refused —
    // if the mobile count walked the PC-slot set instead, a browser room would be
    // an unlimited handset parking lot.
    registry.pairMobile({ short_code: r.json.code, pcid: r.json.pcid, device_uid: 'ph-00000000000000a1' });
    const again = registry.resolvePcForPair({ short_code: r.json.code, pcid: r.json.pcid });
    expect(again.id).toBeTruthy();
    registry.pairMobile({ short_code: r.json.code, pcid: r.json.pcid, device_uid: 'ph-00000000000000a2' });
    expect(() => registry.pairMobile({
      short_code: r.json.code, pcid: r.json.pcid, device_uid: 'ph-00000000000000a3',
    })).toThrowError(ServerError);
  });
});

describe('the burst brake', () => {
  it('refuses the sixth build in a minute by name, with a wait that is a number', async () => {
    const a = await account('web-room-limit@flowmic.test');
    for (let i = 0; i < 5; i++) expect((await build(a.bearer)).status).toBe(200);
    const sixth = await build(a.bearer);
    expect(sixth.status).toBe(429);
    expect(sixth.json.error).toBe('WEB_ROOM_RATE_LIMITED');
    // The waiting time rides beside the code, never inside the sentence: the
    // client backs off on this number and nine translations cannot drift from it.
    expect(sixth.json.retry_after_ms).toBeGreaterThan(0);
    expect(sixth.json.retry_after_ms).toBeLessThanOrEqual(60_000);
  });

  it('is charged per ACCOUNT, so one account cannot lock out another', async () => {
    const a = await account('web-room-limit-a@flowmic.test');
    const b = await account('web-room-limit-b@flowmic.test');
    for (let i = 0; i < 5; i++) await build(a.bearer);
    expect((await build(a.bearer)).status).toBe(429);
    expect((await build(b.bearer)).status).toBe(200);
  });
});

describe('expiry, and exactly what a release takes with it', () => {
  it('replaces an expired room and releases ONLY its own pairings', async () => {
    const a = await account('web-room-expiry@flowmic.test');
    // A short TTL rather than a 30-minute wait; the clock is the same one the
    // registry and the auth service read, so nothing here is out of step.
    deps = makeDeps({ ttlMs: 1_000 });
    // A real computer of the same account, with a phone on it. Neither may be
    // touched by a web room's release — that is the whole cascade ruling.
    const pc = registry.registerPc({ device_name: 'Desk PC', user_id: a.id, client_instance_id: 'inst-desk' });
    registry.pairMobile({ short_code: pc.pc.short_code, pcid: pc.pc.pcid ?? undefined, device_uid: 'ph-00000000000000d1' });

    const first = await build(a.bearer);
    const roomId = db.pcs.listByUser(a.id).filter(isWebRoom)[0]!.id;
    registry.pairMobile({
      short_code: first.json.code, pcid: first.json.pcid, device_uid: 'ph-00000000000000w1',
    });
    expect(db.mobiles.listByPc(roomId)).toHaveLength(1);

    now += 1_001;
    const second = await build(a.bearer);
    expect(second.status).toBe(200);
    // A NEW room: new token, new row. The page holding the old token now gets
    // AUTH_TOKEN_INVALID on its next reconnect, which is the state machine's
    // §9.4 answer and the reason a client never predicts its own expiry.
    expect(second.json.room_token).not.toBe(first.json.room_token);
    expect(db.pcs.findById(roomId)).toBeNull();
    // 🔴 THE CASCADE, MEASURED: the released room's pairing is gone…
    expect(db.mobiles.listByPc(roomId)).toHaveLength(0);
    // …and the desktop's room and its phone are untouched.
    expect(db.pcs.findById(pc.pc.id)).not.toBeNull();
    expect(db.mobiles.listByPc(pc.pc.id)).toHaveLength(1);
    // Exactly one web room at rest, always.
    expect(db.pcs.listByUser(a.id).filter(isWebRoom)).toHaveLength(1);
  });

  it('does not expire a room that is still inside its window', async () => {
    const a = await account('web-room-alive@flowmic.test');
    deps = makeDeps({ ttlMs: 10_000 });
    const first = await build(a.bearer);
    now += 9_000;
    const second = await build(a.bearer);
    expect(second.json.room_token).toBe(first.json.room_token);
    // …and asking again pushed the window out, so the room outlives the ORIGINAL
    // stamp. A TTL that ignored the second call would kill a page mid-session.
    expect(second.json.expires_at).toBe(now + 10_000);
    now += 9_000;
    expect((await build(a.bearer)).json.room_token).toBe(first.json.room_token);
  });

  it('re-mints the CODE once the governor lets it lapse, while the room (token/pcid) stays put', async () => {
    // The two clocks web-room.ts documents (§ WEB_ROOM_TTL_MS header): a short
    // CODE ttl inside a long ROOM ttl, so it is only `codeIsActive` going false
    // — never the room's own expiry — that can be what triggers the re-mint.
    const a = await account('web-room-code-remint@flowmic.test');
    const shortCodeRegistry = new Registry({
      pcs: db.pcs, mobiles: db.mobiles, mode: 'saas', limitsOf: () => planLimits('free'),
      now: () => now, shortCodeTtlMs: 1_000,
    });
    deps = makeDeps({ rooms: shortCodeRegistry, ttlMs: 60_000 });

    const first = await build(a.bearer);
    expect(first.status).toBe(200);

    now += 1_001; // the CODE (1s) has lapsed; the ROOM (60s) has not.
    const second = await build(a.bearer);
    expect(second.status).toBe(200);

    // Same room: the idempotent path, not a replace — one row throughout.
    expect(second.json.room_token).toBe(first.json.room_token);
    expect(second.json.pcid).toBe(first.json.pcid);
    expect(db.pcs.listByUser(a.id).filter(isWebRoom)).toHaveLength(1);

    // …but a FRESH code: the dead one must not be handed back, because a page
    // that reloaded a moment ago and is still showing the old QR would then be
    // showing a code the server itself will not honour.
    expect(second.json.code).toMatch(/^\d{4}$/);
    expect(
      shortCodeRegistry.resolvePcForPair({ short_code: second.json.code, pcid: second.json.pcid }).device_token,
    ).toBe(second.json.room_token);
    // The OLD code is well and truly dead, not merely superseded in the
    // response — a phone still holding the earlier QR must be refused, not
    // silently routed to the same room by a stale string.
    expect(() => shortCodeRegistry.resolvePcForPair({ short_code: first.json.code, pcid: first.json.pcid }))
      .toThrowError(ServerError);
  });
});

// card S2-04b — the account-scoped race a repeat build call opens: two
// requests for the SAME account, each observing「no room yet」before either has
// written one, must not each mint a row. `Registry.ensureWebRoom` answers this
// with an in-process, per-account promise chain (registry.ts, its own header
// argues the scope: cross-node duplication is already impossible — a replica
// answers every write with 421 before this class is ever reached — so the
// chain only has to hold for the ONE writer process).
describe('🔴 two concurrent first calls for the same account never mint two rows', () => {
  it('Registry.ensureWebRoom serializes itself: N calls issued in the same tick still produce ONE row', async () => {
    const a = await account('web-room-race@flowmic.test');
    // Issued from the SAME synchronous tick, exactly the shape a reload and a
    // second tab produce on the wire (two requests whose bodies are already
    // fully buffered when the server gets to them) — `registry` here is the
    // one instance both would share on a single writer node.
    const outcomes = await Promise.all([
      registry.ensureWebRoom(a.id),
      registry.ensureWebRoom(a.id),
      registry.ensureWebRoom(a.id),
      registry.ensureWebRoom(a.id),
      registry.ensureWebRoom(a.id),
    ]);
    expect(db.pcs.listByUser(a.id).filter(isWebRoom)).toHaveLength(1);
    // Every caller gets back the SAME row — not just "a" row each.
    const tokens = new Set(outcomes.map((o) => o.token));
    expect(tokens.size).toBe(1);
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
  });

  // 🔴 REVERSE CONTROL, seen red (S2-04b cross-check, 2026-09): with the lock's
  // OWN chaining removed — `ensureWebRoom` calling straight through to the
  // module function with no `webRoomLocks` gate — this exact test still passed,
  // because `node:sqlite`'s DatabaseSync is fully synchronous and Node drains
  // microtasks after every callback: a `Promise.all` of calls issued from one
  // synchronous tick against a function with no internal `await` cannot
  // interleave AT ALL, locked or not — call 0 runs its entire read-then-insert
  // to completion, including the insert, before call 1 is even invoked, purely
  // because JS evaluates the array's elements eagerly left-to-right. So this
  // specific shape of test is incapable of proving the lock does anything; it
  // is kept because it is still the correct BEHAVIOURAL contract (N callers on
  // one writer, one row, one winner) and because it is the one that will start
  // failing the day this project's own precedent — `admitCloudInstance`'s
  // comment, registry.ts — stops holding: "the find-first-then-insert is the
  // fast path", i.e. the day a real yield point (an actual async DB driver, a
  // remote store) lands between the read and the write, THIS is the test that
  // will catch a regression, and the lock is what will already be there to
  // fix it. The genuinely reproducible half of this race — the DB itself
  // enforcing the invariant when two readers really have raced past each
  // other — is pinned separately in web-room-db-backstop.test.ts.
});
