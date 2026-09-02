// A read-only relay replica must REFUSE the socket events whose writes it cannot
// keep — by name, before the write — instead of accepting them into a database
// the next replication pull replaces.
//
// SPEC-REF: docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §10
//           apps/server-core/src/node/writer-only.ts (the measurement)
//
// ── WHAT MAKES THESE ASSERTIONS WORTH ANYTHING ─────────────────────────────
// Two things, and neither is「it returned an error」:
//
//  ① EVERY refusal is paired with a REVERSE CONTROL — the identical call with
//     `NODE_CAN_WRITE`, asserted to SUCCEED and to leave the row behind. Without
//     it, a guard that refused unconditionally, or a handler that was already
//     broken for some unrelated reason, would pass every test in this file.
//
//  ② EVERY refusal also asserts the DATABASE, not just the ack. 「Said no」 and
//     「wrote nothing」 are two different claims and this whole card exists
//     because a write that happens and then evaporates is indistinguishable, from
//     the ack's point of view, from one that never happened.
//
// And one negative control at the end that is arguably the most important test
// here: a replica still SERVES READS. Refusing everything would satisfy every
// other assertion in this file while destroying the only reason a replica exists.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { registerSettingsHandlers } from '../src/socket/handlers/settings.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { ERROR_CODES } from '@flowmic/protocol';
import { makeWriterOnlyGuard, NODE_CAN_WRITE, type WriterOnlyGuard } from '../src/node/writer-only';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;
const WRITER = 'https://srvny.flowmic.app';

interface FakeSocket {
  id: string;
  data: { auth: AuthContext | null; roomUuid?: string };
  on(event: string, fn: (payload: unknown, ack: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  join(room: string): void;
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>>;
}

function fakeSocket(id: string, auth: AuthContext | null, roomUuid?: string): FakeSocket {
  const handlers = new Map<string, (payload: unknown, ack: unknown) => void>();
  return {
    id,
    data: roomUuid === undefined ? { auth } : { auth, roomUuid },
    on(event, fn) { handlers.set(event, fn); },
    emit() { /* fan-out is not what this file is about */ },
    join() { /* ditto */ },
    invoke(event, payload) {
      return new Promise((resolve) => {
        const h = handlers.get(event);
        if (!h) return resolve({ __no_handler: true });
        h(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
      });
    },
  };
}

let db: Db;
let registry: Registry;
let store: RoomStore;

const io = { sockets: { sockets: new Map() } } as unknown as Server;

/** Wire all three handlers onto one socket under a given node role. */
function wire(socket: FakeSocket, writerOnly: WriterOnlyGuard): FakeSocket {
  const resolveActingUser = () => ({ userId: socket.data.auth?.userId ?? 'default' });
  registerPcHandlers(socket as unknown as Socket, {
    io, registry, store: store as RoomStore<Socket>, resolveActingUser, writerOnly,
  });
  registerMobileHandlers(socket as unknown as Socket, {
    io, registry, store: store as RoomStore<Socket>, pairLimiter: new PairRateLimiter(),
    mode: 'standalone', resolveActingUser, writerOnly,
    restriction: { getUser: () => ({ restricted_at: null, restriction_reason: null }) },
  });
  registerSettingsHandlers(socket as unknown as Socket, {
    io, repo: db.settings, registry, store: store as RoomStore<Socket>, writerOnly,
  });
  return socket;
}

const replica = () => makeWriterOnlyGuard(WRITER);

/** Assert the shape every refusal in this file must have. */
function expectRefusal(ack: Record<string, unknown>): void {
  expect(ack.error).toBe('NODE_IS_REPLICA');
  // It names WHERE, because「no」without「then who?」costs an operator an hour.
  expect(ack.writer).toBe(WRITER);
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore();
});
afterEach(() => db.close());

describe('a replica refuses the writes it cannot keep', () => {
  it('pc:register — refused by name, and NOT ONE ROW written', async () => {
    const sock = wire(fakeSocket('s1', null), replica());
    const ack = await sock.invoke('pc:register', { device_name: 'PC-A', client_instance_id: 'inst-aaaaaaaaaaaaaaa', machine_uid: 'ma-0123456789abcdef' });

    expectRefusal(ack);
    // 🔴 The database, not the ack. registerPc is eight writes; the ack could say
    // anything and this is the claim that matters.
    expect(db.pcs.listByUser('default')).toHaveLength(0);
    // And no token was minted for a registration that did not happen.
    expect(ack.short_code).toBeUndefined();
  });

  it('REVERSE CONTROL — the same call on a writable node registers and persists', async () => {
    const sock = wire(fakeSocket('s1', null), NODE_CAN_WRITE);
    const ack = await sock.invoke('pc:register', { device_name: 'PC-A', client_instance_id: 'inst-aaaaaaaaaaaaaaa', machine_uid: 'ma-0123456789abcdef' });

    expect(ack.error).toBeUndefined();
    expect(typeof ack.short_code).toBe('string');
    expect(db.pcs.listByUser('default')).toHaveLength(1);
  });

  it('mobile:pair — refused, and the brute-force budget is NOT spent', async () => {
    // Seed a real PC on a writable node first: the phone's refusal must be about
    // the NODE, not about there being nothing to pair with.
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'inst-aaaaaaaaaaaaaaa' });

    const sock = wire(fakeSocket('s2', null), replica());
    const ack = await sock.invoke('mobile:pair', { short_code: pc.short_code, mobile_name: 'Pixel' });

    expectRefusal(ack);
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(0);
    // 🔴 REFUSED BEFORE `resolvePcForPair`, and the reason is NOT the one an
    // earlier draft of this comment gave. It claimed the failed-guess ledger is
    // erased by replication; it is an in-memory Map (room/short-code.ts) and a
    // pull never touches it. The real reason: a replica's governor never stamped
    // anything, so `isActive` is false for every row it holds, a CORRECT code
    // resolves to nothing, and the user is told 「配对码无效」 about a code that is
    // right. Refusing by name is the difference between a wrong answer and a
    // true one.
    //
    // What this line asserts is the narrow, honest thing: the refusal consumed
    // nothing — the issuance is untouched, not burned by an attempt that never
    // reached the pairing logic.
    expect(registry.isCodeActive(pc.id)).toBe(true);
  });

  it('REVERSE CONTROL — the same pairing on a writable node succeeds', async () => {
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'inst-aaaaaaaaaaaaaaa' });
    const sock = wire(fakeSocket('s2', null), NODE_CAN_WRITE);
    const ack = await sock.invoke('mobile:pair', { short_code: pc.short_code, mobile_name: 'Pixel' });

    expect(ack.error).toBeUndefined();
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(1);
  });

  // B11 (2026-09-02, WP-6) — the OTHER first-contact arm. `writer-only.ts`
  // refuses `mobile:pair` unconditionally BEFORE it looks at which variant the
  // payload names (short_code vs qr_payload vs cloud_instance) — this proves
  // that guard actually covers the QR arm too, not only the one the rest of
  // this describe block happens to exercise. Content of `qr_payload` is
  // irrelevant here: the refusal fires before anything parses it.
  it('mobile:pair via qr_payload — refused exactly like the short-code arm', async () => {
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'inst-aaaaaaaaaaaaaaa' });
    const sock = wire(fakeSocket('s2b', null), replica());
    const ack = await sock.invoke('mobile:pair', {
      qr_payload: `flowmic://pair?endpoint=wss://x&code=${pc.short_code}&channel=standalone`,
      mobile_name: 'Pixel',
    });

    expectRefusal(ack);
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(0);
  });

  it('REVERSE CONTROL — the same qr_payload pairing on a writable node succeeds', async () => {
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'inst-aaaaaaaaaaaaaaa' });
    const sock = wire(fakeSocket('s2c', null), NODE_CAN_WRITE);
    const ack = await sock.invoke('mobile:pair', {
      qr_payload: `flowmic://pair?endpoint=wss://x&code=${pc.short_code}&channel=standalone`,
      mobile_name: 'Pixel',
    });

    expect(ack.error).toBeUndefined();
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(1);
  });

  it('pc:release-mobile — refused, and THE PAIRING IS STILL THERE', async () => {
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'inst-aaaaaaaaaaaaaaa' });
    const { mobile } = registry.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel', user_id: 'default' });

    const sock = wire(
      fakeSocket('s3', { userId: 'default', deviceId: pc.id, kind: 'pc' }, pc.room_uuid),
      replica(),
    );
    const ack = await sock.invoke('pc:release-mobile', { mobile_id: mobile.id, revoke: true, reason: 'manual' });

    expectRefusal(ack);
    // 🔴 A REVOKE THAT COMES BACK. If this ever asserts the opposite, a user has
    // removed a phone, been told it worked, and had it restored thirty seconds
    // later with nothing logged anywhere.
    expect(db.mobiles.listByPc(pc.id).map((m) => m.id)).toContain(mobile.id);
  });

  it('mobile:unpair — refused, and the pairing survives', async () => {
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'inst-aaaaaaaaaaaaaaa' });
    const { mobile } = registry.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel', user_id: 'default' });

    const sock = wire(
      fakeSocket('s4', { userId: 'default', pairingId: mobile.id, deviceId: pc.id, kind: 'mobile' }, pc.room_uuid),
      replica(),
    );
    expectRefusal(await sock.invoke('mobile:unpair', {}));
    expect(db.mobiles.listByPc(pc.id)).toHaveLength(1);
  });

  // ⚠️ 2026-08-31 — READ THIS WITH replica-code-mint-forwarding.test.ts. This
  // harness wires NO `mintCodeOnWriter`, so what it pins is the FALLBACK: a
  // replica with nobody to ask still refuses and still writes nothing. It is no
  // longer the whole behaviour of this event, and a green here says nothing about
  // whether a PC can actually get a code — that claim lives in the other file,
  // against two databases. Keeping this test unchanged is deliberate: the
  // fallback is the failure direction the forwarding rests on.
  it('pc:refresh-code — refused with no forwarder, and the code on screen is the one still valid', async () => {
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'inst-aaaaaaaaaaaaaaa' });
    const before = registry.findPc(pc.id)!.short_code;

    const sock = wire(fakeSocket('s5', { userId: 'default', deviceId: pc.id, kind: 'pc' }), replica());
    expectRefusal(await sock.invoke('pc:refresh-code', {}));

    // The stored code is untouched — a replica that minted one would have put a
    // code on the user's screen that stops existing at the next pull.
    expect(registry.findPc(pc.id)!.short_code).toBe(before);
  });

  it('settings:update — refused, and the stored value does not move', async () => {
    db.settings.write('default', 'ui.theme', 'dark');

    const sock = wire(fakeSocket('s6', { userId: 'default', kind: 'pc', deviceId: 'x' }), replica());
    expectRefusal(await sock.invoke('settings:update', { key: 'ui.theme', value: 'light' }));

    expect(db.settings.read('default', 'ui.theme')?.value).toBe('dark');
  });

  // ── 🔴 THE NEGATIVE CONTROL, and the most important test in this file ──────
  it('a replica STILL SERVES READS — refusing everything is not the fix', async () => {
    const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'inst-aaaaaaaaaaaaaaa' });
    registry.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel', user_id: 'default' });

    const sock = wire(fakeSocket('s7', { userId: 'default', deviceId: pc.id, kind: 'pc' }), replica());
    const ack = await sock.invoke('pc:list-mobiles', {});

    // Serving reads near the user is the ENTIRE reason a replica exists. A guard
    // that took this out would still pass every other assertion above, and would
    // have turned a data-loss fix into a broken product.
    expect(ack.error).toBeUndefined();
    expect((ack.mobiles as unknown[])).toHaveLength(1);
  });

  it('the socket refusal and the HTTP 421 say the SAME word and the SAME sentence', () => {
    // One fact, one name. http/router.ts builds its 421 body from this very
    // function, so this asserts the shared constructor rather than two copies
    // that happen to agree today.
    const refusal = makeWriterOnlyGuard(WRITER)();
    expect(refusal).not.toBeNull();
    expect(refusal!.error).toBe('NODE_IS_REPLICA');
    expect(refusal!.message).toBe(ERROR_CODES.NODE_IS_REPLICA.en);
  });

  it('a writable node produces no refusal at all — null, not an empty object', () => {
    // `null` is the answer the call sites branch on. An empty object would be
    // truthy and would refuse every event on every single-node deployment there
    // is, which is all of them.
    expect(NODE_CAN_WRITE()).toBeNull();
  });
});
