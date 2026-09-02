// E7 — initBridge()'s two seed-vs-push races (CONNECTION snapshot, OFFLINE_STATE),
// fixed via the same guard seedThenSubscribe implements elsewhere (see
// lib/seed-then-subscribe.ts and connectionPushCount's doc in store.ts for why
// this site could not just call the shared helper directly).
//
// `bridge.ts` gates every invoke/listen on `__TAURI_INTERNALS__` being present
// on `window` (pairing-bridge.test.ts already established this stub pattern),
// and `listen`'s mock below defers its resolution one microtask like the real
// Tauri IPC does — so a push fired synchronously right after `initBridge()`
// starts is NOT already "subscribed" the instant `onChannel(...)` is called,
// unlike the plain unit fixtures in seed-then-subscribe.test.ts. Real bridge
// listeners always cross this real async boundary.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (payload: unknown) => void;

const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
const listenCallbacks = new Map<string, Listener[]>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  // One microtask hop, like a real IPC round trip — NOT synchronous like the
  // pure seed-then-subscribe.test.ts fixtures, which is exactly why this file
  // exists as a SEPARATE test from that one: it proves the guard survives a
  // subscribe() that resolves asynchronously, not just one that resolves eagerly.
  listen: vi.fn(async (channel: string, cb: (e: { payload: unknown }) => void) => {
    await Promise.resolve();
    const fn: Listener = (payload) => cb({ payload });
    const arr = listenCallbacks.get(channel) ?? [];
    arr.push(fn);
    listenCallbacks.set(channel, arr);
    return () => {
      const remaining = (listenCallbacks.get(channel) ?? []).filter((f) => f !== fn);
      listenCallbacks.set(channel, remaining);
    };
  }),
}));

const hadWindow = 'window' in globalThis;
(globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
afterAll(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const { initBridge, conn, connByChannel, offlineMode } = await import('./store');
const { CH } = await import('../lib/bridge');

/** Fire every listener registered for `channel`, synchronously. */
function push(channel: string, payload: unknown): void {
  for (const cb of listenCallbacks.get(channel) ?? []) cb(payload);
}

/** A deferred promise, so the test controls exactly when an invoke resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  invoke.mockReset();
  listenCallbacks.clear();
  invoke.mockResolvedValue(null); // safe default for every command this test does not care about
  Object.assign(conn, { connected: false, registered: false, mobiles: 0 });
  for (const k of Object.keys(connByChannel)) delete connByChannel[k];
  offlineMode.value = false;
});

describe('E7 — initBridge seed-vs-push races', () => {
  it('a CONNECTION push during the in-flight snapshot pull wins — the stale snapshot is discarded', async () => {
    const snapshotCall = deferred<unknown>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'connection_snapshot') return snapshotCall.promise;
      return Promise.resolve(null);
    });

    const bridgeReady = initBridge();
    // Let initBridge register its listeners (each `onChannel` await crosses
    // one microtask via the mocked `listen` above) and reach the
    // connection_snapshot call, which is now parked on `snapshotCall`.
    await vi.waitFor(() => expect((listenCallbacks.get(CH.connection) ?? []).length).toBeGreaterThan(0));

    // A LIVE frame arrives while the snapshot pull is still in flight.
    push(CH.connection, { channel: 'lan', connected: true, registered: true, mobiles: 2 });
    expect(conn.connected).toBe(true);
    expect(conn.mobiles).toBe(2);

    // The snapshot NOW resolves, with a stale, pre-push answer.
    snapshotCall.resolve([{ channel: 'lan', connected: false, registered: false, mobiles: 0 }]);
    await bridgeReady;

    // The stale snapshot must not have overwritten the live push.
    expect(conn.connected).toBe(true);
    expect(conn.mobiles).toBe(2);
    expect(connByChannel.lan?.connected).toBe(true);
  });

  it('the snapshot is applied normally when no push raced it', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'connection_snapshot') {
        return Promise.resolve([{ channel: 'lan', connected: true, registered: true, mobiles: 1 }]);
      }
      return Promise.resolve(null);
    });
    await initBridge();
    expect(conn.connected).toBe(true);
    expect(conn.mobiles).toBe(1);
  });

  it('an OFFLINE_STATE push during the in-flight offline_state pull wins', async () => {
    const offlineCall = deferred<unknown>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'offline_state') return offlineCall.promise;
      return Promise.resolve(null);
    });

    const bridgeReady = initBridge();
    await vi.waitFor(() => expect((listenCallbacks.get(CH.offlineState) ?? []).length).toBeGreaterThan(0));

    push(CH.offlineState, { offline: true });
    expect(offlineMode.value).toBe(true);

    // A stale answer resolves after the push above.
    offlineCall.resolve({ offline: false });
    await bridgeReady;

    expect(offlineMode.value).toBe(true);
  });

  it('the offline seed is applied normally when no push raced it', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'offline_state') return Promise.resolve({ offline: true });
      return Promise.resolve(null);
    });
    await initBridge();
    expect(offlineMode.value).toBe(true);
  });
});
