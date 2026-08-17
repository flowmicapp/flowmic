// card F6 / owner ruling ⑧ (2026-08-04) — "why is that PC not there".
//
// Contract: docs/rebuild/18-CONNECTION-STATES-THREE-ENDS.md §7.3 (written FIRST,
// per the repo's contract-area order). What these cases pin, in the order of how
// much it costs to get wrong:
//   ① 🔴 the END-TO-END fact that did not exist before: after the watchdog kicks
//      an expired cloud PC, the phone's own HTTP question comes back with
//      `pc_absent_reason: 'auth_expired'` instead of a bare 「not here」. Driven
//      through the REAL watchdog, the REAL pc handler and the REAL route, with
//      NOTHING injected between them — the module table they share is the
//      production one, so a table nobody wired would fail here.
//   ② the same for write site ②, the pc:reconnect account gate — and the
//      NEGATIVE half: an AUTH_TOKEN_INVALID verdict records nothing, because
//      「did not verify」 is not 「expired」.
//   ③ 🔴 no cross-PC / cross-ACCOUNT leak: a reason filed against someone else's
//      machine is never visible to this phone. With a positive control, so the
//      「absent」 cannot be a broken recorder.
//   ④ the reason cannot outlive its fact: coming back into the room erases it,
//      so the NEXT ordinary shutdown is reported exactly as today.
//   ⑤ the response is byte-identical to today's whenever nothing was recorded —
//      that is the whole "failure direction degrades to the status quo" argument, asserted rather than
//      claimed in a comment.
//   ⑥ the table is BOUNDED (cap + TTL, both directions) and its value set is
//      CLOSED.
//
// *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Server, Socket } from 'socket.io';
import { PC_PRESENCE_PATH, tryHandlePresenceRoutes } from '../src/http/presence-routes';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { armAuthExpiry } from '../src/socket/handlers/auth-expiry';
import {
  PcAbsenceReasons,
  PC_ABSENCE_MAX_ENTRIES,
  PC_ABSENCE_TTL_MS,
  PC_ABSENT_REASONS,
  pcAbsenceReasons,
} from '../src/room/pc-absence';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

// ── the http half (same shapes as http-pc-presence.test.ts) ──────────────────

function request(url: string, token?: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = 'GET';
  req.url = url;
  (req as { headers: Record<string, string> }).headers =
    token === undefined ? {} : { authorization: `Bearer ${token}` };
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: '10.0.0.44' };
  return req;
}

function response(): { res: ServerResponse; read(): { status: number; body: Record<string, unknown> } } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(payload?: string) {
      body = payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
    },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body }) };
}

// ── the socket half (same FakeSocket shape as pc-reconnect-account-auth) ─────

const PC_INSTANCE = 'desktop-instance-aaaa';

interface SocketData {
  auth: AuthContext | null;
  roomUuid?: string;
  accountAuthError?: 'AUTH_TOKEN_EXPIRED' | 'AUTH_TOKEN_INVALID';
}

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  disconnected = false;
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
    this.disconnected = true;
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

/** Fire the auth:expired watchdog on demand: `armAuthExpiry`'s scheduler seam is
 *  captured, so nothing sleeps and the fire happens where the test says. */
function armAndFire(socket: FakeSocket): void {
  let fire: (() => void) | null = null;
  armAuthExpiry(socket as unknown as Socket, 0, {
    nowMs: () => 0,
    setTimeoutFn: ((fn: () => void) => {
      fire = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
  });
  if (fire === null) throw new Error('the watchdog scheduled nothing — this run proves nothing');
  (fire as () => void)();
}

// ── one real world: real db, real Registry, real RoomStore, real handlers ────
//
// TWO users on purpose. 「Never leak another account's machine」 cannot be
// asserted against a single-tenant world, and the relay is the deployment that
// has more than one.

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;

interface Pc {
  pcId: string;
  roomUuid: string;
  deviceToken: string;
  mobileToken: string;
}

function makePc(userId: string, name: string, instance: string): Pc {
  const reg = registry.registerPc({ device_name: name, user_id: userId, client_instance_id: instance });
  const pair = registry.pairMobile({ short_code: reg.pc.short_code, mobile_name: `${name} phone`, user_id: userId });
  return {
    pcId: reg.pc.id,
    roomUuid: reg.pc.room_uuid,
    deviceToken: reg.token,
    mobileToken: pair.token,
  };
}

/** The phone's own question, asked exactly the way the router asks it — with NO
 *  absence table injected, because production has none to inject. */
function askPresence(mobileToken: string): { status: number; body: Record<string, unknown> } {
  const { res, read } = response();
  tryHandlePresenceRoutes(request(PC_PRESENCE_PATH, mobileToken), res, {
    registry,
    store: store as unknown as RoomStore,
    pcs: db.pcs,
  });
  return read();
}

function wirePc(socket: FakeSocket): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    resolveActingUser: () => ({ userId: 'u1' }),
  });
  return socket;
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  db.users.insert({ id: 'u2', display_name: 'U2', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore<Socket>();
  // Module singleton is shared across cases; drain so size assertions measure
  // this case alone (production erase path remains clearFor).
  pcAbsenceReasons.drainForTests();
});
afterEach(() => db.close());

describe('① 🔴 the watchdog kick becomes an ANSWER the phone can read', () => {
  it('expired cloud key ⇒ presence says pc_online:false + pc_absent_reason:auth_expired', () => {
    const pc = makePc('u1', 'PC-A', PC_INSTANCE);
    store.joinPc(pc.roomUuid, { id: 's-pc' } as unknown as Socket);
    // Before: online, and the reason field has no business being there.
    expect(askPresence(pc.mobileToken).body).toEqual({ ok: true, pc_id: pc.pcId, pc_online: true });

    // The kick, through the REAL watchdog on a socket shaped like the one
    // bootstrap arms: a PC that reached its room (kind:'pc' + roomUuid are
    // stamped together by pc:register/pc:reconnect).
    const pcSocket = new FakeSocket('s-pc', {
      auth: { userId: 'u1', deviceId: pc.pcId, kind: 'pc' } as AuthContext,
      roomUuid: pc.roomUuid,
    });
    armAndFire(pcSocket);
    // The kick's own contract still holds (this card must not have moved it).
    expect(pcSocket.emitted).toEqual([{ event: 'auth:expired', payload: {} }]);
    expect(pcSocket.disconnected).toBe(true);
    // Production empties the room from bootstrap's disconnect hook; that file is
    // untouched by this card, so the test does what it does.
    store.leavePc(pc.roomUuid, 's-pc');

    expect(askPresence(pc.mobileToken).body).toEqual({
      ok: true,
      pc_id: pc.pcId,
      pc_online: false,
      pc_absent_reason: 'auth_expired',
    });
  });

  it('a MOBILE socket whose own login expires records nothing about any PC', () => {
    const pc = makePc('u1', 'PC-A', PC_INSTANCE);
    // Same watchdog, armed for an in-session mobile:login (auth.handler). Its
    // expiry is a fact about a phone; answering it into PRESENCE would be one
    // value answering two questions.
    const phone = new FakeSocket('s-mob', {
      auth: { userId: 'u1', pairingId: 'pair-x', kind: 'mobile' } as unknown as AuthContext,
      roomUuid: pc.roomUuid,
    });
    armAndFire(phone);
    expect(phone.emitted).toEqual([{ event: 'auth:expired', payload: {} }]);
    expect(askPresence(pc.mobileToken).body).toEqual({ ok: true, pc_id: pc.pcId, pc_online: false });
  });
});

describe('② the pc:reconnect account gate — write site ②', () => {
  it('AUTH_TOKEN_EXPIRED refusal ⇒ the phone is told WHY, on the very next poll', async () => {
    const pc = makePc('u1', 'PC-A', PC_INSTANCE);
    // The incident's shape: the PC is NOT in the room (its socket bounced), so
    // nothing about its room can be recorded — the refusal holds only the token.
    expect(askPresence(pc.mobileToken).body).toEqual({ ok: true, pc_id: pc.pcId, pc_online: false });

    const zombie = wirePc(new FakeSocket('s-zombie', { auth: null, accountAuthError: 'AUTH_TOKEN_EXPIRED' }));
    const ack = await zombie.invoke('pc:reconnect', { token: pc.deviceToken });
    expect(ack).toEqual({ error: 'AUTH_TOKEN_EXPIRED' });
    // The gate itself must not have loosened: the room stays empty.
    expect(store.getPc(pc.roomUuid)).toBeNull();

    expect(askPresence(pc.mobileToken).body).toEqual({
      ok: true,
      pc_id: pc.pcId,
      pc_online: false,
      pc_absent_reason: 'auth_expired',
    });
  });

  it('🔴 AUTH_TOKEN_INVALID records NOTHING — "did not verify" is not "expired"', async () => {
    const pc = makePc('u1', 'PC-A', PC_INSTANCE);
    const bad = wirePc(new FakeSocket('s-badjwt', { auth: null, accountAuthError: 'AUTH_TOKEN_INVALID' }));
    expect(await bad.invoke('pc:reconnect', { token: pc.deviceToken })).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    // Degrades to exactly today's answer. An INVALID key may not even be that
    // PC calling, so "login has expired" would be a fact we invented.
    expect(askPresence(pc.mobileToken).body).toEqual({ ok: true, pc_id: pc.pcId, pc_online: false });
  });

  it('a dead DEVICE token cannot file a reason against a PC (IT-13: unresolved ⇒ no entry)', async () => {
    const pc = makePc('u1', 'PC-A', PC_INSTANCE);
    const before = pcAbsenceReasons.size;
    const stranger = wirePc(new FakeSocket('s-stranger', { auth: null, accountAuthError: 'AUTH_TOKEN_EXPIRED' }));
    await stranger.invoke('pc:reconnect', { token: 'f'.repeat(64) });
    // IT-13: the unresolved token is not stored at all (pre-IT-13 it burned a
    // slot under an unreachable digest). Size must not move; the reader still
    // sees bare "not here".
    expect(pcAbsenceReasons.size).toBe(before);
    expect(askPresence(pc.mobileToken).body).toEqual({ ok: true, pc_id: pc.pcId, pc_online: false });
  });
});

describe('③ 🔴 a phone is only ever told about ITS OWN PC (ID mix-up / cross-account)', () => {
  it('another ACCOUNT\'s expired PC is invisible here — with a positive control', () => {
    const mine = makePc('u1', 'PC-A', PC_INSTANCE);
    const theirs = makePc('u2', 'PC-C', 'desktop-instance-cccc');
    expect(mine.roomUuid).not.toBe(theirs.roomUuid);

    // u2's machine died of an expired key.
    const theirSocket = new FakeSocket('s-u2', {
      auth: { userId: 'u2', deviceId: theirs.pcId, kind: 'pc' } as AuthContext,
      roomUuid: theirs.roomUuid,
    });
    armAndFire(theirSocket);

    // u1's phone sees its OWN offline PC and not one word about u2's.
    expect(askPresence(mine.mobileToken).body).toEqual({ ok: true, pc_id: mine.pcId, pc_online: false });
    // 🔴 Positive control: the reason really was recorded, so the absence above
    // is this route refusing to say it — not a recorder that did nothing.
    expect(askPresence(theirs.mobileToken).body).toEqual({
      ok: true,
      pc_id: theirs.pcId,
      pc_online: false,
      pc_absent_reason: 'auth_expired',
    });
  });

  it('a second PC of the SAME user is just as separate', () => {
    const a = makePc('u1', 'PC-A', PC_INSTANCE);
    const b = makePc('u1', 'PC-B', 'desktop-instance-bbbb');
    armAndFire(
      new FakeSocket('s-b', {
        auth: { userId: 'u1', deviceId: b.pcId, kind: 'pc' } as AuthContext,
        roomUuid: b.roomUuid,
      }),
    );
    expect(askPresence(a.mobileToken).body).toEqual({ ok: true, pc_id: a.pcId, pc_online: false });
    expect(askPresence(b.mobileToken).body.pc_absent_reason).toBe('auth_expired');
  });
});

describe('④ a reason must never outlive the fact it describes', () => {
  it('coming back into the room erases it — the next ordinary shutdown reads as today', async () => {
    const pc = makePc('u1', 'PC-A', PC_INSTANCE);
    armAndFire(
      new FakeSocket('s-old', {
        auth: { userId: 'u1', deviceId: pc.pcId, kind: 'pc' } as AuthContext,
        roomUuid: pc.roomUuid,
      }),
    );
    expect(askPresence(pc.mobileToken).body.pc_absent_reason).toBe('auth_expired');

    // The owner logs in again: a clean socket (no jwt verdict) reconnects.
    const fresh = wirePc(new FakeSocket('s-fresh'));
    const ack = await fresh.invoke('pc:reconnect', { token: pc.deviceToken });
    expect(ack.pc_id).toBe(pc.pcId);
    expect(askPresence(pc.mobileToken).body).toEqual({ ok: true, pc_id: pc.pcId, pc_online: true });

    // …and later switches the machine off. THIS is the direction a leftover
    // entry would turn into a lie: "powered off" reported as "login expired".
    store.leavePc(pc.roomUuid, 's-fresh');
    expect(askPresence(pc.mobileToken).body).toEqual({ ok: true, pc_id: pc.pcId, pc_online: false });
  });

  it('the register leg erases too (a desktop that lost its credentials keeps its room)', async () => {
    const sock = wirePc(new FakeSocket('s-reg'));
    const reg = await sock.invoke('pc:register', { device_name: 'PC-R', client_instance_id: PC_INSTANCE });
    const pair = registry.pairMobile({
      short_code: reg.short_code as string,
      mobile_name: 'phone',
      user_id: 'u1',
    });
    const roomUuid = reg.room_uuid as string;
    store.leavePc(roomUuid, 's-reg');
    armAndFire(
      new FakeSocket('s-reg-old', {
        auth: { userId: 'u1', deviceId: reg.pc_id as string, kind: 'pc' } as AuthContext,
        roomUuid,
      }),
    );
    expect(askPresence(pair.token).body.pc_absent_reason).toBe('auth_expired');

    // registerPc recognises the machine and returns it to the SAME room.
    const again = wirePc(new FakeSocket('s-reg2'));
    await again.invoke('pc:register', { device_name: 'PC-R', client_instance_id: PC_INSTANCE });
    store.leavePc(roomUuid, 's-reg2');
    expect(askPresence(pair.token).body).toEqual({
      ok: true,
      pc_id: reg.pc_id,
      pc_online: false,
    });
  });

  it('⑤ an ONLINE PC is never given a reason, even when one is on file', () => {
    const pc = makePc('u1', 'PC-A', PC_INSTANCE);
    armAndFire(
      new FakeSocket('s-old', {
        auth: { userId: 'u1', deviceId: pc.pcId, kind: 'pc' } as AuthContext,
        roomUuid: pc.roomUuid,
      }),
    );
    // Something else puts a socket back in the room without going through the
    // handlers' erase (belt and braces: the online answer must be the three keys
    // whatever the table holds — 「why is it not here」 has no answer for a PC
    // that IS here).
    store.joinPc(pc.roomUuid, { id: 's-back' } as unknown as Socket);
    expect(Object.keys(askPresence(pc.mobileToken).body).sort()).toEqual(['ok', 'pc_id', 'pc_online']);
  });
});

describe('⑥ the table itself: closed set, bounded, and keyed per PC', () => {
  it('the reason set is CLOSED — adding a value is a contract change (book 18 §7.3.1)', () => {
    expect([...PC_ABSENT_REASONS]).toEqual(['auth_expired']);
    // No 'unknown' member on purpose: an absent field IS "unknown", and a value
    // with no writer is the repo's #1 historical defect.
    expect(PC_ABSENT_REASONS).not.toContain('unknown');
  });

  it('both addressing forms answer, and they do NOT collide with each other', () => {
    const t = new PcAbsenceReasons(() => 1_000);
    t.noteByRoom('room-1', 'auth_expired');
    expect(t.reasonFor({ room_uuid: 'room-1', device_token: 'tok-1' })).toBe('auth_expired');
    // The room id is not readable as a token and vice versa: the two forms live
    // in separate key namespaces, so one PC's room can never be addressed by
    // another PC's token.
    expect(t.reasonFor({ room_uuid: 'other', device_token: 'room-1' })).toBeNull();
    t.noteByDeviceToken('tok-2', 'auth_expired', true);
    expect(t.reasonFor({ room_uuid: 'other', device_token: 'tok-2' })).toBe('auth_expired');
    expect(t.reasonFor({ room_uuid: 'tok-2', device_token: 'nope' })).toBeNull();
  });

  it('TTL: an entry stops answering, and is pruned rather than merely hidden', () => {
    let now = 0;
    const t = new PcAbsenceReasons(() => now, 512, 1_000);
    t.noteByRoom('room-1', 'auth_expired');
    now = 999;
    expect(t.reasonFor({ room_uuid: 'room-1', device_token: 'x' })).toBe('auth_expired');
    now = 1_000;
    expect(t.reasonFor({ room_uuid: 'room-1', device_token: 'x' })).toBeNull();
    expect(t.size).toBe(0);
  });

  it('TTL is per ENTRY, not per PC — a fresh token entry survives a dead room entry', () => {
    let now = 0;
    const t = new PcAbsenceReasons(() => now, 512, 1_000);
    t.noteByRoom('room-1', 'auth_expired');
    now = 900;
    t.noteByDeviceToken('tok-1', 'auth_expired', true);
    now = 1_500;
    expect(t.reasonFor({ room_uuid: 'room-1', device_token: 'tok-1' })).toBe('auth_expired');
  });

  it('CAP: the map cannot grow past its bound, and the OLDEST write is what goes', () => {
    const t = new PcAbsenceReasons(() => 1_000, 3);
    for (let i = 0; i < 10; i++) t.noteByRoom(`room-${i}`, 'auth_expired');
    expect(t.size).toBe(3);
    expect(t.reasonFor({ room_uuid: 'room-0', device_token: 'x' })).toBeNull();
    expect(t.reasonFor({ room_uuid: 'room-9', device_token: 'x' })).toBe('auth_expired');
    // Re-stamping an existing entry keeps it young: it moves to the end of the
    // eviction order instead of holding its original slot.
    t.noteByRoom('room-7', 'auth_expired');
    for (let i = 10; i < 12; i++) t.noteByRoom(`room-${i}`, 'auth_expired');
    expect(t.reasonFor({ room_uuid: 'room-7', device_token: 'x' })).toBe('auth_expired');
    expect(t.size).toBe(3);
  });

  it('expired entries are swept on WRITE too (a table nobody reads still cannot grow)', () => {
    let now = 0;
    const t = new PcAbsenceReasons(() => now, 512, 1_000);
    for (let i = 0; i < 50; i++) t.noteByRoom(`room-${i}`, 'auth_expired');
    expect(t.size).toBe(50);
    now = 5_000;
    t.noteByRoom('room-new', 'auth_expired');
    expect(t.size).toBe(1);
  });

  it('clearFor erases BOTH forms for that PC and nothing else', () => {
    const t = new PcAbsenceReasons(() => 1_000);
    t.noteByRoom('room-1', 'auth_expired');
    t.noteByDeviceToken('tok-1', 'auth_expired', true);
    t.noteByRoom('room-2', 'auth_expired');
    t.clearFor({ room_uuid: 'room-1', device_token: 'tok-1' });
    expect(t.reasonFor({ room_uuid: 'room-1', device_token: 'tok-1' })).toBeNull();
    expect(t.reasonFor({ room_uuid: 'room-2', device_token: 'x' })).toBe('auth_expired');
    expect(t.size).toBe(1);
  });

  it('the shipped defaults are the ones the contract names', () => {
    expect(PC_ABSENCE_MAX_ENTRIES).toBe(512);
    expect(PC_ABSENCE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    // The ONE table the route reads and the handlers write — same object, which
    // is the whole wiring of this card.
    expect(pcAbsenceReasons).toBeInstanceOf(PcAbsenceReasons);
  });
});

// ── IT-13: flood cannot squeeze genuine entries ─────────────────────────────
//
// Pre-fix: write site ② hashed whatever token string arrived, so 512 random
// digests could push every real entry out of the cap. Post-fix: unresolved
// tokens never enter; a genuine resolved write still does (positive control).
// The reverse control below is run by hand (break → red → restore → green);
// a reverse control never observed red does not count in this repo.

describe('IT-13 — unresolved flood cannot evict a genuine absence reason', () => {
  it('flood of random tokens on AUTH_TOKEN_EXPIRED leaves a genuine entry answering', async () => {
    const genuine = makePc('u1', 'PC-A', PC_INSTANCE);
    // Seed the genuine reason the way write site ② does for a real desktop.
    const seed = wirePc(new FakeSocket('s-seed', { auth: null, accountAuthError: 'AUTH_TOKEN_EXPIRED' }));
    expect(await seed.invoke('pc:reconnect', { token: genuine.deviceToken })).toEqual({
      error: 'AUTH_TOKEN_EXPIRED',
    });
    expect(askPresence(genuine.mobileToken).body.pc_absent_reason).toBe('auth_expired');
    const sizeAfterGenuine = pcAbsenceReasons.size;

    // Spray far more than the cap with tokens that resolve to nothing.
    const flooder = wirePc(new FakeSocket('s-flood', { auth: null, accountAuthError: 'AUTH_TOKEN_EXPIRED' }));
    for (let i = 0; i < PC_ABSENCE_MAX_ENTRIES + 64; i++) {
      const junk = `flood-${i}-`.padEnd(64, '0');
      await flooder.invoke('pc:reconnect', { token: junk });
    }

    // Genuine entry still answers; the flood added zero slots.
    expect(pcAbsenceReasons.size).toBe(sizeAfterGenuine);
    expect(askPresence(genuine.mobileToken).body).toEqual({
      ok: true,
      pc_id: genuine.pcId,
      pc_online: false,
      pc_absent_reason: 'auth_expired',
    });
  });

  it('POSITIVE CONTROL — ordinary resolved absence recording still works', async () => {
    // A fix that broke the whole table would look identical to a correct fix
    // on the flood test alone (both end with 「genuine still answers」 only if
    // the genuine write happened; this case pins that write itself).
    const pc = makePc('u1', 'PC-A', PC_INSTANCE);
    expect(askPresence(pc.mobileToken).body).toEqual({ ok: true, pc_id: pc.pcId, pc_online: false });
    const sock = wirePc(new FakeSocket('s-pos', { auth: null, accountAuthError: 'AUTH_TOKEN_EXPIRED' }));
    expect(await sock.invoke('pc:reconnect', { token: pc.deviceToken })).toEqual({
      error: 'AUTH_TOKEN_EXPIRED',
    });
    expect(askPresence(pc.mobileToken).body).toEqual({
      ok: true,
      pc_id: pc.pcId,
      pc_online: false,
      pc_absent_reason: 'auth_expired',
    });
  });

  it('table-level: unresolved noteByDeviceToken is a no-op (does not claim a slot)', () => {
    const t = new PcAbsenceReasons(() => 1_000, 3);
    t.noteByDeviceToken('real-tok', 'auth_expired', true);
    expect(t.size).toBe(1);
    for (let i = 0; i < 20; i++) {
      t.noteByDeviceToken(`junk-${i}`, 'auth_expired', false);
    }
    expect(t.size).toBe(1);
    expect(t.reasonFor({ room_uuid: 'x', device_token: 'real-tok' })).toBe('auth_expired');
  });

  it('table-level: resolved writes still evict oldest among themselves at the cap', () => {
    // Grading must not freeze the cap into 「first 512 forever」 — re-stamping
    // and oldest-first among RESOLVED entries remain the bound.
    const t = new PcAbsenceReasons(() => 1_000, 3);
    for (let i = 0; i < 5; i++) t.noteByDeviceToken(`tok-${i}`, 'auth_expired', true);
    expect(t.size).toBe(3);
    expect(t.reasonFor({ room_uuid: 'x', device_token: 'tok-0' })).toBeNull();
    expect(t.reasonFor({ room_uuid: 'x', device_token: 'tok-4' })).toBe('auth_expired');
  });
});
