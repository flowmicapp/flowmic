// GA-08 — `pc:release-mobile` disconnect/revoke (HUMAN-AUDIT: pairing/auth).
//
// The pre-GA-08 handler disconnected the phone's socket and stopped there: the
// mobile_pairings row and its token survived, so the reconnect ladder was back
// in the room seconds later. The desktop had no button for it at all. This file
// pins the semantics the card ruled, against the REAL handlers over a REAL
// sqlite db + REAL Registry + REAL RoomStore (fakes only at the socket seam):
//
//   ① disconnect = end THIS session + a 60 s reconnect-suppression window. Inside the
//      window the same (still valid) token is refused with PAIR_RELEASED; when
//      the window lapses the phone returns on its own. NO REAL SLEEP — the clock
//      is injected into both the Registry and the ReleaseSuppression.
//   ② revoke = permanent: the row is DELETED (05 §7 deleting the row IS revocation), so the token now
//      resolves to nothing and the phone gets AUTH_TOKEN_INVALID — the code its
//      existing fail-loud path already acts on (zero mobile change).
//   ③ IDEMPOTENT: revoking an already-revoked id acks ok.
//   ④ OWNERSHIP (the security core): only the PC that owns a pairing may
//      disconnect or revoke it. Cross-PC and cross-user attempts change nothing
//      and are INDISTINGUISHABLE from an id that never existed — same ack, so the
//      wire is not an existence oracle.
//
// GA-18 rides along: the register / refresh-code acks carry `expires_in_ms` read
// from the short-code governor (the same clock that decides code validity).
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.1; docs/rebuild/05-DATA-MODEL.md §7;
//           docs/strategy/2026-07-25-full-gap-audit/02-DESKTOP.md GA-08 / GA-18

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { ReleaseSuppression, RELEASE_SUPPRESS_MS, BUSY_SUPPRESS_MS } from '../src/room/release-suppression';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

const PC_A_INSTANCE = 'desktop-instance-aaaa';
const PC_B_INSTANCE = 'desktop-instance-bbbb';
const PC_X_INSTANCE = 'desktop-instance-xxxx';

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  connected = true;
  disconnected = 0;
  readonly handshake = { address: '10.0.0.9' };
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();

  constructor(
    readonly id: string,
    public data: { auth: AuthContext | null; roomUuid?: string } = { auth: null },
  ) {}

  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  off(): this { return this; }
  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  disconnect(_close?: boolean): this {
    this.disconnected += 1;
    this.connected = false;
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
let suppression: ReleaseSuppression;
/** The ONE clock every time-dependent collaborator reads. Tests advance it. */
let clock = 1_700_000_000_000;

function wirePc(socket: FakeSocket): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    resolveActingUser: () => ({ userId: socket.data.auth?.userId ?? 'default' }),
    suppression,
  });
  return socket;
}

function wireMobile(socket: FakeSocket): FakeSocket {
  registerMobileHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    pairLimiter: new PairRateLimiter({}),
    mode: 'standalone',
    resolveActingUser: () => ({ userId: 'default' }),
    suppression,
    // A2-3 (F1) — the admission gate's reader, pointed at the REAL repo. Nobody
    // is restricted in this file, so the GA-08 semantics below are measured
    // unchanged. Not optional in the deps on purpose (mobile.handler.ts).
    restriction: { getUser: (id) => db.users.findById(id) },
  });
  return socket;
}

/** A registered PC plus `names.length` paired phones, each with a live socket in
 *  the room (so a release has something real to disconnect). */
function pcWithPhones(userId: string, deviceName: string, instance: string, names: string[]) {
  const { pc } = registry.registerPc({ device_name: deviceName, user_id: userId, client_instance_id: instance });
  const phones = names.map((mobile_name, i) => {
    const paired = registry.pairMobile({ short_code: pc.short_code, mobile_name, user_id: userId });
    const sock = new FakeSocket(`sock-${deviceName}-${i}`);
    store.joinMobile(pc.room_uuid, paired.mobile.id, sock as unknown as Socket);
    return { ...paired, sock };
  });
  const row = registry.findPc(pc.id)!;
  const pcSock = wirePc(new FakeSocket(`sock-${deviceName}-pc`, {
    auth: { userId, deviceId: row.id, kind: 'pc' },
    roomUuid: row.room_uuid,
  }));
  return { pc: row, phones, pcSock };
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  db.users.insert({ id: 'other', display_name: 'O', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles, now: () => clock });
  store = new RoomStore<Socket>();
  suppression = new ReleaseSuppression(() => clock);
});
afterEach(() => db.close());

describe('GA-08 ① disconnect — session ends AND stays ended for the window', () => {
  it('disconnects the phone and refuses its reconnect with PAIR_RELEASED, then lets it back', async () => {
    const { phones, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel 9']);
    const phone = phones[0]!;

    const ack = await pcSock.invoke('pc:release-mobile', { mobile_id: phone.mobile.id });
    expect(ack).toMatchObject({ ok: true, released: 1, revoked: 0, suppressed_ms: RELEASE_SUPPRESS_MS });
    expect(phone.sock.disconnected).toBe(1);

    // The row is UNTOUCHED — disconnect is not revoke.
    expect(db.mobiles.findById(phone.mobile.id)).not.toBeNull();
    expect(db.mobiles.findByToken(phone.token)).not.toBeNull();

    // Inside the window: refused with the distinct code, and the room slot is
    // NOT handed to the returning socket. (The slot still holds the dead socket
    // until its own disconnect hook / GA-04 grace clears it — that hook lives in
    // bootstrap, not here; what matters is that the suppressed socket never took
    // the slot over.)
    const back = wireMobile(new FakeSocket('sock-phone-again'));
    clock += 5_000;
    const refused = await back.invoke('mobile:reconnect', { token: phone.token });
    expect(refused.error).toBe('PAIR_RELEASED');
    expect(refused.retry_after_ms).toBe(RELEASE_SUPPRESS_MS - 5_000);
    const slot = store.getMobile(pcSock.data.roomUuid!, phone.mobile.id);
    expect(slot).not.toBe(back as unknown as Socket);
    expect(slot?.connected).toBe(false);

    // …and refused BEFORE any presence side effect: no pc:mobile-joined fired.
    expect(pcSock.emitted.filter((e) => e.event === 'pc:mobile-joined')).toHaveLength(0);

    // The window lapses on its own — no second action by anyone.
    clock += RELEASE_SUPPRESS_MS;
    const accepted = await back.invoke('mobile:reconnect', { token: phone.token });
    expect(accepted.error).toBeUndefined();
    expect(accepted.pairing_id).toBe(phone.mobile.id);
    expect(store.getMobile(pcSock.data.roomUuid!, phone.mobile.id)).toBe(back as unknown as Socket);
  });

  it('the refusal code is NOT AUTH_TOKEN_INVALID (which would make the phone drop the pairing)', async () => {
    // mobile_reconnect_flow.dart deletes the stored pairing on AUTH_TOKEN_INVALID
    // and merely backs off on anything else. disconnect must therefore never answer with
    // it — that difference IS the disconnect/revoke split as the phone experiences it.
    const { phones, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel 9']);
    await pcSock.invoke('pc:release-mobile', { mobile_id: phones[0]!.mobile.id });
    const back = wireMobile(new FakeSocket('sock-again'));
    const refused = await back.invoke('mobile:reconnect', { token: phones[0]!.token });
    expect(refused.error).not.toBe('AUTH_TOKEN_INVALID');
    expect(refused.retryable).toBe(true);
  });

  it('a bare release (no mobile_id) ends every phone of THIS PC only', async () => {
    const a = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel', 'iPhone']);
    const b = pcWithPhones('default', 'PC-B', PC_B_INSTANCE, ['Tablet']);

    const ack = await a.pcSock.invoke('pc:release-mobile', {});
    expect(ack).toMatchObject({ ok: true, released: 2, revoked: 0 });
    for (const p of a.phones) {
      expect(p.sock.disconnected).toBe(1);
      expect(suppression.isSuppressed(p.mobile.id)).toBe(true);
    }
    // The other PC's phone is untouched in every respect.
    expect(b.phones[0]!.sock.disconnected).toBe(0);
    expect(suppression.isSuppressed(b.phones[0]!.mobile.id)).toBe(false);
  });
});

describe('GA-08 ② revoke — permanent, and ③ idempotent', () => {
  it('deletes the row so the same token is now AUTH_TOKEN_INVALID', async () => {
    const { pc, phones, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel 9']);
    const phone = phones[0]!;

    const ack = await pcSock.invoke('pc:release-mobile', { mobile_id: phone.mobile.id, revoke: true });
    expect(ack).toMatchObject({ ok: true, released: 1, revoked: 1, suppressed_ms: 0 });
    expect(phone.sock.disconnected).toBe(1);

    // The credential IS the row (05 §7) — both lookups are dead.
    expect(db.mobiles.findById(phone.mobile.id)).toBeNull();
    expect(db.mobiles.findByToken(phone.token)).toBeNull();
    expect(registry.listMobilesForPc(pc.id)).toHaveLength(0);

    const back = wireMobile(new FakeSocket('sock-revoked'));
    expect(await back.invoke('mobile:reconnect', { token: phone.token })).toEqual({ error: 'AUTH_TOKEN_INVALID' });
  });

  it('a revoked pairing leaves NO suppression residue behind', async () => {
    const { phones, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel 9']);
    // Disconnect first (arming a window), then revoke: the window must be dropped
    // with the row rather than lingering for a pairing that no longer exists.
    await pcSock.invoke('pc:release-mobile', { mobile_id: phones[0]!.mobile.id });
    expect(suppression.size).toBe(1);
    await pcSock.invoke('pc:release-mobile', { mobile_id: phones[0]!.mobile.id, revoke: true });
    expect(suppression.size).toBe(0);
  });

  it('③ repeating the revoke acks ok (idempotent), counting 0 the second time', async () => {
    const { phones, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel 9']);
    const id = phones[0]!.mobile.id;
    expect(await pcSock.invoke('pc:release-mobile', { mobile_id: id, revoke: true }))
      .toMatchObject({ ok: true, revoked: 1 });
    // Honest counters, successful ack: a replayed/duplicated revoke is not an error.
    expect(await pcSock.invoke('pc:release-mobile', { mobile_id: id, revoke: true }))
      .toMatchObject({ ok: true, released: 0, revoked: 0 });
  });

  it('a revoke without a mobile_id is refused — never widened into revoke-all', async () => {
    const { pc, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel', 'iPhone']);
    const ack = await pcSock.invoke('pc:release-mobile', { revoke: true });
    expect(ack.error).toBe('PAIR_INVALID_PAYLOAD');
    expect(registry.listMobilesForPc(pc.id)).toHaveLength(2); // nothing deleted
  });

  it('rejects a non-boolean revoke at the schema boundary', async () => {
    const { pc, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel']);
    const id = registry.listMobilesForPc(pc.id)[0]!.id;
    // A truthy string must not be coerced into a permanent revocation.
    expect(await pcSock.invoke('pc:release-mobile', { mobile_id: id, revoke: 'true' }))
      .toEqual({ error: 'PAIR_INVALID_PAYLOAD' });
    expect(registry.listMobilesForPc(pc.id)).toHaveLength(1);
  });
});

describe('GA-08 ④ ownership — and no existence oracle', () => {
  /** The one ack shape every refused / unknown target gets. */
  const NOTHING = { ok: true, released: 0, revoked: 0, suppressed_ms: 0 };

  it('cross-PC (same user): another PC\'s phone can be neither disconnected nor revoked', async () => {
    const a = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Phone-A']);
    const b = pcWithPhones('default', 'PC-B', PC_B_INSTANCE, ['Phone-B']);
    const victim = b.phones[0]!;

    expect(await a.pcSock.invoke('pc:release-mobile', { mobile_id: victim.mobile.id })).toEqual(NOTHING);
    expect(await a.pcSock.invoke('pc:release-mobile', { mobile_id: victim.mobile.id, revoke: true })).toEqual(NOTHING);

    expect(db.mobiles.findById(victim.mobile.id)).not.toBeNull();
    expect(victim.sock.disconnected).toBe(0);
    expect(suppression.isSuppressed(victim.mobile.id)).toBe(false);
  });

  it('cross-user: another account\'s phone is equally unreachable', async () => {
    const mine = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Phone-A']);
    const theirs = pcWithPhones('other', 'PC-X', PC_X_INSTANCE, ['Phone-X']);
    const victim = theirs.phones[0]!;

    expect(await mine.pcSock.invoke('pc:release-mobile', { mobile_id: victim.mobile.id, revoke: true })).toEqual(NOTHING);
    expect(db.mobiles.findById(victim.mobile.id)).not.toBeNull();
    expect(victim.sock.disconnected).toBe(0);
  });

  it('a foreign id and a never-existed id are INDISTINGUISHABLE', async () => {
    const a = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Phone-A']);
    const b = pcWithPhones('default', 'PC-B', PC_B_INSTANCE, ['Phone-B']);

    const foreign = await a.pcSock.invoke('pc:release-mobile', { mobile_id: b.phones[0]!.mobile.id, revoke: true });
    const ghost = await a.pcSock.invoke('pc:release-mobile', { mobile_id: 'no-such-pairing-id', revoke: true });
    const revoked = await a.pcSock.invoke('pc:release-mobile', { mobile_id: a.phones[0]!.mobile.id, revoke: true });
    const again = await a.pcSock.invoke('pc:release-mobile', { mobile_id: a.phones[0]!.mobile.id, revoke: true });

    // Byte-identical: "not yours", "never existed" and "already gone" all read the
    // same, so the ack cannot be used to enumerate pairing ids.
    expect(foreign).toEqual(ghost);
    expect(again).toEqual(ghost);
    // …while the genuinely owned one really did act (the query is scoped, not inert).
    expect(revoked).toMatchObject({ revoked: 1 });
  });

  it('a PC whose device row belongs to another user is refused outright', async () => {
    const theirs = pcWithPhones('other', 'PC-X', PC_X_INSTANCE, ['Phone-X']);
    // Socket says userId 'default' but points at 'other's device row.
    const impostor = wirePc(new FakeSocket('sock-imp', {
      auth: { userId: 'default', deviceId: theirs.pc.id, kind: 'pc' },
      roomUuid: theirs.pc.room_uuid,
    }));
    expect(await impostor.invoke('pc:release-mobile', { mobile_id: theirs.phones[0]!.mobile.id, revoke: true }))
      .toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(db.mobiles.findById(theirs.phones[0]!.mobile.id)).not.toBeNull();
  });

  it('refuses an unauthenticated socket and a MOBILE-kind socket', async () => {
    const a = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Phone-A']);
    const anon = wirePc(new FakeSocket('sock-anon'));
    expect(await anon.invoke('pc:release-mobile', {})).toEqual({ error: 'AUTH_TOKEN_INVALID' });

    const asMobile = wirePc(new FakeSocket('sock-m', {
      auth: { userId: 'default', deviceId: a.pc.id, pairingId: a.phones[0]!.mobile.id, kind: 'mobile' },
      roomUuid: a.pc.room_uuid,
    }));
    expect(await asMobile.invoke('pc:release-mobile', { mobile_id: a.phones[0]!.mobile.id, revoke: true }))
      .toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(db.mobiles.findById(a.phones[0]!.mobile.id)).not.toBeNull();
  });
});

describe('GA-29 ⑤ busy — a refused SECOND phone is not a disconnect', () => {
  it('holds it out for seconds with PC_BUSY, not a minute with PAIR_RELEASED', async () => {
    const { phones, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel 9']);
    const phone = phones[0]!;

    // The desktop refuses a second phone by sending the SAME wire name with
    // reason:'busy'. It is still a release (the phone is disconnected), but the
    // reported window is the short one.
    const ack = await pcSock.invoke('pc:release-mobile', { mobile_id: phone.mobile.id, reason: 'busy' });
    expect(ack).toMatchObject({ ok: true, released: 1, revoked: 0, suppressed_ms: BUSY_SUPPRESS_MS });
    expect(BUSY_SUPPRESS_MS).toBeLessThan(RELEASE_SUPPRESS_MS);
    // disconnect is revoke's sibling, not busy's: the pairing row is untouched either way.
    expect(db.mobiles.findById(phone.mobile.id)).not.toBeNull();

    // Inside the (short) window the phone is told WHY, and it is a different
    // why: nobody pressed disconnect, the machine is simply taken.
    const back = wireMobile(new FakeSocket('sock-phone-again'));
    clock += 1_000;
    const refused = await back.invoke('mobile:reconnect', { token: phone.token });
    expect(refused.error).toBe('PC_BUSY');
    expect(refused.retryable).toBe(true);
    expect(refused.retry_after_ms).toBe(BUSY_SUPPRESS_MS - 1_000);

    // …and it is back in seconds — the whole point. A phone that waited out a
    // 60 s disconnect window here would still be locked out long after the capsule freed.
    clock += BUSY_SUPPRESS_MS;
    const accepted = await back.invoke('mobile:reconnect', { token: phone.token });
    expect(accepted.error).toBeUndefined();
    expect(accepted.pairing_id).toBe(phone.mobile.id);
  });

  it('an absent reason is still a manual disconnect (old desktops keep their semantics)', async () => {
    const { phones, pcSock } = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Pixel 9']);
    const phone = phones[0]!;
    // No `reason` on the wire — exactly what every pre-GA-29 build sends.
    const ack = await pcSock.invoke('pc:release-mobile', { mobile_id: phone.mobile.id });
    expect(ack).toMatchObject({ suppressed_ms: RELEASE_SUPPRESS_MS });

    const back = wireMobile(new FakeSocket('sock-phone-again'));
    const refused = await back.invoke('mobile:reconnect', { token: phone.token });
    expect(refused.error).toBe('PAIR_RELEASED');
  });

  it('a busy refusal still cannot cross an ownership boundary', async () => {
    // The reason field must not become a back door: it rides the SAME
    // ownership check as every other release.
    const a = pcWithPhones('default', 'PC-A', PC_A_INSTANCE, ['Phone-A']);
    const b = pcWithPhones('default', 'PC-B', PC_B_INSTANCE, ['Phone-B']);
    const ack = await a.pcSock.invoke('pc:release-mobile', {
      mobile_id: b.phones[0]!.mobile.id,
      reason: 'busy',
    });
    expect(ack).toMatchObject({ ok: true, released: 0, revoked: 0 });
    expect(suppression.isSuppressed(b.phones[0]!.mobile.id)).toBe(false);
    expect(b.phones[0]!.sock.disconnected).toBe(0);
  });
});

describe('GA-18 — expires_in_ms comes from the short-code governor', () => {
  it('the register ack carries a full TTL and the refresh ack re-arms it', async () => {
    const sock = wirePc(new FakeSocket('sock-fresh'));
    const reg = await sock.invoke('pc:register', { device_name: 'PC-A', client_instance_id: PC_A_INSTANCE });
    expect(typeof reg.short_code).toBe('string');
    expect(reg.expires_in_ms).toBe(5 * 60_000);

    // The countdown is the governor's, not a UI constant: it decays with the clock…
    clock += 60_000;
    const refreshed = await sock.invoke('pc:refresh-code', {});
    // …and a refresh mints a NEW code, so the ack reports the new full life.
    expect(refreshed.short_code).not.toBe(reg.short_code);
    expect(refreshed.expires_in_ms).toBe(5 * 60_000);
  });

  it('reports 0 once the code has aged out (never a resurrected TTL)', async () => {
    const sock = wirePc(new FakeSocket('sock-stale'));
    const reg = await sock.invoke('pc:register', { device_name: 'PC-A', client_instance_id: PC_A_INSTANCE });
    const pcId = reg.pc_id as string;
    clock += 4 * 60_000;
    expect(registry.shortCodeExpiresInMs(pcId)).toBe(60_000);
    clock += 60_001;
    expect(registry.shortCodeExpiresInMs(pcId)).toBe(0);
    expect(registry.isCodeActive(pcId)).toBe(false);
  });
});
