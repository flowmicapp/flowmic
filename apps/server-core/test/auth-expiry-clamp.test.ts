// R1 (owner ruling 2026-08-27, docs/decisions/2026-08-27-owner-persistent-login-
// and-routing-order.md §R1) — the JWT TTL became 100 years, and THAT ALONE WOULD
// HAVE DISCONNECTED EVERY SIGNED-IN SOCKET THE MOMENT IT CONNECTED.
//
// 🔴 THE MECHANISM, because a comment that only says "clamp it" teaches nothing:
// Node stores a timer's delay in a SIGNED 32-BIT INT. A delay above 2^31-1 ms
// (~24.855 days) overflows, Node emits TimeoutOverflowWarning, and the timer is
// re-scheduled with a delay of **1** — i.e. it fires AT ONCE. `armAuthExpiry`
// computed `exp*1000 - now()` and handed it straight to `setTimeout`, so a token
// good for a century produced a watchdog that fired inside the same tick and
// emitted `auth:expired` + disconnect. Persistent login would have shipped as
// "you can never stay connected".
//
// *** HUMAN-AUDIT SENSITIVE (auth) — reviewable in isolation ***
//
// ⚠️ REAL TIMERS ON PURPOSE. The overflow lives in Node's own timer
// implementation; a fake-timer library re-implements scheduling and therefore
// re-implements it WITHOUT the 32-bit truncation — the bug would be invisible
// and this file would be green against the broken code. That is the "先核你的
// 尺子" rule: the ruler must be the thing the product actually runs on.

import { describe, it, expect } from 'vitest';
import type { Socket } from 'socket.io';
import { armAuthExpiry, MAX_TIMEOUT_MS } from '../src/socket/handlers/auth-expiry';

class FakeSocket {
  emitted: { event: string; payload: unknown }[] = [];
  disconnected = false;
  data: Record<string, unknown> = {};
  private handlers = new Map<string, ((...a: unknown[]) => void)[]>();

  on(event: string, fn: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }

  disconnect(): this {
    this.disconnected = true;
    return this;
  }

  listenerCount(event: string): number {
    return (this.handlers.get(event) ?? []).length;
  }

  fireDisconnect(): void {
    for (const fn of this.handlers.get('disconnect') ?? []) fn();
  }
}

const SECOND = 1000;
const YEAR_SEC = 365 * 24 * 60 * 60;
/** Long enough for a timer scheduled with the overflow-truncated delay of 1 ms
 *  to have fired several times over, short enough to keep the suite fast. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

function arm(socket: FakeSocket, expEpochSec: number): void {
  armAuthExpiry(socket as unknown as Socket, expEpochSec);
}

describe('armAuthExpiry — a far-future exp must not be armed at all', () => {
  it('🔴 100-year token: the socket is NOT kicked (this is the case the TTL change created)', async () => {
    const socket = new FakeSocket();
    arm(socket, Math.floor(Date.now() / SECOND) + 100 * YEAR_SEC);
    await settle();
    expect(socket.disconnected).toBe(false);
    expect(socket.emitted).toEqual([]);
  });

  it('no timer is left behind either — nothing was scheduled, so there is nothing to clear', async () => {
    const socket = new FakeSocket();
    arm(socket, Math.floor(Date.now() / SECOND) + 100 * YEAR_SEC);
    // Not arming means not registering the disconnect cleanup: a `clearTimeout`
    // listener for a timer that does not exist is a second, silent claim that
    // something is being watched.
    expect(socket.listenerCount('disconnect')).toBe(0);
    await settle();
    expect(socket.disconnected).toBe(false);
  });

  it('the boundary is the timer limit itself, not a rounded-off guess', () => {
    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
  });

  it('positive control: an exp just INSIDE the limit still arms — otherwise "not kicked" above could just be a broken arm path', async () => {
    const socket = new FakeSocket();
    // ~24.8 days out: under the limit, so a timer really is scheduled (and is
    // cleaned up on disconnect). It must not fire during this test.
    arm(socket, Math.floor((Date.now() + MAX_TIMEOUT_MS - 60_000) / SECOND));
    expect(socket.listenerCount('disconnect')).toBe(1);
    await settle();
    expect(socket.disconnected).toBe(false);
    socket.fireDisconnect();
  });
});

describe('armAuthExpiry — near-term behaviour is unchanged (the legacy 7-day tokens still in the wild)', () => {
  it('an exp already in the past fires immediately: emit auth:expired then disconnect', async () => {
    const socket = new FakeSocket();
    arm(socket, Math.floor(Date.now() / SECOND) - 60);
    await settle();
    expect(socket.emitted).toEqual([{ event: 'auth:expired', payload: {} }]);
    expect(socket.disconnected).toBe(true);
  });

  it('an exp a few ms out fires at that moment, once', async () => {
    const socket = new FakeSocket();
    arm(socket, (Date.now() + 10) / SECOND);
    await settle();
    expect(socket.emitted).toEqual([{ event: 'auth:expired', payload: {} }]);
    expect(socket.disconnected).toBe(true);
  });

  it('a 7-day exp arms a real timer and does not fire early', async () => {
    const socket = new FakeSocket();
    arm(socket, Math.floor((Date.now() + 7 * 24 * 60 * 60 * SECOND) / SECOND));
    expect(socket.listenerCount('disconnect')).toBe(1);
    await settle();
    expect(socket.disconnected).toBe(false);
    socket.fireDisconnect();
  });
});
