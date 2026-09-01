// THE PHONE'S "is my computer online" ASKED THE WRONG NODE.
//
// SPEC-REF: apps/server-core/src/room/pc-presence.ts (the ONE author)
//           apps/mobile/lib/src/session/presence_route.dart (the phone's half:
//             it already sends the question to its PC's node, and every failure
//             there falls back to "ask whoever I am talking to" — never to
//             "offline". The server half must keep that direction.)
//           apps/server-core/src/node/replica-puller.ts (PULL_INTERVAL_MS)
//           apps/server-core/src/node/outbox-drainer.ts (DRAIN_INTERVAL_MS)
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// A home_node-aware resolver has existed since 2026-08-30 and was wired into the
// CONSOLE only. The three phone-facing sites still read
// `store.getPc(pc.room_uuid) !== null`:
//
//   · GET /api/pc/presence            (the resting instance list's 10 s poll)
//   · the mobile:pair ack's pc_online
//   · the mobile:reconnect ack's pc_online
//
// Rooms are a Map inside ONE process (room/store.ts: "Live socket presence
// ONLY"). A phone that asks node A about a PC living on node B was told,
// truthfully and uselessly, that its computer is not there — and nothing
// reported an error, because nothing was wrong with the answer. It was the right
// answer to the question that was asked.
//
// ── WHY THE CASES BELOW ARE SHAPED THIS WAY ─────────────────────────────────
// Every case drives the REAL handler / REAL route over a REAL sqlite db, a REAL
// Registry and a REAL RoomStore. A unit test of `pcPresence` alone proves
// nothing about wiring, and wiring is the entire card — the function was
// already correct and already had reverse controls (cross-node-presence.test.ts)
// while all three phone surfaces answered from the old expression.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Server, Socket } from 'socket.io';
import { AUDIO_DEFAULTS } from '@flowmic/protocol';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { tryHandlePresenceRoutes, PC_PRESENCE_PATH } from '../src/http/presence-routes';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { NODE_CAN_WRITE } from '../src/node/writer-only';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { DRAIN_INTERVAL_MS } from '../src/node/outbox-drainer';
import { PULL_INTERVAL_MS } from '../src/node/replica-puller';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

const STALE = AUDIO_DEFAULTS.heartbeat_timeout_ms; // 15_000
const NOW = 1_800_000_000_000;
const PC_INSTANCE = 'desktop-instance-aaaa';

/** Both nodes are named rather than 'a'/'b' so a failure message says which end
 *  of the ocean it is talking about. `srvny` is the writer. */
const WRITER = 'srvny';
const OTHER = 'srvjp';

// ── the socket seam ─────────────────────────────────────────────────────────

class FakeSocket {
  connected = true;
  readonly handshake = { address: '10.0.0.9' };
  private readonly handlers = new Map<string, ((p: unknown, ack: unknown) => void)[]>();
  constructor(
    readonly id: string,
    public data: { auth: AuthContext | null; roomUuid?: string } = { auth: null },
  ) {}
  on(event: string, fn: (p: unknown, ack: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  off(): this { return this; }
  emit(): boolean { return true; }
  disconnect(): this { this.connected = false; return this; }
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      for (const fn of list) fn(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }
}

// ── the http seam ───────────────────────────────────────────────────────────

function request(token: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = 'GET';
  req.url = PC_PRESENCE_PATH;
  (req as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` };
  (req as { socket: { remoteAddress: string } }).socket = { remoteAddress: '10.0.0.44' };
  return req;
}

function response(): { res: ServerResponse; read(): Record<string, unknown> } {
  let body: Record<string, unknown> = {};
  const res = {
    writeHead() { return res; },
    end(payload?: string) { body = payload ? (JSON.parse(payload) as Record<string, unknown>) : {}; },
  } as unknown as ServerResponse;
  return { res, read: () => body };
}

// ── the world ───────────────────────────────────────────────────────────────

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore<Socket>();
});
afterEach(() => db.close());

/** What this node believes about itself. Absent `nodeId` = single node.
 *  `now` defaults to the frozen instant every stamp below is expressed against;
 *  the one case that must NOT freeze it says so in its own comment. */
interface NodeShape { nodeId?: string; replica?: boolean; now?: () => number }

/** A PC's socket in a room. It needs `emit` because `joinAndNotify` tells the PC
 *  a phone arrived — a bare `{ id }` throws inside the pair handler and the ack
 *  comes back as SETTINGS_SYNC_FAIL, which looks nothing like the cause. */
function pcSocket(id = 'pc-sock'): Socket {
  return new FakeSocket(id) as unknown as Socket;
}

function wireMobile(socket: FakeSocket, node: NodeShape = {}): FakeSocket {
  registerMobileHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    pairLimiter: new PairRateLimiter({}),
    mode: 'standalone',
    writerOnly: NODE_CAN_WRITE,
    resolveActingUser: () => ({ userId: 'default' }),
    restriction: { getUser: (id) => db.users.findById(id) },
    now: node.now ?? (() => NOW),
    rowsFromReplicationPull: node.replica === true,
    ...(node.nodeId ? { nodeId: node.nodeId } : {}),
  });
  return socket;
}

function askHttp(token: string, node: NodeShape = {}): Record<string, unknown> {
  const { res, read } = response();
  tryHandlePresenceRoutes(request(token), res, {
    registry,
    store: store as unknown as RoomStore,
    pcs: db.pcs,
    nodeIdFor: () => node.nodeId ?? null,
    rowsFromReplicationPull: node.replica === true,
    now: node.now ?? (() => NOW),
  });
  return read();
}

/** Register a PC and pair one phone to it, WITHOUT putting the PC in this
 *  node's room — which is what a PC living on another node looks like from
 *  here, and is also what the writer sees for every replica-hosted computer. */
function pcWithPhone(): { pcId: string; roomUuid: string; shortCode: string; token: string } {
  const { pc } = registry.registerPc({
    device_name: 'PC-A', user_id: 'default', client_instance_id: PC_INSTANCE,
  });
  const pair = registry.pairMobile({ short_code: pc.short_code, mobile_name: 'phone', user_id: 'default' });
  return { pcId: pc.id, roomUuid: pc.room_uuid, shortCode: pc.short_code, token: pair.token };
}

/** Move the PC's heartbeat stamp to `ageMs` before NOW. */
function seenAgo(pcId: string, ageMs: number): void {
  db.pcs.touchLastSeen(pcId, new Date(NOW - ageMs).toISOString());
}

// ─────────────────────────────────────────────────────────────────────────────

describe('a PC on another node is ONLINE to its own phone', () => {
  it('🔴 all three phone-facing answers say true — pair ack, reconnect ack, http', async () => {
    const w = pcWithPhone();
    db.pcs.setHomeNode(w.pcId, OTHER);
    seenAgo(w.pcId, 1_000);

    // The precondition that makes this a real test rather than a tautology: the
    // writer's room map cannot hold a socket that belongs to another process,
    // and this is the exact expression all three sites used to answer with.
    expect(store.getPc(w.roomUuid)).toBeNull();

    const pairAck = await wireMobile(new FakeSocket('m-pair'), { nodeId: WRITER })
      .invoke('mobile:pair', { short_code: w.shortCode });
    expect(pairAck.pc_online).toBe(true);

    const reAck = await wireMobile(new FakeSocket('m-re'), { nodeId: WRITER })
      .invoke('mobile:reconnect', { token: pairAck.mobile_token as string });
    expect(reAck.pc_online).toBe(true);

    expect(askHttp(w.token, { nodeId: WRITER })).toMatchObject({ ok: true, pc_online: true });
  });

  it('and goes absent once the forwarded heartbeat stops', async () => {
    // The whole reason the substitute is a TIMESTAMP and not `is_online`: it
    // stops advancing when the computer does. 60 s is past every window here.
    const w = pcWithPhone();
    db.pcs.setHomeNode(w.pcId, OTHER);
    seenAgo(w.pcId, 60_000);

    const pairAck = await wireMobile(new FakeSocket('m-pair'), { nodeId: WRITER })
      .invoke('mobile:pair', { short_code: w.shortCode });
    expect(pairAck.pc_online).toBe(false);

    const reAck = await wireMobile(new FakeSocket('m-re'), { nodeId: WRITER })
      .invoke('mobile:reconnect', { token: pairAck.mobile_token as string });
    expect(reAck.pc_online).toBe(false);

    expect(askHttp(w.token, { nodeId: WRITER })).toMatchObject({ pc_online: false });
  });
});

describe('the replica window — a stamp that arrived in a snapshot', () => {
  // A remote PC's stamp reaches the WRITER one outbox drain after the beat, and
  // reaches a REPLICA one replication pull after that. Judging a replica's copy
  // by the writer's window would flap a healthy computer online/offline with the
  // 30 s pull period. Both edges are asserted so a change to either constant
  // lands here rather than in a support ticket.
  const MID = STALE + DRAIN_INTERVAL_MS + 15_000; // 35 s: past the writer's window, inside a replica's

  it('🔴 a replica accepts a stamp the writer would call stale', async () => {
    const w = pcWithPhone();
    db.pcs.setHomeNode(w.pcId, OTHER);
    seenAgo(w.pcId, MID);

    // `mobile:pair` is writer-only (it mints rows), so the replica's phone-facing
    // presence answer arrives on the reconnect leg and on http. Both are wired.
    const pairAck = await wireMobile(new FakeSocket('m-pair'), { nodeId: WRITER })
      .invoke('mobile:pair', { short_code: w.shortCode });
    const token = pairAck.mobile_token as string;

    const onReplica = await wireMobile(new FakeSocket('m-re-replica'), { nodeId: WRITER, replica: true })
      .invoke('mobile:reconnect', { token });
    expect(onReplica.pc_online).toBe(true);
    expect(askHttp(w.token, { nodeId: WRITER, replica: true })).toMatchObject({ pc_online: true });

    // REVERSE CONTROL — the same row, the same instant, on a node whose copy did
    // NOT come from a pull. If this said `true`, the window would have been
    // widened for everybody and the case above would prove nothing.
    const onWriter = await wireMobile(new FakeSocket('m-re-writer'), { nodeId: WRITER })
      .invoke('mobile:reconnect', { token });
    expect(onWriter.pc_online).toBe(false);
    expect(askHttp(w.token, { nodeId: WRITER })).toMatchObject({ pc_online: false });
  });

  it('and no wider than one pull — both edges', async () => {
    const w = pcWithPhone();
    db.pcs.setHomeNode(w.pcId, OTHER);
    const pairAck = await wireMobile(new FakeSocket('m-pair'), { nodeId: WRITER })
      .invoke('mobile:pair', { short_code: w.shortCode });
    const token = pairAck.mobile_token as string;

    const at = async (ageMs: number): Promise<boolean> => {
      seenAgo(w.pcId, ageMs);
      const ack = await wireMobile(new FakeSocket(`m-${ageMs}`), { nodeId: WRITER, replica: true })
        .invoke('mobile:reconnect', { token });
      return ack.pc_online as boolean;
    };
    const window = STALE + DRAIN_INTERVAL_MS + PULL_INTERVAL_MS; // 50 s
    expect(await at(window - 1)).toBe(true);
    expect(await at(window)).toBe(false);
  });

  it('REVERSE CONTROL — the widening is for REMOTE rows only', async () => {
    // A PC whose home node is this one is written here on every beat, so the
    // pull is not in its chain. It keeps the narrow window and the room check.
    const w = pcWithPhone();
    db.pcs.setHomeNode(w.pcId, WRITER);
    seenAgo(w.pcId, MID);
    store.joinPc(w.roomUuid, pcSocket());

    expect(askHttp(w.token, { nodeId: WRITER, replica: true })).toMatchObject({ pc_online: false });
  });
});

describe('single node — byte-for-byte what it was', () => {
  it('a freshly registered PC in its room reads ONLINE', async () => {
    const w = pcWithPhone();
    // 🔴 THE ASSERTION THAT KEEPS THIS CARD FROM BEING A REGRESSION. The old
    // answer was room membership alone; the new one is membership AND a fresh
    // `last_seen_at`. That is only the same answer because registration stamps
    // the column — `registry.registerPc` → `pcs.setOnline(id, true)`, whose
    // UPDATE writes `last_seen_at` as well as the flag. If that ever stops being
    // true, every phone is told its computer is offline for the first five
    // seconds of every session, and this line is where it is caught.
    const row = db.pcs.findById(w.pcId);
    expect(row?.last_seen_at).not.toBeNull();
    expect(row?.home_node).toBeNull();

    store.joinPc(w.roomUuid, pcSocket());
    // 🔴 THE REAL CLOCK, not the frozen NOW, and that is the point of this case:
    // the stamp is whatever registration just wrote, judged against the moment
    // the phone asks. Freezing time here would test the harness instead.
    expect(askHttp(w.token, { now: Date.now })).toMatchObject({ ok: true, pc_online: true });

    const ack = await wireMobile(new FakeSocket('m-pair-single'), { now: Date.now })
      .invoke('mobile:pair', { short_code: w.shortCode });
    expect(ack.pc_online).toBe(true);
  });

  it('an empty room is still absent, and a home_node with no node id changes nothing', async () => {
    const w = pcWithPhone();
    seenAgo(w.pcId, 1_000);
    expect(askHttp(w.token)).toMatchObject({ pc_online: false });

    // A row stamped with a home node on a deployment that has no node id of its
    // own: `thisNode` is null, so there is nothing to compare against and the
    // remote branch must stay unreachable. Absent means「there is no such fact」,
    // never「assume it is elsewhere」.
    db.pcs.setHomeNode(w.pcId, OTHER);
    expect(askHttp(w.token)).toMatchObject({ pc_online: false });

    const ack = await wireMobile(new FakeSocket('m-pair-nonode')).invoke('mobile:pair', {
      short_code: w.shortCode,
    });
    expect(ack.pc_online).toBe(false);
  });
});
