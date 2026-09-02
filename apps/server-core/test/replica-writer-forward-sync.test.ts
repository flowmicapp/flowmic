// SPEC-REF:
//   apps/server-core/src/node/forward-sync.ts        (the writer-side dispatch)
//   apps/server-core/src/node/forward-sync-types.ts  (the per-verb shapes)
//   apps/server-core/src/http/node-routes.ts          (POST /api/node/forward-sync)
//   apps/server-core/src/node/writer-client.ts        (forwardSync — the client)
//   apps/server-core/src/socket/handlers/pc.handler.ts       (pc:release-mobile)
//   apps/server-core/src/socket/handlers/mobile.handler.ts   (mobile:unpair)
//   apps/server-core/src/socket/handlers/settings.handler.ts (settings:update)
//   docs/strategy/2026-09-02-full-implementation-audit-and-next-plan.md
//     §5-4 item 2, §3-B B4/B5/B6
//
// ── THE DEFECT THIS FILE EXISTS FOR (measured 2026-09-02) ───────────────────
//
// Before the generic handoff, a PC or phone on a replica could never
// disconnect/revoke a pairing, retire its own pairing, or persist a setting
// (including a PC's own name) — every one of those was refused with
// `NODE_IS_REPLICA`, and where a write DID sneak through locally (there was
// none here — these three were fully refused, unlike `pc:reconnect`'s "lost"
// writes) the user would have watched the change revert at the next pull.
//
// Same evidentiary bar `replica-code-mint-forwarding.test.ts` set for the first
// two forwarded verbs, and reused here for the same reason:
//  ① TWO DATABASES, and every mutation is asserted in BOTH — a test that only
//     read the ack would pass just as happily against "mint/write locally,
//     look successful, evaporate at the next pull".
//  ② THE TWO HALVES SPEAK OVER THE REAL PROTOCOL: `makeWriterClient` driven
//     against the REAL `makeNodeRoutes` handler through a fetch shim, so a
//     mismatch in path, verb string, status code or body key fails here.
//  ③ EVERY FAILURE PATH degrades to the OLD refusal, never to a fabricated
//     success — an unreachable writer, a writer that refuses (structural
//     mismatch), and no forwarder wired all end at `NODE_IS_REPLICA`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server, Socket } from 'socket.io';
import { Readable } from 'node:stream';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { registerSettingsHandlers } from '../src/socket/handlers/settings.handler';
import { PC_NAME_KEY } from '../src/socket/handlers/settings.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { ReleaseSuppression, RELEASE_SUPPRESS_MS, BUSY_SUPPRESS_MS } from '../src/room/release-suppression';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';
import { makeWriterClient, WriterUnreachable, type ForwardSyncOutcome } from '../src/node/writer-client';
import { makeForwardSyncDispatcher } from '../src/node/forward-sync';
import {
  isReleaseMobileResult, isSettingsUpdateResult, isUnpairMobileResult,
  type SettingsUpdateRequest,
} from '../src/node/forward-sync-types';
import { makeWriterOnlyGuard, NODE_CAN_WRITE, type WriterOnlyGuard } from '../src/node/writer-only';
import type { AuthContext } from '../src/auth/middleware';

type Db = ReturnType<typeof createDbConnection>;

const WRITER_URL = 'https://srvny.flowmic.app';
const SECRET = 'node-shared-secret-32-bytes-long!!';

interface Node {
  db: Db;
  registry: Registry;
  store: RoomStore<Socket>;
  suppression: ReleaseSuppression;
}

function makeNode(): Node {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  return {
    db,
    registry: new Registry({ pcs: db.pcs, mobiles: db.mobiles }),
    store: new RoomStore<Socket>(),
    suppression: new ReleaseSuppression(),
  };
}

// ── the writer's HTTP side, as a fetch shim the real WriterClient can drive ──
// VERBATIM pattern from replica-code-mint-forwarding.test.ts — the REAL route
// handler, fed a real-enough request/response pair.
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
      const handled = handler(req, res);
      if (!handled) resolve(new Response('', { status: 404 }));
    });
  }) as typeof fetch;
}

interface FakeSocket {
  data: { auth: AuthContext | null; roomUuid?: string };
  id: string;
  emitted: { event: string; payload: unknown }[];
  connected: boolean;
  on(event: string, fn: (payload: unknown, ack: unknown) => void): void;
  emit(event: string, payload: unknown): void;
  disconnect(close?: boolean): void;
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>>;
}

function fakeSocket(id: string, auth: AuthContext | null, roomUuid?: string): FakeSocket {
  const handlers = new Map<string, (payload: unknown, ack: unknown) => void>();
  const s: FakeSocket = {
    data: { auth, ...(roomUuid ? { roomUuid } : {}) },
    id,
    emitted: [],
    connected: true,
    on(event, fn) { handlers.set(event, fn); },
    emit(event, payload) { s.emitted.push({ event, payload }); },
    disconnect() { s.connected = false; },
    invoke(event, payload) {
      return new Promise((resolve) => {
        const h = handlers.get(event);
        if (!h) return resolve({ __no_handler: true });
        h(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
      });
    },
  };
  return s;
}

const io = { sockets: { sockets: new Map() } } as unknown as Server;

let writer: Node;
let replica: Node;

beforeEach(() => {
  writer = makeNode();
  replica = makeNode();
});
afterEach(() => {
  writer.db.close();
  replica.db.close();
});

/** The production wiring for all three verbs, end to end: replica socket →
 *  WriterClient → the real writer route → the writer's real dispatch table. */
function productionForwardSync(): (verb: string, payload: Record<string, unknown>) => Promise<ForwardSyncOutcome> {
  const client = makeWriterClient({
    writerUrl: WRITER_URL,
    sharedSecret: SECRET,
    nodeId: 'srvjp',
    fetchImpl: fetchIntoRoutes({
      nodeId: 'srvny',
      version: '0.3.56',
      sharedSecret: SECRET,
      forwardSync: makeForwardSyncDispatcher({
        registry: writer.registry,
        repo: writer.db.settings,
        suppression: writer.suppression,
      }),
    }),
  });
  return (verb, payload) => client.forwardSync(verb, payload);
}

function forwardReleaseMobileVia(fwd: ReturnType<typeof productionForwardSync>) {
  return async (req: {
    pc_id: string; user_id: string; room_uuid: string; revoke: boolean;
    reason: 'manual' | 'busy'; mobile_id?: string;
  }) => {
    const outcome = await fwd('release_mobile', req);
    if (outcome.status !== 'ok' || !isReleaseMobileResult(outcome.result)) {
      return { status: 'refused' as const, error: outcome.status === 'refused' ? outcome.error : 'bad_shape' };
    }
    return { status: 'ok' as const, result: outcome.result };
  };
}

function forwardUnpairMobileVia(fwd: ReturnType<typeof productionForwardSync>) {
  return async (pairingId: string) => {
    const outcome = await fwd('unpair_mobile', { pairing_id: pairingId });
    if (outcome.status !== 'ok' || !isUnpairMobileResult(outcome.result)) {
      return { status: 'refused' as const, error: outcome.status === 'refused' ? outcome.error : 'bad_shape' };
    }
    return { status: 'ok' as const, result: outcome.result };
  };
}

function forwardSettingsUpdateVia(fwd: ReturnType<typeof productionForwardSync>) {
  return async (req: SettingsUpdateRequest) => {
    const outcome = await fwd('settings_update', { ...req });
    if (outcome.status !== 'ok' || !isSettingsUpdateResult(outcome.result)) {
      return { status: 'refused' as const, error: outcome.status === 'refused' ? outcome.error : 'bad_shape' };
    }
    return { status: 'ok' as const, result: outcome.result };
  };
}

// ═════════════════════════════════════ B5 — pc:release-mobile ══════════════

describe('pc:release-mobile forwarded from a replica (B5)', () => {
  function wirePc(writerOnlyGuard: WriterOnlyGuard, forwardReleaseMobile?: ReturnType<typeof forwardReleaseMobileVia>) {
    const s = fakeSocket('sock-pc', { userId: 'default', deviceId: '', kind: 'pc' });
    registerPcHandlers(s as unknown as Socket, {
      io, registry: replica.registry, store: replica.store,
      resolveActingUser: () => ({ userId: 'default' }),
      writerOnly: writerOnlyGuard,
      ...(forwardReleaseMobile ? { forwardReleaseMobile } : {}),
    });
    return s;
  }

  /** A PC registered on the writer, replicated to the replica, with a phone
   *  paired on the writer and ALSO replicated — and the phone's LIVE socket
   *  joined on the REPLICA (the node it is actually connected to). */
  function fixture() {
    const { pc } = writer.registry.registerPc({ device_name: 'dev-pc-a', user_id: 'default' });
    const paired = writer.registry.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel', user_id: 'default' });
    replica.db.pcs.insert({
      id: pc.id, user_id: 'default', device_name: pc.device_name, room_uuid: pc.room_uuid,
      device_token: pc.device_token, short_code: pc.short_code,
    });
    replica.db.mobiles.insert({
      id: paired.mobile.id, user_id: 'default', pc_device_id: pc.id, mobile_token: paired.token, mobile_name: 'Pixel',
    });
    const mobileSock = fakeSocket('sock-mobile', { userId: 'default', pairingId: paired.mobile.id, kind: 'mobile' });
    replica.store.joinMobile(pc.room_uuid, paired.mobile.id, mobileSock as unknown as Socket);
    return { pc, paired, mobileSock };
  }

  it('disconnect (revoke:false) suppresses on the WRITER and disconnects the LOCAL socket', async () => {
    const { pc, paired, mobileSock } = fixture();
    const fwd = productionForwardSync();
    const socket = wirePc(makeWriterOnlyGuard(WRITER_URL), forwardReleaseMobileVia(fwd));
    socket.data.auth = { userId: 'default', deviceId: pc.id, kind: 'pc' };
    socket.data.roomUuid = pc.room_uuid;

    const ack = await socket.invoke('pc:release-mobile', { mobile_id: paired.mobile.id });

    expect(ack).toMatchObject({ ok: true, released: 1, revoked: 0, suppressed_ms: RELEASE_SUPPRESS_MS });
    expect(mobileSock.connected).toBe(false);
    expect(mobileSock.emitted).toContainEqual({
      event: 'mobile:released',
      payload: { retry_after_ms: RELEASE_SUPPRESS_MS, revoked: false },
    });
    // ① the mutation is on the WRITER, not fabricated by the replica.
    expect(writer.suppression.reasonFor(paired.mobile.id)).toBe('manual');
    // …and the pairing ROW is untouched (a disconnect is not a revoke).
    expect(writer.db.mobiles.findById(paired.mobile.id)).not.toBeNull();
  });

  it('a `busy` release uses the shorter window — the reason travels intact', async () => {
    const { pc, paired } = fixture();
    const fwd = productionForwardSync();
    const socket = wirePc(makeWriterOnlyGuard(WRITER_URL), forwardReleaseMobileVia(fwd));
    socket.data.auth = { userId: 'default', deviceId: pc.id, kind: 'pc' };
    socket.data.roomUuid = pc.room_uuid;

    const ack = await socket.invoke('pc:release-mobile', { mobile_id: paired.mobile.id, reason: 'busy' });

    expect(ack).toMatchObject({ suppressed_ms: BUSY_SUPPRESS_MS });
    expect(writer.suppression.reasonFor(paired.mobile.id)).toBe('busy');
  });

  it('revoke DELETES the row on the WRITER — and does NOT touch the replica copy', async () => {
    const { pc, paired } = fixture();
    const fwd = productionForwardSync();
    const socket = wirePc(makeWriterOnlyGuard(WRITER_URL), forwardReleaseMobileVia(fwd));
    socket.data.auth = { userId: 'default', deviceId: pc.id, kind: 'pc' };
    socket.data.roomUuid = pc.room_uuid;

    const ack = await socket.invoke('pc:release-mobile', { mobile_id: paired.mobile.id, revoke: true });

    expect(ack).toMatchObject({ ok: true, released: 1, revoked: 1 });
    // ① again: the writer's row is gone…
    expect(writer.db.mobiles.findById(paired.mobile.id)).toBeNull();
    // …but the replica's copy of the OLD row is UNTOUCHED — it dies at the next
    // pull, not by this handler reaching into a database it must not write.
    expect(replica.db.mobiles.findById(paired.mobile.id)).not.toBeNull();
  });

  it('an unreachable writer yields the REFUSAL, never a fabricated ok', async () => {
    const { pc, paired } = fixture();
    const socket = wirePc(
      makeWriterOnlyGuard(WRITER_URL),
      () => Promise.reject(new WriterUnreachable('ECONNRESET')) as never,
    );
    socket.data.auth = { userId: 'default', deviceId: pc.id, kind: 'pc' };
    socket.data.roomUuid = pc.room_uuid;
    // forwardReleaseMobileVia wraps rejects into `.catch` inside the handler,
    // so pass a raw forwarder that itself throws to exercise that path.
    (socket as unknown as { __x?: unknown }).__x = paired;

    const ack = await socket.invoke('pc:release-mobile', { mobile_id: paired.mobile.id });

    expect(ack).toMatchObject({ error: 'NODE_IS_REPLICA', writer: WRITER_URL });
    expect(ack.released).toBeUndefined();
  });

  it('with NO forwarder wired, the pre-existing refusal stands', async () => {
    const { pc, paired } = fixture();
    const socket = wirePc(makeWriterOnlyGuard(WRITER_URL));
    socket.data.auth = { userId: 'default', deviceId: pc.id, kind: 'pc' };
    socket.data.roomUuid = pc.room_uuid;

    const ack = await socket.invoke('pc:release-mobile', { mobile_id: paired.mobile.id });

    expect(ack).toMatchObject({ error: 'NODE_IS_REPLICA' });
  });

  it('negative control: a node that CAN write still mutates locally, never forwards', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'PC', user_id: 'default' });
    const paired = writer.registry.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel', user_id: 'default' });
    const mobileSock = fakeSocket('m', { userId: 'default', pairingId: paired.mobile.id, kind: 'mobile' });
    writer.store.joinMobile(pc.room_uuid, paired.mobile.id, mobileSock as unknown as Socket);
    const socket = fakeSocket('pc', { userId: 'default', deviceId: pc.id, kind: 'pc' }, pc.room_uuid);
    registerPcHandlers(socket as unknown as Socket, {
      io, registry: writer.registry, store: writer.store,
      resolveActingUser: () => ({ userId: 'default' }),
      writerOnly: NODE_CAN_WRITE,
      // Wired ON PURPOSE and asserted UNUSED — a writer must never forward to itself.
      forwardReleaseMobile: () => Promise.reject(new Error('a writer must never forward its own release')),
    });

    const ack = await socket.invoke('pc:release-mobile', { mobile_id: paired.mobile.id, revoke: true });

    expect(ack).toMatchObject({ ok: true, revoked: 1 });
    expect(writer.db.mobiles.findById(paired.mobile.id)).toBeNull();
  });
});

// ═════════════════════════════════════ B4 — mobile:unpair ══════════════════

describe('mobile:unpair forwarded from a replica (B4)', () => {
  function wireMobile(forwardUnpairMobile?: ReturnType<typeof forwardUnpairMobileVia>) {
    const s = fakeSocket('sock-mobile', null);
    registerMobileHandlers(s as unknown as Socket, {
      io, registry: replica.registry, store: replica.store,
      pairLimiter: new PairRateLimiter({}),
      mode: 'standalone',
      resolveActingUser: () => ({ userId: 'default' }),
      suppression: replica.suppression,
      writerOnly: makeWriterOnlyGuard(WRITER_URL),
      restriction: { getUser: (id) => replica.db.users.findById(id) },
      ...(forwardUnpairMobile ? { forwardUnpairMobile } : {}),
    });
    return s;
  }

  function fixture() {
    const { pc } = writer.registry.registerPc({ device_name: 'dev-pc-a', user_id: 'default' });
    const paired = writer.registry.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel', user_id: 'default' });
    replica.db.pcs.insert({
      id: pc.id, user_id: 'default', device_name: pc.device_name, room_uuid: pc.room_uuid,
      device_token: pc.device_token, short_code: pc.short_code,
    });
    replica.db.mobiles.insert({
      id: paired.mobile.id, user_id: 'default', pc_device_id: pc.id, mobile_token: paired.token, mobile_name: 'Pixel',
    });
    return { pc, paired };
  }

  it('retires the row on the WRITER, and tells the LOCALLY-connected PC', async () => {
    const { pc, paired } = fixture();
    const pcSock = fakeSocket('sock-pc-local', { userId: 'default', deviceId: pc.id, kind: 'pc' });
    replica.store.joinPc(pc.room_uuid, pcSock as unknown as Socket);

    const fwd = productionForwardSync();
    const socket = wireMobile(forwardUnpairMobileVia(fwd));
    socket.data.auth = { userId: 'default', pairingId: paired.mobile.id, kind: 'mobile' };

    const ack = await socket.invoke('mobile:unpair', {});

    expect(ack).toMatchObject({ ok: true });
    // ① the row is gone on the WRITER…
    expect(writer.db.mobiles.findById(paired.mobile.id)).toBeNull();
    // …and the LOCALLY-connected PC (this node's own room) was told, even
    // though the mutation itself happened on a different machine.
    expect(pcSock.emitted).toContainEqual({ event: 'pc:mobile-left', payload: { mobile_id: paired.mobile.id } });
  });

  it('an already-retired pairing is idempotent — ok:true, no crash, no local emit', async () => {
    const { paired } = fixture();
    writer.registry.retireMobile(paired.mobile.id);
    const fwd = productionForwardSync();
    const socket = wireMobile(forwardUnpairMobileVia(fwd));
    socket.data.auth = { userId: 'default', pairingId: paired.mobile.id, kind: 'mobile' };

    const ack = await socket.invoke('mobile:unpair', {});

    expect(ack).toMatchObject({ ok: true });
  });

  it('an unreachable writer yields the REFUSAL, never a fabricated ok', async () => {
    const { paired } = fixture();
    const socket = wireMobile(() => Promise.reject(new WriterUnreachable('ECONNRESET')) as never);
    socket.data.auth = { userId: 'default', pairingId: paired.mobile.id, kind: 'mobile' };

    const ack = await socket.invoke('mobile:unpair', {});

    expect(ack).toMatchObject({ error: 'NODE_IS_REPLICA' });
  });

  it('with NO forwarder wired, the pre-existing refusal stands', async () => {
    const { paired } = fixture();
    const socket = wireMobile();
    socket.data.auth = { userId: 'default', pairingId: paired.mobile.id, kind: 'mobile' };

    const ack = await socket.invoke('mobile:unpair', {});

    expect(ack).toMatchObject({ error: 'NODE_IS_REPLICA' });
  });
});

// ═════════════════════════════════════ B6 — settings:update ════════════════

describe('settings:update forwarded from a replica (B6)', () => {
  function wireSettings(forwardSettingsUpdate?: ReturnType<typeof forwardSettingsUpdateVia>) {
    const s = fakeSocket('sock-settings', null);
    registerSettingsHandlers(s as unknown as Socket, {
      io, repo: replica.db.settings, registry: replica.registry, store: replica.store,
      writerOnly: makeWriterOnlyGuard(WRITER_URL),
      ...(forwardSettingsUpdate ? { forwardSettingsUpdate } : {}),
    });
    return s;
  }

  function pcFixture() {
    const { pc } = writer.registry.registerPc({ device_name: 'dev-pc-a', user_id: 'default' });
    replica.db.pcs.insert({
      id: pc.id, user_id: 'default', device_name: pc.device_name, room_uuid: pc.room_uuid,
      device_token: pc.device_token, short_code: pc.short_code,
    });
    return pc;
  }

  it('PC_NAME_KEY: renames on the WRITER and fans out to local peers', async () => {
    const pc = pcFixture();
    const mobileSock = fakeSocket('m', { userId: 'default', pairingId: 'p1', kind: 'mobile' });
    replica.store.joinMobile(pc.room_uuid, 'p1', mobileSock as unknown as Socket);
    const peerPc = fakeSocket('peer', { userId: 'default', deviceId: 'other-pc', kind: 'pc' });
    (io.sockets.sockets as Map<string, unknown>).set('peer', peerPc);

    const fwd = productionForwardSync();
    const socket = wireSettings(forwardSettingsUpdateVia(fwd));
    socket.data.auth = { userId: 'default', deviceId: pc.id, kind: 'pc' };

    const ack = await socket.invoke('settings:update', { key: PC_NAME_KEY, value: { pc_name: 'New Name' } });

    expect(ack).toMatchObject({ ok: true });
    // ① the WRITER's row changed…
    expect(writer.db.pcs.findById(pc.id)?.device_name).toBe('New Name');
    // …the local phone in this PC's room heard it…
    expect(mobileSock.emitted).toContainEqual({
      event: 'settings:updated',
      payload: { key: PC_NAME_KEY, value: { pc_id: pc.id, pc_name: 'New Name' } },
    });
    // …and so did the peer PC socket (broadcastUpdated, account-wide).
    expect(peerPc.emitted).toContainEqual({
      event: 'settings:updated',
      payload: { key: PC_NAME_KEY, value: { pc_id: pc.id, pc_name: 'New Name' } },
    });
    (io.sockets.sockets as Map<string, unknown>).delete('peer');
  });

  it('PC_NAME_KEY from a MOBILE socket is refused — the writer enforces the same rule', async () => {
    const pc = pcFixture();
    const fwd = productionForwardSync();
    const socket = wireSettings(forwardSettingsUpdateVia(fwd));
    socket.data.auth = { userId: 'default', pairingId: 'p1', kind: 'mobile' };

    const ack = await socket.invoke('settings:update', { key: PC_NAME_KEY, value: { pc_name: 'Nope' } });

    expect(ack).toMatchObject({ error: 'AUTH_TOKEN_INVALID' });
    expect(writer.db.pcs.findById(pc.id)?.device_name).toBe('dev-pc-a');
  });

  it('an ordinary KV write lands on the WRITER, not on the replica copy', async () => {
    pcFixture();
    const fwd = productionForwardSync();
    const socket = wireSettings(forwardSettingsUpdateVia(fwd));
    socket.data.auth = { userId: 'default', deviceId: 'irrelevant', kind: 'pc' };

    const ack = await socket.invoke('settings:update', { key: 'stt.polish', value: { enabled: true } });

    expect(ack).toMatchObject({ ok: true });
    expect(writer.db.settings.read('default', 'stt.polish')?.value).toEqual({ enabled: true });
    expect(replica.db.settings.read('default', 'stt.polish')).toBeNull();
  });

  it('G2 regress: the OLDER write is refused and the LOSER (this socket) is told', async () => {
    pcFixture();
    writer.db.settings.write('default', 'stt.polish', { enabled: true }, '2026-09-02T12:00:00.000Z');

    const fwd = productionForwardSync();
    const socket = wireSettings(forwardSettingsUpdateVia(fwd));
    socket.data.auth = { userId: 'default', deviceId: 'irrelevant', kind: 'pc' };

    const ack = await socket.invoke('settings:update', {
      key: 'stt.polish', value: { enabled: false }, updated_at: '2026-09-02T11:00:00.000Z',
    });

    expect(ack).toMatchObject({ ok: true });
    // The write did NOT land — the writer's newer value survives.
    expect(writer.db.settings.read('default', 'stt.polish')?.value).toEqual({ enabled: true });
    // The loser (this very socket) was told the winner, not left believing its
    // stale value is now authoritative.
    expect(socket.emitted).toContainEqual({
      event: 'settings:updated',
      payload: { key: 'stt.polish', value: { enabled: true }, updated_at: '2026-09-02T12:00:00.000Z' },
    });
  });

  it('an unreachable writer yields the REFUSAL, never a fabricated ok', async () => {
    pcFixture();
    const socket = wireSettings(() => Promise.reject(new WriterUnreachable('ECONNRESET')) as never);
    socket.data.auth = { userId: 'default', deviceId: 'irrelevant', kind: 'pc' };

    const ack = await socket.invoke('settings:update', { key: 'stt.polish', value: { enabled: true } });

    expect(ack).toMatchObject({ error: 'NODE_IS_REPLICA' });
  });

  it('with NO forwarder wired, the pre-existing refusal stands', async () => {
    pcFixture();
    const socket = wireSettings();
    socket.data.auth = { userId: 'default', deviceId: 'irrelevant', kind: 'pc' };

    const ack = await socket.invoke('settings:update', { key: 'stt.polish', value: { enabled: true } });

    expect(ack).toMatchObject({ error: 'NODE_IS_REPLICA' });
  });
});
