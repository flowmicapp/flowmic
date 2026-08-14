// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.2 (heartbeat / liveness: sys:ping{nonce}
//     → sys:pong{nonce, ok}); §3.1 (pc:reconnect ack.connectedMobiles is the
//     ACTIVELY CONFIRMED set, not a raw membership snapshot)
//   docs/strategy/2026-07-25-full-gap-audit/01-SERVER-PROTOCOL.md GA-07
//
// The liveness probe behind pc:reconnect. Before the PC is told which phones it
// has, every mobile socket the RoomStore still lists is asked to prove it is
// alive: `sys:ping{nonce}` out, `sys:pong{nonce}` back inside the budget.
//
// WHY this exists (GA-07 + GA-26): socket.io only notices a dead peer after its
// own pingTimeout (20 s). A force-stopped phone therefore stays in the store for
// up to 20 s, and a PC reconnecting inside that window would be seeded with a
// GHOST — the exact "desktop shows 2 phones" the owner reproduced. A membership row
// is a memory of a socket; a pong is evidence.
//
// Both clients already answer (mobile health_handler.dart, desktop client.rs
// SYS_PING handler) — this is the emitter that was missing.
//
// TESTABILITY: the budget and the timer are injected (`LivenessDeps`), so a test
// drives a zombie/alive mix through the REAL code path with a fake timer and no
// real sleep. Nothing here knows about socket.io beyond a 3-method shape.

import { randomUUID } from 'node:crypto';
import { safeParseEvent } from '@flowmic/protocol';

/** 04 §3.2 probe budget: a phone that cannot answer in 1.5 s is not usable as a
 *  live input source anyway. Overridable per deployment/test, never at runtime. */
export const LIVENESS_PROBE_MS = 1500;

/** The socket surface the probe needs. `Socket` from socket.io satisfies it;
 *  a test fake is ~15 lines. */
export interface ProbeSocket {
  readonly id: string;
  emit(event: string, payload: unknown): unknown;
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
}

export interface ProbeTarget<S extends ProbeSocket> {
  mobile_id: string;
  socket: S;
}

export interface LivenessDeps {
  /** Budget in ms for the WHOLE probe (all targets share one deadline). */
  timeoutMs?: number;
  /** Timer seam — default global setTimeout/clearTimeout. Injected in tests so
   *  the deadline fires on demand instead of after a real 1.5 s. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Nonce factory — default randomUUID. Injected so a test can assert the
   *  nonce actually round-trips (a pong echoing the WRONG nonce is not proof). */
  newNonce?: () => string;
}

export interface LivenessResult {
  /** mobile_ids that answered with the matching nonce inside the budget. */
  alive: string[];
  /** mobile_ids that did not — the caller evicts these. */
  dead: string[];
}

/**
 * Probe every target once. Resolves as soon as ALL targets answered, or when the
 * shared budget expires — whichever comes first. Never rejects, never leaves a
 * listener behind (every `on` is paired with an `off` on both exits).
 *
 * A pong whose nonce does not match the one THIS probe sent is ignored (it is a
 * reply to an older probe, not evidence about now); the socket then simply times
 * out unless the right nonce arrives.
 */
export function probeMobileLiveness<S extends ProbeSocket>(
  targets: ProbeTarget<S>[],
  deps: LivenessDeps = {},
): Promise<LivenessResult> {
  const timeoutMs = deps.timeoutMs ?? LIVENESS_PROBE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const newNonce = deps.newNonce ?? (() => randomUUID());

  if (targets.length === 0) return Promise.resolve({ alive: [], dead: [] });

  return new Promise<LivenessResult>((resolve) => {
    const alive = new Set<string>();
    const listeners: { socket: S; fn: (payload: unknown) => void }[] = [];
    let settled = false;
    let timer: unknown;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      for (const { socket, fn } of listeners) socket.off('sys:pong', fn);
      resolve({
        alive: targets.filter((t) => alive.has(t.mobile_id)).map((t) => t.mobile_id),
        dead: targets.filter((t) => !alive.has(t.mobile_id)).map((t) => t.mobile_id),
      });
    };

    for (const target of targets) {
      const nonce = newNonce();
      const onPong = (payload: unknown): void => {
        const parsed = safeParseEvent('sys:pong', payload);
        if (!parsed.success || parsed.data.nonce !== nonce) return;
        alive.add(target.mobile_id);
        if (alive.size === targets.length) finish();
      };
      listeners.push({ socket: target.socket, fn: onPong });
      target.socket.on('sys:pong', onPong);
      target.socket.emit('sys:ping', { nonce });
    }

    // Every target may already have answered synchronously (a fake socket that
    // pongs inline) — finish() is idempotent, so arming after the loop is safe.
    if (!settled) timer = setTimer(finish, timeoutMs);
  });
}
