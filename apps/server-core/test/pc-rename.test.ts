// GA-10 — the reserved settings key `device.pc_name` (04 §3.7 F-3101).
//
// owner 2026-07-26 iron rule: "PC naming can only be controlled by the PC side". That is the property this
// file exists for, and it is checked from the mobile's side too — a rule that is
// only asserted from the happy direction is not asserted at all.
//
// The other three properties:
//   · it writes `pc_devices.device_name`, NOT the KV store. Same row the web
//     console reads, which is how a desktop rename reaches the console with no
//     second write path (owner iron rule ②);
//   · it is refused, not truncated, when the value is malformed or over-length;
//   · the broadcast is scoped to THAT PC's room — an account with two PCs must
//     not have one rename relabel the other in every phone's list.
//
// SPEC-REF: docs/rebuild/04-PROTOCOL-SPEC.md §3.7;
//           docs/strategy/2026-07-25-full-gap-audit/05-WAVE-F-OWNER-ROUND.md GA-10

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { registerSettingsHandlers, parsePcName, PC_NAME_KEY, PC_NAME_MAX } from '../src/socket/handlers/settings.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, (p: unknown, ack: unknown) => void>();
  constructor(
    readonly id: string,
    readonly data: { auth?: AuthContext; roomUuid?: string } = {},
  ) {}
  on(event: string, fn: (p: unknown, ack: unknown) => void): this {
    this.handlers.set(event, fn);
    return this;
  }
  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }
  async invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.handlers.get(event)!(payload, (a: unknown) => resolve(a as Record<string, unknown>));
    });
  }
}

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;

/** An `io` stand-in whose peer fan-out we can observe (broadcastUpdated walks
 *  io.sockets.sockets). Empty = no peers, which is the normal single-PC case. */
const io = { sockets: { sockets: new Map<string, unknown>() } } as unknown as Server;

function wire(socket: FakeSocket): FakeSocket {
  registerSettingsHandlers(socket as unknown as Socket, { io, repo: db.settings, registry, store });
  return socket;
}

function pcWithPhone(userId: string, deviceName: string, instance: string) {
  const { pc } = registry.registerPc({ device_name: deviceName, user_id: userId, client_instance_id: instance });
  const paired = registry.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel', user_id: userId });
  const phone = new FakeSocket('sock-phone');
  store.joinMobile(pc.room_uuid, paired.mobile.id, phone as unknown as Socket);
  const row = registry.findPc(pc.id)!;
  const pcSock = wire(new FakeSocket(`sock-${deviceName}`, {
    auth: { userId, deviceId: row.id, kind: 'pc' },
    roomUuid: row.room_uuid,
  }));
  return { pc: row, phone, pcSock, pairingId: paired.mobile.id };
}

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  db.users.insert({ id: 'other', display_name: 'O', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore<Socket>();
});
afterEach(() => db.close());

describe('GA-10 — device.pc_name writes pc_devices, not the KV store', () => {
  it('renames the row and tells that PC\'s phones', async () => {
    const { pc, phone, pcSock } = pcWithPhone('default', 'FlowMic-OLD-0000', 'inst-a');

    const ack = await pcSock.invoke('settings:update', {
      key: PC_NAME_KEY,
      value: { pc_name: '  书房台式机  ' },
    });
    expect(ack).toEqual({ ok: true });

    // The DEVICE row moved (this is also the row /api/cloud/devices projects,
    // which is what makes the rename reach the web console — owner iron rule ②)…
    expect(registry.findPc(pc.id)!.device_name).toBe('书房台式机');
    // …and the KV store was NOT touched. A name sitting in user_settings would
    // be read by nothing and would drift from the row that matters.
    expect(db.settings.readAll('default').find((i) => i.key === PC_NAME_KEY)).toBeUndefined();

    // The phone in THIS room hears it, with the pc_id it needs to attribute the
    // change (a phone may be paired to several PCs).
    const pushes = phone.emitted.filter((e) => e.event === 'settings:updated');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.payload).toEqual({ key: PC_NAME_KEY, value: { pc_id: pc.id, pc_name: '书房台式机' } });
  });

  it('a MOBILE may not rename a PC — the iron rule, checked from its own side', async () => {
    const { pc, pairingId } = pcWithPhone('default', 'FlowMic-OLD-0000', 'inst-a');
    const asMobile = wire(new FakeSocket('sock-m', {
      auth: { userId: 'default', deviceId: pc.id, pairingId, kind: 'mobile' },
      roomUuid: pc.room_uuid,
    }));

    const ack = await asMobile.invoke('settings:update', {
      key: PC_NAME_KEY,
      value: { pc_name: '我给它改个名' },
    });
    expect(ack).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    // Refused means UNCHANGED — not accepted-and-dropped.
    expect(registry.findPc(pc.id)!.device_name).toBe('FlowMic-OLD-0000');
  });

  it('another account\'s PC id changes nothing and is indistinguishable from a bad id', async () => {
    const mine = pcWithPhone('default', 'MINE', 'inst-a');
    const theirs = pcWithPhone('other', 'THEIRS', 'inst-b');
    // Point my socket at their device id.
    const attacker = wire(new FakeSocket('sock-x', {
      auth: { userId: 'default', deviceId: theirs.pc.id, kind: 'pc' },
      roomUuid: theirs.pc.room_uuid,
    }));
    const hit = await attacker.invoke('settings:update', { key: PC_NAME_KEY, value: { pc_name: 'pwned' } });
    const miss = await wire(new FakeSocket('sock-y', {
      auth: { userId: 'default', deviceId: 'no-such-device', kind: 'pc' },
    })).invoke('settings:update', { key: PC_NAME_KEY, value: { pc_name: 'pwned' } });

    // Same shape for both: the wire is not an existence oracle.
    expect(hit).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    expect(miss).toEqual(hit);
    expect(registry.findPc(theirs.pc.id)!.device_name).toBe('THEIRS');
    expect(registry.findPc(mine.pc.id)!.device_name).toBe('MINE');
  });

  it('one PC\'s rename does not reach the OTHER PC\'s phones', async () => {
    // Both PCs belong to one account, so an account-wide fan-out would relabel
    // the wrong machine in the second phone's list.
    const a = pcWithPhone('default', 'PC-A', 'inst-a');
    const b = pcWithPhone('default', 'PC-B', 'inst-b');
    await a.pcSock.invoke('settings:update', { key: PC_NAME_KEY, value: { pc_name: 'A-renamed' } });

    expect(a.phone.emitted.filter((e) => e.event === 'settings:updated')).toHaveLength(1);
    expect(b.phone.emitted.filter((e) => e.event === 'settings:updated')).toHaveLength(0);
    expect(registry.findPc(b.pc.id)!.device_name).toBe('PC-B');
  });

  it('refuses a malformed or over-long name instead of storing something else', async () => {
    const { pc, pcSock } = pcWithPhone('default', 'KEEP-ME', 'inst-a');
    for (const value of [
      {},
      { pc_name: '' },
      { pc_name: '   ' },
      { pc_name: 42 },
      { pc_name: 'x'.repeat(PC_NAME_MAX + 1) },
      'a bare string',
      null,
    ]) {
      const ack = await pcSock.invoke('settings:update', { key: PC_NAME_KEY, value });
      expect(ack, JSON.stringify(value)).toEqual({ error: 'SETTINGS_SCHEMA_INVALID' });
    }
    // Not truncated to 80 either — silently storing a different name than the
    // one typed is the quiet kind of lie.
    expect(registry.findPc(pc.id)!.device_name).toBe('KEEP-ME');
    expect((await pcSock.invoke('settings:update', {
      key: PC_NAME_KEY,
      value: { pc_name: 'x'.repeat(PC_NAME_MAX) },
    }))).toEqual({ ok: true });
  });

  it('ordinary keys are untouched by the reserved-key branch', async () => {
    const { pcSock } = pcWithPhone('default', 'PC-A', 'inst-a');
    const ack = await pcSock.invoke('settings:update', { key: 'ui.theme', value: 'dark' });
    expect(ack).toEqual({ ok: true });
    expect(db.settings.readAll('default').find((i) => i.key === 'ui.theme')?.value).toBe('dark');
  });
});

describe('parsePcName', () => {
  it('trims, and refuses rather than truncates', () => {
    expect(parsePcName({ pc_name: '  书房  ' })).toBe('书房');
    expect(parsePcName({ pc_name: 'x'.repeat(PC_NAME_MAX) })).toHaveLength(PC_NAME_MAX);
    expect(parsePcName({ pc_name: 'x'.repeat(PC_NAME_MAX + 1) })).toBeNull();
    expect(parsePcName({ pc_name: '' })).toBeNull();
    expect(parsePcName({ name: 'wrong field' })).toBeNull();
    expect(parsePcName('string')).toBeNull();
    expect(parsePcName(null)).toBeNull();
  });
});
