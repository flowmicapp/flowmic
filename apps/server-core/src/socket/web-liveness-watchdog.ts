// SPEC-REF:
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.2 (sys:ping{nonce} → sys:pong{nonce, ok})
//   src/socket/server.ts (PING_INTERVAL_MS / PING_TIMEOUT_MS — the GLOBAL engine
//     heartbeat this file deliberately does NOT touch)
//   src/room/liveness.ts (the other sys:ping emitter: a ONE-SHOT probe at
//     pc:reconnect; this one is a standing watch on a single socket)
//   src/socket/handlers/mobile-room-admission.ts (`joinAndNotify` — the ONE
//     arming site, i.e. the moment a socket takes a room slot)
//   docs/strategy/2026-08-27-next-release-feature-and-optimization-ledger.md NR-69
//
// ── WHY A SECOND HEARTBEAT EXISTS AT ALL ────────────────────────────────────
//
// socket.io's own liveness is pingInterval 10 s / pingTimeout 20 s, and those
// numbers are NOT ours to shrink: lesson N5 relaxed pingTimeout to 20 s
// precisely because a single-isolate Dart phone can stall past a tighter window
// under recording bursts, and that setting is GLOBAL — one number for the
// desktop, the handset and the browser alike. A browser tab has no such excuse
// (its event loop is not ours to block for seconds at a time) and it dies in
// ways a handset does not: the tab is closed from the OS switcher, the laptop
// lid shuts, the page is discarded under memory pressure. In every one of those
// the page never gets to say goodbye, and the desktop waits pingTimeout (20 s)
// PLUS the audio grace (AUDIO_DEFAULTS.mobile_drop_grace_ms, 30 s) before its
// capsule retreats — the owner's 2026-09-17 report.
//
// So the 7 s rule is scoped to what it can honestly hold: WEB-kind mobile
// sockets only. `clientOriginOf` is the one author of "what kind of end is
// this" (a NULL `mobile_pairings.client` reads as 'app'), and the Dart handset
// is never armed here — see the negative control in the tests.
//
// ── A DEAD TAB IS NOT A PHONE IN A TUNNEL ───────────────────────────────────
//
// The audio grace window exists to hide a BLIP from the PC: a handset that
// walks through a lift comes back on a new socket inside 30 s and the desktop
// never learns it was away. A tab that stopped answering a 2.5 s ping for 7 s
// is not that: the page is gone, discarded, or its whole event loop is wedged,
// and nothing is going to resume that session. Announcing it as present for
// another 30 s is the shape the red line forbids — a wait with no mechanism
// behind it. A watchdog drop is therefore marked on the socket, and the
// disconnect handler collapses the grace on the spot, exactly as it does for a
// client that said it was leaving.
//
// 🔴 IT IS MARKED RATHER THAN INFERRED FROM THE REASON STRING. socket.io reports
// a server-side `socket.disconnect()` as 'server namespace disconnect', and
// audio-registry.ts's `isDeliberateLeave` deliberately EXCLUDES that reason
// because the other paths that produce it (pc:release-mobile, auth:expired) own
// their own presence story. This path owns its own too — and says so in a flag
// it sets itself, instead of borrowing a string three other paths also produce.
//
// ── THE PROBATION RULE, AND THE DEPLOY ORDER IT BUYS BACK ────────────────────
//
// 🔴 A watchdog that drops any web socket which fails to pong would kill every
// browser page already in the field the moment this relay ships — the answering
// half lives in the web client and a cached tab has yesterday's build. The
// failure direction is chosen so that it cannot: enforcement is ARMED BY THE
// FIRST PONG. Until this socket has proven once that it can answer, a silence
// stands the watch DOWN (logged, once) instead of dropping anything, and that
// client degrades to exactly today's behaviour — pingTimeout + grace. There is
// therefore no "relay first / client first" hazard, and no version gate.
//
// ⚠️ The hole this leaves, stated rather than hidden: a web client that dies
// inside its first ping interval — before it has ever ponged — is not
// watchdogged. That is today's behaviour, not a regression, and it is the price
// of not shooting every tab that predates this change.
//
// ── ONE PROCESS, ONE WATCH ──────────────────────────────────────────────────
//
// Nothing here is gated on writer/replica (node/node-runtime.ts), and that is
// deliberate rather than overlooked: the watch is per-SOCKET and a socket exists
// in exactly one process, so the node that holds it is the node that watches it
// and no second node can duplicate the drop. The announcement it triggers is
// local for the same reason the existing one is — `mobileLeftOnGraceExpiry`
// emits to `store.getPc(roomUuid)`, this process's room map. A PC sitting on a
// DIFFERENT node from its phone therefore learns nothing from this watch, which
// is the already-open cross-node fan-out account (WP-6), not something this
// file adds.

import type { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { clientOriginOf, safeParseEvent } from '@flowmic/protocol';
import { log } from '../log';

/** How often a web socket is asked to prove it is there. Short enough that the
 *  budget below can be crossed by a genuinely dead tab within a second or two of
 *  the deadline, long enough to be invisible next to the audio frames already on
 *  this wire. */
export const WEB_LIVENESS_PING_MS = 2_500;

/**
 * 🔴 THE 7 SECOND RULE (owner, 2026-09-17). Silence longer than this on a
 * WEB-kind mobile socket ends the connection. It is not derived from the engine
 * heartbeat and must never be collapsed into it: `PING_INTERVAL_MS` /
 * `PING_TIMEOUT_MS` in socket/server.ts are one global setting shared with the
 * Dart handset, and shrinking those to 7 s would re-open lesson N5.
 */
export const WEB_LIVENESS_SILENCE_MS = 7_000;

/** The socket surface this watch needs. `Socket` satisfies it; a test fake is
 *  ~20 lines. Kept small on purpose, so a test cannot accidentally end up
 *  testing socket.io instead of this file. */
export interface WatchedSocket {
  readonly id: string;
  emit(event: string, payload: unknown): unknown;
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
  disconnect(close?: boolean): unknown;
  data: Record<string, unknown>;
}

export interface WebLivenessDeps {
  /** Ping cadence. Overridable per test, never at runtime. */
  pingMs?: number;
  /** Silence budget. Overridable per test, never at runtime. */
  silenceMs?: number;
  /** Timer seam — a test drives the whole watch with no real sleep. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Clock seam, paired with the timer seam: silence is measured against this,
   *  not against a count of ticks, so a process that was itself stalled cannot
   *  mistake its own missed timers for an answering client. */
  now?: () => number;
  /** Nonce factory. Injected so a test can prove a pong echoing the WRONG nonce
   *  is not accepted as evidence (a stale reply is not news about now). */
  newNonce?: () => string;
}

/** What `joinAndNotify` calls. One signature, so the arming site cannot grow a
 *  second opinion about which sockets are watched. */
export type WebLivenessArmer = (
  socket: WatchedSocket,
  client: string | null | undefined,
  deps?: WebLivenessDeps,
) => void;

const DROP_FLAG = 'webLivenessDropped';

/** Set by this file immediately BEFORE it closes a socket, read by
 *  disconnect.handler.ts. See the header for why this is a flag and not a
 *  reason-string comparison. */
function markWebLivenessDrop(socket: WatchedSocket): void {
  socket.data[DROP_FLAG] = true;
}

/**
 * Did THIS socket go away because the web liveness watch ended it?
 *
 * The one consumer is `makeDisconnectHandler`'s mobile branch, which collapses
 * the audio grace window for a `true` — a dead tab does not get 30 s of being
 * announced to the desktop as present.
 */
export function wasWebLivenessDrop(socket: { data?: unknown } | null | undefined): boolean {
  const data = socket?.data as Record<string, unknown> | undefined;
  return data?.[DROP_FLAG] === true;
}

/**
 * Watch one socket, if it is a browser end.
 *
 * No-op for an 'app' client and for a row that says nothing (`clientOriginOf`'s
 * default) — the Dart handset keeps socket.io's 20 s window and every behaviour
 * it had before this file existed.
 *
 * Self-disarming: the watch removes its own pong listener and cancels its own
 * timer on `disconnect`, so a socket that leaves for any other reason costs
 * nothing.
 */
export const armWebLivenessWatchdog: WebLivenessArmer = (socket, client, deps = {}): void => {
  if (clientOriginOf(client ?? null) !== 'web') return;

  const pingMs = deps.pingMs ?? WEB_LIVENESS_PING_MS;
  const silenceMs = deps.silenceMs ?? WEB_LIVENESS_SILENCE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? ((): number => Date.now());
  const newNonce = deps.newNonce ?? ((): string => randomUUID());

  /** Nonces this watch has sent and not yet seen answered. Bounded: a pong
   *  proves life and empties it, and the cap stops an unanswering client from
   *  growing it without limit. */
  const outstanding = new Set<string>();
  const outstandingCap = 8;

  let lastHeardAt = now();
  /** 🔴 The probation latch — see the header. Enforcement starts at the first
   *  pong and not before. */
  let provenAlive = false;
  let timer: unknown = null;
  let stopped = false;

  const onPong = (payload: unknown): void => {
    const parsed = safeParseEvent('sys:pong', payload);
    // A pong whose nonce this watch never sent is a reply to somebody else's
    // probe (room/liveness.ts runs its own at pc:reconnect) — not evidence
    // about this watch's question.
    if (!parsed.success || !outstanding.has(parsed.data.nonce)) return;
    outstanding.clear();
    lastHeardAt = now();
    provenAlive = true;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimer(timer);
    socket.off('sys:pong', onPong);
    socket.off('disconnect', stop);
  };

  const tick = (): void => {
    if (stopped) return;
    const silentFor = now() - lastHeardAt;
    if (silentFor > silenceMs) {
      if (!provenAlive) {
        // An older build that does not answer sys:ping. Stand down rather than
        // drop it: this client has done nothing wrong, and the enforcing half
        // ships in its own release.
        log.info('web liveness watch stood down: this client never answered sys:pong', {
          socketId: socket.id,
          silent_ms: silentFor,
        });
        stop();
        return;
      }
      log.info('web liveness watch: dropping a silent browser end', {
        socketId: socket.id,
        silent_ms: silentFor,
        budget_ms: silenceMs,
      });
      // Marked BEFORE the close, because the close fires `disconnect`
      // synchronously and the handler reads the flag on the way past.
      markWebLivenessDrop(socket);
      stop();
      socket.disconnect(true);
      return;
    }
    const nonce = newNonce();
    if (outstanding.size >= outstandingCap) outstanding.clear();
    outstanding.add(nonce);
    socket.emit('sys:ping', { nonce });
    timer = setTimer(tick, pingMs);
  };

  socket.on('sys:pong', onPong);
  socket.on('disconnect', stop);
  timer = setTimer(tick, pingMs);
};

/** The same watch on a socket.io `Socket`, so production wiring never casts. */
export function armWebLiveness(socket: Socket, client: string | null | undefined): void {
  armWebLivenessWatchdog(socket as unknown as WatchedSocket, client);
}
