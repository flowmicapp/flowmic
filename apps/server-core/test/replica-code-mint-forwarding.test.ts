// SPEC-REF:
//   apps/server-core/src/socket/handlers/pc.handler.ts  (`pc:refresh-code`)
//   apps/server-core/src/http/node-routes.ts            (POST /api/node/mint-code)
//   apps/server-core/src/node/writer-client.ts          (mintShortCode)
//   docs/strategy/2026-08-31-multinode-regression-rca-and-geo-strategy.md §4-1
//
// ── THE DEFECT THIS FILE EXISTS FOR (measured 2026-08-31, dev-pc-a vs srvjp) ──
//
// `pc:refresh-code` was refused on a replica, and `pc:reconnect` deliberately was
// not. Both of those are individually correct, and together they produced a state
// nobody designed: a PC that lands on the Tokyo replica reconnects with its
// token, registers, transcribes, injects — and CAN NEVER ADD A PHONE AGAIN. A
// token reconnect leaves `short_code` null by construction, so the refused event
// is the only thing that can mint one. The desktop's 「add a phone」 modal sat on
// 「no valid pairing code yet」 forever, with no QR and no stated reason.
//
// ── WHAT MAKES THE ASSERTIONS HERE WORTH ANYTHING ───────────────────────────
//
//  ① TWO DATABASES, and the code is asserted in BOTH. 「An ack carried four
//     digits」 is not the claim — the claim is that those digits live on the
//     WRITER, where `resolvePcForPair` will look for them, and NOT on the
//     replica, where a locally-minted code would be erased by the next
//     replication pull and would meanwhile stamp a governor no phone ever asks.
//     A test that only read the ack would pass just as happily against the bug
//     this replaces (mint locally, look successful, evaporate).
//
//  ② THE CODE IS ACTUALLY REDEEMED. The last test pairs with it through
//     `resolvePcForPair` on the writer's registry — the same call a phone's
//     first contact makes. Four digits that cannot be redeemed are a code-shaped
//     lie, and only this assertion can tell the two apart.
//
//  ③ THE TWO HALVES SPEAK OVER THE REAL PROTOCOL. `makeWriterClient` is driven
//     against the REAL `makeNodeRoutes` handler through a fetch shim, so a
//     mismatch in path, method, header name, status semantics or body key fails
//     here. Hand-stubbing `mintCodeOnWriter` in every test would have proven the
//     handler and left the wire contract untested — which is where a
//     forwarding feature actually breaks.
//
//  ④ EVERY FAILURE PATH IS ASSERTED TO PRODUCE THE OLD REFUSAL, never a code.
//     The failure direction is the whole safety argument: an unreachable writer
//     must degrade to 「no code right now, reconnect」 (2026-08-30's behaviour,
//     visibly broken and already documented) and must never degrade to a code
//     that no node will honour.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server, Socket } from 'socket.io';
import { Readable } from 'node:stream';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';
import { makeWriterClient, WriterUnreachable } from '../src/node/writer-client';
import { makeWriterOnlyGuard, NODE_CAN_WRITE, type WriterOnlyGuard } from '../src/node/writer-only';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

const WRITER_URL = 'https://srvny.flowmic.app';
const SECRET = 'node-shared-secret-32-bytes-long!!';

// ── one node's worth of state ────────────────────────────────────────────────
interface Node {
  db: Db;
  registry: Registry;
  store: RoomStore;
}

function makeNode(): Node {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  return { db, registry: new Registry({ pcs: db.pcs, mobiles: db.mobiles }), store: new RoomStore() };
}

// ── the writer's HTTP side, as a fetch shim the real WriterClient can drive ──
//
// Not a mock of the route: the REAL handler, fed a real-enough request. The body
// has to be an async iterable because `readJsonBody` streams it — buffering it
// here would let a route that ignored the ceiling pass.
function fetchIntoRoutes(deps: NodeRoutesDeps): typeof fetch {
  const handler = makeNodeRoutes(deps);
  // `string | URL` rather than `RequestInfo`: this package's lib does not carry
  // the DOM's `RequestInfo`, and the production caller (writer-client.ts) only
  // ever passes a template-built string anyway.
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
          resolve(new Response(payload ?? '', {
            status,
            headers: { 'content-type': 'application/json' },
          }));
        },
      } as unknown as ServerResponse;
      const handled = handler(req, res);
      if (!handled) resolve(new Response('', { status: 404 }));
    });
  }) as typeof fetch;
}

// ── the replica's socket side ────────────────────────────────────────────────
interface FakeSocket {
  data: { auth: AuthContext | null };
  on(event: string, fn: (payload: unknown, ack: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  join(room: string): void;
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>>;
}

function fakeSocket(auth: AuthContext | null): FakeSocket {
  const handlers = new Map<string, (payload: unknown, ack: unknown) => void>();
  return {
    data: { auth },
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

const io = { sockets: { sockets: new Map() } } as unknown as Server;

function wirePc(
  node: Node,
  socket: FakeSocket,
  writerOnly: WriterOnlyGuard,
  mintCodeOnWriter?: PcMint,
): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    io,
    registry: node.registry,
    store: node.store as RoomStore<Socket>,
    resolveActingUser: () => ({ userId: socket.data.auth?.userId ?? 'default' }),
    writerOnly,
    ...(mintCodeOnWriter ? { mintCodeOnWriter } : {}),
  });
  return socket;
}

type PcMint = (pcId: string) => Promise<{ short_code: string; expires_in_ms: number | null } | null>;

let writer: Node;
let replica: Node;

/** Register a PC on the WRITER (as node_select.rs guarantees), then plant the
 *  same row on the REPLICA the way a replication pull would — code and all.
 *
 *  ⚠️ `pc_devices.short_code` is NOT NULL, which is worth stating because it is
 *  the thing that makes this defect invisible from the database: the row always
 *  carries SOME code. What is null after a token reconnect is the DESKTOP's copy
 *  (the reconnect ack carries no code — shell/connection.rs `PairingInfo`), and
 *  what decides whether the stored string still resolves is the writer's
 *  in-memory governor. So 「the replica has a code in its row」 answers neither
 *  「can this PC show one」 nor 「would it work」. */
function registerOnWriterAndReplicate(): { pcId: string; replicatedCode: string } {
  const { pc } = writer.registry.registerPc({ device_name: 'dev-pc-a', user_id: 'default' });
  replica.db.pcs.insert({
    id: pc.id,
    user_id: 'default',
    device_name: pc.device_name,
    room_uuid: pc.room_uuid,
    device_token: pc.device_token,
    short_code: pc.short_code,
  });
  return { pcId: pc.id, replicatedCode: pc.short_code };
}

beforeEach(() => {
  writer = makeNode();
  replica = makeNode();
});
afterEach(() => {
  writer.db.close();
  replica.db.close();
});

describe('a replica gets its PC a pairing code from the writer', () => {
  /** The production wiring, end to end: replica socket → WriterClient → the real
   *  writer route → the writer's own registry. */
  function productionMint(): PcMint {
    const client = makeWriterClient({
      writerUrl: WRITER_URL,
      sharedSecret: SECRET,
      nodeId: 'srvjp',
      fetchImpl: fetchIntoRoutes({
        nodeId: 'srvny',
        version: '0.3.51',
        sharedSecret: SECRET,
        mintShortCode: (pcId) => {
          if (!writer.db.pcs.findById(pcId)) return null;
          return {
            short_code: writer.registry.refreshShortCode(pcId),
            expires_in_ms: writer.registry.shortCodeExpiresInMs(pcId),
          };
        },
      }),
    });
    return (pcId) => client.mintShortCode(pcId);
  }

  it('mints on the WRITER — the ack carries the code and the writer holds it', async () => {
    const { pcId } = registerOnWriterAndReplicate();
    const socket = wirePc(
      replica,
      fakeSocket({ userId: 'default', deviceId: pcId, kind: 'pc' } as AuthContext),
      makeWriterOnlyGuard(WRITER_URL),
      productionMint(),
    );

    const ack = await socket.invoke('pc:refresh-code', {});

    expect(ack.error).toBeUndefined();
    expect(String(ack.short_code)).toMatch(/^\d{4}$/);
    // ① WHERE the code lives is the claim, not that an ack existed.
    expect(writer.db.pcs.findById(pcId)?.short_code).toBe(ack.short_code);
    // …and the TTL came from the writer's governor, not from a second author.
    expect(typeof ack.expires_in_ms).toBe('number');
    expect(ack.expires_in_ms as number).toBeGreaterThan(0);
  });

  it('does NOT write the code into the replica — that copy dies at the next pull', async () => {
    const { pcId, replicatedCode } = registerOnWriterAndReplicate();
    const socket = wirePc(
      replica,
      fakeSocket({ userId: 'default', deviceId: pcId, kind: 'pc' } as AuthContext),
      makeWriterOnlyGuard(WRITER_URL),
      productionMint(),
    );

    const ack = await socket.invoke('pc:refresh-code', {});

    expect(String(ack.short_code)).toMatch(/^\d{4}$/);
    expect(ack.short_code).not.toBe(replicatedCode);
    // 🔴 The negative half of ①. A local mint would satisfy every other
    // assertion in the previous test and still be the bug: the replica's row is
    // UNTOUCHED, still holding whatever the last replication pull gave it.
    expect(replica.db.pcs.findById(pcId)?.short_code).toBe(replicatedCode);
  });

  it('② the code is REDEEMABLE where a phone will present it', async () => {
    const { pcId } = registerOnWriterAndReplicate();
    const socket = wirePc(
      replica,
      fakeSocket({ userId: 'default', deviceId: pcId, kind: 'pc' } as AuthContext),
      makeWriterOnlyGuard(WRITER_URL),
      productionMint(),
    );

    const ack = await socket.invoke('pc:refresh-code', {});

    // The same call a phone's first contact makes on the writer (role:'writer').
    const resolved = writer.registry.resolvePcForPair({ short_code: String(ack.short_code) });
    expect(resolved.id).toBe(pcId);

    // Negative control: the replica cannot resolve it, which is exactly why the
    // mint had to go to the writer rather than stay here.
    expect(() => replica.registry.resolvePcForPair({ short_code: String(ack.short_code) })).toThrow();
  });

  it('a writer that cannot be reached yields the REFUSAL, never a code', async () => {
    const { pcId } = registerOnWriterAndReplicate();
    const socket = wirePc(
      replica,
      fakeSocket({ userId: 'default', deviceId: pcId, kind: 'pc' } as AuthContext),
      makeWriterOnlyGuard(WRITER_URL),
      () => Promise.reject(new WriterUnreachable('ECONNRESET')),
    );

    const ack = await socket.invoke('pc:refresh-code', {});

    expect(ack.error).toBe('NODE_IS_REPLICA');
    expect(ack.writer).toBe(WRITER_URL);
    expect(ack.short_code).toBeUndefined();
  });

  it('a writer that does not know this PC yields the REFUSAL, never a code', async () => {
    const { pcId } = registerOnWriterAndReplicate();
    const socket = wirePc(
      replica,
      fakeSocket({ userId: 'default', deviceId: pcId, kind: 'pc' } as AuthContext),
      makeWriterOnlyGuard(WRITER_URL),
      () => Promise.resolve(null),
    );

    const ack = await socket.invoke('pc:refresh-code', {});

    expect(ack.error).toBe('NODE_IS_REPLICA');
    expect(ack.short_code).toBeUndefined();
  });

  it('with NO forwarder wired, the pre-2026-08-31 refusal stands', async () => {
    const { pcId } = registerOnWriterAndReplicate();
    const socket = wirePc(
      replica,
      fakeSocket({ userId: 'default', deviceId: pcId, kind: 'pc' } as AuthContext),
      makeWriterOnlyGuard(WRITER_URL),
    );

    const ack = await socket.invoke('pc:refresh-code', {});

    // A forgotten wiring degrades to 「visibly broken, already documented」 and
    // never to 「silently minted somewhere it will not survive」.
    expect(ack.error).toBe('NODE_IS_REPLICA');
  });

  it('an unauthenticated socket is told AUTH_TOKEN_INVALID, on a replica too', async () => {
    // The ordering change this card made: the refusal used to be returned BEFORE
    // the auth check, so a replica answered NODE_IS_REPLICA to anyone. Forwarding
    // needs a device id, and 「who are you」 was always the better first question.
    const socket = wirePc(
      replica,
      fakeSocket(null),
      makeWriterOnlyGuard(WRITER_URL),
      productionMint(),
    );

    const ack = await socket.invoke('pc:refresh-code', {});

    expect(ack.error).toBe('AUTH_TOKEN_INVALID');
  });

  it('③ negative control: a node that CAN write still mints locally', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'PC', user_id: 'default' });
    const before = writer.db.pcs.findById(pc.id)?.short_code;
    const socket = wirePc(
      writer,
      fakeSocket({ userId: 'default', deviceId: pc.id, kind: 'pc' } as AuthContext),
      NODE_CAN_WRITE,
      // Wired ON PURPOSE and asserted UNUSED: `writerOnly` is what decides, and a
      // writer that started forwarding to itself would be a loop nobody notices.
      () => Promise.reject(new Error('a writer must never forward its own mint')),
    );

    const ack = await socket.invoke('pc:refresh-code', {});

    expect(String(ack.short_code)).toMatch(/^\d{4}$/);
    expect(ack.short_code).not.toBe(before);
    expect(writer.db.pcs.findById(pc.id)?.short_code).toBe(ack.short_code);
  });
});

describe('POST /api/node/mint-code — the writer half on its own', () => {
  const routeDeps = (over: Partial<NodeRoutesDeps> = {}): NodeRoutesDeps => ({
    nodeId: 'srvny',
    version: '0.3.51',
    sharedSecret: SECRET,
    mintShortCode: (pcId) => {
      if (!writer.db.pcs.findById(pcId)) return null;
      return {
        short_code: writer.registry.refreshShortCode(pcId),
        expires_in_ms: writer.registry.shortCodeExpiresInMs(pcId),
      };
    },
    ...over,
  });

  async function post(deps: NodeRoutesDeps, body: unknown, headers: Record<string, string>, method = 'POST') {
    const res = await fetchIntoRoutes(deps)('https://srvny.flowmic.app/api/node/mint-code', {
      method,
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const auth = { 'x-flowmic-node-secret': SECRET, 'x-flowmic-node-id': 'srvjp' };

  it('mints for a known PC', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'PC', user_id: 'default' });
    const r = await post(routeDeps(), { pc_id: pc.id }, auth);
    expect(r.status).toBe(200);
    expect(String(r.body.short_code)).toMatch(/^\d{4}$/);
    expect(writer.db.pcs.findById(pc.id)?.short_code).toBe(r.body.short_code);
  });

  it('404s for a PC it does not have — and that is a FACT, not a failure', async () => {
    const r = await post(routeDeps(), { pc_id: 'pc-that-never-registered' }, auth);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('pc_unknown');
  });

  it('400s with no pc_id', async () => {
    const r = await post(routeDeps(), {}, auth);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('pc_id_required');
  });

  it('403s on a wrong secret, and says nothing about which half was wrong', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'PC', user_id: 'default' });
    const before = writer.db.pcs.findById(pc.id)?.short_code;
    const r = await post(routeDeps(), { pc_id: pc.id }, { ...auth, 'x-flowmic-node-secret': 'wrong' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
    // No code was minted as a side effect of being refused.
    expect(writer.db.pcs.findById(pc.id)?.short_code).toBe(before);
  });

  it('403s on NO secret at all — this route is never open', async () => {
    const r = await post(routeDeps(), { pc_id: 'x' }, { 'x-flowmic-node-id': 'srvjp' });
    expect(r.status).toBe(403);
  });

  it('501s where no mint is configured — i.e. on a replica', async () => {
    const r = await post(routeDeps({ mintShortCode: undefined }), { pc_id: 'x' }, auth);
    expect(r.status).toBe(501);
    expect(r.body.error).toBe('mint_not_configured');
  });

  it('405s a GET: minting is a write and must not be reachable by a link', async () => {
    const r = await post(routeDeps(), { pc_id: 'x' }, auth, 'GET');
    expect(r.status).toBe(405);
  });
});
