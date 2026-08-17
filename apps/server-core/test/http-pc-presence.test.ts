// RV-98 / card B4-14 — GET /api/pc/presence.
//
// owner 2026-08-01: "the PC is actually online, this display is wrong; it must correctly show whether the PC side is online".
//
// book 15 §1.4.1 is the contract. What these cases pin, in order of how much it
// would cost to get wrong:
//   ① the ANSWER tracks the room, in both directions (a test that only proves
//      `true` passes just as happily against `pc_online: () => true`);
//   ② the CREDENTIAL is required, and a token nobody owns is refused the same way
//      a missing one is;
//   ③ 🔴 one phone's token can NEVER be answered about another phone's PC — the
//      structural half of never-mix-up-IDs, asserted as "the pc_id that comes back is
//      the caller's own」 rather than as 「the route rejects a pc_id parameter」,
//      because there IS no such parameter to reject;
//   ④ the lookup writes NOTHING (no last_seen_at), which is what stops this poll
//      from turning that column into a second answer to a different question;
//   ⑤ it is mounted in BOTH modes — the relay is the deployment that needs it.

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { makeHttpHandler } from '../src/http/router';
import { makeResolveUserId } from '../src/http/account-auth';
import { PC_PRESENCE_PATH, PRESENCE_AUTH_REQUIRED, tryHandlePresenceRoutes } from '../src/http/presence-routes';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { createDbConnection } from '../src/db/connection';
import type { DbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';

function request(method: string, url: string, token?: string): IncomingMessage {
  const stream = Readable.from([]);
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  (req as { headers: Record<string, string> }).headers =
    token === undefined ? {} : { authorization: `Bearer ${token}` };
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

/** A real Registry over a real in-memory DB + a real RoomStore, with two PCs each
 *  owning one phone. Fakes would let the two 「is it in the room」 answers drift;
 *  the point of this route is that there is only one. */
function world() {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'u1', display_name: 'U1', plan: 'free' });
  const registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  const store = new RoomStore<{ id: string }>();

  const mk = (name: string, instance: string) => {
    const { pc } = registry.registerPc({ device_name: name, user_id: 'u1', client_instance_id: instance });
    const pair = registry.pairMobile({ short_code: pc.short_code, mobile_name: `${name} phone`, user_id: 'u1' });
    return { pc: pair.pc, token: pair.token, mobileId: pair.mobile.id };
  };
  return { db, registry, store, a: mk('PC-A', 'inst-a-000000000000'), b: mk('PC-B', 'inst-b-000000000000') };
}

function ask(
  deps: { db: DbConnection; registry: Registry; store: RoomStore<{ id: string }> },
  token?: string,
  method = 'GET',
) {
  const { res, read } = response();
  const handled = tryHandlePresenceRoutes(
    request(method, PC_PRESENCE_PATH, token),
    res,
    // `pcs` is the C9 cross-account read. The REAL repo, not a stub: the point of
    // this world is that the two 「is it in the room」 answers cannot drift.
    { registry: deps.registry, store: deps.store as unknown as RoomStore, pcs: deps.db.pcs },
  );
  return { handled, ...read() };
}

describe('GET /api/pc/presence — "is the PC I paired with there"', () => {
  it('① answers the room, in BOTH directions', () => {
    const w = world();

    // Nobody in the room yet.
    expect(ask(w, w.a.token)).toMatchObject({ status: 200, body: { ok: true, pc_online: false } });

    // The desktop's socket arrives.
    w.store.joinPc(w.a.pc.room_uuid, { id: 'sock-pc-a' });
    expect(ask(w, w.a.token)).toMatchObject({ status: 200, body: { ok: true, pc_online: true } });

    // …and leaves again. THIS is the direction owner's screenshot was about, and
    // the one an implementation that hard-codes 「reachable ⇒ online」 gets wrong.
    w.store.leavePc(w.a.pc.room_uuid, 'sock-pc-a');
    expect(ask(w, w.a.token)).toMatchObject({ status: 200, body: { ok: true, pc_online: false } });
  });

  it('② refuses with no token, and refuses an unknown token the SAME way', () => {
    const w = world();
    const none = ask(w, undefined);
    const bogus = ask(w, 'fm_' + 'f'.repeat(64));
    expect(none).toMatchObject({ status: 401, body: { ok: false, error: PRESENCE_AUTH_REQUIRED } });
    // Identical: telling 「no token」 from 「wrong token」 apart is the only feedback
    // a guesser could ever profit from.
    expect(bogus).toEqual(none);
  });

  it('② a malformed Authorization header is a refusal, never a pass-through', () => {
    const w = world();
    const { res, read } = response();
    const req = request('GET', PC_PRESENCE_PATH);
    (req as { headers: Record<string, string> }).headers = { authorization: w.a.token }; // no 「Bearer 」
    tryHandlePresenceRoutes(req, res, {
      registry: w.registry,
      store: w.store as unknown as RoomStore,
      pcs: w.db.pcs,
    });
    expect(read()).toMatchObject({ status: 401, body: { error: PRESENCE_AUTH_REQUIRED } });
  });

  it('③ 🔴 a phone is only ever told about ITS OWN PC (ID mix-up: structurally impossible to ask about someone else\'s)', () => {
    const w = world();
    // PC-B is in its room; PC-A is not. If the route could be pointed at another
    // machine, A's token would be able to see B's `true`.
    w.store.joinPc(w.b.pc.room_uuid, { id: 'sock-pc-b' });

    const fromA = ask(w, w.a.token);
    const fromB = ask(w, w.b.token);

    expect(fromA.body).toMatchObject({ pc_id: w.a.pc.id, pc_online: false });
    expect(fromB.body).toMatchObject({ pc_id: w.b.pc.id, pc_online: true });
    // Positive control for the negative above: the two PCs really are different
    // rows in different rooms, so 「A said false」 means A was asked about A.
    expect(w.a.pc.id).not.toBe(w.b.pc.id);
    expect(w.a.pc.room_uuid).not.toBe(w.b.pc.room_uuid);

    // And there is no parameter that changes the subject: asking with A's token
    // while NAMING B answers about A. (A `?pc_id=` that were honoured would flip
    // this to B's `true` — which is precisely the enumeration oracle this route
    // is shaped to make impossible.)
    const { res, read } = response();
    tryHandlePresenceRoutes(
      request('GET', `${PC_PRESENCE_PATH}?pc_id=${w.b.pc.id}`, w.a.token),
      res,
      { registry: w.registry, store: w.store as unknown as RoomStore, pcs: w.db.pcs },
    );
    expect(read().body).toMatchObject({ pc_id: w.a.pc.id, pc_online: false });
  });

  it('④ resolving the token writes NOTHING (last_seen_at is not touched)', () => {
    const w = world();
    const touch = vi.spyOn(w.db.mobiles, 'touchLastSeen');
    ask(w, w.a.token);
    ask(w, w.a.token);
    expect(touch).not.toHaveBeenCalled();
    // Reverse control: the SESSION path on the same token does touch it, so the
    // zero above is the route's restraint and not a broken spy.
    w.registry.reconnectMobile(w.a.token);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('the answer is exactly one bit plus the caller\'s own pc_id — no inventory', () => {
    const w = world();
    const body = ask(w, w.a.token).body;
    expect(Object.keys(body).sort()).toEqual(['ok', 'pc_id', 'pc_online']);
  });

  it('non-GET is refused rather than silently treated as a read', () => {
    const w = world();
    expect(ask(w, w.a.token, 'POST')).toMatchObject({ status: 405 });
  });

  it('an unrelated url is not handled here', () => {
    const w = world();
    const { res } = response();
    expect(
      tryHandlePresenceRoutes(request('GET', '/api/health'), res, {
        registry: w.registry,
        store: w.store as unknown as RoomStore,
        pcs: w.db.pcs,
      }),
    ).toBe(false);
  });
});

describe('mounting — the relay is the deployment that needs this', () => {
  const handlerFor = (mode: 'standalone' | 'saas', presence?: Parameters<typeof makeHttpHandler>[0]['presence']) =>
    makeHttpHandler({
      config: { mode, port: 41879, mockBilling: false } as never,
      billing: {} as never,
      version: '0.2.36',
      // saas refuses to build a resolver without an account layer; this route
      // never consults it (it authenticates with the PAIRING token, not an
      // account Bearer), so one that knows nobody is exactly right here.
      resolveUserId: makeResolveUserId({
        mode,
        standaloneUserId: 'default',
        ...(mode === 'saas'
          ? { account: { verifyToken: () => ({ ok: false, error: 'AUTH_TOKEN_INVALID' }), getUser: () => null } }
          : {}),
      }),
      ...(presence ? { presence } : {}),
    });

  for (const mode of ['standalone', 'saas'] as const) {
    it(`is mounted in ${mode}`, () => {
      const w = world();
      w.store.joinPc(w.a.pc.room_uuid, { id: 'sock' });
      const handler = handlerFor(mode, {
        registry: w.registry,
        store: w.store as unknown as RoomStore,
        pcs: w.db.pcs,
      });
      const { res, read } = response();
      expect(handler(request('GET', PC_PRESENCE_PATH, w.a.token), res)).toBe(true);
      expect(read()).toMatchObject({ status: 200, body: { pc_online: true } });
    });
  }

  it('without the dep the path is simply unhandled (→ 404), never a fabricated answer', () => {
    const { res } = response();
    expect(handlerFor('saas')(request('GET', PC_PRESENCE_PATH, 'fm_' + 'a'.repeat(64)), res)).toBe(false);
  });
});
