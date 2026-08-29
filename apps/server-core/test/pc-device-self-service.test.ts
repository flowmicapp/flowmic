// D11 — pc_devices self-service: measuring what `/devices/revoke` ACTUALLY
// deletes, and proving the new `PcRepo.remove()` is a REAL escape route off
// the PC device ceiling (a free-tier user who reinstalls Windows twice must
// not be permanently stuck at 2/2).
//
// SPEC-REF: docs/rebuild/05-DATA-MODEL.md §1 (pc_devices);
//   docs/decisions/2026-08-02-pc-instance-limit-2-3-10.md (GA-16 ceiling);
//   room/registry.ts `ensurePcSlot`/`realPcs` (the counting logic this file
//   measures against); CLAUDE.md red line: anti-façade / no silent failure
//
// WHY THIS FILE DRIVES `tryHandleConsoleRoutes` DIRECTLY instead of booting a
// server (same argument as test/billing-events-route.test.ts): the deps here
// are real repos off a real connection and a real AuthService, so what is
// proven is THIS route's behaviour, not bootstrap's wiring. `Registry` is
// likewise the real production class (test/device-limits.test.ts's own
// pattern) wired to the SAME `db`, so "can register again" is measured
// through the exact entry point `ensurePcSlot` guards, not a re-implementation
// of the count.
//
// 🔴 THE MEASURED DEFECT (D11 card, report point 3): `POST
// /api/cloud/devices/revoke` (console-routes.ts) calls
// `deps.mobiles.remove(pairingId)` — it operates EXCLUSIVELY on
// `mobile_pairings` and never touches `pc_devices`. The first block below
// proves that in the one way that matters: fill a free account's PC ceiling,
// revoke a mobile pairing hanging off one of those PCs, and show the PC row
// count and the NEXT registration are both unaffected.
//
// The second block proves `PcRepo.remove` (new in D11) is what actually frees
// the slot, end to end, through the SAME production entry point
// (`Registry.registerPc`) the first block's negative result is measured
// against — a fix proven against the identical yardstick as the defect.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDbConnection, type DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeAuthService, type AuthService } from '../src/auth/auth-service';
import { RegisterRateLimiter } from '../src/auth/register-rate-limit';
import { BillingService } from '../src/billing/billing-service';
import { tryHandleConsoleRoutes, type ConsoleRoutesDeps } from '../src/http/console-routes';
import { unconfiguredPasswordResetMailer } from '../src/mail';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { planLimits } from '../src/billing/plans';
import { ServerError } from '../src/errors';

const SECRET = 'pc-self-service-secret-32-bytes-min-xx';
const NOW = Date.parse('2026-08-04T00:00:00.000Z');

let db: DbConnection;
let auth: AuthService;
let server: Server;
let url: string;
let registry: Registry;
let store: RoomStore<FakeSocket>;

/** The narrowest thing `RoomStore` will hold (`RoomSocketLike`) plus the two
 *  members an eviction calls. Deliberately NOT a socket.io mock: what these
 *  tests need to observe is "was it told, and was it closed, and in that order",
 *  which is three fields — a real socket would add a transport to keep alive and
 *  prove nothing extra. */
interface FakeSocket {
  readonly id: string;
  connected?: boolean;
  emitted: Array<{ event: string; payload: unknown }>;
  disconnected: boolean;
  /** The emit log's length at the moment `disconnect` ran. `mobile:released`
   *  must already be in it — socket.io drops anything queued on a closed socket,
   *  so on the real wire the ORDER IS THE DELIVERY. A test that only checked
   *  "both happened" would stay green for a version that closes the door first
   *  and says nothing. */
  emitsAtDisconnect: number | null;
  emit(event: string, payload: unknown): void;
  disconnect(close?: boolean): void;
}

function fakeSocket(id: string): FakeSocket {
  const s = {
    id,
    connected: true,
    emitted: [] as Array<{ event: string; payload: unknown }>,
    disconnected: false,
    emitsAtDisconnect: null as number | null,
    emit(event: string, payload: unknown): void {
      s.emitted.push({ event, payload });
    },
    disconnect(): void {
      s.disconnected = true;
      s.connected = false;
      s.emitsAtDisconnect = s.emitted.length;
    },
  };
  return s;
}

function makeDeps(): ConsoleRoutesDeps {
  auth = makeAuthService({ users: db.users, jwtSecret: Buffer.from(SECRET, 'utf8'), now: () => NOW });
  return {
    auth,
    billing: new BillingService({
      settings: db.settings,
      users: db.users,
      usage: db.usage,
      billing: db.billing,
      unlockAll: false,
      now: () => NOW,
    }),
    billingLedger: db.billing,
    opsAudit: db.opsAudit,
    pcs: db.pcs,
    mobiles: db.mobiles,
    // 2026-08-28 — the REAL RoomStore class, shared with the suite so a test can
    // put a fake socket in a room and make that PC genuinely present. A stub
    // returning `null` forever would make every presence assertion below pass
    // for the wrong reason (this is the same argument the file header makes for
    // using the production `Registry` rather than re-implementing the count).
    store,
    settings: db.settings,
    users: db.users,
    usage: db.usage,
    passwordLimiter: new RegisterRateLimiter(),
    // VERIFY-1 — this suite's subject is not the verification gate, so its
    // accounts are held verified by a stub reader (the gate itself — refusal,
    // admit, grandfather, real bootstrap wiring — is proven end-to-end in
    // test/email-verification.test.ts against db.emailVerification).
    verifiedEmail: { emailVerifiedAt: () => NOW },
    // MAIL-1 — required by ConsoleRoutesDeps since the password-reset surface got
    // a delivery leg. This suite never drives /api/password/*, so it takes the
    // loudly-failing mailer rather than a fake that would suggest it does: if a
    // case here ever reaches that route, it fails BY NAME instead of quietly
    // passing (src/mail/unconfigured.ts).
    mail: unconfiguredPasswordResetMailer(),
    now: () => NOW,
  };
}

/** Register a real account and mint a real Bearer for it. */
async function account(email: string): Promise<{ id: string; bearer: Record<string, string> }> {
  const user = await auth.register({ email, password: 'longenough1', display_name: 'T' });
  return { id: user.id, bearer: { authorization: `Bearer ${auth.issueToken(user).token}` } };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(async () => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  store = new RoomStore<FakeSocket>();
  const deps = makeDeps();
  // Free plan's REAL ceiling (2 PCs), read from the same single source
  // (billing/plans.ts) the production Registry reads — not a hand-picked
  // number that could quietly drift from what GA-16 actually enforces.
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode: 'saas', limitsOf: () => planLimits('free') });
  server = createServer((req, res) => {
    if (tryHandleConsoleRoutes(req, res, deps)) return;
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

describe('🔴 MEASURED — POST /api/cloud/devices/revoke never touches pc_devices', () => {
  it('revoking a mobile pairing on a PC at the ceiling does NOT free the PC slot', async () => {
    const a = await account('ceiling@d11.co');
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'inst-1' }).pc;
    registry.registerPc({ device_name: 'PC-2', user_id: a.id, client_instance_id: 'inst-2' });
    expect(db.pcs.listByUser(a.id)).toHaveLength(2); // free ceiling reached

    // Something REAL to revoke: a mobile paired to pc1.
    const pairing = registry.pairMobile({ short_code: pc1.short_code, pcid: pc1.pcid ?? undefined, mobile_name: 'Phone', user_id: a.id });

    const r = await post('/api/cloud/devices/revoke', { pairing_id: pairing.mobile.id }, a.bearer);
    expect(r.status).toBe(200);
    //  — the pairing had no live socket in this suite, and the
    // field says so rather than being omitted. 2026-08-28 added it so a caller
    // can tell 'the row is gone and the phone was told' from 'the row is gone'.
    expect(r.json).toEqual({ ok: true, revoked: true, evicted: false });

    // The mobile pairing is gone (the route DID do its own job)...
    expect(db.mobiles.findById(pairing.mobile.id)).toBeNull();
    // ...but pc1 is COMPLETELY untouched, and the PC count is still 2/2.
    expect(db.pcs.findById(pc1.id)).not.toBeNull();
    expect(db.pcs.listByUser(a.id)).toHaveLength(2);

    // 🔴 THE MEASURED DEFECT: the next PC registration STILL throws. A user
    // who "revoked a device" from the console has NOT gained a PC slot —
    // there is no code path from this route to a freed slot.
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: a.id, client_instance_id: 'inst-3' }),
    ).toThrow(ServerError);
    expect(db.pcs.listByUser(a.id)).toHaveLength(2); // unchanged by the throw
  });

  it('revoking ALL mobiles on ALL of a full account\'s PCs still leaves it at the ceiling', async () => {
    // The strongest form of the measurement: not "one revoke, unlucky pairing
    // choice", but "revoke everything revocable" — and the PC count does not
    // move by even one, because nothing in this route can ever reach it.
    const a = await account('revoke-all@d11.co');
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'inst-1' }).pc;
    const pc2 = registry.registerPc({ device_name: 'PC-2', user_id: a.id, client_instance_id: 'inst-2' }).pc;
    const m1 = registry.pairMobile({ short_code: pc1.short_code, pcid: pc1.pcid ?? undefined, mobile_name: 'P1', user_id: a.id });
    const m2 = registry.pairMobile({ short_code: pc2.short_code, pcid: pc2.pcid ?? undefined, mobile_name: 'P2', user_id: a.id });

    await post('/api/cloud/devices/revoke', { pairing_id: m1.mobile.id }, a.bearer);
    await post('/api/cloud/devices/revoke', { pairing_id: m2.mobile.id }, a.bearer);

    expect(db.mobiles.findById(m1.mobile.id)).toBeNull();
    expect(db.mobiles.findById(m2.mobile.id)).toBeNull();
    expect(db.pcs.listByUser(a.id)).toHaveLength(2); // still 2/2
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: a.id, client_instance_id: 'inst-3' }),
    ).toThrow(ServerError);
  });
});

describe('D11 fix — PcRepo.remove() is a REAL escape route off the device ceiling', () => {
  beforeEach(() => {
    db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
    db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
  });

  // ── 🔴 THE END-TO-END CASE THE CARD ASKS FOR ────────────────────────────
  it('limit reached -> user removes ONE device -> can pair (register) again', () => {
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: 'u1', client_instance_id: 'inst-1' }).pc;
    registry.registerPc({ device_name: 'PC-2', user_id: 'u1', client_instance_id: 'inst-2' });
    expect(db.pcs.listByUser('u1')).toHaveLength(2);
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: 'u1', client_instance_id: 'inst-3' }),
    ).toThrow(ServerError);

    // The self-service action itself: the user removes ONE of their own
    // devices (the reinstalled-Windows machine's stale row, in the card's
    // scenario).
    db.pcs.remove(pc1.id);
    expect(db.pcs.listByUser('u1')).toHaveLength(1);

    // The freed slot is IMMEDIATELY usable — `ensurePcSlot` recomputes
    // `realPcs(user_id).length` fresh on every call, so there is no cache to
    // invalidate and no second step required.
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: 'u1', client_instance_id: 'inst-3' }),
    ).not.toThrow();
    expect(db.pcs.listByUser('u1')).toHaveLength(2);
  });

  it('remove() cascades the removed device\'s mobile_pairings (schema.ts ON DELETE CASCADE)', () => {
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: 'u1', client_instance_id: 'inst-1' }).pc;
    const pairing = registry.pairMobile({ short_code: pc1.short_code, pcid: pc1.pcid ?? undefined, mobile_name: 'Phone', user_id: 'u1' });
    expect(db.mobiles.findById(pairing.mobile.id)).not.toBeNull();

    db.pcs.remove(pc1.id);

    expect(db.mobiles.findById(pairing.mobile.id)).toBeNull();
  });

  // ── 🔴 REVERSE CONTROL ────────────────────────────────────────────────────
  it("remove() only removes the row asked for — another user's device survives, and u1's OTHER pc survives too", () => {
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: 'u1', client_instance_id: 'inst-1' }).pc;
    const pc2 = registry.registerPc({ device_name: 'PC-2', user_id: 'u1', client_instance_id: 'inst-2' }).pc;
    registry.registerPc({ device_name: 'PC-A', user_id: 'u2', client_instance_id: 'inst-A' });

    db.pcs.remove(pc1.id);

    // The negative half: pc1 is gone.
    expect(db.pcs.findById(pc1.id)).toBeNull();
    // The positive half, in the SAME test: u1's OTHER device and u2's device
    // both survive untouched — a probe that removed everything would pass a
    // lone negative assertion just as easily.
    expect(db.pcs.findById(pc2.id)).not.toBeNull();
    expect(db.pcs.listByUser('u2')).toHaveLength(1);
  });
});

// ── 2026-08-28 — the console device-management surface ──────────────────────
//
// owner rulings (docs/decisions/2026-08-28-owner-web-rulings-console-device-
// management.md): presence is the present tense and never the persisted flag
// (§5-1); a console revoke takes effect NOW rather than at the phone's next
// reconnect (§5-2); removal is REFUSED while the computer is present (§2).
//
// What makes these assertions worth anything is that the store is the production
// `RoomStore` holding sockets the tests place by hand: "present" here is a socket
// in a room, not a boolean somebody set.
describe('console device management — presence, removal, eviction', () => {
  /** Put a PC in its room and stamp a fresh beat: genuinely present. */
  function bringOnline(pc: { id: string; room_uuid: string }, atMs: number = NOW): FakeSocket {
    const sock = fakeSocket(`pc-sock-${pc.id}`);
    store.joinPc(pc.room_uuid, sock);
    db.pcs.touchLastSeen(pc.id, new Date(atMs).toISOString());
    return sock;
  }

  async function devices(bearer: Record<string, string>): Promise<any> {
    const res = await fetch(`${url}/api/cloud/devices`, { headers: bearer });
    return res.json();
  }

  const RELEASED = { event: 'mobile:released', payload: { retry_after_ms: 0, revoked: true } };

  it('REVERSE CONTROL: is_online=1 with an empty room reads ABSENT (the relay-restart lie)', async () => {
    // THE case this judgement exists for. A relay restart drops every room but
    // touches no row, so `is_online` keeps saying 1 for a fleet of machines that
    // are not there. Read presence off that column and every one of those rows is
    // permanently unremovable — the dead end this surface was built to delete,
    // wearing a different hat.
    const a = await account('stale-flag@d11.co');
    const pc = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'i1' }).pc;
    db.pcs.setOnline(pc.id, true);
    db.pcs.touchLastSeen(pc.id, new Date(NOW).toISOString()); // the beat is fresh too
    expect(store.getPc(pc.room_uuid)).toBeNull(); // ...and yet nobody is in the room

    const row = (await devices(a.bearer)).pc_devices[0];
    expect(row.is_online).toBe(true); // the column still says so, honestly
    expect(row.is_present).toBe(false); // and the judgement disagrees, correctly

    // Removal going through is the user-visible half of that same fact.
    const r = await post('/api/cloud/devices/remove-pc', { pc_id: pc.id }, a.bearer);
    expect(r.json.removed).toBe(true);
  });

  it('present = in a room AND recently seen; a stale beat closes the ghost window', async () => {
    const a = await account('ghost@d11.co');
    const pc = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'i1' }).pc;
    bringOnline(pc);
    expect((await devices(a.bearer)).pc_devices[0].is_present).toBe(true);

    // Socket still in the room — socket.io holds a force-killed peer for up to its
    // ~20 s pingTimeout — but the 5 s beat stopped 16 s ago. Membership alone would
    // still say present; the freshness half is what closes that window.
    db.pcs.touchLastSeen(pc.id, new Date(NOW - 16_000).toISOString());
    expect(store.getPc(pc.room_uuid)).not.toBeNull();
    expect((await devices(a.bearer)).pc_devices[0].is_present).toBe(false);
  });

  it('a row that never connected is absent, not accidentally present', async () => {
    // `last_seen_at` is null here, and every comparison against NaN is false, so
    // the explicit null check is what keeps the answer from resting on that
    // accident rather than on a decision.
    //
    // ⚠️ INSERTED DIRECTLY, not registered, and the reason is worth the line: both
    // `registerPc` and `setOnline(id, false)` STAMP `last_seen_at` (the latter on
    // purpose — pc.repo.ts uses the disconnect moment so `listStaleOffline` can
    // read "disconnected long ago"). A row that has genuinely never connected can
    // therefore only be produced below the registry. Reaching for
    // `setOnline(false)` here is what my first draft did, and it failed loudly —
    // which is the mechanism working: the repo would not let a test pretend.
    const a = await account('never@d11.co');
    db.pcs.insert({
      id: 'never-connected', user_id: a.id, device_name: 'PC-1',
      client_instance_id: 'i1', machine_uid: null,
      device_token: 'fm_never', room_uuid: 'room-never', short_code: '0001',
    });
    expect(db.pcs.findById('never-connected')?.last_seen_at ?? null).toBeNull();
    expect((await devices(a.bearer)).pc_devices[0].is_present).toBe(false);
  });

  it('removal is REFUSED while the computer is present, and the slot stays taken', async () => {
    const a = await account('present@d11.co');
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'i1' }).pc;
    registry.registerPc({ device_name: 'PC-2', user_id: a.id, client_instance_id: 'i2' });
    bringOnline(pc1);

    const r = await post('/api/cloud/devices/remove-pc', { pc_id: pc1.id }, a.bearer);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, removed: false, reason: 'present' });
    expect(db.pcs.findById(pc1.id)).not.toBeNull();
    expect(db.pcs.listByUser(a.id)).toHaveLength(2);
  });

  it('removing an offline computer frees the slot through the production entry point', async () => {
    const a = await account('free-slot@d11.co');
    const pc1 = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'i1' }).pc;
    registry.registerPc({ device_name: 'PC-2', user_id: a.id, client_instance_id: 'i2' });
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: a.id, client_instance_id: 'i3' }),
    ).toThrow(ServerError);

    const r = await post('/api/cloud/devices/remove-pc', { pc_id: pc1.id }, a.bearer);
    expect(r.json).toEqual({ ok: true, removed: true, released: 0, evicted: 0 });

    // Measured through `registerPc` — the same gate that refused a moment ago —
    // rather than through a row count, which would prove only that a DELETE ran.
    expect(() =>
      registry.registerPc({ device_name: 'PC-3', user_id: a.id, client_instance_id: 'i3' }),
    ).not.toThrow();
  });

  it('removal cascades the pairings AND tells each phone before closing it', async () => {
    const a = await account('cascade@d11.co');
    const pc = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'i1' }).pc;
    const m1 = registry.pairMobile({ short_code: pc.short_code, pcid: pc.pcid ?? undefined, mobile_name: 'P1', user_id: a.id });
    const phone = fakeSocket('phone-1');
    store.joinMobile(pc.room_uuid, m1.mobile.id, phone);

    const r = await post('/api/cloud/devices/remove-pc', { pc_id: pc.id }, a.bearer);
    expect(r.json).toEqual({ ok: true, removed: true, released: 1, evicted: 1 });
    expect(db.mobiles.findById(m1.mobile.id)).toBeNull();

    // ORDER IS THE DELIVERY. socket.io drops anything queued on a closed socket,
    // so an implementation that disconnects first delivers nothing and the phone
    // renders a network-failure sentence for something a person did on purpose.
    // Asserting only that both happened would stay green for exactly that bug.
    expect(phone.disconnected).toBe(true);
    expect(phone.emitted).toEqual([RELEASED]);
    expect(phone.emitsAtDisconnect).toBe(1);
  });

  it('a console revoke evicts the live phone instead of leaving it a working session', async () => {
    // Before this round the row went and the phone was told nothing, so until it
    // happened to reconnect its socket injections kept landing while its HTTP
    // image uploads had already started answering 401 — one handset, two answers.
    const a = await account('revoke-live@d11.co');
    const pc = registry.registerPc({ device_name: 'PC-1', user_id: a.id, client_instance_id: 'i1' }).pc;
    const m1 = registry.pairMobile({ short_code: pc.short_code, pcid: pc.pcid ?? undefined, mobile_name: 'P1', user_id: a.id });
    const phone = fakeSocket('phone-1');
    store.joinMobile(pc.room_uuid, m1.mobile.id, phone);

    const r = await post('/api/cloud/devices/revoke', { pairing_id: m1.mobile.id }, a.bearer);
    expect(r.json).toEqual({ ok: true, revoked: true, evicted: true });
    expect(phone.emitted).toEqual([RELEASED]);
    expect(phone.emitsAtDisconnect).toBe(1);
  });

  it('another account computer answers exactly like one that does not exist', async () => {
    // No existence oracle: `not_found` covers both, byte-identical — the same
    // property the revoke route has held since it was written.
    const a = await account('owner-a@d11.co');
    const b = await account('owner-b@d11.co');
    const pcB = registry.registerPc({ device_name: 'B-PC', user_id: b.id, client_instance_id: 'ib' }).pc;

    const mine = await post('/api/cloud/devices/remove-pc', { pc_id: pcB.id }, a.bearer);
    const nothing = await post('/api/cloud/devices/remove-pc', { pc_id: 'no-such-row' }, a.bearer);
    expect(mine.json).toEqual({ ok: true, removed: false, reason: 'not_found' });
    expect(mine.json).toEqual(nothing.json);
    expect(db.pcs.findById(pcB.id)).not.toBeNull();
  });

  it('the virtual cloud-relay row is refused by name, not silently removed', async () => {
    // It takes no plan slot and admission re-creates it on the next connect, so a
    // button that appeared to work would change nothing at all.
    const a = await account('virtual@d11.co');
    const pc = registry.registerPc({
      device_name: 'Cloud', user_id: a.id, client_instance_id: 'flowmic-cloud-instance',
    }).pc;

    const r = await post('/api/cloud/devices/remove-pc', { pc_id: pc.id }, a.bearer);
    expect(r.json).toEqual({ ok: true, removed: false, reason: 'cloud_instance' });
    expect(db.pcs.findById(pc.id)).not.toBeNull();
  });

  it('the PCID reaches the console in full — the only cue that tells two same-named rows apart', async () => {
    const a = await account('pcid@d11.co');
    const pc = registry.registerPc({ device_name: 'dev-pc-a', user_id: a.id, client_instance_id: 'i1' }).pc;

    const row = (await devices(a.bearer)).pc_devices[0];
    expect(row.pcid).toBe(pc.pcid);
    expect(row.pcid).toMatch(/^\d{9}$/); // whole, not masked (owner 2026-08-28 §5-3)
  });
});
