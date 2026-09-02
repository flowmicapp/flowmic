// SPEC-REF:
//   apps/server-core/src/socket/handlers/pc.handler.ts  (pc:reconnect)
//   apps/server-core/src/node/token-read-through.ts     (the gate)
//   apps/server-core/src/node/writer-client.ts          (resolveToken)
//
// Split out of cross-node-token-read-through.test.ts (verify:lint file-size:
// that file crossed the test-file line cap once WP-4's B1 family and WP-8's
// additions landed in the same merge). This file owns the `pc:reconnect`
// half of the defect Z4 (in the sibling file) owns for `mobile:reconnect`;
// the shared harness below is duplicated verbatim rather than factored into
// a shared module — see that file's own header for why the real wiring
// (real handler, real writer route, real fetch shim) is what makes these
// assertions worth anything.
//
// B1 (2026-09-02) — `pc:reconnect` reads `pc_devices` the same way the
// handshake does and, before this card, answered a local miss with a
// LOCAL-ONLY `registry.reconnectPc`: no retry through the writer at all. The
// handshake's own read-through does not make this redundant — a replication
// pull racing us (the same race Z4 documents for mobile:reconnect) can take a
// just-landed row away again between the handshake tick and this event's own
// lookup, on the SAME socket. `machine_uid` is required by PcReconnectSchema;
// a fixed value is fine since these tests never assert on it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { Registry } from '../src/room/registry';
import { authMiddleware, type AuthContext } from '../src/auth/middleware';
import type { Server, Socket } from 'socket.io';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { RoomStore } from '../src/room/store';
import { makeWriterOnlyGuard } from '../src/node/writer-only';
import { tokenLookupOver } from '../src/bootstrap';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';
import { makeWriterClient, WriterUnreachable } from '../src/node/writer-client';
import {
  makeTokenReadThrough,
  type TokenReadThrough,
} from '../src/node/token-read-through';
import { applyTokenResolution, resolveTokenRows } from '../src/node/token-rows';

type Db = ReturnType<typeof createDbConnection>;

const WRITER_URL = 'https://srvny.flowmic.app';
const SECRET = 'node-shared-secret-32-bytes-long!!';

interface Node {
  db: Db;
  registry: Registry;
}

function makeNode(): Node {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  return { db, registry: new Registry({ pcs: db.pcs, mobiles: db.mobiles }) };
}

// the writer's HTTP side, as a fetch shim the real WriterClient can drive.
// Body is an async iterable because `readJsonBody` streams it; buffering it
// here would let a route that ignored its own ceiling pass.
function fetchIntoRoutes(deps: NodeRoutesDeps, onCall?: (path: string) => void): typeof fetch {
  const handler = makeNodeRoutes(deps);
  return (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    onCall?.(url.pathname);
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

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

let writer: Node;
let replica: Node;
// Every `/api/node/*` path the replica actually dialled, in order. The
// counter that makes "no writer call at all" an assertion rather than a hope.
let dialled: string[];

beforeEach(() => {
  writer = makeNode();
  replica = makeNode();
  dialled = [];
});
afterEach(() => {
  writer.db.close();
  replica.db.close();
});

// The production wiring, end to end: replica gate -> WriterClient -> the real
// writer route -> the writer's own repos.
function productionReadThrough(over: Partial<NodeRoutesDeps> = {}): TokenReadThrough {
  const client = makeWriterClient({
    writerUrl: WRITER_URL,
    sharedSecret: SECRET,
    nodeId: 'srvjp',
    fetchImpl: fetchIntoRoutes(
      {
        nodeId: 'srvny',
        version: '0.3.54',
        sharedSecret: SECRET,
        resolveToken: (token) => resolveTokenRows(writer.db, token),
        ...over,
      },
      (p) => dialled.push(p),
    ),
  });
  return makeTokenReadThrough({
    askWriter: (t) => client.resolveToken(t),
    apply: (rows) => applyTokenResolution(replica.db, rows),
    log: silentLog,
  });
}

// A PC registered on the writer AND already replicated to the replica - the
// ordinary state of the world, since a PC registers long before its phone
// pairs.
function pcOnBothNodes(): { pcId: string } {
  const { pc } = writer.registry.registerPc({ device_name: 'dev-pc-a', user_id: 'default' });
  replica.db.pcs.upsertReplicated(writer.db.pcs.findById(pc.id)!);
  return { pcId: pc.id };
}

// Drive the REAL handshake middleware against the replica's database.
// Resolves with the error socket.io would refuse the connection with, or
// null. Kept here (duplicated from the sibling file) only because
// wirePcOnReplica below does not itself need it directly - the pull-race
// test does, to land the row at the handshake before the pull erases it.
function handshake(token: string, readThrough?: TokenReadThrough): Promise<{ err: string | null; auth: AuthContext | null }> {
  const socket = { handshake: { auth: { token } }, data: {} as Record<string, unknown> };
  const mw = authMiddleware(tokenLookupOver(replica.db), undefined, readThrough);
  return new Promise((resolve) => {
    mw(socket, (err?: Error) => {
      resolve({ err: err ? err.message : null, auth: (socket.data.auth as AuthContext | null) ?? null });
    });
  });
}

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  connected = true;
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
  join(): this { return this; }
  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  disconnect(): this { this.connected = false; return this; }
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      for (const fn of list) fn(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }
}

const MACHINE_UID = 'ma-0123456789abcdef';

// The REAL pc handler over the REPLICA's real db / Registry / RoomStore,
// faked only at the socket seam - mirrors wireMobileOnReplica in the sibling
// file.
function wirePcOnReplica(seam?: TokenReadThrough): FakeSocket {
  const socket = new FakeSocket('sock-pc-1');
  registerPcHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry: replica.registry,
    store: new RoomStore() as RoomStore<Socket>,
    resolveActingUser: () => ({ userId: 'default' }),
    writerOnly: makeWriterOnlyGuard(WRITER_URL),
    ...(seam ? { resolveTokenOnWriter: seam } : {}),
  });
  return socket;
}

describe('B1: pc:reconnect resolves an unknown device token through the writer too', () => {
  it('🔴 a local miss is recovered, and the ack is an acceptance', async () => {
    // A PC that just registered on the writer and reconnects before the next
    // pull — its device token exists nowhere on this replica yet.
    const { pc } = writer.registry.registerPc({ device_name: 'fresh-pc', user_id: 'default' });
    expect(replica.db.pcs.findByToken(pc.device_token)).toBeNull();
    const socket = wirePcOnReplica(productionReadThrough());

    const ack = await socket.invoke('pc:reconnect', { token: pc.device_token, machine_uid: MACHINE_UID });

    expect(ack.error).toBeUndefined();
    expect(ack.pc_id).toBe(pc.id);
    // The row is HERE now, so the next event on this socket needs nobody.
    expect(replica.db.pcs.findByToken(pc.device_token)).not.toBeNull();
    expect(dialled).toEqual(['/api/node/resolve-token']);
  });

  it('🔴 the pull-race: a row that landed at the handshake and was ERASED again is recovered', async () => {
    // `replica-puller.ts` applies `DELETE FROM t; INSERT INTO t SELECT * FROM
    // snap.t` for every table, so a snapshot fetched BEFORE this PC registered
    // and applied AFTER the handshake landed it takes the row away again —
    // underneath a socket that is still open and about to emit `pc:reconnect`.
    const { pc } = writer.registry.registerPc({ device_name: 'fresh-pc-2', user_id: 'default' });
    const gate = productionReadThrough();
    expect((await handshake(pc.device_token, gate)).err).toBeNull(); // the handshake landed it
    replica.db.pcs.remove(pc.id);                                    // the pull took it away
    const socket = wirePcOnReplica(gate);

    const ack = await socket.invoke('pc:reconnect', { token: pc.device_token, machine_uid: MACHINE_UID });

    expect(ack.error).toBeUndefined();
    expect(ack.pc_id).toBe(pc.id);
    expect(dialled.length).toBe(2); // once at the handshake, once here
  });

  it('a writer that cannot be reached yields the refusal, and does not hang', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'fresh-pc-3', user_id: 'default' });
    const socket = wirePcOnReplica(makeTokenReadThrough({
      askWriter: () => Promise.reject(new WriterUnreachable('ECONNRESET')),
      apply: () => { throw new Error('nothing may be applied when nothing was learned'); },
      log: silentLog,
    }));

    const ack = await socket.invoke('pc:reconnect', { token: pc.device_token, machine_uid: MACHINE_UID });

    // 🔴 CORRECTION (B2-S, 2026-09-02): was AUTH_TOKEN_INVALID. Before this
    // card the handler asked only the boolean `resolve()`, which collapses
    // 'unverifiable' (this case) into the same `false` as
    // 'writer-confirmed-absent' — so a writer outage made the desktop's
    // DeadToken branch delete a good token and re-register. This is the
    // REVERSE CONTROL for that bug: with the pre-fix `.resolve()`-only call
    // this assertion fails (actual AUTH_TOKEN_INVALID).
    expect(ack.error).toBe('AUTH_TOKEN_UNVERIFIABLE');
    expect(replica.db.pcs.findByToken(pc.device_token)).toBeNull();
  });

  it('🔴 exactly ONE retry — the read-through is authoritative', async () => {
    const socket = wirePcOnReplica(makeTokenReadThrough({
      askWriter: () => { dialled.push('/api/node/resolve-token'); return Promise.resolve(null); },
      apply: () => { throw new Error('unreachable — the writer knew nothing'); },
      log: silentLog,
    }));

    const ack = await socket.invoke('pc:reconnect', { token: 'fm_' + '3'.repeat(64), machine_uid: MACHINE_UID });

    expect(ack.error).toBe('AUTH_TOKEN_INVALID');
    expect(dialled.length).toBe(1);
  });

  it('a token that IS local never reaches the writer', async () => {
    const { pcId } = pcOnBothNodes();
    const pcToken = writer.db.pcs.findById(pcId)!.device_token;
    const socket = wirePcOnReplica(productionReadThrough());

    const ack = await socket.invoke('pc:reconnect', { token: pcToken, machine_uid: MACHINE_UID });

    expect(ack.error).toBeUndefined();
    expect(dialled).toEqual([]);
  });

  it('REVERSE CONTROL — with NO seam wired, the pre-B1 refusal stands', async () => {
    // Single node and the writer: `wireNodeRuntime` returns null, bootstrap
    // spreads nothing, and this handler is the one that shipped before B1.
    const { pc } = writer.registry.registerPc({ device_name: 'fresh-pc-4', user_id: 'default' });
    const socket = wirePcOnReplica();

    const ack = await socket.invoke('pc:reconnect', { token: pc.device_token, machine_uid: MACHINE_UID });

    expect(ack.error).toBe('AUTH_TOKEN_INVALID');
    expect(dialled).toEqual([]);
  });
});
