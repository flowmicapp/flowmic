// B12 (2026-09-02, WP-6) — `pc:reconnect` must not MINT a PCID on a replica.
//
// findings-multinode.md F10: "registry.ts stampPcid on replica erased by pull
// => pcid churn for pre-0.2.66 rows". `stampPcid` backfills a NULL pcid with a
// freshly-drawn random one; on a replica that write is erased by the next
// pull (the writer's own row is still null), so the NEXT reconnect — same
// replica after a pull, or any other node — mints a DIFFERENT one. A
// pre-0.2.66 row that only ever reconnects through a replica would churn a
// fresh PCID into the pairing dialog on every cycle, none of which ever
// persist.
//
// SPEC-REF: apps/server-core/src/room/registry.ts `reconnectPc`'s
//   `skipPcidBackfill` option; apps/server-core/src/socket/handlers/
//   pc.handler.ts `pc:reconnect` (the caller); audit doc §3-A B12.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeWriterOnlyGuard, NODE_CAN_WRITE } from '../src/node/writer-only';
import { planLimits } from '../src/billing/plans';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

const WRITER_URL = 'https://srvny.flowmic.app';
const TOKEN = 'device-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let db: Db;
let registry: Registry;

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode: 'saas', limitsOf: () => planLimits('max') });
});
afterEach(() => db.close());

/** A "pre-0.2.66" row: inserted directly (bypassing registerPc, which always
 *  stamps a pcid on the register leg), so pcid starts genuinely NULL — the
 *  exact shape of row F10 is about. */
function preExistingPcRow(): { id: string } {
  const pc = db.pcs.insert({
    id: 'pc-legacy-1', user_id: 'default', device_name: 'Legacy PC',
    device_token: TOKEN, room_uuid: 'room-legacy-1', short_code: '1234',
  });
  expect(pc.pcid).toBeNull();
  return { id: pc.id };
}

describe('Registry.reconnectPc — the skipPcidBackfill option', () => {
  it('skipPcidBackfill:true leaves the row pcid-less, every single time', () => {
    preExistingPcRow();
    for (let i = 0; i < 3; i++) {
      const result = registry.reconnectPc(TOKEN, undefined, undefined, { skipPcidBackfill: true });
      expect(result?.pc.pcid ?? null).toBeNull();
    }
    expect(db.pcs.findByToken(TOKEN)?.pcid).toBeNull();
  });

  it('without the option (writer / single-node path) the row is backfilled exactly once', () => {
    preExistingPcRow();
    const first = registry.reconnectPc(TOKEN);
    expect(first?.pc.pcid).not.toBeNull();
    const minted = first!.pc.pcid;
    // stampPcid is a no-op once the row has one — a SECOND reconnect (still
    // without the option) must never rotate it.
    const second = registry.reconnectPc(TOKEN);
    expect(second?.pc.pcid).toBe(minted);
  });

  it('🔴 THE CHURN F10 NAMES, reproduced: repeated skip-mode reconnects never converge on one value', () => {
    // Without the fix, each of these calls would have minted and stored a
    // FRESH random pcid (stampPcid ran unconditionally); with skipPcidBackfill
    // the row is simply never touched, so there is nothing to churn.
    preExistingPcRow();
    const seen = new Set<string | null>();
    for (let i = 0; i < 5; i++) {
      registry.reconnectPc(TOKEN, undefined, undefined, { skipPcidBackfill: true });
      seen.add(db.pcs.findByToken(TOKEN)?.pcid ?? null);
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBeNull();
  });

  it('standalone mode never mints regardless of the option — unaffected by this card', () => {
    const standalone = new Registry({ pcs: db.pcs, mobiles: db.mobiles, mode: 'standalone' });
    preExistingPcRow();
    standalone.reconnectPc(TOKEN);
    expect(db.pcs.findByToken(TOKEN)?.pcid).toBeNull();
  });
});

// ── the wiring: pc.handler.ts must pass the option, keyed off writerOnly() ──

interface FakeSocket {
  id: string;
  data: { auth: AuthContext | null; roomUuid?: string };
  on(event: string, fn: (payload: unknown, ack: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  join(room: string): void;
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>>;
}

function fakeSocket(id: string): FakeSocket {
  const handlers = new Map<string, (payload: unknown, ack: unknown) => void>();
  return {
    id,
    data: { auth: null },
    on(event, fn) { handlers.set(event, fn); },
    emit() {},
    join() {},
    invoke(event, payload) {
      return new Promise((resolve) => {
        const h = handlers.get(event);
        if (!h) return resolve({ __no_handler: true });
        h(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
      });
    },
  };
}

describe('🔴 pc:reconnect wiring — writerOnly() truthiness gates the backfill, end to end', () => {
  const io = { sockets: { sockets: new Map() } } as unknown as Server;

  it('on a replica, the ack never carries a pcid and the row stays null', async () => {
    preExistingPcRow();
    const socket = fakeSocket('s1');
    registerPcHandlers(socket as unknown as Socket, {
      io, registry, store: new RoomStore() as RoomStore<Socket>,
      resolveActingUser: () => ({ userId: 'default' }),
      writerOnly: makeWriterOnlyGuard(WRITER_URL),
    });

    const ack = await socket.invoke('pc:reconnect', { token: TOKEN });

    expect(ack.error).toBeUndefined();
    expect(db.pcs.findByToken(TOKEN)?.pcid).toBeNull();
  });

  it('REVERSE CONTROL — the identical reconnect on a writable node DOES backfill', async () => {
    preExistingPcRow();
    const socket = fakeSocket('s2');
    registerPcHandlers(socket as unknown as Socket, {
      io, registry, store: new RoomStore() as RoomStore<Socket>,
      resolveActingUser: () => ({ userId: 'default' }),
      writerOnly: NODE_CAN_WRITE,
    });

    const ack = await socket.invoke('pc:reconnect', { token: TOKEN });

    expect(ack.error).toBeUndefined();
    expect(db.pcs.findByToken(TOKEN)?.pcid).not.toBeNull();
  });
});
