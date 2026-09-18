// Connection-layer guard (src/socket/connection-guard.ts).
//
// WHAT THIS FILE PINS — the two facts the guard exists to make true, and the
// two it must NOT make true:
//   ① one network cannot hold more than N sockets at once, and closing one
//      admits one more (a ceiling that only ever counted up would lock a
//      network out permanently, which is the failure mode of a leaking counter);
//   ② a socket that never identifies itself is closed at T, while one that
//      pairs or registers before T is left alone;
//   ③ two different networks never share a budget;
//   ④ standalone is untouched — the guard is not installed there at all, which
//      is asserted at the wiring (`createSocketServer`), not by asking the guard
//      to be nice.
//
// The sockets here are structural doubles rather than a real socket.io server:
// the mechanisms under test are a counter and a timer, and driving them through
// a real engine would measure socket.io's reconnection behaviour instead.
// `pair-brute-force-e2e.test.ts` is the file that uses a real server.

import { describe, it, expect, vi } from 'vitest';
import {
  SocketConnectionGuard,
  DEFAULT_MAX_PER_IP,
  DEFAULT_UNAUTH_TTL_MS,
  IP_CEILING_REFUSAL_CODE,
  resolveSocketMaxPerIp,
  resolveSocketUnauthTtlMs,
  type GuardableSocket,
} from '../src/socket/connection-guard';
import { ERROR_CODES } from '@flowmic/protocol';

interface Double extends GuardableSocket {
  disconnected: boolean;
  fireDisconnect(): void;
}

function socketFrom(ip: string, data: Record<string, unknown> = { auth: null }): Double {
  const listeners: Array<() => void> = [];
  return {
    handshake: { address: ip },
    data,
    on(_event, listener) { listeners.push(listener); return this; },
    disconnect() { (this as Double).disconnected = true; return this; },
    disconnected: false,
    fireDisconnect() { for (const l of listeners) l(); },
  };
}

/** Admit (or refuse) one socket; returns the error the handshake carried. */
function admit(guard: SocketConnectionGuard, socket: Double): Error | undefined {
  let err: Error | undefined;
  guard.middleware(socket, (e) => { err = e; });
  return err;
}

function makeGuard(over: Partial<ConstructorParameters<typeof SocketConnectionGuard>[0]> = {}): SocketConnectionGuard {
  return new SocketConnectionGuard({ maxPerIp: 3, unauthTtlMs: 60_000, ipSalt: 'test-salt', nodeId: 'test', ...over });
}

describe('per-IP concurrent socket ceiling', () => {
  it('admits N and refuses the N+1th from the same address', () => {
    const guard = makeGuard();
    const held = [socketFrom('203.0.113.7'), socketFrom('203.0.113.7'), socketFrom('203.0.113.7')];
    for (const s of held) expect(admit(guard, s)).toBeUndefined();
    expect(guard.openCountFor('203.0.113.7')).toBe(3);

    const refused = admit(guard, socketFrom('203.0.113.7'));
    expect(refused?.message).toBe(IP_CEILING_REFUSAL_CODE);
    // The ceiling must not count the socket it just refused — a refused
    // handshake never completes, so no `disconnect` will ever give the slot back.
    expect(guard.openCountFor('203.0.113.7')).toBe(3);
  });

  it('closing one socket admits one more', () => {
    const guard = makeGuard();
    const first = socketFrom('203.0.113.7');
    for (const s of [first, socketFrom('203.0.113.7'), socketFrom('203.0.113.7')]) admit(guard, s);
    expect(admit(guard, socketFrom('203.0.113.7'))?.message).toBe(IP_CEILING_REFUSAL_CODE);

    first.fireDisconnect();
    expect(guard.openCountFor('203.0.113.7')).toBe(2);
    expect(admit(guard, socketFrom('203.0.113.7'))).toBeUndefined();
  });

  it('a second disconnect for the same socket does not hand back a second slot', () => {
    // Idempotence is the property that keeps the counter honest: socket.io fires
    // `disconnect` once, but the TTL path closes a socket itself, so the release
    // can be reached twice for one admission.
    const guard = makeGuard();
    const s = socketFrom('203.0.113.7');
    admit(guard, s);
    s.fireDisconnect();
    s.fireDisconnect();
    expect(guard.openCountFor('203.0.113.7')).toBe(0);
  });

  it('two addresses are independent budgets', () => {
    const guard = makeGuard();
    for (let i = 0; i < 3; i++) admit(guard, socketFrom('203.0.113.7'));
    expect(admit(guard, socketFrom('203.0.113.7'))?.message).toBe(IP_CEILING_REFUSAL_CODE);
    // A different network is unaffected by the first one's exhaustion.
    expect(admit(guard, socketFrom('198.51.100.4'))).toBeUndefined();
    expect(guard.openCountFor('198.51.100.4')).toBe(1);
  });

  it('counts an IPv6 client by its /64, not by its address', () => {
    // A single device is routinely handed many addresses inside one /64; counting
    // the full address would give it an unlimited supply of fresh budgets — the
    // cap would exist and do nothing, which is the failure trial-ip-bucket.ts
    // calls worse than no cap because it would be believed.
    const guard = makeGuard();
    admit(guard, socketFrom('2001:db8:0:1::1'));
    admit(guard, socketFrom('2001:db8:0:1::2'));
    admit(guard, socketFrom('2001:db8:0:1::3'));
    expect(admit(guard, socketFrom('2001:db8:0:1::4'))?.message).toBe(IP_CEILING_REFUSAL_CODE);
  });

  it('the refusal code is a registered one', () => {
    expect(Object.keys(ERROR_CODES)).toContain(IP_CEILING_REFUSAL_CODE);
  });
});

describe('unauthenticated idle cutoff', () => {
  it('closes a socket that never identified itself, at T', () => {
    vi.useFakeTimers();
    try {
      const guard = makeGuard();
      const s = socketFrom('203.0.113.7'); // data.auth stays null
      admit(guard, s);

      vi.advanceTimersByTime(59_999);
      expect(s.disconnected).toBe(false);
      vi.advanceTimersByTime(2);
      expect(s.disconnected).toBe(true);
      // …and the slot came back with it.
      expect(guard.openCountFor('203.0.113.7')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a socket that paired before T alone', () => {
    vi.useFakeTimers();
    try {
      const guard = makeGuard();
      const s = socketFrom('203.0.113.7');
      admit(guard, s);
      // What `mobile:pair` does on success: socket/wire.ts `setAuth`.
      vi.advanceTimersByTime(30_000);
      (s.data as Record<string, unknown>).auth = { userId: 'u1', pairingId: 'p1', kind: 'mobile' };
      vi.advanceTimersByTime(120_000);

      expect(s.disconnected).toBe(false);
      expect(guard.openCountFor('203.0.113.7')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a PC that registered alone', () => {
    vi.useFakeTimers();
    try {
      const guard = makeGuard();
      const s = socketFrom('203.0.113.7');
      admit(guard, s);
      (s.data as Record<string, unknown>).auth = { userId: 'u1', deviceId: 'pc1', kind: 'pc' };
      vi.advanceTimersByTime(120_000);
      expect(s.disconnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a socket that arrived WITH a token alone (auth set at the handshake)', () => {
    vi.useFakeTimers();
    try {
      const guard = makeGuard();
      const s = socketFrom('203.0.113.7', { auth: { userId: 'u1', deviceId: 'pc1', kind: 'pc' } });
      admit(guard, s);
      vi.advanceTimersByTime(120_000);
      expect(s.disconnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire after the socket already went away', () => {
    vi.useFakeTimers();
    try {
      const guard = makeGuard();
      const s = socketFrom('203.0.113.7');
      admit(guard, s);
      s.fireDisconnect();
      vi.advanceTimersByTime(120_000);
      expect(s.disconnected).toBe(false); // nothing tried to close a dead socket
      expect(guard.openCountFor('203.0.113.7')).toBe(0); // and no double-release
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('configuration', () => {
  it('falls back rather than becoming NaN', () => {
    // A NaN ceiling compares false against every count and silently disables the
    // guard; a NaN cutoff arms a timer that fires immediately and drops every
    // pairing in flight. Both directions are worse than the default.
    expect(resolveSocketMaxPerIp({ FLOWMIC_SOCKET_MAX_PER_IP: 'lots' })).toBe(DEFAULT_MAX_PER_IP);
    expect(resolveSocketMaxPerIp({ FLOWMIC_SOCKET_MAX_PER_IP: '0' })).toBe(DEFAULT_MAX_PER_IP);
    expect(resolveSocketMaxPerIp({})).toBe(DEFAULT_MAX_PER_IP);
    expect(resolveSocketMaxPerIp({ FLOWMIC_SOCKET_MAX_PER_IP: '40' })).toBe(40);

    expect(resolveSocketUnauthTtlMs({ FLOWMIC_SOCKET_UNAUTH_TTL_MS: 'soon' })).toBe(DEFAULT_UNAUTH_TTL_MS);
    expect(resolveSocketUnauthTtlMs({ FLOWMIC_SOCKET_UNAUTH_TTL_MS: '-1' })).toBe(DEFAULT_UNAUTH_TTL_MS);
    expect(resolveSocketUnauthTtlMs({ FLOWMIC_SOCKET_UNAUTH_TTL_MS: '5000' })).toBe(5_000);
  });
});

describe('standalone is unaffected', () => {
  // The wiring, not the guard, is what keeps a LAN server out of this: bootstrap
  // builds a guard ONLY in saas, so standalone's `createSocketServer` call
  // carries no `connectionGuard` and the io chain is the one that shipped before
  // this file existed. Counting socket.io's own middleware list is the only way
  // to assert an ABSENCE here; the positive case below is what proves the count
  // is reading the right list rather than a field that is always short by one.
  const middlewareCount = async (withGuard: boolean): Promise<number> => {
    const { createServer } = await import('node:http');
    const { createSocketServer } = await import('../src/socket/server');
    const httpServer = createServer();
    const handle = createSocketServer({
      httpServer,
      authMiddleware: (_s, next) => next(),
      ...(withGuard ? { connectionGuard: makeGuard().middleware } : {}),
    });
    const count = ((handle.io.of('/') as unknown as { _fns?: unknown[] })._fns ?? []).length;
    await handle.close();
    httpServer.close();
    return count;
  };

  it('installs only the auth middleware when no guard is passed', async () => {
    expect(await middlewareCount(false)).toBe(1);
  });

  it('positive control — a passed guard really does become a second middleware', async () => {
    expect(await middlewareCount(true)).toBe(2);
  });
});
