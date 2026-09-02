// OPS-1 (2026-09-02 production investigation) - auth-refusal-log.test.ts pins
// the shared helper (auth/refusal-log.ts) in isolation; THIS file pins that the
// production call sites actually reach it. Before this change, a socket
// refused AUTH_TOKEN_INVALID / AUTH_TOKEN_EXPIRED / AUTH_TOKEN_UNVERIFIABLE /
// ACCOUNT_RESTRICTED at any of these points left NOTHING in the server log -
// the iOS P0 that started this work could not be attributed server-side for
// exactly this reason.
//
// Real handlers over a real sqlite db + real Registry + real RoomStore (the
// pc-reconnect-account-auth.test.ts harness pattern) - a fake auth layer would
// only prove the helper again, not that these files call it.
//
// REVERSE CONTROL (seen red): temporarily removing the `logAuthRefusal(...)`
// call from pc.handler.ts's `pc:reconnect` local-miss branch (the exact line
// OPS-1 found silent) turned "an unknown pc:reconnect token is logged" red -
// 0 calls instead of 1 - while the ack itself (`{error: 'AUTH_TOKEN_INVALID'}`)
// stayed unchanged. Restored afterward; grep for `logAuthRefusal` in
// pc.handler.ts confirms the call is back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { NODE_CAN_WRITE } from '../src/node/writer-only';
import { authMiddleware, type AuthContext } from '../src/auth/middleware';
import { registerPcHandlers } from '../src/socket/handlers/pc.handler';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import type { RestrictionReader } from '../src/auth/account-restriction';
import { signJwt } from '../src/auth/jwt';
import { log } from '../src/log';
import { authRefusalLog } from '../src/auth/refusal-log';

type Db = ReturnType<typeof createDbConnection>;

interface SocketData {
  auth: AuthContext | null;
  roomUuid?: string;
  accountAuthError?: 'AUTH_TOKEN_EXPIRED' | 'AUTH_TOKEN_INVALID';
  account?: { userId: string; plan: 'free' | 'pro' | 'max'; exp: number } | null;
}

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();
  readonly handshake = { address: '10.0.0.9' };

  constructor(readonly id: string, public data: SocketData = { auth: null }) {}

  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  off(): this { return this; }
  emit(event: string, payload: unknown): boolean { this.emitted.push({ event, payload }); return true; }
  disconnect(): this { return this; }

  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      for (const fn of list) fn(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }
}

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function wirePc(socket: FakeSocket): FakeSocket {
  registerPcHandlers(socket as unknown as Socket, {
    writerOnly: NODE_CAN_WRITE,
    io: {} as Server,
    registry,
    store,
    resolveActingUser: () => ({ userId: 'default' }),
    nodeId: 'srvny',
  });
  return socket;
}

function wireMobile(socket: FakeSocket, restriction: RestrictionReader, mode: 'standalone' | 'saas' = 'standalone'): FakeSocket {
  registerMobileHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    pairLimiter: new PairRateLimiter(),
    writerOnly: NODE_CAN_WRITE,
    mode,
    resolveActingUser: () => ({ userId: 'default' }),
    restriction,
    nodeId: 'srvny',
  });
  return socket;
}

const NEVER_RESTRICTED: RestrictionReader = { getUser: () => ({ restricted_at: null, restriction_reason: null }) };

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore<Socket>();
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  authRefusalLog.resetForTests();
});
afterEach(() => {
  db.close();
  warnSpy.mockRestore();
});

function refusalCalls(): Record<string, unknown>[] {
  return warnSpy.mock.calls.filter((c) => c[0] === 'auth: refused').map((c) => c[1] as Record<string, unknown>);
}

describe('pc.handler.ts pc:reconnect - a refusal now logs', () => {
  it('an unknown token: ack unchanged, AND a log.warn line names the node/kind/code', async () => {
    const sock = wirePc(new FakeSocket('s-pc'));
    const ack = await sock.invoke('pc:reconnect', { token: 'z'.repeat(64) });
    expect(ack).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    const calls = refusalCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ code: 'AUTH_TOKEN_INVALID', where: 'pc:reconnect', kind: 'pc', node: 'srvny', token_prefix: 'zzz' });
  });

  it('a positive control - a successful pc:register never logs a refusal', async () => {
    const sock = wirePc(new FakeSocket('s-pc-ok'));
    const ack = await sock.invoke('pc:register', { device_name: 'PC-A', client_instance_id: 'desktop-instance-aaaa' });
    expect(ack.error).toBeUndefined();
    expect(refusalCalls()).toHaveLength(0);
  });
});

describe('mobile.handler.ts mobile:reconnect - a refusal now logs', () => {
  it('an unknown token: ack unchanged, AND a log.warn line names the node/kind/code', async () => {
    const sock = wireMobile(new FakeSocket('s-mob'), NEVER_RESTRICTED);
    const ack = await sock.invoke('mobile:reconnect', { token: 'y'.repeat(64), device_uid: 'device-abcd1234' });
    expect(ack).toEqual({ error: 'AUTH_TOKEN_INVALID' });
    const calls = refusalCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ code: 'AUTH_TOKEN_INVALID', where: 'mobile:reconnect', kind: 'mobile', node: 'srvny', token_prefix: 'yyy' });
  });
});

describe('mobile.handler.ts refuseRestricted - the ACCOUNT_RESTRICTED admission gate now logs', () => {
  const RESTRICTED: RestrictionReader = { getUser: () => ({ restricted_at: 1_700_000_000_000, restriction_reason: 'terms_violation' }) };

  it('a restricted account trying the saas cloud-instance admission is refused AND logged with its userId', async () => {
    const sock = wireMobile(new FakeSocket('s-mob-restricted'), RESTRICTED, 'saas');
    const ack = await sock.invoke('mobile:pair', { cloud_instance: true });
    expect(ack).toMatchObject({ error: 'ACCOUNT_RESTRICTED', reason: 'terms_violation' });
    const calls = refusalCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ code: 'ACCOUNT_RESTRICTED', where: 'mobile:restricted', kind: 'mobile', node: 'srvny', user_id: 'default' });
  });
});

describe('auth/middleware.ts authMiddleware - a handshake refusal now logs', () => {
  const SECRET = Buffer.from('handshake-refusal-log-secret-32b', 'utf8');
  const NOW = 1_800_000_000_000;

  function runHandshake(auth: Record<string, unknown>): { err: string | null; data: Record<string, unknown> } {
    const socket = { handshake: { auth }, data: {} as Record<string, unknown> };
    let err: Error | undefined;
    const lookup = { findPcByToken: () => null, findMobileByToken: () => null };
    const mw = authMiddleware(lookup, { secret: SECRET, nowMs: () => NOW }, undefined, 'srvny');
    mw(socket, (e) => { err = e; });
    return { err: err ? err.message : null, data: socket.data };
  }

  it('an invalid handshake JWT is logged (no token/kind known yet)', () => {
    const r = runHandshake({ jwt: 'not-a-jwt' });
    expect(r.err).toBeNull(); // handshake itself never rejects (04 SS2)
    expect(r.data.accountAuthError).toBe('AUTH_TOKEN_INVALID');
    const calls = refusalCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ code: 'AUTH_TOKEN_INVALID', where: 'handshake-jwt', kind: null, node: 'srvny' });
  });

  it('an expired handshake JWT is logged with the EXPIRED code', () => {
    const expired = signJwt({ sub: 'u1', plan: 'free' }, { secret: SECRET, ttlMs: -1000, now: () => NOW });
    const r = runHandshake({ jwt: expired });
    expect(r.data.accountAuthError).toBe('AUTH_TOKEN_EXPIRED');
    expect(refusalCalls()[0]).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED', where: 'handshake-jwt' });
  });

  it('an unknown opaque token is logged and the connection is refused', () => {
    const r = runHandshake({ token: 'fm_' + 'd'.repeat(64) });
    expect(r.err).toBe('AUTH_TOKEN_INVALID');
    const calls = refusalCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ code: 'AUTH_TOKEN_INVALID', where: 'handshake-token', kind: null, node: 'srvny', token_prefix: 'fm_' });
  });

  it('a positive control - no token, no jwt: nothing is refused, nothing is logged', () => {
    const r = runHandshake({});
    expect(r.err).toBeNull();
    expect(refusalCalls()).toHaveLength(0);
  });
});
