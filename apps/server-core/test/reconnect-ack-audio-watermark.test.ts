// SEG-1 (R5, docs/strategy/2026-08-11-unified-transcription-session-design.md):
// the mobile:reconnect ack carries `audio_last_contiguous_seq` — the surviving
// audio session's SeqTracker watermark — so the phone can trim its 30 s ring
// replay (card SEG-2) instead of always re-sending everything.
//
// What this file pins, and against WHICH parts:
//   · the watermark on the ack is the PRODUCTION chain's number, not a fake's:
//     a real SttSessionBridge (real AudioSession, real SeqTracker) is fed
//     chunks with known seqs, held in a real grace window, and read back
//     through the real mobile.handler reconnect path;
//   · ABSENCE is the no-session signal — asserted on the KEY (`in` /
//     JSON.stringify), never on an undefined-valued property read, because the
//     wire cannot tell `{k: undefined}` from a missing key but a zod consumer
//     can; every absence test carries a positive control (the ack itself
//     arrived) so a zero can never be a blind probe (G13 rule ②);
//   · `-1` is a VALUE (session live, zero chunks yet), not an absence — the
//     suite holds both states side by side so they can never be collapsed;
//   · the peek is side-effect free: it must not adopt, rebind, or disturb an
//     armed grace timer (「do not change grace/rebind semantics」).

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server, Socket } from 'socket.io';
import type { SttEngineId } from '@flowmic/protocol';
import { registerMobileHandlers } from '../src/socket/handlers/mobile.handler';
import { Registry } from '../src/room/registry';
import { RoomStore } from '../src/room/store';
import { PairRateLimiter } from '../src/room/pair-rate-limit';
import { createDbConnection } from '../src/db/connection';
import { deriveKey } from '../src/auth/crypto';
import {
  AudioSessionRegistry, audioSessionKey, publishAudioSessions,
} from '../src/engine/audio-registry';
import { SttSessionBridge } from '../src/engine/stt-session';
import { SttEngineOrchestrator } from '../src/stt/orchestrator-core';
import type { SttEngine, EngineState } from '../src/stt/engines/base';
import type { AudioSession } from '../src/stt/audio/session';
import type { VadGate } from '../src/stt/vad-gate';

type Db = ReturnType<typeof createDbConnection>;

class FakeSocket {
  readonly emitted: { event: string; payload: unknown }[] = [];
  connected = true;
  disconnected = 0;
  readonly handshake = { address: '10.0.0.9' };
  private readonly handlers = new Map<string, ((payload: unknown, ack: unknown) => void)[]>();
  data: { auth?: unknown; roomUuid?: string; audioSessions?: unknown } = {};
  constructor(readonly id: string) {}
  on(event: string, fn: (payload: unknown, ack: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }
  disconnect(_close?: boolean): this {
    this.disconnected += 1;
    this.connected = false;
    return this;
  }
  invoke(event: string, payload: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const list = this.handlers.get(event) ?? [];
      if (list.length === 0) return resolve({ __no_handler: true });
      for (const fn of list) fn(payload, (r: unknown) => resolve((r ?? {}) as Record<string, unknown>));
    });
  }
}

/** Injected scheduler for the grace window — nothing sleeps, nothing fires
 *  unless a test says so, and `pending()` proves an armed window stayed armed. */
function fakeClock(): { setTimeoutFn: typeof setTimeout; clearTimeoutFn: typeof clearTimeout; pending: () => number } {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const setTimeoutFn = ((cb: () => void) => {
    const id = nextId++;
    timers.set(id, cb);
    return id as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((h: unknown) => { timers.delete(h as number); }) as unknown as typeof clearTimeout;
  return { setTimeoutFn, clearTimeoutFn, pending: () => timers.size };
}

/** The engine is irrelevant here — the watermark lives in the AudioSession's
 *  SeqTracker, which the bridge advances on every pushChunk whether or not the
 *  vendor leg is up. A stub keeps the test off the network. */
class FakeEngine extends EventEmitter implements SttEngine {
  private _state: EngineState = 'closed';
  constructor(public readonly id: SttEngineId = 'custom-openai-compatible') { super(); }
  get state(): EngineState { return this._state; }
  async open(): Promise<void> { this._state = 'open'; }
  push(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<void> { this._state = 'closed'; }
}

/** A REAL SttSessionBridge over a real AudioSession + real SeqTracker — the
 *  production implementation of the seam's `lastContiguousSeq`, i.e. the very
 *  getter mobile.handler's peek reads in production. */
function makeBridge(): SttSessionBridge {
  return new SttSessionBridge({
    build: (session: AudioSession, _lang: string, _uid: string, _vad?: VadGate) => ({
      orchestrator: new SttEngineOrchestrator(session, () => new FakeEngine(), { engineFlushTimeoutMs: 200 }),
      isByok: false,
      gated: false,
    }),
    emitter: { emit: (_event, _payload) => { /* nothing observes stt:* here */ } },
    userId: 'default',
    mode: 'realtime',
    sourceLang: 'zh',
    onComplete: () => {},
    levelIntervalMs: 0,
  });
}

const PCM = Buffer.alloc(320).toString('base64'); // 10 ms of s16le silence
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

let db: Db;
let registry: Registry;
let store: RoomStore<Socket>;
let audioSessions: AudioSessionRegistry;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  db = createDbConnection({ dbPath: ':memory:', encryptionKey: deriveKey('test-secret-32-bytes-or-more-xx') });
  db.users.insert({ id: 'default', display_name: 'D', plan: 'free' });
  registry = new Registry({ pcs: db.pcs, mobiles: db.mobiles });
  store = new RoomStore<Socket>();
  clock = fakeClock();
  audioSessions = new AudioSessionRegistry({ setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
});
afterEach(() => {
  audioSessions.stopAll(); // finalize sessions → the 5-min hard-limit timers die
  db.close();
});

function wireMobile(socket: FakeSocket): FakeSocket {
  registerMobileHandlers(socket as unknown as Socket, {
    io: {} as Server,
    registry,
    store,
    pairLimiter: new PairRateLimiter({}),
    mode: 'standalone',
    resolveActingUser: () => ({ userId: 'default' }),
    // A2-3 (F1) — the admission gate's reader, pointed at the REAL repo. Nobody
    // is restricted here, so the SEG-1 watermark assertions are unchanged. Not
    // optional in the deps on purpose (mobile.handler.ts).
    restriction: { getUser: (id) => db.users.findById(id) },
  });
  // In production every socket gets the registry from registerAudioHandlers
  // (bootstrap wires both handler sets per connection); the reconnect path —
  // adopt AND peek — reads it off the socket, so the test publishes it the same
  // way rather than reaching around the socket-scoped access.
  publishAudioSessions(socket as unknown as Socket, audioSessions);
  return socket;
}

/** A paired phone whose FIRST socket owns a live audio session entry. */
function pairedPhoneWithSession(): { token: string; mobileId: string; roomUuid: string; key: string; oldSock: FakeSocket } {
  const { pc } = registry.registerPc({ device_name: 'PC-A', user_id: 'default', client_instance_id: 'desktop-instance-aaaa' });
  const paired = registry.pairMobile({ short_code: pc.short_code, mobile_name: 'Pixel 9', user_id: 'default' });
  const oldSock = new FakeSocket('sock-old');
  store.joinMobile(pc.room_uuid, paired.mobile.id, oldSock as unknown as Socket);
  const key = audioSessionKey(pc.room_uuid, paired.mobile.id);
  return { token: paired.token, mobileId: paired.mobile.id, roomUuid: pc.room_uuid, key, oldSock };
}

describe('mobile:reconnect ack — audio_last_contiguous_seq (SEG-1 R5)', () => {
  it('a grace-held session puts the EXACT SeqTracker watermark on the ack', async () => {
    const { token, key, roomUuid, mobileId, oldSock } = pairedPhoneWithSession();
    const entry = audioSessions.put({ key, roomUuid, pairingId: mobileId, socket: oldSock as unknown as Socket, fannedOut: false });
    const bridge = makeBridge();
    entry.orchestrator = bridge;
    await tick(); // let the engine open (irrelevant to the tracker, tidy anyway)

    // Known seqs: 0,1,2 contiguous, then 4 across a gap. The watermark answers
    // 「contiguously observed」, so it must be 2 — NOT the max (4). A phone
    // trimming at 4 would drop the never-received seq 3: the exact loss this
    // field's contract forbids.
    bridge.pushChunk(0, PCM, 0);
    bridge.pushChunk(1, PCM, 10);
    bridge.pushChunk(2, PCM, 20);
    bridge.pushChunk(4, PCM, 40);
    expect(bridge.lastContiguousSeq).toBe(2); // the production getter itself

    audioSessions.beginGrace(key, undefined, oldSock.id); // the phone dropped
    expect(clock.pending()).toBe(1);

    const back = wireMobile(new FakeSocket('sock-new'));
    const ack = await back.invoke('mobile:reconnect', { token });
    expect(ack.pairing_id).toBe(mobileId); // accepted, not refused
    expect('audio_last_contiguous_seq' in ack).toBe(true);
    expect(ack.audio_last_contiguous_seq).toBe(2);
    // The reconnect adopted the session (grace cancelled) — the peek itself
    // must not have been what did it; the adopt hook was already there.
    expect(clock.pending()).toBe(0);
    expect(audioSessions.get(key)?.socket).toBe(back as unknown as Socket);
  });

  it('a live session with ZERO chunks answers -1 — present, never collapsed into absence', async () => {
    const { token, key, roomUuid, mobileId, oldSock } = pairedPhoneWithSession();
    const entry = audioSessions.put({ key, roomUuid, pairingId: mobileId, socket: oldSock as unknown as Socket, fannedOut: false });
    entry.orchestrator = makeBridge();
    await tick();
    audioSessions.beginGrace(key, undefined, oldSock.id);

    const back = wireMobile(new FakeSocket('sock-new'));
    const ack = await back.invoke('mobile:reconnect', { token });
    expect(ack.pairing_id).toBe(mobileId);
    // -1 means 「session exists, nothing observed yet」 — the phone still gets a
    // watermark (trim nothing, send everything) rather than the no-session
    // fallback, and the two states stay distinguishable on the wire.
    expect('audio_last_contiguous_seq' in ack).toBe(true);
    expect(ack.audio_last_contiguous_seq).toBe(-1);
  });

  // ── REVERSE CONTROL (ran red once, 2026-08-10, then reverted) ─────────────
  // mobile.handler.ts's no-session branch was temporarily changed to
  // `audioSeq === null ? { audio_last_contiguous_seq: -1 } : …` — the forbidden
  // -1-as-sentinel. All THREE absence tests in this file went red on their
  // key-absence assertion while the three value tests stayed green (3 failed |
  // 3 passed). Verbatim from the red run:
  //   × … > no audio session at all → the key is ABSENT from the ack
  //     → expected true to be false // Object.is equality
  //   × … > a bare grace entry (idle drop — no utterance) omits the field too
  //     → expected true to be false // Object.is equality
  //   × … > an orchestrator that cannot answer the optional seam member omits
  //         the field (fail toward full replay)
  //     → expected true to be false // Object.is equality
  //   FAIL  test/reconnect-ack-audio-watermark.test.ts > … > no audio session
  //   at all → the key is ABSENT from the ack
  //   AssertionError: expected true to be false // Object.is equality
  //   - Expected  false
  //   + Received  true
  //    ❯ test/reconnect-ack-audio-watermark.test.ts:240:48
  //       240|     expect('audio_last_contiguous_seq' in ack).toBe(false);
  // The handler was reverted and the suite re-ran green (6/6) — these
  // assertions really guard the absence-is-the-signal contract rather than
  // passing vacuously.
  it('no audio session at all → the key is ABSENT from the ack', async () => {
    const { token, mobileId } = pairedPhoneWithSession(); // NO registry entry made
    const back = wireMobile(new FakeSocket('sock-new'));
    const ack = await back.invoke('mobile:reconnect', { token });
    // Positive control first: the ack itself arrived and is the accept ack —
    // so the zero below is a real zero, not a dead probe (G13 rule ②).
    expect(ack.pairing_id).toBe(mobileId);
    expect(ack.room_uuid).toBeTruthy();
    // Key absence, asserted structurally AND on the serialized frame.
    expect('audio_last_contiguous_seq' in ack).toBe(false);
    expect(JSON.stringify(ack)).not.toContain('audio_last_contiguous_seq');
  });

  it('a bare grace entry (idle drop — no utterance) omits the field too', async () => {
    const { token, key, mobileId, oldSock } = pairedPhoneWithSession();
    // beginGrace on a key with no session mints the presence-only entry
    // (orchestrator === null) — the common case: the phone dropped while idle.
    audioSessions.beginGrace(key, undefined, oldSock.id);
    expect(audioSessions.get(key)).not.toBeNull(); // the entry EXISTS…
    const back = wireMobile(new FakeSocket('sock-new'));
    const ack = await back.invoke('mobile:reconnect', { token });
    expect(ack.pairing_id).toBe(mobileId);
    // …so this absence exercises the orchestrator-null branch, not the
    // missing-entry branch of the peek.
    expect('audio_last_contiguous_seq' in ack).toBe(false);
  });

  it('an orchestrator that cannot answer the optional seam member omits the field (fail toward full replay)', async () => {
    const { token, key, roomUuid, mobileId, oldSock } = pairedPhoneWithSession();
    const entry = audioSessions.put({ key, roomUuid, pairingId: mobileId, socket: oldSock as unknown as Socket, fannedOut: false });
    // The audio-grace-test shape of fake: implements the seam's three methods,
    // says nothing about lastContiguousSeq. The honest ack says nothing too —
    // the phone then replays in full, which duplicates but never loses.
    entry.orchestrator = { pushChunk() {}, async finish() {}, dispose() {} };
    audioSessions.beginGrace(key, undefined, oldSock.id);
    const back = wireMobile(new FakeSocket('sock-new'));
    const ack = await back.invoke('mobile:reconnect', { token });
    expect(ack.pairing_id).toBe(mobileId);
    expect('audio_last_contiguous_seq' in ack).toBe(false);
  });

  it('the peek is READ-ONLY: it neither disarms the grace nor rebinds the socket', async () => {
    const { key, roomUuid, mobileId, oldSock } = pairedPhoneWithSession();
    const entry = audioSessions.put({ key, roomUuid, pairingId: mobileId, socket: oldSock as unknown as Socket, fannedOut: false });
    const bridge = makeBridge();
    entry.orchestrator = bridge;
    await tick();
    bridge.pushChunk(0, PCM, 0);
    audioSessions.beginGrace(key, undefined, oldSock.id);
    expect(clock.pending()).toBe(1);

    expect(audioSessions.peekLastContiguousSeq(key)).toBe(0);
    // Nothing moved: the window is still armed and the entry is still unbound.
    expect(clock.pending()).toBe(1);
    expect(audioSessions.get(key)?.socket).toBeNull();
  });
});
