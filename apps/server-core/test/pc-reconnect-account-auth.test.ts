// #6 P0 (owner batch 2026-08-04) — the zombie-room gate: a PC socket whose
// handshake PRESENTED an account JWT that failed verification must NOT re-enter
// its room on the device token alone.
//
// The incident shape this pins: the auth:expired watchdog is armed only for a
// VERIFIED handshake JWT (bootstrap), and the handshake itself never rejects
// (middleware contract) — so a cloud PC whose socket bounced across its key's
// exp instant used to reconnect with the stale JWT, pc:reconnect readmitted it
// on the device token alone, and /api/pc/presence — whose answer is exactly
// `store.getPc(room_uuid) !== null` — reported pc_online:true for a PC whose
// cloud login was dead, indefinitely. The phone then honestly painted online.
//
// Real handlers over a real sqlite db + real Registry + real RoomStore; fakes
// only at the socket seam (the presence-liveness.test.ts harness pattern). The
// middleware half (a bad/expired jwt records data.accountAuthError and lets the
// socket in) is pinned by the middleware's own tests; these drive the handler
// with that verdict already stamped on socket.data, exactly as production does.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:reconnect{token});
//           docs/rebuild/15-DELIVERY-CHANNELS-STATES-AND-FAILURES.md §4 R11
// *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

/** ClientInstanceId is `min(16)` — a short id would be a payload rejection. */
const PC_INSTANCE = 'desktop-instance-aaaa';

interface SocketData {
  auth: AuthContext | null;
  roomUuid?: string;
  /** The middleware's verdict on a PRESENT-but-bad handshake jwt (wire.ts
   *  getAccountAuthError reads this key). Absent = no jwt / verified jwt. */
  accountAuthError?: 'AUTH_TOKEN_EXPIRED' | 'AUTH_TOKEN_INVALID';
  /** The VERIFIED handshake-jwt identity (wire.ts getAccount reads this key),
   *  exactly as auth/middleware resolveHandshakeJwt stamps it. Absent = no jwt
   *  presented / standalone. */
  account?: { userId: string; plan: 'free' | 'pro' | 'max'; exp: number };
}

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();
  readonly handshake = { address: '10.0.0.9' };

  constructor(
    readonly id: string,
    public data: SocketData = { auth: null },
  ) {}

  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  off(): this {
    return this;
  }

  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }

  disconnect(): this {
    return this;
  }

  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      for (const fn of list) fn(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }
}

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;

function wirePc(socket: FakeSocket): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    resolveActingUser: () => ({ userId: 'default' }),
  });
  return socket;
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore<Socket>();
});
afterEach(() => db.close());

/** Register a PC through the REAL handler, then take its socket out of the room
 *  (the disconnect that precedes the incident's reconnect attempt). */
async function registeredPcOffline(): Promise<{ token: string; pcId: string; roomUuid: string }> {
  const sock = wirePc(new FakeSocket('s-pc-original'));
  const ack = await sock.invoke('pc:register', { device_name: 'PC-A', client_instance_id: PC_INSTANCE });
  if (ack.pc_id === undefined) throw new Error(`pc:register failed: ${JSON.stringify(ack)}`);
  const roomUuid = ack.room_uuid as string;
  store.leavePc(roomUuid, 's-pc-original');
  expect(store.getPc(roomUuid)).toBeNull();
  return { token: ack.token as string, pcId: ack.pc_id as string, roomUuid };
}

describe('#6 — pc:reconnect refuses a socket whose handshake jwt failed', () => {
  it('expired handshake jwt ⇒ ack {error: AUTH_TOKEN_EXPIRED}, room stays empty, no auth stamped', async () => {
    const pc = await registeredPcOffline();
    const zombie = wirePc(new FakeSocket('s-pc-zombie', { auth: null, accountAuthError: 'AUTH_TOKEN_EXPIRED' }));
    const ack = await zombie.invoke('pc:reconnect', { token: pc.token });
    // The WHOLE ack is the error — no room/token/roster fields may leak to a
    // socket the account layer just refused.
    expect(ack).toEqual({ error: 'AUTH_TOKEN_EXPIRED' });
    // The exact expression /api/pc/presence answers with must stay null: this
    // is the line that used to flip the phone's face to online.
    expect(store.getPc(pc.roomUuid)).toBeNull();
    expect(zombie.data.auth).toBeNull();
  });

  it('invalid handshake jwt ⇒ ack {error: AUTH_TOKEN_INVALID}, room stays empty', async () => {
    const pc = await registeredPcOffline();
    const zombie = wirePc(new FakeSocket('s-pc-badjwt', { auth: null, accountAuthError: 'AUTH_TOKEN_INVALID' }));
    const ack = await zombie.invoke('pc:reconnect', { token: pc.token });
    expect(ack).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(store.getPc(pc.roomUuid)).toBeNull();
  });

  it('positive control — a clean socket (no jwt verdict) reconnects and re-enters the room', async () => {
    const pc = await registeredPcOffline();
    const fresh = wirePc(new FakeSocket('s-pc-fresh'));
    const ack = await fresh.invoke('pc:reconnect', { token: pc.token });
    expect(ack.pc_id).toBe(pc.pcId);
    expect(ack.error).toBeUndefined();
    // Standalone shape rides this exact path: the LAN sidecar never configures
    // the jwt handshake, so accountAuthError can never be set there.
    expect((store.getPc(pc.roomUuid) as unknown as FakeSocket).id).toBe('s-pc-fresh');
    expect(fresh.data.auth).toEqual({ userId: 'default', deviceId: pc.pcId, kind: 'pc' });
  });

  it('collision pin — a DEAD DEVICE TOKEN also answers AUTH_TOKEN_INVALID (why the desktop routes only EXPIRED to its account path)', async () => {
    await registeredPcOffline();
    const fresh = wirePc(new FakeSocket('s-pc-deadtoken'));
    const ack = await fresh.invoke('pc:reconnect', { token: 'a'.repeat(64) });
    // One code, two meanings (dead device token here, bad jwt above). The
    // desktop therefore treats only AUTH_TOKEN_EXPIRED as an account refusal
    // that preserves the pairing credential (socket/pairing.rs) — INVALID keeps
    // the historical clear-token-and-re-register recovery. Pinned so a future
    // code split shows up as a conscious change, not an accident.
    expect(ack).toEqual({ error: 'AUTH_TOKEN_INVALID' });
  });
});

// A2 cross-account gate (owner 2026-08-11 cloud logout / switch account). The
// incident shape: desktop signs out of account A (clearCloudKey keeps
// credentials-cloud.bin by design), user pastes account B's key, the dial
// carries B's VERIFIED jwt — and pc:reconnect{token_A} used to resolve the
// token wholesale, `setAuth(userId: A)`, re-entering A's room: the machine
// keeps speaking as the account it just signed out of. The gate refuses with
// the EXISTING AUTH_TOKEN_INVALID, whose desktop meaning (clear device token,
// re-register) is exactly the recovery that lands the machine in B's account.
describe('A2 — pc:reconnect refuses a device token minted under another account', () => {
  const accountB = { userId: 'user-b', plan: 'free' as const, exp: 4102444800 };

  it('verified jwt for user B + token of user A ⇒ AUTH_TOKEN_INVALID, room stays empty, no auth stamped', async () => {
    db.users.insert({ id: 'user-b', display_name: 'B', plan: 'free' });
    const pc = await registeredPcOffline(); // registered under 'default' (= user A)
    const switched = wirePc(new FakeSocket('s-pc-switched', { auth: null, account: accountB }));
    const ack = await switched.invoke('pc:reconnect', { token: pc.token });
    expect(ack).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    // Read-only gate: the refused PC must not have been marked present.
    expect(store.getPc(pc.roomUuid)).toBeNull();
    expect(switched.data.auth).toBeNull();
  });

  it('positive control — the SAME account behind the verified jwt reconnects fine', async () => {
    const pc = await registeredPcOffline();
    const same = wirePc(
      new FakeSocket('s-pc-same-user', {
        auth: null,
        account: { userId: 'default', plan: 'free', exp: 4102444800 },
      }),
    );
    const ack = await same.invoke('pc:reconnect', { token: pc.token });
    expect(ack.pc_id).toBe(pc.pcId);
    expect(ack.error).toBeUndefined();
    expect((store.getPc(pc.roomUuid) as unknown as FakeSocket).id).toBe('s-pc-same-user');
  });

  it('negative boundary — no account on the socket (standalone / LAN) is byte-identical to before', async () => {
    // Same as the existing positive control, restated here so the A2 group
    // carries its own proof that the gate is inert without a verified jwt.
    const pc = await registeredPcOffline();
    const lan = wirePc(new FakeSocket('s-pc-lan'));
    const ack = await lan.invoke('pc:reconnect', { token: pc.token });
    expect(ack.pc_id).toBe(pc.pcId);
    expect(ack.error).toBeUndefined();
  });

  it('mismatched account + UNRESOLVED token still answers AUTH_TOKEN_INVALID (no oracle about which half failed)', async () => {
    db.users.insert({ id: 'user-b2', display_name: 'B2', plan: 'free' });
    const s = wirePc(
      new FakeSocket('s-pc-unresolved', {
        auth: null,
        account: { userId: 'user-b2', plan: 'free', exp: 4102444800 },
      }),
    );
    const ack = await s.invoke('pc:reconnect', { token: 'b'.repeat(64) });
    expect(ack).toEqual({ error: 'AUTH_TOKEN_INVALID' });
  });
});
