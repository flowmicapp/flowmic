// SPEC-REF:
//   docs/strategy/2026-10-11-replication-tiering-design.md §11 (REVOKE-PUSH)
//   apps/server-core/src/node/revocation-hint.ts       (writer: TEMP triggers + long-poll)
//   apps/server-core/src/node/revocation-follower.ts   (replica: hear, pull, sweep)
//   apps/server-core/src/node/forward-sync.ts          (`credentials_check`)
//   apps/server-core/src/http/node-routes-revocation-hint.ts
//
// ── WHAT THIS FILE PROVES, AND HOW ──────────────────────────────────────────
//
// Before REVOKE-PUSH a credential revoked on the writer kept working on a
// replica until the next 30-second pull for a NEW handshake, and FOREVER for a
// socket already connected there (nothing on a replica ever looked back at an
// admitted socket). The end-to-end case below runs two real databases, the real
// node routes behind a fetch shim, the real WriterClient, the real puller and
// the real follower, and asserts on the replica's sockets and the replica's
// handshake — never on an ack.
//
// The three claims, each with the reverse control that was seen red:
//   ① a revocation on the writer closes the replica's live session and refuses
//     the next handshake, within one hint + one pull — and ONLY that session
//     (D-25: the other phone and the PC stay up);
//   ② a row missing on the replica because of an import race is NOT treated as
//     a revocation — the writer is asked, says 「still here」, nothing closes;
//   ③ the hint counts only committed revocations, including cascades, and not
//     the heartbeat columns.
// Review follow-up (design §11-3 step 2, §11-4), same file, each seen red:
//   ⑤ hint-triggered pulls have a floor: eight revocations inside the window
//     buy ONE more pull, which still closes all eight (floor removed ⇒ 9 pulls);
//   ⑥ imports failing while the writer answers: the stale watchdog checks every
//     live session and closes only the revoked one (watchdog not sweeping ⇒
//     ⑥ and ⑦ time out);
//   ⑦ imports failing and the writer unreachable: nothing closes; the same
//     rounds close the revoked one once it answers (an unanswered chunk read as
//     「all absent」 ⇒ the valid-until-proven phone gets [emit, disconnect]).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { Registry } from '../src/room/registry';
import { authMiddleware } from '../src/auth/middleware';
import { tokenLookupOver } from '../src/bootstrap';
import { makeNodeRoutes, type NodeRoutesDeps } from '../src/http/node-routes';
import { makeWriterClient, type WriterClient } from '../src/node/writer-client';
import { makeTokenReadThrough } from '../src/node/token-read-through';
import { applyTokenResolution, resolveTokenRows } from '../src/node/token-rows';
import { makeSnapshotProducer } from '../src/node/snapshot';
import { makeReplicaPuller, type ReplicaPuller } from '../src/node/replica-puller';
import { makeForwardSyncDispatcher, credentialsCheckOnWriter } from '../src/node/forward-sync';
import { isCredentialsCheckResult } from '../src/node/forward-sync-types';
import { installRevocationHint, type RevocationHint } from '../src/node/revocation-hint';
import { makeRevocationFollower, type LiveSocket, type RevocationFollower } from '../src/node/revocation-follower';

type Db = ReturnType<typeof createDbConnection>;
interface Node { db: Db; registry: Registry }

const WRITER_URL = 'https://srvny.flowmic.app';
const SECRET = 'node-shared-secret-32-bytes-long!!';

function makeNode(): Node {
  const db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  return { db, registry: new Registry({ pcs: db.pcs, mobiles: db.mobiles }) };
}

/** The writer's HTTP side as a fetch shim the real WriterClient drives (the
 *  harness cross-node-token-read-through.test.ts established). Binary bodies
 *  pass through so the real snapshot route can be pulled. */
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
        end(payload?: string | Buffer) { resolve(new Response(payload ?? '', { status })); },
      } as unknown as ServerResponse;
      if (!handler(req, res)) resolve(new Response('', { status: 404 }));
    });
  }) as typeof fetch;
}

interface Log { info: (m: string, meta?: Record<string, unknown>) => void; warn: (m: string, meta?: Record<string, unknown>) => void; lines: string[] }
function captureLog(): Log {
  const lines: string[] = [];
  return { lines, info: (m) => { lines.push(`INFO ${m}`); }, warn: (m) => { lines.push(`WARN ${m}`); } };
}

/** A socket.io socket as far as the follower can tell, with its calls recorded
 *  IN ORDER (emit-before-disconnect is load-bearing on the wire). */
interface FakeSocket extends LiveSocket { calls: string[]; connected: boolean }
function fakeSocket(auth: Record<string, unknown>): FakeSocket {
  const s: FakeSocket = {
    connected: true,
    data: { auth },
    calls: [],
    emit(event: string, payload: unknown) { s.calls.push(`emit ${event} ${JSON.stringify(payload)}`); return true; },
    disconnect(close?: boolean) { s.calls.push(`disconnect ${String(close)}`); s.connected = false; return s; },
  };
  return s;
}

async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let pairSeq = 0;
function pairOn(node: Node, pcId: string): { token: string; id: string } {
  pairSeq += 1;
  const pc = node.db.pcs.findById(pcId)!;
  const { token, mobile } = node.registry.pairMobile({
    short_code: pc.short_code, mobile_name: `Pixel-${pairSeq}`, device_uid: `handset-${pairSeq}`,
  });
  return { token, id: mobile.id };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('REVOKE-PUSH ③ — the writer hint counts committed revocations only', () => {
  let n: Node;
  let hint: RevocationHint;
  beforeEach(() => {
    n = makeNode();
    hint = installRevocationHint(n.db.raw, { log: { info: () => {} }, pollMs: 5, bootId: 'boot-1' });
  });
  afterEach(() => { hint.stop(); n.db.close(); });

  it('watches all five tables on this build, with their revocation columns', () => {
    expect(Object.fromEntries(hint.watched.map((w) => [w.table, w.updateOf]))).toEqual({
      mobile_pairings: ['mobile_token', 'pc_device_id', 'user_id'],
      pc_devices: ['device_token', 'user_id'],
      users: ['restricted_at'],
      timeline_grants: ['revoked'],
      integrator_keys: ['revoked_at'],
    });
  });

  it('a revoke bumps; heartbeats, no-op rewrites and rolled-back deletes do not; a cascade does', () => {
    const { pc } = n.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const a = pairOn(n, pc.id);
    pairOn(n, pc.id);
    expect(hint.current()).toEqual({ boot: 'boot-1', gen: 0 });

    // Heartbeat columns are not revocations.
    n.db.raw.prepare('UPDATE mobile_pairings SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), a.id);
    n.db.raw.prepare('UPDATE pc_devices SET last_seen_at = ?, is_online = 1 WHERE id = ?').run(new Date().toISOString(), pc.id);
    // Re-writing a token to the value it already has is not a rotation.
    n.db.raw.prepare('UPDATE pc_devices SET device_token = device_token WHERE id = ?').run(pc.id);
    expect(hint.current().gen).toBe(0);

    expect(n.registry.revokeMobile(pc.id, a.id)).toBe(true);
    expect(hint.current().gen).toBe(1);

    // A delete that did not commit must not be announced.
    n.db.raw.exec('BEGIN');
    n.db.raw.prepare('DELETE FROM pc_devices WHERE id = ?').run(pc.id);
    n.db.raw.exec('ROLLBACK');
    expect(n.db.pcs.findById(pc.id)).not.toBeNull();
    expect(hint.current().gen).toBe(1);

    n.db.raw.prepare('UPDATE users SET restricted_at = ? WHERE id = ?').run(Date.now(), 'default');
    expect(hint.current().gen).toBe(2);

    // Account deletion: ONE statement, and the cascade fires the pairing and
    // PC triggers too (the case a per-route call would miss).
    expect(n.db.users.remove('default')).toBe(true);
    expect(hint.current().gen).toBeGreaterThanOrEqual(5); // pairing + pc + user
  });

  it('a long-poll is held, released by a change, by its deadline, and by stop()', async () => {
    const { pc } = n.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const a = pairOn(n, pc.id);

    const differs = hint.waitForChange({ boot: 'other-boot', gen: 0 }, 5_000);
    await expect(differs.promise).resolves.toEqual({ boot: 'boot-1', gen: 0 });

    const held = hint.waitForChange({ boot: 'boot-1', gen: 0 }, 5_000);
    let settled = false;
    void held.promise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    n.registry.revokeMobile(pc.id, a.id);
    await expect(held.promise).resolves.toEqual({ boot: 'boot-1', gen: 1 });

    const t0 = Date.now();
    await expect(hint.waitForChange({ boot: 'boot-1', gen: 1 }, 40).promise).resolves.toEqual({ boot: 'boot-1', gen: 1 });
    expect(Date.now() - t0).toBeLessThan(1_000);

    const parked = hint.waitForChange({ boot: 'boot-1', gen: 1 }, 5_000);
    hint.stop();
    await expect(parked.promise).resolves.toEqual({ boot: 'boot-1', gen: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REVOKE-PUSH — credentials_check on the writer', () => {
  it('answers absent for a missing row and for a re-parented one, present otherwise', () => {
    const w = makeNode();
    try {
      const { pc } = w.registry.registerPc({ device_name: 'pc', user_id: 'default' });
      const { pc: pc2 } = w.registry.registerPc({ device_name: 'pc2', user_id: 'default' });
      const a = pairOn(w, pc.id);
      const result = credentialsCheckOnWriter({ registry: w.registry }, {
        pairings: [{ id: a.id, pc_id: pc.id }, { id: a.id, pc_id: pc2.id }, { id: 'gone', pc_id: pc.id }],
        pcs: [{ id: pc.id, user_id: 'default' }, { id: pc.id, user_id: 'someone-else' }, { id: 'gone', user_id: 'default' }],
      });
      expect(result).toEqual({
        absent_pairings: [{ id: a.id, pc_id: pc2.id }, { id: 'gone', pc_id: pc.id }],
        absent_pcs: [{ id: pc.id, user_id: 'someone-else' }, { id: 'gone', user_id: 'default' }],
      });
      const dispatch = makeForwardSyncDispatcher({ registry: w.registry, repo: w.db.settings });
      expect(dispatch('credentials_check', { pairings: [{ id: 1 }], pcs: [] })).toEqual({ ok: false, error: 'malformed' });
      const tooMany = Array.from({ length: 501 }, (_, i) => ({ id: `p${i}`, user_id: 'u' }));
      expect(dispatch('credentials_check', { pairings: [], pcs: tooMany })).toEqual({ ok: false, error: 'malformed' });
      const ok = dispatch('credentials_check', { pairings: [], pcs: [{ id: pc.id, user_id: 'default' }] });
      expect(ok.ok && isCredentialsCheckResult(ok.result)).toBe(true);
    } finally {
      w.db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('REVOKE-PUSH ①② — end to end over the node channel', () => {
  let writer: Node;
  let replica: Node;
  let hint: RevocationHint;
  let client: WriterClient;
  let puller: ReplicaPuller;
  let follower: RevocationFollower;
  let log: Log;
  let dir: string;
  let sockets: FakeSocket[];
  /** When each HINT-TRIGGERED pull started (the follower's `pull` dep is only
   *  ever called from its triggered path; direct `puller.pull()` is not here). */
  let pullStarts: number[];
  interface Tune {
    minPullIntervalMs?: number;
    staleCeilingMs?: number;
    staleCheckMs?: number;
    wrapFetch?: (inner: typeof fetch) => typeof fetch;
  }

  function routesDeps(over: Partial<NodeRoutesDeps> = {}, opts: { noHint?: boolean } = {}): NodeRoutesDeps {
    return {
      nodeId: 'srvny',
      version: 'test',
      sharedSecret: SECRET,
      snapshot: makeSnapshotProducer(writer.db.raw),
      resolveToken: (t) => resolveTokenRows(writer.db, t),
      forwardSync: makeForwardSyncDispatcher({ registry: writer.registry, repo: writer.db.settings }),
      ...(opts.noHint ? {} : { revocationHint: hint }),
      ...over,
    };
  }

  /** The production wiring of node-runtime.ts, minus env: the puller's
   *  post-import hook drives the follower's sweep. */
  function wireReplica(deps: NodeRoutesDeps, fetchSnapshot?: () => Promise<Buffer>, tune: Tune = {}): void {
    const shim = fetchIntoRoutes(deps);
    client = makeWriterClient({
      writerUrl: WRITER_URL, sharedSecret: SECRET, nodeId: 'srvjp', fetchImpl: tune.wrapFetch ? tune.wrapFetch(shim) : shim,
    });
    let f: RevocationFollower | null = null;
    puller = makeReplicaPuller({
      db: replica.db.raw,
      fetchSnapshot: fetchSnapshot ?? (() => client.fetchSnapshot()),
      log,
      stagePath: join(dir, `stage-${Math.random().toString(36).slice(2)}.db`),
      setIntervalFn: () => null,
      onApplied: () => { void f?.sweep(); },
    });
    f = makeRevocationFollower({
      waitHint: (seen, ms, signal) => client.waitRevocationHint(seen, ms, signal),
      pull: () => { pullStarts.push(Date.now()); return puller.pull(); },
      lastAppliedAt: () => puller.lastAppliedAt(),
      pcs: replica.db.pcs,
      mobiles: replica.db.mobiles,
      checkOnWriter: async (req) => {
        const o = await client.forwardSync('credentials_check', { ...req });
        return o.status === 'ok' && isCredentialsCheckResult(o.result) ? o.result : null;
      },
      log,
      waitMs: 2_000,
      backoffMinMs: 20,
      minRoundMs: 20,
      minPullIntervalMs: tune.minPullIntervalMs ?? 10,
      // Out of the way unless a case is about it.
      staleCeilingMs: tune.staleCeilingMs ?? 60_000,
      staleCheckMs: tune.staleCheckMs ?? 60_000,
    });
    follower = f;
  }

  function handshake(token: string): Promise<string | null> {
    const readThrough = makeTokenReadThrough({
      askWriter: (t) => client.resolveToken(t),
      apply: (rows) => applyTokenResolution(replica.db, rows),
      log: { info: () => {}, warn: () => {} },
    });
    const socket = { handshake: { auth: { token } }, data: {} as Record<string, unknown> };
    const mw = authMiddleware(tokenLookupOver(replica.db), undefined, readThrough);
    return new Promise((resolve) => { mw(socket, (err?: Error) => resolve(err ? err.message : null)); });
  }

  beforeEach(() => {
    writer = makeNode();
    replica = makeNode();
    hint = installRevocationHint(writer.db.raw, { log: { info: () => {} }, pollMs: 5 });
    log = captureLog();
    dir = mkdtempSync(join(tmpdir(), 'revoke-push-'));
    sockets = [];
    pullStarts = [];
  });
  afterEach(() => {
    follower?.stop();
    puller?.stop();
    hint.stop();
    writer.db.close();
    replica.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('① a revoke on the writer closes THAT phone on the replica and refuses its next handshake — nobody else', async () => {
    const { pc, token: pcToken } = writer.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const a = pairOn(writer, pc.id);
    const b = pairOn(writer, pc.id);
    wireReplica(routesDeps());

    const phoneA = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: a.id, deviceId: pc.id });
    const phoneB = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: b.id, deviceId: pc.id });
    const pcSock = fakeSocket({ kind: 'pc', userId: 'default', deviceId: pc.id });
    sockets.push(phoneA, phoneB, pcSock);

    // Start: the first hint answer counts as a change ⇒ one pull lands the rows.
    follower.bindSockets(() => sockets);
    await until(() => puller.lastAppliedAt() !== null && replica.db.mobiles.findById(a.id) !== null);
    // Positive control: before the revoke, the replica admits A from its OWN rows.
    expect(await handshake(a.token)).toBeNull();

    const t0 = Date.now();
    expect(writer.registry.revokeMobile(pc.id, a.id)).toBe(true);
    await until(() => phoneA.calls.length >= 2);
    const elapsedMs = Date.now() - t0;
    console.info(`REVOKE-PUSH in-process: writer revoke → replica eviction in ${elapsedMs} ms`);

    // The writer's own eviction shape, emit FIRST.
    expect(phoneA.calls).toEqual([
      'emit mobile:released {"retry_after_ms":0,"revoked":true}',
      'disconnect true',
    ]);
    // D-25: the other phone of the same account and PC, and the PC, stay up.
    expect(phoneB.calls).toEqual([]);
    expect(pcSock.calls).toEqual([]);
    // The next handshake is refused, authoritatively; B's still lands.
    expect(replica.db.mobiles.findById(a.id)).toBeNull();
    expect(await handshake(a.token)).toBe('AUTH_TOKEN_INVALID');
    expect(await handshake(b.token)).toBeNull();
    expect(await handshake(pcToken)).toBeNull();
    expect(elapsedMs).toBeLessThan(2_000);
    expect(log.lines).toContain('INFO node.revocation: closed sessions whose credential the writer no longer holds');
  });

  it('① removing a PC on the writer closes the PC and every phone of it on the replica', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const { pc: other } = writer.registry.registerPc({ device_name: 'other', user_id: 'default' });
    const a = pairOn(writer, pc.id);
    const c = pairOn(writer, other.id);
    wireReplica(routesDeps());
    const phoneA = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: a.id, deviceId: pc.id });
    const pcSock = fakeSocket({ kind: 'pc', userId: 'default', deviceId: pc.id });
    const phoneC = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: c.id, deviceId: other.id });
    const otherSock = fakeSocket({ kind: 'pc', userId: 'default', deviceId: other.id });
    sockets.push(phoneA, pcSock, phoneC, otherSock);
    follower.bindSockets(() => sockets);
    await until(() => replica.db.pcs.findById(pc.id) !== null);

    writer.db.pcs.remove(pc.id);
    await until(() => pcSock.calls.length >= 1 && phoneA.calls.length >= 2);
    expect(pcSock.calls).toEqual(['disconnect true']); // no phone event on a PC
    expect(phoneA.calls[0]).toBe('emit mobile:released {"retry_after_ms":0,"revoked":true}');
    expect(phoneC.calls).toEqual([]);
    expect(otherSock.calls).toEqual([]);
  });

  it('② a row lost to an import race is NOT a revocation: the writer is asked, says it exists, nothing closes', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const stale = await makeSnapshotProducer(writer.db.raw)();
    const c = pairOn(writer, pc.id);
    wireReplica(routesDeps(), async () => stale);
    expect(await handshake(c.token)).toBeNull();
    const phoneC = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: c.id, deviceId: pc.id });
    sockets.push(phoneC);
    // The first hint answer triggers a pull of the STALE snapshot, which deletes
    // the landed row; the post-import sweep then meets a candidate.
    follower.bindSockets(() => sockets);
    await until(() => puller.lastAppliedAt() !== null);
    expect(replica.db.mobiles.findById(c.id)).toBeNull();
    const report = await follower.sweep();
    // The harm first: a valid phone told 「the computer cancelled this pairing」.
    expect(phoneC.calls).toEqual([]);
    expect(report).toEqual({ candidates: 1, confirmedAbsent: 0, evicted: 0, unverified: 0 });
  });

  it('an older writer (no verb, no hint route) closes nothing and says so once', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const a = pairOn(writer, pc.id);
    const oldDispatcher = makeForwardSyncDispatcher({ registry: writer.registry, repo: writer.db.settings });
    wireReplica(routesDeps({
      forwardSync: (verb, payload) => (verb === 'credentials_check' ? { ok: false, error: 'unknown_verb' } : oldDispatcher(verb, payload)),
    }, { noHint: true }));
    const phoneA = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: a.id, deviceId: pc.id });
    sockets.push(phoneA);
    follower.bindSockets(() => sockets);
    await until(() => log.lines.some((l) => l.startsWith('WARN node.revocation hints unavailable')));
    await puller.pull();
    writer.registry.revokeMobile(pc.id, a.id);
    await puller.pull();
    const report = await follower.sweep();
    expect(phoneA.calls).toEqual([]);
    expect(report).toEqual({ candidates: 1, confirmedAbsent: 0, evicted: 0, unverified: 1 });
    expect(log.lines.filter((l) => l.startsWith('WARN node.revocation: could not confirm')).length).toBe(1);
  });

  it('⑤ a burst of revocations inside the floor window costs ONE more pull, and loses none of them', async () => {
    const WINDOW = 600;
    const { pc } = writer.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const phones = Array.from({ length: 8 }, () => pairOn(writer, pc.id));
    wireReplica(routesDeps(), undefined, { minPullIntervalMs: WINDOW });
    const socks = phones.map((p) => fakeSocket({ kind: 'mobile', userId: 'default', pairingId: p.id, deviceId: pc.id }));
    sockets.push(...socks);
    follower.bindSockets(() => sockets);
    await until(() => pullStarts.length === 1 && replica.db.mobiles.findById(phones[7]!.id) !== null);
    const t0 = pullStarts[0]!;

    // Eight revocations 30 ms apart: each is its own hint answer (the writer
    // polls its counter every 5 ms here), so without the floor each would buy
    // its own pull.
    for (const p of phones) {
      expect(writer.registry.revokeMobile(pc.id, p.id)).toBe(true);
      await new Promise((r) => setTimeout(r, 30));
    }
    // The test's own timing premise: every bump landed inside the window.
    expect(Date.now() - t0).toBeLessThan(WINDOW);

    await until(() => socks.every((s) => s.calls.length >= 2));
    await new Promise((r) => setTimeout(r, WINDOW + 100)); // nothing else is coming
    console.info(`REVOKE-PUSH floor: 8 revocations → ${pullStarts.length - 1} hint-triggered pull(s) after the boot pull`);
    expect(pullStarts.length).toBe(2);
    expect(pullStarts[1]! - t0).toBeGreaterThanOrEqual(WINDOW - 5);
    // None lost: the coalesced pull started after the last bump and closed all eight.
    for (const s of socks) expect(s.calls[0]).toBe('emit mobile:released {"retry_after_ms":0,"revoked":true}');
  });

  it('⑥ imports failing while the writer answers: every live session is checked, and only the revoked one closes', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const a = pairOn(writer, pc.id);
    const b = pairOn(writer, pc.id);
    let snapshotsWork = true;
    wireReplica(routesDeps(), async () => {
      if (!snapshotsWork) throw new Error('snapshot route broken');
      return client.fetchSnapshot();
    }, { staleCeilingMs: 400, staleCheckMs: 50 });
    const phoneA = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: a.id, deviceId: pc.id });
    const phoneB = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: b.id, deviceId: pc.id });
    const pcSock = fakeSocket({ kind: 'pc', userId: 'default', deviceId: pc.id });
    sockets.push(phoneA, phoneB, pcSock);
    follower.bindSockets(() => sockets);
    await until(() => replica.db.mobiles.findById(a.id) !== null);

    snapshotsWork = false;
    expect(writer.registry.revokeMobile(pc.id, a.id)).toBe(true);
    // The hint fires, the pull fails: the import path can close nothing, and
    // the replica's rows are frozen with A still in them.
    await until(() => log.lines.some((l) => l.startsWith('WARN node.revocation: on-demand pull FAILED')));
    expect(replica.db.mobiles.findById(a.id)).not.toBeNull();

    await until(() => phoneA.calls.length >= 2);
    expect(phoneA.calls).toEqual([
      'emit mobile:released {"retry_after_ms":0,"revoked":true}',
      'disconnect true',
    ]);
    // D-25 under the full check too: same PC, same account, still up.
    expect(phoneB.calls).toEqual([]);
    expect(pcSock.calls).toEqual([]);
    expect(log.lines).toContain('WARN node.revocation: no committed import for too long — every live session is checked with the writer each round');
  });

  it('⑦ imports failing AND the writer unreachable: nothing closes (fail-open); once it answers, the revoked one does', async () => {
    const { pc } = writer.registry.registerPc({ device_name: 'pc', user_id: 'default' });
    const a = pairOn(writer, pc.id);
    const b = pairOn(writer, pc.id);
    let writerUp = true;
    let snapshotsWork = true;
    wireReplica(routesDeps(), async () => {
      if (!snapshotsWork) throw new Error('snapshot route broken');
      return client.fetchSnapshot();
    }, {
      staleCeilingMs: 300,
      staleCheckMs: 50,
      wrapFetch: (inner) => (async (input: string | URL, init?: RequestInit) => {
        if (!writerUp) throw new TypeError('fetch failed');
        return inner(input, init);
      }) as typeof fetch,
    });
    const phoneA = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: a.id, deviceId: pc.id });
    const phoneB = fakeSocket({ kind: 'mobile', userId: 'default', pairingId: b.id, deviceId: pc.id });
    const pcSock = fakeSocket({ kind: 'pc', userId: 'default', deviceId: pc.id });
    sockets.push(phoneA, phoneB, pcSock);
    follower.bindSockets(() => sockets);
    await until(() => replica.db.mobiles.findById(a.id) !== null);

    snapshotsWork = false;
    writerUp = false;
    expect(writer.registry.revokeMobile(pc.id, a.id)).toBe(true);
    await until(() => log.lines.some((l) => l.startsWith('WARN node.revocation: no committed import for too long')));
    await new Promise((r) => setTimeout(r, 300)); // several full rounds against a silent writer
    // The harm first: a session closed on nobody's word.
    expect(phoneA.calls).toEqual([]);
    expect(phoneB.calls).toEqual([]);
    expect(pcSock.calls).toEqual([]);
    expect(log.lines.filter((l) => l.startsWith('WARN node.revocation: could not confirm')).length).toBe(1);

    // Positive control: the same rounds, with the writer answering again (and
    // imports STILL failing, so only the watchdog can do it), close A only.
    writerUp = true;
    await until(() => phoneA.calls.length >= 2);
    expect(phoneB.calls).toEqual([]);
    expect(pcSock.calls).toEqual([]);
    expect(log.lines).toContain('INFO node.revocation: writer confirmation recovered');
  });

  it('the hint route takes the shared secret only', async () => {
    const deps = routesDeps({ snapshotSecret: 'read-only-snapshot-key-32-bytes!!' });
    const f = fetchIntoRoutes(deps);
    const ask = (secret: string) => f(`${WRITER_URL}/api/node/revocation-hint?wait_ms=0`, { headers: { 'x-flowmic-node-secret': secret } });
    expect((await ask('read-only-snapshot-key-32-bytes!!')).status).toBe(403);
    expect((await ask('wrong')).status).toBe(403);
    const ok = await ask(SECRET);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, gen: 0 });
    const none = fetchIntoRoutes(routesDeps({}, { noHint: true }));
    expect((await none(`${WRITER_URL}/api/node/revocation-hint`, { headers: { 'x-flowmic-node-secret': SECRET } })).status).toBe(501);
  });
});
