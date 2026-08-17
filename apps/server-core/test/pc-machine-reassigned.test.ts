// card C9 (2026-08-17) — a phone stranded on another account's PC row.
//
// SPEC-REF:
//   apps/server-core/src/room/machine-reassigned.ts (the question, and why it is
//     asked at read time rather than repaired by a second reap)
//   apps/server-core/src/http/presence-routes.ts (`pc_absent_reason` on the wire)
//   apps/server-core/src/room/cross-account-reap.ts (ACC-1 — the write side that
//     could never fire here, because it hangs off `pc:register` alone)
//   docs/strategy/2026-08-12-sensitive-surface-audit-queue.md row 25
//
// 🔴 WHAT THIS FILE PINS IS THE DISTINCTION, NOT THE FEATURE. A test that only
// proved 「a stranded pairing gets the named reason」 would pass just as happily
// against an implementation that named it for EVERY absence — and that
// implementation is strictly worse than today's, because it would tell every
// person whose computer is simply switched off to go and re-pair. So each case
// below has its negative twin, and the twin is the one that would catch a
// discriminator that stopped discriminating.
//
// THE INCIDENT (production, 2026-08-17): `pc_devices` held NINE rows for one
// `machine_uid`, one per account that ever registered the machine. The phone's
// pairing resolved to the row abandoned when the desktop signed into a different
// account. Presence answered `pc_online:false`, correctly. Both ends were
// telling the truth about different rooms, and the true answer sent the owner to
// check a machine that was powered on and fine.

import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { PC_PRESENCE_PATH, tryHandlePresenceRoutes } from '../src/http/presence-routes';
import { MACHINE_REASSIGNED_REASON } from '../src/room/machine-reassigned';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { pcAbsenceReasons } from '../src/room/pc-absence';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

const MACHINE = 'machine-uid-shared-by-two-accounts';

function request(token: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = 'GET';
  req.url = PC_PRESENCE_PATH;
  (req as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` };
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

/** A real Registry over a real in-memory DB + the real RoomStore. Fakes would
 *  let 「is it in the room」 have two answers, and the whole point of this route
 *  is that it has one. */
function world() {
  const db = createDbConnection({
    dbPath: ':memory:',
    encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx'),
  });
  db.users.insert({ id: 'u1', display_name: 'Account One', plan: 'free' });
  db.users.insert({ id: 'u2', display_name: 'Account Two', plan: 'free' });
  const registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  const store = new RoomStore<{ id: string }>();
  pcAbsenceReasons.drainForTests();

  /** Register ONE physical machine under `userId` and pair a phone to it.
   *
   *  🔴 Straight through `registry.registerPc`, deliberately NOT through
   *  `pc.handler.ts` — the handler is where `reapCrossAccountSiblings` lives, and
   *  the incident is precisely that the reap never ran. A world that reaped
   *  would be testing the fix that could not reach this. */
  const register = (userId: string, instance: string) => {
    const reg = registry.registerPc({
      device_name: 'Studio PC',
      user_id: userId,
      client_instance_id: instance,
      machine_uid: MACHINE,
    });
    const pair = registry.pairMobile({
      short_code: reg.pc.short_code,
      mobile_name: 'phone',
      user_id: userId,
    });
    return { pc: pair.pc, token: pair.token };
  };
  return { db, registry, store, register };
}

function askPresence(
  w: ReturnType<typeof world>,
  token: string,
): { status: number; body: Record<string, unknown> } {
  const { res, read } = response();
  tryHandlePresenceRoutes(request(token), res, {
    registry: w.registry,
    store: w.store as unknown as RoomStore,
    pcs: w.db.pcs,
  });
  return read();
}

describe('a pairing whose machine now serves a different account', () => {
  it('🔴 names the reason — the machine is here, just not in this account\'s room', () => {
    const w = world();
    const abandoned = w.register('u1', 'inst-account-one-000');
    const current = w.register('u2', 'inst-account-two-000');
    // Two rows, one machine. This is the production state, reproduced.
    expect(abandoned.pc.id).not.toBe(current.pc.id);
    expect(w.db.pcs.listByMachineUidOtherUsers(MACHINE, 'u1').map((p) => p.id)).toEqual([current.pc.id]);

    // The desktop is connected — under the NEW account, in the NEW room.
    w.store.joinPc(current.pc.room_uuid, { id: 'sock-desktop' });

    const answer = askPresence(w, abandoned.token);
    expect(answer.status).toBe(200);
    // The absence itself is unchanged and still true: that room IS empty.
    expect(answer.body).toMatchObject({ ok: true, pc_online: false });
    // …and now it is attributable, which is the whole card.
    expect(answer.body.pc_absent_reason).toBe(MACHINE_REASSIGNED_REASON);
  });

  it('🔴 THE DISTINCTION: a genuinely offline PC still gets plain offline', () => {
    const w = world();
    const abandoned = w.register('u1', 'inst-account-one-000');
    w.register('u2', 'inst-account-two-000');
    // Same nine-rows-one-machine shape as above — the ONLY difference is that
    // nobody is in any room: the machine is switched off.
    const answer = askPresence(w, abandoned.token);
    expect(answer.body).toMatchObject({ ok: true, pc_online: false });
    // 🔴 The key is OMITTED, not null and not a reason. An absent key is what
    // every phone — old and new — already renders as today's plain 「offline」,
    // and 「turn the computer on」 is the right instruction for a computer that
    // is off. Answering `machine_reassigned` here would send that user to
    // re-pair a machine that will come back to them the moment it boots.
    expect('pc_absent_reason' in answer.body).toBe(false);
  });

  it('a machine with rows under ONE account only is never called reassigned', () => {
    const w = world();
    const mine = w.register('u1', 'inst-account-one-000');
    // Same account registers the same machine twice (a re-install, a second
    // Windows profile): `listByMachineUidOtherUsers` excludes the row's own
    // owner, so a busy single-account machine cannot trip this.
    const second = w.register('u1', 'inst-account-one-002');
    w.store.joinPc(second.pc.room_uuid, { id: 'sock-desktop' });
    const answer = askPresence(w, mine.token);
    expect('pc_absent_reason' in answer.body).toBe(false);
  });

  it('the sibling must be IN a room, not merely on record', () => {
    const w = world();
    const abandoned = w.register('u1', 'inst-account-one-000');
    const current = w.register('u2', 'inst-account-two-000');
    // The other account's row exists and its desktop was there — then left.
    w.store.joinPc(current.pc.room_uuid, { id: 'sock-desktop' });
    expect(askPresence(w, abandoned.token).body.pc_absent_reason).toBe(MACHINE_REASSIGNED_REASON);
    w.store.leavePc(current.pc.room_uuid, 'sock-desktop');
    // 🔴 The reason must not outlive the fact it describes. Nothing is stored,
    // so there is nothing to expire: the next question is answered from the
    // rooms as they are at that moment.
    expect('pc_absent_reason' in askPresence(w, abandoned.token).body).toBe(false);
  });

  it('🔴 reassignment outranks a recorded auth_expired, because its action is the right one', () => {
    const w = world();
    const abandoned = w.register('u1', 'inst-account-one-000');
    const current = w.register('u2', 'inst-account-two-000');
    // Both facts are true at once, and this is the ordinary sequence: the old
    // account's sign-in lapsed, THEN the machine was signed into a new one.
    pcAbsenceReasons.noteByRoom(abandoned.pc.room_uuid, 'auth_expired');
    w.store.joinPc(current.pc.room_uuid, { id: 'sock-desktop' });

    expect(askPresence(w, abandoned.token).body.pc_absent_reason).toBe(MACHINE_REASSIGNED_REASON);
    // The negative twin: with no live sibling, the recorded reason is still the
    // answer. The precedence rule must not be 「the new reason always wins」.
    w.store.leavePc(current.pc.room_uuid, 'sock-desktop');
    expect(askPresence(w, abandoned.token).body.pc_absent_reason).toBe('auth_expired');
  });

  it('an online PC is never given a reason, whatever the siblings are doing', () => {
    const w = world();
    const mine = w.register('u1', 'inst-account-one-000');
    const other = w.register('u2', 'inst-account-two-000');
    w.store.joinPc(mine.pc.room_uuid, { id: 'sock-mine' });
    w.store.joinPc(other.pc.room_uuid, { id: 'sock-other' });
    const answer = askPresence(w, mine.token);
    // A reason answers 「why is it not here」. For a PC that IS here that
    // question has no answer to give, and the online response keeps exactly the
    // three keys it has always had.
    expect(answer.body).toMatchObject({ ok: true, pc_online: true });
    expect('pc_absent_reason' in answer.body).toBe(false);
  });

  it('discloses one bit and nothing about the other account', () => {
    const w = world();
    const abandoned = w.register('u1', 'inst-account-one-000');
    const current = w.register('u2', 'inst-account-two-000');
    w.store.joinPc(current.pc.room_uuid, { id: 'sock-desktop' });
    const body = JSON.stringify(askPresence(w, abandoned.token).body);
    // The sibling rows are consulted and discarded: no account id, no other
    // pc_id, no room, no device token. What crosses is one named reason.
    expect(body).not.toContain('u2');
    expect(body).not.toContain(current.pc.id);
    expect(body).not.toContain(current.pc.room_uuid);
    expect(body).not.toContain(current.token);
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(
      ['ok', 'pc_absent_reason', 'pc_id', 'pc_online'],
    );
  });
});
