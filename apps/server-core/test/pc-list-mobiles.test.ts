// R6 T-8 — `pc:list-mobiles` (HUMAN-AUDIT: pairing/auth adjacency).
//
// The desktop device page could only ever say "N online" because no wire face
// existed for「this PC's paired phones」. This is that face, and the two things
// that can go wrong with it are both security-shaped, so they are pinned here
// against the REAL handler over a REAL sqlite db + REAL Registry + REAL RoomStore
// (fakes only at the socket seam):
//
//   ① PROJECTION — `mobile_token` is a bearer secret (05 §7). The ack is scanned
//      RECURSIVELY for it: no token, no key named *token*, and the literal secret
//      value must not appear anywhere in the serialized ack.
//   ② OWNERSHIP — the payload is `{}` (nothing addressable), rows are read by the
//      socket's OWN pc_device_id, and the row's user must match the socket's. A
//      phone paired to another PC (same user OR another user) is unreachable.
//
// ③ `online` is REAL RoomStore presence, not a persisted flag: a pairing that
//    exists in the db but has no live socket reads false, and flips true/false as
//    the socket joins/leaves.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.1 (pc:list-mobiles);
//           docs/rebuild/05-DATA-MODEL.md §1/§7; R6-BACKLOG-AND-PLAN.md T-8

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

interface FakeSocket {
  id: string;
  data: { auth: AuthContext | null; roomUuid?: string };
  on(event: string, fn: (payload: unknown, ack: unknown) => void): void;
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>>;
}

function fakeSocket(id: string, auth: AuthContext | null): FakeSocket {
  const handlers = new Map<string, (payload: unknown, ack: unknown) => void>();
  return {
    id,
    data: { auth },
    on(event, fn) { handlers.set(event, fn); },
    invoke(event, payload) {
      return new Promise((resolve) => {
        const h = handlers.get(event);
        if (!h) return resolve({ __no_handler: true });
        h(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
      });
    },
  };
}

/** Recursively hunt for a key (or value) anywhere in an ack — a spread that
 *  smuggles the secret one level down must fail this, not just a shallow check. */
function deepFindKey(value: unknown, pred: (k: string) => boolean): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (pred(k)) hits.push(`${path}.${k}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(value, '$');
  return hits;
}

let db: Db;
let registry: Registry;
let store: RoomStore;

function wire(socket: FakeSocket): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store: store as RoomStore<Socket>,
    resolveActingUser: () => ({ userId: socket.data.auth?.userId ?? 'default' }),
  });
  return socket;
}

/** Register a PC row for `userId` and pair `count` phones to it. */
function pcWithMobiles(userId: string, deviceName: string, names: string[]) {
  const { pc } = registry.registerPc({ device_name: deviceName, user_id: userId, client_instance_id: `inst-${deviceName}` });
  const paired = names.map((mobile_name) =>
    registry.pairMobile({ short_code: pc.short_code, mobile_name, user_id: userId }),
  );
  return { pc: registry.findPc(pc.id)!, paired };
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  db.users.insert({ id: 'other', display_name: 'O', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore();
});
afterEach(() => db.close());

describe('pc:list-mobiles — the paired-phone table', () => {
  it('lists THIS PC\'s pairings with the public six fields', async () => {
    const { pc, paired } = pcWithMobiles('default', 'PC-A', ['Pixel 9', 'iPhone 16']);
    const sock = wire(fakeSocket('s-pc', { userId: 'default', deviceId: pc.id, kind: 'pc' }));

    const ack = await sock.invoke('pc:list-mobiles', {});
    const mobiles = ack.mobiles as Record<string, unknown>[];
    expect(mobiles).toHaveLength(2);
    expect(mobiles.map((m) => m.mobile_name)).toEqual(['Pixel 9', 'iPhone 16']);
    expect(mobiles.map((m) => m.pairing_id)).toEqual(paired.map((p) => p.mobile.id));
    for (const m of mobiles) {
      // An EXACT key set, not a subset: this is the zero-secret projection, and
      // a field that appears without anyone deciding to add it is exactly how a
      // token would eventually ride along. v0.2.4 adds `device_uid` — the sixth
      // is a decision, recorded here.
      expect(Object.keys(m).sort()).toEqual([
        'device_uid', 'last_seen_at', 'mobile_name', 'online', 'paired_at', 'pairing_id',
      ]);
      expect(typeof m.paired_at).toBe('string');
      expect(m.last_seen_at).toBeNull(); // never connected yet — honest null
      // These pairings were made by the registry directly with no uid, so the
      // honest answer is null — never a fabricated id that would make two
      // unrelated phones look like one machine on the desktop's table.
      expect(m.device_uid).toBeNull();
    }
  });

  it('① never leaks mobile_token — not as a key, not as a value, at any depth', async () => {
    const { pc, paired } = pcWithMobiles('default', 'PC-A', ['Pixel 9']);
    const secret = paired[0]!.token;
    expect(secret.length).toBeGreaterThan(16); // the real bearer secret
    // Sanity: the raw record the handler reads DOES carry it.
    expect(registry.listMobilesForPc(pc.id)[0]!.mobile_token).toBe(secret);

    const sock = wire(fakeSocket('s-pc', { userId: 'default', deviceId: pc.id, kind: 'pc' }));
    const ack = await sock.invoke('pc:list-mobiles', {});

    expect(deepFindKey(ack, (k) => /token|secret|password/i.test(k))).toEqual([]);
    expect(JSON.stringify(ack)).not.toContain(secret);
  });

  it('③ online is REAL room presence, flipping with the live socket', async () => {
    const { pc, paired } = pcWithMobiles('default', 'PC-A', ['Pixel 9']);
    const pairingId = paired[0]!.mobile.id;
    const sock = wire(fakeSocket('s-pc', { userId: 'default', deviceId: pc.id, kind: 'pc' }));
    const firstOnline = async (): Promise<boolean> =>
      ((await sock.invoke('pc:list-mobiles', {})).mobiles as { online: boolean }[])[0]!.online;

    // Row exists in the db, no live socket → false (never a stored flag).
    expect(await firstOnline()).toBe(false);

    // The slot holds a real socket, so `connected` is socket.io's own liveness
    // flag — the fake has to model it or it is not modelling a socket.
    const phone = { id: 'sock-mobile', connected: true };
    store.joinMobile(pc.room_uuid, pairingId, phone);
    expect(await firstOnline()).toBe(true);

    // GA-04 ↔ GA-07 crossing (lead ruling): during the mobile-drop grace the SLOT
    // survives (the audio session is keyed to it) while the socket is already
    // dead. The roster answers 「is the socket up」, so it must read offline the
    // instant the transport dies — the grace defers the ANNOUNCEMENT, it does
    // not claim the phone is still there.
    phone.connected = false;
    expect(await firstOnline()).toBe(false);

    phone.connected = true;
    store.leaveMobile(pc.room_uuid, pairingId, 'sock-mobile');
    expect(await firstOnline()).toBe(false);
  });

  it('② cross-PC: a phone paired to ANOTHER PC of the same user is invisible', async () => {
    const a = pcWithMobiles('default', 'PC-A', ['Phone-A']);
    const b = pcWithMobiles('default', 'PC-B', ['Phone-B']);
    const sockA = wire(fakeSocket('s-a', { userId: 'default', deviceId: a.pc.id, kind: 'pc' }));

    const names = ((await sockA.invoke('pc:list-mobiles', {})).mobiles as { mobile_name: string }[]).map((m) => m.mobile_name);
    expect(names).toEqual(['Phone-A']);
    expect(names).not.toContain('Phone-B');
    // …and B's phone really does exist — the query is scoped, not empty.
    expect(registry.listMobilesForPc(b.pc.id)).toHaveLength(1);
  });

  it('② cross-user: naming another user\'s device id is refused, not answered', async () => {
    const mine = pcWithMobiles('default', 'PC-A', ['Phone-A']);
    const theirs = pcWithMobiles('other', 'PC-X', ['Phone-X']);

    // A socket authenticated as 'default' whose deviceId points at 'other's row.
    const impostor = wire(fakeSocket('s-imp', { userId: 'default', deviceId: theirs.pc.id, kind: 'pc' }));
    expect(await impostor.invoke('pc:list-mobiles', {})).toEqual({ error: 'AUTH_TOKEN_INVALID' });

    // The payload carries no id at all, so a hand-crafted one is simply dropped:
    // the honest scope (this socket's own PC) is what answers.
    const sock = wire(fakeSocket('s-a', { userId: 'default', deviceId: mine.pc.id, kind: 'pc' }));
    const ack = await sock.invoke('pc:list-mobiles', { pc_device_id: theirs.pc.id, user_id: 'other' });
    expect((ack.mobiles as { mobile_name: string }[]).map((m) => m.mobile_name)).toEqual(['Phone-A']);
  });

  it('② refuses an unauthenticated socket and a MOBILE-kind socket', async () => {
    const { pc } = pcWithMobiles('default', 'PC-A', ['Phone-A']);
    const anon = wire(fakeSocket('s-anon', null));
    expect(await anon.invoke('pc:list-mobiles', {})).toEqual({ error: 'AUTH_TOKEN_INVALID' });

    const asMobile = wire(fakeSocket('s-m', { userId: 'default', deviceId: pc.id, pairingId: 'p1', kind: 'mobile' }));
    expect(await asMobile.invoke('pc:list-mobiles', {})).toEqual({ error: 'AUTH_TOKEN_INVALID' });
  });

  it('rejects a malformed payload with the pairing-domain code', async () => {
    const { pc } = pcWithMobiles('default', 'PC-A', ['Phone-A']);
    const sock = wire(fakeSocket('s-a', { userId: 'default', deviceId: pc.id, kind: 'pc' }));
    expect(await sock.invoke('pc:list-mobiles', null)).toEqual({ error: 'PAIR_INVALID_PAYLOAD' });
  });

  it('answers an unpaired PC with an empty list, not an error', async () => {
    const { pc } = registry.registerPc({ device_name: 'Lonely', user_id: 'default', client_instance_id: 'inst-lonely' });
    const sock = wire(fakeSocket('s-lonely', { userId: 'default', deviceId: pc.id, kind: 'pc' }));
    expect(await sock.invoke('pc:list-mobiles', {})).toEqual({ mobiles: [] });
  });
});
