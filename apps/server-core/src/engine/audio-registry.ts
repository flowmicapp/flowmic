// SPEC-REF:
//   docs/rebuild/06-STT-ENGINE-LAYER.md §2 (four-layer robustness / F-2135 grace +
//     resumeFromGrace; pc:mobile-left delayed until the grace window expires)
//   docs/rebuild/04-PROTOCOL-SPEC.md §3.3 (audio:pause / audio:resume)
//   packages/protocol/src/constants.ts AUDIO_DEFAULTS.mobile_drop_grace_ms
//   docs/strategy/2026-07-25-full-gap-audit/01-SERVER-PROTOCOL.md GA-04
//   CLAUDE.md red line: no silent failures; a latch closed by a remote event
//     must have a local watchdog
//
// AUDIO SESSION OWNERSHIP, decoupled from the socket (GA-04 minimal-closed-loop card).
//
// Before this module an audio/STT session lived and died with the socket that
// started it: a 2-second LTE blip disposed the orchestrator mid-utterance and
// the PC was told `pc:mobile-left` instantly, so the mobile's 30 s ring-buffer
// replay had no host to land in. The session now belongs to the PAIRING, not to
// the transport:
//
//   key = `${roomUuid}::${pairingId}`
//
// A drop starts a grace window (AUDIO_DEFAULTS.mobile_drop_grace_ms — this
// module is that constant's ONE production consumer); a mobile that returns
// inside the window ADOPTS the same entry (same orchestrator, same SeqTracker),
// and the PC never learns the phone was away. Only when the window expires is
// the orchestrator disposed and the deferred presence callback (bootstrap's
// leaveMobile + pc:mobile-left) finally run.
//
// Timers are injectable (tests never sleep). Nothing here emits protocol events
// itself except through the caller-supplied expiry callback.

import type { Socket } from 'socket.io';
import { AUDIO_DEFAULTS } from '@flowmic/protocol';
import type { RoomStore } from '../room/store';
import type { SttOrchestrator } from './orchestrator';

/** The ownership key: a session belongs to a (room, pairing), not to a socket. */
export function audioSessionKey(roomUuid: string, pairingId: string): string {
  return `${roomUuid}::${pairingId}`;
}

/** The mutable per-utterance state the audio handler drives. The handler works
 *  against this shape whether the session lives in the registry (paired mobile)
 *  or in the handler's own legacy per-socket slot (no roomUuid/pairingId). */
export interface AudioSessionState {
  /** null = no live utterance (a bare grace/presence entry, or a start that
   *  failed to build an engine — the fan-out bookkeeping below still applies). */
  orchestrator: SttOrchestrator | null;
  /** Explicit user/lifecycle pause (audio:pause). Chunks are NOT fed to the
   *  engine while set — see the audio handler for the (non-silent) semantics. */
  paused: boolean;
  /** Whether THIS utterance's audio:start was mirrored to the paired PC.
   *  Record-only (delivery:'none') never is, so audio:stop / audio:pause /
   *  audio:resume must not mirror an edge the PC never saw begin (GA-02). */
  fannedOut: boolean;
}

export interface AudioSessionEntry extends AudioSessionState {
  readonly key: string;
  readonly roomUuid: string;
  readonly pairingId: string;
  /** The socket this session is CURRENTLY bound to; null while in grace. */
  socket: Socket | null;
}

interface InternalEntry extends AudioSessionEntry {
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Deferred work owed to the PC if the mobile never comes back (presence). */
  onExpire: Array<() => void>;
}

export interface AudioSessionRegistryOptions {
  /** Injectable scheduler for deterministic tests (defaults to global timers). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Grace window; defaults to the protocol constant (F-2135, 30 s). */
  graceMs?: number;
}

export class AudioSessionRegistry {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly setT: typeof setTimeout;
  private readonly clearT: typeof clearTimeout;
  readonly graceMs: number;

  constructor(opts: AudioSessionRegistryOptions = {}) {
    this.setT = opts.setTimeoutFn ?? setTimeout;
    this.clearT = opts.clearTimeoutFn ?? clearTimeout;
    // *** the ONE production consumer of AUDIO_DEFAULTS.mobile_drop_grace_ms ***
    this.graceMs = opts.graceMs ?? AUDIO_DEFAULTS.mobile_drop_grace_ms;
  }

  get(key: string): AudioSessionEntry | null {
    return this.entries.get(key) ?? null;
  }

  /**
   * SEG-1 (R5, docs/strategy/2026-08-11-unified-transcription-session-design.md)
   * — READ-ONLY peek at the live session's contiguous-seq watermark
   * (SttOrchestrator.lastContiguousSeq → SeqTracker.lastContiguousSeq), for the
   * mobile:reconnect ack's `audio_last_contiguous_seq` field.
   *
   * `null` = 「no live audio session」 and the caller must OMIT the field
   * (absence is the wire's no-session signal — protocol-schemas-auth.ts). Three
   * ways to get null, all deliberate:
   *   · no entry for the key — the phone was idle or the grace already expired;
   *   · a bare grace/presence entry (`orchestrator === null`, the common
   *     idle-drop case beginGrace mints) — presence survived, no utterance did;
   *   · an orchestrator that does not answer the optional seam member (a fake)
   *     — cannot know ⇒ say nothing ⇒ the phone replays in full (fail toward
   *     duplication, never loss).
   * `-1` is a REAL answer, not a null: the session is live and has observed
   * zero chunks yet.
   *
   * MUST stay side-effect free: no adopt, no rebind, no grace-timer touch —
   * a peek that resumed a session would turn a status read into a state change.
   */
  peekLastContiguousSeq(key: string): number | null {
    const entry = this.entries.get(key);
    if (!entry || entry.orchestrator === null) return null;
    return entry.orchestrator.lastContiguousSeq ?? null;
  }

  size(): number {
    return this.entries.size;
  }

  /** Install a fresh session for `key`. A surviving same-key session is disposed
   *  first: a new audio:start IS a new utterance (never two engines on one
   *  pairing), and a pending grace is cancelled because the phone is provably
   *  back — its deferred pc:mobile-left must NOT fire. */
  put(init: { key: string; roomUuid: string; pairingId: string; socket: Socket; fannedOut: boolean }): AudioSessionEntry {
    this.dispose(init.key);
    const entry: InternalEntry = {
      key: init.key,
      roomUuid: init.roomUuid,
      pairingId: init.pairingId,
      socket: init.socket,
      orchestrator: null,
      paused: false,
      fannedOut: init.fannedOut,
      graceTimer: null,
      onExpire: [],
    };
    this.entries.set(init.key, entry);
    return entry;
  }

  /** Rebind a surviving session to the mobile's NEW socket and cancel the grace
   *  (F-2135 resumeFromGrace). Returns null when nothing survives — the caller
   *  then behaves exactly as it does today (a fresh audio:start builds one). */
  adopt(key: string, socket: Socket): AudioSessionEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.cancelGrace(entry);
    entry.socket = socket;
    return entry;
  }

  /** Detach the entry WITHOUT disposing its orchestrator — audio:stop hands the
   *  orchestrator to the finish() → dispose() chain, and disposing here would
   *  drop the terminal final mid-flush. Any pending grace is cancelled (a stop
   *  arriving means the phone is back and speaking). */
  detach(key: string): AudioSessionEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.cancelGrace(entry);
    this.entries.delete(key);
    return entry;
  }

  /** Tear the session down for good: engine disposed, timer cleared, entry gone.
   *  Any deferred expiry callback is DROPPED, not run (dispose is the "the phone
   *  is back / superseded" path; the expiry path calls its callbacks itself). */
  dispose(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.cancelGrace(entry);
    this.entries.delete(key);
    entry.socket = null;
    entry.orchestrator?.dispose();
    entry.orchestrator = null;
  }

  /**
   * The mobile's socket went away. Keep the session (and the room presence the
   * caller defers via `onExpire`) alive for the grace window instead of tearing
   * down on the transport edge.
   *
   * Idempotent per drop: a second caller for the same key (the audio handler and
   * bootstrap both observe the same disconnect) APPENDS its expiry callback to
   * the already-armed timer instead of restarting the window.
   *
   * `fromSocketId` guards the late-disconnect race: socket.io can deliver the
   * OLD socket's disconnect after the new one already adopted the session, and
   * starting a grace then would kill a live, reconnected utterance.
   */
  beginGrace(key: string, onExpire?: () => void, fromSocketId?: string): void {
    let entry = this.entries.get(key);
    if (entry && entry.socket !== null && fromSocketId !== undefined && entry.socket.id !== fromSocketId) {
      return; // a NEWER socket already owns this pairing — not a drop at all
    }
    if (!entry) {
      // No live utterance (the common case: the phone drops while idle). A bare
      // entry still gets a grace so the PRESENCE leg (pc:mobile-left) is delayed
      // exactly the same way — a blip (闪断) must never surface on the PC.
      const [roomUuid = '', pairingId = ''] = key.split('::');
      entry = {
        key, roomUuid, pairingId, socket: null,
        orchestrator: null, paused: false, fannedOut: false,
        graceTimer: null, onExpire: [],
      };
      this.entries.set(key, entry);
    }
    entry.socket = null; // in grace: nothing to emit the mobile leg to
    if (onExpire) entry.onExpire.push(onExpire);
    if (entry.graceTimer !== null) return; // window already running
    entry.graceTimer = this.setT(() => {
      const live = this.entries.get(key);
      if (!live) return;
      live.graceTimer = null;
      const owed = live.onExpire.slice();
      this.dispose(key);
      // Callbacks run AFTER the teardown so the PC's pc:mobile-left is the last
      // word about this pairing, never a half-disposed intermediate state.
      for (const cb of owed) cb();
    }, this.graceMs);
  }

  /**
   * The phone left ON PURPOSE — collapse the window `beginGrace` just armed and
   * run its teardown + owed callbacks NOW.
   *
   * Blip debouncing (闪断防抖) exists to hide a BLIP from the PC. A user who backs out of the
   * instance is not a blip: owner 2026-07-27 saw the capsule linger ~30 s after
   * the phone returned to the connection list. Same code path as expiry (dispose
   * first, callbacks last) so pc:mobile-left is still the last word.
   *
   * No-op unless a window is actually armed AND still unowned — a newer socket
   * that already adopted the session keeps it (beginGrace's guard, restated).
   */
  expireGraceNow(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.graceTimer === null || entry.socket !== null) return false;
    this.clearT(entry.graceTimer);
    entry.graceTimer = null;
    const owed = entry.onExpire.slice();
    this.dispose(key);
    for (const cb of owed) cb();
    return true;
  }

  /** Cancel every window and dispose every session (bootstrap close). Deferred
   *  expiry callbacks are dropped: the server is going down, it does not get to
   *  narrate presence on the way out. */
  stopAll(): void {
    for (const key of [...this.entries.keys()]) this.dispose(key);
  }

  private cancelGrace(entry: InternalEntry): void {
    if (entry.graceTimer !== null) this.clearT(entry.graceTimer);
    entry.graceTimer = null;
    entry.onExpire.length = 0;
  }
}

// ── socket-scoped access ────────────────────────────────────────────────
// The registry is published on the socket by the audio handler so a handler
// that does NOT own the audio deps (mobile.handler's reconnect path) can rebind
// the session with a single call and no deps-interface change.

export function publishAudioSessions(socket: Socket, registry: AudioSessionRegistry): void {
  (socket.data as { audioSessions?: AudioSessionRegistry }).audioSessions = registry;
}

export function getAudioSessions(socket: Socket): AudioSessionRegistry | null {
  return (socket.data as { audioSessions?: AudioSessionRegistry }).audioSessions ?? null;
}

/** The mobile:reconnect rebind hook (GA-04). Call right after the reconnect ack
 *  path has re-established auth/roomUuid and re-joined the room store: a session
 *  still inside its grace window is rebound to this socket, its grace cancelled,
 *  and the deferred pc:mobile-left never fires. Returns true when a session was
 *  actually adopted (false = nothing survived / audio layer not wired). */
export function adoptAudioSession(socket: Socket, roomUuid: string, pairingId: string): boolean {
  const registry = getAudioSessions(socket);
  if (!registry) return false;
  return registry.adopt(audioSessionKey(roomUuid, pairingId), socket) !== null;
}

/** SEG-1 (R5): the read-only companion to [[adoptAudioSession]], same
 *  socket-scoped access, same keying. Answers 「how far has the surviving
 *  session contiguously observed」 for the reconnect ack — see
 *  [[AudioSessionRegistry.peekLastContiguousSeq]] for the null/-1 semantics.
 *  Safe to call whether or not a session survived; touches nothing. */
export function peekAudioLastContiguousSeq(socket: Socket, roomUuid: string, pairingId: string): number | null {
  const registry = getAudioSessions(socket);
  if (!registry) return null;
  return registry.peekLastContiguousSeq(audioSessionKey(roomUuid, pairingId));
}

/**
 * Did this socket go away because its owner SAID SO, or because the network ate
 * it? socket.io already carries the answer and we do not need a protocol event
 * for it (57 stays 57): a client that calls `disconnect()` sends a namespace
 * DISCONNECT packet first — the Dart client included (socket_io_client
 * `Socket.disconnect()` → `packet({type: DISCONNECT})`) — and the server reports
 * `client namespace disconnect`. A blip reports `transport close` /
 * `ping timeout` / `transport error` and MUST keep its grace window.
 *
 * `server namespace disconnect` (pc:release-mobile disconnect, auth:expired) is
 * deliberately NOT in this set: those paths own their own presence story.
 */
export const DELIBERATE_LEAVE_REASON = 'client namespace disconnect';

export function isDeliberateLeave(reason: unknown): boolean {
  return reason === DELIBERATE_LEAVE_REASON;
}

/** The PRESENCE half of the grace: what the PC is told once the window really
 *  expires. Exported (rather than inlined in bootstrap) so the grace tests
 *  assert the production callback, not a copy of it.
 *
 *  GA-26's discriminator is preserved verbatim: leaveMobile's socket_id guard
 *  decides whether this socket still held the pairing, and the announcement
 *  follows its verdict — a phone that came back on a NEW socket already replaced
 *  itself in the store, and a live phone must never be announced as gone. */
export function mobileLeftOnGraceExpiry(args: {
  store: Pick<RoomStore<Socket>, 'leaveMobile' | 'getPc'>;
  roomUuid: string;
  pairingId: string;
  socketId: string;
}): () => void {
  return () => {
    const removed = args.store.leaveMobile(args.roomUuid, args.pairingId, args.socketId);
    if (removed) args.store.getPc(args.roomUuid)?.emit('pc:mobile-left', { mobile_id: args.pairingId });
  };
}
