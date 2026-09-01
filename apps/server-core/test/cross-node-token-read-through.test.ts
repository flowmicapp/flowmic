// SPEC-REF:
//   apps/server-core/src/auth/middleware.ts          (the handshake seam)
//   apps/server-core/src/node/token-read-through.ts  (the gate)
//   apps/server-core/src/node/token-rows.ts          (the rows, and how they land)
//   apps/server-core/src/http/node-routes.ts         (POST /api/node/resolve-token)
//   apps/server-core/src/node/writer-client.ts       (resolveToken)
//
// ── THE DEFECT THIS FILE EXISTS FOR (P0-①, 2026-08-31) ──────────────────────
//
// `mobile:pair` is writer-only, so a brand-new `mobile_pairings` row is born on
// the writer. NOTHING forwards it — no member of the ForwardedWrite union
// carries a pairing row — so a replica learns about it through exactly one
// mechanism: the 30-second whole-database pull. A phone that pairs and then
// follows its PC to that PC's home node therefore presents a VALID token to a
// node that has never heard of it, and is refused AUTH_TOKEN_INVALID for up to
// thirty seconds. The owner's report of it is 「exit and re-enter twice and it
// works」, which is the pull period wearing a client bug's clothes.
//
// ── WHAT MAKES THE ASSERTIONS HERE WORTH ANYTHING ───────────────────────────
//
//  ① TWO DATABASES, and the rows are asserted in the REPLICA's. 「The handshake
//     was admitted」 is not the claim. Everything after the handshake —
//     `mobile:reconnect` → `registry.reconnectMobile` → `findPairingByToken` —
//     reads `mobile_pairings` and then `pc_devices` out of the LOCAL database,
//     so admitting a socket without landing both rows would trade a refused
//     connection for a connected phone refused by its first event. The reconnect
//     is driven for real, on the replica's own registry, with the writer's fetch
//     shim taken away first.
//
//  ② THE TWO HALVES SPEAK OVER THE REAL PROTOCOL. `makeWriterClient` is driven
//     against the REAL `makeNodeRoutes` handler through a fetch shim (the same
//     harness `replica-code-mint-forwarding.test.ts` established), so a mismatch
//     in path, method, header name, status semantics or body key fails HERE.
//     Stubbing `askWriter` in every test would have proven the gate and left the
//     wire contract — where a forwarding feature actually breaks — untested.
//
//  ③ EVERY FAILURE PATH IS ASSERTED TO PRODUCE THE OLD REFUSAL. Unreachable
//     writer, authoritative 「never heard of it」, a row that will not land, a
//     spent budget, no seam at all: AUTH_TOKEN_INVALID, on a resolved promise,
//     every time. A handshake that hangs would be worse than the defect.
//
//  ④ THE CASCADE. `INSERT OR REPLACE` on `pc_devices` would DELETE the
//     conflicting row first, and `mobile_pairings.pc_device_id ... ON DELETE
//     CASCADE` with `PRAGMA foreign_keys = ON` means that delete takes every
//     pairing with it — silently, with no error and no log. The idempotency test
//     asserts the pairings are still there afterwards, which is the only
//     assertion that can tell the two spellings apart.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { Registry } from '../src/room/registry';
import { authMiddleware, type AuthContext } from '../src/auth/middleware';
import type { Server, Socket } from 'socket.io';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { makeWriterOnlyGuard } from '../src/node/writer-only';
import { tokenLookupOver } from '../src/bootstrap';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';
import { makeWriterClient, WriterUnreachable } from '../src/node/writer-client';
import {
  makeTokenReadThrough,
  READ_THROUGH_MAX_CALLS_PER_WINDOW,
  type TokenReadThrough,
} from '../src/node/token-read-through';
import { applyTokenResolution, resolveTokenRows, parseTokenResolution } from '../src/node/token-rows';

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

// ── the writer's HTTP side, as a fetch shim the real WriterClient can drive ──
// Body is an async iterable because `readJsonBody` streams it; buffering it here
// would let a route that ignored its own ceiling pass.
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
/** Every `/api/node/*` path the replica actually dialled, in order. The counter
 *  that makes 「no writer call at all」 an assertion rather than a hope. */
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

/** The production wiring, end to end: replica gate → WriterClient → the real
 *  writer route → the writer's own repos. */
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

/** Drive the REAL handshake middleware against the replica's database. Resolves
 *  with the error socket.io would refuse the connection with, or null. */
function handshake(token: string, readThrough?: TokenReadThrough): Promise<{ err: string | null; auth: AuthContext | null }> {
  const socket = { handshake: { auth: { token } }, data: {} as Record<string, unknown> };
  const mw = authMiddleware(tokenLookupOver(replica.db), undefined, readThrough);
  return new Promise((resolve) => {
    mw(socket, (err?: Error) => {
      resolve({ err: err ? err.message : null, auth: (socket.data.auth as AuthContext | null) ?? null });
    });
  });
}

/** A PC registered on the writer AND already replicated to the replica — the
 *  ordinary state of the world, since a PC registers long before its phone
 *  pairs. The mobile pairing is then minted on the writer ONLY, which is exactly
 *  the thirty-second window. */
function pcOnBothNodes(): { pcId: string } {
  const { pc } = writer.registry.registerPc({ device_name: 'dev-pc-a', user_id: 'default' });
  replica.db.pcs.upsertReplicated(writer.db.pcs.findById(pc.id)!);
  return { pcId: pc.id };
}

/** Mint a pairing ON THE WRITER ONLY — the thirty-second window in one line.
 *
 *  A fresh `device_uid` per call on purpose: `pairMobile` REUSES a handset's row
 *  rather than minting a second one (v0.2.3), so a shared uid would silently
 *  make 「two pairings」 be one, and the cascade test below would pass against a
 *  spelling that deleted a row. */
let pairSeq = 0;
function pairOnWriter(pcId: string): string {
  pairSeq += 1;
  const pc = writer.db.pcs.findById(pcId)!;
  const { token } = writer.registry.pairMobile({
    short_code: pc.short_code,
    mobile_name: `Pixel-${pairSeq}`,
    device_uid: `handset-${pairSeq}`,
  });
  return token;
}

describe('a replica resolves a fresh token through the writer', () => {
  it('🔴 the defect: with NO read-through the fresh pairing is refused', async () => {
    // The control the whole file rests on. If this ever goes green on its own,
    // something else started replicating pairings and this feature is dead code.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);

    const r = await handshake(token);

    expect(r.err).toBe('AUTH_TOKEN_INVALID');
    expect(r.auth).toBeNull();
    expect(replica.db.mobiles.findByToken(token)).toBeNull();
  });

  it('local miss → writer hit → BOTH rows land locally → handshake accepted', async () => {
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);

    const r = await handshake(token, productionReadThrough());

    expect(r.err).toBeNull();
    expect(r.auth).toEqual({
      userId: 'default',
      pairingId: writer.db.mobiles.findByToken(token)!.id,
      deviceId: pcId,
      kind: 'mobile',
    });
    // ① The claim is WHERE the rows are, not that an ack existed.
    const landedMobile = replica.db.mobiles.findByToken(token);
    expect(landedMobile).not.toBeNull();
    expect(landedMobile).toEqual(writer.db.mobiles.findByToken(token));
    expect(replica.db.pcs.findById(pcId)).toEqual(writer.db.pcs.findById(pcId));
    // ② It went over the real route, not through a stub.
    expect(dialled).toEqual(['/api/node/resolve-token']);
  });

  it('① and the phone can then RECONNECT from the replica\'s own rows', async () => {
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);

    const r = await handshake(token, productionReadThrough());
    expect(r.err).toBeNull();

    // 🔴 The writer is now unreachable by construction — this call has no client
    // at all. Anything that still works is working from the replica's database,
    // which is the only thing that makes the admitted socket useful.
    const resolved = replica.registry.reconnectMobile(token, 'device-uid-1');
    expect(resolved).not.toBeNull();
    expect(resolved!.pc.id).toBe(pcId);
    expect(resolved!.mobile.mobile_token).toBe(token);
    expect(resolved!.mobile.device_uid).toBe('device-uid-1');
  });

  it('the PC half of the same gap: a device token lands its ONE row', async () => {
    // A PC re-selecting a node it has never been on. One row, and the union has
    // no member that would let a `kind:'pc'` answer carry a pairing.
    const { pc } = writer.registry.registerPc({ device_name: 'fresh-pc', user_id: 'default' });
    expect(replica.db.pcs.findByToken(pc.device_token)).toBeNull();

    const r = await handshake(pc.device_token, productionReadThrough());

    expect(r.err).toBeNull();
    expect(r.auth).toEqual({ userId: 'default', deviceId: pc.id, kind: 'pc' });
    expect(replica.db.pcs.findById(pc.id)).toEqual(writer.db.pcs.findById(pc.id));
    expect(replica.db.mobiles.listByPc(pc.id)).toEqual([]);
  });
});

describe('S1b: the ONBOARDING path, where the replica knows nothing at all', () => {
  /** A brand-new account on the writer: user, PC and pairing all minted inside
   *  one 30-second pull window, none of it on the replica. */
  function signUpAndPairOnWriter(): { userId: string; pcId: string; token: string } {
    writer.db.users.insert({ id: 'newbie', display_name: 'N', plan: 'free' });
    const { pc } = writer.registry.registerPc({ device_name: 'first-pc', user_id: 'newbie' });
    return { userId: 'newbie', pcId: pc.id, token: pairOnWriter(pc.id) };
  }

  it('🔴 the account, its PC and its pairing all land in one go', async () => {
    // THE WINDOW S1 LEFT OPEN. Both device tables REFERENCE users(id) and `users`
    // replicates on the SAME 30-second cycle, so without the account row the
    // pairing cannot land AT ALL — and the refusal that follows is the one the
    // phone deletes the fresh pairing on. S1 measured this as a test before it
    // was fixed; this is that same case, now green.
    const { userId, pcId, token } = signUpAndPairOnWriter();
    expect(replica.db.users.findById(userId)).toBeNull();
    expect(replica.db.pcs.findById(pcId)).toBeNull();
    expect(replica.db.mobiles.findByToken(token)).toBeNull();

    const r = await handshake(token, productionReadThrough());

    expect(r.err).toBeNull();
    expect(r.auth).toEqual({
      userId,
      pairingId: writer.db.mobiles.findByToken(token)!.id,
      deviceId: pcId,
      kind: 'mobile',
    });
    // All three rows, byte for byte, in the REPLICA's database.
    expect(replica.db.users.findById(userId)).toEqual(writer.db.users.findById(userId));
    expect(replica.db.pcs.findById(pcId)).toEqual(writer.db.pcs.findById(pcId));
    expect(replica.db.mobiles.findByToken(token)).toEqual(writer.db.mobiles.findByToken(token));
  });

  it('...and the phone can then RECONNECT from those rows with the writer gone', async () => {
    const { pcId, token } = signUpAndPairOnWriter();

    expect((await handshake(token, productionReadThrough())).err).toBeNull();

    // No writer client in this call at all: anything that works is working from
    // the replica's own database, which is the only thing that makes the
    // admitted socket useful.
    const resolved = replica.registry.reconnectMobile(token, 'newbie-handset');
    expect(resolved).not.toBeNull();
    expect(resolved!.pc.id).toBe(pcId);
    expect(resolved!.mobile.mobile_token).toBe(token);
  });

  it('the PC half of onboarding brings its account too', async () => {
    // A first registration on the writer, then the desktop selects a node it has
    // never been on. One device row, and the account it hangs from.
    writer.db.users.insert({ id: 'newbie', display_name: 'N', plan: 'free' });
    const { pc } = writer.registry.registerPc({ device_name: 'first-pc', user_id: 'newbie' });

    const r = await handshake(pc.device_token, productionReadThrough());

    expect(r.err).toBeNull();
    expect(r.auth).toEqual({ userId: 'newbie', deviceId: pc.id, kind: 'pc' });
    expect(replica.db.users.findById('newbie')).toEqual(writer.db.users.findById('newbie'));
    expect(replica.db.pcs.findById(pc.id)).toEqual(writer.db.pcs.findById(pc.id));
  });

  it('🔴 an account row ALREADY HERE is left alone — the pull owns that table', async () => {
    // THE DECISION, PINNED. `users` lands ON CONFLICT DO NOTHING while the two
    // device rows land DO UPDATE, and the asymmetry is deliberate:
    //
    //   · the device rows ARE the subject of the request — a token was presented
    //     and they are what it means, so correcting a stale copy is the job;
    //   · the account row is a DEPENDENCY DRAGGED IN to satisfy a foreign key.
    //     Nobody asked about it, and the only thing this path needs from `users`
    //     is that the id exists. Rewriting it would make an unrelated phone's
    //     handshake a writer of somebody's account row — and this node does
    //     serve the HTTP account routes, so a local write from the last thirty
    //     seconds is a real thing to be reverting on another actor's behalf.
    //
    // The replication pull stays the single authority on this table's CONTENT
    // and reconciles within 30 s either way, so the choice costs nothing and the
    // blast radius is the whole of the difference.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    writer.db.users.setPlan('default', 'pro');
    writer.db.pcs.setDeviceName(pcId, 'renamed-on-the-writer');
    expect(replica.db.users.findById('default')!.plan).toBe('free');

    const r = await handshake(token, productionReadThrough());

    expect(r.err).toBeNull();
    // The account row did NOT move...
    expect(replica.db.users.findById('default')!.plan).toBe('free');
    // ...while the PC row, which IS what was asked about, did. Both halves in
    // one test on purpose: without the second assertion this would pass just as
    // happily against a transaction that never ran at all.
    expect(replica.db.pcs.findById(pcId)!.device_name).toBe('renamed-on-the-writer');
  });

  it('DO NOTHING still INSERTS — it is not a no-op wearing a rule', async () => {
    // The negative control for the test above. 「Never touches a row that is
    // already here」 and 「never writes anything」 look identical from the row
    // that was already there, and only one of them closes the onboarding hole.
    const { userId, token } = signUpAndPairOnWriter();
    const before = replica.db.users.findById(userId);

    await handshake(token, productionReadThrough());

    expect(before).toBeNull();
    expect(replica.db.users.findById(userId)).not.toBeNull();
  });
});

describe('the failure direction is exactly today\'s behaviour', () => {
  it('a writer that cannot be reached yields the refusal, and does not hang', async () => {
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    const gate = makeTokenReadThrough({
      askWriter: () => Promise.reject(new WriterUnreachable('ECONNRESET')),
      apply: () => { throw new Error('nothing may be applied when nothing was learned'); },
      log: silentLog,
    });

    const r = await handshake(token, gate);

    expect(r.err).toBe('AUTH_TOKEN_INVALID');
    expect(r.auth).toBeNull();
    // Nothing was invented locally out of a failure.
    expect(replica.db.mobiles.findByToken(token)).toBeNull();
  });

  it('a writer that answers 404 yields the refusal — and THAT one is honest', async () => {
    // The whole point of closing this gap: after it, a replica's
    // AUTH_TOKEN_INVALID is a statement about the product and not about this
    // node's copy of the database.
    const r = await handshake('fm_' + 'a'.repeat(64), productionReadThrough());

    expect(r.err).toBe('AUTH_TOKEN_INVALID');
    expect(dialled).toEqual(['/api/node/resolve-token']);
  });

  it('a writer answering 200 with unusable rows is an OUTAGE, never a "no such token"', async () => {
    // Structurally apart, because a 200 that we cannot read tells us neither
    // thing — and folding it into 「unknown」 would let one bad writer deploy turn
    // every valid pairing in the region into a permanent refusal.
    const client = makeWriterClient({
      writerUrl: WRITER_URL,
      sharedSecret: SECRET,
      nodeId: 'srvjp',
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, kind: 'mobile', pc: { id: 'x' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    });
    await expect(client.resolveToken('fm_' + 'b'.repeat(64))).rejects.toBeInstanceOf(WriterUnreachable);
  });

  it('🔴 rows that will not land are refused, and the earlier statements are rolled back', async () => {
    // 🔴 THIS TEST WAS REWRITTEN BY S1b, AND THE REASON IS WORTH KEEPING. Its
    // first version used the ACCOUNT gap as its cause: a pairing under a `users`
    // row the replica had not pulled yet could not land, so S1 pinned that
    // residual here rather than leaving it to be discovered. S1b closed exactly
    // that hole, which made this test go red on a correct implementation — the
    // healthiest possible way for a residual to stop being one.
    //
    // The case it must still cover is the OTHER one: rows that will not land for
    // a reason no answer can carry. A stale local `pc_devices` row holds the
    // room_uuid this PC is about to claim, under a DIFFERENT id — a UNIQUE that
    // `ON CONFLICT(id)` deliberately does not swallow.
    //
    // It is also, still, the only shape that proves the TRANSACTION: the account
    // row inserts FINE (a real, observable write — that account is not here),
    // and the PC row after it fails. Without one transaction the replica would
    // be left holding an account nobody can reach.
    writer.db.users.insert({ id: 'newbie', display_name: 'N', plan: 'free' });
    const { pc } = writer.registry.registerPc({ device_name: 'first-pc', user_id: 'newbie' });
    replica.db.pcs.insert({
      id: 'a-stale-local-row',
      user_id: 'default',
      device_name: 'stale',
      device_token: 'fm_' + '7'.repeat(64), // different token ⇒ the lookup still MISSES
      room_uuid: pc.room_uuid,              // …and this is the collision
      short_code: '0000',
    });

    const r = await handshake(pc.device_token, productionReadThrough());

    expect(r.err).toBe('AUTH_TOKEN_INVALID');
    expect(replica.db.pcs.findByToken(pc.device_token)).toBeNull();
    // 🔴 The transaction's own assertion: the account row that DID insert is not
    // here either, so the statement that succeeded was rolled back with the one
    // that failed.
    expect(replica.db.users.findById('newbie')).toBeNull();
    // Positive control — the stale row that caused it is untouched, so this is a
    // refusal and not a wipe.
    expect(replica.db.pcs.findById('a-stale-local-row')!.device_name).toBe('stale');
  });

  it('an unknown-token answer is a FACT: a later pull can still deliver the row', async () => {
    // No negative caching. A 404 refuses this attempt and nothing more — the
    // next handshake asks again, so a pairing created a second later is not
    // locked out by an answer that was true when it was given.
    const { pcId } = pcOnBothNodes();
    const gate = productionReadThrough();
    const early = 'fm_' + 'c'.repeat(64);

    expect((await handshake(early, gate)).err).toBe('AUTH_TOKEN_INVALID');
    const token = pairOnWriter(pcId);
    expect((await handshake(token, gate)).err).toBeNull();
    expect(dialled).toEqual(['/api/node/resolve-token', '/api/node/resolve-token']);
  });
});

describe('the writer is not an amplifier', () => {
  it('🔴 a malformed token costs the writer NOTHING', async () => {
    const gate = productionReadThrough();
    for (const bad of ['fm_short', 'x'.repeat(67), 'fm_' + 'Z'.repeat(64), 'fm_' + 'a'.repeat(63)]) {
      const r = await handshake(bad, gate);
      expect(r.err).toBe('AUTH_TOKEN_INVALID');
    }
    // ⚠️ The EMPTY string is not in that list and must not be: an absent token
    // is how `pc:register` and `mobile:pair` connect in the first place, so it
    // is admitted UNAUTHENTICATED rather than refused. Asserted here so nobody
    // 「tidies」 it into the loop above and turns first contact into a refusal.
    const none = await handshake('', gate);
    expect(none.err).toBeNull();
    expect(none.auth).toBeNull();
    // The assertion that matters is the EMPTY list. `authMiddleware` shape-checks
    // before the lookup and the gate shape-checks again, and this proves the pair
    // of them rather than either one.
    expect(dialled).toEqual([]);
  });

  it('🔴 a flood of shape-valid unknown tokens is capped, and says so', async () => {
    const warned: string[] = [];
    const gate = makeTokenReadThrough({
      askWriter: () => { dialled.push('/api/node/resolve-token'); return Promise.resolve(null); },
      apply: () => { throw new Error('unreachable — the writer knew nothing'); },
      log: { info: () => {}, warn: (m) => warned.push(m) },
      windowMs: 60_000,
      now: () => 1_800_000_000_000, // one frozen instant: the window never drains
    });

    const attempts = READ_THROUGH_MAX_CALLS_PER_WINDOW + 25;
    for (let i = 0; i < attempts; i += 1) {
      // Distinct tokens, so single-flight is not what is being measured here.
      const token = 'fm_' + i.toString(16).padStart(64, '0');
      expect((await handshake(token, gate)).err).toBe('AUTH_TOKEN_INVALID');
    }

    expect(dialled.length).toBe(READ_THROUGH_MAX_CALLS_PER_WINDOW);
    expect(gate.throttledCount).toBe(25);
    // The push half of the pair. One line, not twenty-five — a refusal that logs
    // per attempt turns a flood into disk work.
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain('throttled');
  });

  it('the budget DRAINS — a throttled device recovers on its next ladder rung', async () => {
    // The reason this may be sized conservatively: being over budget is slow,
    // never broken. Without this the previous test would also pass against a
    // permanent lockout.
    let clock = 1_800_000_000_000;
    const gate = makeTokenReadThrough({
      askWriter: () => { dialled.push('/api/node/resolve-token'); return Promise.resolve(null); },
      apply: () => { throw new Error('unreachable — the writer knew nothing'); },
      log: silentLog,
      windowMs: 60_000,
      maxCallsPerWindow: 2,
      now: () => clock,
    });
    const tok = (n: number): string => 'fm_' + n.toString(16).padStart(64, '0');

    await gate.resolve(tok(1));
    await gate.resolve(tok(2));
    await gate.resolve(tok(3));
    expect(dialled.length).toBe(2);

    clock += 60_001;
    await gate.resolve(tok(4));
    expect(dialled.length).toBe(3);
  });

  it('🔴 concurrent handshakes for the SAME token cost ONE writer call', async () => {
    // A phone's reconnect ladder fires again while the first flight is in the
    // air; so does a PC racing its own reconnect. Two requests for one answer is
    // the cheapest amplification there is, and the one nobody would notice.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const gate = makeTokenReadThrough({
      askWriter: async (t) => {
        dialled.push('/api/node/resolve-token');
        await held;
        return resolveTokenRows(writer.db, t);
      },
      apply: (rows) => applyTokenResolution(replica.db, rows),
      log: silentLog,
    });

    const flights = [handshake(token, gate), handshake(token, gate), handshake(token, gate)];
    release();
    const results = await Promise.all(flights);

    expect(results.map((r) => r.err)).toEqual([null, null, null]);
    expect(dialled.length).toBe(1);
  });

  it('and the flight is FORGOTTEN afterwards — no cached "false" for a real pairing', async () => {
    // The reverse of the test above, and the one that catches the obvious wrong
    // fix: a map entry left behind would make the first (unknown) answer
    // permanent for that token.
    const { pcId } = pcOnBothNodes();
    const gate = productionReadThrough();
    const token = pairOnWriter(pcId);

    // Ask once while the writer is willing, then again — a second real call.
    expect((await handshake(token, gate)).err).toBeNull();
    replica.db.mobiles.remove(writer.db.mobiles.findByToken(token)!.id);
    expect((await handshake(token, gate)).err).toBeNull();
    expect(dialled.length).toBe(2);
  });
});

describe('landing rows is idempotent against the replication pull', () => {
  it('🔴 upserting a PC does NOT cascade its pairings away', async () => {
    // ④ The assertion that separates ON CONFLICT DO UPDATE from INSERT OR
    // REPLACE. REPLACE deletes the conflicting row first, and
    // `mobile_pairings.pc_device_id ... ON DELETE CASCADE` under
    // `PRAGMA foreign_keys = ON` takes every pairing with it — no error, no log.
    const { pcId } = pcOnBothNodes();
    const first = pairOnWriter(pcId);
    await handshake(first, productionReadThrough());
    const second = pairOnWriter(pcId);

    await handshake(second, productionReadThrough());

    expect(replica.db.mobiles.listByPc(pcId).length).toBe(2);
    expect(replica.db.mobiles.findByToken(first)).not.toBeNull();
    expect(replica.db.mobiles.findByToken(second)).not.toBeNull();
  });

  it('a row the pull already delivered is re-landed as a no-op', async () => {
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    // The pull raced us: both rows are already here, byte for byte.
    replica.db.mobiles.upsertReplicated(writer.db.mobiles.findByToken(token)!);
    const before = { pc: replica.db.pcs.findById(pcId), mobile: replica.db.mobiles.findByToken(token) };

    applyTokenResolution(replica.db, resolveTokenRows(writer.db, token)!);
    applyTokenResolution(replica.db, resolveTokenRows(writer.db, token)!);

    expect(replica.db.pcs.findById(pcId)).toEqual(before.pc);
    expect(replica.db.mobiles.findByToken(token)).toEqual(before.mobile);
    expect(replica.db.mobiles.listByPc(pcId).length).toBe(1);
  });

  it('a STALE local row is corrected, not left to disagree with the writer', async () => {
    // The pull's whole-table replace is the authority and would do this in at
    // most thirty seconds; landing the same values early must not produce a
    // different answer from the one the pull will give.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    writer.db.pcs.setHomeNode(pcId, 'srvjp');
    writer.db.pcs.setDeviceName(pcId, 'renamed');

    await handshake(token, productionReadThrough());

    expect(replica.db.pcs.findById(pcId)!.home_node).toBe('srvjp');
    expect(replica.db.pcs.findById(pcId)!.device_name).toBe('renamed');
  });
});

describe('a single node is byte-for-byte unchanged', () => {
  it('no seam ⇒ the miss is refused on the SAME TICK, with no I/O', async () => {
    // The compatibility guarantee, and it is asserted as SYNCHRONY rather than
    // as an outcome: with no read-through wired there must be no promise, no
    // microtask and nothing to await. `wireNodeRuntime` returns null for
    // `resolveTokenOnWriter` on a writer and on every single-node deployment, so
    // this is the path every deployment that exists today takes.
    const socket = { handshake: { auth: { token: 'fm_' + 'd'.repeat(64) } }, data: {} as Record<string, unknown> };
    const mw = authMiddleware(tokenLookupOver(replica.db));
    const seen: (string | null)[] = [];
    mw(socket, (err?: Error) => seen.push(err ? err.message : null));
    expect(seen).toEqual(['AUTH_TOKEN_INVALID']); // already, before any await
  });

  it('a token that IS local never reaches the writer, replica or not', async () => {
    // The hot path. A cross-region round trip on every handshake is how a
    // multi-node deployment becomes slower than the single node it replaced.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    replica.db.mobiles.upsertReplicated(writer.db.mobiles.findByToken(token)!);

    const r = await handshake(token, productionReadThrough());

    expect(r.err).toBeNull();
    expect(dialled).toEqual([]);
  });
});

describe('POST /api/node/resolve-token — the writer half on its own', () => {
  const routeDeps = (over: Partial<NodeRoutesDeps> = {}): NodeRoutesDeps => ({
    nodeId: 'srvny',
    version: '0.3.54',
    sharedSecret: SECRET,
    resolveToken: (token) => resolveTokenRows(writer.db, token),
    ...over,
  });

  async function post(deps: NodeRoutesDeps, body: unknown, headers: Record<string, string>, method = 'POST') {
    const res = await fetchIntoRoutes(deps)(`${WRITER_URL}/api/node/resolve-token`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const auth = { 'x-flowmic-node-secret': SECRET, 'x-flowmic-node-id': 'srvjp' };

  it('answers a mobile token with BOTH rows', async () => {
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    const r = await post(routeDeps(), { token }, auth);
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('mobile');
    expect(r.body.pc.id).toBe(pcId);
    expect(r.body.mobile.mobile_token).toBe(token);
    // The response body is the parser's input, so this pins the wire contract in
    // the direction the replica reads it.
    expect(parseTokenResolution(r.body)).not.toBeNull();
  });

  it('404s a token it does not have — and that is a FACT, not a failure', async () => {
    const r = await post(routeDeps(), { token: 'fm_' + 'e'.repeat(64) }, auth);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('token_unknown');
  });

  it('400s a malformed token before it can reach a statement', async () => {
    for (const bad of [undefined, '', 'nope', 'fm_' + 'Z'.repeat(64)]) {
      const r = await post(routeDeps(), { token: bad }, auth);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('token_malformed');
    }
  });

  it('403s on a wrong secret, and says nothing about which half was wrong', async () => {
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    const r = await post(routeDeps(), { token }, { ...auth, 'x-flowmic-node-secret': 'wrong' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
    expect(r.body.pc).toBeUndefined();
  });

  it('403s on NO secret at all — this route is never open', async () => {
    const { pcId } = pcOnBothNodes();
    const r = await post(routeDeps(), { token: pairOnWriter(pcId) }, { 'x-flowmic-node-id': 'srvjp' });
    expect(r.status).toBe(403);
  });

  it('501s where no resolver is configured — i.e. on a replica', async () => {
    const r = await post(routeDeps({ resolveToken: undefined }), { token: 'fm_' + 'f'.repeat(64) }, auth);
    expect(r.status).toBe(501);
    expect(r.body.error).toBe('resolve_token_not_configured');
  });

  it('405s a GET: a credential must never be reachable by a link', async () => {
    const r = await post(routeDeps(), { token: 'fm_' + 'a'.repeat(64) }, auth, 'GET');
    expect(r.status).toBe(405);
  });

  it('a pairing whose PC row is gone answers "unknown", never half an answer', () => {
    // Not reachable through the repos (the FK cascade removes a pairing with its
    // PC), so the branch is driven directly. It exists because the replica
    // physically could not insert such a pairing, and a 200 promising rows that
    // cannot land would admit a socket into a session with no computer.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    const orphaned = resolveTokenRows(
      { pcs: { findByToken: () => null, findById: () => null }, mobiles: writer.db.mobiles, users: writer.db.users },
      token,
    );
    expect(orphaned).toBeNull();
    // Positive control: the same token through the real repos IS an answer, so
    // the null above is the missing PC and not the token.
    expect(resolveTokenRows(writer.db, token)).not.toBeNull();
  });
});

describe('the parser refuses what it cannot use', () => {
  const pcRow = () => {
    const { pc } = writer.registry.registerPc({ device_name: 'PC', user_id: 'default' });
    return writer.db.pcs.findById(pc.id)!;
  };
  const owners = () => [writer.db.users.findById('default')!];

  it('🔴 a pairing handed back with SOMEBODY ELSE-S pc is unusable', () => {
    // The wrong-target red line in miniature. A parser that took the two halves
    // on trust would put a phone in another computer-s room.
    const pc = pcRow();
    const other = pcRow();
    const token = pairOnWriter(other.id);
    const mobile = writer.db.mobiles.findByToken(token)!;
    expect(parseTokenResolution({ kind: 'mobile', users: owners(), pc, mobile })).toBeNull();
    // Positive control, same call one field apart: with ITS OWN pc it parses.
    expect(parseTokenResolution({ kind: 'mobile', users: owners(), pc: other, mobile })).not.toBeNull();
  });

  it('a missing field is refused rather than inserted as undefined', () => {
    const pc = pcRow();
    expect(parseTokenResolution({ kind: 'pc', users: owners(), pc: { ...pc, device_token: undefined } })).toBeNull();
    expect(parseTokenResolution({ kind: 'pc', users: owners(), pc })).not.toBeNull();
  });

  it('an unknown kind is refused, never guessed from the shape', () => {
    const pc = pcRow();
    expect(parseTokenResolution({ kind: 'web', users: owners(), pc })).toBeNull();
    expect(parseTokenResolution({ users: owners(), pc })).toBeNull();
  });

  it('🔴 S1b: an answer that does not CARRY the owning account is refused', () => {
    // It could not land anyway - pc_devices.user_id REFERENCES users(id) - but it
    // would fail inside the transaction and be reported as 「the rows would not
    // land」, which is our bug's name for the writer's bug. Two different
    // failures, and only one of them is ours to fix.
    const pc = pcRow();
    expect(parseTokenResolution({ kind: 'pc', users: [], pc })).toBeNull();
    expect(parseTokenResolution({ kind: 'pc', pc })).toBeNull();
    // ...and an account row for SOMEBODY ELSE does not count as carrying it.
    const stranger = { ...writer.db.users.findById('default')!, id: 'not-the-owner' };
    expect(parseTokenResolution({ kind: 'pc', users: [stranger], pc })).toBeNull();
    // Positive control, one element apart.
    expect(parseTokenResolution({ kind: 'pc', users: owners(), pc })).not.toBeNull();
  });

  it('nulls survive the round trip as nulls', () => {
    // `home_node` NULL means 「dial the host you already have」, and a parser that
    // turned it into a string or dropped the row would break every pairing that
    // predates the column.
    const pc = pcRow();
    expect(pc.home_node).toBeNull();
    const round = parseTokenResolution(JSON.parse(JSON.stringify({ kind: 'pc', users: owners(), pc })));
    expect(round).not.toBeNull();
    expect(round!.pc.home_node).toBeNull();
    expect(round!.pc.machine_uid).toBeNull();
    // S1b - the account row's own nullables, same rule. `password_hash` NULL is
    // an account that signs in with Google and nothing else; turning it into ''
    // would be inventing a credential.
    expect(round!.users[0]!.password_hash).toBeNull();
    expect(round!.users[0]!.google_sub).toBeNull();
    expect(round!.users[0]!.restricted_at).toBeNull();
  });

  it('S1b: the account row keeps its booleans as booleans across the wire', () => {
    // `is_admin` / `permanent_free` are INTEGER 0/1 in the column and boolean in
    // the record. The wire is JSON, so they cross as booleans and go back to
    // INTEGERs in the repo - and `=== true` rather than truthiness is what stops
    // a stray string from promoting an account.
    writer.db.users.setPermanentFree('default', true);
    const pc = pcRow();
    const round = parseTokenResolution(JSON.parse(JSON.stringify({ kind: 'pc', users: owners(), pc })));
    expect(round!.users[0]!.permanent_free).toBe(true);
    expect(round!.users[0]!.is_admin).toBe(false);
    const forged = { ...writer.db.users.findById('default')!, is_admin: 'yes' as unknown as boolean };
    expect(parseTokenResolution({ kind: 'pc', users: [forged], pc })!.users[0]!.is_admin).toBe(false);
  });
});

// ── Z4: the SECOND seam that resolves a pairing token locally ───────────────
//
// `mobile:reconnect` reads the same tables as the handshake and, before Z4,
// answered a local miss with an ack-level AUTH_TOKEN_INVALID — the refusal the
// phone DELETES its local pairing on (`mobile_reconnect_flow.dart`, one of only
// two `removeByToken` call sites in the whole app). The handshake's read-through
// does not cover it: a socket admitted with NO token never ran one, and a
// replication pull that races us can take the rows away again underneath a
// socket that is still open.

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

/** The REAL mobile handler over the REPLICA's real db / Registry / RoomStore,
 *  faked only at the socket seam — the harness account-restriction-socket.ts
 *  established. `restriction` is a real row read, not a stub's opinion. */
function wireMobileOnReplica(seam?: TokenReadThrough): FakeSocket {
  const socket = new FakeSocket('sock-1');
  registerMobileHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry: replica.registry,
    store: new RoomStore() as RoomStore<Socket>,
    pairLimiter: new PairRateLimiter({}),
    mode: 'standalone',
    resolveActingUser: () => ({ userId: 'default' }),
    writerOnly: makeWriterOnlyGuard(WRITER_URL),
    restriction: { getUser: (id) => replica.db.users.findById(id) },
    ...(seam ? { resolveTokenOnWriter: seam } : {}),
  });
  return socket;
}

describe('Z4: mobile:reconnect resolves an unknown token through the writer too', () => {
  it('🔴 a local miss is recovered, and the ack is an acceptance', async () => {
    // The state the handshake cannot have fixed: this socket was admitted with
    // no token (pair/register flows connect first), so nothing ran a
    // read-through for it, and the pairing was minted on the writer moments ago.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    expect(replica.db.mobiles.findByToken(token)).toBeNull();
    const socket = wireMobileOnReplica(productionReadThrough());

    const ack = await socket.invoke('mobile:reconnect', { token });

    expect(ack.error).toBeUndefined();
    expect(ack.pc_id).toBe(pcId);
    expect(ack.pairing_id).toBe(writer.db.mobiles.findByToken(token)!.id);
    // The rows are HERE now, so the next event on this socket needs nobody.
    expect(replica.db.mobiles.findByToken(token)).not.toBeNull();
    expect(dialled).toEqual(['/api/node/resolve-token']);
  });

  it('🔴 the pull-race: rows that landed and were ERASED again are recovered', async () => {
    // The case that makes this seam load-bearing rather than defensive.
    // `replica-puller.ts` applies `DELETE FROM t; INSERT INTO t SELECT * FROM
    // snap.t` for every table, so a snapshot fetched BEFORE this pairing existed
    // and applied AFTER we landed it takes the row away again — underneath a
    // socket that is still open and a phone that is about to rejoin.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    const gate = productionReadThrough();
    expect((await handshake(token, gate)).err).toBeNull();                // the handshake landed it
    replica.db.mobiles.remove(replica.db.mobiles.findByToken(token)!.id); // the pull took it away
    const socket = wireMobileOnReplica(gate);

    const ack = await socket.invoke('mobile:reconnect', { token });

    expect(ack.error).toBeUndefined();
    expect(ack.pc_id).toBe(pcId);
    expect(dialled.length).toBe(2); // once at the handshake, once here
  });

  it('a writer that cannot be reached yields the refusal, and does not hang', async () => {
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    const socket = wireMobileOnReplica(makeTokenReadThrough({
      askWriter: () => Promise.reject(new WriterUnreachable('ECONNRESET')),
      apply: () => { throw new Error('nothing may be applied when nothing was learned'); },
      log: silentLog,
    }));

    // The assertion IS that this await returns: a handler that never acks is
    // worse than one that refuses, and it is the failure an added `await` makes
    // newly possible.
    const ack = await socket.invoke('mobile:reconnect', { token });

    expect(ack.error).toBe('AUTH_TOKEN_INVALID');
    expect(replica.db.mobiles.findByToken(token)).toBeNull();
  });

  it('a writer that answers 404 yields the refusal — and THAT one is honest', async () => {
    const socket = wireMobileOnReplica(productionReadThrough());

    const ack = await socket.invoke('mobile:reconnect', { token: 'fm_' + '1'.repeat(64) });

    expect(ack.error).toBe('AUTH_TOKEN_INVALID');
    expect(dialled).toEqual(['/api/node/resolve-token']);
  });

  it('🔴 exactly ONE retry — the read-through is authoritative', async () => {
    // A second ask on the same answer could only produce the same miss, and a
    // handler that looped would hold a socket open against a slow writer for as
    // long as its patience lasted.
    const socket = wireMobileOnReplica(makeTokenReadThrough({
      askWriter: () => { dialled.push('/api/node/resolve-token'); return Promise.resolve(null); },
      apply: () => { throw new Error('unreachable — the writer knew nothing'); },
      log: silentLog,
    }));

    expect((await socket.invoke('mobile:reconnect', { token: 'fm_' + '2'.repeat(64) })).error)
      .toBe('AUTH_TOKEN_INVALID');
    expect(dialled.length).toBe(1);
  });

  it('a token that IS local never reaches the writer', async () => {
    // The hot path, and the reason the handler stays synchronous until the miss:
    // an `async` function runs to its first `await`, and on a hit there is none.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    replica.db.mobiles.upsertReplicated(writer.db.mobiles.findByToken(token)!);
    const socket = wireMobileOnReplica(productionReadThrough());

    const ack = await socket.invoke('mobile:reconnect', { token });

    expect(ack.error).toBeUndefined();
    expect(dialled).toEqual([]);
  });

  it('with NO seam wired, the pre-Z4 refusal stands', async () => {
    // Single node and the writer: `wireNodeRuntime` returns null, bootstrap
    // spreads nothing, and this handler is the one that shipped before.
    const { pcId } = pcOnBothNodes();
    const token = pairOnWriter(pcId);
    const socket = wireMobileOnReplica();

    const ack = await socket.invoke('mobile:reconnect', { token });

    expect(ack.error).toBe('AUTH_TOKEN_INVALID');
    expect(dialled).toEqual([]);
  });
});

describe('the seam never leaves a handshake unanswered', () => {
  it('a read-through that REJECTS still produces exactly one refusal', async () => {
    // Unreachable by the gate's contract (it turns every failure into `false`),
    // and wired anyway: an unhandled rejection here would leave `next` uncalled,
    // and a handshake nobody answers is the one failure this path must not have.
    const seen: (string | null)[] = [];
    const socket = { handshake: { auth: { token: 'fm_' + 'a'.repeat(64) } }, data: {} as Record<string, unknown> };
    const mw = authMiddleware(tokenLookupOver(replica.db), undefined, {
      resolve: () => Promise.reject(new Error('a seam that broke its own contract')),
    });
    mw(socket, (err?: Error) => seen.push(err ? err.message : null));
    await vi.waitFor(() => expect(seen.length).toBe(1));
    expect(seen).toEqual(['AUTH_TOKEN_INVALID']);
  });
});
