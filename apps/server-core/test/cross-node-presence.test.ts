// A PC on a replica must read as PRESENT in the console, which only ever talks
// to the writer.
//
// SPEC-REF: docs/strategy/2026-08-29-multi-node-relay-design-srvny-srvjp.md §10-9
//           apps/server-core/src/node/node-runtime.ts `stampPresence`
//
// ── 🔴 THE FIRST DIAGNOSIS OF THIS WAS WRONG, AND THAT IS WHY THIS FILE EXISTS
// The gap was originally written up as "a PC on a replica reads offline to its
// own PHONE". Measuring the READ path refuted it: the phone polls `reconnect.url`
// — the node it is itself on — and follows its PC there, so presence is answered
// from live socket state inside one process and is correct.
//
// The surface that genuinely breaks is the CONSOLE. It always talks to the
// writer, `pcPresence` demanded local room membership, and the writer's
// RoomStore structurally cannot hold a socket that belongs to another process.
// A working computer read as absent — and by `pcPresence`'s own documented
// failure direction, absent also means REMOVABLE.
//
// ⚠️ Forwarding alone would not have fixed it, and that is worth keeping: the
// console deliberately does not consult `is_online` (owner 2026-08-28 §5-1 — a
// persisted flag survives a restart and lies). The fix is two halves that only
// work together — a producer on the replica, and a console that accepts a
// forwarded timestamp in place of a room membership it cannot observe.

import { describe, it, expect } from 'vitest';
import { pcPresence } from '../src/room/pc-presence';
import { registerHeartbeatHandler } from '../src/socket/handlers/heartbeat.handler';
import { AUDIO_DEFAULTS } from '@flowmic/protocol';
import { DRAIN_INTERVAL_MS } from '../src/node/outbox-drainer';
import type { PcRecord } from '../src/db/repos/pc.repo';
import type { Socket } from 'socket.io';
import type { AuthContext } from '../src/auth/middleware';

const STALE = AUDIO_DEFAULTS.heartbeat_timeout_ms; // 15_000
const NOW = 1_800_000_000_000;

/** A store that holds nothing — which is exactly what the WRITER's store looks
 *  like for a PC that lives on a replica. */
const emptyStore = { getPc: () => null, getMobile: () => null };
/** A store that holds the PC — the single-node and same-node case. */
const holdingStore = {
  getPc: () => ({ id: 's', emit: () => {}, disconnect: () => {} }),
  getMobile: () => null,
};

function pc(over: Partial<PcRecord> = {}): PcRecord {
  return {
    id: 'pc-1', user_id: 'u', device_name: 'PC', client_instance_id: 'inst',
    machine_uid: null, device_token: 't', room_uuid: 'room-1', short_code: '1234',
    is_online: 0, last_seen_at: new Date(NOW - 1_000).toISOString(),
    home_node: null, pcid: null,
    ...over,
  } as unknown as PcRecord;
}

describe('pcPresence across nodes', () => {
  it('🔴 a PC on ANOTHER node is present on a fresh forwarded heartbeat', () => {
    // The writer's store is empty for this PC and always will be. Before the
    // fix this returned false — a healthy computer reported absent, and
    // removable.
    expect(pcPresence(emptyStore, pc({ home_node: 'srvjp' }), NOW, 'srvny')).toBe(true);
  });

  it('REVERSE CONTROL — a PC on THIS node still needs its room', () => {
    // Without this, "always true when home_node is set" would pass the test
    // above. Same row, same freshness, home_node == this node ⇒ the local rule
    // applies unchanged and an empty store means absent.
    expect(pcPresence(emptyStore, pc({ home_node: 'srvny' }), NOW, 'srvny')).toBe(false);
    expect(pcPresence(holdingStore, pc({ home_node: 'srvny' }), NOW, 'srvny')).toBe(true);
  });

  it('REVERSE CONTROL — single node is byte-for-byte unchanged', () => {
    // Every deployment that is not the relay. `home_node` is null on every row,
    // so the remote branch must be unreachable and an empty store must still
    // mean absent.
    expect(pcPresence(emptyStore, pc(), NOW)).toBe(false);
    expect(pcPresence(holdingStore, pc(), NOW)).toBe(true);
    expect(pcPresence(emptyStore, pc({ home_node: 'srvjp' }), NOW, null)).toBe(false);
  });

  it('a remote PC still goes absent once the forwarded heartbeat stops', () => {
    // 🔴 The whole point of using a TIMESTAMP rather than the `is_online` flag:
    // this stops advancing the moment the heartbeat stops, so a powered-off
    // remote computer becomes absent — and therefore removable — on its own.
    const dead = pc({ home_node: 'srvjp', last_seen_at: new Date(NOW - 60_000).toISOString() });
    expect(pcPresence(emptyStore, dead, NOW, 'srvny')).toBe(false);
  });

  it('the remote window is one outbox drain wider, and no wider', () => {
    // Derived, not picked: the forwarded path adds one drain interval over the
    // local one. Asserted at both edges so a change to either constant lands
    // here rather than in a support ticket.
    const at = (ageMs: number) =>
      pcPresence(emptyStore, pc({ home_node: 'srvjp', last_seen_at: new Date(NOW - ageMs).toISOString() }), NOW, 'srvny');
    expect(at(STALE + DRAIN_INTERVAL_MS - 1)).toBe(true);
    expect(at(STALE + DRAIN_INTERVAL_MS)).toBe(false);
    // And a LOCAL pc gets the narrow window — the slack is not global.
    const local = pcPresence(
      holdingStore,
      pc({ home_node: 'srvny', last_seen_at: new Date(NOW - (STALE + 1)).toISOString() }),
      NOW, 'srvny',
    );
    expect(local).toBe(false);
  });

  it('a row that never connected is absent even on another node', () => {
    expect(pcPresence(emptyStore, pc({ home_node: 'srvjp', last_seen_at: null }), NOW, 'srvny')).toBe(false);
  });
});

// ── the producer half ───────────────────────────────────────────────────────

interface FakeSocket {
  data: { auth: AuthContext | null };
  on(e: string, fn: (p: unknown, ack: unknown) => void): void;
  invoke(e: string, p: unknown): Promise<Record<string, unknown>>;
}
function fakeSocket(auth: AuthContext | null): FakeSocket {
  const h = new Map<string, (p: unknown, ack: unknown) => void>();
  return {
    data: { auth },
    on(e, fn) { h.set(e, fn); },
    invoke(e, p) {
      return new Promise((r) => {
        const fn = h.get(e);
        if (!fn) return r({ __no_handler: true });
        fn(p, (v: unknown) => r((v ?? {}) as Record<string, unknown>));
      });
    },
  };
}

describe('the heartbeat forwards presence on a replica', () => {
  const auth = { userId: 'u', deviceId: 'pc-1', kind: 'pc' } as AuthContext;

  it('forwards the SAME instant it wrote locally', async () => {
    const touched: Array<[string, string]> = [];
    const forwarded: Array<[string, number]> = [];
    const s = fakeSocket(auth);
    registerHeartbeatHandler(s as unknown as Socket, {
      pcs: { touchLastSeen: (id: string, w: string) => { touched.push([id, w]); } } as never,
      mobiles: { touchLastSeen: () => {} } as never,
      now: () => new Date(NOW),
      stampPresence: (id, ms) => { forwarded.push([id, ms]); },
    });

    await s.invoke('heartbeat', { ts: NOW });

    expect(touched).toEqual([['pc-1', new Date(NOW).toISOString()]]);
    // 🔴 The same instant, not "about now". Two clocks for one fact is how the
    // console and the node disagree about whether a computer is here.
    expect(forwarded).toEqual([['pc-1', NOW]]);
  });

  it('REVERSE CONTROL — a writer/single node forwards nothing', () => {
    // `stampPresence` absent must mean「there is nowhere to send it」and must not
    // throw, because that is every non-relay deployment there is.
    const touched: string[] = [];
    const s = fakeSocket(auth);
    registerHeartbeatHandler(s as unknown as Socket, {
      pcs: { touchLastSeen: (id: string) => { touched.push(id); } } as never,
      mobiles: { touchLastSeen: () => {} } as never,
      now: () => new Date(NOW),
    });
    return s.invoke('heartbeat', { ts: NOW }).then((ack) => {
      expect(ack.error).toBeUndefined();
      expect(touched).toEqual(['pc-1']);
    });
  });

  it('a PHONE heartbeat forwards nothing — the console table is about computers', async () => {
    const forwarded: string[] = [];
    const s = fakeSocket({ userId: 'u', pairingId: 'm-1', kind: 'mobile' } as AuthContext);
    registerHeartbeatHandler(s as unknown as Socket, {
      pcs: { touchLastSeen: () => {} } as never,
      mobiles: { touchLastSeen: () => {} } as never,
      now: () => new Date(NOW),
      stampPresence: (id) => { forwarded.push(id); },
    });
    await s.invoke('heartbeat', { ts: NOW });
    expect(forwarded).toEqual([]);
  });
});
