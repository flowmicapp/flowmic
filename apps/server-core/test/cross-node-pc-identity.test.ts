// SPEC-REF:
//   apps/server-core/src/node/pc-identity-forward.ts   (the producer, the rules, the apply)
//   apps/server-core/src/node/forwarded-write.ts       (`pc.identity` on the wire)
//   card NR-131 (2026-09-29 diag-0100 failure 3)
//
// A PC that reconnects through a REPLICA used to stamp its machine uid and its
// client declaration into that replica's database only. The next replication
// pull replaced the row with the writer's copy, and nothing had told the writer:
// a row that needed a backfill kept `machine_uid = NULL` on both nodes, every
// phone ack carried `pc_machine_uid: null`, and the phone could not group the
// PC's LAN and cloud rows (measured on production: a 0.3.100 desktop still
// `client_version 0.3.95` on srvny and srvjp).
//
// Two nodes, in process, real sqlite on both: the REAL pc and mobile handlers on
// the replica, the REAL outbox → drainer → WriterClient → `POST /api/node/forward`
// route → receiver → ledger → apply on the writer, and the REAL snapshot → pull
// back to the replica. Only the socket and the HTTP transport are shims.
//
// ⚠️ `pc:register` is refused on a replica (writer-only.ts), so the leg under test
// is `pc:reconnect` — the leg an installed desktop uses for the rest of its life.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server, Socket } from 'socket.io';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { Registry } from '../src/room/registry';
import type { AuthContext } from '../src/auth/middleware';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { makeWriterOnlyGuard } from '../src/node/writer-only';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';
import { makeWriterClient } from '../src/node/writer-client';
import { ReplicaOutbox } from '../src/db/replica-outbox';
import { startOutboxDrainer } from '../src/node/outbox-drainer';
import { makeForwardLedger } from '../src/node/forward-ledger';
import { makeForwardReceiver } from '../src/node/forward-receiver';
import { makeSnapshotProducer } from '../src/node/snapshot';
import { makeReplicaPuller } from '../src/node/replica-puller';
import type { ForwardTargets } from '../src/node/forwarded-write';
import {
  makePcIdentityApplier, makePcIdentityClock, makePcIdentityForwarder, type PcIdentityClock,
} from '../src/node/pc-identity-forward';

type Db = ReturnType<typeof createDbConnection>;

const WRITER_URL = 'https://srvny.flowmic.app';
const SECRET = 'node-shared-secret-32-bytes-long!!';
const UID = 'pc-6a4f7d7e39a4c0de';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

// the writer's HTTP side as a fetch shim the real WriterClient drives —
// the same shim cross-node-pc-reconnect.test.ts uses.
function fetchIntoRoutes(deps: NodeRoutesDeps): typeof fetch {
  const handler = makeNodeRoutes(deps);
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const req = Object.assign(Readable.from([Buffer.from(bodyText, 'utf8')]), {
      url: url.pathname + url.search,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    }) as unknown as IncomingMessage;
    return await new Promise<Response>((resolve) => {
      let status = 0;
      const res = {
        writeHead(code: number) { status = code; return res; },
        end(payload?: string) {
          resolve(new Response(payload ?? '', { status, headers: { 'content-type': 'application/json' } }));
        },
      } as unknown as ServerResponse;
      if (!handler(req, res)) resolve(new Response('', { status: 404 }));
    });
  }) as typeof fetch;
}

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  connected = true;
  readonly handshake = { address: '10.0.0.9' };
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();
  constructor(readonly id: string, public data: { auth: AuthContext | null; roomUuid?: string } = { auth: null }) {}
  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  off(): this { return this; }
  join(): this { return this; }
  emit(event: string, payload: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  disconnect(): this { this.connected = false; return this; }
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      for (const fn of list) fn(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }
}

interface Cluster {
  dir: string;
  writer: { db: Db; registry: Registry; clock: PcIdentityClock };
  replica: { db: Db; registry: Registry; outbox: ReplicaOutbox };
  /** Replica → writer: one drain of the outbox through the real route. */
  flush(): Promise<void>;
  /** Writer → replica: one real snapshot pull. */
  pull(): Promise<void>;
  receive: ReturnType<typeof makeForwardReceiver>;
}

let c: Cluster;

function makeCluster(): Cluster {
  const dir = mkdtempSync(join(tmpdir(), 'nr131-'));
  const open = (name: string): Db => createDbConnection({
    dbPath: join(dir, name), encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx'),
  });
  const wdb = open('writer.db');
  wdb.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  wdb.users.insert({ id: 'other', display_name: 'O', plan: 'free' });
  const rdb = open('replica.db');
  const clock = makePcIdentityClock();
  // The writer's apply targets, with the PRODUCTION identity applier. The
  // metering arms are unreachable here and throw so that stays true.
  const targets: ForwardTargets = {
    usage: {
      recordSttUsage: () => { throw new Error('no metering in this test'); },
      recordLlmUsage: () => { throw new Error('no metering in this test'); },
      recordQuotaRefusal: () => { throw new Error('no metering in this test'); },
    } as unknown as ForwardTargets['usage'],
    setHomeNode: (pcId, node) => wdb.pcs.setHomeNode(pcId, node),
    setPresence: () => {},
    setPcIdentity: makePcIdentityApplier({ pcs: wdb.pcs, clock, log: silent }),
  };
  const receive = makeForwardReceiver({ ledger: makeForwardLedger(wdb.raw), targets });
  const client = makeWriterClient({
    writerUrl: WRITER_URL, sharedSecret: SECRET, nodeId: 'srvjp',
    fetchImpl: fetchIntoRoutes({ nodeId: 'srvny', version: '0.3.101', sharedSecret: SECRET, receiveForward: receive }),
  });
  const outbox = new ReplicaOutbox(join(dir, 'outbox.jsonl'));
  const drainer = startOutboxDrainer({
    outbox, client, log: silent, setIntervalFn: () => null, clearIntervalFn: () => {},
  });
  const puller = makeReplicaPuller({
    db: rdb.raw, fetchSnapshot: makeSnapshotProducer(wdb.raw), log: silent,
    stagePath: join(dir, 'stage.db'), setIntervalFn: () => null,
  });
  return {
    dir,
    writer: { db: wdb, registry: new Registry({ pcs: wdb.pcs, mobiles: wdb.mobiles }), clock },
    replica: { db: rdb, registry: new Registry({ pcs: rdb.pcs, mobiles: rdb.mobiles }), outbox },
    flush: () => drainer.tick(),
    pull: async () => { await puller.pull(); },
    receive,
  };
}

beforeEach(() => { c = makeCluster(); });
afterEach(() => {
  c.writer.db.close();
  c.replica.db.close();
  rmSync(c.dir, { recursive: true, force: true });
});

/** The production state of the affected row: minted by a build that sent no
 *  uid, on the writer, and replicated. */
async function legacyPcOnBothNodes(opts: { machine_uid?: string } = {}): Promise<{ pcId: string; token: string }> {
  const { pc, token } = c.writer.registry.registerPc({
    device_name: 'FlowMic-LINUX-TESTVM', user_id: 'default', client_version: '0.3.95',
    ...(opts.machine_uid ? { machine_uid: opts.machine_uid } : {}),
  });
  await c.pull();
  expect(c.replica.db.pcs.findById(pc.id)).not.toBeNull();
  return { pcId: pc.id, token };
}

/** The REAL pc handler over the replica, with the production forwarder — or
 *  without it, which is the build that shipped before NR-131. */
function pcSocketOnReplica(forward: boolean): FakeSocket {
  const socket = new FakeSocket('sock-pc');
  registerPcHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry: c.replica.registry,
    store: new RoomStore() as RoomStore<Socket>,
    resolveActingUser: () => ({ userId: 'default' }),
    writerOnly: makeWriterOnlyGuard(WRITER_URL),
    ...(forward ? { notePcIdentity: makePcIdentityForwarder({ outbox: c.replica.outbox, nodeId: 'srvjp', log: silent }) } : {}),
  });
  return socket;
}

async function phoneAckOnReplica(pcId: string): Promise<Record<string, unknown>> {
  const pc = c.writer.db.pcs.findById(pcId)!;
  const { token } = c.writer.registry.pairMobile({ short_code: pc.short_code, mobile_name: 'TB335', device_uid: 'mb-0123456789abcdef' });
  await c.pull();
  const socket = new FakeSocket('sock-mobile');
  registerMobileHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry: c.replica.registry,
    store: new RoomStore() as RoomStore<Socket>,
    pairLimiter: new PairRateLimiter({}),
    mode: 'standalone',
    resolveActingUser: () => ({ userId: 'default' }),
    writerOnly: makeWriterOnlyGuard(WRITER_URL),
    restriction: { getUser: (id) => c.replica.db.users.findById(id) },
  });
  return socket.invoke('mobile:reconnect', { token });
}

const RECONNECT = { machine_uid: UID, client: 'app', client_version: '0.3.100', target_caps: { image: true } };

describe('NR-131: a PC reconnecting through a replica reaches the writer', () => {
  it('🔴 uid, version and caps land on the writer, survive the next pull, and reach the phone ack', async () => {
    const { pcId, token } = await legacyPcOnBothNodes();
    const socket = pcSocketOnReplica(true);

    const ack = await socket.invoke('pc:reconnect', { token, ...RECONNECT });
    expect(ack.error).toBeUndefined();
    // Nothing has crossed yet: the writer still holds the legacy row.
    expect(c.writer.db.pcs.findById(pcId)!.machine_uid).toBeNull();

    await c.flush();
    const onWriter = c.writer.db.pcs.findById(pcId)!;
    expect(onWriter.machine_uid).toBe(UID);
    expect(onWriter.client_version).toBe('0.3.100');
    expect(onWriter.target_caps).toBe('{"image":true}');
    expect(c.replica.outbox.stats().pending).toBe(0);

    // The pull that used to erase it now brings the writer's copy back.
    await c.pull();
    const onReplica = c.replica.db.pcs.findById(pcId)!;
    expect(onReplica.machine_uid).toBe(UID);
    expect(onReplica.client_version).toBe('0.3.100');
    expect(onReplica.target_caps).toBe('{"image":true}');

    // And the fact the phone groups by, served BY THE REPLICA.
    const phone = await phoneAckOnReplica(pcId);
    expect(phone.error).toBeUndefined();
    expect(phone.pc_machine_uid).toBe(UID);
  });

  it('CONTROL — the pre-NR-131 build: the pull erases the stamp and the phone ack is null', async () => {
    // What production measured. If this ever passes with a uid, something else
    // started carrying it and the test above proves nothing about this fix.
    const { pcId, token } = await legacyPcOnBothNodes();
    const socket = pcSocketOnReplica(false);
    await socket.invoke('pc:reconnect', { token, ...RECONNECT });
    expect(c.replica.db.pcs.findById(pcId)!.machine_uid).toBe(UID); // stamped locally…
    await c.flush();
    await c.pull();
    expect(c.writer.db.pcs.findById(pcId)!.machine_uid).toBeNull();
    expect(c.replica.db.pcs.findById(pcId)!.machine_uid).toBeNull(); // …and erased
    expect((await phoneAckOnReplica(pcId)).pc_machine_uid).toBeNull();
  });

  it('🔴 a replica cannot blank the writer’s non-empty uid (an old desktop that sends none)', async () => {
    const { pcId, token } = await legacyPcOnBothNodes({ machine_uid: UID });
    const socket = pcSocketOnReplica(true);
    await socket.invoke('pc:reconnect', { token, client_version: '0.3.60' });
    await c.flush();
    const row = c.writer.db.pcs.findById(pcId)!;
    expect(row.machine_uid).toBe(UID);
    // The declaration DOES travel — same as the direct path, absence included.
    expect(row.client_version).toBe('0.3.60');
    expect(row.target_caps).toBeNull();
  });

  it('a malformed uid degrades to absent; a malformed declaration is rejected', async () => {
    const { pcId } = await legacyPcOnBothNodes({ machine_uid: UID });
    const base = { kind: 'pc.identity', pc_id: pcId, user_id: 'default', declared_at: Date.now(), client: 'app', client_version: '0.3.100', target_caps: null };
    const out = c.receive([
      { id: 'r-mb', body: { ...base, machine_uid: 'mb-0123456789abcdef' } },
      { id: 'r-blank', body: { ...base, machine_uid: '' } },
      { id: 'r-long', body: { ...base, client_version: 'x'.repeat(33) } },
      { id: 'r-client', body: { ...base, client: 'desktop' } },
    ], 'srvjp');
    expect(out).toEqual({ 'r-mb': 'accepted', 'r-blank': 'accepted', 'r-long': 'rejected', 'r-client': 'rejected' });
    expect(c.writer.db.pcs.findById(pcId)!.machine_uid).toBe(UID);
  });

  it('a record naming another account is consumed and changes nothing', async () => {
    const { pcId } = await legacyPcOnBothNodes();
    const out = c.receive([{ id: 'r-x', body: {
      kind: 'pc.identity', pc_id: pcId, user_id: 'other', declared_at: Date.now(),
      machine_uid: UID, client: 'app', client_version: '9.9.9', target_caps: null,
    } }], 'srvjp');
    expect(out).toEqual({ 'r-x': 'accepted' });
    const row = c.writer.db.pcs.findById(pcId)!;
    expect(row.machine_uid).toBeNull();
    expect(row.client_version).toBe('0.3.95');
  });

  it('last writer wins by declared_at — a late record does not undo a newer one', async () => {
    const { pcId } = await legacyPcOnBothNodes();
    const rec = (id: string, at: number, v: string) => ({ id, body: {
      kind: 'pc.identity', pc_id: pcId, user_id: 'default', declared_at: at,
      machine_uid: UID, client: 'app', client_version: v, target_caps: null,
    } });
    c.receive([rec('new', 2_000, '0.3.101')], 'srvjp');
    c.receive([rec('old', 1_000, '0.3.100')], 'srvjp');           // retried late
    expect(c.writer.db.pcs.findById(pcId)!.client_version).toBe('0.3.101');
    // A direct connection to the writer notes its instant on the same clock.
    c.writer.clock.noteDirect(pcId, 3_000);
    c.receive([rec('mid', 2_500, '0.3.99')], 'srvjp');
    expect(c.writer.db.pcs.findById(pcId)!.client_version).toBe('0.3.101');
    // A redelivery of the same id is a ledger duplicate, not a second apply.
    expect(c.receive([rec('new', 2_000, '0.3.101')], 'srvjp')).toEqual({ new: 'duplicate' });
  });

  it('COMPAT — a body kind this writer does not know is rejected alone; its neighbours apply', async () => {
    // This is the path a pre-NR-131 writer takes for `pc.identity`: its
    // parseForwardedWrite has no arm for it and its `default` throws
    // UnknownForwardedWrite, which the receiver turns into a per-record
    // `rejected` (forward-receiver.ts). The replica keeps the record owed and
    // parks it at MAX_TRIES; nothing behind it is held up.
    const { pcId } = await legacyPcOnBothNodes();
    const out = c.receive([
      { id: 'future', body: { kind: 'pc.identity.v2', pc_id: pcId } },
      { id: 'home', body: { kind: 'pc.home_node', pc_id: pcId, home_node: 'srvasia02' } },
    ], 'srvjp');
    expect(out).toEqual({ future: 'rejected', home: 'accepted' });
    expect(c.writer.db.pcs.findById(pcId)!.home_node).toBe('srvasia02');
  });
});
